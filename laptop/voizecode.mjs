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
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
function startChat(sessionId, label, initialModel, cwd, resumeId, engine = "claude") {
  let model = initialModel;
  let resume = resumeId || null;
  const isCodex = engine === "codex";
  const history = !isCodex && resume ? buildHistory(resume) : null; // prior transcript to show in the viewer
  let claude = null, buf = "", turnText = "";
  let liveSessionId = resume || null; // the Claude session id currently being written (for forking)
  let codexProc = null, codexThread = isCodex ? resume : null; // codex: per-turn `exec`, resume by thread id
  let ws = null, hbTimer = null, wdTimer = null, retry = 0, closed = false;

  const send = (m) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ ...m, sessionId }));
  const announce = () => send({ t: "init", sessionId, model: isCodex ? "codex" : model, label, engine });

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
    if (isCodex) { codexThread = null; try { codexProc?.kill("SIGINT"); } catch { /* gone */ } codexProc = null; announce(); return; }
    console.log(`[${sessionId}] reset (fresh claude context)`);
    resume = null; // new chat = drop any resumed session
    const old = claude; startClaude(); old?.stdin.end(); old?.kill("SIGINT");
    announce();
  }

  // Fork this chat at a turn boundary: copy the live session's transcript up to (but not
  // including) the userIndex-th user turn into a new session id, then spawn a chat resuming it.
  // Claude continues with the truncated context; the client sends the (edited) message next.
  function forkChat(userIndex, forkLabel) {
    if (isCodex) return; // Claude-only
    const id = liveSessionId;
    if (!id) { console.log(`[${sessionId}] fork: no live session id yet`); return; }
    const root = join(homedir(), ".claude", "projects");
    let file = null;
    try { for (const d of readdirSync(root)) { const f = join(root, d, id + ".jsonl"); try { statSync(f); file = f; break; } catch { /* not here */ } } } catch { return; }
    if (!file) { console.log(`[${sessionId}] fork: no transcript for ${id}`); return; }
    let lines;
    try { lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()); } catch { return; }
    let count = 0, cut = -1; // line index of the userIndex-th real user turn
    for (let i = 0; i < lines.length; i++) {
      let m; try { m = JSON.parse(lines[i]); } catch { continue; }
      if (m.isMeta || m.isSidechain || m.type !== "user" || !m.message?.content) continue;
      const text = firstUserText(m.message.content).trim();
      const isToolResult = Array.isArray(m.message.content) && m.message.content[0]?.tool_use_id;
      if (!text || isToolResult || /^<(local-command|command-)/.test(text)) continue;
      if (count === userIndex) { cut = i; break; }
      count++;
    }
    if (cut <= 0) { console.log(`[${sessionId}] fork: couldn't locate user turn ${userIndex}`); return; }
    const newId = randomUUID();
    const dest = join(file.slice(0, file.lastIndexOf("/")), newId + ".jsonl");
    try { writeFileSync(dest, lines.slice(0, cut).join("\n") + "\n"); }
    catch (e) { console.log(`[${sessionId}] fork write failed:`, e.message); return; }
    console.log(`[${sessionId}] forked at user turn ${userIndex} -> ${newId.slice(0, 8)} (${cut} lines kept)`);
    createChat({ cwd, resumeId: newId, label: forkLabel || `${label} ↶`, engine: "claude" });
  }

  // --- Codex engine: one `codex exec` per turn, resuming by thread id (prompt via stdin) ---
  function codexTurn(text) {
    const flags = ["--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];
    // `exec resume` uses the session's recorded cwd and rejects -C; a fresh `exec` needs -C.
    const args = codexThread
      ? ["exec", "resume", codexThread, ...flags, "-"]
      : ["exec", ...flags, "-C", cwd, "-"];
    const proc = spawn("codex", args, { stdio: ["pipe", "pipe", "inherit"] });
    codexProc = proc; buf = ""; turnText = "";
    console.log(`[${sessionId}] codex ${codexThread ? "resume " + codexThread.slice(0, 8) : "new"} in ${cwd}`);
    proc.stdin.write(text); proc.stdin.end();
    proc.stdout.on("data", (d) => { if (proc === codexProc) onCodexStdout(d); });
    proc.on("exit", () => { if (proc === codexProc) { send({ t: "turn_end", fullText: turnText.trim() }); codexProc = null; } });
  }
  function onCodexStdout(d) {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim() || line[0] !== "{") continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "thread.started" && m.thread_id) { codexThread = m.thread_id; send({ t: "meta", claudeSessionId: m.thread_id, cwd }); }
      else if (m.type === "item.completed" && m.item) {
        const it = m.item;
        if (it.type === "agent_message" && it.text) { turnText += it.text; send({ t: "delta", text: it.text }); }
        else if (it.type !== "reasoning") send({ t: "tool_use", name: it.type, summary: codexToolSummary(it), speak: ["file_change", "web_search", "mcp_tool_call"].includes(it.type) });
      }
      // turn.completed is covered by proc exit -> turn_end
    }
  }

  const pushTurn = isCodex ? codexTurn : (text) =>
    claude?.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
  const interrupt = isCodex
    ? () => { try { codexProc?.kill("SIGINT"); } catch { /* gone */ } }
    : () => claude?.stdin.write(JSON.stringify({ type: "control_request", request_id: "int-" + Date.now(), request: { subtype: "interrupt" } }) + "\n");

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
      else if (m.t === "new_chat") { createChat({ cwd: m.cwd, resumeId: m.resumeId, label: m.label, engine: m.engine }); }
      else if (m.t === "fork") { forkChat(m.userIndex, m.label); }
      else if (m.t === "list_sessions") { send({ t: "sessions_list", ...scanSessions() }); }
      else if (m.t === "list_prs") { listPRs(cwd, m.scope, (prs) => send({ t: "prs", prs })); }
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
      liveSessionId = m.session_id;
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

  if (!isCodex) startClaude(); // codex spawns per-turn, not persistently
  connect();
  return { sessionId, kill: () => { try { claude?.kill("SIGINT"); } catch { /* noop */ } try { codexProc?.kill("SIGINT"); } catch { /* noop */ } try { ws?.close(); } catch { /* noop */ } } };
}

