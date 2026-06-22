// voizecode relay (Deno). Hub between laptop CLIs ("agents") and one browser
// ("client"). Holds all API keys. Per-session: STT (Deepgram), narration
// (gpt-4.1-nano) + TTS (OpenAI), seq-buffered output for reconnect replay.
//
// Multi-session: each laptop registers a sessionId (repo name). The client
// addresses sessions by id and shows them as tabs; one is "active" for audio.

const PORT = Number(Deno.env.get("VOIZE_RELAY_PORT") ?? 8787);
const DEEPGRAM_KEY = Deno.env.get("DEEPGRAM_API_KEY") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const NARRATE_MODEL = Deno.env.get("VOIZE_NARRATE_MODEL") ?? "gpt-4.1-nano";
const TTS_SPEED = Number(Deno.env.get("VOIZE_SPEED") ?? 1.8);
const TTS_SR = 24000;
// TTS provider: deepgram (Aura-2, ~75ms first-byte) by default, openai (tts-1) fallback.
// Speed is applied client-side (playbackRate slider), so neither needs a speed param here.
// Path A default: OpenAI streams mp3 progressively (low latency, MSE-friendly).
// VOIZE_TTS=deepgram falls back to a single whole-mp3 blob (no progressive streaming).
const TTS_PROVIDER = (Deno.env.get("VOIZE_TTS") ?? "openai").toLowerCase();
const TTS_VOICE = Deno.env.get("VOIZE_TTS_VOICE") ?? "aura-2-thalia-en";
const UTTER_GAP_MS = Number(Deno.env.get("VOIZE_UTTER_GAP_MS") ?? 2200);
// Spoken tool updates are throttled so a busy turn doesn't chatter — the first
// meaningful action each turn always speaks. Which tools are "meaningful" is decided
// by the laptop (it has the full command) and arrives as the `speak` flag.
const TOOL_SPEAK_THROTTLE_MS = Number(Deno.env.get("VOIZE_TOOL_SPEAK_THROTTLE_MS") ?? 6000);

interface Session {
  id: string;
  label: string;
  model: string;
  agent: WebSocket | null;
  dg: WebSocket | null;
  dgQueue: Uint8Array[];
  utter: string;
  utterTimer?: number;
  lastToolSpeakAt: number; // throttle spoken tool-call updates
}
const sessions = new Map<string, Session>();
let client: WebSocket | null = null;
let narration: "narrate" | "final-only" | "silent" = "narrate";
let ttsVoice = (Deno.env.get("VOIZE_VOICE") ?? "alloy").toLowerCase(); // OpenAI TTS voice, set from the client

function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) { s = { id, label: id, model: "?", agent: null, dg: null, dgQueue: [], utter: "", lastToolSpeakAt: 0 }; sessions.set(id, s); }
  return s;
}

// ---- seq-numbered output buffer for client reconnect/replay ----
let seq = 0;
const ring: { seq: number; msg: unknown }[] = [];
const nextSeq = () => ++seq;
function toClient(sessionId: string, msg: Record<string, unknown>) {
  const full = { ...msg, sessionId };
  if ("seq" in full) { ring.push({ seq: full.seq as number, msg: full }); if (ring.length > 800) ring.shift(); }
  if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(full));
}
const toAgent = (s: Session, msg: Record<string, unknown>) =>
  s.agent?.readyState === WebSocket.OPEN && s.agent.send(JSON.stringify(msg));
function broadcastSessions() {
  const list = [...sessions.values()].filter((s) => s.agent).map((s) => ({ sessionId: s.id, label: s.label, model: s.model }));
  if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify({ t: "sessions", sessions: list }));
}

