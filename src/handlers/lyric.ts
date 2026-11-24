// MIoT 智能音箱插件 - 歌词代理 Handler
//
// 背景：主程序对 remote 歌曲即使暂无歌词也会返回 lyric_url（指向
// /api/v1/songs/{id}/lyric），用于触发歌词插件的懒搜索；当确实搜不到歌词时，
// 该端点按设计返回 404。若前端直接 fetch 这个 404，浏览器会把它记为网络错误
// 打到控制台（window.fetch 原生行为，JS 的 try/catch 无法抑制）。
//
// 本 handler 在插件后端代理该请求：把「无歌词」的 404 归一化为 200 空 payload，
// 前端只与本插件端点通信，从而消除控制台的 404 噪音，同时保持主程序
// 的 404-by-design 语义不变。
//
// 另外实现 /lyric-search：本插件注册为歌词提供者后，宿主对无歌词歌曲回调该端点，
// 用内置 lxserver 源搜词，命中结果由宿主自动入库（StoreScrapedLyrics）。

import { jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { callHostAPI } from '../utils/http';
import type { ConfigManager } from '../config/manager';
import { normalizeLXServerConfig } from '../lxserver/types';
import { LxServerProvider } from '../lxserver/provider';
import { isLyricEmpty } from '../lxserver/lyric';

interface HostLyricPayload {
  lyric?: string;
  tlyric?: string;
  rlyric?: string;
  lxlyric?: string;
}

/**
 * 注册歌词代理路由
 * GET /lyric?song_id=123 → 代理主程序 /api/v1/songs/{id}/lyric
 * 返回统一 data envelope；仅未命中时 lyric 为空，其他失败供页面提示重试。
 */
export function registerLyricHandlers(router: Router, configManager?: ConfigManager): void {
  router.get('/lyric', async (req: HTTPRequest) => {
    const query = parseQuery(req.query);
    const songId = query.song_id;
    if (!songId) {
      return jsonResponse({ success: false, error: '缺少 song_id' }, 400);
    }
    const refresh = query.refresh && query.refresh !== 'false' ? '?refresh=1' : '';

    try {
      const payload = await callHostAPI<HostLyricPayload>(
        'GET',
        `/api/v1/songs/${encodeURIComponent(songId)}/lyric${refresh}`,
        undefined,
        // 宿主给每个歌词提供者 15 秒，代理需为搜索和网络开销留出时间。
        { timeoutMs: 30000 },
      );
      return jsonResponse({
        success: true,
        data: {
          lyric: payload?.lyric || '',
          tlyric: payload?.tlyric || '',
          rlyric: payload?.rlyric || '',
          lxlyric: payload?.lxlyric || '',
        },
      });
    } catch (e: any) {
      // 404 表示该歌曲无歌词（主程序设计如此），静默归一化为空歌词。
      // 其他错误不能伪装成「没有歌词」，否则慢搜索失败后用户无法重试。
      const msg = String(e?.message || e);
      if (!/^Host API error 404 /.test(msg)) {
        songloft.log.warn('[lyric] fetch lyric failed song_id=' + songId + ': ' + msg);
        return jsonResponse({ success: false, error: '歌词获取失败，请重试' }, 502);
      }
      return jsonResponse({
        success: true,
        data: { lyric: '', tlyric: '', rlyric: '', lxlyric: '' },
      });
    }
  });

  // 宿主歌词提供者回调：GET /lyric-search?title=&artist=&album=&duration=
  // 响应必须是裸 LyricPayload（宿主直接 json.Unmarshal 到 models.LyricPayload），
  // 包一层 {success,data} 会被当成空歌词丢弃。空对象同样是合法的「没找到」。
  router.get('/lyric-search', async (req: HTTPRequest) => {
    const query = parseQuery(req.query);
    const title = String(query.title ?? '').trim();
    const artist = String(query.artist ?? '').trim();
    const duration = Number(query.duration) || 0;

    const search = async () => {
      if (!configManager || !title) return null;
      const config = await configManager.getConfig();
      const cfg = normalizeLXServerConfig(config.lxserver);
      if (!cfg.enabled || !cfg.host) return null;

      const provider = new LxServerProvider(cfg);
      const hint = { title, artist: artist || undefined, duration };
      // "歌手 歌名" 组合先搜；无结果时 provider 内部按 hint.title 兜底重搜。
      const keyword = artist ? `${artist} ${title}` : title;
      const tracks = await provider.findTracksForLyric(keyword, hint);
      for (const track of tracks.slice(0, 3)) {
        const payload = await provider.getTrackLyric(track);
        if (!isLyricEmpty(payload)) {
          // 宿主字段带 omitempty：空段不返回，保持与宿主体响应一致。
          const clean: Record<string, string> = {};
          for (const [key, value] of Object.entries(payload)) {
            if (value) clean[key] = value;
          }
          return clean;
        }
      }
      return null;
    };

    // 宿主给每个歌词提供者 15s；留 3s 余量，慢搜索不能拖到宿主判定失败。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('lyric-search 超时')), 12_000);
    });
    try {
      const payload = await Promise.race([search(), timeout]);
      // 宿主只认 200 + 非空 LyricPayload；404 让它尽快跳到下一个提供者。
      return payload ? jsonResponse(payload, 200) : jsonResponse({}, 404);
    } catch (e) {
      songloft.log.warn('[lyric] /lyric-search failed: ' + String(e));
      return jsonResponse({}, 404);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
}
