import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, On } from 'claude-code'

import type { MonitorFilter, MonitorFlash, MonitorObserved, MonitorProbe, MonitorRow, MonitorState, MonitorView } from '../../types'
import { MIN, classify, describeActivity, parseEvents, sessionLink } from './classify'
import { describeBackground, readChoice, readLocal } from './local'
import type { Block, Choice } from './local'
import { C, NODE_PX, badgePiece, cardCornerPiece, cardSidePiece, chipDotPiece, dashTilePiece, dotPiece, fade, fitText, frameLineSource, frameSide, glintPiece, gutterPiece, newDotPiece, pillPiece, railPiece, spacerPiece, stubPiece, worktreePiece } from './pieces'
import type { DotState, Frame, Piece } from './pieces'

// The monitor pulls: it reads the app's session list and each session's recent transcript when it
// refreshes. Other sessions run nothing and spend no tokens. Every session loads this plugin, so
// the monitor does nothing until it is opened (/gudals:monitor, or its pane drawn), and then only
// in that session. The board: repositories are islands, and a session's state lifts its island.
const PANE = 'monitor'
const TITLE = 'Monitor'
const SERVER = 'ccd_session_mgmt'
// The board reads everything this often; the costly process table is read less (local.ts).
const REFRESH_MS = 3_000
const PROBE_LIMIT = 20
const OBSERVED_KEY = 'monitorObserved'
const UNSEEN_KEY = 'monitorUnseen'
const OPEN_COLD_KEY = 'monitorOpenCold'
const DISMISSED_KEY = 'monitorDismissed'
// An island quiet this long folds into mini chips below the "휴면" line.
const COLD_MS = 120 * MIN
const FLASH_MS = 900
// A Box width in cells draws this many pixels to the cell (measured on the desktop).
const BOX_CELL_PX = 8
// A card's starting width in cells (about 300px, the prototype's minmax(300px, 1fr)): two fit a row
// from about 600px, and below one card's width a card shrinks to the pane.
const CARD_MIN_CELLS = 38
// Two columns of cards replace rows of two when they leave at least this much less empty room.
const MASONRY_GAIN_PX = 80
// Dash tiles in a dashed line: enough for a pane 2000px wide.
const DASH_TILES = 7
const BOARD_PAD = 8
// A folded dormant card: the prototype's opacity, at rest and under the pointer, and its padding.
const FADED = 0.6
const FADED_HOVER = 0.85
const FADED_PAD = 6
// A mini chip is at most this wide.
const CHIP_PX = 200
// How tall the desktop draws a plain button with a caption label.
const BUTTON_PX = 20
// Room kept above and right of every card for its unseen mark, which sits on the card's corner.
const BADGE_ROOM = { top: 10, right: 7 }
// The room above a card below the dormant line: the prototype's 6px gap there.
const CARD_GAP_COLD = 6

const view = atom({ plugin: 'gudals', key: 'monitorView' } as const, null as MonitorView | null)

type SessionJson = {
  sessionId: string
  title?: string
  cwd?: string
  startedBy?: string
  isRunning?: boolean
  lastActivityAt?: string
}

// A session whose last activity has not moved keeps the probe taken at that activity.
const probes = new Map<string, { lastActivityAt: number; probe: MonitorProbe }>()
// What the person did on the board, kept across refreshes: changes not yet looked at, dormant
// islands unfolded, flashes still running.
let unseen = new Set<string>()
let openCold = new Set<string>()
const flashes = new Map<string, { kind: MonitorFlash; until: number }>()
// Dev only: sample rows that show every part of the board, for checking the layout.
let isDemo = false
// Dev only: the pane's width in cells as last drawn.
let lastColumns = 0
// Set by the demo switch: the next refresh compares nothing.
let skipDiff = false
// Questions the person closed on the board, by session and question (waitKey). The app says
// nothing when a question is closed in the session itself, so this is the radar's own record.
let dismissed = new Set<string>()
// Answers sent from the board, by session: to which question (waitKey), the label, and when.
const sent = new Map<string, { key: string; label: string; at: number }>()
// How long a sent answer stands in for the buttons if the session stays on the question.
const SENT_MS = 10 * MIN
// The header filter; a reload starts from all.
let filter: MonitorFilter = 'all'
// Dev only: draw the board this many pixels wide, to check a narrow pane.
let forcedWidth: number | undefined

// One question of one session: a closed question stays closed until the session asks another.
export function waitKey(id: string, text: string | undefined, options: string[] | undefined) {
  let hash = 5381
  for (const ch of `${text ?? ''}\u0000${(options ?? []).join('\u0000')}`) hash = ((hash * 33) ^ (ch.codePointAt(0) ?? 0)) >>> 0
  return `${id}:${hash.toString(36)}`
}

const dotOf = (state: MonitorState): DotState =>
  state === 'waiting' ? 'waiting' : state === 'idle' ? 'paused' : state === 'background' ? 'background' : 'working'
// A row's dot: as its state's, but a prompt a hook dropped is its own, red.
const rowDot = (row: MonitorRow): DotState => (row.state === 'waiting' && row.waitKind === 'blocked' ? 'blocked' : dotOf(row.state))

function folderName(cwd: string) {
  const last = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  return last.startsWith('scratch-') ? FOLDERLESS : last
}

// A worktree session belongs to the repository its worktree was cut from.
const repoOf = (cwd: string) => cwd.split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0] ?? cwd

// Sessions started without a folder each get a scratch folder of their own; they share one island.
const FOLDERLESS = '폴더 없음'
const islandOf = (cwd: string) => (folderName(cwd) === FOLDERLESS ? FOLDERLESS : repoOf(cwd))

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// "지금", "N분", "N시간 M분", "N일", as the prototype's fmtAge.
function age(at: number, since: number | null) {
  if (since === null) return '–'
  const min = Math.floor((at - since) / MIN)
  if (min < 1) return '지금'
  if (min < 60) return `${min}분`
  if (min < 1440) return `${Math.floor(min / 60)}시간${min % 60 ? ` ${min % 60}분` : ''}`
  return `${Math.floor(min / 1440)}일`
}

async function callText($: Engine, tool: string, args: Record<string, unknown>) {
  const result = await $.mcp.call(SERVER, tool, args)
  const text = result.content.map((block: { type: string; text?: unknown }) => ('text' in block ? String(block.text) : '')).join('')
  if (result.isError) throw new Error(text.slice(0, 200))
  return text
}

// A running session is read again every time, so its activity line follows it even while its
// last activity time stands still (a long command).
async function probeOf($: Engine, id: string, lastActivityAt: number, isRunning: boolean) {
  const cached = probes.get(id)
  if (cached && cached.lastActivityAt === lastActivityAt && !isRunning) return cached.probe
  const probe = parseEvents(await callText($, 'list_events', { session_id: id, limit: 30 }))
  probes.set(id, { lastActivityAt, probe })
  return probe
}

