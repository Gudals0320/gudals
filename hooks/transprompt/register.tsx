import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Draft } from '../../types'
import { judgeVoice } from './voice'
import type { EditStats, VoiceVerdict } from './voice'

const PANE = 'transprompt'
const TITLE = 'Transprompt'

const draft = atom({ plugin: 'gudals', key: 'transpromptDraft' } as const, null)
const bypassNext = atom({ plugin: 'gudals', key: 'transpromptBypassNext' } as const, false)

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

let inFlight: AbortController | undefined
// 지금 입력창에 있는 초안이 어떻게 들어왔는지: 키로 친 글자 수와 덩어리로 들어온 글자 수.
let edits: EditStats = { keyed: 0, keyless: 0 }
let draftLength = 0
let lastVerdict: VoiceVerdict | undefined
// 마지막 프롬프트가 판정 전에 걸러졌다면 그 이유. 판정까지 갔으면 비운다.
let lastSkip: string | undefined

function describeVerdict(verdict: VoiceVerdict | undefined) {
  if (!verdict) {
    return '아직 판정한 프롬프트가 없습니다.'
  }
  const head = `${verdict.isVoice ? '음성' : '타이핑'}으로 판정 (점수 ${verdict.score})`

  return verdict.reasons.length ? `${head}: ${verdict.reasons.join(', ')}` : head
}

async function isEnabled($: EngineInterface) {
  return (await $.store.get('transpromptEnabled')) !== false
}

async function structure($: EngineInterface, raw: string, model: string) {
  inFlight?.abort()
  const stop = new AbortController()
  inFlight = stop
  await update($, draft, (): Draft => ({ phase: 'structuring', raw }))
  $.ui.status('transprompt: 구조화 중…')

  const result = await $.model.complete(
    { model, system: SYSTEM, prompt: raw, maxTokens: 16000, timeoutMs: 180000 },
    { signal: stop.signal },
  )
  if (inFlight !== stop) {
    return
  }
  inFlight = undefined
  $.ui.status(undefined)

  if (result.isAnswered && result.text.trim() !== '') {
    const structured = stripEmphasis(result.text)
    await update($, draft, (): Draft => ({ phase: 'ready', raw, structured }))
    $.ui.toast('transprompt: 구조화 완료, 확인 후 승인해 주세요')
  } else {
    const reason = result.isAnswered ? 'empty-reply' : result.reason
    await update($, draft, (): Draft => ({ phase: 'failed', raw, reason }))
  }
}

async function finish($: EngineInterface) {
  inFlight?.abort()
  inFlight = undefined
  $.ui.status(undefined)
  await update($, draft, () => null)
  await $.ui.close({ id: PANE })
}

async function send($: EngineInterface, text: string) {
  await finish($)
  // 자기 자신이 호출한 $.prompt.submit은 이 모드의 prompt.submit 훅을 거치지 않는다.
  await $.prompt.submit({ text, asUser: true })
}

async function toPrompt($: EngineInterface, text: string, bypass: boolean) {
  await finish($)
  if (bypass) {
    await update($, bypassNext, () => true)
  }
  await $.prompt.fill({ text })
}

