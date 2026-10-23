import type { EngineInterface, Register } from 'claude-code'
import {
  branchFromHead,
  composeSection,
  forbiddenGit,
  gitdirFromDotGit,
  hasReportPrefix,
  isOwned,
  LOADED_MARKER,
  parseTask,
  repoRootFromGitdir,
  REPORT_PREFIXES,
  taskNameFromBranch,
  type Task,
} from './task'

type Found = { task: Task; cwd: string; gitdir: string; repoRoot: string | null } | null

// 모든 세션이 이 mod를 읽으므로, 브랜치가 `coord-<이름>`이고 `.coord/tasks/<이름>.md`가 있을 때만 켜진다.
const findTask = async ($: EngineInterface): Promise<Found> => {
  const cwd = await $.session.cwd()
  const read = (path: string) => $.fs.read(path).then(String, () => null)

  const dotGit = await read(`${cwd}/.git`)
  const linked = dotGit === null ? `${cwd}/.git` : gitdirFromDotGit(dotGit)
  const gitdir = linked === null ? null : /^([a-zA-Z]:)?[\\/]/.test(linked) ? linked : `${cwd}/${linked}`
  const head = gitdir === null ? null : await read(`${gitdir}/HEAD`)
  const branch = head === null ? null : branchFromHead(head)

  if (branch === null || !/(^|\/)coord-/.test(branch)) return null

  const entries = await $.fs.list(`${cwd}/.coord/tasks`).catch(() => [])
  const names = entries.filter(f => f.kind === 'file' && f.name.endsWith('.md')).map(f => f.name.slice(0, -3))
  const name = taskNameFromBranch(branch, names)
  const text = name === null ? null : await read(`${cwd}/.coord/tasks/${name}.md`)

  if (name === null || text === null || gitdir === null) return null

  return { task: parseTask(name, text), cwd, gitdir, repoRoot: repoRootFromGitdir(gitdir) }
}

// 처음 찾을 때 한 번만 계산한다. reload 때는 모듈 변수가 비워져 다시 찾는다.
// session.start는 transprompt가 이미 잡고 있어(matcher 없는 훅은 하나만 둘 수 있다) 첫 훅 호출 때 찾는다.
let found: Promise<Found> | undefined

async function locate($: EngineInterface): Promise<Found> {
  const hit = await findTask($)

  // 로드 확인 표시를 워크트리의 git 폴더에 남긴다. 커밋되지 않고, 메인이 `git rev-parse --git-path coord-loaded`로 찾는다.
  if (hit !== null) {
    await $.fs.write(`${hit.gitdir}/${LOADED_MARKER}`, `${hit.task.name}\n`).catch(() => undefined)
  }

  return hit
}

function current($: EngineInterface): Promise<Found> {
  return (found ??= locate($))
}

export const registerCoordinate: Register = on => {
  // 첫 지시문 대신 시스템 프롬프트에 작업 명세를 둔다. 압축돼도 사라지지 않는다.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const hit = await current($)

    if (hit === null) return result

    return { sections: [...result.sections, { id: 'gudals:coordinate', text: composeSection(hit.task), scope: 'session' as const }] }
  })

  for (const tool of ['Edit', 'Write', 'NotebookEdit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const hit = await current($)
      const path = 'notebook_path' in e ? e.notebook_path : e.file_path

      if (hit === null || isOwned(hit.task, hit.cwd, path, hit.repoRoot)) return next(e)

      return { deny: `coordinate: ${path}는 이 작업(${hit.task.name})의 소유 범위 밖이다. 고치지 말고 BLOCKED 또는 보고에 적어라.` }
    }).catch(($, e, next) => (next.called ? next(e) : { deny: 'coordinate: 소유 범위 검사가 실패했다.' }))
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const hit = await current($)
    const why = hit === null ? null : forbiddenGit(e.command, hit.task.base)

    return why === null ? next(e) : { deny: `coordinate: ${why}. 필요하면 보고에 적어라.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'coordinate: git 규칙 검사가 실패했다.' }))

  // 메인에 가는 알림은 recap이 먼저 오므로 recap도 상태로 시작해야 한다.
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const hit = await current($)
    const recap = (e as { recap?: unknown }).recap

    if (hit === null || (typeof recap === 'string' && hasReportPrefix(recap))) return next(e)

    return { deny: `coordinate: recap을 ${REPORT_PREFIXES.join(' / ')} 중 하나로 시작해 다시 호출하라.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'coordinate: recap 검사가 실패했다.' }))

  // 보고 형식이 아니면 한 번 되돌려 보낸다. 백그라운드 작업을 기다리는 중이면 막지 않는다.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const hit = await current($)
    const isWaiting = (e.background_tasks?.length ?? 0) > 0

    if (hit === null || e.stop_hook_active || isWaiting || hasReportPrefix(e.last_assistant_message ?? '')) return result

    return { ...result, block: `coordinate: 마지막 메시지 첫 줄을 ${REPORT_PREFIXES.join(' / ')} 중 하나로 시작해 보고하라.` }
  })
}
