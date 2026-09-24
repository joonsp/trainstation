import * as THREE from 'three';
import type { AudioCue, Ctx } from '../core/types';
import type { BoatInfo, CritterInfo, CritterKind, VehicleInfo } from '../core/apis';
import type { Building } from '../core/countryside';
import { clop, oarStroke, putt, chuff, type SynthKit } from './synth';

/**
 * LIVING-WORLD AMBIENCE (v2). Everything here is positional against the view focus (ctx.view) and bounded:
 *  - continuous beds (river, weir, rain on water, leaves in the wind, pub murmur) are a fixed set of looping noise
 *    graphs whose gains follow proximity; no nodes are created per frame;
 *  - moving things get a small fixed pool of emitter SLOTS: VEHICLE_SLOTS carriages (hooves + wheel rumble, or a
 *    motorwagen's putter), BOAT_SLOTS boats (oar strokes or a launch's soft chuff). Beyond the pool nothing sounds;
 *  - sporadic life (animals, forge, church, windmill, mill wheel) goes through play(), which carries the global
 *    voice cap and debounce.
 * Nothing here schedules while paused, and rhythms use a clamped speed so 10×/60× never turn into a drum roll.
 */
const VEHICLE_SLOTS = 4;
const BOAT_SLOTS = 2;
const HEAR_VEHICLE = 110;
const HEAR_BOAT = 120;
const HEAR_ANIMAL = 130;

interface Deps {
  ac: AudioContext;
  kit: SynthKit;
  /** ambience bus (into master) */
  amb: GainNode;
  spatial(pos: THREE.Vector3): { gain: number; pan: number };
  play(cue: AudioCue, pos?: THREE.Vector3, volume?: number): void;
  loopNoise(buf: AudioBuffer, dest: AudioNode): AudioBufferSourceNode;
}

interface Emitter { id: string | null; gain: GainNode; pan: StereoPannerNode; rumble: GainNode; next: number; beat: number; kind: string }

const safe = <T,>(f: () => T, d: T): T => { try { return f() ?? d; } catch { return d; } };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const CRITTER_CUE: Partial<Record<CritterKind, { cue: AudioCue; gap: number; night?: boolean }>> = {
  sheep: { cue: 'sheep', gap: 3.5 }, cow: { cue: 'moo', gap: 7 }, duck: { cue: 'duck', gap: 4 }, goose: { cue: 'goose', gap: 6 },
  hen: { cue: 'hens', gap: 5 }, swan: { cue: 'swan', gap: 14 }, dog: { cue: 'dog', gap: 6, night: true }, crow: { cue: 'crow', gap: 5 },
  rook: { cue: 'crow', gap: 4 }, starling: { cue: 'birdsong', gap: 3 }, swallow: { cue: 'birdsong', gap: 5 }, horse: { cue: 'horse', gap: 12 },
  cat: { cue: 'meow', gap: 20, night: true },
};

