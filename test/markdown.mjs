#!/usr/bin/env node
// Fenced-code-block splitting: display keeps the diagram intact, speech drops it entirely.
//
// The sample is the real reply that produced the bad screenshot — an ASCII flow diagram that the
// mobile renderer turned into a bag of one-word chips, because styledWords() splits on whitespace
// and every fenced line went through it. Node strips the types, so this imports shared/markdown.ts
// directly rather than testing a copy of it.
//
//   node test/markdown.mjs

import { splitBlocks, stripFences, styledWords } from "../shared/markdown.ts";

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

console.log(`\n${pass}/${total} passed\n`);
process.exit(pass === total ? 0 : 1);
