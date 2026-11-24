# 发布

发布由 tag 驱动，与 `mimusic-jsplugin-audiobook`、`songloft-plugin-karaoke-lyric` 同构：本地脚本改版本、提交、打 tag 并推送，CI 只对 `v*` tag 响应。**分支推送不打包、不发版。**

版本是 semver，与 tag 完全一致（`plugin.json` 写 `1.1.0`，tag 是 `v1.1.0`）。宿主侧也只要求三段数字：`ValidateManifest` 用 `^\d+\.\d+\.\d+` 校验，`checkUpdate` 用字符串不等判断有无更新，没有「降级」概念。

## 一次发布

```bash
npm run release                            # 默认 patch 自增，1.1.0 → 1.1.1
npm run release -- --minor                 # 1.1.3 → 1.2.0
npm run release -- --major                 # 1.1.3 → 2.0.0
npm run release -- --dry-run               # 只打印将要执行的步骤
npm run release -- --no-push               # 只在本地产出提交和 tag
npm run release -- --version 1.2.0         # 指定版本（重发或补号用）
```

`scripts/bump-version.mjs` 依次做四件事：

1. 算出下一个版本：取「已有 tag 与清单版本」中的最大者，按 `--major` / `--minor` / `--patch`（默认）进位。**清单版本还没有对应 tag 时直接发它本身**——首次改用 semver、或手工调过版本时不会凭空跳过 1.1.0。
2. 同步写 `package.json` 与 `plugin.json`（`package-lock.json` 按本仓库约定不入库，不改也不提交；`npm ci` 不校验它的 `version` 字段）。
3. 提交 `chore(release): bump to v…`，打附注 tag `v…`；版本号本来就没变（首发）时跳过提交，只打 tag。
4. `git push origin HEAD:<当前分支> --follow-tags`。

工作区不干净会直接拒绝：打包的是 tag 指向的源码，未提交的改动会漏在包外。`package-lock.json` 与 `src/data/*` 是例外（前者是 npm 的版本号副作用、后者由 prebuild 重新生成），只会打印警告。**本地落后于远端也会拒绝**：CI 发完版会往默认分支回写清单提交，直接发版会在 push 时被拒，脚本在动文件之前就拦住并提示 `git pull --ff-only`。

## CI 做什么

`.github/workflows/release.yml` 监听 `push: tags: ['v*']`，按顺序：

1. checkout 该 tag；
2. 校验 `plugin.json.version` 与 tag 一致，不一致立即失败（防止 tag 和清单对不上）；
3. `npm ci`（含 `frontend/`）、两层 `tsc --noEmit`；
4. 插件全量测试 `node --experimental-strip-types --test tests/*.test.mjs` 与前端测试；
5. `npm run build` + `npm run validate`；
6. 生成更新说明并 `gh release create` 上传 `dist/miot.jsplugin.zip`；
7. 把 `download_url`、`updateUrl`、`entryHash`、`zipHash`、`releaseSource` 回写到默认分支（`lxserver`）的 `plugin.json` 并提交。

第 7 步只补发布后才存在的信息，版本号在 tag 里已经改过。`updateUrl` 指向本仓库默认分支，插件自更新取的是本项目的包，不会回落到上游。`releaseSource` 记该包的构建提交，由 CI 写入（上游同名流程也是自己写），不写会一直留着上游的旧 SHA。

## Release 正文（更新说明）

第 6 步的正文不是 GitHub 自动拼的英文 "What's Changed"，而是 `scripts/release-notes.mjs` 生成的：取**上一版 tag..本次 tag** 之间的提交，按 Conventional Commits 类型分组。

```markdown
## 更新内容

### ✨ 新功能

- `voice`: 加口令 ([ccc3333](https://github.com/…/commit/ccc3333)) (commit by @boluofan)

### 🐛 修复

- `search`: 入库模式允许播放时解析外部音源 ([6e89a24](https://github.com/…/commit/6e89a24)) (commit by @hanxi)

---

**完整对比**：[v1.1.1...v1.1.2](https://github.com/…/compare/v1.1.1...v1.1.2)
```

规则：

- 分组顺序固定：💥 不兼容变更 → ✨ 新功能 → 🐛 修复 → ⚡ 性能 → ♻️ 重构 → 📝 文档 → 📦 构建 → 🤖 持续集成 → ✅ 测试 → 🎨 代码风格 → 🔧 杂项 → ⏪ 回滚 → 📌 其他。组内按提交时间倒序。
- 每条提交末尾带 `(commit by @作者)`：优先从 GitHub noreply 邮箱里取 username（正文里的 `@username` 会被 GitHub 自动链到主页），普通邮箱退回提交里的 author name；没有作者信息的旧数据不显示这一段。
- `chore(release)` 不列出：改的只是版本号，而且它自己就在被发布的这批提交里。
- 类型不在表内的提交（如 `wip:`）落到「其他」，不会被丢掉；不符合 `type(scope): 描述` 格式的同样归到「其他」。
- 「上一版 tag」按 **semver 数值**取严格小于本次的最大者，不用 `git tag --sort=creatordate` 取末尾——手动补发某个旧 tag 时，时间序会取到比它新的 tag，changelog 范围就反了。
- 首个版本没有上一版，范围从仓库首个提交算起。
- CI 里脚本失败不会阻断发布：`--generate-notes` 兜底，包照发。
- 因此**提交信息要按约定写**（`feat(scope): 中文描述`），这是更新说明唯一的信息来源。

本地预览（不发布、不联网）：

```bash
npm run release:notes -- --tag v1.1.2     # 打印 v1.1.1..v1.1.2 的更新说明
npm run release:notes                     # 省略 --tag 时取当前 HEAD 上的 tag
```

`main` 只作上游镜像（通过 GitHub Sync fork 维护），不参与发布，也不接受发布元数据提交。

## 失败与重发

- 校验或构建失败：该 tag 不会产生 Release。修好后删除 tag 再重发：

  ```bash
  git tag -d v1.1.1
  git push origin :refs/tags/v1.1.1
  npm run release -- --version 1.1.1
  ```

- Release 建好但元数据回写失败：直接重跑工作流（Actions → Release Plugin → Re-run），不会重复上传同一个 Release。
- 已分配的版本号不复用，失败可能留下空号。

## 本地验证

```bash
node --test tests/release_version.test.mjs   # 版本号与 tag 规则
node --test tests/release_notes.test.mjs     # Release 正文的分组与范围
```

patch/minor/major 进位、首发不跳号、tag 领先时倒挂、非 semver 报错、tag 格式这些规则由第一组用例覆盖；分组顺序、发版提交过滤、破坏性变更置顶、补发旧 tag 时的范围选择由第二组覆盖。测试不访问网络也不会发布。
