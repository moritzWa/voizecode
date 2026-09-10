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
