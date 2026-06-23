#!/usr/bin/env node
// e2e for the cross-directory session browser:
//   - list_sessions returns past sessions + project dirs (real codebases, temp dirs filtered)
//   - "new chat in a project" spawns claude in that cwd -> new tab
//   - "resume a session" spawns claude with --resume <id> in that session's cwd -> new tab
//
// Isolated port (won't touch a live session on :8787). Read-only: it never sends a turn to a
// resumed real session, so it doesn't mutate your transcripts — it asserts spawn + cwd + resume
// from the agent's own logs and the relay's session (tab) broadcast.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "../laptop/node_modules/ws/index.js";

const ROOT = new URL("..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = Object.fromEntries(readFileSync(join(ROOT, "relay/.env"), "utf8").split("\n")
  .filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

let pass = 0, total = 0;
const check = (name, cond, extra = "") => { total++; if (cond) pass++; console.log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m${extra ? "  " + extra : ""}`); return cond; };

const PORT = 8801, WSURL = `ws://localhost:${PORT}`;
let agentLog = "";
function start(name, cmd, args, opts, capture) {
  const p = spawn(cmd, args, opts);
  const tag = (d) => { if (capture) agentLog += d.toString(); process.stdout.write(`\x1b[2m[${name}] ${d}\x1b[0m`); };
  p.stdout.on("data", tag); p.stderr.on("data", tag);
  return p;
}

// agent launched in the voizecode repo -> startup tab "voizecode", and it can scan ~/.claude/projects
const relay = start("relay", "deno", ["run", "--allow-net", "--allow-env", "--allow-read", "--env-file=.env", "main.ts"], { cwd: join(ROOT, "relay"), env: { ...process.env, ...env, VOIZE_RELAY_PORT: String(PORT) } });
const agent = start("agent", "node", [join(ROOT, "laptop/voizecode.mjs")], { cwd: ROOT, env: { ...process.env, VOIZE_MODEL: "haiku", VOIZE_RELAY_URL: WSURL } }, true);
await sleep(3500);

const ws = new WebSocket(WSURL);
const inbox = [];
let sessionsTabs = [];      // active tabs (relay "sessions")
let savedSessions = [], projects = [];
ws.on("message", (r) => {
  const m = JSON.parse(r.toString());
  if (m.t === "sessions") sessionsTabs = m.sessions;
  if (m.t === "sessions_list") { savedSessions = m.sessions; projects = m.projects; }
  inbox.push(m);
});
await new Promise((res) => ws.on("open", res));
ws.send(JSON.stringify({ t: "hello", role: "client", since: 0 }));
await sleep(1500);

const tabIds = () => sessionsTabs.map((s) => s.sessionId);
async function waitFor(pred, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(200); } return false; }

console.log(`\n=== voizecode session-browser e2e ===`);
try {
  // startup tab exists -> gives us a sessionId to route control requests through
  await waitFor(() => sessionsTabs.length >= 1);
  const routeId = tabIds()[0];
  check("agent connected with a startup tab", !!routeId, routeId || "");

  // 1) list_sessions
  ws.send(JSON.stringify({ t: "list_sessions", sessionId: routeId }));
  await waitFor(() => projects.length > 0 || savedSessions.length > 0, 10000);
  check("list_sessions returned projects", projects.length > 0, `${projects.length} projects`);
  check("list_sessions returned past sessions", savedSessions.length > 0, `${savedSessions.length} sessions`);
  check("temp dirs filtered out of projects", !projects.some((p) => /\/(tmp|var\/folders)\//.test(p.cwd)),
    projects.slice(0, 3).map((p) => p.label).join(", "));
  check("sessions carry a real cwd + preview", savedSessions.every((s) => s.cwd && s.preview),
    JSON.stringify(savedSessions[0]?.preview?.slice(0, 40)));

  // 2) new chat in a project (use this repo's own dir so the spawn cwd is predictable)
  const proj = projects.find((p) => p.cwd === ROOT.replace(/\/$/, "")) || projects[0];
  const before = new Set(tabIds());
  ws.send(JSON.stringify({ t: "new_session", sessionId: routeId, cwd: proj.cwd, label: proj.label }));
  const gotProjectTab = await waitFor(() => tabIds().some((id) => !before.has(id)));
  check("new-chat-in-project created a new tab", gotProjectTab, tabIds().join(", "));
  check("agent spawned claude in the project's cwd", agentLog.includes(`in ${proj.cwd}`), proj.cwd);

  // 3) resume a past session (most recent) — assert spawn w/ --resume in its cwd, no turn sent
  const s0 = savedSessions[0];
  const before2 = new Set(tabIds());
  ws.send(JSON.stringify({ t: "new_session", sessionId: routeId, cwd: s0.cwd, resumeId: s0.id, label: s0.label }));
  const gotResumeTab = await waitFor(() => tabIds().some((id) => !before2.has(id)));
  check("resume created a new tab", gotResumeTab);
  check("agent spawned claude with --resume", agentLog.includes(`resume ${s0.id.slice(0, 8)}`), s0.id.slice(0, 8));
  check("resume used the session's own cwd", agentLog.includes(`in ${s0.cwd}`), s0.cwd);

  console.log(`\n=== ${pass}/${total} passed ===`);
} catch (e) {
  console.log("\x1b[31m[fatal] " + e.message + "\x1b[0m");
} finally {
  ws.close(); agent.kill("SIGINT"); relay.kill("SIGINT");
  await sleep(500);
  process.exit(pass === total ? 0 : 1);
}
