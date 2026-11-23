# 冲突处理手册（lxserver 定制 vs 上游 main）

合并时真正花时间的不是 `git cherry-pick`，是判断「这处改动谁的意思算数」。这份手册记录本仓库的定制点与已知的冲突形态。

## 1. 定制分支的实际内容

`git diff --name-only $(git merge-base main lxserver)..lxserver` 会给出完整清单。按功能归纳：

| 定制能力 | 主要落点 | 绝不能丢的东西 |
| --- | --- | --- |
| 内置 lxserver 在线搜索源 | `src/lxserver/*`（client/provider/ref/types）、`config/manager.ts`、`frontend/.../VoiceSettings.tsx`、`src/voicecmd/online_searcher.ts` | 配置项 `external_search_*` 的读写兼容；音源别名只用 `kw/kg/tx/wy/mg` |
| 在线歌手队列 + 直链懒解析 | `player/manager.ts`（`setSongUrlResolver` 钩子）、`online_searcher.searchArtistQueue` | 临播前补 `song.url`；lookahead 不递归；在线队列 `order`、本地队列 `random` |
| 命中以「引用」入库 + 宿主解析回调 | `src/handlers/music_url.ts`、`src/lxserver/ref.ts` | `plugin_entry_path` = `miot`；`decodeAnyRef` 的向后兼容；直推模式曲目 `url` 留空、由钩子按 TTL 现取 |
| 歌手口令全曲库匹配 | `src/indexing/manager.ts` 的 `resolveArtistSongs`、`music/service.ts` 的 `executePlayArtist` | **两条链路取并集**（索引扫描必跑 + 宿主名录增量）；remote 歌因不写 `song_artists` 只能靠索引链路 |
| 收藏状态走 song-ids | `src/utils/playlist_membership.ts`、`handlers/playlist.ts` | 空 `{ids:[],total:0}` 判「不在」；404 降级 `getSongs` |
| 在线查重走 keyword | `online_searcher.findExistingSong` | `?keyword=` + `limit=50` + `exclude_playlist_labels=none` |
| 测试基建 | `tests/chat_loader.mjs`（SDK 回退）、`tests/player_failures.test.mjs`（依赖表 + `sourceCache`） | 本机没 clone toolchain 也能跑全量 |

## 2. 冲突高发文件（上游常改、本地也有改动）

- `src/player/manager.ts`、`src/music/service.ts`、`src/indexing/manager.ts`
- `src/handlers/playlist.ts`、`src/handlers/config.ts`、`src/main.ts`
- `frontend/src/store.ts`、`frontend/src/types.ts`、`frontend/src/views/settings/VoiceSettings.tsx`
- `tests/chat_loader.mjs`、`tests/player_failures.test.mjs`、`tests/player_status.test.mjs`
- `README.md` / `README.en.md` / `AGENTS.md` / `AGENTS.en.md`

改到这些文件的提交，`analyze_upstream.sh` 会打 ⚠。

## 3. 处理规则

1. **先读两边的意图，再决定内容。** 不用 `-X ours` / `-X theirs` 一刀切：`-X theirs` 会静默丢掉定制，`-X ours` 会静默丢掉上游修复——两种都不可接受。
2. **上游改行为、本地改结构**（最常见）：按上游的新行为，把定制装进新结构里。例：上游把 `names` 从「整串署名」改成「拆开的单个歌手」（`54e820b`），定制侧的并集逻辑要跟着改成按归一键匹配，而不是保留旧注释。
3. **上游重构搬走了定制挂载点**（函数改名/挪文件/删钩子）：跟着搬，先确认功能在，再删旧写法。搬不动就 `git cherry-pick --abort` 并把它列进「需人工复核」。
4. **文档冲突**：README/AGENTS 的定制段落保留，同时吸收上游新增的通用条目——两边都要，别整段取一边。
5. **测试冲突**：上游的断言通常对，本地改动可能让它们失效。先在本地改动上跑一遍，确认是「上游预期 vs 定制行为」的真实分歧，还是在修定制引入的回归。**不许为了让测试变绿而删上游断言**，只许改成同时表达两种意图。
6. **拿不准就停**：`git cherry-pick --abort`，在报告里写清卡在哪、两边各要什么，交给人判断。误合比没合贵得多。
7. **契约冲突先去主仓库核对，别猜**。定制的价值大半在「跟宿主语义对齐」，一旦上游改的是接口语义，答案不在两边代码里，在宿主实现里：
   ```bash
   cd C:/dev/boluofan/songloft-org
   grep -rn "func (h .*) <HandlerName>" internal/handlers/*.go
   grep -rn "<字段名>" internal/repository internal/models | head
   grep -n "<路由片段>" internal/app/routers.go
   ```
   以主仓库当前行为为准。例：`names?field=artist` 在 `54e820b` 之后返回「拆开的单个歌手」而不是整串，定制侧若还按整串匹配就是错的。

## 4. 重复修复的真实案例

上游和定制都修了同一个问题，这类决策最容易被「谁先看到」带偏。下面是本仓库真实发生过的一次，当作模板：

**问题**：`播放歌手 X` 时，插件导入的 remote 歌命中不到。

- **上游方案**（`54e820b` 一带）：把 `names?field=artist` 改成走 `song_artists` 关联表返回拆开的单个歌手，`songs?artist=` 用 `NormalizeArtistKey` 匹配归一键。看起来更"正确"。
- **本地方案**（`9d9fe9e`）：索引扫描 + 宿主名录取并集。
- **判断**：上游的归一化匹配确实更好，但**没解决根因**——`AddRemoteSongs → UpsertRemote → SongRepository.Create()` 只写 `songs` 表、不写 `song_artists`（migration 0038 只做一次性回填），插件导入的歌在关联表里根本没有行，上游那套再精确也查不到。
- **结论 C 融合**：保留并集结构（索引链路必跑），把上游的归一化键匹配吸收进名录链路。既没丢远程歌，也没拒绝上游的改进。

**可复用的判据**：当上游方案「更漂亮」但本地方案「解决了上游看不见的前提」时，选融合，不要二选一。反过来，如果本地方案只是「当年绕过去的土办法」而上游修了根因，就该采用上游并删掉本地。

## 5. 不需要合并的上游提交

- `chore(release)` / 版本号 bump / `package.json` bump（版本由本分支自己的发布流程决定）
- 纯 CI、依赖机器人、格式化、拼写修正（除非影响到构建产物）
- 与本插件业务无关的联调/脚手架改动
- 已经在 lxserver 里以等价形式存在的改动（`git cherry` 标 `-` 的那些，不要再 pick）

## 6. 合并后的自检清单

- [ ] 定制五件事仍可用：内置 lxserver 搜索、在线歌手队列、引用入库 + `/music/url` 回调、歌手名录并集、收藏 song-ids
- [ ] 没有留下两份等价实现（选了「采用上游」就必须删掉本地那份）
- [ ] `git cherry lxserver main` 里没有残留的 `+`
- [ ] `scripts/verify.sh` 全绿（tsc + 全量测试 + validate）
- [ ] 没有 `push`（推送永远由人执行）
