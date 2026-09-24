import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { Anchor, BoatInfo, BoatKind, PersonSpec } from '../core/apis';
import type { InstancedRig } from '../core/rig';
import { HORSE_STRIDE } from '../core/rigs/horse';
import type { Rng } from '../core/rng';
import type { Water } from './water';
import type { Puffs } from './smoke';
import type { BoatProbe } from './fowl';
import { BOATK, BOAT_DIMS } from './rigs';
import { Path } from './life';
import { TAU, clamp, clamp01, turnToward, wrapPi, yawOf, warmth, hash1, type Drawer } from './util';

/**
 * BOATS ON THE ASHBOURNE (one instanced draw + the shared nature horse rig + the puff draw).
 *
 * - Rowing skiffs and a punt put out from the Ashcombe Rowing Club boathouse on fine days (they slide out of the
 *   boathouse onto the slip and back in again — the boathouse is their origin/sink), rowed by people riding the
 *   boat's Anchor (oars animate in the shader from the stroke phase).
 * - The steam launch *Kingfisher* lies at mooring m1; once a day she takes a party down through Millbridge lock
 *   to the mill tail and back (funnel puffs; funnel hinges down under the bridges; whistle; bow lamp at night).
 * - The narrowboat *Perseverance* is towed by a horse walking the towpath: she comes down from Glenmoor through
 *   the river:up portal (the horse via path:towUp), winds in the mill pool, unloads at the mill wharf, lies
 *   overnight at m3 with her cabin lamp lit and the stove smoking while the horse sleeps in the lock stable, and
 *   leaves upstream in the morning.
 * - Every boat bobs, rolls and pitches in the shader, so a moored boat is never frozen.
 * Boats enter/leave ONLY via the river portals, the boathouse or a mooring (audited).
 */
export interface Boats {
  update(dtM: number, dt: number): void;
  sync(dt: number, DB: Drawer, DH: Drawer): void;
  probe: BoatProbe;
  request(kind: BoatKind, opts?: { from?: string; riders?: PersonSpec[]; tag?: string; route?: 'loop' | 'upstream' | 'downstream' | 'regatta' }): string | null;
  anchorOf(id: string): Anchor | null;
  infos(): BoatInfo[];
  get(id: string): BoatInfo | undefined;
  raycast(r: THREE.Raycaster): string | null;
  count(): number;
  /** river s of the lock-keeper / lock state for audio */
  lockBusy(): boolean;
  debug(): unknown[];
}

type Pose = 'sit' | 'drive' | 'row' | 'stand' | 'pole' | 'fish';
interface SeatDef { pose: Pose; back: boolean }
const SEATS: Record<BoatKind, SeatDef[]> = {
  rowing: [{ pose: 'row', back: true }, { pose: 'sit', back: false }, { pose: 'sit', back: true }],
  gig4: [{ pose: 'row', back: true }, { pose: 'row', back: true }, { pose: 'row', back: true }, { pose: 'row', back: true }, { pose: 'sit', back: false }],
  launch: [{ pose: 'stand', back: false }, { pose: 'sit', back: false }, { pose: 'sit', back: false }, { pose: 'sit', back: false }, { pose: 'sit', back: false }, { pose: 'stand', back: false }],
  narrowboat: [{ pose: 'stand', back: false }],
  punt: [{ pose: 'pole', back: false }, { pose: 'sit', back: true }, { pose: 'sit', back: true }],
};
const KIND_K: Record<BoatKind, number> = { rowing: BOATK.rowing, gig4: BOATK.gig4, launch: BOATK.launch, narrowboat: BOATK.narrowboat, punt: BOATK.punt };
const DRAFT: Record<BoatKind, number> = { rowing: 0.14, gig4: 0.1, launch: 0.32, narrowboat: 0.36, punt: 0.08 };
const COLORS: Record<BoatKind, number[]> = {
  rowing: [0x7a4a2a, 0xd8c8a0, 0x6a4a30, 0x2b3a67],
  gig4: [0x9a6a3a, 0xe8dcc0, 0x6a4a30, 0x7a2230],
  launch: [0x1f3a2e, 0xc9a24a, 0x7a2230, 0xd8cfb8],
  narrowboat: [0x2a2420, 0x2f5f3a, 0x8a7e5e, 0xc9a24a],
  punt: [0x9a7a4a, 0x7a5a32, 0x6a5030, 0xb03a2a],
};
const SKIFF_NAMES = ['Dabchick', 'Moorhen', 'Kittiwake', 'Water Rat', 'Minnow', 'Grebe', 'Coot'];
const ROT_FWD = new THREE.Matrix4().makeRotationY(Math.PI / 2);
const ROT_BACK = new THREE.Matrix4().makeRotationY(-Math.PI / 2);

type Task = { name: string; started?: boolean; start?: (b: Boat) => void; step: (b: Boat, dt: number) => boolean };

interface TowHorse {
  slot: number;
  x: number; y: number; z: number; yaw: number; phase: number; speed: number;
  state: 'tow' | 'graze' | 'walk' | 'stable' | 'toHitch' | 'offmap';
  path: Path | null; d: number; then: 'stable' | 'graze' | 'hitch' | null;
  graze: number; stampLeg: number; stampPh: number; timer: number; tx: number; tz: number;
}

interface Boat {
  id: string; kind: BoatKind; k: number; name: string; info: BoatInfo;
  slot: number;
  free: boolean;          // free-mode (explicit x/z/yaw) vs river mode (s/lat)
  s: number; lat: number; dir: 1 | -1; spd: number;
  x: number; y: number; z: number; yaw: number; px: number; pz: number;
  load: number; stroke: number; strokeAmp: number; funnel: number; lamp: number;
  tasks: Task[];
  riders: string[];
  anchor: Anchor; originId: string; removeOrigin: (() => void) | null;
  where: string | null;   // mooring / boathouse id while moored
  away: boolean;          // off-map / not drawn
  home: 'boathouse' | 'm1' | 'upstream';
  race: number;
  tag?: string;
  horse: TowHorse | null;
  smokeT: number;
  wantRiders: PersonSpec[] | null;
  lastStroke: number;
  recalled: boolean;
}

