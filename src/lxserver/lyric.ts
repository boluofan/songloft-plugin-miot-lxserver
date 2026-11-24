// lxserver 歌词 → 宿主 LyricPayload 的归一化。
//
// 宿主契约（models.LyricPayload）：{ lyric, tlyric?, rlyric?, lxlyric? }，
// 四段都是 LRC 文本。lxserver 的 LyricInfo 字段同名，但有两处形态差异必须抹平：
//   1. 没有翻译/罗马音/逐字歌词时，SDK 直接返回一整段 LRC 字符串而不是对象；
//   2. 各源的历史字段名不一致（lrc/tlrc/rlrc/klyric/awlrc 都可能出现在返回里）。
// 归一化后交给 /lyric-search 原样返回，宿主会自行入库（StoreScrapedLyrics）。

export interface LyricPayload {
  lyric: string;
  tlyric: string;
  rlyric: string;
  lxlyric: string;
}

const FIELD_ALIASES: Array<[keyof LyricPayload, string[]]> = [
  ['lyric', ['lyric', 'lrc']],
  ['tlyric', ['tlyric', 'tlrc']],
  ['rlyric', ['rlyric', 'rlrc']],
  ['lxlyric', ['lxlyric', 'klyric', 'awlrc']],
];

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function emptyLyric(): LyricPayload {
  return { lyric: '', tlyric: '', rlyric: '', lxlyric: '' };
}

export function isLyricEmpty(payload: LyricPayload): boolean {
  return !payload.lyric && !payload.tlyric && !payload.rlyric && !payload.lxlyric;
}

/**
 * 把 lxserver 的歌词返回归一化成宿主 LyricPayload。
 * 不认识的形态返回全空（交由宿主返回 404，而不是塞一段垃圾歌词进曲库）。
 */
export function normalizeLyric(raw: unknown): LyricPayload {
  const out = emptyLyric();
  if (typeof raw === 'string') {
    out.lyric = raw.trim();
    return out;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  let source = raw as Record<string, unknown>;
  // 少数源会包一层 { code, data }；没有可识别歌词字段时才尝试拆包，
  // 避免把 data 当成歌词文本误存。
  if (!FIELD_ALIASES.some(([, aliases]) => aliases.some((key) => asText(source[key])))) {
    const data = source.data;
    if (typeof data === 'string') {
      // 少数源把整段 LRC 直接塞进 data 字符串；拆包后就是主歌词。
      out.lyric = asText(data);
      return out;
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      source = data as Record<string, unknown>;
    }
  }

  for (const [target, aliases] of FIELD_ALIASES) {
    for (const key of aliases) {
      const text = asText(source[key]);
      if (text) {
        out[target] = text;
        break;
      }
    }
  }
  return out;
}
