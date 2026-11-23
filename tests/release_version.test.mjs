import assert from 'node:assert/strict';
import test from 'node:test';
import { datePrefix, nextVersion, tagVersion } from '../scripts/release-version.mjs';

test('北京时间换日重置日期与序号，序号按数值递增', () => {
  assert.equal(datePrefix(new Date('2026-10-14T15:59:59Z')), '2026.10.14');
  assert.equal(datePrefix(new Date('2026-10-14T16:00:00Z')), '2026.10.15');
  assert.equal(nextVersion(['v2026.10.14.9', 'v2026.10.14.10'], '2026.10.14.10', new Date('2026-10-14T12:00:00Z')), '2026.10.14.11');
  assert.equal(nextVersion(['v2026.10.14.10'], '2026.10.14.10', new Date('2026-10-14T16:00:00Z')), '2026.10.15.0');
});

test('过渡期的明日版本从 .1 开始，日期追平后沿用当日序号', () => {
  assert.equal(nextVersion(['v2026.10.15'], '2026.10.15', new Date('2026-10-14T12:00:00Z')), '2026.10.15.1');
  assert.equal(nextVersion(['v2026.10.15.1'], '2026.10.15.1', new Date('2026-10-15T12:00:00Z')), '2026.10.15.2');
  assert.equal(nextVersion(['v2026.10.15.2'], '2026.10.15.2', new Date('2026-10-16T12:00:00Z')), '2026.10.16.0');
  assert.equal(nextVersion(['v2026.2.30.999', 'v2026.2.28.3'], '2026.2.28.3', new Date('2026-02-28T12:00:00Z')), '2026.2.28.4');
});

test('清单版本即使没有对应 tag 也占住序号，避免与已发布版本撞号', () => {
  // 本仓库从上游继承了 2026.11.23.0，但 fork 里没有任何 tag。
  assert.equal(nextVersion([], '2026.11.23.0', new Date('2026-11-23T04:00:00Z')), '2026.11.23.1');
  assert.equal(nextVersion([], '2026.11.23.7', new Date('2026-11-23T04:00:00Z')), '2026.11.23.8');
  assert.equal(nextVersion(['v2026.11.23.2'], '2026.11.23.7', new Date('2026-11-23T04:00:00Z')), '2026.11.23.8');
  assert.equal(nextVersion([], '2026.11.22.7', new Date('2026-11-23T04:00:00Z')), '2026.11.23.0');
});

test('只有 v 前缀的四段版本才是发布 tag', () => {
  assert.equal(tagVersion('v2026.11.23.1'), '2026.11.23.1');
  assert.equal(tagVersion('2026.11.23.1'), null);
  assert.equal(tagVersion('v2026.11.23'), null, '三段版本是迁移期历史，不打 tag');
  assert.equal(tagVersion('vnightly'), null);
  assert.equal(tagVersion(''), null);
});
