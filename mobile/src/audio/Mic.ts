// Mic capture -> base64 linear16 @ 16 kHz frames, which is exactly what the relay forwards to
// Deepgram (`{t:"audio", pcm}`). The web client does this with getUserMedia + a ScriptProcessor;
// here it's react-native-audio-api's AudioRecorder, which hands us float samples in a callback.
//
// Two things the web version doesn't have to deal with:
//   - The requested sample rate is a *preference*. iOS routinely delivers 48 kHz regardless, and
//     sending 48 kHz audio labelled 16 kHz makes Deepgram transcribe chipmunk gibberish rather
//     than fail loudly. So we check what actually arrived and downsample when it differs.
//   - Muting has to keep the stream flowing. Dropping frames while muted makes Deepgram stall
//     mid-utterance instead of finalizing your last words, so we send silence instead (same
//     trick as the web client).
import { AudioManager, AudioRecorder } from "react-native-audio-api";
import { floatsToPcmB64 } from "../core/base64";
import { configureSession, sessionMode } from "./session";

export const MIC_SR = 16000;
const FRAME = 4096;
// How long without a single audio buffer before we assume capture has silently died. Deepgram
// gives up on silence at around 12s, so this has to be comfortably shorter than that.
const FRAME_STALL_MS = 4000;

// Cheap linear-interpolation resample. Speech at 16 kHz through a low-pass-free decimation is
// good enough for STT — Deepgram is far more tolerant of interpolation artifacts than of a
// wrong declared rate. Not suitable if this audio ever becomes something a human listens to.
function downsample(input: Float32Array<ArrayBufferLike>, from: number, to: number): Float32Array<ArrayBufferLike> {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

export class Mic {
  private recorder: AudioRecorder | null = null;
  private muted = false;
  private warnedRate = false;
  // iOS sometimes stops delivering buffers to onAudioReady while the recorder still reports as
  // running — an interruption, a route change, or the session being pulled out from under us.
  // Nothing throws; frames just stop, Deepgram times out on silence ~12s later, and it looks
  // like "it only transcribed the first few words". This watchdog notices and restarts.
  private lastFrameAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private restarting = false;

  // onFrame receives base64 linear16 @ MIC_SR, ready to put straight on the wire.
  // beforeSessionChange must tear down any live audio graph: switching the session category
  // under a running AVAudioEngine aborts the process (see ./session).
  constructor(
    private onFrame: (pcmB64: string) => void,
    private beforeSessionChange?: () => Promise<void>,
  ) {}

  isRecording() { return !!this.recorder; }

  setMuted(m: boolean) { this.muted = m; }

  // Resolves to an error string, or "" on success. Permission denial is the common case and
  // has to surface in the UI — a silently dead mic looks like a broken app.
  async start(): Promise<string> {
    if (this.recorder) return "";
    try {
      const perm = await AudioManager.checkRecordingPermissions();
      if (perm !== "Granted") return "Mic access denied — enable it in Settings › voizecode.";
    } catch {
      return "Could not check microphone access.";
    }

    // The category is NOT changed here. It was fixed at startup by initSession, because changing
    // it once audio has been running aborts the process inside AudioToolbox — see ./session. If
    // we somehow got here without a record-capable session, fail loudly instead of crashing.
    if (sessionMode() !== "call") {
      return "Microphone unavailable — restart the app and allow mic access.";
    }

    try {
      const rec = new AudioRecorder();
      rec.onAudioReady({ sampleRate: MIC_SR, bufferLength: FRAME, channelCount: 1 }, (e) => {
        const buf = e.buffer;
        let samples: Float32Array<ArrayBufferLike> = buf.getChannelData(0);
        if (this.muted) {
          // Silence, not nothing: keeps the STT stream alive so the last utterance finalizes.
          this.lastFrameAt = Date.now();
          this.onFrame(floatsToPcmB64(new Float32Array(Math.floor(samples.length * (MIC_SR / buf.sampleRate)))));
          return;
        }
        if (buf.sampleRate !== MIC_SR) {
          if (!this.warnedRate) {
            this.warnedRate = true;
            console.warn(`[mic] device delivered ${buf.sampleRate} Hz, resampling to ${MIC_SR}`);
          }
          samples = downsample(samples, buf.sampleRate, MIC_SR);
        }
        this.lastFrameAt = Date.now();
        this.onFrame(floatsToPcmB64(samples));
      });
      const res = await rec.start();
      if (res && (res as { error?: string }).error) return String((res as { error?: string }).error);
      this.recorder = rec;
      this.lastFrameAt = Date.now();
      this.startWatchdog();
      return "";
    } catch (err) {
      return `Mic error: ${(err as Error).message}`;
    }
  }

  private startWatchdog() {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (!this.recorder || this.restarting) return;
      if (Date.now() - this.lastFrameAt < FRAME_STALL_MS) return;
      console.warn(`[mic] no audio for ${FRAME_STALL_MS}ms — restarting capture`);
      void this.restart();
    }, 2000);
  }
  private stopWatchdog() { if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; } }

  // Tear the recorder down and bring it back. The session category is untouched (changing it
  // aborts the process — see ./session), so this is just the capture graph.
  private async restart() {
    this.restarting = true;
    try {
      await this.stop();
      const err = await this.start();
      if (err) console.warn("[mic] restart failed:", err);
    } finally { this.restarting = false; }
  }

  async stop() {
    this.stopWatchdog();
    const rec = this.recorder;
    this.recorder = null;
    if (!rec) return;
    try { rec.clearOnAudioReady(); } catch { /* noop */ }
    try { await rec.stop(); } catch { /* already stopped */ }
    // Deliberately NOT switching back to "playback": that would rebuild the audio engine and
    // abort the process. playAndRecord + defaultToSpeaker plays back fine. See ./session.
  }
}
