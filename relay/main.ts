// voizecode relay (Deno). Hub between laptop CLIs ("agents") and one browser
// ("client"). Holds all API keys. Per-session: STT (Deepgram), narration
// (gpt-4.1-nano) + TTS (OpenAI), seq-buffered output for reconnect replay.
//
// Multi-session: each laptop registers a sessionId (repo name). The client
// addresses sessions by id and shows them as tabs; one is "active" for audio.

import { makeBlobStore } from "./storage.ts";

const PORT = Number(Deno.env.get("VOIZE_RELAY_PORT") ?? 8787);
const ENV_DEEPGRAM_KEY = Deno.env.get("DEEPGRAM_API_KEY") ?? "";
const ENV_OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const NARRATE_MODEL = Deno.env.get("VOIZE_NARRATE_MODEL") ?? "gpt-4.1-nano";
const TTS_SPEED = Number(Deno.env.get("VOIZE_SPEED") ?? 1.8);
const TTS_SR = 24000;
const ENV_EL_KEY = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
const EL_VOICE = Deno.env.get("VOIZE_EL_VOICE") ?? "EXAVITQu4vr4xnSDxMaL"; // Sarah (premade)
const EL_MODEL = Deno.env.get("VOIZE_EL_MODEL") ?? "eleven_flash_v2_5";
// TTS provider: elevenlabs (per-word timestamps -> Speechify highlight) when its key is set,
// else openai (streams mp3) , else deepgram. OpenAI is the fallback if the primary errors.
// Speed is applied client-side (playbackRate, pitch-preserved); timestamps are in media-time so it stays synced.
const TTS_PREF = Deno.env.get("VOIZE_TTS")?.toLowerCase() ?? "";
const TTS_VOICE = Deno.env.get("VOIZE_TTS_VOICE") ?? "aura-2-thalia-en";

// ---- bring-your-own-keys -------------------------------------------------------------------
// Keys are resolved per session, not per process. A laptop that sends its own keys at hello runs
// entirely on them; everyone else falls back to this relay's env keys (the hosted "just try it"
// path, billed to whoever runs the relay). It is deliberately all-or-nothing per session: mixing
// a user's ElevenLabs key with the host's OpenAI key would quietly put half the bill on the host.
interface Keys { dg: string; openai: string; el: string; elVoice: string; elModel: string; ttsVoice: string; byok: boolean }
const ENV_KEYS: Keys = {
  dg: ENV_DEEPGRAM_KEY, openai: ENV_OPENAI_KEY, el: ENV_EL_KEY,
  elVoice: EL_VOICE, elModel: EL_MODEL, ttsVoice: TTS_VOICE, byok: false,
};
function keysFromHello(k: Record<string, unknown> | undefined): Keys | null {
  if (!k || typeof k !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const dg = str(k.deepgram), openai = str(k.openai), el = str(k.elevenlabs);
  if (!dg && !openai && !el) return null; // nothing usable sent -> stay on the host's keys
  return {
    dg, openai, el,
    elVoice: str(k.elVoice) || EL_VOICE,
    elModel: str(k.elModel) || EL_MODEL,
    ttsVoice: str(k.ttsVoice) || TTS_VOICE,
    byok: true,
  };
}
// Which TTS backend this session gets. VOIZE_TTS pins it for the host; otherwise it follows
// whichever keys exist, preferring ElevenLabs because only it returns the word timings that drive
// the reading highlight.
function ttsProvider(k: Keys): string {
  if (TTS_PREF && !k.byok) return TTS_PREF;
  return k.el ? "elevenlabs" : k.openai ? "openai" : "deepgram";
}
const UTTER_GAP_MS = Number(Deno.env.get("VOIZE_UTTER_GAP_MS") ?? 2200);
// When an utterance ends on a word/punctuation that implies more is coming (you paused
// mid-thought), wait this much longer before committing — up to UTTER_MAX_EXT times — so the
// agent doesn't answer half a sentence. Resets the moment you keep talking.
const UTTER_INCOMPLETE_GAP_MS = Number(Deno.env.get("VOIZE_UTTER_INCOMPLETE_GAP_MS") ?? 1800);
const UTTER_MAX_EXT = Number(Deno.env.get("VOIZE_UTTER_MAX_EXT") ?? 3);
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
  utterExt?: number;       // how many times delivery was deferred because the utterance looked unfinished
  hold?: boolean;          // ramble/dictation mode: accumulate speech across pauses, commit only on explicit flush
  lastToolSpeakAt: number; // throttle spoken tool-call updates
  keys: Keys;              // BYOK: the agent's own provider keys, else the relay's env keys
}
const sessions = new Map<string, Session>();
let client: WebSocket | null = null;
// Persisted spoken clips (audio + word timings) for replay-on-click. Clip keys carry a
// per-process prefix so a relay restart (which resets the seq counter) can't make a new clip
// overwrite or collide with an old persisted one — old files stay replayable, new ones are fresh.
const clipStore = makeBlobStore();
const RUN_ID = crypto.randomUUID().slice(0, 8);
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
// Access gate: ON automatically when deployed, or when VOIZE_TOKEN/VOIZE_AUTH is set (pin a code,
// or force-enable for tests). OFF for plain local dev, so localhost keeps working with no code.
// The required token is pinned from VOIZE_TOKEN, else adopted from the first agent that connects
// (zero-config: the laptop generates + owns the code).
// "Deployed" is per-host and easy to get wrong: DENO_DEPLOYMENT_ID alone was the check while this
// lived on Deno Deploy, and Fly never sets it — so after the move the entire gate rested on the
// VOIZE_TOKEN secret happening to exist, with no warning if it didn't.
const PINNED_TOKEN = Deno.env.get("VOIZE_TOKEN") ?? "";
const DEPLOYED = !!Deno.env.get("DENO_DEPLOYMENT_ID") || !!Deno.env.get("FLY_APP_NAME");
const AUTH_ON = DEPLOYED || !!PINNED_TOKEN || Deno.env.get("VOIZE_AUTH") === "1";
// Fail closed. Deployed with no pinned code, the relay would adopt whichever agent connected
// first — so after any restart it's a race for who owns the relay, and the winner gets our
// Deepgram/OpenAI/ElevenLabs keys. Refuse to boot rather than serve that quietly.
if (DEPLOYED && !PINNED_TOKEN) {
  console.error("[relay] FATAL: deployed without VOIZE_TOKEN — refusing to start ungated.");
  console.error("[relay] fix: flyctl secrets set VOIZE_TOKEN=<code> -a voizecode-relay");
  Deno.exit(1);
}
let requiredToken: string = PINNED_TOKEN;
let narration: "narrate" | "final-only" | "silent" = "narrate";
// Selected TTS voice from the client. For ElevenLabs this is a voice ID (case-sensitive); for the
// OpenAI fallback we coerce to a valid OpenAI voice. Empty -> provider default.
// Voice is a *per-client* preference, not a global. It used to be one variable, so any client
// connecting (a second phone, a simulator, a browser tab) overwrote it for everyone — you would
// be mid-conversation in one voice and it would silently switch to whatever the other client had
// stored. Keyed by socket, with the env default as the fallback.
const DEFAULT_VOICE = Deno.env.get("VOIZE_VOICE") ?? "";
const voiceByClient = new WeakMap<WebSocket, string>();
const voiceFor = (sock: WebSocket | null) => (sock && voiceByClient.get(sock)) || DEFAULT_VOICE;
const OPENAI_VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);

