# iOS app — handoff

Context for the agent building the voizecode iOS app. Written 2026-08-02 at the end of the
infra/demo-polish session; read alongside `README.md` (architecture + deploy are current there).

## Goal

Native iOS app that does what the web client (`client/`) does, plus the one thing the web
fundamentally can't: **keep audio AND mic alive with the screen locked / phone pocketed**.
That's the whole reason to go native — treat it as the acceptance test.

## The one decision that matters first

"Just wrap the web app in a WebView" does NOT work for the lock-screen goal — it's *worse* than
Safari: WKWebView-hosted pages get their mic **muted in background** (Safari itself has the
`UIBackgroundModes audio` entitlement; wrapped WebViews don't inherit the behavior — WebKit
bug 226620, still true in 2026). A wrapper buys an icon, nothing else. Two real options:

- **Expo / React Native port (recommended, researched):** ~3-4 focused days. UI + protocol port
  is easy (see "what's reusable"); the work is the audio pipeline.
- **Capacitor/WebView wrapper:** only worth it as a stopgap icon; don't expect background gains.

## Researched stack (mid-2026 state, verified via Expo docs + community)

- **Expo with a development build** (not Expo Go). Config plugins cover everything; no Xcode GUI.
- **Playback** (MediaSource replacement): `react-native-audio-api` (Software Mansion) — Web
  Audio-compatible, has a **buffer-queue source node** for streamed mp3 chunks + `playbackRate`.
  Simpler alternative: `expo-audio-studio` (formerly `@siteed/expo-audio-stream`).
- **Mic streaming**: `expo-audio-studio` — 16 kHz PCM chunk streaming (the relay wants
  `linear16@16k` base64 frames, see protocol below) **with built-in VAD** (replaces Silero/onnx).
- **Lock screen / background**: iOS `UIBackgroundModes: audio` via config plugin; Now Playing
  controls via `expo-media-control` or `react-native-track-player`.
- **Ship pipeline**: `eas build --platform ios` (EAS manages certs/profiles server-side after one
  Apple ID 2FA login) → `eas submit` with an ASC API key → TestFlight internal (no review).
  `npx testflight` does the whole first pass in one command. JS-only iterations ship as
  **EAS Update OTA** — no Apple involvement.
- **Agent tooling**: add the official Expo MCP server (`claude mcp add --transport http expo
  https://mcp.expo.dev/mcp`) — build triggering, logs, TestFlight feedback from inside Claude Code.

## Blocked on Apple (status as of writing)

Developer Program enrollment is **stuck**: the Apple Developer app rejects both of Moritz's IDs
(US green card → "not accepted for your region"; German passport → upload error). No US driver's
license. A support request for **manual verification / special upload link** is the known fix —
message drafted, to be sent to developer.apple.com/contact → Membership → Program Enrollment
(or +1-800-633-2152). **Nothing can reach TestFlight until this clears (can take days-weeks);
everything else — simulator dev, dev builds on a cabled phone — can proceed.**

## What's reusable from `client/`

- **The relay protocol is the spec.** JSON over a single WebSocket to
  `wss://voizecode-relay.fly.dev`. Auth: first message
  `{t:"hello", role:"client", token, since}` (token = `~/.voizecode/token` on the laptop, same
  `?key=` the web app stores). Then: send `{t:"text"|"audio"(pcm b64)|"barge_in"|"ramble"|
  "set_model"|"fork"|"new_session"|"close_session"|"list_prs"|"get_clip"...}`; receive
  `{t:"sessions"|"user_echo"|"agent_text"|"speech_text"|"audio_chunk"(mp3 b64, bounded ≤24KB)|
  "words"(timestamps for highlight)|"audio_end"|"clip_audio"|"thinking"|"status"|"meta"|
  "history"|"transcript"...}`. Read `client/src/hooks/useVoize.ts` (state machine, ~650 lines,
  portable) and `relay/main.ts` (authoritative message handling).
- **`clipPlayer.ts` semantics** (ordered clip queue, one-at-a-time, barge-in stop, replay): port
  the *logic*, swap MediaSource/HTMLAudioElement for the native buffer-queue player.
- Word-highlight rendering (`SpokenLine`/`styledWords` in `index.tsx`), tab/session/localStorage
  patterns (→ AsyncStorage), token gate.
- The relay/agent need **zero changes** — the web client stays as-is; iOS is a second client.

## Sharp edges learned this session (don't re-learn these)

- The relay holds sessions **in memory on one Fly machine** — never scale it horizontally.
- Only ONE client gets live audio (single client slot, last-active wins). Phone + web open at
  once will fight; that's known behavior.
- ElevenLabs TTS provides the **word timestamps**; OpenAI fallback has none (highlight degrades
  gracefully — the web client already handles `words` being absent).
- Audio chunks arrive bounded (≤24 KB base64) and clips are replayable from R2 via
  `get_clip`/`clip_audio` — never re-synthesize.
- Errors from claude are surfaced as spoken turns/status lines by the agent — the client just
  renders; don't add client-side error synthesis.

## Suggested order

1. Expo scaffold + dev build running in simulator; WS connect + token + sessions list + text
   turns rendered (no audio) — half a day, proves the protocol port.
2. Playback: `react-native-audio-api` buffer-queue fed by `audio_chunk`; rate control; clip
   queue port. Then word-highlight sync off `words` + playback position.
3. Mic: `expo-audio-studio` PCM stream → `{t:"audio"}` frames; its VAD for barge-in.
4. Background mode + Now Playing controls; the acceptance test: lock the phone mid-narration,
   keep talking, get an answer.
5. TestFlight via `npx testflight` (once Apple enrollment clears).

## Non-iOS backlog left over from this session (for whoever picks it up)

- **Demo video still unrecorded** (script exists in the 2026-08-01/02 session transcript);
  rotate the access token after recording: `rm ~/.voizecode/token && pkill -f voizecode.mjs`.
- Web-app iOS lock-screen mode (the cheaper 80% alternative to the native app; recipe in
  README Status section — persistent `<audio>` groundwork already landed in `clipPlayer.ts`).
- Mic capture still uses deprecated ScriptProcessor → AudioWorklet.
- Voice playback controls ("pause", "slower", "again") — roadmap item, unstarted.
- Housekeeping: delete merged `menubar-voizemonitor` branch; revoke the Cloudflare DNS token and
  Fly API token pasted in the chat transcript (or keep deliberately for future agent ops);
  `voizecode.vercel.app` landing is redundant with voizecode.com (kept as mirror).
