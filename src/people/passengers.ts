import * as THREE from 'three';
import type { Dir, LineId, PlatformId } from '../core/types';
import type { Departure, PersonSpec, TrainInfo, VehicleKind } from '../core/apis';
import type { Origin } from '../core/origins';
import type { PeopleSystem } from './system';
import { WALK, yawTo } from './system';
import { passengerLook } from './looks';
import type { Person, Seat } from './types';

/*
 * PASSENGERS (v2): origin-based trip planner, honest lead times, boarding at predicted doors, waiting room,
 * rebooking, alighting sinks (cab rank, omnibus, homes, family meeting them).
 *
 * Time reality: motion runs 1 s per sim minute, so walking 100 m costs ~74 sim minutes. Travellers therefore
 * set out from their door (or book a cab / the omnibus) at  expected departure − (walk time + queue + slack),
 * and only ever target a train they can actually reach.
 */

const QUEUE_SPACING = 0.85;
const MAX_QUEUE = 11;
const MAX_ALIGHT_PER_TRAIN = 36;
/** give up only when the next train the passenger could take is further away than this (sim minutes) */
const MAX_POSTED_WAIT = 210;
/** don't head for the waiting room unless the train is at least this far off (sim min = motion s) */
const WAITING_ROOM_MIN = 80;

/** travellers per sim minute by hour (× 0.7 in v2 — the rest of life happens in the towns) */
const RATE: [number, number][] = [
  [0, 0.09], [1, 0.02], [2, 0.006], [4.5, 0.006], [5.5, 0.1], [6.5, 0.35], [7.3, 0.9], [8.6, 0.95], [9.4, 0.45],
  [12, 0.42], [13, 0.55], [14, 0.4], [16.5, 0.45], [17.3, 0.95], [18.7, 0.9], [19.5, 0.4], [21, 0.24], [22.5, 0.14], [24, 0.09],
];

interface DepInfo { seats?: number; trainId: string | null; line: LineId; dir: Dir; time: number; expected: number; cancelled: boolean; departed: boolean; boarding: boolean; platform: PlatformId; length?: number; stopHeadT?: number }
interface Cand { o: Origin; w: number; len: Record<number, number> }
interface AlightJob { trainId: string; platform: PlatformId; remaining: number; doors: THREE.Vector3[] | null; t: number; waited: number; i: number }
type Mode = 'omnibus' | 'cab' | 'near' | 'ash' | 'far' | 'cart' | 'gig';

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** trains the public may board: no goods, ghosts, seatless specials or engines running 'not in service' to the shed */
export function isPassengerService(t: TrainInfo): boolean {
  return !(t.kind === 'freight' || t.capacity === 0 || t.ghost || t.inService === false || (t.special && /ghost|freight|circus/.test(t.special)));
}

export class Passengers {
  private deps: DepInfo[] = [];
  private depsAt = -999;
  private nextDep = new Map<string, DepInfo>();
  private queue: Person[] = [];
  private seats: Seat[] = [];
  private pending = new Map<string, number>();
  private alightJobs: AlightJob[] = [];
  private dwell = new Map<string, TrainInfo>();
  private doorsCache = new Map<string, THREE.Vector3[]>();
  private predCache = new Map<string, THREE.Vector3[]>();
  private doorOrigins = new Map<string, (() => void)[]>();
  private meeters = new Map<string, Person[]>();
  /** service train announced (train:approaching) per `line|dir`, until it departs */
  private approach = new Map<string, string>();
  private cabQueue: Person[] = [];
  private busQueue: Person[] = [];
  private spawnAcc = 0;
  private gaveUpTimes: number[] = [];
  private lastComplaintGazette = -1e9;
  private lastCrowdGazette = -1e9;
  gaveUpTotal = 0;
  boardedTotal = 0;
  private near: Cand[] = [];
  /** vehicle trips that could not be booked yet: retried every couple of minutes instead of spawning at a door */
  private retry: { mode: Mode; size: number; next: number; until: number }[] = [];
  /** recent departures per building (sim minutes), for the hourly output cap */
  private outLog = new Map<string, number[]>();
  private ash: Cand[] = [];
  private far: Cand[] = [];
  private qDir = new THREE.Vector3();
  private stepsNode: THREE.Vector3;
  private unsubs: (() => void)[] = [];
  readonly maxPassengers: number;

  constructor(private S: PeopleSystem) {
    const ctx = S.ctx;
    const L = ctx.layout;
    this.maxPassengers = Math.round(S.cap * 0.62);
    this.stepsNode = L.nav.nodes.steps?.clone() ?? L.entrance.clone();
    this.qDir.copy(this.stepsNode).sub(L.bookingOffice).setY(0).normalize();
    if (this.qDir.lengthSq() < 0.5) this.qDir.set(1, 0, 0);
    for (const P of [L.platforms[1], L.platforms[2]]) {
      P.benches.forEach((b) => {
        const ax = new THREE.Vector3(Math.cos(b.yaw), 0, -Math.sin(b.yaw));
        const fw = new THREE.Vector3(Math.sin(b.yaw), 0, Math.cos(b.yaw));
        for (const o of [-0.6, 0, 0.6]) this.seats.push({ plat: P.id, pos: b.pos.clone().addScaledVector(ax, o).addScaledVector(fw, 0.06), yaw: b.yaw, taken: null });
      });
    }
    // candidate origins
    for (const o of ctx.origins.list({ kind: 'door', for: 'people' })) {
      const b = o.building ? L.buildings.find((x) => x.id === o.building) : undefined;
      if (!b) continue;
      if (b.kind === 'hut' || b.kind === 'church' || b.kind === 'chapel' || b.kind === 'barn' || b.kind === 'stable' || b.kind === 'mews' || b.kind === 'engineHouse' || b.kind === 'school' || b.kind === 'mill' || b.kind === 'boathouse' || b.kind === 'lodge') continue;
      const c: Cand = { o, w: b.kind === 'pub' || b.kind === 'inn' ? 1.4 : b.kind === 'terrace' ? 1.2 : 1, len: {} };
      if (b.town === 'station') this.near.push(c);
      else if (b.town === 'ashcombe') this.ash.push(c);
      else this.far.push(c);
    }
    for (const o of ctx.origins.list({ kind: 'portal', for: 'people' })) this.far.push({ o, w: 0.5, len: {} });

    this.unsubs.push(
      ctx.bus.on('train:arrived', (e) => this.onTrainArrived(e.trainId, e.platform)),
      ctx.bus.on('train:departed', (e) => this.onTrainGone(e.trainId)),
      ctx.bus.on('train:despawned', (e) => this.onTrainGone(e.trainId)),
      ctx.bus.on('train:approaching', (e) => this.onTrainApproaching(e.trainId, e.line, e.platform)),
    );
  }

  dispose() { for (const u of this.unsubs) u(); for (const [, r] of this.doorOrigins) for (const f of r) f(); }

  private get ctx() { return this.S.ctx; }
  private get rng() { return this.S.rng; }
  private now() { return this.ctx.clock.minutes; }

  // ───────────────────────── timetable ─────────────────────────
  private refreshDeps(force = false) {
    const now = this.now();
    if (!force && now - this.depsAt < 1) return;
    this.depsAt = now;
    const L = this.ctx.layout;
    let rows: Departure[] = [];
    try { rows = this.ctx.reg.trains?.timetable(40) ?? []; } catch { rows = []; }
    this.deps.length = 0;
    this.nextDep.clear();
    for (const d of rows) {
      const line = L.lines[d.line];
      if (!line) continue;
      const dir: Dir | null = d.dir ?? (line.ends.east === d.destination ? 'east' : line.ends.west === d.destination ? 'west' : null);
      if (!dir) continue;
      const status = d.status ?? '';
      const m = /Delayed\s+(\d+)/i.exec(status);
      const delay = m ? Number(m[1]) : 0;
      const info: DepInfo = {
        trainId: d.trainId, line: d.line, dir, time: d.time,
        expected: d.expected ?? d.time + delay,
        cancelled: /cancel|not in service/i.test(status), departed: status === 'Departed', boarding: status === 'Boarding',
        platform: d.platform, length: d.trainLength, stopHeadT: d.stopHeadT, seats: d.seats,
      };
      this.deps.push(info);
      const key = `${d.line}|${dir}`;
      if (!info.departed && !info.cancelled && !this.nextDep.has(key)) this.nextDep.set(key, info);
    }
  }