// ====================================================================
// STT: per-session Deepgram streaming socket
// ====================================================================
function openDeepgram(s: Session) {
  if (!DEEPGRAM_KEY || s.dg) return;
  const url =
    "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1" +
    "&model=nova-2&interim_results=true&smart_format=true&endpointing=300&utterance_end_ms=1200";
  const dg = new WebSocket(url, ["token", DEEPGRAM_KEY]);
  s.dg = dg;
  dg.onopen = () => { console.log(`[relay:${s.id}] deepgram connected`); flushDg(s); };
  dg.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "UtteranceEnd") { deliverUtterance(s); return; }
    const text = m.channel?.alternatives?.[0]?.transcript;
    if (!text) return;
    if (m.is_final) {
      s.utter += text + " ";
      toClient(s.id, { t: "transcript", text: s.utter.trim(), final: false });
      clearTimeout(s.utterTimer);
      s.utterTimer = setTimeout(() => deliverUtterance(s), UTTER_GAP_MS);
    } else {
      toClient(s.id, { t: "transcript", text: (s.utter + text).trim(), final: false });
    }
  };
  dg.onclose = () => { s.dg = null; s.utter = ""; clearTimeout(s.utterTimer); };
  dg.onerror = (e) => console.log(`[relay:${s.id}] deepgram error`, (e as ErrorEvent).message);
}
function flushDg(s: Session) { while (s.dgQueue.length && s.dg?.readyState === WebSocket.OPEN) s.dg.send(s.dgQueue.shift()!); }
function feedAudio(s: Session, pcmB64: string) {
  openDeepgram(s);
  const bytes = Uint8Array.from(atob(pcmB64), (c) => c.charCodeAt(0));
  if (s.dg?.readyState === WebSocket.OPEN) { flushDg(s); s.dg.send(bytes); }
  else s.dgQueue.push(bytes);
}
function deliverUtterance(s: Session) {
  clearTimeout(s.utterTimer);
  if (s.utter.trim()) { deliverUserTurn(s, s.utter.trim()); s.utter = ""; }
}
function deliverUserTurn(s: Session, text: string) {
  console.log(`[relay:${s.id}] user:`, text);
  s.lastToolSpeakAt = 0; // let the first meaningful tool call this turn speak
  // A new turn supersedes whatever was in flight: interrupt claude + stop its audio first.
  // (Idempotent — a no-op if claude is idle.) Fixes a split/follow-up answering the stale turn.
  toAgent(s, { t: "interrupt" });
  toClient(s.id, { t: "stop_audio" });
  toClient(s.id, { t: "user_echo", text, seq: nextSeq() });
  toAgent(s, { t: "user_message", text });
  toClient(s.id, { t: "thinking", on: true });
}

