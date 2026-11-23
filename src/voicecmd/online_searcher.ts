// MIoT 智能音箱插件 - 在线歌曲搜索器
// 当本地索引找不到歌曲时，调用用户配置的外部搜索 API 搜索并推送到音箱

/// <reference types="@songloft/plugin-sdk" />

import { MinaService } from '../service/service';
import { getHostAPIBaseUrl, getHostBaseUrl } from '../utils/http';
import { URLBuilder, playbackOptionsOf } from '../player/url_builder';
import { ConfigManager } from '../config/manager';
import { IndexingManager } from '../indexing/manager';
import { GroupCoordinator } from '../group/coordinator';
import type { ExternalSearchSource } from '../types';
import type { PlaylistManager } from '../player/manager';
import { LxServerProvider } from '../lxserver/provider';
import type { LXMissReason } from '../lxserver/provider';
import type { LXArtistQueue } from '../lxserver/provider';
import { PLUGIN_ENTRY_PATH, buildSongRef, buildToponeRef, isOwnSongRef, toponeDedupKey } from '../lxserver/ref';
import type { ToponeSongRef } from '../lxserver/ref';
import { normalizeLXServerConfig } from '../lxserver/types';

// 外部搜索 API 请求体
interface SearchOneRequest {
  keyword: string;
  hint?: { title?: string; artist?: string; duration?: number };
  quality?: string;
}

// 外部搜索 API 成功响应 data（provider 中立，不解读内部字段）
export interface OnlineSearchResult {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  cover_url?: string;
  url?: string;                                      // 直链型 provider 提供
  plugin_entry_path?: string;                        // provider 自身 entryPath；缺省纯外链
  source_data?: string | Record<string, unknown>;   // 不透明；对象则由 MIoT 序列化
  dedup_key?: string;
  lyric?: string;
  lyric_source?: string;
  /** 命中来源：内置 lxserver / 外部 topone（供设置页测试展示，播放链路忽略） */
  hit_source?: 'lxserver' | 'topone';
}

/** 设置页测试用：搜索结果与未命中原因（命中时 reason 为空） */
export interface OnlineSearchDiagnosis {
  result: OnlineSearchResult | null;
  reason: string;
}

/**
 * 歌手在线歌曲（仅内置 lxserver）。
 *
 * 首播只等前 `preResolve` 首的直链：artistSongs 约 1.7~2s，逐首解析 10 首会把首播推迟到
 * 数秒，所以其余曲目先拿元数据占位，等真的快播到它们时再解析（见 resolveUrl 的 lookahead）。
 */
export interface OnlineArtistQueue {
  /** 实际命中的歌手名 */
  artistName: string;
  /** 该歌手在源上的可用歌曲总数（未按 limit 截断），仅用于日志 */
  total: number;
  /**
   * 队列形态：
   *   - 'push'   ：不入库直推，items 的 url 由 peekUrl/resolveUrl 按需补（懒解析）
   *   - 'import' ：入库成解析型，items 带 plugin_entry_path + source_data，播放时由宿主解析
   */
  mode: 'push' | 'import';
  /** 队列（顺序即热门度）。'push' 模式 url 不填充，走懒解析；'import' 模式 url 恒为空。 */
  items: OnlineSearchResult[];
  /** 已解析好的音箱可播 URL；未解析（或 'import' 模式）返回 '' */
  peekUrl: (index: number) => string;
  /** 懒解析第 index 首，返回音箱可播 URL（'import' 模式返回 ''，由宿主解析） */
  resolveUrl: (index: number) => Promise<string>;
}


// 外部搜索 API 响应
interface SearchOneResponse {
  code: number;
  msg: string;
  data: OnlineSearchResult | null;
}

// songloft /api/v1/songs/remote 请求体（provider 中立）
interface RemoteSongItem {
  title: string;
  artist: string;
  album: string;
  cover_url: string;
  duration: number;
  url: string;               // 直链型 provider 有；解析型为空
  plugin_entry_path: string; // provider 自身 entryPath；缺省 '' 表示纯外链
  source_data: string;
  dedup_key: string;
  lyric?: string;
  lyric_source?: string;
}

// songloft /api/v1/songs/remote 响应
interface RemoteSongsResponse {
  count: number;
  songs: Array<{
    id: number;
    type: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    url: string;
    cover_url: string;
    plugin_entry_path: string;
    source_data: string;
    dedup_key: string;
  }>;
}

/**
 * 直推模式的直链缓存有效期。
 *
 * 直链是签名 CDN，解析那一刻开始倒计时（通常几分钟到半小时）。队列预解析 + lookahead 会把
 * 后几首的直链提前拿到手，若用户中途长时间暂停再恢复，手里那条可能已经过期，表现为「起播失败」。
 * 5 分钟是个保守值：既避免每次起播都重新解析，又不至于拿着将死的链接去播。
 */
export const DIRECT_URL_TTL_MS = 5 * 60_000;

/**
 * 外部源「按引用重搜」的总预算。
 *
 * 和内置源的解析预算对齐（宿主给 /music/url 的调度预算 30s，留 5s 余量）：QuickJS 是单线程
 * 调度器，逐源重搜若各自等到超时，源一多就会把插件的其它调用全堵住。超预算就让宿主走 502 切源。
 */
