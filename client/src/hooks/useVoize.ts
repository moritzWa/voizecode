import { useCallback, useEffect, useRef, useState } from "react";
import { ClipPlayer, b64ToBytes } from "@/lib/clipPlayer";
import { ThinkingTone } from "@/lib/thinkingTone";

const RELAY_WS = process.env.NEXT_PUBLIC_RELAY_WS || "ws://localhost:8787";
const MIC_SR = 16000;
const LS_KEY = "voize:convos:v1";
// Max wait between reconnect attempts (it retries FOREVER; this only caps the interval).
// The `online` event triggers an immediate reconnect, so a longer outage still recovers fast.
const RECONNECT_CAP_MS = Number(process.env.NEXT_PUBLIC_RECONNECT_CAP_MS) || 15000;
const VOICE_KEY = "voize:voice";
const MIC_KEY = "voize:micId";
// OpenAI tts-1 voices (default TTS provider). Pick in the UI; the relay applies it.
export const VOICES = [
  { id: "alloy", label: "alloy — neutral" },
  { id: "echo", label: "echo — clear" },
  { id: "fable", label: "fable — expressive" },
  { id: "onyx", label: "onyx — deep" },
  { id: "nova", label: "nova — bright ♀" },
  { id: "shimmer", label: "shimmer — soft ♀" },
];

export type Line = { kind: "user" | "agent" | "status" | "speech"; text: string; clip?: number };
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
  const [speakingClip, setSpeakingClip] = useState<number | null>(null); // clip id currently being voiced
  const [speakingTime, setSpeakingTime] = useState(0);                   // playback time of the active clip (s)
  const [clipWords, setClipWords] = useState<Record<number, { text: string; start: number }[]>>({}); // per-clip word timings
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]); // past sessions (browser)
  const [projects, setProjects] = useState<ProjectInfo[]>([]);            // dirs that have sessions
  const [metas, setMetas] = useState<Record<string, { claudeSessionId: string; cwd: string }>>({}); // debug info per chat
  const [voice, setVoiceState] = useState("alloy");
  const voiceRef = useRef(voice);
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [micId, setMicId] = useState("");        // "" = system default
  const micIdRef = useRef(micId);

  const ws = useRef<WebSocket | null>(null);
  const lastSeq = useRef(0);
  const hbTimer = useRef<ReturnType<typeof setInterval> | null>(null);  // heartbeat ping
  const wdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);   // silence watchdog
  const retry = useRef(0);                                              // backoff attempt count
  const wantNew = useRef(false);                                        // auto-focus the next new session
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

  useEffect(() => { activeRef.current = activeId; }, [activeId]);
  useEffect(() => { rateRef.current = rate; player.current?.setRate(rate); }, [rate]);
  useEffect(() => {
    const v = (typeof window !== "undefined" && localStorage.getItem(VOICE_KEY)) || "alloy";
    setVoiceState(v); voiceRef.current = v;
    const savedMic = (typeof window !== "undefined" && localStorage.getItem(MIC_KEY)) || "";
    setMicId(savedMic); micIdRef.current = savedMic;
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
      (clip) => { setSpeakingClip(clip); setSpeakingTime(0); }, // new clip -> reset word highlight
      (_clip, t) => setSpeakingTime(t),                          // playback progress -> advance highlight
    );
    p.setRate(rateRef.current); // apply the initial speed (default 2x) before the first clip plays
    player.current = p;
    tone.current = new ThinkingTone();
    return () => { player.current?.stop(); tone.current?.stop(); };
  }, []);
  const stopAudio = useCallback(() => {
    player.current?.stop(); tone.current?.stop(); markSpeaking(false);
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
      send({ t: "hello", role: "client", since: lastSeq.current }); // replay anything missed
      send({ t: "set_voice", voice: voiceRef.current });            // re-apply chosen voice on (re)connect
      hbTimer.current = setInterval(() => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: "ping" })); }, 10000);
      armWatchdog();
    };
    sock.onclose = () => {
      setConnected(false);
      clearTimers();
      const delay = Math.min(1000 * 2 ** retry.current, RECONNECT_CAP_MS) + Math.random() * 500; // backoff + jitter
      retry.current++;
      setTimeout(connect, delay);
    };
    sock.onmessage = (e) => {
      armWatchdog();
      const m = JSON.parse(e.data);
      if (m.t === "pong") return;
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
          }
          break;
        }
        case "model": setSessions((p) => p.map((s) => s.sessionId === sid ? { ...s, model: normModel(m.model) } : s)); break;
        case "sessions_list": setSavedSessions(m.sessions || []); setProjects(m.projects || []); break;
        case "meta": setMetas((p) => ({ ...p, [sid]: { claudeSessionId: m.claudeSessionId, cwd: m.cwd } })); break;
        case "words": setClipWords((p) => ({ ...p, [m.clip]: m.words })); break;
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
        case "speech_text": flushAgent(sid); addLine(sid, { kind: "speech", text: m.text, clip: m.clip }); if (!isActive) setUnread((p) => ({ ...p, [sid]: true })); break;
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
        case "stop_audio": if (isActive) stopAudio(); break;
        case "thinking": setThinking((p) => ({ ...p, [sid]: m.on })); if (!m.on) flushAgent(sid); break;
      }
    };
  }, [stopAudio]);
  useEffect(() => { connect(); return () => ws.current?.close(); }, [connect]);

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
  const start = useCallback(async () => {
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
  }, [stopAudio]);

  const stop = useCallback(() => {
    vad.current?.destroy(); vad.current = null;
    proc.current?.disconnect(); ac.current?.close();
    stream.current?.getTracks().forEach((t) => t.stop());
    setLive(false);
    setMuted(false); mutedRef.current = false;
  }, []);
  const toggleMute = useCallback(() => setMuted((m) => { mutedRef.current = !m; return !m; }), []);

  const sendText = useCallback((text: string) => { send({ t: "text", sessionId: activeRef.current, text }); }, []);
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
  const setMic = useCallback((id: string) => {
    setMicId(id); micIdRef.current = id;
    try { localStorage.setItem(MIC_KEY, id); } catch { /* quota */ }
    if (live) { stop(); setTimeout(() => start(), 150); } // re-acquire capture on the new device
  }, [live, stop, start]);
  // New chat as a separate session/tab (the agent spawns a sibling claude); auto-focuses it.
  const newSession = useCallback(() => { wantNew.current = true; send({ t: "new_session", sessionId: activeRef.current }); }, []);
  // Session browser: fetch past sessions/projects, resume one, or start fresh in a project dir.
  const requestSessions = useCallback(() => send({ t: "list_sessions", sessionId: activeRef.current }), []);
  const openSession = useCallback((id: string, cwd: string, label: string) => {
    wantNew.current = true; send({ t: "new_session", sessionId: activeRef.current, cwd, resumeId: id, label });
  }, []);
  const newInProject = useCallback((cwd: string, label: string) => {
    wantNew.current = true; send({ t: "new_session", sessionId: activeRef.current, cwd, label });
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
    voice, setVoice, clearChat, newSession, closeSession, mics, micId, setMic, muted, toggleMute, speakingClip,
    savedSessions, projects, requestSessions, openSession, newInProject, titles, copyDebug,
    thinkingSound, setThinkingSound, speakingTime, clipWords,
  };
}
