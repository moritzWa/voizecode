#!/usr/bin/env node
// voizecode — laptop side. Run it ONCE (anywhere). It hosts one or more "chats", each a
// persistent `claude` stream-json session in some directory, bridged to the relay over its
// OWN WebSocket. The web app can list past Claude Code sessions across all directories and
// open/resume any of them, or start a new chat in any project that already has sessions.
//
//   client (mic) -> relay (STT) --user_message--> chat --> claude stdin
//   claude stdout --delta/tool_use/turn_end--> chat --> relay (narrate+TTS) -> client

import { spawn, execFile } from "node:child_process";
import process from "node:process";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import WebSocket from "ws";

const RELAY_URL = process.env.VOIZE_RELAY_URL || "ws://localhost:8787";
const DEFAULT_MODEL = process.env.VOIZE_MODEL || "sonnet";
const RECONNECT_CAP_MS = Number(process.env.VOIZE_RECONNECT_CAP_MS) || 15000;

const claudeArgs = (m, resumeId) => [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--dangerously-skip-permissions",
  "--model", m,
  ...(resumeId ? ["--resume", resumeId] : []),
];

// One self-contained chat: its own claude process (in `cwd`, optionally resuming a session)
// + its own relay websocket. The relay keys sessions by socket, so N chats = N sockets.
function startChat(sessionId, label, initialModel, cwd, resumeId) {
  let model = initialModel;
  let resume = resumeId || null;
  const history = resume ? buildHistory(resume) : null; // prior transcript to show in the viewer
  let claude = null, buf = "", turnText = "";
  let ws = null, hbTimer = null, wdTimer = null, retry = 0, closed = false;

  const send = (m) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ ...m, sessionId }));
  const announce = () => send({ t: "init", sessionId, model, label });

  function startClaude() {
    // VOIZE_NO_ANNOUNCE lets the user's Stop hook (done-announce.sh) skip the "finished" sound —
    // we already speak the reply, so the chime is redundant for voizecode sessions.
    const child = spawn("claude", claudeArgs(model, resume), { stdio: ["pipe", "pipe", "inherit"], cwd, env: { ...process.env, VOIZE_NO_ANNOUNCE: "1" } });
    claude = child; buf = ""; turnText = "";
    console.log(`[${sessionId}] spawned claude (${model}${resume ? " resume " + resume.slice(0, 8) : ""}) in ${cwd}`);
    child.stdout.on("data", (d) => { if (child === claude) onStdout(d); });
    child.on("exit", (c) => { if (child === claude) { console.log(`[${sessionId}] claude exited`, c); send({ t: "exit", code: c ?? 0 }); } });
  }
  function switchModel(next) {
    if (next === model || !["haiku", "sonnet", "opus"].includes(next)) return;
    console.log(`[${sessionId}] model ${model} -> ${next}`);
    model = next;
    const old = claude; startClaude(); old?.stdin.end(); old?.kill("SIGINT"); // keeps resume -> same context
    announce();
  }
  function resetSession() {
    console.log(`[${sessionId}] reset (fresh claude context)`);
    resume = null; // new chat = drop any resumed session
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
      if (history && history.length) send({ t: "history", sessionId, messages: history }); // populate viewer on resume
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
      else if (m.t === "new_chat") { createChat({ cwd: m.cwd, resumeId: m.resumeId, label: m.label }); }
      else if (m.t === "list_sessions") { send({ t: "sessions_list", ...scanSessions() }); }
      else if (m.t === "list_prs") { listPRs(cwd, (prs) => send({ t: "prs", prs })); }
      else if (m.t === "close") { // kill this chat for good (UI closed the tab)
        closed = true;
        clearTimers();
        try { claude?.kill("SIGINT"); } catch { /* noop */ }
        try { sock.close(); } catch { /* noop */ }
        const i = chats.findIndex((c) => c.sessionId === sessionId);
        if (i >= 0) chats.splice(i, 1);
        console.log(`[${sessionId}] closed`);
      }
    });
    sock.on("close", () => {
      if (closed) return; // deliberate close -> don't reconnect
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
    if (m.type === "system" && m.subtype === "init" && m.session_id) {
      send({ t: "meta", claudeSessionId: m.session_id, cwd }); // for the "copy debug info" button
    } else if (m.type === "stream_event" && m.event?.delta?.text) {
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
    // Prefer Claude's human description ("Run the tests"); fall back to the command's first word.
    case "Bash": return String(i.description || "").trim() || `running ${firstWord(i.command) || "a command"}`;
    case "Grep": case "Glob": return `searching for ${i.pattern || ""}`;
    default: return `using ${block.name}`;
  }
}
const short = (p) => (p ? String(p).split("/").slice(-1)[0] : "");
// First real command word, skipping leading comment lines (so we don't show "running #").
function firstWord(cmd) {
  const lines = String(cmd || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !l.startsWith("#")) || lines[0] || "";
  return line.split(/\s+/)[0] || "";
}
const READONLY_BASH = new Set(["ls", "find", "cat", "grep", "rg", "fd", "head", "tail", "wc", "pwd",
  "echo", "which", "tree", "stat", "du", "df", "env", "sed", "awk", "cd", "git"]);
function toolSpeakable(block) {
  const i = block.input || {};
  switch (block.name) {
    case "Edit": case "Write": case "NotebookEdit": case "Task": case "WebSearch": case "WebFetch": return true;
    case "Bash": return !READONLY_BASH.has(firstWord(i.command));
    default: return false;
  }
}

// ---- scan past Claude Code sessions (~/.claude/projects/<enc-cwd>/<uuid>.jsonl) ----
function readHead(file, maxBytes = 131072) {
  let fd;
  try { fd = openSync(file, "r"); const b = Buffer.alloc(maxBytes); const n = readSync(fd, b, 0, maxBytes, 0); return b.subarray(0, n).toString("utf8"); }
  catch { return ""; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* noop */ } } }
}
function firstUserText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.find((c) => c?.type === "text" && c.text)?.text || "";
  return "";
}
// Reconstruct a resumed session's transcript (real user/assistant text, last 60 msgs) for the viewer.
function buildHistory(id) {
  const root = join(homedir(), ".claude", "projects");
  let file = null;
  try {
    for (const d of readdirSync(root)) {
      const f = join(root, d, id + ".jsonl");
      try { statSync(f); file = f; break; } catch { /* not here */ }
    }
  } catch { return []; }
  if (!file) return [];
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  const msgs = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.isMeta || m.isSidechain) continue;
    if (m.type === "user" && m.message?.content) {
      const text = firstUserText(m.message.content).trim();
      if (!text || /^<(local-command|command-)/.test(text)) continue; // skip tool results + caveats
      msgs.push({ role: "user", text });
    } else if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      const text = m.message.content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("").trim();
      if (text) msgs.push({ role: "assistant", text });
    }
  }
  return msgs.slice(-60);
}

