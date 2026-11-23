import assert from 'node:assert/strict';
import test from 'node:test';
import { nextVersion, tagVersion } from '../scripts/release-version.mjs';

test('默认 patch 自增，与已发布的 tag 对齐', () => {
  assert.equal(nextVersion(['v1.1.0'], '1.1.0'), '1.1.1');
  assert.equal(nextVersion(['v1.0.9', 'v1.1.0'], '1.1.0'), '1.1.1');
  assert.equal(nextVersion(['v1.1.9'], '1.1.9'), '1.1.10', '按数值进位，不是字符串拼');
});

test('清单版本还没对应的 tag 时直接发它本身，不凭空跳号', () => {
  // 首次从日期版本迁到 semver：清单已改成 1.1.0，但一个 tag 都没有。
  assert.equal(nextVersion([], '1.1.0'), '1.1.0');
  assert.equal(nextVersion(['v1.0.0', 'v1.0.1'], '1.1.0'), '1.1.0');
});

test('tag 领先清单时以 tag 为准，避免倒着发', () => {
  // 别人（或别的分支）已经发到 1.2.0，而本地清单还停在 1.1.0。
  assert.equal(nextVersion(['v1.1.0', 'v1.2.0'], '1.1.0'), '1.2.1');
});

test('minor / major 进位把低位清零', () => {
  assert.equal(nextVersion(['v1.1.3'], '1.1.3', 'minor'), '1.2.0');
  assert.equal(nextVersion(['v1.4.9'], '1.4.9', 'major'), '2.0.0');
  assert.throws(() => nextVersion(['v1.1.3'], '1.1.3', 'huge'), /未知的进位方式/);
});

test('清单不是三段 semver 时明确报错，提示先手工迁移', () => {
  // 从上游继承的四段日期版本没法算 semver，必须人工定一个起点。
  assert.throws(() => nextVersion([], '2026.11.23.0'), /不是 semver/);
  assert.throws(() => nextVersion([], '1.1'), /不是 semver/);
});

test('只有 v 前缀的三段语义化版本才是发布 tag', () => {
  assert.equal(tagVersion('v1.1.0'), '1.1.0');
  assert.equal(tagVersion('v1.1.10'), '1.1.10');
  assert.equal(tagVersion('1.1.0'), null, '缺 v 前缀不算');
  assert.equal(tagVersion('v2026.11.23.0'), null, '四段日期版本是迁移前的历史');
  assert.equal(tagVersion('v1.1'), null);
  assert.equal(tagVersion('vnightly'), null);
  assert.equal(tagVersion(''), null);
});
