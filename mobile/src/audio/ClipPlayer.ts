// Native counterpart of the web client's `client/src/lib/clipPlayer.ts`.
//
// Same contract, deliberately: an ordered queue of spoken "clips" (one utterance each),
// arriving as mp3 byte chunks via pushChunk and terminated by endClip. Clips play strictly in
// arrival order, one at a time, pitch-preserved, with pause/resume that survives a VAD duck.
// Porting the *semantics* rather than the code is the point — the web version is built around
// MediaSource and an HTMLAudioElement, neither of which exists here.
//
// The one real behavioral difference: the web version streams a clip as it downloads (MediaSource
// appends mp3 frames mid-playback). react-native-audio-api decodes whole buffers, and partial mp3
// frames don't decode, so here a clip is buffered until endClip and then played. Clips are single
// sentences, so the added latency is one sentence's synthesis, not a whole turn. If that ever
// matters, AudioBufferQueueSourceNode can hold sub-clip buffers — but it needs decodable pieces.
import { AudioContext, decodeAudioData } from "react-native-audio-api";
import type { AudioBuffer, AudioBufferSourceNode } from "react-native-audio-api";
import { activateSession, configureSession } from "./session";

type SpeakingCb = (b: boolean) => void;

interface Clip {
  id: number;
  chunks: Uint8Array[];
  ended: boolean;         // endClip seen -> decodable
  buffer?: AudioBuffer;   // decoded, ready to play
  failed?: boolean;       // undecodable -> skip rather than wedge the queue
}

export class ClipPlayer {
  private clips = new Map<number, Clip>();
  private order: number[] = [];
  private current: Clip | null = null;
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private rate = 1;
  private speaking = false;
  private paused = false;
  private offset = 0;      // media-time seconds into the current clip (survives pause/resume)
  private starting = false; // a decode/start is in flight; don't race a second one

  // onClip(id) when a clip starts, onClip(null) when the queue empties (drives the UI highlight).
  // onProgress(id, t) with media-time seconds, for word-level highlighting.
  constructor(
    private onSpeaking?: SpeakingCb,
    private onClip?: (clip: number | null) => void,
    private onProgress?: (clip: number, t: number) => void,
  ) {}

  private context(): AudioContext {
    if (this.ctx) return this.ctx;
    // Playback-only until a call starts — see ./session for why asking for record capability
    // here aborts the process rather than failing. This is also the category that keeps audio
    // alive with the screen locked, paired with UIBackgroundModes: audio in app.json.
    configureSession("playback");
    void activateSession(true);
    this.ctx = new AudioContext();
    return this.ctx;
  }

  isPlaying() { return !!this.current; }
  isPaused() { return this.paused; }

  // Tear the audio graph down so the session category can be changed safely. Changing it under a
  // live AVAudioEngine aborts the process (see ./session), so anything that switches modes has to
  // call this first. The context is lazily recreated on the next clip.
  async closeContext() {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    if (!ctx) return;
    try { await ctx.close(); } catch { /* already closed */ }
  }

  setRate(r: number) {
    this.rate = r;
    if (this.source) this.source.playbackRate.value = r;
  }

  pushChunk(id: number, bytes: Uint8Array) {
    this.ensure(id).chunks.push(bytes);
  }

  endClip(id: number) {
    const clip = this.clips.get(id);
    if (!clip) return;
    clip.ended = true;
    // If this clip is the one we're waiting on, it can start now.
    if (this.current === clip) void this.playCurrent();
    else if (!this.current) this.startNext();
  }