function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) { s = { id, label: id, model: "?", agent: null, dg: null, dgQueue: [], utter: "", lastToolSpeakAt: 0, keys: ENV_KEYS }; sessions.set(id, s); }
  return s;
}

// ---- seq-numbered output buffer for client reconnect/replay ----
let seq = 0;
const ring: { seq: number; msg: unknown }[] = [];
const nextSeq = () => ++seq;

// ---- cross-isolate bridge ----
// Deno Deploy runs several isolates that do NOT share memory, and the agent's and the phone's
// WebSockets can land on different ones — each seeing "no sessions" from the other. BroadcastChannel
// spans isolates: each isolate announces its live agent sessions, and any message whose target
// socket isn't local is re-posted for whichever isolate holds it. The replay `ring` stays
// local-only — a client that hops isolates loses replay history but keeps all live traffic.
const ISOLATE_ID = crypto.randomUUID().slice(0, 8);
type SessionInfo = { sessionId: string; label: string; model: string };
const remoteSessions = new Map<string, { list: SessionInfo[]; at: number }>();
const REMOTE_TTL_MS = 30000; // an isolate that hasn't re-announced in this long is considered gone
const bc = typeof BroadcastChannel !== "undefined" && Deno.env.get("DENO_DEPLOYMENT_ID")
  ? new BroadcastChannel("voize-bridge") : null;
const bcPings: string[] = []; // /bc-ping diagnostics: pings received from OTHER isolates
const localSessionList = (): SessionInfo[] =>
  [...sessions.values()].filter((s) => s.agent).map((s) => ({ sessionId: s.id, label: s.label, model: s.model }));
const announce = () => bc?.postMessage({ k: "ann", iso: ISOLATE_ID, list: localSessionList() });
function remoteHasSession(sid: string): boolean {
  const now = Date.now();
  for (const r of remoteSessions.values()) if (now - r.at < REMOTE_TTL_MS && r.list.some((x) => x.sessionId === sid)) return true;
  return false;
}
function mergedSessionList(): SessionInfo[] {
  const list = localSessionList();
  const seen = new Set(list.map((s) => s.sessionId));
  const now = Date.now();
  for (const r of remoteSessions.values()) {
    if (now - r.at >= REMOTE_TTL_MS) continue;
    for (const s of r.list) if (!seen.has(s.sessionId)) { seen.add(s.sessionId); list.push(s); }
  }
  return list;
}
const sendSessionsToLocalClient = () =>
  client?.readyState === WebSocket.OPEN && client.send(JSON.stringify({ t: "sessions", sessions: mergedSessionList() }));
