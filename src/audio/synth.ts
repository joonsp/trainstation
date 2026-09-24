import type { AudioCue } from '../core/types';

/**
 * Procedural cue synthesis. Each cue builds a short-lived node graph into `out` starting at `t`.
 * Returns the cue's approximate duration (s) so the engine can track voices.
 */
export interface SynthKit {
  ac: AudioContext;
  noise: AudioBuffer; // white, 2 s
  brown: AudioBuffer; // brown, 4 s
}

type CueFn = (k: SynthKit, out: AudioNode, t: number, v: number) => number;

// ── helpers ──
function env(ac: AudioContext, out: AudioNode, t: number, a: number, peak: number, hold: number, rel: number): GainNode {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
  g.gain.setValueAtTime(Math.max(0.0002, peak), t + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
  g.connect(out);
  return g;
}
function osc(ac: AudioContext, type: OscillatorType, f: number, t: number, dur: number, dest: AudioNode): OscillatorNode {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}
function noiseSrc(k: SynthKit, t: number, dur: number, dest: AudioNode, brown = false): AudioBufferSourceNode {
  const s = k.ac.createBufferSource();
  s.buffer = brown ? k.brown : k.noise;
  s.loop = true;
  s.connect(dest);
  s.start(t, Math.random() * 1.5);
  s.stop(t + dur + 0.05);
  return s;
}
function filt(ac: AudioContext, type: BiquadFilterType, f: number, Q: number, dest: AudioNode): BiquadFilterNode {
  const b = ac.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = Q;
  b.connect(dest);
  return b;
}
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** FM bell strike. */
export function bellStrike(k: SynthKit, out: AudioNode, t: number, f: number, v: number, decay = 2.2, ratio = 1.41) {
  const { ac } = k;
  const g = env(ac, out, t, 0.004, v, 0, decay);
  const car = osc(ac, 'sine', f, t, decay + 0.1, g);
  const mod = ac.createOscillator();
  mod.frequency.value = f * ratio;
  const mi = ac.createGain();
  mi.gain.setValueAtTime(f * 2.2, t);
  mi.gain.exponentialRampToValueAtTime(f * 0.08, t + decay * 0.8);
  mod.connect(mi).connect(car.frequency);
  mod.start(t); mod.stop(t + decay + 0.1);
  // bright partial
  const g2 = env(ac, out, t, 0.002, v * 0.25, 0, decay * 0.35);
  osc(ac, 'sine', f * 2.76, t, decay * 0.4, g2);
}

// ── cues ──
const whistle: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const blasts: [number, number][] = [[0, 0.32], [0.45, 1.25]];
  for (const [off, len] of blasts) {
    const t0 = t + off;
    const bp = filt(ac, 'bandpass', 1300, 1.2, out);
    const g = env(ac, bp, t0, 0.06, v * 0.35, len, 0.25);
    for (const f of [466, 587, 698]) {
      const o = osc(ac, 'sawtooth', f * 0.94, t0, len + 0.35, g);
      o.frequency.exponentialRampToValueAtTime(f, t0 + 0.12);
    }
    const ng = env(ac, filt(ac, 'bandpass', 2400, 0.8, out), t0, 0.03, v * 0.35, len * 0.8, 0.35);
    noiseSrc(k, t0, len + 0.5, ng);
  }
  return 2.1;
};

const bell: CueFn = (k, out, t, v) => {
  for (let i = 0; i < 4; i++) bellStrike(k, out, t + i * 0.34, 1318, v * 0.28, 1.3, 1.52);
  return 2.6;
};

const chime: CueFn = (k, out, t, v) => {
  // Westminster-style quarter phrase on a big bell
  const phrase = [64, 60, 62, 55];
  phrase.forEach((m, i) => bellStrike(k, out, t + i * 0.7, mtof(m), v * 0.32, 2.6, 1.0 + 0.41));
  return 5.5;
};

const brake: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const dur = 1.6;
  const bp = filt(ac, 'bandpass', 3200, 18, out);
  bp.frequency.setValueAtTime(3400, t);
  bp.frequency.linearRampToValueAtTime(2700, t + dur);
  const g = env(ac, bp, t, 0.12, v * 1.6, dur - 0.4, 0.3);
  noiseSrc(k, t, dur, g);
  const sg = env(ac, out, t, 0.2, v * 0.05, dur - 0.6, 0.4);
  const o = osc(ac, 'sine', 2950, t, dur, sg);
  const lfo = ac.createOscillator(); lfo.frequency.value = 7;
  const lg = ac.createGain(); lg.gain.value = 40;
  lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + dur);
  return dur;
};

