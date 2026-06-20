#!/usr/bin/env node
// Browser e2e for the Next.js client. Boots relay + TWO agents + `next dev`,
// drives the real UI in headless Chromium with a synthesized WAV fed as the mic.
//
// Asserts: relay-connected, two session tabs, typed round-trip, tab switching,
// localStorage persistence across reload, model dropdown, speed slider, mic->STT.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import pw from "../client/node_modules/playwright/index.js";
const { chromium } = pw;

const ROOT = new URL("..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = Object.fromEntries(readFileSync(join(ROOT, "relay/.env"), "utf8").split("\n")
  .filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

let failures = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`); if (!cond) failures++; };

async function makeWav(text) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-1", voice: "onyx", input: text, response_format: "mp3" }),
  });
  const mp3 = join(tmpdir(), "bmic.mp3"), wav = join(tmpdir(), "bmic.wav");
  writeFileSync(mp3, Buffer.from(await r.arrayBuffer()));
  execFileSync("ffmpeg", ["-y", "-i", mp3, "-af", "apad=pad_dur=2", "-ar", "16000", "-ac", "1", wav], { stdio: "ignore" });
  return wav;
}
function start(name, cmd, args, opts) {
  const p = spawn(cmd, args, opts);
  const tag = (d) => process.stdout.write(`\x1b[2m[${name}] ${d}\x1b[0m`);
  p.stdout.on("data", tag); p.stderr.on("data", tag);
  return p;
}

const repoA = mkdtempSync(join(tmpdir(), "voize-A-")), repoB = mkdtempSync(join(tmpdir(), "voize-B-"));
const A = basename(repoA), B = basename(repoB);
const wav = await makeWav("What files are in the current directory? Just name them.");
const relay = start("relay", "deno", ["task", "start"], { cwd: join(ROOT, "relay") });
const agentA = start("agentA", "node", [join(ROOT, "laptop/voizecode.mjs")], { cwd: repoA, env: { ...process.env, VOIZE_MODEL: "haiku" } });
let agentALog = "";
agentA.stdout.on("data", (d) => { agentALog += d; });
const agentB = start("agentB", "node", [join(ROOT, "laptop/voizecode.mjs")], { cwd: repoB, env: { ...process.env, VOIZE_MODEL: "haiku" } });
const next = start("next", "npm", ["run", "dev"], { cwd: join(ROOT, "client") });
await sleep(7000);

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("\x1b[2m[browser err] " + m.text() + "\x1b[0m"); });

try {
  console.log(`\n=== voizecode browser e2e (sessions ${A}, ${B}) ===`);
  await page.goto("http://localhost:3030", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector("text=relay connected", { timeout: 15000 });
  ok("page loads + relay connected", true);

  await page.waitForSelector(`button:has-text("${A}")`, { timeout: 10000 });
  await page.waitForSelector(`button:has-text("${B}")`, { timeout: 10000 });
  ok("both session tabs render", true);

  // type on session A
  await page.click(`button:has-text("${A}")`);
  await page.fill('input[placeholder="or type…"]', "Say hello in one sentence.");
  await page.click('button:has-text("Send")');
  await page.waitForSelector("text=Say hello in one sentence.", { timeout: 5000 });
  const replyA = await page.waitForFunction(() => document.querySelectorAll(".bg-zinc-100").length > 0, null, { timeout: 60000 }).then(() => true).catch(() => false);
  ok("session A: typed turn -> reply renders", replyA);

  // switch to B: A's message should NOT be visible
  await page.click(`button:has-text("${B}")`);
  await sleep(500);
  const aHiddenOnB = !(await page.isVisible("text=Say hello in one sentence."));
  ok("tab switch isolates conversations", aHiddenOnB);

  // persistence: reload, A's message still there
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(`button:has-text("${A}")`, { timeout: 10000 });
  await page.click(`button:has-text("${A}")`);
  const persisted = await page.waitForSelector("text=Say hello in one sentence.", { timeout: 5000 }).then(() => true).catch(() => false);
  ok("conversation persists across reload (localStorage)", persisted);

  // model dropdown + speed slider
  await page.selectOption("select", "sonnet");
  await sleep(2500);
  ok("model dropdown switches to sonnet", (await page.inputValue("select")) === "sonnet");
  await page.fill('input[type="range"]', "2");
  ok("speed slider updates to 2.0x", await page.isVisible("text=speed 2.0x"));

  // deferred audio: B speaks while focused on A -> audio held until B is focused
  await page.click(`button:has-text("${B}")`);
  await page.fill('input[placeholder="or type…"]', "Say the word ready in one short sentence.");
  await page.click('button:has-text("Send")');
  await page.click(`button:has-text("${A}")`); // switch away before B replies
  const held = await page.waitForFunction((b) => (window.__voizePending?.[b]?.length || 0) > 0, B, { timeout: 60000 }).then(() => true).catch(() => false);
  ok("background session audio is HELD while unfocused", held);
  await page.click(`button:has-text("${B}")`); // focus B -> flush held audio
  const flushed = await page.waitForFunction((b) => (window.__voizePending?.[b]?.length || 0) === 0, B, { timeout: 10000 }).then(() => true).catch(() => false);
  ok("held audio flushes (plays) on focus", flushed);

  // mic capture + VAD barge-in (deterministic): trigger a long reply on A, wait until
  // the agent is ACTUALLY speaking, then open the mic mid-speech so the fake audio
  // overlaps -> STT transcript + VAD onSpeechStart -> barge_in -> claude interrupt.
  await page.click(`button:has-text("${A}")`);
  await page.fill('input[placeholder="or type…"]', "Tell me about yourself in five short sentences.");
  await page.click('button:has-text("Send")');
  await page.waitForFunction(() => window.__voizeSpeaking === true, null, { timeout: 60000 });
  await page.click('button:has-text("Start call")'); // mic opens while agent is speaking
  const heard = await page.waitForFunction(() => /current directory|name them|files/i.test(document.body.innerText), null, { timeout: 30000 }).then(() => true).catch(() => false);
  ok("mic capture -> STT transcript appears", heard);
  const interrupted = await (async () => {
    for (let i = 0; i < 50; i++) { if (/interrupt/i.test(agentALog)) return true; await sleep(500); }
    return false;
  })();
  ok("VAD barge-in: talking over agent interrupts claude", interrupted);

  console.log(`\n=== ${failures === 0 ? "\x1b[32mALL PASSED" : `\x1b[31m${failures} FAILED`}\x1b[0m ===`);
} catch (e) {
  console.log("\x1b[31m[fatal] " + e.message + "\x1b[0m"); failures++;
} finally {
  await browser.close();
  agentA.kill("SIGINT"); agentB.kill("SIGINT"); relay.kill("SIGINT"); next.kill("SIGINT");
  await sleep(800);
  process.exit(failures === 0 ? 0 : 1);
}
