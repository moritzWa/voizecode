// A soft ambient "thinking" tone played while the agent is working (à la OpenAI voice mode):
// two quiet detuned sines with a slow tremolo (gentle digital shimmer), faded in/out so it
// never clicks. Generated procedurally — no audio file needed.

export class ThinkingTone {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private oscs: OscillatorNode[] = [];
  private on = false;

  start() {
    if (this.on) return;
    this.on = true;
    const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    const ctx = (this.ctx ??= new Ctor());
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    master.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.4); // gentle fade-in, low volume
    this.master = master;

    // two soft detuned partials = airy shimmer; a slow LFO pulses the amplitude
    for (const freq of [262, 392]) { // calmer, lower partials
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0.42;
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.18; // slow, dispersed pulse (longer gaps between swells)
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.42; // deep tremolo -> dips near silence between pulses
      lfo.connect(lfoGain);
      lfoGain.connect(g.gain);
      osc.connect(g);
      g.connect(master);
      osc.start();
      lfo.start();
      this.oscs.push(osc, lfo);
    }
  }

  stop() {
    if (!this.on) return;
    this.on = false;
    const ctx = this.ctx, master = this.master;
    const oscs = this.oscs;
    this.oscs = [];
    this.master = null;
    if (!ctx || !master) return;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25); // fade-out, no click
    setTimeout(() => {
      for (const o of oscs) { try { o.stop(); } catch { /* already stopped */ } }
      try { master.disconnect(); } catch { /* noop */ }
    }, 300);
  }
}
