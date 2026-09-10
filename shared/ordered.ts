// Synthesize ahead, deliver in order.
//
// TTS for a multi-sentence reply used to be strictly serial: nothing started synthesizing
// sentence 2 until sentence 1 had finished streaming to the client. The client then buffers each
// clip whole before it can decode it, so the gaps compound — the longer the answer, the more of
// the wait is spent doing nothing.
//
// Running them concurrently is not enough on its own, because the client plays clips in arrival
// order and a faster later sentence would jump the queue. So: start up to `limit` at once, but
// hold each one's output until every earlier one has been flushed. Slot 0 still streams the
// instant it has bytes — it has nothing in front of it — while 1 and 2 are already being made.

export type Msg = Record<string, unknown>;

// Buffers messages per slot and releases them strictly in slot order. `emit` is called only when
// a message is genuinely ready to go out, which is also when its sequence number must be taken:
// seq has to be monotonic on the wire or a reconnecting client's replay skips messages.
export class OrderedEmitter {
  private buf = new Map<number, Msg[]>();
  private finished = new Set<number>();
  private next = 0;
  private emit: (m: Msg) => void;

  // Written out rather than as a parameter property: Node's type-stripping (which the tests use to
  // import this file directly) rejects those.
  constructor(emit: (m: Msg) => void) { this.emit = emit; }

  push(slot: number, m: Msg) {
    if (slot === this.next) { this.emit(m); return; }
    if (slot < this.next) return; // already released; a late write for a closed slot is a bug upstream
    const q = this.buf.get(slot);
    if (q) q.push(m); else this.buf.set(slot, [m]);
  }

  // Slot is done producing. Release it and any already-complete slots queued behind it.
  finish(slot: number) {
    this.finished.add(slot);
    while (this.finished.has(this.next)) {
      const q = this.buf.get(this.next);
      if (q) { for (const m of q) this.emit(m); this.buf.delete(this.next); }
      this.finished.delete(this.next);
      this.next++;
      // The new current slot may have buffered output from work still in flight — release what
      // it has so far, then let its own push()es go straight through.
      const cur = this.buf.get(this.next);
      if (cur && !this.finished.has(this.next)) { for (const m of cur) this.emit(m); this.buf.delete(this.next); }
    }
  }

  get pending() { return this.buf.size; }
}

// Start tasks in index order, at most `limit` in flight. Rejections are contained: one sentence
// failing to synthesize must not abandon the rest of the reply.
export async function mapConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const n = items.length;
  if (!n) return;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      try { await fn(items[i], i); } catch { /* contained: the caller's slot just produces nothing */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), n) }, worker));
}