export const registerTransprompt: Register = (on, options) => {
  const minChars = Number(options.transpromptMinChars ?? 200)
  const model = String(options.transpromptModel ?? 'sonnet')
  const voiceGate = options.transpromptVoiceGate !== false
  const voiceThreshold = Number(options.transpromptVoiceThreshold ?? 2)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'transprompt',
      description: '음성 프롬프트 구조화: on | off | status | why',
      argumentHint: 'on | off | status | why',
    })

    return next(e)
  })

  on('command.run', { command: 'transprompt' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'why') {
      return { text: `transprompt: 마지막 프롬프트 ${lastSkip ?? describeVerdict(lastVerdict)}` }
    }
    if (arg === 'on' || arg === 'off') {
      await $.store.set('transpromptEnabled', arg === 'on')
    }
    const enabled = await isEnabled($)

    return {
      text:
        `transprompt: ${enabled ? '켜짐' : '꺼짐'} (${minChars}자 이상, ` +
        `${voiceGate ? `음성 판정 점수 ${voiceThreshold} 이상만` : '음성 판정 없이'} 가로챔, 모델 ${model})`,
    }
  })

  // 입력창 편집을 지켜보기만 한다: 키 하나로 들어온 글자와 붙여넣기/받아쓰기처럼 덩어리로 들어온 글자를 센다.
  on('prompt.edit', async ($, e, next) => {
    if (e.inputText !== '') {
      if (e.key) {
        edits = { ...edits, keyed: edits.keyed + e.inputText.length }
      } else {
        edits = { ...edits, keyless: edits.keyless + e.inputText.length }
      }
    }
    const box = await next(e)
    draftLength = box.text.length

    return box
  })

  on('prompt.change', async ($, e, next) => {
    if (e.origin.kind === 'engine' && e.text.length > draftLength) {
      // 엔진 쪽 받아쓰기 등 prompt.edit을 거치지 않은 삽입.
      edits = { ...edits, keyless: edits.keyless + e.text.length - draftLength }
    } else if (e.origin.kind !== 'engine') {
      edits = { keyed: 0, keyless: 0 }
    }
    draftLength = e.text.length

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const typedEdits = edits
    edits = { keyed: 0, keyless: 0 }
    draftLength = 0
    const isPersonTyped = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isPersonTyped || e.command || e.isMeta || e.attachments?.length) {
      return next(e)
    }
    if (await read($, bypassNext)) {
      await update($, bypassNext, () => false)
      return next(e)
    }
    if (!(await isEnabled($))) {
      lastSkip = '판정 안 함: transprompt가 꺼져 있습니다.'
      return next(e)
    }
    const length = e.text.trim().length
    if (length < minChars) {
      lastSkip = `판정 안 함: ${length}자로 최소 ${minChars}자보다 짧습니다.`
      return next(e)
    }
    lastSkip = undefined
    lastVerdict = judgeVoice(e.text, typedEdits, voiceThreshold)
    if (voiceGate && !lastVerdict.isVoice) {
      return next(e)
    }

    void structure($, e.text, model)
    void $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })

    return { drop: 'transprompt: 구조화한 뒤 승인을 받아 보냅니다' }
  }).catch(($, e, next) => next(e)) // 훅이 실패하면 프롬프트를 잃지 않고 그대로 보낸다.

  on('ui.close', { id: PANE }, async ($, e, next) => {
    // 사람이 Esc나 닫기로 패널을 닫으면 원문을 프롬프트 창으로 돌려놓는다.
    if (e.origin.kind === 'person') {
      const current = await read($, draft)
      inFlight?.abort()
      inFlight = undefined
      $.ui.status(undefined)
      await update($, draft, () => null)
      if (current) {
        await $.prompt.fill({ text: current.raw })
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const current = await read($, draft)

    if (current === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>대기 중인 프롬프트가 없습니다.</Text>
        </Box>
      )
    }

    if (current.phase === 'structuring') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>음성 프롬프트를 구조화하는 중… ({current.raw.length}자)</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="raw" hotkey="3" label="원문 그대로 보내기" onPress={() => send($, current.raw)} />
            <Button key="cancel" hotkey="5" label="취소 (원문을 입력창으로)" onPress={() => toPrompt($, current.raw, false)} />
          </Box>
        </Box>
      )
    }

    if (current.phase === 'failed') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="red">구조화 실패: {current.reason}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="retry" hotkey="4" variant="primary" label="다시 구조화" onPress={() => structure($, current.raw, model)} />
            <Button key="raw" hotkey="3" label="원문 그대로 보내기" onPress={() => send($, current.raw)} />
            <Button key="cancel" hotkey="5" label="취소 (원문을 입력창으로)" onPress={() => toPrompt($, current.raw, false)} />
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          이렇게 보내면 될까요? 원문 {current.raw.length}자 → 구조화 {current.structured.length}자
        </Text>
        {voiceGate && <Text dimColor>{describeVerdict(lastVerdict)}</Text>}
        <Markdown key="preview" text={current.structured} />
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="approve" hotkey="1" variant="primary" autoFocus label="승인하고 보내기" onPress={() => send($, current.structured)} />
          <Button key="edit" hotkey="2" label="입력창에서 고치기" onPress={() => toPrompt($, current.structured, true)} />
          <Button key="raw" hotkey="3" label="원문 그대로 보내기" onPress={() => send($, current.raw)} />
          <Button key="retry" hotkey="4" label="다시 구조화" onPress={() => structure($, current.raw, model)} />
          <Button key="cancel" hotkey="5" label="취소 (원문을 입력창으로)" onPress={() => toPrompt($, current.raw, false)} />
        </Box>
      </Box>
    )
  })
}
