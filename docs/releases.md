# 发布

发布由 tag 驱动，流程与 `mimusic-jsplugin-audiobook` 一致：本地脚本改版本、提交、打 tag 并推送，CI 只对 `v*` tag 响应。**分支推送不打包、不发版、不占版本号。**

## 一次发布

```bash
npm run release                            # 算出版本、提交、打 tag、推送
npm run release -- --dry-run               # 只打印将要执行的步骤
npm run release -- --no-push               # 只在本地产出提交和 tag
npm run release -- --version 2026.11.23.7  # 指定版本（重发或补号用）
```

`scripts/bump-version.mjs` 依次做四件事：

1. 按北京时间算出版本 `YYYY.M.D.N`：当天首个包为 `.0`，之后取「已有 tag 与清单版本的最大序号」加一；`plugin.json` 里继承自上游的版本也会占住序号，避免与已发布版本撞号。
2. 同步写 `package.json` 与 `plugin.json`（`package-lock.json` 按本仓库约定不入库，不改也不提交；`npm ci` 不校验它的 `version` 字段）。
3. 提交 `chore(release): bump to v…`，打附注 tag `v…`。
4. `git push origin HEAD:<当前分支> --follow-tags`。

工作区不干净会直接拒绝：打包的是 tag 指向的源码，未提交的改动会漏在包外。`package-lock.json` 与 `src/data/*` 是例外（前者是 npm 的版本号副作用、后者由 prebuild 重新生成），只会打印警告。

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
  git tag -d v2026.11.23.1
  git push origin :refs/tags/v2026.11.23.1
  npm run release -- --version 2026.11.23.1
  ```

- Release 建好但元数据回写失败：直接重跑工作流（Actions → Release Plugin → Re-run），不会重复上传同一个 Release。
- 已分配的版本号不复用，失败可能留下空号。

## 本地验证

```bash
node --test tests/release_version.test.mjs   # 版本号与 tag 规则
```

换日、序号递增、迁移期三段版本、清单版本占号这些规则由这组用例覆盖，测试不访问网络也不会发布。