  /** next usable departure for line/dir at or after `after` (sim minutes) */
  private depFor(line: LineId, dir: Dir, after = -Infinity): DepInfo | undefined {
    for (const d of this.deps) if (d.line === line && d.dir === dir && !d.departed && !d.cancelled && d.expected >= after) return d;
    return undefined;
  }

  // ───────────────────────── spawning (trip planner) ─────────────────────────
  private spawnRate(): number {
    const h = this.ctx.clock.hour;
    let r = RATE[RATE.length - 1][1];
    for (let i = 1; i < RATE.length; i++) {
      if (h <= RATE[i][0]) {
        const [h0, r0] = RATE[i - 1], [h1, r1] = RATE[i];
        r = r0 + (r1 - r0) * ((h - h0) / (h1 - h0));
        break;
      }
    }
    const wd = this.ctx.clock.weekday;
    if (wd >= 5 && (h > 6.5 && h < 9.6 || h > 16.8 && h < 19.6)) r *= 0.6;
    const a = this.ctx.reg.atmosphere;
    const w = a?.weather ?? 'clear';
    const wf = w === 'storm' ? 0.35 : w === 'rain' ? 0.75 : w === 'snow' ? 0.65 : w === 'fog' ? 0.85 : w === 'overcast' ? 0.95 : 1;
    return r * 1.25 * wf * Math.max(0, this.S.api?.density ?? 1);
  }

  /** walking metres from an origin to a platform (cached) */
  private walkLen(c: Cand, plat: PlatformId): number {
    let l = c.len[plat];
    if (l === undefined) {
      const P = this.ctx.layout.platforms[plat];
      try { l = this.ctx.layout.walk.length(c.o.pos(_v), P.center); } catch { l = 400; }
      if (!isFinite(l)) l = 2000;
      c.len[plat] = l;
    }
    return l;
  }

  /** pick a departure the traveller can honestly reach given `travel(plat)` sim minutes of travel */
  private chooseDep(travel: (plat: PlatformId) => number, queueMin: number): DepInfo | null {
    const now = this.now();
    let tot = 0;
    const ws: number[] = [];
    for (const d of this.deps) {
      let w = 0;
      if (!d.departed && !d.cancelled && !this.depFull(d)) {
        const spare = d.expected - now - travel(d.platform) - queueMin;
        if (spare >= 14 && spare < 200) { const k = (spare - 62) / 42; w = Math.exp(-k * k) + 0.015; }
      }
      ws.push(w); tot += w;
    }
    if (tot <= 0) return null;
    let r = this.rng.next() * tot;
    for (let i = 0; i < this.deps.length; i++) { r -= ws[i]; if (r <= 0) return this.deps[i]; }
    return null;
  }

  /** a small train already has as many travellers heading for it as it has free seats */
  private depFull(d: DepInfo): boolean {
    if (d.seats === undefined) return false;
    let n = 0;
    for (const p of this.S.list) if (p.kind === 'passenger' && p.alive && p.line === d.line && p.dir === d.dir && p.aim === d.time) n++;
    return n >= d.seats;
  }

  private pickCand(list: Cand[], sink = false): Cand | null {
    const focus = this.ctx.view?.focus;
    let tot = 0;
    const ws = list.map((c) => {
      const b = c.o.building;
      let w = c.w;
      if (b && !sink && !this.canLeave(b)) w = 0;
      if (b && sink && !this.S.canAbsorb(b)) w = 0;
      if (focus) { const d = c.o.pos(_v).distanceTo(focus); if (d < 140) w *= 1.6; }
      tot += w;
      return w;
    });
    if (tot <= 0) return null;
    let r = this.rng.next() * tot;
    for (let i = 0; i < list.length; i++) { r -= ws[i]; if (r <= 0) return list[i]; }
    return list[list.length - 1] ?? null;
  }

  /** a building can send out a traveller only while residents are inside and it is under its hourly output cap */
  private canLeave(b: string, n = 1): boolean {
    if (this.ctx.origins.pools.count(b) < n) return false;
    const log = this.outLog.get(b);
    if (!log) return true;
    const now = this.now();
    while (log.length && log[0] < now - 60) log.shift();
    const res = this.ctx.layout.buildings.find((x) => x.id === b)?.residents ?? 2;
    const cap = Math.max(1, Math.min(4, Math.round(res * 0.4)));
    return log.length + n <= cap;
  }

  private noteLeft(b: string, n: number) {
    let log = this.outLog.get(b);
    if (!log) { log = []; this.outLog.set(b, log); }
    const now = this.now();
    for (let i = 0; i < n; i++) log.push(now);
  }

  private groupSize(): number {
    const r = this.rng.next();
    return r < 0.7 ? 1 : r < 0.88 ? 2 : r < 0.96 ? 3 : 4;
  }

  private spawnGroup(size: number): number {
    // most travellers come in by cab or the omnibus (they appear at the map edge or the Crown Mews); a few walk
    // in from Ashcombe and the outlying hamlets, and only a small share from the handful of houses by the station
    const r = this.rng.next();
    const mode: Mode = r < 0.46 ? 'omnibus' : r < 0.64 ? 'cab' : r < 0.69 ? 'near' : r < 0.89 ? 'ash' : r < 0.92 ? 'far' : r < 0.97 ? 'cart' : 'gig';
    if (mode === 'omnibus' || mode === 'cab' || mode === 'cart' || mode === 'gig') {
      const got = this.requestVehicle(mode, size);
      if (got === true) return size;
      if (got === 'nodep') return this.walkerGroup(this.ash, size);
      // no vehicle free right now: try again in a couple of minutes (the traveller is still at home, unseen)
      const now = this.now();
      if (this.retry.length < 12) this.retry.push({ mode, size, next: now + 2, until: now + 24 });
      return size;
    }
    return this.walkerGroup(mode === 'near' ? this.near : mode === 'ash' ? this.ash : this.far, size);
  }

  private updateRetries() {
    const now = this.now();
    for (let i = this.retry.length - 1; i >= 0; i--) {
      const q = this.retry[i];
      if (now < q.next) continue;
      if (this.requestVehicle(q.mode, q.size) === true) { this.retry.splice(i, 1); continue; }
      q.next = now + 2.5;
      if (now > q.until) {
        // still nothing: they set out on foot from Ashcombe or a hamlet (never the station-side houses)
        this.retry.splice(i, 1);
        if (this.S.counts.passenger < this.maxPassengers && this.S.roomFor(q.size + 6)) this.walkerGroup(this.rng.chance(0.7) ? this.ash : this.far, q.size);
      }
    }
  }

  private requestVehicle(mode: Mode, size: number): boolean | 'nodep' {
    const traffic = this.ctx.reg.traffic;
    if (!traffic) return 'nodep';
    // vehicle time to the forecourt (portal / depot → drop-off at a trot) + walk drop-off → platform
    const vehMin = mode === 'cab' ? 80 : mode === 'omnibus' ? 150 : 170;
    const dep = this.chooseDep(() => vehMin + 40, 6);
    if (!dep) return 'nodep';
    const specs: PersonSpec[] = [];
    for (let i = 0; i < size; i++) specs.push({ role: 'passenger', child: i > 0 && this.rng.chance(0.45), luggage: i === 0 && this.rng.chance(0.5), dest: { line: dep.line, dir: dep.dir, trainId: dep.trainId ?? undefined }, tag: 'passenger' });
    const kind: VehicleKind | 'cab' = mode === 'cab' ? 'cab' : mode === 'omnibus' ? 'omnibus' : mode === 'cart' ? 'farmcart' : 'gig';
    let id: string | null = null;
    try { id = traffic.request({ kind, to: mode === 'omnibus' ? 'forecourt:omnibus' : 'forecourt:drop', riders: specs, tag: 'passenger' }); } catch { id = null; }
    return !!id;
  }

