#!/usr/bin/env bash
# docs-convention 스킬의 검사기와 훅이 실제로 막는지 확인한다.
# 사용: bash skills/docs-convention/tests/selftest.sh   (Git Bash / bash, node, git 필요)
set -u
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$SKILL/scripts/check-docs.mjs"
GUARD="$SKILL/scripts/docs-guard.mjs"
PASS=0; FAIL=0

winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

# expect <기대 종료코드> <설명> <명령...>   (OUT 에 출력을 남긴다)
expect() {
  local want="$1"; local desc="$2"; shift 2
  OUT="$("$@" 2>&1)"; local got=$?
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  ok    [$want] $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL  [want $want, got $got] $desc"; echo "$OUT" | sed 's/^/        /' | head -12; fi
}
# expect_out <부분문자열> <설명>   (직전 OUT 검사)
expect_out() {
  if printf '%s' "$OUT" | grep -q -- "$1"; then PASS=$((PASS+1)); echo "  ok    출력에 \"$1\" 포함: $2"
  else FAIL=$((FAIL+1)); echo "  FAIL  출력에 \"$1\" 없음: $2"; echo "$OUT" | sed 's/^/        /' | head -12; fi
}
# guard <기대코드> <설명> <json>
guard() { expect "$1" "$2" bash -c "printf '%s' '$3' | node '$GUARD'"; }

T="$(mktemp -d)"; WT="$(winpath "$T")"
trap 'rm -rf "$T"' EXIT

echo "== 규약을 따르는 저장소 만들기 =="
mkdir -p "$T/docs/log" "$T/docs/experiments" "$T/docs/research" "$T/scripts" "$T/.githooks"
cp "$CHECK" "$GUARD" "$T/scripts/"
cp "$SKILL/references/convention.md" "$T/docs/README.md"
cp "$SKILL/assets/pre-commit" "$T/.githooks/pre-commit"
echo "# t" > "$T/README.md"
printf '# t\n\n## 지킬 것\n\n- 문서는 한국어로 쓴다.\n' > "$T/CLAUDE.md"
printf '# 인계\n\n## 정한 것\n\n| 항목 | 결정 | 날짜 |\n|---|---|---|\n| 언어 | 한국어 | 2026-10-31 |\n' > "$T/docs/BRIEF.md"
printf '# 설계\n\n## 1. 구조\n\n## 2. API 표\n\n| 메서드 | 받는 것 → 주는 것 |\n|---|---|\n| board.get | id → board |\n' > "$T/docs/ARCH.md"
printf '# t 계획\n\n## 지금: 사이드바\n\n시나리오.\n\n## 다음: 세션 되찾기\n\n목표.\n\n## 열린 결정\n\n- 정렬 기준\n' > "$T/docs/PLAN.md"
printf '# 시험 요령\n' > "$T/docs/testing.md"
printf '# 결정 로그\n\n- 2026-10-31 한국어로 쓴다. 이유: 사용자 요청.\n' > "$T/docs/decisions.md"
printf '상태: 닫힘\n날짜: 2026-10-30\n\n## 지시\n\n백엔드.\n\n## 작업 기록\n\n했다.\n\n## 보고\n\n됐다.\n' > "$T/docs/log/p1-backend.md"
printf '상태: 열림\n날짜: 2026-10-31\n\n## 지시\n\n사이드바.\n\n## 작업 기록\n\n## 보고\n' > "$T/docs/log/p2-sidebar.md"
printf '# E1\n' > "$T/docs/experiments/E1.md"
printf '# 조사\n' > "$T/docs/research/prior-art.md"
git -C "$T" init -q && git -C "$T" config user.email t@t && git -C "$T" config user.name t && git -C "$T" config core.hooksPath .githooks
git -C "$T" add -A && git -C "$T" commit -q -m "init"

echo "== 검사기: 통과해야 하는 것 =="
expect 0 "작업 트리 검사 통과" node "$CHECK" "$WT"
expect 0 "--staged 통과" node "$CHECK" "$WT" --staged
expect 0 "--close 변경 없음 통과" node "$CHECK" "$WT" --close

