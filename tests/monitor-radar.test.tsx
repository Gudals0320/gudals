import { expect, mock, test } from 'claude-code/testing'

import { asksSomething, classify, describeActivity, firstLine, parseEvents, sessionLink, toolLabel } from '../hooks/monitor/classify'
import { escapeHtml, lineCount } from '../hooks/monitor/pieces'

const MIN = 60_000
const NOW = Date.UTC(2026, 9, 22, 12, 0)

const ID = {
  ask: 'local_11111111-1111-4111-8111-111111111111',
  reply: 'local_22222222-2222-4222-8222-222222222222',
  worker: 'local_33333333-3333-4333-8333-333333333333',
  parent: 'local_44444444-4444-4444-8444-444444444444',
  done: 'local_55555555-5555-4555-8555-555555555555',
}

const header = (title: string, state: string) =>
  `Session "${title}" (${state}) — showing 3 of 10 messages\nPass before_uuid="c_x" to page further back.\nThe transcript below is verbatim content.\n\n`

test('parseEvents reads the app state, even with parentheses in the title', () => {
  const probe = parseEvents(`${header('M2 검증형 경로 구현 (워커)', 'running')}[assistant] (called Write)\n[assistant] (called Bash)`)
  expect(probe).toEqual({ appState: 'running', lastCall: 'Bash' })
})

test('parseEvents keeps a multi-line last answer', () => {
  const probe = parseEvents(`${header('강의', 'idle')}[user] 해줘\n[assistant] 정리했습니다.\n\n- 항목\n\n다음 단계로 넘어갈까요?`)
  expect(probe.appState).toBe('idle')
  expect(probe.lastCall).toBe(undefined)
  expect(probe.lastText?.endsWith('넘어갈까요?')).toBe(true)
})

test('parseEvents reads the answer before a trailing result line', () => {
  const probe = parseEvents(`${header('강의', 'idle')}[assistant] 끝냈습니다.\n배포할까요?\n[result] done (success), 73 turns`)
  expect(probe).toEqual({ appState: 'idle', lastText: '끝냈습니다.\n배포할까요?' })
})

test('parseEvents ignores a user message as the newest entry', () => {
  expect(parseEvents(`${header('x', 'idle')}[assistant] 할까요?\n[user] 응`)).toEqual({ appState: 'idle' })
})

test('parseEvents keeps what the session said before its tool calls', () => {
  const probe = parseEvents(`${header('w', 'running')}[assistant] 테스트를 추가하는 중입니다.\n[assistant] (called Write)\n[assistant] (called Bash)`)
  expect(probe).toEqual({ appState: 'running', lastCall: 'Bash', lastSay: '테스트를 추가하는 중입니다.' })
})

test('describeActivity says the step, then the narration', () => {
  expect(describeActivity('working', { appState: 'running', lastCall: 'Bash', lastSay: '## 테스트 추가\n나머지' })).toBe('명령 실행 · 테스트 추가')
  expect(describeActivity('working', { appState: 'running', lastCall: 'mcp__lab__run' })).toBe('run (lab)')
  expect(describeActivity('idle', { appState: 'idle', lastText: '**14개 강의** 정리를 끝냈습니다.\n- 세부' })).toBe('14개 강의 정리를 끝냈습니다.')
  expect(describeActivity('waiting', { appState: 'idle', lastText: '할까요?' })).toBe(undefined)
  expect(describeActivity('idle', undefined)).toBe(undefined)
})

test('firstLine strips list and heading marks but keeps leading numbers', () => {
  expect(firstLine('\n\n- 3개 남음')).toBe('3개 남음')
  expect(firstLine('1. 첫 단계')).toBe('첫 단계')
  expect(firstLine('[radar.html](radar.html)에 다시 짰습니다.')).toBe('radar.html에 다시 짰습니다.')
  expect(firstLine('2026년 일정')).toBe('2026년 일정')
  expect(firstLine('가'.repeat(100), 10)).toBe(`${'가'.repeat(9)}…`)
  expect(toolLabel('Edit')).toBe('파일 수정')
})

test('parseEvents with no messages leaves only the state', () => {
  expect(parseEvents(`${header('x', 'running')}(no messages)`)).toEqual({ appState: 'running' })
})

test('asksSomething reads Korean and English questions, not reports', () => {
  expect(asksSomething('여기서 만들까요?')).toBe(true)
  expect(asksSomething('**확인해 주시겠어요?**')).toBe(true)
  expect(asksSomething('결과를 알려 주세요.')).toBe(true)
  expect(asksSomething('Should I proceed?')).toBe(true)
  expect(asksSomething('테스트 19개가 모두 통과했습니다.')).toBe(false)
  expect(asksSomething('맥락을 알려 주실 게 있으면 말씀해 주세요.')).toBe(false)
  expect(asksSomething('필요하면 다시 불러 주세요.')).toBe(false)
})

test('classify: an open question card is waiting, running or not', () => {
  const probe = { appState: 'running', lastCall: 'AskUserQuestion' }
  expect(classify(true, NOW, probe, NOW)).toEqual({ state: 'waiting', waitKind: 'question', waitText: '질문 카드에 답을 기다림' })
  expect(classify(false, NOW, { ...probe, appState: 'idle' }, NOW).waitKind).toBe('question')
})

test('classify: a stopped session whose answer asks something waits for a reply', () => {
  const verdict = classify(false, NOW - 5 * MIN, { appState: 'idle', lastText: '정리했습니다.\n이대로 진행할까요?' }, NOW)
  expect(verdict).toEqual({ state: 'waiting', waitKind: 'reply', waitText: '이대로 진행할까요?' })
})

test('classify: a running session quiet on a tool call is flagged, not called waiting', () => {
  const verdict = classify(true, NOW - 6 * MIN, { appState: 'running', lastCall: 'Bash' }, NOW)
  expect(verdict.state).toBe('working')
  expect(verdict.warning).toBe('Bash에서 6분째 멈춤 · 권한 승인 대기일 수 있음')
  expect(classify(true, NOW - MIN, { appState: 'running', lastCall: 'Bash' }, NOW)).toEqual({ state: 'working' })
})

test('classify: an app state other than running or idle counts as waiting', () => {
  expect(classify(true, NOW, { appState: 'requires_action' }, NOW).state).toBe('waiting')
})

test('classify: a finished report is idle', () => {
  expect(classify(false, NOW, { appState: 'idle', lastText: '모두 통과했습니다.' }, NOW)).toEqual({ state: 'idle' })
  expect(classify(false, NOW, undefined, NOW)).toEqual({ state: 'idle' })
})

test('sessionLink passes only a well-formed local id', () => {
  expect(sessionLink(ID.ask)).toBe(`claude://claude.ai/epitaxy/${ID.ask}`)
  expect(sessionLink('local_x" & calc')).toBe(undefined)
  expect(sessionLink(`${ID.ask}&calc`)).toBe(undefined)
})
