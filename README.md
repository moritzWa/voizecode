# voizecode

**Your codebase, hands-free.** Explore *and* change code by voice — from anywhere.

Understand code while walking, review a PR while commuting, ship a change away from your keyboard —
voizecode turns Claude Code or Codex into something that feels like a phone call with your repo.

The killer feature isn't voice *input*, it's voice *output*: instead of reading pages of agent logs,
a narrator continuously summarizes what it's doing — *"I found the likely bug… there are no tests for
it, so I'll add one first."* That's pair-programming, not terminal-watching.

### V1 workflows (what it's for)
- Explain this PR · Explain this file · Find where something happens · Make a simple change · Narrate progress

### Roadmap
- [x] Desktop: voice loop, narrator, multi-chat, cross-directory session browser, PR context, Electron app
- [x] Word-level (Speechify-style) highlighting synced to speech
- [x] Selectable engines: Codex CLI alongside Claude Code (pick per chat)
- [x] Mobile: phone talks to the laptop from anywhere (cellular) via the deployed relay + access-token URL
- [x] Click-to-replay with continuous read-through (clips persisted to R2, no re-synthesis)
- [ ] Playback controls by voice (pause / continue / slower / "explain that again")
- [ ] iOS lock-screen mode: keep audio + mic alive with the screen off (persistent `<audio>` + MediaSession)
- [ ] Faster narrator path
- [ ] One-command install + 30-second demo

## Architecture (3 tiers, relay in the middle)

```
   LAPTOP (yours)                             RELAY (Deno Deploy)                          CLIENT (browser/phone)
┌────────────────────────────┐        ┌────────────────────────────────┐        ┌──────────────────────────────┐
│  voizecode.mjs             │        │  STT      Deepgram streaming   │        │  Next.js web app             │
│                            │        │           + endpointing        │        │                              │
│  one claude/codex child    │        │                                │        │  mic 16k PCM + VAD           │
│  per chat (stream-json,    │◄──────►│  narrate  gpt-4.1-nano         │◄──────►│  audio @ 1–3x, barge-in      │
│  interrupt, fork, resume)  │ conn A │                                │ conn B │   (pitch-preserved)          │
│                            │  wss   │  TTS      ElevenLabs w/ word   │  wss   │  word-sync highlighting      │
│  caffeinate wrapper        │        │           timings → OpenAI     │        │  click-to-replay             │
│  (Mac stays awake)         │        │           fallback             │        │                              │
└────────────────────────────┘        │                                │        │  chat tabs; transcripts      │
                                      │  clips → R2 (replay w/o        │        │   in localStorage            │
                                      │           re-synthesis)        │        │  access key (?key=…)         │
                                      │                                │        └──────────────────────────────┘
                                      │  seq buffer + replay           │
                                      │  access gate (token)           │
                                      └────────────────────────────────┘
```

Two independent WebSocket connections, each with heartbeat + watchdog + backoff reconnect.
Phone drops → laptop keeps working, relay buffers, phone catches up via seq replay. The
relay can restart and both ends self-heal. (More robust than a single tunnel.)

## How it works

- You talk → Deepgram STT → a whole utterance goes straight to claude (no translator agent).
- claude streams text + tool calls. Tool calls → light spoken status ("editing auth.ts").
  End of turn → `gpt-4.1-nano` compresses the reply into 1-3 spoken sentences.
- **Streaming TTS:** ElevenLabs synthesizes with **per-word timestamps** (that's what drives the
  Speechify-style highlighting); OpenAI is the automatic fallback (no timings). The relay forwards
  byte chunks; the client appends them to a `MediaSource` so audio starts before a sentence
  finishes. Playback is through an `<audio>` element, so the speed slider (1–3x) stays
  **pitch-preserved**.
