import type { EngineInterface as Engine } from 'claude-code'

import { MIN } from './classify'

// What this machine says about a session beyond the app's own list: whether its process is
// mid-turn, and which shells it left running after the turn ended. Both come from undocumented
// local files and Windows process data, so every reader here may come back empty, and the radar
// then falls back to the app's list alone.

export type BgTask = {
  kind: 'command' | 'monitor'
  label: string
  startedAt: number
}

// `status` is the engine's own word for the session: `busy`, `idle` or `waiting` (on the person).
export type LocalInfo = { pid: number; status: string; isBusy: boolean; cliId: string; cwd: string; tasks: BgTask[] }

type Registered = { pid: number; hostId: string; status: string; cliId: string; cwd: string }

// One `~/.claude/sessions/<pid>.json`: the engine's note about a live session process.
export function parseRegistry(text: string): Registered | undefined {
  try {
    const one = JSON.parse(text) as { pid?: unknown; hostSessionId?: unknown; status?: unknown; sessionId?: unknown; cwd?: unknown }
    if (typeof one.pid !== 'number' || typeof one.hostSessionId !== 'string') return undefined
    return {
      pid: one.pid,
      hostId: one.hostSessionId,
      status: typeof one.status === 'string' ? one.status : '',
      cliId: typeof one.sessionId === 'string' ? one.sessionId : '',
      cwd: typeof one.cwd === 'string' ? one.cwd : '',
    }
  } catch {
    return undefined
  }
}

export type Proc = { pid: number; ppid: number; name: string; command?: string; startedAt?: number }

export function parseProcesses(json: string): Proc[] {
  const raw = JSON.parse(json) as unknown
  const list = Array.isArray(raw) ? raw : [raw]
  return list.flatMap(one => {
    const p = one as { p?: unknown; pp?: unknown; n?: unknown; c?: unknown; t?: unknown }
    if (typeof p.p !== 'number' || typeof p.pp !== 'number') return []
    const proc: Proc = { pid: p.p, ppid: p.pp, name: String(p.n ?? '') }
    if (typeof p.c === 'string') proc.command = p.c
    if (typeof p.t === 'string' && !Number.isNaN(Date.parse(p.t))) proc.startedAt = Date.parse(p.t)
    return [proc]
  })
}

const SHELL = /^(bash|sh|pwsh|powershell|cmd)\.exe$/i

// The command a session's shell runs: Claude Code wraps it as `eval '<command>'`.
export function innerCommand(commandLine: string) {
  const wrapped = /eval '((?:[^']|'\\'')*)'/.exec(commandLine)
  return (wrapped?.[1] ?? commandLine).replace(/'\\''/g, "'").replace(/\\"/g, '"').trim()
}

// A shell that follows a file (`tail -f`) is a watch; anything else is a command at work.
export function taskOf(commandLine: string, startedAt: number): BgTask {
  const command = innerCommand(commandLine)
  const watched = /\btail\b[^|;]*?\s-[a-zA-Z]*f[a-zA-Z]*\s+(?:-n\s*\S+\s+)?(\S+)/.exec(command) ?? /\btail\b[^|;]*?-f\s+(\S+)/.exec(command)
  if (watched?.[1]) {
    return { kind: 'monitor', label: watched[1].split(/[\\/]/).pop() ?? watched[1], startedAt }
  }
  const step = command
    .split(/\s*(?:&&|;|\|\||\|)\s*/)
    .map(one => one.replace(/\s*[12]?>>?\s*\S+/g, '').replace(/\s*<\s*\S+/g, '').trim())
    .find(one => one && !/^(cd|export|set|source|touch|echo)\b/.test(one))
  return { kind: 'command', label: shorten(step ?? command, 48), startedAt }
}

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// The shells a session process started directly, as tasks, oldest first. `selfMarker` keeps
// out the radar's own process query.
export function tasksUnder(procs: Proc[], pid: number, selfMarker: string): BgTask[] {
  return procs
    .filter(one => one.ppid === pid && SHELL.test(one.name) && one.command && !one.command.includes(selfMarker))
    .map(one => taskOf(one.command!, one.startedAt ?? 0))
    .sort((a, b) => a.startedAt - b.startedAt)
}