  private walkerGroup(list: Cand[], size: number): number {
    if (!list.length) return 0;
    const c = this.pickCand(list);
    if (!c) return 0;
    const hasTicket = this.rng.chance(0.45);
    const dep = this.chooseDep((plat) => this.walkLen(c, plat) / (WALK * 0.95), hasTicket ? 0 : 8);
    if (!dep) return 0;
    const b = c.o.building;
    // a house sends out no more people than are at home (the group shrinks to who is in)
    if (b) { const have = this.ctx.origins.pools.count(b); if (have <= 0 || !this.canLeave(b)) return 0; size = Math.min(size, have); }
    const pool = !!b;
    const lead = this.S.emerge(c.o, 'passenger', 'passenger', passengerLook(this.rng), { pool });
    if (!lead) return 0;
    if (b) this.noteLeft(b, 1);
    if (lead.look.child) { lead.look.child = false; }
    lead.home = c.o.building;
    this.assignDest(lead, dep.line, dep.dir, dep.time);
    lead.hasTicket = hasTicket;
    let n = 1;
    for (let i = 1; i < size; i++) {
      const look = passengerLook(this.rng);
      const child = this.rng.chance(0.55);
      if (child) { look.child = true; look.scale = this.rng.range(0.58, 0.7); look.accs = look.accs.filter((a) => a !== 'suitcase'); }
      const f = this.S.emerge(c.o, 'passenger', 'passenger', look, { pool });
      if (!f) break;
      if (b) this.noteLeft(b, 1);
      f.home = c.o.building;
      f.leader = lead; lead.followers.push(f);
      f.line = lead.line; f.dir = lead.dir; f.platform = lead.platform; f.destination = lead.destination; f.aim = lead.aim;
      f.followOff.set(this.rng.range(-0.9, 0.9), 0, -this.rng.range(0.6, 1.1));
      f.state = 'following';
      n++;
    }
    this.arriveAtStation(lead);
    return n;
  }

  assignDest(p: Person, line: LineId, dir: Dir, aim?: number) {
    const L = this.ctx.layout;
    p.line = line; p.dir = dir;
    p.platform = L.lines[line].platform;
    p.destination = L.lines[line].ends[dir];
    if (aim !== undefined) p.aim = aim;
    else { this.refreshDeps(); p.aim = this.depFor(line, dir, this.now())?.time ?? this.now() + 60; }
    p.tolerance = this.rng.range(140, 260);
    p.patience = 1;
  }

  /** a traveller reaches the station area (from a door, or stepped down from a cab / the omnibus) */
  arriveAtStation(p: Person) {
    if (!p.alive) return;
    if (p.kind !== 'passenger') this.S.setKind(p, 'passenger');
    if (!p.line || !p.dir) {
      // no destination (e.g. spawned inside a vehicle without one): choose a reachable train now
      const d = this.chooseDep(() => 40, 5) ?? this.deps.find((x) => !x.departed && !x.cancelled);
      if (!d) { void this.S.dismiss(p); return; }
      this.assignDest(p, d.line, d.dir, d.time);
    }
    if (!p.hasTicket && p.data.ticketChecked === undefined) { p.data.ticketChecked = true; p.hasTicket = this.rng.chance(0.4); }
    if (p.look.child && !p.leader) p.hasTicket = true;
    // short on time? skip the queue (pay the guard on the train) and hurry
    const d = this.depFor(p.line!, p.dir!, this.now() - 2);
    const spare = d ? d.expected - this.now() : 999;
    const walkMin = Math.hypot(p.pos.x - this.stepsNode.x, p.pos.z - this.stepsNode.z) / WALK + 38;
    if (!p.hasTicket && (this.queue.length >= MAX_QUEUE || spare < walkMin + this.queue.length * 3 + 6)) p.hasTicket = true;
    p.state = 'toStation';
    if (p.hasTicket) this.headToPlatform(p, spare < walkMin + 4);
    else this.S.go(p, this.stepsNode.clone().add(p.lane), () => this.joinQueue(p), { run: spare < walkMin + 12 });
  }

  // ───────────────────────── warm start ─────────────────────────
  warmStart() {
    this.refreshDeps(true);
    const n = Math.round(THREE.MathUtils.clamp(this.spawnRate() / 0.7 * 55, 0, 48));
    const L = this.ctx.layout;
    const now = this.now();
    for (let i = 0; i < n; i++) {
      if (this.S.counts.passenger >= this.maxPassengers || !this.S.roomFor()) break;
      const opts = this.deps.filter((d) => !d.departed && !d.cancelled && d.expected - now < 140);
      if (!opts.length) break;
      const d = this.rng.pick(opts);
      const p = this.S.spawnRaw('passenger', L.entrance, 'passenger', passengerLook(this.rng));
      if (p.look.child) { p.look.child = false; }
      this.assignDest(p, d.line, d.dir, d.time);
      p.hasTicket = true;
      p.home = this.rng.pick(this.near.length && this.rng.chance(0.1) ? this.near : this.ash.length ? this.ash : this.near)?.o.building;
      const spot = this.chooseSpot(p);
      p.pos.copy(spot.pos);
      this.arriveAtSpot(p, spot.seat);
    }
  }

  // ───────────────────────── queue & platform ─────────────────────────
  private joinQueue(p: Person) {
    if (this.queue.length >= MAX_QUEUE) { p.hasTicket = true; this.headToPlatform(p); return; }
    p.state = 'queueing';
    this.queue.push(p);
  }

  private queuePos(i: number, out: THREE.Vector3): THREE.Vector3 {
    const b = this.ctx.layout.bookingOffice;
    const total = Math.hypot(this.stepsNode.x - b.x, this.stepsNode.z - b.z);
    const d = 0.6 + i * QUEUE_SPACING;
    out.copy(b).addScaledVector(this.qDir, d);
    const k = Math.min(1, d / Math.max(0.1, total));
    out.y = b.y + (this.stepsNode.y - b.y) * k;
    return out;
  }

  private updateQueue(dtm: number) {
    for (let i = 0; i < this.queue.length; i++) {
      const p = this.queue[i];
      const q = this.queuePos(i, _v);
      const d = Math.hypot(q.x - p.pos.x, q.z - p.pos.z);
      if (d > 0.15 && p.pathIdx >= p.path.length) { p.path = [q.clone()]; p.pathIdx = 0; p.onArrive = null; p.running = false; }
      if (p.pathIdx >= p.path.length) p.faceYaw = yawTo(-this.qDir.x, -this.qDir.z);
    }
    const front = this.queue[0];
    const clerk = this.S.staff.clerk;
    if (front && front.pathIdx >= front.path.length) {
      const q = this.queuePos(0, _v);
      if (Math.hypot(q.x - front.pos.x, q.z - front.pos.z) < 0.3) {
        if (front.state !== 'buying') { front.state = 'buying'; front.data.buyT = this.rng.range(2, 4.2); }
        front.data.buyT = (front.data.buyT as number) - dtm;
        if (clerk) clerk.manualAnim = 'work';
        if ((front.data.buyT as number) <= 0) {
          this.queue.shift();
          front.hasTicket = true;
          this.headToPlatform(front);
          if (clerk) clerk.manualAnim = null;
        }
      }
    } else if (!front && clerk && clerk.manualAnim === 'work') clerk.manualAnim = null;
  }

  /**
   * would a figure standing here be hidden behind a canopy valance from the current camera? (the dagger boards hang
   * ~3.7 m above the platform, so from the iso camera they cover the upper bodies of people a few metres beyond them,
   * leaving only skirts and boots showing — "headless spikes")
   */
  private underValance(plat: PlatformId, pos: THREE.Vector3): boolean {
    const cam = this.ctx.camera?.current;
    if (!cam) return false;
    const P = this.ctx.layout.platforms[plat];
    cam.getWorldDirection(_dir);
    const n = P.inward;
    const ax = Math.cos(P.yaw), az = -Math.sin(P.yaw);
    const eave = P.center.y + 4.3;
    for (const lat of [-(P.width / 2 - 0.1), P.width / 2 + 0.2]) {
      const lx = P.center.x + n.x * lat, lz = P.center.z + n.z * lat;
      for (const hy of [0.9, 1.7]) {
        const s0 = (pos.x - lx) * n.x + (pos.z - lz) * n.z;
        const dn = _dir.x * n.x + _dir.z * n.z;
        if (Math.abs(dn) < 1e-4) continue;
        const t = s0 / dn;
        if (t <= 0) continue;
        const y = pos.y + hy - t * _dir.y;
        const hx = pos.x - t * _dir.x, hz = pos.z - t * _dir.z;
        const along = (hx - P.center.x) * ax + (hz - P.center.z) * az;
        if (Math.abs(along) > P.canopyLength / 2 + 0.6) continue;
        if (y > eave - 0.75 && y < eave + 0.2) return true;
      }
    }
    return false;
  }

