---
name: docs-convention
description: 에이전트가 만드는 마크다운 문서의 종류, 위치, 수명을 정한 규약과 그것을 강제하는 검사기·훅. 다음 상황이면 반드시 이 스킬을 먼저 읽는다 - 저장소에 PLAN, BRIEF, ARCH, NOTES, TODO, 보고서, 인계 문서, 계획, 정리, 메모 같은 .md 파일을 새로 만들거나 옮기려 할 때, 어디에 적어야 할지 모를 때, 작업자(서브에이전트, 워크트리 세션, 다른 Claude 세션)에게 일을 맡기는 지시문을 쓸 때, 작업자의 결과를 합치고 단계(phase, P1, P2, v0.x)를 닫으면서 계획·설계 문서에 "반영"하려 할 때, CLAUDE.md에 줄을 더하려 할 때, 사용자가 docs가 너무 많다·계획 문서가 너무 길다·문서 규약이 필요하다고 할 때, 그리고 이 규약을 새 저장소에 도입할 때. 라이브러리 README, API 문서 생성기, 코드 주석, 블로그 글에는 쓰지 않는다.
---

# docs 규약

이 스킬은 두 가지를 준다. **규약**(`references/convention.md`)과 **강제 장치**(`scripts/check-docs.mjs` 검사기, `scripts/docs-guard.mjs` 편집 차단 훅, `assets/` 템플릿과 훅 설정). 규약만 있으면 지켜지지 않는다는 것이 실측 결과라, 둘을 함께 쓴다.

핵심 구분은 하나다. **살아 있는 문서**(CLAUDE.md, BRIEF, ARCH, PLAN, testing)는 현재 상태만 담고 크기 예산이 있다. **기록**(`docs/log/<작업>.md`, decisions, experiments, research)은 git에 남기고 닫히면 고치지 않는다. 증식은 살아 있는 문서를 기록처럼 덧붙일 때 생긴다.

## 0. 먼저 확인할 것

1. 저장소에 `docs/README.md`와 `scripts/check-docs.mjs`가 있는가. 없으면 규약이 도입되지 않은 저장소다. 아래 5절로 간다. 사용자가 도입을 원하지 않으면 규약의 원칙만 적용하고 파일은 만들지 않는다.
2. 나는 지휘 세션인가 작업자인가. 작업 디렉터리가 `.claude/worktrees/` 아래면 작업자다. 작업자는 자기 작업 파일의 작업 기록·보고 절, 코드, ARCH의 자기 모듈 행만 고친다.

## 1. 문서를 만들거나 옮기려 할 때

`references/convention.md` 1절의 표에서 종류를 찾는다. 표에 없는 문서는 만들지 않는다. 루트에는 README와 CLAUDE.md만, `docs/` 바로 아래에는 표의 파일만, 하위 폴더는 `log/`, `experiments/`, `research/`뿐이다.

- 작업하다 남기는 메모, 계획, 진행 상황은 자기 작업 파일 `docs/log/<작업>.md`의 작업 기록 절에 쓴다. 새 파일을 만들지 않는다.
- 설계가 바뀌었으면 ARCH의 틀린 문장을 고친다. 새 절을 덧붙이지 않는다.
- CLAUDE.md에 줄을 더하려면 "모든 세션이 지켜야 할 규칙인가"를 묻는다. 도구·환경 변수·명령 이름이 들어가면 `docs/testing.md`다. 변경 이력이면 README다.

## 2. 작업을 맡길 때 (지휘 세션)

1. `assets/work-file.md`를 `docs/log/<번호>-<이름>.md`로 복사하고 지시 절을 채운다. 시나리오와 완료 기준을 **직접 넣는다**. "PLAN 4절만 읽어라"는 결국 전체를 읽게 만든다.
2. 작업자가 읽을 파일은 `CLAUDE.md`, `docs/ARCH.md`, 자기 작업 파일 셋이다. 다른 작업 파일을 가리켜야 하면 하나만, "파일 + 절 이름"으로.
3. `node scripts/check-docs.mjs`를 돌린다. 지시 절은 10,000자까지다.
4. `main`에 커밋한 뒤 워크트리를 만든다. 커밋 전에 워크트리를 만들면 작업자에게 파일이 없다.
5. 작업자가 시작한 뒤에는 지시 절을 고치지 않는다. 바뀐 지시는 메시지로 보내고, 작업자가 작업 기록 절에 날짜와 함께 받아 적는다.

## 3. 작업하는 동안 (작업자)

