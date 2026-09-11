#!/usr/bin/env node
// Fenced-code-block splitting: display keeps the diagram intact, speech drops it entirely.
//
// The sample is the real reply that produced the bad screenshot — an ASCII flow diagram that the
// mobile renderer turned into a bag of one-word chips, because styledWords() splits on whitespace
// and every fenced line went through it. Node strips the types, so this imports shared/markdown.ts
// directly rather than testing a copy of it.
//
//   node test/markdown.mjs

import { splitBlocks, stripFences, styledWords, proseItems, spokenText } from "../shared/markdown.ts";

let pass = 0, total = 0;
const check = (name, cond, got) => {
  total++; if (cond) pass++;
  console.log(`  ${cond ? "\x1b[32m✓" : "\x1b[31m✗"} ${name}\x1b[0m`);
  if (!cond && got !== undefined) console.log(`      got: ${JSON.stringify(got).slice(0, 300)}`);
};

const DIAGRAM = `sub-agent: needs_credential(domain="sharepoint.com", field="password")  | (no secret in context)
   ▼ your server ── push over persistent WS ──▶ broker on your Mac
   | op item get --otp  Touch ID prompt | encrypt to VM's ephemeral pubkey
   | server relays sealed envelope (can't read it) ──┘
   ▼ VM adapter: decrypt → xdotool type → zeroize
   ▼ sub-agent: {"filled": true}  ← only this comes back`;

const REPLY = `**2. Password request.** Parent agent never touches 1Password.

\`\`\`
${DIAGRAM}
\`\`\`

Two details that make it safe: the envelope is sealed to the VM's per-session key.`;

console.log("\n=== markdown: fenced blocks ===");

const blocks = splitBlocks(REPLY);
check("splits into prose / code / prose", blocks.map((b) => b.type).join(",") === "prose,code,prose",
  blocks.map((b) => b.type));
check("code block keeps every line", blocks[1]?.text.split("\n").length === DIAGRAM.split("\n").length,
  blocks[1]?.text.split("\n").length);
check("code block is byte-identical to the diagram", blocks[1]?.text === DIAGRAM);
check("box-drawing characters survive", /──▶/.test(blocks[1]?.text ?? ""));
check("prose either side is kept", /Password request/.test(blocks[0]?.text ?? "") && /per-session key/.test(blocks[2]?.text ?? ""));

// The one that matters for audio: none of the diagram may reach TTS.
const spoken = stripFences(REPLY);
check("speech drops the diagram entirely", !/xdotool|sharepoint|▼|needs_credential/.test(spoken), spoken);
check("speech keeps the prose", /Password request/.test(spoken) && /per-session key/.test(spoken));
check("speech does not run the two sentences together", / 1Password\. \*\*/.test(spoken) || /1Password\.\s+Two details/.test(spoken), spoken);

// Streaming: the closing fence has not arrived yet, so the tail must already read as code rather
// than flashing raw backticks and diagram lines through the prose renderer.
const partial = `Here is the flow:\n\n\`\`\`\n${DIAGRAM.split("\n").slice(0, 3).join("\n")}`;
const pb = splitBlocks(partial);
check("unterminated fence is treated as code", pb.map((b) => b.type).join(",") === "prose,code", pb.map((b) => b.type));
check("unterminated fence never leaks ``` into prose", !pb.some((b) => b.type === "prose" && b.text.includes("```")));
check("unterminated fence is not spoken", !/xdotool|sharepoint|needs_credential/.test(stripFences(partial)));

// Text with no fence at all must come back untouched — this is the common case.
check("plain prose is a single block", splitBlocks("just a sentence").length === 1);
check("plain prose is unchanged by stripFences", stripFences("just a sentence, with `code` in it") === "just a sentence, with `code` in it");

// Two blocks in one reply, and a language tag on the fence.
const two = "a\n\n```ts\nconst x = 1;\n```\n\nb\n\n```\nplain\n```\n\nc";
check("handles several blocks and a language tag",
  splitBlocks(two).map((b) => b.type).join(",") === "prose,code,prose,code,prose", splitBlocks(two).map((b) => b.type));
check("language tag is not part of the code", splitBlocks(two)[1].text === "const x = 1;", splitBlocks(two)[1].text);

// The alignment contract. The relay synthesizes stripFences(text) and returns one timing per
// spoken word; the renderer highlights by index into its own drawn words. If a fenced block
// contributes words to one side and not the other, every highlight after the first block in a
// reply drifts by the size of that block — silently, and worse the bigger the diagram.
const drawn = splitBlocks(REPLY).filter((b) => b.type === "prose")
  .flatMap((b) => b.text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean))
  .flatMap((para) => styledWords(para)).length;
const spokenWords = styledWords(stripFences(REPLY)).length;
check(`drawn words == spoken words (${drawn} vs ${spokenWords})`, drawn === spokenWords);

// ---- lists --------------------------------------------------------------------------------
// The reply from the second bug screenshot: items separated by single newlines, which used to
// collapse into one paragraph with every "-" drawn as a word.
console.log("\n=== markdown: lists ===");
const LIST = `Where we are:

- **Architecture**: parent agent → dumb VM with a control adapter.
- **Contract**: returns \`{status, result}\`. Images backlogged.
- **Policy** = guardrail text passed as a second arg.

Next step we hadn't started.`;

const items = proseItems(LIST);
check("each list item is its own row", items.map((i) => i.kind).join(",") === "p,li,li,li,p", items.map((i) => i.kind));
check("bullet markers are not part of the item text", items.filter((i) => i.kind === "li").every((i) => !i.text.startsWith("-")));
check("item text is intact", items[2]?.text === "**Contract**: returns `{status, result}`. Images backlogged.", items[2]?.text);

const ol = proseItems("Plan:\n1. Scaffold the repo\n   (continuation of one)\n2) Run the test\n3. Decide");
check("ordered items get their own rows, `1.` and `2)` both", ol.map((i) => i.kind).join(",") === "p,ol,ol,ol", ol.map((i) => i.kind));
check("a wrapped continuation line joins its item", ol[1]?.text === "Scaffold the repo (continuation of one)", ol[1]?.text);
check("ordered marker is kept for display", ol[1]?.marker === "1." && ol[2]?.marker === "2)", [ol[1]?.marker, ol[2]?.marker]);

check("a line starting **bold** is not a bullet", proseItems("**Bold** start").map((i) => i.kind).join() === "p");
check("a dash mid-sentence is not a bullet", proseItems("a - b - c").map((i) => i.kind).join() === "p");
check("soft-wrapped paragraph lines still join", proseItems("one line\nwraps here")[0]?.text === "one line wraps here");

// The alignment contract again, now with lists on both sides: bullets are drawn as a glyph and
// dropped from speech; ordered markers are a counted word on both sides.
const countDrawn = (t) => splitBlocks(t).filter((b) => b.type === "prose")
  .flatMap((b) => proseItems(b.text))
  .reduce((n, it) => n + styledWords(it.text).length + (it.kind === "ol" ? 1 : 0), 0);
const countSpoken = (t) => styledWords(spokenText(t)).length;
const MIXED = LIST + "\n\n1. first\n2. second\n\n```\n- not a bullet, it's code\n```\n\n- after the fence";
check(`lists: drawn words == spoken words (${countDrawn(MIXED)} vs ${countSpoken(MIXED)})`, countDrawn(MIXED) === countSpoken(MIXED));
check("bullet markers never reach the speech", !/^\s*[-*•]\s/m.test(spokenText(MIXED)), spokenText(MIXED));

console.log(`\n${pass}/${total} passed\n`);
process.exit(pass === total ? 0 : 1);
