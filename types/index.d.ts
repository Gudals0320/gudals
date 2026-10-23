export type Draft =
  | { phase: 'structuring'; raw: string; startedAt: number; auto: boolean }
  | { phase: 'ready'; raw: string; structured: string }
  | { phase: 'failed'; raw: string; reason: string }

// ── monitor ─────────────────────────────────────────────────────────────

// `background`: the turn ended, but shells it started still run.
export type MonitorState = 'working' | 'background' | 'waiting' | 'idle'

// `question`: a question card or plan approval is open; `choice`: the turn ended on a
// next-step box with options; `reply`: the last answer asks something; `app`: the engine or
// the app reports the session waiting on the person; `blocked`: a hook dropped the person's prompt
// (transprompt holding it for approval), and nothing of theirs has gone through since.
export type MonitorWaitKind = 'question' | 'choice' | 'reply' | 'app' | 'blocked'

// What the monitor read from one session's recent transcript.
export type MonitorProbe = {
  appState: string
  lastCall?: string
  // With `lastCall`: the newest thing the session said before that call.
  lastSay?: string
  lastText?: string
  // The turn since the person last wrote ended with a next-step box.
  asked?: boolean
}

export type MonitorRow = {
  id: string
  title: string
  cwd: string
  parentId?: string
  isRunning: boolean
  lastActivityAt: number
  state: MonitorState
  waitKind?: MonitorWaitKind
  waitText?: string
  // What it is doing, or last did, in one line.
  activity?: string
  // A next-step box's options, as their labels, and what each sends when pressed.
  options?: string[]
  answers?: string[]
  // Shells the session left running after its turn, oldest first.
  tasks?: { kind: 'command' | 'monitor'; label: string; startedAt: number }[]
  // When the session entered its current state: its last activity, or a change the monitor saw
  // happen. Null when neither is known; never the time the monitor looked.
  since: number | null
  warnings: string[]
}

// Which islands the board shows: all, or those with a session waiting, working, or changed unseen.
export type MonitorFilter = 'all' | 'wait' | 'work' | 'new'

// The one-off flash an island shows after a session in it changed state, by the new state.
export type MonitorFlash = 'waiting' | 'working' | 'other'

export type MonitorView = {
  at: number
  rows: MonitorRow[]
  error?: string
  // Islands with a change the person has not looked at yet, by island key.
  unseen?: string[]
  // Islands flashing right now, by island key.
  flash?: Record<string, MonitorFlash>
  // Dormant islands the person unfolded, by island key.
  openCold?: string[]
  filter?: MonitorFilter
  // Answers sent from the board to sessions still on that question: the button's label, by session.
  sent?: Record<string, string>
  // Dev only: the board drawn this many pixels wide instead of the pane's width.
  forcedWidth?: number
}

// The state changes the monitor has seen today, per session.
export type MonitorObserved = { day: number; steps: { at: number; state: MonitorState }[] }

declare module 'claude-code' {
  interface PluginState {
    gudals: {
      transpromptDraft: Draft | null
      transpromptBypassNext: boolean
      monitorView: MonitorView | null
    }
  }
}
