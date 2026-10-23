import { expect, mock, test } from 'claude-code/testing'

import { stripEmphasis } from '../hooks/transprompt/register'

const RAW =
  '어 그러니까 내가 하고 싶은 거는 음 로그인 페이지를 좀 고치고 싶은데 뭐 비밀번호 찾기 버튼이 안 보이거든 그거를 좀 보이게 해 주고 ' +
  '그리고 또 하나는 에러 메시지가 영어로 나오는데 그거를 한국어로 바꿔 줬으면 좋겠어 그리고 테스트도 같이 돌려 줘'
const STRUCTURED = '# 로그인 페이지 수정\n\n## 요청 사항\n\n1. 비밀번호 찾기 버튼을 **보이게** 한다\n2. 에러 메시지를 *한국어로* 바꾼다\n3. 테스트를 돌린다'

const PANE = {
  plugin: 'gudals',
  component: 'Pane',
  requestId: 'transprompt',
  props: {
    title: 'Transprompt',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('stripEmphasis removes bold and italic but keeps bullets and code', () => {
  expect(stripEmphasis('* item **bold** and *it* `a*b*c` __u__ _i_ snake_case_name')).toBe(
    '* item bold and it `a*b*c` u i snake_case_name',
  )
  expect(stripEmphasis('```markdown\n# T\n- a\n```')).toBe('# T\n- a')
})

test('a long voice prompt is held, structured, and sent on approval', { options: { transpromptMinChars: 50, transpromptAuto: false } }, async ($, on) => {
  const sent: string[] = []
  mock.store(on)
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'transprompt' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: STRUCTURED,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const held = await $.prompt.submit({ text: RAW, wait: false, origin: { kind: 'composer' } })
  expect(held.drop).toBeDefined()
  expect(sent).toEqual([])

  // 구조화는 drop 뒤에 따로 돈다: 미리보기가 그려질 때까지 기다린다.
  let isReady = false
  for (let i = 0; i < 100 && !isReady; i++) {
    const probe = await $.ui.mount({ ...PANE, surface: 'desktop' })
    isReady = (await probe.find({ key: 'preview' })) !== undefined
    await probe.unmount()
  }
  expect(isReady).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const preview = await ui.find({ key: 'preview' })
    expect(preview?.text).toContain('비밀번호 찾기 버튼을 보이게 한다')
    expect(preview?.text).not.toContain('**')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'approve' })
  await ui.unmount()

  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('# 로그인 페이지 수정')
  expect(sent[0]).toContain('에러 메시지를 한국어로 바꾼다')
})

