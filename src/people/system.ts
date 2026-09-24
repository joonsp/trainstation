import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { Anchor, IdleStyle, PeopleAPI, PersonAnim, PersonInfo, PersonRole, PersonSpec } from '../core/apis';
import type { Origin, LifeKind } from '../core/origins';
import type { Rng } from '../core/rng';
import { PeopleRenderer } from './render';
import type { AccKind } from './geometry';
import { passengerLook, personName, roleLook, type Look } from './looks';
import { computePose, out as poseOut } from './anim';
import type { Kind, Person, RidePose, Step } from './types';
import { Passengers } from './passengers';
import { Staff } from './staff';
import { Town } from './town';

// ───────────────────────── tuning ─────────────────────────
export const WALK = 1.35;
export const HURRY = 2.1;
export const RUN = 3.3;
/** gentle diorama exaggeration so figures read at the default iso zoom */
const PERSON_SCALE = 1.1;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _mSeat = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _s = new THREE.Vector3();
const _anim = new THREE.Vector4();
const _arm = new THREE.Vector4();
const _aux = new THREE.Vector4();
const _env = { cold: false, night: false, lookX: 0, lookZ: 0, hasLook: false };
const _col = new THREE.Color();

export const angDiff = (a: number, b: number) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
export const yawTo = (dx: number, dz: number) => Math.atan2(dx, dz);

const STAFF_ROLES: PersonRole[] = ['porter', 'stationmaster', 'guard', 'mechanic', 'clerk', 'signalman', 'crew'];
const STATION_DOORS = ['door:station:east', 'door:station:p1', 'door:station:p2'];
const DRIVER_ROLES: PersonRole[] = ['cabman', 'coachman', 'drayman', 'carter', 'milkman', 'motorist', 'postman', 'bargee', 'firefighter'];
const TOWN_ROLES: PersonRole[] = ['townsfolk', 'child', 'schoolchild', 'vendor', 'publican', 'drinker', 'vicar', 'washerwoman', 'baker', 'blacksmith', 'miller', 'angler', 'farmhand', 'shepherd', 'ploughman', 'dairymaid', 'skater', 'rower', 'punter', 'bargee', 'lockkeeper', 'milkman', 'postman'];
/** an actor nobody has moved for this long (sim min) was forgotten by its owner: send it home */
const ACTOR_IDLE_LIMIT = 240;

interface EmbarkGroup { pending: number; ok: boolean; resolve: (ok: boolean) => void }

export class PeopleSystem {
  readonly api: PeopleAPI;
  readonly rng: Rng;
  readonly renderer: PeopleRenderer;
  readonly persons = new Map<string, Person>();
  readonly byNum = new Map<number, Person>();
  readonly list: Person[] = [];
  readonly counts: Record<Kind, number> = { passenger: 0, alighter: 0, staff: 0, actor: 0, idler: 0, guard: 0, town: 0, meeter: 0 };
  readonly capacity: number;
  readonly cap: number;
  vt = 0;
  private lastWriteVt = 0;
  private lowTier = false;
  private detourCache = new Map<string, number>();
  private riders = new Map<string, Person[]>();
  private routeCache = new Map<number, THREE.Vector3[]>();
  private fbA: THREE.Vector3;
  private fbB: THREE.Vector3;
  private fbRoute: THREE.Vector3[];
  private unsubs: (() => void)[] = [];
  private nextNum = 1;
  private warm = true;
  readonly passengers: Passengers;
  readonly staff: Staff;
  readonly town: Town;
  private embarkGroups = new Map<Person, EmbarkGroup>();
  private lookCues: { pos: THREE.Vector3; until: number; r: number }[] = [];

  constructor(readonly ctx: Ctx) {
    this.rng = ctx.rng.fork(0x9e0e1e);
    const q = ctx.quality?.knobs;
    this.cap = q?.caps.people ?? 360;
    this.capacity = this.cap + 60;
    this.renderer = new PeopleRenderer(ctx.renderer, this.capacity, ctx.quality?.tier === 'low');
    this.lowTier = ctx.quality?.tier === 'low';
    this.renderer.onFrame = () => this.writeInstances();
    ctx.scene.add(this.renderer.group);
    const L = ctx.layout;
    this.fbA = (L.nav.nodes.fbA ?? L.footbridge.a).clone();
    this.fbB = (L.nav.nodes.fbB ?? L.footbridge.b).clone();
    this.fbRoute = L.footbridge.route.slice(1, -1).map((v) => v.clone());

    this.passengers = new Passengers(this);
    this.staff = new Staff(this);
    this.town = new Town(this);
    this.api = this.buildApi();
    // debug handle (not part of the contract): __station.ctx.reg.people._debug
    Object.defineProperty(this.api, '_debug', { value: { sys: this, giveUpWhy: this.passengers.giveUpWhy, missWhy: this.passengers.missWhy }, enumerable: false });

    this.unsubs.push(
      ctx.bus.on('audio:cue', (e) => {
        if (!e.pos) return;
        const c = e.cue;
        if (c === 'whistle' || c === 'bell' || c === 'horse' || c === 'motor' || c === 'shout' || c === 'crossingBell' || c === 'cheer'
          || c === 'band' || c === 'fanfare' || c === 'honk' || c === 'moo' || c === 'pistol' || c === 'churchPeal' || c === 'boatWhistle' || c === 'dog' || c === 'splash') {
          if (this.lookCues.length < 8) this.lookCues.push({ pos: e.pos.clone(), until: this.vt + 2.5 + Math.random() * 1.5, r: c === 'whistle' || c === 'churchPeal' ? 90 : 45 });
        }
      }),
    );
  }

  // ───────────────────────── helpers ─────────────────────────
  get clock() { return this.ctx.clock; }
  get layout() { return this.ctx.layout; }
  get total() { return this.list.length; }
  roomFor(n = 1): boolean { return this.list.length + n <= this.cap; }

  /** origins helper: resolve an origin id (also accepts traffic vehicle ids via 'veh:' prefix) */
  origin(id: string | undefined): Origin | undefined {
    if (!id) return undefined;
    return this.ctx.origins.get(id) ?? this.ctx.origins.get(`veh:${id}`) ?? this.ctx.origins.get(`vehicle:${id}`);
  }

  /** point just inside an origin (≤ 1 m in from the threshold) */
  insidePoint(o: Origin, out: THREE.Vector3): THREE.Vector3 {
    o.pos(out);
    if (!o.inside) return out;
    o.inside(_v3);
    const dx = _v3.x - out.x, dy = _v3.y - out.y, dz = _v3.z - out.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return out;
    const k = Math.min(1, 1.0 / d);
    out.x += dx * k; out.z += dz * k; out.y += dy * k;
    return out;
  }

  // ───────────────────────── creation / removal ─────────────────────────
  /** raw creation (no audit) — callers pair it with emerge()/audit or warm placement */
  spawnRaw(role: PersonRole, pos: THREE.Vector3, kind: Kind, look?: Look): Person {
    const r = this.rng;
    const L = look ?? roleLook(role, r);
    const num = this.nextNum++;
    const id = `p${num}`;
    const p: Person = {
      num, id, name: personName(role, L, r), role, look: L, kind, state: 'idle',
      pos: pos.clone(), yaw: r.range(-Math.PI, Math.PI), faceYaw: null,
      path: [], pathIdx: 0, speed: WALK * r.range(0.88, 1.12) * (L.child ? 1.08 : 1), speedOverride: undefined, running: false, onArrive: null, walkResolve: null,
      wait: 0, onWait: null,
      manualAnim: null, phase: r.range(0, 6.28), moving: false, sit: 0, sitTarget: 0, seed: r.next() * 100,
      seat: null,
      fade: 1, fadeLeg: null, idle: null, clip: 0, clipT: 0, clipDur: 1, nextClip: r.range(0.5, 5), clipSign: 1,
      headYaw: 0, headPitch: 0, glanceYaw: 0, glancePitch: 0, glanceT: r.range(0, 3), rollBias: 0,
      lookAt: null, lookTrain: null, lookUntil: 0, riding: null,
      patience: r.range(0.75, 1), mood: 0.8, hasTicket: false, trainId: null, refused: null,
      leader: null, followers: [], followOff: new THREE.Vector3(),
      umbrella: false, shelterCheck: r.range(0, 1),
      lane: new THREE.Vector3(r.range(-0.75, 0.75), 0, r.range(-0.75, 0.75)),
      aim: 0, tolerance: r.range(100, 200),
      script: null, stepIdx: 0, stepT: 0, stepStarted: false, scriptDone: null,
      cols: new Float32Array(21), accSlots: {}, accCols: {}, tempProps: [],
      info: null as unknown as PersonInfo,
      data: {}, alive: true,
    };
    p.info = { id, name: p.name, role, state: p.state, mood: p.mood, patience: p.patience, position: p.pos, umbrella: false };
    const c = L.colors;
    for (let k = 0; k < 4; k++) { _col.setHex(c[k]); p.cols[k * 3] = _col.r; p.cols[k * 3 + 1] = _col.g; p.cols[k * 3 + 2] = _col.b; }
    for (let k = 0; k < 3; k++) { _col.setHex(L.hatColors[k]); p.cols[12 + k * 3] = _col.r; p.cols[13 + k * 3] = _col.g; p.cols[14 + k * 3] = _col.b; }
    for (const a of L.accs) this.addAcc(p, a);
    this.persons.set(id, p);
    this.byNum.set(num, p);
    this.list.push(p);
    this.counts[kind]++;
    return p;
  }

