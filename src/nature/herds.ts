import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { Field, Building } from '../core/layout';
import type { InstancedRig } from '../core/rig';
import { HORSE_STRIDE } from '../core/rigs/horse';
import type { Rng } from '../core/rng';
import { QUAD } from './rigs';
import { Registry, type Critter, Ticker, insideField, polyCentroid, randomInField, roadWalk, Path } from './life';
import { TAU, clamp, clamp01, lerp, turnToward, wrapPi, yawOf, hash1, type Drawer } from './util';

/**
 * LIVESTOCK & DOGS: grazing sheep (Wyke Down, Eastcote Down), cows (Kingsmead water meadow, milked twice a day at
 * Millbridge Dairy — they walk there along Millbridge Lane and in through the byre door), paddock horses, village
 * dogs (in and out of their own cottage doors) and drovers' flocks moved along the roads with a collie (herd()).
 * Every beast is always subtly alive: CPU drives grazing/steps/lying/fleeing, the shader adds breathing, tail
 * swish, ear flicks and head sway.
 */
type BeastKind = 'sheep' | 'cow' | 'horse' | 'dog';
type BState = 'graze' | 'walk' | 'look' | 'lie' | 'flee' | 'trip' | 'inside' | 'sit' | 'sniff' | 'follow';

interface Beast {
  c: Critter;
  kind: BeastKind;
  x: number; z: number; y: number; yaw: number;
  speed: number; phase: number; amp: number;
  state: BState; timer: number; stepT: number;
  tx: number; tz: number; tSpeed: number;
  head: number; headT: number; lie: number; lieT: number; turn: number; turnT: number; tail: number; sit: number; sitT: number;
  pushX: number; pushZ: number;
  field: FieldGroup | null;
  ticker: Ticker;
  // trips (dairy, herding)
  trip: Trip | null; rank: number; latOff: number;
  // horse
  stampLeg: number; stampPh: number; nod: number;
  // dog
  home: DogHome | null; walk: Path | null; walkD: number; next: 'sniff' | 'home' | 'sit' | null;
  colors: number[];
  scale: number;
}

interface FieldGroup { field: Field; kind: BeastKind; members: Beast[]; cx: number; cz: number }
interface Trip {
  kind: 'dairyOut' | 'dairyBack' | 'herd';
  path: Path;
  members: Beast[];
  leaderD: number;
  speed: number;
  spacing: number;
  /** at the end: join a field, go inside a door, or leave by a portal */
  end: { type: 'field'; group: FieldGroup } | { type: 'door' | 'portal'; pos: THREE.Vector3; label: string };
  dog: Beast | null;
  drover: string | null;
  droverTimer: number;
  done: (ok: boolean) => void;
  tag?: string;
  edgeHint: string;
  finished: boolean;
}
interface DogHome { building: Building; door: THREE.Vector3; inside: THREE.Vector3; originId: string; town: string }

export interface Herds {
  update(dtMotion: number, dt: number): void;
  sync(DQ: Drawer, DH: Drawer): void;
  scare(pos: THREE.Vector3, r: number): void;
  herd(kind: 'sheep' | 'cows', from: string, to: string, opts?: { count?: number; dog?: boolean; tag?: string }): Promise<boolean>;
  /** road stretches occupied by herds (for traffic) */
  roadBlocks(): { x: number; z: number; r: number }[];
  nearestCueTarget(kind: BeastKind): THREE.Vector3 | null;
  debug(): unknown;
}

const SHEEP_WOOL = [0xe9e3d2, 0xe2dac6, 0xd9d0bb, 0xefe9da];
const COW_COATS: [number, number][] = [[0x8a4a2e, 0xece4d4], [0xa8784a, 0x6a4a2e], [0x2e2a28, 0xeae6de], [0x7a3a24, 0x7a3a24], [0xb88a5a, 0xefe6d6]];
const HORSE_COATS = [0x6a4a2e, 0x3a2a20, 0x8a6a4a, 0x9a9690, 0x2a2420, 0xb08a58];
const STRIDE: Record<BeastKind, number> = { sheep: 0.9, cow: 1.4, horse: HORSE_STRIDE.walk, dog: 0.75 };
const WALK: Record<BeastKind, number> = { sheep: 0.55, cow: 0.75, horse: 1.0, dog: 1.1 };

