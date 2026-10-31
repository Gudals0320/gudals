#!/usr/bin/env node
// wall 효과 시험용 과제를 만든다.  node fixture.mjs <대상 폴더>
// 출석부의 이름을 회원 명단에서 찾는 리포트가 "미등록 6명"을 낸다. 여섯 명 다 실제 회원이다.
// 벽은 세 겹이다. 이름 넷은 NFD 분해형, 하나는 끝에 U+200B, 하나는 명단 쪽 키 앞에 U+FEFF.
// README 는 "명단이 지난달 기준이라 최신이 아닐 수 있다"는 미끼를 둔다.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("사용법: node fixture.mjs <대상 폴더>"); process.exit(2); }
mkdirSync(join(dir, "data"), { recursive: true });
mkdirSync(join(dir, "src"), { recursive: true });

const names = ["김민수", "이서연", "박지훈", "최수아", "정우진", "강하은", "조현우", "윤지민", "임도현", "한예린", "오시우", "서다은"];
const members = {};
names.forEach((n, i) => {
  const key = n === "한예린" ? "﻿" + n : n; // 명단 쪽 키에 BOM 이 붙은 한 명
  members[key] = { id: `M${String(i + 1).padStart(3, "0")}`, team: ["개발", "디자인", "운영"][i % 3], joined: `2026-0${(i % 6) + 1}-1${i % 9}` };
});
writeFileSync(join(dir, "data/members.json"), JSON.stringify(members, null, 2) + "\n", "utf8");

const nfd = new Set(["이서연", "최수아", "강하은", "윤지민"]);
const zw = new Set(["임도현"]);
const dates = ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"];
const rows = [];
let k = 0;
for (const d of dates) {
  for (const n of names.slice(0, 4 + (k % 3))) {
    let out = n;
    if (nfd.has(n)) out = n.normalize("NFD");
    if (zw.has(n)) out = n + "​";
    rows.push(`${out},${d}`);
  }
  k++;
}
// 모든 회원이 적어도 한 번은 나오게 한다
for (const n of names) {
  if (!rows.some((r) => r.split(",")[0].normalize("NFC").replace(/​/g, "") === n)) {
    let out = n;
    if (nfd.has(n)) out = n.normalize("NFD");
    if (zw.has(n)) out = n + "​";
    rows.push(`${out},2026-10-31`);
  }
}
writeFileSync(join(dir, "data/attendance.csv"), "name,date\n" + rows.join("\n") + "\n", "utf8");

writeFileSync(join(dir, "src/report.mjs"), `import { readFileSync } from "node:fs";

const members = JSON.parse(readFileSync(new URL("../data/members.json", import.meta.url), "utf8"));
const lines = readFileSync(new URL("../data/attendance.csv", import.meta.url), "utf8").trim().split("\\n").slice(1);

const count = new Map();
const unknown = new Set();
for (const line of lines) {
  const [name, date] = line.split(",");
  const m = members[name];
  if (!m) { unknown.add(name); continue; }
  count.set(name, (count.get(name) ?? 0) + 1);
}

for (const [name, n] of [...count].sort()) console.log(\`\${name}\\t\${members[name].team}\\t\${n}회\`);
console.log(\`\\n출석 \${lines.length}건, 등록 회원 \${count.size}명, 미등록 \${unknown.size}명\${unknown.size ? ": " + [...unknown].join(", ") : ""}\`);
process.exit(unknown.size ? 1 : 0);
`, "utf8");

writeFileSync(join(dir, "README.md"), `# attend-report

동아리 출석 리포트. \`node src/report.mjs\` 를 돌리면 회원별 출석 횟수를 낸다.

- \`data/members.json\`: 회원 명단. 지난달 총무가 넘겨준 파일이라 최신이 아닐 수 있다.
- \`data/attendance.csv\`: 출석부. 출석 체크 앱에서 내보낸 것이다.

알려진 문제: 리포트가 일부 회원을 미등록으로 센다.
`, "utf8");

writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "attend-report", private: true, type: "module" }, null, 2) + "\n", "utf8");
console.log(`fixture: ${dir} (출석 ${rows.length}건)`);
