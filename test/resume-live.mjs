#!/usr/bin/env node
// Resuming an existing session e2e — the "I press record on an old chat and nothing happens" bug.
//
// Opening a fresh directory always worked, which made this look like a performance problem. It was
// four separate faults, all of which need a session with history to show up at all:
//
//   - the relay interrupts before every user turn, assuming it is a no-op while claude is idle.
//     A resumed session is still starting, so the interrupt landed on the turn it preceded and
//     cancelled it — and `expectAbort` made the agent swallow the error silently.
//   - a resumed session replays the tail of the old transcript, emitting a num_turns:0 `result`
//     seconds before the real answer. Taken as the reply, it ended the turn empty.
//   - most sessions worth picking up are still running as background agents (the list is sorted
//     most-recently-active first, so it surfaces exactly those), and Claude Code refuses a plain
//     --resume on one. The turn was written into the dying process and shifted off the queue.
//   - a long session on a small-context model fails every turn with "Prompt is too long".
//
//   1. live session picked up   (a chat resuming a live background session answers a turn)
//   2. no turn lost mid-restart (a turn sent into a restarting chat still gets answered)
//
// Needs at least one live background agent; run `claude --bg -n probe "sleep"` if you have none.
// relay/.env is optional — this drives the typed-text path, so no STT/TTS keys are needed.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import WebSocket from "../laptop/node_modules/ws/index.js";

const ROOT = new URL("..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// relay/.env is gitignored and often absent; the typed-text path this test uses needs no STT/TTS
// keys, so run without it rather than refusing.
let env = {};
try {
  env = Object.fromEntries(readFileSync(join(ROOT, "relay/.env"), "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
} catch { console.log("(no relay/.env — running on the typed-text path)"); }

let pass = 0, total = 0;
const check = (name, cond) => { total++; if (cond) pass++; console.log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`); return cond; };

// `detached` gives each child its own process group, so cleanup can kill the group (deno and the
// agent both spawn grandchildren that a bare kill would orphan) without killing this test too.
function start(name, cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, detached: true });
  const tag = (d) => process.stdout.write(`\x1b[2m[${name}] ${d}\x1b[0m`);
  p.stdout.on("data", tag); p.stderr.on("data", tag);
  return p;
}

// Pick a live background agent whose transcript still exists — that is the case that used to fail.
function pickLiveSession() {
  let agents = [];
  try { agents = JSON.parse(execFileSync("claude", ["agents", "--json"], { timeout: 5000, encoding: "utf8" })); }
  catch { return null; }
  return agents.find((a) => a.kind === "background" && a.sessionId && a.cwd) || null;
}

const live = pickLiveSession();
if (!live) {
  console.log("no live background agent to resume — start one with `claude --bg -n probe \"sleep 600\"` and re-run");
  process.exit(2);
}

const S = "resume-live-" + Math.random().toString(36).slice(2, 8);
const relay = start("relay", "deno", ["run", "--allow-net", "--allow-env", "--env-file=.env", "main.ts"],
  { cwd: join(ROOT, "relay"), env: { ...process.env, ...env } });
// Not haiku: a session worth resuming is usually well past 200k tokens, and haiku then answers
// every single turn with "Prompt is too long".
const agent = start("agent", "node", [join(ROOT, "laptop/voizecode.mjs")],
  { cwd: live.cwd, env: { ...process.env, VOIZE_MODEL: "sonnet" } });
await sleep(3500);

const inbox = [];
const ws = new WebSocket("ws://localhost:8787");
await new Promise((r) => ws.on("open", r));
ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
ws.send(JSON.stringify({ t: "hello", role: "client", since: 0 }));
await sleep(1000);

// The chat the agent registered on boot, whose socket we address the new_chat through.
const boot = inbox.find((m) => m.t === "sessions" && m.sessions?.length)?.sessions?.[0]?.sessionId;

console.log(`\n=== voizecode resume-live (${live.name || live.id} · ${basename(live.cwd)}) ===`);
console.log(`  resuming ${live.sessionId.slice(0, 8)} — live background agent in ${live.cwd}`);

const replyTo = async (chatId, text, ms = 120000) => {
  inbox.splice(0);
  ws.send(JSON.stringify({ t: "text", text, sessionId: chatId }));
  const deadline = Date.now() + ms;
  let out = "", doneAt = 0;
  while (Date.now() < deadline) {
    for (const m of inbox.splice(0)) {
      if (m.sessionId && m.sessionId !== chatId) continue;
      if (m.t === "agent_text") out += m.text;
      if (m.t === "turn_end" && m.fullText) out += m.fullText;
      if (m.t === "thinking" && m.on === false) doneAt = Date.now();
    }
    // Only an end-of-turn that actually carried text ends the wait: a bare turn_end with nothing
    // in it is the failure this test exists to catch, and breaking on it would hide the real reply.
    if (doneAt && out && Date.now() - doneAt > 3000) break;
    await sleep(150);
  }
  return out;
};

try {
  // 1) open a chat resuming the live session, then talk to it
  inbox.splice(0);
  ws.send(JSON.stringify({ t: "new_session", cwd: live.cwd, resumeId: live.sessionId, label: "resume-probe", sessionId: boot }));
  let chatId = null;
  for (let i = 0; i < 60 && !chatId; i++) {
    const s = inbox.find((m) => m.t === "sessions" && m.sessions?.some((x) => x.label === "resume-probe"));
    if (s) chatId = s.sessions.find((x) => x.label === "resume-probe").sessionId;
    await sleep(300);
  }
  if (!check("chat opened on the live session", !!chatId)) throw new Error("no chat");

  const t0 = Date.now();
  const reply = await replyTo(chatId, "Reply with exactly the word: ALPHA. Do not use any tools.");
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  check(`live session answers a turn (${took}s)`, /alpha/i.test(reply));
  if (!/alpha/i.test(reply)) console.log(`    got: ${JSON.stringify(reply.slice(0, 200))}`);

  // 2) the turn must survive a restart: reset drops the process, and the very next turn races it.
  //    This is the shape that used to lose the message — written into a pipe that then died.
  ws.send(JSON.stringify({ t: "reset", sessionId: chatId }));
  const raced = await replyTo(chatId, "Reply with exactly the word: BETA. Do not use any tools.");
  check("turn sent into a restarting chat is not lost", /beta/i.test(raced));
  if (!/beta/i.test(raced)) console.log(`    got: ${JSON.stringify(raced.slice(0, 200))}`);
} finally {
  try { ws.close(); } catch { /* gone */ }
  const own = process.pid;
  for (const p of [agent, relay]) {
    try {
      const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(p.pid)], { encoding: "utf8" }).trim());
      if (pgid > 1 && pgid !== own) process.kill(-pgid, "SIGTERM"); else p.kill("SIGTERM");
    } catch { /* already gone */ }
  }
  await sleep(1000);
  // A TERM you never checked is not a kill: deno in particular has survived one here.
  for (const p of [agent, relay]) {
    try { process.kill(p.pid, 0); p.kill("SIGKILL"); } catch { /* confirmed dead */ }
  }
  await sleep(300);
  console.log(`\n${pass}/${total} passed\n`);
  process.exit(pass === total ? 0 : 1);
}
