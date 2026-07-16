#!/usr/bin/env node
// Tells the running voizecode relay to open a chat in a given directory (used by `voize`).
// Connects as a client, waits for an active agent session to route through, then asks for a
// new chat in <dir>. Brief — the browser reconnects right after.
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import WebSocket from "../laptop/node_modules/ws/index.js";

const cwd = process.argv[2] || process.cwd();
const URL = process.env.VOIZE_RELAY_URL || "ws://localhost:8787";
// Deployed relays gate on the access token (same one the agent presents); local dev ignores it.
const token = process.env.VOIZE_TOKEN?.trim() ||
  (() => { try { return readFileSync(join(homedir(), ".voizecode", "token"), "utf8").trim(); } catch { return ""; } })();
const ws = new WebSocket(URL);
let sent = false;

ws.on("open", () => ws.send(JSON.stringify({ t: "hello", role: "client", token, since: 0 })));
ws.on("message", (r) => {
  let m; try { m = JSON.parse(r.toString()); } catch { return; }
  if (m.t === "sessions" && m.sessions?.[0] && !sent) {
    sent = true;
    ws.send(JSON.stringify({ t: "new_session", sessionId: m.sessions[0].sessionId, cwd, label: basename(cwd) }));
    setTimeout(() => { ws.close(); process.exit(0); }, 700);
  }
});
ws.on("error", (e) => { console.error("voize: relay not reachable —", e.message); process.exit(1); });
setTimeout(() => { console.error("voize: timed out waiting for the agent"); process.exit(1); }, 15000);
