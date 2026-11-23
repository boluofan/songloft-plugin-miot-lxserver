# 待办与待决策事项

按「需要人拍板 / 尚未分析完」的事项登记，做完的条目从这里删掉并落到对应实现或 `docs/issue-*.md`。

| # | 事项 | 状态 | 优先级 | 关联 |
| --- | --- | --- | --- | --- |
| 1 | 插件播放不写宿主播放历史 | 待分析（方案已给，未拍板） | P2 | 主仓库 `internal/handlers/music.go:3395`（`SongPlayed`）、`internal/handlers/play_history.go` |

---

## 1. 插件播放不写宿主播放历史

**状态**：方案已调研完成，等两个决策点（见「待拍板」），暂不动代码。

**一句话**：插件从头到尾没有发过 `type=play`，所以宿主那条「按播放上下文的播放历史」对音箱侧播放完全空白。

### 不处理会怎样（缺陷清单）

分三类。A 类确定发生且只能靠上报解决，B 类**不受影响**（别误当 bug），C 类是将来补的时候容易踩的坑。

#### A. 确定存在的功能缺口

1. **宿主 App 的播放历史面板对插件播放永远为空。**
   `PlayHistoryPanel` 挂在 `CategorySongsPage`（歌手/专辑/流派等分面页）与 `TagSongsPage` 上，按 `(context_type, context_key)` 二元组查询。插件一条都没写 → 用户在音箱上说「播放周杰伦的歌」，回到 App 打开「周杰伦」页点「播放历史」，是空的。而这段播放恰恰是他最想在 App 里找回来的。
2. **按上下文续听断链。**
   历史面板的价值是「看到刚才放的，点一下接着听」。没有历史，用户只能靠歌名重新搜。
3. **`play_count` 缺一半口径。**
   历史条目带播放次数（同上下文内 upsert 累加）。现在这个数字只统计 App 侧播放，音箱侧不计入。若 App 有按热度/常听排序的展示，插件播放的歌会被系统性低估。
4. **播放事件广播也缺失（影响面比历史更广）。**
   `POST /songs/{id}/played` 除了落库，还会 `BroadcastPlayEvent(songID, title, artist, type, source)` 给所有注册了 `songloft.events.onPlayEvent` 的插件。插件不发请求，任何订阅播放事件的插件（歌词联动、灯效、自动化等）都感知不到音箱侧播放。**目前没有已知的这类下游依赖**，所以算潜在缺口而非当下故障——但它意味着「miot 播放」在宿主生态里是隐形的。
5. **数据不可回溯（延迟成本，非 bug）。**
   历史只能从开始上报那天起产生。今天不做的每一天都是永久空白；将来补上后，用户看到的历史起点会是某一天，之前的音箱播放补不回来。

#### B. 不受影响的（避免误判）

- **插件自己的重启恢复**：`PlaylistManager.persistState` + `PlaylistManagerMap.restoreTempPlaylists`（`player/manager.ts:4441`）+ 设备状态缓存，全部走插件自己的存储，**不依赖宿主播放历史**。重启后接着播的能力不受影响。
- 播放、收藏、歌单、点歌、歌词、AI 对话全链路，没有任何一处读 `/play-history`。
- 宿主侧的清理、去重、50 条裁剪逻辑照常工作，只是永远没有 `source=miot` 的行。

#### C. 将来补的时候的坑（现在就要记下来）

- **`context_key` 用错会写孤儿数据。** 宿主的 `context_key` 是**原样字符串**（`NormalizeArtistKey` 只用于 `?artist=` 过滤，不用于历史键）。传用户口令原文（「周杰倫」）而 App 歌手页查的是「周杰伦」，历史会落到一个谁也不查的 key 下，比不写更糟。
- **重复上报会把 `play_count` 刷高。** 宿主是 upsert + 累加次数，必须按播放会话去重。
- **老宿主 404 若不打标记**，每首歌都会打一次无效请求。该端点与 `/playlists/{id}/song-ids` 是同一个 commit（`a929c82`，2026-07-30），晚于 2.10.0 发布，`minHostVersion` 仍是 2.9.5。

### 宿主契约（已核对源码）