echo "== 검사기: 구조 위반 =="
echo "# n" > "$T/NOTES.markdown"
expect 1 "루트의 .markdown 잡음" node "$CHECK" "$WT"; expect_out "NOTES.markdown" "루트 파일 이름"; rm "$T/NOTES.markdown"
mkdir -p "$T/docs/notes" && echo "# s" > "$T/docs/notes/scratch.md"
expect 1 "docs/ 아래 허용 외 폴더 잡음" node "$CHECK" "$WT"; expect_out "허용하지 않은 폴더" "폴더 메시지"; rm -r "$T/docs/notes"
echo "# p" > "$T/docs/P3.md"
expect 1 "docs/ 바로 아래 단계 보고서 잡음" node "$CHECK" "$WT"; expect_out "docs/log/<작업>.md" "옮길 곳을 가리키는 메시지"; rm "$T/docs/P3.md"
mkdir -p "$T/app" && echo "# api" > "$T/app/API.md"
expect 0 "docs/ 밖 md 는 경고만" node "$CHECK" "$WT"; expect_out "경고" "경고 표시"; rm -r "$T/app"

echo "== 검사기: PLAN 구조 =="
cp "$T/docs/PLAN.md" "$T/PLAN.bak"
printf '\n## P6(끝남)\n\n- H1 끝남\n' >> "$T/docs/PLAN.md"
expect 1 "PLAN 에 단계 절과 완료 표시" node "$CHECK" "$WT"; expect_out "완료 표시" "완료 표시 메시지"; expect_out "허용되지 않는다" "제목 메시지"
cp "$T/PLAN.bak" "$T/docs/PLAN.md"

echo "== 검사기: 작업 파일 =="
printf '# 메모\n\n## 할 일\n' > "$T/docs/log/p3-x.md"
expect 1 "작업 파일 첫 줄과 제목 위반" node "$CHECK" "$WT"; expect_out "상태: 열림" "첫 줄 메시지"; rm "$T/docs/log/p3-x.md"
{ printf '상태: 열림\n\n## 지시\n\n'; head -c 11000 /dev/zero | tr '\0' 'x'; printf '\n\n## 작업 기록\n\n## 보고\n'; } > "$T/docs/log/p4-long.md"
expect 1 "지시 절 10,000자 초과" node "$CHECK" "$WT"; expect_out "지시 절" "지시 절 메시지"; rm "$T/docs/log/p4-long.md"

echo "== 검사기: BRIEF 표 행 =="
cp "$T/docs/BRIEF.md" "$T/BRIEF.bak"
{ printf '| 긴 행 | '; head -c 600 /dev/zero | tr '\0' 'y'; printf ' | 2026 |\n'; } >> "$T/docs/BRIEF.md"
expect 1 "500자 넘는 표 행" node "$CHECK" "$WT"; expect_out "표 행" "표 행 메시지"
cp "$T/BRIEF.bak" "$T/docs/BRIEF.md"

echo "== 검사기: 예산 파일 =="
echo '{"budgets":{"docs/PLAN.md":999999}}' > "$T/.docs-budget.json"
expect 2 "기본의 1.5배 넘는 예산은 거부" node "$CHECK" "$WT"; expect_out "1.5" "상한 메시지"
echo '{"budgets":{"docs/PLAN.md":20000}}' > "$T/.docs-budget.json"
expect 0 "1.5배 안의 예산은 허용" node "$CHECK" "$WT"; expect_out "재정의" "재정의 표시"
echo '{"budgets":{"docs/PLAN.md":null}}' > "$T/.docs-budget.json"
expect 2 "예산 값이 숫자가 아니면 거부" node "$CHECK" "$WT"
echo '{"budgets":{"docs/FOO.md":1}}' > "$T/.docs-budget.json"
expect 2 "모르는 파일의 예산은 거부" node "$CHECK" "$WT"
rm "$T/.docs-budget.json"
expect 2 "없는 경로" node "$CHECK" "$WT/없는폴더"; expect_out "경로 없음" "경로 메시지"

echo "== 검사기: 예산 초과 =="
cp "$T/CLAUDE.md" "$T/CLAUDE.bak"
head -c 5000 /dev/zero | tr '\0' 'z' >> "$T/CLAUDE.md"
expect 1 "CLAUDE.md 4,000자 초과" node "$CHECK" "$WT"; expect_out "초과" "초과 표시"
cp "$T/CLAUDE.bak" "$T/CLAUDE.md"

