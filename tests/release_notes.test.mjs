import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupCommits,
  parseCommitSubject,
  renderReleaseNotes,
  selectPreviousTag,
} from '../scripts/release-notes.mjs';

test('解析约定式提交标题：类型、作用域、破坏性标记', () => {
  assert.deepEqual(parseCommitSubject('fix(search): 入库模式允许解析外部音源'), {
    type: 'fix', scope: 'search', breaking: false, description: '入库模式允许解析外部音源', known: true,
  });
  assert.equal(parseCommitSubject('feat: 支持歌手队列').scope, '', '无作用域');
  assert.equal(parseCommitSubject('feat(lxserver)!: 换掉引用格式').breaking, true, '感叹号表示破坏性');
  assert.equal(parseCommitSubject('Fix(UI): 大小写混写').type, 'fix', '类型统一小写');
  assert.equal(parseCommitSubject('随手改一下'), null, '不符合约定返回 null');
  assert.equal(parseCommitSubject(''), null);
  assert.equal(parseCommitSubject(undefined), null);
});

test('类型不在约定表里也算有效提交，落到「其他」而不是丢掉', () => {
  const parsed = parseCommitSubject('wip(x): 半成品');
  assert.equal(parsed.type, 'wip');
  assert.equal(parsed.known, false, 'known 为 false 才会归到 other');
  assert.equal(groupCommits([{ hash: 'abc1234', subject: 'wip(x): 半成品' }])[0].label, '📌 其他');
});

test('按类型分组且组间顺序固定，不受提交先后影响', () => {
  const groups = groupCommits([
    { hash: 'aaa1111', subject: 'docs: 补文档' },
    { hash: 'bbb2222', subject: 'fix(player): 修切歌' },
    { hash: 'ccc3333', subject: 'feat(voice): 加口令' },
  ]);
  assert.deepEqual(groups.map(g => g.key), ['feat', 'fix', 'docs']);
  assert.deepEqual(groups.map(g => g.items[0].hash), ['ccc3333', 'bbb2222', 'aaa1111']);
});

test('发版提交不进更新列表，它自己就在被发布的这批提交里', () => {
  const groups = groupCommits([
    { hash: 'ddd4444', subject: 'chore(release): bump to v1.1.2' },
    { hash: 'eee5555', subject: 'chore(release): backfill manifest for v1.1.2' },
    { hash: 'fff6666', subject: 'fix: 真修复' },
    { hash: 'ggg7777', subject: 'chore(ci): 顺手调流水线' },
  ]);
  const items = groups.flatMap(g => g.items.map(i => i.hash));
  assert.deepEqual(items, ['fff6666', 'ggg7777'], '只保留非发版提交，其他 chore 照常列出');
});

test('破坏性变更单独置顶，同时保留它原本的类型归属信息', () => {
  const groups = groupCommits([
    { hash: 'aaa1111', subject: 'feat(api): 新接口' },
    { hash: 'bbb2222', subject: 'refactor(ref)!: 改引用结构' },
  ]);
  assert.equal(groups[0].key, 'breaking');
  assert.equal(groups[0].items[0].hash, 'bbb2222');
  assert.equal(groups[1].key, 'feat');
});

test('上一版 tag 按数值取严格小于本次的最大者，补发旧 tag 时也不会反', () => {
  const tags = ['v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.10.0'];
  assert.equal(selectPreviousTag(tags, 'v1.10.0'), 'v1.2.0', '按数值比，不是字符串比');
  // 手动补发中间的 v1.1.0：上一版应是 v1.0.0，不能取到比它新的 v1.2.0
  assert.equal(selectPreviousTag(tags, 'v1.1.0'), 'v1.0.0');
  assert.equal(selectPreviousTag(tags, 'v1.0.0'), null, '首个版本没有上一版');
  assert.equal(selectPreviousTag(['2026.11.23.0'], 'v1.1.0'), null, '四段日期 tag 不参与比较');
  assert.equal(selectPreviousTag([], 'v1.1.0'), null);
});

test('渲染出中文分组、作用域与提交链接', () => {
  const notes = renderReleaseNotes({
    tag: 'v1.1.2',
    previousTag: 'v1.1.1',
    repository: 'boluofan/songloft-plugin-miot-plus',
    commits: [
      { hash: 'ccc3333', subject: 'feat(voice): 加口令' },
      { hash: 'bbb2222', subject: 'fix(player): 修切歌' },
    ],
  });
  assert.match(notes, /^## 更新内容/);
  assert.match(notes, /### ✨ 新功能\n\n- `voice`: 加口令 \(\[ccc3333\]\(https:\/\/github\.com\/boluofan\/songloft-plugin-miot-plus\/commit\/ccc3333\)\)/);
  assert.match(notes, /### 🐛 修复/);
  assert.match(notes, /完整对比.*v1\.1\.1\.\.\.v1\.1\.2/);
  assert.ok(notes.endsWith('\n'), '以换行结尾，--notes-file 读进去才不粘连');
});

test('没有仓库信息时退化为纯哈希，没有上一版时不渲染对比链接', () => {
  const notes = renderReleaseNotes({
    tag: 'v1.1.0',
    previousTag: null,
    commits: [{ hash: 'abc1234', subject: 'feat: 首个版本' }],
  });
  assert.match(notes, /- 首个版本 \(abc1234\)/);
  assert.doesNotMatch(notes, /完整对比/);
});

test('范围内没有可展示提交时给出说明而不是空白正文', () => {
  const notes = renderReleaseNotes({ tag: 'v1.1.2', previousTag: 'v1.1.1', commits: [] });
  assert.match(notes, /没有需要列出的代码变更/);
  assert.doesNotMatch(notes, /完整对比/, '没有仓库信息就不拼链接');
});
