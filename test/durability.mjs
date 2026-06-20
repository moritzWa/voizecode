#!/usr/bin/env node
// Durability e2e: proves the system survives network drops and self-heals.
//
//   1. ping -> pong          (heartbeat round-trip)
//   2. replay on reconnect   (a fresh client with `since` catches up on missed messages;
//                             with since=max it gets nothing — no dupes)
//   3. relay restart         (kill the relay mid-session; client AND agent both back off,
//                             reconnect when it returns, and a new turn is answered)
//
// Reads keys from relay/.env. Uses the typed-text path (no STT needed).

import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import WebSocket from "../laptop/node_modules/ws/index.js";

const ROOT = new URL("..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = Object.fromEntries(readFileSync(join(ROOT, "relay/.env"), "utf8").split("\n")
  .filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

let pass = 0, total = 0;
const check = (name, cond) => { total++; if (cond) pass++; console.log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`); return cond; };

function start(name, cmd, args, opts) {
  const p = spawn(cmd, args, opts);
  const tag = (d) => process.stdout.write(`\x1b[2m[${name}] ${d}\x1b[0m`);
  p.stdout.on("data", tag); p.stderr.on("data", tag);
  return p;
}
// Spawn `deno run` directly (NOT `deno task`, whose wrapper child would survive kill and
// keep holding the port), so relay.kill() actually takes the server down.
const startRelay = () => start("relay", "deno",
  ["run", "--allow-net", "--allow-env", "--env-file=.env", "main.ts"],
  { cwd: join(ROOT, "relay"), env: { ...process.env, ...env } });

// A reconnecting client that records inbound messages and tracks lastSeq (like the real app).
function makeClient(sessionId) {
  const c = { ws: null, inbox: [], lastSeq: 0, connected: false, closed: false };
  const connect = () => {
    if (c.closed) return;
    const sock = new WebSocket("ws://localhost:8787");
    c.ws = sock;
    sock.on("open", () => { c.connected = true; sock.send(JSON.stringify({ t: "hello", role: "client", since: c.lastSeq })); });
    sock.on("close", () => { c.connected = false; if (!c.closed) setTimeout(connect, 500); });
    sock.on("error", () => {});
    sock.on("message", (r) => {
      const m = JSON.parse(r.toString());
      if (typeof m.seq === "number") c.lastSeq = Math.max(c.lastSeq, m.seq);
      c.inbox.push(m);
    });
  };
  c.connect = connect;
  c.send = (m) => c.ws?.readyState === WebSocket.OPEN && c.ws.send(JSON.stringify({ ...m, sessionId }));
  c.drain = () => c.inbox.splice(0);
  c.shutdown = () => { c.closed = true; try { c.ws?.close(); } catch { /* gone */ } }; // stop reconnect loop (relay has one client slot)
  return c;
}

async function runTurn(client, sessionId, text) {
  client.drain();
  client.send({ t: "text", text });
  const deadline = Date.now() + 90000;
  let agentText = "", doneAt = 0;
  while (Date.now() < deadline) {
    for (const m of client.inbox.splice(0)) {
      if (m.sessionId !== sessionId) continue;
      if (m.t === "agent_text") agentText += m.text;
      if (m.t === "thinking" && m.on === false) doneAt = Date.now();
    }
    if (doneAt && Date.now() - doneAt > 3000) break;
    await sleep(150);
  }
  return agentText;
}

// ---- boot ----
const repo = mkdtempSync(join(tmpdir(), "voize-dur-"));
const S = basename(repo);
let relay = startRelay();
const agent = start("agent", "node", [join(ROOT, "laptop/voizecode.mjs")], { cwd: repo, env: { ...process.env, VOIZE_MODEL: "haiku" } });
await sleep(3500);

const c = makeClient(S);
c.connect();
await sleep(1500);
console.log(`\n=== voizecode durability (session ${S}) ===`);

try {
  // wait for the session to register
  for (let i = 0; i < 20 && !c.inbox.some((m) => m.t === "sessions" && m.sessions.some((s) => s.sessionId === S)); i++) await sleep(300);

  // 1) heartbeat
  c.drain();
  c.ws.send(JSON.stringify({ t: "ping" }));
  let gotPong = false;
  for (let i = 0; i < 20 && !gotPong; i++) { if (c.inbox.some((m) => m.t === "pong")) gotPong = true; await sleep(100); }
  check("ping -> pong (heartbeat round-trip)", gotPong);

  // a real turn so the ring buffer has seq'd messages to replay
  const reply1 = await runTurn(c, S, "Reply with exactly the word: ALPHA");
  check("turn answered before drop", /alpha/i.test(reply1));
  const maxSeq = c.lastSeq;

  // 2) replay: a brand-new client with since:0 should catch up on the buffered messages
  const fresh = makeClient(S);
  fresh.lastSeq = 0;
  fresh.connect();
  await sleep(1500);
  const replayed = fresh.inbox.filter((m) => typeof m.seq === "number" && m.seq <= maxSeq);
  check("replay: reconnecting client catches up on missed messages", replayed.length > 0);
  // and a client already caught up (since:max) gets no seq'd replay -> no dupes
  const fresh2 = makeClient(S);
  fresh2.lastSeq = maxSeq;
  fresh2.connect();
  await sleep(1500);
  const dupes = fresh2.inbox.filter((m) => typeof m.seq === "number" && m.seq <= maxSeq);
  check("no dupes: caught-up client (since=max) gets no replay", dupes.length === 0);
  fresh.shutdown(); fresh2.shutdown();

  // 3) relay restart: kill it mid-session, both client + agent must self-heal
  console.log("\n\x1b[1m# killing relay (simulated outage)\x1b[0m");
  relay.kill("SIGKILL");
  await sleep(2500);
  check("client detected the outage (disconnected)", c.connected === false);

  console.log("\x1b[1m# restarting relay\x1b[0m");
  relay = startRelay();
  // wait for client to reconnect AND agent to re-register its session
  let healed = false;
  for (let i = 0; i < 40 && !healed; i++) {
    await sleep(500);
    healed = c.connected && c.inbox.some((m) => m.t === "sessions" && m.sessions.some((s) => s.sessionId === S));
  }
  check("client + agent reconnected after relay restart", healed);

  // a fresh turn must be answered post-recovery
  const reply2 = await runTurn(c, S, "Reply with exactly the word: BETA");
  check("new turn answered after recovery (end-to-end healed)", /beta/i.test(reply2));

  console.log(`\n=== ${pass}/${total} passed ===`);
} catch (e) {
  console.log("\x1b[31m[fatal] " + e.message + "\x1b[0m");
} finally {
  c.ws?.close(); agent.kill("SIGINT"); relay.kill("SIGINT");
  await sleep(500);
  process.exit(pass === total ? 0 : 1);
}
