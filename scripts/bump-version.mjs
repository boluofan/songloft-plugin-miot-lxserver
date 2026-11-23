#!/usr/bin/env node
// 本地发布入口：算版本 → 改 package.json / package-lock.json / plugin.json →
// 提交 → 打 tag → 推送。推送 tag 后由 .github/workflows/release.yml 构建并创建 Release。
//
// 用法：
//   npm run release                  # 计算当天下一个版本并发版
//   npm run release -- --dry-run     # 只打印将要执行的步骤
//   npm run release -- --no-push     # 只在本地产出提交和 tag
//   npm run release -- --version 2026.11.23.7
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextVersion, tagVersion } from './release-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const push = !args.includes('--no-push');
const forced = args.includes('--version') ? args[args.indexOf('--version') + 1] : undefined;

const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const readJSON = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
const writeJSON = (path, value) => writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');

if (forced && !tagVersion(`v${forced}`)) throw new Error(`--version 需要 YYYY.M.D.N 形式：${forced}`);

// 打包的是 tag 指向的源码：工作区有未提交改动时，打出来的包会漏掉它们。
// 两类例外不阻断发布——它们由构建重新生成或按仓库约定不入库，脏着发版不影响产物：
//   package-lock.json（npm install 的版本号副作用）、src/data/*（prebuild 重写的行尾）。
const DIRTY_IGNORED = /(^| )package-lock\.json$|^..? src\/data\//;
const status = git('status', '--porcelain');
const ignored = status.split('\n').filter(line => line && DIRTY_IGNORED.test(line));
const dirty = status.split('\n').filter(line => line && !DIRTY_IGNORED.test(line));
if (ignored.length) console.warn(`⚠️ 忽略 ${ignored.length} 个约定不入库的改动：package-lock.json / src/data/*`);
if (dirty.length) throw new Error(`工作区有未提交改动，先提交或 stash：\n${dirty.join('\n')}`);

// 拉一下远端 tag：别人（或 CI 回写后）可能已经占掉当天序号。
try { git('fetch', 'origin', '--tags', '--quiet'); }
catch { console.warn('⚠️ 无法从 origin 拉取 tag，按本地现有 tag 计算版本'); }
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const currentVersion = readJSON('plugin.json').version;
const tags = git('tag', '--list').split('\n').filter(Boolean);
const version = forced || nextVersion(tags, currentVersion, new Date());
const tag = `v${version}`;

console.log(`分支        ${branch}`);
console.log(`当前版本    ${currentVersion}`);
console.log(`新版本      ${version}`);
if (tags.includes(tag)) throw new Error(`${tag} 已存在；要重发请先删除该 tag（含远端）再跑`);
if (version === currentVersion) throw new Error(`版本号未变化（${version}），无需发版`);

if (dryRun) {
  console.log('\n[dry-run] 将更新 package.json / plugin.json');
  console.log(`[dry-run] git commit -m "chore(release): bump to ${tag}"`);
  console.log(`[dry-run] git tag -a ${tag} -m "Release version ${version}"`);
  console.log(`[dry-run] git push origin HEAD:${branch} --follow-tags`);
  process.exit(0);
}

for (const file of ['package.json', 'plugin.json']) {
  const manifest = readJSON(file);
  manifest.version = version;
  writeJSON(file, manifest);
}

git('add', 'package.json', 'plugin.json');
git('commit', '-m', `chore(release): bump to ${tag}`);
git('tag', '-a', tag, '-m', `Release version ${version}`);

if (push) {
  git('push', 'origin', `HEAD:${branch}`, '--follow-tags');
  console.log(`\n已推送 ${tag}，CI 构建完成后会创建 Release。`);
} else {
  console.log(`\n已在本地产出 ${tag}，推送后 CI 才会发布：\n  git push origin HEAD:${branch} --follow-tags`);
}
console.log(`tag ${tag}`);
