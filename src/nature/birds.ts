import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { CritterKind } from '../core/apis';
import type { InstancedRig } from '../core/rig';
import type { Rng } from '../core/rng';
import { localToWorld } from '../core/poly';
import { Registry, type Critter, insideField, randomInField, polyCentroid } from './life';
import { TAU, clamp, clamp01, lerp, warmth, yawOf, hash1, type Drawer } from './util';

/**
 * BIRDS ON THE WING (one instanced draw): crows feeding on Long Acre and Glenmoor Field (they rise at train
 * whistles and roost off-map overnight), rooks wheeling round St Mary's tower, swallows hawking low over the
 * regatta reach on warm days (nesting in the boathouse eaves), an autumn-evening starling murmuration over
 * Shed Meadow that streams in from beyond the map edge and away again, and butterflies in the gardens (med/high).
 * Flocks only appear/disappear beyond the playfield edge or at their nest origin (audited).
 */
export interface Birds {
  update(dtM: number, dt: number): void;
  sync(D: Drawer): void;
  scare(pos: THREE.Vector3, r: number): void;
  flying(): number;
}

const KIND_LOOK: Record<string, { cols: number[]; scale: [number, number, number]; freq: number }> = {
  crow: { cols: [0x18181c, 0x202026, 0x3a3a40, 0x18181c], scale: [1.25, 1.25, 1.35], freq: 3.2 },
  rook: { cols: [0x1c1c24, 0x26262e, 0xa0a0a0, 0x1c1c24], scale: [1.2, 1.2, 1.3], freq: 3.4 },
  starling: { cols: [0x24242a, 0x2c2c34, 0x9a8a40, 0x24242a], scale: [0.62, 0.62, 0.66], freq: 8 },
  swallow: { cols: [0x1a2444, 0x16203a, 0x7a2a2a, 0x1a2444], scale: [0.6, 0.6, 0.85], freq: 6.5 },
  butterfly: { cols: [0x2a2a2a, 0xf2f0e4, 0x2a2a2a, 0x2a2a2a], scale: [0.22, 0.3, 0.5], freq: 9 },
};
const BUTTERFLY_WINGS = [0xf2f0e4, 0xe8de6a, 0xd8742a, 0x8a3a3a, 0xf0ece0, 0x9ab0d8];

interface Bird {
  c: Critter | null; slot: number; kind: string;
  x: number; y: number; z: number; px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  yaw: number; bank: number;
  ground: number; groundT: number; peck: number; flapAmp: number;
  a: number; b: number; p: number; q: number; r: number; h: number;
  hopT: number; tx: number; tz: number;
  away: boolean;
  cols: number[];
}

