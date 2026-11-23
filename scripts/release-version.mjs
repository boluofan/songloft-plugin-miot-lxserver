// 版本号规则：semver 三段 `MAJOR.MINOR.PATCH`，tag 带 `v`，清单与 package.json 不带。
//
// 宿主侧只做两件事：ValidateManifest 要求 version 以 `\d+\.\d+\.\d+` 开头，
// CheckUpdate 用「字符串不等」判断有无更新（没有降级概念）。所以这里用与 tag
// 完全一致的 semver：默认 patch 自增，需要时用 --minor / --major 主动进位。
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(version) {
  const match = VERSION_RE.exec(version ?? '');
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export const formatVersion = parts => parts.join('.');

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function nextVersion(tags, currentVersion, bump = 'patch') {
  const current = parseVersion(currentVersion);
  // 从日期版本（2026.11.23.0）迁移过来时，必须先把清单改成三段 semver，否则无从算起。
  if (!current) {
    throw new Error(`清单版本不是 semver（${currentVersion}），先手动改成诸如 1.1.0 再发版`);
  }

  const released = tags.map(parseVersion).filter(Boolean);
  const max = released.reduce((best, item) => (compare(item, best) > 0 ? item : best), current);
  const currentReleased = released.some(item => compare(item, current) === 0);

  // 清单版本还没对应的 tag（首次改用 semver，或手工调过版本）时，本次就发它本身，
  // 否则首发会变成 1.1.1，凭空跳掉一个号。
  if (!currentReleased && compare(max, current) === 0) return formatVersion(current);

  const [major, minor, patch] = max;
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`未知的进位方式：${bump}（只支持 major / minor / patch）`);
}

// tag 必须是 `v` + 三段 semver；返回去掉 v 的版本号，不合法返回 null。
export function tagVersion(name) {
  const version = /^v(.+)$/.exec(name ?? '')?.[1];
  return parseVersion(version) ? version : null;
}
