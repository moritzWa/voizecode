import { useCallback, useEffect, useRef, useState } from "react";
import { ClipPlayer, b64ToBytes } from "@/lib/clipPlayer";
import { ThinkingTone } from "@/lib/thinkingTone";

const RELAY_WS = process.env.NEXT_PUBLIC_RELAY_WS || "ws://localhost:8787";
const TOKEN_KEY = "voize:token";
// Access code: from ?key=… (saved to localStorage + stripped from the URL so it isn't bookmarked
// in the clear), else the stored value. Empty when none — fine for local dev (relay auth is off).
function resolveToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const url = new URL(window.location.href);
    const key = url.searchParams.get("key");
    if (key) { localStorage.setItem(TOKEN_KEY, key); url.searchParams.delete("key"); history.replaceState(null, "", url.toString()); return key; }
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch { return ""; }
}
const MIC_SR = 16000;
const LS_KEY = "voize:convos:v1";
// Max wait between reconnect attempts (it retries FOREVER; this only caps the interval).
// The `online` event triggers an immediate reconnect, so a longer outage still recovers fast.
const RECONNECT_CAP_MS = Number(process.env.NEXT_PUBLIC_RECONNECT_CAP_MS) || 15000;
const VOICE_KEY = "voize:voice";
const MICPREF_KEY = "voize:micPref"; // preferred mic by LABEL ("" = auto); labels survive deviceId churn
// When no explicit preference matches, fall back through these (substring match) before system default.
const DEFAULT_MIC_PRIORITY = ["Studio Display Microphone", "MacBook Pro Microphone"];
// Resolve the active input deviceId from a label preference + availability. "" = system default.
function resolveMic(mics: { id: string; label: string }[], pref: string): string {
  const find = (needle: string) => mics.find((m) => m.label.toLowerCase().includes(needle.toLowerCase()));
  if (pref) { const m = find(pref); if (m) return m.id; }
  for (const p of DEFAULT_MIC_PRIORITY) { const m = find(p); if (m) return m.id; }
  return "";
}
// OpenAI tts-1 voices (default TTS provider). Pick in the UI; the relay applies it.
export const VOICES = [
  { id: "alloy", label: "alloy — neutral" },
  { id: "echo", label: "echo — clear" },
  { id: "fable", label: "fable — expressive" },
  { id: "onyx", label: "onyx — deep" },
  { id: "nova", label: "nova — bright ♀" },
  { id: "shimmer", label: "shimmer — soft ♀" },
];

export type Line = { kind: "user" | "agent" | "status" | "speech"; text: string; clip?: number; key?: string };
export type SessionInfo = { sessionId: string; label: string; model: string };
export type SavedSession = { id: string; cwd: string; label: string; preview: string; mtime: number };
export type ProjectInfo = { cwd: string; label: string; count: number; mtime: number };
// One held audio event for an unfocused session: a chunk (b) or an end marker (e), for clip c.
type HeldEvent = { c: number; b?: string; e?: boolean };

const loadConvos = (): Record<string, Line[]> => {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
};
const normModel = (m: string) =>
  m.includes("haiku") ? "haiku" : m.includes("opus") ? "opus" : m.includes("sonnet") ? "sonnet" : m;

