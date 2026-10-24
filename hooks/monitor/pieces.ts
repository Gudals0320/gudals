// The radar's small pictures. The desktop lays its own elements out in character cells, while an
// SVG is drawn in CSS pixels, so dots, dashed rails and moving bars live in pictures. Each is sized
// here because a picture cannot measure itself. Clicks stay with real Buttons beside them.
// The dots and the sweep bar move by SVG's own animation (SMIL), which plays inside an image.
// A picture with an empty alt is not drawn at all, so every piece names itself.

// The prototype's palette (the session radar prototype), kept in step with DESIGN.md.
export const C = {
  // The app's own pane colour, so the radar sits in the pane with no edge of its own.
  bg: '#1a1a19',
  panel: '#1d1a15',
  panel2: '#24201a',
  panel3: '#2b261f',
  line: '#2f2a22',
  line2: '#3d3629',
  fg: '#e8e2d6',
  fg2: '#a89f90',
  fg3: '#6f675b',
  fg4: '#4e483f',
  amber: '#e2a34a',
  amberBg: '#3a2a12',
  green: '#5fbf8a',
  greenBg: '#163125',
  teal: '#4fb8b0',
  red: '#e0665a',
  // A prompt a hook dropped: a red that stands out from the warm palette.
  hook: '#ff3b3b',
} as const

// A colour at an opacity over the board, as a solid colour: the desktop's boxes have no opacity,
// so a card the prototype draws at 60% is drawn in the colours it would show.
export function fade(color: string, opacity: number, over: string = C.bg) {
  const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const top = channels(color)
  const under = channels(over)
  return `#${top.map((one, i) => Math.round(one * opacity + (under[i] ?? 0) * (1 - opacity)).toString(16).padStart(2, '0')).join('')}`
}

export type Piece = { svg: string; width: number; height: number; alt: string }

// The four states the board shows. `working` covers a session busy in a turn and one whose
// shells run on after it; `paused` is idle with nothing asked.
// `blocked` waits too, on a prompt a hook dropped, and shows in red. `background`: the session
// stopped, but shells it started still run; nothing about it is live, so it is drawn apart.
export type DotState = 'waiting' | 'blocked' | 'working' | 'background' | 'paused' | 'done'

const FONT = "'Pretendard', 'Noto Sans KR', 'Malgun Gothic', 'Segoe UI', system-ui, sans-serif"
const MONO = "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace"

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)

const svg = (width: number, height: number, alt: string, body: string): Piece => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
  width,
  height,
  alt,
})

// HTML inside a picture, for text that needs CSS: a mono chip, an ellipsis.
function html(width: number, height: number, alt: string, body: string): Piece {
  return svg(
    width,
    height,
    alt,
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:${width}px;height:${height}px;overflow:hidden;` +
      `font-family:${FONT};font-size:12px;line-height:1.4;color:${C.fg}">${body}</div></foreignObject>`,
  )
}

// About how wide a run of text draws at a font size: Hangul and other wide script are about one
// em across, Latin about half; a mono face 0.6 em for every glyph.
export function textWidth(text: string, fontSize: number, isMono = false) {
  let used = 0
  for (const ch of text) used += isMono ? fontSize * 0.6 : isWide(ch.codePointAt(0) ?? 0) ? fontSize : fontSize * 0.55
  return Math.ceil(used)
}

// The text cut with an ellipsis to fit a width, as CSS text-overflow would.
export function fitText(text: string, width: number, fontSize: number) {
  if (textWidth(text, fontSize) <= width) return text
  let cut = ''
  for (const ch of text) {
    if (textWidth(`${cut}${ch}…`, fontSize) > width) break
    cut += ch
  }
  return `${cut}…`
}

// How many lines (1 or 2) a run of text takes at a font size.
export function lineCount(text: string, width: number, fontSize: number) {
  return textWidth(text, fontSize) > width ? 2 : 1
}

