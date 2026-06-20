# voizecode

Talk to Claude Code on your laptop and hear it talk back — keep coding by voice while you walk away.

## Architecture (3 tiers, relay in the middle)

```
   LAPTOP (home)              RELAY (Deno, always-on)        CLIENT (browser/phone)
┌──────────────────┐       ┌─────────────────────┐       ┌────────────────────┐
│ voizecode.mjs    │       │  - STT  (Deepgram)  │       │  Next.js           │
│  spawns claude   │◄─────►│  - narrate (nano)   │◄─────►│  mic + audio@speed │
│  stream-json     │ conn A│  - TTS  (streamed)  │ conn B│  text + barge-in   │
│  + interrupt     │       │  - seq buffer/replay│       │  multi-session tabs│
└──────────────────┘       └─────────────────────┘       └────────────────────┘
```

Two independent WebSocket connections, each with heartbeat + watchdog + backoff reconnect.
Phone drops → laptop keeps working, relay buffers, phone catches up via seq replay. The
relay can restart and both ends self-heal. (More robust than a single tunnel.)

## How it works

- You talk → Deepgram STT → a whole utterance goes straight to claude (no translator agent).
- claude streams text + tool calls. Tool calls → light spoken status ("editing auth.ts").
  End of turn → `gpt-4.1-nano` compresses the reply into 1-3 spoken sentences.
- **Streaming TTS:** OpenAI streams mp3 as it's generated; the relay forwards byte chunks; the
  client appends them to a `MediaSource` so audio starts before a sentence finishes. Playback is
  through an `<audio>` element, so the speed slider (1–3x) stays **pitch-preserved**.
- **Barge-in:** talking over the agent (Silero VAD) stops audio AND interrupts claude mid-turn;
  your next utterance redirects the same session.
- **Multi-session:** run the laptop CLI in several repos → one tab each. The active tab gets the
  mic + audio; background sessions update silently and hold their audio until you focus them.
- **Persistence:** conversations are kept in `localStorage` (survive reload).
- **Model switch:** pick haiku / sonnet / opus per session from the dropdown.

## Setup

```bash
npm run setup                 # installs laptop + client deps (client postinstall copies VAD assets)
cp .env.example relay/.env    # add your API keys (DEEPGRAM_API_KEY, OPENAI_API_KEY)
```

API keys live only in `relay/.env` (gitignored). See `.env.example` for all options.

## Run (talk to your laptop in the browser)

```bash
npm run dev                   # starts relay + client
# in the repo you want claude to work on:
cd ~/some/project && node ~/CODE/voizecode/laptop/voizecode.mjs
```

Open http://localhost:3030, hit **Start call**, talk. To use it from your phone on the same
wifi, open `http://<laptop-LAN-IP>:3030` in Safari.

## Tests

```bash
node test/e2e.mjs         # backend pipeline: STT → claude → narration → streaming TTS, multi-session, model switch
node test/browser.mjs     # real UI in headless Chromium (fake mic): tabs, persistence, barge-in, held audio
node test/durability.mjs  # heartbeat, replay-on-reconnect, full relay-restart self-heal
```

## Status / TODO

- `--dangerously-skip-permissions` is on (unattended) — run on repos you trust.
- No auth on the relay yet (single user, localhost). Add a shared token before exposing it.
- For phone-on-cellular: deploy the relay (e.g. Deno Deploy) and point both ends at it.
- Lock-screen audio on iOS needs MediaSession + continuous playback (web app, future-mobile work).
- Mic uses the deprecated ScriptProcessor; move to AudioWorklet.
