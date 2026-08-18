// Port of client/src/lib/thinkingTone.ts: a soft ambient shimmer while the agent is working.
// Two quiet detuned sines with a slow tremolo LFO, faded in and out so it never clicks.
// Procedural, so there is no asset to ship.
//
// react-native-audio-api implements the same Web Audio node graph, so this is close to a
// copy. The one difference is that it shares the app's audio session with the ClipPlayer, so it
// deliberately does NOT touch the session configuration — see ./session.
import { AudioContext } from "react-native-audio-api";
import type { GainNode, OscillatorNode } from "react-native-audio-api";

export class ThinkingTone {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private oscs: OscillatorNode[] = [];
  private on = false;

  start() {
    if (this.on) return;
    this.on = true;
    const ctx = (this.ctx ??= new AudioContext());

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    master.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.4); // gentle fade-in, low volume
    this.master = master;

    for (const freq of [262, 392]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0.42;
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.18;   // slow, dispersed pulse
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.42;    // deep tremolo -> dips near silence between swells
      lfo.connect(lfoGain);
      lfoGain.connect(g.gain);
      osc.connect(g);
      g.connect(master);
      osc.start();
      lfo.start();
      this.oscs.push(osc, lfo);
    }
  }

  // Like ClipPlayer.closeContext: the session category cannot change under a live engine, and
  // this class owns a second one. Anything switching modes has to close this too.
  async closeContext() {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    if (!ctx) return;
    try { await ctx.close(); } catch { /* already closed */ }
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
