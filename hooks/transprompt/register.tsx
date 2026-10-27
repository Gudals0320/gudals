import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Draft } from '../../types'
import { judgeVoice } from './voice'
import type { EditStats, VoiceVerdict } from './voice'

const PANE = 'transprompt'
const TITLE = 'Transprompt'
const TIMEOUT_MS = 180000
// 구조화 중이거나 실패했을 때 원문 미리보기에 보여 줄 글자 수.
const RAW_EXCERPT = 160

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
// 마지막으로 사람이 보낸 프롬프트가 입력창에 들어온 방식. /transprompt why가 보여 준다.
let lastEdits: EditStats | undefined
// 검토 패널에서 보고 있는 탭. 새로 구조화할 때마다 구조화본으로 돌아간다.
let view: 'structured' | 'raw' = 'structured'
// 구조화 중에 경과 시간을 다시 그리는 타이머.
let ticker: Timer | undefined

function stopTicker() {
  ticker?.cancel()
  ticker = undefined
}

function excerpt(text: string) {
  return text.length > RAW_EXCERPT ? `${text.slice(0, RAW_EXCERPT)}…` : text
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

// auto가 참이면 승인 단계 없이 결과를 바로 보낸다. 실패해도 기다리지 않고 원문을 보낸다.
// command가 있으면 raw는 그 스킬 이름 뒤의 내용이고, 결과는 그 스킬을 다시 실행해 넘긴다.
async function structure($: EngineInterface, raw: string, model: string, auto: boolean, command?: string) {
  inFlight?.abort()
  const stop = new AbortController()
  inFlight = stop
  view = 'structured'
  const startedAt = await $.clock.now()
  await update($, draft, (): Draft => ({ phase: 'structuring', raw, startedAt, auto, command }))
  $.ui.status('transprompt: 구조화 중…')
  stopTicker()
  ticker = $.clock.every(1000, () => $.ui.invalidate('ui.render'))

  const result = await $.model.complete(
    { model, system: SYSTEM, prompt: raw, maxTokens: 16000, timeoutMs: TIMEOUT_MS },
    { signal: stop.signal },
  )
  if (inFlight !== stop) {
    return
  }
  inFlight = undefined
  stopTicker()
  $.ui.status(undefined)

  if (result.isAnswered && result.text.trim() !== '') {
    const structured = stripEmphasis(result.text)
    if (auto) {
      $.ui.toast('transprompt: 구조화해서 보냈어요')
      await send($, structured, command)
      return
    }
    await update($, draft, (): Draft => ({ phase: 'ready', raw, structured, command }))
    $.ui.toast('transprompt: 구조화 완료, 확인 후 승인해 주세요')
  } else {
    const reason = describeFailure(result.isAnswered ? { reason: 'empty-reply' } : result)
    if (auto) {
      $.ui.toast(`transprompt: 구조화 실패(${reason}), 원문을 보냈어요`)
      await send($, raw, command)
      return
    }
    await update($, draft, (): Draft => ({ phase: 'failed', raw, reason, command }))
  }
}

// 입력창에 되돌릴 때는 스킬 호출을 앞에 붙여, 그대로 다시 보내면 같은 스킬로 간다.
function withCommand(text: string, command: string | undefined) {
  return command ? `/${command} ${text}` : text
}

async function isSkillCommand($: EngineInterface, name: string) {
  const found = (await $.command.list()).find(c => c.name === name)

  return found !== undefined && found.source !== 'builtin'
}

async function showView($: EngineInterface, next: 'structured' | 'raw') {
  view = next
  $.ui.invalidate('ui.render')
}

async function finish($: EngineInterface) {
  inFlight?.abort()
  inFlight = undefined
  stopTicker()
  $.ui.status(undefined)
  await update($, draft, () => null)
  await $.ui.close({ id: PANE })
}

async function send($: EngineInterface, text: string, command: string | undefined) {
  await finish($)
  // 자기 자신이 호출한 $.prompt.submit과 $.command.run은 이 모드의 훅을 거치지 않는다.
  if (command) {
    await $.command.run({ command, args: text })
    return
  }
  await $.prompt.submit({ text, asUser: true })
}

async function toPrompt($: EngineInterface, text: string, bypass: boolean, command: string | undefined) {
  await finish($)
  if (bypass) {
    await update($, bypassNext, () => true)
  }
  await $.prompt.fill({ text: withCommand(text, command) })
}

type Settings = { minChars: number; model: string; voiceGate: boolean; voiceThreshold: number; auto: boolean }

// /transprompt auto | review로 고른 모드가 플러그인 설정(transpromptAuto)보다 우선한다.
async function isAuto($: EngineInterface, settings: Settings) {
  const saved = await $.store.get('transpromptAuto')

  return typeof saved === 'boolean' ? saved : settings.auto
}

// 인자가 비었거나 이 단어 하나뿐이면 옵션이다. 그 밖의 인자는 구조화할 내용으로 본다.
const OPTIONS = new Set(['', 'on', 'off', 'auto', 'review', 'status', 'why'])

async function runCommand($: EngineInterface, args: string, settings: Settings) {
  const arg = args.trim()
  if (!OPTIONS.has(arg)) {
    // 직접 넘긴 내용은 음성 판정·최소 글자 수·켜짐 여부와 상관없이 구조화하고, 모드와 상관없이 바로 보낸다.
    void structure($, arg, settings.model, true)
    void $.ui.open({ id: PANE, title: TITLE })

    return {}
  }
  if (arg === 'why') {
    // 입력 방식이 0 / 0이면 이 화면에서는 입력창 편집이 mod에 오지 않아, 텍스트 모양만으로 판정한 것이다.
    const stats = lastEdits ? ` (입력 방식: 키로 친 글자 ${lastEdits.keyed} / 한 번에 들어온 글자 ${lastEdits.keyless})` : ''

    return { text: `transprompt: 마지막 프롬프트 ${lastSkip ?? describeVerdict(lastVerdict)}${stats}` }
  }
  if (arg === 'on' || arg === 'off') {
    await $.store.set('transpromptEnabled', arg === 'on')
  }
  if (arg === 'auto' || arg === 'review') {
    await $.store.set('transpromptAuto', arg === 'auto')
  }
  const enabled = await isEnabled($)
  const mode = (await isAuto($, settings)) ? '자동 전송' : '검토 후 전송'
  const { minChars, model, voiceGate, voiceThreshold } = settings

  return {
    text:
      `transprompt: ${enabled ? '켜짐' : '꺼짐'}, ${mode} (${minChars}자 이상, ` +
      `${voiceGate ? `음성 판정 점수 ${voiceThreshold} 이상만` : '음성 판정 없이'} 가로챔, 모델 ${model})`,
  }
}

export const registerTransprompt: Register = (on, options) => {
  const minChars = Number(options.transpromptMinChars ?? 200)
  const model = String(options.transpromptModel ?? 'sonnet')
  const voiceGate = options.transpromptVoiceGate !== false
  const voiceThreshold = Number(options.transpromptVoiceThreshold ?? 2)
  const auto = options.transpromptAuto !== false
  const settings: Settings = { minChars, model, voiceGate, voiceThreshold, auto }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'transprompt',
      description: '음성 프롬프트 구조화: on | off | auto | review | status | why, 또는 바로 구조화할 내용',
      argumentHint: 'on | off | auto | review | status | why | [구조화할 내용]',
    })

    return next(e)
  })

  // 짧은 /transprompt는 세션이 돌아야 등록되어, Desktop에서는 새 세션 첫 메시지의 자동완성에 안 뜬다.
  // skills/transprompt가 디스크에서 바로 보이는 /gudals:transprompt를 만들고, 그 실행도 여기서 받는다.
  on('command.run', { command: 'transprompt' }, async ($, e) => runCommand($, e.args, settings))
  on('command.run', { command: 'gudals:transprompt' }, async ($, e) => runCommand($, e.args, settings))

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
    if (!isPersonTyped || e.isMeta || e.attachments?.length) {
      return next(e)
    }
    lastEdits = typedEdits
    if (await read($, bypassNext)) {
      await update($, bypassNext, () => false)
      return next(e)
    }
    if (!(await isEnabled($))) {
      lastSkip = '판정 안 함: transprompt가 꺼져 있습니다.'
      return next(e)
    }
    // 스킬을 부른 뒤 받아쓴 내용은 스킬 이름 뒤의 내용만 판정한다. 내장 명령은 drop해도 이미 돌았으므로 건드리지 않는다.
    const command = e.command?.name
    if (command !== undefined && !(await isSkillCommand($, command))) {
      lastSkip = `판정 안 함: /${command}는 내장 명령입니다.`
      return next(e)
    }
    const body = e.command ? e.command.args : e.text
    const length = body.trim().length
    if (length < minChars) {
      lastSkip = `판정 안 함: ${length}자로 최소 ${minChars}자보다 짧습니다.`
      return next(e)
    }
    lastSkip = undefined
    lastVerdict = judgeVoice(body, typedEdits, voiceThreshold)
    if (voiceGate && !lastVerdict.isVoice) {
      return next(e)
    }

    // 자동 모드는 사람을 기다리지 않으므로 패널이 입력 포커스를 가져가지 않는다. 진행을 보여 주고 취소할 길만 남긴다.
    if (await isAuto($, settings)) {
      void structure($, body, model, true, command)
      void $.ui.open({ id: PANE, title: TITLE })

      return { drop: 'transprompt: 구조화해서 바로 보냅니다' }
    }

    void structure($, body, model, false, command)
    void $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })

    return { drop: 'transprompt: 구조화한 뒤 승인을 받아 보냅니다' }
  }).catch(($, e, next) => next(e)) // 훅이 실패하면 프롬프트를 잃지 않고 그대로 보낸다.

  on('ui.close', { id: PANE }, async ($, e, next) => {
    // 사람이 Esc나 닫기로 패널을 닫으면 원문을 프롬프트 창으로 돌려놓는다.
    if (e.origin.kind === 'person') {
      const current = await read($, draft)
      inFlight?.abort()
      inFlight = undefined
      stopTicker()
      $.ui.status(undefined)
      await update($, draft, () => null)
      if (current) {
        await $.prompt.fill({ text: withCommand(current.raw, current.command) })
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

    // 패널은 통째로 스크롤되므로, 버튼은 미리보기 위에 둬야 긴 구조화본에도 화면 안에 남는다.
    if (current.phase === 'structuring') {
      const seconds = Math.max(0, Math.round(((await $.clock.now()) - current.startedAt) / 1000))

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text color="warning" weight="semibold">구조화 중</Text>
            <Text dimColor size="caption">
              {current.raw.length}자 · {seconds}초 경과 · {model}
              {current.command ? ` · /${current.command}에 넘김` : ''}
              {current.auto ? ' · 끝나면 바로 보냅니다' : ''}
            </Text>
          </Box>
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <Button key="raw" hotkey="3" plain dimColor label="원문 그대로 보내기" onPress={() => send($, current.raw, current.command)} />
            <Button key="cancel" hotkey="5" plain dimColor label="취소 (원문을 입력창으로)" onPress={() => toPrompt($, current.raw, false, current.command)} />
          </Box>
          <Box borderStyle="round" paddingX={1}>
            <Text dimColor>{excerpt(current.raw)}</Text>
          </Box>
        </Box>
      )
    }

    if (current.phase === 'failed') {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text color="error" weight="semibold">구조화 실패</Text>
            <Text dimColor size="caption">{current.reason}</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="retry" hotkey="4" variant="primary" autoFocus label="다시 구조화" onPress={() => structure($, current.raw, model, false, current.command)} />
            <Button key="raw" hotkey="3" label="원문 그대로 보내기" onPress={() => send($, current.raw, current.command)} />
          </Box>
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <Button key="cancel" hotkey="5" plain dimColor label="취소 (원문을 입력창으로)" onPress={() => toPrompt($, current.raw, false, current.command)} />
          </Box>
          <Box borderStyle="round" paddingX={1}>
            <Text dimColor>{excerpt(current.raw)}</Text>
          </Box>
        </Box>
      )
    }

    const verdict = voiceGate && lastVerdict ? ` · 음성 ${lastVerdict.score}점` : ''

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text color="suggestion" weight="semibold">검토 대기</Text>
          <Text dimColor size="caption">
            원문 {current.raw.length}자 → 구조화 {current.structured.length}자{verdict}
            {current.command ? ` · /${current.command}에 넘김` : ''}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="approve" hotkey="1" variant="primary" autoFocus label="승인하고 보내기" onPress={() => send($, current.structured, current.command)} />
          <Button key="edit" hotkey="2" label="입력창에서 고치기" onPress={() => toPrompt($, current.structured, true, current.command)} />
        </Box>
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Button key="raw" hotkey="3" plain dimColor label="원문 그대로" onPress={() => send($, current.raw, current.command)} />
          <Button key="retry" hotkey="4" plain dimColor label="다시 구조화" onPress={() => structure($, current.raw, model, false, current.command)} />
          <Button key="cancel" hotkey="5" plain dimColor label="취소" onPress={() => toPrompt($, current.raw, false, current.command)} />
        </Box>
        <Box flexDirection="row" gap={2}>
          <Button key="tab-structured" hotkey="s" plain dimColor={view !== 'structured'} label="구조화본" onPress={() => showView($, 'structured')} />
          <Button key="tab-raw" hotkey="r" plain dimColor={view !== 'raw'} label="원문" onPress={() => showView($, 'raw')} />
        </Box>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          {view === 'structured' ? (
            <Markdown key="preview" text={current.structured} />
          ) : (
            <Text>{current.raw}</Text>
          )}
        </Box>
        {voiceGate && <Text dimColor size="caption">{describeVerdict(lastVerdict)}</Text>}
      </Box>
    )
  })
}
