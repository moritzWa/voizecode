#!/usr/bin/env node
// Browser e2e for the access-code gate. Boots relay + agent + `next dev` with VOIZE_TOKEN set
// (so the relay enforces auth and the agent presents the matching code), then drives headless
// Chromium to assert:
//   - wrong/missing ?key -> access gate, NOT connected
//   - correct ?key -> connected, code persisted to localStorage, key stripped from the URL
//   - reload with a clean URL -> still connected (reuses the stored code)

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pw from "../client/node_modules/playwright/index.js";
const { chromium } = pw;

const ROOT = new URL("..", import.meta.url).pathname;
const TOKEN = "playwrighttest123";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`); if (!cond) failures++; };
function start(name, cmd, args, opts) {
  const p = spawn(cmd, args, opts);
  const tag = (d) => process.stdout.write(`\x1b[2m[${name}] ${d}\x1b[0m`);
  p.stdout.on("data", tag); p.stderr.on("data", tag);
  return p;
}

const repo = mkdtempSync(join(tmpdir(), "voize-auth-"));
const env = { ...process.env, VOIZE_TOKEN: TOKEN, VOIZE_MODEL: "haiku" };
const relay = start("relay", "deno", ["task", "start"], { cwd: join(ROOT, "relay"), env });
const agent = start("agent", "node", [join(ROOT, "laptop/voizecode.mjs")], { cwd: repo, env });
const next = start("next", "npm", ["run", "dev"], { cwd: join(ROOT, "client"), env });
await sleep(9000);

const browser = await chromium.launch();
const page = await browser.newPage();
const bodyText = () => page.evaluate(() => document.body.innerText);

try {
  console.log("\n=== voizecode access-gate e2e ===");

  // wrong code -> gate
  await page.goto(`http://localhost:3030/?key=wrongcode`, { waitUntil: "networkidle", timeout: 60000 });
  await sleep(1500);
  let t = await bodyText();
  ok("wrong code -> access gate shown", t.includes("Enter your access code"));
  ok("wrong code -> NOT connected", !/\bconnected\b/.test(t) || t.includes("Enter your access code"));

  // correct code -> connected + persisted + URL stripped
  await page.goto(`http://localhost:3030/?key=${TOKEN}`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector("text=connected", { timeout: 15000 }).catch(() => {});
  await sleep(500);
  t = await bodyText();
  ok("correct code -> connected", t.includes("connected") && !t.includes("Enter your access code"));
  const stored = await page.evaluate(() => localStorage.getItem("voize:token"));
  ok("correct code -> persisted to localStorage", stored === TOKEN);
  const url = await page.evaluate(() => location.href);
  ok("correct code -> ?key stripped from URL", !url.includes("key="));

  // reload clean URL -> still connected (reuses stored code)
  await page.goto(`http://localhost:3030/`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector("text=connected", { timeout: 15000 }).catch(() => {});
  t = await bodyText();
  ok("reload clean URL -> reuses stored code, connected", t.includes("connected") && !t.includes("Enter your access code"));
} finally {
  await browser.close();
  for (const p of [relay, agent, next]) { try { p.kill("SIGTERM"); } catch { /* gone */ } }
  await sleep(500);
}
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\n\x1b[32mall passed\x1b[0m");
process.exit(failures ? 1 : 0);
