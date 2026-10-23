---
version: beta
name: gudals-monitor
description: >-
  The Monitor pane (gudals:monitor) inside Claude Desktop's Code tab: a board of repository islands, each
  holding the tree of sessions that work in it. State is not a section of its own; it is what
  lifts an island up the board. Follows the session radar prototype (session-radar-proto.html) and its spec; where
  the mod cannot do what the prototype does, this file says what it does instead.
sources:
  - the session radar prototype (session-radar-proto.html) and its spec (the base)
  - Claude, Linear and Raycast analyses from VoltAgent/awesome-design-md (MIT, community-made)

colors:
  bg: "#15130f"
  panel: "#1d1a15"
  panel2: "#24201a"     # island card
  panel3: "#2b261f"     # node hover, neutral flash
  line: "#2f2a22"
  line2: "#3d3629"
  fg: "#e8e2d6"
  fg2: "#a89f90"
  fg3: "#6f675b"
  fg4: "#4e483f"
  amber: "#e2a34a"      # waiting
  amber-bg: "#3a2a12"
  green: "#5fbf8a"      # working
  green-bg: "#163125"
  teal: "#4fb8b0"       # lineage: dashed rails and elbows
  red: "#e0665a"

typography:
  sans: "'Pretendard', 'Noto Sans KR', 'Malgun Gothic', system-ui, sans-serif"
  mono: "'Cascadia Mono', 'JetBrains Mono', Consolas, monospace"

timing:
  waiting-ring: 1.4s
  working-blink: 1.0s
  sweep: 1.8s
  flash: 0.9s
---

# Session radar design

## Principles

1. **The island is the structure.** Sessions appear only inside their repository's island, as a
   tree. A session never shows in two places.
2. **State lifts islands.** Waiting and working are not sections. An island with a waiting session
   goes to the top (and spans the board when the pane is wide); one with a working session follows.
3. **No "열기".** A session's title is its button.
4. **Light means life.** Only waiting and working dots move. Paused sessions sit still and grey.
5. **Lineage in teal.** A sub-session hangs under the session that started it behind a dashed teal
   rail and elbow; a worktree shows as a dashed tag.

## States

| State | From | Dot | Title |
| --- | --- | --- | --- |
| waiting | a next-step box nobody answered, a question card, a permission prompt, the engine's `waiting` | amber, a ring grows and fades every 1.4s | amber |
| working | busy in a turn, or shells left running after it | green, blinks every 1.0s | green |
| paused | idle, nothing asked | fg3, still | fg |
| done | (not available: the app does not expose the sidebar's "completed" mark) | fg4 | fg3 |

## Island tiers

| Tier | When | Card |
| --- | --- | --- |
| hot | a session waits | amber border; full width on a wide pane; head says "나를 기다림 · N분째" |
| live | a session works | green border; head says "실행 중" |
| warm | otherwise, active within 2 hours | line border |
| cold | otherwise, quiet 2 hours or more | below the "휴면 · 2시간 이상" line, folded into mini chips; its name unfolds it |

Islands sort by tier, then by latest activity. Inside an island, sessions sort by state, then by
the time they entered it.

## Components

**Header.** "세션", then pills shown only when non-zero: 대기 N (amber), 실행 N (green), 새 변경 N
(neutral). On the right, 모두 확인 (A) and 새로고침 (R).

**Island card.** panel2, rounded border by tier. Head: the island's dot, its name, why, the
session count, and an amber ● while it holds a change not yet looked at.

**Node.** Gutter picture (dashed rail and elbow for a child, then the state dot), the title as a
plain button in the state's colour, a dashed worktree tag, and the age in mono. Hover lights the
row in panel3.
- waiting: the question in amber, then the box's options as buttons, numbered 1-9; the first is
  primary. `1`-`9` press the buttons of the session that has waited longest. Pressing one sends
  what the button would have sent, and the node shows "…받고 진행 중" until the session moves.
- working: the activity line in green, a sweep bar under it, then each shell it runs: "실행" or
  "감시", the command in a dashed mono tag, and how long it has run.

**Mini chip.** In a folded cold island: panel, line border, a dot and the title as a button.

**Footer.** One mono hint line: 제목 클릭 세션 이동 · 1-9 · A · R · 휴면 카드 이름 클릭.

## Live behaviour

| What | In the prototype | In the mod |
| --- | --- | --- |
| waiting ring, working blink, sweep | CSS animation | SVG animation inside the pictures |
| island glow breathing | box-shadow animation | static amber border (boxes do not animate) |
| state change flash | background flash 0.9s | the island's background in the new state's colour for 0.9s |
| reorder | FLIP slide 0.45s | islands simply reorder (the mod cannot move DOM nodes) |
| new waiting | scroll into view | not available; the island rises to the top instead |
| unseen change | ● and "새 변경 N" until looked at | same; cleared by opening a session there, or A |
| refresh | 2-3s polling | every 10s, and on R |

## Words

- A session started by another session is a **하위 세션**; the one that started it is its **상위
  세션**.
- State words: 대기, 실행 중, 멈춤, 휴면.