async function readRows($: Engine, at: number): Promise<MonitorRow[]> {
  const [listText, local] = await Promise.all([callText($, 'list_sessions', { limit: 50 }), readLocal($)])
  const list = JSON.parse(listText) as SessionJson[]
  const activityOf = (one: SessionJson) => (one.lastActivityAt ? Date.parse(one.lastActivityAt) : 0)
  // The engine's own busy flag, where this machine gives it, beats the app's.
  const runningOf = (one: SessionJson) => local?.get(one.sessionId)?.isBusy ?? one.isRunning ?? false
  const candidates = list.filter(one => runningOf(one) || activityOf(one) >= at - 24 * 60 * MIN).slice(0, PROBE_LIMIT)
  const probed = new Map(
    await Promise.all(
      candidates.map(async one => [one.sessionId, await probeOf($, one.sessionId, activityOf(one), runningOf(one)).catch(() => undefined)] as const),
    ),
  )

  // An idle session whose newest next-step box nobody has answered yet, read from the transcript
  // itself. A session the engine marks busy or waiting has something more current to show.
  const choices = new Map<string, Choice | Block>()
  await Promise.all(
    list.map(async one => {
      const info = local?.get(one.sessionId)
      if (!info || info.status !== 'idle' || activityOf(one) < at - 48 * 60 * MIN) return
      const choice = await readChoice($, info)
      if (choice) choices.set(one.sessionId, choice)
    }),
  )

  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  const stored = ((await $.store.get(OBSERVED_KEY)) as Record<string, MonitorObserved> | undefined) ?? {}
  const observed: Record<string, MonitorObserved> = {}
  for (const [id, seen] of Object.entries(stored)) if (seen.day === day.getTime()) observed[id] = seen

  const rows = list.map(one => {
    const lastActivityAt = activityOf(one)
    const probe = probed.get(one.sessionId)
    const info = local?.get(one.sessionId)
    let verdict = classify(runningOf(one), lastActivityAt, probe, at)
    // A turn that ended with shells still running is not a stop.
    if (verdict.state === 'idle' && info && info.tasks.length > 0) verdict = { state: 'background' }
    if (verdict.state === 'working' && info && info.tasks.length > 0 && verdict.warning?.includes('권한 승인')) verdict = { state: 'working' }
    // The engine says it waits on the person: a permission prompt, a question card, a dialog.
    if (info?.status === 'waiting' && verdict.state !== 'waiting') verdict = { state: 'waiting', waitKind: 'app', waitText: '입력을 기다리는 중' }
    const found = choices.get(one.sessionId)
    // A prompt a hook dropped waits on the person as a next-step box does, shown in red.
    const choice = found && 'ask' in found ? found : undefined
    if (found && 'blocked' in found && !runningOf(one)) verdict = { state: 'waiting', waitKind: 'blocked', waitText: found.blocked }
    if (choice && !runningOf(one)) verdict = { state: 'waiting', waitKind: 'choice', waitText: choice.ask }
    // A question the person closed on the board no longer waits.
    if (verdict.state === 'waiting' && dismissed.has(waitKey(one.sessionId, verdict.waitText, verdict.waitKind === 'choice' ? choice?.options : undefined))) {
      verdict = { state: 'idle' }
    }
    const seen = observed[one.sessionId]
    const lastStep = seen?.steps.at(-1)
    const changedNow = seen !== undefined && lastStep?.state !== verdict.state
    if (lastStep?.state !== verdict.state) {
      observed[one.sessionId] = { day: day.getTime(), steps: [...(seen?.steps ?? []), { at, state: verdict.state }].slice(-300) }
    }
    // A step after the first of the day is a change the radar saw happen; the first is only when
    // it first looked, which says nothing about the session.
    const sawChange = changedNow ? at : seen && seen.steps.length > 1 && lastStep?.state === verdict.state ? lastStep.at : undefined
    const row: MonitorRow = {
      id: one.sessionId,
      title: one.title ?? '(제목 없음)',
      cwd: one.cwd ?? '',
      isRunning: runningOf(one),
      lastActivityAt,
      state: verdict.state,
      // Stopped and waiting sessions since they last moved; working ones since the radar saw them
      // start, else their last activity.
      since: (verdict.state === 'idle' || verdict.state === 'waiting' ? undefined : sawChange) ?? (lastActivityAt || null),
      warnings: verdict.warning ? [verdict.warning] : [],
    }
    if (one.startedBy) row.parentId = one.startedBy
    if (verdict.waitKind) row.waitKind = verdict.waitKind
    if (verdict.waitText) row.waitText = verdict.waitText
    if (choice?.options.length && verdict.waitKind === 'choice') {
      row.options = choice.options
      row.answers = choice.messages
    }
    if (info && info.tasks.length > 0 && (verdict.state === 'working' || verdict.state === 'background')) row.tasks = info.tasks
    const activity =
      describeActivity(verdict.state, probe) ?? (verdict.state === 'background' && info ? describeBackground(info.tasks, at) : undefined)
    if (activity) row.activity = activity
    return row
  })
  await $.store.set(OBSERVED_KEY, observed)
  return rows
}

// The sessions whose board state moved since the last snapshot, or that are new. A title or
// activity line changing is not a change (no flashing on every refresh).
function changedRows(prev: MonitorRow[], next: MonitorRow[]) {
  const before = new Map(prev.map(row => [row.id, dotOf(row.state)]))
  return next.filter(row => before.get(row.id) !== dotOf(row.state))
}

const flashOf = (row: MonitorRow): MonitorFlash => (dotOf(row.state) === 'waiting' ? 'waiting' : dotOf(row.state) === 'working' ? 'working' : 'other')

// Each session's island: its own folder's, but a sub-session lives in the island of the session at
// the top of its line, wherever its own folder is (a subfolder of the repository, another folder).
export function homesOf(rows: MonitorRow[]) {
  const byId = new Map(rows.map(row => [row.id, row]))
  const homes = new Map<string, string>()
  for (const row of rows) {
    let top = row
    const seen = new Set([row.id])
    for (let up = top.parentId && byId.get(top.parentId); up && !seen.has(up.id); up = up.parentId && byId.get(up.parentId)) {
      seen.add(up.id)
      top = up
    }
    homes.set(row.id, islandOf(top.cwd))
  }
  return homes
}

// Which islands changed, with the colour of the new state, for the flash.
export function changedIslands(prev: MonitorRow[], next: MonitorRow[]) {
  const homes = homesOf(next)
  return new Map(changedRows(prev, next).map(row => [homes.get(row.id) ?? islandOf(row.cwd), flashOf(row)]))
}

