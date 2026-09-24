import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { CritterKind } from '../core/apis';
import type { InstancedRig } from '../core/rig';
import type { Rng } from '../core/rng';
import type { Water } from './water';
import { FOWL } from './rigs';
import { Registry, type Critter, Ticker } from './life';
import { TAU, clamp, clamp01, turnToward, wrapPi, yawOf, hash1, type Drawer } from './util';

/**
 * WATERFOWL & YARD BIRDS: two duck families (drake, duck, a line of ducklings) on the regatta reach and the mill
 * pool, a swan family in the mill pool, geese on the Coldharbour pond, hens at the crossing keeper's lodge and in
 * the Coldharbour rickyard, a heron that stalks the shallows, strikes, and flaps off between its fishing spots,
 * and fish that jump (splash rings on the water). Ducks and swans keep clear of boats and walk on the ice in a
 * hard frost. All persistent (warm start), so nothing ever pops in.
 */
export interface Fowl {
  update(dtM: number, dt: number): void;
  sync(dt: number, D: Drawer): void;
  scare(pos: THREE.Vector3, r: number): void;
}
export interface BoatProbe { (s: number, lat: number, r: number): { s: number; lat: number; d: number } | null }

interface RB {
  c: Critter; kind: number; ck: CritterKind;
  // river birds live in river coordinates
  s: number; lat: number; hd: number; spd: number;
  x: number; y: number; z: number; yaw: number;
  phase: number; amp: number; dab: number; dabT: number; flap: number; flapT: number; turn: number; turnT: number; stretch: number; water: number;
  state: string; timer: number; scale: number;
  follow: RB | null; gap: number;
  ticker: Ticker;
  cols: number[];
}
interface Flock { s0: number; s1: number; members: RB[]; ts: number; tl: number; state: string; timer: number; speed: number; name: string }

