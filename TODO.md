# TODO

Living document. Add things as they come up; delete them when they ship. Started
2026-08-13 while building the iOS app.

`ios-handoff.md` is the build spec for the mobile app (protocol, stack research, what's
reusable from `client/`). This file is the running list of what's left and what's blocked.

## Decisions made (so we don't relitigate them)

- **TestFlight internal, not the App Store, for now.** Internal TestFlight has no review at
  all — install today, up to 100 testers. `eas submit` to the App Store is one command
  whenever we want it, same build, same bundle ID. Nothing is lost by deferring, and going
  for the App Store now would mean solving multi-tenancy, demo accounts and billing before
  the app is usable on Moritz's own phone.
- **One UI, not two.** The mobile app is React Native Web (NativeWind + React Native
  Reusables), so `client/`'s Tailwind + Radix + CVA + lucide stack ports rather than gets
  duplicated. See task list.
- **No billing.** Email signup + a form-to-email notification, so we find out the moment a
  real user shows up. Add credits/payments only if usage appears.
- **Bring your own keys, not a SaaS** (2026-08-18). Deepgram/ElevenLabs/OpenAI keys live on
  the *laptop* (`~/.voizecode/keys.json`) and are sent to the relay at hello, held in memory
  for the life of the socket and never persisted. All-or-nothing per session: sending any key
  makes the session BYOK so a half-filled config bills the user, never the host. Agents that
  send none fall back to the relay's env keys — that is the hosted "try it without signing
  up" path, and the single `if` where a Stripe gate would go if it ever earns one.
  ElevenLabs is the cost to watch (cents per reply); Deepgram is rounding error. If the demo
  gets loud, the cheap defence is to point the no-key fallback at Deepgram Aura and cap
  characters per token.
- **No end-to-end encryption, and we say so plainly.** The relay decodes the audio and holds
  the assistant's plaintext because it is the thing calling Deepgram and ElevenLabs — E2E is
  impossible while the server does the transcription. Encryption we hold the key to would be
  a worse claim than none. README states what the operator can see (conversation text, not
  your repo) and points anyone who cares at self-hosting.
- **Bundle ID `com.voizecode.app`**, EAS owner `moritzw42` (same account as Cronus), Apple
  Team `74NH893Z4B`.

## Blocker for any broader release: the relay is single-tenant

This is the thing that has to be fixed before anyone else can use the relay we deploy.
It's smaller than it sounds — it is *not* "a Fly machine per user".

- `relay/main.ts:48` — `sessions` is a Map keyed by session id, so **many sessions on one
  machine already work**. This part is fine.
- `relay/main.ts:49` — `let client: WebSocket | null` is a **single global socket**. One
  connected client at a time, globally. Two strangers signed up at once fight over the same
  audio slot (last-active wins, re-asserted on every message).
- `relay/main.ts:62` — `requiredToken` is a **single global access code**. Everyone shares
  one credential; there's no notion of an account.

The fix is to make those two per-account on the same box, not to shard machines. Memory per
session is tiny. Call it a day of work, not an infrastructure project.

**Why it must stay one machine:** the relay keeps sessions and live sockets in memory. It
originally ran on Deno Deploy, which load-balances across isolates that share nothing — the
laptop agent and the phone landed in different isolates and never saw each other.
`BroadcastChannel` would have bridged them but is a non-functional stub on that platform.
Fly lets us pin exactly one always-on machine (`relay/fly.toml`, `--ha=false`). Horizontal
scaling is a correctness bug here, not a tuning knob. If we ever outgrow one machine, the
constraint to preserve is that an agent and its client must land on the same process — so
route by session id, don't load-balance.

## Security

The access gate fails closed: the relay refuses to boot if it looks deployed (`FLY_APP_NAME` or
`DENO_DEPLOYMENT_ID`) with no `VOIZE_TOKEN`. It rejects unauthorized **agents** as well as
clients, so cloning the public repo does not get you access. That's load-bearing; keep it.

## If we do go to the App Store later