// What a change marks unseen: its island, but in the folder-less island the session itself, since
// those sessions share nothing but the lack of a folder.
export const unseenKey = (row: MonitorRow, homes: Map<string, string>) => {
  const home = homes.get(row.id) ?? islandOf(row.cwd)
  return home === FOLDERLESS ? `session:${row.id}` : home
}

async function publish($: Engine, at: number, rows: MonitorRow[], error?: string) {
  for (const [key, one] of flashes) if (one.until <= at) flashes.delete(key)
  // A sent answer holds while its session still waits on that same question, for a while.
  const asking = new Map(rows.filter(row => row.state === 'waiting').map(row => [row.id, waitKey(row.id, row.waitText, row.options)]))
  for (const [id, one] of sent) if (asking.get(id) !== one.key || at - one.at > SENT_MS) sent.delete(id)
  const next: MonitorView = {
    at,
    rows,
    unseen: [...unseen],
    flash: Object.fromEntries([...flashes].map(([key, one]) => [key, one.kind])),
    openCold: [...openCold],
    filter,
    sent: Object.fromEntries([...sent].map(([id, one]) => [id, one.label])),
  }
  if (forcedWidth) next.forcedWidth = forcedWidth
  if (error) next.error = error
  await update($, view, () => next)
}

// Closes a waiting session's question on the board: it stays closed until the session asks again.
async function dismiss($: Engine, row: MonitorRow) {
  dismissed.add(waitKey(row.id, row.waitText, row.waitKind === 'choice' ? row.options : undefined))
  await $.store.set(DISMISSED_KEY, [...dismissed].slice(-200))
  const current = await read($, view)
  if (!current) return
  const rows = current.rows.map(one => {
    if (one.id !== row.id) return one
    const { options: _options, answers: _answers, waitKind: _kind, waitText: _text, ...rest } = one
    return { ...rest, state: 'idle' as const }
  })
  await publish($, current.at, rows, current.error)
}

async function setFilter($: Engine, next: MonitorFilter) {
  filter = next
  await settleFlash($)
}

// Dev only: when the last refreshes ran and what started them, kept across reloads, to see
// whether the timer keeps running while this session sits idle.
const REFRESH_LOG_KEY = 'monitorRefreshLog'

async function noteRefresh($: Engine, at: number, cause: string) {
  const log = ((await $.store.get(REFRESH_LOG_KEY)) as [number, string][] | undefined) ?? []
  await $.store.set(REFRESH_LOG_KEY, [...log, [at, cause]].slice(-40))
}

// One refresh at a time: a tick that comes while one still runs (a slow transcript scan) is skipped.
let refreshing: Promise<void> | undefined

function refresh($: Engine, cause = 'timer') {
  refreshing ??= readAndPublish($, cause).finally(() => (refreshing = undefined))
  return refreshing
}

async function readAndPublish($: Engine, cause: string) {
  const at = await $.clock.now()
  const began = Date.now()
  try {
    await readAndPublishAt($, at)
  } finally {
    void noteRefresh($, at, `${cause} ${Date.now() - began}ms`)
  }
}

async function readAndPublishAt($: Engine, at: number) {
  const prev = (await read($, view))?.rows
  try {
    const rows = isDemo ? demoRows(at) : await readRows($, at)
    if (prev && !skipDiff) {
      const homes = homesOf(rows)
      for (const row of changedRows(prev, rows)) {
        unseen.add(unseenKey(row, homes))
        flashes.set(homes.get(row.id) ?? islandOf(row.cwd), { kind: flashOf(row), until: at + FLASH_MS })
      }
      await $.store.set(UNSEEN_KEY, [...unseen])
      if (flashes.size) $.clock.after(FLASH_MS + 100, () => void settleFlash($))
    }
    skipDiff = false
    await publish($, at, rows)

    const waiting = rows.filter(row => row.state === 'waiting')
    const running = rows.filter(row => dotOf(row.state) === 'working')
    const head = waiting[0] ? ` · ${short(waiting[0].title, 24)} 대기 중` : ''
    $.ui.status(`Monitor · 대기 ${waiting.length} · 실행 ${running.length}${head}`)
  } catch (err) {
    await publish($, at, prev ?? [], String(err).slice(0, 200))
  }
}

// Ends the flashes that ran their time, without reading anything again.
async function settleFlash($: Engine) {
  const current = await read($, view)
  if (current) await publish($, await $.clock.now(), current.rows, current.error)
}

async function markSeen($: Engine, key?: string) {
  if (key) unseen.delete(key)
  else unseen.clear()
  await $.store.set(UNSEEN_KEY, [...unseen])
  await settleFlash($)
}

async function toggleCold($: Engine, key: string) {
  if (openCold.has(key)) openCold.delete(key)
  else openCold.add(key)
  await $.store.set(OPEN_COLD_KEY, [...openCold])
  await settleFlash($)
}

// Opening a claude:// link through the OS moves the app's main window to that session.
async function openSession($: Engine, id: string) {
  const link = sessionLink(id)
  if (!link) return
  try {
    const ran = await $.process.run(['cmd.exe', '/c', 'start', '', link], { timeoutMs: 10_000 })
    if (ran.exitCode !== 0) $.ui.toast(`세션으로 못 옮김: ${short(ran.stderr.trim(), 80)}`)
  } catch (err) {
    $.ui.toast(`세션으로 못 옮김: ${short(String(err), 80)}`)
  }
}

// Answers a waiting session from the board: sends what its button says. The session receives it
// as a message from this session, labelled with this session's title, so a session that asked
// the person to decide may still ask them to confirm in it.
async function answer($: Engine, row: MonitorRow, index: number) {
  const label = row.options?.[index]
  const message = row.answers?.[index] ?? label
  if (!label || !message) return
  try {
    const result = await $.mcp.call(SERVER, 'send_message', { session_id: row.id, message })
    if (result.isError) {
      const text = result.content.map((block: { type: string; text?: unknown }) => ('text' in block ? String(block.text) : '')).join('')
      $.ui.toast(`답을 못 보냄: ${short(text, 80)}`)
      return
    }
    sent.set(row.id, { key: waitKey(row.id, row.waitText, row.options), label, at: await $.clock.now() })
    $.ui.toast(`${short(row.title, 24)}에 "${short(label, 24)}" 보냄`)
    await settleFlash($)
  } catch (err) {
    $.ui.toast(`답을 못 보냄: ${short(String(err), 80)}`)
  }
}

