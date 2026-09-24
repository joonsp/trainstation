// Trains: rolling stock, timetable, signalling/dispatch, shed & rescue operations, crews, smoke/steam effects.
//
// v2 notes (living world):
//  • NO POP-IN: trains appear and vanish only inside the rail tunnels (see tunnels.ts); cars are hidden only while
//    both ends are in a tunnel. Spawns/despawns are audited against the tunnel origins.
//  • Shed moves use the dedicated shed road through the `shedWest` tunnel (issue 2): light engines come in from the
//    west and back out tender-first; a coast westbound train sent to the shed diverts at the switch straight after
//    its platform call, runs its engine into the bay and later leaves west through the shed tunnel, coaches and all.
//  • Punctuality (issue 1a): honest dwell discipline (hold only for committed boarders, ≤ 2 min, never when late),
//    delayLine affects only the next train each way (max, not sum), specials take a free slot (planned trains are held
//    briefly or withdrawn to make way), and trains projected > 25 min late are cancelled instead of limping in.
//  • Level crossing LC1: coast trains request the gates (westbound while still in the tunnel, eastbound before leaving
//    P1) and never pass trainStopT without them.
//  • The Phantom Mail picks a free line, bursts out of a tunnel at ~40 m/s and glides the platform at 7.5 m/s (issue 6).
import * as THREE from 'three';
import type { Ctx, Dir, LineId, PlatformId, System } from '../core/types';
import type { CarType, Departure, SpecialTrainSpec, TrainInfo, TrainsAPI } from '../core/apis';
import type { LineLayout } from '../core/layout';
import { SimClock, formatSimTime } from '../core/clock';
import { createTrainMats } from './mats';
import { Route, type Track } from './route';
import { Smoke, PUFF_GHOST, PUFF_SMOKE, PUFF_STEAM } from './smoke';
import { TrainVisuals, isPassengerCar, type Car } from './visuals';
import {
  buildConsist, createLocoPool, locoCars, serviceName, specialConsist, takeLoco, trimToLength, HIGHLAND_MAX_LEN,
  type CarPlan, type Loco, type TrainKind,
} from './consist';
import { SPECS, type LiveryId } from './cars';
import { createDebugCam } from './debugCam';
import { makeTunnelTest } from './tunnels';
import { CrewRenderer, newCrewState, type CrewState } from './crew';
import { Headlamps } from './headlamps';
import { trainsShared } from './share';

// ───────────────────────── tuning ─────────────────────────
const SEP = 16;               // following distance behind another train's tail (m)
const FOUL = 24;              // metres along the shed siding before a vehicle clears the coast track
const FAR_ZONE = 230;         // beyond this distance from the platform centre trains may run fast
const V_FAR = 30;
const V_SIDING = 15;
const V_SHED_ROAD = 20;
const V_SHED_IN = 11;
const V_CAUTION = 5;
const V_THROUGH = 13;
const V_HAUL = 8;
const V_EXIT = 36;
const EXIT_ZONE = 130;        // metres past the platform centre after which departing trains may open up
const MAX_QUEUED_PER_LINE = 3;
const ENTRY_DEPTH = 3;        // head spawns this far inside the tunnel mouth
const EXIT_DEPTH = 2;         // a train is removed once its tail is this far inside a tunnel
const SPAWN_LEAD = 20;        // queued train objects exist this many sim-min before they may enter (predicted doors)
const CANCEL_LATE = 25;       // projected lateness (min) beyond which a train is cancelled/withdrawn
const EXIT_EST = 20;          // sim-min for a departing train to clear the single line (motion seconds)
const DIVERT_MAX_LEN = 92;    // longest coast train that can stand on the shed siding clear of the switch
const GHOST_FAST = 40, GHOST_GLIDE = 9, GHOST_GLIDE_LEAD = 45, GHOST_BRAKE = 3;
/** the Phantom may follow a train that is leaving ahead of it, never closer than this (m) */
const GHOST_FOLLOW_GAP = 160;
const GHOST_OCC = 44;         // sim-min the Phantom holds its line (tunnel → glide past the platform → tunnel)

type Task = 'service' | 'shed' | 'release' | 'rescuer' | 'hauled';
type Phase = 'queued' | 'run' | 'dwell' | 'whistle' | 'shed' | 'releaseWait' | 'hold' | 'couple' | 'broken';

interface Service {
  id: number;
  line: LineId;
  dir: Dir;
  kind: TrainKind | 'mail';
  special?: string;
  name: string;
  origin: string;
  dest: string;
  arr: number;
  dep: number;
  dwell: number;
  stops: boolean;
  state: 'planned' | 'active' | 'departed' | 'cancelled';
  trainId: string | null;
  hold: number;
  depActual: number;
  warned: boolean;
  spawnedAt?: number;
  enteredAt?: number;
  arrivedAt?: number;
  estLen: number;
}

interface CrossingPlan { crossS: number; stopS: number; requested: boolean; granted: boolean; done: boolean }