export function createBirds(ctx: Ctx, reg: Registry, rig: InstancedRig, rng: Rng): Birds {
  const L = ctx.layout, R = L.river, K = ctx.quality.knobs;
  const rnd = () => rng.next();
  const tmp = new THREE.Vector3(), m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e3 = new THREE.Euler(), s3 = new THREE.Vector3();
  const all: Bird[] = [];
  const B = K.caps.birds;

  const mk = (kind: string, label: string, group: string, register: boolean): Bird | null => {
    const slot = rig.alloc();
    if (slot < 0) return null;
    const look = KIND_LOOK[kind];
    const cols = kind === 'butterfly' ? [0x2a2a2a, BUTTERFLY_WINGS[Math.floor(rnd() * BUTTERFLY_WINGS.length)], 0x2a2a2a, 0x2a2a2a] : look.cols;
    rig.setColors(slot, cols);
    const c = register ? reg.add(kind as CritterKind, tmp.set(0, 0, 0), label, group, kind === 'starling' ? 0.4 : 0.6) : null;
    if (c) { c.slot = slot; c.rig = rig; }
    const b: Bird = {
      c, slot, kind, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, yaw: rnd() * TAU, bank: 0,
      ground: 1, groundT: 1, peck: 0, flapAmp: 0.8,
      a: 0.25 + rnd() * 0.35, b: 0.3 + rnd() * 0.4, p: rnd() * TAU, q: rnd() * TAU, r: rnd() * TAU, h: rnd(),
      hopT: rnd() * 2, tx: 0, tz: 0, away: false, cols,
    };
    all.push(b);
    return b;
  };
  const setAway = (b: Bird, away: boolean) => { b.away = away; if (b.c) b.c.away = away; reg.invalidate(); };

  // ── crows ──
  interface CrowFlock { field: THREE.Vector2[]; cx: number; cz: number; birds: Bird[]; state: 'feed' | 'aloft' | 'land' | 'leave' | 'away' | 'arrive'; timer: number; edge: THREE.Vector3 }
  const crowFlocks: CrowFlock[] = [];
  const nCrow = Math.max(4, Math.min(10, Math.floor(B * 0.13)));
  for (const fid of ['FA', 'FD']) {
    const f = L.fields.find((q) => q.id === fid);
    if (!f) continue;
    const cen = polyCentroid(f.poly);
    // roost direction: the nearest map edge
    const ex = Math.abs(cen.x) > Math.abs(cen.y) ? Math.sign(cen.x) * 470 : cen.x;
    const ez = Math.abs(cen.x) > Math.abs(cen.y) ? cen.y : Math.sign(cen.y) * 470;
    const fl: CrowFlock = { field: f.poly, cx: cen.x, cz: cen.y, birds: [], state: 'feed', timer: 20, edge: new THREE.Vector3(ex, 30, ez) };
    for (let i = 0; i < nCrow; i++) {
      const b = mk('crow', `Carrion crow · ${f.name}`, fid, true);
      if (!b) break;
      const p = randomInField(f.poly, 3, rnd);
      b.x = p.x; b.z = p.y; b.y = L.heightAt(b.x, b.z);
      b.tx = b.x; b.tz = b.z;
      fl.birds.push(b);
    }
    crowFlocks.push(fl);
  }

  // ── rooks round St Mary's tower ──
  const church = L.buildings.find((b) => b.kind === 'church' && b.town === 'ashcombe' && b.tower) ?? L.buildings.find((b) => b.kind === 'church' && b.tower);
  const rooks: Bird[] = [];
  let tower = new THREE.Vector3(), towerTop = 0, towerHalf = 1.5;
  if (church && church.tower) {
    tower = localToWorld(church.center, church.yaw, church.tower.lx, 0);
    towerTop = church.center.y + church.tower.h;
    towerHalf = church.tower.size / 2;
    const n = Math.max(3, Math.min(8, Math.floor(B * 0.07)));
    for (let i = 0; i < n; i++) {
      const b = mk('rook', `Rook · ${church.name}`, 'rookery', true);
      if (!b) break;
      b.ground = 0; b.groundT = 0;
      b.x = tower.x + Math.cos(b.p) * 12; b.z = tower.z + Math.sin(b.p) * 12; b.y = towerTop + 5;
      rooks.push(b);
    }
  }
  const perch = (i: number, out: THREE.Vector3) => {
    const k = i % 4, sx = k & 1 ? 1 : -1, sz = k & 2 ? 1 : -1;
    out.set(tower.x + sx * (towerHalf - 0.3) + (i >> 2) * 0.4 * sx, towerTop + 0.1, tower.z + sz * (towerHalf - 0.3));
    return out;
  };

  // ── swallows ──
  const swallows: Bird[] = [];
  const regatta = R.reaches.find((r) => r.id === 'regatta');
  const nest = R.boathouse.center.clone().setY(R.boathouse.center.y + 3.2);
  if (regatta) {
    ctx.origins.add({ id: 'nature:swallowNest', kind: 'door', owner: 'nature', pos: (o) => o.copy(nest), radius: 6, for: ['animals'], open: () => true, building: 'river:boathouse' });
    const n = Math.max(2, Math.min(8, Math.floor(B * 0.06)));
    for (let i = 0; i < n; i++) {
      const b = mk('swallow', 'Swallow', 'swallows', true);
      if (!b) break;
      b.ground = 0; b.groundT = 0;
      b.x = nest.x; b.y = nest.y; b.z = nest.z;
      setAway(b, true);
      swallows.push(b);
    }
  }
  let swallowState: 'nest' | 'out' | 'hunt' | 'home' = 'nest';
  let swallowT = 0;

  // ── butterflies (med/high) ──
  const butterflies: { b: Bird; hx: number; hz: number; rest: boolean }[] = [];
  if (ctx.quality.tier !== 'low') {
    const homes: THREE.Vector3[] = [L.forecourt.center.clone()];
    for (const t of L.towns) for (const a of t.areas) if (a.kind === 'green' || a.kind === 'garden' || a.kind === 'churchyard') homes.push(a.center.clone());
    const fg = L.fields.find((f) => f.id === 'FG');
    if (fg) homes.push(fg.center.clone());
    const n = Math.min(14, Math.floor(B * 0.08));
    for (let i = 0; i < n; i++) {
      const b = mk('butterfly', 'Butterfly', 'butterflies', false);
      if (!b) break;
      const h = homes[i % homes.length];
      b.x = h.x + (rnd() - 0.5) * 8; b.z = h.z + (rnd() - 0.5) * 8; b.y = L.heightAt(b.x, b.z) + 0.2;
      butterflies.push({ b, hx: h.x, hz: h.z, rest: true });
    }
  }

  // ── starlings (the remaining budget) ──
  const starlings: Bird[] = [];
  const nStar = Math.max(0, Math.min(220, B - all.length));
  if (nStar >= 12) {
    for (let i = 0; i < nStar; i++) {
      const b = mk('starling', 'Starling', 'murmuration', true);
      if (!b) break;
      b.ground = 0; b.groundT = 0;
      setAway(b, true);
      starlings.push(b);
    }
  }
  const fgF = L.fields.find((f) => f.id === 'FG');
  const murC = fgF ? new THREE.Vector3(fgF.center.x, 0, fgF.center.z) : new THREE.Vector3(-30, 0, 118);
  const mur = { state: 'off' as 'off' | 'in' | 'show' | 'out', t: 0, day: -1, from: new THREE.Vector3(80, 34, 470), to: new THREE.Vector3(-470, 30, 170) };
  reg.invalidate();

  // ── motion helpers ──
  const steerTo = (b: Bird, x: number, y: number, z: number, speed: number, dt: number, agility = 2.2) => {
    const dx = x - b.x, dy = y - b.y, dz = z - b.z, d = Math.hypot(dx, dy, dz) || 1e-3;
    const k = Math.min(1, dt * agility);
    b.vx += ((dx / d) * speed - b.vx) * k;
    b.vy += ((dy / d) * speed - b.vy) * k;
    b.vz += ((dz / d) * speed - b.vz) * k;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    return d;
  };
  const faceVel = (b: Bird, dt: number) => {
    const sp = Math.hypot(b.vx, b.vz);
    if (sp > 0.2) {
      const y = yawOf(b.vx, b.vz);
      let d = y - b.yaw; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
      b.yaw += d * Math.min(1, dt * 6);
      b.bank = clamp(b.bank * 0.9 + clamp(-d * 2, -0.9, 0.9) * 0.1, -0.9, 0.9);
    }
  };
  const hour = () => ctx.clock.hour;
  const night = () => (ctx.reg.atmosphere?.nightFactor ?? 0);
  const badWeather = () => { const w = ctx.reg.atmosphere?.weather; return w === 'rain' || w === 'storm'; };

  // ── crows ──
  const stepCrows = (fl: CrowFlock, dt: number) => {
    fl.timer -= dt;
    const nf = night();
    if ((fl.state === 'feed' || fl.state === 'aloft' || fl.state === 'land') && nf > 0.65) { fl.state = 'leave'; for (const b of fl.birds) b.groundT = 0; }
    if (fl.state === 'away' && nf < 0.35 && hour() > 4 && hour() < 12) {
      fl.state = 'arrive';
      fl.birds.forEach((b, i) => {
        b.x = fl.edge.x + (rnd() - 0.5) * 12; b.z = fl.edge.z + (rnd() - 0.5) * 12; b.y = fl.edge.y + (rnd() - 0.5) * 6;
        b.vx = b.vy = b.vz = 0; b.groundT = 0; b.hopT = i * 0.3;
        ctx.origins.audit('nature', 'spawn', 'animals', tmp.set(b.x, b.y, b.z), 'crow');
        setAway(b, false);
      });
    }
    for (const b of fl.birds) {
      if (b.away) continue;
      const t = ctx.clock.minutes;
      switch (fl.state) {
        case 'feed': {
          b.groundT = 1;
          b.hopT -= dt;
          if (b.hopT <= 0) {
            b.hopT = 0.8 + rnd() * 2.4;
            const a = rnd() * TAU, d = 0.3 + rnd() * 0.6;
            const nx = b.x + Math.cos(a) * d, nz = b.z - Math.sin(a) * d;
            if (insideField(fl.field, nx, nz, 1.5)) { b.tx = nx; b.tz = nz; b.yaw = yawOf(nx - b.x, nz - b.z); }
            b.peck = rnd() < 0.6 ? 1 : 0;
          }
          b.x += (b.tx - b.x) * Math.min(1, dt * 6); b.z += (b.tz - b.z) * Math.min(1, dt * 6);
          b.y = L.heightAt(b.x, b.z);
          break;
        }
        case 'aloft': {
          b.groundT = 0;
          const ang = t * (0.12 + b.a * 0.1) + b.p;
          const r = 18 + b.h * 16;
          steerTo(b, fl.cx + Math.cos(ang) * r, L.heightAt(fl.cx, fl.cz) + 9 + b.h * 7 + Math.sin(t * 0.3 + b.q) * 2, fl.cz - Math.sin(ang) * r, 8, dt);
          faceVel(b, dt);
          break;
        }
        case 'land': {
          const gy = L.heightAt(b.tx, b.tz);
          const d = steerTo(b, b.tx, gy, b.tz, Math.min(7, 1 + Math.hypot(b.tx - b.x, b.tz - b.z) * 0.5), dt, 3);
          faceVel(b, dt);
          if (d < 0.5) { b.groundT = 1; b.vx = b.vy = b.vz = 0; b.y = gy; }
          else b.groundT = 0;
          break;
        }
        case 'leave': case 'arrive': {
          b.groundT = 0;
          const tx = fl.state === 'leave' ? fl.edge.x : b.tx, tz = fl.state === 'leave' ? fl.edge.z : b.tz;
          const ty = fl.state === 'leave' ? fl.edge.y : L.heightAt(b.tx, b.tz);
          const d = steerTo(b, tx, ty, tz, fl.state === 'leave' ? 11 : Math.min(10, 1 + Math.hypot(tx - b.x, tz - b.z) * 0.4), dt, 1.5);
          faceVel(b, dt);
          if (fl.state === 'leave' && Math.max(Math.abs(b.x), Math.abs(b.z)) > 440) {
            ctx.origins.audit('nature', 'despawn', 'animals', tmp.set(b.x, b.y, b.z), 'crow');
            setAway(b, true);
          }
          if (fl.state === 'arrive' && d < 0.5) { b.groundT = 1; b.vx = b.vy = b.vz = 0; }
          break;
        }
        default: break;
      }
    }
    if (fl.state === 'aloft' && fl.timer <= 0) {
      fl.state = 'land'; fl.timer = 25;
      for (const b of fl.birds) { const p = randomInField(fl.field, 3, rnd); b.tx = p.x; b.tz = p.y; }
    } else if ((fl.state === 'land' || fl.state === 'arrive') && (fl.birds.every((b) => b.groundT > 0.5 || b.away) || fl.timer <= 0)) {
      fl.state = 'feed'; for (const b of fl.birds) { b.groundT = 1; b.tx = b.x; b.tz = b.z; }
    } else if (fl.state === 'leave' && fl.birds.every((b) => b.away)) fl.state = 'away';
    else if (fl.state === 'feed' && fl.timer <= 0) {
      // short hop flights across the field now and then
      fl.timer = 30 + rnd() * 60;
      if (rnd() < 0.35) { fl.state = 'aloft'; fl.timer = 8 + rnd() * 10; }
    }
    if (fl.state === 'arrive' && fl.birds.some((b) => b.tx === 0 && b.tz === 0)) {
      for (const b of fl.birds) { const p = randomInField(fl.field, 3, rnd); b.tx = p.x; b.tz = p.y; }
    }
  };
  // warm start: at night the crows are away
  if (night() > 0.65) for (const fl of crowFlocks) { fl.state = 'away'; for (const b of fl.birds) setAway(b, true); }
  for (const fl of crowFlocks) for (const b of fl.birds) if (b.tx === 0) { b.tx = b.x; b.tz = b.z; }

  // ── rooks ──
  let rookAgit = 0;
  const stepRooks = (dt: number) => {
    const nf = night();
    const t = ctx.clock.minutes;
    rookAgit = Math.max(0, rookAgit - dt * 0.05);
    rooks.forEach((b, i) => {
      const perchNow = nf > 0.7 || ((Math.sin(t * 0.02 + b.p * 3) > 0.55) && rookAgit < 0.2);
      if (perchNow) {
        perch(i, tmp);
        const d = steerTo(b, tmp.x, tmp.y, tmp.z, Math.min(7, 0.5 + Math.hypot(tmp.x - b.x, tmp.z - b.z) * 0.6), dt, 3);
        if (d < 0.4) { b.groundT = 1; b.vx = b.vy = b.vz = 0; b.x = tmp.x; b.y = tmp.y; b.z = tmp.z; b.yaw += Math.sin(t * 0.5 + i) * dt * 0.3; }
        else { b.groundT = 0; faceVel(b, dt); }
      } else {
        b.groundT = 0;
        const ang = t * (0.25 + b.a * 0.2) * (i % 2 ? 1 : -1) + b.p;
        const r = 9 + b.h * 10 + rookAgit * 12;
        steerTo(b, tower.x + Math.cos(ang) * r, towerTop + 3 + b.h * 8 + Math.sin(t * 0.4 + b.q) * 2.5, tower.z - Math.sin(ang) * r, 7, dt, 2);
        faceVel(b, dt);
      }
    });
  };

  // ── swallows ──
  const swallowTarget = (b: Bird, t: number, out: THREE.Vector3) => {
    const r = regatta!;
    const sc = (r.s0 + r.s1) / 2, A = (r.s1 - r.s0) / 2 * 0.8;
    const s = sc + A * Math.sin(t * 0.22 * (0.8 + b.a * 0.4) + b.p);
    const hwv = R.widthAt(s) / 2;
    const lat = (hwv + 5) * Math.sin(t * 0.5 * (0.8 + b.b) + b.q);
    R.pointAt(s, lat, 0, out);
    out.y = R.waterYAt(s) + 0.5 + 2.2 * (0.5 + 0.5 * Math.sin(t * 0.9 + b.r));
    return out;
  };
  const stepSwallows = (dt: number) => {
    if (!swallows.length) return;
    const ok = warmth(ctx) > 0.5 && night() < 0.35 && !badWeather() && hour() > 6.5 && hour() < 20;
    const t = ctx.clock.minutes;
    if (swallowState === 'nest' && ok) {
      swallowState = 'out'; swallowT = 0;
      swallows.forEach((b) => { b.x = nest.x; b.y = nest.y; b.z = nest.z; b.vx = b.vy = b.vz = 0; });
    }
    if ((swallowState === 'out' || swallowState === 'hunt') && !ok) swallowState = 'home';
    swallowT += dt;
    swallows.forEach((b, i) => {
      if (swallowState === 'nest') return;
      if (swallowState === 'out' && b.away && swallowT > i * 0.8) { ctx.origins.audit('nature', 'spawn', 'animals', tmp.copy(nest), 'swallow'); setAway(b, false); }
      if (b.away) return;
      if (swallowState === 'home') {
        const d = steerTo(b, nest.x, nest.y, nest.z, Math.min(9, 1.5 + Math.hypot(nest.x - b.x, nest.z - b.z) * 0.8), dt, 3);
        if (d < 5) { const k = Math.min(1, dt * 2.5); b.x += (nest.x - b.x) * k; b.y += (nest.y - b.y) * k; b.z += (nest.z - b.z) * k; }
        faceVel(b, dt);
        if (d < 1.5) { ctx.origins.audit('nature', 'despawn', 'animals', tmp.copy(nest), 'swallow'); setAway(b, true); }
      } else {
        swallowTarget(b, t, tmp);
        steerTo(b, tmp.x, tmp.y, tmp.z, 10, dt, 3.5);
        faceVel(b, dt);
      }
    });
    if (swallowState === 'out' && swallows.every((b) => !b.away)) swallowState = 'hunt';
    if (swallowState === 'home' && swallows.every((b) => b.away)) swallowState = 'nest';
  };

  // ── murmuration ──
  const murShape = (b: Bird, tau: number, k: number, out: THREE.Vector3) => {
    const rx = (20 + 10 * Math.sin(tau * 0.11)) * k, ry = (6 + 4 * Math.sin(tau * 0.17 + 1)) * k, rz = (16 + 8 * Math.cos(tau * 0.09)) * k;
    const th = tau * 0.07;
    let x = Math.sin(tau * b.a + b.p) * rx, y = Math.sin(tau * b.b + b.q) * ry, z = Math.cos(tau * b.a * 0.83 + b.r) * rz;
    y += 3.5 * k * Math.sin(x * 0.18 - tau * 1.6);
    const c = Math.cos(th), s = Math.sin(th);
    out.set(x * c + z * s, y, -x * s + z * c);
    return out;
  };
  const murCenter = (tau: number, out: THREE.Vector3) => out.set(murC.x + Math.sin(tau * 0.05) * 22, 30 + 5 * Math.sin(tau * 0.08), murC.z + Math.sin(tau * 0.07 + 1) * 16);
  const cen = new THREE.Vector3(), off = new THREE.Vector3();
  const stepMurmuration = (dt: number) => {
    if (!starlings.length) return;
    const c = ctx.clock;
    const nf = night();
    if (mur.state === 'off') {
      if (mur.day !== c.day && c.hour > 15 && c.hour < 22 && nf > 0.2 && nf < 0.55 && !badWeather()) {
        mur.day = c.day;
        if (warmth(ctx) < 0.8 || rnd() < 0.5) {
          mur.state = 'in'; mur.t = 0;
          for (const b of starlings) {
            murShape(b, 0, 0.35, off);
            b.x = mur.from.x + off.x; b.y = mur.from.y + off.y; b.z = mur.from.z + off.z;
            ctx.origins.audit('nature', 'spawn', 'animals', tmp.set(b.x, b.y, b.z), 'starling');
            setAway(b, false);
          }
        }
      }
      return;
    }
    mur.t += dt;
    const tau = mur.t;
    const IN = 30, SHOW = 75, OUT = 36;
    let k = 1;
    if (mur.state === 'in') {
      const u = clamp01(tau / IN);
      murCenter(tau, cen).lerp(tmp.copy(mur.from), 1 - u * u * (3 - 2 * u));
      k = lerp(0.35, 1, u);
      if (tau >= IN) mur.state = 'show';
    } else if (mur.state === 'show') {
      murCenter(tau, cen);
      if (tau >= IN + SHOW) mur.state = 'out';
    } else {
      const u = clamp01((tau - IN - SHOW) / OUT);
      murCenter(tau, cen).lerp(tmp.copy(mur.to), u * u);
      k = lerp(1, 0.35, u);
      if (u >= 1) {
        mur.state = 'off';
        for (const b of starlings) { ctx.origins.audit('nature', 'despawn', 'animals', tmp.set(b.x, b.y, b.z), 'starling'); setAway(b, true); }
        return;
      }
    }
    for (const b of starlings) {
      b.px = b.x; b.py = b.y; b.pz = b.z;
      murShape(b, tau, k, off);
      b.x = cen.x + off.x; b.y = cen.y + off.y; b.z = cen.z + off.z;
      const inv = 1 / Math.max(1e-3, dt);
      b.vx = (b.x - b.px) * inv; b.vy = (b.y - b.py) * inv; b.vz = (b.z - b.pz) * inv;
      faceVel(b, dt);
    }
  };

  // ── butterflies ──
  const stepButterflies = (dt: number) => {
    const ok = warmth(ctx) > 0.45 && night() < 0.3 && !badWeather() && ctx.wind.speed < 8;
    for (const bf of butterflies) {
      const b = bf.b;
      bf.rest = !ok;
      if (bf.rest) {
        const gy = L.heightAt(b.x, b.z) + 0.15;
        if (b.y > gy + 0.05) { b.y -= dt * 0.6; b.groundT = 0; } else { b.y = gy; b.groundT = 1; }
        continue;
      }
      b.groundT = 0;
      b.hopT -= dt;
      if (b.hopT <= 0) {
        b.hopT = 0.3 + rnd() * 0.9;
        const toHome = Math.hypot(b.x - bf.hx, b.z - bf.hz) > 8;
        const a = toHome ? Math.atan2(bf.hz - b.z, bf.hx - b.x) + (rnd() - 0.5) : rnd() * TAU;
        b.tx = Math.cos(a); b.tz = Math.sin(a);
        b.h = L.heightAt(b.x, b.z) + 0.4 + rnd() * 1.3;
      }
      b.vx += (b.tx * 0.9 - b.vx) * Math.min(1, dt * 3);
      b.vz += (b.tz * 0.9 - b.vz) * Math.min(1, dt * 3);
      b.x += b.vx * dt; b.z += b.vz * dt;
      b.y += (b.h - b.y) * Math.min(1, dt * 2) + Math.sin(ctx.clock.minutes * 7 + b.p) * 0.02;
      faceVel(b, dt);
    }
  };

  // ── scare ──
  const scare = (pos: THREE.Vector3, r: number) => {
    for (const fl of crowFlocks) {
      if (fl.state !== 'feed' && fl.state !== 'land') continue;
      if (Math.hypot(fl.cx - pos.x, fl.cz - pos.z) > r + 30) continue;
      fl.state = 'aloft'; fl.timer = 25 + rnd() * 30;
      for (const b of fl.birds) { b.vy = 3 + rnd() * 2; b.groundT = 0; }
      ctx.bus.emit('audio:cue', { cue: 'crow', pos: new THREE.Vector3(fl.cx, 5, fl.cz), volume: 0.6 });
    }
    if (Math.hypot(tower.x - pos.x, tower.z - pos.z) < r + 20) rookAgit = 1;
  };

  // ambient cues
  let cueT = 5;
  const cues = (dt: number) => {
    cueT -= dt;
    if (cueT > 0) return;
    cueT = 7 + rnd() * 10;
    const f = ctx.view.focus;
    const nf = night();
    if (nf < 0.4 && !badWeather()) {
      if (Math.hypot(tower.x - f.x, tower.z - f.z) < 120 && rnd() < 0.5) ctx.bus.emit('audio:cue', { cue: 'crow', pos: tower.clone(), volume: 0.35 });
      else ctx.bus.emit('audio:cue', { cue: 'birdsong', pos: f.clone(), volume: 0.3 });
    }
  };

  // ── update / sync ──
  const update = (dtM: number, dt: number) => {
    if (dtM > 0) {
      for (const fl of crowFlocks) stepCrows(fl, dtM);
      stepRooks(dtM);
      stepSwallows(dtM);
      stepMurmuration(dtM);
      stepButterflies(dtM);
      for (const b of all) {
        const k = Math.min(1, dtM * 5);
        b.ground += (b.groundT - b.ground) * k;
        b.peck *= Math.max(0, 1 - dtM * 1.5);
        if (b.c) { b.c.info.pos.set(b.x, b.y, b.z); b.c.info.state = b.ground > 0.5 ? 'feeding' : 'flying'; }
      }
    }
    cues(dt);
  };
  const sync = (D: Drawer) => {
    for (const b of all) {
      if (b.away) continue;
      tmp.set(b.x, b.y, b.z);
      if (!ctx.view.isVisible(tmp, 2)) continue;
      const i = D.next(hash1(b.slot * 0.91 + 7), b.cols);
      if (i < 0) break;
      const look = KIND_LOOK[b.kind];
      e3.set(b.bank * (1 - b.ground), b.yaw, 0, 'YZX');
      q4.setFromEuler(e3);
      s3.set(look.scale[0], look.scale[1], look.scale[2]);
      m4.compose(tmp, q4, s3);
      rig.setMatrix(i, m4);
      const glide = b.kind === 'swallow' || b.kind === 'rook' ? (Math.sin(ctx.clock.minutes * 0.7 + b.p) > 0.3 ? 0.15 : 1) : 1;
      rig.setAnim(i, look.freq, (b.kind === 'butterfly' ? 1 : 0.8) * glide, b.ground, b.bank * 0.5);
      rig.setAux(i, b.peck, 0, 0, 0);
    }
  };
  return {
    update, sync, scare,
    flying() { let n = 0; for (const b of all) if (!b.away && b.c) n++; return n; },
  };
}
