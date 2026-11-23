// MIoT 智能音箱插件 - lxserver「解析型音源」引用
//
// 背景：lxserver 的播放直链有时效（签名 CDN），写进曲库当天就可能失效。所以入库时不存直链，
// 只存一份「引用」——平台 + 曲目 id + 裁剪后的 search 原始对象。播放时宿主回调本插件的
// POST /api/music/url，再拿引用去 lxserver 现解析一条新鲜直链。
//
// 契约（宿主 internal/services/source/fetcher.go）：
//   入库：POST /api/v1/songs/remote { url: '', plugin_entry_path, source_data }
//   播放：POST /api/music/url     { source_data, fallback? } → { url, headers? }
// source_data 对宿主是不透明 JSON（models.Song.SourceData，原样回传），结构由本文件定义。

/// <reference types="@songloft/plugin-sdk" />

import type { LXTrack } from './types';

/**
 * 本插件在宿主侧的音源标识，必须与 plugin.json 的 entryPath 一致。
 * 宿主按它把 /api/music/url 回调打回本插件。
 */
export const PLUGIN_ENTRY_PATH = 'miot';

/** 引用结构版本：将来若换解析策略（如改存最小字段）可据此兼容旧行 */
export const SONG_REF_VERSION = 1;

// 继承 Record<string, unknown> 是为了让引用能直接塞进 OnlineSearchResult.source_data
// （其类型是 string | Record<string, unknown>），不必到处断言。
export interface LXSongRef extends Record<string, unknown> {
  v: number;
  /** 生产者标识：只有本插件写的引用才允许在入库时被改写成解析型，避免误判外部源的 source_data */
  owner?: string;
  /** lxserver 平台别名（kw/kg/tx/wy/mg），重搜兜底时用 */
  platform: string;
  /** 平台主 ID（kg 用 hash、mg 用 copyrightId，其余 songmid） */
  id: string;
  /** 歌名/歌手：raw 缺失时按它重搜补齐 */
  name?: string;
  singer?: string;
  /** 秒 */
  duration?: number;
  /** 解析成功的音质，仅用于日志 */
  quality?: string;
  /** lxserver search 原样返回的对象（裁剪版）；解析直链必须回传它 */
  raw?: Record<string, unknown>;
}

/**
 * 明确不需要、且可能很大的字段：歌词/长文本/评论。
 * 用黑名单而非白名单——各平台解析所需的字段名不一致（tx 要 strMediaMid、kg 要 hash、
 * mg 要 copyrightId、wy 要 songmid），白名单一旦漏字段就是「全源解析失败」。
 */
const DROP_FIELDS = new Set([
  'lyric', 'tlyric', 'rlyric', 'lxlyric', 'lrc', 'yrc',
  'desc', 'description', 'intro', 'summary', 'content', 'translate',
  'comment', 'comments', 'hotComment', 'recommend',
]);

/** source_data 超过这个字节数就丢掉 raw（退化为播放时重搜，避免列表接口被撑爆） */
const MAX_REF_BYTES = 8192;

