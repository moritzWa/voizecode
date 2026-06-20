#!/usr/bin/env node
// voizecode — laptop side. Spawns a persistent `claude` stream-json session in
// the current repo and bridges it to the relay over WebSocket.
//
//   client (mic) -> relay (STT) --user_message--> THIS --> claude stdin
//   claude stdout --delta/tool_use/turn_end--> THIS --> relay (narrate+TTS) -> client
//
// Validated mechanisms: persistent multi-turn input + mid-turn interrupt.
// Model switching restarts the claude process (fresh session).

import { spawn } from "node:child_process";
import process from "node:process";
import { basename } from "node:path";
import WebSocket from "ws";

const RELAY_URL = process.env.VOIZE_RELAY_URL || "ws://localhost:8787";
let model = process.env.VOIZE_MODEL || "sonnet";
const SESSION_ID = process.env.VOIZE_SESSION || basename(process.cwd()); // repo name = session id
const claudeArgs = (m) => [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--dangerously-skip-permissions",
  "--model", m,
];

// ---- restartable claude child ----
let claude = null;
let buf = "";
let turnText = "";

function startClaude() {
  const child = spawn("claude", claudeArgs(model), { stdio: ["pipe", "pipe", "inherit"] });
  claude = child;
  console.log(`[voizecode] spawned claude (${model}) in ${process.cwd()}`);
  buf = ""; turnText = "";
  child.stdout.on("data", (d) => { if (child === claude) onStdout(d); }); // ignore stragglers from replaced procs
  child.on("exit", (c) => {
    if (child !== claude) return; // a replaced (old) process exited during a switch — expected
    console.log("[voizecode] claude exited", c);
    send({ t: "exit", code: c ?? 0 });
    process.exit(c ?? 0);
  });
}

// Tell the relay which model is active now (claude is lazy and won't emit its own
// init until the next turn, so the UI would otherwise lag a switch).
const announceModel = () => send({ t: "init", sessionId: "local", model });

function switchModel(next) {
  if (next === model || !["haiku", "sonnet", "opus"].includes(next)) return;
  console.log(`[voizecode] switching model ${model} -> ${next}`);
  model = next;
  const old = claude;
  startClaude();          // claude now points to the new process; sends a fresh init
  old?.stdin.end();
  old?.kill("SIGINT");    // its exit handler no-ops (child !== claude)
  announceModel();
}

const pushTurn = (text) =>
  claude?.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
const interrupt = () =>
  claude?.stdin.write(JSON.stringify({ type: "control_request", request_id: "int-" + Date.now(), request: { subtype: "interrupt" } }) + "\n");

// ---- relay connection (auto-reconnect w/ heartbeat + backoff) ----
let ws = null;
let hbTimer = null;   // heartbeat ping interval
let wdTimer = null;   // silence watchdog
let retry = 0;        // backoff attempt count
const send = (m) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

function connect() {
  const sock = new WebSocket(RELAY_URL);
  ws = sock;
  const clearTimers = () => { if (hbTimer) clearInterval(hbTimer); if (wdTimer) clearTimeout(wdTimer); };
  // No inbound for 25s -> assume a half-open socket (network change) and force a reconnect.
  const armWatchdog = () => { if (wdTimer) clearTimeout(wdTimer); wdTimer = setTimeout(() => { try { sock.terminate(); } catch { /* gone */ } }, 25000); };
  sock.on("open", () => {
    retry = 0;
    console.log(`[voizecode] relay connected (session: ${SESSION_ID})`);
    send({ t: "hello", role: "agent", sessionId: SESSION_ID, label: SESSION_ID });
    announceModel();
    hbTimer = setInterval(() => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "ping" })); }, 10000);
    armWatchdog();
  });
  sock.on("message", (raw) => {
    armWatchdog();
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === "pong") return;
    if (m.t === "user_message") { console.log("[voizecode] << user:", m.text); pushTurn(m.text); }
    else if (m.t === "interrupt") { console.log("[voizecode] << interrupt"); interrupt(); }
    else if (m.t === "set_model") { switchModel(m.model); }
  });
  sock.on("close", () => {
    clearTimers();
    const delay = Math.min(1000 * 2 ** retry, Number(process.env.VOIZE_RECONNECT_CAP_MS) || 15000) + Math.random() * 500;
    retry++;
    console.log(`[voizecode] relay closed, retrying in ${Math.round(delay)}ms`);
    setTimeout(connect, delay);
  });
  sock.on("error", (e) => console.log("[voizecode] relay error:", e.message));
}

// ---- parse claude stream-json -> relay events ----
function onStdout(d) {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
}

function handle(m) {
  if (m.type === "system" && m.subtype === "init") {
    send({ t: "init", sessionId: m.session_id, model: m.model });
  } else if (m.type === "stream_event" && m.event?.delta?.text) {
    turnText += m.event.delta.text;
    send({ t: "delta", text: m.event.delta.text });
  } else if (m.type === "assistant" && Array.isArray(m.message?.content)) {
    for (const block of m.message.content) {
      if (block.type === "tool_use") send({ t: "tool_use", name: block.name, summary: toolSummary(block) });
    }
  } else if (m.type === "result") {
    send({ t: "turn_end", fullText: turnText.trim() });
    turnText = "";
  }
}

function toolSummary(block) {
  const i = block.input || {};
  switch (block.name) {
    case "Edit": case "Write": return `editing ${short(i.file_path)}`;
    case "Read": return `reading ${short(i.file_path)}`;
    case "Bash": return `running ${String(i.command || "").trim().split(/\s+/)[0] || "a command"}`;
    case "Grep": case "Glob": return `searching for ${i.pattern || ""}`;
    default: return `using ${block.name}`;
  }
}
const short = (p) => (p ? String(p).split("/").slice(-1)[0] : "");

startClaude();
connect();
process.on("SIGINT", () => { claude?.kill("SIGINT"); process.exit(0); });