// Short status line for a Codex tool/event item.
function codexToolSummary(it) {
  switch (it.type) {
    case "command_execution": return `running ${firstWord(it.command) || "a command"}`;
    case "file_change": return `editing ${short((it.changes && it.changes[0] && it.changes[0].path) || it.path || "files")}`;
    case "web_search": return `searching the web${it.query ? ` for ${String(it.query).slice(0, 40)}` : ""}`;
    case "mcp_tool_call": return `using ${it.tool || it.server || "a tool"}`;
    default: return `using ${it.type}`;
  }
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
  "echo", "which", "tree", "stat", "du", "df", "env", "sed", "awk", "cd", "git", "gh", "jq", "cut", "sort", "uniq"]);
// `gh` is read-only by default (pr diff/view/list etc.); only voice it for clear mutations.
const GH_WRITE = new Set(["create", "merge", "close", "edit", "comment", "review", "ready", "reopen",
  "delete", "rerun", "sync", "push", "approve"]);
function bashSpeakable(cmd) {
  const fw = firstWord(cmd);
  if (fw === "gh") return String(cmd || "").trim().split(/\s+/).slice(1, 4).some((w) => GH_WRITE.has(w));
  return !READONLY_BASH.has(fw);
}
function toolSpeakable(block) {
  const i = block.input || {};
  switch (block.name) {
    case "Edit": case "Write": case "NotebookEdit": case "Task": case "WebSearch": case "WebFetch": return true;
    case "Bash": return bashSpeakable(i.command);
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
function listPRs(cwd, scope, cb) {
  const args = ["pr", "list", "--state", "all", "--limit", scope === "all" ? "50" : "30",
    "--json", "number,title,url,createdAt,isDraft,author"];
  if (scope !== "all") args.push("--author", "@me");
  execFile("gh", args, { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    if (err) { console.log(`[prs] gh error: ${err.message.split("\n")[0]}`); return cb([]); }
    let arr = [];
    try { arr = JSON.parse(stdout); } catch { /* noop */ }
    arr.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    cb(arr.map((p) => ({ number: p.number, title: p.title, url: p.url, createdAt: p.createdAt, isDraft: !!p.isDraft, author: p.author?.login || "" })));
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
  chats.push(startChat(sessionId, label, DEFAULT_MODEL, cwd, opts.resumeId || null, opts.engine || "claude"));
}
createChat(); // first chat in the launch directory

process.on("SIGINT", () => { for (const c of chats) c.kill(); process.exit(0); });