if (bc) {
  bc.onmessage = (e: MessageEvent) => {
    const m = e.data as Record<string, unknown>;
    switch (m.k) {
      case "who": announce(); break;
      case "ping": bcPings.push(`${m.iso}→${ISOLATE_ID}`); if (bcPings.length > 5) bcPings.shift(); break;
      case "ann": // another isolate's live sessions changed -> refresh our client's picker
        remoteSessions.set(m.iso as string, { list: m.list as SessionInfo[], at: Date.now() });
        sendSessionsToLocalClient();
        break;
      case "c2a": { // client input for an agent held by this isolate
        const s = sessions.get(m.sid as string);
        if (s?.agent?.readyState === WebSocket.OPEN) s.agent.send(JSON.stringify(m.m));
        break;
      }
      case "a2c": { // agent output for a client held by this isolate
        if (client?.readyState !== WebSocket.OPEN) break;
        const full = m.full as Record<string, unknown>;
        client.send(JSON.stringify(full));
        break;
      }
    }
  };
  bc.postMessage({ k: "who" }); // learn the other isolates' sessions on boot
  setInterval(announce, 10000); // heartbeat so REMOTE_TTL_MS can expire dead isolates
}

function toClient(sessionId: string, msg: Record<string, unknown>) {
  const full = { ...msg, sessionId };
  if ("seq" in full) { ring.push({ seq: full.seq as number, msg: full }); if (ring.length > 800) ring.shift(); }
  if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(full));
  else bc?.postMessage({ k: "a2c", full });
}
function toAgent(s: Session, msg: Record<string, unknown>) {
  if (s.agent?.readyState === WebSocket.OPEN) return s.agent.send(JSON.stringify(msg));
  bc?.postMessage({ k: "c2a", sid: s.id, m: msg });
}
function broadcastSessions() {
  announce(); // our list changed -> keep other isolates' pickers fresh too
  sendSessionsToLocalClient();
}

// ====================================================================
// STT: per-session Deepgram streaming socket
// ====================================================================
function openDeepgram(s: Session) {
  if (!s.keys.dg || s.dg) return;
  const url =
    "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1" +
    "&model=nova-2&interim_results=true&smart_format=true&endpointing=300&utterance_end_ms=1200";
  const dg = new WebSocket(url, ["token", s.keys.dg]);
  s.dg = dg;
  dg.onopen = () => { console.log(`[relay:${s.id}] deepgram connected`); flushDg(s); };
  dg.onmessage = (e) => {
    const m = JSON.parse(e.data);
    // Ignore Deepgram's UtteranceEnd (fires on a ~1.2s pause) — it splits a sentence when you
    // pause mid-thought. Delivery is driven solely by the UTTER_GAP_MS debounce below.
    if (m.type === "UtteranceEnd") return;
    const text = m.channel?.alternatives?.[0]?.transcript;
    if (!text) return;
    if (m.is_final) {
      s.utter += text + " ";
      s.utterExt = 0; // more speech arrived -> give a fresh full grace window before committing
      console.log(`[relay:${s.id}] stt final${s.hold ? " (ramble)" : ""}: "${text}" [buf ${s.utter.trim().length} chars]`);
      toClient(s.id, { t: "transcript", text: s.utter.trim(), final: false });
      clearTimeout(s.utterTimer);
      // Ramble mode: keep accumulating; never auto-commit — the user flushes explicitly.
      if (!s.hold) s.utterTimer = setTimeout(() => deliverUtterance(s), UTTER_GAP_MS);
    } else {
      toClient(s.id, { t: "transcript", text: (s.utter + text).trim(), final: false });
    }
  };
  dg.onclose = () => {
    // Keep the buffer if a ramble is in progress — Deepgram can drop on an inactivity gap and we
    // reopen on the next audio frame; wiping s.utter here would silently lose what was rambled.
    console.log(`[relay:${s.id}] deepgram closed${s.hold ? ` (ramble buffer kept: ${s.utter.trim().length} chars)` : ""}`);
    s.dg = null; clearTimeout(s.utterTimer);
    if (!s.hold) { s.utter = ""; s.utterExt = 0; }
  };
  dg.onerror = (e) => console.log(`[relay:${s.id}] deepgram error`, (e as ErrorEvent).message);
}
function flushDg(s: Session) { while (s.dgQueue.length && s.dg?.readyState === WebSocket.OPEN) s.dg.send(s.dgQueue.shift()!); }
function feedAudio(s: Session, pcmB64: string) {
  openDeepgram(s);
  const bytes = Uint8Array.from(atob(pcmB64), (c) => c.charCodeAt(0));
  if (s.dg?.readyState === WebSocket.OPEN) { flushDg(s); s.dg.send(bytes); }
  else s.dgQueue.push(bytes);
}
// Backchannel words that, on their own, are NOT a real turn — someone in the room saying
// "yeah" shouldn't hijack the agent. (See readme/research: ignore pure-backchannel utterances.)
const FILLERS = new Set(["yeah", "yep", "yes", "yup", "ok", "okay", "mm", "mhm", "mmhm", "uh", "um",
  "uhhuh", "huh", "hmm", "right", "sure", "cool", "nice", "oh", "ah", "no", "nope", "hi", "hey", "hello", "gotcha", "thanks"]);