/** 裁剪 search 原始对象：去掉歌词/长文本，其余原样保留 */
export function trimSongInfo(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (DROP_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** 由 lxserver 曲目构造引用（raw 裁剪 + 超限降级） */
export function buildSongRef(track: LXTrack, quality?: string): LXSongRef {
  const ref: LXSongRef = {
    v: SONG_REF_VERSION,
    owner: PLUGIN_ENTRY_PATH,
    platform: String(track.source || ''),
    id: String(track.id || ''),
    name: track.name || undefined,
    singer: track.singer || undefined,
    duration: track.duration > 0 ? track.duration : undefined,
    quality: quality || undefined,
  };
  const raw = track.raw && typeof track.raw === 'object' ? trimSongInfo(track.raw) : null;
  if (raw) ref.raw = raw;

  // 超限：牺牲 raw（播放时重搜兜底）优先保住「永久可播」，避免把列表接口撑肥。
  const size = JSON.stringify(ref).length;
  if (size > MAX_REF_BYTES && ref.raw) {
    delete ref.raw;
    songloft.log.warn(`[LxSongRef] raw too large (${size}B) for ${ref.platform}/${ref.id}, fallback to re-search`);
  }
  return ref;
}

/** 序列化为 source_data 字符串（宿主要求合法 JSON） */
export function encodeSongRef(ref: LXSongRef): string {
  return JSON.stringify(ref);
}

/**
 * 反解 source_data。兼容三种形态：本插件写的 JSON 字符串、宿主原样透传的对象、
 * 以及旧的 {platform, quality} 最小对象（无 v/id 时视为不可解析，返回 null）。
 */
export function decodeSongRef(input: unknown): LXSongRef | null {
  const obj = toObject(input);
  if (!obj) return null;
  const platform = String(obj.platform ?? '');
  const id = String(obj.id ?? '');
  if (!platform || !id) return null;
  const raw = obj.raw;
  return {
    v: Number(obj.v ?? SONG_REF_VERSION) || SONG_REF_VERSION,
    owner: typeof obj.owner === 'string' && obj.owner ? obj.owner : undefined,
    platform,
    id,
    name: typeof obj.name === 'string' && obj.name ? obj.name : undefined,
    singer: typeof obj.singer === 'string' && obj.singer ? obj.singer : undefined,
    duration: Number(obj.duration) > 0 ? Number(obj.duration) : undefined,
    quality: typeof obj.quality === 'string' && obj.quality ? obj.quality : undefined,
    raw: raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined,
  };
}

/** OnlineSearchResult.source_data 可能是对象也可能是字符串，统一取值 */
export function sourceDataOf(song: { source_data?: string | Record<string, unknown> }): unknown {
  return song.source_data;
}

// ---------- topone 外部源的引用 ----------
//
// 外部源没有「按 id 取直链」的接口，只有搜索接口，所以引用记的是「当时怎么搜到的」：
// 源 id + 关键词 + hint。播放时用同样的参数重搜一次，拿回新鲜直链。
// 代价是多一次搜索往返；换来的是曲库条目不会因为 CDN 签名过期变成死条目。

export interface ToponeHint {
  title?: string;
  artist?: string;
  duration?: number;
}

export interface ToponeSongRef extends Record<string, unknown> {
  v: number;
  owner?: string;
  kind: 'topone';
  /** 命中该结果的源 id（配置里 ExternalSearchSource.id） */
  source_id: string;
  /** 原搜索关键词，重搜时原样复用 */
  keyword: string;
  hint?: ToponeHint;
  name?: string;
  singer?: string;
  duration?: number;
}

/** 由外部源命中结果构造引用（只在结果带 http(s) 直链、且不是其它插件的解析型时调用） */
export function buildToponeRef(
  result: { title: string; artist?: string; duration?: number },
  ctx: { sourceId: string; keyword: string; hint?: ToponeHint | null },
): ToponeSongRef {
  const ref: ToponeSongRef = {
    v: SONG_REF_VERSION,
    owner: PLUGIN_ENTRY_PATH,
    kind: 'topone',
    source_id: String(ctx.sourceId || ''),
    keyword: String(ctx.keyword || '').trim(),
  };
  if (result.title) ref.name = result.title;
  if (result.artist) ref.singer = result.artist;
  if (result.duration && result.duration > 0) ref.duration = result.duration;
  const hint = ctx.hint;
  if (hint && (hint.title || hint.artist)) {
    ref.hint = {
      ...(hint.title ? { title: hint.title } : {}),
      ...(hint.artist ? { artist: hint.artist } : {}),
      ...(hint.duration && hint.duration > 0 ? { duration: hint.duration } : {}),
    };
  }
  return ref;
}

export function decodeToponeRef(input: unknown): ToponeSongRef | null {
  const obj = toObject(input);
  if (!obj) return null;
  if (String(obj.kind ?? '') !== 'topone') return null;
  const sourceId = String(obj.source_id ?? '');
  const keyword = String(obj.keyword ?? obj.name ?? '');
  if (!sourceId || !keyword) return null;
  const hintRaw = obj.hint && typeof obj.hint === 'object' && !Array.isArray(obj.hint)
    ? (obj.hint as Record<string, unknown>)
    : null;
  return {
    v: Number(obj.v ?? SONG_REF_VERSION) || SONG_REF_VERSION,
    owner: typeof obj.owner === 'string' && obj.owner ? obj.owner : undefined,
    kind: 'topone',
    source_id: sourceId,
    keyword,
    hint: hintRaw
      ? {
        title: typeof hintRaw.title === 'string' ? hintRaw.title : undefined,
        artist: typeof hintRaw.artist === 'string' ? hintRaw.artist : undefined,
        duration: Number(hintRaw.duration) > 0 ? Number(hintRaw.duration) : undefined,
      }
      : undefined,
    name: typeof obj.name === 'string' && obj.name ? obj.name : undefined,
    singer: typeof obj.singer === 'string' && obj.singer ? obj.singer : undefined,
    duration: Number(obj.duration) > 0 ? Number(obj.duration) : undefined,
  };
}

/** 把字符串/对象统一成对象（source_data 两种形态都接受） */
function toObject(input: unknown): Record<string, unknown> | null {
  let value: unknown = input;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export type DecodedRef =
  | { kind: 'lxserver'; ref: LXSongRef }
  | { kind: 'topone'; ref: ToponeSongRef };

/** 统一反解：先看 kind，再回落到 lxserver（老数据没有 kind 字段） */
export function decodeAnyRef(input: unknown): DecodedRef | null {
  const topone = decodeToponeRef(input);
  if (topone) return { kind: 'topone', ref: topone };
  const lx = decodeSongRef(input);
  if (lx) return { kind: 'lxserver', ref: lx };
  return null;
}

/**
 * 外部源的去重 key：外部源拿不到平台曲目 id，只能按「源 + 歌名 + 歌手」认。
 * 同一首歌反复搜索因此只占一行，重搜时还会刷新 source_data 里的 hint。
 */
export function toponeDedupKey(sourceId: string, result: { title: string; artist?: string }): string {
  const norm = (v: string): string => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `topone:${sourceId}:${norm(result.title)}|${norm(result.artist || '')}`.slice(0, 200);
}

/** 该搜索结果能否以「解析型」入库（有可用的引用即可） */
export function isResolvableSong(song: { source_data?: string | Record<string, unknown> }): boolean {
  return decodeAnyRef(sourceDataOf(song)) !== null;
}

/**
 * 是否本插件自己产出的引用。
 * 入库改写只认自家引用——外部 topone 源的 source_data 结构不可控，
 * 万一撞上 {platform,id} 形态，误改成解析型会让它永远播不出来。
 */
export function isOwnSongRef(song: { source_data?: string | Record<string, unknown> }): boolean {
  const decoded = decodeAnyRef(sourceDataOf(song));
  if (!decoded) return false;
  return decoded.ref.owner === PLUGIN_ENTRY_PATH;
}
