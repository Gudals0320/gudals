// 프롬프트가 음성 받아쓰기(STT)로 들어왔는지 점수로 추정한다.
// 엔진은 받아쓰기 여부를 알려 주지 않으므로, 입력창에 들어온 방식과 텍스트의 모양을 근거로 삼는다.
// 마침표는 끊어서 녹음하면 계속 들어가므로 근거로 쓰지 않는다.

// 입력창 편집에서 모은 글자 수: 키 하나씩 친 것과 한 번에 덩어리로 들어온 것(붙여넣기, 받아쓰기 도구).
export type EditStats = { keyed: number; keyless: number }

export type VoiceVerdict = { isVoice: boolean; score: number; reasons: string[] }

const FILLERS = new Set([
  '어', '음', '아', '그', '저', '저기', '뭐', '막', '좀', '약간', '이제', '그냥', '근데',
  '그러니까', '그니까', '뭔가', '그거', '이거', '그런', '이런', '일단', '사실', '진짜',
])
const CONNECTIVES = /(그리고|그래서|근데|그러면|그런데|그러니까|아니면)/g
const SPOKEN_ENDINGS = /(거든|잖아|거야|거지|는데|말이야|같아|좋겠어|싶어|해\s?줘|하고)(?=[\s.,?!]|$)/g
// 스킬 호출(/gudals:write-ko)의 슬래시와 콜론은 판정에서 뺀다.
const SKILL_CALL = /(^|\s)\/[\w-]+(:[\w-]+)?(?=\s|$)/g
// 음성으로는 나올 수 없는 마크다운: 줄머리 헤딩·불릿, 코드펜스.
// 인라인 백틱은 받아쓰기 도구가 넣기도 하므로(VOICE_LONG) 확정 신호로 쓰지 않는다.
const MARKDOWN = [/^\s*#{1,6}\s/m, /^\s*[*-]\s/m, /```/]
const NUMBERED = /(^|\s)\d+\.\s/g
// 받아쓰기로는 잘 안 나오는 코드 흔적: 백틱 코드, 경로, 코드 기호.
const CODE_MARKERS = [/`[^`\n]+`/, /[A-Za-z]:\\|\w\/\w+\.\w+|\.\/\w/, /=>|[{};]|\(\)|--\w/]
// 이 길이 이상인데 줄바꿈이 2개 이하면 한 덩어리로 말한 것으로 본다.
const CHUNK_CHARS = 100

function countMatches(text: string, re: RegExp) {
  return text.match(re)?.length ?? 0
}

export function judgeVoice(input: string, edits: EditStats, threshold: number): VoiceVerdict {
  const text = input.replace(SKILL_CALL, '$1').trim()
  const reasons: string[] = []
  let score = 0
  const add = (points: number, reason: string) => {
    score += points
    reasons.push(`${points > 0 ? '+' : ''}${points} ${reason}`)
  }
  // 확실한 키보드 신호는 점수와 상관없이 타이핑으로 확정한다.
  const confirmed: string[] = []

  const typedTotal = edits.keyed + edits.keyless
  if (typedTotal >= 5) {
    const keylessRatio = edits.keyless / typedTotal
    if (keylessRatio >= 0.8) {
      add(2, '입력창에 한 번에 들어옴')
    } else if (keylessRatio <= 0.2) {
      confirmed.push('키보드로 한 글자씩 입력됨')
    }
  }

  if (MARKDOWN.some(re => re.test(text))) {
    confirmed.push('마크다운 문법 있음')
  }

  // 줄바꿈 1~2개는 Shift+Enter나 끊어 녹음에서도 나오므로 세지 않는다.
  const lines = text.split('\n').length - 1
  if (lines >= 3) {
    add(-2, `줄바꿈 ${lines}개`)
  } else if (text.length >= CHUNK_CHARS) {
    add(1, `${text.length}자가 한 덩어리`)
  }

  const numbered = countMatches(text, NUMBERED)
  if (numbered >= 2) {
    add(-2, `숫자 나열 ${numbered}개`)
  }

  if (CODE_MARKERS.some(re => re.test(text))) {
    add(-1, '코드 기호 있음')
  }

  const hangul = countMatches(text, /[가-힣]/g)
  const latin = countMatches(text, /[A-Za-z]/g)
  if (hangul > 0 && latin / (hangul + latin) < 0.05) {
    add(0.5, '영문 거의 없음')
  } else if (latin / Math.max(1, hangul + latin) > 0.3) {
    add(-1, '영문 비중 높음')
  }

  const words = text.split(/\s+/).filter(Boolean)
  const fillers = words.filter(w => FILLERS.has(w.replace(/[.,?!]/g, ''))).length
  const fillerRate = fillers / Math.max(1, words.length)
  if (fillers >= 2 && fillerRate >= 0.06) {
    add(2, `군말 ${fillers}개`)
  } else if (fillers >= 1 && fillerRate >= 0.03) {
    add(1, `군말 ${fillers}개`)
  }

  const connectives = countMatches(text, CONNECTIVES)
  if (connectives >= 2) {
    add(1, `접속사 ${connectives}개`)
  }

  const endings = countMatches(text, SPOKEN_ENDINGS)
  if (endings >= 2) {
    add(1, `구어체 어미 ${endings}개`)
  }

  for (const reason of confirmed) {
    reasons.push(`${reason} (타이핑으로 확정)`)
  }

  return { isVoice: confirmed.length === 0 && score >= threshold, score, reasons }
}
