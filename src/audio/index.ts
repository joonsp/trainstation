import * as THREE from 'three';
import type { AudioCue, Ctx, System } from '../core/types';
import type { AudioAPI, Departure, TrainInfo } from '../core/apis';
import { CUES, CUE_GAIN, chirp, chuff, clack, cricket, hourStrikes, type SynthKit } from './synth';
import { createAmbience } from './ambience';

/*
 * Procedural WebAudio. No files. Locked until the first user gesture.
 * Graph: [cue voices] → sfx ─┐
 *        [ambient beds] → amb ┼→ master → compressor → destination
 *        [train chuffs] → per-slot gain/pan ┘
 * Ambient beds crossfade continuously from atmosphere/people/trains state.
 * v2: ambience.ts adds the living world (river, weir, leaves, pub, hooves & wheels, oars, animals, forge, church
 * bells, level-crossing bell); everything is attenuated by distance from ctx.view.focus and voice-limited.
 */

const STORE_KEY = 'vj.audio.muted';
const MAX_VOICES = 28;
const CHUFF_SLOTS = 2;

interface Slot { id: string | null; gain: GainNode; pan: StereoPannerNode; nextChuff: number; nextClack: number; beat: number }

export function createAudio(ctx: Ctx): System {
  const { bus, reg, clock } = ctx;

  let stored = false;
  try { stored = localStorage.getItem(STORE_KEY) === '1'; } catch { /* storage blocked */ }

  let ac: AudioContext | null = null;
  let kit: SynthKit | null = null;
  let master: GainNode, sfx: GainNode, amb: GainNode;
  let rainG: GainNode, windG: GainNode, windBP: BiquadFilterNode, crowdG: GainNode, crowdBP: BiquadFilterNode;
  const slots: Slot[] = [];
  let voices: number[] = []; // end times
  const lastCue: Partial<Record<AudioCue, number>> = {};
  const _v = new THREE.Vector3();

  let ambience: ReturnType<typeof createAmbience> | null = null;
  const api: AudioAPI & { debug(): unknown } = {
    debug: () => ({ unlocked: api.unlocked, state: ac?.state, voices: voices.length, ambience: ambience?.state() ?? null }),
    muted: ctx.params.mute || stored,
    unlocked: false,
    setMuted(m: boolean) {
      api.muted = m;
      if (!ctx.params.mute) { try { localStorage.setItem(STORE_KEY, m ? '1' : '0'); } catch { /* ignore */ } }
      if (ac && master) {
        const t = ac.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setTargetAtTime(m ? 0 : 0.9, t, 0.08);
        if (m) setTimeout(() => { if (api.muted && ac?.state === 'running') ac.suspend().catch(() => {}); }, 400);
        else if (ac.state !== 'running') ac.resume().catch(() => {});
      }
    },
    play(cue: AudioCue, pos?: THREE.Vector3, volume?: number) {
      const now = performance.now();
      const prev = lastCue[cue] ?? -1e9;
      lastCue[cue] = now;
      if (!ac || !kit || api.muted || ac.state !== 'running') return;
      if (now - prev < 220) return; // debounce floods (e.g. during fast-forward)
      const fn = CUES[cue];
      if (!fn) return;
      const t = ac.currentTime + 0.02;
      voices = voices.filter((e) => e > t);
      if (voices.length >= MAX_VOICES) return;
      let v = (volume ?? 1) * (CUE_GAIN[cue] ?? 0.5);
      let panV = 0;
      if (pos) {
        const a = spatial(pos);
        v *= a.gain;
        panV = a.pan;
      }
      if (v < 0.01) return;
      try {
        const p = ac.createStereoPanner();
        p.pan.value = panV;
        p.connect(sfx);
        const dur = fn(kit, p, t, v);
        voices.push(t + dur);
        setTimeout(() => { try { p.disconnect(); } catch { /* */ } }, (dur + 2) * 1000);
      } catch (e) { console.warn('[audio] cue failed', cue, e); }
    },
  };
  ctx.reg.audio = api;

  /** distance attenuation to the view focus + stereo pan from screen position */
  function spatial(pos: THREE.Vector3): { gain: number; pan: number } {
    const cam = ctx.camera.current;
    const target = ctx.view.focus;
    const d = Math.hypot(pos.x - target.x, pos.z - target.z);
    // zoomed-in listeners are "closer"; far zoom-outs hear a wider (but quieter) area
    const zoom = ctx.view.zoom || 1;
    const ref = 50 / Math.max(0.5, Math.min(3, zoom));
    const gain = 1 / (1 + Math.max(0, d - ref * 0.4) / ref);
    _v.copy(pos).project(cam);
    const pan = Number.isFinite(_v.x) ? THREE.MathUtils.clamp(_v.x * 0.75, -0.85, 0.85) : 0;
    return { gain, pan };
  }

  function makeNoise(seconds: number, brown: boolean): AudioBuffer {
    const len = Math.floor(ac!.sampleRate * seconds);
    const buf = ac!.createBuffer(1, len, ac!.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return buf;
  }

  function loopNoise(buf: AudioBuffer, dest: AudioNode) {
    const s = ac!.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.connect(dest);
    s.start(0, Math.random() * buf.duration);
    return s;
  }

  function unlock() {
    if (ac) { if (!api.muted && ac.state !== 'running') ac.resume().catch(() => {}); return; }
    const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    try {
      ac = new AC({ latencyHint: 'interactive' });
    } catch (e) { console.warn('[audio] no AudioContext', e); return; }
    kit = { ac, noise: makeNoise(2, false), brown: makeNoise(4, true) };
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.25;
    comp.connect(ac.destination);
    master = ac.createGain(); master.gain.value = api.muted ? 0 : 0.9; master.connect(comp);
    sfx = ac.createGain(); sfx.gain.value = 1; sfx.connect(master);
    amb = ac.createGain(); amb.gain.value = 1; amb.connect(master);

    // rain: bright hiss
    rainG = ac.createGain(); rainG.gain.value = 0;
    const rainHP = ac.createBiquadFilter(); rainHP.type = 'highpass'; rainHP.frequency.value = 600;
    const rainLP = ac.createBiquadFilter(); rainLP.type = 'lowpass'; rainLP.frequency.value = 6500;
    rainHP.connect(rainLP).connect(rainG).connect(amb);
    loopNoise(kit.noise, rainHP);
    // wind: brown noise, swept band-pass
    windG = ac.createGain(); windG.gain.value = 0;
    windBP = ac.createBiquadFilter(); windBP.type = 'bandpass'; windBP.frequency.value = 400; windBP.Q.value = 0.8;
    windBP.connect(windG).connect(amb);
    loopNoise(kit.brown, windBP);
    // crowd murmur: mid band noise with slow AM
    crowdG = ac.createGain(); crowdG.gain.value = 0;
    crowdBP = ac.createBiquadFilter(); crowdBP.type = 'bandpass'; crowdBP.frequency.value = 520; crowdBP.Q.value = 1.4;
    const crowdAM = ac.createGain(); crowdAM.gain.value = 0.7;
    const lfo = ac.createOscillator(); lfo.frequency.value = 0.37;
    const lfoG = ac.createGain(); lfoG.gain.value = 0.3;
    lfo.connect(lfoG).connect(crowdAM.gain); lfo.start();
    crowdBP.connect(crowdAM).connect(crowdG).connect(amb);
    loopNoise(kit.noise, crowdBP);

    for (let i = 0; i < CHUFF_SLOTS; i++) {
      const gain = ac.createGain(); gain.gain.value = 0;
      const pan = ac.createStereoPanner();
      gain.connect(pan).connect(amb);
      slots.push({ id: null, gain, pan, nextChuff: 0, nextClack: 0, beat: 0 });
    }
    try {
      ambience = createAmbience(ctx, { ac, kit, amb, spatial, play: (c, p, v) => api.play(c, p, v), loopNoise });
    } catch (e) { console.warn('[audio] ambience failed', e); }
    api.unlocked = true;
    if (api.muted) ac.suspend().catch(() => {});
    else {
      ac.resume().catch(() => {});
      // a distant welcoming whistle
      setTimeout(() => api.play('whistle', undefined, 0.3), 150);
    }
    for (const ev of GESTURES) window.removeEventListener(ev, unlock, true);
  }
  const GESTURES = ['pointerdown', 'keydown', 'touchstart'] as const;
  for (const ev of GESTURES) window.addEventListener(ev, unlock, true);

  // ── bus hooks ──
  bus.on('audio:cue', (e) => api.play(e.cue, e.pos, e.volume));
  let lastChime = -1e9;
  bus.on('time:hour', (e) => {
    const now = performance.now();
    if (now - lastChime < 15000 || !ac || !kit || api.muted) return; // skip bursts during fast-forward
    lastChime = now;
    const pos = safe(() => reg.world.clockTowerTop, undefined);
    api.play('chime', pos, 1);
    const strikes = (e.hour % 12) || 12;
    const t = ac.currentTime + 3.0;
    const g = ac.createGain();
    g.gain.value = pos ? spatial(pos).gain : 0.8;
    g.connect(sfx);
    const dur = hourStrikes(kit, g, t, clock.timeScale > 30 ? Math.min(strikes, 3) : strikes, 1);
    setTimeout(() => { try { g.disconnect(); } catch { /* */ } }, (dur + 5) * 1000);
  });
  // fallbacks when the owning system didn't send its own cue
  bus.on('weather:lightning', (e) => {
    const at = performance.now();
    const d = Math.hypot(e.pos.x - 20, e.pos.z);
    const delay = Math.min(2500, (d / 343) * 1000) + 150;
    setTimeout(() => {
      if ((lastCue.thunder ?? -1e9) >= at - 300) return;
      api.play('thunder', undefined, Math.max(0.3, Math.min(1, e.intensity)));
    }, delay);
  });
  bus.on('train:departing', (e) => {
    const at = performance.now();
    setTimeout(() => {
      if ((lastCue.whistle ?? -1e9) >= at - 300) return;
      const t = safe(() => reg.trains.get(e.trainId), undefined);
      if (t && !t.ghost) api.play('whistle', t.position, 0.9);
    }, 400);
  });

  function safe<T>(f: () => T, d: T): T { try { return f() ?? d; } catch { return d; } }

  // ── departure bell (1 sim-minute before departures) ──
  const rung = new Set<string>();
  function checkBell() {
    const deps = safe(() => reg.trains.timetable(6), [] as Departure[]);
    const now = clock.minutes;
    for (const d of deps) {
      if (!d.trainId || /Depart|Cancel/i.test(d.status)) continue;
      const key = `${d.trainId}@${Math.round(d.time)}`;
      if (rung.has(key)) continue;
      const lead = d.time - now;
      if (lead <= 1 && lead > -0.5) {
        rung.add(key);
        if (rung.size > 60) rung.delete(rung.values().next().value!);
        const plat = ctx.layout.platforms[d.platform];
        api.play('bell', plat?.center, 0.9);
      }
    }
  }

  // ── ambient scheduling ──
  let ambErr = false;
  let nextBird = 0, nextCricket = 0, lastAmb = 0, lastBell = 0, gust = 0.5;

  function updateAmbient(nowMs: number) {
    if (!ac || !kit || ac.state !== 'running') return;
    const t = ac.currentTime;
    const atm = reg.atmosphere;
    const rain = atm?.rain ?? 0, snow = atm?.snow ?? 0, night = atm?.nightFactor ?? 0;
    const windSpd = ctx.wind.speed;
    const ws = ctx.wind.sample(ctx.view.focus.x, ctx.view.focus.z);
    const storm = atm?.weather === 'storm' ? 1 : 0;
    gust = THREE.MathUtils.clamp(gust * 0.7 + (ws.gust ?? 0.5) * 0.3 + (Math.random() - 0.5) * 0.08, 0.1, 1);
    rainG.gain.setTargetAtTime(Math.min(1, rain) * 0.22 * (1 - snow * 0.8), t, 0.6);
    const windAmt = THREE.MathUtils.clamp(windSpd / 14, 0, 1) * (0.55 + 0.45 * gust) + storm * 0.2 + snow * 0.1;
    windG.gain.setTargetAtTime(windAmt * 0.25, t, 0.5);
    windBP.frequency.setTargetAtTime(250 + gust * 500 + windSpd * 20, t, 0.8);
    const people = safe(() => reg.people.count(), 0);
    const f = ctx.view.focus;
    const nearStation = THREE.MathUtils.clamp(1 - (Math.hypot(f.x - 35, f.z + 5) - 60) / 140, 0, 1);
    crowdG.gain.setTargetAtTime(Math.min(1, Math.sqrt(people) / 9) * 0.07 * nearStation * (1 - Math.min(0.6, rain * 0.4)), t, 0.8);
    crowdBP.frequency.setTargetAtTime(480 + Math.random() * 80, t, 1);

    const clear = atm ? atm.weather === 'clear' || atm.weather === 'overcast' : true;
    // birdsong by day
    if (nowMs > nextBird) {
      const birdAmt = clear && rain < 0.1 && snow < 0.3 ? Math.max(0, 1 - night * 2.2) : 0;
      if (birdAmt > 0.05) {
        const p = ac.createStereoPanner(); p.pan.value = Math.random() * 1.6 - 0.8; p.connect(amb);
        chirp(kit, p, t + 0.05, 0.035 * birdAmt);
        setTimeout(() => { try { p.disconnect(); } catch { /* */ } }, 2000);
      }
      nextBird = nowMs + 700 + Math.random() * 2600 / Math.max(0.3, birdAmt || 0.3);
    }
    // crickets on warm clear nights
    if (nowMs > nextCricket) {
      const temp = atm?.temperatureC ?? 14;
      const cAmt = atm?.weather === 'clear' && temp >= 9 && rain < 0.05 ? Math.max(0, (night - 0.5) * 2) : 0;
      if (cAmt > 0.05) {
        const p = ac.createStereoPanner(); p.pan.value = Math.random() * 1.8 - 0.9; p.connect(amb);
        cricket(kit, p, t + 0.05, 0.02 * cAmt);
        setTimeout(() => { try { p.disconnect(); } catch { /* */ } }, 1000);
      }
      nextCricket = nowMs + 180 + Math.random() * 700;
    }
  }

  // ── train chuffs (2 nearest moving trains) ──
  function updateChuffs() {
    if (!ac || !kit || ac.state !== 'running') return;
    const t = ac.currentTime;
    const target = ctx.view.focus;
    const trains = safe(() => reg.trains.list(), [] as TrainInfo[]);
    const moving = trains
      .filter((tr) => tr.speed > 0.3 && tr.state !== 'inShed')
      .map((tr) => ({ tr, d: Math.hypot(tr.position.x - target.x, tr.position.z - target.z) }))
      .filter((x) => x.d < 320)
      .sort((a, b) => a.d - b.d)
      .slice(0, CHUFF_SLOTS);
    const wanted = new Set(moving.map((m) => m.tr.id));
    for (const s of slots) if (s.id && !wanted.has(s.id)) { s.id = null; s.gain.gain.setTargetAtTime(0, t, 0.3); }
    const paused = clock.paused || clock.timeScale === 0;
    for (const m of moving) {
      let s = slots.find((x) => x.id === m.tr.id);
      if (!s) { s = slots.find((x) => !x.id); if (!s) continue; s.id = m.tr.id; s.nextChuff = t + 0.05; s.nextClack = t + 0.3; }
      const sp = spatial(m.tr.position);
      const speed = m.tr.speed * Math.min(clock.timeScale, 1.5); // at high sim speed keep rhythm plausible
      const working = m.tr.state === 'departing' ? 1.4 : m.tr.state === 'braking' ? 0.5 : 1;
      const lvl = paused ? 0 : sp.gain * Math.min(1, 0.35 + speed / 18) * (m.tr.ghost ? 0.25 : 1);
      s.gain.gain.setTargetAtTime(lvl, t, 0.15);
      s.pan.pan.setTargetAtTime(sp.pan, t, 0.15);
      if (paused || lvl < 0.01) continue;
      const rate = THREE.MathUtils.clamp(speed * 0.42, 1.2, 9); // chuffs per second
      const horizon = t + 0.15;
      if (s.nextChuff < t - 0.5) s.nextChuff = t;
      while (s.nextChuff < horizon) {
        const accent = s.beat % 4 === 0 ? 1 : 0.7;
        chuff(kit, s.gain, s.nextChuff, 0.32 * accent * working, Math.min(1, speed / 20));
        s.beat++;
        s.nextChuff += 1 / rate;
      }
      if (speed > 3) {
        if (s.nextClack < t - 0.5) s.nextClack = t;
        while (s.nextClack < horizon) {
          clack(kit, s.gain, s.nextClack, 0.18);
          clack(kit, s.gain, s.nextClack + 2.4 / speed, 0.14); // bogie pair
          s.nextClack += 18 / speed;
        }
      }
    }
  }

  return {
    name: 'audio',
    update() {
      const now = performance.now();
      if (now - lastAmb < 50) return; // once per frame-ish; ignores fast-forward sub-steps
      lastAmb = now;
      if (!ac) return;
      if (now - lastBell > 250) { lastBell = now; checkBell(); }
      updateAmbient(now);
      updateChuffs();
      if (ambience) { try { ambience.update(now); } catch (e) { if (!ambErr) { ambErr = true; console.warn('[audio] ambience update', e); } } }
    },
    dispose() {
      try { ac?.close(); } catch { /* */ }
    },
  };
}
