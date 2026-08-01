// Plays an ordered queue of streamed audio "clips" (one spoken utterance each).
//
// Each clip arrives as mp3 byte chunks (pushChunk) terminated by endClip. When the browser
// supports MediaSource for mp3, chunks are appended to a SourceBuffer so a long clip starts
// playing before it finishes downloading (true streaming). Otherwise we accumulate the clip
// and play it as one Blob (non-streaming fallback, e.g. desktop Safari).
//
// All clips play through ONE persistent HTMLAudioElement (src swapped per clip). This matters:
// - Autoplay policy: a fresh `new Audio()` per clip can never be gesture-unlocked, so on an
//   origin without autoplay permission every reply was silently dropped (play() rejected ->
//   clip discarded). One element gets unlocked once (unlock(), or any pointer/key gesture via
//   the document listener) and stays blessed. A blocked clip now WAITS instead of dropping.
// - iOS lock-screen (future): background audio requires reusing one element, never creating
//   media elements while backgrounded.
// playbackRate stays pitch-preserved. Clips play strictly in arrival order, one at a time.

type SpeakingCb = (b: boolean) => void;

interface Clip {
  id: number;
  url: string;
  // MSE mode
  ms?: MediaSource;
  sb?: SourceBuffer;
  appendQ: Uint8Array[];
  ended: boolean;
  // blob fallback mode
  blobChunks?: Uint8Array[];
  playable: boolean; // has a source ready to play()
}

const MSE_MP3 = typeof window !== "undefined" && "MediaSource" in window &&
  (() => { try { return MediaSource.isTypeSupported("audio/mpeg"); } catch { return false; } })();

// ~1ms of silence; playing it inside a user gesture blesses the element for later
// programmatic play() calls.
const SILENT_WAV = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

export class ClipPlayer {
  private building = new Map<number, Clip>();
  private order: number[] = [];
  private current: Clip | null = null;
  private rate = 1;
  private speaking = false;
  private paused = false;
  private el: HTMLAudioElement | null = null;
  private blocked = false; // play() was rejected by autoplay policy; retry on next gesture
  // onClip(id) when a clip starts playing, onClip(null) when nothing is playing (for UI highlight).
  // onProgress(id, t) on each timeupdate of the playing clip (media-time seconds, for word highlight).
  constructor(private onSpeaking?: SpeakingCb, private onClip?: (clip: number | null) => void, private onProgress?: (clip: number, t: number) => void) {
    if (typeof document !== "undefined") {
      // Any gesture retries blocked playback (and pre-blesses the element the first time).
      const retry = () => this.unlock();
      document.addEventListener("pointerdown", retry, { capture: true });
      document.addEventListener("keydown", retry, { capture: true });
    }
  }

