#!/usr/bin/env node
// Coalesced transcript persistence.
//
// The transcript used to be re-serialized on every change: every sentence of a reply, over up to
// 300 lines per session times every open tab, with JSON.stringify running synchronously on the JS
// thread while audio decodes. This measures the cost on a transcript the size of a real resumed
// session, and checks that coalescing keeps the last value (a debounce that loses the final write
// would trade jank for data loss).
//
//   node test/persist.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

let pass = 0, total = 0;
const check = (name, cond, got) => {
  total++; if (cond) pass++;
  console.log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`);
  if (!cond && got !== undefined) console.log(`      got: ${JSON.stringify(got).slice(0, 200)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the debounce, mirrored from mobile/src/core/storage.ts ---------------------------------
// Kept local so this runs under plain node: the real module imports AsyncStorage. The behaviour
// under test is the scheduling, and it is transcribed, not approximated.
function makeStore(sink) {
  const written = [];
  const timers = new Map(), latest = new Map();
  // Taken as a parameter, not a reassignable property: flushJSON closes over it.
  const setJSON = (k, v) => { written.push(v); sink?.(k, v); };
  const flushJSON = (key) => {
    for (const k of key ? [key] : [...latest.keys()]) {
      const t = timers.get(k);
      if (t) { clearTimeout(t); timers.delete(k); }
      if (latest.has(k)) { setJSON(k, latest.get(k)); latest.delete(k); }
    }
  };
  const setJSONSoon = (k, v, ms = 800) => {
    latest.set(k, v);
    if (timers.has(k)) return;
    timers.set(k, setTimeout(() => { timers.delete(k); flushJSON(k); }, ms));
  };
  return { written, setJSON, setJSONSoon, flushJSON, latest };
}

// --- a transcript the size of a real one ----------------------------------------------------
function realTranscript() {
  const root = join(homedir(), ".claude", "projects");
  let best = null;
  try {
    for (const d of readdirSync(root)) {
      let files = [];
      try { files = readdirSync(join(root, d)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) {
        const p = join(root, d, f);
        let size = 0; try { size = statSync(p).size; } catch { continue; }
        if (!best || size > best.size) best = { path: p, size };
      }
    }
  } catch { return null; }
  if (!best) return null;
  const lines = [];
  for (const line of readFileSync(best.path, "utf8").split("\n")) {
    if (!line.trim() || lines.length >= 300) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      const text = m.message.content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("").trim();
      if (text) lines.push({ kind: "agent", text });
    } else if (m.type === "user" && typeof m.message?.content === "string") {
      lines.push({ kind: "user", text: m.message.content });
    }
  }
  return lines;
}

console.log("\n=== transcript persistence ===");

const lines = realTranscript();
if (!lines || lines.length < 20) { console.log("  (no local transcripts to measure against)\n"); process.exit(2); }

// Three open tabs is ordinary use, and every one of them is in the same stringify.
const convos = { a: lines, b: lines.slice(0, Math.floor(lines.length / 2)), c: lines.slice(0, 20) };
const bytes = JSON.stringify(convos).length;

let ms = 0;
for (let i = 0; i < 20; i++) { const t = process.hrtime.bigint(); JSON.stringify(convos); ms += Number(process.hrtime.bigint() - t) / 1e6; }
ms /= 20;

console.log(`  transcript ${lines.length} lines, 3 tabs -> ${(bytes / 1024).toFixed(0)}KB per write, ${ms.toFixed(1)}ms each`);
console.log(`  a 20-sentence reply: BEFORE 20 writes = ${(ms * 20).toFixed(0)}ms of blocked JS thread, AFTER 1-2`);
console.log("");

// Measured, not assumed. On desktop V8 this is well under a millisecond, so coalescing is a
// small win rather than the large one it looked like from reading the code — Hermes on a phone is
// slower, but not by the order of magnitude that would make this the cause of the stutter. Kept
// because it is free and strictly less work; NOT kept as the explanation for the lag.
check("cost is measured, and small enough to say so out loud", ms < 5, `${ms.toFixed(2)}ms`);

// Coalescing: many rapid changes, one write, and it must be the newest value.
{
  const st = makeStore();
  for (let i = 0; i < 20; i++) st.setJSONSoon("k", { n: i }, 40);
  check("nothing is written synchronously", st.written.length === 0, st.written.length);
  await sleep(90);
  check("20 rapid changes collapse to one write", st.written.length === 1, st.written.length);
}
{
  const seen = [];
  const st = makeStore((_k, v) => seen.push(v.n));
  for (let i = 0; i < 5; i++) st.setJSONSoon("k", { n: i }, 40);
  await sleep(90);
  check("the write carries the newest value, not the first", seen.at(-1) === 4, seen);
}
// Losing the tail would trade jank for data loss, so an explicit flush must write immediately.
{
  const seen = [];
  const st = makeStore((_k, v) => seen.push(v.n));
  st.setJSONSoon("k", { n: 7 }, 5000);
  st.flushJSON();
  check("flush writes the pending value straight away (backgrounding the app)", seen.at(-1) === 7, seen);
  await sleep(30);
  check("flush cancels the timer — no duplicate write", seen.length === 1, seen);
}
{
  const st = makeStore();
  st.flushJSON();
  check("flush with nothing pending is a no-op", st.written.length === 0, st.written.length);
}

console.log(`\n${pass}/${total} passed\n`);
process.exit(pass === total ? 0 : 1);