// Hangul Jamo, CJK and Hangul syllables, compatibility ideographs, fullwidth forms.
const WIDE_RANGES = [
  [0x1100, 0x11ff],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
] as const

function isWide(code: number) {
  return WIDE_RANGES.some(([from, to]) => code >= from && code <= to)
}

const STATE_WORD: Record<DotState, string> = { waiting: '대기', blocked: '훅 차단', background: '백그라운드', working: '실행 중', paused: '멈춤', done: '완료' }

// A state dot centred at (x, y), 8px across, the same centre in every state. Waiting sends a ring
// out from under it every 1.4s; working blinks every 1.0s. The ring is drawn around the dot and
// takes no room of its own.
function dot(state: DotState, x: number, y: number) {
  if (state === 'waiting' || state === 'blocked') {
    const color = state === 'blocked' ? C.hook : C.amber
    return (
      `<circle cx="${x}" cy="${y}" r="3" fill="none" stroke="${color}" stroke-width="2">` +
      `<animate attributeName="r" values="3;8" dur="1.4s" repeatCount="indefinite"/>` +
      `<animate attributeName="opacity" values="0.9;0" dur="1.4s" repeatCount="indefinite"/></circle>` +
      `<circle cx="${x}" cy="${y}" r="4" fill="${color}"/>`
    )
  }
  if (state === 'working') {
    return (
      `<circle cx="${x}" cy="${y}" r="4" fill="${C.green}">` +
      `<animate attributeName="opacity" values="1;0.35;1" dur="1s" repeatCount="indefinite"/></circle>`
    )
  }
  // A hollow teal dot, still: the session itself does nothing; its shells do.
  if (state === 'background') return `<circle cx="${x}" cy="${y}" r="3.25" fill="none" stroke="${C.teal}" stroke-width="1.5"/>`
  return `<circle cx="${x}" cy="${y}" r="4" fill="${state === 'paused' ? C.fg3 : C.fg4}"/>`
}

// A dot on its own, for an island's head.
export function dotPiece(state: DotState): Piece {
  return svg(18, 18, STATE_WORD[state], dot(state, 9, 9))
}

// A mini chip's dot: 8px, then the chip's 5px gap.
export function chipDotPiece(state: DotState): Piece {
  return svg(13, 18, STATE_WORD[state], dot(state, 4.5, 9))
}

// The tree, as the prototype's: a node row is 27px with its dot's centre 13.5px down, each depth
// 14px further in. A node's children hang off a dashed teal line straight down from the centre of
// its dot; each child's elbow leaves that line level with the child's dot centre and stops 3px
// short of the dot. Half-pixel centres keep the 1px lines sharp.
const STEP = 14
export const NODE_PX = 27
const dotX = (depth: number) => 10.5 + depth * STEP
const MID = NODE_PX / 2
export const gutterWidth = (depth: number) => 22 + depth * STEP

const dashed = (d: string) => `<path d="${d}" fill="none" stroke="${C.teal}" stroke-opacity="0.7" stroke-width="1" stroke-dasharray="3 3"/>`
const verticals = (through: number[], height: number) => through.map(depth => dashed(`M${dotX(depth)} 0 V${height}`)).join('')

export type Gutter = {
  // The depths whose child line runs on past this row.
  through: number[]
  // No sibling follows: the parent's line ends at this row's elbow.
  isLast: boolean
  hasChildren: boolean
  // A 2px bar down the row's left edge, for a waiting or working node.
  accent?: string
}

