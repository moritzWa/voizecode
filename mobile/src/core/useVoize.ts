// Port of client/src/hooks/useVoize.ts — the relay protocol state machine.
//
// The web version is the reference implementation; read it alongside this. The message handling
// is deliberately line-for-line comparable so a protocol change can be applied to both. What
// changed, and why:
//   - localStorage -> the hydrated cache in ./storage (async under the hood, sync at the edges).
//   - MediaSource/HTMLAudioElement -> ../audio/ClipPlayer.
//   - getUserMedia + ScriptProcessor -> ../audio/Mic.
//   - The `online` event -> AppState. RN has no navigator.onLine; coming back to the foreground
//     after a tunnel or a night asleep is the case that actually matters on a phone.
//   - Mic *selection* is gone. It exists on the web because a Mac has a Studio Display mic and a
//     built-in one; iOS routes audio itself and offers no equivalent choice.
//   - Silero VAD is not wired yet, so barge-in currently relies on the relay's endpointing. The
//     duck/confirm/resume state below is ported intact and ready for a VAD to drive it.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Linking from "expo-linking";
import type { SessionInfo, SavedSession, ProjectInfo, PullRequest, SpokenWord } from "@shared/protocol";
import { ClipPlayer } from "../audio/ClipPlayer";
import { Mic } from "../audio/Mic";
import { ThinkingTone } from "../audio/ThinkingTone";
import { initSession } from "../audio/session";
import { AudioManager } from "react-native-audio-api";
import { b64ToBytes } from "./base64";
import * as store from "./storage";
import { KEYS } from "./storage";

const RELAY_WS = process.env.EXPO_PUBLIC_RELAY_WS || "wss://voizecode-relay.fly.dev";
const RECONNECT_CAP_MS = 15000;
// How long after our own speech ends before the mic is trusted again. Covers speaker decay plus
// whatever Deepgram still has buffered; below ~200ms the tail of the last word gets transcribed.
const ECHO_TAIL_MS = 350;

// `history` marks turns restored from a resumed session's transcript. Those have no narrated
// `speech` lines to accompany them, so the UI must show them in full rather than collapsing
// them behind a "full reply" disclosure — collapsing would hide the entire answer.
export type Line = { kind: "user" | "agent" | "status" | "speech"; text: string; clip?: number; key?: string; history?: boolean };
type TabInfo = { claudeSessionId: string; cwd: string; label: string };
type HeldEvent = { c: number; b?: string; e?: boolean };