interface Train {
  info: TrainInfo;
  seq: number;
  loco: Loco | null;
  cars: Car[];
  route: Route;
  s: number;
  v: number;
  task: Task;
  phase: Phase;
  prevPhase: Phase;
  entered: boolean;
  priority: number;
  earliestEntry: number;
  stops: boolean;
  stopS: number | null;
  stopDone: boolean;
  signalS: number | null;
  needsBlock: boolean;
  hasBlock: boolean;
  blockDone: boolean;
  waitSince: number;
  failedOverride: boolean;
  caution: boolean;
  dwellUntil: number;
  dwellHard: number;
  whistleUntil: number;
  arrivedAt: number;
  alighted: boolean;
  service: Service | null;
  shedPending: boolean;
  /** user-ordered to the shed: runs 'not in service' (no boarding), short stop, may divert */
  shedUrgent: boolean;
  ghost: boolean;
  special?: string;
  vBase: number;
  accel: number;
  brake: number;
  canExit: boolean;
  centreS: number;
  livery: LiveryId;
  // ops
  approachEmitted: boolean;
  brakeCue: boolean;
  brokenAt: number;
  rescueRequested: boolean;
  rescueTarget: Train | null;
  rescuerCar: Car | null;
  rescuerLoco: Loco | null;
  removeRescuerAt: number;
  dead: boolean;
  shedAt: number;
  pauseUntil: number;
  stuckFor: number;
  crossing: CrossingPlan | null;
  crossWaitSince: number;
  doorOff: (() => void)[];
  /** route s / sim minute of the right-away (door origins stay open a moment for the guard to step in) */
  departS: number;
  departAt: number;
  cabOff: (() => void) | null;
  prevLead: number;
  // visuals
  chuffAcc: number;
  puffClock: number;
  sparkClock: number;
  hissAt: number;
  cockUntil: number;
  blowUntil: number;
  nextBlow: number;
  lastV: number;
  spooked: boolean;
  crew: CrewState;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _tan = new THREE.Vector3();

const opposite = (d: Dir): Dir => (d === 'east' ? 'west' : 'east');

/**
 * Issue 3: head t where a train stops. Core's LineLayout.stopTFor keeps a westbound Highland ENGINE ≥ 48 m in from
 * P2's west end (clear of the clock tower / roof from the ESE camera); a long train lets its van overhang instead.
 */
const stopTFor = (L: LineLayout, dir: Dir, len: number): number => L.stopTFor(dir, len);

export function createTrains(ctx: Ctx): System {
  const { layout, bus, clock } = ctx;
  const rng = ctx.rng.fork(0x7a1);
  const tm = createTrainMats(ctx.mats);
  const tunnels = makeTunnelTest(layout);
  const hiddenAt = (x: number, z: number) => tunnels.hidden(x, z);
  const vis = new TrainVisuals(tm, hiddenAt);
  const smoke = new Smoke();
  const crewR = new CrewRenderer(tm.headLamp);
  vis.root.add(crewR.mesh, crewR.lamp);
  const knobs = ctx.quality?.knobs;
  const lamps = new Headlamps(ctx, knobs?.spotLights ?? 2);
  vis.root.add(lamps.group);
  smoke.group.name = 'trainSmoke';
  ctx.scene.add(vis.root, smoke.group);

  const coast = layout.lines.coast;
  const shedCurve = layout.shed.curve;
  const shedLen = layout.shed.length ?? shedCurve.getLength();
  const switchM = layout.shed.switchT * coast.length;
  const SR = layout.shedRoad;
  const shedB = layout.shed.building;
  const shedCX = shedB.center.x;
  const shedX0 = shedCX - shedB.size.x / 2, shedX1 = shedCX + shedB.size.x / 2;
  const LC = (layout.crossings ?? []).find((c) => c.line === 'coast') ?? null;
  const bridges = (layout.bridges ?? []).filter((b) => b.carries === 'rail' && b.line && b.lineT !== undefined);

  const pool = createLocoPool(rng.fork(3));
  const trains: Train[] = [];
  let listCache: TrainInfo[] | null = null;
  let seq = 0;
  let svcSeq = 0;
  let realClock = 0;
  const services: Service[] = [];
  const svcLog: Service[] = [];
  /** the train that owns the shed road / bay (arriving, being repaired or leaving) */
  let shedOwner: Train | null = null;

  // ───────────────────────── per-line state ─────────────────────────
  interface LineState {
    id: LineId;
    L: LineLayout;
    blockHolder: Train | null;
    holdUntil: number;
    lockedBy: Train | null;
    nextGen: number;
    nextDir: Dir;
    lastMailDay: number;
    blockM: [number, number];
    centreM: number;
    entryS: Record<Dir, number>;
    approachEst: Record<Dir, number>;
  }

  /** route distance at which the head sits ENTRY_DEPTH m inside the tunnel the route starts in */
  function entrySFor(r: Route): number {
    for (let s = 0; s <= r.total; s += 1) {
      r.pointAt(s, _v);
      if (tunnels.depth(_v.x, _v.z) < ENTRY_DEPTH) return Math.max(0, s - 1);
    }
    return 0;
  }

  const lines = {} as Record<LineId, LineState>;
  for (const id of ['coast', 'highland'] as LineId[]) {
    const L = layout.lines[id];
    lines[id] = {
      id, L, blockHolder: null, holdUntil: 0, lockedBy: null,
      nextGen: clock.minutes, nextDir: id === 'coast' ? 'east' : 'west', lastMailDay: -1,
      blockM: [L.signalT.east * L.length, L.signalT.west * L.length],
      centreM: ((L.platformStartT + L.platformEndT) / 2) * L.length,
      entryS: { east: entrySFor(lineRoute(L, 'east')), west: entrySFor(lineRoute(L, 'west')) },
      approachEst: { east: 25, west: 25 },
    };
  }
  const shedEntryS = entrySFor(new Route().add(SR.curve, 0, 1, 'shedRoad'));

  // ───────────────────────── helpers ─────────────────────────
  const invalidate = () => { listCache = null; };
  const now = () => clock.minutes;
  function gazette(headline: string, kind: 'info' | 'warn' | 'event' = 'info') { bus.emit('gazette', { headline, kind }); }
  function cue(c: Parameters<typeof bus.emit<'audio:cue'>>[1]['cue'], pos?: THREE.Vector3, volume?: number) {
    bus.emit('audio:cue', { cue: c, pos: pos ? pos.clone() : undefined, volume });
  }
  const night = () => { try { return ctx.reg.atmosphere?.nightFactor ?? 0; } catch { return 0; } };
  const shortName = (t: Train) => t.info.name.split(' · ')[0];

  function layoutCars(t: Train) {
    let off = 0;
    for (const c of t.cars) { c.offset = off; off += c.len; }
    t.info.length = off;
    t.info.cars = t.cars.map((c) => c.plan.type);
    t.info.capacity = t.cars.reduce((a, c) => a + c.spec.capacity, 0);
    t.info.passengers = Math.min(t.info.passengers, t.info.capacity);
    const loco = t.cars.find((c) => c.isLoco && !isRescuerCar(t, c)) ?? t.cars[0];
    if (loco) t.info.object = loco.group;
    vis.setTailLamp(t.cars, t.ghost);
  }
  const isRescuerCar = (t: Train, c: Car) => t.rescuerCar === c;

  function lineRoute(L: LineLayout, dir: Dir): Route {
    return dir === 'east' ? new Route().add(L.curve, 0, 1, L.id) : new Route().add(L.curve, 1, 0, L.id);
  }

  interface TrackPos { track: Track; m: number }
  const _tpA: TrackPos = { track: 'coast', m: 0 }, _tpB: TrackPos = { track: 'coast', m: 0 }, _tpL: TrackPos = { track: 'coast', m: 0 };
  const _occ: [number, number] = [0, 0];

  /** position on a track (track metres) for route distance s (writes `out`) */
  function trackPos(r: Route, s: number, out: TrackPos = { track: 'coast', m: 0 }): TrackPos {
    if (s < 0 || s > r.total) {
      const first = s < 0;
      const leg = first ? r.legs[0] : r.legs[r.legs.length - 1];
      const base = first ? leg.t0 : leg.t1;
      const ext = first ? s : s - r.total;
      out.track = leg.track;
      out.m = base * leg.curveLen + Math.sign(leg.t1 - leg.t0) * ext;
      return out;
    }
    const { leg, t } = r.tAt(s);
    out.track = leg.track;
    out.m = t * leg.curveLen;
    return out;
  }

  /**
   * Occupied interval [lo, hi] in metres on the given track, or null. Returns a SHARED scratch tuple:
   * read it immediately, before calling occupancy() again.
   */
  function occupancy(t: Train, line: Track): [number, number] | null {
    if (!t.entered) return null;
    const a = trackPos(t.route, t.s, _tpA), b = trackPos(t.route, t.s - t.info.length, _tpB);
    let lo = Infinity, hi = -Infinity;
    if (a.track === line) { lo = Math.min(lo, a.m); hi = Math.max(hi, a.m); }
    if (b.track === line) { lo = Math.min(lo, b.m); hi = Math.max(hi, b.m); }
    if (line === 'coast') {
      const na = a.track === 'shed', nb = b.track === 'shed';
      const ra = a.track === 'shedRoad', rb = b.track === 'shedRoad';
      if ((na || ra) !== (nb || rb) && (a.track === 'coast' || b.track === 'coast')) { lo = Math.min(lo, switchM); hi = Math.max(hi, switchM); }
      else if (na && nb && Math.min(a.m, b.m) < FOUL) { lo = Math.min(lo, switchM - 2); hi = Math.max(hi, switchM + 2); }
      else if (na && !nb && b.track !== 'coast' && a.m < FOUL) { lo = Math.min(lo, switchM - 2); hi = Math.max(hi, switchM + 2); }
    }
    if (lo > hi) return null;
    _occ[0] = lo; _occ[1] = hi;
    return _occ;
  }

  function leadM(t: Train, line: Track): number | null {
    const p = trackPos(t.route, t.s, _tpL);
    return p.track === line ? p.m : null;
  }
  const headTrack = (t: Train): Track => trackPos(t.route, t.s, _tpL).track;

  function trainsOnLine(line: LineId, except?: Train): Train[] {
    return trains.filter((o) => o !== except && o.entered && o.phase !== 'shed' && occupancy(o, line) !== null);
  }

  /** is `o` behind `t` (relative to t's travel direction) on line */
  function isBehind(o: Train, t: Train, line: LineId): boolean {
    const occ = occupancy(o, line), lm = leadM(t, line);
    if (!occ || lm === null) return false;
    const lo = occ[0], hi = occ[1];
    const tailT = trackPos(t.route, t.s - t.info.length, _tpB).m;
    return t.info.dir === 'east' ? hi <= tailT + 1 : lo >= tailT - 1;
  }

  /** anyone (other than `except`) on the shed road or siding, or owning the bay */
  function shedRoadBusy(except?: Train): boolean {
    if (shedOwner && shedOwner !== except && trains.includes(shedOwner)) return true;
    for (const o of trains) {
      if (o === except || !o.entered) continue;
      if (o.phase === 'shed') return true;
      for (const leg of o.route.legs) if (leg.track === 'shedRoad') { if (occupancy(o, 'shedRoad')) return true; break; }
      if (occupancy(o, 'shed')) return true;
    }
    return false;
  }

  // ───────────────────────── kinematics ─────────────────────────
  function stepV(v: number, dist: number, vmax: number, a: number, b: number, dtm: number): number {
    const vStop = Math.sqrt(Math.max(0, 2 * b * Math.max(0, dist - 0.25)));
    const target = Math.min(vmax, vStop);
    if (v < target) return Math.min(target, v + a * dtm);
    const dec = v - target > 3 ? 3.2 : Math.max(b * 1.4, 1.0);
    return Math.max(target, v - dec * dtm);
  }

  function estimateTime(dist: number, v0: number, vmax: number, a: number, b: number): number {
    let s = 0, v = v0, t = 0;
    for (let i = 0; i < 4000 && dist - s > 0.3; i++) {
      v = stepV(v, dist - s, vmax, a, b, 0.5);
      s += v * 0.5; t += 0.5;
      if (v < 0.02 && dist - s < 1) break;
    }
    return t;
  }

  for (const id of ['coast', 'highland'] as LineId[]) {
    const ls = lines[id];
    for (const dir of ['east', 'west'] as Dir[]) {
      const r = lineRoute(ls.L, dir);
      const s0 = ls.entryS[dir];
      const stop = r.sOfT(0, stopTFor(ls.L, dir, 80));
      const dist = stop - s0;
      // motion seconds = sim minutes (MOTION_SECONDS_PER_SIM_MINUTE = 1)
      ls.approachEst[dir] = estimateTime(dist, Math.min(V_FAR, Math.sqrt(2 * 1.5 * dist)), 22, 1.0, 1.5);
    }
  }

  // ───────────────────────── crossing (LC1) ─────────────────────────
  /** the crossing point on this route (if the route passes LC1 on the coast line) */
  function planCrossing(r: Route): CrossingPlan | null {
    if (!LC) return null;
    for (let i = 0; i < r.legs.length; i++) {
      const leg = r.legs[i];
      if (leg.track !== 'coast') continue;
      const lo = Math.min(leg.t0, leg.t1), hi = Math.max(leg.t0, leg.t1);
      if (LC.t < lo || LC.t > hi) continue;
      const dir: Dir = leg.t1 > leg.t0 ? 'east' : 'west';
      return { crossS: r.sOfT(i, LC.t), stopS: r.sOfT(i, LC.trainStopT[dir]) - 1, requested: false, granted: false, done: false };
    }
    return null;
  }
  function requestLC(t: Train): boolean {
    if (!LC || !t.crossing) return true;
    t.crossing.requested = true;
    let ok = true;
    try { ok = ctx.reg.traffic?.requestCrossing ? ctx.reg.traffic.requestCrossing(LC.id, t.info.id) !== false : true; } catch { ok = true; }
    if (ok) t.crossing.granted = true;
    return ok;
  }
  function releaseLC(t: Train) {
    if (!LC || !t.crossing || !t.crossing.requested) return;
    t.crossing.requested = false;
    try { ctx.reg.traffic?.releaseCrossing?.(LC.id, t.info.id); } catch { /* stub */ }
  }
  /** per update for a running train: request, and stop at trainStopT if the gates are not ours yet */
  function crossingLimit(t: Train): number {
    const c = t.crossing;
    if (!c || c.done) return Infinity;
    if (t.s - t.info.length > c.crossS + 6) { c.done = true; releaseLC(t); return Infinity; }
    if (t.s > c.crossS + 0.5) return Infinity; // head over the crossing: keep going
    if (c.crossS - t.s > 420) return Infinity;
    if (requestLC(t)) return Infinity;
    c.granted = false;
    return t.s <= c.stopS + 0.5 ? c.stopS : Infinity;
  }

  // ───────────────────────── origins (train doors, footplate) ─────────────────────────
  function clearDoorOrigins(t: Train) {
    for (const off of t.doorOff) { try { off(); } catch { /* ignore */ } }
    t.doorOff = [];
  }
  function registerDoorOrigins(t: Train) {
    clearDoorOrigins(t);
    const origins = ctx.origins;
    if (!origins) return;
    const pts = doorPoints(t, t.s, false);
    const inw = layout.platforms[lines[t.info.line].L.platform].inward;
    pts.forEach((p, k) => {
      const pos = p.clone();
      const ins = p.clone().addScaledVector(inw, -2.2); // inside the carriage
      t.doorOff.push(origins.add({
        id: `train:${t.info.id}:d${k}`, kind: 'train', owner: 'trains',
        pos: (o) => o.copy(pos), inside: (o) => o.copy(ins), radius: 2.2, for: ['people', 'animals'],
        // open while dwelling, through the right-away and the first metres of the start (the guard steps in last)
        open: () => t.phase === 'dwell' || t.phase === 'whistle' || (t.departAt >= 0 && t.s - t.departS < 4 && now() - t.departAt < 4),
      }));
    });
  }
  /** circus / cattle specials: each cage or van side on the platform is an origin for animals (and their keepers) */
  function registerCageOrigins(t: Train) {
    const origins = ctx.origins;
    if (!origins || !t.special) return;
    const L = lines[t.info.line].L;
    const plat = layout.platforms[L.platform];
    t.cars.forEach((c, k) => {
      const ty = c.plan.type;
      if (ty !== 'circus_cage' && ty !== 'wagon_box' && ty !== 'wagon_flat' && ty !== 'royal_saloon') return;
      const { leg, t: ct } = t.route.tAt(t.s - c.offset - c.len / 2);
      if (leg.track !== t.info.line || ct < L.platformStartT || ct > L.platformEndT) return;
      const pos = plat.edgePointAt(ct);
      const ins = pos.clone().addScaledVector(plat.inward, -2.4);
      t.doorOff.push(origins.add({
        id: `train:${t.info.id}:c${k}`, kind: 'train', owner: 'trains',
        pos: (o) => o.copy(pos), inside: (o) => o.copy(ins), radius: Math.max(3, c.len / 2), for: ['animals', 'people'],
        open: () => t.phase === 'dwell' || t.phase === 'whistle',
      }));
    });
  }
  function registerCab(t: Train) {
    if (t.cabOff || !ctx.origins || t.ghost) return;
    const tt = t;
    t.cabOff = ctx.origins.add({
      id: `train:${t.info.id}:cab`, kind: 'train', owner: 'trains',
      pos: (o) => {
        const c = tt.cars[locoIndex(tt)];
        if (!c) return o.copy(tt.info.position);
        return o.set(c.spec.loco === 'express' ? -3.8 : -2.5, 1.3, 1.6).applyMatrix4(c.group.matrix);
      },
      radius: 2.5, for: ['people'], roles: ['crew'],
      open: () => tt.entered && tt.v < 0.05,
    });
  }
  function clearCab(t: Train) { if (t.cabOff) { try { t.cabOff(); } catch { /* ignore */ } t.cabOff = null; } }

  /** audit a spawn/despawn: trains only ever (dis)appear inside a tunnel — report at the tunnel origin */
  function audit(t: Train, what: 'spawn' | 'despawn') {
    const o = ctx.origins;
    if (!o) return;
    t.route.pointAt(t.s, _v3);
    let p = _v3;
    if (tunnels.hidden(_v3.x, _v3.z, 0)) {
      const tn = o.nearest(_v3, 'vehicles', { kinds: ['tunnel'] });
      if (tn) p = tn.pos(new THREE.Vector3());
    }
    try { o.audit('trains', what, 'vehicles', p, t.info.name); } catch { /* ignore */ }
  }

  // ───────────────────────── train creation ─────────────────────────
  function newInfo(id: string, name: string, kind: TrainInfo['kind'], line: LineId, dir: Dir, loco: Loco | null): TrainInfo {
    const L = layout.lines[line];
    return {
      id, name, kind, line, dir,
      origin: L.ends[opposite(dir)], destination: L.ends[dir],
      state: 'approaching', speed: 0, position: new THREE.Vector3(), headT: 0, platform: null,
      cars: [], length: 0,
      condition: loco ? loco.condition : { boiler: 1, brakes: 1, wheels: 1, coal: 1, water: 1 },
      passengers: 0, capacity: 0, scheduledArr: now(), scheduledDep: now(), delayMin: 0, doorsOpen: false,
      object: vis.root,
    };
  }

  function makeTrain(opts: {
    name: string; kind: TrainInfo['kind']; line: LineId; dir: Dir; loco: Loco | null; plans: CarPlan[];
    task: Task; stops: boolean; ghost?: boolean; special?: string; service?: Service | null; priority: number;
    livery: LiveryId; adopt?: Car[];
  }): Train {
    const id = `T${++seq}`;
    const info = newInfo(id, opts.name, opts.kind, opts.line, opts.dir, opts.loco);
    if (opts.special) info.special = opts.special;
    if (opts.ghost) info.ghost = true;
    const ls = lines[opts.line];
    const t: Train = {
      info, seq, loco: opts.loco, cars: [], route: lineRoute(ls.L, opts.dir), s: 0, v: 0,
      task: opts.task, phase: 'queued', prevPhase: 'queued', entered: false, priority: opts.priority,
      earliestEntry: 0, stops: opts.stops, stopS: null, stopDone: false, signalS: null,
      needsBlock: true, hasBlock: false, blockDone: false, waitSince: -1, failedOverride: false, caution: false,
      dwellUntil: 0, dwellHard: 0, whistleUntil: 0, arrivedAt: 0, alighted: false,
      service: opts.service ?? null, shedPending: false, shedUrgent: false, ghost: !!opts.ghost, special: opts.special,
      vBase: 18, accel: 0.55, brake: 0.85, canExit: false, centreS: 0, livery: opts.livery,
      approachEmitted: false, brakeCue: false, brokenAt: 0, rescueRequested: false, rescueTarget: null,
      rescuerCar: null, rescuerLoco: null, removeRescuerAt: -1, dead: false, shedAt: 0, pauseUntil: 0, stuckFor: 0,
      crossing: null, crossWaitSince: -1, doorOff: [], departS: 0, departAt: -1, cabOff: null, prevLead: NaN,
      chuffAcc: 0, puffClock: 0, sparkClock: 0, hissAt: 0, cockUntil: 0, blowUntil: 0, nextBlow: 0, lastV: 0, spooked: false,
      crew: newCrewState(seq * 7 + 3),
    };
    const locoName = opts.loco?.name ?? null;
    for (const p of opts.plans) t.cars.push(vis.makeCar(p, id, p.type.startsWith('loco') ? locoName : null, t.ghost));
    if (opts.adopt) for (const c of opts.adopt) { c.group.userData.pick = { kind: 'train', id }; t.cars.push(c); }
    layoutCars(t);
    t.info.passengers = Math.round(t.info.capacity * rng.range(0.25, 0.75));
    tune(t);
    setupLineRun(t, opts.line, opts.dir);
    trains.push(t);
    invalidate();
    bus.emit('train:spawned', { trainId: id });
    return t;
  }

  function tune(t: Train) {
    const k = t.info.kind;
    t.vBase = t.ghost ? GHOST_FAST : k === 'express' ? 24 : k === 'freight' ? 18 : 20;
    t.accel = t.ghost ? 2.5 : (k === 'freight' ? 0.7 : k === 'express' ? 0.95 : 1.05);
    t.brake = t.ghost ? 4 : k === 'freight' ? 1.15 : 1.5;
  }

  /** (re)build a plain line run: entry in the tunnel at the dir's start, stop/signal points */
  function setupLineRun(t: Train, line: LineId, dir: Dir) {
    const ls = lines[line];
    const L = ls.L;
    t.route = lineRoute(L, dir);
    t.info.line = line; t.info.dir = dir;
    t.s = ls.entryS[dir];
    t.signalS = t.route.sOfT(0, L.signalT[dir]) - 2;
    t.centreS = t.route.sOfT(0, (L.platformStartT + L.platformEndT) / 2);
    t.stopS = t.stops ? t.route.sOfT(0, stopTFor(L, dir, t.info.length)) : null;
    t.info.platform = t.stops ? L.platform : null;
    t.info.origin = L.ends[opposite(dir)];
    t.info.destination = L.ends[dir];
    t.crossing = planCrossing(t.route);
  }

  function removeTrain(t: Train) {
    const tgt = t.rescueTarget;
    if (t.task === 'rescuer' && tgt && tgt.phase === 'broken' && trains.includes(tgt)) {
      tgt.rescueRequested = false; // rescue abandoned: auto-rescue will try again
      tgt.brokenAt = now();
    }
    if (t.entered) audit(t, 'despawn');
    releaseLC(t);
    clearDoorOrigins(t);
    clearCab(t);
    for (const c of t.cars) vis.removeCar(c);
    t.cars = [];
    if (t.loco) t.loco.busy = false;
    if (t.rescuerLoco) t.rescuerLoco.busy = false;
    for (const ls of Object.values(lines)) {
      if (ls.blockHolder === t) ls.blockHolder = null;
      if (ls.lockedBy === t) ls.lockedBy = null;
    }
    if (shedOwner === t) shedOwner = null;
    const i = trains.indexOf(t);
    if (i >= 0) trains.splice(i, 1);
    invalidate();
    bus.emit('train:despawned', { trainId: t.info.id });
  }

  function releaseBlock(t: Train) {
    for (const ls of Object.values(lines)) if (ls.blockHolder === t) ls.blockHolder = null;
    t.hasBlock = false;
  }

  function hideTrain(t: Train) {
    if (t.entered) audit(t, 'despawn');
    releaseBlock(t);
    releaseLC(t);
    clearDoorOrigins(t);
    clearCab(t);
    t.entered = false;
    t.v = 0;
    for (const c of t.cars) c.group.visible = false;
  }

  function setCars(t: Train, plans: CarPlan[], keep: Car[] = []) {
    for (const c of t.cars) if (!keep.includes(c)) vis.removeCar(c);
    t.cars = [];
    const locoName = t.loco?.name ?? null;
    for (const p of plans) t.cars.push(vis.makeCar(p, t.info.id, p.type.startsWith('loco') ? locoName : null, t.ghost));
    for (const c of keep) t.cars.push(c);
    layoutCars(t);
  }

  // ───────────────────────── shed flows (v2: the shed road) ─────────────────────────
  /** route distance on `r` of the first point whose x is ≤ x (westbound) / ≥ x (eastbound) on the shed straight */
  function sAtX(r: Route, x: number, westbound: boolean): number {
    let best = 0, bd = Infinity;
    for (let s = 0; s <= r.total; s += 0.5) {
      r.pointAt(s, _v);
      if (Math.abs(_v.z - SR.z) > 1.5) continue;
      const d = Math.abs(_v.x - x);
      if (d < bd) { bd = d; best = s; }
    }
    void westbound;
    return best;
  }

  /** Convert a train (now off the map) into a light engine that enters from the shed tunnel and runs east to the bay. */
  function convertToShed(t: Train, rescued: boolean) {
    hideTrain(t);
    if (t.service && t.service.state !== 'departed') t.service.state = 'cancelled';
    t.service = null;
    const liv: LiveryId = t.livery === 'royal' || t.livery === 'circus' ? t.livery : (t.loco?.home ?? 'coast');
    const plans = t.loco ? locoCars(t.loco, liv) : [{ type: 'loco_tank' as CarType, livery: liv, variant: 0 }];
    if (rescued && !t.rescuerCar) {
      // off-map rescue: a pilot tank engine pushes the dead engine home
      const pl = takeLoco(pool, rng, t.loco?.home ?? 'coast', 'loco_tank');
      t.rescuerLoco = pl;
      t.rescuerCar = vis.makeCar({ type: 'loco_tank', livery: pl.home, variant: 0 }, t.info.id, pl.name, false);
    }
    const keep = t.rescuerCar ? [t.rescuerCar] : [];
    if (t.rescuerCar) t.rescuerCar.flipped = false;
    setCars(t, plans, keep);
    for (const c of t.cars) c.working = c === t.rescuerCar || (!t.dead && c.isLoco);
    t.task = 'shed';
    t.phase = 'queued';
    t.stops = false;
    t.info.passengers = 0;
    t.info.doorsOpen = false;
    t.info.platform = null;
    t.info.line = 'coast';
    t.info.dir = 'east';
    t.info.destination = 'Engine Shed';
    t.info.state = rescued ? 'rescued' : 'toShed';
    t.route = new Route().add(SR.curve, 0, 1, 'shedRoad');
    t.s = shedEntryS;
    t.signalS = null;
    t.centreS = 0;
    t.stopS = sAtX(t.route, shedCX + t.info.length / 2, false);
    t.stopDone = false;
    t.needsBlock = false; t.hasBlock = false; t.blockDone = true;
    t.failedOverride = false; t.caution = false; t.waitSince = -1;
    t.canExit = false;
    t.crossing = null;
    t.priority = 2;
    t.earliestEntry = now() + 0.5;
    t.shedPending = false;
    t.vBase = V_SHED_ROAD; t.accel = 1.2; t.brake = 4;
    invalidate();
  }

  /** goods trains, ghosts and anything without seats never open their doors to the public */
  function carriesPassengers(t: Train): boolean {
    return t.info.kind !== 'freight' && t.info.capacity > 0 && !t.ghost && t.task === 'service';
  }

  /** a coast westbound train that has just left P1 runs straight through the switch, siding and into the shed */
  function canDivert(t: Train): boolean {
    if (t.info.line !== 'coast' || t.info.dir !== 'west' || t.dead || t.ghost) return false;
    // a train that finished its booked call with travellers aboard carries them on; it comes back as a light engine
    if (!t.shedUrgent && t.info.passengers > 0) return false;
    if (shedRoadBusy(t)) return false;
    const lead = leadM(t, 'coast');
    // the head must still be east of the switch, with room to ease down to siding speed
    const margin = 8 + Math.max(0, t.v * t.v - V_SIDING * V_SIDING) / (2 * 2.5);
    if (lead === null || lead < switchM + margin) return false;
    return true;
  }
  function divertToShed(t: Train): boolean {
    const r = new Route().add(coast.curve, 1, layout.shed.switchT, 'coast').add(shedCurve, 0, 1, 'shed');
    const endX = shedCurve.getPointAt(1).x;
    r.add(SR.curve, SR.tAtX(endX), 0, 'shedRoad');
    // the train's current route is coast 1 → 0, so s carries over unchanged on the first leg
    const locoLen = t.cars.filter((c) => c.isLoco || c.plan.type === 'tender').reduce((a, c) => a + c.len, 0) || 18;
    const stopS = sAtX(r, shedCX - locoLen / 2, true);
    if (stopS - t.info.length < r.legs[0].len + FOUL) return false; // tail would foul the coast switch
    t.route = r;
    t.task = 'shed';
    t.stops = false;
    t.stopS = stopS;
    t.stopDone = false;
    t.canExit = false;
    t.needsBlock = false;
    t.info.state = 'toShed';
    t.info.destination = 'Engine Shed';
    t.info.passengers = 0;
    t.info.platform = null;
    t.shedPending = false;
    t.crossing = null;
    t.vBase = V_SIDING;
    shedOwner = t;
    cue('whistle', t.info.position, 0.45);
    invalidate();
    return true;
  }

  function arriveInShed(t: Train) {
    t.phase = 'shed';
    t.v = 0;
    t.shedAt = now();
    t.info.state = 'inShed';
    t.dead = false;
    // the shed pilot waits for a fitter to lift the coupling (maintenance calls trainsShared.uncouple), or leaves by itself
    if (t.rescuerCar) t.removeRescuerAt = now() + 30;
    for (const c of t.cars) c.working = c.isLoco;
    shedOwner = t;
    bus.emit('train:inShed', { trainId: t.info.id });
    cue('clank', t.info.position, 0.6);
    t.nextBlow = now() + rng.range(1, 4);
  }

  /** the pilot engine uncouples in the shed and runs back out west through the shed tunnel (no pop-out) */
  function splitPilot(t: Train) {
    const rc = t.rescuerCar;
    if (!rc) return;
    const headX = t.route.pointAt(t.s, _v).x;
    const eastEnd = headX - rc.offset; // t faces east: its cars run west from the head
    t.cars = t.cars.filter((c) => c !== rc);
    t.rescuerCar = null;
    const pl = t.rescuerLoco;
    t.rescuerLoco = null;
    t.removeRescuerAt = -1;
    layoutCars(t);
    rc.flipped = !rc.flipped;
    const p = makeTrain({
      name: `Shed Pilot · ${pl?.name ?? 'tank engine'}`, kind: 'special', line: 'coast', dir: 'west', loco: pl, plans: [],
      task: 'release', stops: false, special: 'rescue', priority: 0, livery: pl?.home ?? 'coast', adopt: [rc],
    });
    p.info.passengers = 0;
    p.info.destination = 'Ashby Vale';
    p.info.state = 'fromShed';
    p.route = new Route().add(SR.curve, SR.tAtX(eastEnd), 0, 'shedRoad');
    p.s = rc.len + 0.8; // a little gap opens at the coupling
    p.stopS = null; p.stopDone = true; p.needsBlock = false; p.blockDone = true; p.signalS = null; p.crossing = null;
    p.canExit = true;
    p.entered = true;
    p.phase = 'hold';
    p.pauseUntil = now() + 0.8;
    p.vBase = V_SHED_ROAD; p.accel = 0.7; p.brake = 1.0;
    for (const c of p.cars) c.working = true;
    registerCab(p);
    cue('clank', t.info.position, 0.7);
    t.route.pointAt(t.s - t.info.length, _v);
    smoke.emit(_v.x, 1.1, _v.z, 0, 1.2, 0, 0.5, PUFF_STEAM, 1.6);
  }

  function startRelease(t: Train) {
    const head = t.route.pointAt(t.s, _v).clone();
    t.route.tangentAt(Math.min(t.route.total, t.s), _tan);
    if (_tan.x > 0) {
      // light engine faces east: reverse and back out tender-first to the west
      t.cars.reverse();
      for (const c of t.cars) c.flipped = !c.flipped;
      layoutCars(t);
      t.route = new Route().add(SR.curve, SR.tAtX(head.x), 0, 'shedRoad');
      t.s = t.info.length;
    }
    // (a train that came in off the siding already faces west: it simply continues through the shed, coaches and all)
    t.stopS = null;
    t.stopDone = true;
    t.needsBlock = false;
    t.blockDone = true;
    t.task = 'release';
    t.phase = 'hold';
    t.pauseUntil = now() + 0.6;
    t.info.dir = 'west';
    t.info.state = 'fromShed';
    t.info.destination = 'Ashby Vale';
    t.canExit = true;
    t.vBase = V_SHED_ROAD; t.accel = 0.6; t.brake = 0.9;
    cue('whistle', head, 0.5);
  }

  // ───────────────────────── rescue flows ─────────────────────────
  function spawnRescuer(target: Train): Train | null {
    const line = target.info.line;
    const dir = opposite(target.info.dir);
    const loco = takeLoco(pool, rng, line, 'loco_tank');
    const r = makeTrain({
      name: `Rescue Engine · ${loco.name}`, kind: 'special', line, dir, loco,
      plans: locoCars(loco, line), task: 'rescuer', stops: false, special: 'rescue', priority: 0, livery: line,
    });
    r.rescueTarget = target;
    r.needsBlock = false;
    r.info.destination = 'Rescue';
    r.vBase = 14;
    r.accel = 0.7;
    r.info.passengers = 0;
    return r;
  }

  function coupleRescue(r: Train) {
    const t = r.rescueTarget;
    if (!t || !trains.includes(t)) { r.task = 'service'; r.canExit = true; r.stopDone = true; r.phase = 'run'; return; }
    const car = r.cars[0];
    r.cars = [];
    car.flipped = !car.flipped;
    car.group.userData.pick = { kind: 'train', id: t.info.id };
    t.cars.unshift(car);
    t.rescuerCar = car;
    t.rescuerLoco = r.loco;
    r.loco = null;
    layoutCars(t);
    t.s += car.len;
    for (const c of t.cars) c.working = c === car;
    t.dead = true;
    t.task = 'hauled';
    t.phase = 'run';
    t.info.state = 'rescued';
    t.stops = false;
    t.stopS = null;
    t.stopDone = true;
    t.needsBlock = false;
    t.canExit = true;
    t.info.doorsOpen = false;
    t.info.platform = null;
    clearDoorOrigins(t);
    t.vBase = V_HAUL;
    t.accel = 0.3;
    t.crossing = planCrossing(t.route);
    if (t.crossing && t.s > t.crossing.crossS) t.crossing.done = true;
    if (t.service && t.service.state !== 'departed') t.service.state = 'cancelled';
    lines[t.info.line].lockedBy = t;
    gazette(`Rescue engine “${t.rescuerLoco?.name ?? 'tank engine'}” couples up to the stricken ${t.info.name}.`, 'info');
    r.entered = false; // its engine lives on at the head of the hauled train — not a despawn
    removeTrain(r);
  }

  // ───────────────────────── entry control ─────────────────────────
  function ghostReserved(line: LineId, t: Train): boolean {
    return trains.some((g) => g !== t && g.ghost && g.info.line === line && !g.entered && g.phase === 'queued' && g.earliestEntry - now() < 60);
  }

  /** the Phantom may slip in behind a same-direction train that has finished its stop and is well ahead */
  function ghostMayFollow(g: Train, o: Train, line: LineId, entryM: number): boolean {
    if (o.info.dir !== g.info.dir || (o.stops && !o.stopDone)) return false;
    const occ = occupancy(o, line);
    if (!occ) return true;
    return g.info.dir === 'east' ? occ[0] - entryM > GHOST_FOLLOW_GAP + 60 : entryM - occ[1] > GHOST_FOLLOW_GAP + 60;
  }
  /** busy windows for the Phantom on line/dir: opposing trains, and same-way trains that have yet to make their stop */
  function ghostBlockers(line: LineId, dir: Dir): [number, number][] {
    const tNow = now();
    const out: [number, number][] = [];
    for (const o of trains) {
      if (o.info.line !== line || !o.entered || o.task === 'shed' || o.ghost || (o.task === 'release' && headTrack(o) !== line)) continue;
      if (o.info.dir === dir && (!o.stops || o.stopDone)) {
        // leaving ahead of us: only until it has drawn clear of the entry
        const lm = leadM(o, line);
        const L = lines[line];
        const entryM = dir === 'east' ? 0 : L.L.length;
        const ahead = lm === null ? 1e9 : Math.abs(lm - entryM) - o.info.length;
        out.push([tNow, tNow + Math.max(0, (GHOST_FOLLOW_GAP + 80 - ahead) / Math.max(8, o.v))]);
        continue;
      }
      if (o.info.dir === dir && o.stops && !o.stopDone && o.stopS !== null) {
        // same way, still to make its stop: we can follow once it has pulled out of the platform
        const toStop = o.phase === 'dwell' || o.phase === 'whistle' ? Math.max(0, o.dwellUntil - tNow) + 1.5 : Math.max(0, o.stopS - o.s) / Math.max(6, o.v) + (o.service?.dwell ?? 3) + 1.5;
        out.push([tNow, tNow + toStop + 4]);
        continue;
      }
      out.push([tNow, tNow + remainingOnLine(o)]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }

  function canEnter(t: Train): boolean {
    if (now() < t.earliestEntry) return false;
    const line = t.info.line, dir = t.info.dir;
    const ls = lines[line];
    if (t.task === 'shed') return !shedRoadBusy(t);
    if (ls.lockedBy && ls.lockedBy !== t && trains.includes(ls.lockedBy)) return false;
    if (ls.lockedBy && !trains.includes(ls.lockedBy)) ls.lockedBy = null;
    if (!t.ghost && ghostReserved(line, t)) return false;
    const others = trainsOnLine(line, t);
    if (t.task === 'rescuer') {
      const tgt = t.rescueTarget;
      if (!tgt) return false;
      for (const o of others) {
        if (o === tgt) continue;
        if (o.info.dir === tgt.info.dir && isBehind(o, tgt, line)) continue;
        return false;
      }
      return crossingOkToEnter(t);
    }
    const entryM = trackPos(t.route, t.s).m;
    for (const o of others) {
      if (o.info.dir !== dir) return false;
      if (t.ghost) { if (ghostMayFollow(t, o, line, entryM)) continue; return false; }
      const occ = occupancy(o, line)!;
      const lo = dir === 'east' ? entryM - 40 : entryM - 220;
      const hi = dir === 'east' ? entryM + 220 : entryM + 40;
      if (occ[1] >= lo && occ[0] <= hi) return false;
    }
    return crossingOkToEnter(t);
  }

  /** westbound coast trains get the LC1 gates while still inside the east tunnel (any wait is invisible) */
  function crossingOkToEnter(t: Train): boolean {
    const c = t.crossing;
    if (!c || c.done || t.s > c.crossS || c.crossS - t.s > 420) return true;
    return requestLC(t);
  }

  function enter(t: Train) {
    t.entered = true;
    t.phase = 'run';
    const ls = lines[t.info.line];
    const dist = t.stopS !== null ? t.stopS - t.s : 400;
    t.v = Math.min(t.ghost ? GHOST_FAST : t.task === 'shed' ? V_SHED_ROAD : V_FAR, Math.sqrt(2 * t.brake * Math.max(0, dist)), t.vBase + 6);
    if (t.task === 'rescuer') { ls.lockedBy = t; t.v = Math.min(t.v, 14); }
    if (t.task === 'shed') shedOwner = t;
    if (t.ghost) { ls.lockedBy = t; if (!t.spooked) { t.spooked = true; cue('spooky', undefined, 0.8); } }
    t.stuckFor = 0;
    t.prevLead = NaN;
    if (t.service) t.service.enteredAt = now();
    audit(t, 'spawn');
    registerCab(t);
  }

  // ───────────────────────── timetable ─────────────────────────
  function hourOf(min: number) { return ((min % 1440) + 1440) % 1440 / 60; }
  const EST_LEN: Record<string, number> = { express: 96, local: 52, freight: 70, mail: 74, special: 80 };

  function addService(line: LineId, dir: Dir, kind: Service['kind'], arr: number, stops: boolean, dwell: number, special?: string, name?: string): Service {
    const L = layout.lines[line];
    let est = EST_LEN[kind] ?? 80;
    if (line === 'highland' && kind !== 'freight') est = Math.min(est, HIGHLAND_MAX_LEN);
    const sv: Service = {
      id: ++svcSeq, line, dir, kind, special,
      name: name ?? serviceName(kind, line, dir, L.ends[dir], rng),
      origin: L.ends[opposite(dir)], dest: L.ends[dir],
      arr, dep: arr + (stops ? dwell : 0), dwell, stops, state: 'planned', trainId: null, hold: 0, depActual: 0, warned: false,
      estLen: est,
    };
    services.push(sv);
    return sv;
  }

  function generate() {
    const horizon = now() + 240;
    for (const ls of Object.values(lines)) {
      let t = ls.nextGen;
      let guard = 0;
      while (t < horizon && guard++ < 50) {
        const h = hourOf(t);
        const day = Math.floor(t / 1440);
        if (h >= 0.5 && h < 5.5) {
          if (ls.id === 'coast' && ls.lastMailDay !== day) {
            ls.lastMailDay = day;
            const mailT = day * 1440 + 120;
            if (mailT >= now()) addService('coast', 'west', 'mail', mailT, true, 1.5);
          }
          if (ls.id === 'highland' && ls.lastMailDay !== day) {
            ls.lastMailDay = day;
            const gT = day * 1440 + 200 + rng.range(0, 30);
            if (gT >= now()) addService('highland', rng.chance(0.5) ? 'east' : 'west', 'freight', gT, false, 0);
          }
          t = day * 1440 + 330 + rng.range(0, 10);
          continue;
        }
        const busy = h >= 6 && h < 22;
        // by day every direction slot carries passengers (goods trains follow in a flight, or run at night) — so a
        // traveller who misses a train never faces a >2 h wait for the next one in the same direction
        const kind = busy
          ? rng.weighted<Service['kind']>([{ w: 0.5, v: 'express' }, { w: 0.5, v: 'local' }])
          : rng.weighted<Service['kind']>([{ w: 0.4, v: 'express' }, { w: 0.35, v: 'local' }, { w: 0.25, v: 'freight' }]);
        const dir = ls.nextDir;
        ls.nextDir = opposite(dir);
        const stops = kind !== 'freight' || rng.chance(0.3);
        const dwell = kind === 'express' ? rng.range(2, 3) : kind === 'local' ? rng.range(2, 4) : 1.5;
        addService(ls.id, dir, kind, t, stops, dwell);
        // same-direction goods often follows close behind (it waits at the home signal while the passenger
        // train dwells). A single-track line reverses direction at most about once an hour.
        let gap = busy ? rng.range(58, 72) : rng.range(75, 95);
        if (busy && kind !== 'freight' && rng.chance(0.4)) {
          // a flight: a second train in the same direction. It can only have the block once the leader has cleared
          // it (the leader needs ~20 motion-s after its dwell to clear the platform block at 1 m/s²)
          if (rng.chance(0.4)) {
            addService(ls.id, dir, 'local', t + rng.range(36, 40), true, rng.range(2, 3));
            gap += 38;
          } else {
            const fStops = rng.chance(0.25);
            addService(ls.id, dir, 'freight', t + (fStops ? rng.range(34, 38) : rng.range(28, 32)), fStops, 1.5);
            gap += 32;
          }
        }
        t += gap;
      }
      ls.nextGen = t;
    }
    services.sort((a, b) => a.arr - b.arr);
  }

  /** planned entry time (sim min) of a service */
  const dueOf = (sv: Service) => sv.arr + sv.hold - lines[sv.line].approachEst[sv.dir];

  function spawnService(sv: Service): Train {
    const line = sv.line;
    const kind: TrainInfo['kind'] = sv.kind === 'mail' ? 'express' : sv.special ? 'special' : sv.kind;
    const locoType = sv.kind === 'express' || sv.kind === 'mail' ? 'loco_express' : sv.kind === 'local' ? 'loco_tank' : (rng.chance(0.5) ? 'loco_express' : 'loco_tank');
    const loco = takeLoco(pool, rng, line, locoType);
    const plans = buildConsist(sv.kind, line, rng, loco);
    const t = makeTrain({
      name: `${sv.name} · ${loco.name}`, kind, line, dir: sv.dir, loco, plans, task: 'service', stops: sv.stops,
      service: sv, priority: 3, livery: line,
    });
    t.info.scheduledArr = sv.arr;
    t.info.scheduledDep = sv.dep;
    t.earliestEntry = dueOf(sv);
    sv.trainId = t.info.id;
    sv.state = 'active';
    sv.spawnedAt = now();
    sv.estLen = t.info.length;
    if (sv.kind === 'freight') t.info.passengers = 0;
    emitApproaching(t);
    return t;
  }

  /** passengers get the train's stopping position well ahead (predictedDoors is valid from here on) */
  function emitApproaching(t: Train) {
    if (t.approachEmitted || !t.stops || t.task !== 'service' || t.ghost) return;
    t.approachEmitted = true;
    bus.emit('train:approaching', { trainId: t.info.id, line: t.info.line, platform: lines[t.info.line].L.platform as PlatformId });
  }

  function cancelService(sv: Service, why: string) {
    sv.state = 'cancelled';
    if (sv.stops) gazette(`The ${formatSimTime(sv.dep)} ${sv.name} to ${sv.dest} has been cancelled ${why}.`, 'warn');
  }

  function serviceTick() {
    generate();
    const tNow = now();
    for (const ls of Object.values(lines)) {
      const queued = trains.filter((t) => !t.entered && t.task === 'service' && t.info.line === ls.id && t.phase === 'queued').length;
      for (let guard = 0; guard < 4; guard++) {
        const next = services.find((s) => s.line === ls.id && s.state === 'planned');
        if (!next) break;
        const projected = Math.max(next.hold, tNow + ls.approachEst[next.dir] - next.arr);
        if (projected > CANCEL_LATE) { cancelService(next, 'owing to congestion on the line'); continue; }
        if (tNow >= dueOf(next) - SPAWN_LEAD && queued < MAX_QUEUED_PER_LINE) spawnService(next);
        break;
      }
    }
    // withdraw queued (off-map) trains that could only arrive hopelessly late
    for (const t of trains) {
      if (t.entered || t.phase !== 'queued' || t.task !== 'service' || !t.service || t.special) continue;
      const proj = Math.max(tNow, t.earliestEntry) + lines[t.info.line].approachEst[t.info.dir] - t.info.scheduledArr;
      if (proj > CANCEL_LATE) {
        cancelService(t.service, 'and the train withdrawn to recover the timetable');
        removeTrain(t);
        break;
      }
    }
    // prune old services
    for (let i = services.length - 1; i >= 0; i--) {
      const s = services[i];
      if ((s.state === 'departed' && tNow - s.depActual > 30) || (s.state === 'cancelled' && tNow - s.dep > 60)) services.splice(i, 1);
    }
  }

  function serviceDelay(sv: Service): number {
    const tNow = now();
    if (sv.state === 'departed') return Math.max(0, Math.round(sv.depActual - sv.dep));
    if (sv.trainId) {
      const t = byId(sv.trainId);
      if (t) return t.info.delayMin;
    }
    const ls = lines[sv.line];
    return Math.max(0, Math.round(tNow + ls.approachEst[sv.dir] - sv.arr), Math.round(sv.hold));
  }

  // ───────────────────────── ledger (nextGap, specials, eta) ─────────────────────────
  /** remaining sim minutes this entered train occupies its line */
  function remainingOnLine(t: Train): number {
    if (t.phase === 'dwell' || t.phase === 'whistle') return Math.max(0, t.dwellUntil - now()) + EXIT_EST;
    if (t.phase === 'broken') return 60;
    if (t.stops && !t.stopDone && t.stopS !== null) return Math.max(0, t.stopS - t.s) / Math.max(6, t.v) + (t.service?.dwell ?? 3) + EXIT_EST;
    return EXIT_EST * 0.8;
  }
  /** busy windows on a line [from, to] in sim minutes (entered, queued and planned trains) */
  function busyWindows(line: LineId, plannedToo = true, enteredOnly = false): [number, number][] {
    const tNow = now();
    const out: [number, number][] = [];
    for (const t of trains) {
      if (t.info.line !== line || t.task === 'shed' || (t.task === 'release' && headTrack(t) !== line)) continue;
      if (t.entered) out.push([tNow, tNow + remainingOnLine(t)]);
      else if (t.phase === 'queued' && !enteredOnly && !t.ghost) {
        const e = Math.max(tNow, t.earliestEntry);
        const dw = t.stops ? (t.service?.dwell ?? 3) : 0;
        out.push([e - 1, e + lines[line].approachEst[t.info.dir] + dw + EXIT_EST]);
      }
    }
    if (plannedToo) for (const sv of services) {
      if (sv.line !== line || sv.state !== 'planned') continue;
      out.push([dueOf(sv) - 2, sv.dep + sv.hold + EXIT_EST + 2]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }
  function gapIn(wins: [number, number][], from: number, minutes: number): { start: number; end: number } {
    let start = from;
    for (const [a, b] of wins) {
      if (b <= start) continue;
      if (a - start >= minutes) return { start, end: a };
      start = Math.max(start, b);
    }
    return { start, end: start + 24 * 60 };
  }

  /** a stopping special wants a clear run in at `target`: take the first free slot, holding/cancelling planned trains */
  function slotSpecial(line: LineId, dir: Dir, target: number, dwell: number, name: string): number {
    const ls = lines[line];
    const appr = ls.approachEst[dir];
    const need = appr + dwell + EXIT_EST + 2;
    const g = gapIn(busyWindows(line, false), target - appr, need);
    const entry = g.start;
    const w0 = entry - 2, w1 = entry + need + 2;
    for (const sv of services) {
      if (sv.line !== line || sv.state !== 'planned') continue;
      const a = dueOf(sv) - 2, b = sv.dep + sv.hold + EXIT_EST + 2;
      if (b < w0 || a > w1) continue;
      const shift = w1 - a;
      if (shift <= 10) sv.hold += shift;
      else cancelService(sv, `to make way for ${name}`);
    }
    return entry;
  }

  // ───────────────────────── warm start ─────────────────────────
  function warmStart() {
    const tNow = now();
    const h = hourOf(tNow);
    if (h >= 0.5 && h < 5.5) return; // quiet night: the timetable will bring the night mail
    // coast: a local sliding into platform 1; highland: an express approaching platform 2
    const svA = addService('coast', 'east', 'local', tNow + 0.2, true, rng.range(2.5, 3.5));
    const a = spawnService(svA);
    a.earliestEntry = tNow;
    enter(a);
    a.s = (a.stopS ?? a.s) - 4; a.v = 2.2;
    const svB = addService('highland', 'west', 'express', tNow + 16, true, rng.range(2, 3));
    const b = spawnService(svB);
    b.earliestEntry = tNow;
    enter(b);
    const d = 120;
    b.s = (b.stopS ?? b.s) - d; b.v = Math.sqrt(2 * b.brake * d);
    for (const t of [a, b]) if (t.crossing && t.s > t.crossing.crossS) t.crossing.done = true;
    // next services leave room for the warm-start trains to clear the single-track lines
    lines.coast.nextGen = tNow + rng.range(52, 60);
    lines.coast.nextDir = 'west';
    lines.highland.nextGen = tNow + rng.range(68, 76);
    lines.highland.nextDir = 'east';
    placeAll();
  }

  // ───────────────────────── per-train update ─────────────────────────
  function vmaxFor(t: Train): number {
    let vm = t.vBase;
    const trk = headTrack(t);
    if (t.ghost) return ghostVmax(t);
    const lm = leadM(t, t.info.line);
    if (t.task === 'service' && lm !== null) {
      const dc = Math.abs(lm - lines[t.info.line].centreM);
      if (dc > FAR_ZONE) vm = V_FAR;
      if (!t.stops && t.hasBlock && dc < 90) vm = Math.min(vm, V_THROUGH);
    }
    if (t.task === 'shed' || t.task === 'release') {
      if (trk === 'shed') vm = V_SIDING;
      else if (trk === 'shedRoad') {
        const x = t.route.pointAt(t.s, _v).x;
        vm = x > shedX0 - 2 && x < shedX1 + 2 ? V_SHED_IN : V_SHED_ROAD;
        if (t.task === 'release' && x < shedX0 - 20) vm = 16;
      } else if (trk === 'coast' && t.task === 'shed') vm = Math.min(vm, V_SIDING);
    }
    if (leavingFar(t)) vm = Math.max(vm, t.shedPending ? V_EXIT + 8 : V_EXIT);
    else {
      // drivers ease off in fog and snow
      const atmo = ctx.reg.atmosphere;
      if (atmo) vm *= 1 - 0.25 * Math.min(1, atmo.fog ?? 0) - 0.15 * Math.min(1, atmo.snow ?? 0);
    }
    if (t.caution) vm = Math.min(vm, V_CAUTION);
    if (t.dead && !t.rescuerCar) vm = Math.min(vm, 6); // nudged along by the shed pilot
    const c = t.info.condition;
    if (Math.min(c.coal, c.water) < 0.08 && !t.dead) vm *= 0.6;
    return vm;
  }

  /** motion seconds (= sim min) from the Phantom's tunnel entry to the platform */
  function ghostApproach(line: LineId, dir: Dir): number {
    const ls = lines[line], L = ls.L;
    const r = lineRoute(L, dir);
    const ps = r.sOfT(0, dir === 'east' ? L.platformStartT : L.platformEndT);
    const d = Math.max(0, ps - ls.entryS[dir]);
    const fast = Math.max(0, d - GHOST_GLIDE_LEAD - 60);
    return fast / GHOST_FAST + 60 / ((GHOST_FAST + GHOST_GLIDE) / 2) + Math.min(d, GHOST_GLIDE_LEAD) / GHOST_GLIDE;
  }

  /** the Phantom: 40 m/s until ~110 m short of the platform, a 7.5 m/s glide past it, then gone at speed */
  function ghostVmax(t: Train): number {
    const v = ghostVmaxFree(t);
    // never close on a train leaving ahead on the same line
    const lm = leadM(t, t.info.line);
    if (lm === null) return v;
    let cap = v;
    for (const o of trains) {
      if (o === t || !o.entered || o.info.line !== t.info.line || o.info.dir !== t.info.dir) continue;
      const occ = occupancy(o, t.info.line);
      if (!occ) continue;
      const gap = t.info.dir === 'east' ? occ[0] - lm : lm - occ[1];
      if (gap < 0) continue;
      if (gap < GHOST_FOLLOW_GAP) cap = Math.min(cap, Math.max(0, o.v - 1 + (gap - GHOST_FOLLOW_GAP * 0.6) * 0.05));
    }
    return cap;
  }
  function ghostVmaxFree(t: Train): number {
    const L = lines[t.info.line].L;
    const east = t.info.dir === 'east';
    const psS = t.route.sOfT(0, east ? L.platformStartT : L.platformEndT);
    const peS = t.route.sOfT(0, east ? L.platformEndT : L.platformStartT);
    if (t.s < psS) return Math.min(GHOST_FAST, Math.sqrt(GHOST_GLIDE ** 2 + 2 * GHOST_BRAKE * Math.max(0, psS - GHOST_GLIDE_LEAD - t.s)));
    // glides on until its engine has cleared the platform, then melts away at speed into the far tunnel
    if (t.s < peS + 12) return GHOST_GLIDE;
    return GHOST_FAST;
  }

  /** leaving the station and well clear of the platform: allowed to open up hard */
  function leavingFar(t: Train): boolean {
    if (t.task !== 'service' || t.ghost || (t.stops && !t.stopDone)) return false;
    const lm = leadM(t, t.info.line);
    if (lm === null) return false;
    const d = (lm - lines[t.info.line].centreM) * (t.info.dir === 'east' ? 1 : -1);
    // an engine ordered to the shed runs off smartly (it returns as a light engine through the shed tunnel)
    return d > (t.shedPending ? 30 : EXIT_ZONE);
  }

  function limitFor(t: Train): { limit: number; atSignal: boolean } {
    let limit = Infinity;
    let atSignal = false;
    if (t.stopS !== null && !t.stopDone) limit = t.stopS;
    if (t.needsBlock && !t.hasBlock && !t.blockDone && t.signalS !== null && t.s <= t.signalS + 0.5) {
      if (t.signalS < limit) { limit = t.signalS; atSignal = true; }
    }
    const cl = crossingLimit(t);
    if (cl < limit) { limit = cl; atSignal = true; }
    const trk = headTrack(t);
    const my = leadM(t, trk);
    if (my !== null) {
      const sgn = trackSense(t);
      for (const o of trains) {
        if (o === t || !o.entered) continue;
        if (o.phase === 'shed' && trk !== 'shedRoad' && trk !== 'shed') continue;
        if (t.task === 'rescuer' && o === t.rescueTarget) {
          const ol = leadM(o, trk);
          if (ol !== null) {
            const gap = t.info.dir === 'east' ? ol - my : my - ol;
            limit = Math.min(limit, t.s + Math.max(0, gap - 0.25));
          }
          continue;
        }
        if (t.task === 'hauled' && o.task === 'service') continue; // followers are behind
        const occ = occupancy(o, trk);
        if (!occ) continue;
        let gap: number;
        if (sgn > 0) { if (occ[0] < my - 1) continue; gap = occ[0] - my; }
        else { if (occ[1] > my + 1) continue; gap = my - occ[1]; }
        if (o.info.dir !== t.info.dir && trk !== 'shedRoad') gap -= 8; // opposing (should not happen) — keep well clear
        limit = Math.min(limit, t.s + gap - (trk === 'shedRoad' ? 6 : SEP));
      }
    }
    return { limit, atSignal };
  }
  /** +1 if the train's head moves toward increasing track metres */
  function trackSense(t: Train): number {
    const { leg } = t.route.tAt(Math.min(t.route.total, Math.max(0, t.s)));
    return leg.t1 >= leg.t0 ? 1 : -1;
  }

  function tryAcquireBlock(t: Train) {
    if (!t.needsBlock || t.hasBlock || t.blockDone || t.signalS === null) return;
    const line = t.info.line, ls = lines[line];
    if (ls.blockHolder && ls.blockHolder !== t) { if (!trains.includes(ls.blockHolder)) ls.blockHolder = null; else return; }
    if (now() < ls.holdUntil && !t.ghost) return;
    // only the front-most train wanting the block may take it
    const my = leadM(t, line);
    if (my === null) return;
    for (const o of trains) {
      if (o === t || !o.entered || !o.needsBlock || o.blockDone || o.hasBlock || o.info.line !== line || o.info.dir !== t.info.dir) continue;
      const om = leadM(o, line);
      if (om === null) continue;
      if (t.info.dir === 'east' ? om > my : om < my) return;
    }
    let aspect: string = 'stop';
    try { aspect = ctx.reg.world?.getSignal(line, t.info.dir) ?? 'stop'; } catch { /* stub */ }
    if (aspect === 'failed' && !t.failedOverride && !t.ghost) {
      if (t.s >= t.signalS - 1 && t.v < 0.1) {
        if (t.waitSince < 0) t.waitSince = now();
        if (now() - t.waitSince >= 5) {
          t.failedOverride = true;
          t.caution = true;
          gazette(`Signal failure on the ${ls.L.name}: the ${shortName(t)} is waved past at caution.`, 'warn');
        }
      }
      if (!t.failedOverride) return;
    }
    ls.blockHolder = t;
    t.hasBlock = true;
    emitApproaching(t);
  }

  function checkBlockRelease(t: Train) {
    if (!t.hasBlock) return;
    const line = t.info.line, ls = lines[line];
    const passed = t.stops ? t.stopDone : true;
    if (!passed && t.task !== 'hauled') return;
    const occ = occupancy(t, line);
    const lead = leadM(t, line);
    const beyond = lead === null ? true : t.info.dir === 'east' ? lead > ls.blockM[1] : lead < ls.blockM[0];
    const clear = !occ || occ[1] < ls.blockM[0] || occ[0] > ls.blockM[1];
    if (clear && (beyond || lead === null)) {
      releaseBlock(t);
      t.blockDone = true;
      t.caution = false;
      if (t.stops && t.task === 'service') bus.emit('train:departed', { trainId: t.info.id, line });
    }
  }

  function arrive(t: Train) {
    t.phase = 'dwell';
    t.v = 0;
    t.arrivedAt = now();
    t.stopDone = false;
    const late = Math.max(0, Math.round(now() - t.info.scheduledArr));
    t.info.delayMin = late;
    t.info.doorsOpen = carriesPassengers(t);
    t.alighted = false;
    const ls = lines[t.info.line];
    const base = t.service ? t.service.dwell : 3;
    // dwell discipline: a late train takes a short stop; it waits for committed boarders only when ≤ 3 min late
    // (specials keep their whole booked stop from arrival: events stage the royal party / the circus parade on it)
    // (every stopping service keeps its doors open ≥ 3 sim min: at 1 m per motion-second a 20 m dash takes that long)
    const minDwell = late > 3 && !t.special ? Math.min(base, 3) : base;
    t.dwellUntil = Math.max(now() + minDwell, t.info.scheduledDep);
    if (t.dwellUntil - now() > base + 2 && late <= 0 && !t.special) t.dwellUntil = now() + base + 2;
    // bound for the shed: a short stop, but long enough for everyone aboard to step down
    if (t.shedUrgent) t.dwellUntil = Math.min(t.dwellUntil, now() + (t.info.passengers > 0 ? 2 : 1));
    // hold for committed boarders (anyone already running for a door): up to +4 min on time, +3 when late
    t.dwellHard = t.dwellUntil + (late <= 2 ? 4 : 3);
    t.hissAt = now() + rng.range(0.3, 1);
    t.nextBlow = now() + rng.range(0.5, 2.5);
    t.crossWaitSince = -1;
    t.departAt = -1;
    if (t.service) { t.service.arrivedAt = now(); svcLog.push(t.service); if (svcLog.length > 60) svcLog.shift(); }
    registerDoorOrigins(t);
    registerCageOrigins(t);
    bus.emit('train:arrived', { trainId: t.info.id, line: t.info.line, platform: ls.L.platform as PlatformId, lateMin: late });
    if (!t.ghost) cue('doors', t.info.position, 0.5);
    if (t.info.kind === 'express' || t.special === 'royal' || t.special === 'circus') {
      const nm = shortName(t);
      const when = late >= 3 ? `, ${late} minutes late` : ' on time';
      gazette(`${nm} arrives at Platform ${ls.L.platform}${when}, hauled by “${t.loco?.name ?? '?'}”.`, late >= 10 ? 'warn' : 'info');
    }
  }

  function depart(t: Train) {
    t.phase = 'whistle';
    // the guard's flag, his step up into the van, the driver's whistle: ~1.5 min before the wheels turn
    t.whistleUntil = now() + (t.ghost || t.shedUrgent ? 0.5 : 1.5);
    t.info.doorsOpen = false;
    t.departS = t.s;
    t.departAt = now();
    bus.emit('train:departing', { trainId: t.info.id });
    if (!t.ghost) {
      cue('whistle', t.info.position, 0.9); cue('doors', t.info.position, 0.4);
      // a whistle startles the rooks and the cab horses
      bus.emit('animal:scared', { pos: t.info.position.clone(), radius: 60 });
    }
  }

  function updateDelay(t: Train) {
    if (!t.service || t.stopDone || t.phase === 'dwell' || t.phase === 'whistle') {
      if (t.phase === 'dwell' || t.phase === 'whistle') t.info.delayMin = Math.max(t.info.delayMin, Math.max(0, Math.round(now() - t.info.scheduledDep)));
      return;
    }
    let remaining: number;
    if (!t.entered) remaining = Math.max(0, t.earliestEntry - now()) + lines[t.info.line].approachEst[t.info.dir];
    else if (t.stopS !== null) remaining = Math.max(0, t.stopS - t.s) / Math.max(7, t.v * 0.7 + 3);
    else remaining = 0;
    const d = Math.max(0, Math.round(now() + remaining - t.info.scheduledArr));
    t.info.delayMin = d;
    const sv = t.service;
    if (d >= 10 && !sv.warned && sv.stops) {
      sv.warned = true;
      gazette(`Delays on the ${lines[t.info.line].L.name}: the ${formatSimTime(sv.dep)} ${sv.name} is running ${d} minutes late.`, 'warn');
    }
  }

  /** whole train out of sight (both ends inside a tunnel / off the ground) */
  function outOfSight(t: Train, depth = EXIT_DEPTH): boolean {
    t.route.pointAt(t.s - t.info.length, _v);
    t.route.pointAt(t.s, _v2);
    return tunnels.hidden(_v.x, _v.z, depth) && tunnels.hidden(_v2.x, _v2.z, depth);
  }
  const exitCheck = (t: Train) => t.canExit && outOfSight(t);

  function onExit(t: Train) {
    if (t.task === 'hauled' || (t.dead && t.task === 'release')) {
      lines[t.info.line].lockedBy = lines[t.info.line].lockedBy === t ? null : lines[t.info.line].lockedBy;
      convertToShed(t, true);
      return;
    }
    if (t.task === 'service' && t.shedPending) { convertToShed(t, false); return; }
    removeTrain(t);
  }

  function moveTrain(t: Train, dtm: number) {
    const { limit, atSignal } = limitFor(t);
    const vmax = vmaxFor(t);
    const prevV = t.v;
    const boost = leavingFar(t) ? (t.shedPending ? 3 : 2.4) : (t.task === 'shed' || t.task === 'release') && !t.dead ? 2 : t.shedPending && t.stopDone ? 1.8 : 1;
    t.v = stepV(t.v, limit - t.s, vmax, boost * t.accel * (0.7 + 0.3 * t.info.condition.boiler), t.brake * (0.75 + 0.25 * t.info.condition.brakes), dtm);
    let ds = t.v * dtm;
    if (t.s + ds > limit) { ds = Math.max(0, limit - t.s); t.v = 0; }
    t.s += ds;
    if (Number.isFinite(limit) && limit - t.s < 0.45 && t.v < 0.35) { t.s = Math.max(t.s, limit); t.v = 0; }
    t.lastV = prevV;
    for (const c of t.cars) c.spin += ds * (c.flipped ? -1 : 1);
    if (ds > 0 && !t.dead && !t.ghost) {
      const c = t.info.condition;
      const work = t.v > prevV + 1e-4 ? 1 : 0.3;
      c.coal = Math.max(0, c.coal - (ds / 1000) * 0.01 * work);
      c.water = Math.max(0, c.water - (ds / 1000) * 0.016 * work);
    }
    t.chuffAcc += ds;
    if (t.v < 0.05) t.stuckFor += clock.dtSim; else t.stuckFor = 0;
    bridgeCues(t);

    // state reporting
    if (t.task === 'service') {
      if (atSignal && t.v < 0.2) t.info.state = 'waitingSignal';
      else if (t.stops && !t.stopDone && t.stopS !== null) {
        const bd = (t.v * t.v) / (2 * t.brake) + 10;
        t.info.state = t.stopS - t.s < bd * 1.3 ? 'braking' : 'approaching';
        if (!t.brakeCue && t.stopS - t.s < 70 && t.v > 4 && !t.ghost) { t.brakeCue = true; cue('brake', t.info.position, 0.5); }
      } else if (t.stopDone) t.info.state = t.hasBlock ? 'departing' : 'running';
      else t.info.state = t.hasBlock || t.blockDone ? 'running' : 'approaching';
    } else if (t.task === 'rescuer') t.info.state = 'running';

    // ghost passes the platform: one spooky moan
    if (t.ghost && !t.canExit && t.s > t.centreS) { t.canExit = true; cue('spooky', t.info.position, 0.7); }
    if (!t.stops && t.task === 'service' && t.s > t.centreS) t.canExit = true;

    // arrivals at stop points
    if (t.stopS !== null && !t.stopDone && t.s >= t.stopS - 0.05 && t.v < 0.05) {
      if (t.task === 'service') arrive(t);
      else if (t.task === 'shed') { t.stopDone = true; arriveInShed(t); }
    }
    if (t.task === 'rescuer' && t.rescueTarget) {
      const my = leadM(t, t.info.line), ol = leadM(t.rescueTarget, t.info.line);
      const gap = my !== null && ol !== null ? (t.info.dir === 'east' ? ol - my : my - ol) : 0;
      if (gap < 0.6 && t.v < 0.05) {
        t.phase = 'couple'; t.pauseUntil = now() + 1; cue('clank', t.info.position, 0.8);
        t.route.pointAt(t.s, _v);
        smoke.emit(_v.x, 1.2, _v.z, 0, 1.0, 0, 0.45, PUFF_STEAM, 1.4);
      }
    }
  }

  /** wheels drum over the river bridges and the Wyke arch */
  function bridgeCues(t: Train) {
    if (!bridges.length || t.ghost) return;
    const trk = headTrack(t);
    const m = leadM(t, trk);
    if (m === null) { t.prevLead = NaN; return; }
    if (!Number.isNaN(t.prevLead)) {
      for (const b of bridges) {
        if (b.line !== trk) continue;
        const bm = (b.lineT ?? 0) * layout.lines[b.line].length;
        if ((t.prevLead - bm) * (m - bm) <= 0 && t.prevLead !== m) {
          const vol = Math.min(1, 0.4 + t.v / 30) * (b.kind === 'underbridge' ? 0.7 : 1);
          cue('wheels', b.center, vol);
          cue('clank', b.center, 0.35 * vol);
        }
      }
    }
    t.prevLead = m;
  }

  function updateTrain(t: Train, dtm: number) {
    const tNow = now();
    switch (t.phase) {
      case 'queued':
        if (t.task === 'rescuer' && (!t.rescueTarget || !trains.includes(t.rescueTarget) || t.rescueTarget.phase !== 'broken')) {
          removeTrain(t);
          return;
        }
        locoPoint(t, t.info.position);
        if (t.task === 'service') updateDelay(t);
        return;
      case 'run':
        moveTrain(t, dtm);
        // ordered to the shed after it had already left P1: still east of the switch → straight into the siding
        if (t.shedPending && t.task === 'service' && t.stopDone && canDivert(t)) {
          const owed = t.hasBlock && t.stops; // 'train:departed' not sent yet (it goes out when the block clears)
          if (divertToShed(t) && owed) bus.emit('train:departed', { trainId: t.info.id, line: t.info.line });
        }
        break;
      case 'hold':
        if (tNow >= t.pauseUntil) t.phase = 'run';
        break;
      case 'dwell': {
        t.info.state = 'dwelling';
        if (tNow >= t.hissAt) {
          t.hissAt = tNow + rng.range(0.8, 1.8);
          if (!t.ghost && rng.chance(0.6)) cue('hiss', t.info.position, 0.35);
        }
        // eastbound coast trains ask for the LC1 gates before they start
        if (t.crossing && !t.crossing.done && tNow >= t.dwellUntil - (t.shedPending ? 5 : 2) && t.s < t.crossing.crossS) requestLC(t);
        if (tNow >= t.dwellUntil) {
          let pending = 0, eta = 0;
          try { pending = ctx.reg.people?.boardingPending(t.info.id) ?? 0; } catch { pending = 0; }
          try { eta = pending > 0 ? (ctx.reg.people?.boardingEta?.(t.info.id) ?? 2) : 0; } catch { eta = 2; }
          const waitBoarders = pending > 0 && eta <= 5 && tNow < t.dwellHard;
          let gates = true;
          if (t.crossing && !t.crossing.done && t.s < t.crossing.crossS && t.crossing.crossS - t.s < 420) {
            gates = t.crossing.granted || requestLC(t);
            if (!gates) { if (t.crossWaitSince < 0) t.crossWaitSince = tNow; if (tNow - t.crossWaitSince > 1.5) gates = true; }
          }
          if (!waitBoarders && gates) depart(t);
        }
        break;
      }
      case 'whistle':
        t.info.state = 'dwelling';
        if (tNow >= t.whistleUntil) {
          t.phase = 'run';
          t.stopDone = true;
          t.canExit = true;
          t.cockUntil = realClock + 3.5;
          if (t.service) { t.service.state = 'departed'; t.service.depActual = tNow; }
          t.info.delayMin = Math.max(0, Math.round(tNow - t.info.scheduledDep));
          if (t.shedPending && canDivert(t)) {
            bus.emit('train:departed', { trainId: t.info.id, line: t.info.line });
            if (!divertToShed(t)) { /* too long for the siding: runs off the map and returns as a light engine */ }
            else t.hasBlock = t.hasBlock; // still clearing the coast block
          }
        }
        break;
      case 'shed':
        t.info.state = 'inShed';
        if (t.removeRescuerAt > 0 && tNow >= t.removeRescuerAt && t.rescuerCar) splitPilot(t);
        if (tNow - t.shedAt > 360) { t.phase = 'releaseWait'; } // safety: never strand an engine forever
        break;
      case 'releaseWait': {
        t.info.state = 'fromShed';
        const pilotOut = trains.some((o) => o !== t && o.entered && (o.task === 'release' || o.task === 'shed') && o.route.legs.some((l) => l.track === 'shedRoad') && occupancy(o, 'shedRoad'));
        if (!pilotOut && !t.rescuerCar) startRelease(t);
        break;
      }
      case 'couple':
        if (tNow >= t.pauseUntil) coupleRescue(t);
        return;
      case 'broken': {
        t.info.state = 'broken';
        t.v = Math.max(0, t.v - 2.2 * dtm);
        const ds = t.v * dtm;
        t.s += ds;
        for (const c of t.cars) c.spin += ds * (c.flipped ? -1 : 1);
        if (!t.rescueRequested && tNow - t.brokenAt > 40) api.rescue(t.info.id);
        break;
      }
    }
    if (t.doorOff.length && t.departAt >= 0 && (t.s - t.departS > 6 || now() - t.departAt > 5)) clearDoorOrigins(t);
    if (t.phase === 'run' && (t.task === 'service')) tryAcquireBlock(t);
    checkBlockRelease(t);
    if (t.task === 'service') updateDelay(t);
    // live position
    locoPoint(t, t.info.position);
    t.info.speed = t.v;
    t.info.headT = t.route.tAt(Math.max(0, t.s)).t;
    if (t.s > t.route.total + 1500) {
      // should never happen — a train that ran far past the end of its route is quietly retired (inside a tunnel)
      console.warn('[trains] runaway train removed', t.info.id, t.task);
      if (t.task === 'hauled') convertToShed(t, true); else removeTrain(t);
    } else if ((t.phase === 'run' || t.phase === 'hold') && exitCheck(t)) onExit(t);
    else if (t.stuckFor > 300 && t.phase === 'run' && t.task !== 'shed' && outOfSight(t, 0)) {
      gazette(`The ${shortName(t)} is quietly withdrawn after a very long delay.`, 'warn');
      if (t.service && t.service.state !== 'departed') t.service.state = 'cancelled';
      removeTrain(t);
    }
  }

  function locoIndex(t: Train): number {
    for (let i = 0; i < t.cars.length; i++) if (t.cars[i].isLoco && t.cars[i] !== t.rescuerCar) return i;
    return 0;
  }
  function locoPoint(t: Train, out: THREE.Vector3) {
    const i = locoIndex(t);
    const c = t.cars[i];
    if (!c) return out;
    const front = c.flipped ? t.s - c.offset - c.len : t.s - c.offset;
    return t.route.pointAt(front, out);
  }

  // ───────────────────────── doors ─────────────────────────
  /** platform-edge door points for the train standing with its head at route distance `s` (off-platform doors dropped) */
  function doorPoints(t: Train, s: number, _predict: boolean): THREE.Vector3[] {
    const L = lines[t.info.line].L;
    const plat = layout.platforms[L.platform];
    const inset = 1.0 / L.length;
    const out: THREE.Vector3[] = [];
    for (const c of t.cars) {
      if (!isPassengerCar(c.plan.type)) continue;
      for (const dx of c.spec.doors) {
        const fromFront = c.flipped ? c.len / 2 + dx : c.len / 2 - dx;
        const { leg, t: ct } = t.route.tAt(s - c.offset - fromFront);
        if (leg.track !== t.info.line) continue;
        if (ct < L.platformStartT + inset || ct > L.platformEndT - inset) continue; // overhangs the platform end
        out.push(plat.edgePointAt(ct));
      }
    }
    return out;
  }

  // ───────────────────────── visuals ─────────────────────────
  let placeQueued = false;
  function placeAll() {
    placeQueued = false;
    vis.beginFrame();
    for (const t of trains) {
      if (!t.entered) continue;
      vis.placeTrain(t.cars, t.route, t.s, t.v, t.ghost);
    }
    for (const g of gallery) vis.placeTrain(g.cars, g.route, g.s, 0, false);
    vis.endFrame();
  }

  let crewDt = 0;
  function drawCrews() {
    const dt = crewDt; crewDt = 0;
    crewR.begin();
    const n = night();
    for (const t of trains) {
      if (!t.entered || t.ghost) continue;
      const li = locoIndex(t);
      const loco = t.cars[li];
      const moving = t.v > 0.3;
      const standing = t.phase === 'dwell' || t.phase === 'whistle';
      const nearStop = t.stopS !== null && !t.stopDone && t.stopS - t.s < 90;
      if (loco && loco.isLoco && !t.dead) {
        crewR.drawLoco(loco, t.crew, {
          speed: t.v,
          working: moving && t.v >= t.lastV - 1e-4 && t.phase === 'run',
          watching: nearStop || t.info.state === 'waitingSignal' || (t.task !== 'service' && t.v < 6),
          standing,
          lookBack: t.phase === 'dwell' && now() >= t.dwellUntil - 0.8,
          whistle: t.phase === 'whistle',
        }, dt);
      }
      if (t.rescuerCar && t.rescuerCar.isLoco) crewR.drawLoco(t.rescuerCar, t.crew, { speed: t.v, working: moving, watching: true, standing: false, lookBack: false, whistle: false }, 0);
      // the guard: out on the platform while the train stands (unless the people system has him walking the
      // platform already), flag up before the right-away; then leaning from the van as the train draws out
      if (t.task === 'service' && t.stops) {
        const gi = findGuardCar(t);
        const g = t.cars[gi];
        if (g) {
          const side = platformSideOf(t, g);
          const standing = t.phase === 'dwell' || t.phase === 'whistle';
          const own = standing && !peopleGuard(t, g);
          const out = own && t.phase === 'dwell' && now() - t.arrivedAt > 0.15 && g.group.visible && onPlatform(t, g);
          const flag = own && t.phase === 'dwell' && now() >= t.dwellUntil - 0.7;
          const lean = t.stopDone && t.phase === 'run' && t.v < 9 && t.departAt >= 0 && now() - t.departAt < 12 && onPlatform(t, g);
          crewR.drawGuard(g, t.crew, side, g.flipped ? -1 : 1, 1.0, out, flag, n, dt, lean);
        }
      }
    }
    crewR.end();
  }
  /** does the people system already show this train's guard on the platform? (checked about once a second) */
  const guardSeen = new Map<string, { at: number; has: boolean }>();
  function peopleGuard(t: Train, car: Car): boolean {
    const c = guardSeen.get(t.info.id);
    if (c && realClock - c.at < 1) return c.has;
    let has = false;
    try {
      const P = ctx.reg.people;
      const gp = car.group.position;
      has = !!P && P.list().some((p) => p.role === 'guard' && (p.position.x - gp.x) ** 2 + (p.position.z - gp.z) ** 2 < 40 * 40);
    } catch { has = false; }
    guardSeen.set(t.info.id, { at: realClock, has });
    if (guardSeen.size > 40) for (const k of guardSeen.keys()) { if (!byId(k)) guardSeen.delete(k); }
    return has;
  }
  function findGuardCar(t: Train): number {
    for (let i = t.cars.length - 1; i >= 0; i--) if (t.cars[i].plan.type === 'guard') return i;
    for (let i = t.cars.length - 1; i >= 0; i--) if (isPassengerCar(t.cars[i].plan.type)) return i;
    return -1;
  }
  /** car-local z sign of the platform side */
  function platformSideOf(t: Train, c: Car): number {
    const L = lines[t.info.line].L;
    const plat = layout.platforms[L.platform];
    const m = c.group.matrix.elements;
    // car-local +z axis in world = third column
    const zx = m[8], zz = m[10];
    return -(zx * plat.inward.x + zz * plat.inward.z) >= 0 ? -1 : 1;
  }
  function onPlatform(t: Train, c: Car): boolean {
    const L = lines[t.info.line].L;
    const ct = L.nearestT(c.group.position);
    return ct > L.platformStartT + 2 / L.length && ct < L.platformEndT - 2 / L.length;
  }

  function emitSmoke(t: Train, dt: number, n: number) {
    if (!t.entered) return;
    const vis0 = t.cars.some((c) => c.group.visible);
    if (!vis0) { t.chuffAcc = 0; return; }
    for (const c of t.cars) {
      if (!c.working || !c.spec.chimney || t.phase === 'broken' || (t.dead && c !== t.rescuerCar)) continue;
      if (!c.group.visible) continue;
      const front = t.s - c.offset;
      const along = c.flipped ? c.len / 2 + c.spec.chimney.x : c.len / 2 - c.spec.chimney.x;
      t.route.pointAt(front - along, _v);
      t.route.tangentAt(Math.max(0, Math.min(t.route.total, front - along)), _tan);
      _v.y += c.spec.chimney.y;
      const accel = t.v - t.lastV;
      const working = accel > 0.0005 || (Math.abs(accel) <= 0.0005 && t.v > 1 && t.phase === 'run');
      const drvR = c.spec.loco === 'express' ? 1.0 : 0.7;
      const chuffLen = (Math.PI * 2 * drvR) / 4;
      t.puffClock -= dt;
      t.sparkClock -= dt;
      const kind = t.ghost ? PUFF_GHOST : PUFF_SMOKE;
      if (t.v > 0.3 && t.phase === 'run') {
        const chuff = t.chuffAcc >= chuffLen;
        if ((chuff && t.puffClock <= 0) || (working && t.puffClock < -0.16)) {
          t.chuffAcc = t.chuffAcc % chuffLen;
          t.puffClock = working ? 0.085 : 0.4;
          const size = working ? 0.62 + Math.max(0, 0.5 * (1 - t.v / 18)) : 0.32;
          const vx = _tan.x * t.v * 0.15, vz = _tan.z * t.v * 0.15;
          smoke.emit(_v.x, _v.y + 0.1, _v.z, vx, working ? 3.4 : 1.6, vz, size, working ? kind : (t.ghost ? PUFF_GHOST : PUFF_STEAM), working ? 3.0 : 1.8);
          if (n > 0.45 && working && t.v < 20 && t.sparkClock <= 0 && !t.ghost) {
            t.sparkClock = 0.08;
            for (let k = 0; k < 5; k++) smoke.spark(_v.x, _v.y + 0.2, _v.z, vx, 0, vz);
          }
        }
      } else if (t.puffClock <= 0) {
        // idling: lazy wisps from the chimney
        t.puffClock = 0.45 + Math.random() * 0.3;
        smoke.emit(_v.x, _v.y + 0.1, _v.z, 0, 1.1, 0, 0.3, t.ghost ? PUFF_GHOST : PUFF_SMOKE, 2.4);
        t.chuffAcc = 0;
      }
      // cylinder drain cocks on starting / hissing while dwelling
      if (c.spec.cocks && !t.ghost && (realClock < t.cockUntil || (t.phase === 'dwell' && Math.random() < dt * 0.5))) {
        const cf = c.flipped ? c.len / 2 + c.spec.cocks.x : c.len / 2 - c.spec.cocks.x;
        t.route.pointAt(front - cf, _v2);
        if (Math.random() < dt * 8) {
          const side = Math.random() < 0.5 ? 1 : -1;
          const sx = -_tan.z * side, sz = _tan.x * side;
          smoke.emit(_v2.x + sx * 1.1, _v2.y + c.spec.cocks.y, _v2.z + sz * 1.1, sx * 2.2, 0.5, sz * 2.2, 0.32, PUFF_STEAM, 1.1);
        }
      }
      // occasional boiler blowdown while standing: a roaring white jet low off the firebox side
      if (!t.ghost && c.isLoco && c !== t.rescuerCar && (t.phase === 'dwell' || t.phase === 'shed' || t.phase === 'releaseWait')) {
        if (now() >= t.nextBlow && t.blowUntil <= realClock) {
          t.blowUntil = realClock + 1.6;
          t.nextBlow = now() + rng.range(t.phase === 'shed' ? 6 : 3, t.phase === 'shed' ? 20 : 9);
          cue('hiss', t.info.position, 0.8);
        }
        if (realClock < t.blowUntil && Math.random() < dt * 30) {
          const fb = c.flipped ? c.len / 2 - 1.5 : c.len / 2 + 1.5; // firebox, behind the drivers
          t.route.pointAt(front - fb, _v2);
          const side = platformSideAway(t);
          const sx = -_tan.z * side, sz = _tan.x * side;
          smoke.emit(_v2.x + sx * 1.4, 0.7, _v2.z + sz * 1.4, sx * 6 + (Math.random() - 0.5), 0.6 + Math.random() * 0.8, sz * 6 + (Math.random() - 0.5), 0.35, PUFF_STEAM, 1.3);
        }
      }
    }
  }
  /** blow down on the side away from the platform (never over the passengers) */
  function platformSideAway(t: Train): number {
    const L = lines[t.info.line]?.L;
    if (!L || t.task !== 'service') return 1;
    // tangent × up points to +side; platformSide is relative to eastbound travel
    const dirSign = t.info.dir === 'east' ? 1 : -1;
    return -L.platformSide * dirSign;
  }

  function updateHeadlamps(n: number) {
    lamps.begin(n);
    if (n > 0.2) {
      const cands = trains.filter((t) => t.entered && !t.ghost && t.cars.length && t.cars[0].group.visible && t.phase !== 'shed');
      const f = ctx.view?.focus;
      const d2 = (t: Train) => f ? (t.info.position.x - f.x) ** 2 + (t.info.position.z - f.z) ** 2 : t.info.position.lengthSq();
      cands.sort((a, b) => d2(a) - d2(b));
      for (const t of cands.slice(0, 6)) {
        const lead = t.cars[0];
        const lamp = lead.spec.lamp;
        t.route.pointAt(t.s, _v);
        t.route.tangentAt(Math.max(0, Math.min(t.route.total, t.s)), _tan);
        _v.y += (lamp ? lamp.y : 1.6);
        lamps.add(t.info.id, _v, _tan);
      }
    }
    lamps.end();
  }

  // ───────────────────────── API ─────────────────────────
  const byId = (id: string) => trains.find((t) => t.info.id === id);

  function etaOf(t: Train, line: LineId, tt: number): number | null {
    const L = layout.lines[line];
    const target = tt * L.length;
    const sgn = t.info.dir === 'east' ? 1 : -1;
    const vc = Math.max(8, Math.min(t.vBase, 22));
    if (t.entered) {
      const m = leadM(t, line);
      if (m === null) return null;
      const dist = (target - m) * sgn;
      if (dist < -0.5) return null;
      let sec = dist / Math.max(4, (t.v + vc) / 2);
      if ((t.phase === 'dwell' || t.phase === 'whistle') && dist > 1) sec += Math.max(0, t.dwellUntil - now());
      else if (t.stops && !t.stopDone && t.stopS !== null && t.s + dist > t.stopS + 1) sec += (t.service?.dwell ?? 3);
      return sec;
    }
    if (t.phase !== 'queued') return null;
    const entryM = trackPos(t.route, t.s).m;
    const dist = (target - entryM) * sgn;
    if (dist < 0 || headTrack(t) !== line) return null;
    return Math.max(0, t.earliestEntry - now()) + dist / vc;
  }

  const api: TrainsAPI = {
    predictedDoors(id) {
      const t = byId(id);
      if (!t || !t.stops || t.stopS === null || t.task !== 'service') return [];
      if (t.phase === 'dwell' || t.phase === 'whistle') return doorPoints(t, t.s, false);
      if (t.stopDone) return [];
      return doorPoints(t, t.stopS, true);
    },
    eta(line, tt, horizonS = 180) {
      let best: { trainId: string | null; seconds: number; dir: Dir } | null = null;
      for (const t of trains) {
        if (t.info.line !== line || t.task === 'shed' || (t.task === 'release' && headTrack(t) !== line)) continue;
        const s = etaOf(t, line, tt);
        if (s === null || s > horizonS) continue;
        if (!best || s < best.seconds) best = { trainId: t.info.id, seconds: s, dir: t.info.dir };
      }
      // planned services not yet spawned
      const L = layout.lines[line];
      for (const sv of services) {
        if (sv.line !== line || sv.state !== 'planned') continue;
        const entryIn = dueOf(sv) - now();
        if (entryIn > horizonS) break;
        const ls = lines[line];
        const entryM = (sv.dir === 'east' ? ls.entryS.east : L.length - ls.entryS.west);
        const dist = (tt * L.length - entryM) * (sv.dir === 'east' ? 1 : -1);
        if (dist < 0) continue;
        const s = Math.max(0, entryIn) + dist / 18;
        if (s <= horizonS && (!best || s < best.seconds)) best = { trainId: null, seconds: s, dir: sv.dir };
      }
      return best;
    },
    occupied(line, t0, t1) {
      const L = layout.lines[line];
      const a0 = Math.min(t0, t1) * L.length, a1 = Math.max(t0, t1) * L.length;
      for (const t of trains) {
        const occ = occupancy(t, line);
        if (occ && occ[1] >= a0 && occ[0] <= a1) return true;
      }
      return false;
    },
    nextGap(line, minutes) {
      return gapIn(busyWindows(line, true), now(), minutes);
    },
    expectedDeparture(id) {
      const t = byId(id);
      if (!t || !t.stops || t.task !== 'service') return null;
      if (t.phase === 'dwell') return Math.max(now(), t.dwellUntil);
      if (t.phase === 'whistle' || t.stopDone) return null;
      return t.info.scheduledDep + t.info.delayMin;
    },
    list() {
      if (!listCache) listCache = trains.map((t) => t.info);
      return listCache;
    },
    get(id) { return byId(id)?.info; },

    timetable(count = 8) {
      const tNow = now();
      const rows = services.filter((s) => s.stops && s.kind !== 'freight' && (s.state === 'planned' || s.state === 'active' || (s.state === 'departed' && tNow - s.depActual < 3) || (s.state === 'cancelled' && tNow - s.dep < 20)));
      rows.sort((a, b) => a.dep - b.dep);
      const out: Departure[] = [];
      for (const s of rows.slice(0, count)) {
        const t = s.trainId ? byId(s.trainId) : undefined;
        let status: string;
        const d = serviceDelay(s);
        if (s.state === 'cancelled') status = 'Cancelled';
        else if (s.state === 'departed') status = 'Departed';
        else if (t && t.shedUrgent) status = 'Not in service';
        else if (t && (t.phase === 'dwell' || t.phase === 'whistle')) status = 'Boarding';
        else if (t && t.entered && t.phase !== 'broken') status = d >= 3 ? `Delayed ${d} min` : 'Approaching';
        else status = d >= 3 ? `Delayed ${d} min` : 'On time';
        const L = layout.lines[s.line];
        const len = t ? t.info.length : s.estLen;
        const expected = t && t.phase === 'dwell' ? Math.max(tNow, t.dwellUntil) : s.dep + d;
        out.push({
          trainId: s.trainId, time: s.dep, line: s.line, platform: L.platform,
          destination: s.dest, name: s.name, status,
          dir: s.dir, expected, trainLength: len, stopHeadT: t && t.stopS !== null ? t.route.tAt(t.stopS).t : stopTFor(L, s.dir, len),
          // small consists (the Night Mail's one coach) can fill: tell the trip planners how many seats are left
          seats: t ? (t.info.capacity <= 60 ? Math.max(0, t.info.capacity - Math.round(t.info.passengers * (t.alighted ? 1 : 0.6))) : undefined) : s.kind === 'mail' ? 22 : undefined,
        });
      }
      return out;
    },

    spawnSpecial(spec: SpecialTrainSpec) {
      const special = spec.special;
      if (special === 'rescue') {
        const broken = trains.find((t) => t.phase === 'broken' && !t.rescueRequested);
        if (broken) { api.rescue(broken.info.id); const r = trains.find((x) => x.rescueTarget === broken); return r ? r.info.id : broken.info.id; }
      }
      const ghost = spec.ghost ?? special === 'ghost';
      let line: LineId = spec.line ?? (rng.chance(0.5) ? 'coast' : 'highland');
      let dir: Dir = spec.dir ?? (rng.chance(0.5) ? 'east' : 'west');
      let ghostEntry = now();
      if (ghost) {
        // the Phantom takes whichever line is quiet soonest (preferring the one events asked for)
        // it needs the line to itself for ~GHOST_OCC min: wait only for trains already about, and make planned ones
        // stand aside (held briefly, or withdrawn — "the signalman reports something on the line")
        // (only trains already ON the line count: queued ones are kept in their tunnels by ghostReserved())
        let best: { line: LineId; dir: Dir; start: number } | null = null;
        for (const l of ['coast', 'highland'] as LineId[]) {
          for (const d of ['east', 'west'] as Dir[]) {
            const g = gapIn(ghostBlockers(l, d), now(), GHOST_OCC);
            const bias = l === line && d === dir ? -3 : 0;
            if (!best || g.start + bias < best.start) best = { line: l, dir: d, start: g.start + bias };
          }
        }
        if (best) {
          line = best.line; dir = best.dir;
          ghostEntry = Math.max(now(), gapIn(ghostBlockers(line, dir), now(), GHOST_OCC).start);
          // events asks for it at the platform by `arriveBy` (the haunting needs a little build-up)
          if (spec.arriveBy !== undefined) ghostEntry = Math.max(ghostEntry, spec.arriveBy - ghostApproach(line, dir));
          const w0 = ghostEntry - 2, w1 = ghostEntry + GHOST_OCC;
          for (const sv of services) {
            if (sv.line !== line || sv.state !== 'planned') continue;
            const a = dueOf(sv) - 2, b = sv.dep + sv.hold + EXIT_EST + 2;
            if (b < w0 || a > w1) continue;
            const shift = w1 - a;
            if (shift <= 10) sv.hold += shift;
            else cancelService(sv, '— the signalman reports "something on the line"');
          }
        }
      }
      let loco: Loco;
      if (ghost) loco = { name: 'The Phantom', type: 'loco_express', home: line, busy: true, condition: { boiler: 1, brakes: 1, wheels: 1, coal: 1, water: 1 } };
      else loco = takeLoco(pool, rng, line, special === 'rescue' ? 'loco_tank' : 'loco_express');
      let plans: CarPlan[];
      let livery: LiveryId = line;
      if (spec.cars && spec.cars.length) {
        const liv: LiveryId = special === 'royal' ? 'royal' : special === 'circus' ? 'circus' : line;
        plans = spec.cars.map((type) => ({ type, livery: type.startsWith('wagon') ? 'freight' as LiveryId : liv, variant: rng.int(0, 3) }));
        if (!spec.cars[0].startsWith('loco')) plans = [...locoCars(loco, liv), ...plans];
        livery = liv;
      } else if (special === 'rescue') {
        plans = locoCars(loco, line);
      } else {
        const sc = specialConsist(special, line, rng, loco);
        plans = sc.cars; livery = sc.livery;
      }
      const stops = spec.stops ?? (special === 'royal' || special === 'circus' || (!ghost && special !== 'freight' && special !== 'rescue'));
      if (stops && line === 'highland') plans = trimToLength(plans, Math.max(HIGHLAND_MAX_LEN, plans.slice(0, 3).reduce((a, p) => a + SPECS[p.type].len, 0)));
      const dwell = spec.dwellMin ?? (special === 'royal' ? 12 : special === 'circus' ? 8 : 3);
      const name = spec.name ?? (special === 'royal' ? 'The Royal Train' : special === 'circus' ? 'Signor Fandango’s Travelling Circus'
        : ghost ? 'The Midnight Phantom' : special === 'freight' ? `Special Goods for ${layout.lines[line].ends[dir]}` : special === 'rescue' ? 'Light Engine' : `Special to ${layout.lines[line].ends[dir]}`);
      let sv: Service | null = null;
      let entry = now();
      if (stops) {
        const appr = lines[line].approachEst[dir];
        entry = slotSpecial(line, dir, Math.max(now() + appr, spec.arriveBy ?? 0), dwell, name);
        sv = addService(line, dir, 'express', entry + appr, true, dwell, special, name);
        sv.state = 'active';
        services.sort((a, b) => a.arr - b.arr);
      }
      const t = makeTrain({
        name: ghost ? name : `${name} · ${loco.name}`, kind: 'special', line, dir, loco: ghost ? null : loco, plans,
        task: 'service', stops, ghost, special, service: sv, priority: 1, livery,
      });
      if (ghost) { t.loco = null; t.info.name = name; t.earliestEntry = ghostEntry; }
      else t.earliestEntry = entry;
      if (sv) { sv.trainId = t.info.id; sv.estLen = t.info.length; t.info.scheduledArr = sv.arr; t.info.scheduledDep = sv.dep; }
      else { t.info.scheduledArr = now(); t.info.scheduledDep = now(); }
      if (ghost || special === 'freight' || special === 'rescue') t.info.passengers = 0;
      if (special === 'royal') t.info.passengers = Math.min(t.info.capacity, 6);
      emitApproaching(t);
      return t.info.id;
    },

    delayLine(line, minutes, reason) {
      // only the next train each way is affected, and by the larger delay (not the sum)
      const tNow = now();
      for (const dir of ['east', 'west'] as Dir[]) {
        const q = trains.find((t) => !t.entered && t.phase === 'queued' && t.task === 'service' && t.info.line === line && t.info.dir === dir);
        if (q) {
          q.earliestEntry = Math.max(q.earliestEntry, q.info.scheduledArr + minutes - lines[line].approachEst[dir], tNow);
          continue;
        }
        const sv = services.find((s) => s.line === line && s.dir === dir && s.state === 'planned' && s.arr - tNow < 180);
        if (sv) sv.hold = Math.max(sv.hold, minutes);
      }
      const ls = lines[line];
      ls.holdUntil = Math.max(ls.holdUntil, tNow + Math.min(minutes, 10) * 0.5);
      gazette(`${ls.L.name}: ${reason} — services delayed by up to ${Math.round(minutes)} minutes.`, 'warn');
    },

    holdAtSignal(line, holdUntilSimMin) {
      const ls = lines[line];
      ls.holdUntil = Math.max(ls.holdUntil, holdUntilSimMin);
    },

    releaseHold(line) {
      lines[line].holdUntil = 0;
    },

    requestShed(id, opts) {
      const t = byId(id);
      if (!t) return false;
      if (t.task !== 'service' || t.phase === 'broken' || t.ghost) return false;
      if (!t.entered && t.phase === 'queued') { convertToShed(t, false); return true; }
      t.shedPending = true;
      // Two consistent behaviours:
      //  · ordered by the user (urgent): the train runs NOT IN SERVICE from now on — no boarding, the board says so,
      //    people leave it alone — and makes an abbreviated stop (everyone out, doors shut within the minute);
      //  · retired by the shed foreman after arrival: it finishes its booked call (boarding as usual) and goes to the
      //    shed after its duty (off the map, back as a light engine).
      if (opts?.urgent) {
        t.shedUrgent = true;
        t.info.inService = false;
        if (t.phase === 'dwell') { t.dwellUntil = Math.min(t.dwellUntil, Math.max(now(), t.arrivedAt + 1.5)); t.dwellHard = Math.min(t.dwellHard, t.dwellUntil + 2); }
      }
      // eastbound coast: ask for the LC1 gates now so the keeper has them shut by the time the doors close
      if (t.crossing && !t.crossing.done && !t.crossing.granted && t.s < t.crossing.crossS && (t.phase === 'dwell' || t.phase === 'run')) requestLC(t);
      return true;
    },

    releaseFromShed(id) {
      const t = byId(id);
      if (!t || t.phase !== 'shed') return;
      t.phase = 'releaseWait';
      t.info.state = 'fromShed';
      // (maintenance emits 'train:repaired' when it releases an engine)
    },

    breakdown(id) {
      const t = byId(id);
      if (!t || t.phase === 'broken' || t.phase === 'shed' || t.task === 'rescuer' || t.task === 'hauled' || t.ghost) return;
      if (t.phase === 'couple') return;
      if (t.entered && outOfSight(t, 0) && t.task !== 'release') {
        // failed out of sight (entering or leaving through a tunnel): handled entirely off-stage
        hideTrain(t);
        if (t.task === 'shed' && shedOwner === t) shedOwner = null;
      }
      t.prevPhase = t.phase;
      t.phase = 'broken';
      t.brokenAt = now();
      t.info.state = 'broken';
      t.info.doorsOpen = false;
      clearDoorOrigins(t);
      t.rescueRequested = false;
      bus.emit('train:breakdown', { trainId: id, pos: t.info.position.clone() });
      if (t.entered) cue('clank', t.info.position, 0.7);
    },

    rescue(id) {
      const t = byId(id);
      if (!t || t.phase !== 'broken' || t.rescueRequested) return;
      t.rescueRequested = true;
      t.dead = true;
      if (!t.entered) { t.phase = 'queued'; convertToShed(t, true); return; }
      if (t.task === 'shed' || t.task === 'release') {
        // on the shed road / siding: nudged on by the shed pilot at walking pace
        t.phase = t.prevPhase === 'broken' ? 'run' : t.prevPhase;
        if (t.phase === 'dwell' || t.phase === 'whistle') t.phase = 'run';
        t.info.state = 'rescued';
        return;
      }
      spawnRescuer(t);
    },

    getDoors(id) {
      const t = byId(id);
      if (!t || (t.phase !== 'dwell' && t.phase !== 'whistle') || !t.entered) return [];
      return doorPoints(t, t.s, false);
    },

    takeAlighting(id) {
      const t = byId(id);
      if (!t || t.alighted || (t.phase !== 'dwell' && t.phase !== 'whistle')) return 0;
      t.alighted = true;
      const frac = t.shedUrgent ? 1 : t.special === 'royal' ? 0.95 : rng.range(0.3, 0.65);
      const n = Math.round(t.info.passengers * frac);
      t.info.passengers -= n;
      return n;
    },

    addPassengers(id, n) {
      const t = byId(id);
      if (!t || n <= 0 || t.shedUrgent || !carriesPassengers(t) || !t.info.doorsOpen) return 0;
      const acc = Math.max(0, Math.min(Math.floor(n), t.info.capacity - t.info.passengers));
      t.info.passengers += acc;
      return acc;
    },

    raycast(r) {
      const objs: THREE.Object3D[] = [];
      for (const t of trains) if (t.entered) for (const c of t.cars) if (c.group.visible) objs.push(c.group);
      if (!objs.length) return null;
      const hits = r.intersectObjects(objs, true);
      for (const h of hits) {
        let o: THREE.Object3D | null = h.object;
        while (o) {
          const p = o.userData?.pick as { kind: string; id: string } | undefined;
          if (p && p.kind === 'train') return p.id;
          o = o.parent;
        }
      }
      return null;
    },
  };
  /**
   * TrainsAPI.shedEta (optional member): sim minutes until this engine should be in the shed bay, or null if unknown.
   * Used for the "Send to shed" gazette ETA and the train card.
   */
  /** light-engine run from the shed tunnel into the bay (motion s = sim min) */
  const SHED_RUN = 11;
  const shedEta = (id: string): number | null => {
    const t = byId(id);
    if (!t) return null;
    if (t.phase === 'releaseWait' || t.task === 'release') return null;
    if (t.phase === 'shed') return 0;
    // honest bay wait: the job in hand (the gang hurries when someone waits), the engine in the bay running out west
    // through the shed road, then every light engine already queued ahead of us doing the same
    const bayWait = () => {
      const occupied = trains.some((o) => o !== t && (o.phase === 'shed' || o.phase === 'releaseWait'));
      const ahead = trains.filter((o) => o !== t && o.task === 'shed' && !o.entered && o.phase === 'queued' && o.earliestEntry <= t.earliestEntry).length
        + trains.filter((o) => o !== t && o.task === 'shed' && o.entered && o.phase !== 'shed' && o.phase !== 'releaseWait').length;
      if (!shedRoadBusy(t) && !ahead) return 0;
      const first = occupied ? trainsShared.bayFreeIn() + 1 + SHED_RUN * 0.5 : shedRoadBusy(t) ? SHED_RUN * 0.6 : 0;
      return Math.max(4, first + ahead * (SHED_RUN * 1.8 + 8));
    };
    if (t.task === 'shed') {
      if (!t.entered) return Math.max(Math.max(0, t.earliestEntry - now()), bayWait()) + SHED_RUN;
      return estimateTime(Math.max(0, (t.stopS ?? t.s) - t.s), t.v, t.vBase, t.accel * 2, t.brake);
    }
    if (t.task === 'hauled' || t.phase === 'broken' || t.task === 'rescuer') return null;
    if (t.task !== 'service') return null;
    if (!t.entered) return Math.max(0.5, bayWait()) + SHED_RUN;
    const ls = lines[t.info.line];
    // finish the platform call (abbreviated), then either divert at the switch or leave through the far tunnel
    let tt = 0, s0 = t.s, v0 = t.v;
    if (t.stops && !t.stopDone && t.stopS !== null) {
      tt += t.phase === 'dwell' || t.phase === 'whistle' ? Math.max(0, t.dwellUntil - now()) + 0.5
        : estimateTime(Math.max(0, t.stopS - t.s), t.v, t.vBase, t.accel, t.brake) + 1.1;
      s0 = t.stopS; v0 = 0;
    }
    const divert = t.info.line === 'coast' && t.info.dir === 'west' && t.info.length <= DIVERT_MAX_LEN && !shedRoadBusy(t)
      && (leadM(t, 'coast') ?? 0) > switchM + 8;
    if (divert) return tt + estimateTime(Math.max(0, (coast.length - switchM) - s0) + shedLen * 0.9, v0, V_SIDING, t.accel * 2, t.brake);
    const exitS = t.route.total - ls.entryS[opposite(t.info.dir)] + t.info.length + EXIT_DEPTH;
    tt += estimateTime(Math.max(0, exitS - s0), v0, V_EXIT + 8, t.accel * 3, 3) * 0.85;
    return tt + Math.max(0.5, bayWait()) + SHED_RUN;
  };
  api.shedEta = shedEta;
  api.holdDoors = (id, untilSimMin) => {
    const t = byId(id);
    if (!t || t.phase !== 'dwell') return;
    const until = Math.min(untilSimMin, t.info.scheduledDep + 30);
    if (until <= t.dwellUntil) return;
    t.dwellUntil = until;
    t.dwellHard = Math.max(t.dwellHard, until);
  };
  trainsShared.smoke = smoke;
  trainsShared.shedEta = shedEta;
  trainsShared.pilotCoupling = (id, out) => {
    const t = byId(id);
    const rc = t?.rescuerCar;
    if (!t || !rc || t.phase !== 'shed') return null;
    // t faces east with the pilot at the rear: the coupling is at the pilot's front face
    t.route.pointAt(t.s - rc.offset, out);
    out.y = 0;
    return out;
  };
  trainsShared.uncouple = (id) => {
    const t = byId(id);
    if (t && t.rescuerCar && t.phase === 'shed') t.removeRescuerAt = Math.min(t.removeRescuerAt, now() + 0.3);
  };
  trainsShared.cabSide = (id, out) => {
    const t = byId(id);
    if (!t || !t.entered) return null;
    const c = t.cars[locoIndex(t)];
    if (!c) return null;
    return out.set(c.spec.loco === 'express' ? -3.8 : -2.5, 0, -2.3).applyMatrix4(c.group.matrix).setY(0);
  };
  ctx.reg.trains = api;
  // DEV introspection (harmless in production): __trainsDebug() → internal dispatcher state
  (window as unknown as { __trainsDebug?: () => unknown }).__trainsDebug = () => ({
    lines: Object.values(lines).map((l) => ({ id: l.id, holder: l.blockHolder?.info.id ?? null, locked: l.lockedBy?.info.id ?? null, holdUntil: l.holdUntil, appr: l.approachEst })),
    shedOwner: shedOwner?.info.id ?? null,
    trains: trains.map((t) => ({
      id: t.info.id, name: t.info.name, st: t.info.state, task: t.task, phase: t.phase, entered: t.entered, line: t.info.line, dir: t.info.dir,
      s: +t.s.toFixed(1), v: +t.v.toFixed(2), stopS: t.stopS && +t.stopS.toFixed(1), sig: t.signalS && +t.signalS.toFixed(1), len: t.info.length,
      block: t.hasBlock, done: t.blockDone, occ: occupancy(t, t.info.line)?.map((x) => +x.toFixed(0)) ?? null, track: headTrack(t),
      canEnter: !t.entered && t.phase === 'queued' ? canEnter(t) : undefined, early: +(t.earliestEntry - now()).toFixed(1),
      lim: t.entered ? +limitFor(t).limit.toFixed(1) : null, pos: [+t.info.position.x.toFixed(1), +t.info.position.z.toFixed(1)],
      cross: t.crossing ? { ...t.crossing, crossS: +t.crossing.crossS.toFixed(1) } : null,
    })),
    log: svcLog.map((x) => `${x.line[0]}${x.dir[0]} ${x.kind} arr${formatSimTime(x.arr)} hold${x.hold.toFixed(0)} spawn+${((x.spawnedAt ?? 0) - x.arr).toFixed(0)} enter+${((x.enteredAt ?? 0) - x.arr).toFixed(0)} at+${((x.arrivedAt ?? 0) - x.arr).toFixed(0)}`),
    services: services.filter((x) => x.state === 'planned').slice(0, 6).map((x) => ({ id: x.id, line: x.line, dir: x.dir, arr: formatSimTime(x.arr), due: +(dueOf(x) - now()).toFixed(1) })),
  });

  const debugCam = createDebugCam(ctx);
  // DEV: ?tgallery=1 lays out every car type on straight test tracks south of the coast line
  const gallery: { cars: Car[]; route: Route; s: number }[] = [];
  if (ctx.params.raw.get('tgallery') === '1') {
    const rows: { liv: LiveryId; types: CarType[] }[] = [
      { liv: 'coast', types: ['loco_express', 'tender', 'coach_first', 'coach_second', 'coach_third', 'dining', 'mail', 'guard'] },
      { liv: 'highland', types: ['loco_tank', 'coach_first', 'coach_second', 'coach_third', 'loco_express', 'tender', 'guard'] },
      { liv: 'freight', types: ['wagon_coal', 'wagon_box', 'wagon_tank', 'wagon_flat', 'wagon_coal', 'wagon_box', 'wagon_tank', 'wagon_flat', 'guard'] },
      { liv: 'royal', types: ['loco_express', 'tender', 'coach_first', 'royal_saloon', 'guard'] },
      { liv: 'circus', types: ['circus_cage', 'circus_cage', 'wagon_flat', 'coach_third'] },
    ];
    rows.forEach((row, i) => {
      const z = 40 + i * 7;
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-60, 0.35, z), new THREE.Vector3(60, 0.35, z)]);
      const route = new Route().add(curve, 1, 0, 'coast');
      const cars = row.types.map((type, k) => vis.makeCar({ type, livery: row.liv, variant: k }, 'gallery', type.startsWith('loco') ? 'Duchess of Albany' : null, false));
      let off = 0;
      for (const c of cars) { c.offset = off; off += c.len; }
      vis.setTailLamp(cars, false);
      gallery.push({ cars, route, s: 100 });
    });
  }
  bus.on('ready', () => { try { warmStart(); } catch (e) { console.error('[trains] warm start failed', e); } });

  // ───────────────────────── system ─────────────────────────
  function signalsTick() {
    const world = ctx.reg.world;
    if (!world) return;
    for (const ls of Object.values(lines)) {
      for (const end of ['east', 'west'] as Dir[]) {
        const h = ls.blockHolder;
        const clear = !!h && h.info.dir === end && h.signalS !== null && h.s < h.signalS + 6 && h.task !== 'release';
        const want = clear ? 'clear' : 'stop';
        let cur: string;
        try { cur = world.getSignal(ls.id, end); } catch { continue; }
        if (cur === 'failed' || cur === want) continue;
        try { world.setSignal(ls.id, end, want); } catch { /* ignore */ }
      }
    }
  }

  /** too many engines waiting off-map for the (single-road) shed: the oldest goes to the main works instead */
  function worksOverflow() {
    const waiting = trains.filter((t) => t.task === 'shed' && t.phase === 'queued' && !t.entered && t !== shedOwner);
    if (waiting.length <= 2) return;
    waiting.sort((a, b) => a.earliestEntry - b.earliestEntry);
    const t = waiting[0];
    if (t.loco) { const c = t.loco.condition; c.boiler = c.brakes = c.wheels = c.coal = c.water = 1; }
    gazette(`With the shed road full, “${t.loco?.name ?? t.info.name}” is sent away to the works at Kingsport.`, 'info');
    removeTrain(t);
  }

  function entryTick() {
    worksOverflow();
    const queued = trains.filter((t) => t.phase === 'queued' && !t.entered && t.info.state !== 'broken');
    if (!queued.length) return;
    queued.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const serviceSeen = new Set<LineId>();
    for (const t of queued) {
      if (t.task === 'service' && t.priority >= 3) {
        if (serviceSeen.has(t.info.line)) continue; // strict FIFO per line for timetabled trains
        serviceSeen.add(t.info.line);
      }
      if (canEnter(t)) enter(t);
    }
  }

  return {
    name: 'trains',
    update(dt: number, c: SimClock) {
      realClock += dt;
      crewDt += dt;
      const dtm = c.dtMotion;
      if (c.dtSim > 0) {
        serviceTick();
        entryTick();
      }
      for (const t of [...trains]) {
        if (!trains.includes(t)) continue;
        try { updateTrain(t, dtm); } catch (e) { console.error('[trains] train update failed', t.info.id, e); removeTrain(t); }
      }
      if (c.dtSim > 0) signalsTick();

      // visuals (real dt)
      const n = night();
      tm.setNight(n);
      const atmo = ctx.reg.atmosphere;
      if (atmo) tm.setWeather(atmo.snow ?? 0, atmo.rain ?? 0);
      // smoke lives in *motion* time when that runs faster than real time (10×/60×, __station.advance)
      const vdt = Math.max(dt, c.dtMotion);
      for (const t of trains) emitSmoke(t, vdt, n);
      const w = ctx.reg.atmosphere?.wind;
      smoke.update(vdt, w ? w.x : 0.8, w ? w.y : 0.3, n);
      if (!placeQueued) {
        placeQueued = true;
        queueMicrotask(() => {
          placeAll();
          try { drawCrews(); updateHeadlamps(night()); } catch (e) { console.error('[trains] crew/lamps failed', e); }
        });
      }
      debugCam?.(dt);
    },
    dispose() {
      for (const t of [...trains]) removeTrain(t);
      smoke.dispose();
      vis.dispose();
      crewR.dispose();
      lamps.dispose();
      ctx.scene.remove(vis.root, smoke.group);
    },
  };
}