echo "== 검사기: --staged 는 인덱스를 본다 =="
echo "# n" > "$T/NOTES.md"
expect 0 "스테이지 안 된 위반은 --staged 통과" node "$CHECK" "$WT" --staged
expect 1 "같은 상태에서 작업 트리 검사는 실패" node "$CHECK" "$WT"
git -C "$T" add NOTES.md
expect 1 "스테이지하면 --staged 도 실패" node "$CHECK" "$WT" --staged
git -C "$T" rm -q --cached NOTES.md && rm "$T/NOTES.md"

echo "== 검사기: pre-commit 훅이 커밋을 막는다 =="
echo "# n" > "$T/NOTES.md" && git -C "$T" add NOTES.md
expect 1 "pre-commit 이 위반 커밋을 거부" git -C "$T" commit -q -m "bad"
git -C "$T" rm -q --cached NOTES.md && rm "$T/NOTES.md"

echo "== 검사기: --close =="
printf '\n## 4. 고쳐 쓴 문장\n\n문장 하나를 고쳐 몇십 자 늘었다.\n' >> "$T/docs/ARCH.md"
expect 0 "닫기 검사: ARCH 가 허용치 안에서 늘면 통과" node "$CHECK" "$WT" --close
{ printf '\n## 5. 덧붙인 절\n\n'; head -c 1200 /dev/zero | tr '\0' 'v'; printf '\n'; } >> "$T/docs/ARCH.md"
expect 1 "닫기 검사: ARCH 가 허용치 넘게 커짐" node "$CHECK" "$WT" --close; expect_out "커졌다" "비증가 메시지"
git -C "$T" checkout -q -- docs/ARCH.md
printf '\n다음 단계가 더 커서 늘어난 시나리오.\n' >> "$T/docs/PLAN.md"
expect 0 "닫기 검사: PLAN 은 커져도 된다" node "$CHECK" "$WT" --close
cp "$T/PLAN.bak" "$T/docs/PLAN.md"
printf '\n나중에 고침.\n' >> "$T/docs/log/p1-backend.md"
expect 1 "닫기 검사: 닫힌 작업 파일 수정" node "$CHECK" "$WT" --close; expect_out "닫힌 작업 파일" "닫힌 파일 메시지"
git -C "$T" checkout -q -- docs/log/p1-backend.md
{ printf -- '- 2026-10-31 '; head -c 3500 /dev/zero | tr '\0' 'w'; printf '\n'; } >> "$T/docs/decisions.md"
expect 1 "닫기 검사: decisions 커밋당 3,000자 초과" node "$CHECK" "$WT" --close; expect_out "decisions.md" "결정 로그 메시지"
git -C "$T" checkout -q -- docs/decisions.md
printf '\n나중에 고침.\n' >> "$T/docs/log/p2-sidebar.md"
expect 0 "닫기 검사: 열린 작업 파일 수정은 허용" node "$CHECK" "$WT" --close
git -C "$T" checkout -q -- docs/log/p2-sidebar.md

echo "== 검사기: --stop (Stop 훅) =="
echo "# n" > "$T/NOTES.md"
expect 0 "--stop 은 종료 0" bash -c "cd '$T' && printf '{}' | node '$CHECK' --stop"; expect_out '"decision":"block"' "위반이 있으면 block"
expect 0 "--stop stop_hook_active 면 통과" bash -c "cd '$T' && printf '{\"stop_hook_active\":true}' | node '$CHECK' --stop"
if [ -z "$OUT" ]; then PASS=$((PASS+1)); echo "  ok    stop_hook_active 일 때 출력 없음"; else FAIL=$((FAIL+1)); echo "  FAIL  stop_hook_active 인데 출력 있음: $OUT"; fi
rm "$T/NOTES.md"
expect 0 "--stop 위반 없으면 출력 없음" bash -c "cd '$T' && printf '{}' | node '$CHECK' --stop"
if [ -z "$OUT" ]; then PASS=$((PASS+1)); echo "  ok    통과 시 출력 없음"; else FAIL=$((FAIL+1)); echo "  FAIL  통과인데 출력 있음: $OUT"; fi

