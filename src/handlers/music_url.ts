// MIoT 智能音箱插件 - 音源解析端点（宿主契约）
//
// 宿主在播放「解析型」歌曲时回调本端点（internal/services/source/fetcher.go:
// InvokeHTTP(entryPath, "POST", "/api/music/url")，插件侧去掉 /api 前缀后即 /music/url）：
//
//   POST /music/url
//   { "source_data": {...}, "fallback": { "enabled": true, "title": "...", "artist": "...", "duration": 0 } }
//   → 200 { "url": "https://..." }          （可选 headers / source_data / used_fallback）
//   → 非 200 时宿主返回 502 并异步切源
//
// 这条链路让我们能把 lxserver 的歌曲以「引用」入库：库里的条目永久有效，直链每次播放现取。

import { jsonResponse } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import type { ConfigManager } from '../config/manager';
import { chatBody } from './chat';
import { LxServerProvider } from '../lxserver/provider';
import { decodeAnyRef } from '../lxserver/ref';
import { createProviderCache } from '../lxserver/provider_cache';
import { OnlineSearcher } from '../voicecmd/online_searcher';

/** 按配置签名复用 provider，保住 client 内部的鉴权结果 */
const providerCache = createProviderCache();

/**
 * 注册音源解析路由
 * 注册后本插件即可作为 songloft 的「解析型音源」（plugin_entry_path = plugin.json 的 entryPath）。
 */
export function registerMusicSourceHandlers(router: Router, configManager: ConfigManager): void {
  /** 取当前配置下的解析器（配置未变则复用，保住鉴权态） */
  const getProvider = async (): Promise<LxServerProvider> => {
    const cached = await providerCache.get(configManager);
    if (!cached) throw new Error('内置 lxserver 未启用或未配置地址');
    return cached.provider;
  };

  // 外部源解析：复用 OnlineSearcher 的搜索链路（含去空白重试），不另写一套请求格式
  let sourceSearcher: OnlineSearcher | null = null;
  const getSearcher = (): OnlineSearcher => {
    if (!sourceSearcher) sourceSearcher = new OnlineSearcher(configManager);
    return sourceSearcher;
  };

  router.post('/music/url', async (req: HTTPRequest) => {
    let body: Record<string, unknown>;
    try {
      body = chatBody(req);
    } catch (e) {
      return jsonResponse({ error: '请求 JSON 无效' }, 400);
    }

    // 宿主把 source_data 原样回传（models.Song.SourceData 是字符串，但 json.RawMessage
    // 序列化后到达这里可能是对象），两种形态都接受。
    const decoded = decodeAnyRef(body.source_data);
    if (!decoded) {
      return jsonResponse({ error: 'source_data 不是本插件可解析的引用' }, 400);
    }

    try {
      // 外部源：引用里只有「怎么搜到的」，用同样参数重搜一次拿新鲜直链
      if (decoded.kind === 'topone') {
        const url = await getSearcher().resolveSourceRef(decoded.ref);
        songloft.log.info(`[MusicSource] resolved topone ref (${decoded.ref.name || decoded.ref.keyword})`);
        return jsonResponse({ url });
      }

      const provider = await getProvider();
      const playable = await provider.resolveSongRef(decoded.ref);
      if (!playable || !playable.url) {
        return jsonResponse({ error: '解析失败:无 url' }, 502);
      }
      songloft.log.info(
        `[MusicSource] resolved ${decoded.ref.platform}/${decoded.ref.id} (${decoded.ref.name || '-'}) quality=${playable.type || '-'}`,
      );
      // headers 不返回：lxserver 直链是公开 CDN，不需要 Referer/UA。
      return jsonResponse({ url: playable.url });
    } catch (e: any) {
      const msg = String(e?.message || e);
      // 不伪装成成功：宿主拿到非 200 会返 502 并触发异步切源，比「返一个假 url」可诊断得多。
      songloft.log.warn(`[MusicSource] resolve failed: ${msg}`);
      return jsonResponse({ error: msg }, 502);
    }
  });
}