async function popOut($: Engine) {
  try {
    const result = await $.mcp.call('ccd_window', 'open_session_in', { session_id: 'self', target: 'window' })
    const text = result.content.map((block: { type: string; text?: unknown }) => ('text' in block ? String(block.text) : '')).join('')
    return result.isError ? `창으로 못 띄움: ${short(text, 120)}` : '이 세션을 별도 창으로 띄웠습니다.'
  } catch (err) {
    return `창으로 못 띄움: ${short(String(err), 120)}`
  }
}

async function openPane($: Engine) {
  await start($)
  void refresh($, 'open')
  return $.ui.open({ id: PANE, title: TITLE })
}

// Starts the monitor in this session, once: its saved marks, its refresh timer, and the dev tools
// that check it. Nothing runs before, so sessions that never open it pay nothing.
let started: Promise<void> | undefined

function start($: Engine) {
  started ??= (async () => {
    await restore($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    for (const [name, description] of DEV_TOOLS) await $.tool.register({ name, description })
  })()
  return started
}

const DEV_TOOLS: [string, string][] = [
  ['monitor_demo', 'gudals monitor dev: toggles sample rows in the pane, for checking the layout.'],
  ['monitor_snapshot', 'gudals monitor dev: refreshes and returns the board as JSON.'],
  ['monitor_narrow', 'gudals monitor dev: draws the board 400px wide, then 280px, then at the pane width again.'],
  ['monitor_peek', 'gudals monitor dev: returns when the last refreshes ran, without refreshing.'],
]

async function restore($: Engine) {
  const saved = (await $.store.get(UNSEEN_KEY)) as string[] | undefined
  const unfolded = (await $.store.get(OPEN_COLD_KEY)) as string[] | undefined
  const closed = (await $.store.get(DISMISSED_KEY)) as string[] | undefined
  unseen = new Set(saved ?? [])
  openCold = new Set(unfolded ?? [])
  dismissed = new Set(closed ?? [])
}

// A row's time for sorting: when it entered its state, else its last activity.
const timeOf = (row: MonitorRow) => row.since ?? row.lastActivityAt

type Tier = 'hot' | 'live' | 'warm' | 'cold'
const TIER_ORDER: Record<Tier, number> = { hot: 0, live: 1, warm: 2, cold: 3 }
const RANK: Record<DotState, number> = { blocked: 0, waiting: 0, working: 1, background: 2, paused: 3, done: 4 }

type IslandView = { key: string; name: string; rows: MonitorRow[]; best: DotState; tier: Tier; latest: number; why: string }

// Repositories as islands: tier from the most pressing session in them, then the most recent.
export function buildIslands(rows: MonitorRow[], at: number): IslandView[] {
  const groups = new Map<string, MonitorRow[]>()
  const homes = homesOf(rows)
  for (const row of rows) {
    const home = homes.get(row.id) ?? islandOf(row.cwd)
    groups.set(home, [...(groups.get(home) ?? []), row])
  }
  return [...groups.entries()]
    .map(([key, members]) => {
      const best = members.map(rowDot).sort((a, b) => RANK[a] - RANK[b])[0] ?? 'paused'
      const latest = Math.max(...members.map(row => Math.max(row.lastActivityAt, row.since ?? 0)))
      const tier: Tier =
        best === 'waiting' || best === 'blocked' ? 'hot' : best === 'working' ? 'live' : best === 'background' || at - latest < COLD_MS ? 'warm' : 'cold'
      const shells = members.filter(row => row.state === 'background').reduce((sum, row) => sum + (row.tasks?.length ?? 0), 0)
      const oldestWait = members.filter(row => row.state === 'waiting').sort((a, b) => timeOf(a) - timeOf(b))[0]
      const why = oldestWait
        ? rowDot(oldestWait) === 'blocked'
          ? 'HOOK'
          : `나를 기다림 · ${age(at, oldestWait.since)}째`
        : best === 'working'
          ? '실행 중'
          : best === 'background'
            ? `백그라운드 ${shells || ''}`.trim()
            : ''
      return { key, name: folderName(key), rows: members, best, tier, latest, why }
    })
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.latest - a.latest)
}

// A session's children inside its island, most pressing first, then the most recent.
function childrenOf(island: IslandView, parentId: string | undefined) {
  const ids = new Set(island.rows.map(row => row.id))
  return island.rows
    .filter(row => (parentId === undefined ? !row.parentId || !ids.has(row.parentId) : row.parentId === parentId))
    .sort((a, b) => RANK[rowDot(a)] - RANK[rowDot(b)] || timeOf(b) - timeOf(a))
}

