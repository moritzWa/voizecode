#!/usr/bin/env node
// Records a phone-sized video proving the chat renders: tool calls (status lines),
// the full agent reply, and an ASCII diagram readably (monospace, preserved whitespace).
//
// Boots relay + one agent (scratch repo) + `next dev`, drives the real UI in a
// 390x844 (iPhone-ish) viewport, asks for an ASCII diagram + a tool call, asserts
// the diagram renders with monospace + newlines, saves a video and a screenshot.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import pw from "../client/node_modules/playwright/index.js";
const { chromium } = pw;

const ROOT = new URL("..", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`); if (!cond) failures++; };

function start(name, cmd, args, opts) {
  const p = spawn(cmd, args, opts);
  const tag = (d) => process.stdout.write(`\x1b[2m[${name}] ${d}\x1b[0m`);
  p.stdout.on("data", tag); p.stderr.on("data", tag);
  return p;
}

const repo = mkdtempSync(join(tmpdir(), "voize-vid-"));
const S = basename(repo);
const outDir = join(ROOT, "test/artifacts");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const relay = start("relay", "deno", ["task", "start"], { cwd: join(ROOT, "relay") });
const agent = start("agent", "node", [join(ROOT, "laptop/voizecode.mjs")], { cwd: repo, env: { ...process.env, VOIZE_MODEL: "haiku" } });
const next = start("next", "npm", ["run", "dev"], { cwd: join(ROOT, "client") });
await sleep(7000);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, // iPhone 14-ish, simulate reading on the phone
  recordVideo: { dir: outDir, size: { width: 390, height: 844 } },
});
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("\x1b[2m[browser err] " + m.text() + "\x1b[0m"); });

try {
  console.log(`\n=== voizecode video: ASCII diagram + tool calls (session ${S}) ===`);
  await page.goto("http://localhost:3030", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector("text=relay connected", { timeout: 15000 });
  await page.waitForSelector(`button:has-text("${S}")`, { timeout: 10000 });
  await page.click(`button:has-text("${S}")`);

  // 1) a request that forces a tool call (so a status line renders)
  await page.fill('input[placeholder="or type…"]', "Run the ls command to list this directory.");
  await page.click('button:has-text("Send")');
  const sawStatus = await page.waitForSelector(".italic", { timeout: 60000 }).then(() => true).catch(() => false);
  ok("tool call renders as a status line", sawStatus);
  await sleep(2000);

  // 2) ask for an ASCII diagram
  await page.fill('input[placeholder="or type…"]',
    "Draw a simple ASCII diagram of a three-tier architecture: a Client box, an arrow to a Server box, an arrow to a Database box. Use plain ASCII like +---+ boxes and --> arrows. Output ONLY the diagram inside a code block, nothing else.");
  await page.click('button:has-text("Send")');

  // wait for an agent (monospace) bubble that actually contains multiple lines
  const diagramHandle = await page.waitForFunction(() => {
    const els = [...document.querySelectorAll("pre.font-mono")];
    return els.find((e) => (e.textContent || "").split("\n").length >= 3) || null;
  }, null, { timeout: 90000 }).catch(() => null);

  ok("agent reply rendered in a monospace bubble", !!diagramHandle);

  if (diagramHandle) {
    const info = await diagramHandle.evaluate((e) => {
      const cs = getComputedStyle(e);
      return {
        text: e.textContent,
        lines: (e.textContent || "").split("\n").length,
        fontFamily: cs.fontFamily,
        whiteSpace: cs.whiteSpace,
      };
    });
    ok("diagram preserves multiple lines (newlines intact)", info.lines >= 3);
    ok("rendered in monospace font", /mono|consol|courier|menlo/i.test(info.fontFamily));
    ok("whitespace preserved (pre-wrap)", info.whiteSpace.includes("pre"));
    console.log(`\n--- rendered diagram (${info.lines} lines, font: ${info.fontFamily.split(",")[0]}, ws: ${info.whiteSpace}) ---`);
    console.log(info.text);
    console.log("---");
  }

  await sleep(1500);
  await page.screenshot({ path: join(outDir, "diagram.png"), fullPage: true });
  console.log(`\nscreenshot: ${join(outDir, "diagram.png")}`);
} catch (e) {
  console.log("\x1b[31m[fatal] " + e.message + "\x1b[0m"); failures++;
} finally {
  await context.close(); // finalizes the video file
  await browser.close();
  agent.kill("SIGINT"); relay.kill("SIGINT"); next.kill("SIGINT");
  await sleep(800);
  const vid = readdirSync(outDir).find((f) => f.endsWith(".webm"));
  if (vid) console.log(`video: ${join(outDir, vid)}`);
  console.log(`\n=== ${failures === 0 ? "\x1b[32mALL PASSED" : `\x1b[31m${failures} FAILED`}\x1b[0m ===`);
  process.exit(failures === 0 ? 0 : 1);
}