export function createHerds(ctx: Ctx, reg: Registry, quad: InstancedRig, horses: InstancedRig, rng: Rng): Herds {
  const L = ctx.layout, K = ctx.quality.knobs;
  const beasts: Beast[] = [];
  const groups: FieldGroup[] = [];
  const trips: Trip[] = [];
  const rnd = () => rng.next();
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const nearR = K.lifeNearRadius;

  const rigOf = (k: BeastKind) => (k === 'horse' ? horses : quad);
  const mkBeast = (kind: BeastKind, x: number, z: number, label: string, group?: string): Beast | null => {
    const rig = rigOf(kind);
    const slot = rig.alloc();
    if (slot < 0) return null;
    const y = L.heightAt(x, z);
    const c = reg.add(kind, tmp.set(x, y, z), label, group, kind === 'cow' ? 1.3 : kind === 'horse' ? 1.4 : kind === 'dog' ? 0.6 : 0.8);
    c.slot = slot; c.rig = rig;
    let colors: number[];
    if (kind === 'sheep') { const black = rnd() < 0.06; colors = [black ? 0x3a3430 : rng.pick(SHEEP_WOOL), rnd() < 0.3 ? 0xd8cfc0 : 0x2c2622, 0x2c2622, 0xffffff]; }
    else if (kind === 'cow') { const cc = rng.pick(COW_COATS); colors = [cc[0], cc[1], 0x3a302a, 0xd8a0a0]; }
    else if (kind === 'horse') { const coat = rng.pick(HORSE_COATS); colors = [coat, rnd() < 0.5 ? 0x2a2018 : coat, 0x3a3028, coat]; }
    else colors = [0x222020, 0xeee8dc, 0x222020, 0x222020];
    rig.setColors(slot, colors);
    const b: Beast = {
      c, kind, x, z, y, yaw: rnd() * TAU, speed: 0, phase: rnd() * TAU, amp: 0,
      state: 'graze', timer: 5 + rnd() * 20, stepT: rnd() * 4, tx: x, tz: z, tSpeed: 0,
      head: 1, headT: 1, lie: 0, lieT: 0, turn: 0, turnT: 0, tail: 0, sit: 0, sitT: 0, pushX: 0, pushZ: 0,
      field: null, ticker: new Ticker(), trip: null, rank: 0, latOff: 0,
      stampLeg: 0, stampPh: 0, nod: 0, home: null, walk: null, walkD: 0, next: null, colors,
      scale: kind === 'sheep' ? 0.92 + rnd() * 0.16 : kind === 'cow' ? 0.94 + rnd() * 0.1 : kind === 'horse' ? 0.95 + rnd() * 0.08 : 1,
    };
    beasts.push(b);
    return b;
  };
  const freeBeast = (b: Beast) => {
    b.c.rig?.free(b.c.slot);
    b.c.slot = -1;
    reg.remove(b.c);
    const i = beasts.indexOf(b);
    if (i >= 0) beasts.splice(i, 1);
    if (b.field) { const j = b.field.members.indexOf(b); if (j >= 0) b.field.members.splice(j, 1); b.field = null; }
  };

  // ── populate fields (warm start: exempt from the audit) ──
  const addGroup = (fid: string, kind: BeastKind, n: number) => {
    const f = L.fields.find((q) => q.id === fid);
    if (!f || n <= 0) return;
    const cen = polyCentroid(f.poly);
    const g: FieldGroup = { field: f, kind, members: [], cx: cen.x, cz: cen.y };
    groups.push(g);
    // flocks start in 1–3 loose clusters
    const clusters = kind === 'sheep' ? 2 : 1;
    const cc: THREE.Vector2[] = [];
    for (let k = 0; k < clusters; k++) cc.push(randomInField(f.poly, 6, rnd));
    for (let i = 0; i < n; i++) {
      const c0 = cc[i % clusters];
      const sep = kind === 'sheep' ? 1.5 : 3;
      let x = 0, z = 0;
      for (let tries = 0; tries < 8; tries++) {
        x = c0.x + (rnd() - 0.5) * (12 + tries * 2); z = c0.y + (rnd() - 0.5) * (12 + tries * 2);
        if (!insideField(f.poly, x, z, 2)) { const p = randomInField(f.poly, 3, rnd); x = p.x; z = p.y; }
        if (g.members.every((m) => Math.hypot(m.x - x, m.z - z) > sep)) break;
      }
      const b = mkBeast(kind, x, z, `${kind === 'sheep' ? 'Sheep' : kind === 'cow' ? 'Cow' : 'Horse'} · ${f.name}`, f.id);
      if (!b) break;
      b.field = g;
      g.members.push(b);
    }
  };
  const sheepN = K.caps.sheep;
  addGroup('FB', 'sheep', Math.round(sheepN * 0.58));
  addGroup('FH', 'sheep', Math.round(sheepN * 0.42));
  addGroup('FE', 'cow', Math.min(K.caps.cows, 9));
  addGroup('FK', 'horse', 3);

  // ── village dogs ──
  const dogHomes: DogHome[] = [];
  const pickHome = (townId: string, prefer: string[]) => {
    const t = L.towns.find((q) => q.id === townId);
    if (!t) return;
    const b = t.buildings.find((q) => prefer.includes(q.kind) && q.doors.length);
    if (!b) return;
    const originId = `nature:dog:${b.id}`;
    const door = b.doors[0].clone(), inside = b.doorsIn[0].clone();
    ctx.origins.add({ id: originId, kind: 'door', owner: 'nature', pos: (o) => o.copy(door), inside: (o) => o.copy(inside), radius: 2.2, for: ['animals'], open: () => true, building: b.id });
    dogHomes.push({ building: b, door, inside, originId, town: townId });
  };
  pickHome('coldharbour', ['farmhouse']);
  pickHome('millbridge', ['cottage']);
  pickHome('ashcombe', ['police', 'cottage']);
  pickHome('wyke', ['farmhouse', 'cottage']);
  const dogs: Beast[] = [];
  for (let i = 0; i < Math.min(K.caps.dogs, dogHomes.length); i++) {
    const h = dogHomes[i];
    const b = mkBeast('dog', h.inside.x, h.inside.z, i === 0 ? 'Farm collie · Coldharbour' : `Village dog · ${L.towns.find((t) => t.id === h.town)?.name ?? ''}`);
    if (!b) break;
    b.home = h;
    b.state = 'inside';
    b.c.away = true;
    b.timer = 5 + rnd() * 40;
    b.colors = i % 2 ? [0x6a4a2a, 0xe0d0b0, 0x2a2018, 0x6a4a2a] : b.colors;
    quad.setColors(b.c.slot, b.colors);
    dogs.push(b);
  }
  reg.invalidate();

  // ── helpers ──
  const hour = () => ctx.clock.hour;
  const lieChance = () => { const h = hour(); return h > 11.5 && h < 14.5 ? 0.35 : h > 21 || h < 5 ? 0.7 : 0.07; };
  const setWalk = (b: Beast, x: number, z: number, speed: number) => { b.tx = x; b.tz = z; b.tSpeed = speed; b.state = 'walk'; };
  const nextIdle = (b: Beast) => {
    const r = rnd();
    const f = b.field;
    if (b.kind !== 'dog' && r < lieChance()) { b.state = 'lie'; b.timer = 60 + rnd() * 240; b.lieT = 1; b.headT = 0.1; return; }
    b.lieT = 0;
    if (r < 0.55) { b.state = 'graze'; b.timer = 8 + rnd() * 30; b.headT = 1; return; }
    if (r < 0.75) { b.state = 'look'; b.timer = 2 + rnd() * 5; b.headT = -0.1 + rnd() * 0.2; b.turnT = (rnd() - 0.5) * 1.6; return; }
    if (f) {
      // wander: toward the group (cohesion) or a fresh patch
      let x: number, z: number;
      if (rnd() < 0.6 && f.members.length > 1) { x = f.cx + (rnd() - 0.5) * 14; z = f.cz + (rnd() - 0.5) * 14; }
      else { const p = randomInField(f.field.poly, 3, rnd); x = p.x; z = p.y; }
      if (!insideField(f.field.poly, x, z, 2.5)) { x = f.cx; z = f.cz; }
      // a playful trot for horses now and then
      const play = b.kind === 'horse' && rnd() < 0.2 && hour() > 7 && hour() < 19;
      setWalk(b, x, z, play ? 3.2 : WALK[b.kind]);
      b.headT = b.kind === 'sheep' && !play ? 0.55 : 0;
      return;
    }
    b.state = 'graze'; b.timer = 10;
  };

  // walk b toward (tx, tz); returns true on arrival
  const moveToward = (b: Beast, dt: number, tx: number, tz: number, speed: number): boolean => {
    const dx = tx - b.x, dz = tz - b.z, d = Math.hypot(dx, dz);
    const want = d > 0.25 ? speed : 0;
    b.speed += (want - b.speed) * Math.min(1, dt * 2.5);
    if (d > 0.05) b.yaw = turnToward(b.yaw, yawOf(dx, dz), dt * (b.kind === 'dog' ? 5 : 2.2));
    const fwd = Math.max(0, Math.cos(wrapPi(yawOf(dx, dz) - b.yaw)));
    const step = Math.min(d, b.speed * dt * (0.35 + 0.65 * fwd));
    const nx = b.x + Math.cos(b.yaw) * step, nz = b.z - Math.sin(b.yaw) * step;
    b.x = nx; b.z = nz;
    b.phase += (step / STRIDE[b.kind]) * TAU;
    return d < 0.4;
  };

  // ── group upkeep (2 Hz): centroids + separation ──
  let groupT = 0;
  const upkeep = () => {
    for (const g of groups) {
      let sx = 0, sz = 0, n = 0;
      for (const m of g.members) if (m.state !== 'trip') { sx += m.x; sz += m.z; n++; }
      if (n) { g.cx = sx / n; g.cz = sz / n; }
      const sep = g.kind === 'sheep' ? 1.2 : g.kind === 'cow' ? 2.4 : 3;
      for (const a of g.members) {
        a.pushX = 0; a.pushZ = 0;
        if (a.state === 'trip') continue;
        for (const o of g.members) {
          if (o === a) continue;
          const dx = a.x - o.x, dz = a.z - o.z, d = Math.hypot(dx, dz);
          if (d < sep && d > 1e-3) { a.pushX += (dx / d) * (sep - d); a.pushZ += (dz / d) * (sep - d); }
        }
        // loose cohesion: stray sheep drift back
        const dc = Math.hypot(g.cx - a.x, g.cz - a.z);
        if (g.kind === 'sheep' && dc > 14) { a.pushX += (g.cx - a.x) / dc * 0.4; a.pushZ += (g.cz - a.z) / dc * 0.4; }
      }
    }
  };

  // ── per-beast step ──
  const stepBeast = (b: Beast, dt: number) => {
    const f = b.field;
    const px = b.x, pz = b.z;
    switch (b.state) {
      case 'graze': {
        b.headT = 1;
        b.stepT -= dt;
        if (b.stepT <= 0) {
          // shuffle a pace or two while cropping the grass
          b.stepT = 2 + rnd() * 5;
          const a = b.yaw + (rnd() - 0.5) * 1.2;
          const d = 0.5 + rnd() * 1.2;
          b.tx = b.x + Math.cos(a) * d; b.tz = b.z - Math.sin(a) * d;
        }
        if (Math.hypot(b.tx - b.x, b.tz - b.z) > 0.3) moveToward(b, dt, b.tx, b.tz, 0.35); else b.speed *= 0.8;
        b.timer -= dt;
        if (b.timer <= 0) nextIdle(b);
        break;
      }
      case 'look': b.speed *= 0.8; b.timer -= dt; if (b.timer <= 0) { b.turnT = 0; nextIdle(b); } break;
      case 'lie': {
        b.speed = 0;
        b.timer -= dt;
        if (rnd() < dt * 0.08) { b.turnT = (rnd() - 0.5) * 1.4; b.headT = rnd() < 0.3 ? 0.4 : 0; }
        if (b.timer <= 0) { b.lieT = 0; b.turnT = 0; if (b.lie < 0.1) nextIdle(b); else b.timer = 1; }
        break;
      }
      case 'walk': {
        b.lieT = 0;
        if (b.lie > 0.2) { b.speed = 0; break; }
        if (moveToward(b, dt, b.tx, b.tz, b.tSpeed)) { b.state = 'graze'; b.timer = 6 + rnd() * 20; b.headT = 1; }
        break;
      }
      case 'flee': {
        b.lieT = 0;
        b.timer -= dt;
        moveToward(b, dt, b.tx, b.tz, b.tSpeed);
        if (b.timer <= 0) { b.state = 'look'; b.timer = 3 + rnd() * 4; b.headT = -0.2; }
        break;
      }
      default: break;
    }
    // separation drift (field animals)
    if (f && b.state !== 'trip') {
      b.x += clamp(b.pushX, -1, 1) * dt * 0.5;
      b.z += clamp(b.pushZ, -1, 1) * dt * 0.5;
      if (!insideField(f.field.poly, b.x, b.z, 1.6) && insideField(f.field.poly, px, pz, 1.6)) {
        b.x = px; b.z = pz;
        if (b.state === 'walk' || b.state === 'flee' || b.state === 'graze') { b.tx = f.cx + (rnd() - 0.5) * 6; b.tz = f.cz + (rnd() - 0.5) * 6; b.yaw = turnToward(b.yaw, yawOf(b.tx - b.x, b.tz - b.z), 0.6); }
      }
    }
  };

  // ── dogs ──
  const dogTargets = (h: DogHome): THREE.Vector3[] => {
    const t = L.towns.find((q) => q.id === h.town);
    const out: THREE.Vector3[] = [];
    if (t) {
      for (const b of t.buildings) if (b.doors.length && b !== h.building) out.push(b.doors[0]);
      for (const a of t.areas) out.push(a.center);
    }
    for (const f of L.fields) if (Math.hypot(f.gate.x - h.door.x, f.gate.z - h.door.z) < 90) out.push(f.gate);
    return out;
  };
  const dogWalk = (b: Beast, to: THREE.Vector3, next: Beast['next']) => {
    let pts: THREE.Vector3[];
    try { pts = L.footPath(tmp.set(b.x, b.y, b.z), to); } catch { pts = []; }
    if (pts.length < 2) pts = [new THREE.Vector3(b.x, b.y, b.z), to.clone()];
    b.walk = new Path(pts);
    b.walkD = 0;
    b.state = 'follow';
    b.next = next;
    b.tSpeed = rnd() < 0.5 ? 1.9 : 1.2;
  };
  const stepDog = (b: Beast, dt: number) => {
    const h = b.home!;
    switch (b.state) {
      case 'inside': {
        b.timer -= dt;
        const night = hour() > 21.5 || hour() < 6;
        if (b.timer <= 0 && !night && ctx.reg.atmosphere?.weather !== 'storm') {
          // out through the door
          b.x = h.door.x; b.z = h.door.z; b.y = h.door.y;
          ctx.origins.audit('nature', 'spawn', 'animals', tmp.set(b.x, b.y, b.z), 'dog');
          b.c.away = false; reg.invalidate();
          b.yaw = yawOf(h.door.x - h.inside.x, h.door.z - h.inside.z);
          const tg = dogTargets(h);
          dogWalk(b, tg.length ? tg[Math.floor(rnd() * tg.length)] : h.door, 'sniff');
        } else if (b.timer <= 0) b.timer = 30 + rnd() * 60;
        break;
      }
      case 'follow': {
        const w = b.walk!;
        const spd = b.tSpeed;
        b.walkD = Math.min(w.length, b.walkD + spd * dt);
        w.at(b.walkD, tmp);
        const dx = tmp.x - b.x, dz = tmp.z - b.z, d = Math.hypot(dx, dz);
        if (d > 0.02) b.yaw = turnToward(b.yaw, yawOf(dx, dz), dt * 6);
        b.phase += (d / STRIDE.dog) * TAU;
        b.speed = d / Math.max(1e-3, dt);
        b.x = tmp.x; b.z = tmp.z;
        b.headT = spd < 1.5 ? 0.35 : 0;
        if (b.walkD >= w.length - 0.05) {
          b.walk = null;
          if (b.next === 'home') {
            ctx.origins.audit('nature', 'despawn', 'animals', tmp.set(b.x, b.y, b.z), 'dog');
            b.state = 'inside'; b.c.away = true; reg.invalidate();
            b.timer = 40 + rnd() * 120;
          } else if (b.next === 'sit') { b.state = 'sit'; b.timer = 8 + rnd() * 20; b.sitT = 1; }
          else { b.state = 'sniff'; b.timer = 6 + rnd() * 14; b.tx = b.x; b.tz = b.z; }
        }
        break;
      }
      case 'sniff': {
        b.headT = 0.8;
        b.stepT -= dt;
        if (b.stepT <= 0) { b.stepT = 0.8 + rnd() * 2; const a = rnd() * TAU; b.tx = b.x + Math.cos(a) * 1.5; b.tz = b.z - Math.sin(a) * 1.5; }
        moveToward(b, dt, b.tx, b.tz, 0.7);
        b.timer -= dt;
        if (b.timer <= 0) {
          const r = rnd();
          if (r < 0.3) { b.state = 'sit'; b.timer = 6 + rnd() * 16; b.sitT = 1; }
          else if (r < 0.65) { const tg = dogTargets(h); dogWalk(b, tg[Math.floor(rnd() * tg.length)] ?? h.door, 'sniff'); }
          else dogWalk(b, h.door, 'home');
          if (rnd() < 0.25) ctx.bus.emit('audio:cue', { cue: 'dog', pos: new THREE.Vector3(b.x, b.y, b.z), volume: 0.5 });
        }
        break;
      }
      case 'sit': {
        b.speed = 0; b.headT = rnd() < dt * 0.3 ? -0.3 : b.headT;
        if (rnd() < dt * 0.4) b.turnT = (rnd() - 0.5) * 1.6;
        b.timer -= dt;
        if (b.timer <= 0) { b.sitT = 0; b.turnT = 0; if (b.sit < 0.1) { const r = rnd(); if (r < 0.5) dogWalk(b, h.door, 'home'); else { const tg = dogTargets(h); dogWalk(b, tg[Math.floor(rnd() * tg.length)] ?? h.door, 'sniff'); } } else b.timer = 0.5; }
        break;
      }
      case 'flee': { b.timer -= dt; moveToward(b, dt, b.tx, b.tz, 2.5); if (b.timer <= 0) dogWalk(b, h.door, 'home'); break; }
      default: break;
    }
  };

  // ── trips (dairy + herding) ──
  const startTrip = (t: Trip) => {
    trips.push(t);
    t.members.forEach((m, i) => { m.trip = t; m.state = 'trip'; m.rank = i; m.latOff = (rnd() - 0.5) * (t.kind === 'herd' ? 3.2 : 0.8); m.lieT = 0; });
    if (t.dog) { t.dog.trip = t; t.dog.state = 'trip'; t.dog.sitT = 0; }
  };
  const endTrip = (t: Trip, ok: boolean) => {
    if (t.finished) return;
    t.finished = true;
    const i = trips.indexOf(t);
    if (i >= 0) trips.splice(i, 1);
    if (t.dog) {
      const d = t.dog;
      d.trip = null;
      if (d.home) dogWalk(d, d.home.door, 'home');
      else {
        // a drover's collie leaves the way it came
        d.state = 'inside';
      }
    }
    if (t.drover) { try { void ctx.reg.people?.dismissActor(t.drover); } catch { /* people missing */ } }
    t.done(ok);
  };
  const stepTrip = (t: Trip, dt: number) => {
    // leader advances; waits for stragglers
    let tail = Infinity;
    for (const m of t.members) if (m.trip === t) tail = Math.min(tail, (m as Beast & { tripD?: number }).tripD ?? 0);
    const spread = t.leaderD - (Number.isFinite(tail) ? tail : t.leaderD);
    const maxSpread = t.spacing * t.members.length * 0.6 + 12;
    const blocked = spread > maxSpread;
    if (!blocked) t.leaderD += t.speed * dt;
    let arrived = 0;
    for (const m of t.members) {
      if (m.trip !== t) { arrived++; continue; }
      const mm = m as Beast & { tripD?: number };
      const goalD = t.leaderD - m.rank * t.spacing / (t.kind === 'herd' ? 2.2 : 1);
      const cur = mm.tripD ?? 0;
      // walk along the path toward goalD (trot if far behind)
      const lag = goalD - cur;
      const v = lag > 6 ? WALK[m.kind] * 2.4 : lag > 1 ? WALK[m.kind] * 1.25 : lag > 0 ? WALK[m.kind] * 0.6 : 0;
      const nd = Math.min(t.path.length, cur + v * dt);
      mm.tripD = nd;
      if (m.c.away) {
        // still inside the byre / beyond the portal: appear only when it is this beast's turn to step out
        if (nd < 0) { t.path.at(0, tmp); m.x = tmp.x; m.z = tmp.z; m.yaw = t.path.yawAt(0.5); continue; }
        t.path.at(0, tmp);
        m.x = tmp.x; m.z = tmp.z;
        ctx.origins.audit('nature', 'spawn', 'animals', tmp, m.kind);
        m.c.away = false; reg.invalidate();
      }
      t.path.at(nd, tmp);
      const yaw = t.path.yawAt(nd);
      // lateral spread across the lane
      const lat = m.latOff;
      tmp.x += Math.sin(yaw) * lat; tmp.z += Math.cos(yaw) * lat;
      const dx = tmp.x - m.x, dz = tmp.z - m.z, d = Math.hypot(dx, dz);
      if (d > 0.02) m.yaw = turnToward(m.yaw, yawOf(dx, dz), dt * 3);
      const stepLen = Math.min(d, Math.max(v, 0.3) * dt * 1.6 + 0.02);
      if (d > 1e-4) { m.x += (dx / d) * stepLen; m.z += (dz / d) * stepLen; }
      m.phase += (stepLen / STRIDE[m.kind]) * TAU;
      m.speed = stepLen / Math.max(1e-3, dt);
      m.headT = m.speed < 0.2 ? (rnd() < 0.5 ? 1 : 0) : 0;
      if (nd >= t.path.length - 0.05 && t.leaderD >= t.path.length) {
        // reached the end of the route
        const e = t.end;
        if (e.type === 'field') {
          m.trip = null; m.field = e.group; if (!e.group.members.includes(m)) e.group.members.push(m);
          m.c.info.group = e.group.field.id;
          const p = randomInField(e.group.field.poly, 4, rnd);
          setWalk(m, p.x, p.y, WALK[m.kind]);
        } else {
          ctx.origins.audit('nature', 'despawn', 'animals', tmp.set(m.x, m.y, m.z), m.kind);
          m.trip = null; m.state = 'inside'; m.c.away = true; reg.invalidate();
          if (e.type === 'portal') { m.timer = -1; }
        }
        arrived++;
      }
    }
    // the collie works the flanks behind the flock
    if (t.dog) {
      const d = t.dog;
      const back = Math.max(0, (Number.isFinite(tail) ? tail : t.leaderD) - 4);
      t.path.at(back, tmp);
      const yaw = t.path.yawAt(back);
      const sweep = Math.sin(ctx.clock.minutes * 0.9 + d.c.slot) * 3.2;
      tmp.x += Math.sin(yaw) * sweep; tmp.z += Math.cos(yaw) * sweep;
      moveToward(d, dt, tmp.x, tmp.z, 2.4);
      d.headT = 0.2; d.tail = 0.6;
    }
    // drover follows behind (people walks him)
    if (t.drover) {
      t.droverTimer -= dt;
      if (t.droverTimer <= 0) {
        t.droverTimer = 6;
        const back = Math.max(0, (Number.isFinite(tail) ? tail : t.leaderD) - 6);
        try { void ctx.reg.people?.walkTo(t.drover, t.path.at(back, new THREE.Vector3()), { direct: true }); } catch { /* */ }
      }
    }
    if (arrived >= t.members.length) {
      // free portal-leavers
      for (const m of t.members) if (m.state === 'inside' && !m.home && m.timer === -1) freeBeast(m);
      for (const m of t.members.slice()) if (m.state === 'inside' && t.end.type === 'portal') freeBeast(m);
      endTrip(t, true);
    }
  };

  // ── dairy ──
  const dairy = L.buildings.find((b) => b.kind === 'dairy');
  const cowGroup = groups.find((g) => g.kind === 'cow');
  let dairyState: 'field' | 'out' | 'inside' | 'back' = 'field';
  let dairyTimer = 0;
  const insideCows: Beast[] = [];
  const dairyOut = () => {
    if (!dairy || !cowGroup || dairyState !== 'field' || !cowGroup.members.length) return;
    const members = cowGroup.members.slice().sort((a, b) => Math.hypot(a.x - cowGroup.field.gate.x, a.z - cowGroup.field.gate.z) - Math.hypot(b.x - cowGroup.field.gate.x, b.z - cowGroup.field.gate.z));
    const pts = roadWalk(ctx, cowGroup.field.gate, dairy.doors[0], -1.2);
    const path = new Path(pts);
    for (const m of members) { (m as Beast & { tripD?: number }).tripD = 0; m.field = null; }
    cowGroup.members.length = 0;
    dairyState = 'out';
    // cows first amble to the gate, then file along the lane
    for (const m of members) { (m as Beast & { tripD?: number }).tripD = -Math.hypot(m.x - cowGroup.field.gate.x, m.z - cowGroup.field.gate.z); }
    const trip: Trip = {
      kind: 'dairyOut', path, members, leaderD: 0, speed: 0.8, spacing: 3.4, dog: null, drover: null, droverTimer: 0, edgeHint: 'M', finished: false,
      end: { type: 'door', pos: dairy.doors[0], label: 'dairy' },
      done: () => { dairyState = 'inside'; dairyTimer = 45; insideCows.push(...members); },
    };
    startTrip(trip);
    try {
      const pp = ctx.reg.people;
      if (pp) { const r = pp.summonActor('dairymaid', cowGroup.field.gate.clone(), { timeoutMin: 60 }); trip.drover = r.id; }
    } catch { /* people not ready */ }
  };
  const dairyBack = () => {
    if (!dairy || !cowGroup || !insideCows.length) { dairyState = 'field'; return; }
    const pts = roadWalk(ctx, dairy.doors[0], cowGroup.field.gate, -1.2);
    const path = new Path(pts);
    const members = insideCows.splice(0);
    for (const m of members) {
      (m as Beast & { tripD?: number }).tripD = 0;
      m.x = dairy.doors[0].x; m.z = dairy.doors[0].z; m.y = dairy.doors[0].y;
    }
    dairyState = 'back';
    // they come out one at a time: stagger by making followers start "behind" the door
    members.forEach((m, i) => { (m as Beast & { tripD?: number }).tripD = -i * 3.4; m.c.away = true; });
    const trip: Trip = {
      kind: 'dairyBack', path, members, leaderD: 0, speed: 0.8, spacing: 3.4, dog: null, drover: null, droverTimer: 0, edgeHint: 'M', finished: false,
      end: { type: 'field', group: cowGroup },
      done: () => { dairyState = 'field'; },
    };
    startTrip(trip);
  };

  // ── herd() ──
  const resolvePlace = (id: string): { pos: THREE.Vector3; type: 'field' | 'door' | 'portal'; field?: Field; originId?: string } | null => {
    const f = L.fields.find((q) => q.id === id);
    if (f) return { pos: f.gate.clone().setY(L.heightAt(f.gate.x, f.gate.z)), type: 'field', field: f };
    const o = ctx.origins.get(id) ?? ctx.origins.get(`portal:${id}`) ?? ctx.origins.get(`door:${id}`);
    if (o) return { pos: o.pos(new THREE.Vector3()), type: o.kind === 'portal' ? 'portal' : 'door', originId: o.id };
    const p = L.portals.find((q) => q.id === id);
    if (p) return { pos: p.pos.clone(), type: 'portal', originId: `portal:${p.id}` };
    return null;
  };
  const herd: Herds['herd'] = (kind, from, to, opts) => new Promise<boolean>((resolve) => {
    const bk: BeastKind = kind === 'cows' ? 'cow' : 'sheep';
    const A = resolvePlace(from), B = resolvePlace(to);
    if (!A || !B) { resolve(false); return; }
    const count = opts?.count ?? (bk === 'sheep' ? 12 : 6);
    let members: Beast[] = [];
    if (A.type === 'field') {
      const g = groups.find((q) => q.field.id === A.field!.id && q.kind === bk);
      if (!g || !g.members.length) { resolve(false); return; }
      members = g.members.slice().sort((a, b) => Math.hypot(a.x - A.pos.x, a.z - A.pos.z) - Math.hypot(b.x - A.pos.x, b.z - A.pos.z)).slice(0, count);
      for (const m of members) { const j = g.members.indexOf(m); if (j >= 0) g.members.splice(j, 1); m.field = null; (m as Beast & { tripD?: number }).tripD = -Math.hypot(m.x - A.pos.x, m.z - A.pos.z); }
    } else {
      for (let i = 0; i < count; i++) {
        const b = mkBeast(bk, A.pos.x, A.pos.z, bk === 'sheep' ? "Drover's sheep" : "Drover's cow", opts?.tag);
        if (!b) break;
        (b as Beast & { tripD?: number }).tripD = -i * 1.2;
        b.c.away = true;
        members.push(b);
      }
      if (!members.length) { resolve(false); return; }
    }
    const pts = roadWalk(ctx, A.pos, B.pos, 0);
    const path = new Path(pts);
    let end: Trip['end'];
    if (B.type === 'field') {
      let g = groups.find((q) => q.field.id === B.field!.id && q.kind === bk);
      if (!g) { const cen = polyCentroid(B.field!.poly); g = { field: B.field!, kind: bk, members: [], cx: cen.x, cz: cen.y }; groups.push(g); }
      end = { type: 'field', group: g };
    } else end = { type: B.type, pos: B.pos, label: to };
    // collie: borrow the nearest village dog that is at home
    let dog: Beast | null = null;
    if (opts?.dog !== false) {
      let bd = Infinity;
      for (const d of dogs) {
        if (d.trip || d.state !== 'inside') continue;
        const dd = Math.hypot(d.home!.door.x - A.pos.x, d.home!.door.z - A.pos.z);
        if (dd < bd) { bd = dd; dog = d; }
      }
      if (dog && bd < 400) {
        dog.x = dog.home!.door.x; dog.z = dog.home!.door.z; dog.y = dog.home!.door.y;
        ctx.origins.audit('nature', 'spawn', 'animals', tmp.set(dog.x, dog.y, dog.z), 'dog');
        dog.c.away = false;
      } else dog = null;
    }
    const trip: Trip = {
      kind: 'herd', path, members, leaderD: 0, speed: bk === 'sheep' ? 0.85 : 0.75, spacing: bk === 'sheep' ? 1.3 : 3,
      end, dog, drover: null, droverTimer: 0, tag: opts?.tag, edgeHint: '', finished: false,
      done: (ok) => { ctx.bus.emit('animal:herded', { kind, to, tag: opts?.tag }); resolve(ok); },
    };
    startTrip(trip);
    reg.invalidate();
    try {
      const pp = ctx.reg.people;
      if (pp) {
        const r = pp.summonActor(bk === 'sheep' ? 'shepherd' : 'drover', A.pos.clone(), { from: A.originId, timeoutMin: 120 });
        trip.drover = r.id;
      }
    } catch { /* people not ready */ }
  });

  // weekly drover: Wednesday flocks come down Glenmoor Drove to Wyke Down (or go back out when it is full)
  const fb = groups.find((g) => g.field.id === 'FB');
  let droveDay = -1;
  const maybeDrove = () => {
    const c = ctx.clock;
    if (c.weekday !== 2 || droveDay === c.day || c.hour < 8 || c.hour > 12) return;
    droveDay = c.day;
    const n = Math.min(10, Math.max(4, Math.round(K.caps.sheep * 0.2)));
    const full = fb && fb.members.length > K.caps.sheep * 0.58;
    if (full) void herd('sheep', 'FB', 'N1', { count: n, tag: 'drover' });
    else void herd('sheep', 'N1', 'FB', { count: n, tag: 'drover' });
  };
  ctx.bus.on('town:day', (e) => { if (e.kind === 'drover') droveDay = -1; });

  // ── scare ──
  const scare = (pos: THREE.Vector3, r: number) => {
    let bleat = false;
    for (const b of beasts) {
      if (b.c.away || b.state === 'trip' || b.state === 'inside') continue;
      const dx = b.x - pos.x, dz = b.z - pos.z, d = Math.hypot(dx, dz);
      if (d > r) continue;
      if (b.kind === 'dog') { b.state = 'flee'; b.timer = 2; b.tx = b.x + dx / (d + 1e-3) * 5; b.tz = b.z + dz / (d + 1e-3) * 5; continue; }
      const f = b.field;
      let tx = b.x + (dx / (d + 1e-3)) * 10, tz = b.z + (dz / (d + 1e-3)) * 10;
      if (f && !insideField(f.field.poly, tx, tz, 2)) { tx = f.cx; tz = f.cz; }
      b.state = 'flee'; b.timer = 2.5 + rnd() * 3; b.tx = tx; b.tz = tz; b.lieT = 0;
      b.tSpeed = b.kind === 'sheep' ? 2.6 : b.kind === 'cow' ? 2.0 : 4.5;
      if (b.kind === 'sheep') bleat = true;
    }
    if (bleat) ctx.bus.emit('audio:cue', { cue: 'sheep', pos: pos.clone(), volume: 0.6 });
  };

  // ── update ──
  let lastHour = hour();
  const crossed = (h0: number, h1: number, at: number) => (h0 < at && h1 >= at) || (h0 > h1 && (at > h0 || at <= h1));
  const update = (dtM: number, dt: number) => {
    if (dtM <= 0) return;
    const h = hour();
    if (crossed(lastHour, h, 5.67) || crossed(lastHour, h, 15.67)) dairyOut();
    lastHour = h;
    if (dairyState === 'inside') { dairyTimer -= dtM; if (dairyTimer <= 0) dairyBack(); }
    maybeDrove();
    groupT -= dtM;
    if (groupT <= 0) { groupT = 0.5; upkeep(); }
    const focus = ctx.view.focus;
    for (const t of trips.slice()) stepTrip(t, dtM);
    for (const b of beasts) {
      if (b.state === 'trip') { easeCosmetics(b, dtM); continue; }
      const near = Math.hypot(b.x - focus.x, b.z - focus.z) < nearR;
      const d = b.ticker.step(dtM, near);
      if (d <= 0) continue;
      if (b.kind === 'dog') stepDog(b, d); else stepBeast(b, d);
      easeCosmetics(b, d);
    }
    void dt;
  };
  const easeCosmetics = (b: Beast, dt: number) => {
    const k = Math.min(1, dt * 1.6);
    b.head += (b.headT - b.head) * k;
    b.lie += (b.lieT - b.lie) * Math.min(1, dt * 0.7);
    b.turn += (b.turnT - b.turn) * k;
    b.sit += (b.sitT - b.sit) * Math.min(1, dt * 2.5);
    b.amp += (clamp(b.speed / (b.kind === 'horse' ? 1.9 : b.kind === 'dog' ? 1.8 : 1.3), 0, 1.4) - b.amp) * Math.min(1, dt * 3);
    b.y = L.heightAt(b.x, b.z);
    const p = b.c.info.pos;
    p.set(b.x, b.y, b.z);
    b.c.info.state = b.state === 'trip' ? (b.trip?.kind === 'herd' ? 'herded' : 'to the dairy') : b.state;
    if (b.kind === 'horse') {
      // stamp now and then, nod while walking
      if (b.stampLeg === 0 && rnd() < dt * 0.05) { b.stampLeg = 1 + Math.floor(rnd() * 4); b.stampPh = 0; }
      if (b.stampLeg) { b.stampPh += dt * 2.2; if (b.stampPh >= 1) b.stampLeg = 0; }
    }
  };

  // ── visual sync (once per rendered frame) ──
  const sync = (DQ: Drawer, DH: Drawer) => {
    const t = ctx.clock.minutes;
    for (const b of beasts) {
      if (b.c.away || b.c.slot < 0) continue;
      tmp2.set(b.x, b.y + 0.6, b.z);
      if (!ctx.view.isVisible(tmp2, 3)) continue;
      const horse = b.kind === 'horse';
      const D = horse ? DH : DQ;
      const i = D.next(hash1(b.c.slot * 1.37 + (horse ? 57 : 0)), b.colors);
      if (i < 0) continue;
      const rig = D.rig;
      tmp2.set(b.x, b.y, b.z);
      rig.setTransform(i, tmp2, b.yaw, b.scale);
      if (horse) {
        const swish = Math.sin(t * 2.3 + b.c.slot * 1.7) * (0.35 + 0.65 * Math.max(0, Math.sin(t * 0.21 + b.c.slot)));
        const gaitAmp = b.speed < 0.1 ? 0 : b.speed > 2.2 ? 1 : 0.5;
        rig.setAnim(i, b.phase, gaitAmp * clamp01(b.speed * 2), 0.3 * Math.sin(t * 0.7 + b.c.slot) + (b.state === 'look' ? -0.4 : 0), swish);
        rig.setAux(i, b.stampLeg, b.stampPh, clamp01(b.head) * (b.speed < 0.3 ? 1 : 0.3), clamp01(Math.sin(t * 1.3 + b.c.slot * 5) * 3 - 2));
      } else {
        const kind = b.kind === 'sheep' ? QUAD.sheep : b.kind === 'cow' ? QUAD.cow : QUAD.dog;
        const ex = b.kind === 'dog' ? (b.speed > 0.5 ? 0.9 : b.state === 'sit' ? 0.5 : 0.3) + b.tail * 0.3 : b.state === 'flee' ? 1 : 0.2;
        rig.setAnim(i, b.phase, b.amp, b.head * (1 - b.lie * 0.6), ex);
        rig.setAux(i, b.lie, b.turn, b.sit, kind);
      }
    }
  };

  return {
    update, sync, scare, herd,
    debug() { return trips.map((t) => ({ kind: t.kind, L: +t.path.length.toFixed(1), leader: +t.leaderD.toFixed(1), members: t.members.map((m) => `${m.state}:${m.trip === t ? 'T' : '-'}:${m.c.away ? 'A' : 'v'}:${((m as Beast & { tripD?: number }).tripD ?? 0).toFixed(1)}`) })); },
    roadBlocks() {
      const out: { x: number; z: number; r: number }[] = [];
      for (const t of trips) {
        if (!t.members.length) continue;
        const p = t.path.at(Math.max(0, t.leaderD - t.members.length * t.spacing * 0.3), new THREE.Vector3());
        out.push({ x: p.x, z: p.z, r: t.members.length * t.spacing * 0.35 + 6 });
      }
      return out;
    },
    nearestCueTarget(kind) {
      const f = ctx.view.focus;
      let best: Beast | null = null, bd = 140;
      for (const b of beasts) {
        if (b.kind !== kind || b.c.away) continue;
        const d = Math.hypot(b.x - f.x, b.z - f.z);
        if (d < bd) { bd = d; best = b; }
      }
      return best ? new THREE.Vector3(best.x, best.y, best.z) : null;
    },
  };
  void lerp; void hash1;
}
