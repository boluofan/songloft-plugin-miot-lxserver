// MIoT 智能音箱插件 - lxserver 搜索源适配层
// 职责：把内置 lxserver 客户端的结果，转换为 MIoT 播放链路期望的 OnlineSearchResult。
// 这是「lxserver 数据结构变动只改一处」的收敛点：字段映射、候选匹配、直链解析都在此。

/// <reference types="@songloft/plugin-sdk" />

import { LxServerClient } from './client';
import type { LXArtist, LXPlayableUrl, LXServerConfig, LXTrack } from './types';
import type { OnlineSearchResult } from '../voicecmd/online_searcher';

/** 与 online_searcher 的 hint 对齐 */
export interface LXSearchHint {
  title: string;
  artist?: string;
  duration?: number;
}

/** 文本归一化：去空格/大小写/括号/常见标点，用于候选匹配打分 */
function normalizeText(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s（）()\[\]【】「」『』,，。.!！?？:：;；\-_"'《》]/g, '');
}

/** 双向包含匹配（歌手名常有 "周杰伦 feat.XXX" 等形态） */
function includesLoose(actual: string, expected: string): boolean {
  const a = normalizeText(actual);
  const e = normalizeText(expected);
  if (!e) return true;
  if (!a) return false;
  return a.includes(e) || e.includes(a);
}

/** lxserver 能力矩阵：只有 tx/wy 支持 type=singer 与 artistSongs（kw/kg/mg 会返回 500） */
const ARTIST_SOURCES = new Set(['tx', 'wy']);

/** 歌手名匹配分：精确名 > 包含名；同档再用专辑数体现流行度（避免选到同名小号） */
function artistMatchScore(artist: LXArtist, target: string): number {
  const names = [artist.name, ...artist.aliases].map(normalizeText).filter(Boolean);
  if (names.some((n) => n === target)) return 100;
  let score = 0;
  for (const n of names) {
    if (!n.includes(target) && !target.includes(n)) continue;
    // 包含匹配按「多出的字数」打折：「G.E.M.邓紫棋」应优于「邓紫棋粉丝团」，
    // 否则只按专辑数排序会选中粉丝号/翻唱号。
    const extra = Math.abs(n.length - target.length);
    score = Math.max(score, Math.max(10, 50 - extra * 2));
  }
  return score;
}

/** 候选匹配打分：优先歌名+歌手都吻合，其次仅歌名/仅歌手吻合；时长接近加分 */
function matchScore(track: LXTrack, hint: LXSearchHint | null): number {
  if (!hint) return 50;
  let score = 0;
  const titleHit = includesLoose(track.name, hint.title);
  // hint 没给 artist 时，关键词本身可能是歌手名（设置页测试/语音歌手兜底）。
  // 这时歌手字段也应算命中，否则「邓紫棋」会因歌名「唯一」不匹配而被阈值过滤。
  const singerAsTitleHit = !hint.artist && includesLoose(track.singer, hint.title);
  const artistHit = hint.artist ? includesLoose(track.singer, hint.artist) : false;
  if (titleHit || singerAsTitleHit) score += 40;
  if (artistHit) score += 40;
  if (hint.artist && titleHit && !artistHit) score -= 20; // 明确给了歌手却对不上，重罚
  if (hint.duration && hint.duration > 0 && track.duration > 0) {
    const diff = Math.abs(hint.duration - track.duration);
    if (diff <= 3) score += 10;
    else if (diff <= 15) score += 5;
  }
  return score;
}

/** 未命中原因：供设置页测试区分「源没结果」与「候选被过滤」 */
export type LXMissReason = 'no_candidates' | 'below_threshold' | 'no_playable_url' | 'error' | null;

/** 歌手队列条目：直链按需解析，playable 为空表示「还没解析」 */
export interface LXQueueItem {
  track: LXTrack;
  playable?: LXPlayableUrl;
}

/** 在线歌手队列解析结果 */
export interface LXArtistQueue {
  /** 实际命中的歌手名（lxserver 返回的，可能是别名/繁简差异） */
  artistName: string;
  /** 命中来源（tx/wy），仅用于日志定位 */
  source: string;
  /** 该歌手在源上可用的歌曲总数（未按 limit 截断） */
  total: number;
  items: LXQueueItem[];
}

/** 直链可播性：音箱（player_play_url）只可靠播放 mp3；其余交给播放链路的转码代理。
 *  这里保留原样 URL，由 playSearchResult → resolveDirectPushUrl 统一处理转码。 */