export function createBoats(ctx: Ctx, rig: InstancedRig, horses: InstancedRig, water: Water, puffs: Puffs, rng: Rng): Boats {
  const L = ctx.layout, R = L.river, K = ctx.quality.knobs;
  const rnd = () => rng.next();
  const lock = R.lock, weirS = R.weir.s;
  const boats: Boat[] = [];
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), m4 = new THREE.Matrix4(), m4b = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e3 = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
  let seq = 0;
  const hw = (s: number) => R.widthAt(s) / 2;
  const mooring = (id: string) => R.moorings.find((m) => m.id === id) ?? R.moorings[0];
  const bh = R.boathouse;
  const hour = () => ctx.clock.hour;
  const night = () => ctx.reg.atmosphere?.nightFactor ?? 0;
  const weather = () => ctx.reg.atmosphere?.weather ?? 'clear';
  const people = () => ctx.reg.people;
  const bridgesS = L.bridges.filter((b) => b.riverS !== undefined).map((b) => b.riverS as number);
  const nearBridge = (s: number, r: number) => bridgesS.some((bs) => Math.abs(bs - s) < r);

  // static boathouse origin (boats + their crews come and go through it)
  const bhIn = bh.center.clone().setY(R.waterYAt(bh.slipS) - 0.1);
  ctx.origins.add({ id: 'nature:boathouse', kind: 'boat', owner: 'nature', pos: (o) => o.copy(bhIn), inside: (o) => o.copy(bhIn), radius: 7, for: ['boats', 'people'], open: () => true, building: 'river:boathouse' });
  // the lock stable (the towpath horse sleeps at the lock-keeper's)
  const keeperB = L.buildings.find((b) => b.id === 'river:lockCottage');
  const stableDoor = keeperB ? keeperB.doors[0].clone() : R.pointAt(weirS, 12, -2.2);
  const stableIn = keeperB ? keeperB.doorsIn[0].clone() : stableDoor.clone();
  ctx.origins.add({ id: 'nature:lockStable', kind: 'door', owner: 'nature', pos: (o) => o.copy(stableDoor), inside: (o) => o.copy(stableIn), radius: 2.5, for: ['animals'], open: () => true, building: keeperB?.id });

  // ── lock machinery (gates 0,1 upper · 2,3 lower; level 0 low .. 1 high) ──
  const gates = [0, 0, 0, 0], gateT = [0, 0, 0, 0];
  let level = 1, levelT = 1, lockOwner: Boat | null = null, keeperId: string | null = null;
  const pushLock = () => {
    const W = ctx.reg.world;
    try { for (let i = 0; i < 4; i++) W?.setLockGate?.(i, gates[i]); W?.setLockLevel?.(level); } catch { /* world stub */ }
    water.lockLevel = level;
  };
  const stepLock = (dt: number) => {
    let changed = false;
    for (let i = 0; i < 4; i++) {
      const d = gateT[i] - gates[i];
      if (Math.abs(d) > 1e-4) { gates[i] += clamp(d, -dt / 4, dt / 4); changed = true; }
    }
    const dl = levelT - level;
    if (Math.abs(dl) > 1e-4) { level += clamp(dl, -dt / 16, dt / 16); changed = true; }
    if (changed) pushLock();
  };
  const gatesAt = (ids: number[], v: number) => ids.every((i) => Math.abs(gates[i] - v) < 0.01);
  pushLock();

  // ── seating / anchors ──
  const doorPoint = (b: Boat, out: THREE.Vector3): THREE.Vector3 => {
    if (b.where === 'boathouse' || (b.free && b.home === 'boathouse')) return out.copy(bh.door);
    // step ashore on the nearer bank (towpath side if moored there)
    const side = b.lat >= 0 ? 1 : -1;
    if (side > 0) return R.pointAt(b.s, R.towpath.lateral(b.s) - 0.6, R.towpath.yAt(b.s), out);
    R.pointAt(b.s, -(hw(b.s) + 1.6), 0, out);
    out.y = L.heightAt(out.x, out.z);
    return out;
  };
  const boatMatrix = (b: Boat, out: THREE.Matrix4) => {
    e3.set(0, b.yaw, 0, 'YZX');
    q4.setFromEuler(e3);
    return out.compose(tmp2.set(b.x, b.y, b.z), q4, one);
  };
  const mkAnchor = (b: Boat): Anchor => ({
    id: b.id,
    seats: SEATS[b.kind].length,
    seatMatrix(seat, out) {
      if (!boats.includes(b) || b.away) return false;
      const d = BOAT_DIMS[b.k];
      const sp = d.seats[seat] ?? d.seats[0];
      boatMatrix(b, out);
      m4b.makeTranslation(sp.x, sp.y, sp.z);
      out.multiply(m4b);
      out.multiply((SEATS[b.kind][seat] ?? SEATS[b.kind][0]).back ? ROT_BACK : ROT_FWD);
      return true;
    },
    seatPose(seat) { return (SEATS[b.kind][seat] ?? SEATS[b.kind][0]).pose; },
    hidden() { return false; },
    doorPoint(out) { return doorPoint(b, out); },
    stopped() { return b.where !== null; },
  });
  const seatRiders = (b: Boat, specs: PersonSpec[]) => {
    const P = people();
    if (!P || !specs.length) return;
    try {
      const n = Math.min(specs.length, SEATS[b.kind].length);
      const ids = P.spawnInside(b.originId, specs.slice(0, n)) ?? [];
      if (ids.length) { P.ride(ids, b.anchor, ids.map((_, i) => i)); b.riders.push(...ids); }
    } catch { /* people not ready */ }
    b.info.riders = b.riders;
  };
  const landRiders = (b: Boat, to?: THREE.Vector3) => {
    const P = people();
    if (P && b.riders.length) { try { P.disembark(b.id, { then: 'dismiss', to }); } catch { /* */ } }
    b.riders = [];
    b.info.riders = b.riders;
  };

  // ── boat factory ──
  const mkBoat = (kind: BoatKind, name: string, home: Boat['home']): Boat | null => {
    const slot = rig.alloc();
    if (slot < 0) return null;
    const id = `boat:${kind}:${++seq}`;
    rig.setColors(slot, COLORS[kind]);
    const info: BoatInfo = { id, kind, name, pos: new THREE.Vector3(), yaw: 0, speed: 0, state: 'moored', riders: [] };
    const b = {
      id, kind, k: KIND_K[kind], name, info, slot, free: false, s: 0, lat: 0, dir: 1 as 1 | -1, spd: 0,
      x: 0, y: 0, z: 0, yaw: 0, px: 0, pz: 0, load: 0, stroke: rnd() * TAU, strokeAmp: 0, funnel: 0, lamp: 0,
      tasks: [] as Task[], riders: [] as string[], anchor: null as unknown as Anchor, originId: `boat:${id}`, removeOrigin: null as (() => void) | null,
      where: null as string | null, away: false, home, race: 1, horse: null as TowHorse | null, smokeT: rnd(), wantRiders: null as PersonSpec[] | null, lastStroke: 0, recalled: false,
    } satisfies Boat;
    b.anchor = mkAnchor(b);
    const bb = b as Boat;
    b.removeOrigin = ctx.origins.add({
      id: b.originId, kind: 'boat', owner: 'nature', radius: 4, for: ['people'],
      pos: (o) => o.set(bb.x, bb.y + 0.3, bb.z), inside: (o) => o.set(bb.x, bb.y + 0.3, bb.z),
      open: () => bb.where !== null || bb.away,
    });
    boats.push(bb);
    return bb;
  };
  const freeBoat = (b: Boat) => {
    landRiders(b);
    rig.free(b.slot);
    b.removeOrigin?.();
    if (b.horse) { horses.free(b.horse.slot); b.horse = null; }
    const i = boats.indexOf(b);
    if (i >= 0) boats.splice(i, 1);
    if (lockOwner === b) lockOwner = null;
  };

  // ── pose helpers ──
  const placeRiver = (b: Boat) => {
    R.pointAt(b.s, b.lat, 0, tmp);
    b.x = tmp.x; b.z = tmp.z;
    const inL = water.inLock(b.s, b.lat);
    const wy = inL ? THREE.MathUtils.lerp(-3.5, -3.0, level) : b.s > weirS ? R.waterYAt(weirS + 1) : R.waterYAt(b.s);
    b.y = wy - DRAFT[b.kind] - (b.kind === 'narrowboat' ? b.load * 0.14 : 0);
    b.info.pos.set(b.x, b.y, b.z);
  };
  const faceMotion = (b: Boat, dt: number, rate = 1.4) => {
    const dx = b.x - b.px, dz = b.z - b.pz;
    if (dx * dx + dz * dz > 1e-6) b.yaw = turnToward(b.yaw, yawOf(dx, dz), dt * rate);
    else if (!b.free && b.where === null) b.yaw = turnToward(b.yaw, R.poly.yawAt(b.s) + (b.dir < 0 ? Math.PI : 0), dt * 0.3);
  };
  const strokeLen = (b: Boat) => (b.kind === 'rowing' ? 1.7 : b.kind === 'gig4' ? 2.6 : b.kind === 'punt' ? 3.2 : 4);
  /** keep clear of other boats: slow for / pass the one ahead, give way to oncoming craft (dodge = lateral shift) */
  const avoid = { f: 1, dodge: 0 };
  const avoidance = (b: Boat) => {
    let f = 1, dodge = 0;
    for (const o of boats) {
      if (o === b || o.away || o.free) continue;
      const ds = (o.s - b.s) * b.dir;
      const reach = (BOAT_DIMS[o.k].len + BOAT_DIMS[b.k].len) * 0.5 + 8;
      if (ds < -2 || ds > reach) continue;
      const dl = o.lat - b.lat, adl = Math.abs(dl);
      const clearL = (BOAT_DIMS[o.k].beam + BOAT_DIMS[b.k].beam) * 0.5 + 1.2;
      if (adl > clearL + 0.8) continue;
      const push = (dl >= 0 ? -1 : 1) * (clearL + 0.8 - adl);
      if (o.dir !== b.dir || o.spd < 0.08) {
        dodge += push * 1.2;
        if (ds > 0) f = Math.min(f, adl < clearL ? clamp01((ds - BOAT_DIMS[b.k].len * 0.5) / reach) * 0.8 + 0.1 : 0.8);
      } else if (ds > 0) {
        if (o.spd < b.spd * 0.85) dodge += push;
        if (adl < clearL) f = Math.min(f, Math.max(0.15, o.spd / Math.max(0.1, b.spd)));
      }
    }
    avoid.f = f; avoid.dodge = dodge;
    return avoid;
  };
  /** river-mode motion toward sTarget in lane; returns remaining distance */
  const riverMove = (b: Boat, dt: number, sTarget: number, speed: number, lane: number, latRate = 0.28) => {
    b.free = false;
    const ds = sTarget - b.s, dist = Math.abs(ds);
    if (dist > 0.6) { const want: 1 | -1 = ds > 0 ? 1 : -1; if (want !== b.dir) b.dir = want; }
    const acc = b.kind === 'narrowboat' ? 0.12 : b.kind === 'launch' ? 0.35 : 0.5;
    const av = lockOwner === b ? null : avoidance(b);
    const want = Math.min(speed * (av ? av.f : 1), Math.sqrt(2 * acc * Math.max(0, dist - 0.2)));
    b.spd += clamp(want - b.spd, -acc * dt * 1.5, acc * dt);
    if (b.spd < 0) b.spd = 0;
    b.s += b.dir * Math.min(dist, b.spd * dt);
    const ln = av && av.dodge !== 0 ? lane + clamp(av.dodge, -4, 4) : lane;
    const dl = ln - b.lat, lr = (av && av.dodge !== 0 ? Math.max(latRate, 0.6) : latRate) * Math.max(0.35, b.spd) * dt;
    b.lat += clamp(dl, -lr, lr);
    return dist;
  };
  const laneFor = (b: Boat, s: number) => {
    const h = hw(s);
    const beam = BOAT_DIMS[b.k].beam;
    // the towed narrowboat keeps to the towpath (west, +lat) side; everyone else keeps to the right of travel
    if (b.kind === 'narrowboat') return clamp(h * 0.4, 0, h - beam / 2 - 1.2);
    return b.dir * clamp(h * 0.32, 0, h - beam / 2 - 1);
  };

  // ── tasks ──
  const tDo = (name: string, fn: (b: Boat) => void): Task => ({ name, step: (b) => { fn(b); return true; } });
  const tWait = (name: string, pred: (b: Boat) => boolean, onWait?: (b: Boat, dt: number) => void): Task => ({ name, step: (b, dt) => { onWait?.(b, dt); return pred(b); } });
  const tGo = (sTarget: number | ((b: Boat) => number), speed: number, lane?: number | ((b: Boat) => number), latRate?: number): Task => {
    let st = 0;
    return {
      name: 'go',
      start: (b) => { st = typeof sTarget === 'function' ? sTarget(b) : sTarget; b.where = null; b.info.state = 'underway'; },
      step: (b, dt) => {
        const ln = lane === undefined ? laneFor(b, b.s) : typeof lane === 'function' ? lane(b) : lane;
        const d = riverMove(b, dt, st, speed * b.race, ln, latRate ?? 0.28);
        return d < 0.5 && (latRate === undefined || Math.abs(ln - b.lat) < 0.4);
      },
    };
  };
  const tHold = (sec: number | (() => number), drift = 0.05): Task => {
    let t = 0;
    return {
      name: 'hold', start: () => { t = typeof sec === 'function' ? sec() : sec; },
      step: (b, dt) => {
        b.spd *= Math.max(0, 1 - dt * 1.5);
        b.s += b.dir * b.spd * dt + water.flowSpeed(b.s) * drift * dt;
        t -= dt;
        return t <= 0;
      },
    };
  };
  const tTurn = (sec: number): Task => {
    let t = 0, y0 = 0;
    return {
      name: 'turn',
      start: (b) => { t = 0; y0 = b.yaw; b.spd = 0; },
      step: (b, dt) => {
        t += dt;
        const u = clamp01(t / sec), e = u * u * (3 - 2 * u);
        const target = y0 + Math.PI * (b.lat >= 0 ? 1 : -1);
        b.yaw = y0 + (target - y0) * e;
        b.spd = 0.15 * Math.sin(Math.PI * u);
        if (u >= 1) { b.dir = (b.dir === 1 ? -1 : 1); b.yaw = R.poly.yawAt(b.s) + (b.dir < 0 ? Math.PI : 0) + wrapPi(b.yaw - (R.poly.yawAt(b.s) + (b.dir < 0 ? Math.PI : 0))); return true; }
        return false;
      },
    };
  };
  const tMoor = (where: string, s: number, lat: number, until: (b: Boat) => boolean, onMoored?: (b: Boat, dt: number) => void): Task => {
    let ph = 0;
    return {
      name: `moor:${where}`,
      start: () => { ph = 0; },
      step: (b, dt) => {
        if (ph === 0) {
          const d = riverMove(b, dt, s, 0.6, lat, 0.6);
          if (d < 0.5 && Math.abs(b.lat - lat) < 0.25) {
            ph = 1; b.where = where; b.spd = 0; b.info.state = 'moored';
            ctx.bus.emit('boat:moored', { boatId: b.id, where });
          }
          return false;
        }
        b.lat += (lat - b.lat) * Math.min(1, dt);
        b.s += (s - b.s) * Math.min(1, dt * 0.5);
        onMoored?.(b, dt);
        if (until(b)) {
          b.where = null;
          ctx.bus.emit('boat:departed', { boatId: b.id, where });
          return true;
        }
        return false;
      },
    };
  };
  /** free-mode path (boathouse ↔ slip ↔ water) */
  const tFree = (pts: THREE.Vector3[], speed: number, then: (b: Boat) => void): Task => {
    let path: Path | null = null, d = 0;
    return {
      name: 'free',
      start: (b) => { path = new Path(pts); d = 0; b.free = true; b.info.state = 'underway'; },
      step: (b, dt) => {
        const p = path!;
        const want = Math.min(speed, 0.3 + (p.length - d) * 0.6, 0.3 + d * 0.8);
        b.spd += (want - b.spd) * Math.min(1, dt * 2);
        d = Math.min(p.length, d + b.spd * dt);
        p.at(d, tmp);
        b.x = tmp.x; b.z = tmp.z;
        b.y = tmp.y - DRAFT[b.kind];
        if (d >= p.length - 0.02) { then(b); return true; }
        return false;
      },
    };
  };
  const slipWater = new THREE.Vector3();
  R.pointAt(bh.slipS, -(hw(bh.slipS) - 3.2), R.waterYAt(bh.slipS), slipWater);
  const slipPt = bh.slip.clone().setY(R.waterYAt(bh.slipS));
  const toRiverAt = (b: Boat) => { const n = R.nearest(slipWater); b.s = n.s; b.lat = n.lat; b.free = false; };
  const slipBusy = (b: Boat) => boats.some((o) => o !== b && !o.away && ((o.free && o.where === null) || (Math.hypot(o.x - slipWater.x, o.z - slipWater.z) < 7 && o.where === null)));
  const tSlipOut = (): Task[] => [
    tWait('slip clear', (b) => !slipBusy(b)),
    tDo('launch', (b) => { b.where = null; b.info.state = 'underway'; ctx.bus.emit('boat:departed', { boatId: b.id, where: 'boathouse' }); ctx.bus.emit('audio:cue', { cue: 'splash', pos: slipPt.clone(), volume: 0.4 }); }),
    tFree([bhIn.clone(), slipPt.clone(), slipWater.clone()], 0.8, toRiverAt),
  ];
  const tSlipIn = (): Task[] => [
    tGo(() => R.nearest(slipWater).s + 6, 1.0),
    tWait('slip clear', (b) => !boats.some((o) => o !== b && !o.away && o.free && o.where === null), (b, dt) => { b.spd *= Math.max(0, 1 - dt); }),
    tGo(() => R.nearest(slipWater).s, 0.8, () => R.nearest(slipWater).lat, 0.8),
    tFree([slipWater.clone(), slipPt.clone(), bhIn.clone()], 0.7, (b) => { b.where = 'boathouse'; b.info.state = 'hauled'; }),
    tDo('ashore', (b) => { landRiders(b, bh.door); ctx.bus.emit('boat:moored', { boatId: b.id, where: 'boathouse' }); }),
    tHold(3, 0),
    tDo('stow', (b) => { ctx.origins.audit('nature', 'despawn', 'boats', bhIn, `${b.kind} ${b.id}`); freeBoat(b); }),
  ];
  const tLock = (down: boolean): Task => {
    let ph = 0, keeperAsked = false;
    const mid = (lock.s0 + lock.s1) / 2;
    const sIn = down ? lock.s0 - 11 : lock.s1 + 11, sOut = down ? lock.s1 + 12 : lock.s0 - 12;
    const entry = down ? [0, 1] : [2, 3], exit = down ? [2, 3] : [0, 1];
    const set = (ids: number[], v: number) => { for (const i of ids) gateT[i] = v; };
    return {
      name: down ? 'lockDown' : 'lockUp',
      start: () => { ph = 0; keeperAsked = false; },
      step: (b, dt) => {
        switch (ph) {
          case 0: {
            const d = riverMove(b, dt, sIn, 0.8, lock.lateral, 0.5);
            if (!keeperAsked && Math.abs(b.s - sIn) < 60) {
              keeperAsked = true;
              const P = people();
              if (P && !keeperId) {
                try {
                  const gp = lock.gates[down ? 0 : 2].clone();
                  gp.add(tmp.copy(lock.gates[down ? 0 : 2]).sub(lock.gates[down ? 1 : 3]).setY(0).normalize().multiplyScalar(1.6));
                  gp.y = R.towpath.yAt(mid);
                  keeperId = P.summonActor('lockkeeper', gp, { from: keeperB ? `door:${keeperB.id}:0` : undefined, timeoutMin: 40 }).id;
                } catch { keeperId = null; }
              }
              ctx.bus.emit('audio:cue', { cue: 'boatWhistle', pos: new THREE.Vector3(b.x, b.y, b.z), volume: b.kind === 'launch' ? 0.8 : 0.2 });
            }
            if (d < 0.6 && (lockOwner === null || lockOwner === b)) { lockOwner = b; ph = 1; b.info.state = 'inLock'; ctx.bus.emit('audio:cue', { cue: 'lock', pos: R.weir.pos.clone(), volume: 0.6 }); }
            return false;
          }
          case 1:
            b.spd *= 0.9;
            set(exit, 0);
            if (!gatesAt(exit, 0)) return false;
            levelT = down ? 1 : 0;
            if (Math.abs(level - levelT) > 0.005) return false;
            set(entry, 1);
            if (gatesAt(entry, 1)) ph = 2;
            return false;
          case 2:
            if (riverMove(b, dt, mid, 0.55, lock.lateral, 0.6) < 0.4) { ph = 3; b.spd = 0; }
            return false;
          case 3:
            set(entry, 0);
            if (gatesAt(entry, 0)) { ph = 4; ctx.bus.emit('audio:cue', { cue: 'lock', pos: R.weir.pos.clone(), volume: 0.7 }); }
            return false;
          case 4:
            levelT = down ? 0 : 1;
            b.lat += (lock.lateral - b.lat) * Math.min(1, dt);
            if (Math.abs(level - levelT) < 0.005) ph = 5;
            return false;
          case 5:
            set(exit, 1);
            if (gatesAt(exit, 1)) ph = 6;
            return false;
          default: {
            const d = riverMove(b, dt, sOut, 0.8, lock.lateral * 0.5, 0.35);
            const clear = down ? b.s > lock.s1 + 9 : b.s < lock.s0 - 9;
            if (clear && lockOwner === b) {
              lockOwner = null;
              set(exit, 0);
              b.info.state = 'underway';
              if (keeperId) { const id = keeperId; keeperId = null; try { void people()?.dismissActor(id); } catch { /* */ } }
            }
            return d < 0.6 && lockOwner !== b;
          }
        }
      },
    };
  };
  const tExit = (up: boolean): Task => {
    const portal = up ? R.portals.up : R.portals.down;
    const sEnd = up ? 6 : R.length - 6;
    return {
      name: 'exit',
      step: (b, dt) => {
        const d = riverMove(b, dt, sEnd, b.kind === 'narrowboat' ? 1.05 : 1.6, laneFor(b, b.s));
        const beyond = up ? b.s < portal.s - 12 : b.s > portal.s + 12;
        if (beyond || d < 0.6) {
          ctx.origins.audit('nature', 'despawn', 'boats', tmp.set(b.x, b.y, b.z), `${b.kind} ${b.id} @river portal`);
          landRiders(b);
          b.away = true;
          b.info.state = 'hauled';
          if (b.horse) { ctx.origins.audit('nature', 'despawn', 'animals', tmp.set(b.horse.x, b.horse.y, b.horse.z), 'bargehorse'); b.horse.state = 'offmap'; }
          return true;
        }
        return false;
      },
    };
  };

  // ── boathouse craft ──
  const outing = (b: Boat, route: 'loop' | 'regatta' | 'upstream' | 'downstream') => {
    b.tasks.push(...tSlipOut());
    const sl = R.nearest(slipWater).s;
    const reg = R.reaches.find((r) => r.id === 'regatta');
    const lo = (reg?.s0 ?? 350) + 10, hi = Math.min(lock.s0 - 45, 585);
    if (b.kind === 'punt') {
      // punts potter in the quiet reach between the boathouse and the arches (the pole won't clear the bridges)
      const a = sl + 8 + rnd() * 20, c = sl - 10 - rnd() * 16;
      b.tasks.push(tGo(a, 0.8), tHold(() => 6 + rnd() * 14), tTurn(14), tGo(c, 0.8), tHold(() => 8 + rnd() * 20), tTurn(14), tGo(sl + 2, 0.8));
    } else if (route === 'regatta') {
      const start = (reg?.s0 ?? 348) + 14, finish = (reg?.s1 ?? 505) - 2;
      b.race = 1;
      b.tasks.push(tGo(start + 6, 2.2), tTurn(10), tDo('marks', (bb) => { bb.race = 1; }), tHold(8, 0),
        tDo('race', (bb) => { bb.race = 1.55 + rnd() * 0.35; }), tGo(finish, 2.6), tDo('easy', (bb) => { bb.race = 1; }), tGo(finish + 10, 1.0), tHold(10, 0.02));
    } else {
      const t1 = route === 'upstream' ? lo : route === 'downstream' ? hi : clamp(sl + (rnd() < 0.5 ? -1 : 1) * (40 + rnd() * 90), lo, hi);
      const t2 = clamp(t1 + (sl - t1) * (0.3 + rnd() * 0.4), lo, hi);
      const sp = b.kind === 'gig4' ? 2.4 : 1.4;
      b.tasks.push(tGo(t1, sp), tHold(() => 10 + rnd() * 40, 0.08), tGo(t2, sp * 0.9), tHold(() => 5 + rnd() * 20, 0.08), tGo(sl - 4 * Math.sign(sl - t2 || 1), sp));
    }
    b.tasks.push(...tSlipIn());
  };
  const launchFromBoathouse = (kind: BoatKind, riders: PersonSpec[] | undefined, tag: string | undefined, route: 'loop' | 'regatta' | 'upstream' | 'downstream'): Boat | null => {
    const name = kind === 'punt' ? 'Punt "Mayfly"' : kind === 'gig4' ? `Coxed four${tag?.startsWith('regatta') ? ` (${tag})` : ''}` : `Skiff "${SKIFF_NAMES[seq % SKIFF_NAMES.length]}"`;
    const b = mkBoat(kind, name, 'boathouse');
    if (!b) return null;
    b.tag = tag;
    b.free = true;
    b.x = bhIn.x; b.z = bhIn.z; b.y = bhIn.y - DRAFT[kind]; b.px = b.x; b.pz = b.z;
    b.yaw = yawOf(slipPt.x - bhIn.x, slipPt.z - bhIn.z);
    b.where = 'boathouse'; b.info.state = 'hauled';
    b.info.pos.set(b.x, b.y, b.z); b.info.yaw = b.yaw;
    ctx.origins.audit('nature', 'spawn', 'boats', bhIn, `${kind} ${b.id} @boathouse`);
    const specs: PersonSpec[] = riders ?? (kind === 'rowing'
      ? [{ role: 'rower' }, ...(rnd() < 0.6 ? [{ role: 'townsfolk' as const }] : []), ...(rnd() < 0.25 ? [{ role: 'child' as const, child: true }] : [])]
      : kind === 'punt' ? [{ role: 'punter' }, { role: 'townsfolk' }, ...(rnd() < 0.5 ? [{ role: 'townsfolk' as const }] : [])]
        : [{ role: 'rower' }, { role: 'rower' }, { role: 'rower' }, { role: 'rower' }, { role: 'rower' }]);
    seatRiders(b, specs);
    outing(b, route);
    return b;
  };

  // ── the steam launch Kingfisher (moored at m1, bow upstream) ──
  const m1 = mooring('m1');
  const launch = mkBoat('launch', 'Steam launch "Kingfisher"', 'm1');
  let launchSlot = '', launchGo = false, launchWait = 0, launchBoarding = 0, launchCrewCall = false, launchHoldCap = 50;
  const moorLat = (m: { lateral: number; s: number }) => Math.sign(m.lateral) * Math.min(Math.abs(m.lateral), hw(m.s) - 1.25);
  const launchIdle = () => launch !== null && launch.where === 'm1' && launch.tasks.length <= 1;
  /** lying at m1: passengers step ashore shortly after she ties up; she casts off once the next party is aboard */
  const moorLaunch = (landed0: boolean): Task => {
    let t = 0, landed = landed0;
    return tMoor('m1', m1.s, moorLat(m1), (bb) => bb.tasks.length > 1 && launchGo, (bb, dt) => {
      t += dt;
      if (!landed && t > 4) { landed = true; landRiders(bb); }
      if (bb.tasks.length > 1) {
        launchWait += dt;
        // the crew comes up from the cabin once the party is nearly here (or at once for a crew-only run)
        if (!bb.riders.length && (launchCrewCall || launchWait > launchHoldCap - 10)) seatRiders(bb, [{ role: 'bargee', tag: 'launch' }]);
        // she never casts off while her party is still walking down to her (up to the walk-based cap)
        if ((launchBoarding <= 0 && bb.riders.length) || launchWait > launchHoldCap) { if (!bb.riders.length) seatRiders(bb, [{ role: 'bargee', tag: 'launch' }]); launchGo = true; }
      }
    });
  };
  if (launch) {
    launch.s = m1.s; launch.lat = moorLat(m1); launch.dir = -1; launch.where = 'm1';
    placeRiver(launch);
    launch.yaw = R.poly.yawAt(launch.s) + Math.PI;
    launch.px = launch.x; launch.pz = launch.z;
    launch.tasks.push(moorLaunch(true));
  }
  const launchTrip = (route: 'lock' | 'loop' | 'regatta', passengers: number) => {
    const b = launch;
    if (!b) return false;
    const P = people();
    launchGo = false; launchWait = 0; launchBoarding = 0; launchCrewCall = passengers <= 0; launchHoldCap = 50;
    // the crew comes up from the cabin (a moored boat is a legitimate origin) when the party is close (moorLaunch)
    // a party walks down to the mooring and embarks: all from the one nearest door, with a timeout (and the launch's
    // hold) sized from the real walk (1 sim min per motion second: ~74 min per 100 m)
    if (P && passengers > 0) {
      const door = doorPoint(b, new THREE.Vector3());
      const o = ctx.origins.bestFor(door, 'people', { kinds: ['door', 'portal'], role: 'townsfolk' });
      let walkM = 150;
      if (o) { try { const l = ctx.layout.walk.length(o.pos(new THREE.Vector3()), door); if (isFinite(l)) walkM = l; } catch { /* */ } }
      const timeoutMin = Math.max(45, (walkM / 1.35) * 1.3 + 15);
      launchHoldCap = Math.min(240, timeoutMin + 10);
      for (let i = 0; i < passengers; i++) {
        try {
          const r = P.summonActor('townsfolk', door.clone().add(tmp.set((rnd() - 0.5) * 2, 0, (rnd() - 0.5) * 2)), { timeoutMin, from: o?.id });
          launchBoarding++;
          void r.arrived.then((ok) => {
            // missed the boat (or never made it): home they go, whatever the launch is doing
            if (!ok || b.where !== 'm1' || launchGo) { launchBoarding--; try { void P.dismissActor(r.id); } catch { /* */ } return; }
            launchCrewCall = true;
            void P.embark([r.id], b.anchor).then((seated) => {
              launchBoarding--;
              if (seated && !b.riders.includes(r.id)) { b.riders.push(r.id); b.info.riders = b.riders; }
            });
          });
        } catch { /* people busy */ }
      }
    }
    const whistle = tDo('whistle', (bb) => { ctx.bus.emit('audio:cue', { cue: 'boatWhistle', pos: new THREE.Vector3(bb.x, bb.y, bb.z), volume: 0.9 }); });
    const pullOut = tGo(m1.s - 12, 0.6, 0, 0.9);
    if (route === 'lock') {
      const wind = lock.s1 + 20;
      b.tasks.push(whistle, pullOut, tTurn(18), tGo(lock.s0 - 30, 2.6), tLock(true), tGo(wind, 1.0, 0, 0.6), tTurn(20), tLock(false), tGo(m1.s + 8, 2.6));
    } else if (route === 'regatta') {
      const reg = R.reaches.find((r) => r.id === 'regatta');
      b.tasks.push(whistle, pullOut, tTurn(18), tHold(25, 0), tGo((reg?.s1 ?? 505) - 4, 2.4), tHold(30, 0.02), tGo((reg?.s1 ?? 505) + 6, 0.8, 0, 0.8), tTurn(18), tGo(m1.s + 8, 2.2));
    } else if (route === 'loop') {
      // a short pleasure run upstream past the meadows and back (about an hour), so she can make three a day
      b.tasks.push(whistle, tGo(Math.max(R.portals.up.s + 150, m1.s - 50), 2.4), tHold(6, 0.05), tGo((bb) => bb.s + 6, 0.8, 0, 0.8), tTurn(18), tGo(m1.s + 22, 2.2), tGo(m1.s + 28, 0.8, 0, 0.8), tTurn(18), tGo(m1.s + 8, 1.6));
    } else {
      b.tasks.push(whistle, tGo(Math.max(R.portals.up.s + 150, m1.s - 170), 2.4), tHold(20, 0.05), tGo((bb) => bb.s + 6, 0.8, 0, 0.8), tTurn(18), tGo(m1.s + 30, 2.4), tGo(m1.s + 40, 0.8, 0, 0.8), tTurn(18), tGo(m1.s + 8, 1.8));
    }
    b.tasks.push(moorLaunch(false));
    return true;
  };

  // ── the narrowboat Perseverance and her horse ──
  const m3 = mooring('m3');
  const barge = mkBoat('narrowboat', 'Narrowboat "Perseverance"', 'upstream');
  const TOW = 19;
  const towPoint = (s: number, out: THREE.Vector3) => {
    const ss = clamp(s, 0, R.length);
    return R.pointAt(ss, R.towpath.lateral(ss), R.towpath.yAt(ss), out);
  };
  let bargeWait = 0;
  const HORSE_COLS = [0x5a3a24, 0x2a1e16, 0x2a2420, 0x3a2418];
  if (barge) {
    const hs = horses.alloc();
    if (hs >= 0) {
      horses.setColors(hs, HORSE_COLS);
      barge.horse = { slot: hs, x: 0, y: 0, z: 0, yaw: 0, phase: 0, speed: 0, state: 'graze', path: null, d: 0, then: null, graze: 1, stampLeg: 0, stampPh: 0, timer: 5, tx: 0, tz: 0 };
    }
  }
  /** lying at m3: unloading (the load sinks), the bargee goes ashore for the night; she leaves once the horse is hitched */
  const bargeMoorTask = (): Task => {
    let t = 0, landed = false;
    return tMoor('m3', m3.s, moorLat(m3), (bb) => bb.tasks.length > 1 && (!bb.horse || bb.horse.state === 'tow'), (bb, dt) => {
      t += dt;
      bb.load = Math.max(0, bb.load - dt / 150);
      if (!landed && t > 150 && bb.tasks.length <= 1) { landed = true; landRiders(bb); }
    });
  };
  const horseTo = (h: TowHorse, to: THREE.Vector3, then: TowHorse['then']) => {
    let pts: THREE.Vector3[] = [];
    try { pts = L.footPath(tmp.set(h.x, h.y, h.z), to); } catch { pts = []; }
    if (pts.length < 2) pts = [new THREE.Vector3(h.x, h.y, h.z), to.clone()];
    h.path = new Path(pts); h.d = 0; h.then = then; h.state = 'walk';
  };
  const bargeDepart = () => {
    const b = barge!;
    const h = b.horse;
    // the bargee comes up from the cabin; the horse is fetched from the lock stable (or from its grazing)
    if (!b.riders.length) seatRiders(b, [{ role: 'bargee', tag: 'narrowboat' }]);
    if (h) {
      if (h.state === 'stable') {
        h.x = stableDoor.x; h.y = stableDoor.y; h.z = stableDoor.z;
        ctx.origins.audit('nature', 'spawn', 'animals', stableDoor, 'bargehorse');
      }
      if (h.state !== 'tow') horseTo(h, towPoint(b.s + b.dir * TOW, new THREE.Vector3()), 'hitch');
    }
    b.tasks.push(
      tGo(m3.s - 8, 0.4, (bb) => laneFor(bb, bb.s)),
      tExit(true),
      tDo('gone', () => { bargeWait = 90 + rnd() * 200; }),
    );
  };
  /**
   * Perseverance arrives from off the map. Most days she comes down from Glenmoor and lies at the mill-pool
   * mooring; some days she works THROUGH Millbridge lock and on down to the sea (river:down), and some days she
   * comes UP from below, locks up and lies at m3 — so the lock and its keeper see regular use.
   */
  const bargeArrive = () => {
    const b = barge!;
    const r = rnd();
    const variant: 'moor' | 'through' | 'fromBelow' = r < 0.3 ? 'through' : r < 0.6 ? 'fromBelow' : 'moor';
    const up = variant !== 'fromBelow';
    b.tasks.length = 0;
    bargeWait = 0; // (a negative wait means "leave soon" — only for the warm start; never cast off at midnight after arriving)
    b.away = false; b.load = 1; b.dir = up ? 1 : -1;
    b.s = up ? R.portals.up.s - 16 : R.portals.down.s + 16; b.lat = laneFor(b, b.s);
    placeRiver(b);
    b.yaw = R.poly.yawAt(b.s) + (up ? 0 : Math.PI); b.px = b.x; b.pz = b.z;
    ctx.origins.audit('nature', 'spawn', 'boats', tmp.set(b.x, b.y, b.z), `narrowboat ${b.id} @river:${up ? 'up' : 'down'}`);
    b.info.state = 'underway';
    seatRiders(b, [{ role: 'bargee', tag: 'narrowboat' }]);
    const h = b.horse;
    if (h) {
      towPoint(b.s + b.dir * TOW, tmp);
      h.x = tmp.x; h.y = tmp.y; h.z = tmp.z; h.state = 'tow';
      ctx.origins.audit('nature', 'spawn', 'animals', tmp, `bargehorse @path:${up ? 'towUp' : 'towDown'}`);
    }
    if (variant === 'through') {
      b.tasks.push(
        tGo(lock.s0 - 30, 1.05, (bb) => laneFor(bb, bb.s)),
        tLock(true),
        tExit(false),
        tDo('gone', () => { bargeWait = 120 + rnd() * 240; }),
      );
      return;
    }
    if (variant === 'fromBelow') {
      b.tasks.push(
        tGo(lock.s1 + 30, 1.05, (bb) => laneFor(bb, bb.s)),
        tLock(false),
        tGo(m3.s + 10, 0.9, (bb) => (bb.s < m3.s + 30 ? 0 : laneFor(bb, bb.s))),
        tDo('unhitch', (bb) => { if (bb.horse) { bb.horse.state = 'graze'; bb.horse.timer = 3; } }),
        bargeMoorTask(),
      );
      return;
    }
    const turnS = (m3.s + lock.s0 - 20) / 2;
    b.tasks.push(
      tGo(turnS, 1.05, (bb) => (bb.s > m3.s - 30 ? 0 : laneFor(bb, bb.s))),
      tDo('unhitch', (bb) => { if (bb.horse) { bb.horse.state = 'graze'; bb.horse.timer = 3; } }),
      tTurn(70),
      bargeMoorTask(),
    );
  };
  if (barge) {
    // warm start: lying at the mill-pool mooring, bow upstream, part unloaded
    barge.s = m3.s; barge.lat = moorLat(m3); barge.dir = -1; barge.where = 'm3'; barge.load = 0.35;
    placeRiver(barge);
    barge.yaw = R.poly.yawAt(barge.s) + Math.PI; barge.px = barge.x; barge.pz = barge.z;
    barge.info.state = 'moored';
    barge.tasks.push(bargeMoorTask());
    const h = barge.horse;
    if (h) {
      const hr = hour();
      towPoint(barge.s - 5, tmp);
      h.x = tmp.x; h.y = tmp.y; h.z = tmp.z; h.tx = h.x; h.tz = h.z;
      h.state = hr > 6 && hr < 19.5 ? 'graze' : 'stable';
    }
    if (hour() > 6.5 && hour() < 12) bargeWait = -1; // leaves soon after the warm start
  }
  let departDay = -1;

  // ── horse ──
  const stepHorse = (b: Boat, h: TowHorse, dt: number) => {
    if (h.state === 'offmap' || h.state === 'stable') return;
    const px = h.x, pz = h.z;
    if (h.state === 'tow') {
      towPoint(b.s + b.dir * TOW, tmp);
      h.x += (tmp.x - h.x) * Math.min(1, dt * 3); h.z += (tmp.z - h.z) * Math.min(1, dt * 3); h.y = tmp.y;
      h.graze += ((nearBridge(b.s + b.dir * TOW, 7) ? 0.45 : 0) - h.graze) * Math.min(1, dt * 2);
    } else if (h.state === 'walk' || h.state === 'toHitch') {
      const p = h.path!;
      h.d = Math.min(p.length, h.d + 1.0 * dt);
      p.at(h.d, tmp);
      h.x = tmp.x; h.y = tmp.y; h.z = tmp.z;
      h.graze += (0 - h.graze) * Math.min(1, dt * 2);
      if (h.d >= p.length - 0.02) {
        h.path = null;
        if (h.then === 'stable') { ctx.origins.audit('nature', 'despawn', 'animals', stableDoor, 'bargehorse'); h.state = 'stable'; }
        else if (h.then === 'hitch') h.state = 'tow';
        else { h.state = 'graze'; h.tx = h.x; h.tz = h.z; }
      }
    } else if (h.state === 'graze') {
      h.timer -= dt;
      if (h.timer <= 0) {
        h.timer = 4 + rnd() * 10;
        towPoint(b.s + b.dir * (3 + rnd() * 7), tmp);
        const side = R.nearest(tmp);
        R.pointAt(side.s, side.lat + (rnd() - 0.3) * 1.2, 0, tmp2);
        h.tx = tmp2.x; h.tz = tmp2.z;
      }
      const dx = h.tx - h.x, dz = h.tz - h.z, d = Math.hypot(dx, dz);
      if (d > 0.3) { const st = Math.min(d, 0.4 * dt); h.x += dx / d * st; h.z += dz / d * st; }
      const n = R.nearest(tmp.set(h.x, 0, h.z));
      h.y = R.towpath.yAt(n.s);
      h.graze += ((d > 0.3 ? 0.2 : 1) - h.graze) * Math.min(1, dt * 1.2);
      // evening: off to the lock stable
      if ((hour() > 19.5 || hour() < 5.5) && b.where === 'm3') horseTo(h, stableDoor, 'stable');
    }
    const dx = h.x - px, dz = h.z - pz, st = Math.hypot(dx, dz);
    if (st > 1e-4) h.yaw = turnToward(h.yaw, yawOf(dx, dz), dt * 3);
    h.phase += (st / HORSE_STRIDE.walk) * TAU;
    h.speed = st / Math.max(1e-3, dt);
    if (h.stampLeg === 0 && h.speed < 0.1 && rnd() < dt * 0.06) { h.stampLeg = 1 + Math.floor(rnd() * 4); h.stampPh = 0; }
    if (h.stampLeg) { h.stampPh += dt * 2.2; if (h.stampPh >= 1) h.stampLeg = 0; }
  };

  // ── scheduling (2 Hz) ──
  let schedT = 0;
  const fair = () => { const w = weather(); return w !== 'storm' && w !== 'rain' && w !== 'snow' && water.ice < 0.2 && night() < 0.35; };
  const boathouseOut = () => boats.filter((b) => b.home === 'boathouse').length;
  const maxBoathouse = Math.max(1, K.caps.boats - 2);
  const schedule = (dtSince: number) => {
    const h = hour();
    // boathouse craft
    if (fair() && h > 8.5 && h < 18.5 && warmth(ctx) > 0.2 && boathouseOut() < maxBoathouse) {
      const p = dtSince / 70;
      if (rnd() < p) {
        const punt = warmth(ctx) > 0.55 && h > 12.5 && h < 18 && !boats.some((b) => b.kind === 'punt') && rnd() < 0.4;
        launchFromBoathouse(punt ? 'punt' : 'rowing', undefined, undefined, 'loop');
      }
    }
    // recall everyone in bad weather / at dusk / ice
    if (!fair() || h > 19.5) {
      for (const b of boats) {
        if (b.home !== 'boathouse' || b.where === 'boathouse' || b.free || (b.tag ?? '').startsWith('regatta')) continue;
        if (b.recalled || b.tasks.some((t) => t.name === 'free' || t.name === 'ashore' || t.name === 'stow')) continue;
        b.recalled = true;
        b.tasks.length = 0;
        b.tasks.push(...tSlipIn());
      }
    }
    // Kingfisher's daily trip
    // three short trips a day (morning, early and late afternoon), so she is not a permanent fixture at m1
    const slotI = h > 8.5 && h < 11 ? 0 : h > 12 && h < 14 ? 1 : h > 15 && h < 16.5 ? 2 : -1;
    const slotKey = `${ctx.clock.day}:${slotI}`;
    if (launch && slotI >= 0 && launchIdle() && fair() && launchSlot !== slotKey && warmth(ctx) > 0.15) {
      launchSlot = slotKey;
      // three short upstream pleasure loops a day (the lock run takes most of a day at river pace: requestBoat only)
      launchTrip('loop', 2 + Math.floor(rnd() * 3));
    }
    // Perseverance
    if (barge) {
      if (barge.away) {
        bargeWait -= dtSince;
        if (bargeWait <= 0 && h > 4 && h < 11 && water.ice < 0.3 && weather() !== 'storm') bargeArrive();
      } else if (barge.where === 'm3' && barge.tasks.length <= 1 && water.ice < 0.3 && weather() !== 'storm') {
        const soon = bargeWait < 0 && h < 13;
        if ((departDay !== ctx.clock.day && h > 6.2 && h < 10 && night() < 0.5) || soon) {
          departDay = ctx.clock.day;
          bargeWait = 0;
          bargeDepart();
        }
      }
    }
  };

  // ── per-boat step ──
  const step = (b: Boat, dt: number) => {
    b.px = b.x; b.pz = b.z;
    let guard = 0;
    while (b.tasks.length && guard++ < 4) {
      const t = b.tasks[0];
      if (!t.started) { t.started = true; t.start?.(b); }
      if (t.step(b, dt)) { b.tasks.shift(); if (!boats.includes(b)) return; continue; }
      break;
    }
    if (b.away) return;
    if (!b.free) {
      const beam = BOAT_DIMS[b.k].beam;
      if (b.where === null && !water.inLock(b.s, b.lat) && lockOwner !== b) {
        const h = hw(b.s) - beam / 2 - 0.4;
        b.lat = clamp(b.lat, -h, h);
        // never drift into the weir: boats not working the lock keep out of the lock/weir band
        if (b.s > lock.s0 - 8 && b.s < lock.s1 + 4 && !b.tasks.some((t) => t.name.startsWith('lock'))) b.s = b.dir > 0 ? Math.min(b.s, lock.s0 - 8) : Math.max(b.s, lock.s1 + 4);
      }
      placeRiver(b);
      if (!b.tasks.length || b.tasks[0].name !== 'turn') faceMotion(b, dt);
    } else faceMotion(b, dt, 2.5);
    // oars / pole
    const moving = b.spd > 0.12 && !b.free;
    b.strokeAmp += ((moving || (b.free && b.spd > 0.1) ? 1 : 0) - b.strokeAmp) * Math.min(1, dt * 1.5);
    b.stroke += (Math.max(b.spd, b.strokeAmp * 0.5) * dt / strokeLen(b)) * TAU;
    // funnel under bridges
    if (b.kind === 'launch') b.funnel += ((nearBridge(b.s, 9) && !b.free ? 1 : 0) - b.funnel) * Math.min(1, dt * 0.8);
    b.lamp += ((night() > 0.45 && (b.kind === 'narrowboat' || b.riders.length > 0 || b.tasks.length > 1) ? 1 : 0) - b.lamp) * Math.min(1, dt * 0.5);
    if (b.horse) stepHorse(b, b.horse, dt);
    b.info.pos.set(b.x, b.y, b.z);
    b.info.yaw = b.yaw;
    b.info.speed = b.spd;
  };

  const update = (dtM: number, dt: number) => {
    stepLock(dtM);
    for (const b of boats.slice()) step(b, dtM);
    schedT += dtM;
    if (schedT >= 0.5) { schedule(schedT); schedT = 0; }
    smokeAcc += dtM;
    void dt;
  };

  // ── render ──
  let smokeAcc = 0;
  const funnelTop = BOAT_DIMS[BOATK.launch].funnel!, chim = BOAT_DIMS[BOATK.narrowboat].chimney!, mastTop = BOAT_DIMS[BOATK.narrowboat].mast!;
  const lampPos = new THREE.Vector3();
  const localOf = (b: Boat, lx: number, ly: number, lz: number, out: THREE.Vector3) => {
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    return out.set(b.x + lx * c + lz * s, b.y + ly, b.z - lx * s + lz * c);
  };
  let splashT = 0;
  const sync = (dt: number, DB: Drawer, DH: Drawer) => {
    const age = Math.max(dt, smokeAcc);
    smokeAcc = 0;
    const f = ctx.view.focus;
    splashT -= age;
    let nearest: Boat | null = null, nd = 110;
    for (const b of boats) {
      if (b.away) continue;
      tmp.set(b.x, b.y + 1, b.z);
      const vis = ctx.view.isVisible(tmp, BOAT_DIMS[b.k].len * 0.6 + 2);
      const bi = vis ? DB.next(hash1(b.slot * 1.91 + 11), COLORS[b.kind]) : -1;
      if (bi >= 0) {
        boatMatrix(b, m4);
        rig.setMatrix(bi, m4);
        rig.setAnim(bi, b.stroke, b.strokeAmp, b.load, b.lamp);
        if (b.kind === 'narrowboat') {
          const h = b.horse;
          if (h && h.state === 'tow') {
            // towline end = the horse's collar, in boat-local space
            const dx = h.x - b.x, dz = h.z - b.z, c = Math.cos(b.yaw), s = Math.sin(b.yaw);
            rig.setAux(bi, dx * c - dz * s, h.y + 1.35 - b.y, dx * s + dz * c, b.k);
          } else rig.setAux(bi, mastTop.x, mastTop.y, 0, b.k);
        } else rig.setAux(bi, b.funnel, 0, 0, b.k);
        const d = Math.hypot(b.x - f.x, b.z - f.z);
        if (d < nd && (b.kind === 'rowing' || b.kind === 'gig4') && b.strokeAmp > 0.5) { nd = d; nearest = b; }
      }
      // smoke
      b.smokeT -= age;
      if (b.kind === 'launch' && (b.riders.length || b.tasks.length > 1) && b.smokeT <= 0) {
        b.smokeT = b.spd > 0.3 ? 0.35 : 1.4;
        const up = funnelTop.y * (1 - b.funnel * 0.6);
        localOf(b, funnelTop.x - b.funnel * 0.9, up + 0.1, 0, tmp);
        if (ctx.view.isVisible(tmp, 6)) puffs.emit(tmp.x, tmp.y, tmp.z, 0.32, 0.55, 0.9);
      } else if (b.kind === 'narrowboat' && b.where !== null && b.smokeT <= 0) {
        const cold = (ctx.reg.atmosphere?.temperatureC ?? 12) < 14;
        const cooking = hour() < 8.5 || hour() > 17.5;
        b.smokeT = 1.1 + rnd() * 0.8;
        localOf(b, chim.x, chim.y + 0.1, chim.z, tmp);
        if ((cold || cooking) && ctx.view.isVisible(tmp, 5)) puffs.emit(tmp.x, tmp.y, tmp.z, 0.18, 0.2, 0.45);
      }
      // lamps (claim a pool light near the view)
      if (b.lamp > 0.05) {
        const lp = BOAT_DIMS[b.k].lamp;
        if (lp) {
          localOf(b, lp.x, lp.y + 0.2, lp.z, lampPos);
          if (ctx.view.isVisible(lampPos, 6)) ctx.lights.claim(`nature:${b.id}`, lampPos, 0xffb766, 2.2 * b.lamp, 11, 0.3);
        }
      }
      // horse
      const h = b.horse;
      if (h && h.state !== 'offmap' && h.state !== 'stable') {
        tmp.set(h.x, h.y + 1, h.z);
        const hi = ctx.view.isVisible(tmp, 3) ? DH.next(hash1(h.slot * 3.1 + 5), HORSE_COLS) : -1;
        if (hi >= 0) {
          tmp.set(h.x, h.y, h.z);
          horses.setTransform(hi, tmp, h.yaw, 1);
          const t = ctx.clock.minutes;
          const swish = Math.sin(t * 2.1 + h.slot) * (0.35 + 0.65 * Math.max(0, Math.sin(t * 0.23 + 1.3)));
          horses.setAnim(hi, h.phase, h.speed > 0.08 ? 0.5 * clamp01(h.speed * 1.5) : 0, 0.25 * Math.sin(t * 0.6), swish);
          horses.setAux(hi, h.stampLeg, h.stampPh, clamp01(h.graze), clamp01(Math.sin(t * 1.1 + 2) * 3 - 2));
        }
      }
    }
    // oar dip rings for the skiff nearest the view
    if (nearest && splashT <= 0) {
      const b = nearest;
      const ph = ((b.stroke % TAU) + TAU) % TAU;
      if (ph < 0.6) {
        splashT = 1.2;
        const o = BOAT_DIMS[b.k].oars[0];
        if (o) {
          for (const sgn of [1, -1]) { localOf(b, o.x - 0.3, 0, sgn * (Math.abs(o.z) + o.len * 0.75), tmp); water.splash(tmp.x, tmp.z, 0.35); }
          if (nd < 60 && rnd() < 0.3) ctx.bus.emit('audio:cue', { cue: 'oars', pos: new THREE.Vector3(b.x, b.y, b.z), volume: 0.3 });
        }
      }
    }
    puffs.update(age);
  };

  // ── API bits ──
  const probe: BoatProbe = (s, lat, r) => {
    let best: { s: number; lat: number; d: number } | null = null, bd = r;
    for (const b of boats) {
      if (b.away || b.free) continue;
      const d = Math.hypot(b.s - s, b.lat - lat) - BOAT_DIMS[b.k].len * 0.4;
      if (d < bd) { bd = d; best = { s: b.s, lat: b.lat, d: Math.max(0, d) }; }
    }
    return best;
  };
  const request: Boats['request'] = (kind, opts) => {
    const route = opts?.route ?? 'loop';
    if (kind === 'launch') {
      if (!launch || !launchIdle()) return null;
      launchTrip(route === 'regatta' ? 'regatta' : route === 'loop' ? 'loop' : 'lock', opts?.riders ? 0 : 2);
      launch.tag = opts?.tag;
      return launch.id;
    }
    if (kind === 'narrowboat') {
      if (!barge) return null;
      if (barge.away) { bargeWait = 0; if (hour() > 4) bargeArrive(); }
      else if (barge.where === 'm3' && barge.tasks.length <= 1) { departDay = ctx.clock.day; bargeDepart(); }
      return barge.id;
    }
    if (water.ice > 0.4) return null;
    if (boats.filter((b) => b.home === 'boathouse').length >= maxBoathouse + 2) return null;
    const b = launchFromBoathouse(kind, opts?.riders, opts?.tag, route);
    return b ? b.id : null;
  };
  const byId = (id: string) => boats.find((b) => b.id === id);

  return {
    update, sync, probe, request,
    anchorOf(id) { const b = byId(id) ?? byId(id.replace(/^boat:(?=boat:)/, '')); return b && !b.away ? b.anchor : null; },
    infos() { return boats.filter((b) => !b.away).map((b) => b.info); },
    get(id) { const b = byId(id); return b && !b.away ? b.info : undefined; },
    raycast(r) {
      let best: Boat | null = null, bd = Infinity;
      for (const b of boats) {
        if (b.away) continue;
        tmp.set(b.x, b.y + 0.5, b.z);
        const rad = BOAT_DIMS[b.k].len * 0.45 + 0.4;
        if (r.ray.distanceSqToPoint(tmp) > rad * rad) continue;
        const along = tmp.sub(r.ray.origin).dot(r.ray.direction);
        if (along < bd) { bd = along; best = b; }
      }
      return best ? best.id : null;
    },
    count() { let n = 0; for (const b of boats) if (!b.away) n++; return n; },
    lockBusy() { return lockOwner !== null; },
    debug() { return boats.map((b) => ({ n: b.name, t: b.tasks.map((t) => t.name).join('>'), s: +b.s.toFixed(1), lat: +b.lat.toFixed(2), dir: b.dir, where: b.where, free: b.free, away: b.away, spd: +b.spd.toFixed(2) })); },
  };
}