  private platformPoint(plat: PlatformId, alongMax: number, latMin: number, latMax: number): THREE.Vector3 {
    const P = this.ctx.layout.platforms[plat];
    // waiting travellers favour the forecourt (east) half, which the default view looks along
    const along = this.rng.range(-alongMax * 0.55, alongMax);
    const lat = this.rng.range(latMin, latMax);
    const ax = Math.cos(P.yaw), az = -Math.sin(P.yaw);
    return new THREE.Vector3(P.center.x + ax * along + P.inward.x * lat, P.center.y, P.center.z + az * along + P.inward.z * lat);
  }

  private chooseSpot(p: Person): { pos: THREE.Vector3; seat: Seat | null } {
    const plat = p.platform!;
    const wet = this.S.wetness() > 0.3;
    if (!p.look.child && this.rng.chance(wet ? 0.7 : 0.4)) {
      const free = this.seats.filter((s) => s.plat === plat && !s.taken);
      if (free.length) {
        const s = this.rng.pick(free);
        s.taken = p;
        return { pos: s.pos.clone(), seat: s };
      }
    }
    const alongMax = wet ? 32 : 40;
    let pos = this.platformPoint(plat, alongMax, -2.2, 0.3);
    for (let k = 0; k < 6; k++) {
      pos = this.rng.chance(0.7) ? this.platformPoint(plat, alongMax, -2.2, 0.3) : this.platformPoint(plat, alongMax, 1.9, 2.9);
      if (!this.underValance(plat, pos)) break;
    }
    return { pos, seat: null };
  }

  private faceTrack(p: Person, jitter = 0.6) {
    const P = this.ctx.layout.platforms[p.platform ?? 1];
    p.faceYaw = yawTo(-P.inward.x, -P.inward.z) + this.rng.range(-jitter, jitter);
  }

  /** the train this passenger wants has been announced: stand back from the edge at one of its doors */
  private readyIfAnnounced(p: Person, hurry = false): boolean {
    if (!p.line || !p.dir || p.leader) return false;
    const id = this.approach.get(`${p.line}|${p.dir}`);
    if (!id || id === p.refused) return false;
    let t: TrainInfo | undefined;
    try { t = this.ctx.reg.trains.get(id); } catch { t = undefined; }
    if (!t || t.platform === null && t.state === 'departing') return false;
    const doors = this.predictedDoors(t);
    if (!doors.length) return false;
    this.goReady(p, doors, hurry);
    return true;
  }

  headToPlatform(p: Person, run = false) {
    const spot = this.chooseSpot(p);
    p.state = 'toPlatform';
    p.seat = null;
    this.S.go(p, spot.pos, () => this.arriveAtSpot(p, spot.seat), { run });
    if (spot.seat) { spot.seat.taken = p; p.seat = spot.seat; }
  }

  private arriveAtSpot(p: Person, seat: Seat | null) {
    if (this.readyIfAnnounced(p)) return;
    if (seat && seat.taken === p) {
      p.seat = seat; p.sitTarget = 1; p.state = 'seated';
      p.faceYaw = seat.yaw;
      p.pos.copy(seat.pos);
      if (!p.look.child && this.rng.chance(0.45)) this.S.readPaper(p, true);
    } else {
      p.state = 'waiting';
      this.faceTrack(p);
      if (!p.look.child && !this.S.chatWithNeighbour(p) && p.look.gender === 'm' && this.rng.chance(0.12) && this.S.wetness() < 0.3) this.S.readPaper(p, true);
    }
    if (p.trainId) p.trainId = null;
  }

  /** forget a passenger's queue/seat/train bookkeeping */
  release(p: Person, dropFollowers = true) {
    const qi = this.queue.indexOf(p);
    if (qi >= 0) this.queue.splice(qi, 1);
    const ci = this.cabQueue.indexOf(p); if (ci >= 0) this.cabQueue.splice(ci, 1);
    const bi = this.busQueue.indexOf(p); if (bi >= 0) this.busQueue.splice(bi, 1);
    if (p.seat && p.seat.taken === p) p.seat.taken = null;
    p.seat = null;
    p.trainId = null;
    if (dropFollowers) {
      for (const f of p.followers) f.leader = null;
      p.followers.length = 0;
    }
  }

  onRemoved(p: Person) {
    this.release(p, false);
    for (const [, arr] of this.meeters) { const i = arr.indexOf(p); if (i >= 0) arr.splice(i, 1); }
  }

  // ───────────────────────── giving up / rebooking ─────────────────────────
  /** debug: why travellers gave up (reason → count) */
  readonly giveUpWhy: Record<string, number> = {};

  private giveUp(p: Person, why = 'patience') {
    const k = `${why}:${p.data.why ?? '-'}:${p.state}`;
    this.giveUpWhy[k] = (this.giveUpWhy[k] ?? 0) + 1 + p.followers.length;
    this.release(p, false);
    p.state = 'gaveUp';
    p.mood = Math.min(p.mood, 0.1);
    const n = 1 + p.followers.length;
    this.gaveUpTotal += n;
    this.ctx.bus.emit('passenger:gaveUp', { personId: p.id });
    for (const f of p.followers) this.ctx.bus.emit('passenger:gaveUp', { personId: f.id });
    const now = this.now();
    this.gaveUpTimes.push(now);
    while (this.gaveUpTimes.length && this.gaveUpTimes[0] < now - 30) this.gaveUpTimes.shift();
    if (this.gaveUpTimes.length >= 6 && now - this.lastComplaintGazette > 240) {
      this.lastComplaintGazette = now;
      const line = p.line ? this.ctx.layout.lines[p.line].name : 'the railway';
      const heads = [
        `Indignant travellers storm out of the booking hall, denouncing ${line} delays`,
        `"Scandalous!" — a crowd of weary passengers abandons the ${line} platform`,
        `Letters to the Editor: patience of ${line} travellers "entirely exhausted"`,
        `Umbrellas brandished as disgruntled passengers quit the station in disgust`,
      ];
      this.ctx.bus.emit('gazette', { headline: this.rng.pick(heads), kind: 'warn' });
    }
    if (p.data.indoorsOf) this.S.reemerge(p);
    if (p.kind === 'passenger') this.S.setKind(p, 'idler');
    void this.S.dismiss(p, { state: 'leaving in disgust' });
  }

  /** missed / cancelled / refused: aim for the next train in the same direction (or give up if it's too far off) */
  private rebook(p: Person, why: string): boolean {
    this.refreshDeps(true);
    const now = this.now();
    const next = p.line && p.dir ? this.depFor(p.line, p.dir, now + 1) : undefined;
    // nothing posted yet (the board only shows a few hours ahead): wait for the next listing
    if (!next) { p.aim = now + 90; p.mood = Math.max(0, p.mood - 0.15); p.data.why = why; return true; }
    if (next.expected - now > (p.data.indoorsOf ? MAX_POSTED_WAIT + 90 : MAX_POSTED_WAIT)) { this.giveUp(p, `rebook-${why}-${next ? Math.round(next.expected - now) : 'none'}`); return false; }
    p.aim = next.time;
    // a fresh train to aim for: grumble, but settle down to wait again
    p.patience = Math.max(p.patience, 0.7);
    p.mood = Math.max(0, p.mood - 0.15);
    p.data.rebooked = ((p.data.rebooked as number) ?? 0) + 1;
    p.data.why = why;
    return true;
  }

  // ───────────────────────── boarding ─────────────────────────
  private updateDwell() {
    this.dwell.clear();
    let trains: TrainInfo[] = [];
    try { trains = this.ctx.reg.trains?.list() ?? []; } catch { trains = []; }
    for (const t of trains) {
      if (!isPassengerService(t)) continue;
      if (t.doorsOpen && t.platform != null && (t.state === 'dwelling' || t.speed < 0.3)) {
        this.dwell.set(`${t.platform}|${t.line}|${t.dir}`, t);
      }
    }
  }

  private doorsFor(t: TrainInfo): THREE.Vector3[] {
    let d = this.doorsCache.get(t.id);
    if (!d) {
      try { d = (this.ctx.reg.trains.getDoors(t.id) ?? []).map((v) => v.clone()); } catch { d = []; }
      if (!d.length) d = this.fallbackDoors(t, t.line, t.dir, t.length, null);
      this.doorsCache.set(t.id, d);
      this.ensureDoorOrigins(t, d);
    }
    return d;
  }

