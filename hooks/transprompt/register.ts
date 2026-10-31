import type { EngineInterface, Register } from 'claude-code'

// 요청할 때만 쓰는 구조화: /transprompt 뒤에 쓴 내용을 구조화해서 바로 보낸다.
// 프롬프트를 자동으로 가로채던 기능(음성 판정, 검토 패널, 자동·검토 모드)은 이 스킬을 다른 곳으로 옮기면서 뺐다.

const TIMEOUT_MS = 180000
// 예전 옵션 단어. 이것만 치면 내용으로 보내지 않고, 이제 요청할 때만 동작한다고 알려 준다.
const RETIRED_OPTIONS = new Set(['on', 'off', 'auto', 'review', 'status', 'why'])
const USAGE = 'transprompt: 구조화할 내용을 명령 뒤에 적어 주세요. 예: /transprompt 로그인 버튼이 안 보이는데 고쳐 줘'

const SYSTEM = `너는 음성인식(STT)으로 받아쓴 프롬프트를 코딩 에이전트(Claude Code)에게 보낼 구조화된 작업 지시문으로 다시 쓰는 편집자다.

원칙
- 원문의 요청, 맥락, 조건, 예시, 걱정, 질문을 하나도 빠뜨리지 않는다. 요약해서 정보를 잃지 않는다.
- 원문에 없는 요구, 추측, 해결책을 덧붙이지 않는다.
- "어", "음", "그러니까", "뭐", "약간" 같은 군말과 말 더듬기, 같은 말의 반복은 걷어내고 하나로 합친다.
- 음성인식이 잘못 받아쓴 것이 분명한 단어(특히 기술 용어, 라이브러리명, 파일명, 명령어)만 문맥에 맞게 바로잡는다. 애매하면 원래 표기를 둔다.
- 화자가 직접 요청하는 1인칭 시점과 원문의 언어를 그대로 유지한다.
- 말하다가 생각이 바뀐 경우 최종 의도를 따르되, 바뀌었다는 사실이 중요하면 남긴다.

형식
- 마크다운 헤딩(#, ##, ###), 불릿(-, *), 번호 목록(1. 2. 3.)을 내용에 맞게 자유롭게 쓴다.
- 볼드(**굵게**, __굵게__)와 이탤릭(*기울임*, _기울임_)은 절대 쓰지 않는다. 강조가 필요하면 문장이나 구조로 드러낸다.
- 코드, 파일 경로, 명령어, 식별자는 백틱으로 감싼다.
- 권장 뼈대(해당 없는 섹션은 빼고, 필요하면 섹션을 더한다):
  # 한 줄 제목
  ## 배경
  ## 요청 사항 (순서가 있으면 번호 목록)
  ## 요구 조건 / 제약
  ## 참고 / 예시
  ## 열린 질문
- 출력은 구조화된 프롬프트 본문만. 서두, 맺음말, 설명, 코드펜스로 전체를 감싸기 금지.`

// 모델이 규칙을 어겨도 볼드/이탤릭은 걷어낸다. 백틱 안은 건드리지 않는다.
export function stripEmphasis(text: string): string {
  const fenced = text.match(/^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/)
  const body = fenced?.[1] ?? text

  return body
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '$1')
            .replace(/__(?=\S)([^_\n]+?)__/g, '$1')
            .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]+?)\*(?!\*)/g, '$1$2')
            .replace(/(^|[\s(])_(?=[^\s_])([^_\n]+?)_(?=$|[\s).,!?:;])/gm, '$1$2'),
    )
    .join('')
    .trim()
}

type Unanswered = { reason: string; status?: number | null; error?: string }

function describeFailure(result: Unanswered) {
  if (result.reason === 'aborted') {
    return `${TIMEOUT_MS / 1000}초 안에 답이 오지 않았어요`
  }
  if (result.reason === 'empty-reply') {
    return '모델이 빈 답을 보냈어요'
  }
  if (result.reason === 'api-error') {
    if (result.error === 'rate_limit') {
      return '요청 한도에 걸렸어요. 잠시 뒤 다시 시도하세요'
    }
    if (result.error === 'overloaded') {
      return '모델이 붐비고 있어요. 잠시 뒤 다시 시도하세요'
    }
    if (result.error === 'authentication_failed') {
      return '인증에 실패했어요. 로그인 상태를 확인하세요'
    }
    return `API 오류 (${result.status ?? '응답 없음'})`
  }

  return result.reason
}

let inFlight: AbortController | undefined

// 실패해도 기다리지 않고 원문을 보내, 넘긴 내용을 잃지 않는다.
async function structureAndSend($: EngineInterface, raw: string, model: string) {
  inFlight?.abort()
  const stop = new AbortController()
  inFlight = stop
  $.ui.status('transprompt: 구조화 중…')

  const result = await $.model.complete(
    { model, system: SYSTEM, prompt: raw, maxTokens: 16000, timeoutMs: TIMEOUT_MS },
    { signal: stop.signal },
  )
  if (inFlight !== stop) {
    return
  }
  inFlight = undefined
  $.ui.status(undefined)

  if (result.isAnswered && result.text.trim() !== '') {
    $.ui.toast('transprompt: 구조화해서 보냈어요')
    await $.prompt.submit({ text: stripEmphasis(result.text), asUser: true })
    return
  }
  const reason = describeFailure(result.isAnswered ? { reason: 'empty-reply' } : result)
  $.ui.toast(`transprompt: 구조화 실패(${reason}), 원문을 보냈어요`)
  await $.prompt.submit({ text: raw, asUser: true })
}

async function runCommand($: EngineInterface, args: string, model: string) {
  const text = args.trim()
  if (text === '') {
    return { text: USAGE }
  }
  if (RETIRED_OPTIONS.has(text)) {
    return { text: `transprompt: /transprompt ${text} 옵션은 없어졌습니다. 이제 요청할 때만 동작합니다. ${USAGE.replace('transprompt: ', '')}` }
  }
  void structureAndSend($, text, model)

  return {}
}

export const registerTransprompt: Register = (on, options) => {
  const model = String(options.transpromptModel ?? 'sonnet')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'transprompt',
      description: '뒤에 쓴 내용을 구조화해서 바로 보냅니다',
      argumentHint: '[구조화할 내용]',
    })

    return next(e)
  })

  // 짧은 /transprompt는 세션이 돌아야 등록되어, Desktop에서는 새 세션 첫 메시지의 자동완성에 안 뜬다.
  // skills/transprompt가 디스크에서 바로 보이는 /gudals:transprompt를 만들고, 그 실행도 여기서 받는다.
  on('command.run', { command: 'transprompt' }, async ($, e) => runCommand($, e.args, model))
  on('command.run', { command: 'gudals:transprompt' }, async ($, e) => runCommand($, e.args, model))
}
