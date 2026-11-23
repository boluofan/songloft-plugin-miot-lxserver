#!/usr/bin/env bash
# 合并后验证：类型检查 + 全量测试 + 插件校验（前端改动时加跑前端三项）。
#
# 用法：scripts/verify.sh [--frontend] [--no-validate]
#   --frontend     强制加跑 frontend 的类型检查与测试
#   --no-validate  跳过 songloft-plugin validate（只想快速过一遍时用）
#
# 全部命令从仓库根目录执行；不跑 build（prebuild 会重写 src/data/* 造成脏工作区，
# 需要构建验证时由人单独执行并 git checkout -- src/data/）。
#
# 前端测试有一组「上游既有失败」，脚本按名单区分「与基线一致」和「本次新增失败」，
# 避免把既有红当成合并搞坏，也避免它掩盖真正的回归。
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)" || { echo "不在 git 仓库内" >&2; exit 1; }
cd "$ROOT" || exit 1

# 前端既有失败基线（两分支该测试文件相同，与 lxserver 定制无关）。
# 由「frontend/tests/chat_races.test.mjs 的 new Function 环境缺 exports」引起；
# 上游修好后把对应条目删掉，脚本会自动把它当新失败报出来。
FRONTEND_BASELINE_FAILURES=(
  "late HTTP chat status cannot overwrite a newer WebSocket status; old devices are ignored"
  "WebSocket construction failure still polls HTTP status and stops retry on device removal"
  "WebSocket error and close cannot double-retry; stale sockets and snapshots are ignored"
  "WebSocket open deadline retries a hung connection, malformed messages do not suppress HTTP"
)

# 排障开关：置 1 时不认基线，任何失败都算失败。怀疑基线名单已过期时用它看全集。
if [ "${VERIFY_IGNORE_BASELINE:-0}" = "1" ]; then
  FRONTEND_BASELINE_FAILURES=()
fi

FRONTEND=0
VALIDATE=1
for arg in "$@"; do
  case "$arg" in
    --frontend) FRONTEND=1 ;;
    --no-validate) VALIDATE=0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

if [ "$FRONTEND" -eq 0 ]; then
  MB="$(git merge-base HEAD origin/main 2>/dev/null || true)"
  if [ -n "$MB" ] && git diff --name-only "$MB"..HEAD -- frontend | head -1 | grep -q .; then
    FRONTEND=1
    echo "==> 检测到 frontend/ 改动，额外跑前端验证"
  fi
fi

FAILED=()

run() {
  local label="$1"; shift
  echo
  echo "==> $label"
  if "$@"; then
    echo "✅ $label"
  else
    echo "❌ $label"
    FAILED+=("$label")
  fi
}

run_in() {
  local dir="$1" label="$2"; shift 2
  echo
  echo "==> $label（$dir/）"
  if ( cd "$dir" && "$@" ); then
    echo "✅ $label"
  else
    echo "❌ $label"
    FAILED+=("$label")
  fi
}

in_baseline() {
  local needle="$1" item
  for item in "${FRONTEND_BASELINE_FAILURES[@]}"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

run_frontend_test() {
  local label="frontend test"
  echo
  echo "==> $label（frontend/）"
  local out
  out="$( cd frontend && npm test 2>&1 )" || true

  local fails=() line
  while IFS= read -r line; do
    [ -n "$line" ] && fails+=("$line")
  done < <(printf '%s\n' "$out" | sed -nE 's/^not ok [0-9]+ - //p')

  if [ "${#fails[@]}" -eq 0 ]; then
    echo "✅ $label"
    return 0
  fi

  local extra=() known=0 name
  for name in "${fails[@]}"; do
    if in_baseline "$name"; then
      known=$((known + 1))
    else
      extra+=("$name")
    fi
  done

  if [ "${#extra[@]}" -eq 0 ]; then
    echo "⚠ $label：$known 个失败，全部命中已知基线（上游既有，与本次合并无关）"
    printf '%s\n' "${fails[@]}" | sed 's/^/  - /'
    return 0
  fi

  echo "❌ $label：${#extra[@]} 个新增失败（基线内 $known 个）"
  printf '%s\n' "${extra[@]}" | sed 's/^/  - /'
  printf '%s\n' "$out" | tail -20
  FAILED+=("$label（新增失败 ${#extra[@]}）")
  return 1
}

run "tsc --noEmit" npx tsc --noEmit
run "全量测试" node --test tests/*.test.mjs
if [ "$VALIDATE" -eq 1 ]; then
  run "songloft-plugin validate" npx songloft-plugin validate
fi
if [ "$FRONTEND" -eq 1 ]; then
  run_in frontend "frontend typecheck" npm run typecheck
  run_frontend_test
fi

echo
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "✅ 全部验证通过"
  exit 0
fi
echo "❌ 验证失败 ${#FAILED[@]} 项：${FAILED[*]}"
exit 1