export function createFowl(ctx: Ctx, reg: Registry, rig: InstancedRig, water: Water, boats: BoatProbe, rng: Rng): Fowl {
  const L = ctx.layout, R = L.river, K = ctx.quality.knobs;
  const rnd = () => rng.next();
  const tmp = new THREE.Vector3();
  const all: RB[] = [];
  const flocks: Flock[] = [];
  const hw = (s: number) => R.widthAt(s) / 2;
  const tyaw = (s: number) => R.poly.yawAt(s);

  const mk = (kind: number, ck: CritterKind, label: string, group: string, colors: number[], scale = 1, radius = 0.5): RB | null => {
    const slot = rig.alloc();
    if (slot < 0) return null;
    const c = reg.add(ck, tmp.set(0, 0, 0), label, group, radius);
    c.slot = slot; c.rig = rig;
    rig.setColors(slot, colors);
    const b: RB = {
      c, kind, ck, s: 0, lat: 0, hd: 0, spd: 0, x: 0, y: 0, z: 0, yaw: 0, phase: rnd() * TAU, amp: 0,
      dab: 0, dabT: 0, flap: 0, flapT: 0, turn: 0, turnT: 0, stretch: 0, water: 1, state: 'swim', timer: rnd() * 10, scale,
      follow: null, gap: 0.5, ticker: new Ticker(), cols: colors,
    };
    all.push(b);
    return b;
  };

  // ── duck families + swans ──
  const wf = K.caps.waterfowl;
  const reach = (id: string) => R.reaches.find((r) => r.id === id);
  const addDucks = (id: 'regatta' | 'millpool' | 'skating', name: string, ducklings: number) => {
    const r = reach(id);
    if (!r) return;
    const fl: Flock = { s0: r.s0 + 8, s1: r.s1 - 8, members: [], ts: 0, tl: 0, state: 'paddle', timer: 0, speed: 0.32, name };
    const s = fl.s0 + (fl.s1 - fl.s0) * rnd();
    const mother = mk(FOWL.duck, 'duck', `Mallard · ${name}`, name, [0x8a6a48, 0x7a5a3a, 0xd89a3a, 0x3a3a3a]);
    if (!mother) return;
    const drake = mk(FOWL.duck, 'duck', `Mallard drake · ${name}`, name, [0x9a9488, 0x2f5f3a, 0xe0c040, 0x3a3a3a]);
    const list = [mother];
    if (drake) { drake.follow = mother; drake.gap = 1.3; list.push(drake); }
    let prev = mother;
    for (let i = 0; i < ducklings; i++) {
      const d = mk(FOWL.duckling, 'duck', `Duckling · ${name}`, name, [0x8a7a4a, 0xd8c060, 0x6a5a3a, 0x3a3a3a], 1, 0.3);
      if (!d) break;
      d.follow = prev; d.gap = 0.42; prev = d; list.push(d);
    }
    list.forEach((b, i) => { b.s = s - i * 0.5; b.lat = (rnd() - 0.5) * 2; });
    fl.members = list;
    fl.ts = s; fl.tl = 0;
    flocks.push(fl);
  };
  const nDuckl = wf >= 14 ? 5 : 2;
  addDucks('regatta', 'Regatta reach', nDuckl);
  addDucks('millpool', 'Mill pool', wf >= 14 ? 4 : 0);
  if (wf >= 10) addDucks('skating', 'Kingsmead reach', 0);
  // swans in the mill pool
  const pool = reach('millpool');
  if (pool) {
    const fl: Flock = { s0: pool.s0 + 6, s1: pool.s1 - 4, members: [], ts: 0, tl: 0, state: 'paddle', timer: 0, speed: 0.22, name: 'Mill pool swans' };
    const s = fl.s0 + (fl.s1 - fl.s0) * 0.5;
    const cob = mk(FOWL.swan, 'swan', 'Mute swan (cob)', fl.name, [0xf2f0ea, 0xf2f0ea, 0xd86a2a, 0x1a1a1a], 1.05, 0.9);
    const pen = mk(FOWL.swan, 'swan', 'Mute swan (pen)', fl.name, [0xf0eee6, 0xf0eee6, 0xd87030, 0x1a1a1a], 0.95, 0.9);
    const list: RB[] = [];
    if (cob) list.push(cob);
    if (pen) { pen.follow = cob; pen.gap = 2.2; list.push(pen); }
    if (wf >= 14) {
      let prev = pen ?? cob;
      for (let i = 0; i < 2; i++) { const cy = mk(FOWL.swan, 'swan', 'Cygnet', fl.name, [0x9a9690, 0x9a9690, 0x5a5048, 0x3a3a3a], 0.6, 0.6); if (!cy) break; cy.follow = prev; cy.gap = 1.4; prev = cy; list.push(cy); }
    }
    list.forEach((b, i) => { b.s = s - i * 2; b.lat = -1; });
    fl.members = list; fl.ts = s;
    if (list.length) flocks.push(fl);
  }

  // ── geese on the Coldharbour pond ──
  const pondA = L.towns.find((t) => t.id === 'coldharbour')?.areas.find((a) => a.kind === 'pond');
  interface Yard { cx: number; cz: number; rx: number; rz: number; yaw: number; pond: boolean }
  interface YB { b: RB; yard: Yard; tx: number; tz: number }
  const yardBirds: YB[] = [];
  const toWorld = (y: Yard, lx: number, lz: number, out: THREE.Vector3) => {
    const c = Math.cos(y.yaw), s = Math.sin(y.yaw);
    return out.set(y.cx + lx * c + lz * s, 0, y.cz - lx * s + lz * c);
  };
  const inYard = (y: Yard, x: number, z: number, k = 1) => {
    const c = Math.cos(y.yaw), s = Math.sin(y.yaw);
    const dx = x - y.cx, dz = z - y.cz;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    return y.pond ? (lx / (y.rx * k)) ** 2 + (lz / (y.rz * k)) ** 2 < 1 : Math.abs(lx) < y.rx * k && Math.abs(lz) < y.rz * k;
  };
  if (pondA) {
    const yard: Yard = { cx: pondA.center.x, cz: pondA.center.z, rx: pondA.size.x / 2 * 0.85, rz: pondA.size.z / 2 * 0.85, yaw: pondA.yaw, pond: true };
    for (let i = 0; i < 4; i++) {
      const b = mk(FOWL.goose, 'goose', 'Goose · Coldharbour pond', 'pond', [0xeeeae0, 0xeeeae0, 0xe08a30, 0x3a3a3a], 1, 0.6);
      if (!b) break;
      const p = toWorld(yard, (rnd() - 0.5) * yard.rx, (rnd() - 0.5) * yard.rz, tmp);
      b.x = p.x; b.z = p.z; b.state = 'swim';
      yardBirds.push({ b, yard, tx: b.x, tz: b.z });
    }
  }
  const henYards: Yard[] = [];
  const hr = L.towns.find((t) => t.id === 'lc1')?.areas[0];
  if (hr) henYards.push({ cx: hr.center.x, cz: hr.center.z, rx: hr.size.x / 2 - 0.5, rz: hr.size.z / 2 - 0.5, yaw: hr.yaw, pond: false });
  const ry = L.towns.find((t) => t.id === 'coldharbour')?.areas.find((a) => a.kind === 'rickyard');
  if (ry) henYards.push({ cx: ry.center.x, cz: ry.center.z, rx: ry.size.x / 2 - 1, rz: ry.size.z / 2 - 1, yaw: ry.yaw, pond: false });
  const HENS = [[0x8a4a22, 0x6a3a1a], [0xe8e0d0, 0xd8d0c0], [0x3a3432, 0x2a2422], [0xa86a3a, 0x7a4a2a]];
  for (const y of henYards) {
    const n = K.caps.waterfowl >= 14 ? 6 : 4;
    for (let i = 0; i < n; i++) {
      const hc = HENS[i % HENS.length];
      const b = mk(FOWL.hen, 'hen', i === 0 ? 'Cockerel' : 'Hen', 'hens', [hc[0], i === 0 ? 0x2a4a3a : hc[1], 0xd8b040, 0xc8302a], i === 0 ? 1.15 : 1, 0.4);
      if (!b) break;
      const p = toWorld(y, (rnd() - 0.5) * 2 * y.rx, (rnd() - 0.5) * 2 * y.rz, tmp);
      b.x = p.x; b.z = p.z; b.water = 0; b.state = 'peck'; b.yaw = rnd() * TAU;
      yardBirds.push({ b, yard: y, tx: b.x, tz: b.z });
    }
  }

  // ── heron ──
  interface Spot { s: number; lat: number }
  const spots: Spot[] = R.heron.map((p) => { const n = R.nearest(p); return { s: n.s, lat: n.lat }; });
  {
    // an extra spot in the reeds below Ashbourne Bridge (in the default view's corner)
    const bed = R.reeds.find((r) => r.side === -1 && Math.abs(r.s0 - R.nearest(new THREE.Vector3(148, 0, -74)).s) < 20);
    if (bed) { const s = (bed.s0 + bed.s1) / 2; spots.push({ s, lat: -(hw(s) - 0.7) }); }
  }
  const heron = spots.length ? mk(FOWL.heron, 'heron', 'Grey heron', 'heron', [0x9aa0a4, 0xf0f0ee, 0xd8b050, 0x2a2a2e], 1.05, 1.1) : null;
  let heronSpot = spots.length > 2 ? 2 : 0;
  const hf = { fx: 0, fz: 0, tx: 0, tz: 0, fy: 0, ty: 0, u: 0, len: 1 };
  if (heron) {
    const sp = spots[heronSpot];
    heron.s = sp.s; heron.lat = sp.lat; heron.water = 0; heron.state = 'stand'; heron.timer = 5;
    heron.hd = Math.PI / 2 * Math.sign(sp.lat || 1);
  }

  // ── fish (one at a time, visible only while jumping) ──
  const fish = mk(FOWL.fish, 'heron', 'Trout', 'fish', [0x9a8a60, 0x7a6a48, 0x7a6a48, 0x7a6a48], 1, 0.3);
  if (fish) { reg.remove(fish.c); fish.c.away = true; }
  const fj = { t: -1, x: 0, z: 0, y: 0, yaw: 0, next: 20 };

  reg.invalidate();

  // ── river bird motion ──
  const place = (b: RB) => {
    R.pointAt(b.s, b.lat, 0, tmp);
    b.x = tmp.x; b.z = tmp.z;
    const ice = water.ice;
    const sy = water.riverY(b.s);
    if (b === heron) { b.y = sy - 0.28; }
    else b.y = sy + (ice > 0.75 ? 0.03 : 0);
    b.water = b === heron ? 0 : ice > 0.75 ? 0 : 1;
    b.yaw = tyaw(b.s) + b.hd;
  };
  const clampLat = (b: RB, margin: number) => { const h = hw(b.s) - margin; b.lat = clamp(b.lat, -h, h); if (water.inLock(b.s, b.lat)) b.lat = -Math.abs(b.lat); };
  const steer = (b: RB, ts: number, tl: number, speed: number, dt: number, turnRate = 1.6) => {
    const ds = ts - b.s, dl = tl - b.lat, d = Math.hypot(ds, dl);
    if (d > 0.05) b.hd = turnToward(b.hd, Math.atan2(-dl, ds), dt * turnRate);
    const want = d > 0.15 ? Math.min(speed, d * 1.5) : 0;
    b.spd += (want - b.spd) * Math.min(1, dt * 2);
    b.s += Math.cos(b.hd) * b.spd * dt;
    b.lat += -Math.sin(b.hd) * b.spd * dt;
    b.phase += b.spd * dt * 9;
    return d;
  };

  const stepFlock = (f: Flock, dt: number) => {
    const lead = f.members[0];
    const iced = water.ice > 0.75;
    const night = (ctx.reg.atmosphere?.nightFactor ?? 0) > 0.7;
    f.timer -= dt;
    // boat avoidance: a boat within 9 m pushes the whole family toward the far bank
    const bn = boats(lead.s, lead.lat, 10);
    if (bn && f.state !== 'flee') {
      const away = lead.lat >= bn.lat ? 1 : -1;
      f.tl = away * (hw(lead.s) - 1.0);
      f.ts = lead.s + (lead.s >= bn.s ? 4 : -4);
      if (bn.d < 3.5) { f.state = 'flee'; f.timer = 1.5 + rnd() * 1.5; }
      else f.state = 'paddle';
    }
    switch (f.state) {
      case 'paddle': {
        const d = steer(lead, f.ts, f.tl, (iced ? 0.25 : f.speed) * (lead.kind === FOWL.swan ? 1 : 1), dt);
        if (d < 0.6 || f.timer <= 0) {
          const r = rnd();
          if (night) { f.state = 'rest'; f.timer = 40 + rnd() * 80; f.tl = Math.sign(lead.lat || 1) * (hw(lead.s) - 1.1); f.ts = lead.s; }
          else if (r < 0.3 && !iced) { f.state = 'dabble'; f.timer = 3 + rnd() * 6; }
          else {
            f.ts = clamp(lead.s + (rnd() - 0.5) * 40, f.s0, f.s1);
            f.tl = (rnd() - 0.5) * 2 * (hw(f.ts) - 1.6);
            f.timer = 40 + rnd() * 30;
          }
        }
        break;
      }
      case 'dabble': steer(lead, lead.s, lead.lat, 0, dt); if (f.timer <= 0) { f.state = 'paddle'; f.timer = 0; } break;
      case 'rest': steer(lead, f.ts, f.tl, 0.1, dt); if (f.timer <= 0) { f.state = 'paddle'; f.timer = 0; } break;
      case 'flee': {
        const away = bn ? (lead.s >= bn.s ? 1 : -1) : 1;
        steer(lead, lead.s + away * 6, f.tl, iced ? 1.2 : 2.4, dt, 4);
        if (f.timer <= 0) { f.state = 'paddle'; f.timer = 5; }
        break;
      }
      default: f.state = 'paddle';
    }
    lead.dabT = f.state === 'dabble' ? 1 : 0;
    lead.flapT = f.state === 'flee' && lead.kind !== FOWL.duckling ? 1 : 0;
    clampLat(lead, 0.8);
    lead.s = clamp(lead.s, f.s0 - 10, f.s1 + 10);
    // followers: chase a point behind the one ahead
    for (let i = 1; i < f.members.length; i++) {
      const b = f.members[i], fo = b.follow ?? lead;
      const ts = fo.s - Math.cos(fo.hd) * b.gap, tl = fo.lat + Math.sin(fo.hd) * b.gap;
      const sp = f.state === 'flee' ? 2.6 : Math.max(0.2, fo.spd * 1.25 + 0.1);
      steer(b, ts, tl, sp, dt, 3);
      clampLat(b, 0.7);
      b.dabT = f.state === 'dabble' && rnd() < 0.6 ? 1 : f.state === 'dabble' ? b.dabT : 0;
      b.flapT = f.state === 'flee' && b.kind !== FOWL.duckling ? 1 : 0;
    }
  };

  const stepHeron = (b: RB, dt: number) => {
    b.timer -= dt;
    const bn = b.state !== 'fly' ? boats(b.s, b.lat, 16) : null;
    if (bn && b.state !== 'fly') startFlight(b);
    switch (b.state) {
      case 'stand': {
        b.amp = 0; b.stretch = 0.15 + 0.1 * Math.sin(ctx.clock.minutes * 0.3);
        if (rnd() < dt * 0.2) b.turnT = (rnd() - 0.5) * 1.2;
        if (b.timer <= 0) {
          const r = rnd();
          if (r < 0.45) { b.state = 'stalk'; b.timer = 4 + rnd() * 6; }
          else if (r < 0.75) { b.state = 'strike'; b.timer = 1.2; b.dabT = 0; }
          else if (r < 0.8) startFlight(b);
          else b.timer = 4 + rnd() * 8;
        }
        break;
      }
      case 'stalk': {
        // slow, deliberate steps along the margin
        const sp = spots[heronSpot];
        const ts = sp.s + Math.sin(ctx.clock.minutes * 0.05) * 6;
        steer(b, ts, sp.lat, 0.12, dt, 0.6);
        b.amp = 0.35; b.stretch = 0.3;
        if (b.timer <= 0) { b.state = 'stand'; b.timer = 3 + rnd() * 8; b.spd = 0; }
        break;
      }
      case 'strike': {
        const u = 1 - b.timer / 1.2;
        b.stretch = u < 0.3 ? 0.3 + u * 2.3 : 1;
        b.dabT = u > 0.25 && u < 0.6 ? 1 : 0;
        if (u > 0.3 && u < 0.34) water.splash(b.x + Math.cos(b.yaw) * 0.7, b.z - Math.sin(b.yaw) * 0.7, 0.8);
        if (b.timer <= 0) { b.state = 'stand'; b.timer = 6 + rnd() * 12; b.dabT = 0; }
        break;
      }
      case 'fly': {
        hf.u = Math.min(1, hf.u + (6.5 * dt) / hf.len);
        const u = hf.u;
        const x = hf.fx + (hf.tx - hf.fx) * u, z = hf.fz + (hf.tz - hf.fz) * u;
        const arc = Math.sin(Math.PI * u) * Math.min(18, hf.len * 0.08) + (hf.fy + (hf.ty - hf.fy) * u);
        b.x = x; b.z = z; b.y = arc;
        b.yaw = yawOf(hf.tx - hf.fx, hf.tz - hf.fz);
        b.flapT = u > 0.92 ? 0.4 : 1;
        if (u >= 1) {
          const sp = spots[heronSpot];
          b.s = sp.s; b.lat = sp.lat; b.state = 'stand'; b.timer = 8 + rnd() * 10; b.flapT = 0;
          b.hd = Math.PI / 2 * Math.sign(sp.lat || 1);
        }
        break;
      }
      default: b.state = 'stand';
    }
    if (b.state !== 'fly') { clampLat(b, 0.3); if (Math.abs(b.lat) < hw(b.s) - 1.4) b.lat = Math.sign(b.lat || 1) * (hw(b.s) - 1.4); }
  };
  const startFlight = (b: RB) => {
    if (spots.length < 2) return;
    let n = heronSpot;
    while (n === heronSpot) n = Math.floor(rnd() * spots.length);
    R.pointAt(b.s, b.lat, 0, tmp);
    hf.fx = tmp.x; hf.fz = tmp.z; hf.fy = water.riverY(b.s) - 0.28;
    heronSpot = n;
    const sp = spots[n];
    R.pointAt(sp.s, sp.lat, 0, tmp);
    hf.tx = tmp.x; hf.tz = tmp.z; hf.ty = water.riverY(sp.s) - 0.28;
    hf.len = Math.max(10, Math.hypot(hf.tx - hf.fx, hf.tz - hf.fz));
    hf.u = 0;
    b.state = 'fly';
    b.stretch = 0;
    b.dabT = 0;
  };

  const stepYard = (yb: YB, dt: number) => {
    const b = yb.b, y = yb.yard;
    b.timer -= dt;
    if (b.state !== 'run') b.flapT = 0;
    const goose = b.kind === FOWL.goose;
    const night = (ctx.reg.atmosphere?.nightFactor ?? 0) > 0.75;
    const dx = yb.tx - b.x, dz = yb.tz - b.z, d = Math.hypot(dx, dz);
    const speed = b.state === 'run' ? 1.6 : goose && b.water > 0.5 ? 0.3 : 0.45;
    if (d > 0.1 && b.state !== 'roost') {
      b.yaw = turnToward(b.yaw, yawOf(dx, dz), dt * 4);
      const st = Math.min(d, speed * dt);
      b.x += Math.cos(b.yaw) * st; b.z -= Math.sin(b.yaw) * st;
      b.phase += st * (goose ? 7 : 11);
      b.amp = b.water > 0.5 ? 0 : 0.6;
      b.spd = speed;
    } else { b.amp = 0; b.spd = 0; }
    if (b.timer <= 0) {
      if (night && !goose) { b.state = 'roost'; b.timer = 30 + rnd() * 40; b.dabT = 0; b.turnT = (rnd() - 0.5); return; }
      const r = rnd();
      if (r < 0.45) { b.state = 'peck'; b.timer = 1.5 + rnd() * 4; }
      else if (r < 0.9 || !goose) {
        b.state = r > 0.97 ? 'run' : 'walk'; b.timer = 3 + rnd() * 5;
        // geese mostly swim; sometimes waddle out to graze on the bank
        const swim = goose && rnd() < 0.7;
        const k = goose ? (swim ? 1 : 1.4) : 0.95;
        for (let tries = 0; tries < 8; tries++) {
          const p = toWorld(y, (rnd() - 0.5) * 2 * y.rx * k, (rnd() - 0.5) * 2 * y.rz * k, tmp);
          if (goose ? (!swim || water.onPond(p.x, p.z)) : inYard(y, p.x, p.z)) { yb.tx = p.x; yb.tz = p.z; break; }
        }
      } else { b.state = 'honk'; b.timer = 1.5; b.stretch = 1; }
      if (b.state !== 'honk') b.stretch = 0;
    }
    b.dabT = b.state === 'peck' ? (Math.sin(ctx.clock.minutes * 9 + b.c.slot * 3) > 0 ? 1 : 0.2) : 0;
    const onPond = goose && water.onPond(b.x, b.z);
    b.water = onPond ? 1 : 0;
    b.y = onPond ? water.surfaceY(b.x, b.z) : L.heightAt(b.x, b.z) + (b.state === 'roost' ? -0.08 : 0);
    if (b.state === 'honk' && rnd() < dt * 0.8) ctx.bus.emit('audio:cue', { cue: goose ? 'goose' : 'hens', pos: new THREE.Vector3(b.x, b.y, b.z), volume: 0.4 });
  };

  const stepFish = (dtM: number) => {
    if (!fish) return;
    fj.next -= dtM;
    if (fj.next > 0 || fj.t >= 0 || water.ice > 0.3) return;
    fj.next = 25 + rnd() * 70;
    const f = ctx.view.focus;
    const n = R.nearest(tmp.set(f.x, 0, f.z));
    if (n.d > 160) return;
    const s = clamp(n.s + (rnd() - 0.5) * 70, 5, R.length - 5);
    const lat = (rnd() - 0.5) * 2 * (hw(s) - 1.5);
    if (water.inLock(s, lat)) return;
    R.pointAt(s, lat, 0, tmp);
    if (!ctx.view.isVisible(tmp, 2)) return;
    fj.x = tmp.x; fj.z = tmp.z; fj.y = water.riverY(s); fj.yaw = rnd() * TAU; fj.t = 0;
    water.splash(fj.x, fj.z, 0.9);
    ctx.bus.emit('audio:cue', { cue: 'splash', pos: tmp.clone(), volume: 0.25 });
  };

  // ── update ──
  const focus = ctx.view.focus;
  const update = (dtM: number) => {
    if (dtM <= 0) return;
    for (const f of flocks) {
      const lead = f.members[0];
      const near = Math.hypot(lead.x - focus.x, lead.z - focus.z) < K.lifeNearRadius;
      const d = lead.ticker.step(dtM, near);
      if (d > 0) stepFlock(f, d);
    }
    if (heron) stepHeron(heron, dtM);
    for (const yb of yardBirds) {
      const near = Math.hypot(yb.b.x - focus.x, yb.b.z - focus.z) < K.lifeNearRadius;
      const d = yb.b.ticker.step(dtM, near);
      if (d > 0) stepYard(yb, d);
    }
    stepFish(dtM);
    // cosmetics + info
    for (const b of all) {
      const k = Math.min(1, dtM * 4);
      b.dab += (b.dabT - b.dab) * k;
      b.flap += (b.flapT - b.flap) * Math.min(1, dtM * 5);
      b.turn += (b.turnT - b.turn) * k;
      if (b !== fish) {
        if (b.kind !== FOWL.goose && b.kind !== FOWL.hen && !(b === heron && b.state === 'fly')) place(b);
        b.c.info.pos.set(b.x, b.y, b.z);
        b.c.info.state = b.state;
      }
    }
    // pond/yard birds are in xz
  };

  // ── scare ──
  const scare = (pos: THREE.Vector3, r: number) => {
    for (const f of flocks) {
      const lead = f.members[0];
      if (Math.hypot(lead.x - pos.x, lead.z - pos.z) > r) continue;
      f.state = 'flee'; f.timer = 2 + rnd() * 2;
      water.splash(lead.x, lead.z, 0.7);
      ctx.bus.emit('audio:cue', { cue: lead.kind === FOWL.swan ? 'swan' : 'duck', pos: new THREE.Vector3(lead.x, lead.y, lead.z), volume: 0.6 });
    }
    if (heron && heron.state !== 'fly' && Math.hypot(heron.x - pos.x, heron.z - pos.z) < r * 1.4) startFlight(heron);
    for (const yb of yardBirds) {
      const b = yb.b;
      const d = Math.hypot(b.x - pos.x, b.z - pos.z);
      if (d > r) continue;
      b.state = 'run'; b.timer = 1 + rnd() * 1.5; b.flapT = b.kind === FOWL.hen ? 0.6 : 0.3;
      const ax = (b.x - pos.x) / (d + 1e-3), az = (b.z - pos.z) / (d + 1e-3);
      const tx = b.x + ax * 3, tz = b.z + az * 3;
      if (b.kind === FOWL.goose || inYard(yb.yard, tx, tz)) { yb.tx = tx; yb.tz = tz; }
    }
  };

  // ── render ──
  const sync = (dt: number, D: Drawer) => {
    for (const b of all) {
      if (b === fish) continue;
      tmp.set(b.x, b.y + 0.3, b.z);
      if (!ctx.view.isVisible(tmp, 2)) continue;
      const i = D.next(hash1(b.c.slot * 0.73 + 3), b.cols);
      if (i < 0) break;
      tmp.set(b.x, b.y, b.z);
      const pitch = b.kind === FOWL.duck || b.kind === FOWL.duckling ? -b.dab * 1.05 * b.water : 0;
      rig.setTransform(i, tmp, b.yaw, b.scale, pitch);
      const headDip = b.kind === FOWL.duck || b.kind === FOWL.duckling ? b.dab * (1 - b.water) : b.dab;
      rig.setAnim(i, b.phase, clamp01(b.amp + (b.water < 0.5 ? b.spd : 0)), headDip, b.flap);
      rig.setAux(i, b.stretch, b.turn, b.water, b.kind);
    }
    if (fish && fj.t >= 0) {
      fj.t += dt / 0.8;
      if (fj.t >= 1) { fj.t = -1; water.splash(fj.x + Math.cos(fj.yaw) * 0.9, fj.z - Math.sin(fj.yaw) * 0.9, 0.7); }
      else {
        const u = fj.t;
        tmp.set(fj.x + Math.cos(fj.yaw) * 0.9 * u, fj.y + Math.sin(Math.PI * u) * 0.55, fj.z - Math.sin(fj.yaw) * 0.9 * u);
        const i = D.next(0.5, fish.cols);
        if (i >= 0) {
          rig.setTransform(i, tmp, fj.yaw, 1, Math.cos(Math.PI * u) * 1.1);
          rig.setAnim(i, 0, 0, 0, 0);
          rig.setAux(i, 0, 0, 1, FOWL.fish);
        }
      }
    }
  };

  // ambient cues (real time, only when close to the view)
  let cueT = 6;
  const cue = (dt: number) => {
    cueT -= dt;
    if (cueT > 0) return;
    cueT = 8 + rnd() * 14;
    let best: RB | null = null, bd = 90;
    for (const f of flocks) { const b = f.members[0]; const d = Math.hypot(b.x - focus.x, b.z - focus.z); if (d < bd) { bd = d; best = b; } }
    if (best && (ctx.reg.atmosphere?.nightFactor ?? 0) < 0.8) ctx.bus.emit('audio:cue', { cue: best.kind === FOWL.swan ? 'swan' : 'duck', pos: new THREE.Vector3(best.x, best.y, best.z), volume: 0.35 });
  };

  return {
    update(dtM, dt) { update(dtM); cue(dt); },
    sync, scare,
  };
  void wrapPi;
}
