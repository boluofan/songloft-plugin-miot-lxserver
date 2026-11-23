// 版本号规则（与上游每日版本一致）：北京时间 `YYYY.M.D.N`，tag 带 `v`，清单里的版本不带。
export function datePrefix(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(now);
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key).value).join('.');
}

function versionParts(version) {
  const match = /^v?(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d+))?$/.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map(value => value === undefined ? undefined : Number(value));
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 ||
      date.getUTCDate() !== parts[2] || (parts[3] !== undefined && !Number.isSafeInteger(parts[3]))) return null;
  return parts;
}

export function nextVersion(tags, currentVersion, now = new Date()) {
  let date = versionParts(datePrefix(now)).slice(0, 3);
  const current = versionParts(currentVersion);
  // 过渡版曾使用明日日期：日期追上之前沿用该前缀，不能让商店判为降级。
  if (current && current.slice(0, 3).some((value, i) =>
    value > date[i] && current.slice(0, i).every((prefix, j) => prefix === date[j]))) date = current.slice(0, 3);
  const prefix = date.join('.');
  const sameDay = tags.map(versionParts).filter(parts => parts && parts.slice(0, 3).join('.') === prefix);
  // 清单版本也参与取最大值：本仓库从上游继承了 2026.11.23.0，但 fork 里没有任何 tag。
  if (current && current.slice(0, 3).join('.') === prefix && current[3] !== undefined) sameDay.push(current);
  const revisions = sameDay.filter(parts => parts[3] !== undefined).map(parts => parts[3]);
  // 三段 D 与四段 D.0 数值相同，迁移当日需从 .1 开始才能提示升级。
  const legacy = sameDay.some(parts => parts[3] === undefined);
  const revision = revisions.length ? Math.max(...revisions) + 1 : legacy ? 1 : 0;
  if (!Number.isSafeInteger(revision) || revision > 999999999) throw new Error('Daily release sequence exhausted');
  return `${prefix}.${revision}`;
}

export function tagVersion(name) {
  const version = /^v(.+)$/.exec(name ?? '')?.[1];
  const parts = version ? versionParts(version) : null;
  // 只有四段 vYYYY.M.D.N 才是发布 tag；三段是迁移期的历史版本。
  return parts && parts[3] !== undefined ? version : null;
}
