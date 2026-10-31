import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildIslands, changedIslands, mergeSessions, parseSessionList, savedOutputPath } from '../hooks/monitor/register'
import { DASH_TILE_PX, dashTilePiece, escapeHtml, glintPiece, gutterPiece, gutterWidth, lineCount } from '../hooks/monitor/pieces'
import type { MonitorRow } from '../types'

const MIN = 60_000
const NOW = Date.UTC(2026, 9, 22, 14, 0)

const row = (id: string, rest: Partial<MonitorRow>): MonitorRow => ({
  id, title: id, cwd: 'C:/w/app', isRunning: false, lastActivityAt: NOW - 5 * MIN, state: 'idle', since: NOW - 5 * MIN, warnings: [], ...rest,
})

test('islands rise by their most pressing session, then by the latest activity', () => {
  const islands = buildIslands(
    [
      row('old', { cwd: 'C:/w/old', lastActivityAt: NOW - 200 * MIN, since: NOW - 200 * MIN }),
      row('calm', { cwd: 'C:/w/calm', lastActivityAt: NOW - 30 * MIN, since: NOW - 30 * MIN }),
      row('busy', { cwd: 'C:/w/busy', state: 'working' }),
      // Stopped three hours ago, but its two shells still run: not live, and not dormant either.
      row('bg', { cwd: 'C:/w/bg', state: 'background', lastActivityAt: NOW - 180 * MIN, since: NOW - 180 * MIN, tasks: [
        { kind: 'monitor', label: 'eval.log', startedAt: NOW - 170 * MIN },
        { kind: 'command', label: 'npm run eval', startedAt: NOW - 175 * MIN },
      ] }),
      row('ask', { cwd: 'C:/w/ask', state: 'waiting', since: NOW - 3 * MIN }),
      row('tree', { cwd: 'C:/w/ask/.claude/worktrees/spike', parentId: 'ask' }),
    ],
    NOW,
  )
  expect(islands.map(one => [one.name, one.tier])).toEqual([
    ['ask', 'hot'],
    ['busy', 'live'],
    ['calm', 'warm'],
    ['bg', 'warm'],
    ['old', 'cold'],
  ])
  expect(islands[0]?.why).toBe('나를 기다림 · 3분째')
  expect(islands[0]?.rows.length).toBe(2)
  expect(islands[1]?.why).toBe('실행 중')
  expect(islands[3]?.why).toBe('백그라운드 2')
})

test('a prompt a hook dropped lifts its island and says HOOK', () => {
  const islands = buildIslands([row('drop', { cwd: 'C:/w/t', state: 'waiting', waitKind: 'blocked', waitText: 'transprompt: 승인 대기' })], NOW)
  expect([islands[0]?.tier, islands[0]?.best, islands[0]?.why]).toEqual(['hot', 'blocked', 'HOOK'])
})

test("a sub-session lives in the island of the session at the top of its line, wherever its folder is", () => {
  const islands = buildIslands(
    [
      row('top', { cwd: 'C:/w/lecture-artifact' }),
      row('sub', { cwd: 'C:/w/lecture-artifact/VLSI', parentId: 'top' }),
      row('subsub', { cwd: 'C:/elsewhere/tool', parentId: 'sub' }),
      // A parent the list does not hold: the session keeps its own folder.
      row('orphan', { cwd: 'C:/w/other', parentId: 'gone' }),
    ],
    NOW,
  )
  expect(islands.map(one => [one.name, one.rows.length]).sort()).toEqual([
    ['lecture-artifact', 3],
    ['other', 1],
  ])
})

test('sessions started without a folder share one island', () => {
  const islands = buildIslands([row('a', { cwd: 'C:/d/scratch-2026-10-22-aaaaaa' }), row('b', { cwd: 'C:/d/scratch-2026-10-22-bbbbbb' })], NOW)
  expect(islands.map(one => [one.name, one.rows.length])).toEqual([['폴더 없음', 2]])
})

test('only a state change marks its island, with the colour of the new state', () => {
  const before = [row('a', {}), row('b', { cwd: 'C:/w/b', state: 'working' })]
  const after = [row('a', { state: 'waiting', title: 'renamed' }), row('b', { cwd: 'C:/w/b', state: 'background', activity: 'new line' }), row('c', { cwd: 'C:/w/c' })]
  // b stopped and left a shell running: that is a change too.
  expect([...changedIslands(before, after)]).toEqual([
    ['C:/w/app', 'waiting'],
    ['C:/w/b', 'other'],
    ['C:/w/c', 'other'],
  ])
})

