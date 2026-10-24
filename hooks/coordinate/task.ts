// coord 하위 세션의 작업 명세를 찾고 해석한다. 엔진에 의존하지 않는 순수 함수만 둔다.

export type Task = {
  name: string
  owns: string[]
  base: string
  plan: string
  verify: string
  model: string
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

// 작업 파일: 맨 앞 `---` 블록에 owns(쉼표 구분 glob), base, plan, verify(검증 명령), model(하위 세션 모델 id)을 두고,
// 나머지는 브리프 본문이다.
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
    verify: field('verify'),
    model: field('model'),
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

// opencodex가 다른 제공자로 보내는 모델. 하네스는 Claude라고 표시하지만 실제 모델은 다르다.
export const isRoutedModel = (model: string): boolean => /^ocx-/i.test(model.trim())

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

// 메인 세션의 상태 파일. 커밋하지 않는다. 있으면 그 세션이 coord 메인이다.
export const STATE_PATH = '.coord/state.md'

export const isCoordBranch = (branch: string | null): boolean => branch !== null && /(^|\/)coord-/.test(branch)

export const hasReportPrefix = (message: string): boolean => {
  const first = message.split(/\r?\n/).find(line => line.trim() !== '')?.trim() ?? ''

  return REPORT_PREFIXES.some(prefix => first.replace(/^[*_`#\s]+/, '').startsWith(prefix))
}

// 라우팅된 모델(ocx-*)에게만 붙이는 안내. 하네스가 보여주는 모델명과 실제 모델이 다르다.
const routedNotes = (model: string): string => `
## 이 세션의 모델
이 세션은 opencodex 프록시를 거쳐 \`${model}\`로 돈다. 하네스가 Claude 모델명을 표시해도 실제 모델은 이것이다.
- \`claude-api\` 스킬은 호출하지 않는다. 라우팅된 모델에는 그 문서 묶음이 빠져 있다.
- 이미지 입력이 없다. 스크린샷을 읽어야 하면 \`BLOCKED\`로 보고하고, 확인은 텍스트 출력(명령 결과, 파일 내용)으로 한다.
- 범위 밖 발견·막힘·불확실은 즉흥으로 우회하지 않고 멈춰서 보고한다. 보고는 비용이 아니다.
`

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

## 검증: 2회 규칙
검증 명령: ${task.verify ? `\`${task.verify}\`` : '(지정 없음 — 완료 기준에 적힌 명령을 검증 명령으로 삼는다)'}
- 변경을 마칠 때마다 검증 명령만 돌린다. 전체 테스트·빌드·CI는 돌리지 않는다. 그것은 메인이 병합 뒤에 한다.
- 실패하면 한 번 고치고 다시 돌린다. 두 번째도 실패하면 더 시도하지 말고 \`BLOCKED\`로 보고한다.
- 그 보고에는 다음을 넣는다: 바꾼 파일 목록, 에러 원문(요약하지 않는다), 시도한 것 두 줄, 의심 지점 한 줄. 메인이 디프에서부터 이어간다.
- 검증 명령 자체가 잘못됐다고 보이면(없는 파일, 없는 스크립트) 고치지 말고 \`BLOCKED\`로 보고한다.
${isRoutedModel(task.model) ? routedNotes(task.model) : ''}
## 인계 메모
다른 작업이 알아야 할 것(정한 이름·앵커, 가정, 범위 밖에서 발견한 문제)은 \`${notesPath(task)}\`에 적고 커밋한다. 보고에는 요약만 쓴다.

## 보고
턴을 끝낼 때 wrap_up의 recap과 마지막 메시지 첫 줄을 모두 다음 중 하나로 시작한다. 지키지 않으면 거부되거나 턴이 끝나지 않는다.
- \`DONE: <한 줄 요약>\`
- \`BLOCKED: <무엇이 필요한지>\`
- \`PLAN-CHANGE: <무엇을 왜 바꿔야 하는지>\`
그 아래: 한 일, 완료 기준별 확인 결과(검증 명령의 마지막 결과 포함), 브랜치 이름. 검증이 두 번 실패했으면 위 검증 절의 항목을 붙여 BLOCKED로 보고한다.

## 작업 명세
${task.body}
`

// 메인 세션에 매 요청 붙는 절. 스킬 본문이 압축으로 사라져도 조율·취합을 이어갈 수 있을 만큼만 담는다.
export const composeMainSection = (state: string): string => `# coord 메인 세션

이 세션은 coord 조율을 맡은 메인이다. 스킬 본문이 대화에서 사라졌어도(압축, 새로 연 세션) 이 절과 \`${STATE_PATH}\`로 조율과 취합을 이어간다. 이 지시는 매 요청 다시 붙는다.

## 역할
- 메인은 계획·판단·취합만 한다. 코드는 쓰지 않는다. 커밋은 공통 기반과 취합만 한다.
- 하위 세션의 작업 명세는 \`.coord/tasks/<이름>.md\`, 계획은 상태 파일의 plan 항목이다.
- 기다린다. 폴링하거나 "끝났나요?"를 보내지 않는다. 하위 세션이 턴을 끝내면 앱이 메인을 깨운다.

## 상태 파일 \`${STATE_PATH}\`
- 전이가 일어나면 바로 갱신한다: 세션 시작(id), 보고 수신(상태와 첫 줄), 사용자 승인, 병합 완료, 차수 전환. 대화에만 둔 결정은 압축되면 사라진다.
- 상태 파일과 현실이 다르면 \`list_sessions\` {"linked": true}와 \`git branch --list '*coord-*'\`로 맞춘 뒤 진행한다.
- 커밋하지 않는다.

## 보고 처리
- 알림은 400자에서 잘린다. 첫 줄의 상태만 보고 판단하고, 전문이 필요하면 \`list_events\`를 limit 2–4로 그 세션만 읽는다.
- \`BLOCKED\`: 메인이 답할 수 있으면 \`SendMessage\`로 답한다. 사용자만 답할 수 있으면 묻고 답을 그대로 인용해 전달한다. 검증 2회 실패로 온 것은 원인을 알면 한 줄 지시로 되돌리고, 모르면 그 브랜치를 직접 받아 디프에서 이어간다. 세 번째 시도를 시키지 않는다.
- \`PLAN-CHANGE\`: 다른 세션에 영향이 있으면 사용자에게 확인받고, 계획 파일을 고쳐 커밋한 뒤 영향받는 세션에 \`SendMessage\`로 보낸다.
- 범위 밖 문제: 담당 세션에 전달한다. 담당이 없으면 사용자에게 알린다.
- 한 세션이 실패해도 나머지는 계속 둔다.

## 취합
- 보고를 믿지 않는다. 브랜치마다 검사를 서브에이전트에 맡기고 판정 한 줄만 받는다: 변경 파일이 owns와 인계 메모 안에 있는지, 그 세션의 워크트리에서 verify 결과가 어떤지. 메인은 \`git diff --stat\`까지만 직접 본다. 전체 diff를 메인 컨텍스트에 넣지 않는다.
- 병합은 상태 파일에 승인이 기록돼 있을 때만 한다. \`refs/heads/<브랜치>\`를 의존이 적은 순서로 하나씩 병합하고, 병합마다 테스트를 돌린다. 승인이 없으면 브랜치 목록과 상태만 보고한다.
- 소유 범위 위반에서 온 충돌은 고치지 않고 사용자에게 보고한다.
- 다음 차수: 앞 차수를 모두 병합하고 빌드를 확인한 뒤, 계획 파일의 공유 식별자를 갱신하고, 작업 파일을 커밋하고, 세션을 띄운다. \`source_branch\`는 지금 브랜치다.
- 모두 끝나면 \`.coord/\`를 지우는 커밋을 제안한다.

## 현재 상태 (\`${STATE_PATH}\` 그대로)
${state.trim()}
`