// A tree node's left gutter: the accent bar, the lines running past, for a child the elbow in from
// its parent's line, the start of its own children's line, then the state dot.
export function gutterPiece(state: DotState, depth: number, gutter: Gutter = { through: [], isLast: true, hasChildren: false }): Piece {
  const height = NODE_PX
  const accent = gutter.accent ? `<rect x="0" y="0" width="2" height="${height}" fill="${gutter.accent}"/>` : ''
  const parent = dotX(depth - 1)
  const elbow = depth > 0 ? dashed(`M${parent} 0 V${gutter.isLast ? MID : height} M${parent} ${MID} H${dotX(depth) - 7}`) : ''
  const down = gutter.hasChildren ? dashed(`M${dotX(depth)} ${MID + 7} V${height}`) : ''
  return svg(gutterWidth(depth), height, STATE_WORD[state], accent + verticals(gutter.through, height) + elbow + down + dot(state, dotX(depth), MID))
}

// The last line under a node's children, where folded ones are counted: the parent's line comes
// down to it and turns in, with no dot.
export function elbowPiece(depth: number, height: number, through: number[] = []): Piece {
  const mid = height / 2
  return svg(gutterWidth(depth), height, '트리 선', verticals(through, height) + dashed(`M${dotX(depth - 1)} 0 V${mid} H${dotX(depth) - 3}`))
}

// The gutter beside a node's question or activity lines: only the lines running past.
export function railPiece(depth: number, height: number, through: number[] = []): Piece {
  return svg(gutterWidth(depth), height, '트리 선', verticals(through, height))
}

// Empty room of an exact size, where a Box can only measure in cells.
export function spacerPiece(width: number, height: number): Piece {
  return svg(width, height, '여백', '')
}

// What runs across the board is never one picture: a picture draws no wider than 300px unless it
// is given a width, and the pane's width in pixels is not known (it reports cells, and how many
// pixels a cell is differs from a docked pane to a split one). Solid lines are coloured boxes; a
// dashed line is these tiles side by side, clipped where the box ends. 294px is 42 dashes of 4+3.
export const DASH_TILE_PX = 294

export function dashTilePiece(color: string): Piece {
  return svg(DASH_TILE_PX, 1, '구분선', `<path d="M0 0.5 H${DASH_TILE_PX}" stroke="${color}" stroke-dasharray="4 3"/>`)
}

// The glint that sweeps along a working node's progress line every 1.8s; the line itself is a box.
export function glintPiece(): Piece {
  return svg(
    300,
    2,
    '진행 중',
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${C.green}" stop-opacity="0"/>` +
      `<stop offset="0.5" stop-color="${C.green}"/><stop offset="1" stop-color="${C.green}" stop-opacity="0"/></linearGradient></defs>` +
      `<rect y="0" width="120" height="2" rx="1" fill="url(#g)">` +
      `<animate attributeName="x" values="-120;300" dur="1.8s" repeatCount="indefinite"/></rect>`,
  )
}

// A header count that cannot be chosen (none to show): the prototype's capsule, dimmed.
export function pillPiece(text: string): Piece {
  const width = textWidth(text, 11) + 18
  return html(
    width,
    20,
    text,
    `<div style="display:flex;align-items:center;justify-content:center;height:20px;border:1px solid ${C.line2};border-radius:999px;` +
      `color:${C.fg4};font-size:11px;white-space:nowrap">${escapeHtml(text)}</div>`,
  )
}

// A worktree's branch beside its node: a dashed mono tag, cut to 12 characters so the title keeps
// the room; the alt holds the whole name.
export function worktreePiece(name: string): Piece {
  const shown = [...name].length > 12 ? `${[...name].slice(0, 11).join('')}…` : name
  const width = textWidth(shown, 10, true) + 12
  return html(
    width,
    18,
    name,
    `<div style="display:flex;align-items:center;height:18px"><span style="box-sizing:border-box;font:10px ${MONO};color:${C.fg3};` +
      `border:1px dashed ${C.line2};border-radius:4px;padding:0 5px;white-space:nowrap">${escapeHtml(shown)}</span></div>`,
  )
}

// The amber mark of an island that changed since it was last looked at: 10px across in a 2px ring
// of the board's colour, centred on the card's top-right corner. The picture sits in the room kept
// above and right of the card, `top` pixels tall to the corner.
export function badgePiece(top: number): Piece {
  return svg(14, top + 7, '새 변경', `<circle cx="7" cy="${top}" r="7" fill="${C.bg}"/><circle cx="7" cy="${top}" r="5" fill="${C.amber}"/>`)
}

