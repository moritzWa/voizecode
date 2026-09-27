// Bridges a live `claude --bg` (agent-view) session into voizecode's existing agent protocol,
// so a phone/browser chat can join a session that's *also* open in the desktop agent view or
// another voizecode tab — instead of always forking a divergent copy (the old behavior in
// voizecode.mjs, still used for interactive/foreground sessions, which have no other way in).
//
// Why this needs a real PTY, not stdio pipes: `claude attach <id>` renders Ink's live TUI.
// Verified 2026-09-27: piping its stdio with no TTY tears the process down within
// milliseconds (it prints "Attaching…", then immediately unwinds the alt-screen and exits).
// Through a real pseudo-terminal it renders the full transcript normally. A headless xterm
// parses the same ANSI a real terminal would and hands us clean screen-buffer text to diff —
// far more robust than regexing raw escape codes ourselves.
//
// This is a screen-scrape of a UI that isn't a documented protocol, so it's inherently more
// fragile than the stream-json path other chats use: a Claude Code UI change can break the
// marker characters below. Keep MARKERS in sync with `claude attach`'s rendering if it drifts.
import pty from "node-pty";
import xtermHeadless from "@xterm/headless"; // CJS package: no named ESM exports
const { Terminal } = xtermHeadless;

const COLS = 220, ROWS = 50;
const QUIET_MS = 700; // settle window: Ink stops repainting once a turn is fully rendered
const REPLY_MARKER = "⏺"; // Claude Code's own glyph for "assistant said this"
// Whichever comes first after the reply ends the extracted text: "❯" is the input prompt row
// (present once you've typed something); "✻ Worked for Ns" is the idle footer (present at rest,
// before you've typed anything this turn) — both verified live 2026-09-27.
const END_MARKERS = ["❯", "✻"];

function bufferText(term) {
  const lines = [];
  for (let i = 0; i < term.buffer.active.length; i++) {
    const line = term.buffer.active.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

// Best-effort extraction of "the current assistant reply" from the rendered screen: the text
// between the last reply marker and the next prompt line. Turn-by-turn only (no token deltas —
// attach gives us a redrawn screen, not a token stream), which is enough for voice + the board;
// refine once this is running against real conversations.
function extractLastReply(text) {
  const marker = text.lastIndexOf(REPLY_MARKER);
  if (marker === -1) return null;
  const after = text.slice(marker + REPLY_MARKER.length);
  let end = after.length;
  for (const m of END_MARKERS) { const i = after.indexOf(m); if (i !== -1 && i < end) end = i; }
  return after.slice(0, end)
    .split("\n").map((l) => l.trim()).filter(Boolean).join(" ").trim();
}

// shortId = the 8-char id `claude agents --json` and `claude --bg` print (NOT the full
// sessionId uuid — `claude attach` takes the short form only).
export function startAttach({ shortId, cwd, onDelta, onTurnEnd, onExit, onLog }) {
  const log = onLog || (() => {});
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  let proc;
  try {
    proc = pty.spawn("claude", ["attach", shortId], {
      name: "xterm-256color", cols: COLS, rows: ROWS, cwd, env: process.env,
    });
  } catch (e) {
    log(`attach spawn failed: ${e.message}`);
    onExit(1, e.message);
    return null;
  }

  let lastReply = "";
  let quietTimer = null;

  proc.onData((data) => {
    term.write(data);
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      const reply = extractLastReply(bufferText(term));
      if (reply && reply !== lastReply) {
        lastReply = reply;
        onDelta(reply);
        onTurnEnd(reply);
      }
    }, QUIET_MS);
  });

  proc.onExit(({ exitCode }) => {
    if (quietTimer) clearTimeout(quietTimer);
    onExit(exitCode);
  });

  return {
    write(text) { proc.write(text.replace(/\r?\n/g, " ") + "\r"); }, // one line: Enter submits
    interrupt() { proc.write("\x1b"); }, // Escape = Claude Code's own interrupt key
    resize(cols, rows) { try { proc.resize(cols || COLS, rows || ROWS); term.resize(cols || COLS, rows || ROWS); } catch { /* already dead */ } },
    kill() { try { proc.kill(); } catch { /* already dead */ } },
  };
}

// Looks up which live sessions are `--bg` (attachable) vs plain interactive (fork-only, as
// before), keyed by both the full sessionId and the short id `attach` needs.
export function liveBackgroundSessions(execFileSync) {
  const byFullId = new Map(); // sessionId -> shortId
  try {
    for (const a of JSON.parse(execFileSync("claude", ["agents", "--json"], { timeout: 5000, encoding: "utf8" }))) {
      if (a?.kind === "background" && a?.sessionId && a?.id) byFullId.set(a.sessionId, a.id);
    }
  } catch { /* claude missing or output changed: caller falls back to fork-on-live */ }
  return byFullId;
}