入口 `SongHandler.SongPlayed`（主仓库 `internal/handlers/music.go:3395`），落库分支在 `:3425-3432`；查询侧 `internal/handlers/play_history.go`。

- 上报：`POST /api/v1/songs/{id}/played?source=miot&type=play&context_type=…&context_key=…`
- 落库条件：**仅 `type=play` 且 `context_type`、`context_key` 同时非空**。`finish`/`skip` 一律不落库（宿主刻意为之：skip 上报的是上一首，上下文可能已切，会记错归属）。缺任一参数仍会广播事件，只是不落库。
- 同一上下文内按歌曲去重、upsert 刷新时间并累加 `play_count`，最多保留最近 50 条，因此 `/play-history` 不分页。
- `id` 必须是宿主库里存在的歌，否则 404；歌曲从库中删除时历史级联清理。
- 合法 `context_type`：`playlist` / `tag` / 分面维度 `artist` / `album` / `genre` / `year` / `decade` / `language` / `style`。

### 建议方案

上下文映射（`PlaylistManager` 里已有全部信息：`playlistId`、`tempPlaylistName`、`tempArtistQuery`）：

| 队列来源 | `playlistId` | 映射 |
| --- | --- | --- |
| 真歌单（`play_playlist`、收藏、页面点播） | `> 0` | `{playlist, String(id)}`，直接可得 |
| 歌手口令（`play_artist`） | `tempId` 负数 | `{artist, 规范署名}`，名字必须与宿主对齐 |
| 「全部歌曲」虚拟歌单 | `MAX_SAFE_INTEGER` | 宿主无此上下文，**不传 context**（只发事件不落库） |
| 单曲点播 / 在线临时队列 | `0` 或负数且 `song.id === 0` | **整条跳过**（宿主 404，无从落库） |

三个实现要点：

1. **歌手名的来源**：用 `resolveArtistSongs` 从名录命中的那个署名（`catalog.names[i]`），而不是用户口令原文。
2. **不要用 `tempArtistQuery` 兜底在线歌手队列**：`music/service.ts:1477/1519` 调 `playWithSongs(..., '')` 会把 `tempArtistQuery` 清空，只剩 `tempPlaylistName`（`歌手: xxx`）。建议加一个专用字段，别解析 label 字符串。
3. **上报时机**：不能在投递 URL 时上报（设备离线、被打断都会误记）。真正的确认点是 `playbackConfirmed = true`（`player/manager.ts:3280 / 3290 / 4039`，来自设备状态轮询）。按播放会话去重：`reportedKey = ${song.id}@${playStartTimeMs}`，同会话同曲只报一次。

容错：`void` fire-and-forget + catch，3s 超时；404/405 一次就置进程内 flag 不再尝试；失败只 `log.info`，不影响投递与播放。

实施顺序：

1. **P0** `PlaylistManager` 增加 `playContext?: { type, key }`，在 `play()`（真歌单）与 `playWithSongs()`（歌手）两处赋值；`resolveArtistSongs` 额外返回命中署名。
2. **P0** 在 `playbackConfirmed` 首次为 true 处上报，带会话级去重与探活降级。
3. **P1**（可选）无上下文的场景（全部歌曲、单曲点播）只发 `type=play&source=miot` 不带 context，让事件广播完整。
4. 新增独立测试文件 `tests/play_history_report.test.mjs`（用可编程 `callHostAPI` 桩断言 URL、去重、404 降级），**不要碰** `player_failures` 那张需要手工维护的依赖表。

### 待拍板

1. 歌手上下文键用「名录命中的规范署名」；**找不到名录命中时**是回退到口令原文，还是干脆不报？倾向回退（宁可 key 略偏，也别丢历史）。
2. 「全部歌曲」（虚拟歌单，宿主无对应上下文）要不要只发 play 事件、不落库？

### 验证方式

- 单测：新增独立文件，覆盖真歌单 / 歌手 / 虚拟歌单 / `id=0` 四条映射，以及「同会话只报一次」「404 后不再请求」。
- 联通：真实宿主下播一个歌单，`GET /play-history?context_type=playlist&context_key=<id>` 能看到该歌；分别在 2.9.5 / 2.10.0 宿主上确认不报错。
- 反向：Audit 日志确认未引入额外请求（老宿主只应有 1 次 404 探测）。