  // Duck without losing position (VAD thinks you started talking; may turn out to be noise).
  pause() {
    if (!this.current || this.paused) return;
    this.paused = true;
    this.stopSource();     // captures this.offset
    this.emit(false);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.current) void this.playCurrent();
  }

  // Barge-in / switching away: drop everything.
  stop() {
    this.stopSource();
    this.clips.clear();
    this.order = [];
    this.current = null;
    this.paused = false;
    this.offset = 0;
    this.emit(false);
    this.onClip?.(null);
  }

  private ensure(id: number): Clip {
    let clip = this.clips.get(id);
    if (clip) return clip;
    clip = { id, chunks: [], ended: false };
    this.clips.set(id, clip);
    this.order.push(id);
    this.startNext();
    return clip;
  }

  private startNext() {
    if (this.current || !this.order.length) return;
    const clip = this.clips.get(this.order[0]);
    if (!clip) { this.order.shift(); this.startNext(); return; }
    this.current = clip;
    this.offset = 0;
    this.onClip?.(clip.id);
    void this.playCurrent();
  }

  private async playCurrent() {
    const clip = this.current;
    if (!clip || this.paused || this.starting) return;
    if (!clip.ended) return;      // still streaming in; endClip will call us back
    if (clip.failed) { this.finishCurrent(); return; }

    this.starting = true;
    try {
      if (!clip.buffer) clip.buffer = await this.decode(clip);
      // stop()/switch may have happened while we awaited the decode.
      if (this.current !== clip || this.paused) return;

      const ctx = this.context();
      // pitchCorrection is what keeps 2.5x from sounding like a chipmunk. Plain playbackRate
      // resamples, so it shifts pitch with speed; the web client avoids this for free because an
      // <audio> element time-stretches by default. Without this flag the narrator is unlistenable
      // at the speeds this app is actually used at.
      const src = ctx.createBufferSource({ pitchCorrection: true });
      src.buffer = clip.buffer;
      src.playbackRate.value = this.rate;
      src.onPositionChangedInterval = 100;
      src.onPositionChanged = (e) => {
        if (this.current !== clip) return;
        this.offset = e.value; // where a pause would resume from — kept current, not computed later
        this.onProgress?.(clip.id, e.value);
      };
      src.onEnded = () => { if (this.current === clip) this.finishCurrent(); };
      src.connect(ctx.destination);
      src.start(0, this.offset);
      this.source = src;
      this.emit(true);
    } catch (err) {
      // A clip we can't decode or play must not wedge the queue behind it. But it must not be
      // silent either: "the agent stopped talking" is indistinguishable from "the agent had
      // nothing to say", and a swallowed decode error here would be invisible forever.
      clip.failed = true;
      console.warn(`[player] clip ${clip.id} failed, skipping:`, err);
      if (this.current === clip) this.finishCurrent();
    } finally {
      this.starting = false;
    }
  }

  private async decode(clip: Clip): Promise<AudioBuffer> {
    let total = 0;
    for (const c of clip.chunks) total += c.length;
    const mp3 = new Uint8Array(total);
    let at = 0;
    for (const c of clip.chunks) { mp3.set(c, at); at += c.length; }
    clip.chunks = []; // decoded copy is what we keep
    // Decode to the CONTEXT's sample rate, not the file's. The relay synthesizes at 24 kHz but a
    // real device runs its audio context at 48 kHz, and a 24 kHz buffer played through a 48 kHz
    // context comes out an octave low and half speed — the "very deep voice" symptom. The
    // simulator hid this by often matching the file rate. Never assume the two agree.
    return decodeAudioData(mp3.buffer as ArrayBuffer, this.context().sampleRate);
  }

  // Tear down the playing source, recording how far into the clip we got so resume() can
  // pick it up. AudioParam playbackRate means elapsed context time != elapsed media time.
  private stopSource() {
    const src = this.source;
    if (!src) return;
    this.source = null;
    src.onEnded = null;
    src.onPositionChanged = null;
    try { src.stop(); } catch { /* already stopped */ }
    try { src.disconnect(); } catch { /* already detached */ }
  }

  private finishCurrent() {
    const clip = this.current;
    if (!clip) return;
    this.stopSource();
    this.clips.delete(clip.id);
    this.order = this.order.filter((x) => x !== clip.id);
    this.current = null;
    this.offset = 0;
    if (!this.order.length) this.emit(false);
    this.startNext();
    if (!this.current) this.onClip?.(null);
  }

  private emit(b: boolean) {
    if (b !== this.speaking) { this.speaking = b; this.onSpeaking?.(b); }
  }
}