function scanSessions() {
  const root = join(homedir(), ".claude", "projects");
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return { sessions: [], projects: [] }; }
  const sessions = [];
  for (const d of dirs) {
    const dir = join(root, d);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const file = join(dir, f);
      let mtime = 0;
      try { mtime = statSync(file).mtimeMs; } catch { continue; }
      let cwd = "", preview = "";
      for (const line of readHead(file).split("\n")) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (!cwd && m.cwd) cwd = m.cwd;
        if (!preview && m.type === "user" && m.message?.content) preview = firstUserText(m.message.content).trim();
        if (cwd && preview) break;
      }
      if (!cwd || !preview) continue; // need a real dir + an actual prompt
      if (/^\/(private\/)?(tmp|var\/folders)\//.test(cwd)) continue; // skip throwaway temp dirs
      sessions.push({ id: f.replace(/\.jsonl$/, ""), cwd, label: basename(cwd), preview: preview.slice(0, 100), mtime });
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  // distinct projects = dirs that already have sessions (the real codebases), most-recent first
  const byCwd = new Map();
  for (const s of sessions) {
    const p = byCwd.get(s.cwd) || { cwd: s.cwd, label: basename(s.cwd), count: 0, mtime: 0 };
    p.count++; p.mtime = Math.max(p.mtime, s.mtime); byCwd.set(s.cwd, p);
  }
  const projects = [...byCwd.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 40);
  return { sessions: sessions.slice(0, 60), projects };
}

// List the current user's PRs in this chat's repo (incl. drafts), newest first, via gh.
function listPRs(cwd, cb) {
  execFile("gh", ["pr", "list", "--author", "@me", "--state", "all", "--limit", "30",
    "--json", "number,title,url,createdAt,isDraft"],
    { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) { console.log(`[prs] gh error: ${err.message.split("\n")[0]}`); return cb([]); }
      let arr = [];
      try { arr = JSON.parse(stdout); } catch { /* noop */ }
      arr.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      cb(arr.map((p) => ({ number: p.number, title: p.title, url: p.url, createdAt: p.createdAt, isDraft: !!p.isDraft })));
    });
}

// ---- chat registry ----
const chats = [];
let chatCounter = 0;
function createChat(opts = {}) {
  chatCounter++;
  const cwd = opts.cwd || process.cwd();
  const label = opts.label || basename(cwd) || `chat ${chatCounter}`;
  const sessionId = `${(basename(cwd) || "chat").replace(/[^\w.-]/g, "_")}#${chatCounter}`;
  chats.push(startChat(sessionId, label, DEFAULT_MODEL, cwd, opts.resumeId || null));
}
createChat(); // first chat in the launch directory

process.on("SIGINT", () => { for (const c of chats) c.kill(); process.exit(0); });
