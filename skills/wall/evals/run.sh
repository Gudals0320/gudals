#!/usr/bin/env bash
# wall 효과 시험. 같은 과제를 스킬 없이 N회, 스킬을 첫 메시지에 넣고 N회 돌린다.
#   bash skills/wall/evals/run.sh <과제 이름> <결과 폴더> [N=3] [모델=sonnet]
# 과제는 evals/tasks/<이름>/ 에 fixture.mjs(저장소 생성), t1.txt(1턴 요청), t2.txt(2턴: 사용자의 우회 제안), grade.mjs(채점) 로 둔다.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL="$(cd "$HERE/.." && pwd)"
TASK="${1:?과제 이름}"; OUT="${2:?결과 폴더}"; N="${3:-3}"; MODEL="${4:-sonnet}"
TD="$HERE/tasks/$TASK"
[ -f "$TD/fixture.mjs" ] || { echo "과제가 없다: $TD"; exit 2; }
mkdir -p "$OUT"
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

T1="$(cat "$TD/t1.txt")"
T2="$(cat "$TD/t2.txt")"

# 스킬 호출을 흉내 낸다. Skill 도구가 본문을 메시지로 넣는 것과 같은 모양이다.
SKILL_BODY="$(awk 'BEGIN{fm=0} /^---$/{fm++; next} fm>=2{print}' "$SKILL/SKILL.md")"
WITH="Base directory for this skill: $(winpath "$SKILL")

$SKILL_BODY

ARGUMENTS: $T1"

ALLOW=(--allowedTools "Bash(node *)" "Bash(cat *)" "Bash(ls *)" "Bash(xxd *)" "Bash(od *)" "Bash(hexdump *)" "Bash(iconv *)" "Bash(python *)" "Bash(python3 *)" "Bash(file *)" "Bash(head *)" "Bash(tail *)" "Bash(grep *)" "Bash(wc *)" "Bash(cd *)" "Bash(pwd)" "Bash(diff *)" "Bash(mkdir *)" "Bash(strings *)" "Read" "Edit" "MultiEdit" "Write" "Grep" "Glob")

one() {
  local cond="$1" i="$2" msg sid
  local d="$OUT/$cond-$i"
  node "$TD/fixture.mjs" "$d" >/dev/null
  if [ "$cond" = with ]; then msg="$WITH"; else msg="$T1"; fi
  printf '%s' "$msg" > "$d/.msg1.txt"
  ( cd "$d" && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p "$msg" --model "$MODEL" --output-format stream-json --verbose --permission-mode acceptEdits --max-turns 60 "${ALLOW[@]}" > "$d/.t1.jsonl" 2> "$d/.t1.err" )
  sid="$(node -e 'const L=require("fs").readFileSync(process.argv[1],"utf8").split("\n");for(const l of L){try{const j=JSON.parse(l);if(j.session_id){console.log(j.session_id);break}}catch{}}' "$d/.t1.jsonl")"
  if [ -n "$sid" ]; then
    ( cd "$d" && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p --resume "$sid" "$T2" --model "$MODEL" --output-format stream-json --verbose --permission-mode acceptEdits --max-turns 60 "${ALLOW[@]}" > "$d/.t2.jsonl" 2> "$d/.t2.err" )
  fi
  echo "done $cond-$i"
}

for i in $(seq 1 "$N"); do one without "$i" & one with "$i" & done
wait
node "$HERE/summarize.mjs" "$OUT" "$TD/grade.mjs"
