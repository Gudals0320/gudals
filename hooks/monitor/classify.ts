import type { MonitorProbe, MonitorState, MonitorWaitKind } from '../../types'

export const MIN = 60_000

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

// Reads the text the app's transcript tool returns: a header naming the app's own
// state, then entries tagged `[assistant]`, `[user]`, `[result]`, most recent last.
export function parseEvents(text: string): MonitorProbe {
  const header = /^Session ".*" \(([^()]+)\)(?: —|\s*$)/m.exec(text)
  const probe: MonitorProbe = { appState: header?.[1]?.trim() ?? 'unknown' }
  const entries = text.split(/^(?=\[(?:assistant|user|result|system)\] )/m).filter(part => /^\[(assistant|user|result|system)\] /.test(part))
  // A next-step box is the turn's `wrap_up` call after the person's last message.
  const lastUser = entries.findLastIndex(part => part.startsWith('[user] ') && !isAutomated(part))
  if (entries.slice(lastUser + 1).some(part => /^\[assistant\] \(called mcp__ccd_turn__wrap_up\)/.test(part))) probe.asked = true
  // The newest assistant entry decides; a `[result]` or `[system]` line after it does not.
  const last = entries.findLast(part => !/^\[(result|system)\] /.test(part))
  if (!last?.startsWith('[assistant] ')) return probe
  const called = /^\[assistant\] \(called ([^)]+)\)\s*$/.exec(last.trim())
  if (!called?.[1]) {
    probe.lastText = textOf(last)
    return probe
  }
  probe.lastCall = called[1]
  // What the session last said before its tool calls: its own account of the step.
  const said = entries.findLast(part => part.startsWith('[assistant] ') && !/^\[assistant\] \(called /.test(part))
  if (said) probe.lastSay = textOf(said)
  return probe
}

// What the harness puts in a session's user turn on its own: a background task's notice, a
// note from a session it started, a system reminder. None of these is the person answering.
// They come wrapped in a tag, which a person's own message almost never starts with.
const isAutomated = (entry: string) => /^\[user\]\s*</.test(entry) || entry.includes('[SYSTEM NOTIFICATION')

const textOf = (entry: string) => entry.slice('[assistant] '.length).trim()

const TOOL_LABEL: Record<string, string> = {
  Bash: '명령 실행',
  PowerShell: '명령 실행',
  Edit: '파일 수정',
  Write: '파일 작성',
  NotebookEdit: '노트북 수정',
  Read: '파일 읽기',
  Grep: '코드 검색',
  Glob: '파일 찾기',
  WebSearch: '웹 검색',
  WebFetch: '웹 페이지 읽기',
  Agent: '서브에이전트 실행',
  Task: '서브에이전트 실행',
  Skill: '스킬 실행',
  Monitor: '백그라운드 작업 지켜보는 중',
  ScheduleWakeup: '다음 확인 예약',
  SendMessage: '다른 세션에 메시지',
  ToolSearch: '도구 불러오기',
  mcp__ccd_session__start_session: '새 세션 시작',
  mcp__ccd_turn__update_plan: '작업 목록 갱신',
  mcp__ccd_turn__wrap_up: '마무리 정리',
}

export function toolLabel(tool: string) {
  if (TOOL_LABEL[tool]) return TOOL_LABEL[tool]
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp ? `${mcp[2]} (${mcp[1]})` : tool
}

// The first line of an answer, without markdown marks, as a one-line summary.
export function firstLine(text: string, max = 80) {
  const line =
    text
      .split('\n')
      .map(one =>
        one
          .replace(/^\s*(#+|>|[-*]|\d+\.)\s+/, '')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/[*_`]+/g, '')
          .trim(),
      )
      .find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// What a session is doing (or last did), in one line, from its probe alone.
export function describeActivity(state: MonitorState, probe: MonitorProbe | undefined) {
  if (!probe || state === 'waiting') return undefined
  if (probe.lastCall) {
    const step = toolLabel(probe.lastCall)
    return probe.lastSay ? `${step} · ${firstLine(probe.lastSay, 60)}` : step
  }
  return probe.lastText ? firstLine(probe.lastText, 60) : undefined
}

export function lastLine(text: string) {
  return (
    text
      .trim()
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  )
}

// An answer counts as waiting when its last line asks something.
export function asksSomething(text: string) {
  const line = lastLine(text).replace(/[*_`]+/g, '')
  if (/[?？]\s*$/.test(line)) return true
  // "있으면 말씀해 주세요" offers, it does not ask: a conditional before the request rules it out.
  if (/(으면|하면|있으면|필요하면|싶으면)\s.*주세요[.!]?\s*$/.test(line)) return false
  return /(까요|할래요|될까요|주세요|주시겠어요)[.!]?\s*$/.test(line)
}

export type Verdict = { state: MonitorState; waitKind?: MonitorWaitKind; waitText?: string; warning?: string }

export function classify(isRunning: boolean, lastActivityAt: number, probe: MonitorProbe | undefined, at: number): Verdict {
  if (probe && probe.appState !== 'running' && probe.appState !== 'idle' && probe.appState !== 'unknown') {
    return { state: 'waiting', waitKind: 'app', waitText: `앱 상태: ${probe.appState}` }
  }
  if (probe?.lastCall && QUESTION_TOOLS.has(probe.lastCall)) {
    return {
      state: 'waiting',
      waitKind: 'question',
      waitText: probe.lastCall === 'ExitPlanMode' ? '계획 승인을 기다림' : '질문 카드에 답을 기다림',
    }
  }
  if (isRunning) {
    const quiet = at - lastActivityAt
    if (probe?.lastCall && quiet > 3 * MIN) {
      return { state: 'working', warning: `${probe.lastCall}에서 ${Math.round(quiet / MIN)}분째 멈춤 · 권한 승인 대기일 수 있음` }
    }
    if (quiet > 30 * MIN) return { state: 'working', warning: `${Math.round(quiet / MIN)}분째 움직임 없음` }
    return { state: 'working' }
  }
  if (probe?.lastText && asksSomething(probe.lastText)) {
    return { state: 'waiting', waitKind: 'reply', waitText: lastLine(probe.lastText) }
  }
  return { state: 'idle' }
}

// Only `claude://` links to a local session id ever reach the shell.
export function sessionLink(id: string) {
  return /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ? `claude://claude.ai/epitaxy/${id}`
    : undefined
}