const doors: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const t0 = t + i * (0.12 + Math.random() * 0.25);
    const g = env(ac, filt(ac, 'lowpass', 500, 1, out), t0, 0.002, v * 0.9, 0.01, 0.12);
    noiseSrc(k, t0, 0.2, g);
    const sg = env(ac, out, t0, 0.002, v * 0.5, 0, 0.14);
    const o = osc(ac, 'sine', 120, t0, 0.2, sg);
    o.frequency.exponentialRampToValueAtTime(55, t0 + 0.14);
  }
  return 1.6;
};

const thunder: CueFn = (k, out, t, v) => {
  const { ac } = k;
  // crack
  const cg = env(ac, filt(ac, 'highpass', 900, 0.7, out), t, 0.005, v * 0.35, 0.05, 0.4);
  noiseSrc(k, t, 0.6, cg);
  // rumble
  const lp = filt(ac, 'lowpass', 260, 0.9, out);
  lp.frequency.setValueAtTime(420, t);
  lp.frequency.exponentialRampToValueAtTime(90, t + 4.5);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v * 1.4, t + 0.15);
  g.gain.exponentialRampToValueAtTime(v * 0.6, t + 1.2);
  g.gain.linearRampToValueAtTime(v * 0.9, t + 1.8);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 5.5);
  g.connect(lp);
  noiseSrc(k, t, 5.6, g, true);
  return 5.6;
};

const honk: CueFn = (k, out, t, v) => {
  const { ac } = k;
  for (let i = 0; i < 3; i++) {
    const t0 = t + i * 0.28 + Math.random() * 0.05;
    const bp = filt(ac, 'bandpass', 1100, 3, out);
    const g = env(ac, bp, t0, 0.01, v * 0.9, 0.07, 0.06);
    const o = osc(ac, 'sawtooth', 420, t0, 0.2, g);
    o.frequency.exponentialRampToValueAtTime(330, t0 + 0.15);
    const o2 = osc(ac, 'square', 423, t0, 0.2, g);
    o2.frequency.exponentialRampToValueAtTime(328, t0 + 0.15);
  }
  return 1;
};

const moo: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const lp = filt(ac, 'lowpass', 300, 6, out);
  lp.frequency.setValueAtTime(250, t);
  lp.frequency.linearRampToValueAtTime(900, t + 0.5);
  lp.frequency.linearRampToValueAtTime(350, t + 1.6);
  const g = env(ac, lp, t, 0.2, v * 0.8, 1.0, 0.4);
  const o = osc(ac, 'sawtooth', 118, t, 1.7, g);
  o.frequency.linearRampToValueAtTime(128, t + 0.4);
  o.frequency.linearRampToValueAtTime(96, t + 1.6);
  return 1.8;
};

const meow: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const bp = filt(ac, 'bandpass', 900, 4, out);
  bp.frequency.setValueAtTime(700, t);
  bp.frequency.linearRampToValueAtTime(1800, t + 0.25);
  bp.frequency.linearRampToValueAtTime(900, t + 0.65);
  const g = env(ac, bp, t, 0.05, v * 1.1, 0.4, 0.2);
  const o = osc(ac, 'sawtooth', 560, t, 0.7, g);
  o.frequency.linearRampToValueAtTime(820, t + 0.2);
  o.frequency.linearRampToValueAtTime(480, t + 0.65);
  return 0.8;
};

function brassNote(k: SynthKit, out: AudioNode, t: number, f: number, dur: number, v: number) {
  const { ac } = k;
  const lp = filt(ac, 'lowpass', 600, 1.5, out);
  lp.frequency.setValueAtTime(500, t);
  lp.frequency.exponentialRampToValueAtTime(2600, t + 0.08);
  lp.frequency.exponentialRampToValueAtTime(1300, t + dur);
  const g = env(ac, lp, t, 0.03, v, Math.max(0, dur - 0.1), 0.12);
  osc(ac, 'sawtooth', f, t, dur + 0.15, g);
  osc(ac, 'sawtooth', f * 1.004, t, dur + 0.15, g);
}

