# gudals

Gudals0320의 개인 Claude Code 셋업입니다. 스킬과 mod를 플러그인 하나(`gudals`)에 묶어 두고, 이 저장소 자체가 마켓플레이스입니다.

## 들어 있는 것

| 종류 | 이름 | 호출 | 설명 |
| --- | --- | --- | --- |
| 스킬 | `web` | `/gudals:web` (또는 자동) | 답하기 전에 남들의 경험·해결 사례·최신 정보를 먼저 찾고 근거 있는 추천을 줍니다 |
| 스킬 | `write-ko` | `/gudals:write-ko` (또는 자동) | 한국어 초안을 쓸 때 사실·조건·불확실성을 보존하고 목적과 독자에 맞는 구조와 표현을 고릅니다. ASD-STE100 방향의 [ste-ko](https://github.com/beamonic/ste-ko)(MIT)에서 파생했고, 출처는 [ORIGIN.md](skills/write-ko/ORIGIN.md)에 있습니다 |
| 스킬 | `inquiry` | `/gudals:inquiry` (직접 호출만) | 질문이나 웹·SNS에서 도는 주장을 받아 분해 → 범위 승인 → 조사 → 규칙 판정까지 한 번에 하고, 근거를 결론에서 원문까지 거꾸로 따라갈 수 있는 단일 HTML 보고서를 냅니다. 판정은 코드 규칙이 하고 모든 인용은 보관한 원문과 대조합니다 |
| 스킬 | `docs-convention` | `/gudals:docs-convention` (또는 자동) | 에이전트가 쓰는 문서(PLAN, BRIEF, ARCH, 작업 메모, 보고)의 종류·위치·수명 규약과 그것을 강제하는 검사기·훅입니다. 살아 있는 문서에는 크기 예산을 두고, 작업 메모리는 작업 단위 파일 `docs/log/<작업>.md`로 git에 남깁니다. 문서를 만들거나, 작업자에게 지시하거나, 단계를 닫을 때 자동으로 불립니다 |
| 스킬 + mod | `coordinate` | `/gudals:coordinate` (직접 호출만) | 계획을 마친 작업을 소유 범위가 분명한 하위 세션들로 나눠 워크트리에서 병렬로 돌리고, 메인 세션은 중계와 취합만 합니다. 하위 세션의 규칙은 지시문 대신 mod 훅이 주입하고 강제합니다 |
| mod | transprompt | `/transprompt 내용` (또는 `/gudals:transprompt 내용`) | 요청할 때만 동작합니다. 명령 뒤에 쓴 내용(받아쓴 긴 프롬프트 등)을 마크다운으로 구조화해서 바로 보냅니다. 구조화에 실패하면 원문을 보냅니다. 프롬프트를 자동으로 가로채지는 않습니다 |
| mod | monitor | `/gudals:monitor` | Desktop의 모든 Code 세션을 저장소별 섬으로 묶어 한 패널(Monitor)에 보여 줍니다. 대기(다음 단계 박스, 훅 차단), 실행, 백그라운드, 휴면을 색과 위치로 구분하고, 제목을 누르면 그 세션으로 옮기며, 대기 카드의 답 버튼은 그 세션에 메시지를 보냅니다 |

monitor는 패널을 연 세션에서만 돌아갑니다. 앱의 세션 목록과 각 세션 기록을 3초마다 읽고(모델 호출이 없어 토큰은 들지 않습니다), 백그라운드 셸은 15초마다 확인합니다. 답 버튼의 메시지는 받는 세션에 "다른 세션이 보낸 메시지"로 도착하므로, 사용자 확인이 필요한 질문에는 그 세션이 직접 확인을 다시 요청할 수 있습니다. 화면 설계는 [hooks/monitor/DESIGN.md](hooks/monitor/DESIGN.md)에 있습니다.

`/transprompt`는 mod가 세션 시작 때 등록하는 명령이라, Desktop에서는 새 세션의 첫 메시지 전에는 자동완성 목록에 뜨지 않습니다(끝까지 쳐서 보내면 동작합니다). `/gudals:transprompt`는 `skills/transprompt`가 디스크에서 바로 만드는 같은 명령이라 처음부터 목록에 뜹니다. 실행은 둘 다 mod가 처리합니다.

## inquiry

질문 하나를 받아 리서치를 한 번에 끝내고 보고서 파일 하나를 냅니다. 원본은 별도 저장소(inquiry)에서 개발하고, `scripts/export-plugin.mjs`로 `skills/inquiry/`에 옮겨 둡니다. 이 폴더의 파일은 직접 고치지 않습니다.

- **흐름:** 질문만 보고 명제로 분해 → 사용자가 범위 승인 → 단서 수집과 명제별 지지·반박 검색, 원문 보관, 인용 라벨 → 판정 규칙 계산 → 결론 문장 → 보고서.
- **결과물:** `~/.inquiry/runs/<실행 id>/report.html` 한 파일입니다. 데이터가 페이지 안에 들어 있어 그 파일만 열면 되고, 원하면 Claude 아티팩트로 게시합니다. 위치는 `INQUIRY_DATA_DIR`로 바꿉니다.
- **필요한 것:** Node.js 24 이상(`.ts`를 빌드 없이 실행), DuckDuckGo 검색에 쓰는 ego lite의 `ego-browser` 명령, PDF를 읽을 때는 `pdftotext`.
- **채널:** DuckDuckGo(ego lite), 질병관리청·정책브리핑 보도자료 게시판(첨부 PDF·HWPX·HWP까지). 사이트별 요청 간격은 `engine/config/sites.json`이 정합니다.
- **코드가 막는 것:** 승인 전 검색, 루트 명제가 바뀐 뒤 재승인 없는 검색, 원문에 없는 인용, 나중 기록을 가리키는 메모, 인용에 없는 결론 숫자, 반박 검색 없이 명제 통과.

## docs-convention

여러 단계에 걸쳐 에이전트가 일하면 계획 문서가 "반영"이라는 이름으로 덧붙기만 하고 줄어들지 않습니다(한 저장소에서 3일간 1.2만 자 → 6.8만 자, 줄어든 커밋 없음). 이 스킬은 문서를 **살아 있는 문서**(CLAUDE.md, BRIEF, ARCH, PLAN, testing: 현재 상태만, 크기 예산)와 **기록**(`docs/log/<작업>.md`, decisions, experiments, research: git에 남기고 닫히면 안 고침)으로 나누고, 규약만으로는 지켜지지 않으므로 도구로 강제합니다.

- **규약:** [skills/docs-convention/references/convention.md](skills/docs-convention/references/convention.md). 저장소에 도입하면 `docs/README.md`가 됩니다.
- **검사기** `scripts/check-docs.mjs`: 파일별·합계 예산, 루트와 `docs/`의 구조, PLAN의 세 절(지금·다음·열린 결정) 구조와 완료 표시, 작업 파일 구조, BRIEF 표 행 길이. `--staged`(pre-commit), `--close`(단계 닫기: BRIEF·ARCH 비증가, 닫힌 기록 수정), `--stop`(Stop 훅).
- **편집 차단 훅** `scripts/docs-guard.mjs`(PreToolUse): 루트 md 생성, `docs/` 구조 위반, 워크트리 작업자의 계획·인계 문서 편집, 닫힌 작업 파일 편집, 예산 파일 편집, `--no-verify`를 거부합니다.
- **도입:** 스킬이 복사할 파일과 `.claude/settings.json`에 합칠 훅 설정(`assets/hooks.json`)을 안내합니다. 자체 시험은 `bash skills/docs-convention/tests/selftest.sh`.

## 설치

셸에서:

```bash
claude plugin marketplace add Gudals0320/gudals
claude plugin install gudals@gudals
```

터미널 세션에서는 `/plugin marketplace add Gudals0320/gudals` 후 `/plugin install gudals@gudals`.
데스크톱 앱에서는 프롬프트 입력창 옆 + 버튼 → Plugins → Add marketplace에 `Gudals0320/gudals`를 넣고 Add plugin을 누릅니다.

## 자동 업데이트

직접 만든 마켓플레이스는 자동 업데이트가 기본으로 꺼져 있습니다. 한 번 켜 두면 push할 때마다 세션 시작 시 새 커밋을 받아옵니다.

- `/plugin` → **Marketplaces** → `gudals` → **Enable auto-update**

수동으로 받으려면:

```bash
claude plugin marketplace update gudals
```

`plugin.json`에 `version`을 두지 않아서 설치본은 커밋 SHA를 따라갑니다. 버전을 올릴 필요 없이 push가 곧 릴리스입니다.

## transprompt 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `transpromptModel` | `sonnet` | 구조화에 쓸 모델 |

`/plugin configure gudals@gudals` 또는 `/config`에서 바꿉니다.

예전의 자동 가로채기(음성 판정, 검토 패널, 자동·검토 모드, `on` `off` `auto` `review` `status` `why` 옵션)는 이 기능을 다른 곳으로 옮기면서 뺐습니다.

## 구조

```
.claude-plugin/
  marketplace.json      마켓플레이스 (플러그인 gudals 하나, source "./")
  plugin.json           플러그인 매니페스트와 userConfig
skills/<이름>/SKILL.md   스킬. /gudals:<이름> 으로 호출
skills/inquiry/engine/  inquiry가 돌리는 도구 상자(inquiry 저장소에서 내보낸 사본)
hooks/
  hooks.json            hooks 모듈 진입점 (하나만 둘 수 있음)
  index.ts              각 mod의 register를 부른다
  <mod>/                mod별 코드
types/index.d.ts        $.state 타입
tests/                  claude plugin test 가 돌리는 테스트
```

## 새로 넣기

- 스킬: `skills/<이름>/SKILL.md`를 만든다. 다른 곳은 건드릴 필요 없습니다.
- mod: `hooks/<이름>/`에 코드를 두고 `hooks/index.ts`에서 부릅니다. `userConfig` 키, `$.store` 키, `$.state` 키에는 mod 이름을 접두어로 붙여 다른 mod와 겹치지 않게 합니다.
- 모든 mod가 한 hooks 모듈을 공유하므로, matcher 없는 훅(`session.start` 등)은 모듈 전체에서 한 번만 걸 수 있습니다. 이미 다른 mod가 잡은 이벤트가 필요하면 matcher를 달거나 다른 이벤트에서 처리합니다(coordinate는 첫 훅 호출 때 작업을 찾습니다).

## 개발

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
