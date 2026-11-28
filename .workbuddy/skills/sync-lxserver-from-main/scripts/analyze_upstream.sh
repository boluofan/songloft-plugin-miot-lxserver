#!/usr/bin/env bash
# 分析本项目 main 分支上「尚未合入 lxserver」的提交，输出可评估清单。
#
# 用法：scripts/analyze_upstream.sh [base] [upstream]
#   base     目标分支（默认 lxserver）
#   upstream 同步分支（默认 main）
#
# 只读：fetch + log/show/cherry，不改工作区、不动分支指针。
# 「定制文件」按 base 相对 upstream 的实际改动文件集合动态计算，不维护硬编码清单；
# 纯文档提交（改动文件全是 *.md / docs/** / LICENSE 等）打 📝 标记，按技能规则一律跳过；
# 全程不落临时文件（避免在 Windows 上触发文件安全策略）。
set -uo pipefail

BASE="${1:-lxserver}"
UPSTREAM="${2:-main}"

ROOT="$(git rev-parse --show-toplevel)" || { echo "不在 git 仓库内" >&2; exit 1; }
cd "$ROOT" || exit 1

echo "## 分支状态"
git fetch origin --prune --quiet 2>/dev/null || echo "（fetch 失败，继续用本地已有引用）"

LOCAL_UP="$(git rev-parse --short "$UPSTREAM" 2>/dev/null || echo missing)"
REMOTE_UP="$(git rev-parse --short "origin/$UPSTREAM" 2>/dev/null || echo missing)"
echo "- 本地 \`$UPSTREAM\` = \`$LOCAL_UP\`"
echo "- 远程 \`origin/$UPSTREAM\` = \`$REMOTE_UP\`"

BEHIND="$(git rev-list --count "$UPSTREAM".."origin/$UPSTREAM" 2>/dev/null || echo 0)"
AHEAD="$(git rev-list --count "origin/$UPSTREAM".."$UPSTREAM" 2>/dev/null || echo 0)"
if [ "$BEHIND" -gt 0 ]; then
  echo "- ⚠ 本地 \`$UPSTREAM\` 落后远程 $BEHIND 个提交 → 先 fast-forward 再分析"
elif [ "$AHEAD" -gt 0 ]; then
  echo "- ⚠ 本地 \`$UPSTREAM\` 领先远程 $AHEAD 个提交（不应出现；确认后再动）"
else
  echo "- ✅ 本地 \`$UPSTREAM\` 与远程一致"
fi

MERGE_BASE="$(git merge-base "$UPSTREAM" "$BASE")"
echo "- merge-base(\`$BASE\`, \`$UPSTREAM\`) = \`$(git rev-parse --short "$MERGE_BASE")\`"

CUSTOM_LIST="$(git diff --name-only "$MERGE_BASE".."$BASE" | sed '/^$/d')"
CUSTOM_COUNT="$(printf '%s\n' "$CUSTOM_LIST" | grep -c . || true)"
NL=$'\n'
in_custom() {
  case "$NL$CUSTOM_LIST$NL" in
    *"$NL$1$NL"*) return 0 ;;
  esac
  return 1
}

echo
echo "## 定制文件（\`$BASE\` 有改动、\`$UPSTREAM\` 没有）共 $CUSTOM_COUNT 个"
echo "改动落到这些文件的提交，cherry-pick 冲突风险高："
echo '```'
printf '%s\n' "$CUSTOM_LIST" | head -40
if [ "$CUSTOM_COUNT" -gt 40 ]; then
  echo "...（其余 $((CUSTOM_COUNT - 40)) 个略）"
fi
echo '```'

echo
echo "## 待评估清单（\`git cherry\` 判定为未合）"
UNMERGED="$(git cherry "$BASE" "$UPSTREAM" | awk '$1=="+"{print $2}')"
if [ -z "$UNMERGED" ]; then
  echo "✅ \`$UPSTREAM\` 上没有未合入 \`$BASE\` 的提交，无需合并。"
  exit 0
fi

TOTAL=0
while IFS= read -r sha; do
  [ -z "$sha" ] && continue
  TOTAL=$((TOTAL + 1))
  subject="$(git log -1 --format='%s' "$sha")"
  short="$(git rev-parse --short "$sha")"
  FILES="$(git show --name-only --format= "$sha" | sed '/^$/d')"
  NFILES="$(printf '%s\n' "$FILES" | grep -c . || true)"

  HITS=""
  NHITS=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if in_custom "$f"; then
      HITS="$HITS$f "
      NHITS=$((NHITS + 1))
    fi
  done <<< "$FILES"

  # 纯文档判定：所有改动文件都是文档/日志类时打 📝，按技能规则一律跳过。
  DOC_ONLY=1
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *.md|docs/*|*/docs/*|LICENSE*|*.txt|*.svg) ;;
      *) DOC_ONLY=0; break ;;
    esac
  done <<< "$FILES"

  echo
  if [ "$DOC_ONLY" -eq 1 ]; then
    echo "### 📝 \`$short\` $subject"
    echo "- **纯文档/日志提交（$NFILES 个文件全是文档），按技能规则跳过，不需要 git show 评估**"
  elif [ "$NHITS" -gt 0 ]; then
    echo "### ⚠ \`$short\` $subject"
    echo "- 文件 $NFILES 个，其中 $NHITS 个是定制文件：$HITS"
  else
    echo "### ✅ \`$short\` $subject"
    echo "- 文件 $NFILES 个，未触碰定制文件"
  fi
  printf '%s\n' "$FILES" | head -8 | sed 's/^/  - /'
  if [ "$NFILES" -gt 8 ]; then
    echo "  - ...（其余 $((NFILES - 8)) 个略）"
  fi
done <<< "$UNMERGED"

MERGED_COUNT="$(git cherry "$BASE" "$UPSTREAM" | awk '$1=="-"' | wc -l | tr -d ' ')"
echo
echo "## 汇总"
echo "- 未合入：**$TOTAL** 个（上面逐条列出）"
echo "- 已等价合入（\`git cherry\` 标 \`-\`，patch-id 相同）：$MERGED_COUNT 个，不要再 pick"
echo
echo "下一步：逐条判断取舍（规则见 SKILL.md），用 \`git cherry-pick -x <sha>\` 合，每组后跑 scripts/verify.sh。"