export function registerMonitor(on: On) {
  on('tool.call', { tool: 'mcp__gudals__monitor_peek' }, async $ => {
    const now = await $.clock.now()
    const log = ((await $.store.get(REFRESH_LOG_KEY)) as [number, string][] | undefined) ?? []
    const lines = log.map(([at, cause]) => `${new Date(at).toISOString().slice(11, 19)} ${cause} (${Math.round((now - at) / 1000)}s ago)`)
    return { result: `now ${new Date(now).toISOString().slice(11, 19)}\n${lines.join('\n')}` }
  })

  on('tool.call', { tool: 'mcp__gudals__monitor_narrow' }, async $ => {
    forcedWidth = forcedWidth === undefined ? 400 : forcedWidth === 400 ? 280 : undefined
    await settleFlash($)
    return { result: forcedWidth ? `narrow on (${forcedWidth}px)` : 'narrow off' }
  })

  on('tool.call', { tool: 'mcp__gudals__monitor_demo' }, async $ => {
    isDemo = !isDemo
    skipDiff = true
    await refresh($, 'tool')
    return { result: isDemo ? 'demo on' : 'demo off' }
  })

  on('tool.call', { tool: 'mcp__gudals__monitor_snapshot' }, async $ => {
    await start($)
    await refresh($, 'tool')
    const current = await read($, view)
    const brief = current?.rows
      .filter(row => row.state !== 'idle')
      .map(row => ({ title: row.title, state: row.state, waitKind: row.waitKind, waitText: row.waitText, options: row.options, activity: row.activity }))
    return { result: JSON.stringify({ columns: lastColumns, at: current?.at, error: current?.error, unseen: current?.unseen, rows: brief }, null, 1) }
  })

  // /gudals:monitor comes from skills/monitor, so it is in the list from the first message on.
  on('command.run', { command: 'gudals:monitor' }, async $ => {
    const opened = await openPane($)
    return { text: opened.isPlaced ? 'Monitor를 열었습니다.' : `패널을 아직 못 띄움: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    lastColumns = e.viewport?.columns ?? 0
    // A pane still open from before (the app restarted, the plugin reloaded) starts the monitor
    // again, after this drawing: a drawing writes no state of its own.
    if (!started) $.clock.after(0, () => void start($).then(() => refresh($, 'open')))
    const current = await read($, view)
    if (!current) return <Text dimColor>세션 정보를 불러오는 중…</Text>
    if (!Svg) return <Text dimColor>이 화면은 그림을 그릴 수 없어 Monitor를 띄우지 못합니다.</Text>

    const { at, rows } = current
    const allIslands = buildIslands(rows, at)
    const homes = homesOf(rows)
    const keyOf = (row: MonitorRow) => unseenKey(row, homes)
    // Changes not yet looked at: by island, and in the folder-less island by session.
    const keys = new Set(allIslands.flatMap(island => (island.key === FOLDERLESS ? island.rows.map(keyOf) : [island.key])))
    const seenless = new Set((current.unseen ?? []).filter(key => keys.has(key)))
    const hasUnseen = (island: IslandView) =>
      island.key === FOLDERLESS ? island.rows.some(row => seenless.has(keyOf(row))) : seenless.has(island.key)
    const flash = current.flash ?? {}
    const unfolded = new Set(current.openCold ?? [])
    const chosen: MonitorFilter = current.filter ?? 'all'
    const picture = (one: Piece) => <Svg source={one.svg} alt={one.alt} width={one.width} height={one.height} />
    // Lines across whatever room their box has. A solid one is a box of its colour, as tall as the
    // empty picture in it; a dashed one is a row of dash tiles, clipped where the box ends, and
    // starting from no width so the tiles take only the room left over.
    const solid = (key: string, color: string, height = 1) => (
      <Box key={key} flexGrow={1} flexShrink={1} minWidth={0} backgroundColor={color}>
        {picture(spacerPiece(1, height))}
      </Box>
    )
    const dashed = (key: string, color: string) => (
      <Box key={key} width={0} flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row" overflow="hidden">
        {Array.from({ length: DASH_TILES }, (_, i) => (
          <Box key={`tile:${i}`} flexShrink={0}>{picture(dashTilePiece(color))}</Box>
        ))}
      </Box>
    )
    // A control in a drawn frame, as tall as a plain button draws: strips on its edges only, since
    // a placed picture takes the clicks under it. A fill is the Box's own.
    // The spacer holds the box at the frame's height whatever the button draws at, so the sides
    // and the bottom line meet.
    const framed = (key: string, frame: Frame & { fill?: string }, control: JSX.Element, height = BUTTON_PX) => (
      <Box key={key} position="relative" flexDirection="row" alignItems="center" paddingX={frame.radius && frame.radius > 6 ? 'sm' : 'xs'} backgroundColor={frame.fill}>
        {picture(spacerPiece(1, height))}
        {control}
        <Box position="absolute" top={0} left={0}>{picture(frameSide('left', frame, height))}</Box>
        <Box position="absolute" top={0} right={0}>{picture(frameSide('right', frame, height))}</Box>
        <Box position="absolute" top={0} left={0} right={0}>
          <Svg source={frameLineSource(frame)} alt="테두리" height={frame.stroke ?? 1} />
        </Box>
        <Box position="absolute" bottom={0} left={0} right={0}>
          <Svg source={frameLineSource(frame)} alt="테두리" height={frame.stroke ?? 1} />
        </Box>
      </Box>
    )
    // Opening a session marks what it changed as seen: its island, or in the folder-less island, itself.
    const open = (row: MonitorRow) => () => {
      void openSession($, row.id)
      void markSeen($, keyOf(row))
    }
    const waiting = rows.filter(row => row.state === 'waiting').sort((a, b) => timeOf(a) - timeOf(b))

    // One session's rows: the node, what it asks or does, then its children. `through` names the
    // depths whose child line runs on past these rows.
    const node = (island: IslandView, row: MonitorRow, depth: number, through: number[], isLast: boolean): JSX.Element[] => {
      const state = rowDot(row)
      const children = childrenOf(island, row.id)
      const goesOn = depth > 0 && !isLast ? [...through, depth - 1] : through
      // What crosses the rows under the node: its parent's line while a sibling follows, its own when it has children.
      const under = children.length ? [...goesOn, depth] : goesOn
      const rail = (height: number) => picture(railPiece(depth, height, under))
      const fill = (text: JSX.Element) => <Box flexGrow={1} flexShrink={1} minWidth={0}>{text}</Box>
      const isWorktree = row.cwd !== island.key && island.key !== FOLDERLESS
      const accent = state === 'blocked' ? C.hook : state === 'waiting' ? C.amber : state === 'working' ? C.green : undefined
      const lines: JSX.Element[] = [
        <Box key={`node:${row.id}`} flexDirection="row" alignItems="center" hover={{ backgroundColor: C.panel3 }}>
          {picture(gutterPiece(state, depth, { through, isLast, hasChildren: children.length > 0, accent }))}
          {fill(
            <Button key={`open:${row.id}`} plain onPress={open(row)}>
              <Text size="footnote" wrap="truncate-end">{row.title}</Text>
            </Button>,
          )}
          {isWorktree && picture(worktreePiece(folderName(row.cwd)))}
          {island.key === FOLDERLESS && seenless.has(keyOf(row)) && picture(newDotPiece())}
          <Box flexShrink={0} paddingLeft="xs" paddingRight="xs">
            <Text size="caption" mono color={C.fg3}>{age(at, row.since)}</Text>
          </Box>
        </Box>,
      ]
      if (row.state === 'waiting') {
        lines.push(
          <Box key={`q:${row.id}`} flexDirection="row" alignItems="center">
            {rail(19)}
            {fill(
              <Text size="caption" color={state === 'blocked' ? C.hook : C.amber} wrap="truncate-end">
                {state === 'blocked' ? `훅이 프롬프트를 막음 · ${row.waitText}` : (row.waitText ?? '입력을 기다리는 중')}
              </Text>,
            )}
            <Button key={`dismiss:${row.id}`} plain dimColor onPress={() => void dismiss($, row)}>
              <Text size="caption">✕</Text>
            </Button>
          </Box>,
        )
        // An answer sent from the board shows in place of the buttons until the session moves on.
        const answered = current.sent?.[row.id]
        if (answered) {
          lines.push(
            <Box key={`sent:${row.id}`} flexDirection="row" alignItems="center">
              {rail(19)}
              {fill(<Text size="caption" color={C.fg2} wrap="truncate-end">{`"${answered}" 보냄 · 세션의 답을 기다리는 중`}</Text>)}
            </Box>,
          )
        } else if (row.options?.length) {
          lines.push(
            <Box key={`acts:${row.id}`} flexDirection="row" alignItems="center">
              {rail(30)}
              <Box flexDirection="row" flexWrap="wrap" gap="xs" alignItems="center">
                {row.options.slice(0, 9).map((label, i) =>
                  framed(
                    `answerbox:${row.id}:${i}`,
                    i === 0 ? { border: C.amber, stroke: 2 } : { border: C.line2 },
                    <Button key={`answer:${row.id}:${i}`} plain onPress={() => void answer($, row, i)}>
                      <Text size="caption" weight={i === 0 ? 'semibold' : 'regular'}>{`${i + 1} ${label}`}</Text>
                    </Button>,
                  ),
                )}
              </Box>
            </Box>,
          )
        }
      } else if (state === 'working') {
        // No activity read yet: the sweep alone says it works; no stand-in words.
        if (row.activity) {
          lines.push(
            <Box key={`act:${row.id}`} flexDirection="row" alignItems="center">
              {rail(19)}
              {fill(<Text size="caption" color={C.green} wrap="truncate-end">{row.activity}</Text>)}
            </Box>,
          )
        }
        lines.push(
          <Box key={`sweep:${row.id}`} flexDirection="row" alignItems="flex-start">
            {rail(7)}
            <Box position="relative" flexGrow={1} flexShrink={1} minWidth={0} paddingRight="xs">
              {solid('bar', C.line, 2)}
              <Box position="absolute" top={0} left={0}>{picture(glintPiece())}</Box>
            </Box>
          </Box>,
        )
      }
      // The shells a session runs, under it: while it works, and alone once it has stopped and
      // only they run on (no activity line, no sweep: the session itself does nothing).
      if (state === 'working' || state === 'background') {
        lines.push(
          ...(row.tasks ?? []).map((task, i) => (
            <Box key={`task:${row.id}:${i}`} flexDirection="row" alignItems="center" gap="xs">
              {rail(22)}
              <Text size="caption" color={task.kind === 'monitor' ? C.fg3 : C.teal}>{task.kind === 'monitor' ? '감시' : '실행'}</Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text size="caption" mono color={C.fg2} wrap="truncate-end">{task.label}</Text>
              </Box>
              <Box flexShrink={0} paddingRight="xs">
                <Text size="caption" mono color={task.kind === 'monitor' ? C.fg3 : C.teal}>{elapsedLabel(at - task.startedAt)}</Text>
              </Box>
            </Box>
          )),
        )
      }
      children.forEach((child, i) => lines.push(...node(island, child, depth + 1, goesOn, i === children.length - 1)))
      return lines
    }

    const islandCard = (island: IslandView) => {
      const isCold = island.tier === 'cold'
      const isOpen = !isCold || unfolded.has(island.key)
      // A folded dormant card is the prototype's at 60% opacity (85% under the pointer), drawn in
      // the colours that shows; the folder-less island sits a step darker, on the board's colour.
      const isFaded = isCold && !isOpen
      const isFolderless = island.key === FOLDERLESS
      const tone = (color: string, opacity = isFaded ? FADED : 1) => (opacity < 1 ? fade(color, opacity) : color)
      const hotColor = island.best === 'blocked' ? C.hook : C.amber
      const borderColor = island.tier === 'hot' ? hotColor : island.tier === 'live' ? C.green : isFolderless ? C.line2 : tone(C.line)
      const flashing = flash[island.key]
      const base = isFolderless ? C.bg : tone(C.panel2)
      const background = flashing === 'waiting' ? C.amberBg : flashing === 'working' ? C.greenBg : flashing === 'other' ? C.panel3 : base
      const whyColor = island.tier === 'hot' ? hotColor : island.tier === 'live' ? C.green : island.best === 'background' ? C.teal : C.fg3
      const head = (
        <Box key="head" flexDirection="row" alignItems="center" gap="xs">
          {picture(dotPiece(isFaded && island.best === 'paused' ? 'done' : island.best))}
          {isCold ? (
            <Button key={`fold:${island.key}`} plain dimColor={isFaded} onPress={() => void toggleCold($, island.key)}>
              <Text size="body" weight={isFaded ? 'medium' : 'semibold'}>{island.name}</Text>
            </Button>
          ) : (
            <Text size="body" weight="semibold" color={isFolderless ? C.fg2 : undefined} wrap="truncate-end">{island.name}</Text>
          )}
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="caption" color={whyColor} wrap="truncate-end">{isCold ? '' : island.why}</Text>
          </Box>
          <Text size="caption" mono color={isFaded ? C.fg4 : C.fg3} hover={isFaded ? { color: C.fg3 } : undefined}>{String(island.rows.length)}</Text>
        </Box>
      )
      const roots = childrenOf(island, undefined)
      const chipBack = tone(C.panel2)
      const body = isOpen
        ? [
            <Box key="rule" flexDirection="column">
              {picture(spacerPiece(1, 6))}
              <Box flexDirection="row">{solid('line', C.line)}</Box>
              {picture(spacerPiece(1, 6))}
            </Box>,
            ...roots.flatMap((row, i) => node(island, row, 0, [], i === roots.length - 1)),
          ]
        : [
            <Box key="chips" flexDirection="row" flexWrap="wrap" gap="xs" paddingTop="xs">
              {[...island.rows]
                .sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || timeOf(b) - timeOf(a))
                .map(row => (
                  <Box key={`minirow:${row.id}`} flexDirection="row" alignItems="center">
                    {row.parentId && picture(stubPiece())}
                    {framed(
                      `mini:${row.id}`,
                      { border: tone(C.line), fill: tone(C.panel), outside: chipBack },
                      <Box flexDirection="row" alignItems="center">
                        {picture(chipDotPiece(isFaded && rowDot(row) === 'paused' ? 'done' : rowDot(row)))}
                        <Button key={`open:${row.id}`} plain dimColor onPress={open(row)}>
                          <Text size="caption">{fitText(row.title, CHIP_PX - 13 - 12, 11)}</Text>
                        </Button>
                      </Box>,
                    )}
                  </Box>
                ))}
            </Box>,
          ]
      const padded = (
        <Box key="inside" flexDirection="column" paddingX={isFaded ? 'xs' : 'sm'} paddingY="xs">
          {head}
          {body}
        </Box>
      )
      if (!isFolderless) {
        return (
          <Box
            key={`island:${island.key}`}
            flexGrow={1}
            flexDirection="column"
            borderStyle="round"
            borderColor={borderColor}
            backgroundColor={background}
            hover={isFaded ? { backgroundColor: fade(C.panel2, FADED_HOVER), borderColor: fade(C.line, FADED_HOVER) } : undefined}
          >
            {padded}
          </Box>
        )
      }
      // The folder-less island's dashed border is drawn, corners and all: the top and the bottom
      // are rows of dash tiles (the bottom one in the flow, under the content), the sides run long,
      // and the card clips them all.
      return (
        <Box key={`island:${island.key}`} position="relative" overflow="hidden" flexGrow={1} flexDirection="column" backgroundColor={background}>
          <Box flexGrow={1} flexDirection="column">{padded}</Box>
          <Box flexDirection="row">{dashed('dash:bottom', borderColor)}</Box>
          <Box position="absolute" top={0} left={0} right={0} flexDirection="row">
            {dashed('dash:top', borderColor)}
          </Box>
          <Box position="absolute" top={0} left={0}>{picture(cardSidePiece(borderColor))}</Box>
          <Box position="absolute" top={0} right={0}>{picture(cardSidePiece(borderColor))}</Box>
          <Box position="absolute" top={0} left={0}>{picture(cardCornerPiece('tl', borderColor, background))}</Box>
          <Box position="absolute" top={0} right={0}>{picture(cardCornerPiece('tr', borderColor, background))}</Box>
          <Box position="absolute" bottom={0} left={0}>{picture(cardCornerPiece('bl', borderColor, background))}</Box>
          <Box position="absolute" bottom={0} right={0}>{picture(cardCornerPiece('br', borderColor, background))}</Box>
        </Box>
      )
    }

    // A card with the room for its unseen mark above and right of it; the mark sits on the corner.
    // Each starts at a readable width and grows to share its row; where one no longer fits beside
    // another it takes a row of its own, and in a pane narrower than that it shrinks to the pane.
    const placed = (island: IslandView, room: number, isWhole: boolean) => (
      <Box
        key={`place:${island.key}`}
        position="relative"
        flexDirection="column"
        width={isWhole ? '100%' : CARD_MIN_CELLS}
        minWidth={0}
        flexGrow={1}
        flexShrink={1}
      >
        {picture(spacerPiece(1, room))}
        <Box flexDirection="row" flexGrow={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="column">{islandCard(island)}</Box>
          {picture(spacerPiece(BADGE_ROOM.right, 1))}
        </Box>
        {hasUnseen(island) && (
          <Box position="absolute" top={0} right={0}>
            {picture(badgePiece(room))}
          </Box>
        )}
      </Box>
    )

    // The board: waiting islands across the whole row, then the rest two abreast where the pane is
    // wide enough; the dormant ones below their line, never moved up to fill a hole.
    const matches = (island: IslandView) =>
      chosen === 'all' ||
      (chosen === 'wait' && island.rows.some(row => row.state === 'waiting')) ||
      (chosen === 'work' && island.rows.some(row => dotOf(row.state) === 'working')) ||
      (chosen === 'new' && hasUnseen(island))
    const islands = allIslands.filter(matches)
    const hot = islands.filter(island => island.tier === 'hot')
    const active = islands.filter(island => island.tier === 'live' || island.tier === 'warm')
    const cold = islands.filter(island => island.tier === 'cold')
    // About how tall a card draws, in pixels, from what it holds: enough to tell a long card from a
    // short one.
    const heightOf = (island: IslandView, room: number) => {
      const isOpen = island.tier !== 'cold' || unfolded.has(island.key)
      const rowsOf = (row: MonitorRow) => {
        const state = rowDot(row)
        const asks = row.state === 'waiting' ? 19 + (row.options?.length ? 30 : 0) : 0
        const works = state === 'working' ? (row.activity ? 19 : 0) + 7 : 0
        const shells = state === 'working' || state === 'background' ? (row.tasks?.length ?? 0) * 22 : 0
        return NODE_PX + asks + works + shells
      }
      const body = isOpen ? 13 + island.rows.reduce((sum, row) => sum + rowsOf(row), 0) : Math.ceil(island.rows.length / 2) * 25 + 6
      return room + 26 + body + 12
    }
    // Two to a row, side by side at one height, while the cards are about as tall as each other.
    // Where they differ a lot, two columns instead, each card under the shorter one, so short cards
    // stack beside a long one rather than leave a hole under their row-mate. Narrow, the rows or the
    // columns wrap to one.
    const grid = (key: string, members: IslandView[], room: number) => {
      if (members.length === 0) return false
      if (members.length === 1) {
        const only = members[0]!
        return (
          <Box key={key} flexDirection="row">
            {placed(only, room, true)}
          </Box>
        )
      }
      const heights = members.map(island => heightOf(island, room))
      let pairWaste = 0
      for (let i = 0; i < heights.length; i += 2) pairWaste += Math.abs((heights[i] ?? 0) - (heights[i + 1] ?? 0))
      const columns: IslandView[][] = [[], []]
      const sums = [0, 0]
      members.forEach((island, i) => {
        const side = sums[1]! < sums[0]! ? 1 : 0
        columns[side]!.push(island)
        sums[side]! += heights[i]!
      })
      if (pairWaste - Math.abs(sums[0]! - sums[1]!) <= MASONRY_GAIN_PX) {
        return (
          <Box key={key} flexDirection="row" flexWrap="wrap" alignItems="stretch">
            {members.map(island => placed(island, room, false))}
          </Box>
        )
      }
      return (
        <Box key={key} flexDirection="row" flexWrap="wrap" alignItems="flex-start">
          {columns.map((column, side) => (
            <Box key={`${key}:col${side}`} flexDirection="column" width={CARD_MIN_CELLS} minWidth={0} flexGrow={1} flexShrink={1}>
              {column.map(island => placed(island, room, true))}
            </Box>
          ))}
        </Box>
      )
    }
    const board = [
      ...hot.map(island => (
        <Box key={`row:${island.key}`} flexDirection="row">
          {placed(island, BADGE_ROOM.top, true)}
        </Box>
      )),
      grid('active', active, BADGE_ROOM.top),
      cold.length > 0 && (
        <Box key="divider" flexDirection="row" alignItems="center" gap="sm" paddingTop="xs" paddingRight="sm">
          <Box flexShrink={0}>
            <Text size="caption" color={C.fg3}>휴면 · 2시간 이상</Text>
          </Box>
          {dashed('line', C.line2)}
        </Box>
      ),
      grid('cold', cold, CARD_GAP_COLD),
    ].filter(Boolean)

    // The header's counts are the filters: one chosen at a time; a count of none cannot be chosen.
    const counts: Record<MonitorFilter, number> = {
      all: allIslands.length,
      wait: waiting.length,
      work: rows.filter(row => dotOf(row.state) === 'working').length,
      new: seenless.size,
    }
    const TONE: Record<MonitorFilter, { color: string; back: string }> = {
      all: { color: C.fg3, back: C.panel3 },
      wait: { color: C.amber, back: C.amberBg },
      work: { color: C.green, back: C.greenBg },
      new: { color: C.fg3, back: C.panel3 },
    }
    const pill = (kind: MonitorFilter, label: string) => {
      if (kind !== 'all' && counts[kind] === 0) return <Box key={`pill:${kind}`}>{picture(pillPiece(label))}</Box>
      const isChosen = chosen === kind
      const tone = TONE[kind]
      return framed(
        `pill:${kind}`,
        isChosen
          ? { border: tone.color, stroke: 2, radius: 10, fill: tone.back, outside: C.bg }
          : { border: kind === 'all' || kind === 'new' ? C.line2 : tone.color, radius: 10 },
        <Button key={`filter:${kind}`} plain dimColor={!isChosen} onPress={() => void setFilter($, kind)}>
          <Text size="caption" weight={isChosen ? 'semibold' : 'regular'}>{label}</Text>
        </Button>,
      )
    }
    // The desktop passes no key to a pane's buttons, so nothing here has a shortcut.
    const ghost = (key: string, label: string, onPress: () => void) =>
      framed(
        `${key}box`,
        { border: C.line2 },
        <Button key={key} plain dimColor onPress={onPress}>
          <Text size="caption">{label}</Text>
        </Button>,
      )
    const empty = chosen !== 'all' && islands.length === 0
    const hint = (key: string, what: string) => (
      <Text key={key} size="caption" mono color={C.fg3}>
        <Text color={C.fg2}>{key}</Text> {what}
      </Text>
    )

    return (
      <Box flexDirection="column" width={current.forcedWidth ? Math.round(current.forcedWidth / BOX_CELL_PX) : undefined}>
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap="xs" paddingX="sm" paddingY="xs">
          <Text size="footnote" weight="semibold">세션</Text>
          {pill('all', '전체')}
          {pill('wait', `대기 ${counts.wait}`)}
          {pill('work', `실행 ${counts.work}`)}
          {pill('new', `새 변경 ${counts.new}`)}
          <Box flexGrow={1} />
          {ghost('seen', '모두 확인', () => void markSeen($))}
          {ghost('popout', '창으로', () => void popOut($).then(text => $.ui.toast(text)))}
        </Box>
        <Box flexDirection="row">{solid('top', C.line)}</Box>
        {current.error && <Text color="error">목록을 못 읽음: {current.error}</Text>}
        <Box flexDirection="column" paddingLeft="sm" paddingBottom="sm">
          {empty ? (
            <Box key="empty" flexDirection="column" alignItems="center" gap="xs" paddingY="lg">
              <Text size="footnote" color={C.fg3}>해당 세션 없음</Text>
              {framed('allbox', { border: C.line2 }, <Button key="toall" plain onPress={() => void setFilter($, 'all')}>전체로</Button>)}
            </Box>
          ) : board.length ? (
            board
          ) : (
            [<Text key="none" dimColor>세션이 없습니다</Text>]
          )}
        </Box>
        <Box flexDirection="row">{solid('foot', C.line)}</Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap="sm" paddingX="sm" paddingY="xs">
          {hint('제목 클릭', '세션 이동')}
          {hint('답 버튼', '그 세션에 보내기')}
          {hint('휴면 카드 이름 클릭', '펼치기')}
        </Box>
      </Box>
    )
  })
}

// How long a shell has run, coarse enough to read at a glance.
function elapsedLabel(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}초째`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}분째` : `${Math.floor(m / 60)}시간 ${m % 60}분째`
}

function demoRows(at: number): MonitorRow[] {
  const id = (n: number) => `local_00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
  // n minutes ago, as the prototype's m(n).
  const ago = (n: number) => at - n * MIN
  const row = (n: number, title: string, cwd: string, minutes: number, rest: Partial<MonitorRow> = {}): MonitorRow => ({
    id: id(n), title, cwd, isRunning: false, lastActivityAt: ago(minutes), state: 'idle', since: ago(minutes), warnings: [], ...rest,
  })
  const W = 'C:/Workspace'
  const H = 'C:/herdr'
  return [
    row(1, 'Gudals transprompt', 'C:/data/scratch-2026-10-22-77f361', 2, { state: 'waiting', waitKind: 'choice', waitText: '어느 시안으로 갈까요?', options: ['A + C피크', '다른 걸로'], answers: ['A + C피크로 가자.', '다른 걸로 하자.'] }),
    row(2, 'VLSI 교안 디렉토리 구조', `${W}/lecture-artifact`, 0.5, { state: 'working', isRunning: true, activity: '파일 읽기 · 수업 필기 노트 L03 후반 파악 중' }),
    row(3, 'AI 협업 시 역할 분담과 평가 기준', `${W}/inquiry`, 9),
    // Stopped, with only its watch running on.
    row(4, 'M2 검증형 경로 구현 (워커)', `${W}/inquiry`, 15, { parentId: id(3), state: 'background', tasks: [{ kind: 'monitor', label: 'tail -f eval.log', startedAt: ago(12) }] }),
    row(5, '국내 웹 탐색 실험 (네이버·보도자료·PDF/HWP)', `${W}/inquiry/.claude/worktrees/kr-web-sp`, 29, { parentId: id(3) }),
    row(6, 'Anthropic skills 재구성', `${W}/gudals`, 115),
    row(7, '강의 핸드아웃 작업 승계', `${W}/lecture-handout`, 166),
    row(8, 'LMS management (Sonnet)', `${H}/HYU/HY-LMS`, 173),
    row(9, 'LMS answer (Opus)', `${H}/HYU/HY-LMS`, 400),
    row(10, 'HY-LMS-init', `${H}/HYU/HY-LMS`, 900),
    row(11, '한양대학교 과제 명세서', `${H}/HYU/사랑의실천`, 175),
    row(12, '2026-2 학기 과제 명세서', `${H}/HYU/사랑의실천`, 600),
    row(13, 'Scheduler (Sonnet)', `${H}/Scheduler`, 177),
    row(14, 'Scheduler (Opus)', `${H}/Scheduler`, 700),
    row(15, '일정 관리 AI 에이전트', `${H}/Scheduler`, 1300),
    row(16, 'Cheatsheet 초안 구성', `${H}/HYU/Algorithm-midterm`, 214),
    row(17, "Today's interesting Wiki", `${H}/HYU/Algorithm-midterm`, 1500),
    // A prompt transprompt held for approval.
    row(18, 'transprompt v4', `${W}/transprompt`, 3, { state: 'waiting', waitKind: 'blocked', waitText: 'transprompt: 구조화한 뒤 승인을 받아 보냅니다' }),
    row(19, 'transprompt v3', `${W}/transprompt`, 2600),
    row(20, 'gpt-ebook-html', `${W}/gpt-ebook-html`, 4000),
  ]
}
