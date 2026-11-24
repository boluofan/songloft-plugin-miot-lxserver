// 歌词提供者注册状态。
//
// 歌词能力依附于内置 lxserver 源：源启用才把本插件挂到宿主的歌词提供者集合；
// 关闭后连注册都摘掉，宿主不会再回调 /lyric-search —— 歌曲搜不了，歌词也不提供。
// 这样也避免没配内置源时宿主的每次歌词搜索都白问本插件一遍。

let registered = false;

export interface LyricSourceConfig {
  lxserver?: { enabled?: boolean; host?: string } | null;
}

function shouldRegister(config: LyricSourceConfig | null | undefined): boolean {
  const lx = config?.lxserver;
  return lx?.enabled === true && !!(lx.host || '').trim();
}

/** 初始化和配置保存后调用：按内置源开关对齐注册状态，重复调用无副作用。 */
export function syncLyricProvider(config: LyricSourceConfig | null | undefined): void {
  const want = shouldRegister(config);
  if (want === registered) return;
  try {
    if (want) songloft.lyrics.registerProvider();
    else songloft.lyrics.unregisterProvider();
    registered = want;
    songloft.log.info(`[lyric] 歌词提供者已${want ? '注册' : '取消注册'}`);
  } catch (e) {
    songloft.log.warn('同步歌词提供者注册状态失败: ' + String(e));
  }
}

/** 插件卸载时调用：无论当前状态如何都摘掉注册。 */
export function unregisterLyricProvider(): void {
  try {
    if (registered) songloft.lyrics.unregisterProvider();
  } catch (e) {
    songloft.log.warn('取消注册歌词提供者失败: ' + String(e));
  } finally {
    registered = false;
  }
}

/** 仅供单测重置模块状态，生产链路不调用。 */
export function resetLyricProviderStateForTest(): void {
  registered = false;
}
