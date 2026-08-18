// A stand-in relay that speaks just enough of the protocol to exercise the iOS app end to end
// without a laptop agent, an Apple Developer account, or a cent of Deepgram/ElevenLabs credit.
//
// Why not point the app at the real relay: the real one needs `voize` running on the laptop, real
// API keys, and it bills per utterance — none of which belong in a test that should be runnable
// on every change. What this cannot cover is anything Apple actually does (lock-screen audio,
// real mic routing); that still needs a physical device. See TODO.md.
//
//   node e2e/fake-relay.mjs [port]        # default 8788
//   EXPO_PUBLIC_RELAY_WS=ws://localhost:8788 npx expo start
//
// Speaks: hello/unauthorized, sessions, user_echo, thinking, status, speech_text, words,
// audio_chunk, audio_end. Any `text` turn gets a scripted spoken reply with real mp3 audio.
import { WebSocketServer } from "ws";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = Number(process.argv[2]) || 8788;
const TOKEN = process.env.FAKE_RELAY_TOKEN || "testcode";
const here = dirname(fileURLToPath(import.meta.url));

// A real mp3 makes the difference between testing the player and testing a mock. Drop any short
// mp3 at e2e/fixtures/clip.mp3 to exercise decoding; without it we still drive every code path
// except decodeAudioData, and the player's failure branch skips the clip rather than wedging.
const FIXTURE = join(here, "fixtures", "clip.mp3");
const CLIP_MP3 = existsSync(FIXTURE) ? readFileSync(FIXTURE) : null;
if (!CLIP_MP3) console.warn(`[fake-relay] no ${FIXTURE} — audio_chunk frames will be empty`);

const SESSIONS = [
  { sessionId: "voizecode#1", label: "voizecode", model: "sonnet" },
  { sessionId: "cronus#1", label: "cronus", model: "haiku" },
];

// The reply the agent "speaks" back. Split into clips the way the real narrator does: one spoken
// sentence per clip, each with its own word timings.
const REPLY = [
  "I found the likely bug in the auth handler.",
  "There are no tests covering it, so I will add one first.",
];

let seq = 0;
const next = () => ++seq;

const wss = new WebSocketServer({ port: PORT });
console.log(`[fake-relay] listening on ws://localhost:${PORT} (token: ${TOKEN})`);

wss.on("connection", (ws) => {
  let authed = false;
  const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

  ws.on("message", async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.t === "ping") return send({ t: "pong" });

    if (m.t === "hello") {
      // Mirrors the real gate: a bad code gets `unauthorized` and a closed socket, which is what
      // makes the app show its access screen instead of retrying forever.
      if (m.token !== TOKEN) {
        console.log(`[fake-relay] rejected client (token ${JSON.stringify(m.token)})`);
        send({ t: "unauthorized" });
        return ws.close();
      }
      authed = true;
      console.log("[fake-relay] client joined");
      send({ t: "sessions", sessions: SESSIONS });
      // AUTO_TURN drives a full turn without anyone tapping the screen, which is what makes an
      // unattended simulator run possible — typing into a TextInput needs a real tap.
      if (process.env.AUTO_TURN) {
        setTimeout(() => speak(send, SESSIONS[0].sessionId, "what's broken in auth?"), 1500);
      }
      return;
    }
    if (!authed) return;

    if (m.t === "text") return void speak(send, m.sessionId, m.text);

    if (m.t === "barge_in") {
      console.log("[fake-relay] barge-in");
      return send({ t: "stop_audio", sessionId: m.sessionId });
    }
    // `audio` frames arrive several times a second once the mic is live; log a heartbeat rather
    // than a line per frame, so the transcript of a test run stays readable.
    if (m.t === "audio") {
      audioFrames++;
      if (audioFrames % 25 === 1) console.log(`[fake-relay] mic frames: ${audioFrames}`);
      return;
    }
  });

  ws.on("close", () => console.log("[fake-relay] client left"));
});

let audioFrames = 0;
let clipId = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function speak(send, sessionId, text) {
  console.log(`[fake-relay] turn: ${JSON.stringify(text)}`);
  send({ t: "user_echo", sessionId, text, seq: next() });
  send({ t: "thinking", sessionId, on: true });
  await sleep(400);
  send({ t: "status", sessionId, text: "reading src/auth.ts", seq: next() });
  await sleep(600);

  for (const sentence of REPLY) {
    const clip = ++clipId;
    const key = `test-${clip}`;
    send({ t: "speech_text", sessionId, text: sentence, seq: next(), clip, key });

    // Word timings are what drive the highlight. Spacing them evenly is a lie the real
    // ElevenLabs timings don't tell, but it exercises exactly the same rendering path.
    const parts = sentence.split(" ");
    send({
      t: "words", sessionId, clip, seq: next(),
      words: parts.map((w, i) => ({ text: w, start: i * 0.28 })),
    });

    // Chunked the way the relay chunks: bounded frames, then an explicit end.
    if (CLIP_MP3) {
      const SIZE = 16 * 1024;
      for (let at = 0; at < CLIP_MP3.length; at += SIZE) {
        send({
          t: "audio_chunk", sessionId, clip, seq: next(),
          b64: CLIP_MP3.subarray(at, at + SIZE).toString("base64"),
          format: { encoding: "mp3", sampleRate: 24000 },
        });
        await sleep(30);
      }
    }
    send({ t: "audio_end", sessionId, clip, seq: next() });
    await sleep(900);
  }

  send({ t: "thinking", sessionId, on: false });
}