const minutesSince = (at: number, from: number) => Math.max(0, Math.round((at - from) / MIN))

// One line for a session whose turn ended while its shells run on.
export function describeBackground(tasks: BgTask[], at: number) {
  const commands = tasks.filter(one => one.kind === 'command')
  const monitors = tasks.filter(one => one.kind === 'monitor')
  if (commands[0]) {
    const more = commands.length > 1 ? ` 외 ${commands.length - 1}개` : ''
    const watch = monitors.length > 0 ? ` · 감시 ${monitors.length}개` : ''
    return `백그라운드 · ${commands[0].label}${more} · ${minutesSince(at, commands[0].startedAt)}분째${watch}`
  }
  if (monitors[0]) {
    const files = [...new Set(monitors.map(one => one.label))]
    return `감시만 남음 · ${files.slice(0, 2).join(', ')}${files.length > 2 ? ' …' : ''} · ${minutesSince(at, monitors[0].startedAt)}분째`
  }
  return undefined
}

const PROC_MARKER = 'gudals-monitor-process-query'

// Dev only: what one refresh spent, by kind: the app's own calls, the process query, transcript
// scans. Calls run side by side, so each kind keeps its count, its total and its longest.
type CostKind = 'app' | 'ps' | 'scan'
const cost: Record<CostKind, { n: number; ms: number; max: number }> = {
  app: { n: 0, ms: 0, max: 0 },
  ps: { n: 0, ms: 0, max: 0 },
  scan: { n: 0, ms: 0, max: 0 },
}

export function resetCost() {
  for (const one of Object.values(cost)) Object.assign(one, { n: 0, ms: 0, max: 0 })
}

export async function timed<T>(kind: CostKind, run: () => Promise<T>): Promise<T> {
  const began = Date.now()
  try {
    return await run()
  } finally {
    const ms = Date.now() - began
    const one = cost[kind]
    one.n += 1
    one.ms += ms
    one.max = Math.max(one.max, ms)
  }
}

// "app 7×Σ310 max 120 · ps 1×1250 · scan 0", in milliseconds.
export const costLine = () =>
  (Object.entries(cost) as [CostKind, { n: number; ms: number; max: number }][])
    .map(([kind, one]) => (one.n === 0 ? `${kind} 0` : one.n === 1 ? `${kind} 1×${one.ms}` : `${kind} ${one.n}×Σ${one.ms} max ${one.max}`))
    .join(' · ')

// The session processes and their children only, not the machine's whole process table: each one's
// id, parent and name; the command line and start time for shells only. The ids are whole numbers.
export const procQuery = (pids: number[]) =>
  [
    `$null = '${PROC_MARKER}'`,
    // Command lines can hold Korean; the console's own code page would mangle it.
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `Get-CimInstance Win32_Process -Filter "${pids.map(pid => `ProcessId=${Math.trunc(pid)} OR ParentProcessId=${Math.trunc(pid)}`).join(' OR ')}" | ForEach-Object {`,
    "  $shell = $_.Name -match '^(bash|sh|pwsh|powershell|cmd)\\.exe$'",
    "  [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; n = $_.Name;",
    "    c = $(if ($shell) { $_.CommandLine } else { $null });",
    "    t = $(if ($shell -and $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }) }",
    // ConvertTo-Json writes one object bare and none as nothing; parseProcesses takes both.
    '} | ConvertTo-Json -Compress',
  ].join('\n')

const registryCache = new Map<string, { mtimeMs: number; one: Registered | undefined }>()