- 생각, 시도, 막힌 곳은 자기 작업 파일의 작업 기록 절에 쓴다. 세션이 바뀌면 `--- YYYY-MM-DD, 세션 n ---` 한 줄을 넣고 이어 쓴다.
- 끝나면 보고 절에 만든 것, 계획과 다른 곳(사실만), 알려진 문제를 쓴다. 살아 있는 문서에 더할 내용을 "제안"하는 절은 쓰지 않는다. 그 목록이 지휘 세션의 할 일이 되어 문서를 불린다.
- 살아 있는 문서를 고치고 싶으면 보고 절 "계획과 다른 곳"에 적는다. 훅이 편집을 거부한다.

## 4. 단계를 닫을 때 (지휘 세션)

한 단계의 모든 작업이 `main`에 합쳐진 뒤에 한다. 작업 하나가 끝났을 때는 그 파일 첫 줄을 `상태: 닫힘`으로 바꾸는 것만 한다.

1. 작업 파일들의 작업 기록·보고 절을 읽고, 계획과 다르게 간 곳의 이유를 확인한다. 작업자의 문서 수정 제안은 따르지 않는다.
2. PLAN: `## 지금` 절을 비우고, `## 다음`의 내용을 `## 지금`으로 올려 시나리오를 채우고, 새 `## 다음`(제목, 목표 세 줄, 완료 기준까지만)을 쓴다. `## 열린 결정`에서 정해진 줄은 지우고 `decisions.md`에 적는다. PLAN의 2단계 제목은 이 셋뿐이고, "끝남"·"(P6)" 같은 완료 표시가 남으면 검사가 실패한다.
3. ARCH: 구현과 달라진 문장만 고친다. 커졌으면 같은 커밋에서 그만큼 줄인다.
4. BRIEF: 바뀐 결정의 행을 다시 쓴다(500자 이하, 날짜 하나). 이전 문장은 `decisions.md`로.
5. CLAUDE.md: 모든 세션의 규칙을 새로 배웠을 때만 한 줄.
6. `node scripts/check-docs.mjs --close`. BRIEF가 HEAD보다 500자, ARCH가 1,000자 넘게 커졌거나, 결정 로그가 3,000자 넘게 늘었거나, 닫힌 작업 파일을 건드렸으면 실패한다. 글자 수를 맞추려 하지 말고 틀린 문장만 고친다. 통과 후 커밋.

## 5. 새 저장소에 도입할 때

`references/convention.md` 8절을 따른다. 요약:

1. 복사: `references/convention.md` → `docs/README.md`, `scripts/check-docs.mjs`와 `scripts/docs-guard.mjs` → `scripts/`, `assets/pre-commit` → `.githooks/pre-commit`, `assets/hooks.json`의 내용을 `.claude/settings.json`에 합친다. `git config core.hooksPath .githooks`.
2. 이미 문서가 쌓인 저장소면 계획 문서를 ARCH(구조, 모델, 모듈 표, API 표), PLAN(지금·다음·열린 결정, `assets/PLAN.md` 구조), decisions(경위)로 나누고, 단계별 지시문과 보고서를 `docs/log/<작업>.md`로 옮긴다(첫 줄 `상태: 닫힘`).
3. CLAUDE.md에 한 줄: "문서를 만들거나, 작업을 맡기거나, 단계를 닫을 때는 `docs/README.md`를 따른다."
4. `node scripts/check-docs.mjs`가 통과할 때까지 줄인다. 예산(`.docs-budget.json`)은 올리지 않는다. 훅이 그 파일의 편집을 거부하며, 기본의 1.5배를 넘으면 검사기가 거부한다.

## 검사기와 훅

| 명령 | 언제 |
|---|---|
| `node scripts/check-docs.mjs` | 문서를 고친 뒤, 작업을 맡기기 전 |
| `node scripts/check-docs.mjs --staged` | pre-commit이 돌린다 |
| `node scripts/check-docs.mjs --close` | 단계 닫기 커밋 전 |
| `node scripts/check-docs.mjs --stop` | Stop 훅이 돌린다. 위반이 있으면 턴을 끝내지 못한다 |

`docs-guard.mjs`는 PreToolUse에서 루트와 `docs/`의 구조 위반, 작업자의 살아 있는 문서 편집, 닫힌 작업 파일 편집, 예산 파일 편집, `--no-verify`를 거부한다. 거부 메시지가 오면 우회하지 말고 메시지가 가리키는 곳에 쓴다.

규약이 도입되지 않은 저장소에서 검사만 해 보려면 이 스킬 폴더의 스크립트를 경로와 함께 부른다: `node <스킬 폴더>/scripts/check-docs.mjs <저장소>`.
