// Read-only browser use (head decision 2026-10-22). Every Ego Lite script is
// built from fixed templates and checked by assertReadOnly() before it runs:
// no clicks, typing, key presses or form submits. The only exceptions are two
// fixed snippets: declining non-essential cookies (handoff section 6, "필수
// 쿠키만") and scrolling. Search terms only ever enter a script as an
// encoded URL inside a JSON string literal.

export class ReadOnlyViolation extends Error {
  constructor(what: string) {
    super(`browser script is not read-only: ${what}`);
    this.name = "ReadOnlyViolation";
  }
}

/** Clicks only a button whose label means "reject" or "necessary cookies only". Never "accept". */
export const DECLINE_COOKIES = `(() => {
  const re = /^(reject all|reject|decline|only necessary|necessary only|essential only|use necessary cookies only|refuse non-essential cookies|필수 쿠키만 허용|필수 쿠키만|모두 거부|거부)$/i;
  const accept = /accept|agree|allow all|동의|허용(?! 안)/i;
  for (const b of Array.from(document.querySelectorAll("button, [role=button]"))) {
    const t = (b.textContent || "").trim();
    if (re.test(t) && !accept.test(t.replace(/필수 쿠키만 허용/, ""))) { b.click(); return t; }
  }
  return null;
})()`;

export const SCROLL_ONCE = `window.scrollBy(0, Math.round(window.innerHeight * 1.5))`;

const ALLOWED_SNIPPETS = [DECLINE_COOKIES, SCROLL_ONCE];

const FORBIDDEN: [RegExp, string][] = [
  [/\.click\s*\(/, "click"],
  [/\.fill\s*\(/, "fill"],
  [/\.type\s*\(/, "type"],
  [/\.press\s*\(/, "press"],
  [/\bkeyboard\b/, "keyboard"],
  [/\bmouse\b/, "mouse"],
  [/\.submit\s*\(|requestSubmit/, "form submit"],
  [/setInputFiles|\.check\s*\(|\.selectOption\s*\(/, "form input"],
  [/dispatchEvent/, "synthetic event"],
  [/method\s*:\s*["'](POST|PUT|PATCH|DELETE)/i, "write request"],
  [/\.(tap|dblclick|hover|dragTo)\s*\(/, "pointer action"],
];

export function assertReadOnly(script: string): void {
  let s = script;
  for (const snip of ALLOWED_SNIPPETS) s = s.split(snip).join("");
  for (const [re, what] of FORBIDDEN) if (re.test(s)) throw new ReadOnlyViolation(what);
}

/** Signs that a platform is limiting or challenging the account (stop that platform for the day). */
export const ACCOUNT_LIMIT_SIGNS = /unusual activity|suspicious activity|temporarily (locked|restricted|limited)|rate limit exceeded|try again later|verify (it's|that it's) you|confirm (it's|that it's) you|account (is )?(locked|suspended|restricted)|비정상적인 활동|일시적으로 (제한|잠금)|계정이 (잠겼|제한)/i;
export const LOGIN_WALL = /\b(log in|sign in|sign up)\b.*\b(to (see|continue|view)|x|threads)\b|로그인하(고|여|세요)|가입하(고|세요)/i;
