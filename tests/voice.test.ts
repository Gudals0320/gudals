import { expect, test } from 'claude-code/testing'

import { judgeVoice } from '../hooks/transprompt/voice'

const NO_EDITS = { keyed: 0, keyless: 0 }

// 실제로 음성으로 보낸 첫 요청
const VOICE_LONG =
  'Mods 를 만들고 싶어. 어떤 기능이냐면 내가 음성인식으로 프롬프트를 거의 항상 쓰는데 이렇게 되면은 전달이 구조화가 안 되고, 그러니까 뭐 이런 거를 뭐 내 응답을 문서에 어디 기록을 해야 된다던가 그런 상황이 있을 수 있는데, 거기에 이렇게 음성으로 넣어놓은 무한 줄글이 들어가게 되면은 관리가 어렵고 추적이 어렵단 말이야. 그리고 내가 막 10분 이상 말하는 경우도 있어. 텍스트량이 상당해질 거잖아. 이거를 먼저 모드가 먼저 구조화를 하고 프롬프트를 바꾼 다음에 대기했으면 좋겠어. 그러니까 일단 내가 만들고 싶은 거는 이렇게 음성 인식을 해서 전송을 하면은 중간에 클로드가 채가서 구조화를 하고 허락을 받는 거야. 이렇게 보내면 될까요? 내가 그걸 읽고 승인을 하면은 그게 실제 클로드 작업 클로드한테 넘어가서 그거를 프롬프트로 받아서 작업을 하는 거지. 그리고 마크다운 불렛 `-` , `*` 부터 1. 2. 3., `h1` `h2` `h3` 등을 자유롭게 사용했으면 좋겠어. 그리고 이탤릭체와 볼드체는 사용하지 않았으면 좋겠어.'

const VOICE_RAMBLE =
  '어 그러니까 내가 하고 싶은 거는 음 로그인 페이지를 좀 고치고 싶은데 뭐 비밀번호 찾기 버튼이 안 보이거든 그거를 좀 보이게 해 주고 그리고 또 하나는 에러 메시지가 영어로 나오는데 그거를 한국어로 바꿔 줬으면 좋겠어 그리고 테스트도 같이 돌려 줘'

const TYPED_TECH =
  'hooks/register.tsx에서 prompt.submit 훅이 `e.attachments`를 볼 때 길이 체크를 빼먹었어. minChars 비교 전에 처리하도록 고치고, tests/transprompt.test.tsx에 케이스 하나 추가해줘.'

const TYPED_MARKDOWN = '# 할 일\n\n1. 빌드 고치기\n2. 테스트 추가\n3. README 업데이트\n\n- 마감은 금요일\n- 리뷰는 내가 함'

const TYPED_KOREAN_PARAGRAPH =
  '오늘 회의에서 정한 내용을 정리해서 문서로 남겨 주세요. 결정 사항은 세 가지입니다. 첫째, 배포 주기를 주 1회로 바꿉니다. 둘째, 코드 리뷰는 최소 한 명이 승인해야 합니다. 셋째, 장애 대응 당번을 순번제로 운영합니다. 각 항목에 담당자와 시작일을 함께 적어 주세요.'

test('the voice gate tells dictation from typing', () => {
  const cases = [
    ['VOICE_LONG', VOICE_LONG, NO_EDITS, true],
    ['VOICE_RAMBLE', VOICE_RAMBLE, NO_EDITS, true],
    // 짧은 말은 글만 봐서는 알 수 없다: 입력창에 들어온 방식이 있어야 판정된다.
    ['VOICE_SHORT', '막 커밋 해줘', NO_EDITS, false],
    ['VOICE_SHORT injected at once', '막 커밋 해줘', { keyed: 0, keyless: 7 }, true],
    ['TYPED_TECH', TYPED_TECH, NO_EDITS, false],
    ['TYPED_MARKDOWN', TYPED_MARKDOWN, NO_EDITS, false],
    ['TYPED_KOREAN_PARAGRAPH', TYPED_KOREAN_PARAGRAPH, NO_EDITS, false],
    ['VOICE_RAMBLE typed by keys', VOICE_RAMBLE, { keyed: 140, keyless: 0 }, false],
    ['TYPED_KOREAN_PARAGRAPH injected at once', TYPED_KOREAN_PARAGRAPH, { keyed: 0, keyless: 160 }, true],
  ] as const

  for (const [name, text, edits, expected] of cases) {
    const verdict = judgeVoice(text, edits, 2)
    expect(`${name}: ${verdict.isVoice}`).toBe(`${name}: ${expected}`)
  }
})
