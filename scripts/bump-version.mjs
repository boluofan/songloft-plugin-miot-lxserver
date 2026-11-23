#!/usr/bin/env node
// 本地发布入口：算版本 → 改 package.json / plugin.json →
// 提交 → 打 tag → 推送。推送 tag 后由 .github/workflows/release.yml 构建并创建 Release。
// package-lock.json 不动（本仓库约定不入库；npm ci 也不校验它的 version 字段）。
//
// 版本是 semver，与 tag 一致（v1.1.0 ↔ 1.1.0），默认 patch 自增。
//
// 用法：
//   npm run release                  # 计算下一个版本并发版（默认 patch）
//   npm run release -- --minor       # 次版本进位：1.1.3 → 1.2.0
//   npm run release -- --major       # 主版本进位：1.1.3 → 2.0.0
//   npm run release -- --dry-run     # 只打印将要执行的步骤
//   npm run release -- --no-push     # 只在本地产出提交和 tag
//   npm run release -- --version 1.2.0
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
const BUMP_FLAGS = ['--major', '--minor', '--patch'];
const bump = BUMP_FLAGS.find(flag => args.includes(flag))?.slice(2) ?? 'patch';

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

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');

// 拉一下远端：tag 决定当天序号（别人或 CI 可能已经占掉），分支引用决定这次能不能推成功。
try { git('fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`, '--tags', '--quiet'); }
catch { console.warn('⚠️ 无法从 origin 拉取 tag，按本地现有 tag 计算版本'); }

// CI 发完版会往默认分支回写一个清单提交，本地就此落后；落后时 push 必被拒，
// 但那时版本号已改、tag 已建好，收尾很别扭——所以在动任何文件之前先拦住。
let behind = 0;
try { behind = Number(git('rev-list', '--count', `HEAD..origin/${branch}`)); }
catch { /* 远端还没有这个分支，属于首次推送，不必检查 */ }
if (behind > 0) {
  throw new Error(`本地 ${branch} 落后 origin/${branch} ${behind} 个提交（通常是 CI 回写的清单）。先同步再发版：\n  git pull --ff-only origin ${branch}`);
}

const currentVersion = readJSON('plugin.json').version;
const tags = git('tag', '--list').split('\n').filter(Boolean);
const version = forced || nextVersion(tags, currentVersion, bump);
const tag = `v${version}`;

console.log(`分支        ${branch}`);
console.log(`当前版本    ${currentVersion}`);
console.log(`新版本      ${version}${forced ? '（--version 指定）' : version === currentVersion ? '（清单版本尚未发布）' : `（${bump} 进位）`}`);
// 只按 tag 判重：清单版本还没发过时，本次发的就是它本身，不能当「未变化」拒掉。
if (tags.includes(tag)) throw new Error(`${tag} 已存在；要重发请先删除该 tag（含远端）再跑`);

// 首发（清单版本还没 tag）时版本号不会变，写文件没有差异，不能白跑一次 commit。
const versionChanged = version !== currentVersion;

if (dryRun) {
  if (versionChanged) {
    console.log('\n[dry-run] 将更新 package.json / plugin.json');
    console.log(`[dry-run] git commit -m "chore(release): bump to ${tag}"`);
  } else {
    console.log('\n[dry-run] 版本号不变，跳过改文件与提交');
  }
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
// 用暂存区是否为空决定提交，比只看 version 更准：手工只改了一个文件也能兜住。
if (git('diff', '--cached', '--name-only')) {
  git('commit', '-m', `chore(release): bump to ${tag}`);
} else {
  console.log('版本号无变化，跳过提交（清单版本还没对应的 tag，本次直接打 tag）。');
}
git('tag', '-a', tag, '-m', `Release version ${version}`);

if (push) {
  git('push', 'origin', `HEAD:${branch}`, '--follow-tags');
  console.log(`\n已推送 ${tag}，CI 构建完成后会创建 Release。`);
} else {
  console.log(`\n已在本地产出 ${tag}，推送后 CI 才会发布：\n  git push origin HEAD:${branch} --follow-tags`);
}
console.log(`tag ${tag}`);
