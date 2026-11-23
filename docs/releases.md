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
6. `gh release create` 上传 `dist/miot.jsplugin.zip`，说明由 GitHub 自动生成；
7. 把 `download_url`、`updateUrl`、`entryHash`、`zipHash`、`releaseSource` 回写到默认分支（`lxserver`）的 `plugin.json` 并提交。

第 7 步只补发布后才存在的信息，版本号在 tag 里已经改过。`updateUrl` 指向本仓库默认分支，插件自更新取的是本项目的包，不会回落到上游。`releaseSource` 记该包的构建提交，由 CI 写入（上游同名流程也是自己写），不写会一直留着上游的旧 SHA。

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
```

patch/minor/major 进位、首发不跳号、tag 领先时倒挂、非 semver 报错、tag 格式这些规则由这组用例覆盖，测试不访问网络也不会发布。