// ====================================================================
// Narration + TTS
// ====================================================================
// base64 a byte chunk without spreading (spread blows the stack on large arrays).
function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// Speak one utterance: synthesize mp3 and stream the bytes to the client as ordered
// `audio_chunk`s under one `clip` id, finished by `audio_end`. OpenAI's audio/speech
// flushes mp3 progressively, so a long sentence starts playing before it's fully made.
// Deepgram returns a whole mp3 (no progressive body) -> sent as one chunk. Both are mp3,
// so the client plays via MediaSource and keeps pitch-preserved playbackRate.
async function speak(s: Session, text: string) {
  if (!text.trim() || narration === "silent") return;
  toClient(s.id, { t: "speech_text", text, seq: nextSeq() });
  const clip = nextSeq();
  const fmt = { encoding: "mp3" as const, sampleRate: TTS_SR };
  let any = false;
  const emit = (bytes: Uint8Array) => { if (bytes.length) { any = true; toClient(s.id, { t: "audio_chunk", clip, b64: b64(bytes), seq: nextSeq(), format: fmt }); } };

  const streamOpenAI = async () => {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tts-1", voice: ttsVoice, input: text, response_format: "mp3" }),
    });
    if (!r.ok || !r.body) throw new Error(`openai tts ${r.status}`);
    const reader = r.body.getReader();
    while (true) { const { value, done } = await reader.read(); if (done) break; if (value) emit(value); }
  };
  const wholeDeepgram = async () => {
    const r = await fetch(`https://api.deepgram.com/v1/speak?model=${TTS_VOICE}&encoding=mp3`, {
      method: "POST",
      headers: { Authorization: `Token ${DEEPGRAM_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(`deepgram tts ${r.status}`);
    emit(new Uint8Array(await r.arrayBuffer()));
  };

  // Path A default: stream mp3 from OpenAI (progressive). VOIZE_TTS=deepgram -> whole-blob.
  const streamFirst = TTS_PROVIDER !== "deepgram" && !!OPENAI_KEY;
  try {
    if (streamFirst) await streamOpenAI();
    else if (DEEPGRAM_KEY) await wholeDeepgram();
    else if (OPENAI_KEY) await streamOpenAI();
  } catch (e) {
    console.log("[relay] tts failed, trying fallback:", (e as Error).message);
    try { if (streamFirst && DEEPGRAM_KEY) await wholeDeepgram(); else if (OPENAI_KEY) await streamOpenAI(); }
    catch (e2) { console.log("[relay] tts fallback failed:", (e2 as Error).message); }
  }
  if (any) toClient(s.id, { t: "audio_end", clip, seq: nextSeq() });
}

const NARRATE_SYSTEM =
  "You are the voice of a coding agent, speaking to a developer who is LISTENING (not reading). " +
  "Convey the SUBSTANCE of the agent's reply below as natural spoken English, first person ('I', 'you'). " +
  "If it answers a question or explains something, actually SAY that information, condensed to the key points. " +
  "If it describes work done, say concretely what changed and any result. " +
  "Be concise but complete — usually 2 to 5 sentences; longer only if the answer truly needs it. " +
  "Never give meta filler like 'I checked the structure' or 'I have a good understanding' instead of the real content. " +
  "No code, no markdown, no file paths or raw file contents. Do not greet or address the agent.";

function takeSentences(b: string): { done: string[]; rest: string } {
  const done: string[] = [];
  const re = /[^.!?]*[.!?]+(\s|$)/g;
  let m: RegExpExecArray | null, last = 0;
  while ((m = re.exec(b))) { done.push(m[0].trim()); last = re.lastIndex; }
  return { done: done.filter(Boolean), rest: b.slice(last) };
}

async function narrateFinal(s: Session, fullText: string) {
  toClient(s.id, { t: "thinking", on: false });
  if (!fullText) return;
  if (!OPENAI_KEY) { await speak(s, fullText); return; }
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: NARRATE_MODEL, max_tokens: 400, stream: true,
        messages: [{ role: "system", content: NARRATE_SYSTEM }, { role: "user", content: fullText.slice(0, 6000) }],
      }),
    });
    if (!r.ok || !r.body) { console.log("[relay] narrate error", r.status); await speak(s, fullText); return; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let sse = "", spoken = "", any = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sse += dec.decode(value, { stream: true });
      let nl;
      while ((nl = sse.indexOf("\n")) >= 0) {
        const line = sse.slice(0, nl).trim(); sse = sse.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const tok = JSON.parse(data).choices?.[0]?.delta?.content;
        if (!tok) continue;
        spoken += tok;
        const { done: sentences, rest } = takeSentences(spoken);
        spoken = rest;
        for (const sent of sentences) { any = true; await speak(s, sent); }
      }
    }
    if (spoken.trim()) { any = true; await speak(s, spoken.trim()); }
    if (!any) await speak(s, fullText);
  } catch (e) { console.log("[relay] narrate failed", (e as Error).message); await speak(s, fullText); }
}

// ====================================================================
// Message handlers
// ====================================================================
function handleAgent(s: Session, m: Record<string, unknown>) {
  switch (m.t) {
    case "init":
      if (m.label) s.label = m.label as string;
      s.model = (m.model as string) ?? s.model;
      console.log(`[relay:${s.id}] model`, s.model);
      toClient(s.id, { t: "model", model: s.model });
      broadcastSessions();
      break;
    case "delta": toClient(s.id, { t: "agent_text", text: m.text as string, seq: nextSeq() }); break;
    case "tool_use": { // always show as a text line; speak only high-signal, throttled
      toClient(s.id, { t: "status", text: m.summary as string, seq: nextSeq() });
      const now = Date.now();
      if (narration === "narrate" && m.speak === true && now - s.lastToolSpeakAt > TOOL_SPEAK_THROTTLE_MS) {
        s.lastToolSpeakAt = now;
        speak(s, m.summary as string);
      }
      break;
    }
    case "turn_end": narrateFinal(s, (m.fullText as string) ?? ""); break;
    case "exit": console.log(`[relay:${s.id}] agent exited`, m.code); break;
  }
}

function handleClient(m: Record<string, unknown>) {
  if (m.t === "hello") { replay(typeof m.since === "number" ? m.since : 0); broadcastSessions(); return; }
  if (m.t === "set_narration") { narration = m.mode as typeof narration; return; }
  if (m.t === "set_voice") { ttsVoice = String(m.voice).toLowerCase(); console.log("[relay] voice ->", ttsVoice); return; }
  const s = m.sessionId ? sessions.get(m.sessionId as string) : undefined;
  if (!s) return;
  switch (m.t) {
    case "audio": feedAudio(s, m.pcm as string); break;
    case "text": deliverUserTurn(s, m.text as string); break;
    case "barge_in": toClient(s.id, { t: "stop_audio" }); toAgent(s, { t: "interrupt" }); break;
    case "set_model": toAgent(s, { t: "set_model", model: m.model }); break;
    case "reset": toClient(s.id, { t: "stop_audio" }); toAgent(s, { t: "reset" }); break;
    case "new_session": toAgent(s, { t: "new_chat" }); break; // agent spawns a sibling chat -> new tab
    case "close_session": // tell the agent to kill that chat, drop the session, remove the tab
      toAgent(s, { t: "close" });
      s.dg?.close();
      sessions.delete(s.id);
      broadcastSessions();
      break;
  }
}
function replay(since: number) {
  for (const e of ring) if (e.seq > since) client?.send(JSON.stringify(e.msg));
}

// ====================================================================
// WebSocket server
// ====================================================================
Deno.serve({ port: PORT }, (req) => {
  if (req.headers.get("upgrade") !== "websocket") return new Response("voizecode relay up");
  // idleTimeout: Deno auto-pings and drops a socket with no traffic for this long —
  // backstop that reaps half-open sockets left by a network change. App-level
  // ping/pong (every 10s) keeps a live connection well under this window.
  const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 60 });
  let role: "agent" | "client" | null = null;
  let session: Session | null = null;
  socket.onmessage = (e) => {
    let m: Record<string, unknown>; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "ping") { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "pong" })); return; }
    if (m.t === "hello") {
      role = m.role as "agent" | "client";
      if (role === "agent") {
        session = getSession((m.sessionId as string) || "default");
        session.label = (m.label as string) || session.id;
        session.agent = socket;
        console.log(`[relay] agent joined: ${session.id}`);
        broadcastSessions();
      } else { client = socket; console.log("[relay] client joined"); }
    }
    if (role === "agent" && session) handleAgent(session, m);
    else if (role === "client") handleClient(m);
  };
  socket.onclose = () => {
    if (role === "agent" && session?.agent === socket) { session.agent = null; session.dg?.close(); broadcastSessions(); }
    if (role === "client" && client === socket) client = null;
    console.log(`[relay] ${role} left${session ? " " + session.id : ""}`);
  };
  return response;
});
console.log(`[relay] listening on :${PORT}  (stt=${!!DEEPGRAM_KEY} tts=${TTS_PROVIDER}/${TTS_VOICE} narrate=${OPENAI_KEY ? NARRATE_MODEL : "off"})`);
