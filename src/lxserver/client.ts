// MIoT 智能音箱插件 - 内置 lxserver HTTP 客户端
// 移植自 fnmusic_ext_lxserver/src/lxclient.ts（基于最新 lxserver 实测实现）。
// 适配点：
//   1. QuickJS 沙盒无 AbortController/AbortSignal.timeout，改用 X-Fetch-Timeout-Ms +
//      Promise.race + setTimeout（与 online_searcher.ts / music/service.ts 同款写法）；
//   2. 去除飞牛音乐契约依赖（guid/registry/contract），仅保留 lxserver 通用 REST 调用；
//   3. tokenOverride 为后期「设备/房间绑定不同 lxserver 用户」预留：一个 token 一个实例，
//      authUser/authRetryAt/writeChain 均为实例私有状态，绝不共用实例只改 token。

/// <reference types="@songloft/plugin-sdk" />

import {
  LxError,
  type LXArtist,
  type LXAuthState,
  type LXPlayableUrl,
  type LXQuality,
  type LXServerConfig,
  type LXSource,
  type LXTrack,
} from './types';

/** 音质阶梯降级（对齐 fnmusic 文档04 §2） */
const QUALITY_LADDER: Record<LXQuality, LXQuality[]> = {
  flac: ['flac', '320k', '128k'],
  '320k': ['320k', '128k'],
  '128k': ['128k'],
};

/** token 校验失败后的冷却，避免每个播放请求都重打一次 verify */
const AUTH_RETRY_MS = 30_000;

/** 同一时刻对 lxserver 最多 5 个请求，超出排队（避免打爆音源脚本） */
const MAX_CONCURRENT = 5;
let globalActive = 0;
const globalWaiters: (() => void)[] = [];

/** lxserver v2.1.3+ 搜索响应从裸数组改为 {list,...}，统一解包兼容新旧版本 */
function unwrapSearchList<T>(r: unknown, api: string): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object') {
    const o = r as { list?: unknown; error?: unknown; message?: unknown };
    if (Array.isArray(o.list)) return o.list as T[];
    const detail = o.error ?? o.message;
    if (detail != null && detail !== '') throw new LxError(`${api}: ${String(detail)}`, 200);
  }
  return [];
}

/** 平台主 ID：按 source 取 hash / copyrightId / songmid（对齐 fnmusic contract.musicIdOf） */
function musicIdOf(item: Record<string, unknown>): string {
  const src = String(item.source ?? '');
  if (src === 'kg' && item.hash) return String(item.hash);
  if (src === 'mg' && item.copyrightId) return String(item.copyrightId);
  const cand = item.songmid ?? item.songId ?? item.id;
  return cand != null && cand !== '' ? String(cand) : '';
}

