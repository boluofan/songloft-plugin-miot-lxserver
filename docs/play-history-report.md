# 播放历史上报

[English](en/play-history-report.md)

音箱侧播放此前从未上报宿主，导致宿主 App 的播放历史面板对插件播放永远为空、`play_count` 少一半口径、订阅 `onPlayEvent` 的插件感知不到音箱播放。本功能在「设备确认真的发声」时补一次上报。

## 宿主契约

入口是宿主 `POST /api/v1/songs/{id}/played?source=miot`。只有 `type=play` 且 `context_type`、`context_key` 同时非空才落库；缺任一参数仍会广播事件，只是不写历史。同一上下文内按歌曲 upsert 并累加 `play_count`，最多留 50 条。老宿主（早于 2.10.0）没有这条路由，首次 404/405 后置进程内标记，之后不再请求。

## 上报时机

只在 `playbackConfirmed` 首次由 false 变 true 时上报。四个确认点（push 假失败核实、landing verify、外停轮询的位置推进、重载接管后回读设备在播）统一走 `PlaylistManager.markPlaybackConfirmed()`，重复确认由 `reportedSongId` 挡掉。不在投递 URL 时上报——设备离线、被打断都会误记。暂停后续播同一首不重复计数。

上报是 fire-and-forget（3 秒超时），失败只记日志，不阻塞投递与切歌。

## 队列到上下文的映射

| 队列来源 | `context_type` / `context_key` | 结果 |
| --- | --- | --- |
| 真歌单（play_playlist / 收藏 / 页面点播） | `playlist` / 宿主歌单 id | 落库 |
| 歌手口令（名录命中） | `artist` / 名录命中的规范署名 | 落库 |
| 歌手口令（名录不可用或未命中） | `artist` / 用户口令原文 | 落库（宁可 key 略偏也别丢历史） |
| 重启恢复的歌手队列 | `artist` / 持久化下来的署名 | 落库 |
| 「全部歌曲」虚拟歌单 | 不传 context | 只广播事件，不落库（宿主没有对应上下文） |
| 单曲点播 / 在线临时队列（`song.id === 0`） | — | 整条跳过（宿主会 404） |

规范署名由 `IndexingManager.resolveArtistCredit()` 取，复用歌手名录的进程内缓存与既有模糊打分，不额外打宿主接口；老宿主没有名录接口时返回空串，由调用方回退口令原文。

## 验证

`tests/play_history_report.test.mjs` 用可编程的 `callHostAPI` 桩覆盖：四类映射的 URL、同会话只报一次、`song.id=0` 跳过、404 后不再请求、规范署名解析与回退。全量 `node --test tests/*.test.mjs` 通过；类型检查、构建与包校验通过。真机发声、宿主 App 历史面板的实际显示与长期运行未验。