  /** where the doors WILL be (from train:approaching): trains.predictedDoors, else our own estimate from the stop point */
  private predictedDoors(t: TrainInfo): THREE.Vector3[] {
    let d = this.predCache.get(t.id);
    if (d) return d;
    try { d = (this.ctx.reg.trains.predictedDoors(t.id) ?? []).map((v) => v.clone()); } catch { d = []; }
    if (!d.length) {
      const L = this.ctx.layout.lines[t.line];
      let headT: number | null = null;
      try { headT = L.stopTFor(t.dir, t.length || 60); } catch { headT = null; }
      d = this.fallbackDoors(t, t.line, t.dir, t.length, headT);
    }
    this.predCache.set(t.id, d);
    return d;
  }

  private fallbackDoors(t: TrainInfo, lineId: LineId, dir: Dir, length: number, headT: number | null): THREE.Vector3[] {
    const L = this.ctx.layout;
    const line = L.lines[lineId];
    const P = L.platforms[line.platform];
    const head = headT ?? line.nearestT(t.position);
    const sgn = dir === 'east' ? 1 : -1;
    const out: THREE.Vector3[] = [];
    const len = Math.max(20, length || 60);
    for (let s = 14; s < len - 4; s += 13) {
      const tt = head - sgn * s / line.length;
      if (tt < line.platformStartT || tt > line.platformEndT) continue;
      out.push(P.edgePointAt(tt));
    }
    if (!out.length) out.push(P.edgePointAt((line.platformStartT + line.platformEndT) / 2));
    return out;
  }

  /** train doors are legitimate origins while the train stands at the platform (register if trains hasn't) */
  private ensureDoorOrigins(t: TrainInfo, doors: THREE.Vector3[]) {
    if (this.doorOrigins.has(t.id)) return;
    const O = this.ctx.origins;
    const rem: (() => void)[] = [];
    const id = t.id;
    doors.forEach((d, i) => {
      const pos = d.clone();
      rem.push(O.add({
        id: `train:${id}:pd${i}`, kind: 'train', owner: 'people', radius: 2.6, for: ['people'],
        pos: (o) => o.copy(pos),
        open: () => { const tr = this.ctx.reg.trains?.get(id); return !!tr && tr.platform != null && tr.speed < 3; },
      }));
    });
    this.doorOrigins.set(t.id, rem);
  }

  private matchingTrain(p: Person): TrainInfo | undefined {
    if (!p.platform || !p.line || !p.dir) return undefined;
    const t = this.dwell.get(`${p.platform}|${p.line}|${p.dir}`);
    if (!t || t.id === p.refused || p.data.skipTrain === t.id) return undefined;
    // too far to make it before the doors shut (motion: 1 s per sim minute, so a 40 m dash costs ~19 sim min):
    // don't start a hopeless sprint — let this one go and wait for the next
    const doors = this.doorsFor(t);
    let bd = Infinity;
    for (const d of doors) bd = Math.min(bd, Math.hypot(d.x - p.pos.x, d.z - p.pos.z));
    let dep: number | null = null;
    try { dep = this.ctx.reg.trains.expectedDeparture(t.id); } catch { dep = null; }
    const budget = Math.max(0, (dep ?? this.now() + 3) - this.now()) + 3;
    const need = (bd * 1.2) / 2.1;
    if (bd > 6 && need > budget) { p.data.skipTrain = t.id; return undefined; }
    return t;
  }

  private startBoarding(p: Person, t: TrainInfo) {
    const doors = this.doorsFor(t);
    let best = doors[0], bd = Infinity;
    for (const d of doors) { const dd = d.distanceToSquared(p.pos); if (dd < bd) { bd = dd; best = d; } }
    if (!best) return;
    if (p.data.indoorsOf) this.S.reemerge(p);
    const qi = this.queue.indexOf(p); if (qi >= 0) this.queue.splice(qi, 1);
    p.trainId = t.id;
    p.data.bd = Math.round(Math.sqrt(bd));
    p.data.bs = p.state;
    this.S.endChat(p);
    this.S.readPaper(p, false);
    p.state = 'boarding';
    const target = best.clone();
    target.x += this.rng.range(-0.35, 0.35); target.z += this.rng.range(-0.35, 0.35);
    this.S.go(p, target, () => this.board(p, t.id, best), { run: true, direct: p.pos.y > 0.6 && Math.abs(target.y - p.pos.y) < 0.3 && bd < 90 * 90 });
  }

  private board(p: Person, trainId: string, door: THREE.Vector3) {
    const t = this.ctx.reg.trains.get(trainId);
    if (!t || !t.doorsOpen) { this.missed(p); return; }
    let accepted = 0;
    const n = 1 + p.followers.length;
    try { accepted = this.ctx.reg.trains.addPassengers(trainId, n); } catch { accepted = 0; }
    if (accepted <= 0) {
      p.refused = trainId;
      p.trainId = null;
      if (!this.rebook(p, t.inService === false ? 'not in service' : 'full')) return;
      p.state = 'waiting';
      this.S.go(p, p.pos.clone().addScaledVector(this.ctx.layout.platforms[p.platform!].inward, 2.5), () => { p.state = 'waiting'; this.faceTrack(p); }, { direct: true });
      return;
    }
    for (const f of [...p.followers]) {
      this.ctx.bus.emit('passenger:boarded', { personId: f.id, trainId });
      this.boardedTotal++;
      this.S.removeAt(f, door, `boarded ${trainId}`);
    }
    this.ctx.bus.emit('passenger:boarded', { personId: p.id, trainId });
    this.boardedTotal++;
    this.S.removeAt(p, door, `boarded ${trainId}`);
  }

  readonly missWhy: Record<string, number> = {};

  private missed(p: Person) {
    const d = (p.data.bd as number) ?? -1;
    const k = `${p.data.bs ?? '?'}:${d < 3 ? '<3' : d < 8 ? '<8' : d < 20 ? '<20' : d < 50 ? '<50' : '50+'}`;
    this.missWhy[k] = (this.missWhy[k] ?? 0) + 1;
    p.trainId = null;
    this.S.stop(p);
    if (!this.rebook(p, 'missed')) return;
    p.state = 'waiting';
    const P = this.ctx.layout.platforms[p.platform ?? 1];
    this.S.go(p, p.pos.clone().addScaledVector(P.inward, this.rng.range(1.5, 3)), () => { p.state = 'waiting'; this.faceTrack(p); }, { direct: true });
  }

  private onTrainApproaching(trainId: string, line: LineId, platform: PlatformId) {
    let t: TrainInfo | undefined;
    try { t = this.ctx.reg.trains.get(trainId); } catch { t = undefined; }
    if (!t) return;
    const dir = t.dir;
    const service = isPassengerService(t);
    if (service) this.approach.set(`${line}|${dir}`, trainId);
    // everyone on that platform glances at the approaching train
    const P = this.ctx.layout.platforms[platform];
    for (const p of this.S.list) {
      if (p.pos.y > 0.6 && Math.abs(p.pos.x - P.center.x) < 70 && Math.abs(p.pos.z - P.center.z) < 70 && !p.moving) { p.lookTrain = trainId; p.lookUntil = this.S.vt + 5 + (p.seed % 3); }
    }
    if (!service) return;
    const doors = this.predictedDoors(t);
    for (const p of this.S.list) {
      if (p.kind !== 'passenger' || p.leader || !p.alive) continue;
      if (p.line !== line || p.dir !== dir || p.platform !== platform) continue;
      if (p.data.indoorsOf) {
        // out of the waiting room and onto the platform
        this.S.reemerge(p);
        this.goReady(p, doors, true);
        continue;
      }
      if (p.state !== 'waiting' && p.state !== 'seated') continue;
      this.goReady(p, doors, false);
    }
    // family & friends come out to meet it
    this.summonMeeters(t);
  }