test('a short prompt goes straight through', async ($, on) => {
  const sent: string[] = []
  mock.store(on)
  on('command.register', () => ({ value: { command: 'transprompt' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: '테스트 돌려 줘', wait: false, origin: { kind: 'composer' } })

  expect(sent).toEqual(['테스트 돌려 줘'])
})

test('a long typed prompt is not taken for dictation', { options: { transpromptMinChars: 50, transpromptAuto: false } }, async ($, on) => {
  const sent: string[] = []
  mock.store(on)
  on('command.register', () => ({ value: { command: 'transprompt' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const typed = 'hooks/register.tsx에서 `e.attachments` 처리 순서를 고쳐줘.\n테스트도 하나 추가하고, README의 설치 방법도 갱신해줘.'
  await $.prompt.submit({ text: typed, wait: false, origin: { kind: 'composer' } })

  expect(sent).toEqual([typed])
})

test('why explains a prompt skipped for being short', { options: { transpromptMinChars: 50, transpromptAuto: false } }, async ($, on) => {
  mock.store(on)
  on('command.register', () => ({ value: { command: 'transprompt' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const short = '테스트 돌려 줘'
  await $.prompt.submit({ text: short, wait: false, origin: { kind: 'composer' } })

  const why = await $.command.run({ command: 'transprompt', args: 'why' })
  expect(why.text).toContain(`${short.length}자`)
  expect(why.text).toContain('최소 50자')
})

test('why explains a prompt skipped while turned off', { options: { transpromptMinChars: 50, transpromptAuto: false } }, async ($, on) => {
  mock.store(on)
  on('command.register', () => ({ value: { command: 'transprompt' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'transprompt', args: 'off' })
  await $.prompt.submit({ text: RAW, wait: false, origin: { kind: 'composer' } })

  const why = await $.command.run({ command: 'transprompt', args: 'why' })
  expect(why.text).toContain('꺼져 있습니다')
})

test('/gudals:transprompt from the skill answers like /transprompt', { options: { transpromptMinChars: 50, transpromptAuto: false } }, async ($, on) => {
  mock.store(on)
  on('command.register', () => ({ value: { command: 'transprompt' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const off = await $.command.run({ command: 'gudals:transprompt', args: 'off' })
  expect(off.text).toContain('꺼짐')

  const status = await $.command.run({ command: 'transprompt', args: 'status' })
  expect(status.text).toContain('꺼짐')
})

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

type Engine = Parameters<Parameters<typeof test>[1]>[0]
type On = Parameters<Parameters<typeof test>[1]>[1]

// 음성 프롬프트를 붙잡아 구조화를 시작시킨다. 미리보기 패널은 각 테스트가 그린다.
async function holdVoicePrompt($: Engine, on: On, sent: string[] = []) {
  on('command.register', () => ({ value: { command: 'transprompt' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const held = await $.prompt.submit({ text: RAW, wait: false, origin: { kind: 'composer' } })
  expect(held.drop).toBeDefined()
}

// Text는 key를 갖지 않으므로 종류와 글자로 찾는다.
async function findInPane($: Engine, query: { type?: string; key?: string; text?: string }) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const found = await ui.find(query)
  await ui.unmount()

  return found
}

async function pressInPane($: Engine, key: string) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key })
  await ui.unmount()
}

test('the review pane switches between the structured and the original text', { options: { transpromptMinChars: 50, transpromptAuto: false } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: STRUCTURED, usage: USAGE } }))
  await holdVoicePrompt($, on)
  await clock.settle()

  expect((await findInPane($, { key: 'preview' }))?.text).toContain('비밀번호 찾기 버튼을 보이게 한다')
  expect(await findInPane($, { type: 'Text', text: RAW })).toBeUndefined()

  await pressInPane($, 'tab-raw')
  expect(await findInPane($, { type: 'Text', text: RAW })).toBeDefined()
  expect(await findInPane($, { key: 'preview' })).toBeUndefined()

  await pressInPane($, 'tab-structured')
  expect((await findInPane($, { key: 'preview' }))?.text).toContain('에러 메시지를 한국어로 바꾼다')
})

test('the structuring pane counts the seconds since it started', { options: { transpromptMinChars: 50, transpromptAuto: false } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  let answer: (value: unknown) => void = () => {}
  on('model.complete', () => new Promise((resolve) => (answer = resolve)))
  await holdVoicePrompt($, on)
  await clock.settle()

  expect(await findInPane($, { type: 'Text', text: '구조화 중' })).toBeDefined()
  expect(await findInPane($, { type: 'Text', text: '0초 경과' })).toBeDefined()

  await clock.advance(3000)
  expect(await findInPane($, { type: 'Text', text: '3초 경과' })).toBeDefined()

  answer({ value: { isAnswered: true, text: STRUCTURED, usage: USAGE } })
  await clock.settle()
  expect(await findInPane($, { type: 'Text', text: '검토 대기' })).toBeDefined()
})

test('a failed structuring says why in plain words and offers a retry first', { options: { transpromptMinChars: 50, transpromptAuto: false } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  on('model.complete', () => ({
    value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE },
  }))
  await holdVoicePrompt($, on)
  await clock.settle()

  expect(await findInPane($, { type: 'Text', text: '구조화 실패' })).toBeDefined()
  expect(await findInPane($, { type: 'Text', text: '모델이 붐비고 있어요' })).toBeDefined()
  expect((await findInPane($, { key: 'retry' }))?.props).toMatchObject({ variant: 'primary' })
})

test('auto mode, the default, sends the structured prompt without waiting', { options: { transpromptMinChars: 50 } }, async ($, on) => {
  const sent: string[] = []
  const opened: unknown[] = []
  mock.store(on)
  const clock = mock.clock(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: STRUCTURED, usage: USAGE } }))
  on('command.register', () => ({ value: { command: 'transprompt' } }))
  on('ui.open', (_, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const held = await $.prompt.submit({ text: RAW, wait: false, origin: { kind: 'composer' } })
  expect(held.drop).toContain('바로 보냅니다')
  expect(opened.length).toBe(1)
  expect((opened[0] as { focus?: true }).focus).toBeUndefined()

  await clock.settle()
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('# 로그인 페이지 수정')
  expect(sent[0]).not.toContain('**')
  expect(await findInPane($, { key: 'approve' })).toBeUndefined()
})

test('auto mode sends the original when structuring fails', { options: { transpromptMinChars: 50 } }, async ($, on) => {
  const sent: string[] = []
  mock.store(on)
  const clock = mock.clock(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'aborted', usage: USAGE } }))
  await holdVoicePrompt($, on, sent)
  await clock.settle()

  expect(sent).toEqual([RAW])
  expect(await findInPane($, { key: 'retry' })).toBeUndefined()
})

test('/transprompt review asks for approval again, and auto turns it back off', { options: { transpromptMinChars: 50 } }, async ($, on) => {
  const sent: string[] = []
  mock.store(on)
  const clock = mock.clock(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: STRUCTURED, usage: USAGE } }))
  on('command.register', () => ({ value: { command: 'transprompt' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const review = await $.command.run({ command: 'transprompt', args: 'review' })
  expect(review.text).toContain('검토 후 전송')

  await $.prompt.submit({ text: RAW, wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  expect(sent).toEqual([])
  expect(await findInPane($, { key: 'approve' })).toBeDefined()

  const auto = await $.command.run({ command: 'gudals:transprompt', args: 'auto' })
  expect(auto.text).toContain('자동 전송')
})