const fanfare: CueFn = (k, out, t, v) => {
  const vv = v * 0.12;
  const seq: [number, number, number][] = [[60, 0, 0.18], [64, 0.2, 0.18], [67, 0.4, 0.18], [72, 0.6, 0.5], [67, 1.15, 0.16], [72, 1.33, 1.1]];
  for (const [m, off, d] of seq) brassNote(k, out, t + off, mtof(m), d, vv);
  for (const m of [48, 55, 64]) brassNote(k, out, t + 1.33, mtof(m), 1.1, vv * 0.7);
  return 2.6;
};

const band: CueFn = (k, out, t, v) => {
  // oompah: tuba on 1 & 3, chords on 2 & 4, two bars ×2 at 112 bpm
  const beat = 60 / 112;
  const bass = [48, 43, 48, 43, 41, 48, 43, 48];
  const chords = [[64, 67, 72], [62, 65, 71], [64, 67, 72], [65, 69, 72]];
  for (let b = 0; b < 16; b++) {
    const t0 = t + b * beat;
    if (b % 2 === 0) brassNote(k, out, t0, mtof(bass[(b / 2) % bass.length]!) , beat * 0.7, v * 0.2);
    else for (const m of chords[Math.floor(b / 4) % chords.length]!) brassNote(k, out, t0, mtof(m), beat * 0.35, v * 0.06);
    if (b % 2 === 1) { // snare tick
      const g = env(k.ac, filt(k.ac, 'highpass', 1800, 0.7, out), t0, 0.002, v * 0.15, 0, 0.08);
      noiseSrc(k, t0, 0.1, g);
    }
  }
  return 16 * beat;
};

const cheer: CueFn = (k, out, t, v) => {
  const { ac } = k;
  for (const [f, q] of [[700, 1.5], [1400, 2], [2600, 2.5]] as const) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v * 0.9, t + 0.5);
    g.gain.exponentialRampToValueAtTime(v * 0.5, t + 1.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    g.connect(filt(ac, 'bandpass', f, q, out));
    noiseSrc(k, t, 3.3, g);
  }
  for (let i = 0; i < 5; i++) { // "hurrah!" whoops
    const t0 = t + 0.2 + Math.random() * 1.4;
    const bp = filt(ac, 'bandpass', 1000, 5, out);
    const g = env(ac, bp, t0, 0.05, v * 0.25, 0.2, 0.2);
    const o = osc(ac, 'sawtooth', 260 + Math.random() * 120, t0, 0.5, g);
    o.frequency.linearRampToValueAtTime(420 + Math.random() * 150, t0 + 0.3);
  }
  return 3.3;
};

const clank: CueFn = (k, out, t, v) => {
  const n = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    const t0 = t + i * (0.18 + Math.random() * 0.2);
    const f = 380 + Math.random() * 300;
    bellStrike(k, out, t0, f, v * 0.25, 0.35, 2.73);
    const g = env(k.ac, filt(k.ac, 'bandpass', 3000, 1, out), t0, 0.001, v * 0.4, 0, 0.05);
    noiseSrc(k, t0, 0.08, g);
  }
  return 1.2;
};

const hiss: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const hp = filt(ac, 'highpass', 2500, 0.6, out);
  const g = env(ac, hp, t, 0.03, v * 0.7, 0.5, 1.0);
  noiseSrc(k, t, 1.6, g);
  return 1.6;
};

const police: CueFn = (k, out, t, v) => {
  const { ac } = k;
  for (const [off, len] of [[0, 0.45], [0.6, 0.9]] as const) {
    const t0 = t + off;
    const g = env(ac, out, t0, 0.02, v * 0.18, len, 0.06);
    const o = osc(ac, 'sine', 2900, t0, len + 0.1, g);
    const lfo = ac.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 24;
    const lg = ac.createGain(); lg.gain.value = 180;
    lfo.connect(lg).connect(o.frequency); lfo.start(t0); lfo.stop(t0 + len + 0.1);
    const ng = env(ac, filt(ac, 'bandpass', 3000, 2, out), t0, 0.02, v * 0.2, len, 0.06);
    noiseSrc(k, t0, len + 0.1, ng);
  }
  return 1.6;
};

