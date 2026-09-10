#!/usr/bin/env node
// Synthesize-ahead: it has to be faster AND still come out in order.
//
// The client plays clips in arrival order and buffers each one whole before decoding, so a faster
// later sentence jumping the queue would be worse than the serial version it replaces. These
// exercise OrderedEmitter/mapConcurrent with a fake synthesizer whose timings are controlled, so
// the speedup is a measurement rather than a claim about the network.
//
//   node test/ordered.mjs

import { OrderedEmitter, mapConcurrent } from "../shared/ordered.ts";

let pass = 0, total = 0;
const check = (name, cond, got) => {
  total++; if (cond) pass++;
  console.log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`);
  if (!cond && got !== undefined) console.log(`      got: ${JSON.stringify(got).slice(0, 300)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\n=== ordered synthesis ===");

// A stand-in for speak(): streams `chunks` messages over `ms`, then finishes its slot.
async function fakeSpeak(emitter, slot, name, ms, chunks = 3) {
  emitter.push(slot, { t: "speech_text", name });
  for (let i = 0; i < chunks; i++) { await sleep(ms / chunks); emitter.push(slot, { t: "audio_chunk", name, i }); }
  emitter.push(slot, { t: "audio_end", name });
  emitter.finish(slot);
}

// 1) Order is preserved even when later work finishes first.
{
  const out = [];
  const em = new OrderedEmitter((m) => out.push(m));
  // Deliberately inverted: the last sentence is the quickest to synthesize.
  await mapConcurrent(["a", "b", "c"], 3, (n, i) => fakeSpeak(em, i, n, { a: 90, b: 60, c: 20 }[n]));
  const names = out.map((m) => m.name);
  const firstOf = (n) => names.indexOf(n);
  check("clips are delivered in slot order despite finishing out of order",
    firstOf("a") < firstOf("b") && firstOf("b") < firstOf("c"), names);
  check("no clip's messages interleave with another's",
    names.join("").replace(/a+/, "a").replace(/b+/, "b").replace(/c+/, "c") === "abc", names.join(""));
  check("every message is delivered exactly once", out.length === 3 * 5, out.length);
  check("nothing is left buffered", em.pending === 0, em.pending);
}

// 2) The point of the change: concurrency actually shortens the wall clock.
{
  const each = 60, n = 6;
  const serialStart = Date.now();
  const em1 = new OrderedEmitter(() => {});
  for (let i = 0; i < n; i++) await fakeSpeak(em1, i, `s${i}`, each);
  const serial = Date.now() - serialStart;

  const conStart = Date.now();
  const em2 = new OrderedEmitter(() => {});
  await mapConcurrent(Array.from({ length: n }, (_, i) => i), 3, (i) => fakeSpeak(em2, i, `c${i}`, each));
  const concurrent = Date.now() - conStart;

  check(`lookahead 3 beats serial (${serial}ms -> ${concurrent}ms for ${n} utterances)`, concurrent < serial * 0.75);
}

// 3) Slot 0 must still stream immediately — it has nothing in front of it. If the first sentence
//    were held until the batch finished, this whole change would make the felt latency worse.
{
  const stamps = [];
  const em = new OrderedEmitter((m) => stamps.push({ name: m.name, at: Date.now() }));
  const t0 = Date.now();
  await mapConcurrent([0, 1, 2], 3, (i) => fakeSpeak(em, i, `x${i}`, 120));
  const firstOut = stamps[0].at - t0;
  check(`first clip starts streaming while the rest synthesize (${firstOut}ms, not ~360ms)`, firstOut < 60, firstOut);
}

// 4) A sentence that produces nothing must not strand the ones behind it — the failure mode that
//    would turn one bad TTS call into a silent reply.
{
  const out = [];
  const em = new OrderedEmitter((m) => out.push(m));
  await mapConcurrent([0, 1, 2], 3, async (i) => {
    if (i === 1) { em.finish(1); return; } // synthesized nothing at all
    await fakeSpeak(em, i, `y${i}`, 30);
  });
  check("a silent slot releases the queue behind it", out.some((m) => m.name === "y2"), out.map((m) => m.name));
  check("order still holds around the gap",
    out.map((m) => m.name).indexOf("y0") < out.map((m) => m.name).indexOf("y2"));
}

// 5) A thrown synthesis must not abandon the rest of the reply.
{
  const out = [];
  const em = new OrderedEmitter((m) => out.push(m));
  await mapConcurrent([0, 1, 2], 2, async (i) => {
    if (i === 1) { try { throw new Error("tts 500"); } finally { em.finish(1); } }
    await fakeSpeak(em, i, `z${i}`, 20);
  });
  check("a failed sentence does not abort the others", out.some((m) => m.name === "z2"), out.map((m) => m.name));
}

// 6) seq is assigned at emit time, not at compose time — out-of-order seq breaks a reconnecting
//    client's replay, which is the subtle way this change could have gone wrong.
{
  let seq = 0;
  const seen = [];
  const em = new OrderedEmitter((m) => seen.push({ ...m, seq: ++seq }));
  await mapConcurrent([0, 1, 2], 3, (i) => fakeSpeak(em, i, `q${i}`, [80, 40, 10][i]));
  const monotonic = seen.every((m, i) => i === 0 || m.seq > seen[i - 1].seq);
  check("seq is monotonic on the wire", monotonic);
  check("seq order matches clip order", seen.filter((m) => m.t === "speech_text").map((m) => m.name).join(",") === "q0,q1,q2");
}

console.log(`\n${pass}/${total} passed\n`);
process.exit(pass === total ? 0 : 1);