test('pictures: the gutter draws a child behind the dashed teal rail, and dots move', () => {
  expect(gutterPiece('paused', 0).svg).not.toContain('stroke-dasharray')
  const child = gutterPiece('working', 2)
  expect(child.width).toBe(gutterWidth(2))
  expect(child.svg).toContain('stroke-dasharray="3 3"')
  expect(child.svg).toContain('<animate attributeName="opacity"')
  expect(gutterPiece('waiting', 0).svg).toContain('<animate attributeName="r"')
  expect(glintPiece().svg).toContain('<animate attributeName="x"')
  // Tile 2 of 4 carries the glint in the second quarter of the cycle.
  expect(glintPiece(1, 4).svg).toContain('keyTimes="0;0.2500;0.5000;1"')
  // A dash tile holds whole dashes, so tiles side by side read as one line.
  expect(DASH_TILE_PX % 7).toBe(0)
  expect(dashTilePiece('#fff').svg).toContain('stroke-dasharray="4 3"')
  expect(escapeHtml(`'`)).toBe('&#39;')
  expect(lineCount('가'.repeat(30), 300, 12)).toBe(2)
})

const PANE = {
  plugin: 'gudals',
  component: 'Pane',
  requestId: 'monitor',
  surface: 'desktop',
  props: { title: 'Monitor', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const ID = {
  ask: 'local_11111111-1111-4111-8111-111111111111',
  vlsi: 'local_22222222-2222-4222-8222-222222222222',
  parent: 'local_33333333-3333-4333-8333-333333333333',
  spike: 'local_44444444-4444-4444-8444-444444444444',
  lms: 'local_55555555-5555-4555-8555-555555555555',
  old: 'local_66666666-6666-4666-8666-666666666666',
}

const wrapUp = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        name: 'mcp__ccd_turn__wrap_up',
        input: { recap: '시안 세 개를 그렸습니다.', ask: '어느 시안으로 갈까요?', blocked: true, actions: [{ label: 'A + C피크', message: 'A + C피크로 가자.' }, { label: '다른 걸로' }] },
      },
    ],
  },
})

const RUN = `"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/x.sh && eval 'npm run eval:run -- --batch evM2 > log 2>&1' < /dev/null"`

