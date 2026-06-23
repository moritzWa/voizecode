#!/usr/bin/env node
// Regression test for false interruptions: a short backchannel (someone in the room saying
// "yeah") must NOT become a turn or interrupt the agent. A real sentence still does.
//
// Repro of the reported bug: a colleague said "Yeah" -> it was transcribed -> the agent got
// interrupted and answered "yeah". This asserts that no longer happens.
//
// Feeds synthesized speech as mic audio through the real STT path, then checks the relay's
// turn-delivery decision (user_echo) and the discard signal (utterance_discarded).

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import WebSocket from "../laptop/node_modules/ws/index.js";

const ROOT = new URL("..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = Object.fromEntries(readFileSync(join(ROOT, "relay/.env"), "utf8").split("\n")
  .filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const OPENAI = env.OPENAI_API_KEY, DG = env.DEEPGRAM_API_KEY;

let pass = 0, total = 0;
const check = (name, cond) => { total++; if (cond) pass++; console.log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`); return cond; };

async function ttsMp3(text) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-1", voice: "onyx", input: text, response_format: "mp3" }),
  });
  if (!r.ok) throw new Error("tts " + r.status);
  return Buffer.from(await r.arrayBuffer());
}
function mp3ToPcm16k(mp3) {
  const inF = join(tmpdir(), "b-in.mp3"), outF = join(tmpdir(), "b-out.raw");
  writeFileSync(inF, mp3);
  execFileSync("ffmpeg", ["-y", "-i", inF, "-ar", "16000", "-ac", "1", "-f", "s16le", outF], { stdio: "ignore" });
  return readFileSync(outF);
}

function start(name, cmd, args, opts) {
  const p = spawn(cmd, args, opts);
  const tag = (d) => process.stdout.write(`\x1b[2m[${name}] ${d}\x1b[0m`);
  p.stdout.on("data", tag); p.stderr.on("data", tag);
  return p;
}

// Use a dedicated port so a real browser left open on :8787 can't reconnect and steal the
// relay's single client slot mid-test.
const PORT = 8799, WSURL = `ws://localhost:${PORT}`;
const repo = mkdtempSync(join(tmpdir(), "voize-barge-"));
const S = basename(repo);
const relay = start("relay", "deno", ["run", "--allow-net", "--allow-env", "--env-file=.env", "main.ts"], { cwd: join(ROOT, "relay"), env: { ...process.env, ...env, VOIZE_RELAY_PORT: String(PORT) } });
const agent = start("agent", "node", [join(ROOT, "laptop/voizecode.mjs")], { cwd: repo, env: { ...process.env, VOIZE_MODEL: "haiku", VOIZE_RELAY_URL: WSURL } });
await sleep(3500);

const ws = new WebSocket(WSURL);
const inbox = [];
ws.on("message", (r) => inbox.push(JSON.parse(r.toString())));
await new Promise((res) => ws.on("open", res));
ws.send(JSON.stringify({ t: "hello", role: "client", since: 0 }));
await sleep(1500);
const drain = () => inbox.splice(0);

async function feedVoice(text) {
  const pcm = mp3ToPcm16k(await ttsMp3(text));
  const C = 3200;
  for (let i = 0; i < pcm.length; i += C) { ws.send(JSON.stringify({ t: "audio", sessionId: S, pcm: pcm.subarray(i, i + C).toString("base64") })); await sleep(90); }
  const sil = Buffer.alloc(C);
  for (let i = 0; i < 30; i++) { ws.send(JSON.stringify({ t: "audio", sessionId: S, pcm: sil.toString("base64") })); await sleep(90); } // ~2.7s silence -> utterance ends
}

// collect messages of interest for `ms` after feeding
async function observe(ms) {
  const got = { userEcho: [], discarded: 0, transcripts: [] };
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const m of drain()) {
      if (m.sessionId !== S) continue;
      if (m.t === "user_echo") got.userEcho.push(m.text);
      if (m.t === "utterance_discarded") got.discarded++;
      if (m.t === "transcript" && m.text) got.transcripts.push(m.text);
    }
    await sleep(150);
  }
  return got;
}

console.log(`\n=== voizecode barge-in / backchannel test (session ${S}) ===`);
try {
  // 1) backchannel: a stray "yeah" must NOT become a turn
  console.log(`\n\x1b[1m> backchannel: "Yeah, yeah."\x1b[0m`);
  drain();
  await feedVoice("Yeah, yeah.");
  const bc = await observe(4000);
  console.log(`  heard: ${JSON.stringify(bc.transcripts.slice(-1))}  user_echo: ${JSON.stringify(bc.userEcho)}  discarded: ${bc.discarded}`);
  check("backchannel did NOT become a turn (no user_echo)", bc.userEcho.length === 0);
  check("backchannel was explicitly discarded", bc.discarded >= 1);

  // 2) real sentence: must become a turn
  console.log(`\n\x1b[1m> real: "What files are in this folder?"\x1b[0m`);
  drain();
  await feedVoice("What files are in this folder?");
  const real = await observe(6000);
  console.log(`  user_echo: ${JSON.stringify(real.userEcho)}`);
  check("real sentence became a turn (user_echo delivered)", real.userEcho.length >= 1);

  console.log(`\n=== ${pass}/${total} passed ===`);
} catch (e) {
  console.log("\x1b[31m[fatal] " + e.message + "\x1b[0m");
} finally {
  ws.close(); agent.kill("SIGINT"); relay.kill("SIGINT");
  await sleep(500);
  process.exit(pass === total ? 0 : 1);
}