const MIN_TURN_WORDS = Number(Deno.env.get("VOIZE_MIN_TURN_WORDS") ?? 2);
// A transcript counts as a real turn only if it's substantive: a phrase (>= MIN_TURN_WORDS),
// or a single non-filler word (e.g. "stop", "delete"). Pure backchannel / lone fillers are discarded.
function isSubstantive(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  if (words.every((w) => FILLERS.has(w))) return false;
  if (words.length < MIN_TURN_WORDS) return !FILLERS.has(words[0]);
  return true;
}

// Drop inline markdown markers so the spoken audio (and word timings) never include "star star"
// or backticks. Display keeps the original markdown; this only feeds TTS.
function stripMarkdown(t: string): string {
  return t
    .replace(/`([^`]+)`/g, "$1")        // `code`
    .replace(/\*\*([^*]+)\*\*/g, "$1")  // **bold**
    .replace(/__([^_]+)__/g, "$1")      // __bold__
    .replace(/\*([^*]+)\*/g, "$1")      // *italic*
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2"); // _italic_ (avoid snake_case identifiers)
}

// Trailing words/punctuation that signal the speaker isn't done (a mid-thought pause), so we
// should wait a bit longer rather than ship a half sentence to the agent.
const CONTINUATION = new Set([
  "a", "an", "the", "and", "or", "but", "so", "because", "as", "if", "while", "although", "since",
  "that", "which", "who", "whom", "whose",
  "to", "of", "in", "on", "at", "for", "with", "about", "from", "into", "than", "like", "over", "under", "between",
  "can", "could", "would", "should", "will", "shall", "may", "might", "must", "do", "does", "did",
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "am",
  "what", "how", "why", "when", "where", "whether", "i", "you", "we", "my", "your", "our", "their",
]);
function looksIncomplete(text: string): boolean {
  if (/[,:;-]$/.test(text.trim())) return true; // trailing comma/colon/dash = clearly mid-thought
  const last = text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").trim().split(/\s+/).pop();
  return !!last && CONTINUATION.has(last);
}

function deliverUtterance(s: Session) {
  clearTimeout(s.utterTimer);
  const text = s.utter.trim();
  if (!text) { s.utterExt = 0; return; }
  // Defer if it sounds unfinished (and we haven't already waited too long) — keep the text,
  // give the speaker more time to continue. If they do, the is_final handler resets the count.
  if (looksIncomplete(text) && (s.utterExt ?? 0) < UTTER_MAX_EXT) {
    s.utterExt = (s.utterExt ?? 0) + 1;
    s.utterTimer = setTimeout(() => deliverUtterance(s), UTTER_INCOMPLETE_GAP_MS);
    return;
  }
  s.utterExt = 0;
  s.utter = "";
  if (isSubstantive(text)) {
    deliverUserTurn(s, text);
  } else {
    // Not a real instruction (stray "yeah", noise that transcribed to a filler) -> drop it
    // and tell the client to resume the agent audio it ducked.
    console.log(`[relay:${s.id}] ignored backchannel: "${text}"`);
    toClient(s.id, { t: "utterance_discarded", sessionId: s.id });
  }
}
function deliverUserTurn(s: Session, text: string) {
  const agentUp = s.agent?.readyState === WebSocket.OPEN || remoteHasSession(s.id);
  console.log(`[relay:${s.id}] user: ${text}${agentUp ? "" : "  ⚠ NO AGENT CONNECTED — turn dropped, will appear stuck on 'working'"}`);
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
// `readback` = the client asked us to read text that already exists in its transcript (a
// restored turn, or a raw reply that was never narrated). Same synthesis path; the flag tells
// the client to attach the audio to the line it already has rather than appending a duplicate.
async function speak(s: Session, text: string, readback = false, to?: WebSocket) {
  // `to` pins every message of this utterance to one socket. Live narration broadcasts to the
  // active client (last-active-wins is intended there), but a readback was *requested* by a
  // specific client and must come back to it. Without this the reply raced the client slot: the
  // requester got the text and some other connected client got the audio.
  const out = to
    ? (m: Record<string, unknown>) => sendTo(to, { ...m, sessionId: s.id })
    : (m: Record<string, unknown>) => toClient(s.id, m);
  // Use the voice of the client that will actually hear this: the requester for a readback,
  // otherwise the active client.
  const ttsVoice = voiceFor(to ?? client);
  const K = s.keys;
  if (!text.trim() || narration === "silent") return;
  const clip = nextSeq();
  const key = `${RUN_ID}-${clip}`; // stable handle the client keeps for replay
  const spoken = stripMarkdown(text); // TTS + word timings use the clean text; display keeps the markdown
  out({ t: "speech_text", text, seq: nextSeq(), clip, key, readback }); // clip ties the bubble to its audio (for highlight)
  const fmt = { encoding: "mp3" as const, sampleRate: TTS_SR };
  let any = false;
  const parts: Uint8Array[] = [];          // collected audio bytes, persisted on completion
  let clipWords: { text: string; start: number }[] = []; // word timings (ElevenLabs only), persisted alongside
  // Emit in bounded slices: a whole-blob TTS response as one message would blow past the
  // cross-isolate bridge's payload cap (and MediaSource appends smaller chunks sooner anyway).
  const emit = (bytes: Uint8Array) => {
    for (let o = 0; o < bytes.length; o += 24576) {
      const part = bytes.subarray(o, Math.min(o + 24576, bytes.length));
      any = true; parts.push(part);
      out({ t: "audio_chunk", clip, b64: b64(part), seq: nextSeq(), format: fmt });
    }
  };

  const streamOpenAI = async () => {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${K.openai}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tts-1", voice: OPENAI_VOICES.has(ttsVoice) ? ttsVoice : "alloy", input: spoken, response_format: "mp3" }),
    });
    if (!r.ok || !r.body) throw new Error(`openai tts ${r.status}`);
    const reader = r.body.getReader();
    while (true) { const { value, done } = await reader.read(); if (done) break; if (value) emit(value); }
  };
  const wholeDeepgram = async () => {
    const r = await fetch(`https://api.deepgram.com/v1/speak?model=${K.ttsVoice}&encoding=mp3`, {
      method: "POST",
      headers: { Authorization: `Token ${K.dg}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: spoken }),
    });
    if (!r.ok) throw new Error(`deepgram tts ${r.status}`);
    emit(new Uint8Array(await r.arrayBuffer()));
  };
  // ElevenLabs with per-character timestamps -> derive word start times for Speechify-style highlight.
  const elevenLabs = async () => {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ttsVoice || K.elVoice}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": K.el, "Content-Type": "application/json" },
      body: JSON.stringify({ text: spoken, model_id: K.elModel }),
    });
    if (!r.ok) throw new Error(`elevenlabs tts ${r.status}`);
    const j = await r.json();
    if (j.audio_base64) emit(b64ToBytes(j.audio_base64 as string));
    clipWords = j.alignment ? wordsFromAlignment(j.alignment) : [];
    if (clipWords.length) out({ t: "words", clip, words: clipWords, seq: nextSeq() });
  };

  const provider = ttsProvider(K);
  const streamFirst = provider !== "deepgram" && provider !== "elevenlabs" && !!K.openai;
  try {
    if (provider === "elevenlabs" && K.el) await elevenLabs();
    else if (streamFirst) await streamOpenAI();
    else if (K.dg) await wholeDeepgram();
    else if (K.openai) await streamOpenAI();
  } catch (e) {
    console.log("[relay] tts failed, falling back:", (e as Error).message);
    try { if (K.openai) await streamOpenAI(); else if (K.dg) await wholeDeepgram(); }
    catch (e2) { console.log("[relay] tts fallback failed:", (e2 as Error).message); }
  }
  if (any) {
    out({ t: "audio_end", clip, seq: nextSeq() });
    persistClip(key, parts, text, clipWords); // fire-and-forget; failure just means no replay
  }
}

// Save a finished clip's audio + word timings so any client can replay it later by key.
async function persistClip(key: string, parts: Uint8Array[], text: string, words: { text: string; start: number }[]) {
  try {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const mp3 = new Uint8Array(total);
    let o = 0; for (const p of parts) { mp3.set(p, o); o += p.length; }
    await clipStore.put(`${key}.mp3`, mp3, "audio/mpeg");
    await clipStore.put(`${key}.json`, new TextEncoder().encode(JSON.stringify({ text, words })), "application/json");
  } catch (e) { console.log("[relay] clip persist failed", (e as Error).message); }
}

// Replay: read a persisted clip and send its audio + words to the client.
// Who asked for the last list, per session. `sessions_list` and `prs` are *responses*: sending
// them to the global client slot delivers them to whichever client happens to be active, so with
// a phone and a laptop connected the requester's picker stays empty. Third time this bit us —
// see also get_clip and readback audio.
const listAsker = new Map<string, WebSocket>();
const prsAsker = new Map<string, WebSocket>();
const replyTo = (askers: Map<string, WebSocket>, sid: string, m: Record<string, unknown>) => {
  const sock = askers.get(sid);
  if (sock && sock.readyState === WebSocket.OPEN) { sendTo(sock, { ...m, sessionId: sid }); askers.delete(sid); return; }
  toClient(sid, m); // no live asker (they reloaded) — fall back to the broadcast path
};

const sendTo = (sock: WebSocket, m: unknown) => {
  try { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m)); } catch { /* gone */ }
};

async function serveClip(key: string, to: WebSocket) {
  // Always reply (even with empty b64 when the clip isn't persisted) so a continuous replay
  // queue on the client can skip a missing clip instead of stalling on it.
  try {
    const mp3 = await clipStore.get(`${key}.mp3`);
    const metaRaw = mp3 ? await clipStore.get(`${key}.json`) : null;
    const meta = metaRaw ? JSON.parse(new TextDecoder().decode(metaRaw)) : { words: [] };
    sendTo(to, { t: "clip_audio", key, b64: mp3 ? b64(mp3) : "", words: meta.words ?? [], format: { encoding: "mp3", sampleRate: TTS_SR } });
    if (!mp3) console.log(`[relay] clip ${key} not in store (never persisted or aged out)`);
  } catch (e) {
    console.log("[relay] clip serve failed", (e as Error).message);
    sendTo(to, { t: "clip_audio", key, b64: "", words: [], format: { encoding: "mp3", sampleRate: TTS_SR } });
  }
}

// Group ElevenLabs per-character timestamps into word start times (media-time seconds).
function wordsFromAlignment(a: { characters?: string[]; character_start_times_seconds?: number[] }) {
  const chars = a.characters ?? [];
  const starts = a.character_start_times_seconds ?? [];
  const words: { text: string; start: number }[] = [];
  let cur = "", curStart = 0;
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) { if (cur) { words.push({ text: cur, start: curStart }); cur = ""; } }
    else { if (!cur) curStart = starts[i] ?? 0; cur += chars[i]; }
  }
  if (cur) words.push({ text: cur, start: curStart });
  return words;
}

const NARRATE_SYSTEM =
  "You adapt a coding agent's written reply for LISTENING, in the agent's own voice (first person, 'I'/'you'). " +
  "Stay FAITHFUL to the original: keep its wording, its order, and its section structure. This is NOT a summary — " +
  "do not condense, reword, or drop content that already reads fine aloud. Lightly adapt, don't rewrite. " +
  "ONLY change what genuinely doesn't work in speech:\n" +
  "- Tables: speak them as short natural sentences (e.g. 'X uses A, Y uses B') instead of reading cells.\n" +
  "- Code blocks: describe them in a sentence or two (name the key function/change), don't read code character by character.\n" +
  "- Long file paths / raw identifiers: use the short name (e.g. 'auth.ts' not the full path).\n" +
  "- File:line references like `foo.ts:216-232`: drop the line numbers entirely and name the place naturally " +
  "('in the write pipeline') — nobody can click or remember them when listening.\n" +
  "- Headings become a brief spoken lead-in; bullet lists become natural list phrasing — but keep their content and order.\n" +
  "Preserve all the actual information, explanations, and section flow. If the reply is already plain prose, output it " +
  "essentially as-is (just spoken-natural). " +
  "Light markdown is welcome for skimmability: **bold** key terms and the main takeaway, `backticks` for identifiers — " +
  "mirror any emphasis the original already had. " +
  "NEVER add information that is not in the original reply — no background, no elaboration, no examples of your own. " +
  "A short reply (even a single word) is spoken exactly as-is; expanding it is as wrong as dropping content. " +
  "Output ONLY the adapted content, starting directly with its first substantive sentence. NEVER refer to this task " +
  "or yourself as an adapter — no openers like 'Alright, here's the story', 'here's the spoken version', 'I'll tell it " +
  "as I'd say it aloud', no greetings, no meta-commentary, no filler. You are not telling anyone ABOUT the reply; you " +
  "ARE the reply.";

// Split a buffer into complete sentences. Terminators inside a `code` span or a **bold** span are
// ignored (so `email ?? ""` never breaks a clip, and a **bold heading.** isn't split mid-markup,
// which would leave an unbalanced `**` rendering literally on the client); a `.`/`!`/`?` is only a
// boundary when the next char is whitespace or end of buffer (keeps decimals like 3.14 intact).
function takeSentences(b: string): { done: string[]; rest: string } {
  const raw: string[] = [];
  let start = 0, tick = false, bold = false;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === "`") { tick = !tick; continue; }
    if (!tick && c === "*" && b[i + 1] === "*") { bold = !bold; i++; continue; } // toggle on each **
    if (!tick && c === "\n") { // newline = paragraph/bullet boundary — bullets carry no terminator,
      const chunk = b.slice(start, i).trim(); // so without this a whole list glues into one clip
      if (chunk) raw.push(chunk);
      start = i + 1;
      continue;
    }
    if (tick || bold || (c !== "." && c !== "!" && c !== "?")) continue;
    let j = i;
    while (j + 1 < b.length && ".!?".includes(b[j + 1])) j++; // consume "?!" / "..." runs
    const after = b[j + 1];
    if (after === undefined || after === " " || after === "\n" || after === "\t") {
      const chunk = b.slice(start, j + 1).trim();
      if (chunk) raw.push(chunk);
      start = j + 1;
    }
    i = j;
  }
  // A bare list marker ("2." / "-") is not a sentence — glue it onto the chunk that follows
  // (or onto the unfinished rest) instead of emitting an orphan "2." line/clip.
  const isMarker = (t: string) => /^(\d+[.)]|[-*•])$/.test(t);
  const done: string[] = [];
  let carry = "";
  for (let chunk of raw) {
    if (isMarker(chunk)) { carry = carry ? `${carry} ${chunk}` : chunk; continue; }
    // "Header: 1." — a list number glued to a colon header belongs to the NEXT chunk. (Only after
    // a colon: a real sentence like "use python 3." must stay intact.)
    const header = chunk.match(/^(.*:\**)\s+(\d+[.)])$/);
    if (header) { chunk = header[1]; carry = carry ? `${carry} ${header[2]}` : header[2]; done.push(chunk); continue; }
    done.push(carry ? `${carry} ${chunk}` : chunk);
    carry = "";
  }
  return { done, rest: (carry ? `${carry} ` : "") + b.slice(start) };
}