  /**
   * Create a person INSIDE a legitimate origin and let them step out through it (fade-in over the threshold).
   * Returns null when the origin is unknown, closed, or the population cap is reached.
   */
  emerge(origin: Origin | string, role: PersonRole, kind: Kind, look?: Look, opts: { pool?: boolean; force?: boolean } = {}): Person | null {
    const o = typeof origin === 'string' ? this.origin(origin) : origin;
    if (!o) return null;
    if (!opts.force && !this.roomFor()) return null;
    if (!o.open()) return null;
    const threshold = o.pos(new THREE.Vector3());
    const start = this.insidePoint(o, new THREE.Vector3());
    if (opts.pool && o.building) this.ctx.origins.pools.take(o.building, 1);
    const p = this.spawnRaw(role, start, kind, look);
    this.auditAt('spawn', threshold, `${role}@${o.id}`);
    p.originId = o.id;
    if (o.kind === 'door' || o.kind === 'vehicle' || o.kind === 'train') {
      const len = Math.max(0.3, start.distanceTo(threshold));
      if (len > 0.05) {
        p.fade = 0;
        p.fadeLeg = { from: start.clone(), len, dir: 'out' };
        p.path = [threshold.clone()]; p.pathIdx = 0;
        p.yaw = yawTo(threshold.x - start.x, threshold.z - start.z);
      }
      if (o.kind === 'door') {
        try { this.ctx.reg.world?.openDoor(o.id); } catch { /* stub */ }
        this.ctx.bus.emit('person:door', { personId: p.id, originId: o.id, dir: 'out' });
      }
    }
    return p;
  }

  /** audit a spawn/despawn; `pos` should be the origin threshold */
  auditAt(what: 'spawn' | 'despawn', pos: THREE.Vector3, label?: string): boolean {
    const kind: LifeKind = 'people';
    if (this.warm) return true;
    return this.ctx.origins.audit('people', what, kind, pos, label);
  }

  /** walk to a door/sink and fade through it; the person is removed on arrival (or kept hidden with keep) */
  enter(p: Person, origin: Origin | string, opts: { keep?: boolean; run?: boolean; state?: string; then?: () => void } = {}): boolean {
    const o = typeof origin === 'string' ? this.origin(origin) : origin;
    if (!o) return false;
    const threshold = o.pos(new THREE.Vector3());
    const inside = this.insidePoint(o, new THREE.Vector3());
    if (opts.state) p.state = opts.state;
    p.data.entering = o.id;
    const moving = o.kind === 'train' || o.kind === 'vehicle' || o.kind === 'boat';
    /** a moving origin (train door, cab, boat) closed while we walked: carry on to another sink instead */
    const reroute = (): boolean => {
      if (o.open() && this.ctx.origins.get(o.id) === o) return false;
      p.fadeLeg = null; p.fade = 1;
      p.data.entering = undefined;
      if (opts.keep) { opts.then?.(); return true; }
      const alt = this.sinkFor(p);
      if (alt && alt.id !== o.id) this.enter(p, alt, { run: opts.run, state: opts.state, then: opts.then });
      else opts.then?.();
      return true;
    };
    const inStep = () => {
      if (!p.alive) return;
      if (moving) { if (reroute()) return; o.pos(threshold); this.insidePoint(o, inside); }
      const len = Math.max(0.3, threshold.distanceTo(inside));
      p.fadeLeg = { from: p.pos.clone(), len, dir: 'in' };
      p.path = [inside.clone()]; p.pathIdx = 0; p.running = false;
      p.onArrive = () => {
        if (moving && !opts.keep && reroute()) return;
        p.fadeLeg = null;
        p.fade = 0;
        if (o.kind === 'door') {
          try { this.ctx.reg.world?.openDoor(o.id); } catch { /* stub */ }
          this.ctx.bus.emit('person:door', { personId: p.id, originId: o.id, dir: 'in' });
          if (o.building && (p.kind === 'town' || p.home === o.building || p.kind === 'staff')) this.ctx.origins.pools.enter(o.building, 1);
        }
        if (opts.keep) {
          p.state = p.state === 'entering' ? 'indoors' : p.state;
          p.data.indoorsOf = o.id;
          p.data.entering = undefined;
          opts.then?.();
        } else {
          this.auditAt('despawn', threshold, `${p.role}@${o.id}`);
          opts.then?.();
          this.remove(p);
        }
      };
    };
    this.go(p, threshold, inStep, { run: opts.run, staff: this.isStaffRole(p.role) });
    return true;
  }

  /** step a kept-indoors person back out through the door they entered */
  reemerge(p: Person): void {
    const o = this.origin(p.data.indoorsOf as string | undefined);
    p.data.indoorsOf = undefined;
    if (!o) { p.fade = 1; return; }
    const threshold = o.pos(new THREE.Vector3());
    const start = this.insidePoint(o, new THREE.Vector3());
    p.pos.copy(start);
    p.fade = 0;
    p.fadeLeg = { from: start.clone(), len: Math.max(0.3, start.distanceTo(threshold)), dir: 'out' };
    p.path = [threshold.clone()]; p.pathIdx = 0; p.onArrive = null;
    if (o.kind === 'door') {
      try { this.ctx.reg.world?.openDoor(o.id); } catch { /* stub */ }
      this.ctx.bus.emit('person:door', { personId: p.id, originId: o.id, dir: 'out' });
    }
  }

  isStaffRole(r: PersonRole): boolean { return STAFF_ROLES.includes(r); }

  /** best sink door/portal for this person (home first) */
  /** residents (and a visitor or two) only: a building takes people back up to about its residents count */
  canAbsorb(building: string | undefined, n = 1): boolean {
    if (!building) return true;
    const b = this.buildingById(building);
    if (!b) return true;
    const res = b.residents ?? 0;
    if (res <= 0) return false;
    return this.ctx.origins.pools.count(building) + n <= res + 1;
  }
  private bById: Map<string, { residents?: number; town?: string }> | null = null;
  buildingById(id: string): { residents?: number; town?: string } | undefined {
    if (!this.bById) { this.bById = new Map(); for (const b of this.ctx.layout.buildings) this.bById.set(b.id, b as { residents?: number; town?: string }); }
    return this.bById.get(id);
  }
  /** door origins a traveller (passenger / alighter / actor) should not vanish into: full or empty houses, and the
   *  station-side buildings facing the forecourt (arrivals leave by cab, omnibus, or on foot to the villages) */
  private travellerExclude(): string[] {
    const now = this.ctx.clock.minutes;
    if (this.exclCache && now - this.exclCache.at < 2) return this.exclCache.ids;
    const ids = [...STATION_DOORS];
    for (const o of this.ctx.origins.list({ kind: 'door', for: 'people' })) {
      if (!o.building) continue;
      const b = this.buildingById(o.building);
      if (!b) continue;
      if (b.town === 'station' || !this.canAbsorb(o.building)) ids.push(o.id);
    }
    this.exclCache = { at: now, ids };
    return ids;
  }
  private exclCache: { at: number; ids: string[] } | null = null;

