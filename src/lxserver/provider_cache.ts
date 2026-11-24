// 内置 lxserver provider 的按配置缓存。
//
// LxServerClient 的 authUser/authPending/authRetryAt 是实例私有状态：配置没变时必须复用实例，
// 否则每条歌词/每次解析都会重新打一次 /api/user/auth/verify。三处回调（/music/url、
// /lyric-search、在线搜索）共用这套签名与缓存逻辑，避免各自 drift。

import type { ConfigManager } from '../config/manager';
import { LxServerProvider } from './provider';
import { normalizeLXServerConfig } from './types';
import type { LXServerConfig } from './types';

/** 所有会影响客户端行为的字段；任一变化都要重建实例 */
export function lxConfigSignature(cfg: LXServerConfig): string {
  return [
    cfg.host,
    cfg.token,
    cfg.quality,
    cfg.allowQualityFallback,
    cfg.sources.join(','),
    cfg.searchTimeout,
    cfg.urlTimeout,
  ].join('|');
}

export interface CachedProvider {
  config: LXServerConfig;
  provider: LxServerProvider;
}

/** 创建一个按配置签名缓存 provider 的闭包；模块级或实例级各自持有一份 */
export function createProviderCache() {
  let cache: (CachedProvider & { sig: string }) | null = null;
  return {
    /** 未启用或未配置地址时返回 null，由调用方按自己的语义处理 */
    async get(configManager: ConfigManager): Promise<CachedProvider | null> {
      const config = normalizeLXServerConfig((await configManager.getConfig()).lxserver);
      if (!config.enabled || !config.host.trim()) return null;
      const sig = lxConfigSignature(config);
      if (!cache || cache.sig !== sig) {
        cache = { sig, config, provider: new LxServerProvider(config) };
      }
      return { config: cache.config, provider: cache.provider };
    },
  };
}