const spooky: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const dur = 3.4;
  // feedback delay for eeriness
  const dl = ac.createDelay(1); dl.delayTime.value = 0.31;
  const fb = ac.createGain(); fb.gain.value = 0.45;
  dl.connect(fb).connect(dl);
  dl.connect(out);
  const g = env(ac, out, t, 0.6, v * 0.18, dur - 1.4, 0.8);
  g.connect(dl);
  for (const d of [0, 7]) {
    const o = osc(ac, 'sine', 330 + d, t, dur, g);
    o.frequency.linearRampToValueAtTime(520 + d, t + 1.2);
    o.frequency.linearRampToValueAtTime(300 + d, t + dur);
    const lfo = ac.createOscillator(); lfo.frequency.value = 5.5;
    const lg = ac.createGain(); lg.gain.value = 9;
    lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + dur);
  }
  // cut the feedback tail after a while so nodes can be collected
  fb.gain.setValueAtTime(0.45, t + dur);
  fb.gain.linearRampToValueAtTime(0, t + dur + 1.5);
  return dur + 1.5;
};

// ───────────────────────── v2: the living world ─────────────────────────

/** One hoof strike on a hard road: a woody knock plus a short gritty click. `bright` 0..1 (setts vs dirt). */
export function clop(k: SynthKit, out: AudioNode, t: number, v: number, bright = 0.6) {
  const { ac } = k;
  const g = env(ac, filt(ac, 'bandpass', 1300 + bright * 1100, 2.6, out), t, 0.002, v * 0.9, 0.004, 0.035);
  noiseSrc(k, t, 0.06, g);
  const tg = env(ac, out, t, 0.002, v * 0.55, 0, 0.06);
  const o = osc(ac, 'triangle', 300 + Math.random() * 60, t, 0.08, tg);
  o.frequency.exponentialRampToValueAtTime(140, t + 0.05);
}

/** One exhaust beat of a single-cylinder motor: a low pop through a rattly pipe. */
export function putt(k: SynthKit, out: AudioNode, t: number, v: number) {
  const { ac } = k;
  const g = env(ac, filt(ac, 'lowpass', 520, 1.4, out), t, 0.003, v, 0.01, 0.05);
  noiseSrc(k, t, 0.08, g, true);
  const sg = env(ac, out, t, 0.002, v * 0.5, 0.005, 0.04);
  const o = osc(ac, 'square', 62, t, 0.07, filt(ac, 'lowpass', 300, 1, sg));
  o.frequency.exponentialRampToValueAtTime(44, t + 0.05);
}

/** One oar stroke: thole-pin creak then the blade's splash and drip. */
export function oarStroke(k: SynthKit, out: AudioNode, t: number, v: number) {
  const { ac } = k;
  const cg = env(ac, filt(ac, 'bandpass', 700, 7, out), t, 0.01, v * 0.35, 0.06, 0.06);
  const c = osc(ac, 'sawtooth', 190, t, 0.16, cg);
  c.frequency.linearRampToValueAtTime(240, t + 0.12);
  const lp = filt(ac, 'bandpass', 1400, 0.8, out);
  lp.frequency.setValueAtTime(900, t + 0.14);
  lp.frequency.exponentialRampToValueAtTime(2600, t + 0.45);
  const sg = env(ac, lp, t + 0.14, 0.02, v * 0.9, 0.05, 0.3);
  noiseSrc(k, t + 0.14, 0.5, sg);
  for (let i = 0; i < 3; i++) waterBlip(k, out, t + 0.5 + i * 0.13 + Math.random() * 0.1, v * 0.25);
}

/** A single water droplet / bubble "plip". */
export function waterBlip(k: SynthKit, out: AudioNode, t: number, v: number) {
  const { ac } = k;
  const f = 500 + Math.random() * 900;
  const g = env(ac, out, t, 0.003, v, 0, 0.05);
  const o = osc(ac, 'sine', f, t, 0.07, g);
  o.frequency.exponentialRampToValueAtTime(f * 1.8, t + 0.05);
}

function voice(k: SynthKit, out: AudioNode, t: number, dur: number, f0: number, f1: number, formants: number[], v: number, type: OscillatorType = 'sawtooth') {
  const { ac } = k;
  // narrow formant band-passes eat most of the energy: make it up here so calls sit level with the v1 cues
  const g = env(ac, out, t, Math.min(0.04, dur * 0.2), v * 3, Math.max(0, dur * 0.6), dur * 0.3);
  const mix = ac.createGain(); mix.gain.value = 1;
  for (const [i, f] of formants.entries()) mix.connect(filt(ac, 'bandpass', f, 5 - i, g));
  const o = osc(ac, type, f0, t, dur + 0.05, mix);
  o.frequency.linearRampToValueAtTime(f1, t + dur);
  return o;
}