/** interval "04:29" → 秒；兼容数值秒与 _interval */
function intervalToSeconds(interval: unknown, alt?: unknown): number {
  if (typeof alt === 'number' && alt > 0) return alt;
  if (typeof interval === 'number' && interval > 0) return interval;
  const s = String(interval ?? '');
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 封面 http → https（避免前端混合内容拦截） */
const HTTPS_IMG_HINTS = ['kugou.com', 'kuwo.cn', 'music.126.net', 'gtimg.cn', 'migu'];
function normalizeCover(url: string): string {
  if (!url) return '';
  if (url.startsWith('http://')) {
    const host = url.slice(7).split('/')[0];
    if (HTTPS_IMG_HINTS.some((h) => host.includes(h))) return 'https://' + url.slice(7);
  }
  return url;
}

/** 带超时的 fetch：QuickJS 无 AbortController，用头 + Promise.race 实现。
 *  一次性返回 status + text（Fetch body 只能消费一次）。 */
async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { finished = true; reject(new LxError('请求超时', 408)); }, timeoutMs);
  });
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  headers['X-Fetch-Timeout-Ms'] = String(timeoutMs);
  try {
    const work = (async () => {
      const resp = await fetch(url, { ...init, headers });
      const text = await resp.text();
      if (finished) throw new LxError('请求超时', 408);
      return { ok: resp.ok, status: resp.status, text };
    })();
    return await Promise.race([work, timeoutPromise]);
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * lxserver 客户端。
 * @param tokenOverride 后期多用户：每 token 一个实例；首期不传，跟随 cfg.token。
 */
export class LxServerClient {
  private authToken: string | null = null;
  private authUser: string | null = null;
  private authBase: string | null = null;
  private authPending: Promise<void> | null = null;
  private authRetryAt = 0;
  private authGen = 0;

  constructor(private cfg: LXServerConfig, private tokenOverride?: string) {}

  /** 当前生效 Token（override 优先，为空视为匿名） */
  private get userToken(): string {
    return (this.tokenOverride ?? this.cfg.token ?? '').trim();
  }

  /** 用户名由 token 反查：/api/music/url 只有 x-user-name + x-user-token 成对且归属一致才走私有源 */
  private async ensureAuth(): Promise<void> {
    const token = this.userToken;
    if (!token) { this.authToken = null; this.authUser = null; return; }
    // 基址或 token 变化即作废旧归属与失败冷却，防止切换后沿用旧用户名导致 401
    if (this.authToken !== token || this.authBase !== this.cfg.host) {
      this.authToken = token;
      this.authBase = this.cfg.host;
      this.authUser = null;
      this.authRetryAt = 0;
      this.authPending = null;
      this.authGen++;
    }
    if (this.authUser) return;
    if (Date.now() < this.authRetryAt) return;
    const gen = this.authGen;
    if (!this.authPending) {
      this.authPending = this.verifyOwner(token).then((user) => {
        this.authPending = null;
        if (gen !== this.authGen) return;
        this.authUser = user;
        if (!user) this.authRetryAt = Date.now() + AUTH_RETRY_MS;
      });
    }
    await this.authPending;
    if (gen !== this.authGen) return this.ensureAuth();
  }

  private async verifyOwner(token: string): Promise<string | null> {
    try {
      const r = await this.request<{ valid?: boolean; username?: string | null }>(
        '/api/user/auth/verify',
        { method: 'GET', headers: { 'x-user-token': token } },
        5000,
      );
      return r?.valid && r.username ? r.username : null;
    } catch {
      return null;
    }
  }

  /** 鉴权快照（不触发网络请求），供测试连接/设置页展示 */
  authState(): LXAuthState {
    if (!this.userToken) return { mode: 'anonymous', user: null };
    return this.authUser ? { mode: 'user', user: this.authUser } : { mode: 'invalid', user: null };
  }

  /** 预热鉴权（连通性测试用；请求路径自身也会惰性保证） */
  async ensureAuthReady(): Promise<LXAuthState> {
    await this.ensureAuth();
    return this.authState();
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!this.userToken) return h;
    await this.ensureAuth();
    if (this.authUser) {
      h['x-user-name'] = this.authUser;
      h['x-user-token'] = this.userToken;
    }
    return h;
  }

  /** 全局并发闸 */
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (globalActive >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => globalWaiters.push(resolve));
    }
    globalActive++;
    try {
      return await fn();
    } finally {
      globalActive--;
      globalWaiters.shift()?.();
    }
  }

  /** 原始请求：fetch + 超时 + 错误信封识别 */
  private async request<T>(pathAndQuery: string, init: RequestInit, timeoutMs: number): Promise<T> {
    return this.slot(async () => {
      const base = (this.cfg.host || '').replace(/\/+$/, '');
      if (!base) throw new LxError('lxserver 地址未配置');
      const resp = await fetchTextWithTimeout(base + pathAndQuery, init, timeoutMs);
      let body: unknown;
      try { body = JSON.parse(resp.text); } catch { body = resp.text; }
      if (!resp.ok) {
        const msg = body && typeof body === 'object' && 'error' in body
          ? String((body as Record<string, unknown>).error)
          : `HTTP ${resp.status}`;
        throw new LxError(msg, resp.status);
      }
      return body as T;
    });
  }

  /** 带鉴权头的 JSON 请求 */
  private async reqJSON<T>(pathAndQuery: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const headers = await this.authHeaders();
    return this.request<T>(pathAndQuery, { ...init, headers }, timeoutMs);
  }

  /** 探活：匿名可达的轻接口，不经鉴权（避免 verify 失败时误报不可达） */
  async status(): Promise<{ reachable: boolean; detail?: string }> {
    try {
      await this.request('/api/music/tipSearch?name=x&source=kw', { method: 'GET' }, 5000);
      return { reachable: true };
    } catch (e) {
      return { reachable: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 用户名密码登录（后期设置页可选；首期主用持久 Token）。返回 token 由调用方持久化 */
  async login(username: string, password: string): Promise<string> {
    const r = await this.request<{ success?: boolean; token?: string; message?: string }>(
      '/api/user/login',
      { method: 'POST', body: JSON.stringify({ username, password }) },
      8000,
    );
    if (!r?.success || !r.token) throw new LxError(r?.message || '登录失败');
    return r.token;
  }

  /** 单源搜索：GET /api/music/search。limit 显式传入走单页，符合最新 lxserver 语义 */
  async searchSongs(source: string, name: string, limit = 20): Promise<LXTrack[]> {
    const q = new URLSearchParams({ name, source, type: 'song', page: '1', limit: String(limit) });
    const r = await this.reqJSON<unknown>(
      `/api/music/search?${q.toString()}`,
      { method: 'GET' },
      this.cfg.searchTimeout * 1000,
    );
    const list = unwrapSearchList<Record<string, unknown>>(r, 'search/song');
    return list.map((item) => this.toTrack(item));
  }

  /**
   * 歌词：POST /api/music/lyric。songInfo 必须是 search 原样返回的完整对象——
   * 各平台要的 ID 字段名不同（kg 要 hash、mg 要 copyrightId、wy 要 songmid），
   * 只传内部LXTrack.id 会拿不到歌词。
   */
  async getLyric(songInfo: Record<string, unknown>): Promise<unknown> {
    return this.reqJSON<unknown>(
      '/api/music/lyric',
      { method: 'POST', body: JSON.stringify({ songInfo }) },
      this.cfg.urlTimeout * 1000,
    );
  }

  /** 歌手搜索：GET /api/music/search?type=singer。仅 tx/wy 支持，其他源由 lxserver 返回 500。 */
  async searchSingers(source: string, name: string, limit = 10): Promise<LXArtist[]> {
    const q = new URLSearchParams({ name, source, type: 'singer', page: '1', limit: String(limit) });
    const r = await this.reqJSON<unknown>(
      `/api/music/search?${q.toString()}`,
      { method: 'GET' },
      this.cfg.searchTimeout * 1000,
    );
    const list = unwrapSearchList<Record<string, unknown>>(r, 'search/singer');
    return list
      .map((item) => ({
        id: String(item.id ?? item.mid ?? ''),
        name: String(item.name ?? ''),
        cover: normalizeCover(String(item.picUrl ?? item.img ?? item.cover ?? '')),
        aliases: Array.isArray(item.alias) ? item.alias.map((v) => String(v)) : [],
        albumSize: Number(item.albumSize ?? 0) || 0,
        source: String(item.source ?? source),
      }))
      .filter((artist) => !!artist.id && !!artist.name);
  }

  /** 歌手歌曲：GET /api/music/artistSongs。服务端一次返回该歌手全部歌曲（受 artist.maxFetchPages 限制）。 */
  async artistSongs(source: string, id: string, order = 'hot'): Promise<LXTrack[]> {
    const q = new URLSearchParams({ id, source, order });
    const r = await this.reqJSON<unknown>(
      `/api/music/artistSongs?${q.toString()}`,
      { method: 'GET' },
      this.cfg.urlTimeout * 1000,
    );
    const list = unwrapSearchList<Record<string, unknown>>(r, 'artistSongs');
    return list.map((item) => this.toTrack(item));
  }

  /** 字段归一化：lxserver 搜索的扁平 songInfo → 内部曲目模型（保留 raw 供直链解析） */
  private toTrack(item: Record<string, unknown>): LXTrack {
    const source = String(item.source ?? '');
    const types = Array.isArray(item.types) ? item.types : [];
    const lastType = types.length > 0
      ? (types[types.length - 1] as Record<string, unknown> | undefined)?.type
      : undefined;
    return {
      id: musicIdOf(item),
      name: String(item.name ?? ''),
      singer: String(item.singer ?? ''),
      album: String(item.albumName ?? item.album ?? ''),
      duration: intervalToSeconds(item.interval, item._interval),
      cover: normalizeCover(String(item.img ?? item.cover ?? item.coverUrl ?? '')),
      source,
      quality: String(lastType ?? ''),
      raw: item,
    };
  }

  /** 多源并发聚合（allSettled 失败隔离），返回按 sources 顺序的曲目，去重按 source+id */
  async searchAggregate(name: string, sources?: string[]): Promise<LXTrack[]> {
    const list = sources && sources.length > 0 ? sources : this.cfg.sources;
    const settled = await Promise.allSettled(list.map((s) => this.searchSongs(s, name)));
    const out: LXTrack[] = [];
    const seen = new Set<string>();
    settled.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      for (const t of r.value) {
        if (!t.name || !t.id) continue;
        const key = `${t.source}:${t.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    });
    return out;
  }

  /** 播放直链：songInfo 必须是 search 原样返回的完整对象（缺 hash/songmid/songId 会全源解析失败） */
  async musicUrl(
    songInfo: Record<string, unknown>,
    quality: LXQuality,
    timeoutMs = this.cfg.urlTimeout * 1000,
  ): Promise<LXPlayableUrl> {
    const body = JSON.stringify({ songInfo, quality });
    const r = await this.reqJSON<{ url?: string; type?: string; sourceName?: string; error?: string }>(
      '/api/music/url',
      { method: 'POST', body },
      timeoutMs,
    );
    if (!r || !r.url) throw new LxError(this.withAuthHint(r?.error || '解析失败:无 url'));
    return { url: r.url, type: String(r.type ?? quality), sourceName: r.sourceName };
  }

  /**
   * 音质阶梯降级：flac → 320k → 128k。
   * 服务端自己会做「同一首歌跨源轮询」，这里只补服务端没做的音质档位降级；
   * deadlineAt 由上层搜索/解析预算传入，避免阶梯各档各自吃满完整超时。
   */
  async resolveUrlLadder(
    songInfo: Record<string, unknown>,
    deadlineAt?: number,
  ): Promise<LXPlayableUrl> {
    const ladder = this.cfg.allowQualityFallback
      ? QUALITY_LADDER[this.cfg.quality]
      : [this.cfg.quality];
    const fullTimeout = this.cfg.urlTimeout * 1000;
    let lastErr: unknown;
    for (const q of ladder) {
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        throw new LxError('解析预算已耗尽');
      }
      const timeoutMs = deadlineAt === undefined
        ? fullTimeout
        : Math.max(1000, Math.min(fullTimeout, deadlineAt - Date.now()));
      try {
        return await this.musicUrl(songInfo, q, timeoutMs);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new LxError('直链解析失败');
  }

  /** lxserver 的「自定义源解析失败」既可能是没导入源，也可能是鉴权失败退回公开源，按本地鉴权态区分 */
  private withAuthHint(msg: string): string {
    if (!msg.includes('自定义源')) return msg;
    const st = this.authState();
    if (st.mode === 'invalid') {
      return `${msg}（Token 校验未通过，当前按匿名仅可访问公开源；请检查 lxserver Token 是否有效/过期）`;
    }
    if (st.mode === 'anonymous') {
      return `${msg}（未配置 Token，当前仅可访问公开源）`;
    }
    return msg;
  }
}