Three things a reviewer will hit, from the [guidelines](https://developer.apple.com/app-store/review/guidelines/):

- **4.2.3(i): "Your app should work on its own without requiring installation of another app
  to function."** A "go download the desktop app" wall is exactly what this bans. Needs
  standalone value: in-app sign-in, transcript history that reads without a laptop attached.
- **4.2.7 Remote Desktop Clients** is the sharper risk. An app that mirrors *specific*
  host software (rather than being a generic screen mirror) must have host and client "on a
  local and LAN-based network", with account creation initiated on the host. voizecode is
  cellular-from-anywhere with a laptop-minted access code — a direct conflict if a reviewer
  files us here. Framing matters: the relay is **our own backend** and the laptop agent is a
  data source, not a screen being mirrored. Substance has to back the framing.
- **2.1** requires a demo account, since the reviewer has no Mac running the agent. Wire one
  to a canned relay-side session. (A built-in "demo mode" instead needs *prior* approval from
  Apple — not worth it.)

Precedent is good, though: [Omnara](https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727)
and [Happy Coder](https://apps.apple.com/us/app/happy-codex-claude-code-app/id6748571505)
are shipping App Store apps doing essentially this.

Also needed before submission: privacy policy URL (the site has none), listing name,
screenshots, and disclosure that audio goes to Deepgram / OpenAI / ElevenLabs.

**On payments, if it ever comes up:** since April 2025 Apple cannot take a commission on
external link-out purchases, so Stripe-on-the-web is viable at 0%. But the Ninth Circuit
remanded in Dec 2025 and the Supreme Court agreed on 2026-06-30 to hear it — this could
revert. Credits consumed in-app still nominally want StoreKit.

## Shipping identifiers (first TestFlight submission, 2026-08-14)

- EAS project `cc576751-971f-487d-b477-89bc50f28918` (`@moritzw42/voizecode`)
- App Store Connect app ID `6801661113`, bundle `com.voizecode.app`
- Apple team `74NH893Z4B` (Individual). Distribution cert + provisioning profile are managed by
  EAS and expire **2027-08-14**.
- Uploads use an EAS-held App Store Connect API key (`68X6C68CAH`), so later `eas submit` runs
  need no Apple login. Revoke via App Store Connect → Users and Access → Integrations.
- Versioning is remote with `autoIncrement`; build 1 was the first. Don't hand-edit build numbers.

## iOS app — what's left

The app lives in `mobile/` (Expo SDK 57, dev client, NativeWind). `App.tsx` is the UI,
`src/core/useVoize.ts` is the ported protocol state machine, `src/audio/` has the player and mic.

- **The web client has not been restyled to match.** The mobile app now uses larger radii, a
  single rounded composer, grey user bubbles instead of inverted white ones, and bottom sheets.
  The web client still has the old shadcn look, so the two have drifted — deliberately, for now,
  since only mobile was reviewed. Bring `client/` in line, or accept the split.
- **No app icon.** `mobile/assets/icon.png` is still Expo's template art, which is why the home
  screen shows a generic glyph. Note that the icon only changes on a **native rebuild**
  (`npx expo run:ios`) — a Metro reload will never show a new one.
- **Only *inline* markdown is rendered.** `RichText` handles `**bold**` and `` `code` `` via the
  same word renderer as spoken lines, and keeps paragraph breaks. Block-level markdown — lists,
  headings, fenced code blocks, tables — is not parsed and shows its source characters. The web
  client uses react-markdown; there is no RN equivalent worth the dependency yet.
- **Barge-in has no VAD yet.** The duck/confirm/resume state machine is ported intact
  (`vadPending` / `vadHadTranscript` in `useVoize.ts`) but nothing drives it, so talking over the
  agent currently relies on the relay's Deepgram endpointing instead of ducking instantly. Needs a
  VAD to call `player.pause()` on speech onset.
- **Playback buffers a whole clip before playing it.** The web client streams mp3 into a
  MediaSource mid-download; partial mp3 frames aren't decodable by `decodeAudioData`, so a clip
  waits for `audio_end`. Costs one sentence of latency. `AudioBufferQueueSourceNode` could fix
  this if the relay ever emits independently-decodable pieces.
- **`@siteed/expo-audio-studio` is installed but unused.** `react-native-audio-api` turned out to
  cover recording (`AudioRecorder`) as well as playback, so the second library is dead weight and
  extra native build surface. Remove it unless its VAD is wanted for the point above.
- **Running the e2e flows needs a JDK on PATH.** Maestro is installed (from the Cronus work) but
  the machine had no Java, and `brew install --cask temurin` needs sudo. `brew install openjdk`
  works without it:
  `export JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home`.
  `e2e/real-turn.yaml` drives a real turn against the live relay; `e2e/fake-relay.mjs` covers the
  protocol without spending API credit. Both flows step past expo-dev-client's server picker and
  its one-time developer-menu sheet, which only appear on dev builds.
- **Verify the Universal Links app-ID prefix.** `client/public/.well-known/apple-app-site-association`
  hardcodes `74NH893Z4B.com.voizecode.app`, taken from the Developer ID cert on this Mac. Most
  accounts' App ID prefix equals the Team ID, but not all — confirm in the developer portal, since
  a wrong prefix makes universal links fail silently (they just open Safari).
- **The relay is deployed from `main` and the client bakes `NEXT_PUBLIC_RELAY_WS` at build time.**
  The privacy page and the AASA file both need a `client` redeploy to go live.

## Backlog carried over from the 2026-08-02 session

- Demo video still unrecorded (script is in the 2026-08-01/02 transcript). Rotate the access
  token after recording: `rm ~/.voizecode/token && pkill -f voizecode.mjs`.
- Web-app iOS lock-screen mode — the cheaper 80% alternative to the native app; recipe in the
  README Status section, persistent `<audio>` groundwork already in `clipPlayer.ts`. Possibly
  moot once the native app lands.
- Mic capture still uses the deprecated ScriptProcessor → should be AudioWorklet.
- Voice playback controls ("pause", "slower", "again") — roadmap item, unstarted.
- Delete the merged `menubar-voizemonitor` branch.
- Revoke the Cloudflare DNS token and Fly API token that were pasted into a chat transcript
  (or keep them deliberately for future agent ops — decide).
- `voizecode.vercel.app` is redundant with voizecode.com; kept as a mirror.

## Sending a turn while one is running aborts it

Claude Code aborts an in-flight turn with `is_error` / `error_during_execution` if a second user
message arrives on stdin mid-turn. A voice app produces that constantly: STT commits on pauses, so
one spoken thought lands as two turns. The agent now interrupts deliberately first, so the abort
is expected (and not reported as an error). Barge-in is flagged the same way.

Related: respawning after a crash must pass `--fork-session`. A plain `--resume` of an id Claude
Code still considers live is refused ("currently running as a background agent") and the
respawned chat dies instantly.

## OTA updates apply on the NEXT launch

expo-updates downloads in the background and swaps the bundle at the following cold start, so one
relaunch after publishing still runs the old code — indistinguishable from "the update never
shipped". `applyPendingUpdate` now fetches and reloads at startup so a single relaunch suffices,
but that fix is itself in the bundle: a device on an older bundle still needs two.

Also: **deleting the app discards the downloaded bundle** and falls back to the one baked into the
`.ipa`. After a reinstall the app is whatever shipped in that build, not the latest OTA — which
looks exactly like a pile of regressions. Settings shows the running update id for this reason.

Never import `expo-updates` (or any native module) at module scope without a guard: a build made
before the package existed throws at load and the whole app dies. See `src/ui/updates.ts`.

## The iOS audio session is the sharp edge — read `mobile/src/audio/session.ts` first

Two separate crashes came from it, both `SIGABRT` inside AudioToolbox rather than a catchable
error, so neither shows up as a JS exception:

- Configuring a **record-capable category before microphone permission is granted** aborts in
  `AURemoteIO::Initialize`.
- Changing the category **while an AudioContext is live** aborts in `AVAudioEngine dealloc` ->
  `AURemoteIO::~AURemoteIO`. This is what killed the app on the first tap of Ramble.

Tearing down our own `AudioContext`s before switching was **not enough** — the library keeps a
singleton `AudioEngine` that outlives them, so the change still landed on a live `AURemoteIO` and
still aborted. The rule that actually holds: **pick the category once, at startup, before any
AudioContext exists, and never change it** (`initSession`). That is why microphone permission is
requested at launch rather than on the first Ramble tap — asking later means switching later.

## `history` must never overwrite a transcript you already have

`{t:"history"}` carries a resumed session's plain user/assistant turns — no narrated `speech`
lines, no clip keys. Applying it over an existing transcript replaces every spoken line with the
raw reply and makes past lines unplayable. That is exactly what an app restart did: the persisted
transcript loaded, the socket reconnected, `history` arrived, and it all got flattened. It now
only fills an empty transcript. The web client has the same unconditional handling and the same
latent bug.

## `app.json` arrays accumulate duplicates

Repeated `npx expo install` / plugin runs *append* to `ios.associatedDomains`,
`infoPlist.UIBackgroundModes` and `android.permissions` rather than merging, and EAS Update
rejects the manifest outright ("must NOT have duplicate items") while `eas build` accepts it. If a
publish fails on manifest validation, dedupe those arrays first.

## Two audio-session settings that are not cosmetic

- `iosMode: "voiceChat"` turns on voice-processing IO (AGC + echo cancellation) and **heavily
  attenuates output** — playback was obviously quieter than every other app. `"default"` plays at
  full volume. The tradeoff is no hardware echo cancellation, which the app then paid for: with
  the mic open during playback, Deepgram transcribed our own TTS and fed it back as the user's
  next turn — "Loud and clear, go ahead" came back as *"Sylvia. You have that one clear. Go
  ahead."* Fixed half-duplex instead: `useVoize` mutes the mic while a clip plays and unmutes
  350ms after it drains (speaker decay + Deepgram's buffer; under ~200ms the last syllable still
  lands in the transcript). Muting keeps streaming silence rather than stopping — see `Mic.ts`.
  Barge-in will need this gate lifted, and then it needs real AEC, not just a VAD.
  (iOS 18.2+ has `setPrefersEchoCancelledInput`, which is AEC *without* the voiceChat volume
  penalty. `react-native-audio-api` does not expose it — worth a PR if barge-in ever matters.)
- Decode to the **context's** sample rate, not the file's. The relay synthesizes 24 kHz; a device
  runs its context at 48 kHz, and the mismatch played an octave low at half speed.

## Global state on the relay that should be per-client

The relay was written for one client. Every place that assumption leaked has cost a debugging
round trip, and the symptom is always "it works for one of us, silently wrong for the other":

- **`get_clip`** replied on the global `client` socket, so a replay requested from the phone was
  delivered to the laptop. Tapping a line did nothing, intermittently.
- **Readback audio** (`speak`) did the same: the requester got the text, another client got the
  sound.
- **`list_sessions` / `list_prs`** replies went to the global client, so the picker came up empty
  for whoever asked and the home screen had nothing to show.
- **TTS voice** was a single global that any client overwrote on connect — you would be
  mid-conversation and the voice would change to whatever another client had stored.

Rule: anything request/response-shaped replies to the **asking socket**, and anything that is a
user *preference* is keyed per client. The global `client` is only correct for genuine broadcast
(live narration, session lists), where last-active-wins is the intent.

## The single client slot leaks into request/response

`get_clip` used to be answered on the relay's global `client` socket rather than the socket that
asked (`relay/main.ts`). With two clients ever connected — a phone and a simulator, say — a
replay requested from one was delivered to the *other*, and the requester just got silence. It
looked like "tapping a line does nothing, sometimes". Fixed by threading the requesting socket
through `handleClient` into `serveClip`.

Worth generalising: anything request/response-shaped must reply to the asking socket. The global
`client` is only correct for *broadcast* (live audio, session lists), where last-active-wins is
the intended behaviour.

## React Native: inline text cannot be a rounded chip

A nested inline `<Text>` honours `backgroundColor` but **ignores `borderRadius` and padding** on
iOS. Inline `code` and the reading highlight therefore came out as hard, cramped rectangles.
`SpokenLine` lays words out as wrapped `View`s instead, which is the only way to get a rounded,
padded chip — at the cost of real inline text layout (no justification/hyphenation, and the word
gap is a margin rather than a space).

## Theming lives in CSS variables, not in classNames

`global.css` declares the light palette and overrides it under `@media (prefers-color-scheme:
dark)`; `tailwind.config.js` maps every colour to `rgb(var(--token) / <alpha-value>)`. Never put a
literal colour in the Tailwind config — that is how the app ended up dark-only. Values that cannot
come from a className (lucide stroke colours, `placeholderTextColor`, StatusBar style) come from
`src/ui/theme.ts`, which duplicates the same tokens in JS; keep the two in step.

## NativeWind gotcha: colour classes on filled buttons

`text-white` / `text-primary-foreground` on a `<Text>` inside a filled button rendered as
*invisible* text — present in the accessibility tree, reachable by VoiceOver, drawing nothing.
It also broke centring, because an icon+label row centres as a group and a zero-width label
shoves the icon off-centre ("record icon not centred"). Button label colours are passed as
`style={{ color }}` for the same reason lucide icon colours are passed as props.

## Known behavior that is not a bug

- Only ONE client gets live audio (single client slot, last-active wins). Phone + web open at
  once will fight. The iOS app should show when it has lost the slot rather than looking hung.
- ElevenLabs provides the word timestamps; the OpenAI fallback has none, so highlighting
  degrades gracefully.
- Clips are replayable from R2 via `get_clip`/`clip_audio` — never re-synthesize.
- Lines from a *resumed* session's history were never spoken, have no clips, aren't clickable.