export function createAmbience(ctx: Ctx, d: Deps) {
  const { ac, kit, amb } = d;
  const { layout, reg, clock } = ctx;
  const _p = new THREE.Vector3();

  // ── static points of interest ──
  const pubs = layout.buildings.filter((b) => b.kind === 'pub' || b.kind === 'inn');
  const smithies = layout.buildings.filter((b) => b.kind === 'smithy');
  const churches = layout.buildings.filter((b) => b.kind === 'church');
  const towerTop = (b: Building) => new THREE.Vector3(b.center.x, b.center.y + (b.tower?.h ?? b.size.y + b.roofH), b.center.z);
  const weir = layout.river.weir.pos.clone();
  const millWheel = layout.river.mill.wheel.clone();
  const windmill = safe(() => layout.landmarks.windmill.center.clone(), new THREE.Vector3(-250, 0, -122));

  // ── beds ──
  function bed(buf: AudioBuffer, chain: AudioNode[]): GainNode {
    const g = ac.createGain(); g.gain.value = 0;
    let head: AudioNode = chain[0] ?? g;
    for (let i = 0; i < chain.length - 1; i++) chain[i]!.connect(chain[i + 1]!);
    if (chain.length) chain[chain.length - 1]!.connect(g); else head = g;
    g.connect(amb);
    d.loopNoise(buf, head);
    return g;
  }
  const bq = (type: BiquadFilterType, f: number, Q = 0.7) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; return b; };
  // river: a low body plus a wobbling mid "burble"
  const riverLow = bed(kit.brown, [bq('lowpass', 650)]);
  const burbleBP = bq('bandpass', 1500, 1.1);
  const riverMid = bed(kit.noise, [burbleBP]);
  const burbleLfo = ac.createOscillator(); burbleLfo.frequency.value = 0.9;
  const burbleDepth = ac.createGain(); burbleDepth.gain.value = 500;
  burbleLfo.connect(burbleDepth).connect(burbleBP.frequency); burbleLfo.start();
  // weir: broad steady roar
  const weirBed = bed(kit.noise, [bq('bandpass', 900, 0.5), bq('lowpass', 3500)]);
  // rain rings on water: bright crackle over the river
  const rainWater = bed(kit.noise, [bq('highpass', 3800), bq('lowpass', 9000)]);
  // leaves: high rustle that swells with gusts
  const leaves = bed(kit.noise, [bq('highpass', 2200), bq('bandpass', 4200, 0.6)]);
  // pub murmur: voices through walls, with a slow swell
  const pubBP = bq('bandpass', 380, 1.3);
  const pubAM = ac.createGain(); pubAM.gain.value = 0.7;
  const pubLfo = ac.createOscillator(); pubLfo.frequency.value = 0.23;
  const pubLfoG = ac.createGain(); pubLfoG.gain.value = 0.3;
  pubLfo.connect(pubLfoG).connect(pubAM.gain); pubLfo.start();
  const pub = bed(kit.noise, [pubBP, pubAM]);
  const pan = new Map<GainNode, StereoPannerNode>();
  // re-route pubs and the weir through panners so they sit where they are
  for (const g of [weirBed, pub]) {
    const p = ac.createStereoPanner();
    g.disconnect(); g.connect(p).connect(amb);
    pan.set(g, p);
  }

  // ── emitter slots ──
  function mkEmitter(): Emitter {
    const gain = ac.createGain(); gain.gain.value = 0;
    const p = ac.createStereoPanner();
    gain.connect(p).connect(amb);
    const rumble = ac.createGain(); rumble.gain.value = 0;
    const lp = bq('lowpass', 240, 0.9);
    rumble.connect(lp).connect(gain);
    d.loopNoise(kit.brown, rumble);
    return { id: null, gain, pan: p, rumble, next: 0, beat: 0, kind: '' };
  }
  const vSlots = Array.from({ length: VEHICLE_SLOTS }, mkEmitter);
  const bSlots = Array.from({ length: BOAT_SLOTS }, mkEmitter);

  function assign<T extends { id: string; pos: THREE.Vector3 }>(slots: Emitter[], list: T[], hear: number, filter: (x: T) => boolean, t: number) {
    const f = ctx.view.focus;
    const near = list
      .filter(filter)
      .map((x) => ({ x, dd: Math.hypot(x.pos.x - f.x, x.pos.z - f.z) }))
      .filter((e) => e.dd < hear)
      .sort((a, b) => a.dd - b.dd)
      .slice(0, slots.length);
    const want = new Set(near.map((e) => e.x.id));
    for (const s of slots) if (s.id && !want.has(s.id)) { s.id = null; s.gain.gain.setTargetAtTime(0, t, 0.25); s.rumble.gain.setTargetAtTime(0, t, 0.25); }
    const out: { x: T; s: Emitter }[] = [];
    for (const e of near) {
      let s = slots.find((z) => z.id === e.x.id);
      if (!s) { s = slots.find((z) => !z.id); if (!s) continue; s.id = e.x.id; s.next = t + 0.05; s.beat = 0; }
      out.push({ x: e.x, s });
    }
    return out;
  }

  const paused = () => clock.paused || clock.timeScale === 0;
  /** keep rhythms plausible at 10×/60×: visual speed is sim speed × timeScale, but hooves never gallop past ~2× */
  const rhythmSpeed = (ms: number) => Math.abs(ms) * Math.min(Math.max(clock.timeScale, 0.01), 1.8);

  function updateVehicles(t: number) {
    const list = safe(() => reg.traffic.list(), [] as VehicleInfo[]);
    const active = assign(vSlots, list, HEAR_VEHICLE, (v) => v.state !== 'gone' && v.kind !== 'bicycle' && v.kind !== 'pennyfarthing' && (v.speed > 0.25 || v.kind === 'motorwagen'), t);
    for (const { x: v, s } of active) {
      const sp = d.spatial(v.pos);
      const speed = rhythmSpeed(v.speed);
      const lvl = paused() ? 0 : sp.gain;
      s.gain.gain.setTargetAtTime(lvl, t, 0.2);
      s.pan.pan.setTargetAtTime(sp.pan, t, 0.2);
      const onSetts = v.edge === 'FC' || safe(() => layout.towns.some((tn) => (tn.id === 'ashcombe' || tn.id === 'station') && Math.hypot(tn.center.x - v.pos.x, tn.center.z - v.pos.z) < 70), false);
      if (v.kind === 'motorwagen') {
        s.rumble.gain.setTargetAtTime(paused() ? 0 : 0.05 + speed * 0.02, t, 0.3);
        if (lvl < 0.01) continue;
        const rate = 5 + Math.min(7, speed * 1.4); // single cylinder: idles at ~5 beats/s
        if (s.next < t - 0.4) s.next = t;
        while (s.next < t + 0.15) { putt(kit, s.gain, s.next, 0.22 * (0.85 + Math.random() * 0.3)); s.next += 1 / rate * (0.9 + Math.random() * 0.2); }
        continue;
      }
      // wheels: iron tyres on stone rumble louder than on a dirt lane
      s.rumble.gain.setTargetAtTime(paused() || v.speed < 0.25 ? 0 : Math.min(0.5, speed * 0.07) * (onSetts ? 1.4 : 0.8), t, 0.3);
      if (lvl < 0.01 || v.speed < 0.25 || v.horses <= 0) continue;
      const trot = speed > 2.3;
      // walk: 4-beat ≈ 1.6 strides/s ; trot: 2-beat diagonal pairs ≈ 1.4 strides/s → clop interval
      const interval = trot ? 1 / (2 * (1.2 + speed * 0.08)) : 1 / (4 * (0.9 + speed * 0.3));
      if (s.next < t - 0.4) s.next = t;
      while (s.next < t + 0.15) {
        const accent = trot ? (s.beat % 2 === 0 ? 1 : 0.8) : (s.beat % 4 === 0 ? 1 : 0.65);
        const vol = 0.3 * accent * (onSetts ? 1 : 0.6);
        clop(kit, s.gain, s.next, vol, onSetts ? 0.8 : 0.25);
        for (let h = 1; h < Math.min(v.horses, 4); h++) clop(kit, s.gain, s.next + 0.03 + Math.random() * 0.05, vol * 0.7, onSetts ? 0.8 : 0.25);
        s.beat++;
        s.next += interval * (0.94 + Math.random() * 0.12);
      }
    }
    // an occasional snort or whinny from a horse standing near the view
    if (!paused() && Math.random() < 0.012) {
      const f = ctx.view.focus;
      const standing = list.filter((v) => v.horses > 0 && v.speed < 0.2 && v.state !== 'gone' && Math.hypot(v.pos.x - f.x, v.pos.z - f.z) < 70);
      const v = standing[Math.floor(Math.random() * standing.length)];
      if (v) d.play('horse', v.pos, 0.8);
    }
  }

  function updateBoats(t: number) {
    const list = safe(() => reg.nature.boats(), [] as BoatInfo[]);
    const active = assign(bSlots, list, HEAR_BOAT, (b) => b.state === 'underway' || b.state === 'inLock', t);
    for (const { x: b, s } of active) {
      const sp = d.spatial(b.pos);
      const lvl = paused() ? 0 : sp.gain;
      s.gain.gain.setTargetAtTime(lvl, t, 0.2);
      s.pan.pan.setTargetAtTime(sp.pan, t, 0.2);
      s.rumble.gain.setTargetAtTime(0, t, 0.3);
      if (lvl < 0.01 || b.state !== 'underway') continue;
      const ts = Math.min(Math.max(clock.timeScale, 0.01), 1.8);
      if (s.next < t - 0.5) s.next = t;
      if (b.kind === 'launch') {
        while (s.next < t + 0.15) { chuff(kit, s.gain, s.next, 0.12, 0.2); s.next += 1 / (3.2 * ts); }
      } else if (b.kind === 'rowing' || b.kind === 'gig4') {
        const period = (b.kind === 'gig4' ? 1.25 : 1.9) / ts;
        while (s.next < t + 0.15) { oarStroke(kit, s.gain, s.next, b.kind === 'gig4' ? 0.45 : 0.35); s.next += period * (0.95 + Math.random() * 0.1); }
      } else if (b.kind === 'narrowboat') {
        // the towing horse plods along the towpath
        while (s.next < t + 0.15) { clop(kit, s.gain, s.next, 0.16, 0.2); s.next += (0.42 / ts) * (0.9 + Math.random() * 0.2); }
      } else {
        while (s.next < t + 0.15) { s.next += 3 / ts; d.play('water', b.pos, 0.4); }
      }
    }
  }

  // ── sporadic life ──
  const lastKind: Partial<Record<string, number>> = {};
  let nextAnimal = 0, nextForge = 0, nextWindmill = 0, nextMill = 0, nextRook = 0;

  function updateAnimals(now: number) {
    if (now < nextAnimal || paused()) return;
    nextAnimal = now + 900 + Math.random() * 2200;
    const f = ctx.view.focus;
    const night = safe(() => reg.atmosphere.nightFactor, 0) > 0.6;
    const list = safe(() => reg.nature.list(), [] as CritterInfo[]);
    const near = list.filter((a) => {
      const m = CRITTER_CUE[a.kind];
      if (!m || (night && !m.night)) return false;
      return Math.abs(a.pos.x - f.x) < HEAR_ANIMAL && Math.abs(a.pos.z - f.z) < HEAR_ANIMAL;
    });
    if (near.length) {
      const a = near[Math.floor(Math.random() * near.length)]!;
      const m = CRITTER_CUE[a.kind]!;
      if (now - (lastKind[a.kind] ?? -1e9) > m.gap * 1000) {
        lastKind[a.kind] = now;
        d.play(m.cue, a.pos, /scare|flee|bolt/.test(a.state) ? 1 : 0.8);
      }
      return;
    }
    // no critters yet (nature still settling in): rooks over the fields by day, away from the station
    if (!list.length && !night && now > nextRook && Math.hypot(f.x - 40, f.z) > 140) {
      nextRook = now + 6000 + Math.random() * 9000;
      _p.set(f.x + (Math.random() - 0.5) * 120, 12, f.z + (Math.random() - 0.5) * 120);
      d.play('crow', _p, 0.5);
    }
  }

  function updateTownLife(now: number) {
    if (paused()) return;
    const h = clock.hour, wd = clock.weekday;
    const f = ctx.view.focus;
    // the smithies ring by day, Monday to Saturday
    if (now > nextForge) {
      nextForge = now + 2600 + Math.random() * 3800;
      if (wd < 6 && h >= 7 && h < 18) {
        const s = smithies.find((b) => Math.hypot(b.center.x - f.x, b.center.z - f.z) < 150);
        if (s) d.play('forge', s.doors[0] ?? s.center, 0.9);
      }
    }
    // the post mill creaks while its sails turn
    if (now > nextWindmill) {
      nextWindmill = now + 3500 + Math.random() * 3000;
      const rpm = safe(() => reg.world.mills().windmillRpm, ctx.wind.speed > 2 && !(wd === 6) ? 1 : 0);
      if (rpm > 0.1 && Math.hypot(windmill.x - f.x, windmill.z - f.z) < 140) d.play('mill', windmill, 0.6);
    }
    // the mill wheel sloshes
    if (now > nextMill) {
      nextMill = now + 1600 + Math.random() * 600;
      const rpm = safe(() => reg.world.mills().waterwheelRpm, h >= 6 && h < 19 ? 1 : 0);
      if (rpm > 0.1 && Math.hypot(millWheel.x - f.x, millWheel.z - f.z) < 110) d.play('mill', millWheel, 0.7);
    }
  }

  function updateBeds(t: number) {
    const f = ctx.view.focus;
    const zoom = ctx.view.zoom;
    const hear = 70 / Math.max(0.5, Math.min(2.5, zoom)); // zoomed-in listeners are "closer"
    const atm = safe(() => reg.atmosphere, null);
    const ice = Math.max(atm?.iceAmount ?? 0, safe(() => reg.nature.river.ice, 0));
    const rain = atm?.rain ?? 0;
    const rd = safe(() => layout.terrain.riverDist(f.x, f.z), 60);
    const pr = clamp01(1 - Math.max(0, rd) / hear) * (1 - 0.85 * ice);
    const spate = 1 + clamp01((atm?.wetness ?? 0) - 0.5) * 0.8;
    riverLow.gain.setTargetAtTime(pr * 0.16 * spate, t, 0.6);
    riverMid.gain.setTargetAtTime(pr * 0.045 * spate, t, 0.6);
    burbleLfo.frequency.setTargetAtTime(0.6 + Math.random() * 0.8, t, 1.5);
    rainWater.gain.setTargetAtTime(pr * Math.min(1, rain) * 0.07 * (1 - (atm?.snow ?? 0)), t, 0.8);
    // weir roar (and a little of the lock sluices)
    const ws = d.spatial(weir);
    const wd = Math.hypot(weir.x - f.x, weir.z - f.z);
    weirBed.gain.setTargetAtTime(clamp01(1 - wd / 180) * ws.gain * 0.12 * (1 - 0.7 * ice) * spate, t, 0.6);
    pan.get(weirBed)!.pan.setTargetAtTime(ws.pan, t, 0.4);
    // leaves: wind strength at the focus, swelling with gusts; quieter over the open station yard
    const w = safe(() => ctx.wind.sample(f.x, f.z), { strength: ctx.wind.speed / 12, gust: 0.5, dir: new THREE.Vector2() });
    const gust = clamp01(w.gust);
    const trees = Math.hypot(f.x - 30, f.z + 10) < 60 ? 0.45 : 1;
    const leafAmt = clamp01(w.strength) * (0.35 + 0.65 * gust) * trees * (1 - (atm?.snow ?? 0) * 0.6);
    leaves.gain.setTargetAtTime(leafAmt * 0.05, t, 0.35);
    // pub murmur: evening, strongest 19:30–22:30, from the nearest pub within earshot
    const h = clock.hour;
    const evening = h >= 17.5 && h < 23.2 ? clamp01(Math.min((h - 17.5) / 1.5, (23.2 - h) / 0.6)) : h >= 12 && h < 14 ? 0.35 : 0;
    let best: Building | null = null, bd = Infinity;
    for (const p of pubs) { const dd = Math.hypot(p.center.x - f.x, p.center.z - f.z); if (dd < bd) { bd = dd; best = p; } }
    if (best && bd < 120 && evening > 0) {
      const sp = d.spatial(best.center);
      pub.gain.setTargetAtTime(evening * sp.gain * 0.09, t, 0.8);
      pan.get(pub)!.pan.setTargetAtTime(sp.pan, t, 0.6);
      if (evening > 0.6 && Math.random() < 0.01) d.play('shout', best.doors[0] ?? best.center, 0.35); // a laugh / call from the bar
    } else pub.gain.setTargetAtTime(0, t, 0.8);
  }

  // ── bells ──
  let lastTownBellHour = -1;
  function nearestChurch(): Building | null {
    const f = ctx.view.focus;
    let best: Building | null = null, bd = Infinity;
    for (const c of churches) { const dd = Math.hypot(c.center.x - f.x, c.center.z - f.z); if (dd < bd) { bd = dd; best = c; } }
    return best;
  }
  function churchOf(town: string): Building | null { return churches.find((c) => c.town === town) ?? nearestChurch(); }
  function strike(church: Building, n: number, gap = 2.3) {
    const pos = towerTop(church);
    for (let i = 0; i < n; i++) setTimeout(() => d.play('townBell', pos, 0.9), i * gap * 1000);
  }
  ctx.bus.on('town:bell', (e) => {
    const c = churchOf(e.town);
    if (!c) return;
    if (e.kind === 'hour') { lastTownBellHour = Math.floor(clock.hour); strike(c, Math.min(12, (Math.floor(clock.hour) % 12) || 12)); }
    else if (e.kind === 'alarm') strike(c, 10, 0.6);
    else { d.play('churchPeal', towerTop(c), 1); setTimeout(() => d.play('churchPeal', towerTop(c), 1), 5200); }
  });
  let lastPealDay = -1;
  ctx.bus.on('time:hour', (e) => {
    // fallback: if no system rang the town bell for this hour, the nearest church answers the station clock
    setTimeout(() => {
      if (lastTownBellHour === e.hour || clock.timeScale > 12) return;
      const c = nearestChurch();
      if (c && Math.hypot(c.center.x - ctx.view.focus.x, c.center.z - ctx.view.focus.z) < 260) strike(c, Math.min(4, (e.hour % 12) || 12));
    }, 7000);
  });

  // ── level crossing ──
  ctx.bus.on('crossing:state', (e) => {
    const lc = layout.crossings.find((c) => c.id === e.id);
    const pos = lc?.center;
    if (e.state === 'closing') { d.play('crossingBell', pos, 1); setTimeout(() => d.play('gate', pos, 1), 1800); }
    else if (e.state === 'opening') d.play('gate', pos, 0.9);
  });

  return {
    update(nowMs: number) {
      const t = ac.currentTime;
      updateBeds(t);
      updateVehicles(t);
      updateBoats(t);
      updateAnimals(nowMs);
      updateTownLife(nowMs);
      // Sunday peal for morning service at 10:15
      if (clock.weekday === 6 && clock.hour >= 10.25 && clock.hour < 10.45 && lastPealDay !== clock.day && clock.timeScale <= 12) {
        lastPealDay = clock.day;
        const c = nearestChurch();
        if (c) for (let i = 0; i < 3; i++) setTimeout(() => d.play('churchPeal', towerTop(c), 1), i * 5200);
      }
    },
    /** debug: bed and slot levels */
    state() {
      return {
        river: riverLow.gain.value, weir: weirBed.gain.value, leaves: leaves.gain.value, pub: pub.gain.value, rainWater: rainWater.gain.value,
        vehicles: vSlots.map((s) => s.id), boats: bSlots.map((s) => s.id),
      };
    },
  };
}