export function useVoize() {
  const [connected, setConnected] = useState(false);
  const [authError, setAuthError] = useState(false); // access code missing/wrong -> show the gate
  const tokenRef = useRef<string | null>(null);
  const authFailed = useRef(false);
  const [live, setLive] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState("");
  const [convos, setConvos] = useState<Record<string, Line[]>>(loadConvos);
  const [interim, setInterim] = useState<Record<string, string>>({});
  const [thinking, setThinking] = useState<Record<string, boolean>>({});
  const [unread, setUnread] = useState<Record<string, boolean>>({});
  const [rate, setRate] = useState(2.5);
  const [micError, setMicError] = useState("");
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [thinkingSound, setThinkingSoundState] = useState(true); // ambient "thinking" shimmer
  const thinkingSoundRef = useRef(true);
  const [paused, setPaused] = useState(false);                          // user paused playback (pause/play button)
  const [rambling, setRambling] = useState(false);                      // ramble/dictation: accumulate speech, send on stop
  const ramblingRef = useRef(false);
  const [speakingClip, setSpeakingClip] = useState<number | null>(null); // clip id currently being voiced
  const [speakingTime, setSpeakingTime] = useState(0);                   // playback time of the active clip (s)
  const [clipWords, setClipWords] = useState<Record<number, { text: string; start: number }[]>>({}); // per-clip word timings
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]); // past sessions (browser)
  const [projects, setProjects] = useState<ProjectInfo[]>([]);            // dirs that have sessions
  const [prs, setPrs] = useState<{ number: number; title: string; url: string; createdAt: string; isDraft: boolean; author?: string }[]>([]);
  const [metas, setMetas] = useState<Record<string, { claudeSessionId: string; cwd: string }>>({}); // debug info per chat
  const [voice, setVoiceState] = useState("alloy");
  const voiceRef = useRef(voice);
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [micPref, setMicPrefState] = useState(""); // preferred mic LABEL ("" = auto / priority list)
  const micPrefRef = useRef("");
  const [micId, setMicId] = useState("");          // active deviceId, derived from micPref + availability
  const micIdRef = useRef(micId);

  const ws = useRef<WebSocket | null>(null);
  const lastSeq = useRef(0);
  const hbTimer = useRef<ReturnType<typeof setInterval> | null>(null);  // heartbeat ping
  const wdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);   // silence watchdog
  const retry = useRef(0);                                              // backoff attempt count
  const wantNew = useRef(false);                                        // auto-focus the next new session
  const forkPending = useRef<string | null>(null);                      // edited text to send once a forked chat focuses
  const knownIds = useRef<Set<string>>(new Set());                      // sessions seen so far
  const activeRef = useRef(activeId);
  const rateRef = useRef(rate);
  const agentBuf = useRef<Record<string, string>>({});
  const ac = useRef<AudioContext | null>(null);
  const proc = useRef<ScriptProcessorNode | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const vad = useRef<{ destroy: () => void } | null>(null);
  const vadPending = useRef(false);                 // VAD ducked audio, awaiting transcript confirmation
  const vadHadTranscript = useRef(false);           // a real transcript arrived during this VAD onset
  const vadResumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const player = useRef<ClipPlayer | null>(null);
  const tone = useRef<ThinkingTone | null>(null);
  const pending = useRef<Record<string, HeldEvent[]>>({}); // audio held for unfocused sessions
  // Continuous replay: a click plays the clicked line and every following spoken line to the end
  // of the turn. We fetch all their clips, then push them to the player in order as the contiguous
  // prefix arrives (so out-of-order fetch responses still play sequentially).
  const replayQ = useRef<{ key: string; clip: number }[]>([]);
  const replayAudio = useRef<Record<string, { b64: string; words: { text: string; start: number }[] }>>({});
  const replayNext = useRef(0);

  useEffect(() => { activeRef.current = activeId; }, [activeId]);
  useEffect(() => { rateRef.current = rate; player.current?.setRate(rate); }, [rate]);
  useEffect(() => {
    const v = (typeof window !== "undefined" && localStorage.getItem(VOICE_KEY)) || "alloy";
    setVoiceState(v); voiceRef.current = v;
    const savedPref = (typeof window !== "undefined" && localStorage.getItem(MICPREF_KEY)) || "";
    setMicPrefState(savedPref); micPrefRef.current = savedPref;
    const ts = typeof window === "undefined" ? "1" : (localStorage.getItem("voize:thinkingSound") ?? "1");
    setThinkingSoundState(ts !== "0"); thinkingSoundRef.current = ts !== "0";
  }, []);

  // List audio-input devices (labels only populate after mic permission is granted once).
  const refreshMics = useCallback(async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      setMics(devs.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })));
    } catch { /* enumeration unsupported */ }
  }, []);
  useEffect(() => {
    refreshMics();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMics);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMics);
  }, [refreshMics]);
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(convos)); } catch { /* quota */ } }, [convos]);
  useEffect(() => { (window as unknown as { __voizePending?: unknown }).__voizePending = pending.current; }, []);

  const send = (m: unknown) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(m));
  const addLine = (sid: string, l: Line) =>
    setConvos((p) => ({ ...p, [sid]: [...(p[sid] || []).slice(-300), l] }));
  const flushAgent = (sid: string) => {
    const t = agentBuf.current[sid]?.trim();
    if (t) addLine(sid, { kind: "agent", text: t });
    agentBuf.current[sid] = "";
  };

  // ---- audio playback: streamed clips via MediaSource (active session only) ----
  const markSpeaking = (b: boolean) => { (window as unknown as { __voizeSpeaking?: boolean }).__voizeSpeaking = b; };
  useEffect(() => {
    const p = new ClipPlayer(
      markSpeaking,
      (clip) => { setSpeakingClip(clip); setSpeakingTime(0); setPaused(false); }, // new clip -> reset highlight + un-pause
      (_clip, t) => setSpeakingTime(t),                          // playback progress -> advance highlight
    );
    p.setRate(rateRef.current); // apply the initial speed (default 2x) before the first clip plays
    player.current = p;
    tone.current = new ThinkingTone();
    return () => { player.current?.stop(); tone.current?.stop(); };
  }, []);
  const stopAudio = useCallback(() => {
    player.current?.stop(); tone.current?.stop(); markSpeaking(false);
    setPaused(false);
    replayQ.current = []; replayNext.current = 0; // cancel any in-flight continuous replay
    vadPending.current = false;
    if (vadResumeTimer.current) clearTimeout(vadResumeTimer.current);
  }, []);

  // Ambient "thinking" tone while the active session is working (stops before the spoken reply).
  useEffect(() => {
    if (thinking[activeId] && thinkingSoundRef.current) tone.current?.start();
    else tone.current?.stop();
  }, [thinking, activeId, thinkingSound]);
  const setThinkingSound = useCallback((on: boolean) => {
    setThinkingSoundState(on); thinkingSoundRef.current = on;
    try { localStorage.setItem("voize:thinkingSound", on ? "1" : "0"); } catch { /* quota */ }
    if (!on) tone.current?.stop();
  }, []);

  // ---- websocket ----
  const connect = useCallback(() => {
    const sock = new WebSocket(RELAY_WS);
    ws.current = sock;
    const clearTimers = () => {
      if (hbTimer.current) clearInterval(hbTimer.current);
      if (wdTimer.current) clearTimeout(wdTimer.current);
    };
    // Force-close if no inbound traffic for 25s. A wifi->cellular handoff can leave a
    // half-open socket that never fires `close`; the watchdog turns that silence into a
    // reconnect. Any inbound frame (incl. pong) re-arms it.
    const armWatchdog = () => {
      if (wdTimer.current) clearTimeout(wdTimer.current);
      wdTimer.current = setTimeout(() => { try { sock.close(); } catch { /* already gone */ } }, 25000);
    };
    sock.onopen = () => {
      setConnected(true);
      retry.current = 0;
      if (tokenRef.current === null) tokenRef.current = resolveToken();
      send({ t: "hello", role: "client", since: lastSeq.current, token: tokenRef.current }); // replay anything missed
      send({ t: "set_voice", voice: voiceRef.current });            // re-apply chosen voice on (re)connect
      hbTimer.current = setInterval(() => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "ping" })); }, 10000);
      armWatchdog();
    };
    sock.onclose = () => {
      setConnected(false);
      clearTimers();
      if (authFailed.current) return; // wrong/missing access code -> don't reconnect-spam; show the gate
      const delay = Math.min(1000 * 2 ** retry.current, RECONNECT_CAP_MS) + Math.random() * 500; // backoff + jitter
      retry.current++;
      setTimeout(connect, delay);
    };
    sock.onmessage = (e) => {
      armWatchdog();
      const m = JSON.parse(e.data);
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
          setActiveId((cur) => cur || incoming[0] || "");
          if (wantNew.current && fresh.length) { // focus the chat we just created
            wantNew.current = false;
            const id = fresh[fresh.length - 1];
            stopAudio();
            setActiveId(id);
            setUnread((p) => ({ ...p, [id]: false }));
            // Session ids (<dir>#<n>) can be reused after an agent restart, so a brand-new chat
            // may collide with a stale persisted transcript. Clear it; a resumed/forked chat's
            // `history` message arrives right after and repopulates, so resumes are unaffected.
            setConvos((p) => ({ ...p, [id]: [] }));
            if (forkPending.current) { const t = forkPending.current; forkPending.current = null; send({ t: "text", sessionId: id, text: t }); }
          }
          break;
        }
        case "model": setSessions((p) => p.map((s) => s.sessionId === sid ? { ...s, model: normModel(m.model) } : s)); break;
        case "sessions_list": setSavedSessions(m.sessions || []); setProjects(m.projects || []); break;
        case "meta": setMetas((p) => ({ ...p, [sid]: { claudeSessionId: m.claudeSessionId, cwd: m.cwd } })); break;
        case "words": setClipWords((p) => ({ ...p, [m.clip]: m.words })); break;
        case "prs": setPrs(m.prs || []); break;
        case "history": { // resumed transcript -> fill the viewer
          const lines: Line[] = (m.messages || []).map((mm: { role: string; text: string }) =>
            ({ kind: mm.role === "user" ? "user" : "agent", text: mm.text }));
          setConvos((p) => ({ ...p, [sid]: lines }));
          break;
        }
        case "transcript":
          setInterim((p) => ({ ...p, [sid]: m.text }));
          // Mark that real words arrived (so onSpeechEnd treats this as speech, not noise).
          // Do NOT stop the agent yet — the relay decides if it's a real turn (-> stop_audio)
          // or a backchannel like "yeah" (-> utterance_discarded, and we resume).
          if (vadPending.current && isActive && m.text?.trim()) {
            vadHadTranscript.current = true;
            if (vadResumeTimer.current) clearTimeout(vadResumeTimer.current);
          }
          break;
        case "utterance_discarded": // backchannel/noise ignored -> clear interim + resume ducked audio
          setInterim((p) => ({ ...p, [sid]: "" }));
          if (isActive) { vadPending.current = false; if (vadResumeTimer.current) clearTimeout(vadResumeTimer.current); player.current?.resume(); }
          break;
        case "user_echo": addLine(sid, { kind: "user", text: m.text }); setInterim((p) => ({ ...p, [sid]: "" })); break;
        case "agent_text": agentBuf.current[sid] = (agentBuf.current[sid] || "") + m.text; break;
        case "status": flushAgent(sid); addLine(sid, { kind: "status", text: m.text }); if (!isActive) setUnread((p) => ({ ...p, [sid]: true })); break;
        case "speech_text": flushAgent(sid); addLine(sid, { kind: "speech", text: m.text, clip: m.clip, key: m.key }); if (!isActive) setUnread((p) => ({ ...p, [sid]: true })); break;
        case "audio_chunk":
          if (isActive) player.current?.pushChunk(m.clip, b64ToBytes(m.b64));
          else { // hold it: play when the user focuses this session
            const q = (pending.current[sid] ||= []);
            q.push({ c: m.clip, b: m.b64 });
            if (q.length > 400) q.shift();
            setUnread((p) => ({ ...p, [sid]: true }));
          }
          break;
        case "audio_end":
          if (isActive) player.current?.endClip(m.clip);
          else (pending.current[sid] ||= []).push({ c: m.clip, e: true });
          break;
        case "clip_audio": { // store the fetched clip, then flush the queue's contiguous ready prefix in order
          replayAudio.current[m.key] = { b64: m.b64, words: m.words || [] };
          while (replayNext.current < replayQ.current.length) {
            const item = replayQ.current[replayNext.current];
            const got = replayAudio.current[item.key];
            if (!got) break;                 // next clip not fetched yet -> wait
            replayNext.current++;
            if (!got.b64) continue;          // missing/un-persisted clip -> skip, keep going
            if (got.words.length) setClipWords((p) => ({ ...p, [item.clip]: got.words }));
            player.current?.pushChunk(item.clip, b64ToBytes(got.b64));
            player.current?.endClip(item.clip);
          }
          break;
        }
        case "stop_audio": if (isActive) stopAudio(); break;
        case "thinking": setThinking((p) => ({ ...p, [sid]: m.on })); if (!m.on) flushAgent(sid); break;
      }
    };
  }, [stopAudio]);
  useEffect(() => { connect(); return () => ws.current?.close(); }, [connect]);
  // Gate UI: user typed an access code -> save it and reconnect.
  const submitCode = useCallback((code: string) => {
    const c = code.trim(); if (!c) return;
    try { localStorage.setItem(TOKEN_KEY, c); } catch { /* quota */ }
    tokenRef.current = c; authFailed.current = false; setAuthError(false); retry.current = 0;
    try { ws.current?.close(); } catch { /* gone */ }
    connect();
  }, [connect]);

  // When the OS reports connectivity is back, don't wait for the next backoff tick —
  // drop any stale socket and reconnect immediately (handles long outages cleanly).
  useEffect(() => {
    const onOnline = () => {
      retry.current = 0;
      if (ws.current && ws.current.readyState === WebSocket.OPEN) return;
      try { ws.current?.close(); } catch { /* noop */ }
      connect();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [connect]);

  // switching tabs: stop current audio, clear unread, then play whatever this
  // session queued while it was unfocused.
  const switchSession = useCallback((sid: string) => {
    if (ramblingRef.current) { send({ t: "ramble", sessionId: activeRef.current, on: false }); setRambling(false); ramblingRef.current = false; }
    stopAudio();
    setActiveId(sid);
    setUnread((p) => ({ ...p, [sid]: false }));
    const held = pending.current[sid] || [];
    pending.current[sid] = [];
    for (const ev of held) {
      if (ev.e) player.current?.endClip(ev.c);
      else if (ev.b) player.current?.pushChunk(ev.c, b64ToBytes(ev.b));
    }
  }, [stopAudio]);

  // ---- mic capture + VAD barge-in ----
  const start = useCallback(async (ramble = false) => {
    setMicError("");
    setMuted(false); mutedRef.current = false; // fresh call starts unmuted
    let s: MediaStream;
    try {
      const audio: MediaTrackConstraints = { channelCount: 1, sampleRate: MIC_SR, echoCancellation: true, noiseSuppression: true };
      if (micIdRef.current) audio.deviceId = { exact: micIdRef.current }; // chosen mic (else system default)
      s = await navigator.mediaDevices.getUserMedia({ audio });
      refreshMics(); // labels are available now that permission is granted
    } catch (e) {
      // Most common: permission denied/dismissed, or no mic. Surface it instead of failing silently.
      const name = (e as DOMException)?.name;
      setMicError(
        name === "NotAllowedError" ? "Mic blocked — allow it via the address-bar icon, then Start call again."
        : name === "NotFoundError" ? "No microphone found."
        : `Mic error: ${(e as Error).message}`,
      );
      return;
    }
    stream.current = s;
    const ctx = new AudioContext({ sampleRate: MIC_SR });
    ac.current = ctx;
    const src = ctx.createMediaStreamSource(s);
    const node = ctx.createScriptProcessor(4096, 1, 1); // TODO v1: AudioWorklet
    proc.current = node;
    node.onaudioprocess = (ev) => {
      const f = ev.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(f.length); // muted -> leave as silence (zeros): blocks ambient talk,
      if (!mutedRef.current) {              // but keeps the stream alive so Deepgram finalizes your last words
        for (let i = 0; i < f.length; i++) { const x = Math.max(-1, Math.min(1, f[i])); pcm[i] = x < 0 ? x * 0x8000 : x * 0x7fff; }
      }
      let bin = ""; const b = new Uint8Array(pcm.buffer);
      for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
      send({ t: "audio", sessionId: activeRef.current, pcm: btoa(bin) });
    };
    src.connect(node); node.connect(ctx.destination);
    setLive(true);

    // Silero VAD, two-phase barge-in:
    //  - onSpeechStart: just PAUSE (duck) the agent's audio — don't interrupt yet.
    //  - a real Deepgram transcript (handled in the ws "transcript" case) CONFIRMS it:
    //    stop audio + interrupt claude.
    //  - onSpeechEnd with no transcript = it was noise -> RESUME where it left off.
    // Thresholds raised so transient noises (a bottle cap) don't trip onSpeechStart.
    try {
      const { MicVAD } = await import("@ricky0123/vad-web");
      vad.current = await MicVAD.new({
        baseAssetPath: "/", onnxWASMBasePath: "/", // assets served from client/public
        positiveSpeechThreshold: 0.7,  // need higher confidence (default 0.5)
        minSpeechMs: 200,              // require sustained speech, not a transient
        redemptionMs: 320,
        onSpeechStart: () => {
          if (mutedRef.current || !player.current?.isPlaying()) return;
          vadPending.current = true;
          vadHadTranscript.current = false;
          if (vadResumeTimer.current) clearTimeout(vadResumeTimer.current);
          player.current.pause(); // duck immediately, reversibly
        },
        onSpeechEnd: () => {
          if (!vadPending.current) return;
          // give Deepgram a beat to deliver a transcript; if none arrives it was noise -> resume
          if (vadResumeTimer.current) clearTimeout(vadResumeTimer.current);
          vadResumeTimer.current = setTimeout(() => {
            if (vadPending.current && !vadHadTranscript.current) { vadPending.current = false; player.current?.resume(); }
          }, 1000);
        },
      });
      (vad.current as unknown as { start: () => void }).start();
    } catch (e) { console.warn("VAD unavailable, barge-in disabled", e); }
    // Optionally begin the session already in ramble mode (start talking right away).
    if (ramble) { setRambling(true); ramblingRef.current = true; send({ t: "ramble", sessionId: activeRef.current, on: true }); }
  }, [stopAudio]);

  const stop = useCallback(() => {
    if (ramblingRef.current) { send({ t: "ramble", sessionId: activeRef.current, on: false }); setRambling(false); ramblingRef.current = false; }
    vad.current?.destroy(); vad.current = null;
    proc.current?.disconnect(); ac.current?.close();
    stream.current?.getTracks().forEach((t) => t.stop());
    setLive(false);
    setMuted(false); mutedRef.current = false;
  }, []);
  const toggleMute = useCallback(() => setMuted((m) => { mutedRef.current = !m; return !m; }), []);

  const sendText = useCallback((text: string) => { send({ t: "text", sessionId: activeRef.current, text }); }, []);
  // Ramble/dictation mode: tell the relay to accumulate speech across pauses (no auto-commit).
  // Toggling off flushes the whole buffer to the model as one turn. Needs the mic open.
  const setRamble = useCallback((on: boolean) => {
    setRambling(on); ramblingRef.current = on;
    if (on && mutedRef.current) { setMuted(false); mutedRef.current = false; }
    send({ t: "ramble", sessionId: activeRef.current, on });
  }, []);
  const toggleRamble = useCallback(() => setRamble(!ramblingRef.current), [setRamble]);
  // Fork (rewind-lite, Claude only): spawn a new chat resuming context truncated before the
  // userIndex-th user turn, then send the edited message into it once it focuses.
  const forkChat = useCallback((userIndex: number, text: string) => {
    wantNew.current = true;
    forkPending.current = text;
    send({ t: "fork", sessionId: activeRef.current, userIndex });
  }, []);
  // Replay from a spoken line onward: play the clicked line and every following spoken line to the
  // end of the turn, highlighting each in sequence (Speechify-style continuous read).
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
    replayQ.current = queue; replayAudio.current = {}; replayNext.current = 0;
    for (const item of queue) send({ t: "get_clip", key: item.key });
  }, [convos, stopAudio]);
  // Pause/play button: pause the current speech, resume it, or (if idle) replay the last spoken line.
  const togglePlayback = useCallback(() => {
    const pl = player.current; if (!pl) return;
    if (pl.isPaused()) { pl.resume(); setPaused(false); return; }
    if (pl.isPlaying()) { pl.pause(); setPaused(true); return; }
    const ls = convos[activeRef.current] || [];
    for (let i = ls.length - 1; i >= 0; i--) { if (ls[i].kind === "speech" && ls[i].key) { replayClip(ls[i]); return; } }
  }, [convos, replayClip]);
  const interruptNow = useCallback(() => { send({ t: "barge_in", sessionId: activeRef.current }); stopAudio(); }, [stopAudio]);
  const setModel = useCallback((m: string) => {
    setSessions((p) => p.map((s) => s.sessionId === activeRef.current ? { ...s, model: m } : s));
    send({ t: "set_model", sessionId: activeRef.current, model: m });
  }, []);
  const setVoice = useCallback((v: string) => {
    setVoiceState(v); voiceRef.current = v;
    try { localStorage.setItem(VOICE_KEY, v); } catch { /* quota */ }
    send({ t: "set_voice", voice: v });
  }, []);
  // Set the preferred mic by LABEL ("auto"/"" = priority list). Re-acquires capture if live.
  const setMicPref = useCallback((label: string) => {
    const pref = label === "auto" ? "" : label;
    setMicPrefState(pref); micPrefRef.current = pref;
    try { localStorage.setItem(MICPREF_KEY, pref); } catch { /* quota */ }
    const id = resolveMic(mics, pref);
    if (id !== micIdRef.current) {
      setMicId(id); micIdRef.current = id;
      if (live) { stop(); setTimeout(() => start(ramblingRef.current), 150); }
    }
  }, [mics, live, stop, start]);
  // Whenever the device list changes (permission granted, device plugged/unplugged), re-resolve
  // the active device from the preference + priority order; re-acquire if we're already live.
  useEffect(() => {
    const id = resolveMic(mics, micPrefRef.current);
    if (id !== micIdRef.current) {
      setMicId(id); micIdRef.current = id;
      if (live) { stop(); setTimeout(() => start(ramblingRef.current), 150); }
    }
  }, [mics, live, stop, start]);
  // New chat as a separate session/tab (the agent spawns a sibling claude); auto-focuses it.
  const newSession = useCallback(() => { wantNew.current = true; send({ t: "new_session", sessionId: activeRef.current }); }, []);
  // Session browser: fetch past sessions/projects, resume one, or start fresh in a project dir.
  const requestSessions = useCallback(() => send({ t: "list_sessions", sessionId: activeRef.current }), []);
  const requestPRs = useCallback((scope: "mine" | "all" = "mine") => { setPrs([]); send({ t: "list_prs", sessionId: activeRef.current, scope }); }, []);
  const openSession = useCallback((id: string, cwd: string, label: string, engine = "claude") => {
    wantNew.current = true; send({ t: "new_session", sessionId: activeRef.current, cwd, resumeId: id, label, engine });
  }, []);
  const newInProject = useCallback((cwd: string, label: string, engine = "claude") => {
    wantNew.current = true; send({ t: "new_session", sessionId: activeRef.current, cwd, label, engine });
  }, []);
  // Close a chat: kill its claude subprocess + drop the tab. Switches away if it was active.
  const closeSession = useCallback((sid: string) => {
    send({ t: "close_session", sessionId: sid });
    knownIds.current.delete(sid);
    pending.current[sid] = [];
    setConvos((p) => { const n = { ...p }; delete n[sid]; return n; });
    setActiveId((cur) => {
      if (cur !== sid) return cur;
      if (cur === activeRef.current) stopAudio();
      const next = sessions.find((s) => s.sessionId !== sid);
      return next?.sessionId || "";
    });
  }, [sessions, stopAudio]);
  // Reset: clear this session's transcript + fresh claude context (same tab).
  const clearChat = useCallback(() => {
    stopAudio();
    const sid = activeRef.current;
    setConvos((p) => ({ ...p, [sid]: [] }));
    setInterim((p) => ({ ...p, [sid]: "" }));
    pending.current[sid] = [];
    send({ t: "reset", sessionId: sid });
  }, [stopAudio]);

  const active = sessions.find((s) => s.sessionId === activeId);
  // Per-tab title = first user message of that chat (so same-dir chats are distinguishable).
  const titles: Record<string, string> = {};
  for (const [sid, ls] of Object.entries(convos)) {
    const u = ls.find((l) => l.kind === "user");
    if (u) titles[sid] = u.text;
  }
  // Copy debug info for the active chat (project, name, claude session uuid + how to find its transcript).
  const copyDebug = async () => {
    const sid = activeId;
    const meta = metas[sid];
    const sess = sessions.find((s) => s.sessionId === sid);
    const text = [
      "voizecode session",
      `project: ${meta?.cwd || sess?.label || "?"}`,
      `chat: ${sess?.label || sid}${titles[sid] ? " — " + titles[sid] : ""}`,
      `model: ${sess?.model || ""}`,
      meta?.claudeSessionId ? `claude session: ${meta.claudeSessionId}` : "claude session: (none yet — send a turn first)",
      meta?.claudeSessionId ? `transcript: find ~/.claude/projects -name ${meta.claudeSessionId}.jsonl` : "",
    ].filter(Boolean).join("\n");
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
    return text;
  };
  return {
    connected, live, sessions, activeId, switchSession, unread,
    lines: convos[activeId] || [], interim: interim[activeId] || "",
    thinking: !!thinking[activeId], model: active?.model || "sonnet",
    rate, setRate, start, stop, sendText, interruptNow, setModel, micError,
    voice, setVoice, clearChat, newSession, closeSession, mics, micPref, setMicPref, muted, toggleMute, speakingClip,
    savedSessions, projects, requestSessions, openSession, newInProject, titles, copyDebug,
    thinkingSound, setThinkingSound, speakingTime, clipWords, prs, requestPRs, replayClip,
    paused, togglePlayback, rambling, toggleRamble, forkChat,
    authError, submitCode,
  };
}
