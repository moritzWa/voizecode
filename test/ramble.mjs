#!/usr/bin/env node
// Ramble flush: pressing send must send what you said.
//
// The relay only appends Deepgram's FINAL results to its buffer; the in-progress text is streamed
// to the client for display and kept nowhere else. Deepgram finalizes on a pause, and tapping send
// is precisely not a pause — so the tail of the sentence, often all of it, was still interim at
// that moment. The flush found an empty buffer, sent no turn AND no discard, and the sentence sat
// greyed out at the bottom of the transcript, unsent, with no way to recover it.
//
// Deepgram is stubbed so that race is deterministic: the fake emits interim results for audio and
// only produces a final when asked to Finalize (or never, for the worst case).
//
//   node test/ramble.mjs

import { spawn } from "node:child_process";
import { join } from "node:path";
// `ws` is CommonJS, so it has no named exports through the ESM loader.
import ws from "../laptop/node_modules/ws/index.js";
const { WebSocketServer, WebSocket } = ws;

const ROOT = new URL("..", import.meta.url).pathname;
const DG_PORT = 8791, RELAY_PORT = 8790, SID = "t1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, total = 0;
const check = (name, cond, got) => {
  total++; if (cond) pass++;
  console.log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`);
  if (!cond && got !== undefined) console.log(`      got: ${JSON.stringify(got).slice(0, 300)}`);
};

// ---- fake Deepgram ---------------------------------------------------------------------------
// `mode` decides what this connection does, so each scenario can pick the behaviour it needs.
let mode = { interim: "", finalOnFinalize: "" };
const dgServer = new WebSocketServer({ port: DG_PORT });
const say = (ws, transcript, is_final) =>
  ws.send(JSON.stringify({ type: "Results", is_final, channel: { alternatives: [{ transcript }] } }));
dgServer.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => {
    if (isBinary) { if (mode.interim) say(ws, mode.interim, false); return; }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    // The real API turns whatever is buffered into a final on this.
    if (m.type === "Finalize" && mode.finalOnFinalize) say(ws, mode.finalOnFinalize, true);
  });
});

// ---- relay ------------------------------------------------------------------------------------
const relay = spawn("deno", ["run", "--allow-net", "--allow-env", "main.ts"], {
  cwd: join(ROOT, "relay"),
  env: {
    ...process.env,
    VOIZE_RELAY_PORT: String(RELAY_PORT),
    VOIZE_DG_URL: `ws://127.0.0.1:${DG_PORT}`,
    DEEPGRAM_API_KEY: "fake-key-for-the-stub",
    VOIZE_FINALIZE_WAIT_MS: "400",
    VOIZE_FINALIZE_SETTLE_MS: "120",
  },
  detached: true,
});
const relayLog = [];
relay.stdout.on("data", (d) => relayLog.push(d.toString()));
relay.stderr.on("data", (d) => relayLog.push(d.toString()));
await sleep(1500);

// ---- agent + client ---------------------------------------------------------------------------
const agentInbox = [], clientInbox = [];
const agent = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}`);
await new Promise((r, j) => { agent.on("open", r); agent.on("error", j); });
agent.on("message", (d) => agentInbox.push(JSON.parse(d.toString())));
agent.send(JSON.stringify({ t: "hello", role: "agent", sessionId: SID, label: SID }));

const client = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}`);
await new Promise((r, j) => { client.on("open", r); client.on("error", j); });
client.on("message", (d) => clientInbox.push(JSON.parse(d.toString())));
client.send(JSON.stringify({ t: "hello", role: "client", since: 0 }));
await sleep(400);

const send = (m) => client.send(JSON.stringify({ ...m, sessionId: SID }));
const speak = async (frames = 2) => {
  for (let i = 0; i < frames; i++) { send({ t: "audio", pcm: Buffer.alloc(640).toString("base64") }); await sleep(60); }
};
const drain = () => { agentInbox.length = 0; clientInbox.length = 0; };
const waitFor = async (inbox, pred, ms = 2500) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const hit = inbox.find(pred); if (hit) return hit; await sleep(50); }
  return null;
};

console.log("\n=== ramble flush ===");

try {
  // 1) The reported bug: everything is still interim when send is pressed.
  mode = { interim: "summarize the three main unknowns of this project", finalOnFinalize: "" };
  drain();
  send({ t: "ramble", on: true });
  await speak();
  send({ t: "ramble", on: false });
  const turn = await waitFor(agentInbox, (m) => m.t === "user_message");
  check("a ramble with no finals at all is still sent", !!turn, agentInbox.map((m) => m.t));
  check("it carries the interim text that was on screen",
    (turn?.text ?? "").includes("three main unknowns"), turn?.text);

  // 2) Deepgram answers the Finalize: the tail must be included, not dropped or duplicated.
  mode = { interim: "and why it needs", finalOnFinalize: "and why it needs to keep state in memory" };
  drain();
  send({ t: "ramble", on: true });
  await speak();
  send({ t: "ramble", on: false });
  const turn2 = await waitFor(agentInbox, (m) => m.t === "user_message");
  check("the finalized tail is sent", (turn2?.text ?? "").includes("keep state in memory"), turn2?.text);
  check("the interim is not duplicated onto the final",
    (turn2?.text.match(/and why it needs/g) ?? []).length === 1, turn2?.text);

  // 3) Genuinely nothing said: the draft must be cleared rather than left stuck on screen.
  mode = { interim: "", finalOnFinalize: "" };
  drain();
  send({ t: "ramble", on: true });
  await speak();
  send({ t: "ramble", on: false });
  const cleared = await waitFor(clientInbox, (m) => m.t === "utterance_discarded");
  check("an empty ramble clears the draft instead of stranding it", !!cleared, clientInbox.map((m) => m.t));
  check("and says why", !!(await waitFor(clientInbox, (m) => m.t === "status" && /nothing was transcribed/.test(m.text ?? ""))));
  check("nothing is sent to the agent", !agentInbox.some((m) => m.t === "user_message"), agentInbox.map((m) => m.t));

  // 4) Discard still discards — the flush must not have turned "cancel" into "send".
  mode = { interim: "forget this one", finalOnFinalize: "" };
  drain();
  send({ t: "ramble", on: true });
  await speak();
  send({ t: "ramble", on: false, discard: true });
  await sleep(900);
  check("discard sends nothing to the agent", !agentInbox.some((m) => m.t === "user_message"), agentInbox.map((m) => m.t));
  check("discard clears the draft", clientInbox.some((m) => m.t === "utterance_discarded"));

  // 5) A normal (non-ramble) utterance must still auto-commit on its own after the pause.
  mode = { interim: "hello there", finalOnFinalize: "" };
  drain();
  await speak();
  // The auto-commit debounce is driven by finals, which this scenario never produces, so nothing
  // should be delivered — the point is that the flush machinery has not made it fire spuriously.
  await sleep(900);
  check("no ramble in progress: an interim alone is not auto-sent",
    !agentInbox.some((m) => m.t === "user_message"), agentInbox.map((m) => m.t));
} finally {
  try { client.close(); agent.close(); } catch { /* gone */ }
  dgServer.close();
  try { process.kill(-relay.pid, "SIGTERM"); } catch { try { relay.kill("SIGKILL"); } catch { /* gone */ } }
  await sleep(300);
  if (pass !== total) console.log(`\n--- relay log ---\n${relayLog.join("").split("\n").slice(-25).join("\n")}`);
  console.log(`\n${pass}/${total} passed\n`);
  process.exit(pass === total ? 0 : 1);
}