echo "== 편집 차단 훅 (docs-guard) =="
WK="$WT/.claude/worktrees/p8"; mkdir -p "$T/.claude/worktrees/p8/docs/log"; cp "$T/docs/log/p1-backend.md" "$T/.claude/worktrees/p8/docs/log/"
guard 2 "루트에 NOTES.md 생성 거부"          "{\"tool_name\":\"Write\",\"cwd\":\"$WT\",\"tool_input\":{\"file_path\":\"$WT/NOTES.md\"}}"
guard 0 "루트 README.md 편집 허용"           "{\"tool_name\":\"Edit\",\"cwd\":\"$WT\",\"tool_input\":{\"file_path\":\"$WT/README.md\"}}"
guard 0 "docs/log/ 새 작업 파일 허용"        "{\"tool_name\":\"Write\",\"cwd\":\"$WT\",\"tool_input\":{\"file_path\":\"$WT/docs/log/p9-new.md\"}}"
guard 2 "docs/ 바로 아래 P3.md 거부"         "{\"tool_name\":\"Write\",\"cwd\":\"$WT\",\"tool_input\":{\"file_path\":\"$WT/docs/P3.md\"}}"
guard 2 "docs/notes/ 폴더 거부"              "{\"tool_name\":\"Write\",\"cwd\":\"$WT\",\"tool_input\":{\"file_path\":\"$WT/docs/notes/x.md\"}}"
guard 2 "닫힌 작업 파일 편집 거부"           "{\"tool_name\":\"Edit\",\"cwd\":\"$WT\",\"tool_input\":{\"file_path\":\"$WT/docs/log/p1-backend.md\"}}"
guard 0 "열린 작업 파일 편집 허용"           "{\"tool_name\":\"Edit\",\"cwd\":\"$WT\",\"tool_input\":{\"file_path\":\"$WT/docs/log/p2-sidebar.md\"}}"
guard 2 "예산 파일 편집 거부"                "{\"tool_name\":\"Write\",\"cwd\":\"$WT\",\"tool_input\":{\"file_path\":\"$WT/.docs-budget.json\"}}"
guard 0 "지휘 세션의 PLAN 편집 허용"         "{\"tool_name\":\"Edit\",\"cwd\":\"$WT\",\"tool_input\":{\"file_path\":\"$WT/docs/PLAN.md\"}}"
guard 2 "작업자(워크트리)의 PLAN 편집 거부"  "{\"tool_name\":\"Edit\",\"cwd\":\"$WK\",\"tool_input\":{\"file_path\":\"$WK/docs/PLAN.md\"}}"
guard 2 "작업자의 CLAUDE.md 편집 거부"       "{\"tool_name\":\"Edit\",\"cwd\":\"$WK\",\"tool_input\":{\"file_path\":\"$WK/CLAUDE.md\"}}"
guard 0 "작업자의 ARCH 편집 허용"            "{\"tool_name\":\"Edit\",\"cwd\":\"$WK\",\"tool_input\":{\"file_path\":\"$WK/docs/ARCH.md\"}}"
guard 0 "작업자의 코드 편집 허용"            "{\"tool_name\":\"Edit\",\"cwd\":\"$WK\",\"tool_input\":{\"file_path\":\"$WK/src/a.ts\"}}"
guard 0 "프로젝트 밖 파일은 관여 안 함"      "{\"tool_name\":\"Write\",\"cwd\":\"$WT\",\"tool_input\":{\"file_path\":\"$WT/../elsewhere/NOTES.md\"}}"
guard 2 "git commit --no-verify 거부"        "{\"tool_name\":\"Bash\",\"cwd\":\"$WT\",\"tool_input\":{\"command\":\"git commit -m x --no-verify\"}}"
guard 2 "git commit -n 거부"                 "{\"tool_name\":\"Bash\",\"cwd\":\"$WT\",\"tool_input\":{\"command\":\"git commit -n -m x\"}}"
guard 0 "git commit -m 허용"                 "{\"tool_name\":\"Bash\",\"cwd\":\"$WT\",\"tool_input\":{\"command\":\"git commit -m \\\"new feature\\\"\"}}"
guard 2 "hooksPath 를 다른 곳으로 거부"      "{\"tool_name\":\"Bash\",\"cwd\":\"$WT\",\"tool_input\":{\"command\":\"git config core.hooksPath /tmp/none\"}}"
guard 0 "hooksPath .githooks 허용"           "{\"tool_name\":\"Bash\",\"cwd\":\"$WT\",\"tool_input\":{\"command\":\"git config core.hooksPath .githooks\"}}"
guard 0 "빈 입력은 통과"                     "{}"

echo
echo "통과 $PASS, 실패 $FAIL"
[ "$FAIL" = 0 ]
