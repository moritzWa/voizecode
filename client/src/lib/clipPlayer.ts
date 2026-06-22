// Plays an ordered queue of streamed audio "clips" (one spoken utterance each).
//
// Each clip arrives as mp3 byte chunks (pushChunk) terminated by endClip. When the browser
// supports MediaSource for mp3, chunks are appended to a SourceBuffer so a long clip starts
// playing before it finishes downloading (true streaming). Otherwise we accumulate the clip
// and play it as one Blob (non-streaming fallback, e.g. desktop Safari). Either way audio
// plays through an HTMLAudioElement, so playbackRate stays pitch-preserved.
//
// Clips play strictly in arrival order, one at a time, with a natural tiny gap between them.

type SpeakingCb = (b: boolean) => void;

interface Clip {
  id: number;
  audio: HTMLAudioElement;
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

export class ClipPlayer {
  private building = new Map<number, Clip>();
  private order: number[] = [];
  private current: Clip | null = null;
  private rate = 1;
  private speaking = false;
  private paused = false;
  constructor(private onSpeaking?: SpeakingCb) {}

  isPlaying() { return !!this.current; }
  isPaused() { return this.paused; }
  setRate(r: number) { this.rate = r; if (this.current) this.current.audio.playbackRate = r; }

  // Pause/resume the current utterance without tearing down the queue (for VAD ducking:
  // pause on possible speech, resume if it turns out to be noise).
  pause() { if (this.current && !this.paused) { this.paused = true; try { this.current.audio.pause(); } catch { /* noop */ } } }
  resume() { if (this.paused) { this.paused = false; if (this.current) this.current.audio.play().catch(() => {}); } }

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
      clip.audio.src = URL.createObjectURL(blob);
      clip.url = clip.audio.src;
      clip.playable = true;
      if (this.current === clip) this.play(clip);
    }
  }

  stop() { // barge-in / switch away: drop everything
    for (const id of this.order) this.teardown(this.building.get(id));
    if (this.current) this.teardown(this.current);
    this.building.clear(); this.order = []; this.current = null;
    this.paused = false;
    this.emit(false);
  }

  private ensure(id: number): Clip {
    let clip = this.building.get(id);
    if (clip) return clip;
    const audio = new Audio();
    (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    audio.playbackRate = this.rate;
    clip = { id, audio, url: "", appendQ: [], ended: false, playable: false };
    if (MSE_MP3) {
      const ms = new MediaSource();
      clip.ms = ms;
      clip.url = URL.createObjectURL(ms);
      audio.src = clip.url;
      clip.playable = true; // MSE can play() immediately and buffer
      ms.addEventListener("sourceopen", () => {
        if (ms.readyState !== "open" || clip!.sb) return;
        try {
          const sb = ms.addSourceBuffer("audio/mpeg");
          clip!.sb = sb;
          sb.addEventListener("updateend", () => this.pump(clip!));
          this.pump(clip!);
        } catch { /* unsupported codec mid-stream */ }
      });
    }
    audio.addEventListener("ended", () => this.onEnded(clip!));
    audio.addEventListener("error", () => this.onEnded(clip!));
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
    if (clip.playable) this.play(clip);
    // (blob clips not yet playable will be started by endClip)
  }

  private play(clip: Clip) {
    if (this.paused) return; // resume() will start it
    clip.audio.playbackRate = this.rate;
    clip.audio.play().then(() => this.emit(true)).catch(() => this.onEnded(clip));
  }

  private onEnded(clip: Clip) {
    const wasCurrent = this.current?.id === clip.id;
    this.teardown(clip);
    this.building.delete(clip.id);
    this.order = this.order.filter((x) => x !== clip.id);
    if (wasCurrent) {
      this.current = null;
      if (!this.order.length) this.emit(false);
      this.startNext();
    }
  }

  private teardown(clip?: Clip) {
    if (!clip) return;
    try { clip.audio.pause(); } catch { /* noop */ }
    try { if (clip.sb && !clip.sb.updating && clip.ms?.readyState === "open") clip.ms.endOfStream(); } catch { /* noop */ }
    try { clip.audio.removeAttribute("src"); clip.audio.load(); } catch { /* noop */ }
    try { if (clip.url) URL.revokeObjectURL(clip.url); } catch { /* noop */ }
    clip.appendQ = [];
    clip.blobChunks = undefined;
  }

  private emit(b: boolean) { if (b !== this.speaking) { this.speaking = b; this.onSpeaking?.(b); } }
}

export const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