- **Clips & replay:** every spoken sentence is persisted (audio + word timings) to Cloudflare R2.
  Clicking a past line replays from there through the end of the turn — fetched, never re-synthesized,
  so replay costs no TTS credits. Lines from a *resumed* session's history were never spoken, have no
  clips, and aren't clickable.
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
npm run dev                   # starts relay + client + the laptop agent (all three)
```

Open http://localhost:3030 in Chrome, hit **Start call**, talk. The agent runs once and can
open/resume Claude Code sessions in any project via **+ New chat** — no need to launch it
per-repo. To use it from your phone on the same wifi, open `http://<laptop-LAN-IP>:3030` in Safari.

### `voize` command (production — phone from anywhere)

`bin/voize` is **production mode**: it starts the laptop agent against the *deployed* relay
(wrapped in `caffeinate` so the Mac won't sleep while it runs) and prints the phone URL with the
access key. Run it in any repo to open a chat there; run it again elsewhere to add a tab. Install:
`ln -s "$PWD/bin/voize" /opt/homebrew/bin/voize` (same for `voize-dev`).

To rotate the access key (e.g. after it appears in a screen recording):
`rm ~/.voizecode/token && pkill -f voizecode.mjs && voize`.

### `voize-dev` (local stack)

The old all-local flow: starts relay + client + agent on localhost (or the Electron desktop app
if its deps are installed). Use this for development.

### Desktop app (Electron)

`npm run app` opens voizecode in its own window (own mic permission, droppable on any Space).
First time: `cd electron && npm install`. If Electron's binary extracts incompletely (a known
`@electron/get` issue with the framework symlinks), unzip the cached zip manually:
`unzip -o ~/Library/Caches/electron/*/electron-*.zip -d node_modules/electron/dist && printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt`.

## Deploy

Both cloud tiers live on Deno Deploy (`relay/deno.json` / `client/deno.jsonc` name the apps):

```bash
cd relay  && deno deploy --prod    # wss://voizecode-relay.<org>.deno.net
cd client && deno deploy --prod    # https://voizecode-web.<org>.deno.net  (builds Next in the cloud)
```

Relay env (set with `deno deploy env add`): `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`,
`ELEVENLABS_API_KEY` (optional — presence selects ElevenLabs TTS), `CLIP_STORE=r2` + `R2_*` creds,
`VOIZE_TOKEN` (pins the access code). The client bakes `NEXT_PUBLIC_RELAY_WS` in at **build time**,
so it must be set in the web app's env before deploying.

The relay's plain-HTTP response (`curl` the relay URL) reports its isolate id — useful because of
the known multi-isolate caveat below.

## Tests

```bash
node test/e2e.mjs         # backend pipeline: STT → claude → narration → streaming TTS, multi-session, model switch
node test/browser.mjs     # real UI in headless Chromium (fake mic): tabs, persistence, barge-in, held audio
node test/durability.mjs  # heartbeat, replay-on-reconnect, full relay-restart self-heal
```

## Status / TODO

- `--dangerously-skip-permissions` is on (unattended) — run on repos you trust.
- Access gate: off for local dev; auto-on when deployed (Deno Deploy) or when `VOIZE_TOKEN` is set.
  The laptop agent generates a code (`~/.voizecode/token`) and prints a `?key=…` URL; the relay adopts it
  and the web app stores it in `localStorage`. `--dangerously-skip-permissions` makes this a must before exposing.
- **Known issue — Deno Deploy multi-isolate:** relay state (sessions, client slot) is in-memory and
  per-isolate; under churn (redeploys, reconnects) the agent and phone can land on *different*
  isolates and stop seeing each other ("no projects found", dropped turns). Recovery: restart the
  agent, reload the phone tab. Planned fix: BroadcastChannel bridge (verified available on the new
  Deno Deploy despite docs saying Classic-only).
- Lock-screen audio on iOS is buildable in a plain Safari tab (research verified: persistent
  `<audio>` element + silent-loop gap bridging + MediaSession; mic capture survives lock in Safari,
  no WebRTC needed — AudioContext needs an `interrupted`-state resume loop). Not yet implemented.
- Mic uses the deprecated ScriptProcessor; move to AudioWorklet.