const hooves: CueFn = (k, out, t, v) => {
  const beats = [0, 0.12, 0.3, 0.42, 0.6, 0.72];
  beats.forEach((b, i) => clop(k, out, t + b + Math.random() * 0.02, v * (i % 2 ? 0.7 : 1)));
  return 1;
};
const wheels: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const g = env(ac, filt(ac, 'lowpass', 260, 1, out), t, 0.25, v, 0.8, 0.5);
  noiseSrc(k, t, 1.7, g, true);
  const grit = env(ac, filt(ac, 'bandpass', 2400, 1.2, out), t, 0.25, v * 0.12, 0.8, 0.5);
  noiseSrc(k, t, 1.7, grit);
  return 1.7;
};
const horse: CueFn = (k, out, t, v) => {
  const { ac } = k;
  if (Math.random() < 0.55) { // snort / blow
    const g = env(ac, filt(ac, 'bandpass', 700, 1.2, out), t, 0.02, v, 0.12, 0.25);
    noiseSrc(k, t, 0.5, g);
    const g2 = env(ac, filt(ac, 'lowpass', 400, 1, out), t + 0.05, 0.01, v * 0.6, 0.05, 0.15);
    noiseSrc(k, t + 0.05, 0.3, g2, true);
    return 0.6;
  }
  const o = voice(k, out, t, 1.1, 820, 520, [1100, 2400], v * 0.5);
  o.frequency.setValueAtTime(820, t);
  o.frequency.linearRampToValueAtTime(1180, t + 0.25);
  o.frequency.linearRampToValueAtTime(520, t + 1.1);
  const lfo = ac.createOscillator(); lfo.frequency.value = 11;
  const lg = ac.createGain(); lg.gain.value = 55;
  lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + 1.2);
  return 1.3;
};
const motor: CueFn = (k, out, t, v) => {
  let tt = t;
  for (let i = 0; i < 12; i++) { putt(k, out, tt, v * (0.8 + Math.random() * 0.3)); tt += 0.13 + Math.random() * 0.03; }
  return 1.8;
};
const gate: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const g = env(ac, filt(ac, 'bandpass', 950, 9, out), t, 0.05, v * 0.5, 0.9, 0.2);
  const o = osc(ac, 'sawtooth', 170, t, 1.2, g);
  const lfo = ac.createOscillator(); lfo.frequency.value = 17;
  const lg = ac.createGain(); lg.gain.value = 30;
  lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + 1.2);
  bellStrike(k, out, t + 1.15, 330, v * 0.35, 0.4, 2.3);
  const ng = env(ac, filt(ac, 'lowpass', 800, 1, out), t + 1.15, 0.002, v * 0.8, 0.01, 0.12);
  noiseSrc(k, t + 1.15, 0.2, ng);
  return 1.8;
};
const crossingBell: CueFn = (k, out, t, v) => {
  for (let i = 0; i < 8; i++) bellStrike(k, out, t + i * 0.3, 1650 + (i % 2) * 40, v * 0.3, 0.45, 2.1);
  return 3;
};
const townBell: CueFn = (k, out, t, v) => {
  bellStrike(k, out, t, mtof(50), v * 0.45, 4.2, 2.0);
  bellStrike(k, out, t, mtof(62), v * 0.12, 3.0, 1.5);
  return 4.4;
};
const churchPeal: CueFn = (k, out, t, v) => {
  const bells = [67, 65, 63, 62, 60, 58];
  let tt = t;
  for (let round = 0; round < 2; round++) {
    const order = round === 0 ? bells : [67, 63, 65, 60, 62, 58]; // a simple change on the second round
    for (const m of order) { bellStrike(k, out, tt, mtof(m - 12), v * 0.24, 2.4, 2.0); tt += 0.34; }
    tt += 0.34; // handstroke gap
  }
  return tt - t + 2.4;
};
const forge: CueFn = (k, out, t, v) => {
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const t0 = t + i * (0.34 + Math.random() * 0.12);
    const soft = i === n - 1 ? 0.5 : 1; // the last is a light "tap" on the anvil's face
    bellStrike(k, out, t0, 1850 + Math.random() * 80, v * 0.3 * soft, 0.9, 2.76);
    bellStrike(k, out, t0, 2950, v * 0.1 * soft, 0.5, 1.93);
    const g = env(k.ac, filt(k.ac, 'highpass', 2500, 0.7, out), t0, 0.001, v * 0.4 * soft, 0, 0.03);
    noiseSrc(k, t0, 0.05, g);
  }
  return n * 0.45 + 1;
};
const water: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const g = env(ac, filt(ac, 'bandpass', 900, 0.8, out), t, 0.3, v * 0.5, 0.8, 0.6);
  noiseSrc(k, t, 1.8, g);
  for (let i = 0; i < 9; i++) waterBlip(k, out, t + Math.random() * 1.5, v * 0.3);
  return 1.8;
};
const oars: CueFn = (k, out, t, v) => { oarStroke(k, out, t, v); return 1; };
const splash: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const lp = filt(ac, 'lowpass', 3000, 0.7, out);
  lp.frequency.setValueAtTime(3500, t);
  lp.frequency.exponentialRampToValueAtTime(500, t + 0.6);
  const g = env(ac, lp, t, 0.005, v, 0.05, 0.5);
  noiseSrc(k, t, 0.7, g);
  for (let i = 0; i < 6; i++) waterBlip(k, out, t + 0.25 + Math.random() * 0.6, v * 0.25);
  return 1;
};
const boatWhistle: CueFn = (k, out, t, v) => {
  const { ac } = k;
  for (const [off, len] of [[0, 0.35], [0.5, 0.8]] as const) {
    const t0 = t + off;
    const bp = filt(ac, 'bandpass', 1900, 1.5, out);
    const g = env(ac, bp, t0, 0.04, v * 0.3, len, 0.15);
    for (const f of [880, 1108]) osc(ac, 'sawtooth', f, t0, len + 0.2, g);
    const ng = env(ac, filt(ac, 'bandpass', 3200, 1, out), t0, 0.03, v * 0.2, len * 0.8, 0.2);
    noiseSrc(k, t0, len + 0.3, ng);
  }
  return 1.6;
};
const lock: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const tg = env(ac, out, t, 0.004, v * 0.9, 0.05, 0.4);
  const o = osc(ac, 'sine', 70, t, 0.5, tg);
  o.frequency.exponentialRampToValueAtTime(34, t + 0.4);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t + 0.2);
  g.gain.exponentialRampToValueAtTime(v * 0.5, t + 0.8);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
  g.connect(filt(ac, 'lowpass', 900, 0.8, out));
  noiseSrc(k, t + 0.2, 3.1, g, true);
  return 3.3;
};
const mill: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const g = env(ac, filt(ac, 'bandpass', 650, 1, out), t, 0.35, v * 0.6, 0.3, 0.6);
  noiseSrc(k, t, 1.4, g);
  for (let i = 0; i < 2; i++) { // wooden paddle knocks / timber creak
    const t0 = t + 0.2 + i * 0.55;
    const kg = env(ac, out, t0, 0.002, v * 0.35, 0, 0.08);
    const o = osc(ac, 'triangle', 170 + i * 25, t0, 0.1, kg);
    o.frequency.exponentialRampToValueAtTime(90, t0 + 0.08);
  }
  return 1.5;
};
const duck: CueFn = (k, out, t, v) => {
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) voice(k, out, t + i * (0.2 + Math.random() * 0.06), 0.13, 300, 230, [1050, 2200], v * 0.5);
  return n * 0.26 + 0.2;
};
const goose: CueFn = (k, out, t, v) => {
  for (let i = 0; i < 2; i++) voice(k, out, t + i * 0.32, 0.22, 420, 360, [1400, 2800], v * 0.45);
  return 0.9;
};
const hens: CueFn = (k, out, t, v) => {
  let tt = t;
  for (let i = 0; i < 5; i++) { voice(k, out, tt, 0.07, 520, 450, [1500, 3000], v * 0.55, 'sawtooth'); tt += 0.12 + Math.random() * 0.18; }
  if (Math.random() < 0.5) voice(k, out, tt + 0.1, 0.35, 480, 700, [1400, 2600], v * 0.4); // "b-gawk"
  return tt - t + 0.6;
};
const swan: CueFn = (k, out, t, v) => { // wingbeat throb of a mute swan in flight
  const { ac } = k;
  const g = env(ac, filt(ac, 'bandpass', 900, 1.2, out), t, 0.3, v * 0.6, 1.2, 0.5);
  const am = ac.createGain(); am.gain.value = 0.5;
  const lfo = ac.createOscillator(); lfo.frequency.value = 3.2;
  const lg = ac.createGain(); lg.gain.value = 0.5;
  lfo.connect(lg).connect(am.gain); lfo.start(t); lfo.stop(t + 2.1);
  am.connect(g);
  noiseSrc(k, t, 2.1, am);
  return 2.1;
};
const sheep: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const f0 = 250 + Math.random() * 90;
  const o = voice(k, out, t, 0.75, f0, f0 * 0.9, [900, 2400], v * 0.5);
  const lfo = ac.createOscillator(); lfo.frequency.value = 19 + Math.random() * 6; // the bleat's tremolo
  const lg = ac.createGain(); lg.gain.value = f0 * 0.07;
  lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + 0.85);
  return 0.9;
};
const dog: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const n = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const t0 = t + i * (0.22 + Math.random() * 0.1);
    voice(k, out, t0, 0.11, 420, 190, [800, 1700], v * 0.4);
    const g = env(ac, filt(ac, 'bandpass', 1200, 1, out), t0, 0.003, v * 0.35, 0.02, 0.06);
    noiseSrc(k, t0, 0.1, g);
  }
  return n * 0.32 + 0.2;
};
const crow: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const n = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    const t0 = t + i * 0.42;
    voice(k, out, t0, 0.28, 560, 440, [1300, 2600], v * 0.4);
    const g = env(ac, filt(ac, 'bandpass', 1600, 2, out), t0, 0.01, v * 0.25, 0.2, 0.08);
    noiseSrc(k, t0, 0.32, g);
  }
  return n * 0.42 + 0.3;
};
const birdsong: CueFn = (k, out, t, v) => { chirp(k, out, t, v * 0.8); chirp(k, out, t + 0.6 + Math.random() * 0.4, v * 0.6); return 1.6; };
const crowd: CueFn = (k, out, t, v) => {
  const { ac } = k;
  for (const f of [420, 760]) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v * 0.6, t + 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3);
    g.connect(filt(ac, 'bandpass', f, 1.6, out));
    noiseSrc(k, t, 3.1, g);
  }
  return 3.1;
};
const fire: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const rg = env(ac, filt(ac, 'lowpass', 300, 1, out), t, 0.3, v * 0.6, 1.4, 0.5);
  noiseSrc(k, t, 2.3, rg, true);
  for (let i = 0; i < 26; i++) {
    const t0 = t + Math.random() * 2;
    const g = env(ac, filt(ac, 'bandpass', 1500 + Math.random() * 2500, 2, out), t0, 0.001, v * (0.2 + Math.random() * 0.4), 0, 0.015);
    noiseSrc(k, t0, 0.03, g);
  }
  return 2.3;
};
const pistol: CueFn = (k, out, t, v) => {
  const { ac } = k;
  const g = env(ac, filt(ac, 'highpass', 300, 0.7, out), t, 0.001, v * 1.2, 0.01, 0.25);
  noiseSrc(k, t, 0.3, g);
  const tg = env(ac, out, t, 0.001, v * 0.8, 0, 0.18);
  const o = osc(ac, 'sine', 110, t, 0.2, tg);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
  // a rolling echo off the hills
  const eg = env(ac, filt(ac, 'lowpass', 900, 0.8, out), t + 0.35, 0.02, v * 0.2, 0.05, 0.6);
  noiseSrc(k, t + 0.35, 0.8, eg, true);
  return 1.2;
};
const hammer: CueFn = (k, out, t, v) => {
  for (let i = 0; i < 2; i++) {
    const t0 = t + i * 0.3;
    bellStrike(k, out, t0, 2300 + Math.random() * 200, v * 0.22, 0.15, 3.1);
    const g = env(k.ac, filt(k.ac, 'bandpass', 3500, 1, out), t0, 0.001, v * 0.3, 0, 0.02);
    noiseSrc(k, t0, 0.04, g);
  }
  return 0.8;
};
const shout: CueFn = (k, out, t, v) => {
  const o = voice(k, out, t, 0.38, 210, 170, [700, 1200, 2500], v * 0.3);
  o.frequency.setValueAtTime(210, t);
  o.frequency.linearRampToValueAtTime(290, t + 0.12);
  o.frequency.linearRampToValueAtTime(170, t + 0.38);
  return 0.5;
};

