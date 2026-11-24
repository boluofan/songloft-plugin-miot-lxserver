#!/usr/bin/env node
// 生成 Release 正文：取「上一版 tag..本次 tag」之间的提交，按 Conventional Commits 类型分组。
//
// 供 .github/workflows/release-lxserver.yml 在创建 Release 时使用（--notes-file 传入），
// 也可以本地预览：`npm run release:notes -- --tag v1.1.2`（不传 --tag 就取当前 HEAD 上的 tag）。
//
// 「上一版 tag」按 semver 数值比较取严格小于本次 tag 的最大者，不用 `git tag --sort=creatordate`
// 取末尾——手动补发某个旧 tag 时，时间序会取到比它新的 tag，changelog 范围就反了。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, parseVersion } from './release-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 分组顺序即渲染顺序：先破坏性变更，再按「用户能感知」到「内部维护」排列。
export const TYPE_ORDER = [
  'breaking',
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'build',
  'ci',
  'test',
  'style',
  'chore',
  'revert',
  'other',
];

export const TYPE_LABELS = {
  breaking: '💥 不兼容变更',
  feat: '✨ 新功能',
  fix: '🐛 修复',
  perf: '⚡ 性能',
  refactor: '♻️ 重构',
  docs: '📝 文档',
  build: '📦 构建',
  ci: '🤖 持续集成',
  test: '✅ 测试',
  style: '🎨 代码风格',
  chore: '🔧 杂项',
  revert: '⏪ 回滚',
  other: '📌 其他',
};

// `type(scope)!: 描述` / `type: 描述` / `type(scope): 描述`；不符合约定的返回 null。
const SUBJECT_RE = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

export function parseCommitSubject(subject) {
  // 压成一行：提交标题本身不该有换行，但手写不全的合并信息可能带。
  const text = String(subject ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const match = SUBJECT_RE.exec(text);
  if (!match) return null;
  const [, rawType, scope, bang, description] = match;
  const type = rawType.toLowerCase();
  return {
    type,
    scope: scope ? scope.trim() : '',
    breaking: bang === '!',
    description: description.trim(),
    // 类型不在约定表里（例如 `wip:`）也当作有效提交，落到「其他」而不是丢掉。
    known: Object.prototype.hasOwnProperty.call(TYPE_LABELS, type) && type !== 'other',
  };
}

// 从 git 的 author 字段挑一个适合放在 @ 后面的标识。GitHub 的 noreply 邮箱
// （<id>+<username>@users.noreply.github.com）里能取出真正的 username —— Release
// 正文里的 @username GitHub 会自动链到用户主页；普通邮箱退回 author name。
export function authorHandle(name, email) {
  const noreply = /^(?:\d+\+)?([A-Za-z0-9][A-Za-z0-9-]*)@users\.noreply\.github\.com$/i
    .exec(String(email ?? '').trim());
  if (noreply) return noreply[1];
  const trimmedName = String(name ?? '').trim();
  if (trimmedName) return trimmedName;
  return String(email ?? '').split('@')[0] || 'unknown';
}

/**
 * 选「上一版 tag」：所有合法 semver tag 里严格小于 currentTag 的最大者。
 * 返回 null 表示这是首个版本，调用方应回退到仓库首个提交。
 */
export function selectPreviousTag(tags, currentTag) {
  const current = parseVersion(currentTag);
  if (!current) return null;
  let best = null;
  for (const name of tags) {
    const parts = parseVersion(name);
    if (!parts) continue;
    if (compareVersions(parts, current) >= 0) continue;
    if (!best || compareVersions(parts, best.parts) > 0) best = { name, parts };
  }
  return best ? best.name : null;
}

/** 把 [{hash, subject}] 分组成 [{key, label, items}]，空组不返回。 */
export function groupCommits(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    const parsed = parseCommitSubject(entry.subject);
    const type = parsed && parsed.known ? parsed.type : 'other';
    // 发版提交只改版本号，对读者没有信息量；它自己就在被发布的这批提交里。
    if (type === 'chore' && parsed?.scope === 'release') continue;
    const key = parsed?.breaking ? 'breaking' : type;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({
      hash: entry.hash,
      author: String(entry.author ?? '').trim(),
      scope: parsed?.scope ?? '',
      description: parsed?.description ?? String(entry.subject ?? '').trim(),
      breaking: !!parsed?.breaking,
    });
  }
  return TYPE_ORDER.filter(key => buckets.has(key)).map(key => ({
    key,
    label: TYPE_LABELS[key],
    items: buckets.get(key),
  }));
}

const commitLink = (hash, repository) =>
  repository ? `[${hash}](https://github.com/${repository}/commit/${hash})` : hash;

/**
 * 渲染成 Release 正文。
 * @param {{tag: string, previousTag: string|null, commits: {hash: string, subject: string, author?: string}[], repository?: string}} input
 */
export function renderReleaseNotes({ tag, previousTag, commits, repository = '' }) {
  const lines = ['## 更新内容', ''];
  const groups = groupCommits(commits);

  if (groups.length === 0) {
    lines.push('本次发布没有需要列出的代码变更。', '');
  } else {
    for (const group of groups) {
      lines.push(`### ${group.label}`, '');
      for (const item of group.items) {
        const prefix = item.scope ? `\`${item.scope}\`: ` : '';
        const by = item.author ? ` (commit by @${item.author})` : '';
        lines.push(`- ${prefix}${item.description} (${commitLink(item.hash, repository)})${by}`);
      }
      lines.push('');
    }
  }

  if (repository && previousTag) {
    lines.push(
      '---',
      '',
      `**完整对比**：[${previousTag}...${tag}](https://github.com/${repository}/compare/${previousTag}...${tag})`,
      '',
    );
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------- CLI

const git = (...argv) =>
  execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function resolveRepository() {
  try {
    const remote = git('remote', 'get-url', 'origin');
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function resolveCurrentTag(explicit) {
  if (explicit) return explicit.startsWith('v') ? explicit : `v${explicit}`;
  // checkout 到 tag 时 HEAD 未分离地指向该 tag；取不到就报错，别默默生成空 notes。
  return git('describe', '--tags', '--exact-match', 'HEAD');
}

function main() {
  const args = process.argv.slice(2);
  const valueOf = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

  const tag = resolveCurrentTag(valueOf('--tag'));
  const repository = valueOf('--repository') ?? resolveRepository();
  const from = valueOf('--from');

  const previousTag = from ?? selectPreviousTag(git('tag', '--list').split('\n').filter(Boolean), tag);
  // 首个版本没有上一个 tag：用仓库首个提交，让 notes 覆盖全部历史。
  const base = previousTag || git('rev-list', '--max-parents=0', 'HEAD').split('\n').filter(Boolean).pop();

  // 取 hash / author name / author email / subject，tab 分隔；subject 放最后，
  // 里面万一有 tab 也能靠 join 还原。
  const raw = git('log', '--no-merges', '--pretty=format:%h%x09%an%x09%ae%x09%s', `${base}..${tag}`);
  const commits = raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, name, email, ...subjectParts] = line.split('\t');
      return {
        hash: (hash ?? '').trim(),
        author: authorHandle(name, email),
        subject: subjectParts.join('\t'),
      };
    });

  const notes = renderReleaseNotes({ tag, previousTag: from ?? previousTag, commits, repository });

  const output = valueOf('--output');
  if (output) {
    writeFileSync(resolve(root, output), notes);
    console.error(`已写入 ${output}（${commits.length} 条提交，范围 ${previousTag || base}..${tag}）`);
  } else {
    process.stdout.write(notes);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
