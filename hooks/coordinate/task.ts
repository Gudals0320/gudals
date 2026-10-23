// coord 하위 세션의 작업 명세를 찾고 해석한다. 엔진에 의존하지 않는 순수 함수만 둔다.

export type Task = {
  name: string
  owns: string[]
  base: string
  plan: string
  body: string
}

export const REPORT_PREFIXES = ['DONE:', 'BLOCKED:', 'PLAN-CHANGE:'] as const

// 앱이 브랜치 이름 앞에 접두어, 뒤에 접미어를 붙이므로 마지막 경로 조각에서 `coord-<이름>`을 찾는다.
export const taskNameFromBranch = (branch: string, names: readonly string[]): string | null => {
  const leaf = branch.split('/').pop() ?? ''
  const matches = names.filter(name => leaf === `coord-${name}` || leaf.startsWith(`coord-${name}-`))

  return matches.sort((a, b) => b.length - a.length)[0] ?? null
}

export const branchFromHead = (head: string): string | null => {
  const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim())

  return match?.[1] ?? null
}

export const gitdirFromDotGit = (dotGit: string): string | null => {
  const match = /^gitdir:\s*(.+)$/m.exec(dotGit.trim())

  return match?.[1]?.trim() ?? null
}

// 작업 파일: 맨 앞 `---` 블록에 owns(쉼표 구분 glob), base, plan을 두고, 나머지는 브리프 본문이다.
export const parseTask = (name: string, text: string): Task => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const head = match?.[1] ?? ''
  const body = (match?.[2] ?? text).trim()
  const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(head)?.[1]?.trim() ?? ''

  return {
    name,
    owns: field('owns').split(',').map(s => s.trim()).filter(Boolean),
    base: field('base') || 'main',
    plan: field('plan') || 'docs/plan.md',
    body,
  }
}

const globToRegExp = (glob: string): RegExp => {
  let out = ''

  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!

    if (c === '*' && glob[i + 1] === '*') {
      out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }

  return new RegExp(`^${out}$`, 'i')
}

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')

