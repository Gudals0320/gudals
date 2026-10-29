import { expect, test } from 'claude-code/testing'

import { parseEvents } from '../hooks/monitor/classify'
import { blockOf, choiceOf, projectDirName } from '../hooks/monitor/local'

const MIN = 60_000
const NOW = Date.UTC(2026, 9, 22, 13, 30)

// One assistant line of a transcript, ending the turn with a next-step box.
const wrapUpLine = (input: unknown) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__ccd_turn__wrap_up', input }] },
  })

test('choiceOf reads the question and the button labels', () => {
  const line = wrapUpLine({
    recap: '세 버전을 그렸습니다.',
    ask: '어느 버전으로 구현할까요?',
    actions: [{ label: '2 활동 섬', message: '2번으로 해 줘.' }, { label: '다른 버전' }, { action: 'commit' }],
  })
  expect(choiceOf(line)).toEqual({
    ask: '어느 버전으로 구현할까요?',
    recap: '세 버전을 그렸습니다.',
    options: ['2 활동 섬', '다른 버전', 'commit'],
    messages: ['2번으로 해 줘.', '다른 버전', 'commit'],
    isBlocked: false,
  })
  // Only a question can stop the work.
  expect(choiceOf(wrapUpLine({ recap: '막혔습니다.', ask: '어느 쪽?', blocked: true }))?.isBlocked).toBe(true)
  expect(choiceOf(wrapUpLine({ recap: '끝났습니다.', blocked: true }))?.isBlocked).toBe(false)
})

test('choiceOf reads a box with only a recap, and ignores other tools and other entries', () => {
  expect(choiceOf(wrapUpLine({ recap: '끝났습니다.' }))).toEqual({ ask: '', recap: '끝났습니다.', options: [], messages: [], isBlocked: false })
  expect(choiceOf(wrapUpLine({}))).toBe(undefined)
  expect(choiceOf(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }))).toBe(undefined)
  expect(choiceOf(JSON.stringify({ type: 'api-request-blob', message: {} }))).toBe(undefined)
  expect(choiceOf('not json')).toBe(undefined)
})

test('blockOf reads a prompt a hook dropped, and not a message that only quotes one', () => {
  const drop = JSON.stringify({
    type: 'system',
    subtype: 'informational',
    content: 'Prompt dropped by a hook: transprompt: 구조화한 뒤 승인을 받아 보냅니다',
    promptSubmitEnding: { ending: { kind: 'dropped_by_hook', reason: 'transprompt: 구조화한 뒤 승인을 받아 보냅니다' }, promptKept: false },
  })
  expect(blockOf(drop)).toEqual({ blocked: 'transprompt: 구조화한 뒤 승인을 받아 보냅니다' })
  const quoted = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: drop }] } })
  expect(blockOf(quoted)).toBe(undefined)
  // The scan's own filter: a quoted drop has its quotes escaped and does not match.
  expect(quoted.includes('"promptSubmitEnding":{')).toBe(false)
  expect(drop.includes('"type":"system","subtype":"informational"')).toBe(true)
})

test('projectDirName spells the folder as Claude Code does', () => {
  expect(projectDirName('C:\\Workspace\\inquiry')).toBe('C--Workspace-inquiry')
  expect(projectDirName('C:\\herdr\\HYU\\사랑의실천')).toBe('C--herdr-HYU------')
})

const header = (state: string) => `Session "s" (${state}) — showing 4 of 9 messages\n\n`

test('parseEvents flags a next-step box only after the person last wrote', () => {
  expect(parseEvents(`${header('idle')}[user] 해 줘\n[assistant] (called mcp__ccd_turn__wrap_up)\n[assistant] 그렸습니다.`).asked).toBe(true)
  expect(parseEvents(`${header('idle')}[assistant] (called mcp__ccd_turn__wrap_up)\n[assistant] 그렸습니다.\n[user] 3번으로`).asked).toBe(undefined)
  // A background task's notice is not the person writing.
  const notice = `${header('idle')}[user] 해 줘\n[assistant] (called mcp__ccd_turn__wrap_up)\n[assistant] 끝.\n[user] <task-notification>done</task-notification>\n[assistant] 확인했습니다.`
  expect(parseEvents(notice).asked).toBe(true)
})

test('an automatic note after a next-step box leaves the box waiting', () => {
  const text =
    `${header('idle')}[user] 해 줘\n[assistant] (called mcp__ccd_turn__wrap_up)\n[assistant] 끝났어요.\n[result] done\n` +
    `[user] <system-reminder>\nThe session you started finished a turn.\n</system-reminder>\n<side-sessions-event>none</side-sessions-event>\n` +
    `[assistant] 실험 세션의 보고가 왔어요.\n[result] done`
  expect(parseEvents(text).asked).toBe(true)
  expect(parseEvents(`${text}\n[user] 키 없이 시작해`).asked).toBe(undefined)
})
