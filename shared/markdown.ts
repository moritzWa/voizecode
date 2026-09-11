// Fenced-code-block handling, shared by the relay (which must not speak a diagram) and the mobile
// renderer (which must not word-wrap one). These two have to agree: a block that the relay strips
// from the spoken text contributes no word timings, so the renderer must likewise count it for no
// words, or every highlight after the first block lands on the wrong word.
//
// The web client does not use this — it runs the full ReactMarkdown/remark-gfm pipeline, which
// already renders fences as <pre>. Mobile deliberately does not carry a markdown library.

export type Block = { type: "code" | "prose"; text: string };

// An unterminated fence is not an edge case: replies stream in, so every block is briefly a fence
// with no closing ```. Treating the tail as code stops the raw backticks and their contents from
// flashing through the prose renderer on the way in.
const FENCE = /```[^\n]*\n?([\s\S]*?)```/g;

export function splitBlocks(text: string): Block[] {
  const out: Block[] = [];
  const push = (type: Block["type"], t: string) => {
    if (t.trim()) out.push({ type, text: type === "code" ? t.replace(/\n+$/, "") : t });
  };
  const re = new RegExp(FENCE.source, "g");
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    push("prose", text.slice(last, m.index));
    push("code", m[1]);
    last = re.lastIndex;
  }
  const rest = text.slice(last);
  const open = rest.indexOf("```");
  if (open < 0) push("prose", rest);
  else { push("prose", rest.slice(0, open)); push("code", rest.slice(open).replace(/^```[^\n]*\n?/, "")); }
  return out;
}

// The spoken text: prose only. Replacing with a space (not "") keeps the sentences either side of
// a block from being run together into one word.
export function stripFences(text: string): string {
  return splitBlocks(text).filter((b) => b.type === "prose").map((b) => b.text.trim()).join(" ");
}

// A prose run broken into the pieces the renderer lays out separately.
//
// Paragraphs used to be split on blank lines only, and a markdown list separates its items with a
// single newline — so a whole list collapsed into one paragraph, every item ran into the last, and
// each "-" showed up as a stray word mid-sentence. Items are now their own rows.
//
// Unordered markers are dropped (drawn as a bullet glyph, and stripped from the spoken text by
// spokenText below, so neither side counts them). Ordered markers stay a real, counted word: "1."
// is worth hearing, and keeping it on both sides is what keeps the highlight aligned.
export type ProseItem =
  | { kind: "p"; text: string }
  | { kind: "li"; text: string }
  | { kind: "ol"; marker: string; text: string };

// Marker then whitespace. "**bold**" at the start of a line is NOT a bullet: the second "*" is not
// whitespace. A " - " in the middle of a sentence is not one either; only line starts count.
const UL = /^\s*[-*•]\s+/;
const OL = /^\s*(\d{1,3}[.)])\s+/;

export function proseItems(text: string): ProseItem[] {
  const items: ProseItem[] = [];
  for (const para of text.split(/\n{2,}/)) {
    let cur: ProseItem | null = null;
    for (const raw of para.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const ul = raw.match(UL), ol = raw.match(OL);
      if (ul) items.push(cur = { kind: "li", text: raw.slice(ul[0].length).trim() });
      else if (ol) items.push(cur = { kind: "ol", marker: ol[1], text: raw.slice(ol[0].length).trim() });
      // A line that starts no item is a soft wrap: it belongs to whatever came just before it,
      // a list item (markdown's lazy continuation) or a paragraph.
      else if (cur) cur.text += " " + line;
      else items.push(cur = { kind: "p", text: line });
    }
  }
  return items;
}

// The text that gets synthesized: no fenced blocks, and no unordered-list markers. The inline rules
// (backticks, bold) are applied on top of this by the relay; styledWords already drops those same
// markers when the renderer counts, so they need no mirroring here.
//
// Markers are stripped per block, before the blocks are joined. Joining first put a bullet that
// directly follows a code fence on the same line as the prose before the fence, so it was no longer
// at a line start, survived, and got read out as "dash" (caught by the drawn == spoken contract).
export function spokenText(text: string): string {
  return splitBlocks(text)
    .filter((b) => b.type === "prose")
    .map((b) => b.text.trim().replace(/^\s*[-*•]\s+/gm, ""))
    .join(" ");
}

// Light inline markdown (**bold**, `code`) split into words with the markers removed, preserving
// reading order so the word index lines up with the TTS word timings. Lives here rather than in
// the renderer because that alignment is a contract with the relay, and it is only checkable if
// both halves — what is drawn and what is spoken — can be counted by the same test.
export type StyledWord = { text: string; bold?: boolean; code?: boolean };

export function styledWords(text: string): StyledWord[] {
  const out: StyledWord[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|([^*`]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const seg = m[1] != null ? { v: m[1], bold: true } : m[2] != null ? { v: m[2], code: true } : { v: m[3] };
    for (const p of seg.v.split(/\s+/)) if (p) out.push({ text: p, bold: seg.bold, code: seg.code });
  }
  return out;
}