const SOURCE_REF_BUDGET_MS = 25_000;

/**
 * 在线歌曲搜索器
 * 封装对用户配置的外部搜索 API（topone）的调用。
 * MIoT 作为中立消费方，不解读 source_data 内部结构，不写死任何插件名。
 */
export class OnlineSearcher {
  private configManager: ConfigManager;
  private groupCoordinator?: GroupCoordinator;
  /** 内置 lxserver provider 缓存：按配置签名重建，保留鉴权缓存（authUser/authPending） */
  private lxProvider?: LxServerProvider;
  private lxProviderSig = '';

  constructor(configManager: ConfigManager, groupCoordinator?: GroupCoordinator) {
    this.configManager = configManager;
    this.groupCoordinator = groupCoordinator;
  }

  /**
   * 获取内置 lxserver provider（配置变化时重建实例）。
   * 注意：一个 token 一个实例，authUser/authPending 是实例私有状态，配置未变时必须复用。
   */
  private async getLxProvider(): Promise<LxServerProvider | null> {
    const config = await this.configManager.getConfig();
    const lx = normalizeLXServerConfig(config.lxserver);
    if (!lx.enabled || !lx.host.trim()) return null;
    const sig = [lx.host, lx.token, lx.quality, lx.allowQualityFallback, lx.sources.join(','), lx.searchTimeout, lx.urlTimeout].join('|');
    if (!this.lxProvider || this.lxProviderSig !== sig) {
      this.lxProvider = new LxServerProvider(lx);
      this.lxProviderSig = sig;
    }
    return this.lxProvider;
  }

  /**
   * 检查是否配置了在线搜索源：内置 lxserver 或 topone 外部源任一可用即可。
   */
  async isExternalSearchConfigured(): Promise<boolean> {
    const lx = await this.getLxProvider();
    if (lx && lx.isConfigured()) return true;
    const sources = await this.getEnabledSources();
    return sources.length > 0;
  }

  /**
   * 获取当前生效的外部搜索源列表（总开关关闭返回空；数组顺序即优先级）
   */
  private async getEnabledSources(): Promise<ExternalSearchSource[]> {
    const config = await this.configManager.getConfig();
    if (!config.external_search_enabled) return [];
    return config.external_search_sources.filter((s) => s.enabled && (s.url || '').trim() !== '');
  }

  /**
   * 解析单个源的完整地址
   * 支持两种输入：
   * 1. 完整 URL（以 http:// 或 https:// 开头）直接返回
   * 2. 相对路径（以 / 开头）拼接宿主 loopback 地址（调用其他已安装插件）
   */
  private async resolveSourceUrl(source: ExternalSearchSource): Promise<string> {
    const searchUrl = (source.url || '').trim();
    if (!searchUrl) return '';
    if (searchUrl.startsWith('http://') || searchUrl.startsWith('https://')) {
      return searchUrl;
    }
    // 相对路径 = 内部插件/宿主接口，走 loopback API 地址（避免 hairpin NAT）
    const host = await getHostAPIBaseUrl();
    return host + searchUrl;
  }

  /**
   * 解析单个源的认证 Token
   * 源自定义的 token 优先，否则使用插件 token
   */
  private async resolveSourceToken(source: ExternalSearchSource): Promise<string> {
    const userToken = (source.token || '').trim();
    if (userToken) {
      return userToken;
    }
    const pluginToken = await songloft.plugin.getToken();
    return `Bearer ${pluginToken}`;
  }

