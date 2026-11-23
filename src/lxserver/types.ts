// MIoT 智能音箱插件 - 内置 lxserver 客户端类型
// 移植自 fnmusic_ext_lxserver（基于最新 lxserver 对接实现），去除飞牛音乐耦合。
// 首期仅实现搜索 + 直链解析；歌词/歌单、多用户绑定后续在此扩展。

/// <reference types="@songloft/plugin-sdk" />

import type { LXServerSettings } from '../types';

/** lxserver 内置音源平台 */
export type LXSource = 'kw' | 'kg' | 'tx' | 'wy' | 'mg';

/** 音质档位（对齐 lxserver Quality 子集） */
export type LXQuality = '128k' | '320k' | 'flac';

/** 内置 lxserver 配置（直接复用 PluginConfig.lxserver，避免两份定义漂移） */
export type LXServerConfig = LXServerSettings;

export const DEFAULT_LX_SOURCES: LXSource[] = ['kw', 'kg', 'tx', 'wy', 'mg'];

export function defaultLXServerConfig(): LXServerConfig {
  return {
    enabled: false,
    host: '',
    token: '',
    quality: '320k',
    allowQualityFallback: true,
    sources: [...DEFAULT_LX_SOURCES],
    searchTimeout: 6,
    urlTimeout: 12,
    artist_queue_enabled: false,
  };
}

/** 归一化配置：清洗来源白名单、超时边界、音质枚举 */
export function normalizeLXServerConfig(raw: Partial<LXServerConfig> | null | undefined): LXServerConfig {
  const d = defaultLXServerConfig();
  if (!raw || typeof raw !== 'object') return d;
  const validSources = new Set<string>(DEFAULT_LX_SOURCES);
  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter((s) => validSources.has(s))
    : [];
  const quality: LXQuality = raw.quality === 'flac' || raw.quality === '128k' ? raw.quality : '320k';
  const clampTimeout = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
  };
  return {
    enabled: raw.enabled === true,
    host: typeof raw.host === 'string' ? raw.host.trim().replace(/\/+$/, '') : '',
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    quality,
    allowQualityFallback: raw.allowQualityFallback !== false,
    sources: sources.length > 0 ? sources : [...DEFAULT_LX_SOURCES],
    searchTimeout: clampTimeout(raw.searchTimeout, d.searchTimeout, 1, 30),
    urlTimeout: clampTimeout(raw.urlTimeout, d.urlTimeout, 3, 60),
    artist_queue_enabled: raw.artist_queue_enabled === true,
  };
}

/** lxserver 搜索返回的曲目（保留原始 songInfo，直链解析需回传全字段） */
export interface LXTrack {
  /** 平台主 ID（kg 用 hash、mg 用 copyrightId，其余 songmid） */
  id: string;
  name: string;
  singer: string;
  album: string;
  /** 秒 */
  duration: number;
  cover: string;
  source: LXSource | string;
  quality: string;
  /** lxserver 搜索原样返回的完整对象，POST /api/music/url 必须回传它 */
  raw: Record<string, unknown>;
}

/** lxserver 歌手搜索条目（type=singer） */
export interface LXArtist {
  id: string;
  name: string;
  cover: string;
  aliases: string[];
  albumSize: number;
  source: LXSource | string;
}

/** 解析出的可播放直链 */
export interface LXPlayableUrl {
  url: string;
  /** 实际音质（可能低于请求值） */
  type: string;
  sourceName?: string;
}

/** 鉴权态（匿名/已登录/失效） */
export type LXAuthMode = 'anonymous' | 'user' | 'invalid';

export interface LXAuthState {
  mode: LXAuthMode;
  user: string | null;
}

/** LxError：携带 HTTP 状态码，便于区分鉴权失败与音源解析失败 */
export class LxError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'LxError';
    this.status = status;
  }
}
