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
import { useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { SpokenWord } from "@shared/protocol";
import { usePalette, type Palette } from "./theme";

type StyledWord = { text: string; bold?: boolean; code?: boolean };

// Split light markdown (**bold**, `code`) into words with the markers removed, preserving
// reading order so word index lines up with the TTS word timings.
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

const HIGHLIGHT_MS = 130; // long enough to read as a glide, short enough to stay on the beat

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
      // The inter-word gap is padding only, sized to about the width of a real space (~4px),
      // or the paragraph reads as oddly justified.
      style={[{
        borderRadius: 6,
        paddingHorizontal: w.code ? 5 : 2,
        paddingVertical: 2,
        marginVertical: 1,
      }, animated]}
    >
      <Text
        style={{
          color: w.code ? p.codeFg : p.foreground,
          fontSize: w.code ? 13 : 14.5,
          lineHeight: 20,
          fontWeight: w.bold ? "600" : "400",
          fontFamily: w.code ? "Menlo" : undefined,
        }}
      >
        {w.text}
      </Text>
    </Animated.View>
  );
}

export function SpokenLine({ words, t, text }: { words: SpokenWord[]; t: number; text: string }) {
  const p = usePalette();
  const sw = useMemo(() => styledWords(text), [text]);
  // Words arrive in order, so the spoken one is the last whose start time has passed.
  let active = -1;
  for (let i = 0; i < words.length; i++) { if (words[i].start <= t) active = i; else break; }

  return (
    <View className="flex-row flex-wrap items-center">
      {sw.map((w, i) => <Word key={i} w={w} isActive={i === active} p={p} />)}
    </View>
  );
}

// Static rich text for turns that were never narrated — a resumed session's transcript arrives as
// plain assistant text with no `speech` lines, so there is nothing to highlight and nothing to
// collapse behind. Reuses the same word renderer so `**bold**` and `code` look identical to a
// spoken line, and keeps paragraph breaks, which splitting on whitespace alone would destroy.
export function RichText({ text, words = [], t = 0, active = false }: {
  text: string; words?: SpokenWord[]; t?: number; active?: boolean;
}) {
  const p = usePalette();
  const paras = useMemo(() => text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean), [text]);
  // Word timings are for the whole line, but the text is rendered per paragraph — so track a
  // running offset to map a global word index onto each paragraph's local one.
  let seen = 0;
  let cursor = -1;
  if (active) for (let i = 0; i < words.length; i++) { if (words[i].start <= t) cursor = i; else break; }
  return (
    <View>
      {paras.map((para, i) => {
        const sw = styledWords(para);
        const base = seen; seen += sw.length;
        return (
          <View key={i} className="flex-row flex-wrap items-center" style={{ marginBottom: i < paras.length - 1 ? 10 : 0 }}>
            {sw.map((w, j) => <Word key={j} w={w} isActive={base + j === cursor} p={p} />)}
          </View>
        );
      })}
    </View>
  );
}