  /**
   * 判断直链是否音箱可直接播放。音箱（player_play_url）只可靠播放 mp3；
   * webm/opus/ogg/flac/mka/mkv/m4a/wav 等需经 songloft 转码代理（/proxy/transcode）。
   * 判据：URL 的 mime 查询参数（youtube CDN 带 mime=audio/webm）优先，否则看扩展名。
   */
  private isSpeakerPlayableUrl(rawUrl: string): boolean {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return false;
    }
    const mime = (u.searchParams.get('mime') || '').toLowerCase();
    if (mime === 'audio/mpeg' || mime === 'audio/mp3') return true;
    if (mime.startsWith('audio/')) return false; // webm/opus/ogg/flac/mp4/aac/mka 等
    const ext = (u.pathname.split('.').pop() || '').toLowerCase();
    return ext === 'mp3'; // 无 mime（如 go-music-dl 的 .mp3 直链）→ 仅 .mp3 直推
  }

  /**
   * 解析 no-import 直推 URL：可直接播的原样返回；不可播的构造 songloft 转码代理 URL
   * （/api/v1/proxy/transcode，服务端 ffmpeg 实时转 mp3 流式返回，不入库不落盘）。
   *
   * access_token 必须是首个查询参数——部分音箱固件会把 URL 里的 & 替换为空格，
   * 导致后续参数被合并进 token 值（见 url_builder.ts 同款处理）。URLSearchParams
   * 按 set 顺序输出，故先 set access_token。url 值会被自动 percent-encode，
   * youtube 直链里的 & 不会污染参数分隔。
   */
  private async resolveDirectPushUrl(directUrl: string, duration?: number): Promise<string> {
    if (this.isSpeakerPlayableUrl(directUrl)) return directUrl;
    const base = await getHostBaseUrl(); // 音箱可达地址（server_host），非 loopback 的 getHostAPIBaseUrl
    if (!base) {
      // server_host 未配：无法构造转码 URL，回退原样（大概率播不出，但不构造坏 URL）
      songloft.log.warn('[OnlineSearcher] server_host 未配置，无法走转码代理，原样直推（可能无法解码）');
      return directUrl;
    }
    const token = await songloft.plugin.getToken();
    const params = new URLSearchParams();
    params.set('access_token', token); // 必须第一
    params.set('url', directUrl);
    params.set('format', 'mp3');
    if (duration && duration > 0) params.set('duration', String(duration));
    return `${base}/api/v1/proxy/transcode?${params.toString()}`;
  }

  /**
   * 在线搜索歌曲：并发向所有启用源派发请求，但严格按列表顺序采纳结果
   * （源0 命中即用源0，否则看源1……）。仅返回候选，不导入也不播放。
   *
   * @param keyword       搜索关键词
   * @param hint         可选的歌曲提示（title/artist/duration）
   * @returns 搜索候选，全部未命中或请求失败返回 null
   */
  async search(
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
  ): Promise<OnlineSearchResult | null> {
    // 保留正常词间空格；去空白变体仅在源明确未命中后尝试。
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
    keyword = normalize(keyword);
    if (!keyword) return null;
    hint = hint ? { ...hint, title: normalize(hint.title), ...(hint.artist !== undefined ? { artist: normalize(hint.artist) } : {}) } : null;

    // 内置 lxserver 优先：作为默认在线搜索接口，命中即返回；失败/未命中继续 topone 外部源。
    const lxProvider = await this.getLxProvider();
    if (lxProvider && lxProvider.isConfigured()) {
      try {
        const lxResult = await lxProvider.search(keyword, hint);
        if (lxResult) {
          songloft.log.info('[OnlineSearcher] Hit from built-in lxserver for keyword: ' + keyword);
          return { ...lxResult, hit_source: 'lxserver' };
        }
      } catch (e) {
        songloft.log.warn('[OnlineSearcher] built-in lxserver search error: ' + String(e));
      }
    }

    const sources = await this.getEnabledSources();
    if (sources.length === 0) return null;

    const config = await this.configManager.getConfig();
    const timeoutSec = config.external_search_timeout > 0 ? config.external_search_timeout : 6;
    const timeoutMs = timeoutSec * 1000;

    // 立即并发派发所有源；searchOne 内部 catch，绝不 reject
    const tasks = sources.map((s) => this.searchOne(s, keyword, hint, timeoutMs));

    // 按优先级顺序消费：命中即返回（只等到该源），未命中再看下一个
    for (let i = 0; i < tasks.length; i++) {
      const r = await tasks[i];
      if (r) {
        songloft.log.info(`[OnlineSearcher] Hit from source[${i}] "${sources[i].name || sources[i].url}" for keyword: ${keyword}`);
        return { ...this.attachToponeRef(r, sources[i], keyword, hint), hit_source: 'topone' };
      }
    }
    songloft.log.warn('[OnlineSearcher] No source matched for keyword: ' + keyword);
    return null;
  }

  /**
   * 源的稳定身份：写引用和比对引用都用它。
   * 正常配置一定有 id；老配置/手改配置可能缺，退到 url、name（两处必须一致，否则重搜时认不出原源）。
   */
  private sourceIdOf(source: ExternalSearchSource): string {
    return (source.id || source.url || source.name || '').trim();
  }

  /**
   * 给外部源命中结果挂上「引用」：记录怎么搜到的（源 + 关键词 + hint），
   * 入库模式下存它而不是直链，播放时用同样的参数重搜拿新鲜链接。
   *
   * 只处理直链型结果：如果这个源本身已经是别的插件的解析型结果（带 plugin_entry_path），
   * 那套引用是它自己维护的，我们不能覆盖。
   */
  private attachToponeRef(
    result: OnlineSearchResult,
    source: ExternalSearchSource,
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
  ): OnlineSearchResult {
    const url = (result.url || '').trim();
    const isDirectLink = url.startsWith('http://') || url.startsWith('https://');
    // 源身份都没有就没法写引用（重搜时不知道该问谁），保持原样按直链处理
    const sourceId = this.sourceIdOf(source);
    if (!isDirectLink || result.plugin_entry_path || !sourceId) return result;
    return {
      ...result,
      source_data: buildToponeRef(result, { sourceId, keyword, hint }),
      dedup_key: result.dedup_key || toponeDedupKey(sourceId, result),
    };
  }

  /**
   * 解析型音源（外部源）：按引用重跑一次该源的搜索，拿回新鲜直链。
   * 宿主 POST /api/music/url 时由 handler 调用。
   *
   * 原源优先，其余启用源按配置顺序兜底——源可能被改名/禁用/删掉，或那次搜索本身就是偶发失败。
   */
  async resolveSourceRef(ref: ToponeSongRef): Promise<string> {
    const keyword = (ref.keyword || ref.name || '').trim();
    if (!keyword) throw new Error('引用缺少搜索关键词');
    // hint 用于让源在重搜时优先给出同一首歌；缺 title 时不给 hint（源会只按关键词搜）
    const hintTitle = ref.hint?.title || ref.name || '';
    const hintArtist = ref.hint?.artist || ref.singer;
    const hintDuration = ref.hint?.duration || ref.duration;
    const hint = hintTitle
      ? {
        title: hintTitle,
        ...(hintArtist ? { artist: hintArtist } : {}),
        ...(hintDuration && hintDuration > 0 ? { duration: hintDuration } : {}),
      }
      : null;

    const sources = await this.getEnabledSources();
    if (sources.length === 0) throw new Error('没有启用的外部搜索源');

    const cfg = await this.configManager.getConfig();
    const timeoutSec = cfg.external_search_timeout > 0 ? cfg.external_search_timeout : 6;
    const deadline = Date.now() + SOURCE_REF_BUDGET_MS;
    // sort 是稳定排序：命中原源排到最前，其余保持配置里的优先级
    const ordered = [...sources].sort(
      (a, b) => Number(this.sourceIdOf(b) === ref.source_id) - Number(this.sourceIdOf(a) === ref.source_id),
    );

    for (const source of ordered) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const hit = await this.searchOne(source, keyword, hint, Math.min(timeoutSec * 1000, remaining));
      const url = (hit?.url || '').trim();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        if (this.sourceIdOf(source) !== ref.source_id) {
          songloft.log.info(`[OnlineSearcher] ref fallback to source "${source.name || source.id}" for: ${keyword}`);
        }
        return url;
      }
    }
    throw new Error(`外部源解析失败:${keyword}`);
  }

  /**
   * 歌手在线歌曲：只用内置 lxserver 搜「该歌手的多首热门歌」，供「播放歌手X」在本地
   * 没有该歌手时整队播放。外部 topone 源不参与（保持原先 top-1 单曲语义）。
   *
   * 延迟策略（懒解析）：
   *   1. 歌手搜索 + artistSongs 一次拿全量元数据（~2s），只解析前 preResolve 首直链；
   *   2. 真正播放到第 N 首时才解析第 N 首，并顺势预解析 N+1、N+2（lookahead），
   *      于是每首的解析都藏在上一首的播放时间里，首播等待从「N 首之和」降到「2 首」。
   */
  async searchArtistQueue(
    artistName: string,
    opts?: { limit?: number; preResolve?: number; importMode?: boolean },
  ): Promise<OnlineArtistQueue | null> {
    const name = (artistName || '').replace(/\s+/g, ' ').trim();
    if (!name) return null;

    const provider = await this.getLxProvider();
    if (!provider || !provider.isConfigured()) return null;

    // importMode：整队入库成「解析型」，播放时宿主回调 /api/music/url 现解析。
    // 这种模式下不需要任何直链，所以 preResolve 强制为 0 —— 否则会白解析 10 首。
    const importMode = opts?.importMode === true;
    const limit = Math.max(1, Math.min(20, opts?.limit ?? 10));
    const preResolve = importMode ? 0 : Math.max(1, Math.min(limit, opts?.preResolve ?? 2));
    let queue: LXArtistQueue | null;
    try {
      queue = await provider.artistQueue(name, limit, preResolve);
    } catch (e) {
      songloft.log.warn('[OnlineSearcher] lxserver artist queue error: ' + String(e));
      return null;
    }
    if (!queue || queue.items.length === 0) return null;

    // 已解析好的「音箱可播 URL」缓存（直链 → 必要时转码代理）+ 解析时刻。
    // 带时刻是因为直链有签名有效期：过期后必须重解析，否则拿将死的链接去播必然失败。
    const resolved = new Map<number, { url: string; at: number }>();
    const freshUrl = (index: number): string => {
      const entry = resolved.get(index);
      return entry && Date.now() - entry.at < DIRECT_URL_TTL_MS ? entry.url : '';
    };
    const inflight = new Map<number, Promise<string>>();
    // 不递归的 lookahead：解析 i 时预解析 i+1/i+2，但那两首不再继续往后推。
    const resolveOne = async (index: number, lookahead: boolean): Promise<string> => {
      if (index < 0 || index >= queue.items.length) return '';
      const cached = freshUrl(index);
      if (cached) return cached;
      let pending = inflight.get(index);
      if (!pending) {
        pending = (async () => {
          const item = queue.items[index];
          // 缓存的直链可能已过期，但曲目元数据（raw songInfo）可复用，只需重新解析直链。
          const playable = await provider.resolveTrackUrl(item.track);
          item.playable = playable;
          const pushUrl = await this.resolveDirectPushUrl(playable.url, item.track.duration);
          resolved.set(index, { url: pushUrl, at: Date.now() });
          return pushUrl;
        })().finally(() => inflight.delete(index));
        inflight.set(index, pending);
      }
      const url = await pending;
      if (lookahead) {
        void resolveOne(index + 1, false).catch(() => undefined);
        void resolveOne(index + 2, false).catch(() => undefined);
      }
      return url;
    };

    // 首批：provider 已解析直链，这里只需补转码代理判定（不发网络请求）。
    if (!importMode) {
      await Promise.all(
        queue.items.slice(0, preResolve).map(async (item, index) => {
          if (!item.playable) return;
          try {
            const pushUrl = await this.resolveDirectPushUrl(item.playable.url, item.track.duration);
            if (pushUrl) resolved.set(index, { url: pushUrl, at: Date.now() });
          } catch { /* 单首失败不影响队列 */ }
        }),
      );

      if (resolved.size === 0) {
        songloft.log.warn('[OnlineSearcher] lxserver artist queue: no playable url after pre-resolve');
        return null;
      }
    }

    const items: OnlineSearchResult[] = queue.items.map((item) => ({
      title: item.track.name,
      artist: item.track.singer || queue.artistName,
      album: item.track.album || undefined,
      duration: item.track.duration || undefined,
      cover_url: item.track.cover || undefined,
      dedup_key: `lxserver:${item.track.source}:${item.track.id}`,
      // 一律带完整引用：'push' 模式用不上，但 'import' 模式靠它代替直链入库。
      source_data: buildSongRef(item.track, item.playable?.type),
      hit_source: 'lxserver',
    }));

    songloft.log.info(
      `[OnlineSearcher] lxserver artist queue "${queue.artistName}" total=${queue.total} ` +
      `take=${items.length} mode=${importMode ? 'import' : 'push'} preResolved=${resolved.size}`,
    );

    return {
      artistName: queue.artistName,
      total: queue.total,
      mode: importMode ? 'import' : 'push',
      items,
      peekUrl: (index: number) => freshUrl(index),
      resolveUrl: (index: number) => (importMode ? Promise.resolve('') : resolveOne(index, true)),
    };
  }

  /**
   * 与 search() 完全相同的搜索，但额外给出未命中原因，供设置页测试展示。
   * 不改动 search() 的签名，播放链路不受影响。
   */
  async searchWithDiagnosis(
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
  ): Promise<OnlineSearchDiagnosis> {
    if (!keyword || !keyword.trim()) return { result: null, reason: '未命中：关键词为空' };
    const result = await this.search(keyword, hint);
    if (result) return { result, reason: '' };
    return { result: null, reason: await this.describeMiss() };
  }

  /** 读取各源最近一次未命中状态，拼成用户可读的原因 */
  private async describeMiss(): Promise<string> {
    const lxProvider = await this.getLxProvider();
    const lxPart = this.describeLxMiss(lxProvider ? lxProvider.getLastMissReason() : null);
    const sources = await this.getEnabledSources();
    if (sources.length === 0) {
      return lxPart ? `未命中：${lxPart}` : '未命中：没有可用的在线搜索源返回结果，或关键词无匹配';
    }
    const topPart = '外部 topone 源未命中';
    return lxPart ? `未命中：${lxPart}；${topPart}` : `未命中：${topPart}`;
  }

  private describeLxMiss(reason: LXMissReason): string {
    switch (reason) {
      case 'no_candidates':
        return '内置 lxserver 未返回候选（它按歌曲名搜索，单独歌手名可能搜不到）';
      case 'below_threshold':
        return '内置 lxserver 返回了候选，但与关键词匹配度不足';
      case 'no_playable_url':
        return '内置 lxserver 找到歌曲但直链解析失败';
      case 'error':
        return '内置 lxserver 搜索出错';
      default:
        return '';
    }
  }

  /**
   * 向单个源搜索，明确未命中时最多重试一次去空白变体。
   * 内部处理超时/网络错/解析失败，全部返回 null，绝不 reject。
   */
  private async searchOne(
    source: ExternalSearchSource,
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    timeoutMs: number,
  ): Promise<OnlineSearchResult | null> {
    const reqBody: SearchOneRequest = {
      keyword,
      hint: hint || undefined,
      quality: '320k',
    };

    const compactBody: SearchOneRequest = {
      ...reqBody,
      keyword: keyword.replace(/\s+/g, ''),
      hint: hint ? {
        ...hint,
        title: hint.title.replace(/\s+/g, ''),
        ...(hint.artist !== undefined ? { artist: hint.artist.replace(/\s+/g, '') } : {}),
      } : undefined,
    };
    const hasVariant = JSON.stringify(compactBody) !== JSON.stringify(reqBody);
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // 两次尝试共用一个期限，包含地址解析、认证、fetch 和响应体读取。
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { finished = true; reject(new Error('AbortError')); }, timeoutMs);
    });
    try {
      const request = (async (): Promise<OnlineSearchResult | null> => {
        const baseUrl = await this.resolveSourceUrl(source);
        if (!baseUrl || finished) return null;
        const authToken = await this.resolveSourceToken(source);
        const attempts = hasVariant ? [reqBody, compactBody] : [reqBody];
        for (let i = 0; i < attempts.length; i++) {
          if (finished) return null;
          const body = attempts[i];
          if (i > 0) songloft.log.info('[OnlineSearcher] Retrying whitespace-free keyword: ' + body.keyword);
          songloft.log.info('[OnlineSearcher] [Diag] Request POST ' + baseUrl + ' body=' + JSON.stringify(body));
          const fetchResp = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: authToken },
            body: JSON.stringify(body),
          });
          if (finished) return null;
          const text = await fetchResp.text();
          if (finished) return null;
          songloft.log.info('[OnlineSearcher] [Diag] Response status=' + fetchResp.status + ' body=' + text);
          let resp: SearchOneResponse | null;
          try {
            resp = JSON.parse(text) as SearchOneResponse;
          } catch {
            songloft.log.warn('[OnlineSearcher] Failed to parse search/topone response: ' + text);
            return null;
          }
          if (resp?.code === 0 && resp.data) return resp.data;
          songloft.log.warn('[OnlineSearcher] Search/topone returned code=' + (resp?.code ?? 'null') + ' for keyword: ' + body.keyword);
          // 仅业务未命中重试；认证、服务端错误和网络失败不加倍请求。
          if (fetchResp.status < 200 || fetchResp.status >= 300 || !(resp?.code === 404 || resp?.code === 0 && !resp.data)) return null;
        }
        return null;
      })();
      return await Promise.race([request, timeoutPromise]);
    } catch (e: any) {
      if (e.message === 'AbortError') {
        songloft.log.warn(`[OnlineSearcher] Search/topone timeout (>${timeoutMs / 1000}s) for source "${source.name || source.url}" keyword: ` + keyword);
      } else {
        songloft.log.warn('[OnlineSearcher] Search/topone fetch error: ' + String(e));
      }
      return null;
    } finally {
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 将外部搜索候选导入到 Songloft，并推送到音箱播放。
   */
  async playSearchResult(
    song: OnlineSearchResult,
    accountId: string,
    deviceId: string,
    minaService: MinaService,
    indexingManager?: IndexingManager,
    pm?: PlaylistManager,
  ): Promise<boolean> {
    const config = await this.configManager.getConfig();

    // 直链不入库直接播放：仅对「直链型」结果生效（song.url 是 http(s) 直链）。
    // 临时链接（签名 CDN 直链）入库后很快失效、堆成死条目，此模式趁链接新鲜时把原始 URL
    // 直接推给音箱（底层 player_play_url），跳过入库/追加歌单/加索引。
    // 解析型结果（url 为空、靠 plugin_entry_path 让宿主运行时解析）无法脱离曲库播放，回退到入库。
    const directUrl = (song.url || '').trim();
    const isDirectLink = directUrl.startsWith('http://') || directUrl.startsWith('https://');
    if (config.external_search_no_import) {
      if (isDirectLink) {
        // 音箱只可靠播放 mp3；webm/opus 等不可解码格式走 songloft 转码代理（songloft-org/songloft#394）
        const pushUrl = await this.resolveDirectPushUrl(directUrl, song.duration);
        const transcoded = pushUrl !== directUrl;
        const songName = song.artist ? `${song.title}-${song.artist}` : song.title;
        songloft.log.info('[OnlineSearcher] [Diag] No-import direct push: songName="' + songName + '" url="' + pushUrl + '"' + (transcoded ? ' (transcoded)' : ''));
        if (pm && indexingManager) {
          // id=0 只存在于临时队列，不写曲库，也不对它发送已播放/收藏请求。
          return pm.playStandaloneSong({ ...song, id: 0, url: pushUrl, type: 'remote', duration: song.duration || 0 } as any, indexingManager);
        }
        const played = await (this.groupCoordinator || minaService).playURL(accountId, deviceId, pushUrl, {
          title: song.title,
          artist: song.artist,
        });
        if (!played) {
          songloft.log.error('[OnlineSearcher] No-import: failed to push URL to device: ' + pushUrl);
          return false;
        }
        songloft.log.info('[OnlineSearcher] Playing online song (no-import)' + (transcoded ? ' [transcoded]' : '') + ': ' + song.title + ' - ' + song.artist + ' url=' + pushUrl);
        return true;
      }
      songloft.log.info('[OnlineSearcher] No-import enabled but result is resolution-type (no direct url), falling back to import: ' + song.title);
    }

    // 入库模式：可重解析的结果（内置 lxserver）不存直链，改存「引用」。
    // 直链是签名 CDN、当天就失效；引用永久有效，播放时由宿主回调本插件 /api/music/url 现解析。
    // 顺带修掉一个老问题：以前 plugin_entry_path 为空 → 宿主 dedup 不生效 → 每搜一次多一行死条目；
    // 现在 ('miot', 'lxserver:<platform>:<id>') 是唯一键，同一首歌永远只占一行。
    const target = this.toResolvableResult(song) ?? song;
    if (target !== song) {
      songloft.log.info(
        '[OnlineSearcher] Import as resolvable source: ' + song.title + ' - ' + song.artist +
        ' (dedup=' + (song.dedup_key || '-') + ')',
      );
    }

    // 同步导入到 songloft 数据库，直接拿到 songloft 分配的 id 和 url
    const imported = await this.importSong(target);
    if (!imported) {
      songloft.log.error('[OnlineSearcher] Failed to import song, cannot play: ' + song.title);
      return false;
    }

    // 入库后追加到目标歌单（可选，由配置决定）
    const pid = config.external_search_playlist_id;
    let appendedPlaylistId: number | undefined;
    if (pid) {
      try {
        const plToken = await songloft.plugin.getToken();
        const apiBase = await getHostAPIBaseUrl();
        await fetch(`${apiBase}/api/v1/playlists/${pid}/songs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plToken}` },
          body: JSON.stringify({ song_ids: [imported.id] }),
        });
        const pidNum = Number(pid);
        if (!Number.isNaN(pidNum)) appendedPlaylistId = pidNum;
      } catch (e) { songloft.log.warn(`[OnlineSearcher] 追加歌单失败: ${String(e)}`); }
    }

    // 已追加到目标歌单且提供了播放管理器：接管为完整歌单播放，从这首新歌
    // 开始，播完后由 PlaylistManager 的切歌定时器自动续播歌单其余歌曲。
    // （直接 playURL 单曲推送不会注册切歌定时器，播完即停，见 issue #53）
    if (pm && appendedPlaylistId !== undefined) {
      const ok = await pm.playPlaylistFromSong(appendedPlaylistId, imported.id);
      if (ok) {
        // 增量把这首独立远程歌曲加入内存索引，避免为一首歌重建全部歌单缓存。
        if (indexingManager) {
          indexingManager.addImportedSong(
            { id: imported.id, title: song.title, artist: song.artist, album: song.album },
            appendedPlaylistId,
          );
        }
        songloft.log.info(`[OnlineSearcher] Playing online song via playlist ${appendedPlaylistId} (auto-continue): ${song.title} - ${song.artist}`);
        return true;
      }
      songloft.log.warn(`[OnlineSearcher] Playlist takeover failed for playlist ${appendedPlaylistId}, falling back to single URL push`);
    }

    // 没有目标歌单时，导入歌曲与已入库的独立歌曲共用临时歌手队列。
    if (pm && indexingManager) {
      indexingManager.addImportedSong({ id: imported.id, title: song.title, artist: song.artist, album: song.album });
      let fullSong: any = { ...target, id: imported.id, url: imported.url, type: 'remote' };
      try {
        fullSong = await songloft.songs.getById(imported.id) || fullSong;
      } catch (e) {
        songloft.log.warn('[OnlineSearcher] Failed to read imported song detail: ' + String(e));
      }
      return pm.playStandaloneSong(fullSong, indexingManager);
    }

    // 用返回的 url 构造完整播放 URL（相对路径，URLBuilder 会拼接 server_host 和 token）。
    // 必须带上 force_mp3 / volume_normalize：直推路径漏了这些选项时，音箱会拿到不能解码的
    // 源格式流而亮灯不出声（songloft-org/songloft-plugin-miot#62）。
    const playUrl = await URLBuilder.buildSongURL({ id: imported.id, url: imported.url }, playbackOptionsOf(config));
    if (!playUrl) {
      songloft.log.error('[OnlineSearcher] Failed to build URL for song id=' + imported.id);
      return false;
    }

    // 推送 URL 到音箱（传「歌名-歌手」供触屏歌词模式匹配曲库）
    const songName = song.artist ? `${song.title}-${song.artist}` : song.title;
    songloft.log.info('[OnlineSearcher] [Diag] Push to device: songName="' + songName + '" importedUrl="' + imported.url + '" playUrl="' + playUrl + '"');
    const played = await (this.groupCoordinator || minaService).playURL(accountId, deviceId, playUrl, {
      title: song.title,
      artist: song.artist,
    });
    if (!played) {
      songloft.log.error('[OnlineSearcher] Failed to push URL to device: ' + playUrl);
      return false;
    }

    // 增量把这首独立远程歌曲加入内存索引，避免为一首歌重建全部歌单缓存。
    if (indexingManager) {
      indexingManager.addImportedSong(
        { id: imported.id, title: song.title, artist: song.artist, album: song.album },
        appendedPlaylistId,
      );
    }

    songloft.log.info('[OnlineSearcher] Playing online song: ' + song.title + ' - ' + song.artist + ' url=' + playUrl);
    return true;
  }

  /**
   * 在线搜索歌曲并推送到音箱播放，同时导入到本地数据库
   *
   * @param keyword       搜索关键词
   * @param hint         可选的歌曲提示（title/artist/duration）
   * @param accountId    平台账号ID
   * @param deviceId     设备ID
   * @param minaService  MinaService 实例（用于推送URL）
   * @returns 是否成功推送播放
   */
  async searchAndPlay(
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    accountId: string,
    deviceId: string,
    minaService: MinaService,
  ): Promise<boolean> {
    const song = await this.search(keyword, hint);
    if (!song) {
      return false;
    }
    return await this.playSearchResult(song, accountId, deviceId, minaService);
  }

  /**
   * 把「带引用」的搜索结果改写成解析型：清空直链，带上本插件的 entryPath。
   * 只认自家产出的引用（isOwnSongRef），外部源的结构不碰。
   * 返回 null 表示这条结果只能按直链入库（topone 等）。
   */
  private toResolvableResult(song: OnlineSearchResult): OnlineSearchResult | null {
    if (!isOwnSongRef(song)) return null;
    return {
      ...song,
      url: '',
      plugin_entry_path: PLUGIN_ENTRY_PATH,
      source_data: typeof song.source_data === 'string'
        ? song.source_data
        : JSON.stringify(song.source_data ?? {}),
    };
  }

  /**
   * 批量导入（歌手队列用）：一次 POST /api/v1/songs/remote 把整队写进曲库。
   * 返回与入参同序的 {id, url}；任一条失败（如标题为空）整批失败返回 null。
   */
  async importSongs(items: OnlineSearchResult[]): Promise<Array<{ id: number; url: string }> | null> {
    if (items.length === 0) return [];
    const body: RemoteSongItem[] = items.map((song) => ({
      title: song.title,
      artist: song.artist || '',
      album: song.album || '',
      cover_url: song.cover_url || '',
      duration: song.duration || 0,
      url: song.url || '',
      plugin_entry_path: song.plugin_entry_path || '',
      source_data: typeof song.source_data === 'string'
        ? song.source_data
        : (song.source_data ? JSON.stringify(song.source_data) : ''),
      dedup_key: song.dedup_key || '',
      lyric: song.lyric || '',
      lyric_source: song.lyric_source || '',
    }));

    try {
      const pluginToken = await songloft.plugin.getToken();
      const serverHost = await getHostAPIBaseUrl();
      const resp = await fetch(serverHost + '/api/v1/songs/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pluginToken}` },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      if (!resp.ok) {
        songloft.log.warn(`[OnlineSearcher] Batch import failed status=${resp.status}: ${text}`);
        return null;
      }
      const result = JSON.parse(text) as RemoteSongsResponse;
      const songs = result?.songs || [];
      if (songs.length !== items.length) {
        songloft.log.warn(`[OnlineSearcher] Batch import count mismatch: expect=${items.length} got=${songs.length}`);
      }
      return songs.map((s) => ({ id: s.id, url: s.url || `/api/v1/songs/${s.id}/play` }));
    } catch (e) {
      songloft.log.warn('[OnlineSearcher] Batch import error: ' + String(e));
      return null;
    }
  }

  /**
   * 导入歌曲到 songloft 数据库
   * @returns 导入成功后包含歌曲 id 和 url 的对象，失败返回 null
   */
  private async importSong(song: OnlineSearchResult): Promise<{ id: number; url: string } | null> {
    // provider 字段原样映射，不解读、不补插件名
    const remoteItem: RemoteSongItem = {
      title: song.title,
      artist: song.artist || '',
      album: song.album || '',
      cover_url: song.cover_url || '',
      duration: song.duration || 0,
      url: song.url || '',                              // 直链型 provider 有；解析型为空
      plugin_entry_path: song.plugin_entry_path || '',  // 中立缺省 ''，绝不写死任何插件名
      source_data: typeof song.source_data === 'string'
        ? song.source_data
        : (song.source_data ? JSON.stringify(song.source_data) : ''),   // 对象则序列化，不窥内部
      dedup_key: song.dedup_key || '',
      lyric: song.lyric || '',
      lyric_source: song.lyric_source || '',
    };

    try {
      const pluginToken = await songloft.plugin.getToken();
      const serverHost = await getHostAPIBaseUrl();
      const fetchResp = await fetch(serverHost + '/api/v1/songs/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pluginToken}` },
        body: JSON.stringify([remoteItem]),
      });
      const text = await fetchResp.text();
      let result: RemoteSongsResponse;
      try {
        result = JSON.parse(text) as RemoteSongsResponse;
      } catch {
        songloft.log.warn('[OnlineSearcher] Failed to parse remote songs response: ' + text);
        // 导入失败（可能是 UNIQUE 约束冲突），尝试查找已存在的歌曲
        return await this.findExistingSong(song.title, song.artist);
      }

      if (!result.songs || result.songs.length === 0) {
        songloft.log.warn('[OnlineSearcher] Remote import returned no songs: ' + text);
        // 导入失败，尝试查找已存在的歌曲
        return await this.findExistingSong(song.title, song.artist);
      }

      const imported = result.songs[0];
      songloft.log.info('[OnlineSearcher] Import success: ' + song.title + ' - ' + song.artist + ', songloft id=' + imported.id);
      return { id: imported.id, url: imported.url };
    } catch (e: any) {
      songloft.log.warn('[OnlineSearcher] Remote import fetch error: ' + String(e));
      return null;
    }
  }

  /**
   * 在 Songloft 数据库中查找已存在的外部导入歌曲
   * 当 /api/v1/songs/remote 因唯一键约束冲突等无法重复导入时作为回退
   */
  private async findExistingSong(title: string, artist: string): Promise<{ id: number; url: string } | null> {
    try {
      let songLimit = 10000;
      try {
        const cfg = await this.configManager.getConfig();
        songLimit = Math.max(1000, Math.min(100000, cfg.max_song_index ?? 10000));
      } catch {}
      const allSongs = await songloft.songs.list({ limit: songLimit });
      const match = allSongs.find(s =>
        s.title === title &&
        s.artist === artist &&
        (s.type === 'remote' || s.url?.startsWith('http'))
      );
      if (match && match.id && match.url) {
        songloft.log.info('[OnlineSearcher] Found existing remote song: ' + title + ' - ' + artist + ', id=' + match.id);
        return { id: match.id, url: match.url };
      }
    } catch (e) {
      songloft.log.warn('[OnlineSearcher] Failed to search existing songs: ' + String(e));
    }
    return null;
  }
}