async function configDir($: Engine) {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('USERPROFILE')) ?? ''}\\.claude`
}

async function readRegistry($: Engine) {
  const home = await configDir($)
  const dir = `${home}\\sessions`
  const found: Registered[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !/^\d+\.json$/.test(entry.name)) continue
    const path = `${dir}\\${entry.name}`
    let cached = registryCache.get(path)
    if (!cached || cached.mtimeMs !== entry.mtimeMs) {
      const text = await $.fs.read(path)
      cached = { mtimeMs: entry.mtimeMs, one: typeof text === 'string' ? parseRegistry(text) : undefined }
      registryCache.set(path, cached)
    }
    if (cached.one) found.push(cached.one)
  }
  return found
}

// The process query costs a PowerShell start, so it runs at most this often, or sooner when a session
// process starts or ends; the sessions' own state files are read on every refresh.
const PROC_TTL_MS = 30_000
let procCache: { at: number; pids: string; procs: Proc[] } | undefined
let procsInFlight: Promise<Proc[]> | undefined

async function queryProcesses($: Engine, pids: number[]) {
  if (pids.length === 0) return []
  const ran = await timed('ps', () => $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', procQuery(pids)], { timeoutMs: 15_000 }))
  if (ran.exitCode !== 0) throw new Error(ran.stderr.slice(0, 200))
  return ran.stdout.trim() ? parseProcesses(ran.stdout) : []
}

async function readProcesses($: Engine, pids: number[]) {
  const now = await $.clock.now()
  const key = [...pids].sort((a, b) => a - b).join(',')
  if (procCache && procCache.pids === key && now - procCache.at < PROC_TTL_MS) return procCache.procs
  procsInFlight ??= queryProcesses($, pids).finally(() => (procsInFlight = undefined))
  const procs = await procsInFlight
  procCache = { at: now, pids: key, procs }
  return procs
}

// Local facts per app session id; undefined when this machine does not give them up.
export async function readLocal($: Engine): Promise<Map<string, LocalInfo> | undefined> {
  try {
    const registered = await readRegistry($)
    const procs = await readProcesses($, registered.map(one => one.pid))
    const alive = new Set(procs.map(one => one.pid))
    const out = new Map<string, LocalInfo>()
    for (const one of registered) {
      if (!alive.has(one.pid)) continue
      out.set(one.hostId, {
        pid: one.pid,
        status: one.status,
        isBusy: one.status === 'busy',
        cliId: one.cliId,
        cwd: one.cwd,
        tasks: tasksUnder(procs, one.pid, PROC_MARKER),
      })
    }
    return out
  } catch {
    return undefined
  }
}

// `messages`: what each button sends when pressed, beside its label.
export type Choice = { ask: string; options: string[]; messages: string[] }

// A prompt a hook dropped (transprompt holding a prompt for approval, say): the session waits on
// the person until a prompt of theirs goes through.
export type Block = { blocked: string }

// A transcript line where a hook dropped the person's prompt, with the hook's reason.
export function blockOf(line: string): Block | undefined {
  try {
    const entry = JSON.parse(line) as { type?: unknown; promptSubmitEnding?: { ending?: { kind?: unknown; reason?: unknown } } }
    const ending = entry.promptSubmitEnding?.ending
    if (entry.type !== 'system' || ending?.kind !== 'dropped_by_hook') return undefined
    return { blocked: typeof ending.reason === 'string' && ending.reason.trim() ? ending.reason.trim() : '훅이 프롬프트를 막음' }
  } catch {
    return undefined
  }
}

// A transcript line's next-step box: the `wrap_up` call's question and its buttons' labels.
export function choiceOf(line: string): Choice | undefined {
  try {
    const entry = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } }
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return undefined
    for (const block of entry.message.content as { type?: unknown; name?: unknown; input?: unknown }[]) {
      if (block.type !== 'tool_use' || block.name !== 'mcp__ccd_turn__wrap_up') continue
      const input = block.input as { ask?: unknown; actions?: unknown }
      if (typeof input.ask !== 'string' || !input.ask.trim()) return undefined
      const options: string[] = []
      const messages: string[] = []
      for (const one of Array.isArray(input.actions) ? input.actions : []) {
        const action = one as { label?: unknown; action?: unknown; message?: unknown }
        const label = typeof action.label === 'string' ? action.label : typeof action.action === 'string' ? action.action : undefined
        if (!label) continue
        options.push(label)
        messages.push(typeof action.message === 'string' && action.message.trim() ? action.message : label)
      }
      return { ask: input.ask.trim(), options, messages }
    }
  } catch {
    return undefined
  }
  return undefined
}

// Claude Code keeps a session's transcript under its working folder, spelled with every
// character other than a letter or digit as a dash.
export const projectDirName = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

// Keyed by transcript path; a scan already under way is shared by refreshes that overlap it.
const choiceCache = new Map<string, { mtimeMs: number; at: number; choice: Promise<Choice | Block | undefined> }>()
const CHOICE_SCAN_MS = 10_000

// What a session's transcript leaves waiting on the person, newest first: a next-step box or a
// prompt a hook dropped. Found by PowerShell so the radar never holds the whole file (they run to
// megabytes).
export async function readChoice($: Engine, info: LocalInfo): Promise<Choice | Block | undefined> {
  if (!info.cliId || !info.cwd) return undefined
  const path = `${await configDir($)}\\projects\\${projectDirName(info.cwd)}\\${info.cliId}.jsonl`
  try {
    const { mtimeMs } = await $.fs.stat(path)
    const now = await $.clock.now()
    const cached = choiceCache.get(path)
    // A transcript that keeps changing (shells finishing one after another, each leaving a note) is
    // scanned again at most this often; what it last showed stands until then.
    if (cached && (cached.mtimeMs === mtimeMs || now - cached.at < CHOICE_SCAN_MS)) return await cached.choice
    const choice = scanChoice($, path)
    choiceCache.set(path, { mtimeMs, at: now, choice })
    return await choice
  } catch {
    return undefined
  }
}

async function scanChoice($: Engine, path: string): Promise<Choice | Block | undefined> {
  try {
    const ran = await timed('scan', () => $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', choiceScript(path)], { timeoutMs: 20_000 }))
    const line = ran.exitCode === 0 ? ran.stdout.trim() : ''
    return line ? (blockOf(line) ?? choiceOf(line)) : undefined
  } catch {
    return undefined
  }
}

// Prints the newest next-step box or hook-dropped prompt, unless the person wrote after it. Notes
// the harness puts in a user turn (a task's notice, a sub-session's report) come wrapped in a tag
// and do not count: a box stays up through them, as it does in the app. A drop is the harness's
// own system line; a message that only quotes one (its quotes escaped) does not match.
export function choiceScript(path: string) {
  return [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$p = '${path.replace(/'/g, "''")}'`,
    `$hit = Select-String -LiteralPath $p -Pattern '"name":"mcp__ccd_turn__wrap_up"', '"kind":"dropped_by_hook"' -SimpleMatch -Encoding UTF8 |`,
    // An assistant line names its type after its content, so the two are matched apart.
    `  Where-Object { ($_.Line -like '*"type":"assistant"*' -and $_.Line -like '*"name":"mcp__ccd_turn__wrap_up"*') -or $_.Line -like '*"type":"system","subtype":"informational"*"promptSubmitEnding":{*' } | Select-Object -Last 1`,
    'if (-not $hit) { return }',
    '$answered = $false',
    `Select-String -LiteralPath $p -Pattern '"type":"user"' -SimpleMatch -Encoding UTF8 | Where-Object { $_.LineNumber -gt $hit.LineNumber } | ForEach-Object {`,
    '  try { $o = $_.Line | ConvertFrom-Json } catch { return }',
    "  if ($o.type -ne 'user' -or $o.isMeta) { return }",
    '  $c = $o.message.content',
    "  if ($c -is [string]) { if (-not $c.TrimStart().StartsWith('<')) { $answered = $true } }",
    "  else { foreach ($b in $c) { if ($b.type -eq 'text' -and $b.text -and -not $b.text.TrimStart().StartsWith('<')) { $answered = $true } } }",
    '}',
    'if (-not $answered) { $hit.Line }',
  ].join('\n')
}