  /** stand back from the edge near a predicted door */
  private goReady(p: Person, doors: THREE.Vector3[], hurry: boolean) {
    if (!doors.length) return;
    let best = doors[0], bd = Infinity, second = doors[0], sd = Infinity;
    for (const d of doors) {
      const dd = d.distanceToSquared(p.pos);
      if (dd < bd) { second = best; sd = bd; best = d; bd = dd; } else if (dd < sd) { second = d; sd = dd; }
    }
    const door = this.rng.chance(0.3) ? second : best;
    const P = this.ctx.layout.platforms[p.platform!];
    const ax = Math.cos(P.yaw), az = -Math.sin(P.yaw);
    const along = this.rng.range(-1.2, 1.2);
    const spot = door.clone().addScaledVector(P.inward, this.rng.range(1.2, 2.4));
    spot.x += ax * along; spot.z += az * along;
    spot.y = P.center.y;
    this.S.freeSeat(p);
    this.S.endChat(p);
    this.S.readPaper(p, false);
    p.state = 'ready';
    this.S.go(p, spot, () => { p.state = 'ready'; this.faceTrack(p, 0.3); }, { run: hurry || p.pos.distanceTo(spot) > 30, direct: p.pos.y > 0.6 && p.pos.distanceTo(spot) < 60 });
  }

  private onTrainArrived(trainId: string, platform: PlatformId) {
    let n = 0;
    try { n = this.ctx.reg.trains.takeAlighting(trainId) ?? 0; } catch { n = 0; }
    const room = Math.max(0, Math.min(this.S.cap - this.S.total, 110 - this.S.counts.alighter));
    n = Math.min(n, MAX_ALIGHT_PER_TRAIN, room);
    if (n > 0) this.alightJobs.push({ trainId, platform, remaining: n, doors: null, t: 0.8, waited: 0, i: 0 });
  }

  private updateAlighting(dtm: number) {
    for (let j = this.alightJobs.length - 1; j >= 0; j--) {
      const job = this.alightJobs[j];
      const t = this.ctx.reg.trains.get(job.trainId);
      if (!job.doors) {
        job.waited += dtm;
        if (t && t.doorsOpen) job.doors = this.doorsFor(t);
        else if (!t || job.waited > 6) { this.alightJobs.splice(j, 1); continue; }
        else continue;
        if (!job.doors.length) { this.alightJobs.splice(j, 1); continue; }
      }
      if (!t || !t.doorsOpen) { this.alightJobs.splice(j, 1); continue; }
      job.t -= dtm;
      while (job.t <= 0 && job.remaining > 0) {
        const door = job.doors[job.i % job.doors.length];
        job.i++;
        job.remaining--;
        job.t += this.rng.range(0.25, 0.6) * (4 / Math.max(1, job.doors.length));
        this.spawnAlighter(door, job.platform, job.trainId);
      }
      if (job.remaining <= 0) this.alightJobs.splice(j, 1);
    }
  }

  private spawnAlighter(door: THREE.Vector3, plat: PlatformId, trainId: string) {
    if (!this.S.roomFor() || this.S.counts.alighter >= 120) return;
    const P = this.ctx.layout.platforms[plat];
    const pos = door.clone().addScaledVector(P.inward, -0.35);
    const p = this.S.spawnRaw('passenger', pos, 'alighter', passengerLook(this.rng));
    this.S.auditAt('spawn', door, `alighted ${trainId}`);
    p.fade = 0;
    p.fadeLeg = { from: pos.clone(), len: 0.7, dir: 'out' };
    p.state = 'alighting';
    p.platform = plat;
    p.speed *= 1.1;
    p.mood = this.rng.range(0.6, 1);
    p.yaw = yawTo(P.inward.x, P.inward.z);
    this.ctx.bus.emit('passenger:alighted', { personId: p.id, trainId });
    const step = pos.clone().addScaledVector(P.inward, this.rng.range(1.4, 2.6));
    step.x += this.rng.range(-1, 1); step.z += this.rng.range(-1, 1);
    p.path = [step]; p.pathIdx = 0;
    p.onArrive = () => {
      const go = () => this.chooseSink(p, trainId);
      if (this.rng.chance(0.2)) { p.faceYaw = this.rng.range(-3, 3); this.S.sleep(p, this.rng.range(1, 4), go); } else go();
    };
  }

  /** where does an arriving traveller go? cab rank, omnibus, home, a waiting relative… */
  private chooseSink(p: Person, trainId: string) {
    if (!p.alive) return;
    const r = this.rng.next();
    const ft = this.ctx.layout.forecourtTraffic;
    const meet = this.meeters.get(trainId)?.find((m) => m.alive && !m.data.matched && m.state === 'waiting for someone');
    if (meet && r < 0.35) {
      meet.data.matched = p.id;
      p.state = 'looking for family';
      const spot = meet.pos.clone().add(_v.set(this.rng.range(-0.6, 0.6), 0, this.rng.range(-0.6, 0.6)));
      this.S.go(p, spot, () => this.greet(p, meet));
      return;
    }
    if (r < 0.3 && ft) { this.toCabRank(p); return; }
    if (r < 0.55 && ft) { this.toOmnibus(p); return; }
    // on foot: mostly to Ashcombe, the hamlets and the lanes / towpath out of the map; the handful of houses facing
    // the forecourt take back only their own residents (≈5 % of arrivals)
    this.walkHome(p, r < 0.6 ? this.near : r < 0.85 ? this.ash : this.far);
  }

  private walkHome(p: Person, list: Cand[]) {
    let c = this.pickCand(list.length ? list : this.ash, true);
    if (!c && list !== this.ash) c = this.pickCand(this.ash, true);
    if (!c) c = this.pickCand(this.far, true);
    this.S.setKind(p, 'alighter');
    if (!c) { void this.S.dismiss(p, { state: 'heading home' }); return; }
    p.home = c.o.building;
    p.state = 'heading home';
    this.S.enter(p, c.o, { state: 'heading home' });
  }

  private toCabRank(p: Person) {
    const ft = this.ctx.layout.forecourtTraffic;
    p.state = 'queueing for a cab';
    const k = this.cabQueue.length;
    this.cabQueue.push(p);
    const spot = ft.cabQueue.clone().add(_v.set(-this.qDir.x * k * 0.9, 0, -this.qDir.z * k * 0.9));
    p.data.sinkUntil = this.now() + this.rng.range(10, 18);
    p.data.hailAt = 0;
    this.S.go(p, spot, () => { p.state = 'waiting for a cab'; p.faceYaw = ft.rank.length ? yawTo(ft.rank[0].pos.x - p.pos.x, ft.rank[0].pos.z - p.pos.z) : null; });
  }

  private toOmnibus(p: Person) {
    const ft = this.ctx.layout.forecourtTraffic;
    p.state = 'waiting for the omnibus';
    const k = this.busQueue.length;
    this.busQueue.push(p);
    const spot = ft.omnibusQueue.clone().add(_v.set(this.rng.range(-1.5, 1.5), 0, this.rng.range(-1.5, 1.5) + (k % 4) * 0.3));
    p.data.sinkUntil = this.now() + this.rng.range(15, 28);
    this.S.go(p, spot, () => { p.faceYaw = yawTo(ft.omnibus.pos.x - p.pos.x, ft.omnibus.pos.z - p.pos.z); });
  }

  /** cab / omnibus waiting logic for alighters */
  private updateSinks() {
    const traffic = this.ctx.reg.traffic;
    const now = this.now();
    for (let i = this.cabQueue.length - 1; i >= 0; i--) {
      const p = this.cabQueue[i];
      if (!p.alive || p.pathIdx < p.path.length) continue;
      if (i === 0 && traffic && now >= (p.data.hailAt as number)) {
        p.data.hailAt = now + 1.5;
        let cab: string | null = null;
        try { cab = traffic.rank().hail(p.id); } catch { cab = null; }
        const anchor = cab ? traffic.anchorOf(cab) : null;
        if (anchor) {
          this.cabQueue.splice(i, 1);
          p.state = 'taking a cab';
          void this.S.embark([p.id], anchor).then((ok) => { if (!ok && p.alive && !p.riding) this.walkHome(p, this.ash); });
          continue;
        }
      }
      if (now > (p.data.sinkUntil as number)) { this.cabQueue.splice(i, 1); this.walkHome(p, this.rng.chance(0.6) ? this.ash : this.far); }
    }
    let bus: string | null = null;
    if (this.busQueue.length && traffic) { try { bus = traffic.omnibusAt(); } catch { bus = null; } }
    const busAnchor = bus && traffic ? traffic.anchorOf(bus) : null;
    let busStopped = false;
    try { busStopped = !!busAnchor?.stopped(); } catch { busStopped = false; }
    for (let i = this.busQueue.length - 1; i >= 0; i--) {
      const p = this.busQueue[i];
      if (!p.alive || p.pathIdx < p.path.length) continue;
      if (busAnchor && busStopped) {
        this.busQueue.splice(i, 1);
        p.state = 'boarding the omnibus';
        void this.S.embark([p.id], busAnchor).then((ok) => { if (!ok && p.alive && !p.riding) this.walkHome(p, this.ash); });
        continue;
      }
      if (now > (p.data.sinkUntil as number)) { this.busQueue.splice(i, 1); this.walkHome(p, this.ash); }
    }
  }