export const CUES: Record<AudioCue, CueFn> = {
  whistle, bell, brake, doors, thunder, honk, moo, meow, fanfare, band, cheer, clank, hiss, police, spooky, chime,
  hooves, wheels, horse, motor, gate, crossingBell, townBell, churchPeal, forge,
  water, oars, splash, boatWhistle, lock, mill, duck, goose, hens, swan,
  sheep, dog, crow, birdsong, crowd, fire, pistol, hammer, shout,
};

/** default loudness per cue (before distance attenuation) */
export const CUE_GAIN: Record<AudioCue, number> = {
  whistle: 0.8, bell: 0.7, brake: 0.35, doors: 0.6, thunder: 0.9, honk: 0.45, moo: 0.5, meow: 0.4, fanfare: 0.9,
  band: 0.9, cheer: 0.5, clank: 0.6, hiss: 0.35, police: 0.7, spooky: 0.7, chime: 0.8,
  hooves: 0.35, wheels: 0.3, horse: 0.35, motor: 0.45, gate: 0.4, crossingBell: 0.45, townBell: 0.7, churchPeal: 0.7, forge: 0.4,
  water: 0.25, oars: 0.35, splash: 0.4, boatWhistle: 0.5, lock: 0.45, mill: 0.35, duck: 0.35, goose: 0.4, hens: 0.3, swan: 0.3,
  sheep: 0.35, dog: 0.4, crow: 0.3, birdsong: 0.25, crowd: 0.35, fire: 0.45, pistol: 0.45, hammer: 0.5, shout: 0.4,
};

