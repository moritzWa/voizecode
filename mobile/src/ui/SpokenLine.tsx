// Speechify-style spoken line — port of `SpokenLine` + `styledWords` from the web client's
// index.tsx. Keep the two in step; the word indexing has to match the TTS timings.
//
// Words are laid out as wrapped Views rather than one nested <Text>. That is not a style choice:
// on iOS a nested inline <Text> honours backgroundColor but *ignores* borderRadius and padding,
// so inline `code` and the reading highlight both came out as hard, cramped rectangles. Giving
// each word its own view is the only way to get a rounded, padded chip.
//
// The cost is that this is no longer true inline text layout: no justification or hyphenation,
// and the gap between words is padding rather than a real space. At sentence length that is
// invisible, and the highlight is the whole point of this component.
import { memo, useEffect, useMemo } from "react";
import { ScrollView, Text, View, type ViewStyle } from "react-native";
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { SpokenWord } from "@shared/protocol";
import { proseItems, splitBlocks, styledWords, type StyledWord } from "@shared/markdown";
import { usePalette, type Palette } from "./theme";

// Fenced blocks have to come out of the text before anything else touches it. The word renderer
// splits on whitespace and gives every token its own padded chip — which destroys precisely what
// an ASCII diagram is made of, its line breaks and its column alignment, and turns a box-drawing
// figure into a bag of pills. splitBlocks/styledWords live in shared/ alongside the relay's
// stripFences, because "drawn words == spoken words" is a contract between the two and is only
// checkable if one test can count both (test/markdown.mjs).

const HIGHLIGHT_MS = 130; // long enough to read as a glide, short enough to stay on the beat

// Geometry is shared by both word renderers and must stay identical between them: a word that
// changed size when its line started being read would re-wrap the paragraph under the highlight.
const wordBox = (w: StyledWord) => ({
  borderRadius: 6,
  // The inter-word gap is padding only, sized to about the width of a real space (~4px), or the
  // paragraph reads as oddly justified.
  paddingHorizontal: w.code ? 5 : 2,
  paddingVertical: 2,
  marginVertical: 1,
});
const wordText = (w: StyledWord, p: Palette) => ({
  color: w.code ? p.codeFg : p.foreground,
  fontSize: w.code ? 13 : 14.5,
  lineHeight: 20,
  fontWeight: (w.bold ? "600" : "400") as "600" | "400",
  fontFamily: w.code ? "Menlo" : undefined,
});

// The overwhelming majority of words on screen can never light up: everything outside the one line
// currently being spoken. They used to be Animated.Views anyway, each with its own shared value
// and animated style, which is thousands of Reanimated nodes for a resumed transcript — mounted,
// and reconciled again on every playback tick. This is the plain version for those: no hooks, no
// animation, same box.
const StaticWord = memo(function StaticWord({ w, p }: { w: StyledWord; p: Palette }) {
  return (
    <View style={[wordBox(w), { backgroundColor: w.code ? p.codeBg : p.readWordOff }]}>
      <Text style={wordText(w, p)}>{w.text}</Text>
    </View>
  );
});

function Word({ w, isActive, p }: { w: StyledWord; isActive: boolean; p: Palette }) {
  // The highlight cross-fades rather than snapping, so it reads as travelling along the line:
  // the word being left fades out while the next fades in.
  const lit = useSharedValue(isActive ? 1 : 0);
  useEffect(() => { lit.value = withTiming(isActive ? 1 : 0, { duration: HIGHLIGHT_MS }); }, [isActive, lit]);

  const resting = w.code ? p.codeBg : p.readWordOff;
  const animated = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(lit.value, [0, 1], [resting, p.readWord]),
  }));

  return (
    <Animated.View
      // EVERY geometric property here is static — padding depends only on `w.code`, which never
      // changes for a given word. Only the background colour animates. That is deliberate and
      // load-bearing: the moment the highlight changes a size, the line re-wraps and words
      // visibly jump as they are read. The web client avoids this the same way (`px-1` is keyed
      // off `w.code`; the active state only swaps `bg-*`).
      style={[wordBox(w), animated]}
    >
      <Text style={wordText(w, p)}>{w.text}</Text>
    </Animated.View>
  );
}

// One paragraph of words. Split out and memoized so a playback tick re-renders only the paragraph
// whose highlight actually moved: `cursor` is -1 for every inactive line, so the memo holds.
const WordRow = memo(function WordRow({ sw, base, cursor, p, animated, style }: {
  sw: StyledWord[]; base: number; cursor: number; p: Palette; animated: boolean; style?: ViewStyle;
}) {
  return (
    <View className="flex-row flex-wrap items-center" style={style}>
      {sw.map((w, j) => (animated
        ? <Word key={j} w={w} isActive={base + j === cursor} p={p} />
        : <StaticWord key={j} w={w} p={p} />))}
    </View>
  );
});

