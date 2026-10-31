#!/usr/bin/env bash
# wall 스킬의 압축 블록과 공용 블록 스크립트(claude-md-block.mjs)가 CLAUDE.md 를 올바르게 넣고 갱신하고 빼는지 확인한다.
# 사용: bash skills/wall/tests/selftest.sh   (bash, node 필요)
set -u
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$SKILL/../.." && pwd)"
BLOCK="$ROOT/scripts/claude-md-block.mjs"
CONTENT="$SKILL/assets/block.md"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ok    $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/        /' | head -15; }
# expect <기대코드> <설명> <명령...>  (OUT 에 출력)
expect() { local want="$1" desc="$2"; shift 2; OUT="$("$@" 2>&1)"; local got=$?; [ "$got" = "$want" ] && ok "[$want] $desc" || bad "[want $want, got $got] $desc" "$OUT"; }
has()    { grep -q -- "$1" "$2" && ok "$3" || bad "$3 (\"$1\" 없음)" "$(cat "$2")"; }
hasnt()  { grep -q -- "$1" "$2" && bad "$3 (\"$1\" 있음)" "$(cat "$2")" || ok "$3"; }
count()  { local n; n=$(grep -c -- "$1" "$2"); [ "$n" = "$3" ] && ok "$4" || bad "$4 (개수 $n, 기대 $3)" "$(cat "$2")"; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
F="$T/CLAUDE.md"

echo "== 압축 블록 =="
n=$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8").replace(/\r\n/g,"\n");console.log([...s].length)' "$CONTENT")
[ "$n" -le 700 ] && ok "block.md 는 700자 이하 ($n)" || bad "block.md 가 700자를 넘는다 ($n)"
has "<!-- gudals:wall -->" "$CONTENT" "block.md 에 여는 표식"
has "<!-- /gudals:wall -->" "$CONTENT" "block.md 에 닫는 표식"
has "3개 이상" "$CONTENT" "킬스위치 N=3 이 들어 있다"

echo "== 사용법 =="
expect 2 "명령 없음" node "$BLOCK"
expect 2 "잘못된 이름" node "$BLOCK" upsert "Bad Name" "$CONTENT" --file "$F"
expect 2 "upsert 에 내용 파일 없음" node "$BLOCK" upsert wall --file "$F"

echo "== 없는 파일에 넣기 =="
expect 0 "파일이 없으면 만든다" node "$BLOCK" upsert wall "$CONTENT" --file "$F"
[ -f "$F" ] && ok "CLAUDE.md 가 생겼다" || bad "CLAUDE.md 가 없다"
count "<!-- gudals:wall -->" "$F" 1 "블록이 하나"
has "## 벽 앞에서" "$F" "블록 내용이 들어갔다"
rm "$F"

echo "== 기존 내용 보존 =="
printf '# my-project\n\n## 지킬 것\n\n- 문서는 한국어로 쓴다.\n- 테스트는 `npm test`.\n' > "$F"
expect 0 "기존 CLAUDE.md 에 넣기" node "$BLOCK" upsert wall "$CONTENT" --file "$F"
has "# my-project" "$F" "제목 보존"
has "npm test" "$F" "기존 규칙 보존"
count "<!-- gudals:wall -->" "$F" 1 "블록 하나"
head -1 "$F" | grep -q "# my-project" && ok "블록은 끝에 붙고 앞 내용은 그대로" || bad "앞 내용이 밀렸다" "$(head -3 "$F")"

echo "== 같은 내용 다시 넣기 =="
cp "$F" "$T/before.md"
expect 0 "멱등" node "$BLOCK" upsert wall "$CONTENT" --file "$F"
printf '%s' "$OUT" | grep -q "변화 없음" && ok "변화 없음이라고 말한다" || bad "변화 없음 메시지가 없다" "$OUT"
cmp -s "$F" "$T/before.md" && ok "파일이 바이트 단위로 같다" || bad "파일이 달라졌다" "$(diff "$T/before.md" "$F")"

echo "== 내용 갱신 =="
printf '<!-- gudals:wall -->\n## 막혔을 때 (v2)\n\n새 문장.\n<!-- /gudals:wall -->\n' > "$T/v2.md"
expect 0 "갱신" node "$BLOCK" upsert wall "$T/v2.md" --file "$F"
has "(v2)" "$F" "새 내용이 들어갔다"
hasnt "같은 가정 위의 반복" "$F" "옛 내용이 사라졌다"
count "<!-- gudals:wall -->" "$F" 1 "블록은 여전히 하나"
has "npm test" "$F" "기존 규칙 여전히 보존"

echo "== 표식 없는 내용 파일 =="
printf '## 막혔을 때 (v3)\n' > "$T/v3.md"
expect 0 "표식 없는 내용도 받는다" node "$BLOCK" upsert wall "$T/v3.md" --file "$F"
has "(v3)" "$F" "v3 들어감"
count "<!-- /gudals:wall -->" "$F" 1 "닫는 표식 하나"

echo "== 블록 둘 =="
printf '<!-- gudals:docs -->\n문서 규약 한 줄.\n<!-- /gudals:docs -->\n' > "$T/docs.md"
expect 0 "두 번째 블록" node "$BLOCK" upsert docs "$T/docs.md" --file "$F"
expect 0 "list" node "$BLOCK" list --file "$F"
printf '%s' "$OUT" | grep -q "wall" && printf '%s' "$OUT" | grep -q "docs" && ok "list 에 둘 다" || bad "list 누락" "$OUT"
expect 0 "wall 만 빼기" node "$BLOCK" remove wall --file "$F"
hasnt "gudals:wall" "$F" "wall 블록이 없다"
has "gudals:docs" "$F" "docs 블록은 남았다"
has "npm test" "$F" "기존 규칙 보존"
expect 0 "없는 블록 빼기" node "$BLOCK" remove wall --file "$F"
printf '%s' "$OUT" | grep -q "블록이 없다" && ok "없다고 말한다" || bad "메시지 없음" "$OUT"
expect 0 "docs 도 빼기" node "$BLOCK" remove docs --file "$F"
printf '# my-project\n\n## 지킬 것\n\n- 문서는 한국어로 쓴다.\n- 테스트는 `npm test`.\n' > "$T/orig.md"
cmp -s "$F" "$T/orig.md" && ok "다 빼면 원래 파일로 돌아온다" || bad "원래 파일과 다르다" "$(diff "$T/orig.md" "$F")"

echo "== CRLF 파일 =="
printf '# win\r\n\r\n- rule\r\n' > "$F"
expect 0 "CRLF 파일에 넣기" node "$BLOCK" upsert wall "$CONTENT" --file "$F"
node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8"); process.exit(/\r\n/.test(s)?0:1)' "$F" && ok "CRLF 유지" || bad "CRLF 가 사라졌다"
node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8"); process.exit(/[^\r]\n/.test(s)?1:0)' "$F" && ok "LF 단독 줄이 없다" || bad "LF 단독 줄이 섞였다"

echo
echo "통과 $PASS, 실패 $FAIL"
[ "$FAIL" = 0 ]
