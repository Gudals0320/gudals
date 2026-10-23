# gudals

Gudals0320의 개인 Claude Code 셋업입니다. 스킬과 mod를 플러그인 하나(`gudals`)에 묶어 두고, 이 저장소 자체가 마켓플레이스입니다.

## 들어 있는 것

| 종류 | 이름 | 호출 | 설명 |
| --- | --- | --- | --- |
| 스킬 | `web` | `/gudals:web` (또는 자동) | 답하기 전에 남들의 경험·해결 사례·최신 정보를 먼저 찾고 근거 있는 추천을 줍니다 |
| 스킬 | `write-ko` | `/gudals:write-ko` (또는 자동) | 한국어 초안을 쓸 때 사실·조건·불확실성을 보존하고 목적과 독자에 맞는 구조와 표현을 고릅니다. ASD-STE100 방향의 [ste-ko](https://github.com/beamonic/ste-ko)(MIT)에서 파생했고, 출처는 [ORIGIN.md](skills/write-ko/ORIGIN.md)에 있습니다 |
| 스킬 + mod | `coordinate` | `/gudals:coordinate` (또는 자동) | 계획을 마친 작업을 소유 범위가 분명한 하위 세션들로 나눠 워크트리에서 병렬로 돌리고, 메인 세션은 중계와 취합만 합니다. 하위 세션의 규칙은 지시문 대신 mod 훅이 주입하고 강제합니다 |
| mod | transprompt | `/transprompt on \| off \| auto \| review \| status \| why` (또는 `/gudals:transprompt …`) | 음성인식으로 받아쓴 긴 프롬프트를 가로채 마크다운으로 구조화해 보냅니다. 기본은 자동 전송이고, `review` 모드에서는 승인을 받은 뒤 보냅니다 |

`/transprompt`는 mod가 세션 시작 때 등록하는 명령이라, Desktop에서는 새 세션의 첫 메시지 전에는 자동완성 목록에 뜨지 않습니다(끝까지 쳐서 보내면 동작합니다). `/gudals:transprompt`는 `skills/transprompt`가 디스크에서 바로 만드는 같은 명령이라 처음부터 목록에 뜹니다. 실행은 둘 다 mod가 처리합니다.

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
| `transpromptAuto` | `true` | 구조화한 결과를 승인 없이 바로 보냅니다. 실패하면 원문을 보냅니다. `/transprompt auto` 또는 `review`로 고른 모드가 이 값보다 우선합니다 |
| `transpromptMinChars` | 200 | 이 글자 수 이상만 가로챕니다 |
| `transpromptModel` | `sonnet` | 구조화에 쓸 모델 |
| `transpromptVoiceGate` | `true` | 끄면 음성 판정 없이 길이만 봅니다 |
| `transpromptVoiceThreshold` | 2 | 이 점수 이상이면 음성으로 봅니다 |

`/plugin configure gudals@gudals` 또는 `/config`에서 바꿉니다.

음성 판정은 `hooks/transprompt/voice.ts`가 점수로 추정합니다. 입력 방식(덩어리로 들어왔는지, 키로 쳤는지)과 텍스트 특징(줄바꿈, 코드·마크다운 기호, 영문 비율, 군말, 구어체 어미 등)을 봅니다. `/transprompt why`로 마지막 프롬프트의 점수와 근거를 볼 수 있습니다.

## 구조

```
.claude-plugin/
  marketplace.json      마켓플레이스 (플러그인 gudals 하나, source "./")
  plugin.json           플러그인 매니페스트와 userConfig
skills/<이름>/SKILL.md   스킬. /gudals:<이름> 으로 호출
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
