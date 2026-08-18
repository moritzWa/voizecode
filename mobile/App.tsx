// Native port of the web client's index.tsx. Structure, control layout and wording follow it
// closely on purpose — this is the same app on a different screen, not a companion with a
// different opinion. Read them side by side when changing either.
import { useEffect, useRef, useState } from "react";
import {
  Alert, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
// Same icon set as the web client (lucide), so the two read as one product.
import {
  AudioLines, AudioWaveform, ChevronDown, ChevronRight, GitPullRequest, Hand, Keyboard as KeyboardIcon,
  Mic, MicOff, Pause, Pencil, Play, Plus, SendHorizontal, Settings as SettingsIcon, Square, X,
} from "lucide-react-native";
import type { PullRequest, SavedSession, SpokenWord } from "@shared/protocol";
import { useVoize } from "./src/core/useVoize";
import type { Line } from "./src/core/useVoize";
import { RichText, SpokenLine } from "./src/ui/SpokenLine";
import { PRModal, SessionBrowser, SessionPicker, SettingsModal } from "./src/ui/modals";
import { usePalette } from "./src/ui/theme";
import { applyPendingUpdate } from "./src/ui/updates";
import "./global.css";

// Agent replies are collapsed by default: the narrator lines below them are the reading surface,
// and the raw reply is there for detail on demand. Without this the transcript shows every reply
// twice — once in full, once narrated.
function AgentMessage({ text, history, words, t, active, onRead }: {
  text: string; history?: boolean; words?: SpokenWord[]; t?: number; active?: boolean; onRead?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const p = usePalette();
  const preview = text.length > 60 ? text.slice(0, 60).replace(/\s+\S*$/, "") + "…" : text;
  // A restored turn has no narrated lines under it, so the disclosure would hide the whole
  // answer behind a chevron. Show it outright, rendered rather than as raw markdown.
  // Tapping reads it aloud: these turns were never narrated, so there is no stored clip — the
  // relay synthesizes on demand. Highlighting then works exactly as it does for a spoken line.
  if (history) return (
    <Pressable onPress={onRead} className={`rounded-2xl px-2.5 py-1.5 ${active ? "bg-read-line" : ""}`}>
      <RichText text={text} words={words} t={t} active={active} />
    </Pressable>
  );
  return (
    <View>
      <Pressable onPress={() => setOpen((o) => !o)} className="flex-row items-center gap-1 py-0.5 active:opacity-60">
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <ChevronRight size={12} color={p.faint} />
        </View>
        <Text numberOfLines={1} className="flex-1 text-muted-foreground/70 text-[11px]">
          {open ? "full reply" : `full reply · ${preview}`}
        </Text>
      </Pressable>
      {open && (
        // Light markdown only (**bold**, `code`) via the shared word renderer — no block-level
        // markdown (lists, headings, fenced blocks) is parsed. Enough for a reply that is mostly
        // prose; see TODO.md if that stops being true.
        <Pressable onPress={onRead} className={`rounded-2xl px-1 py-0.5 ${active ? "bg-read-line" : ""}`}>
          <RichText text={text} words={words} t={t} active={active} />
        </Pressable>
      )}
    </View>
  );
}

function Btn({
  label, icon, onPress, variant = "outline", flex, size = "md",
}: {
  label?: string; icon?: React.ReactNode; onPress: () => void;
  variant?: "primary" | "outline" | "secondary" | "success" | "warning" | "danger";
  flex?: boolean; size?: "md" | "lg" | "xl";
}) {
  const bg = {
    primary: "bg-primary border-primary",
    outline: "bg-transparent border-border",
    secondary: "bg-secondary border-secondary",
    success: "bg-success border-success",
    warning: "bg-warning border-warning",
    danger: "bg-danger border-danger",
  }[variant];
  // Label colour is a style, not a class. The class form silently produced invisible text on the
  // filled variants — the label was in the tree and reachable by VoiceOver, but drew as nothing,
  // which also threw off centring: the icon+label row centres as a group, so an empty-width
  // label pushes the icon off to one side. That is the "record icon not centred" symptom.
  const p = usePalette();
  const fg = {
    primary: p.primaryForeground,
    outline: p.foreground,
    secondary: p.secondaryForeground,
    success: p.onColor,
    warning: p.onWarning,
    danger: p.onColor,
  }[variant];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      // minHeight, not padding, decides the height. A button that is a direct child of a
      // column was being laid out SHORTER than its own vertical padding, which clipped the text
      // line out of the box while leaving the icon — a label that looked missing, and an icon
      // that looked off-centre because it was then the only thing being centred.
      style={{ minHeight: size === "xl" ? 56 : size === "lg" ? 50 : 44 }}
      className={`${flex ? "flex-1 " : ""}${bg} flex-row items-center justify-center gap-2 border active:opacity-75 ${
        size === "xl" ? "rounded-[18px] py-4 px-4" : size === "lg" ? "rounded-2xl py-3.5 px-4" : "rounded-2xl py-3 px-3.5"
      }`}
    >
      {icon}
      {!!label && (
        // Styled entirely with `style`, deliberately NO className. NativeWind owns the `style`
        // prop of any element it processes, and on a Text it was discarding this colour — so the
        // label rendered in the default black: invisible on every dark variant, and accidentally
        // correct-looking on `primary`, which has a white background. The symptom was a button
        // showing only its icon, apparently off-centre, because the icon+label row centres as a
        // group and the label contributed no visible width.
        <Text numberOfLines={1} style={{ color: fg, flexShrink: 0, fontWeight: "600", fontSize: size === "xl" ? 16 : 14.5 }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}


function AccessGate({ onSubmit }: { onSubmit: (code: string) => void }) {
  const [code, setCode] = useState("");
  const p = usePalette();
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
      <Text className="text-foreground text-[18px] font-semibold">voizecode</Text>
      <Text className="text-muted-foreground text-center text-[14px] leading-[21px]">
        Enter your access code to connect. It came from your laptop agent — or just open the
        phone link it printed.
      </Text>
      <TextInput
        value={code} onChangeText={setCode} onSubmitEditing={() => onSubmit(code)}
        placeholder="access code" placeholderTextColor={p.mutedForeground}
        autoCapitalize="none" autoCorrect={false} returnKeyType="go"
        className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-foreground text-[15px]"
      />
      <Btn label="Connect" variant="primary" onPress={() => onSubmit(code)} />
    </View>
  );
}

// Split from the default export purely so useSafeAreaInsets has a provider above it — the hook
// returns zeros when called in the same component that renders SafeAreaProvider.
export default function App() {
  return (
    <SafeAreaProvider>
      <ThemedStatusBar />
      <Main />
    </SafeAreaProvider>
  );
}

// StatusBar has to invert with the theme or the clock disappears into the background.
function ThemedStatusBar() {
  const { isDark } = usePalette();
  return <StatusBar style={isDark ? "light" : "dark"} />;
}

function Main() {
  useEffect(() => { void applyPendingUpdate(); }, []);
  const v = useVoize();
  const insets = useSafeAreaInsets();
  const p = usePalette();
  const FG = p.foreground, MUTED = p.mutedForeground, DARK = p.primaryForeground;
  const [draft, setDraft] = useState("");
  const [browser, setBrowser] = useState(false);
  const [settings, setSettings] = useState(false);
  const [prModal, setPrModal] = useState(false);
  const [typing, setTyping] = useState(false);   // typed input is opt-in; voice is the default
  // The bottom spacer exists to clear the screen's corner curve. With the keyboard up there is no
  // curve to clear — KeyboardAvoidingView has already lifted everything — so keeping the spacer
  // just wedges an empty band between the composer and the keyboard.
  const [kbUp, setKbUp] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", () => setKbUp(true));
    const hide = Keyboard.addListener("keyboardWillHide", () => setKbUp(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const [forkPoint, setForkPoint] = useState<number | null>(null); // userIndex being edited
  const scroller = useRef<ScrollView>(null);
  const prevChat = useRef<string | null>(null);

  // Auto-scroll: jump to the bottom on a chat switch, and follow genuinely new lines. It must NOT
  // react to playback state — tapping an old line to replay it briefly clears speakingClip, and
  // reacting to that yanked the view to the bottom, away from the line just tapped.
  const prevLineCount = useRef(0);
  // Opening a chat should land at the newest message. A single timed scrollToEnd is not enough:
  // a resumed chat's `history` arrives after the switch and re-lays out a long transcript, so the
  // scroll fires against a container that is still growing and lands short. `stickBottom` keeps
  // us pinned through those layout passes (see onContentSizeChange) until the user scrolls away.
  const stickBottom = useRef(true);
  useEffect(() => {
    const switched = prevChat.current !== v.activeId;
    prevChat.current = v.activeId;
    const grew = v.lines.length > prevLineCount.current;
    prevLineCount.current = v.lines.length;
    if (!switched && !grew) return;
    // New output arriving while something is being read must not drag the reader away from it.
    if (!switched && v.speakingClip != null) return;
    stickBottom.current = true;
    const id = setTimeout(() => scroller.current?.scrollToEnd({ animated: !switched }), 60);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.activeId, v.lines.length]);

  // The home screen IS the picker, so it needs the list without anyone opening a sheet. The
  // condition has to match the one that renders it, or the home screen shows empty sections.
  useEffect(() => {
    if (!v.activeId && v.sessions.length) v.requestSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.activeId, v.sessions.length]);

  if (v.authError) return <AccessGate onSubmit={v.submitCode} />;

  const isCodexChat = v.model === "codex"; // forking is Claude-only
  const resetInput = () => { setDraft(""); setForkPoint(null); setTyping(false); };
  const submit = () => {
    if (!draft.trim()) return;
    if (forkPoint != null) v.forkChat(forkPoint, draft); else v.sendText(draft);
    resetInput();
  };
  const openBrowser = () => { v.requestSessions(); setBrowser(true); };
  // Closing a chat kills its claude subprocess, so it asks first rather than being one stray tap.
  const confirmClose = (sid: string, name: string) =>
    Alert.alert("Close chat?", `“${name}” ends its agent session.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Close", style: "destructive", onPress: () => v.closeSession(sid) },
    ]);

  let userSeen = 0;
  // "Something is being spoken, or is paused mid-sentence" — the condition for showing playback
  // controls at all.
  const speaking = v.speakingClip != null || v.paused;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {/* The home-indicator inset alone is not enough clearance: the screen's corner radius cuts
          into the bottom row, so full-width controls sit visually jammed into the curve. Pad
          past the inset rather than sitting on it. */}
      <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
        <KeyboardAvoidingView
          className="flex-1 gap-2 pt-2"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >

          {/* Tabs are the top edge. Every target here is >=44pt tall: the close button used to be
              a 12px glyph with a tiny hit area, which is unhittable on a moving phone. Closing is
              also destructive (it kills that chat's claude), so it now lives behind a long-press
              on the tab rather than a stray tap next to the label. */}
          <View className="flex-row items-center gap-1 px-3">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
              <View className="flex-row items-center gap-1.5 py-0.5">
                {v.sessions.length === 0 && (
                  <Text className="px-1 text-[13px] text-muted-foreground">no sessions — start the laptop agent</Text>
                )}
                {v.sessions.map((s) => {
                  const activeTab = s.sessionId === v.activeId;
                  const title = v.titles[s.sessionId];
                  return (
                    // The close affordance is visible again, but as its own 40pt target set apart
                    // from the label — the old version was a 12px glyph butted against the text,
                    // which is both unhittable and easy to hit by accident. It only appears on
                    // the focused tab, so a row of chats isn't a row of delete buttons. Long-
                    // pressing the tab does the same thing, and either route confirms first
                    // because closing kills that chat's agent.
                    <View
                      key={s.sessionId}
                      className={`h-11 max-w-[260px] flex-row items-center rounded-full ${
                        activeTab ? "bg-bubble" : "bg-transparent"
                      }`}
                    >
                      <Pressable
                        onPress={() => v.switchSession(s.sessionId)}
                        onLongPress={() => v.sessions.length > 1 && confirmClose(s.sessionId, title || s.label)}
                        delayLongPress={400}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: activeTab }}
                        accessibilityLabel={`${s.label}${title ? ` · ${title}` : ""}`}
                        className="h-11 min-w-0 flex-shrink flex-row items-center gap-2 rounded-full pl-4 pr-2 active:opacity-70"
                      >
                        {v.unread[s.sessionId] && !activeTab && <View className="h-2 w-2 rounded-full bg-blue-500" />}
                        <Text numberOfLines={1} className={`text-[14.5px] ${activeTab ? "text-foreground" : "text-muted-foreground"}`}>
                          <Text className="font-medium">{s.label}</Text>
                          {!!title && <Text className="text-muted-foreground"> · {title}</Text>}
                        </Text>
                      </Pressable>
                      {activeTab && v.sessions.length > 1 && (
                        <Pressable
                          onPress={() => confirmClose(s.sessionId, title || s.label)}
                          accessibilityRole="button"
                          accessibilityLabel={`Close ${s.label}`}
                          className="mr-1 h-9 w-9 items-center justify-center rounded-full active:bg-secondary"
                        >
                          <X size={15} color={MUTED} />
                        </Pressable>
                      )}
                    </View>
                  );
                })}
                {v.sessions.length > 0 && (
                  <Pressable onPress={openBrowser} accessibilityRole="button" accessibilityLabel="New chat"
                    className="h-11 w-11 items-center justify-center rounded-full active:bg-secondary">
                    <Plus size={18} color={FG} />
                  </Pressable>
                )}
              </View>
            </ScrollView>
            <Pressable onPress={() => setPrModal(true)} accessibilityRole="button" accessibilityLabel="Pull requests"
              className="h-11 w-11 items-center justify-center rounded-full active:bg-secondary">
              <GitPullRequest size={17} color={MUTED} />
            </Pressable>
            {/* "App settings", not "Settings": expo-dev-client's floating dev-tools button also
                answers to "Settings" and drifts over the top bar, so the bare name is ambiguous
                to both VoiceOver and the e2e flows. */}
            <Pressable onPress={() => setSettings(true)} accessibilityRole="button" accessibilityLabel="App settings"
              className="h-11 w-11 items-center justify-center rounded-full active:bg-secondary">
              <SettingsIcon size={17} color={MUTED} />
            </Pressable>
            <View className={`ml-0.5 h-2 w-2 rounded-full ${v.connected ? "bg-success" : "bg-danger"}`} />
          </View>

          {/* Home: shown only when NO chat is focused. A focused-but-empty chat is a blank page
              on purpose — you opened it deliberately, and replacing it with a picker makes the
              act of opening look like it did nothing. Boot avoids focusing an empty session (see
              the `sessions` handler in useVoize) so a cold start lands here rather than on blank. */}
          {!v.activeId ? (
            <View className="flex-1">
              <SessionPicker
                projects={v.projects} sessions={v.savedSessions}
                onProject={(cwd: string, label: string, engine: string) => v.newInProject(cwd, label, engine)}
                onSession={(s: SavedSession, engine: string) => v.openSession(s.id, s.cwd, s.label, engine)}
              />
            </View>
          ) : (
          <>
          {/* transcript */}
          <ScrollView
            ref={scroller}
            // Fires on every layout pass as a restored transcript fills in; keeps us at the newest
            // message until the user scrolls up, which clears the flag below.
            onContentSizeChange={() => { if (stickBottom.current) scroller.current?.scrollToEnd({ animated: false }); }}
            onScrollBeginDrag={() => { stickBottom.current = false; }}
            scrollEventThrottle={16}
            // Full-bleed: the transcript is the content, and side padding here only narrowed the
            // messages. Horizontal breathing room lives on the rows themselves.
            className="flex-1 bg-card"
            contentContainerClassName="px-3 py-4 gap-2.5"
          >
            {v.lines.map((l: Line, i: number) => {
              if (l.kind === "agent") {
                const act = l.clip != null && l.clip === v.speakingClip;
                return (
                  <AgentMessage
                    key={i} text={l.text} history={l.history}
                    words={l.clip != null ? v.clipWords[l.clip] : undefined}
                    t={act ? v.speakingTime : 0} active={act}
                    onRead={() => v.readFrom(i)}
                  />
                );
              }

              if (l.kind === "speech") {
                const active = l.clip != null && l.clip === v.speakingClip;
                const words = l.clip != null ? v.clipWords[l.clip] : undefined;
                return (
                  <Pressable
                    key={i}
                    onPress={() => l.key && v.replayClip(l)}
                    // The line being read gets a soft rounded wash so you can find your place at
                    // a glance; the word inside it gets the stronger one (see SpokenLine).
                    className={`rounded-2xl px-2.5 py-1.5 ${active ? "bg-read-line" : ""}`}
                  >
                    <SpokenLine
                      words={active && words?.length ? words : []}
                      t={active ? v.speakingTime : 0}
                      text={l.text}
                    />
                  </Pressable>
                );
              }

              if (l.kind === "user") {
                const userIndex = userSeen++;
                return (
                  <View key={i} className="flex-row items-center justify-end gap-1.5">
                    {!isCodexChat && (
                      <Pressable
                        onPress={() => { setForkPoint(userIndex); setDraft(l.text); }}
                        hitSlop={8} className="p-1 active:opacity-60"
                      >
                        <Pencil size={13} color={MUTED} />
                      </Pressable>
                    )}
                    {/* A lifted grey card, not an inverted white one. Same text colour as the
                        agent's lines — the surface says who is speaking. */}
                    <View className="max-w-[85%] rounded-[20px] bg-bubble px-4 py-2.5">
                      <Text className="text-foreground text-[14.5px] leading-[22px]">{l.text}</Text>
                    </View>
                  </View>
                );
              }

              return <Text key={i} className="px-1 text-[12px] italic text-muted-foreground">{l.text}</Text>;
            })}
            {/* While rambling, the live transcript is a *draft* — the relay is accumulating it and
                will not deliver anything until you tap send. Showing it identically to a sent
                message is what makes it look like it already went. */}
            {!!v.interim && (
              v.rambling ? (
                <View className="self-end max-w-[85%] rounded-[20px] border border-dashed border-border bg-bubble/60 px-4 py-2.5">
                  <Text className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Draft — not sent</Text>
                  <Text className="text-muted-foreground text-[14.5px] leading-[22px]">{v.interim}</Text>
                </View>
              ) : (
                <Text className="self-end px-3 text-[14px] text-muted-foreground">{v.interim}…</Text>
              )
            )}
          </ScrollView>

          </>
          )}

          {!!v.micError && (
            <View className="mx-3 rounded-md bg-destructive/20 px-3 py-2">
              <Text className="text-[12px] text-red-300">{v.micError}</Text>
            </View>
          )}

          {/* call controls — same two layouts as the web client */}
          {/* Voice is the primary input, so the dock is built around it: one wide voice button,
              with typing and call mode as small affordances beside it rather than peers.
              Inset lives here now that the transcript is full-bleed. */}
          {v.rambling ? (
            // Mid-ramble. Cancel has to be as reachable as send — this is the mode for thinking
            // out loud, which is only safe if backing out is one tap.
            <View className="gap-2 px-3">
              <Btn
                label="Tap to send" icon={<Square size={16} color={p.onColor} />}
                // Wrapped, NOT passed directly: onPress hands the press event to the handler, and
                // endRamble's first parameter is `discard` — so `onPress={v.endRamble}` silently
                // threw the ramble away instead of sending it.
                variant="danger" size="xl" onPress={() => v.endRamble()}
              />
              <View className="flex-row gap-2">
                <Btn label="Cancel" icon={<X size={15} color={FG} />} variant="secondary" flex onPress={v.cancelRamble} />
                <Btn
                  label={v.muted ? "Muted" : "Mute"}
                  icon={v.muted ? <MicOff size={15} color={p.onColor} /> : <Mic size={15} color={FG} />}
                  variant={v.muted ? "danger" : "outline"} flex onPress={v.toggleMute}
                />
              </View>
            </View>
          ) : v.live ? (
            // Call mode: continuous conversation.
            <View className="gap-2 px-3">
              <Btn
                label={v.muted ? "Muted" : "Listening"}
                // The icon colour has to follow the variant. Hardcoded white left a white mic on
                // the light-grey `secondary` fill when muted — invisible in light mode.
                icon={v.muted
                  ? <MicOff size={18} color={p.secondaryForeground} />
                  : <Mic size={18} color={p.onColor} />}
                variant={v.muted ? "secondary" : "success"} size="xl" onPress={v.toggleMute}
              />
              <View className="flex-row gap-2">
                {speaking && (
                  <Btn icon={v.paused ? <Play size={16} color={FG} /> : <Pause size={16} color={FG} />}
                    variant="outline" onPress={v.togglePlayback} />
                )}
                <Btn label="Ramble" icon={<AudioLines size={15} color={FG} />} variant="outline" flex onPress={v.toggleRamble} />
                <Btn label="Interrupt" icon={<Hand size={15} color={p.onWarning} />} variant="warning" flex onPress={v.interruptNow} />
                <Btn icon={<Square size={15} color={FG} />} variant="secondary" onPress={v.stop} />
              </View>
            </View>
          ) : (
            <View className="flex-row items-center gap-2 px-3">
              {/* Playback control only exists while there is playback: a permanently-parked pause
                  button is dead weight most of the time, and it was previously the only way to
                  discover you could pause at all. */}
              {speaking && (
                <Pressable
                  onPress={v.togglePlayback}
                  accessibilityRole="button" accessibilityLabel={v.paused ? "Resume" : "Pause"}
                  className="h-[58px] w-[52px] items-center justify-center rounded-[18px] bg-secondary active:opacity-75"
                >
                  {v.paused ? <Play size={19} color={FG} /> : <Pause size={19} color={FG} />}
                </Pressable>
              )}
              {/* Typing is the secondary path, so it's a single icon that reveals the composer. */}
              <Pressable
                onPress={() => setTyping((t) => !t)}
                accessibilityRole="button" accessibilityLabel="Type a message"
                className="h-[58px] w-[52px] items-center justify-center rounded-[18px] border border-border active:bg-secondary"
              >
                <KeyboardIcon size={19} color={MUTED} />
              </Pressable>
              <Btn
                label="Ramble" icon={<AudioLines size={20} color={DARK} />}
                variant="primary" size="xl" flex onPress={() => v.start(true)}
              />
              {/* Call mode, ChatGPT-style: a waveform pill rather than a labelled button. */}
              <Pressable
                onPress={() => v.start()}
                accessibilityRole="button" accessibilityLabel="Start call"
                className="h-[58px] w-[52px] items-center justify-center rounded-[18px] bg-secondary active:opacity-75"
              >
                <AudioWaveform size={20} color={FG} />
              </Pressable>
            </View>
          )}

          {forkPoint != null && (
            <View className="mx-3 flex-row items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5">
              <Text className="flex-1 text-[11px] text-amber-300">
                ✎ Editing from here — sending rewinds the chat to this point (the rest is discarded).
              </Text>
              <Pressable onPress={resetInput} hitSlop={8}><Text className="text-amber-300 text-[12px]">✕</Text></Pressable>
            </View>
          )}

          {/* Typed input is opt-in: hidden until the keyboard affordance is tapped, or whenever
              there is a draft to preserve. Voice is the primary path; a permanently-parked text
              box would say otherwise. */}
          {(typing || !!draft.trim()) && (
          <View className="mx-3 rounded-[22px] bg-bubble px-3 pb-2 pt-1">
            <TextInput
              autoFocus
              value={draft} onChangeText={setDraft}
              // Multiline, so Return inserts a newline and the send button sends. The web client
              // can use Enter-to-send because it has Shift+Enter for a newline; a phone keyboard
              // has no such pair, and a Return that fires off a half-written thought is worse
              // than one extra tap. (onSubmitEditing does not fire on a multiline input anyway.)
              multiline
              placeholder={v.thinking && !draft.trim() ? "running — type to steer, or stop" : "Ask about your code, or steer the agent"}
              placeholderTextColor={MUTED}
              className="max-h-32 min-h-[42px] px-1.5 py-2.5 text-foreground text-[15px] leading-[21px]"
            />
            <View className="flex-row items-center gap-1">
              {/* Icon-only controls need explicit labels: without them VoiceOver announces
                  nothing useful, and nothing can address them by name. */}
              <Pressable onPress={() => { setDraft(""); setTyping(false); }} hitSlop={6}
                accessibilityRole="button" accessibilityLabel="Hide the keyboard"
                className="h-9 w-9 items-center justify-center rounded-full active:bg-secondary">
                <ChevronDown size={18} color={MUTED} />
              </Pressable>
              <View className="flex-1" />
              {draft.trim() ? (
                <Pressable onPress={submit} accessibilityRole="button" accessibilityLabel="Send"
                  className="h-9 w-9 items-center justify-center rounded-full bg-foreground active:opacity-75">
                  <SendHorizontal size={16} color={DARK} />
                </Pressable>
              ) : v.thinking ? (
                <Pressable onPress={v.interruptNow} accessibilityRole="button" accessibilityLabel="Stop the agent"
                  className="h-9 w-9 items-center justify-center rounded-full bg-danger active:opacity-75">
                  <Square size={14} color={p.onColor} />
                </Pressable>
              ) : (
                <View className="h-9 w-9 items-center justify-center rounded-full bg-secondary">
                  <SendHorizontal size={16} color={p.faint} />
                </View>
              )}
            </View>
          </View>
          )}

          {/* Bottom clearance as a spacer, NOT as paddingBottom on the KeyboardAvoidingView:
              with behavior="padding" that view owns its own bottom padding and silently
              overwrites anything set here, which is why the controls kept sitting in the screen's
              corner curve however large the value got. The curve is ~55pt, so the home-indicator
              inset alone leaves the outer buttons clipped. */}
          <View style={{ height: kbUp ? 0 : Math.max(insets.bottom, 16) + 14 }} />
        </KeyboardAvoidingView>

        {browser && (
          <SessionBrowser
            projects={v.projects} sessions={v.savedSessions}
            onProject={(cwd: string, label: string, engine: string) => { v.newInProject(cwd, label, engine); setBrowser(false); }}
            onSession={(s: SavedSession, engine: string) => { v.openSession(s.id, s.cwd, s.label, engine); setBrowser(false); }}
            onClose={() => setBrowser(false)}
          />
        )}
        {settings && <SettingsModal v={v} onClose={() => setSettings(false)} />}
        {prModal && (
          <PRModal
            v={v}
            onClose={() => setPrModal(false)}
            onPick={(p: PullRequest) => {
              v.sendText(`Let's look at my PR #${p.number}: "${p.title}" (${p.url}). Read the diff with gh to understand the code, then wait for my instructions.`);
              setPrModal(false);
            }}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