// ElevenLabs premade voices — kept in sync with the web client's list by hand. If these ever
// drift, the relay just falls through to its default voice rather than erroring.
export const VOICES = [
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah ♀" },
  { id: "9BWtsMINqrJLrRacOk9x", label: "Aria ♀" },
  { id: "FGY2WhTYpPnrIDTdsKH5", label: "Laura ♀" },
  { id: "XB0fDUnXU5powFXDhCwa", label: "Charlotte ♀" },
  { id: "pFZP5JQG7iQjIQuC4Bku", label: "Lily ♀" },
  { id: "JBFqnCBsd6RMkjVDRZzb", label: "George ♂" },
  { id: "nPczCjzI2devNBz1zQrb", label: "Brian ♂" },
  { id: "bIHbv24MWmeRgasZH58o", label: "Will ♂" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", label: "Liam ♂" },
  { id: "SAz9YHcvj6GT2YYXdXww", label: "River ⚥" },
];
export const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"; // George ♂
// The previous default. A stored preference normally wins over the default, which would leave
// anyone who never opened the voice picker stuck on the old voice forever — so a stored value
// that is merely the old default is treated as "never chose one".
const LEGACY_DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL"; // Sarah ♀

const normModel = (m: string) =>
  m.includes("haiku") ? "haiku" : m.includes("opus") ? "opus" : m.includes("sonnet") ? "sonnet" : m;

// The access code can arrive three ways: a universal link tapped from the clipboard
// (https://voizecode.com/?key=…), the custom scheme (voizecode://?key=…), or typed into the gate.
// A link always wins over the stored value — pasting a fresh link is how you rotate the code.
export function tokenFromUrl(url: string | null): string {
  if (!url) return "";
  try {
    const { queryParams } = Linking.parse(url);
    const key = queryParams?.key;
    return typeof key === "string" ? key : "";
  } catch { return ""; }
}

export function useVoize() {
  const [connected, setConnected] = useState(false);
  const [authError, setAuthError] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const authFailed = useRef(false);
  const [live, setLive] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState("");
  const [convos, setConvos] = useState<Record<string, Line[]>>(() => store.getJSON(KEYS.convos, {}));
  const [interim, setInterim] = useState<Record<string, string>>({});
  const [thinking, setThinking] = useState<Record<string, boolean>>({});
  const [unread, setUnread] = useState<Record<string, boolean>>({});
  const [rate, setRateState] = useState(() => Number(store.get(KEYS.rate)) || 2.5);
  const [micError, setMicError] = useState("");
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [rambling, setRambling] = useState(false);
  const ramblingRef = useRef(false);
  const [speakingClip, setSpeakingClip] = useState<number | null>(null);
  const [speakingTime, setSpeakingTime] = useState(0);
  const [clipWords, setClipWords] = useState<Record<number, SpokenWord[]>>({});
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [prsLoading, setPrsLoading] = useState(false);
  const [metas, setMetas] = useState<Record<string, { claudeSessionId: string; cwd: string }>>({});
  const [voice, setVoiceState] = useState(() => {
    const stored = store.get(KEYS.voice);
    if (!stored || stored === LEGACY_DEFAULT_VOICE) return DEFAULT_VOICE;
    return VOICES.some((v) => v.id === stored) ? stored : DEFAULT_VOICE;
  });
  const voiceRef = useRef(voice);
  const [thinkingSound, setThinkingSoundState] = useState(() => store.get(KEYS.thinkingSound) === "1");
  const thinkingSoundRef = useRef(false);

  const sessionsRef = useRef<SessionInfo[]>([]);
  const restoredTabs = useRef<Set<string>>(new Set());
  const savedActive = useRef<{ sid: string; label?: string } | null>(store.getJSON(KEYS.active, null));
  const refocused = useRef(false);

  const ws = useRef<WebSocket | null>(null);
  const lastSeq = useRef(0);
  const hbTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const wdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retry = useRef(0);
  const wantNew = useRef(false);
  const forkSend = useRef<{ sid: string; text: string } | null>(null);
  const knownIds = useRef<Set<string>>(new Set());
  const activeRef = useRef(activeId);
  const rateRef = useRef(rate);
  const agentBuf = useRef<Record<string, string>>({});
  const player = useRef<ClipPlayer | null>(null);
  const mic = useRef<Mic | null>(null);
  const tone = useRef<ThinkingTone | null>(null);
  const vadPending = useRef(false);
  const vadHadTranscript = useRef(false);
  const vadResumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Record<string, HeldEvent[]>>({});
  const replayQ = useRef<{ key: string; clip: number }[]>([]);
  const replayAudio = useRef<Record<string, { b64: string; words: SpokenWord[] }>>({});
  const replayNext = useRef(0);
  const replayPlayed = useRef(0); // clips in this replay that actually had audio
  const replaying = useRef(false);
  const convosRef = useRef<Record<string, Line[]>>({});
  const rambleOwnsMic = useRef(false); // Ramble opened the mic, so ending it should close it
  const readbackQ = useRef<number[]>([]); // line indices awaiting their synthesized clip, in order
  // Half-duplex echo gate: the mic is held muted while our own TTS is coming out of the speaker.
  // Without it the phone transcribes the assistant and feeds it back as your next turn — "Loud and
  // clear, go ahead" came back as "Sylvia. You have that one clear. Go ahead." iOS only does
  // hardware echo cancellation in the voiceChat session mode, which halves the output volume
  // (see ../audio/session), so this is the trade we take instead.
  const echoMute = useRef(false);
  const echoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { activeRef.current = activeId; }, [activeId]);
  useEffect(() => { store.setJSON(KEYS.convos, convos); convosRef.current = convos; }, [convos]);
  useEffect(() => {
    if (!activeId) return;
    const label = sessionsRef.current.find((s) => s.sessionId === activeId)?.label;
    store.setJSON(KEYS.active, { sid: activeId, label });
  }, [activeId, sessions]);

  const send = (m: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
  };
  const addLine = (sid: string, l: Line) =>
    setConvos((p) => ({ ...p, [sid]: [...(p[sid] || []).slice(-300), l] }));
  const flushAgent = (sid: string) => {
    const t = agentBuf.current[sid]?.trim();
    if (t) addLine(sid, { kind: "agent", text: t });
    agentBuf.current[sid] = "";
  };

  // The mic has two independent reasons to be muted: you tapped mute, and we are speaking. The
  // recorder only has one flag, so the effective state is the OR of the two, applied here.
  // (Muted still streams silence rather than stopping — see ../audio/Mic.)
  const applyMic = () => mic.current?.setMuted(mutedRef.current || echoMute.current);

  // Called with true when a clip starts and false when the queue drains. The tail matters: the
  // speaker is still decaying and Deepgram is still holding a few hundred ms of buffered audio
  // when playback "ends", so unmuting instantly puts the last syllable back into the transcript.
  const gateMicForSpeech = (speaking: boolean) => {
    if (echoTimer.current) { clearTimeout(echoTimer.current); echoTimer.current = null; }
    if (speaking) { echoMute.current = true; applyMic(); return; }
    echoTimer.current = setTimeout(() => { echoMute.current = false; applyMic(); }, ECHO_TAIL_MS);
  };

  // The audio session category has to be settled before any AudioContext exists — changing it
  // afterwards aborts the process (see ../audio/session). So the mic permission is requested at
  // launch, not at the moment you tap Ramble.
  useEffect(() => {
    void initSession(async () => {
      try { return (await AudioManager.requestRecordingPermissions()) === "Granted"; }
      catch { return false; }
    });
  }, []);

  // ---- playback ----
  useEffect(() => {
    const p = new ClipPlayer(
      // The UI derives its speaking flag from speakingClip; this callback exists for the echo gate.
      (speaking) => gateMicForSpeech(speaking),
      (clip) => { setSpeakingClip(clip); setSpeakingTime(0); setPaused(false); if (clip === null) replaying.current = false; },
      (_clip, t) => setSpeakingTime(t),
    );
    p.setRate(rateRef.current);
    player.current = p;
    mic.current = new Mic(
      (pcm) => send({ t: "audio", sessionId: activeRef.current, pcm }),
      // The first call switches the audio session to a record-capable category, which is only
      // safe with no live audio graph — so the player's context goes down first.
      async () => {
        await player.current?.closeContext();
        await tone.current?.closeContext();
      },
    );
    tone.current = new ThinkingTone();
    return () => { player.current?.stop(); tone.current?.stop(); void mic.current?.stop(); };
  }, []);

  // Ambient "thinking" shimmer while the active session is working (opt-in). It stops before the
  // spoken reply starts, because `thinking` goes false at turn end.
  useEffect(() => {
    if (thinking[activeId] && thinkingSoundRef.current) tone.current?.start();
    else tone.current?.stop();
  }, [thinking, activeId, thinkingSound]);

  const setThinkingSound = useCallback((on: boolean) => {
    setThinkingSoundState(on); thinkingSoundRef.current = on;
    store.set(KEYS.thinkingSound, on ? "1" : "0");
    if (!on) tone.current?.stop();
  }, []);

  const setRate = useCallback((r: number) => {
    setRateState(r); rateRef.current = r;
    store.set(KEYS.rate, String(r));
    player.current?.setRate(r);
  }, []);

  const stopAudio = useCallback(() => {
    player.current?.stop();
    setPaused(false);
    replayQ.current = []; replayNext.current = 0; replayPlayed.current = 0; replaying.current = false;
    vadPending.current = false;
    if (vadResumeTimer.current) clearTimeout(vadResumeTimer.current);
  }, []);

  // ---- websocket ----
  const connect = useCallback(() => {
    const sock = new WebSocket(RELAY_WS);
    ws.current = sock;
    const clearTimers = () => {
      if (hbTimer.current) clearInterval(hbTimer.current);
      if (wdTimer.current) clearTimeout(wdTimer.current);
    };
    // Force-close after 25s of inbound silence. A cellular handoff (or the phone waking) can
    // leave a half-open socket that never fires `close`; the watchdog turns that into a
    // reconnect. This matters more on a phone than in a browser tab. Any frame re-arms it.
    const armWatchdog = () => {
      if (wdTimer.current) clearTimeout(wdTimer.current);
      wdTimer.current = setTimeout(() => { try { sock.close(); } catch { /* gone */ } }, 25000);
    };
    sock.onopen = () => {
      setConnected(true);
      retry.current = 0;
      send({ t: "hello", role: "client", since: lastSeq.current, token: tokenRef.current || "" });
      send({ t: "set_voice", voice: voiceRef.current });
      hbTimer.current = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "ping" }));
      }, 10000);
      armWatchdog();
    };
    sock.onerror = () => { /* onclose always follows; reconnect is handled there */ };
    sock.onclose = () => {
      setConnected(false);
      clearTimers();
      if (authFailed.current) return; // wrong code -> show the gate, don't reconnect-spam
      const delay = Math.min(1000 * 2 ** retry.current, RECONNECT_CAP_MS) + Math.random() * 500;
      retry.current++;
      setTimeout(connect, delay);
    };
    sock.onmessage = (e) => {
      armWatchdog();
      const m = JSON.parse(e.data as string);
      if (m.t === "pong") return;
      if (m.t === "unauthorized") { authFailed.current = true; setAuthError(true); try { sock.close(); } catch { /* gone */ } return; }
      if (typeof m.seq === "number") lastSeq.current = Math.max(lastSeq.current, m.seq);
      const sid: string = m.sessionId;
      const isActive = sid === activeRef.current;
      switch (m.t) {
        case "sessions": {
          const incoming: string[] = m.sessions.map((x: SessionInfo) => x.sessionId);
          const fresh = incoming.filter((id) => !knownIds.current.has(id));
          knownIds.current = new Set(incoming);
          setSessions(m.sessions);
          sessionsRef.current = m.sessions;
          setActiveId((cur) => {
            const saved = savedActive.current;
            if (!cur) {
              if (saved?.sid && incoming.includes(saved.sid)) { refocused.current = true; return saved.sid; }
              // On a cold start, focus a chat that actually has something in it. Auto-focusing
              // the first session put you on a blank screen with no way to tell what was open;
              // leaving it unfocused lands on the home picker instead.
              const withLines = incoming.find((id) => (convosRef.current[id]?.length ?? 0) > 0);
              return withLines || "";
            }
            // A restored tab reappears under a NEW sid — match by label and take focus back.
            if (!refocused.current && saved?.label) {
              const match = fresh.find((id) => m.sessions.find((x: SessionInfo) => x.sessionId === id)?.label === saved.label);
              if (match) { refocused.current = true; return match; }
            }
            return cur;
          });
          // Resume remembered tabs whose chat no longer exists (an agent restart dropped it).
          const tabs = store.getJSON<Record<string, TabInfo>>(KEYS.tabs, {});
          let changed = false;
          for (const [tsid, t] of Object.entries(tabs)) {
            if (incoming.includes(tsid) || restoredTabs.current.has(tsid)) continue;
            if (!incoming.length || !t.claudeSessionId) continue; // need a live route + a resume handle
            restoredTabs.current.add(tsid);
            send({ t: "new_session", sessionId: incoming[0], cwd: t.cwd, resumeId: t.claudeSessionId, label: t.label });
            delete tabs[tsid]; changed = true;
          }
          if (changed) store.setJSON(KEYS.tabs, tabs);
          if (wantNew.current && fresh.length) {
            wantNew.current = false;
            const id = fresh[fresh.length - 1];
            stopAudio();
            setActiveId(id);
            setUnread((p) => ({ ...p, [id]: false }));
            // Session ids (<dir>#<n>) get reused after an agent restart, so a brand-new chat can
            // collide with a stale persisted transcript. Clear it; a resumed chat's `history`
            // arrives right after and repopulates.
            setConvos((p) => ({ ...p, [id]: [] }));
          }
          break;
        }
        case "model": setSessions((p) => p.map((s) => s.sessionId === sid ? { ...s, model: normModel(m.model) } : s)); break;
        case "sessions_list": setSavedSessions(m.sessions || []); setProjects(m.projects || []); break;
        case "meta":
          setMetas((p) => ({ ...p, [sid]: { claudeSessionId: m.claudeSessionId, cwd: m.cwd } }));
          if (m.claudeSessionId) {
            const tabs = store.getJSON<Record<string, TabInfo>>(KEYS.tabs, {});
            const info = sessionsRef.current.find((x) => x.sessionId === sid);
            tabs[sid] = { claudeSessionId: m.claudeSessionId, cwd: m.cwd, label: info?.label || sid.split("#")[0] };
            store.setJSON(KEYS.tabs, tabs);
          }
          if (forkSend.current && forkSend.current.sid === sid) {
            const t = forkSend.current.text; forkSend.current = null;
            send({ t: "text", sessionId: sid, text: t });
          }
          break;
        case "words": setClipWords((p) => ({ ...p, [m.clip]: m.words })); break;
        case "prs": setPrs(m.prs || []); setPrsLoading(false); break;
        case "history": {
          const lines: Line[] = (m.messages || []).map((mm: { role: string; text: string }) =>
            ({ kind: mm.role === "user" ? "user" : "agent", text: mm.text, history: true }));
          // Only fill an EMPTY transcript. A resumed session's history is plain user/assistant
          // turns — it has no narrated `speech` lines and no clip keys, so applying it over a
          // transcript we already have replaces every spoken line with the raw reply and makes
          // past lines unplayable. That is what happened after an app restart: the persisted
          // transcript was clobbered by history arriving on reconnect.
          setConvos((p) => (p[sid]?.length ? p : { ...p, [sid]: lines }));
          break;
        }
        case "transcript":
          setInterim((p) => ({ ...p, [sid]: m.text }));
          if (vadPending.current && isActive && m.text?.trim()) {
            vadHadTranscript.current = true;
            if (vadResumeTimer.current) clearTimeout(vadResumeTimer.current);
          }
          break;
        case "utterance_discarded":
          setInterim((p) => ({ ...p, [sid]: "" }));
          if (isActive) {
            vadPending.current = false;
            if (vadResumeTimer.current) clearTimeout(vadResumeTimer.current);
            player.current?.resume();
          }
          break;
        case "user_echo":
          addLine(sid, { kind: "user", text: m.text });
          setInterim((p) => ({ ...p, [sid]: "" }));
          // A new turn supersedes whatever was still queued for an unfocused session. Without
          // this the held queue accumulates across every turn, and focusing the tab plays the
          // whole backlog from the top — which reads as "it randomly starts reading everything".
          if (sid !== activeRef.current) pending.current[sid] = [];
          break;
        case "agent_text": agentBuf.current[sid] = (agentBuf.current[sid] || "") + m.text; break;
        case "status": flushAgent(sid); addLine(sid, { kind: "status", text: m.text }); if (!isActive) setUnread((p) => ({ ...p, [sid]: true })); break;
        case "speech_text":
          if (m.readback) {
            // We asked for existing text to be read aloud. Attach the fresh clip to the line the
            // request came from — appending would duplicate text already on screen. The relay
            // synthesizes in the order we sent, so the queue lines up index for index.
            setConvos((p) => {
              const ls = p[sid] || [];
              const idx = readbackQ.current.shift();
              if (idx == null || !ls[idx]) return p;
              const copy = ls.slice();
              copy[idx] = { ...copy[idx], clip: m.clip, key: m.key };
              return { ...p, [sid]: copy };
            });
            break;
          }
          flushAgent(sid);
          addLine(sid, { kind: "speech", text: m.text, clip: m.clip, key: m.key });
          if (!isActive) setUnread((p) => ({ ...p, [sid]: true }));
          break;
        case "audio_chunk":
          if (isActive && replaying.current) break; // a continuous replay owns the player
          if (isActive) player.current?.pushChunk(m.clip, b64ToBytes(m.b64));
          else {
            const q = (pending.current[sid] ||= []);
            q.push({ c: m.clip, b: m.b64 });
            if (q.length > 400) q.shift();
            setUnread((p) => ({ ...p, [sid]: true }));
          }
          break;
        case "audio_end":
          if (isActive && replaying.current) break;
          if (isActive) player.current?.endClip(m.clip);
          else (pending.current[sid] ||= []).push({ c: m.clip, e: true });
          break;
        case "clip_audio": {
          // Store the fetched clip, then flush the queue's contiguous ready prefix in order, so
          // out-of-order fetch responses still play sequentially.
          replayAudio.current[m.key] = { b64: m.b64, words: m.words || [] };
          while (replayNext.current < replayQ.current.length) {
            const item = replayQ.current[replayNext.current];
            const got = replayAudio.current[item.key];
            if (!got) break;
            replayNext.current++;
            if (!got.b64) continue; // never persisted -> skip, keep going
            replayPlayed.current++;
            if (got.words.length) setClipWords((p) => ({ ...p, [item.clip]: got.words }));
            player.current?.pushChunk(item.clip, b64ToBytes(got.b64));
            player.current?.endClip(item.clip);
          }
          // The whole queue resolved and not one clip had audio. Say so: tapping a line and
          // getting silence with no explanation is indistinguishable from a broken app, and it
          // is the expected outcome for turns whose audio was never persisted (or has aged out).
          if (replayNext.current >= replayQ.current.length && replayQ.current.length && !replayPlayed.current) {
            replaying.current = false;
            addLine(sid || activeRef.current, { kind: "status", text: "no saved audio for that line — it can't be replayed" });
          }
          break;
        }
        case "stop_audio": if (isActive) stopAudio(); break;
        case "thinking": setThinking((p) => ({ ...p, [sid]: m.on })); if (!m.on) flushAgent(sid); break;
      }
    };
  }, [stopAudio]);

  // Boot: hydrate storage, take a token from the launch URL if there was one, then connect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await store.hydrate();
      if (cancelled) return;
      const launch = tokenFromUrl(await Linking.getInitialURL());
      if (launch) store.set(KEYS.token, launch);
      tokenRef.current = launch || store.get(KEYS.token) || "";
      const restored = store.getJSON<Record<string, Line[]>>(KEYS.convos, {});
      setConvos(restored);
      convosRef.current = restored; // set synchronously: a `sessions` broadcast can beat the state update
      // Storage hydrates asynchronously, so the relay's `sessions` broadcast can arrive before we
      // know which tab was focused last — the boot branch then sees no saved value and leaves you
      // on the home screen with your chat apparently gone. Re-apply it once we do know.
      const saved = store.getJSON<{ sid: string; label?: string } | null>(KEYS.active, null);
      savedActive.current = saved;
      if (saved?.sid) {
        setActiveId((cur) => {
          if (cur) return cur;
          if (sessionsRef.current.some((x) => x.sessionId === saved.sid)) { refocused.current = true; return saved.sid; }
          return cur;
        });
      }

      const ts = store.get(KEYS.thinkingSound) === "1";
      setThinkingSoundState(ts); thinkingSoundRef.current = ts;
      connect();
    })();
    return () => { cancelled = true; ws.current?.close(); };
  }, [connect]);

  // A link tapped while the app is already running (the clipboard-paste flow, second time on).
  useEffect(() => {
    const sub = Linking.addEventListener("url", ({ url }) => {
      const key = tokenFromUrl(url);
      if (key) submitCode(key);
    });
    return () => sub.remove();
    // submitCode is stable enough for this; re-subscribing on every render would leak listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitCode = useCallback((code: string) => {
    const c = code.trim(); if (!c) return;
    store.set(KEYS.token, c);
    tokenRef.current = c; authFailed.current = false; setAuthError(false); retry.current = 0;
    try { ws.current?.close(); } catch { /* gone */ }
    connect();
  }, [connect]);

  // Returning to the foreground is this app's "online" event: don't wait out the backoff after
  // the phone has been in a pocket, reconnect immediately.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") return;
      retry.current = 0;
      if (ws.current && ws.current.readyState === WebSocket.OPEN) return;
      try { ws.current?.close(); } catch { /* noop */ }
      connect();
    });
    return () => sub.remove();
  }, [connect]);

  const switchSession = useCallback((sid: string) => {
    refocused.current = true;
    if (ramblingRef.current) { send({ t: "ramble", sessionId: activeRef.current, on: false }); setRambling(false); ramblingRef.current = false; }
    stopAudio();
    setActiveId(sid);
    const held = pending.current[sid] || [];
    pending.current[sid] = [];
    // Only speak on arrival if there is genuinely an unheard answer waiting. Switching to a tab
    // you have already listened to should be silent — auto-playing on every switch made moving
    // between chats start a recital you did not ask for.
    setUnread((prev) => {
      if (prev[sid]) {
        for (const ev of held) {
          if (ev.e) player.current?.endClip(ev.c);
          else if (ev.b) player.current?.pushChunk(ev.c, b64ToBytes(ev.b));
        }
      }
      return { ...prev, [sid]: false };
    });
  }, [stopAudio]);

  // ---- mic ----
  const start = useCallback(async (ramble = false) => {
    setMicError("");
    // Call mode starts muted (tap to talk); rambling opens the mic immediately.
    setMuted(!ramble); mutedRef.current = !ramble;
    applyMic();
    const err = await mic.current?.start();
    if (err) { setMicError(err); return; }
    setLive(true);
    if (ramble) { rambleOwnsMic.current = true; setRambling(true); ramblingRef.current = true; send({ t: "ramble", sessionId: activeRef.current, on: true }); }
  }, []);

  const stop = useCallback(() => {
    if (ramblingRef.current) { send({ t: "ramble", sessionId: activeRef.current, on: false }); setRambling(false); ramblingRef.current = false; }
    void mic.current?.stop();
    setLive(false);
    setMuted(false); mutedRef.current = false;
    if (echoTimer.current) { clearTimeout(echoTimer.current); echoTimer.current = null; }
    echoMute.current = false;
  }, []);

  const toggleMute = useCallback(() => setMuted((m) => {
    mutedRef.current = !m;
    applyMic();
    return !m;
  }), []);

  const sendText = useCallback((text: string) => { send({ t: "text", sessionId: activeRef.current, text }); }, []);

  // Ramble/dictation: the relay accumulates speech across pauses instead of auto-committing;
  // toggling off flushes the whole buffer as one turn. Needs the mic open.
  const setRamble = useCallback((on: boolean, discard = false) => {
    setRambling(on); ramblingRef.current = on;
    setMuted(!on); mutedRef.current = !on;
    applyMic();
    if (discard) setInterim((p) => ({ ...p, [activeRef.current]: "" }));
    send({ t: "ramble", sessionId: activeRef.current, on, discard });
  }, []);
  const toggleRamble = useCallback(() => setRamble(!ramblingRef.current), [setRamble]);
  // Finish a ramble. If Ramble is what opened the mic (started from idle, the common path), this
  // closes it again and returns to the idle dock. Without that, sending a ramble dropped you into
  // an open call that kept listening — the mic stayed hot when you thought you had finished.
  // Started from inside a live call, it just ends the ramble and the call continues.
  // Takes no arguments on purpose: it is wired straight to onPress in places, and a `discard`
  // parameter there would receive the press event (truthy) and throw the buffer away. Cancelling
  // goes through cancelRamble instead.
  const endRamble = useCallback((discard = false as boolean) => {
    setRamble(false, discard === true);
    if (rambleOwnsMic.current) { rambleOwnsMic.current = false; stop(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setRamble]);
  // Bail out of a ramble without sending it. The relay drops its accumulated buffer instead of
  // delivering it as a turn — the escape hatch for saying something you didn't mean to send.
  const cancelRamble = useCallback(() => endRamble(true), [endRamble]);

  const forkChat = useCallback((userIndex: number, text: string) => {
    const sid = activeRef.current;
    forkSend.current = { sid, text };
    send({ t: "fork", sessionId: sid, userIndex, text });
    stopAudio();
    setConvos((p) => {
      const ls = p[sid] || [];
      let seen = 0, cut = ls.length;
      for (let i = 0; i < ls.length; i++) { if (ls[i].kind === "user") { if (seen === userIndex) { cut = i; break; } seen++; } }
      return { ...p, [sid]: ls.slice(0, cut) };
    });
    setThinking((p) => ({ ...p, [sid]: true }));
  }, [stopAudio]);

  // Tap a spoken line to replay it and every following spoken line to the end of the turn.
  const replayClip = useCallback((line: Line) => {
    if (line.clip == null) return;
    const ls = convos[activeRef.current] || [];
    const start = ls.findIndex((l) => l.kind === "speech" && l.clip === line.clip);
    if (start < 0) return;
    const queue = ls.slice(start)
      .filter((l) => l.kind === "speech" && l.key && l.clip != null)
      .map((l) => ({ key: l.key as string, clip: l.clip as number }));
    if (!queue.length) return;
    stopAudio();
    replaying.current = true;
    replayQ.current = queue; replayAudio.current = {}; replayNext.current = 0; replayPlayed.current = 0;
    for (const item of queue) send({ t: "get_clip", key: item.key });
  }, [convos, stopAudio]);

  const togglePlayback = useCallback(() => {
    const pl = player.current; if (!pl) return;
    if (pl.isPaused()) { pl.resume(); setPaused(false); return; }
    if (pl.isPlaying()) { pl.pause(); setPaused(true); return; }
    const ls = convos[activeRef.current] || [];
    for (let i = ls.length - 1; i >= 0; i--) { if (ls[i].kind === "speech" && ls[i].key) { replayClip(ls[i]); return; } }
  }, [convos, replayClip]);

  // Read a line aloud that was never narrated — a restored turn, or a raw reply — and continue
  // through every readable line after it. This is the "what was the last message again?" path on
  // the way out of the door: nothing is stored for these, so the relay synthesizes fresh.
  const readFrom = useCallback((lineIndex: number) => {
    const sid = activeRef.current;
    const ls = convos[sid] || [];
    const wanted: number[] = [];
    const texts: string[] = [];
    for (let i = lineIndex; i < ls.length && texts.length < 40; i++) {
      const l = ls[i];
      if (l.kind === "status") continue;             // progress chatter is not worth reading
      if (!l.text.trim()) continue;
      wanted.push(i); texts.push(l.text);
    }
    if (!texts.length) return;
    stopAudio();
    readbackQ.current = wanted;
    send({ t: "speak", sessionId: sid, texts });
  }, [convos, stopAudio]);

  const interruptNow = useCallback(() => { send({ t: "barge_in", sessionId: activeRef.current }); stopAudio(); }, [stopAudio]);

  const setModel = useCallback((m: string) => {
    setSessions((p) => p.map((s) => s.sessionId === activeRef.current ? { ...s, model: m } : s));
    send({ t: "set_model", sessionId: activeRef.current, model: m });
  }, []);

  const setVoice = useCallback((v: string) => {
    setVoiceState(v); voiceRef.current = v;
    store.set(KEYS.voice, v);
    send({ t: "set_voice", voice: v });
  }, []);

  const newSession = useCallback(() => { wantNew.current = true; send({ t: "new_session", sessionId: activeRef.current }); }, []);
  // Routed through *a* live session so the relay can reach the agent. Falls back to the first
  // known one, because the home screen asks for this list precisely when nothing is focused.
  const requestSessions = useCallback(() => {
    const sid = activeRef.current || sessionsRef.current[0]?.sessionId;
    if (sid) send({ t: "list_sessions", sessionId: sid });
  }, []);
  const requestPRs = useCallback((scope: "mine" | "all" = "mine") => {
    setPrs([]); setPrsLoading(true);
    send({ t: "list_prs", sessionId: activeRef.current, scope });
  }, []);
  const openSession = useCallback((id: string, cwd: string, label: string, engine = "claude") => {
    wantNew.current = true; send({ t: "new_session", sessionId: activeRef.current, cwd, resumeId: id, label, engine });
  }, []);
  const newInProject = useCallback((cwd: string, label: string, engine = "claude") => {
    wantNew.current = true; send({ t: "new_session", sessionId: activeRef.current, cwd, label, engine });
  }, []);

  const closeSession = useCallback((sid: string) => {
    send({ t: "close_session", sessionId: sid });
    // Deliberately closed -> forget it, or the restore logic resurrects it on the next boot.
    const tabs = store.getJSON<Record<string, TabInfo>>(KEYS.tabs, {});
    delete tabs[sid];
    store.setJSON(KEYS.tabs, tabs);
    knownIds.current.delete(sid);
    pending.current[sid] = [];
    setConvos((p) => { const n = { ...p }; delete n[sid]; return n; });
    setActiveId((cur) => {
      if (cur !== sid) return cur;
      stopAudio();
      const next = sessions.find((s) => s.sessionId !== sid);
      return next?.sessionId || "";
    });
  }, [sessions, stopAudio]);

  const clearChat = useCallback(() => {
    stopAudio();
    const sid = activeRef.current;
    setConvos((p) => ({ ...p, [sid]: [] }));
    setInterim((p) => ({ ...p, [sid]: "" }));
    pending.current[sid] = [];
    send({ t: "reset", sessionId: sid });
  }, [stopAudio]);

  const active = sessions.find((s) => s.sessionId === activeId);
  // Per-tab title = that chat's first user message, so same-repo chats stay distinguishable.
  const titles: Record<string, string> = {};
  for (const [sid, ls] of Object.entries(convos)) {
    const u = ls.find((l) => l.kind === "user");
    if (u) titles[sid] = u.text;
  }

  return {
    connected, live, sessions, activeId, switchSession, unread,
    lines: convos[activeId] || [], interim: interim[activeId] || "",
    thinking: !!thinking[activeId], model: active?.model || "sonnet",
    rate, setRate, start, stop, sendText, interruptNow, setModel, micError,
    voice, setVoice, clearChat, newSession, closeSession, muted, toggleMute, speakingClip,
    savedSessions, projects, requestSessions, openSession, newInProject, titles,
    speakingTime, clipWords, prs, prsLoading, requestPRs, replayClip,
    paused, togglePlayback, rambling, toggleRamble, endRamble, cancelRamble, forkChat, readFrom,
    authError, submitCode, metas, thinkingSound, setThinkingSound,
  };
}
