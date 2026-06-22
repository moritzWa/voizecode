#!/usr/bin/env node
// voizecode — laptop side. Hosts one or more "chats", each a persistent `claude`
// stream-json session bridged to the relay over its OWN WebSocket. Because the relay
// treats one session per socket, N chats = N sockets and no per-message routing is needed.
//
//   client (mic) -> relay (STT) --user_message--> chat --> claude stdin
//   claude stdout --delta/tool_use/turn_end--> chat --> relay (narrate+TTS) -> client
//
// New chat: the UI asks the relay, which forwards `new_chat` to an existing chat's socket;
// this process then spins up a sibling chat (new socket + claude). Model switch / reset
// respawn that chat's claude (fresh context).

import { spawn } from "node:child_process";
import process from "node:process";
import { basename } from "node:path";
import WebSocket from "ws";

const RELAY_URL = process.env.VOIZE_RELAY_URL || "ws://localhost:8787";
const DEFAULT_MODEL = process.env.VOIZE_MODEL || "sonnet";
const RECONNECT_CAP_MS = Number(process.env.VOIZE_RECONNECT_CAP_MS) || 15000;
const REPO = process.env.VOIZE_SESSION || basename(process.cwd());

const claudeArgs = (m) => [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--dangerously-skip-permissions",
  "--model", m,
];

// One self-contained chat: its own claude process + its own relay websocket.
function startChat(sessionId, label, initialModel) {
  let model = initialModel;
  let claude = null, buf = "", turnText = "";
  let ws = null, hbTimer = null, wdTimer = null, retry = 0;

  const send = (m) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ ...m, sessionId }));
  const announce = () => send({ t: "init", sessionId, model, label });

  function startClaude() {
    const child = spawn("claude", claudeArgs(model), { stdio: ["pipe", "pipe", "inherit"] });
    claude = child; buf = ""; turnText = "";
    console.log(`[${sessionId}] spawned claude (${model}) in ${process.cwd()}`);
    child.stdout.on("data", (d) => { if (child === claude) onStdout(d); });
    child.on("exit", (c) => { if (child === claude) { console.log(`[${sessionId}] claude exited`, c); send({ t: "exit", code: c ?? 0 }); } });
  }
  function switchModel(next) {
    if (next === model || !["haiku", "sonnet", "opus"].includes(next)) return;
    console.log(`[${sessionId}] model ${model} -> ${next}`);
    model = next;
    const old = claude; startClaude(); old?.stdin.end(); old?.kill("SIGINT");
    announce();
  }
  function resetSession() {
    console.log(`[${sessionId}] reset (fresh claude context)`);
    const old = claude; startClaude(); old?.stdin.end(); old?.kill("SIGINT");
    announce();
  }

  const pushTurn = (text) =>
    claude?.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
  const interrupt = () =>
    claude?.stdin.write(JSON.stringify({ type: "control_request", request_id: "int-" + Date.now(), request: { subtype: "interrupt" } }) + "\n");

  function connect() {
    const sock = new WebSocket(RELAY_URL);
    ws = sock;
    const clearTimers = () => { if (hbTimer) clearInterval(hbTimer); if (wdTimer) clearTimeout(wdTimer); };
    const armWatchdog = () => { if (wdTimer) clearTimeout(wdTimer); wdTimer = setTimeout(() => { try { sock.terminate(); } catch { /* gone */ } }, 25000); };
    sock.on("open", () => {
      retry = 0;
      console.log(`[${sessionId}] relay connected`);
      send({ t: "hello", role: "agent", sessionId, label });
      announce();
      hbTimer = setInterval(() => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "ping" })); }, 10000);
      armWatchdog();
    });
    sock.on("message", (raw) => {
      armWatchdog();
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === "pong") return;
      if (m.t === "user_message") { console.log(`[${sessionId}] << user:`, m.text); pushTurn(m.text); }
      else if (m.t === "interrupt") { interrupt(); }
      else if (m.t === "set_model") { switchModel(m.model); }
      else if (m.t === "reset") { resetSession(); }
      else if (m.t === "new_chat") { createChat(); } // spawn a sibling chat
    });
    sock.on("close", () => {
      clearTimers();
      const delay = Math.min(1000 * 2 ** retry, RECONNECT_CAP_MS) + Math.random() * 500;
      retry++;
      console.log(`[${sessionId}] relay closed, retrying in ${Math.round(delay)}ms`);
      setTimeout(connect, delay);
    });
    sock.on("error", (e) => console.log(`[${sessionId}] relay error:`, e.message));
  }

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
    if (m.type === "stream_event" && m.event?.delta?.text) {
      turnText += m.event.delta.text;
      send({ t: "delta", text: m.event.delta.text });
    } else if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block.type === "tool_use") send({ t: "tool_use", name: block.name, summary: toolSummary(block), speak: toolSpeakable(block) });
      }
    } else if (m.type === "result") {
      send({ t: "turn_end", fullText: turnText.trim() });
      turnText = "";
    }
  }

  startClaude();
  connect();
  return { sessionId, kill: () => { try { claude?.kill("SIGINT"); } catch { /* noop */ } try { ws?.close(); } catch { /* noop */ } } };
}

// ---- tool summaries / speakability ----
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
const READONLY_BASH = new Set(["ls", "find", "cat", "grep", "rg", "fd", "head", "tail", "wc", "pwd",
  "echo", "which", "tree", "stat", "du", "df", "env", "sed", "awk", "cd", "git"]);
function toolSpeakable(block) {
  const i = block.input || {};
  switch (block.name) {
    case "Edit": case "Write": case "NotebookEdit": case "Task": case "WebSearch": case "WebFetch": return true;
    case "Bash": return !READONLY_BASH.has(String(i.command || "").trim().split(/\s+/)[0]);
    default: return false;
  }
}

// ---- chat registry ----
const chats = [];
let chatCounter = 0;
function createChat() {
  chatCounter++;
  const sessionId = chatCounter === 1 ? REPO : `${REPO}#${chatCounter}`;
  const label = chatCounter === 1 ? REPO : `${REPO} ${chatCounter}`;
  chats.push(startChat(sessionId, label, DEFAULT_MODEL));
}
createChat(); // first chat

process.on("SIGINT", () => { for (const c of chats) c.kill(); process.exit(0); });
