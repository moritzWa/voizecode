#!/usr/bin/env node
// voizecode backend e2e. Boots the relay + TWO laptop agents (two sessions) and
// drives the full pipeline headlessly per session:
//
//   synth speech -> mic PCM -> relay STT -> claude -> narration -> TTS -> reply
//
// Asserts: per-session routing, model switch, streaming TTS, and that a turn sent
// to session B is answered by B (not A). Reads keys from relay/.env. --play to hear.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import WebSocket from "../laptop/node_modules/ws/index.js";

const ROOT = new URL("..", import.meta.url).pathname;
const PLAY = process.argv.includes("--play");
const env = Object.fromEntries(
  readFileSync(join(ROOT, "relay/.env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const OPENAI = env.OPENAI_API_KEY, DG = env.DEEPGRAM_API_KEY;
if (!OPENAI || !DG) { console.error("need OPENAI_API_KEY + DEEPGRAM_API_KEY in relay/.env"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let pass = 0, total = 0;
const check = (name, cond) => { total++; if (cond) pass++; log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`); return cond; };

// ---- audio helpers ----
async function ttsMp3(text) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-1", voice: "onyx", input: text, response_format: "mp3" }),
  });
  if (!r.ok) throw new Error("tts " + r.status);
  return Buffer.from(await r.arrayBuffer());
}
function mp3ToPcm16k(mp3) {
  const f = join(tmpdir(), "voize-in-" + Date.now() + ".mp3");
  writeFileSync(f, mp3);
  return execFileSync("ffmpeg", ["-i", f, "-ar", "16000", "-ac", "1", "-f", "s16le", "-"], { maxBuffer: 1e8 });
}
async function transcribe(mp3) {
  const r = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true", {
    method: "POST", headers: { Authorization: `Token ${DG}`, "Content-Type": "audio/mpeg" }, body: mp3,
  });
  return (await r.json()).results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

// ---- boot relay + 2 agents ----
function start(name, cmd, args, opts) {
  const p = spawn(cmd, args, opts);
  const tag = (d) => process.stdout.write(`\x1b[2m[${name}] ${d}\x1b[0m`);
  p.stdout.on("data", tag); p.stderr.on("data", tag);
  return p;
}
const repoA = mkdtempSync(join(tmpdir(), "voize-A-")), repoB = mkdtempSync(join(tmpdir(), "voize-B-"));
const A = basename(repoA), B = basename(repoB);
const relay = start("relay", "deno", ["task", "start"], { cwd: join(ROOT, "relay") });
await sleep(2500);
const agentA = start("agentA", "node", [join(ROOT, "laptop/voizecode.mjs")], { cwd: repoA, env: { ...process.env, VOIZE_MODEL: "haiku" } });
const agentB = start("agentB", "node", [join(ROOT, "laptop/voizecode.mjs")], { cwd: repoB, env: { ...process.env, VOIZE_MODEL: "haiku" } });
await sleep(3000);
log(`\n=== voizecode backend e2e ===\nsessions: ${A}, ${B}\n`);

// ---- client ----
const ws = new WebSocket("ws://localhost:8787");
await new Promise((res) => ws.on("open", res));
const inbox = [];
const sessionList = { cur: [] };
const models = {};
ws.on("message", (r) => {
  const m = JSON.parse(r.toString());
  if (m.t === "sessions") sessionList.cur = m.sessions;
  if (m.t === "model") models[m.sessionId] = m.model;
  inbox.push(m);
});
ws.send(JSON.stringify({ t: "hello", role: "client", since: 0 }));
await sleep(1500);
const drain = () => inbox.splice(0);

async function feedVoice(sessionId, text) {
  const pcm = mp3ToPcm16k(await ttsMp3(text));
  const C = 3200;
  for (let i = 0; i < pcm.length; i += C) { ws.send(JSON.stringify({ t: "audio", sessionId, pcm: pcm.subarray(i, i + C).toString("base64") })); await sleep(90); }
  const sil = Buffer.alloc(C);
  for (let i = 0; i < 26; i++) { ws.send(JSON.stringify({ t: "audio", sessionId, pcm: sil.toString("base64") })); await sleep(90); }
}

async function runCase(sessionId, prompt, { voice = true } = {}) {
  log(`\n\x1b[1m> [${sessionId}] ${prompt}\x1b[0m`);
  drain();
  if (voice) await feedVoice(sessionId, prompt);
  else ws.send(JSON.stringify({ t: "text", sessionId, text: prompt }));

  const deadline = Date.now() + 120000;
  let agentText = "", speech = "", audioB64 = null, audioCount = 0, leaked = 0, doneAt = 0;
  while (Date.now() < deadline) {
    for (const m of drain()) {
      const mine = m.sessionId === sessionId;
      if (["agent_text", "speech_text", "audio_chunk", "audio_end", "status"].includes(m.t) && m.sessionId && !mine) leaked++;
      if (!mine) continue;
      if (m.t === "agent_text") agentText += m.text;
      if (m.t === "status") log(`  \x1b[2m· ${m.text}\x1b[0m`);
      if (m.t === "speech_text") speech += m.text + " ";
      if (m.t === "audio_chunk") { audioB64 = m.b64; audioCount++; }
      if (m.t === "thinking" && m.on === false) doneAt = Date.now();
    }
    if (doneAt && Date.now() - doneAt > 4000) break;
    await sleep(200);
  }
  log(`  claude: ${agentText.slice(0, 140).replace(/\n/g, " ")}`);
  log(`  spoken: "${speech.trim()}"  (${audioCount} audio chunk${audioCount === 1 ? "" : "s"}${audioCount > 1 ? " streaming ✓" : ""})`);
  if (audioB64 && PLAY) { const f = join(tmpdir(), "o.mp3"); writeFileSync(f, Buffer.from(audioB64, "base64")); try { execFileSync("afplay", [f]); } catch {} }
  return { agentText, speech, audioCount, leaked };
}

// Drain the inbox and wait until it stays quiet (no inbound for `quietMs`) -> prior
// session's async audio has finished arriving.
async function settle(quietMs = 1500) {
  for (let i = 0; i < 8; i++) { inbox.splice(0); await sleep(quietMs); if (inbox.length === 0) return; }
}

// ---- tests ----
check(`both sessions registered`, sessionList.cur.length === 2 && sessionList.cur.some((s) => s.sessionId === A) && sessionList.cur.some((s) => s.sessionId === B));

const r1 = await runCase(A, "Say hello in one short sentence.");
check(`[${A}] got spoken reply`, !!r1.speech.trim());
check(`[${A}] streaming TTS (>=1 chunk)`, r1.audioCount >= 1);
check(`[${A}] no cross-session leak`, r1.leaked === 0);

log(`\n\x1b[1m# switch ${A} -> sonnet\x1b[0m`);
ws.send(JSON.stringify({ t: "set_model", sessionId: A, model: "sonnet" }));
let switched = false;
for (let i = 0; i < 60 && !switched; i++) { if (models[A]?.includes("sonnet")) switched = true; await sleep(200); }
check(`[${A}] model switched to sonnet`, switched);
check(`[${B}] still on haiku (independent)`, !models[B] || models[B].includes("haiku"));

// Let session A's trailing audio (async TTS streams after thinking:false) flush, so it
// doesn't bleed into B's window and trip the cross-session leak check.
await settle();
const r2 = await runCase(B, "What is two plus two? Answer in one short sentence.", { voice: false });
check(`[${B}] got spoken reply`, !!r2.speech.trim());
check(`[${B}] answered on B, not A (routing)`, r2.leaked === 0 && !!r2.agentText);

log(`\n=== ${pass}/${total} passed ===`);
ws.close(); agentA.kill("SIGINT"); agentB.kill("SIGINT"); relay.kill("SIGINT");
await sleep(500);
process.exit(pass === total ? 0 : 1);