// One board's worth of sessions and the machine around them; `vlsi` lets a test move a session
// and change what its transcript shows; `stored` is what the store holds from the start.
function stage(on: On, vlsi: { running: boolean; events?: string; isAskClosed?: boolean; isSuggestion?: boolean }, stored?: Record<string, unknown>) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  const sent: { session: string; message: string }[] = []
  const opened: string[] = []
  const world = { titles: new Map<string, string>(), pinned: new Map<string, boolean>(), archived: new Set<string>(), calls: [] as string[] }
  on('command.register', () => ({ value: { command: 'monitor' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__gudals__monitor_snapshot' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.list', () => ({ value: [{ name: '1.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }, { name: '2.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] }))
  on('fs.read', (_, e) => ({
    value: String(e.path).endsWith('1.json')
      ? JSON.stringify({ pid: 1, hostSessionId: ID.ask, sessionId: 'cli-ask', cwd: 'C:\\d\\scratch-2026-10-22-77f361', status: 'idle' })
      : JSON.stringify({ pid: 2, hostSessionId: ID.parent, sessionId: 'cli-parent', cwd: 'C:\\w\\inquiry', status: 'idle' }),
  }))
  // Answering the box in the session moves its transcript on; the radar reads it again.
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: vlsi.isAskClosed ? 6 : 5, isLink: false } }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'cmd.exe') opened.push(String(argv[4]))
    const script = String(argv[4] ?? '')
    const stdout = script.includes('Select-String')
      ? script.includes('cli-ask') && !vlsi.isAskClosed ? (vlsi.isSuggestion ? wrapUp.replace('"blocked":true,', '') : wrapUp) : ''
      : JSON.stringify([
          { p: 1, pp: 0, n: 'claude.exe' },
          { p: 2, pp: 0, n: 'claude.exe' },
          { p: 9, pp: 2, n: 'bash.exe', c: RUN, t: new Date(NOW - 20 * MIN).toISOString() },
        ])
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The session menu's calls arrive as tool calls carrying the person's press as consent.
  on('tool.call', (_, e) => {
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    if (!/^mcp__ccd_(session_mgmt|sidebar)__/.test(tool)) return { deny: `unexpected ${tool}` }
    const id = String(args.session_id)
    const name = tool.replace(/^mcp__[a-z_]+?__(?=[a-z_]+$)/, '').replace(/^ccd_(session_mgmt|sidebar)__/, '')
    if (!/^(Rename|Pin|Unpin|Archive) my session /.test(String(args.consent ?? ''))) return { deny: 'no consent' }
    if (name === 'set_session_title') world.titles.set(id, String(args.title))
    if (name === 'set_pinned') world.pinned.set(id, args.pinned === true)
    if (name === 'archive_session') world.archived.add(id)
    world.calls.push(`${name}:${id}`)
    return { result: 'ok' }
  })
  on('mcp.call', (_, e) => {
    if (e.tool === 'send_message') {
      sent.push({ session: String(e.args?.session_id), message: String(e.args?.message) })
      return { value: { content: [{ type: 'text', text: 'delivered' }], isError: false } }
    }
    const iso = (min: number) => new Date(NOW - min * MIN).toISOString()
    const sessions = [
      { sessionId: ID.ask, title: 'Gudals transprompt', cwd: 'C:\\d\\scratch-2026-10-22-77f361', isRunning: false, lastActivityAt: iso(2) },
      { sessionId: ID.vlsi, title: 'VLSI 교안', cwd: 'C:\\w\\lecture-artifact', isRunning: vlsi.running, lastActivityAt: iso(1) },
      { sessionId: ID.parent, title: 'AI 협업', cwd: 'C:\\w\\inquiry', isRunning: false, lastActivityAt: iso(9) },
      { sessionId: ID.spike, title: '국내 웹 탐색', cwd: 'C:\\w\\inquiry\\.claude\\worktrees\\kr-web-spike', startedBy: ID.parent, isRunning: false, lastActivityAt: iso(29) },
      { sessionId: ID.lms, title: 'LMS management', cwd: 'C:\\h\\HY-LMS', isRunning: false, lastActivityAt: iso(173) },
      { sessionId: ID.old, title: '옛 메모', cwd: 'C:\\h\\old-notes', isRunning: false, lastActivityAt: iso(5 * 24 * 60) },
    ]
    const isVlsi = e.args?.session_id === ID.vlsi
    const listed = sessions
      .filter(one => !world.archived.has(one.sessionId))
      .map(one => ({ ...one, title: world.titles.get(one.sessionId) ?? one.title, pinned: world.pinned.get(one.sessionId) ?? false }))
    const text =
      e.tool === 'list_sessions'
        ? JSON.stringify(listed)
        : `Session "s" (${isVlsi && vlsi.running ? 'running' : 'idle'}) — showing 1 of 1 messages\n\n${(isVlsi && vlsi.events) || '[assistant] 파일을 읽는 중입니다.'}`
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  return { sent, opened, clock, world }
}

test('a session menu renames, pins and archives through the app, and never deletes', async ($, on) => {
  const { world } = stage(on, { running: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const ui = await $.ui.mount(PANE)
  const press = (key: string) => $.ui.press({ plugin: 'gudals', key })

  // ⋯ opens the menu under the row: rename, pin, archive and close; no delete.
  expect(await ui.find({ key: `do-rename:${ID.parent}` })).toBe(undefined)
  await press(`menu:${ID.parent}`)
  expect((await ui.find({ key: `do-rename:${ID.parent}` }))?.text).toBe('이름 변경')
  expect((await ui.find({ key: `do-pin:${ID.parent}` }))?.text).toBe('고정')
  expect((await ui.find({ key: `do-archive:${ID.parent}` }))?.text).toBe('보관')
  expect((await ui.findAll({ type: 'Button', text: /삭제/ })).length).toBe(0)

  // Rename where it stands.
  await press(`do-rename:${ID.parent}`)
  await ui.input({ key: `title:${ID.parent}`, text: 'AI 협업 (정리)' })
  expect((await ui.find({ key: `open:${ID.parent}` }))?.text).toBe('AI 협업 (정리)')
  expect(await ui.find({ key: `do-rename:${ID.parent}` })).toBe(undefined)

  // Pin, and the menu offers to unpin.
  await press(`menu:${ID.parent}`)
  await press(`do-pin:${ID.parent}`)
  await press(`menu:${ID.parent}`)
  expect((await ui.find({ key: `do-pin:${ID.parent}` }))?.text).toBe('고정 해제')

  // A pinned session carries the tag.
  expect((await ui.findAll({ type: 'Svg' })).some(one => String(one.props.alt) === '고정')).toBe(true)

  // A name typed and left: pressing anything else saves it, as Enter would. (The menu is still open.)
  await press(`do-rename:${ID.parent}`)
  await ui.input({ key: `title:${ID.parent}`, text: 'AI 협업 (최종)', kind: 'change' })
  await press(`menu:${ID.vlsi}`)
  expect((await ui.find({ key: `open:${ID.parent}` }))?.text).toBe('AI 협업 (최종)')
  // Its own cancel drops it.
  await press(`menu:${ID.parent}`)
  await press(`do-rename:${ID.parent}`)
  await ui.input({ key: `title:${ID.parent}`, text: '버릴 이름', kind: 'change' })
  await press(`title-cancel:${ID.parent}`)
  expect((await ui.find({ key: `open:${ID.parent}` }))?.text).toBe('AI 협업 (최종)')

  // Archive (the menu is still open after cancelling): the session leaves the board.
  await press(`do-archive:${ID.parent}`)
  expect(await ui.find({ key: `open:${ID.parent}` })).toBe(undefined)
  expect(world.calls).toEqual([`set_session_title:${ID.parent}`, `set_pinned:${ID.parent}`, `set_session_title:${ID.parent}`, `archive_session:${ID.parent}`])
  await ui.unmount()
})

test('the board: islands by tier, answers inline, dormant islands folded, titles open sessions', async ($, on) => {
  const { sent, opened } = stage(on, { running: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const ui = await $.ui.mount(PANE)
  const text = async (pattern: RegExp | string) => (await ui.find({ type: 'Text', text: pattern }))?.text
  const pictured = async (alt: string) => (await ui.findAll({ type: 'Svg' })).some(one => String(one.props.alt) === alt)
  const press = (key: string) => $.ui.press({ plugin: 'gudals', key })

  // The header's counts are filters.
  expect((await ui.find({ key: 'filter:wait' }))?.text).toBe('대기 1')
  // AI 협업 stopped and only its shell runs on: that is not running.
  expect((await ui.find({ key: 'filter:work' }))?.text).toBe('실행 1')
  // Each session's age is its own: the last activity, never the time the radar looked.
  expect(await text('29분')).toBe('29분')
  expect(await text('9분')).toBe('9분')
  // One unit only: 2 hours 53 minutes reads "2시간".
  await press(`fold:C:\\h\\HY-LMS`)
  expect(await text(/^2시간$/)).toBe('2시간')
  expect(await ui.find({ type: 'Text', text: /시간 \d+분/ })).toBe(undefined)
  await press(`fold:C:\\h\\HY-LMS`)
  expect(await text('나를 기다림 · 2분째')).toBe('나를 기다림 · 2분째')
  expect(await text('어느 시안으로 갈까요?')).toBe('어느 시안으로 갈까요?')
  // The waiting session's choices are numbered buttons. Nothing has a shortcut: the desktop passes
  // no key to a pane's buttons.
  const first = await ui.find({ key: `answer:${ID.ask}:0` })
  expect(first?.text).toBe('1 A + C피크')
  expect((await ui.findAll({ type: 'Button' })).every(one => one.props.hotkey === undefined)).toBe(true)
  // A popped-out window is a button away.
  expect((await ui.find({ key: 'popout' }))?.text).toBe('창으로')
  // The shell AI 협업 left running shows under it, with how long, and marks the island in teal as
  // background: a hollow dot, no sweep, no "실행 중".
  expect(await text('npm run eval:run -- --batch evM2')).toBe('npm run eval:run -- --batch evM2')
  expect(await text('20분째')).toBe('20분째')
  expect(await text('백그라운드 1')).toBe('백그라운드 1')
  expect(await pictured('백그라운드')).toBe(true)
  // One working island (lecture-artifact) carries the glint, in its row of tiles; background does not.
  expect((await ui.findAll({ type: 'Svg' })).filter(one => String(one.props.alt) === '진행 중').length).toBe(4)
  expect(await pictured('kr-web-spike')).toBe(true)
  // Every picture names itself: one with an empty alt is not drawn.
  expect((await ui.findAll({ type: 'Svg' })).every(one => String(one.props.alt).length > 0)).toBe(true)
  // HY-LMS has been quiet for nearly three hours: below the line, one chip with its session count.
  expect(await text('휴면 · 2시간 이상')).toBe('휴면 · 2시간 이상')
  expect((await ui.find({ key: 'fold:C:\\h\\HY-LMS' }))?.text).toBe('HY-LMS 1')
  expect(await ui.find({ key: `open:${ID.lms}` })).toBe(undefined)
  // A working session's activity sits on its title's line: no line of its own under it.
  expect(await ui.find({ key: `act:${ID.vlsi}` })).toBe(undefined)
  expect((await ui.findAll({ type: 'Button', text: '열기' })).length).toBe(0)

  // An answer button sends what the button says, without leaving the radar, and the buttons give
  // way to a note that it went.
  await $.ui.press({ plugin: 'gudals', key: `answer:${ID.ask}:0` })
  expect(sent).toEqual([{ session: ID.ask, message: 'A + C피크로 가자.' }])
  expect(opened).toEqual([])
  expect(await text('"A + C피크" 보냄 · 세션의 답을 기다리는 중')).toBe('"A + C피크" 보냄 · 세션의 답을 기다리는 중')
  expect(await ui.find({ key: `answer:${ID.ask}:0` })).toBe(undefined)

  await $.ui.press({ plugin: 'gudals', key: `open:${ID.spike}` })
  expect(opened.at(-1)).toBe(`claude://claude.ai/epitaxy/${ID.spike}`)

  // + beside an island's name opens the new-chat screen in its folder; the folder-less island has none.
  await $.ui.press({ plugin: 'gudals', key: 'new:C:\\w\\inquiry' })
  expect(opened.at(-1)).toBe(`claude://code/new?folder=${encodeURIComponent('C:\\w\\inquiry')}`)
  expect(await ui.find({ key: 'new:폴더 없음' })).toBe(undefined)

  // Unfolding a dormant island shows its tree.
  expect(await ui.find({ key: `node:${ID.lms}` })).toBe(undefined)
  await $.ui.press({ plugin: 'gudals', key: 'fold:C:\\h\\HY-LMS' })
  expect((await ui.find({ key: `node:${ID.lms}` })) !== undefined).toBe(true)
  await ui.unmount()
})

test('islands framed as a group: made by picking two, renamed, added to, left and undone', async ($, on) => {
  stage(on, { running: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const ui = await $.ui.mount(PANE)
  const press = (key: string) => $.ui.press({ plugin: 'gudals', key })
  const LEC = 'C:\\w\\lecture-artifact'
  const INQ = 'C:\\w\\inquiry'

  // 묶기 on one island, then 합치기 on another: a frame named after the first.
  await press(`group:${LEC}`)
  expect((await ui.find({ key: `group:${LEC}` }))?.text).toBe('취소')
  expect((await ui.find({ key: `join:${INQ}` }))?.text).toBe('합치기')
  await press(`join:${INQ}`)
  const name = await ui.find({ type: 'Button', text: 'lecture-artifact 외' })
  expect(name !== undefined).toBe(true)
  const id = String(name?.key).replace(/^rename:/, '')
  expect((await ui.find({ type: 'Text', text: '섬 2 · 세션 3' }))?.text).toBe('섬 2 · 세션 3')
  // Inside, each island keeps its own card and can leave.
  expect((await ui.find({ key: `leave:${LEC}` }))?.text).toBe('빼기')

  // The name, edited where it stands.
  await press(`rename:${id}`)
  await ui.input({ key: `name:${id}`, text: 'VLSI 강의' })
  expect((await ui.find({ key: `rename:${id}` }))?.text).toBe('VLSI 강의')

  // + 추가, then 넣기 on an island outside.
  const SCRATCH = '폴더 없음'
  await press(`add:${id}`)
  expect((await ui.find({ key: `join:${SCRATCH}` }))?.text).toBe('넣기')
  await press(`join:${SCRATCH}`)
  // Its one session waits, and stays in its island, in the frame.
  expect((await ui.find({ type: 'Text', text: /^섬 3 · / }))?.text).toBe('섬 3 · 세션 4')

  // 빼기 takes one out; 풀기 undoes the frame.
  await press(`leave:${SCRATCH}`)
  expect((await ui.find({ type: 'Text', text: /^섬 2 · / }))?.text).toBe('섬 2 · 세션 3')
  await press(`ungroup:${id}`)
  expect(await ui.find({ key: `rename:${id}` })).toBe(undefined)
  expect((await ui.find({ key: `group:${LEC}` }))?.text).toBe('묶기')
  await ui.unmount()
})

test('a waiting session stays in its island, which pulses until answered; any island folds to its title and back', async ($, on) => {
  stage(on, { running: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const ui = await $.ui.mount(PANE)
  const press = (key: string) => $.ui.press({ plugin: 'gudals', key })
  // Four edges to a pulsing card.
  const pulses = async () => (await ui.findAll({ type: 'Svg' })).filter(one => String(one.props.alt) === '질문 깜빡임').length
  const LEC = String.raw`C:\w\lecture-artifact`
  const SCRATCH = '폴더 없음'

  // In a group, the question stays where its island is; the island pulses, the frame does not.
  await press(`group:${LEC}`)
  await press(`join:${SCRATCH}`)
  expect(await ui.find({ key: `place:ask:${ID.ask}` })).toBe(undefined)
  expect((await ui.findAll({ key: `node:${ID.ask}` })).length).toBe(1)
  expect((await ui.find({ key: `answer:${ID.ask}:0` }))?.text).toBe('1 A + C피크')
  expect(await pulses()).toBe(4)

  // An active island folds to its title and back; folded, it still pulses.
  expect((await ui.find({ key: `fold-head:${SCRATCH}` }))?.text).toBe('▾ 폴더 없음')
  await press(`fold-head:${SCRATCH}`)
  expect(await ui.find({ key: `node:${ID.ask}` })).toBe(undefined)
  expect((await ui.find({ key: `fold-head:${SCRATCH}` }))?.text).toBe('▸ 폴더 없음')
  expect(await pulses()).toBe(4)
  // The fold holds through a refresh.
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  expect(await ui.find({ key: `node:${ID.ask}` })).toBe(undefined)
  await press(`fold-head:${SCRATCH}`)
  expect((await ui.findAll({ key: `node:${ID.ask}` })).length).toBe(1)

  // Answered and closed, the pulse stops.
  await press(`dismiss:${ID.ask}`)
  expect(await pulses()).toBe(0)
  await ui.unmount()
})

test('dormant islands sit on two shelves, and in a group they keep a title-only card', async ($, on) => {
  stage(on, { running: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const ui = await $.ui.mount(PANE)
  const press = (key: string) => $.ui.press({ plugin: 'gudals', key })
  const text = async (pattern: RegExp | string) => (await ui.find({ type: 'Text', text: pattern }))?.text
  const LEC = 'C:\\w\\lecture-artifact'
  const LMS = 'C:\\h\\HY-LMS'
  const OLD = 'C:\\h\\old-notes'

  // Quiet for three hours, then for five days: the five-day one on the lower shelf.
  expect(await text('휴면 · 2시간 이상')).toBe('휴면 · 2시간 이상')
  expect(await text('휴면 · 3일 이상')).toBe('휴면 · 3일 이상')
  const keys = (await ui.findAll({})).map(one => String(one.key ?? ''))
  expect(keys.indexOf(`fold:${LMS}`) >= 0).toBe(true)
  expect(keys.indexOf(`fold:${LMS}`) < keys.indexOf(`fold:${OLD}`)).toBe(true)

  // In a group, the dormant island keeps its card with only its title; the title opens and folds it.
  await press(`fold:${LMS}`)
  await press(`group:${LEC}`)
  await press(`join:${LMS}`)
  expect((await ui.find({ type: 'Text', text: /^섬 2 · / }))?.text).toBe('섬 2 · 세션 2')
  expect((await ui.find({ key: `node:${ID.lms}` })) !== undefined).toBe(true)
  await press(`fold-head:${LMS}`)
  expect(await ui.find({ key: `node:${ID.lms}` })).toBe(undefined)
  expect(await ui.find({ key: `fold:${LMS}` })).toBe(undefined)
  expect((await ui.find({ key: `fold-head:${LMS}` }))?.text).toBe('▸ HY-LMS')
  await press(`fold-head:${LMS}`)
  expect((await ui.find({ key: `node:${ID.lms}` })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a state change leaves an unseen mark until it is looked at', async ($, on) => {
  const vlsi = { running: true }
  stage(on, vlsi)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  vlsi.running = false
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'filter:new' }))?.text).toBe('새 변경 1')
  // The changed island carries the mark on its corner.
  expect((await ui.findAll({ type: 'Svg' })).some(one => String(one.props.alt) === '새 변경')).toBe(true)
  await $.ui.press({ plugin: 'gudals', key: 'seen' })
  // A count of none stays, dimmed, and cannot be chosen.
  expect(await ui.find({ key: 'filter:new' })).toBe(undefined)
  expect((await ui.findAll({ type: 'Svg' })).some(one => String(one.props.alt) === '새 변경 0')).toBe(true)
  await ui.unmount()
})

test('in the folder-less island a change is marked on its own session, and opening it clears that one', async ($, on) => {
  const world: { running: boolean; isAskClosed?: boolean } = { running: true }
  const { clock } = stage(on, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  world.isAskClosed = true
  // A changed transcript is scanned again at most every 10 seconds.
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const early = await $.ui.mount(PANE)
  expect(await early.find({ key: 'filter:new' })).toBe(undefined)
  await early.unmount()
  await clock.advance(10_000)
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const ui = await $.ui.mount(PANE)
  const marks = async () => (await ui.findAll({ type: 'Svg' })).filter(one => String(one.props.alt) === '새 변경').length
  // The session's own mark, and its island's on the corner.
  expect((await ui.find({ key: 'filter:new' }))?.text).toBe('새 변경 1')
  expect(await marks()).toBe(2)
  await $.ui.press({ plugin: 'gudals', key: `open:${ID.ask}` })
  expect(await marks()).toBe(0)
  expect(await ui.find({ key: 'filter:new' })).toBe(undefined)
  await ui.unmount()
})

test("a working session's activity line follows its transcript on the next 3s refresh", async ($, on) => {
  const vlsi: { running: boolean; events?: string } = { running: true }
  const { clock } = stage(on, vlsi)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: '파일을 읽는 중입니다.' }))?.text).toBe('파일을 읽는 중입니다.')
  vlsi.events = '[assistant] 테스트를 돌려 볼게요.\n[assistant] (called Bash)'
  await clock.advance(3_100)
  expect((await ui.find({ type: 'Text', text: /명령 실행/ }))?.text).toBe('명령 실행 · 테스트를 돌려 볼게요.')
  await ui.unmount()
})

test('a question closed on the board stops waiting, through a refresh, and the filters follow', async ($, on) => {
  stage(on, { running: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const ui = await $.ui.mount(PANE)

  // Waiting: only the island with the waiting session.
  await $.ui.press({ plugin: 'gudals', key: 'filter:wait' })
  expect((await ui.find({ key: `open:${ID.ask}` })) !== undefined).toBe(true)
  expect(await ui.find({ key: `open:${ID.vlsi}` })).toBe(undefined)

  await $.ui.press({ plugin: 'gudals', key: `dismiss:${ID.ask}` })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  expect(await ui.find({ type: 'Text', text: '어느 시안으로 갈까요?' })).toBe(undefined)
  expect((await ui.findAll({ type: 'Svg' })).some(one => String(one.props.alt) === '대기 0')).toBe(true)
  // Nothing left under the filter: it says so and waits to be sent back.
  expect((await ui.find({ type: 'Text', text: '해당 세션 없음' }))?.text).toBe('해당 세션 없음')
  await $.ui.press({ plugin: 'gudals', key: 'toall' })
  expect((await ui.find({ key: `open:${ID.vlsi}` })) !== undefined).toBe(true)

  // Working: the islands with a working session, each tree whole.
  await $.ui.press({ plugin: 'gudals', key: 'filter:work' })
  expect((await ui.find({ key: `open:${ID.vlsi}` })) !== undefined).toBe(true)
  expect(await ui.find({ key: `open:${ID.ask}` })).toBe(undefined)
  await $.ui.press({ plugin: 'gudals', key: 'filter:all' })
  await ui.unmount()
})

test('a box that only suggests is a report: what was done and the suggestion, answerable, not lifted, closable', async ($, on) => {
  const { sent } = stage(on, { running: true, isSuggestion: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const ui = await $.ui.mount(PANE)

  // Nothing waits: the header counts no waiting session, and the session's card shows its report.
  expect((await ui.findAll({ type: 'Svg' })).some(one => String(one.props.alt) === '대기 0')).toBe(true)
  expect((await ui.find({ type: 'Text', text: '✓ 시안 세 개를 그렸습니다.' }))?.text).toBe('✓ 시안 세 개를 그렸습니다.')
  expect((await ui.find({ type: 'Text', text: '→ 어느 시안으로 갈까요?' }))?.text).toBe('→ 어느 시안으로 갈까요?')
  // The suggestion's buttons still answer it.
  await $.ui.press({ plugin: 'gudals', key: `answer:${ID.ask}:0` })
  expect(sent).toEqual([{ session: ID.ask, message: 'A + C피크로 가자.' }])

  // Closed, it stays closed through a refresh.
  await $.ui.press({ plugin: 'gudals', key: `dismiss:${ID.ask}` })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  expect(await ui.find({ type: 'Text', text: '✓ 시안 세 개를 그렸습니다.' })).toBe(undefined)
  expect((await ui.find({ key: `open:${ID.ask}` })) !== undefined).toBe(true)
  await ui.unmount()
})

test('the board keeps one order: groups by name, then the islands outside them by name, whatever the sessions do', async ($, on) => {
  const vlsi = { running: true }
  stage(on, vlsi, {
    monitorGroups: [
      { id: 'g-late', name: '나중 묶음', keys: [String.raw`C:\w\lecture-artifact`] },
      { id: 'g-alpha', name: 'Alpha', keys: [String.raw`C:\h\HY-LMS`] },
    ],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  const ui = await $.ui.mount(PANE)
  const order = async () => {
    const keys = (await ui.findAll({})).map(one => String(one.key ?? ''))
    const at = ['grp:g-alpha', 'grp:g-late', String.raw`new:C:\w\inquiry`, `open:${ID.ask}`].map(key => keys.indexOf(key))
    // Where each stands among the four: what a card holds moves the indices, not the order.
    return at.map(index => at.filter(other => other < index).length + (index < 0 ? -10 : 0))
  }
  const first = await order()
  // The groups first, Latin before Hangul, so the working session's group does not jump ahead;
  // the waiting session stays in its island, among the rest. (The tree lists the left column,
  // then the right.)
  expect(first.every(index => index >= 0)).toBe(true)
  expect(first[0]! < first[1]!).toBe(true)

  // The working session stops: nothing moves.
  vlsi.running = false
  await $.tool.call({ tool: 'mcp__gudals__monitor_snapshot' })
  expect(await order()).toEqual(first)
  await ui.unmount()
})

test('the session list reads past a note the app adds, and shows the app words when it is no list', () => {
  const list = JSON.stringify([{ sessionId: 'a', title: 'A' }], null, 2)
  expect(parseSessionList(list)).toEqual([{ sessionId: 'a', title: 'A' }])
  expect(parseSessionList(`${list}\n\nThis session runs elsewhere.`)).toEqual([{ sessionId: 'a', title: 'A' }])
  expect(parseSessionList('No other sessions found.')).toEqual([])
  expect(() => parseSessionList('Error: session manager is not ready')).toThrow('앱 응답이 목록이 아님 · Error: session manager is not ready')
  expect(() => parseSessionList('')).toThrow('(빈 응답)')
})

test('a list too long to hand back is read from the file it went to, and the latest sessions lead', () => {
  const path = String.raw`C:\Users\me\.claude\projects\p\s\tool-results\mcp-ccd_session_mgmt-list_sessions-17.txt`
  const note = `Error: result (50,908 characters across 1,349 lines) exceeds maximum allowed tokens. Output has been saved to ${path}.\nUse offset and limit to read it.`
  expect(savedOutputPath(note)).toBe(path)
  expect(savedOutputPath('[]')).toBe(undefined)

  const at = (min: number) => new Date(NOW - min * MIN).toISOString()
  const all = new Map([
    ['a', { sessionId: 'a', title: 'A old', lastActivityAt: at(300) }],
    ['b', { sessionId: 'b', title: 'B', lastActivityAt: at(500) }],
    ['gone', { sessionId: 'gone', title: 'archived', lastActivityAt: at(20) }],
  ])
  // Two listed of two asked: 'b' is older than the oldest listed, so it is only past the latest
  // few; 'gone' is newer, so it was archived.
  const merged = mergeSessions([{ sessionId: 'c', title: 'C', lastActivityAt: at(10) }, { sessionId: 'a', title: 'A new', lastActivityAt: at(30) }], all, 2)
  expect(merged.map(one => one.title)).toEqual(['C', 'A new', 'B'])
  // A session read once stays when it drops out of the latest few.
  expect(mergeSessions([{ sessionId: 'd', lastActivityAt: at(1) }, { sessionId: 'c', lastActivityAt: at(10) }], all, 2).map(one => one.sessionId)).toEqual(['d', 'c', 'a', 'b'])
  // Fewer listed than asked: the app listed every session, so the rest are gone.
  expect(mergeSessions([{ sessionId: 'd', lastActivityAt: at(1) }], all, 2).map(one => one.sessionId)).toEqual(['d'])
})