  // ───────────────────────── meeters (family & friends) ─────────────────────────
  private summonMeeters(t: TrainInfo) {
    const h = this.ctx.clock.hour;
    if (h < 6.5 || h > 22 || this.meeters.has(t.id) || !this.S.roomFor(2) || !this.near.length) return;
    if (!this.rng.chance(0.35)) return;
    const n = this.rng.chance(0.2) ? 2 : 1;
    const arr: Person[] = [];
    const F = this.ctx.layout.forecourt;
    for (let i = 0; i < n; i++) {
      const c = this.pickCand(this.near);
      if (!c || (c.o.building && !this.canLeave(c.o.building))) break;
      const p = this.S.emerge(c.o, 'passenger', 'meeter', passengerLook(this.rng), { pool: true });
      if (!p) break;
      if (c.o.building) this.noteLeft(c.o.building, 1);
      if (p.look.child) p.look.child = false;
      p.home = c.o.building;
      const lat = this.rng.range(-5, 5);
      const spot = this.stepsNode.clone().addScaledVector(this.qDir, this.rng.range(2.5, 6));
      spot.x += Math.sin(F.yaw) * lat; spot.z += Math.cos(F.yaw) * lat;
      spot.y = 0;
      p.state = 'going to meet a train';
      p.data.meetUntil = this.now() + 60;
      const booking = this.ctx.layout.bookingOffice;
      this.S.go(p, spot, () => { p.state = 'waiting for someone'; p.idle = 'watch'; p.lookAt = booking.clone(); });
      arr.push(p);
    }
    if (arr.length) this.meeters.set(t.id, arr);
  }

  private greet(p: Person, m: Person) {
    if (!p.alive) return;
    if (!m.alive) { this.walkHome(p, this.ash); return; }
    p.faceYaw = yawTo(m.pos.x - p.pos.x, m.pos.z - p.pos.z);
    m.faceYaw = yawTo(p.pos.x - m.pos.x, p.pos.z - m.pos.z);
    m.lookAt = null; m.idle = null;
    p.manualAnim = 'wave'; m.manualAnim = 'cheer';
    p.state = m.state = 'meeting';
    this.S.sleep(p, 2.4, () => {
      if (!p.alive) return;
      p.manualAnim = null;
      if (m.alive) {
        m.manualAnim = null;
        const home = m.home ? this.S.origin(`door:${m.home}:0`) : null;
        m.state = p.state = 'heading home together';
        if (home && this.S.canAbsorb(m.home, 2) && this.rng.chance(0.3)) {
          this.S.enter(m, home);
          p.home = m.home;
          this.S.enter(p, home);
        } else if (home) { this.S.enter(m, home); this.walkHome(p, this.ash); } else { void this.S.dismiss(m); void this.S.dismiss(p); }
      } else this.walkHome(p, this.ash);
    });
  }

