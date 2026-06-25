# voizecode

**Talk to your codebase from anywhere.** Your repository, as a phone call.

Understand code while walking, review a PR while commuting, make a change away from your keyboard —
voizecode turns Claude Code (Codex next) into something that feels like a phone call with your repo.

The killer feature isn't voice *input*, it's voice *output*: instead of reading pages of agent logs,
a narrator continuously summarizes what it's doing — *"I found the likely bug… there are no tests for
it, so I'll add one first."* That's pair-programming, not terminal-watching.

### V1 workflows (what it's for)
- Explain this PR · Explain this file · Find where something happens · Make a simple change · Narrate progress

### Roadmap
- [x] Desktop: voice loop, narrator, multi-chat, cross-directory session browser, PR context, Electron app
- [x] Word-level (Speechify-style) highlighting synced to speech
- [ ] Mobile: pair the phone to the desktop via QR/token, voice in/out over the relay (desktop stays online)
- [ ] Playback controls by voice (pause / continue / slower / "explain that again")
- [ ] Selectable engines (Codex CLI alongside Claude) + faster narrator path
- [ ] One-command install + 30-second demo

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
npm run dev                   # starts relay + client + the laptop agent (all three)
```

Open http://localhost:3030 in Chrome, hit **Start call**, talk. The agent runs once and can
open/resume Claude Code sessions in any project via **+ New chat** — no need to launch it
per-repo. To use it from your phone on the same wifi, open `http://<laptop-LAN-IP>:3030` in Safari.

### `voize` command (start from anywhere)

`bin/voize` starts the services (if needed), opens a chat in the **current directory**, and opens
the web app. Add an alias: `alias voize="$HOME/CODE/voizecode/bin/voize"`, then run `voize` in any repo.

### Desktop app (Electron)

`npm run app` opens voizecode in its own window (own mic permission, droppable on any Space).
First time: `cd electron && npm install`. If Electron's binary extracts incompletely (a known
`@electron/get` issue with the framework symlinks), unzip the cached zip manually:
`unzip -o ~/Library/Caches/electron/*/electron-*.zip -d node_modules/electron/dist && printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt`.

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
