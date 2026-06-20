#!/usr/bin/env node
// Copies the Silero VAD model + onnxruntime-web wasm into client/public/ so the browser
// can load them. Wired as `postinstall`, so they never go stale after a node_modules wipe.

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");
mkdirSync(pub, { recursive: true });

const sources = [
  // vad-web: model weights + audio worklet
  [join(root, "node_modules/@ricky0123/vad-web/dist"), (f) => /\.onnx$/.test(f) || f === "vad.worklet.bundle.min.js"],
  // onnxruntime-web: wasm runtime + its loader shims
  [join(root, "node_modules/onnxruntime-web/dist"), (f) => /^ort-wasm.*\.(wasm|mjs)$/.test(f)],
];

let n = 0;
for (const [dir, match] of sources) {
  let files;
  try { files = readdirSync(dir); } catch { console.warn(`[voize] skip (not installed): ${dir}`); continue; }
  for (const f of files) {
    if (!match(f)) continue;
    try { copyFileSync(join(dir, f), join(pub, f)); n++; } catch (e) { console.warn(`[voize] skip ${f}: ${e.message}`); }
  }
}
console.log(`[voize] copied ${n} VAD/onnx assets into client/public/`);