// 작업 폴더 기준 상대 경로. 작업 폴더 밖이면 null.
export const relativeTo = (cwd: string, path: string): string | null => {
  const root = normalize(cwd)
  const full = normalize(path)
  const isAbsolute = /^([a-zA-Z]:)?\//.test(full)

  if (!isAbsolute) return full.replace(/^\.\//, '')
  if (full.toLowerCase() === root.toLowerCase()) return ''
  if (!full.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null

  return full.slice(root.length + 1)
}

// 워크트리 경로 `<저장소>/.git/worktrees/<이름>`에서 저장소 루트를 얻는다. 워크트리가 아니면 null.
export const repoRootFromGitdir = (gitdir: string): string | null => {
  const match = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(normalize(gitdir))

  return match?.[1] ?? null
}

export const notesPath = (task: Task) => `.coord/notes/${task.name}.md`

// 자기 워크트리 안: owns와 자기 인계 메모만 허용한다. 같은 저장소의 다른 체크아웃: 거부한다.
// 그 밖(스크래치패드, OS 임시 폴더 등): 허용한다.
export const isOwned = (task: Task, cwd: string, path: string, repoRoot: string | null = null): boolean => {
  const rel = relativeTo(cwd, path)

  if (rel === null) return repoRoot === null || relativeTo(repoRoot, path) === null
  if (rel.toLowerCase() === notesPath(task).toLowerCase()) return true
  if (rel.startsWith('.coord/')) return false

  return task.owns.some(glob => globToRegExp(normalize(glob)).test(rel))
}

// 하위 세션이 하면 안 되는 git 동작: 원격 반영, 병합, 기준 브랜치로 이동, 강제 동작.
export const forbiddenGit = (command: string, base: string): string | null => {
  const rules: [RegExp, string][] = [
    [/\bgit\s+push\b/, '푸시는 메인 세션이 한다'],
    [/\bgit\s+merge\b/, '병합은 메인 세션이 한다'],
    [/\bgit\s+rebase\b/, '리베이스는 메인 세션이 한다'],
    [new RegExp(`\\bgit\\s+(checkout|switch)\\s+(-\\S+\\s+)*${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), `기준 브랜치(${base})로 옮기지 않는다`],
    [/\bgit\s+reset\s+--hard\b/, '되돌릴 수 없는 reset은 하지 않는다'],
    [/\bgit\s+branch\s+(-D|-f|--force)\b/, '브랜치를 강제로 지우거나 옮기지 않는다'],
    [/\bgit\s+(checkout\s+(-\S+\s+)*-[bB]\b|switch\s+(-\S+\s+)*(-[cC]\b|--create\b|--force-create\b))/, '새 브랜치를 만들지 않는다. 지금 브랜치에 커밋한다'],
    [/\bgit\s+branch\s+(-[mMcC]\b|(?!-)[^\s;&|])/, '브랜치를 만들거나 이름을 바꾸지 않는다. 지금 브랜치에 커밋한다'],
    [/\bgit\s+worktree\s+add\b/, '워크트리를 새로 만들지 않는다'],
  ]

  return rules.find(([re]) => re.test(command))?.[1] ?? null
}

export const LOADED_MARKER = 'coord-loaded'

export const hasReportPrefix = (message: string): boolean => {
  const first = message.split(/\r?\n/).find(line => line.trim() !== '')?.trim() ?? ''

  return REPORT_PREFIXES.some(prefix => first.replace(/^[*_`#\s]+/, '').startsWith(prefix))
}

export const composeSection = (task: Task): string => `# coord 하위 세션: ${task.name}

이 세션은 coord 메인 세션이 띄운 하위 작업자다. 아래 작업만 맡는다. 이 지시는 대화가 길어지거나 압축돼도 그대로 유지된다.

## 원칙
- 결과물과 완료 기준이 정해진 자기 작업만 한다.
- 소유 범위 밖의 문제는 직접 고치지 않고 보고한다. 메인 세션이 담당 세션에 전달한다.
- 결과가 계획을 바꾸거나 스스로 해결할 수 없으면 멈추고 보고한다.
- 서브에이전트는 자유롭게 써도 된다.

## 공유 맥락
- 계획 파일: \`${task.plan}\` — 처음에 읽는다.
- 기준 브랜치: \`${task.base}\`
- 수정해도 되는 범위: ${task.owns.length ? task.owns.map(g => `\`${g}\``).join(', ') : '(지정 없음 — 파일 수정 전에 BLOCKED로 보고)'}

## 강제되는 규칙
훅이 막는다. 막히면 우회하지 말고 보고한다.
- 워크트리 안에서 소유 범위 밖 파일 수정(\`.coord/\` 포함). 인계 메모 \`${notesPath(task)}\`는 예외다
- 같은 저장소의 다른 체크아웃(메인 폴더, 다른 워크트리) 수정. 저장소 밖 임시 폴더는 자유롭게 써도 된다
- git push, merge, rebase, 기준 브랜치로 checkout/switch, reset --hard, 브랜치 생성·이름 변경·강제 삭제, worktree add

## 인계 메모
다른 작업이 알아야 할 것(정한 이름·앵커, 가정, 범위 밖에서 발견한 문제)은 \`${notesPath(task)}\`에 적고 커밋한다. 보고에는 요약만 쓴다.

## 보고
턴을 끝낼 때 wrap_up의 recap과 마지막 메시지 첫 줄을 모두 다음 중 하나로 시작한다. 지키지 않으면 거부되거나 턴이 끝나지 않는다.
- \`DONE: <한 줄 요약>\`
- \`BLOCKED: <무엇이 필요한지>\`
- \`PLAN-CHANGE: <무엇을 왜 바꿔야 하는지>\`
그 아래: 한 일, 완료 기준별 확인 결과, 브랜치 이름. 같은 실패를 두 번 겪으면 BLOCKED로 보고한다.

## 작업 명세
${task.body}
`
