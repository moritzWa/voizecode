// The iOS audio session, in one place, because getting it wrong aborts the process rather than
// throwing something catchable. Both crashes this file exists to prevent were real:
//
//  1. Configuring a record-capable category *before* microphone permission is granted makes
//     CoreAudio spin up AURemoteIO with an input it can't have, and it aborts inside
//     AudioToolbox (AURemoteIO::Initialize -> RPC timeout -> abort).
//  2. Changing the category *while an AudioContext is already running* makes
//     react-native-audio-api rebuild its AVAudioEngine, and disposing the live AURemoteIO
//     times out the same way (AVAudioEngine dealloc -> AURemoteIO::~AURemoteIO -> abort).
//     This is what killed the app on the first tap of Ramble.
//
// So the mode is chosen as late as possible and then **never changed back**. Going
// call -> playback would re-trigger (2) for no benefit: `playAndRecord` with defaultToSpeaker
// plays through the speaker at full volume anyway, and UIBackgroundModes: audio keeps working.
// A monotonic transition is worth more here than a theoretically tidier session.
import { AudioManager } from "react-native-audio-api";

// UPDATE, after the fix below still crashed: tearing down our own AudioContexts is not enough.
// react-android/ios-audio-api keeps a **singleton** AudioEngine that outlives every AudioContext,
// so a category change still lands on a live AURemoteIO and still aborts. The only reliable rule
// is therefore stronger than "tear down first": **configure the category exactly once, at
// startup, before any AudioContext exists, and never touch it again.** `initSession` does that.
export type SessionMode = "playback" | "call";

let current: SessionMode = "playback";
let configured = false;

// Decide the category once, before any audio graph exists. Called at app start.
// A voice app needs the microphone, so we ask for it up front rather than mid-gesture: asking
// later means changing the category later, which is the thing that crashes.
export async function initSession(requestMic: () => Promise<boolean>): Promise<boolean> {
  const granted = await requestMic();
  configureSession(granted ? "call" : "playback");
  return granted;
}

export function sessionMode(): SessionMode {
  return current;
}

// Apply a mode. Returns true if it actually changed, so the caller knows whether it had to tear
// down any live audio graph first — see `ClipPlayer.closeContext`.
export function configureSession(mode: SessionMode): boolean {
  if (configured && current === mode) return false;
  if (current === "call" && mode === "playback") return false; // monotonic; see above
  current = mode;
  configured = true;
  try {
    if (mode === "call") {
      AudioManager.setAudioSessionOptions({
        iosCategory: "playAndRecord",
        // NOT "voiceChat". That mode turns on iOS voice-processing IO (AGC + echo cancellation),
        // which heavily attenuates output — playback came out obviously quieter than every other
        // app on the phone. "default" plays at full volume. The tradeoff is no hardware echo
        // cancellation, so a future VAD has to cope with hearing our own speaker.
        iosMode: "default",
        // defaultToSpeaker matters: without it playAndRecord routes to the earpiece, as if you
        // were holding the phone to your face.
        iosOptions: ["defaultToSpeaker", "allowBluetoothHFP"],
      });
    } else {
      AudioManager.setAudioSessionOptions({
        iosCategory: "playback",
        iosMode: "spokenAudio",  // marks this as speech, so iOS ducks other audio correctly
        iosOptions: [],
      });
    }
  } catch {
    /* Best-effort: playback still works in the foreground with a default session. */
  }
  return true;
}

export async function activateSession(active: boolean) {
  try {
    await AudioManager.setAudioSessionActivity(active);
  } catch {
    /* Another app may hold the session; playback recovers when it lets go. */
  }
}