  sinkFor(p: Person): Origin | null {
    const O = this.ctx.origins;
    const home = p.home ? this.origin(`door:${p.home}:0`) : undefined;
    const resident = p.kind === 'town' || this.isStaffRole(p.role);
    if (home && home.open() && (resident || this.canAbsorb(p.home))) {
      // unless home is a huge detour away (over the river and the railway): then the nearest sensible door or lane end
      const hp = home.pos(_v2);
      const straight = Math.hypot(hp.x - p.pos.x, hp.z - p.pos.z);
      let walk = straight;
      if (straight > 60) {
        const key = `${p.home}|${Math.round(p.pos.x / 15)},${Math.round(p.pos.z / 15)}`;
        const c = this.detourCache.get(key);
        if (c !== undefined) walk = c;
        else {
          try { walk = this.ctx.layout.walk.length(p.pos, hp); } catch { walk = straight; }
          if (this.detourCache.size > 2000) this.detourCache.clear();
          this.detourCache.set(key, walk);
        }
      }
      if (walk < 200 || walk < straight * 3) return home;
    }
    const back = this.origin(p.originId);
    if (back && back.open() && (back.kind === 'door' || back.kind === 'portal') && back.pos(_v).distanceTo(p.pos) < 420
      && (resident || back.kind === 'portal' || this.canAbsorb(back.building))) return back;
    const staff = this.isStaffRole(p.role);
    return O.bestFor(p.pos, 'people', { kinds: ['door', 'portal'], role: p.role, exclude: staff ? undefined : resident ? STATION_DOORS : this.travellerExclude() })
      ?? O.nearest(p.pos, 'people', { kinds: ['door', 'portal'], role: p.role });
  }

