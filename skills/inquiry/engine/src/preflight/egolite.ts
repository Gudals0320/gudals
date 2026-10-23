// Thin bridge to Ego Lite: every call is one `ego-browser nodejs` process.
// Scripts go in through stdin (UTF-8, no shell quoting) and report back by
// printing a line containing RESULT_TAG followed by JSON.

import { spawn } from "node:child_process";
import { assertReadOnly } from "../retrieval/browser.ts";

export const RESULT_TAG = "@@inquiry@@";

export type EgoRun = {
  results: unknown[];
  code: number | null;
  stdout: string;
  stderr: string;
};

export function runEgo(script: string, timeoutMs = 120_000): Promise<EgoRun> {
  // Every script is checked before it reaches the browser: reading only.
  try {
    assertReadOnly(script);
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ego-browser timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // ego-browser forwards the script's console output on stderr, and may
      // prefix lines, so search both streams for the tag anywhere in a line.
      const results = `${stdout}\n${stderr}`
        .split(/\r?\n/)
        .filter((line) => line.includes(RESULT_TAG))
        .map((line) => JSON.parse(line.slice(line.indexOf(RESULT_TAG) + RESULT_TAG.length)));
      resolve({ results, code, stdout, stderr });
    });
    child.stdin.end(script, "utf8");
  });
}

/** Ego Lite scripts need absolute paths with forward slashes on Windows. */
export function egoPath(p: string): string {
  return p.replace(/\\/g, "/");
}