// The unseen mark on one session's row, where its island is not one place (the folder-less one).
export function newDotPiece(): Piece {
  return svg(14, 18, '새 변경', `<circle cx="7" cy="9" r="4" fill="${C.amber}"/>`)
}

// A control's rounded frame, as the prototype's buttons, chips and pills, in four strips placed on
// the box's edges. A placed picture takes the clicks under it, so none may cover the label: the
// sides are as wide as the corner, the top and bottom as thick as the stroke, and they stretch
// across as the box does. A filled control is filled by its Box; the sides paint the corners
// outside the curve in the colour behind, since a Box has square corners.
export type Frame = { border: string; stroke?: number; radius?: number; outside?: string }

export function frameSide(side: 'left' | 'right', frame: Frame, height: number): Piece {
  const stroke = frame.stroke ?? 1
  const radius = frame.radius ?? 6
  const inset = stroke / 2
  const x = side === 'left' ? inset : radius - 60 + inset
  const shape = `x="${x}" y="${inset}" width="${60 - stroke}" height="${height - stroke}" rx="${radius - inset}"`
  const corners = frame.outside
    ? `<defs><mask id="m"><rect width="${radius}" height="${height}" fill="white"/><rect ${shape} fill="black"/></mask></defs>` +
      `<rect width="${radius}" height="${height}" fill="${frame.outside}" mask="url(#m)"/>`
    : ''
  return svg(radius, height, '테두리', `${corners}<rect ${shape} fill="none" stroke="${frame.border}" stroke-width="${stroke}"/>`)
}

export function frameLineSource(frame: Frame) {
  const stroke = frame.stroke ?? 1
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${stroke}"><foreignObject x="0" y="0" width="100%" height="${stroke}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="margin:0 ${frame.radius ?? 6}px;height:${stroke}px;background:${frame.border}"></div></foreignObject></svg>`
  )
}

// A card's dashed 1px border, which a Box cannot draw (the desktop draws "dashed" solid). The
// corner arcs are solid: a dash pattern on a 15px arc leaves only scraps of it. The
// corners mask the square card behind them with the board's colour; the sides run long and the
// card clips them, since a picture cannot learn the card's height. The top and bottom are rows of
// dash tiles.
export const CARD_RADIUS = 10
const DASH = 'stroke-dasharray="4 3"'

export function cardCornerPiece(corner: 'tl' | 'tr' | 'bl' | 'br', color: string, inside: string): Piece {
  const r = CARD_RADIUS
  // The corner drawn as the top-left one, then turned into place.
  const turn = { tl: '', tr: `rotate(90 ${r / 2} ${r / 2})`, br: `rotate(180 ${r / 2} ${r / 2})`, bl: `rotate(270 ${r / 2} ${r / 2})` }[corner]
  return svg(
    r,
    r,
    '테두리',
    `<g transform="${turn}"><rect width="${r}" height="${r}" fill="${C.bg}"/>` +
      `<path d="M${r} 0.5 A${r - 0.5} ${r - 0.5} 0 0 0 0.5 ${r} L${r} ${r} Z" fill="${inside}"/>` +
      `<path d="M${r} 0.5 A${r - 0.5} ${r - 0.5} 0 0 0 0.5 ${r}" fill="none" stroke="${color}"/></g>`,
  )
}

export function cardSidePiece(color: string): Piece {
  return svg(1, 4000, '테두리', `<path d="M0.5 ${CARD_RADIUS} V4000" fill="none" stroke="${color}" ${DASH}/>`)
}

// A dormant child chip's lead-in: the dashed teal stub from its parent.
export function stubPiece(): Piece {
  return svg(12, 18, '하위 세션', dashed('M1 9.5 H10'))
}