export class LxServerProvider {
  private client: LxServerClient;
  private lastMissReason: LXMissReason = null;

  constructor(private cfg: LXServerConfig) {
    this.client = new LxServerClient(cfg);
  }

  /** 最近一次 search() 未命中的原因；命中或不可用时为 null */
  getLastMissReason(): LXMissReason {
    return this.lastMissReason;
  }

  /** 是否可用（配置了地址且启用） */
  isConfigured(): boolean {
    return this.cfg.enabled && !!this.cfg.host.trim();
  }

  /** 预热鉴权（可选，失败不影响搜索；惰性 auth 在请求内完成） */
  async warmup(): Promise<void> {
    if (!this.isConfigured()) return;
    await this.client.ensureAuthReady().catch(() => undefined);
  }

  /** 搜索并返回最佳候选：多源并发 → hint 打分排序 → 逐个解析直链 → 首个可播即返回 */
  async search(keyword: string, hint: LXSearchHint | null): Promise<OnlineSearchResult | null> {
    this.lastMissReason = null;
    if (!this.isConfigured()) return null;
    const clean = keyword.replace(/\s+/g, ' ').trim();
    if (!clean) return null;

    let tracks: LXTrack[];
    try {
      // voice 点歌若在 search_priority=external_first 时 keyword 可能是 "歌手 歌名" 组合，
      // 先按原词搜；无结果再用 hint.title 兜底（对齐 lxbridge 的 searchWithFallback 思路）。
      tracks = await this.client.searchAggregate(clean);
      if (tracks.length === 0 && hint?.title && normalizeText(hint.title) !== normalizeText(clean)) {
        tracks = await this.client.searchAggregate(hint.title);
      }
    } catch (e) {
      this.lastMissReason = 'error';
      songloft.log.warn('[LxServerProvider] search failed: ' + String(e));
      return null;
    }
    if (tracks.length === 0) {
      this.lastMissReason = 'no_candidates';
      songloft.log.info('[LxServerProvider] no candidates for: ' + clean);
      return null;
    }

    // 打分排序；同分保持 lxserver 返回顺序（sources 优先级）
    const ranked = tracks
      .map((t) => ({ track: t, score: matchScore(t, hint) }))
      .sort((a, b) => b.score - a.score);

    // 有 hint 时过滤掉明显不相关的候选（分数过低）
    const threshold = hint ? 40 : 0;
    const candidates = ranked.filter((r) => r.score >= threshold).slice(0, 8);
    if (candidates.length === 0) {
      this.lastMissReason = 'below_threshold';
      songloft.log.info('[LxServerProvider] all candidates below threshold for: ' + clean);
      return null;
    }

    // 逐个解析直链：任一成功即返回；失败继续下一个（音源降级在 client.resolveUrlLadder 内）
    for (const { track } of candidates) {
      try {
        const playable = await this.client.resolveUrlLadder(track.raw);
        songloft.log.info(
          `[LxServerProvider] hit ${track.source}/${track.name}-${track.singer} quality=${playable.type}`,
        );
        return {
          title: track.name,
          artist: track.singer,
          album: track.album || undefined,
          duration: track.duration || undefined,
          cover_url: track.cover || undefined,
          url: playable.url,
          dedup_key: `lxserver:${track.source}:${track.id}`,
          source_data: {
            platform: track.source,
            quality: playable.type,
            sourceName: playable.sourceName || '',
          },
        };
      } catch (e) {
        songloft.log.warn(
          `[LxServerProvider] url resolve failed for ${track.source}/${track.name}: ${String(e)}`,
        );
      }
    }
    this.lastMissReason = 'no_playable_url';
    songloft.log.warn('[LxServerProvider] no playable url for: ' + clean);
    return null;
  }