async function narrateFinal(s: Session, fullText: string) {
  toClient(s.id, { t: "thinking", on: false });
  if (!fullText) return;
  // Short prose needs no adaptation — and the nano narrator can't resist embellishing it
  // (a one-word reply came back as a multi-sentence lecture). Bypass it entirely unless the
  // reply is long or contains structure (code, tables, headings) that genuinely needs work.
  const needsAdaptation = fullText.length > 240 || /```|\n\|.*\||^#{1,3} |\n- |\n\d+\. /m.test(fullText);
  if (!s.keys.openai || !needsAdaptation) { await speak(s, fullText); return; }
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${s.keys.openai}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: NARRATE_MODEL, max_tokens: 1200, stream: true, // higher cap: faithful adaptation can be longer than a summary
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
    case "sessions_list": replyTo(listAsker, s.id, { t: "sessions_list", sessions: m.sessions, projects: m.projects }); break;
    case "history": toClient(s.id, { t: "history", messages: m.messages }); break;
    case "meta": toClient(s.id, { t: "meta", claudeSessionId: m.claudeSessionId, cwd: m.cwd }); break;
    case "prs": replyTo(prsAsker, s.id, { t: "prs", prs: m.prs }); break;
    case "exit":
      console.log(`[relay:${s.id}] agent exited`, m.code);
      // A dying claude (bad auth, crash) otherwise leaves the chat silently stuck on "working".
      if (m.code) toClient(s.id, { t: "status", text: `claude exited (code ${m.code}) — check the laptop; if your login expired, run claude /login`, seq: nextSeq() });
      break;
  }
}

function handleClient(m: Record<string, unknown>, from: WebSocket) {
  if (m.t === "hello") { replay(typeof m.since === "number" ? m.since : 0); broadcastSessions(); return; }
  if (m.t === "set_narration") { narration = m.mode as typeof narration; return; }
  if (m.t === "set_voice") { voiceByClient.set(from, String(m.voice)); console.log("[relay] voice ->", String(m.voice), "(this client only)"); return; }
  // Reply to the socket that ASKED, not to the global client slot. Only one client holds
  // that slot at a time, so with a phone and a laptop both connected a replay requested from
  // one was delivered to the other — the requester just got silence, which looked like
  // "tapping a line does nothing, sometimes".
  if (m.t === "get_clip") { void serveClip(String(m.key), from); return; }
  // Read existing transcript text aloud on demand. Turns restored from a resumed session were
  // never narrated, so they have no stored clip to replay — synthesizing here is the only way to
  // hear "what was the last message again?" on the way out of the door.
  if (m.t === "speak") {
    const sid2 = String(m.sessionId ?? "");
    const sess = sessions.get(sid2);
    const texts = Array.isArray(m.texts) ? (m.texts as unknown[]).map(String).filter((t) => t.trim()) : [];
    if (!sess || !texts.length) return;
    // Sequential on purpose: `speak` streams audio for one clip at a time, and the client plays
    // clips in arrival order — synthesizing in parallel would interleave the chunks.
    void (async () => { for (const t of texts.slice(0, 40)) await speak(sess, t, true, from); })();
    return;
  }
  // A session the local isolate doesn't hold may still live behind the bridge — create a local
  // shell for it (agent: null) so STT/turn delivery work here and toAgent() bridges the input.
  const sid = m.sessionId as string | undefined;
  const s = sid ? (sessions.get(sid) ?? (remoteHasSession(sid) ? getSession(sid) : undefined)) : undefined;
  if (!s) return;
  switch (m.t) {
    case "audio": feedAudio(s, m.pcm as string); break;
    case "text": deliverUserTurn(s, m.text as string); break;
    case "barge_in": toClient(s.id, { t: "stop_audio" }); toAgent(s, { t: "interrupt" }); break;
    case "set_model": toAgent(s, { t: "set_model", model: m.model }); break;
    case "reset": toClient(s.id, { t: "stop_audio" }); toAgent(s, { t: "reset" }); break;
    case "ramble": // hold mode on = accumulate without auto-commit; off = flush the buffer as one turn
      s.hold = !!m.on;
      clearTimeout(s.utterTimer);
      if (s.hold) { console.log(`[relay:${s.id}] ramble ON (accumulating)`); }
      else {
        const t = s.utter.trim(); s.utter = ""; s.utterExt = 0;
        // discard = the user changed their mind mid-ramble. Same teardown as a flush, minus the
        // delivery: without this the only way out of ramble mode is to send what you said, which
        // makes thinking out loud risky in exactly the mode meant for it.
        if (m.discard) {
          console.log(`[relay:${s.id}] ramble DISCARD -> dropped ${t.length} chars`);
          toClient(s.id, { t: "utterance_discarded", sessionId: s.id });
          break;
        }
        console.log(`[relay:${s.id}] ramble OFF -> flush ${t.length} chars: "${t.slice(0, 60)}${t.length > 60 ? "…" : ""}"`);
        if (t) deliverUserTurn(s, t);
        else console.log(`[relay:${s.id}] ramble flush had EMPTY buffer (nothing transcribed?)`);
      }
      break;
    case "new_session": toAgent(s, { t: "new_chat", cwd: m.cwd, resumeId: m.resumeId, label: m.label, engine: m.engine }); break;
    case "fork": toAgent(s, { t: "fork", userIndex: m.userIndex, text: m.text }); break;
    case "list_sessions": listAsker.set(s.id, from); toAgent(s, { t: "list_sessions" }); break;
    case "list_prs": prsAsker.set(s.id, from); toAgent(s, { t: "list_prs", scope: m.scope }); break;
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
// On Deno Deploy the platform assigns the port (Deno.serve with no port option); locally we bind PORT.
const onDeploy = !!Deno.env.get("DENO_DEPLOYMENT_ID");
Deno.serve(onDeploy ? {} : { port: PORT }, (req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    if (new URL(req.url).pathname === "/bc-ping") { bc?.postMessage({ k: "ping", iso: ISOLATE_ID }); return new Response(`pinged from ${ISOLATE_ID}`); }
    return new Response(`voizecode relay up (isolate=${ISOLATE_ID} bc=${!!bc} received=[${bcPings.join(" ")}] remotes=${remoteSessions.size})`);
  }
  // idleTimeout: Deno auto-pings and drops a socket with no traffic for this long —
  // backstop that reaps half-open sockets left by a network change. App-level
  // ping/pong (every 10s) keeps a live connection well under this window.
  const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 60 });
  let role: "agent" | "client" | null = null;
  let session: Session | null = null;
  socket.onmessage = (e) => {
    let m: Record<string, unknown>; try { m = JSON.parse(e.data); } catch { return; }
    // Re-assert the single client slot on ANY client activity (incl. the 10s heartbeat). Without
    // this, a transient extra client (a probe, a second tab) permanently displaces the real app:
    // its socket stays open and keeps getting pongs, so it never reconnects, but the relay routes
    // replies elsewhere. Reclaiming on each message means the live client always wins back the slot.
    if (role === "client" && client !== socket) { client = socket; }
    if (m.t === "ping") { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "pong" })); return; }
    if (m.t === "hello") {
      role = m.role as "agent" | "client";
      const tok = typeof m.token === "string" ? m.token : "";
      // Access gate (only when AUTH_ON — i.e. deployed, or VOIZE_TOKEN/VOIZE_AUTH set; off for local dev).
      // The relay adopts the first agent's token as the required code; clients must then match it.
      if (AUTH_ON) {
        if (role === "agent") {
          if (!requiredToken && tok) { requiredToken = tok; console.log("[relay] adopted access token from agent"); }
          if (!requiredToken || tok !== requiredToken) { try { socket.send(JSON.stringify({ t: "unauthorized" })); socket.close(); } catch { /* gone */ } return; }
        } else { // client
          if (!requiredToken || tok !== requiredToken) {
            console.log(`[relay] client rejected (${!requiredToken ? "no agent token yet" : "bad code"})`);
            try { socket.send(JSON.stringify({ t: "unauthorized" })); socket.close(); } catch { /* gone */ }
            return;
          }
        }
      }
      if (role === "agent") {
        session = getSession((m.sessionId as string) || "default");
        session.label = (m.label as string) || session.id;
        // Warn if a different live agent already owns this id — usually a duplicate dev stack
        // (two `npm run dev`), which silently steals turns from the original. Surfaced so it's
        // diagnosable instead of presenting as a stuck "working" with no reply.
        if (session.agent && session.agent !== socket && session.agent.readyState === WebSocket.OPEN) {
          console.log(`[relay] ⚠ agent ${session.id} REPLACED an existing live agent — duplicate stack? turns may have been lost`);
        }
        session.agent = socket;
        // BYOK: adopt this agent's keys for the session, or fall back to the host's. Re-read on
        // every hello so a reconnect after the user edits ~/.voizecode/keys.json picks the new
        // ones up, and so an agent that *stops* sending keys reverts rather than keeping stale
        // credentials alive in memory.
        session.keys = keysFromHello(m.keys as Record<string, unknown> | undefined) ?? ENV_KEYS;
        // A key change has to reach Deepgram too: the STT socket is opened with the key baked in.
        if (session.dg) { try { session.dg.close(); } catch { /* gone */ } session.dg = null; }
        console.log(`[relay] agent joined: ${session.id} (keys: ${session.keys.byok ? "own" : "host"})`);
        broadcastSessions();
      } else { client = socket; console.log("[relay] client joined"); }
    }
    if (role === "agent" && session) handleAgent(session, m);
    else if (role === "client") handleClient(m, socket);
  };
  socket.onclose = () => {
    if (role === "agent" && session?.agent === socket) { session.agent = null; session.dg?.close(); broadcastSessions(); }
    if (role === "client" && client === socket) client = null;
    console.log(`[relay] ${role} left${session ? " " + session.id : ""}`);
  };
  return response;
});
console.log(`[relay] listening on :${PORT}  (host keys: stt=${!!ENV_DEEPGRAM_KEY} tts=${ENV_DEEPGRAM_KEY || ENV_OPENAI_KEY || ENV_EL_KEY ? ttsProvider(ENV_KEYS) : "none"} narrate=${ENV_OPENAI_KEY ? NARRATE_MODEL : "off"}; agents may bring their own)`);
