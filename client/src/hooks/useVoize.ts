import { useCallback, useEffect, useRef, useState } from "react";
import { ClipPlayer, b64ToBytes } from "@/lib/clipPlayer";

const RELAY_WS = process.env.NEXT_PUBLIC_RELAY_WS || "ws://localhost:8787";
const MIC_SR = 16000;
const LS_KEY = "voize:convos:v1";
// Max wait between reconnect attempts (it retries FOREVER; this only caps the interval).
// The `online` event triggers an immediate reconnect, so a longer outage still recovers fast.
const RECONNECT_CAP_MS = Number(process.env.NEXT_PUBLIC_RECONNECT_CAP_MS) || 15000;

export type Line = { kind: "user" | "agent" | "status" | "speech"; text: string };
export type SessionInfo = { sessionId: string; label: string; model: string };
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
  const [rate, setRate] = useState(1.0);

  const ws = useRef<WebSocket | null>(null);
  const lastSeq = useRef(0);
  const hbTimer = useRef<ReturnType<typeof setInterval> | null>(null);  // heartbeat ping
  const wdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);   // silence watchdog
  const retry = useRef(0);                                              // backoff attempt count
  const activeRef = useRef(activeId);
  const rateRef = useRef(rate);
  const agentBuf = useRef<Record<string, string>>({});
  const ac = useRef<AudioContext | null>(null);
  const proc = useRef<ScriptProcessorNode | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const vad = useRef<{ destroy: () => void } | null>(null);
  const player = useRef<ClipPlayer | null>(null);
  const pending = useRef<Record<string, HeldEvent[]>>({}); // audio held for unfocused sessions

  useEffect(() => { activeRef.current = activeId; }, [activeId]);
  useEffect(() => { rateRef.current = rate; player.current?.setRate(rate); }, [rate]);
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
    player.current = new ClipPlayer(markSpeaking);
    return () => player.current?.stop();
  }, []);
  const stopAudio = useCallback(() => { player.current?.stop(); markSpeaking(false); }, []);

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
        case "sessions":
          setSessions(m.sessions);
          setActiveId((cur) => cur || m.sessions[0]?.sessionId || "");
          break;
        case "model": setSessions((p) => p.map((s) => s.sessionId === sid ? { ...s, model: normModel(m.model) } : s)); break;
        case "transcript": setInterim((p) => ({ ...p, [sid]: m.text })); break;
        case "user_echo": addLine(sid, { kind: "user", text: m.text }); setInterim((p) => ({ ...p, [sid]: "" })); break;
        case "agent_text": agentBuf.current[sid] = (agentBuf.current[sid] || "") + m.text; break;
        case "status": flushAgent(sid); addLine(sid, { kind: "status", text: m.text }); if (!isActive) setUnread((p) => ({ ...p, [sid]: true })); break;
        case "speech_text": flushAgent(sid); addLine(sid, { kind: "speech", text: m.text }); if (!isActive) setUnread((p) => ({ ...p, [sid]: true })); break;
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
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: MIC_SR, echoCancellation: true, noiseSuppression: true },
    });
    stream.current = s;
    const ctx = new AudioContext({ sampleRate: MIC_SR });
    ac.current = ctx;
    const src = ctx.createMediaStreamSource(s);
    const node = ctx.createScriptProcessor(4096, 1, 1); // TODO v1: AudioWorklet
    proc.current = node;
    node.onaudioprocess = (ev) => {
      const f = ev.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) { const x = Math.max(-1, Math.min(1, f[i])); pcm[i] = x < 0 ? x * 0x8000 : x * 0x7fff; }
      let bin = ""; const b = new Uint8Array(pcm.buffer);
      for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
      send({ t: "audio", sessionId: activeRef.current, pcm: btoa(bin) });
    };
    src.connect(node); node.connect(ctx.destination);
    setLive(true);

    // Silero VAD: real barge-in (talk over the agent -> stop audio + interrupt claude)
    try {
      const { MicVAD } = await import("@ricky0123/vad-web");
      vad.current = await MicVAD.new({
        baseAssetPath: "/", onnxWASMBasePath: "/", // assets served from client/public
        onSpeechStart: () => { if (player.current?.isPlaying()) { send({ t: "barge_in", sessionId: activeRef.current }); stopAudio(); } },
      });
      (vad.current as unknown as { start: () => void }).start();
    } catch (e) { console.warn("VAD unavailable, barge-in disabled", e); }
  }, [stopAudio]);

  const stop = useCallback(() => {
    vad.current?.destroy(); vad.current = null;
    proc.current?.disconnect(); ac.current?.close();
    stream.current?.getTracks().forEach((t) => t.stop());
    setLive(false);
  }, []);

  const sendText = useCallback((text: string) => { send({ t: "text", sessionId: activeRef.current, text }); }, []);
  const interruptNow = useCallback(() => { send({ t: "barge_in", sessionId: activeRef.current }); stopAudio(); }, [stopAudio]);
  const setModel = useCallback((m: string) => {
    setSessions((p) => p.map((s) => s.sessionId === activeRef.current ? { ...s, model: m } : s));
    send({ t: "set_model", sessionId: activeRef.current, model: m });
  }, []);

  const active = sessions.find((s) => s.sessionId === activeId);
  return {
    connected, live, sessions, activeId, switchSession, unread,
    lines: convos[activeId] || [], interim: interim[activeId] || "",
    thinking: !!thinking[activeId], model: active?.model || "sonnet",
    rate, setRate, start, stop, sendText, interruptNow, setModel,
  };
}
