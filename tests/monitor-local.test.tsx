import { expect, mock, test } from 'claude-code/testing'

import { describeBackground, innerCommand, parseProcesses, parseRegistry, procQuery, taskOf, tasksUnder } from '../hooks/monitor/local'

const MIN = 60_000
const NOW = Date.UTC(2026, 9, 22, 12, 40)

// A shell as Claude Code starts it on Windows, with the session's command inside `eval '…'`.
const wrap = (command: string) =>
  `"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && export TEMP='C:\\Temp' && eval '${command}' < /dev/null && pwd -P >| /c/Temp/claude-1-cwd"`

const RUN = wrap(`npm run inquiry -- run req-20261022-211912-0e56 > data/logs/run.log 2>&1; echo \\"exit $?\\" >> data/logs/run.log`)
const WATCH = wrap(`touch /c/Workspace/inquiry/data/logs/run.log; tail -n +1 -f /c/Workspace/inquiry/data/logs/run.log | grep -E --line-buffered \\"exit [0-9]|완료\\"`)
const WATCH_NEW = wrap(`tail -n 0 -f /c/Workspace/inquiry/data/logs/eval.log | grep -E --line-buffered \\"오류\\"`)

test('parseRegistry reads the session process note', () => {
  const text = JSON.stringify({ pid: 32440, sessionId: 'c02c', hostSessionId: 'local_a59e', status: 'idle', name: 'M2' })
  expect(parseRegistry(text)).toEqual({ pid: 32440, hostId: 'local_a59e', status: 'idle', cliId: 'c02c', cwd: '' })
  expect(parseRegistry('{"pid":1}')).toBe(undefined)
  expect(parseRegistry('not json')).toBe(undefined)
})

test('innerCommand unwraps the eval and its quoting', () => {
  expect(innerCommand(RUN)).toBe('npm run inquiry -- run req-20261022-211912-0e56 > data/logs/run.log 2>&1; echo "exit $?" >> data/logs/run.log')
  expect(innerCommand(wrap(`echo '\\''hi'\\''`))).toBe(`echo 'hi'`)
})

test('taskOf tells a watch from a command and names each', () => {
  expect(taskOf(RUN, NOW)).toEqual({ kind: 'command', label: 'npm run inquiry -- run req-20261022-211912-0e56', startedAt: NOW })
  expect(taskOf(WATCH, NOW)).toEqual({ kind: 'monitor', label: 'run.log', startedAt: NOW })
  expect(taskOf(WATCH_NEW, NOW)).toEqual({ kind: 'monitor', label: 'eval.log', startedAt: NOW })
  expect(taskOf(wrap('cd /c/app && npm test'), NOW).label).toBe('npm test')
})

test('tasksUnder keeps only the session process own shells, oldest first', () => {
  const procs = parseProcesses(
    JSON.stringify([
      { p: 32440, pp: 1, n: 'claude.exe', c: null, t: null },
      { p: 2, pp: 32440, n: 'bash.exe', c: WATCH, t: new Date(NOW - 5 * MIN).toISOString() },
      { p: 3, pp: 32440, n: 'bash.exe', c: RUN, t: new Date(NOW - 9 * MIN).toISOString() },
      { p: 4, pp: 32440, n: 'conhost.exe', c: null, t: null },
      { p: 5, pp: 99, n: 'bash.exe', c: RUN, t: new Date(NOW).toISOString() },
      { p: 6, pp: 32440, n: 'powershell.exe', c: "$null = 'marker'; Get-CimInstance", t: new Date(NOW).toISOString() },
    ]),
  )
  const tasks = tasksUnder(procs, 32440, 'marker')
  expect(tasks.map(one => one.kind)).toEqual(['command', 'monitor'])
  expect(tasks[0]?.startedAt).toBe(NOW - 9 * MIN)
})

test('parseProcesses takes a lone object as a list of one', () => {
  expect(parseProcesses('{"p":1,"pp":0,"n":"x.exe"}')).toEqual([{ pid: 1, ppid: 0, name: 'x.exe' }])
})

test('describeBackground leads with the command, then the watches', () => {
  const run = { kind: 'command' as const, label: 'npm run inquiry', startedAt: NOW - 12 * MIN }
  const other = { kind: 'command' as const, label: 'npm test', startedAt: NOW - 2 * MIN }
  const watch = { kind: 'monitor' as const, label: 'run.log', startedAt: NOW - 3 * MIN }
  expect(describeBackground([run, watch], NOW)).toBe('백그라운드 · npm run inquiry · 12분째 · 감시 1개')
  expect(describeBackground([run, other], NOW)).toBe('백그라운드 · npm run inquiry 외 1개 · 12분째')
  expect(describeBackground([watch], NOW)).toBe('감시만 남음 · run.log · 3분째')
  expect(describeBackground([], NOW)).toBe(undefined)
})

test('procQuery asks for the session processes and their children only', () => {
  const script = procQuery([12, 345])
  expect(script).toContain('-Filter "ProcessId=12 OR ParentProcessId=12 OR ProcessId=345 OR ParentProcessId=345"')
  expect(script.includes('Get-CimInstance Win32_Process |')).toBe(false)
})