  private element(): HTMLAudioElement {
    if (this.el) return this.el;
    const el = new Audio();
    (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    el.addEventListener("ended", () => { if (this.current) this.finishCurrent(); });
    el.addEventListener("error", () => { if (this.current) this.finishCurrent(); });
    el.addEventListener("timeupdate", () => { if (this.current) this.onProgress?.(this.current.id, el.currentTime); });
    this.el = el;
    return el;
  }

  // Call from a user gesture. Retries a policy-blocked clip, or primes the idle element with a
  // beat of silence so future programmatic play() calls are allowed.
  unlock() {
    const el = this.element();
    if (this.current) {
      if (this.blocked) { this.blocked = false; this.play(this.current); }
      return; // playing fine — don't touch the element
    }
    try {
      el.src = SILENT_WAV;
      el.play().then(() => { el.pause(); el.removeAttribute("src"); el.load(); }).catch(() => { /* not a real gesture context */ });
    } catch { /* noop */ }
  }

  isPlaying() { return !!this.current; }
  isPaused() { return this.paused; }
  setRate(r: number) { this.rate = r; if (this.el && this.current) this.el.playbackRate = r; }

  // Pause/resume the current utterance without tearing down the queue (for VAD ducking:
  // pause on possible speech, resume if it turns out to be noise).
  pause() { if (this.current && !this.paused) { this.paused = true; try { this.el?.pause(); } catch { /* noop */ } } }
  resume() { if (this.paused) { this.paused = false; if (this.current) this.play(this.current); } }

  pushChunk(id: number, bytes: Uint8Array) {
    const clip = this.ensure(id);
    if (MSE_MP3) { clip.appendQ.push(bytes); this.pump(clip); }
    else { (clip.blobChunks ||= []).push(bytes); }
  }

  endClip(id: number) {
    const clip = this.building.get(id);
    if (!clip) return;
    clip.ended = true;
    if (MSE_MP3) { this.pump(clip); }
    else { // build the whole-clip blob now and make it playable
      const blob = new Blob((clip.blobChunks ?? []) as BlobPart[], { type: "audio/mpeg" });
      clip.url = URL.createObjectURL(blob);
      clip.playable = true;
      if (this.current === clip) this.play(clip);
    }
  }

  stop() { // barge-in / switch away: drop everything
    for (const id of this.order) this.teardown(this.building.get(id));
    this.building.clear(); this.order = []; this.current = null;
    this.paused = false; this.blocked = false;
    this.emit(false);
    this.onClip?.(null);
  }

  private ensure(id: number): Clip {
    let clip = this.building.get(id);
    if (clip) return clip;
    clip = { id, url: "", appendQ: [], ended: false, playable: false };
    if (MSE_MP3) {
      const ms = new MediaSource();
      clip.ms = ms;
      clip.url = URL.createObjectURL(ms);
      clip.playable = true; // MSE can play() immediately and buffer
      ms.addEventListener("sourceopen", () => { // fires once this clip's url is loaded into the element
        if (ms.readyState !== "open" || clip!.sb) return;
        try {
          const sb = ms.addSourceBuffer("audio/mpeg");
          clip!.sb = sb;
          sb.addEventListener("updateend", () => this.pump(clip!));
          this.pump(clip!);
        } catch { /* unsupported codec mid-stream */ }
      });
    }
    this.building.set(id, clip);
    this.order.push(id);
    this.startNext();
    return clip;
  }

  private pump(clip: Clip) {
    const sb = clip.sb;
    if (!sb || sb.updating) return;
    if (clip.appendQ.length) {
      try { sb.appendBuffer(clip.appendQ.shift()! as BufferSource); } catch { /* quota / state */ }
      return;
    }
    if (clip.ended && clip.ms && clip.ms.readyState === "open") {
      try { clip.ms.endOfStream(); } catch { /* already ended */ }
    }
  }

  private startNext() {
    if (this.current || !this.order.length) return;
    const id = this.order[0];
    const clip = this.building.get(id);
    if (!clip) { this.order.shift(); this.startNext(); return; }
    this.current = clip;
    this.onClip?.(clip.id); // highlight the bubble for this clip
    if (clip.playable) this.play(clip);
    // (blob clips not yet playable will be started by endClip)
  }

  private play(clip: Clip) {
    if (this.paused) return; // resume() will start it
    const el = this.element();
    if (el.src !== clip.url) el.src = clip.url; // swapping src attaches this clip's MediaSource/blob
    el.playbackRate = this.rate;
    el.play()
      .then(() => { this.blocked = false; this.emit(true); })
      .catch(() => { this.blocked = true; /* keep the clip queued; a gesture (unlock) retries */ });
  }

  private finishCurrent() {
    const clip = this.current;
    if (!clip) return;
    this.teardown(clip);
    this.building.delete(clip.id);
    this.order = this.order.filter((x) => x !== clip.id);
    this.current = null;
    if (!this.order.length) this.emit(false);
    this.startNext();
    if (!this.current) this.onClip?.(null); // nothing left to play -> clear highlight
  }

  private teardown(clip?: Clip) {
    if (!clip) return;
    const el = this.el;
    if (el && clip.url && el.src === clip.url) {
      try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* noop */ }
    }
    try { if (clip.sb && !clip.sb.updating && clip.ms?.readyState === "open") clip.ms.endOfStream(); } catch { /* noop */ }
    try { if (clip.url) URL.revokeObjectURL(clip.url); } catch { /* noop */ }
    clip.appendQ = [];
    clip.blobChunks = undefined;
  }

  private emit(b: boolean) { if (b !== this.speaking) { this.speaking = b; this.onSpeaking?.(b); } }
}

export const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
