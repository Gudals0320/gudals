import { expect, test } from 'claude-code/testing'
import { composeMainSection, composeSection, forbiddenGit, hasReportPrefix, isCoordBranch, isOwned, isRoutedModel, parseTask, repoRootFromGitdir, taskNameFromBranch } from '../hooks/coordinate/task'

const CWD = 'C:/repo/.claude/worktrees/coord-auth-x1'
const TASK = `---
owns: src/auth/**, tests/auth/*.ts
base: main
plan: docs/plan.md
---
## 작업
auth 모듈 구현
`

const ROUTED_TASK = TASK.replace('plan: docs/plan.md', ['plan: docs/plan.md', 'verify: npx vitest run tests/auth', 'model: ocx-claude-deepseek--deepseek-flash'].join(String.fromCharCode(10)))

const FILES: Record<string, string> = {
  [`${CWD}/.git`]: 'gitdir: C:/repo/.git/worktrees/coord-auth-x1',
  'C:/repo/.git/worktrees/coord-auth-x1/HEAD': 'ref: refs/heads/gudals/coord-auth-x1\n',
  [`${CWD}/.coord/tasks/auth.md`]: TASK,
}

test('branch picks the longest matching task name', () => {
  expect(taskNameFromBranch('gudals/coord-auth-ui-x1', ['auth', 'auth-ui'])).toBe('auth-ui')
  expect(taskNameFromBranch('gudals/coord-auth-x1', ['auth', 'auth-ui'])).toBe('auth')
  expect(taskNameFromBranch('feature/auth-work', ['auth'])).toBe(null)
})

test('ownership follows the globs and refuses .coord and outside paths', () => {
  const task = parseTask('auth', TASK)

  expect(isOwned(task, CWD, `${CWD}/src/auth/login.ts`)).toBe(true)
  expect(isOwned(task, CWD, `${CWD}\\src\\auth\\deep\\x.ts`)).toBe(true)
  expect(isOwned(task, CWD, `${CWD}/tests/auth/a.ts`)).toBe(true)
  expect(isOwned(task, CWD, `${CWD}/tests/auth/sub/a.ts`)).toBe(false)
  expect(isOwned(task, CWD, `${CWD}/src/billing/x.ts`)).toBe(false)
  expect(isOwned(task, CWD, `${CWD}/.coord/tasks/auth.md`)).toBe(false)
  expect(isOwned(task, CWD, `${CWD}/.coord/notes/auth.md`)).toBe(true)
  expect(isOwned(task, CWD, `${CWD}/.coord/notes/billing.md`)).toBe(false)
})