  /**
   * 在线歌手队列：歌手名 → 该歌手热门歌曲列表。仅 tx/wy 支持（其他源调 type=singer 直接 500）。
   *
   * 只解析前 `preResolve` 首的直链：artistSongs 本身 1.7~2s，再逐首串行解析 /api/music/url
   * 会把首播推迟到数秒。其余曲目保持「未解析」交给播放链路临播前按需补
   * （见 OnlineSearcher.searchArtistQueue 的 resolveUrl / 播放器懒解析钩子）。
   *
   * 未命中时把原因写进 lastMissReason，设置页/日志可据此区分「源不支持」「没有这个歌手」
   * 「找到了但解析不出直链」。
   */
  async artistQueue(name: string, limit = 10, preResolve = 2): Promise<LXArtistQueue | null> {
    this.lastMissReason = null;
    if (!this.isConfigured()) return null;
    const target = normalizeText(name);
    if (!target) return null;

    // 只在支持歌手能力的源里找，保持用户配置的 sources 顺序（先配的源优先）。
    const sources = this.cfg.sources.filter((s) => ARTIST_SOURCES.has(s));
    if (sources.length === 0) {
      this.lastMissReason = 'no_candidates';
      songloft.log.info('[LxServerProvider] artist queue: no tx/wy source enabled, skip');
      return null;
    }

    let best: { artist: LXArtist; score: number } | null = null;
    let bestSongs: LXTrack[] = [];
    for (const source of sources) {
      let songs: LXTrack[] = [];
      let pick: { artist: LXArtist; score: number } | null = null;
      try {
        const artists = await this.client.searchSingers(source, target, 10);
        const ranked = artists
          .map((artist) => ({ artist, score: artistMatchScore(artist, target) }))
          .filter((r) => r.score > 0)
          // 同名档内用专辑数体现流行度，避免选中同名的翻唱号/小号
          .sort((a, b) => b.score - a.score || b.artist.albumSize - a.artist.albumSize);
        if (ranked.length > 0) {
          pick = ranked[0];
          songs = (await this.client.artistSongs(source, pick.artist.id, 'hot'))
            .filter((t) => !!t.id && !!t.name);
        }
      } catch (e) {
        songloft.log.warn(`[LxServerProvider] artist queue ${source} failed: ${String(e)}`);
        continue;
      }
      if (!pick || songs.length === 0) continue;
      // 精确同名歌手直接采纳，不再往下试源。
      if (!best || pick.score > best.score) {
        best = pick;
        bestSongs = songs;
      }
      if (pick.score >= 100) break;
    }

    if (!best || bestSongs.length === 0) {
      this.lastMissReason = 'no_candidates';
      songloft.log.info('[LxServerProvider] artist queue: no artist matched for ' + name);
      return null;
    }

    const take = Math.max(1, Math.min(50, limit));
    const picked = bestSongs.slice(0, take);
    const items: LXQueueItem[] = picked.map((track) => ({ track }));

    // 首批并发解析（失败隔离）：任何一首失败都不影响其余，未解析的临播时再补。
    await Promise.all(
      items.slice(0, Math.max(0, Math.min(take, preResolve))).map(async (item) => {
        try {
          item.playable = await this.client.resolveUrlLadder(item.track.raw);
        } catch (e) {
          songloft.log.warn(
            `[LxServerProvider] artist queue url failed for ${item.track.name}: ${String(e)}`,
          );
        }
      }),
    );

    const playableCount = items.filter((i) => !!i.playable).length;
    if (playableCount === 0) {
      // 一首都解析不出来说明源侧没可用音源（或自定义源未配），交给上层回退单曲兜底。
      this.lastMissReason = 'no_playable_url';
      songloft.log.warn('[LxServerProvider] artist queue: no playable url in first batch for ' + name);
      return null;
    }

    songloft.log.info(
      `[LxServerProvider] artist queue "${best.artist.name}" source=${best.artist.source} ` +
      `songs=${bestSongs.length} take=${items.length} preResolved=${playableCount}`,
    );
    return {
      artistName: best.artist.name,
      source: String(best.artist.source),
      total: bestSongs.length,
      items,
    };
  }

  /** 按需解析单首直链（歌手队列懒解析用；失败由调用方跳过该首） */
  async resolveTrackUrl(track: LXTrack): Promise<LXPlayableUrl> {
    return this.client.resolveUrlLadder(track.raw);
  }

  /** 连通性测试：探活 + 鉴权态，供设置页调用 */
  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    if (!this.cfg.host.trim()) return { ok: false, detail: '地址未配置' };
    const status = await this.client.status();
    if (!status.reachable) return { ok: false, detail: status.detail || '无法连接' };
    const auth = await this.client.ensureAuthReady();
    if (auth.mode === 'invalid') return { ok: false, detail: 'Token 校验未通过（仅公开源可用）' };
    return {
      ok: true,
      detail: auth.mode === 'user' ? `已连接，用户 ${auth.user}` : '已连接，匿名（仅公开源）',
    };
  }

  /** 供后期扩展：直接访问底层客户端（歌词/歌单/多用户 tokenOverride） */
  getClient(): LxServerClient {
    return this.client;
  }
}