// A fenced block, laid out as real preformatted text: one <Text> that keeps its own newlines, in
// a horizontal scroller. Scrolling sideways rather than wrapping is the whole point — an ASCII
// diagram is only legible while its columns stay in register, and on a phone almost every diagram
// is wider than the screen. `lineHeight` is pinned so successive rows stack at an even pitch and
// vertical rules read as vertical.
function CodeBlock({ text, p }: { text: string; p: Palette }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // Without this the scroller claims the full height of its parent and the block grows a
      // large empty margin under short snippets.
      style={{ backgroundColor: p.codeBg, borderRadius: 8, marginVertical: 6, flexGrow: 0 }}
      contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 8 }}
    >
      {/* Claims the touch so no ancestor can. Transcript messages are wrapped in a tap-to-read
          Pressable, and that Pressable took every swipe that started on the block as a tap: the
          block rendered correctly but would not scroll sideways at all. Reproduced headlessly with
          Maestro — inside the Pressable a swipe moved it 0px and fired read-aloud; with this view
          it moves 376px and fires nothing. Swallowing the tap is also right on its own terms: the
          relay never speaks fenced blocks, so "read from here" on a diagram has nothing to read. */}
      <View onStartShouldSetResponder={() => true}>
        <Text selectable style={{ color: p.codeFg, fontFamily: "Menlo", fontSize: 11.5, lineHeight: 16 }}>
          {text}
        </Text>
      </View>
    </ScrollView>
  );
}

export const SpokenLine = memo(function SpokenLine({ words, t, text }: { words: SpokenWord[]; t: number; text: string }) {
  const p = usePalette();
  const sw = useMemo(() => styledWords(text), [text]);
  // Words arrive in order, so the spoken one is the last whose start time has passed.
  let active = -1;
  for (let i = 0; i < words.length; i++) { if (words[i].start <= t) active = i; else break; }

  // `words` is empty for every line that is not being spoken, and the caller passes t=0 there, so
  // those lines take the static path — no shared values, and the memo above stops them re-rendering
  // ten times a second while some other line is read.
  return <WordRow sw={sw} base={0} cursor={active} p={p} animated={words.length > 0} />;
});

// Static rich text for turns that were never narrated — a resumed session's transcript arrives as
// plain assistant text with no `speech` lines, so there is nothing to highlight and nothing to
// collapse behind. Reuses the same word renderer so `**bold**` and `code` look identical to a
// spoken line, and keeps paragraph breaks, which splitting on whitespace alone would destroy.
export const RichText = memo(function RichText({ text, words = [], t = 0, active = false }: {
  text: string; words?: SpokenWord[]; t?: number; active?: boolean;
}) {
  const p = usePalette();
  // Fenced blocks first, then paragraphs and list items within each prose run. A code block is
  // rendered whole and counts for no words; a bullet is drawn as a glyph and counts for none either;
  // an ordered marker ("1.") is a real word. That is exactly what the relay speaks (spokenText), and
  // it is what keeps the highlight aligned. Words are split here, once per text, so the memoized rows
  // get stable arrays instead of fresh ones on every playback tick.
  const parts = useMemo(() => splitBlocks(text).flatMap((b): Part[] => b.type === "code"
    ? [{ kind: "code", text: b.text }]
    : proseItems(b.text).map((it): Part => it.kind === "ol"
      ? { kind: "ol", marker: [{ text: it.marker }], sw: styledWords(it.text) }
      : { kind: it.kind, sw: styledWords(it.text) })), [text]);
  // Word timings are for the whole line, but the text is rendered per paragraph — so track a
  // running offset to map a global word index onto each paragraph's local one.
  let seen = 0;
  let cursor = -1;
  if (active) for (let i = 0; i < words.length; i++) { if (words[i].start <= t) cursor = i; else break; }
  const isItem = (x?: Part) => x?.kind === "li" || x?.kind === "ol";
  return (
    <View>
      {parts.map((part, i) => {
        if (part.kind === "code") return <CodeBlock key={i} text={part.text} p={p} />;
        const next = parts[i + 1];
        // Items of one list sit close together; everything else keeps paragraph spacing.
        const gap = !next ? 0 : isItem(part) && isItem(next) ? 4 : 10;
        if (part.kind === "p") {
          const base = seen; seen += part.sw.length;
          return (
            <WordRow
              key={i} sw={part.sw} base={base} cursor={cursor} p={p}
              // Only a line actually being read aloud needs animated words. A restored transcript is
              // hundreds of these rows; giving every word a shared value was most of the mount cost.
              animated={active}
              style={{ marginBottom: gap }}
            />
          );
        }
        const marker = part.kind === "ol" ? part.marker : NO_WORDS;
        const base = seen; seen += marker.length + part.sw.length;
        return (
          // Hanging indent: the marker gets its own column so wrapped lines of the item line up
          // under its text, not under the bullet.
          <View key={i} style={{ flexDirection: "row", marginBottom: gap }}>
            {/* Fixed, not minWidth: "1." is narrower than "2.", and a column sized to its marker
                started item one's text a few px left of the rest. Right-aligned, so numbers line up
                on the period. */}
            <View style={{ width: 24, paddingRight: 4, alignItems: "flex-end" }}>
              {part.kind === "li"
                // lineHeight matches a word box (20 text + 2x2 padding + 2x1 margin), so the dot
                // sits on the first line's centre.
                ? <Text style={{ color: p.foreground, fontSize: 14.5, lineHeight: 26 }}>•</Text>
                : <WordRow sw={marker} base={base} cursor={cursor} p={p} animated={active} />}
            </View>
            <View style={{ flex: 1 }}>
              <WordRow sw={part.sw} base={base + marker.length} cursor={cursor} p={p} animated={active} />
            </View>
          </View>
        );
      })}
    </View>
  );
});

type Part =
  | { kind: "code"; text: string }
  | { kind: "p" | "li"; sw: StyledWord[] }
  | { kind: "ol"; marker: StyledWord[]; sw: StyledWord[] };
const NO_WORDS: StyledWord[] = [];
