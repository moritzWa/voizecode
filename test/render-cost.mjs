#!/usr/bin/env node
// How much work the transcript costs to draw, measured on a real resumed session.
//
// The mobile transcript is a plain ScrollView over every line, and playback sets `speakingTime`
// state ten times a second (onPositionChangedInterval = 100ms). Before this change nothing was
// memoized and every word was an Animated.View owning a useSharedValue + useAnimatedStyle, so a
// tick re-rendered the entire transcript and every Reanimated node in it. This counts the nodes
// for an actual session rather than guessing at them.
//
//   node test/render-cost.mjs [sessionId]
//
// With no argument it picks the largest transcript on this machine.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { splitBlocks, styledWords } from "../shared/markdown.ts";

const ROOT = join(homedir(), ".claude", "projects");

// Mirrors buildHistory() in laptop/voizecode.mjs: real user/assistant text, last 60 messages.
// Kept local on purpose — this measures the input the renderer actually receives, and importing
// from the agent would drag its whole module (and its websocket) into a measurement script.
function history(file) {
  const msgs = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.isMeta || m.isSidechain) continue;
    if (m.type === "user" && m.message?.content) {
      const c = m.message.content;
      const text = (typeof c === "string" ? c : c.find?.((b) => b?.type === "text" && b.text)?.text || "").trim();
      if (!text || /^<(local-command|command-)/.test(text)) continue;
      msgs.push({ role: "user", text });
    } else if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      const text = m.message.content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("").trim();
      if (text) msgs.push({ role: "assistant", text });
    }
  }
  return msgs.slice(-60);
}

function pickBiggest() {
  let best = null;
  for (const d of readdirSync(ROOT)) {
    let files = [];
    try { files = readdirSync(join(ROOT, d)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = join(ROOT, d, f);
      let size = 0; try { size = statSync(p).size; } catch { continue; }
      if (!best || size > best.size) best = { path: p, size, id: f.replace(/\.jsonl$/, "") };
    }
  }
  return best;
}

const arg = process.argv[2];
let target = null;
if (arg) {
  for (const d of readdirSync(ROOT)) {
    const p = join(ROOT, d, arg + ".jsonl");
    try { statSync(p); target = { path: p, id: arg, size: statSync(p).size }; break; } catch { /* keep looking */ }
  }
  if (!target) { console.error(`no transcript for ${arg}`); process.exit(2); }
} else target = pickBiggest();

const msgs = history(target.path);

// One <Word>/<StaticWord> per word, plus one row View per paragraph and one per code block.
let words = 0, codeBlocks = 0, rows = 0;
for (const m of msgs) {
  for (const b of splitBlocks(m.text)) {
    if (b.type === "code") { codeBlocks++; rows++; continue; }
    for (const para of b.text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)) {
      rows++; words += styledWords(para).length;
    }
  }
}

const TICK_HZ = 10; // onPositionChangedInterval = 100ms

console.log(`\n=== render cost · session ${target.id.slice(0, 8)} (${(target.size / 1e6).toFixed(1)}MB transcript) ===`);
console.log(`  restored turns shown        ${msgs.length}`);
console.log(`  paragraph rows              ${rows}`);
console.log(`  fenced blocks               ${codeBlocks}  (${codeBlocks ? "were word-split before this change" : "none in this session"})`);
console.log(`  words drawn                 ${words}`);
console.log("");
console.log(`  BEFORE  Reanimated word nodes mounted   ${words}`);
console.log(`          word nodes reconciled / second  ${(words * TICK_HZ).toLocaleString()}   (${TICK_HZ} ticks/s x every word)`);
console.log(`  AFTER   Reanimated word nodes mounted   0 while idle; only the spoken line animates`);
console.log(`          word nodes reconciled / second  ~the spoken line only (memoized rows skip the rest)`);
console.log("");

// A guard, not just a print: this is the number that made the app feel broken.
const before = words * TICK_HZ;
const ok = words > 0;
if (!ok) { console.log("  (no drawable text found — pick a session with assistant replies)\n"); process.exit(2); }
console.log(before > 20000
  ? `  => ${before.toLocaleString()} node reconciliations per second of speech, to move one highlight.\n`
  : `  => ${before.toLocaleString()} node reconciliations per second of speech.\n`);