  /** walk to the best sink and leave the world there */
  dismiss(p: Person, opts: { to?: string; run?: boolean; state?: string } = {}): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!p.alive) { resolve(); return; }
      this.releaseAll(p);
      { const sr = p.data.summonResolve as ((ok: boolean) => void) | undefined; if (p.state === 'summoned') sr?.(false); }
      const o = (opts.to ? this.origin(opts.to) : undefined) ?? this.sinkFor(p);
      p.script = null;
      p.manualAnim = null; p.idle = null;
      this.clearTempProps(p);
      if (!o) {
        // no sink at all (should not happen): wander off the visible playfield edge-ward and hope for a portal
        const e = this.ctx.origins.nearest(p.pos, 'people', { kinds: ['portal'] });
        if (!e) { resolve(); return; }
        this.enter(p, e, { run: opts.run, state: opts.state ?? 'leaving', then: resolve });
        return;
      }
      if (!this.enter(p, o, { run: opts.run, state: opts.state ?? 'leaving', then: resolve })) resolve();
    });
  }

  /** remove immediately (boarding a train / riding off in a vehicle): audits at `at` (the legit origin threshold) */
  removeAt(p: Person, at: THREE.Vector3, label: string) {
    this.auditAt('despawn', at, label);
    this.remove(p);
  }

  setKind(p: Person, k: Kind) {
    if (p.kind === k) return;
    this.counts[p.kind]--;
    p.kind = k;
    this.counts[k]++;
  }

  remove(p: Person) {
    if (!p.alive) return;
    this.endChat(p);
    p.alive = false;
    this.counts[p.kind]--;
    for (const a of Object.keys(p.accSlots) as AccKind[]) this.removeAcc(p, a);
    this.passengers.onRemoved(p);
    this.staff.onRemoved(p);
    this.town.onRemoved(p);
    this.unride(p);
    // children leave with their guardian
    for (const f of [...p.followers]) {
      f.leader = null;
      if (f.alive && f.kind === 'passenger') { this.auditAt('despawn', p.pos, `${f.role} with guardian`); this.remove(f); }
    }
    p.followers.length = 0;
    if (p.leader) { const i = p.leader.followers.indexOf(p); if (i >= 0) p.leader.followers.splice(i, 1); p.leader = null; }
    this.persons.delete(p.id);
    this.byNum.delete(p.num);
    const i = this.list.indexOf(p);
    if (i >= 0) { this.list[i] = this.list[this.list.length - 1]; this.list.pop(); }
    const eg = this.embarkGroups.get(p);
    if (eg) { this.embarkGroups.delete(p); this.settleEmbark(eg, false); }
    const res = p.walkResolve; p.walkResolve = null; p.onArrive = null; p.onWait = null;
    res?.();
    // a summons still pending never settles otherwise
    const sr = p.data.summonResolve as ((ok: boolean) => void) | undefined; p.data.summonResolve = undefined;
    sr?.(false);
  }

  // ───────────────────────── props ─────────────────────────
  addAcc(p: Person, a: AccKind) {
    if (p.accSlots[a] !== undefined) return;
    p.accSlots[a] = 0;
    const col = a === 'umbrella' ? [p.look.umbrellaColor, 0, 0] : (p.look.accColors[a] ?? [0x6a5a48, 0x6a5a48, 0x6a5a48]);
    const f = new Float32Array(9);
    for (let k = 0; k < 3; k++) { _col.setHex(col[k]); f[k * 3] = _col.r; f[k * 3 + 1] = _col.g; f[k * 3 + 2] = _col.b; }
    p.accCols[a] = f;
  }

  removeAcc(p: Person, a: AccKind) {
    if (p.accSlots[a] === undefined) return;
    delete p.accSlots[a];
    delete p.accCols[a];
  }

  setTempProps(p: Person, props: AccKind[] | undefined) {
    this.clearTempProps(p);
    if (!props) return;
    for (const a of props) {
      if (p.accSlots[a] !== undefined) continue;
      this.addAcc(p, a);
      p.tempProps.push(a);
    }
  }

  clearTempProps(p: Person) {
    for (const a of p.tempProps) this.removeAcc(p, a);
    p.tempProps.length = 0;
  }

  // ───────────────────────── movement ─────────────────────────
  /** walking route via the unified walk graph (cached), with the footbridge lift and lane offsets */
  route(from: THREE.Vector3, target: THREE.Vector3, opts: { direct?: boolean; staff?: boolean; lane?: THREE.Vector3 } = {}): THREE.Vector3[] {
    const dd = Math.hypot(target.x - from.x, target.z - from.z);
    if (opts.direct || dd < 6) return [target.clone()];
    const W = this.ctx.layout.walk;
    const staff = !!opts.staff;
    let s: number, g: number;
    try { s = W.nearest(from, { staff }); g = W.nearest(target, { staff }); } catch { return [target.clone()]; }
    if (s === g) return [target.clone()];
    const key = (s * 4096 + g) * 2 + (staff ? 1 : 0);
    let nodes = this.routeCache.get(key);
    if (!nodes) {
      try { nodes = W.path(W.nodes[s], W.nodes[g], { staff }); } catch { nodes = []; }
      if (this.routeCache.size > 3000) this.routeCache.clear();
      this.routeCache.set(key, nodes);
    }
    if (nodes.length < 2) return [target.clone()];
    let len = 0;
    for (let i = 1; i < nodes.length; i++) len += nodes[i].distanceTo(nodes[i - 1]);
    if (dd < 40 && len > dd * 4 + 60) return [target.clone()];
    const out: THREE.Vector3[] = [];
    const lane = opts.lane;
    const isA = (v: THREE.Vector3) => v.distanceToSquared(this.fbA) < 1e-3;
    const isB = (v: THREE.Vector3) => v.distanceToSquared(this.fbB) < 1e-3;
    for (let i = 0; i < nodes.length; i++) {
      const q = nodes[i];
      if (i > 0) {
        const prev = nodes[i - 1];
        if (isA(prev) && isB(q)) out.push(...this.fbRoute.map((v) => v.clone()));
        else if (isB(prev) && isA(q)) for (let k = this.fbRoute.length - 1; k >= 0; k--) out.push(this.fbRoute[k].clone());
      }
      const c = q.clone();
      if (lane && i > 0 && i < nodes.length - 1) { c.x += lane.x; c.z += lane.z; }
      out.push(c);
    }
    out.push(target.clone());
    // drop leading waypoints that are behind us (we're already past the nearest node)
    while (out.length >= 3) {
      const a = out[0], b = out[1];
      const tax = a.x - from.x, taz = a.z - from.z, abx = b.x - a.x, abz = b.z - a.z;
      if (tax * abx + taz * abz < 0 && Math.hypot(tax, taz) < 12 && Math.abs(a.y - from.y) < 0.3) out.shift();
      else break;
    }
    return out;
  }

  go(p: Person, target: THREE.Vector3, onArrive: (() => void) | null, opts: { speed?: number; run?: boolean; direct?: boolean; staff?: boolean } = {}) {
    p.path = this.route(p.pos, target, { direct: opts.direct, staff: opts.staff ?? this.isStaffRole(p.role), lane: p.lane });
    p.pathIdx = 0;
    p.running = !!opts.run;
    p.speedOverride = opts.speed;
    p.onArrive = onArrive;
    p.faceYaw = null;
    this.stand(p);
  }

  stop(p: Person) { p.path = []; p.pathIdx = 0; p.onArrive = null; p.running = false; }

  stand(p: Person) {
    if (p.seat) this.freeSeat(p);
    p.sitTarget = 0;
  }

  /** open (or fold away) a newspaper */
  readPaper(p: Person, on: boolean) {
    if (on) { if (p.accSlots.umbrella === undefined && p.accSlots.trolley === undefined) { this.addAcc(p, 'newspaper'); p.data.paper = true; } }
    else if (p.data.paper) { this.removeAcc(p, 'newspaper'); p.data.paper = false; }
  }

  /** strike up a conversation with a waiting stranger close by (both turn to face each other) */
  chatWithNeighbour(p: Person): boolean {
    if (!this.rng.chance(0.3)) return false;
    for (const q of this.list) {
      if (q === p || q.kind !== p.kind || q.state !== 'waiting' || q.data.chatWith || q.leader || q.moving) continue;
      const dx = q.pos.x - p.pos.x, dz = q.pos.z - p.pos.z;
      if (dx * dx + dz * dz > 7 || Math.abs(q.pos.y - p.pos.y) > 0.3) continue;
      p.data.chatWith = q; q.data.chatWith = p;
      p.idle = 'chat'; q.idle = 'chat';
      this.readPaper(q, false);
      p.faceYaw = yawTo(dx, dz); q.faceYaw = yawTo(-dx, -dz);
      p.nextClip = 0.3; q.nextClip = 1.2;
      return true;
    }
    return false;
  }

  endChat(p: Person) {
    const q = p.data.chatWith as Person | undefined;
    if (!q) return;
    p.data.chatWith = undefined; if (p.idle === 'chat') p.idle = null;
    if (q.data.chatWith === p) { q.data.chatWith = undefined; if (q.idle === 'chat') q.idle = null; }
  }

  freeSeat(p: Person) {
    if (p.seat && p.data.paper) this.readPaper(p, false);
    if (p.seat && p.seat.taken === p) p.seat.taken = null;
    p.seat = null;
    p.sitTarget = 0;
  }

  sleep(p: Person, sec: number, cb: () => void) { p.wait = sec; p.onWait = cb; }

  private moveStep(p: Person, dtm: number, dt: number) {
    if (p.pathIdx >= p.path.length) { p.moving = false; return; }
    const base = p.speedOverride ?? (p.running ? (p.kind === 'passenger' || p.kind === 'alighter' ? HURRY : RUN) : p.speed);
    let weatherBoost = 1;
    if (!p.umbrella && (p.kind === 'passenger' || p.kind === 'alighter' || p.kind === 'town')) {
      const a = this.ctx.reg.atmosphere;
      if (a && a.rain > 0.5) weatherBoost = 1.2;
    }
    let dist = base * weatherBoost * dtm;
    const travelled = dist;
    while (dist > 0 && p.pathIdx < p.path.length) {
      const t = p.path[p.pathIdx];
      const dx = t.x - p.pos.x, dy = t.y - p.pos.y, dz = t.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d <= dist || d < 1e-4) {
        if (d > 0.05) p.yaw += angDiff(p.yaw, yawTo(dx, dz)) * Math.min(1, dtm * 10 + dt * 8);
        p.pos.copy(t);
        dist -= d;
        p.pathIdx++;
      } else {
        const k = dist / d;
        p.pos.x += dx * k; p.pos.z += dz * k; p.pos.y += dy * k;
        p.yaw += angDiff(p.yaw, yawTo(dx, dz)) * Math.min(1, dtm * 10 + dt * 8);
        dist = 0;
      }
    }
    // follow the ground on outdoor legs (both ends of the leg on the terrain) so long walks don't float or sink
    {
      const t = p.path[Math.min(p.pathIdx, p.path.length - 1)];
      if (t) {
        const H = this.ctx.layout.heightAt;
        const gt = H(t.x, t.z);
        if (Math.abs(t.y - gt) < 0.35) {
          const g = H(p.pos.x, p.pos.z);
          if (Math.abs(p.pos.y - g) < 0.3) p.pos.y = g;
        }
      }
    }
    p.moving = true;
    p.phase += Math.min(travelled * 4.2, dt * (p.running ? 16 : 11) + 0.02);
    if (p.fadeLeg) {
      const f = p.fadeLeg;
      const d = Math.hypot(p.pos.x - f.from.x, p.pos.z - f.from.z);
      const k = Math.min(1, d / f.len);
      p.fade = f.dir === 'out' ? k : 1 - k;
      if (f.dir === 'out' && k >= 1) { p.fadeLeg = null; p.fade = 1; }
    }
    if (p.pathIdx >= p.path.length) {
      p.moving = false;
      p.path = []; p.pathIdx = 0;
      if (p.fadeLeg && p.fadeLeg.dir === 'out') { p.fadeLeg = null; p.fade = 1; }
      const cb = p.onArrive; p.onArrive = null;
      p.running = false;
      p.speedOverride = undefined;
      cb?.();
    }
  }

  // ───────────────────────── scripts (routines) ─────────────────────────
  runScript(p: Person, steps: Step[], done?: (p: Person) => void) {
    p.script = steps; p.stepIdx = 0; p.stepStarted = false; p.stepT = 0; p.scriptDone = done ?? null;
  }

  private endStep(p: Person) {
    const s = p.script?.[p.stepIdx];
    if (s && (s.k === 'do' || s.k === 'wander')) {
      if (s.k === 'do') { if (s.anim !== undefined) p.manualAnim = null; if (s.idle !== undefined) p.idle = null; }
      else p.idle = null;
      this.clearTempProps(p);
    }
    p.stepIdx++; p.stepStarted = false; p.stepT = 0;
  }

  private untilMinute(h: number): number {
    const c = this.ctx.clock;
    const d = ((h - c.hour) % 24 + 24) % 24;
    return c.minutes + d * 60;
  }

  private tickScript(p: Person, dtSim: number) {
    const sc = p.script;
    if (!sc) return;
    if (p.pathIdx < p.path.length || p.wait > 0) {
      // walking / sleeping: only 'wander' timers keep running
      const s = sc[p.stepIdx];
      if (s && s.k === 'wander' && p.stepStarted && this.ctx.clock.minutes >= (p.data.stepEnd as number)) { /* ends after this leg */ }
      return;
    }
    let guard = 0;
    while (p.alive && p.script === sc && guard++ < 6) {
      const s = sc[p.stepIdx];
      if (!s) {
        p.script = null;
        const d = p.scriptDone; p.scriptDone = null;
        d?.(p);
        return;
      }
      const first = !p.stepStarted;
      p.stepStarted = true;
      switch (s.k) {
        case 'go':
          if (first) {
            if (s.state) p.state = s.state;
            this.go(p, s.to, () => this.endStep(p), { run: s.run, speed: s.speed, direct: s.direct, staff: s.staff });
            return;
          }
          return; // waiting for onArrive
        case 'face': p.faceYaw = s.yaw; this.endStep(p); continue;
        case 'faceTo': p.faceYaw = yawTo(s.p.x - p.pos.x, s.p.z - p.pos.z); this.endStep(p); continue;
        case 'call': this.endStep(p); s.fn(p); continue;
        case 'enter':
          if (first) { this.enter(p, s.origin, { state: s.state ?? 'going in' }); }
          return;
        case 'do': {
          if (first) {
            if (s.state) p.state = s.state;
            if (s.anim !== undefined) p.manualAnim = s.anim;
            if (s.idle !== undefined) p.idle = s.idle;
            this.setTempProps(p, s.props);
            p.data.stepEnd = s.min !== undefined ? this.ctx.clock.minutes + s.min : s.untilHour !== undefined ? this.untilMinute(s.untilHour) : Infinity;
          }
          s.tick?.(p, dtSim);
          if (!p.alive || p.script !== sc) return;
          if (this.ctx.clock.minutes >= (p.data.stepEnd as number) || (s.until && s.until(p))) { this.endStep(p); continue; }
          return;
        }
        case 'wander': {
          if (first) {
            if (s.state) p.state = s.state;
            p.data.stepEnd = s.min !== undefined ? this.ctx.clock.minutes + s.min : s.untilHour !== undefined ? this.untilMinute(s.untilHour) : this.ctx.clock.minutes + 30;
            p.idle = s.idle ?? null;
          }
          if (this.ctx.clock.minutes >= (p.data.stepEnd as number) || (s.until && s.until(p))) { this.endStep(p); continue; }
          // next stroll leg, then a pause
          // a dry leg: never into (or straight across) the river, the lock or a building
          const T = this.ctx.layout.terrain;
          let tx = p.pos.x, tz = p.pos.z;
          for (let tries = 0; tries < 8; tries++) {
            const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(0.3, 1) * s.r;
            const cx = s.center.x + Math.cos(a) * r, cz = s.center.z + Math.sin(a) * r;
            let ok = !T.buildingAt(cx, cz, 0.6);
            for (let k = 1; ok && k <= 6; k++) { const f = k / 6; if (T.isWater(p.pos.x + (cx - p.pos.x) * f, p.pos.z + (cz - p.pos.z) * f)) ok = false; }
            if (ok) { tx = cx; tz = cz; break; }
          }
          const tgt = new THREE.Vector3(tx, tx === p.pos.x && tz === p.pos.z ? p.pos.y : this.ctx.layout.heightAt(tx, tz), tz);
          this.go(p, tgt, () => { this.sleep(p, this.rng.range(3, 9), () => { /* next leg */ }); }, { direct: true });
          return;
        }
      }
    }
  }

  // ───────────────────────── riding ─────────────────────────
  private ridersOf(anchorId: string): Person[] {
    let a = this.riders.get(anchorId);
    if (!a) { a = []; this.riders.set(anchorId, a); }
    return a;
  }

  ride(ids: string[], anchor: Anchor, seats?: number[]) {
    const occ = this.ridersOf(anchor.id);
    ids.forEach((id, k) => {
      const p = this.persons.get(id);
      if (!p || !p.alive) return;
      this.unride(p);
      let seat = seats?.[k];
      if (seat === undefined) {
        const taken = (s: number) => occ.some((q) => q.riding?.seat === s);
        if (DRIVER_ROLES.includes(p.role) && !taken(0)) seat = 0;
        else {
          seat = -1;
          for (let s = anchor.seats > 1 ? 1 : 0; s < Math.max(1, anchor.seats); s++) if (!taken(s)) { seat = s; break; }
          if (seat < 0) seat = occ.length % Math.max(1, anchor.seats);
        }
      }
      let pose: RidePose = 'sit';
      try { pose = anchor.seatPose(seat); } catch { /* default */ }
      let hidden = false;
      try { hidden = !!anchor.hidden?.(seat); } catch { hidden = false; }
      this.stop(p);
      this.freeSeat(p);
      p.fadeLeg = null;
      p.riding = { anchor, anchorId: anchor.id, seat, pose, hidden };
      p.fade = hidden ? 0 : 1;
      p.sitTarget = pose === 'sit' || pose === 'drive' || pose === 'row' ? 1 : 0;
      p.sit = p.sitTarget;
      p.state = 'riding';
      p.script = null;
      occ.push(p);
      this.seatUpdate(p);
    });
  }

  unride(p: Person) {
    if (!p.riding) return;
    const occ = this.riders.get(p.riding.anchorId);
    if (occ) { const i = occ.indexOf(p); if (i >= 0) occ.splice(i, 1); if (!occ.length) this.riders.delete(p.riding.anchorId); }
    p.riding = null;
    p.sitTarget = 0;
  }

  /** place a rider on their seat; false = anchor gone */
  private seatUpdate(p: Person): boolean {
    const r = p.riding!;
    let ok = false;
    try { ok = r.anchor.seatMatrix(r.seat, _mSeat); } catch { ok = false; }
    if (!ok) return false;
    const e = _mSeat.elements;
    if (r.pose === 'push') {
      // walking behind a handcart: stride with the cart's travel
      const moved = Math.hypot(e[12] - p.pos.x, e[14] - p.pos.z);
      p.moving = moved > 0.004 && moved < 3;
      if (p.moving) p.phase += moved * 4.2;
    }
    p.pos.set(e[12], e[13], e[14]);
    p.yaw = Math.atan2(e[8], e[10]);
    return true;
  }

  private anchorGone(p: Person) {
    const O = this.ctx.origins;
    const vo = O.legit(p.pos, 'vehicles', 6) ?? O.legit(p.pos, 'boats', 6) ?? O.legit(p.pos, 'people', 4);
    const offMap = Math.max(Math.abs(p.pos.x), Math.abs(p.pos.z)) > this.ctx.layout.terrain.half;
    if (vo || offMap || p.riding?.hidden) {
      // went with the vehicle through a legitimate origin (depot door / portal / closed carriage)
      const at = vo ? vo.pos(new THREE.Vector3()) : p.pos;
      this.unride(p);
      this.removeAt(p, at, `rider@${vo?.id ?? 'offmap'}`);
      return;
    }
    // stepped down wherever the vehicle vanished (the owner should never do this in view): carry on on foot
    this.unride(p);
    p.fade = 1;
    this.afterRide(p, undefined);
  }

  embark(ids: string[], anchor: Anchor): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const ps = ids.map((id) => this.persons.get(id)).filter((p): p is Person => !!p && p.alive);
      if (!ps.length) { resolve(false); return; }
      const g: EmbarkGroup = { pending: ps.length, ok: true, resolve };
      const door = new THREE.Vector3();
      for (const p of ps) {
        this.releaseAll(p);
        this.embarkGroups.set(p, g);
        p.state = 'embarking';
        p.data.embarkAnchor = anchor;
        p.data.embarkUntil = this.ctx.clock.minutes + 40;
        try { anchor.doorPoint(door); } catch { door.copy(p.pos); }
        const tgt = door.clone().add(_v.set(this.rng.range(-0.5, 0.5), 0, this.rng.range(-0.5, 0.5)));
        this.go(p, tgt, () => { p.state = 'boarding vehicle'; p.faceYaw = yawTo(door.x - p.pos.x, door.z - p.pos.z); });
      }
    });
  }

  private settleEmbark(g: EmbarkGroup, ok: boolean) {
    if (!ok) g.ok = false;
    g.pending--;
    if (g.pending <= 0) g.resolve(g.ok);
  }

  private updateEmbark(p: Person) {
    const anchor = p.data.embarkAnchor as Anchor | undefined;
    const g = this.embarkGroups.get(p);
    if (!anchor || !g) { p.state = 'idle'; return; }
    if (p.pathIdx < p.path.length) return;
    let stopped = false, alive = true;
    try { stopped = anchor.stopped(); alive = anchor.seatMatrix(0, _mSeat); } catch { alive = false; }
    if (!alive || this.ctx.clock.minutes > (p.data.embarkUntil as number)) {
      this.embarkGroups.delete(p);
      p.data.embarkAnchor = undefined;
      this.settleEmbark(g, false);
      p.state = 'idle';
      this.afterRide(p, undefined);
      return;
    }
    if (!stopped) return;
    anchor.doorPoint(_v);
    if (Math.hypot(_v.x - p.pos.x, _v.z - p.pos.z) > 2.2) { this.go(p, _v.clone(), null, { direct: true }); return; }
    this.embarkGroups.delete(p);
    p.data.embarkAnchor = undefined;
    this.ride([p.id], anchor);
    this.settleEmbark(g, true);
  }

  disembark(anchorId: string, opts: { to?: THREE.Vector3; then?: 'passenger' | 'wander' | 'home' | 'actor' | 'dismiss' } = {}): string[] {
    const occ = this.riders.get(anchorId);
    if (!occ || !occ.length) return [];
    const ids: string[] = [];
    for (const p of [...occ]) { this.disembarkOne(p, opts.then, opts.to); ids.push(p.id); }
    return ids;
  }

  /** one rider steps down at the anchor's door point */
  disembarkOne(p: Person, then?: 'passenger' | 'wander' | 'home' | 'actor' | 'dismiss', to?: THREE.Vector3) {
    const r = p.riding;
    if (!r) return;
    const door = new THREE.Vector3();
    try { r.anchor.doorPoint(door); } catch { door.copy(p.pos); }
    const wasHidden = r.hidden;
    this.unride(p);
    p.sit = 0;
    const from = p.pos.clone();
    const step = door.clone().add(_v.set(this.rng.range(-0.8, 0.8), 0, this.rng.range(-0.8, 0.8)));
    if (wasHidden) { p.fade = 0; p.fadeLeg = { from, len: Math.max(0.4, from.distanceTo(step) * 0.8), dir: 'out' }; }
    else p.fade = 1;
    p.state = 'alighting vehicle';
    this.go(p, step, () => this.afterRide(p, { then, to }), { direct: true });
  }

  private afterRide(p: Person, opts: { to?: THREE.Vector3; then?: 'passenger' | 'wander' | 'home' | 'actor' | 'dismiss' } | undefined) {
    if (!p.alive) return;
    // default: travellers carry on to their train, townsfolk go home, everyone else (drivers, crews) walks to a sink —
    // events that want to keep an actor pass then: 'actor' explicitly
    const then = opts?.then ?? (p.line && p.dir && p.kind === 'passenger' ? 'passenger' : p.kind === 'town' ? 'home' : 'dismiss');
    const cont = () => {
      if (!p.alive) return;
      if (then === 'passenger' && p.kind === 'passenger') this.passengers.arriveAtStation(p);
      else if (then === 'passenger') { this.setKind(p, 'passenger'); this.passengers.arriveAtStation(p); }
      else if (then === 'actor') { this.setKind(p, 'actor'); p.state = 'actor'; }
      else if (then === 'wander') {
        this.runScript(p, [{ k: 'wander', center: p.pos.clone(), r: 8, min: this.rng.range(8, 25), state: 'looking about' }], (q) => { void this.dismiss(q); });
      } else void this.dismiss(p);
    };
    if (opts?.to) this.go(p, opts.to, cont); else cont();
  }

  /** detach from any passenger/queue/seat/ride bookkeeping (commandeered by a script or another system) */
  releaseAll(p: Person) {
    this.passengers.release(p);
    this.freeSeat(p);
    this.unride(p);
    const eg = this.embarkGroups.get(p);
    if (eg) { this.embarkGroups.delete(p); this.settleEmbark(eg, false); }
  }

  // ───────────────────────── summon / crowd ─────────────────────────
  summon(role: PersonRole, target: THREE.Vector3, opts: { from?: string; run?: boolean; timeoutMin?: number; spec?: Partial<PersonSpec>; kind?: Kind } = {}): { id: string; arrived: Promise<boolean> } {
    const O = this.ctx.origins;
    let o: Origin | null | undefined = opts.from ? this.origin(opts.from) : undefined;
    if (!o || !o.open()) {
      o = O.bestFor(target, 'people', { kinds: ['door', 'portal', 'vehicle', 'train'], role, exclude: this.isStaffRole(role) ? undefined : STATION_DOORS })
        ?? O.bestFor(target, 'people', { role }) ?? O.nearest(target, 'people');
    }
    const look = opts.spec?.child ? roleLook('child', this.rng) : undefined;
    const p = o ? this.emerge(o, role, opts.kind ?? 'actor', look, { force: true }) : null;
    if (!p) return { id: '', arrived: Promise.resolve(false) };
    if (opts.spec?.home) p.home = opts.spec.home;
    if (opts.spec?.tag) p.data.tag = opts.spec.tag;
    p.state = 'summoned';
    const timeout = opts.timeoutMin ?? 240;
    const arrived = new Promise<boolean>((resolve) => {
      let settled = false;
      const deadline = this.ctx.clock.minutes + timeout;
      p.data.summonDeadline = deadline;
      p.data.summonResolve = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
      const walk = () => {
        if (!p.alive) { resolve(false); return; }
        p.walkResolve = () => { const r = p.data.summonResolve as ((ok: boolean) => void) | undefined; r?.(false); };
        this.go(p, target.clone(), () => {
          p.walkResolve = null;
          if (p.state === 'summoned') p.state = 'actor';
          const r = p.data.summonResolve as ((ok: boolean) => void) | undefined;
          r?.(true);
        }, { run: opts.run });
      };
      // step out of the door first, then walk
      const firstLeg = p.onArrive;
      p.onArrive = () => { firstLeg?.(); walk(); };
      if (p.pathIdx >= p.path.length) walk();
    });
    return { id: p.id, arrived };
  }

  summonCrowd(n: number, near: THREE.Vector3, role?: PersonRole, opts: { spread?: number; timeoutMin?: number } = {}): { ids: string[]; assembled: Promise<number> } {
    const count = Math.max(0, Math.min(Math.floor(n), 160, this.capacity - this.list.length - 10));
    const ids: string[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    const spread = opts.spread ?? 0.8;
    const spots: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const rr = spread * Math.sqrt(i + 0.5) + this.rng.range(0, 0.25);
      const a = i * golden + this.rng.range(-0.2, 0.2);
      spots.push(new THREE.Vector3(near.x + Math.cos(a) * rr, near.y, near.z + Math.sin(a) * rr));
    }
    const proms: Promise<boolean>[] = [];
    let si = 0;
    // 1) recruit people already about (idlers & townsfolk without deadlines) — no role change unless asked
    if (!role || role === 'townsfolk' || role === 'passenger' || role === 'guest') {
      const cands = this.list.filter((p) => p.alive && !p.riding && (p.kind === 'idler' || (p.kind === 'town' && !p.data.fixed)) && p.fade > 0.9 && p.pos.distanceTo(near) < 140)
        .sort((a, b) => a.pos.distanceToSquared(near) - b.pos.distanceToSquared(near));
      for (const p of cands) {
        if (si >= count) break;
        const spot = spots[si++];
        this.commandeer(p);
        p.state = 'crowd';
        ids.push(p.id);
        proms.push(new Promise<boolean>((res) => {
          // settles false if the recruit is removed or taken over before reaching the spot
          p.walkResolve = () => res(false);
          this.go(p, spot, () => { p.walkResolve = null; p.faceYaw = yawTo(near.x - spot.x, near.z - spot.z); res(true); });
        }));
      }
    }
    // 2) the rest walk in from the nearest doors (spread over several)
    const used: string[] = [];
    while (si < count) {
      const spot = spots[si++];
      const o = this.ctx.origins.bestFor(spot, 'people', { kinds: ['door', 'vehicle', 'train'], exclude: used.length > 6 ? undefined : used });
      if (o && o.building && !used.includes(o.id)) used.push(o.id);
      const s = this.summon(role ?? 'townsfolk', spot, { from: o?.id, timeoutMin: opts.timeoutMin ?? 180 });
      if (!s.id) continue;
      ids.push(s.id);
      const p = this.persons.get(s.id)!;
      p.state = 'crowd';
      proms.push(s.arrived.then((ok) => { if (p.alive) p.faceYaw = yawTo(near.x - p.pos.x, near.z - p.pos.z); return ok; }));
    }
    const assembled = Promise.all(proms).then((r) => r.filter(Boolean).length);
    return { ids, assembled };
  }

  /** take a person over for an external script (actor) */
  commandeer(p: Person) {
    if (p.kind === 'staff' || p.kind === 'guard') {
      p.data.scripted = true;
      p.wait = 0; p.onWait = null;
      return;
    }
    this.releaseAll(p);
    p.script = null;
    p.manualAnim = null;
    this.clearTempProps(p);
    if (p.kind !== 'actor') { this.setKind(p, 'actor'); p.state = 'actor'; }
  }

  // ───────────────────────── shelter / weather ─────────────────────────
  sheltered(pos: THREE.Vector3): boolean {
    const L = this.ctx.layout;
    for (const P of [L.platforms[1], L.platforms[2]]) {
      const dx = pos.x - P.center.x, dz = pos.z - P.center.z;
      const along = dx * Math.cos(P.yaw) - dz * Math.sin(P.yaw);
      const lat = dx * Math.sin(P.yaw) + dz * Math.cos(P.yaw);
      if (Math.abs(along) < P.canopyLength / 2 && Math.abs(lat) < P.width / 2 + 0.3 && pos.y > 0.6) return true;
    }
    const S = L.station;
    const dx = pos.x - S.center.x, dz = pos.z - S.center.z;
    const along = dx * Math.cos(S.yaw) - dz * Math.sin(S.yaw);
    const lat = dx * Math.sin(S.yaw) + dz * Math.cos(S.yaw);
    return Math.abs(along) < S.size.x / 2 + 0.5 && Math.abs(lat) < S.size.z / 2 + 0.5;
  }

  shelteredCached(p: Person): boolean {
    const c = p.data.shelterAt as number | undefined;
    const sp = p.data.shelterPos as THREE.Vector3 | undefined;
    if (c !== undefined && Math.abs(this.vt - c) < 0.4 && sp && sp.distanceToSquared(p.pos) < 1) return p.data.shelter as boolean;
    const s = this.sheltered(p.pos);
    p.data.shelter = s; p.data.shelterAt = this.vt;
    if (!sp) p.data.shelterPos = p.pos.clone(); else sp.copy(p.pos);
    return s;
  }

  wetness(): number {
    const a = this.ctx.reg.atmosphere;
    return a ? Math.max(a.rain, a.snow * 0.6) : 0;
  }

  /** how dark it is for lamps (own estimate + atmosphere.gloom) */
  gloom(): number {
    const a = this.ctx.reg.atmosphere;
    if (!a) return 0;
    const nf = THREE.MathUtils.smoothstep(a.nightFactor ?? 0, 0.12, 0.62);
    const fog = (a.fog ?? 0) > 0.4 ? 0.6 : 0;
    const storm = a.weather === 'storm' ? 0.55 : 0;
    return Math.max(a.gloom ?? 0, nf, fog, storm);
  }

  syncInfo(p: Person): PersonInfo {
    const i = p.info;
    i.state = p.state; i.mood = p.mood; i.patience = p.patience; i.umbrella = p.umbrella;
    i.line = p.line; i.dir = p.dir; i.destination = p.destination;
    i.riding = p.riding?.anchorId; i.home = p.home; i.idle = p.idle;
    return i;
  }

  // ───────────────────────── update ─────────────────────────
  update(dt: number, dtm: number, dtSim: number) {
    this.vt += dt;
    const atmo = this.ctx.reg.atmosphere;
    const wet = this.wetness();

    if (this.warm) {
      this.passengers.warmStart();
      this.staff.warmStart();
      this.town.warmStart();
      this.warm = false;
    }
    this.passengers.update(dt, dtm, dtSim);
    this.staff.update(dtm, dtSim);
    this.town.update(dtm, dtSim);

    const list = this.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (!p || !p.alive) continue;
      if (p.riding) {
        if (!this.seatUpdate(p)) { this.anchorGone(p); continue; }
        if (dtSim > 0 && p.kind === 'passenger') this.passengers.riderTick(p);
        continue;
      }
      if (p.data.indoorsOf) { if (dtm > 0 && p.kind === 'passenger') this.passengers.indoorsTick(p, dtm); continue; }
      if (dtm > 0) {
        if (p.wait > 0) {
          p.wait -= dtm;
          if (p.wait <= 0) { p.wait = 0; const cb = p.onWait; p.onWait = null; cb?.(); if (!p.alive) continue; }
        }
        if (p.state === 'embarking' || p.state === 'boarding vehicle') { this.updateEmbark(p); if (!p.alive) continue; }
        else if (p.kind === 'passenger') { this.passengers.updatePassenger(p, dtm); if (!p.alive) continue; }
        else if (p.kind === 'staff' || p.kind === 'guard') { this.staff.updateStaff(p, dtm); if (!p.alive) continue; }
        if (p.script) { this.tickScript(p, dtSim); if (!p.alive) continue; }
        this.moveStep(p, dtm, dt);
        if (!p.alive) continue;
        // backstop: someone heading for a sink who has not moved for 30 sim min (a lost walk) sets off again —
        // after two tries, through the nearest door instead
        if (p.data.entering && !p.riding && !p.moving && p.wait <= 0 && !p.script && /going home|heading home|leaving|wandering off/.test(p.state)) {
          p.data.stillT = ((p.data.stillT as number) ?? 0) + dtm;
          if ((p.data.stillT as number) > 30) {
            p.data.stillT = 0;
            const tries = p.data.sinkRetry = ((p.data.sinkRetry as number) ?? 0) + 1;
            const alt = tries > 2 ? this.ctx.origins.nearest(p.pos, 'people', { kinds: ['door'] }) : null;
            const st = p.state;
            p.data.entering = undefined; p.fadeLeg = null; p.fade = 1;
            void this.dismiss(p, { to: alt?.id, state: st });
            if (!p.alive) continue;
          }
        } else if (p.data.stillT) p.data.stillT = 0;
        if (p.kind === 'actor') {
          const now = this.ctx.clock.minutes;
          if (p.moving || p.script || p.wait > 0 || p.data.actT === undefined) p.data.actT = now;
          else if (now - (p.data.actT as number) > ACTOR_IDLE_LIMIT && !p.data.entering) { p.data.actT = now; void this.dismiss(p, { state: 'wandering off' }); if (!p.alive) continue; }
        }
        if (p.data.summonDeadline !== undefined && p.state === 'summoned' && this.ctx.clock.minutes > (p.data.summonDeadline as number)) {
          const r = p.data.summonResolve as ((ok: boolean) => void) | undefined; r?.(false);
          p.data.summonDeadline = undefined;
        }
      } else p.moving = false;
      // umbrellas (civilians outdoors in rain)
      const civilian = p.kind === 'passenger' || p.kind === 'alighter' || p.kind === 'idler' || p.kind === 'meeter' || (p.kind === 'town' && !p.data.fixed) || p.role === 'guest' || p.role === 'vip' || p.role === 'groom' || p.role === 'bride' || p.role === 'pickpocket';
      const want = civilian && !p.look.child && !p.seat && wet > 0.3 && (atmo?.snow ?? 0) < 0.5 && p.accSlots.trolley === undefined && p.accSlots.newspaper === undefined && p.fade > 0.5 && !this.shelteredCached(p);
      if (want !== p.umbrella) {
        p.umbrella = want;
        if (want) this.addAcc(p, 'umbrella'); else this.removeAcc(p, 'umbrella');
      }
      // visual smoothing
      const sitRate = Math.min(1, (dt + dtm) * 4);
      p.sit += (p.sitTarget - p.sit) * sitRate;
      if (!p.moving && p.faceYaw !== null) p.yaw += angDiff(p.yaw, p.faceYaw) * Math.min(1, (dt + dtm) * 5);
    }
    const nf = atmo?.nightFactor ?? 0;
    this.renderer.setNightLift(0.1 * nf, THREE.MathUtils.smoothstep(nf, 0.25, 0.7), this.vt);
    for (let i = this.lookCues.length - 1; i >= 0; i--) if (this.lookCues[i].until < this.vt) this.lookCues.splice(i, 1);
  }

  // ───────────────────────── instance writing (once per rendered frame) ─────────────────────────
  private writeInstances() {
    const R = this.renderer;
    const t = this.vt;
    const fdt = Math.min(0.1, Math.max(0, t - this.lastWriteVt));
    this.lastWriteVt = t;
    const view = this.ctx.view;
    const atmo = this.ctx.reg.atmosphere;
    _env.cold = (atmo?.temperatureC ?? 12) < 3 || (atmo?.snow ?? 0) > 0.3;
    _env.night = (atmo?.nightFactor ?? 0) > 0.6;
    const trains = this.ctx.reg.trains;
    // far zoomed out a figure is a pixel or two: draw none on low (only those near the focus on med/high)
    // (no hard cuts: figures dither out over a zoom band and a distance band, so nobody blinks in or out on screen;
    //  riders — coachmen on their boxes, boat crews — are always drawn with their vehicle)
    const px = view ? view.pxPerMetre * PERSON_SCALE * 1.75 : 99;
    const pxLo = this.lowTier ? 1.6 : 1.1;
    const zoomFade = THREE.MathUtils.smoothstep(px, pxLo, pxLo + 1.2);
    const farCull = view && px < 6 ? (this.lowTier ? 120 : 260) : Infinity;
    const farBand = this.lowTier ? 45 : 70;
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i];
      const L = p.look;
      if (p.fade <= 0.002 || (view && !view.isVisible(p.pos, 3))) continue;
      let fadeMul = 1;
      if (!p.riding) {
        fadeMul = zoomFade;
        if (farCull !== Infinity && fadeMul > 0) {
          const d = view!.distToFocus(p.pos.x, p.pos.z);
          fadeMul *= 1 - THREE.MathUtils.smoothstep(d, farCull, farCull + farBand);
        }
        if (fadeMul <= 0.02) continue;
      }
      // look targets: explicit lookAt, a train, or a nearby sound cue
      _env.hasLook = false;
      if (p.lookAt) { _env.hasLook = true; _env.lookX = p.lookAt.x; _env.lookZ = p.lookAt.z; }
      else if (p.lookTrain && p.lookUntil > t) {
        const tr = trains?.get(p.lookTrain);
        if (tr) { _env.hasLook = true; _env.lookX = tr.position.x; _env.lookZ = tr.position.z; }
      } else if (this.lookCues.length && !p.moving) {
        for (const c of this.lookCues) {
          if (Math.abs(c.pos.x - p.pos.x) < c.r && Math.abs(c.pos.z - p.pos.z) < c.r) { _env.hasLook = true; _env.lookX = c.pos.x; _env.lookZ = c.pos.z; break; }
        }
      }
      computePose(p, t, fdt, _env);
      const o = poseOut;
      const s = L.scale * PERSON_SCALE;
      const sitY = -0.37 * p.sit * s;
      _e.set(o.lean, p.yaw + o.yawOff, o.roll, 'YXZ');
      _q.setFromEuler(_e);
      _s.set(s, s, s);
      _m.compose(_v.set(p.pos.x, p.pos.y + o.bob * s + sitY, p.pos.z), _q, _s);
      _anim.set(o.phase, o.amp, p.sit, p.seed);
      _arm.set(o.rT, o.rW, o.lT, o.lW);
      _aux.set(o.hYaw, o.hPitch, p.fade * fadeMul, 0);
      R.bodies[L.body].push(p.num, _m, _anim, _arm, _aux, p.cols, 0, true);
      if (L.hat) R.hats[L.hat].push(p.num, _m, _anim, _arm, _aux, p.cols, 12, false);
      for (const k in p.accCols) {
        const a = k as AccKind;
        _aux.w = PROP_IDS[a];
        R.famOf(a).push(p.num, _m, _anim, _arm, _aux, p.accCols[a]!, 0, false);
      }
    }
  }

  // ───────────────────────── API ─────────────────────────
  private buildApi(): PeopleAPI {
    const self = this;
    const api: PeopleAPI = {
      count: () => this.list.length,
      list: () => this.list.map((p) => this.syncInfo(p)),
      get: (id) => { const p = this.persons.get(id); return p ? this.syncInfo(p) : undefined; },
      boardingPending: (trainId) => this.passengers.pendingFor(trainId),
      spawnActor: (role, pos) => {
        const o = this.ctx.origins.legit(pos, 'people', 1);
        if (o && o.open()) {
          const p = this.emerge(o, role, 'actor', undefined, { force: true });
          if (p) { p.state = 'actor'; return p.id; }
        }
        return this.summon(role, pos).id;
      },
      walkTo: (id, target, opts) => {
        const p = this.persons.get(id);
        if (!p || !p.alive) return Promise.resolve();
        this.commandeer(p);
        const prev = p.walkResolve; p.walkResolve = null;
        const sr = p.data.summonResolve as ((ok: boolean) => void) | undefined;
        if (p.state === 'summoned' && sr) { p.state = 'actor'; sr(true); }
        prev?.();
        return new Promise<void>((resolve) => {
          p.walkResolve = resolve;
          const start = () => this.go(p, target, () => {
            if (p.data.scripted) { p.data.scripted = false; p.data.scriptHold = 45; }
            const r = p.walkResolve; p.walkResolve = null; r?.();
          }, opts ?? {});
          if (p.fadeLeg && p.fadeLeg.dir === 'out' && p.pathIdx < p.path.length) {
            const first = p.onArrive;
            p.onArrive = () => { first?.(); start(); };
          } else start();
        });
      },
      setAnim: (id, a) => { const p = this.persons.get(id); if (p) p.manualAnim = a; },
      removeActor: (id) => { const p = this.persons.get(id); if (p) void this.dismiss(p); },
      spawnCrowd: (n, near, role) => this.summonCrowd(n, near, role).ids,
      density: 1,
      raycast: (r) => {
        this.renderer.flush();
        const hit = this.renderer.raycast(r);
        return hit ? this.byNum.get(hit.owner)?.id ?? null : null;
      },
      spawnInside: (originId, specs) => this.spawnInside(originId, specs),
      summonActor: (role, target, opts) => this.summon(role, target, opts),
      summonCrowd: (n, near, role, opts) => this.summonCrowd(n, near, role, opts),
      dismissActor: (id, opts) => { const p = this.persons.get(id); return p ? this.dismiss(p, opts) : Promise.resolve(); },
      ride: (ids, anchor, seats) => this.ride(ids, anchor, seats),
      embark: (ids, anchor) => this.embark(ids, anchor),
      disembark: (anchorId, opts) => this.disembark(anchorId, opts),
      // (an owner still talking to its actor keeps it on duty: both refresh the forgotten-actor backstop)
      setIdle: (id, style: IdleStyle | null) => { const p = this.persons.get(id); if (p) { p.idle = style; p.nextClip = 0; p.data.actT = this.ctx.clock.minutes; } },
      lookAt: (id, target) => { const p = this.persons.get(id); if (p) { p.lookAt = target ? target.clone() : null; p.data.actT = this.ctx.clock.minutes; } },
      boardingEta: (trainId) => this.passengers.boardingEta(trainId),
      stats: () => {
        const byRole: Partial<Record<PersonRole, number>> = {};
        let riding = 0, hidden = 0;
        for (const p of this.list) {
          byRole[p.role] = (byRole[p.role] ?? 0) + 1;
          if (p.riding) riding++;
          if (p.fade < 0.01) hidden++;
        }
        return { byRole, riding, hidden, waiting: this.passengers.waitingCount(), gaveUp: this.passengers.gaveUpTotal, boarded: this.passengers.boardedTotal };
      },
    };
    void self;
    return api;
  }

  /** create people INSIDE an origin (door / vehicle / train door / portal); they step out unless ride() seats them first */
  spawnInside(originId: string, specs: PersonSpec[]): string[] {
    let o = this.origin(originId);
    let anchor: Anchor | null = null;
    if (!o) {
      try { anchor = this.ctx.reg.traffic?.anchorOf(originId) ?? null; } catch { anchor = null; }
      if (!anchor) { try { anchor = this.ctx.reg.nature?.anchorOf(originId) ?? null; } catch { anchor = null; } }
    }
    const ids: string[] = [];
    for (const spec of specs) {
      const role = spec.role;
      const look = spec.child ? roleLook('child', this.rng) : role === 'passenger' ? passengerLook(this.rng) : undefined;
      if (look && spec.luggage && !look.child && !look.accs.includes('suitcase')) { look.accs.push('suitcase'); look.accColors.suitcase = [0x6a4028, 0, 0]; }
      const kind: Kind = spec.dest || role === 'passenger' ? 'passenger' : TOWN_ROLES.includes(role) ? 'town' : this.isStaffRole(role) ? 'actor' : 'actor';
      let p: Person | null = null;
      if (o) {
        const pos = this.insidePoint(o, new THREE.Vector3());
        p = this.spawnRaw(role, pos, kind, look);
        this.auditAt('spawn', o.pos(_v2), `${role}@${o.id}`);
        p.originId = o.id;
      } else if (anchor) {
        const pos = anchor.doorPoint(new THREE.Vector3());
        p = this.spawnRaw(role, pos, kind, look);
        this.auditAt('spawn', pos, `${role}@anchor:${originId}`);
      } else {
        // unknown origin: summon from the nearest door to the entrance instead of popping in
        const s = this.summon(role, this.ctx.layout.entrance.clone(), { spec, kind });
        if (s.id) ids.push(s.id);
        continue;
      }
      p.fade = 0;
      p.state = 'inside';
      p.data.insideOf = o?.id ?? originId;
      p.data.insideSince = this.vt;
      if (spec.home) p.home = spec.home;
      if (spec.tag) p.data.tag = spec.tag;
      if (spec.dest) this.passengers.assignDest(p, spec.dest.line, spec.dest.dir);
      ids.push(p.id);
      const pp = p;
      // if nobody seats them within a moment, they step out through the origin
      pp.wait = 0.6;
      pp.onWait = () => { if (pp.alive && pp.state === 'inside' && !pp.riding) this.stepOut(pp); };
    }
    if (anchor && ids.length) this.ride(ids, anchor);
    return ids;
  }

  private stepOut(p: Person) {
    const o = this.origin(p.data.insideOf as string | undefined);
    const from = p.pos.clone();
    const to = o ? o.pos(new THREE.Vector3()) : p.pos.clone();
    if (o && o.kind !== 'door') {
      // vehicle / train / portal: a short step away from the threshold
      to.x += this.rng.range(-1.2, 1.2); to.z += this.rng.range(-1.2, 1.2);
    }
    p.fadeLeg = { from, len: Math.max(0.3, from.distanceTo(to)), dir: 'out' };
    p.state = 'stepping out';
    this.go(p, to, () => this.afterRide(p, undefined), { direct: true });
    if (o?.kind === 'door') {
      try { this.ctx.reg.world?.openDoor(o.id); } catch { /* stub */ }
      this.ctx.bus.emit('person:door', { personId: p.id, originId: o.id, dir: 'out' });
    }
  }

  dispose() {
    for (const u of this.unsubs) u();
    this.passengers.dispose();
    this.town.dispose();
    for (const p of [...this.list]) this.remove(p);
    this.ctx.scene.remove(this.renderer.group);
    this.renderer.dispose();
  }

  // debug helper for anims
  static readonly ANIMS: PersonAnim[] = ['idle', 'walk', 'run', 'work', 'cheer', 'play', 'sit', 'drive', 'row', 'pole', 'fish', 'read', 'chat', 'watch', 'sweep', 'shovel', 'hammer', 'pitchfork', 'scythe', 'light', 'skate', 'carry', 'push', 'lead', 'wave', 'point', 'drink', 'wash'];
}

import { PROP_ID as PROP_IDS } from './geometry';
