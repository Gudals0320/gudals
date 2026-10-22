// 프롬프트가 음성 받아쓰기(STT)로 들어왔는지 점수로 추정한다.
// 엔진은 받아쓰기 여부를 알려 주지 않으므로, 텍스트의 말투와 입력창에 들어온 방식을 근거로 삼는다.

// 입력창 편집에서 모은 글자 수: 키 하나씩 친 것과 한 번에 덩어리로 들어온 것(붙여넣기, 받아쓰기 도구).
export type EditStats = { keyed: number; keyless: number }

export type VoiceVerdict = { isVoice: boolean; score: number; reasons: string[] }

const FILLERS = new Set([
  '어', '음', '아', '그', '저', '저기', '뭐', '막', '좀', '약간', '이제', '그냥', '근데',
  '그러니까', '그니까', '뭔가', '그거', '이거', '그런', '이런', '일단', '사실', '진짜',
])
const CONNECTIVES = /(그리고|그래서|근데|그러면|그런데|그러니까|아니면)/g
const SPOKEN_ENDINGS = /(거든|잖아|거야|거지|는데|말이야|같아|좋겠어|싶어|해\s?줘|하고)(?=[\s.,?!]|$)/g
const PUNCTUATION = /[.?!,]/g

function countMatches(text: string, re: RegExp) {
  return text.match(re)?.length ?? 0
}

// 받아쓰기로는 잘 안 나오는 것들: 코드펜스, 백틱, 마크다운 줄머리, 경로, 코드 기호.
function markerKinds(text: string) {
  const kinds = [
    /```/,
    /`[^`\n]+`/,
    /^\s*(#{1,6}\s|[-*]\s|\d+\.\s)/m,
    /[A-Za-z]:\\|\w\/\w+\.\w+|\.\/\w/,
    /=>|[{};]|\(\)|--\w/,
  ]

  return kinds.filter(re => re.test(text)).length
}

export function judgeVoice(text: string, edits: EditStats, threshold: number): VoiceVerdict {
  const reasons: string[] = []
  let score = 0
  const add = (points: number, reason: string) => {
    score += points
    reasons.push(`${points > 0 ? '+' : ''}${points} ${reason}`)
  }

  // 키보드로 한 글자씩 친 흔적은 말투보다 확실하다: 그 경우는 점수와 상관없이 타이핑이다.
  let isKeyboard = false
  const typedTotal = edits.keyed + edits.keyless
  if (typedTotal >= 5) {
    const keylessRatio = edits.keyless / typedTotal
    if (keylessRatio >= 0.8) {
      add(2, '입력창에 한 번에 들어옴')
    } else if (keylessRatio <= 0.2) {
      isKeyboard = true
      reasons.push('키보드로 한 글자씩 입력됨 (타이핑으로 확정)')
    }
  }

  const lines = text.trim().split('\n').length - 1
  if (lines >= 3) {
    add(-2, `줄바꿈 ${lines}개`)
  } else if (lines >= 1) {
    add(-1, `줄바꿈 ${lines}개`)
  }

  const markers = markerKinds(text)
  if (markers >= 3) {
    add(-2, '코드/마크다운 기호 많음')
  } else if (markers >= 1) {
    add(-1, '코드/마크다운 기호 있음')
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

  if (text.length >= 80 && countMatches(text, PUNCTUATION) * 60 < text.length) {
    add(1, '긴 글에 문장부호 거의 없음')
  }

  return { isVoice: !isKeyboard && score >= threshold, score, reasons }
}
