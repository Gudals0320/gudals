import { expect, mock, test } from 'claude-code/testing'

import { stripEmphasis } from '../hooks/transprompt/register'

const RAW =
  '어 그러니까 내가 하고 싶은 거는 음 로그인 페이지를 좀 고치고 싶은데 뭐 비밀번호 찾기 버튼이 안 보이거든 그거를 좀 보이게 해 주고 ' +
  '그리고 또 하나는 에러 메시지가 영어로 나오는데 그거를 한국어로 바꿔 줬으면 좋겠어 그리고 테스트도 같이 돌려 줘'
const STRUCTURED = '# 로그인 페이지 수정\n\n## 요청 사항\n\n1. 비밀번호 찾기 버튼을 **보이게** 한다\n2. 에러 메시지를 *한국어로* 바꾼다\n3. 테스트를 돌린다'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

type Engine = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]

test('stripEmphasis removes bold and italic but keeps bullets and code', () => {
  expect(stripEmphasis('* item **bold** and *it* `a*b*c` __u__ _i_ snake_case_name')).toBe(
    '* item bold and it `a*b*c` u i snake_case_name',
  )
  expect(stripEmphasis('```markdown\n# T\n- a\n```')).toBe('# T\n- a')
})

// 세션을 열고, 보내진 프롬프트를 sent에 모은다. completion은 구조화 모델의 답이다.
async function start($: Engine, on: On, sent: string[], completion: unknown) {
  on('model.complete', () => ({ value: completion }))
  on('command.register', () => ({ value: { command: 'transprompt' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

const ANSWERED = { isAnswered: true, text: STRUCTURED, usage: USAGE }

test('/transprompt with text structures it and sends it at once', async ($, on) => {
  const sent: string[] = []
  const clock = mock.clock(on)
  await start($, on, sent, ANSWERED)

  const answer = await $.command.run({ command: 'transprompt', args: RAW })
  expect(answer.text ?? '').toBe('')
  await clock.settle()

  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('# 로그인 페이지 수정')
  expect(sent[0]).not.toContain('**')
})

test('a long dictated prompt is no longer intercepted on its own', async ($, on) => {
  const sent: string[] = []
  const clock = mock.clock(on)
  await start($, on, sent, ANSWERED)

  const result = await $.prompt.submit({ text: RAW, wait: false, origin: { kind: 'composer' } })
  await clock.settle()

  expect(result.drop).toBeUndefined()
  expect(sent).toEqual([RAW])
})

test('when structuring fails, the original is sent instead', async ($, on) => {
  const sent: string[] = []
  const clock = mock.clock(on)
  await start($, on, sent, { isAnswered: false, reason: 'aborted', usage: USAGE })

  await $.command.run({ command: 'gudals:transprompt', args: RAW })
  await clock.settle()

  expect(sent).toEqual([RAW])
})

test('an empty command explains itself, and a retired option word is not sent', async ($, on) => {
  const sent: string[] = []
  const clock = mock.clock(on)
  await start($, on, sent, ANSWERED)

  const empty = await $.command.run({ command: 'transprompt', args: '  ' })
  expect(empty.text).toContain('구조화할 내용을')

  const retired = await $.command.run({ command: 'gudals:transprompt', args: 'status' })
  expect(retired.text).toContain('옵션은 없어졌습니다')
  await clock.settle()
  expect(sent).toEqual([])
})