  private updateMeeters() {
    const now = this.now();
    for (const [tid, arr] of this.meeters) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const m = arr[i];
        if (!m.alive) { arr.splice(i, 1); continue; }
        if (m.state === 'waiting for someone' && !m.data.matched && now > (m.data.meetUntil as number)) {
          m.idle = null; m.lookAt = null;
          arr.splice(i, 1);
          this.S.enter(m, `door:${m.home}:0`, { state: 'going home alone' }) || void this.S.dismiss(m);
        }
      }
      if (!arr.length) this.meeters.delete(tid);
    }
  }

  private onTrainGone(trainId: string) {
    for (const [k, v] of this.approach) if (v === trainId) this.approach.delete(k);
    this.alightJobs = this.alightJobs.filter((j) => j.trainId !== trainId);
    this.doorsCache.delete(trainId);
    this.predCache.delete(trainId);
    const rem = this.doorOrigins.get(trainId);
    if (rem) { for (const f of rem) f(); this.doorOrigins.delete(trainId); }
    // anyone who was heading for it rebooks
    for (const p of this.S.list) {
      if (p.kind !== 'passenger' || !p.alive) continue;
      if (p.trainId === trainId) { p.trainId = null; if (p.state === 'boarding') this.missed(p); }
      // let it go without a sprint: settle down for the next one
      if (p.data.skipTrain === trainId) { p.data.skipTrain = undefined; if (!p.leader) this.rebook(p, 'let go'); }
    }
    // those left standing 'ready' at the edge with no train coming on their road settle back to a bench or a spot
    for (const p of this.S.list) {
      if (p.kind !== 'passenger' || !p.alive || p.leader || p.state !== 'ready' || p.moving) continue;
      if (!p.line || !p.dir || this.approach.has(`${p.line}|${p.dir}`)) continue;
      const P = p.platform ? this.ctx.layout.platforms[p.platform] : null;
      if (P && this.dwell.get(`${p.platform}|${p.line}|${p.dir}`)) continue;
      this.headToPlatform(p);
    }
    const ms = this.meeters.get(trainId);
    if (ms) for (const m of ms) if (m.alive) m.data.meetUntil = Math.min(m.data.meetUntil as number, this.now() + 20);
  }

  // ───────────────────────── per-passenger update ─────────────────────────
  updatePassenger(p: Person, dtm: number) {
    // children follow their leader
    if (p.leader) {
      const l = p.leader;
      if (!l.alive) p.leader = null;
      else {
        if (l.data.indoorsOf) {
          // follow into the waiting room
          if (!p.data.indoorsOf) { p.data.indoorsOf = l.data.indoorsOf; p.fade = 0; p.pos.copy(l.pos); }
          return;
        }
        if (p.data.indoorsOf) { p.data.indoorsOf = undefined; p.pos.copy(l.pos); p.fade = l.fade; p.fadeLeg = null; }
        if (l.fade < 1 && l.fadeLeg) p.fade = l.fade;
        if (p.state !== 'following') p.state = 'following';
        const cy = Math.cos(l.yaw), sy = Math.sin(l.yaw);
        const tx = l.pos.x + p.followOff.x * cy + p.followOff.z * sy;
        const tz = l.pos.z - p.followOff.x * sy + p.followOff.z * cy;
        const d = Math.hypot(tx - p.pos.x, tz - p.pos.z);
        if (d > 0.35) {
          const tgt = _v.set(tx, l.pos.y, tz);
          if (p.pathIdx >= p.path.length || d > 1.5) { p.path = [tgt.clone()]; p.pathIdx = 0; p.onArrive = null; }
          else p.path[p.path.length - 1].copy(tgt);
          p.running = d > 2.5;
          p.speedOverride = Math.max(l.running ? 2.1 : l.speed, 1.2) * (d > 1.2 ? 1.25 : 1);
        } else if (p.pathIdx >= p.path.length) {
          p.faceYaw = l.faceYaw ?? l.yaw;
        }
        p.sitTarget = 0;
        return;
      }
      // orphaned child: go home
      void this.S.dismiss(p, { state: 'going home' });
      return;
    }
    const s = p.state;
    if (s === 'following') { void this.S.dismiss(p, { state: 'going home' }); return; }
    if (s === 'waiting' || s === 'seated' || s === 'ready' || s === 'queueing' || s === 'buying' || s === 'toPlatform' || s === 'toStation') {
      const t = this.matchingTrain(p);
      if (t && (s === 'waiting' || s === 'seated' || s === 'ready')) { this.startBoarding(p, t); return; }
      if (t && (s === 'queueing' || s === 'buying')) {
        // train in: abandon the queue and pay on board if the platform is close enough
        const q = this.queue.indexOf(p);
        if (q >= 0) this.queue.splice(q, 1);
        p.hasTicket = true;
        this.startBoarding(p, t);
        return;
      }
      if (t && (s === 'toPlatform' || s === 'toStation')) {
        const end = p.path[p.path.length - 1];
        if (end && Math.hypot(end.x - p.pos.x, end.z - p.pos.z) < 80) { p.running = true; p.trainId = t.id; if (Math.hypot(end.x - p.pos.x, end.z - p.pos.z) < 45 && p.pos.y > 0.6) { this.startBoarding(p, t); return; } }
      }
      if (!t && (s === 'toPlatform' || s === 'toStation') && p.trainId) { p.trainId = null; }
      // patience: only decays once the train they aimed for is late
      this.patienceTick(p, dtm, s);
      if (!p.alive || p.state !== s) return;
      // out of the rain / a long wait → the waiting room
      if ((s === 'waiting' || s === 'seated') && p.pathIdx >= p.path.length && p.wait <= 0) {
        p.shelterCheck -= dtm;
        if (p.shelterCheck <= 0) {
          p.shelterCheck = this.rng.range(3, 6);
          const dep = this.depFor(p.line!, p.dir!, this.now() - 2);
          const waitMin = dep ? dep.expected - this.now() : 999;
          const cold = (this.ctx.reg.atmosphere?.temperatureC ?? 12) < 4;
          const wet = this.S.wetness() > 0.35;
          const announced = this.approach.has(`${p.line}|${p.dir}`);
          if (announced) { this.readyIfAnnounced(p); return; }
          if (!announced && waitMin > WAITING_ROOM_MIN && (wet || cold || waitMin > 120 || (this.ctx.reg.atmosphere?.nightFactor ?? 0) > 0.7) && this.rng.chance(0.5)) {
            this.toWaitingRoom(p);
          } else if (wet && !this.S.sheltered(p.pos) && !p.seat) {
            const spot = this.chooseSpot(p);
            p.state = 'toPlatform';
            this.S.go(p, spot.pos, () => this.arriveAtSpot(p, spot.seat), { direct: true });
            if (spot.seat) { spot.seat.taken = p; p.seat = spot.seat; }
          }
        }
      }
    } else if (s === 'boarding') {
      const t = p.trainId ? this.ctx.reg.trains.get(p.trainId) : undefined;
      if (!t || !t.doorsOpen || t.platform == null) this.missed(p);
    }
  }

  private patienceTick(p: Person, dtm: number, s: string) {
    if (s === 'toPlatform' || s === 'toStation') return;
    const now = this.now();
    const dep = this.depFor(p.line!, p.dir!, now - 2);
    if (!dep) {
      // nothing posted in this direction at all (yet): wait patiently, give up only after a long while
      p.patience -= dtm / 400;
    } else {
      if (dep.cancelled) { if (!this.rebook(p, 'cancelled')) return; }
      else if (dep.expected - now > (s === 'waitingRoom' ? MAX_POSTED_WAIT + 90 : MAX_POSTED_WAIT)) { if (!this.rebook(p, 'wait')) return; }
      const late = now - (p.aim + 3);
      if (late > 0) {
        let rate = 1 / p.tolerance;
        if (!this.S.shelteredCached(p)) { const w = this.ctx.reg.atmosphere?.weather; rate *= w === 'storm' ? 2 : w === 'rain' || w === 'snow' ? 1.5 : 1; }
        if (s === 'seated') rate *= 0.8;
        p.patience -= rate * dtm;
      }
    }
    if (p.patience <= 0) this.giveUp(p, dep ? 'patience' : 'nodep');
  }

  private toWaitingRoom(p: Person) {
    const door = p.platform === 2 ? 'door:station:p2' : 'door:station:p1';
    this.S.freeSeat(p);
    p.state = 'toWaitingRoom';
    this.S.enter(p, door, { keep: true, then: () => { p.state = 'waitingRoom'; } });
  }

  /** passengers sitting in the waiting room */
  indoorsTick(p: Person, dtm: number) {
    if (p.leader) {
      const l = p.leader;
      if (!l.alive || !l.data.indoorsOf) { p.data.indoorsOf = undefined; p.pos.copy(l.alive ? l.pos : p.pos); p.fade = l.alive ? l.fade : 1; }
      return;
    }
    const now = this.now();
    const dep = p.line && p.dir ? this.depFor(p.line, p.dir, now - 2) : undefined;
    this.patienceTick(p, dtm * 0.6, 'waitingRoom');
    if (!p.alive || !p.data.indoorsOf) return;
    const announced = !!p.line && this.approach.has(`${p.line}|${p.dir}`);
    // walking from the waiting-room door to the far end of a platform takes up to ~60 motion-s
    if (announced || (dep && dep.expected - now < 75)) {
      this.S.reemerge(p);
      p.state = 'toPlatform';
      if (announced) { const f = p.onArrive; p.onArrive = () => { f?.(); if (!this.readyIfAnnounced(p, true)) this.headToPlatform(p); }; return; }
      const spot = this.chooseSpot(p);
      const pp = p;
      p.onArrive = () => { pp.state = 'toPlatform'; this.S.go(pp, spot.pos, () => this.arriveAtSpot(pp, spot.seat)); };
      if (spot.seat) { spot.seat.taken = p; p.seat = spot.seat; }
    }
  }

  /** passengers riding a vehicle: step down at the forecourt */
  riderTick(p: Person) {
    const r = p.riding;
    if (!r) return;
    let stopped = false;
    try { stopped = r.anchor.stopped(); } catch { stopped = false; }
    if (!stopped) return;
    const ft = this.ctx.layout.forecourtTraffic;
    const nearDrop = ft && (p.pos.distanceTo(ft.dropOff.pos) < 14 || p.pos.distanceTo(ft.omnibus.pos) < 14 || p.pos.distanceTo(this.ctx.layout.entrance) < 12);
    if (nearDrop && p.line) this.S.disembarkOne(p, 'passenger');
  }

  // ───────────────────────── system tick ─────────────────────────
  update(_dt: number, dtm: number, dtSim: number) {
    this.refreshDeps();
    this.updateDwell();
    if (dtSim > 0) {
      this.spawnAcc += this.spawnRate() * dtSim;
      if (this.spawnAcc > 5) this.spawnAcc = 5;
      let guard = 0;
      while (this.spawnAcc >= 1 && guard++ < 4) {
        const size = this.groupSize();
        if (this.S.counts.passenger >= this.maxPassengers || !this.S.roomFor(size + 6)) { this.spawnAcc = 0; break; }
        this.spawnAcc -= Math.max(1, this.spawnGroup(size));
      }
    }
    if (dtm > 0) {
      this.updateQueue(dtm);
      this.updateRetries();
      this.updateAlighting(dtm);
      this.updateSinks();
      this.updateMeeters();
    }
    // committed boarders (for trains' dwell discipline)
    this.pending.clear();
    for (const p of this.S.list) {
      if (p.kind !== 'passenger' || !p.trainId) continue;
      if (p.state === 'boarding' || p.running) {
        const n = 1 + p.followers.length;
        this.pending.set(p.trainId, (this.pending.get(p.trainId) ?? 0) + n);
      }
    }
    const now = this.now();
    if (this.S.counts.passenger > 180 && now - this.lastCrowdGazette > 1440) {
      this.lastCrowdGazette = now;
      this.ctx.bus.emit('gazette', { headline: this.rng.pick([
        'Record throngs at the Junction: porters "run off their feet"',
        'Crush on the platforms as half the county takes to the rails',
        'Stationmaster pleads for order amid unprecedented crowds',
      ]), kind: 'info' });
    }
  }

  pendingFor(trainId: string): number { return this.pending.get(trainId) ?? 0; }

  /** longest remaining walk (sim minutes) of passengers committed to this train (≤ 5 min away) */
  boardingEta(trainId: string): number {
    const t = this.ctx.reg.trains?.get(trainId);
    if (!t) return 0;
    let worst = 0;
    for (const p of this.S.list) {
      if (p.kind !== 'passenger' || p.leader) continue;
      if (p.trainId !== trainId && !(p.line === t.line && p.dir === t.dir && (p.state === 'toPlatform' || p.state === 'ready' || p.state === 'boarding'))) continue;
      let rem = 0;
      if (p.pathIdx < p.path.length) {
        let prev = p.pos;
        for (let i = p.pathIdx; i < p.path.length; i++) { rem += Math.hypot(p.path[i].x - prev.x, p.path[i].z - prev.z); prev = p.path[i]; }
      }
      const min = rem / (p.running ? 2.1 : p.speed);
      if (min <= 5 && min > worst) worst = min;
    }
    return worst;
  }

  waitingCount(): number {
    let n = 0;
    for (const p of this.S.list) if (p.kind === 'passenger' && (p.state === 'waiting' || p.state === 'seated' || p.state === 'ready' || p.state === 'waitingRoom')) n++;
    return n;
  }
}
