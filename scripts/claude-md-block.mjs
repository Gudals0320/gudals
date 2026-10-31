#!/usr/bin/env node
// CLAUDE.md 의 표식 블록을 넣고, 갱신하고, 빼고, 나열한다. 조합형 CLAUDE.md 의 공용 도구.
//
//   node scripts/claude-md-block.mjs upsert <이름> <내용 파일> [--file CLAUDE.md]
//   node scripts/claude-md-block.mjs remove <이름>             [--file CLAUDE.md]
//   node scripts/claude-md-block.mjs list                      [--file CLAUDE.md]
//
// 블록은 <!-- gudals:<이름> --> 와 <!-- /gudals:<이름> --> 사이다. 그 밖의 내용은 건드리지 않는다.
// 내용 파일에 같은 표식이 들어 있어도 된다(벗겨 낸다). 파일이 없으면 만든다. 줄바꿈 방식은 원본을 따른다.
// 종료 코드: 0 정상, 2 사용법 오류.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const fileIdx = argv.indexOf("--file");
const target = resolve(fileIdx >= 0 ? argv.splice(fileIdx, 2)[1] : "CLAUDE.md");
const [cmd, name, contentPath] = argv;

if (!cmd || !["upsert", "remove", "list"].includes(cmd)) usage();
if (cmd !== "list" && !/^[a-z][a-z0-9-]*$/.test(name ?? "")) usage("이름은 소문자, 숫자, 하이픈만 쓴다.");
if (cmd === "upsert" && !contentPath) usage("upsert 에는 내용 파일이 필요하다.");

const exists = existsSync(target);
const raw = exists ? readFileSync(target, "utf8") : "";
const crlf = raw.includes("\r\n");
const text = raw.replace(/\r\n/g, "\n");

if (cmd === "list") {
  const names = [...text.matchAll(/<!-- gudals:([a-z][a-z0-9-]*) -->/g)].map((m) => m[1]);
  console.log(names.length ? names.join("\n") : "(블록 없음)");
  process.exit(0);
}

const open = `<!-- gudals:${name} -->`;
const close = `<!-- /gudals:${name} -->`;
const re = new RegExp(`\\n?${esc(open)}\\n[\\s\\S]*?\\n${esc(close)}\\n?`);

if (cmd === "remove") {
  if (!re.test(text)) { console.log(`${name}: 블록이 없다.`); process.exit(0); }
  write(text.replace(re, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "\n"));
  console.log(`${name}: 뺐다.`);
  process.exit(0);
}

// upsert
let body = readFileSync(resolve(contentPath), "utf8").replace(/\r\n/g, "\n").trim();
body = body.replace(new RegExp(`^${esc(open)}\\n?`), "").replace(new RegExp(`\\n?${esc(close)}$`), "").trim();
const block = `${open}\n${body}\n${close}`;

if (re.test(text)) {
  const next = text.replace(re, (m) => `${m.startsWith("\n") ? "\n" : ""}${block}${m.endsWith("\n") ? "\n" : ""}`);
  if (next === text) { console.log(`${name}: 변화 없음.`); process.exit(0); }
  write(next);
  console.log(`${name}: 갱신했다.`);
} else {
  const base = text.length ? text.replace(/\n*$/, "\n\n") : "";
  write(base + block + "\n");
  console.log(`${name}: ${exists ? "넣었다." : "CLAUDE.md 를 만들고 넣었다."}`);
}

function write(s) { writeFileSync(target, crlf ? s.replace(/\n/g, "\r\n") : s, "utf8"); }
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function usage(msg) {
  if (msg) console.error(msg);
  console.error("사용법: claude-md-block.mjs upsert <이름> <내용 파일> | remove <이름> | list   [--file CLAUDE.md]");
  process.exit(2);
}