test('outside its worktree, only the same repository is refused', () => {
  const task = parseTask('auth', TASK)
  const root = repoRootFromGitdir('C:/repo/.git/worktrees/coord-auth-x1')

  expect(root).toBe('C:/repo')
  expect(isOwned(task, CWD, 'C:/repo/src/auth/x.ts', root)).toBe(false)
  expect(isOwned(task, CWD, 'C:/repo/.claude/worktrees/coord-billing-y2/src/x.ts', root)).toBe(false)
  expect(isOwned(task, CWD, 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\x\\scratchpad\\check.py', root)).toBe(true)
  expect(isOwned(task, CWD, 'C:/elsewhere/tool.py', root)).toBe(true)
})

test('git rules block push, merge, moving to base and new branches', () => {
  expect(forbiddenGit('git push origin HEAD', 'main')).not.toBe(null)
  expect(forbiddenGit('git merge main', 'main')).not.toBe(null)
  expect(forbiddenGit('git checkout main', 'main')).not.toBe(null)
  expect(forbiddenGit('git switch -c main', 'main')).not.toBe(null)
  expect(forbiddenGit('git checkout -b coord-l02', 'main')).not.toBe(null)
  expect(forbiddenGit('git switch --create coord-l02', 'main')).not.toBe(null)
  expect(forbiddenGit('git branch coord-l02', 'main')).not.toBe(null)
  expect(forbiddenGit('git branch -m new-name', 'main')).not.toBe(null)
  expect(forbiddenGit('git worktree add ../x', 'main')).not.toBe(null)
  expect(forbiddenGit('git checkout maintenance', 'main')).toBe(null)
  expect(forbiddenGit('git checkout -- src/a.ts', 'main')).toBe(null)
  expect(forbiddenGit('git branch --show-current', 'main')).toBe(null)
  expect(forbiddenGit('git branch', 'main')).toBe(null)
  expect(forbiddenGit('git branch -a', 'main')).toBe(null)
  expect(forbiddenGit('git commit -m "x" && git status', 'main')).toBe(null)
})

test('verify and model are optional frontmatter fields', () => {
  const plain = parseTask('auth', TASK)
  const routed = parseTask('auth', ROUTED_TASK)

  expect(plain.verify).toBe('')
  expect(plain.model).toBe('')
  expect(routed.verify).toBe('npx vitest run tests/auth')
  expect(routed.model).toBe('ocx-claude-deepseek--deepseek-flash')
  expect(isRoutedModel(routed.model)).toBe(true)
  expect(isRoutedModel('sonnet')).toBe(false)
  expect(isRoutedModel('')).toBe(false)
})

test('the brief carries the two-strike verify rule, and routed notes only for ocx models', () => {
  const plain = composeSection(parseTask('auth', TASK))
  const routed = composeSection(parseTask('auth', ROUTED_TASK))

  expect(plain).toContain('## 검증: 2회 규칙')
  expect(plain).toContain('지정 없음')
  expect(plain).not.toContain('## 이 세션의 모델')
  expect(routed).toContain('`npx vitest run tests/auth`')
  expect(routed).toContain('## 이 세션의 모델')
  expect(routed).toContain('ocx-claude-deepseek--deepseek-flash')
  expect(routed).toContain('claude-api')
})

test('the main section carries the coordination rules and the state file as written', () => {
  const state = ['# coord 상태', '- 병합 승인: 받음 (머지해도 됨)', '| auth | local_1 | gudals/coord-auth-x1 | DONE | DONE: auth 끝 |'].join(String.fromCharCode(10))
  const text = composeMainSection(state)

  expect(isCoordBranch('gudals/coord-auth-x1')).toBe(true)
  expect(isCoordBranch('main')).toBe(false)
  expect(isCoordBranch(null)).toBe(false)
  expect(text).toContain('# coord 메인 세션')
  expect(text).toContain('.coord/state.md')
  expect(text).toContain('서브에이전트에 맡기고')
  expect(text).toContain('머지해도 됨')
  expect(text).toContain('local_1')
})

test('report prefix is read from the first non-empty line', () => {
  expect(hasReportPrefix('\nDONE: auth 끝')).toBe(true)
  expect(hasReportPrefix('**BLOCKED:** env 필요')).toBe(true)
  expect(hasReportPrefix('작업을 마쳤습니다.\nDONE: x')).toBe(false)
})

test('in a coord worktree, edits outside ownership are denied and git push is blocked', async ($, on) => {
  on('session.cwd', () => ({ value: CWD }))
  on('fs.read', (_, e) => {
    const path = e.path.replace(/\\/g, '/')

    return path in FILES ? { value: FILES[path]! } : { deny: 'missing' }
  })
  on('fs.list', () => ({ value: [{ name: 'auth.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const inside = await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/auth/a.ts`, old_string: 'a', new_string: 'b' })
  const outside = await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/billing/a.ts`, old_string: 'a', new_string: 'b' })
  const push = await $.tool.call({ tool: 'Bash', command: 'git push' })

  expect('deny' in inside).toBe(false)
  expect(JSON.stringify(outside)).toContain('소유 범위 밖')
  expect(JSON.stringify(push)).toContain('coordinate:')
})

test('a main checkout with a state file gets the main section and no guards', async ($, on) => {
  const ROOT = 'C:/repo'
  const MAIN_FILES: Record<string, string> = {
    [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/main' + String.fromCharCode(10),
    [`${ROOT}/.coord/state.md`]: ['# coord 상태', '- 차수: 1 / 1', '| auth | local_9 | gudals/coord-auth-x1 | 진행 중 | |'].join(String.fromCharCode(10)),
  }

  on('session.cwd', () => ({ value: ROOT }))
  on('fs.read', (_, e) => {
    const path = e.path.replace(/\\/g, '/')

    return path in MAIN_FILES ? { value: MAIN_FILES[path]! } : { deny: 'missing' }
  })
  on('fs.list', () => ({ deny: 'missing' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })

  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const push = await $.tool.call({ tool: 'Bash', command: 'git push' })
  const edit = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/anything.ts`, old_string: 'a', new_string: 'b' })

  expect(sections.map(s => s.id)).toEqual(['gudals:coordinate-main'])
  expect(sections[0]!.text).toContain('local_9')
  expect(JSON.stringify(push)).not.toContain('coordinate:')
  expect(JSON.stringify(edit)).not.toContain('coordinate:')
})

test('in a coord worktree the child section wins even if a state file is present', async ($, on) => {
  const withState = { ...FILES, [`${CWD}/.coord/state.md`]: '# coord 상태' }

  on('session.cwd', () => ({ value: CWD }))
  on('fs.read', (_, e) => {
    const path = e.path.replace(/\\/g, '/')

    return path in withState ? { value: withState[path]! } : { deny: 'missing' }
  })
  on('fs.list', () => ({ value: [{ name: 'auth.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })

  expect(sections.map(s => s.id)).toEqual(['gudals:coordinate'])
})

test('outside a coord worktree nothing is guarded', async ($, on) => {
  on('session.cwd', () => ({ value: 'C:/other' }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('fs.list', () => ({ deny: 'missing' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: 'C:/other', surface: 'desktop', isInteractive: true })

  const push = await $.tool.call({ tool: 'Bash', command: 'git push' })

  expect(JSON.stringify(push)).not.toContain('coordinate:')
})

const inWorktree = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('session.cwd', () => ({ value: CWD }))
  on('fs.read', (_, e) => {
    const path = e.path.replace(/\\/g, '/')

    return path in FILES ? { value: FILES[path]! } : { deny: 'missing' }
  })
  on('fs.list', () => ({ value: [{ name: 'auth.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('the task brief is added to the system prompt', async ($, on) => {
  inWorktree(on)
  on('prompt.compose', () => ({ sections: [] }))

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })

  expect(sections.map(s => s.id)).toEqual(['gudals:coordinate'])
  expect(sections[0]!.text).toContain('auth 모듈 구현')
})

test('stop is sent back once without a report prefix', async ($, on) => {
  inWorktree(on)
  on('classic.Stop', () => ({}))

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const bare = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: '끝났습니다.' })
  const again = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: '끝났습니다.' })
  const done = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'DONE: auth 구현' })

  expect(bare.block).toContain('DONE:')
  expect(again.block).toBe(undefined)
  expect(done.block).toBe(undefined)
})

test('a load marker is written to the worktree git folder once, at the first request', async ($, on) => {
  const written: string[] = []

  inWorktree(on)
  on('prompt.compose', () => ({ sections: [] }))
  on('fs.write', (_, e) => {
    written.push(e.path.replace(/\\/g, '/'))

    return { value: undefined }
  })

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const compose = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }

  await $.prompt.compose(compose)
  await $.prompt.compose(compose)

  expect(written).toEqual(['C:/repo/.git/worktrees/coord-auth-x1/coord-loaded'])
})

test('wrap_up is refused until the recap leads with a status', async ($, on) => {
  inWorktree(on)
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const plain = await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: '작업을 마쳤습니다.' })
  const status = await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'DONE: auth 구현' })

  expect(JSON.stringify(plain)).toContain('recap')
  expect(JSON.stringify(status)).not.toContain('coordinate:')
})