/** Tower hour strikes (after the chime phrase). */
export function hourStrikes(k: SynthKit, out: AudioNode, t: number, count: number, v: number) {
  for (let i = 0; i < count; i++) bellStrike(k, out, t + i * 1.3, mtof(48), v * 0.35, 2.8, 1.0 + 0.41);
  return count * 1.3 + 2;
}

/** One steam chuff: short band-passed noise puff. */
export function chuff(k: SynthKit, out: AudioNode, t: number, v: number, bright: number) {
  const { ac } = k;
  const bp = filt(ac, 'bandpass', 500 + bright * 500, 0.9, out);
  const g = env(ac, bp, t, 0.008, v, 0.02, 0.13);
  noiseSrc(k, t, 0.2, g);
}

/** Rail-joint click. */
export function clack(k: SynthKit, out: AudioNode, t: number, v: number) {
  const { ac } = k;
  const g = env(ac, filt(ac, 'bandpass', 1500, 2, out), t, 0.001, v, 0, 0.04);
  noiseSrc(k, t, 0.06, g);
  const sg = env(ac, out, t, 0.001, v * 0.4, 0, 0.06);
  osc(ac, 'triangle', 180, t, 0.07, sg);
}

/** Bird chirp phrase. */
export function chirp(k: SynthKit, out: AudioNode, t: number, v: number) {
  const { ac } = k;
  const n = 2 + Math.floor(Math.random() * 4);
  const base = 2800 + Math.random() * 1800;
  for (let i = 0; i < n; i++) {
    const t0 = t + i * (0.09 + Math.random() * 0.05);
    const g = env(ac, out, t0, 0.005, v, 0.02, 0.05);
    const o = osc(ac, 'sine', base, t0, 0.1, g);
    o.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.4), t0 + 0.04);
    o.frequency.exponentialRampToValueAtTime(base * 0.85, t0 + 0.08);
  }
}

/** Cricket pulse train. */
export function cricket(k: SynthKit, out: AudioNode, t: number, v: number) {
  const { ac } = k;
  const f = 4300 + Math.random() * 500;
  for (let i = 0; i < 3; i++) {
    const t0 = t + i * 0.055;
    const g = env(ac, out, t0, 0.004, v, 0.02, 0.015);
    osc(ac, 'sine', f, t0, 0.05, g);
  }
}
