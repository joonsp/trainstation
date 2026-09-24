import * as THREE from 'three';
import type { AudioCue, Ctx, Dir, LineId, PlatformId } from '../core/types';
import type { Events } from '../core/bus';
import type { Rng } from '../core/rng';
import type { PersonRole, TrainInfo, TripRequest, VehicleInfo } from '../core/apis';
import { Actors, type WalkOpts } from './actors';
import { Runner, type Script, type Wait } from './runner';
import { Marker, disposeTree, type Fx } from './fx';
import { Critter, getLinger, type CritterAnim } from './critter';
import type { Origin } from '../core/origins';

export interface EventEnv {
  ctx: Ctx;
  rng: Rng;
  fx: Fx;
  gazette(headline: string, kind?: 'info' | 'warn' | 'event'): void;
}

export interface EventInstance {
  start(): void;
  /** returns true when finished */
  update(dt: number, dtSim: number, dtMotion: number): boolean;
  end(): void;
  /** where the action is (for camera focus / UI) */
  focus?(): THREE.Vector3 | null;
}

export interface EventDef {
  id: string;
  title: string;
  blurb: string;
  /** sim minutes before this event may auto-run again */
  cooldown: number;
  /** natural availability (auto scheduler) */
  condition(env: EventEnv): boolean;
  /** relative auto weight when available (default 1) */
  weight?(env: EventEnv): number;
  /** adjustments before a FORCED trigger (e.g. force fog for the ghost) */
  prepare?(env: EventEnv): void;
  create(env: EventEnv): EventInstance;
}

/** Base for scripted events: owns a group, actors, markers, bus subscriptions, decorations; cleans all up. */
/** number of running events currently holding each line */
const lineHolds: Record<LineId, number> = { coast: 0, highland: 0 };
/** v2: maximum sim minutes any event may hold a line */
export const HOLD_CAP = 10;
/** critters already handed to the Linger manager */
const lingering = new WeakSet<Critter>();

export abstract class Scripted implements EventInstance {
  readonly group = new THREE.Group();
  readonly actors: Actors;
  protected runner!: Runner;
  private tickers: ((dt: number, dtMotion: number) => void)[] = [];
  private cleanups: (() => void)[] = [];
  private decos: THREE.Object3D[] = [];
  private markers: { m: Marker; get: () => THREE.Vector3 | null; lift: number }[] = [];
  private carries = new Map<THREE.Object3D, () => void>();
  private vehicleArrivals = new Map<string, Set<string>>();
  private vehicleSub = false;
  private cueTimers: { cue: AudioCue; every: [number, number]; left: number; pos: () => THREE.Vector3 | undefined; vol: number }[] = [];
  protected ctx: Ctx;
  protected rng: Rng;
  /** max sim minutes before forced end */
  maxDuration = 300;
  private age = 0;
  private paused = false;

  constructor(protected env: EventEnv) {
    this.ctx = env.ctx;
    this.rng = env.rng;
    this.group.name = 'event-' + this.constructor.name;
    this.ctx.scene.add(this.group);
    this.actors = new Actors(this.ctx, this.rng);
  }

  protected abstract script(): Script;

  start(): void {
    this.runner = new Runner(this.script());
    this.runner.step(0);
  }

  update(dt: number, dtSim: number, dtMotion: number): boolean {
    this.age += dtSim;
    this.paused = dtSim <= 0;
    this.actors.update(dt, dtMotion);
    for (const f of this.tickers) f(dt, dtMotion);
    const cam = this.ctx.camera.current, vh = this.env.fx.viewH();
    for (const mk of this.markers) {
      const p = mk.get();
      mk.m.visible = !!p;
      if (p) mk.m.place(p, cam, vh, dt, mk.lift);
    }
    if (!this.paused) {
      for (const c of this.cueTimers) {
        c.left -= dt;
        if (c.left <= 0) {
          c.left = this.rng.range(c.every[0], c.every[1]);
          this.cue(c.cue, c.pos(), c.vol);
        }
      }
    }
    this.runner.step(dtSim);
    return this.runner.done || this.age > this.maxDuration;
  }

  end(): void {
    this.runner?.stop();
    for (const f of this.cleanups.reverse()) { try { f(); } catch (e) { console.error('[events] cleanup', e); } }
    this.cleanups = [];
    this.actors.removeAll();
    for (const m of this.markers) m.m.dispose();
    this.markers = [];
    for (const d of this.decos) {
      try { this.ctx.reg.world.removeDecoration(d); } catch { d.removeFromParent(); }
      d.removeFromParent();
      disposeTree(d);
    }
    this.decos = [];
    this.group.removeFromParent();
    disposeTree(this.group);
  }

  focus(): THREE.Vector3 | null {
    for (const mk of this.markers) { const p = mk.get(); if (p) return p.clone(); }
    const c = this.group.children.find((o) => o.visible);
    if (c) return c.position.clone();
    // props placed through world.addDecoration (bunting, red carpet …)
    const d = this.decos.find((o) => o.visible);
    if (!d) return null;
    const b = new THREE.Box3().setFromObject(d);
    return b.isEmpty() ? d.getWorldPosition(new THREE.Vector3()) : b.getCenter(new THREE.Vector3()).setY(0);
  }

  // ── helpers ──
  protected tick(f: (dt: number, dtMotion: number) => void): void { this.tickers.push(f); }

  /** run fn once after `min` sim minutes (motion time; not while paused). Cancelled when the event ends. */
  protected after(min: number, fn: () => void): void {
    let left = min, done = false;
    this.tick((_dt, dm) => {
      if (done) return;
      left -= dm;
      if (left <= 0) { done = true; try { fn(); } catch (e) { console.error('[events] after', e); } }
    });
  }

  /** a shuffled copy of arr (seeded) */
  protected shuffled<T>(arr: readonly T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.rng.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /** an event-owned animal (see critter.ts); it must enter() at a legit origin and leave() at one */
  protected critter(root: THREE.Object3D, label: string, animate: CritterAnim): Critter {
    const c = new Critter(this.ctx, this.group, root, label, animate);
    this.tick((dt, dm) => { if (!lingering.has(c)) c.update(dt, dm); });
    this.onCleanup(() => {
      if (lingering.has(c)) return;
      if (c.present) { lingering.add(c); getLinger(this.ctx).adoptCritter(c); } else c.dispose();
    });
    return c;
  }

  /**
   * the actor walks off to a sink (door / portal) carrying obj (a prop, or a held critter); the object stays with
   * them until they have faded through it — even after this event has ended.
   */
  protected carryOut(obj: THREE.Object3D, actorId: string, opts: { to?: string; y?: number; fwd?: number; critter?: Critter } = {}): void {
    const stop = this.carries.get(obj);
    if (stop) { stop(); this.carries.delete(obj); }
    const pid = this.actors.dismiss(actorId, opts.to ? { to: opts.to } : {});
    if (opts.critter) { lingering.add(opts.critter); opts.critter.present = false; }
    if (!pid) {
      if (opts.critter) { opts.critter.present = true; lingering.delete(opts.critter); }
      return;
    }
    const i = this.decos.indexOf(obj);
    if (i >= 0) this.decos.splice(i, 1);
    getLinger(this.ctx).adoptCarried(obj, pid, opts.y ?? 1.0, opts.fwd ?? 0.35, opts.critter);
  }

  /** stop a carry() started earlier (the object stays where it is) */
  protected stopCarry(obj: THREE.Object3D): void {
    const stop = this.carries.get(obj);
    if (stop) { stop(); this.carries.delete(obj); }
  }

  /** a Wait satisfied by `w` OR by `cond`, at most `max` sim minutes */
  protected either(w: Wait, cond: () => boolean, max = 60): Wait {
    const f = typeof w === 'number' ? (() => { const t0 = this.now; return () => this.now - t0 >= w; })() : typeof w === 'function' ? w : () => w.until();
    return { until: () => cond() || f(), max };
  }

  // ── traffic helpers (defensive: traffic may be a stub → null / no-ops) ──
  /** book a road vehicle (it enters from its depot / a portal); null when traffic can't */
  protected requestVehicle(r: TripRequest): string | null {
    const id = this.safe(() => this.ctx.reg.traffic.request(r), null);
    if (id) this.vehicleArrivals.set(id, new Set());
    return id;
  }
  protected vehicle(id: string | null): VehicleInfo | undefined { return id ? this.safe(() => this.ctx.reg.traffic.get(id), undefined) : undefined; }
  /** Wait: vehicle `id` has arrived at `stop` (any stop when omitted) — or has gone */
  protected vehicleAt(id: string | null, stop?: string, max = 120): Wait {
    if (!id) return 0;
    if (!this.vehicleSub) {
      this.vehicleSub = true;
      this.on('vehicle:arrived', (e) => { this.vehicleArrivals.get(e.vehicleId)?.add(e.stop); });
    }
    return {
      until: () => {
        const set = this.vehicleArrivals.get(id);
        if (set && (stop ? set.has(stop) : set.size > 0)) return true;
        const v = this.vehicle(id);
        if (!v || v.state === 'gone') return true;
        return (v.state === 'stopped' || v.state === 'loading' || v.state === 'waiting') && (!stop || v.stop === stop);
      },
      max,
    };
  }
  /** riders step down from vehicle `id`; they become this event's actors */
  protected alight(id: string | null, role: PersonRole = 'passenger', to?: THREE.Vector3): string[] {
    if (!id) return [];
    const anchor = this.safe(() => this.ctx.reg.traffic.anchorOf(id), null);
    if (!anchor) return [];
    const pids = this.safe(() => this.ctx.reg.people.disembark(anchor.id, { then: 'actor', to: to?.clone() }), [] as string[]);
    return pids.map((pid) => this.actors.adopt(pid, this.safe(() => this.ctx.reg.people.get(pid)?.role, undefined) ?? role)).filter((x): x is string => !!x);
  }
  /** send a vehicle on its way (home / out through a portal) */
  protected releaseVehicle(id: string | null): void { if (id) this.safe(() => this.ctx.reg.traffic.cancel(id), undefined); }

  /** register a temporary legitimate origin (e.g. the station cat's flap, a field gate, a circus-car ramp) */
  protected origin(o: Omit<Origin, 'owner'> & { owner?: string }): string {
    const full: Origin = { owner: 'events', ...o };
    try { this.onCleanup(this.ctx.origins.add(full)); } catch { /* no registry */ }
    return full.id;
  }

  /** an animal door at a fixed point for the duration of the event */
  protected animalGate(id: string, pos: THREE.Vector3, radius = 2.5): string {
    const p = pos.clone();
    return this.origin({ id, kind: 'door', pos: (o) => o.copy(p), radius, for: ['animals'], open: () => true });
  }

  /** Wait until the line has a clear window of `minutes` starting now (trains.nextGap), at most `max` sim min */
  protected lineWindow(line: LineId, minutes: number, max = 60): Wait {
    return { until: () => { const g = this.safe(() => this.ctx.reg.trains.nextGap(line, minutes), null); return !g || g.start <= this.now + 0.5; }, max };
  }
  protected onCleanup(f: () => void): void { this.cleanups.push(f); }
  protected on<K extends keyof Events>(k: K, fn: (p: Events[K]) => void): void { this.cleanups.push(this.ctx.bus.on(k, fn)); }
  protected decorate(obj: THREE.Object3D): void {
    this.decos.push(obj);
    try { this.ctx.reg.world.addDecoration(obj); } catch { this.group.add(obj); }
    if (!obj.parent) this.group.add(obj);
  }
  protected undecorate(obj: THREE.Object3D): void {
    const i = this.decos.indexOf(obj);
    if (i >= 0) this.decos.splice(i, 1);
    try { this.ctx.reg.world.removeDecoration(obj); } catch { /* ignore */ }
    obj.removeFromParent();
    disposeTree(obj);
  }
  protected marker(text: string, get: () => THREE.Vector3 | null, opts: { lift?: number; px?: number; bg?: string; fg?: string } = {}): Marker {
    const m = new Marker(this.group, text, opts.px ?? 30, opts.bg, opts.fg);
    this.markers.push({ m, get, lift: opts.lift ?? 2.4 });
    return m;
  }
  protected dropMarker(m: Marker): void {
    const i = this.markers.findIndex((x) => x.m === m);
    if (i >= 0) { this.markers[i].m.dispose(); this.markers.splice(i, 1); }
  }
  protected cue(cue: AudioCue, pos?: THREE.Vector3, volume = 1): void {
    this.ctx.bus.emit('audio:cue', { cue, pos: pos?.clone(), volume });
  }
  /** repeat an audio cue every [a,b] REAL seconds while the event runs (not while paused); returns stop fn */
  protected cueLoop(cue: AudioCue, every: [number, number], pos: () => THREE.Vector3 | undefined, vol = 0.8): () => void {
    const c = { cue, every, left: this.rng.range(every[0] * 0.3, every[1] * 0.6), pos, vol };
    this.cueTimers.push(c);
    return () => { const i = this.cueTimers.indexOf(c); if (i >= 0) this.cueTimers.splice(i, 1); };
  }
  protected gazette(h: string, kind: 'info' | 'warn' | 'event' = 'event'): void { this.env.gazette(h, kind); }
  protected walk(id: string, target: THREE.Vector3, opts?: WalkOpts): Wait { return this.actors.walk(id, target, opts); }
  /** wait until every Wait-returning walk is satisfied */
  protected all(ws: Wait[], max = 120): Wait {
    const done = ws.map(() => false);
    return {
      until: () => {
        let ok = true;
        ws.forEach((w, i) => {
          if (done[i]) return;
          if (typeof w === 'number') { done[i] = true; return; }
          const r = typeof w === 'function' ? w() : w.until();
          if (r) done[i] = true; else ok = false;
        });
        return ok;
      },
      max,
    };
  }
  /** attach obj to an actor (carried item); forward = metres ahead along walking direction. returns stop fn */
  protected carry(obj: THREE.Object3D, id: string, y = 1.05, forward = 0.35, yawOffset = 0): () => void {
    const prev = this.actors.pos(id).clone();
    let yaw = obj.rotation.y;
    let on = true;
    this.tick(() => {
      if (!on) return;
      const p = this.actors.pos(id);
      const dx = p.x - prev.x, dz = p.z - prev.z;
      if (dx * dx + dz * dz > 1e-5) yaw = Math.atan2(-dz, dx);
      prev.copy(p);
      obj.position.set(p.x + Math.cos(yaw) * forward, p.y + y, p.z - Math.sin(yaw) * forward);
      obj.rotation.y = yaw + yawOffset;
    });
    const stop = () => { on = false; };
    this.carries.set(obj, stop);
    return stop;
  }
  /**
   * Keep trains on `line` held at the home signals while the obstruction lasts. A short hold is re-issued every
   * sim minute (so a crashed script can never hold a line forever); on release the hold is cleared at once via
   * trains.releaseHold, unless another event still holds the same line.
   */
  protected holdLine(line: LineId, maxMin = HOLD_CAP): () => void {
    let on = true, acc = 1, held = 0;
    const put = () => { try { this.ctx.reg.trains.holdAtSignal(line, this.now + 1.6); } catch { /* stub */ } };
    put();
    lineHolds[line]++;
    this.tick((_dt, dm) => {
      if (!on) return;
      held += dm;
      // v2 disruption discipline: an event never holds a line for more than HOLD_CAP sim minutes
      if (held >= maxMin) { release(); return; }
      acc -= dm; if (acc <= 0) { acc = 1; put(); }
    });
    const release = () => {
      if (!on) return;
      on = false;
      lineHolds[line] = Math.max(0, lineHolds[line] - 1);
      if (lineHolds[line] === 0) { try { this.ctx.reg.trains.releaseHold(line); } catch { /* stub */ } }
    };
    this.onCleanup(release);
    return release;
  }
  protected get now(): number { return this.ctx.clock.minutes; }
  protected safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }
}

// ───────────────────────── placement helpers ─────────────────────────
export function platCenterT(ctx: Ctx, pid: PlatformId): number {
  const L = ctx.layout.lines[ctx.layout.platforms[pid].line];
  return (L.platformStartT + L.platformEndT) / 2;
}
/** point on platform: along = metres from centre (east +), lat = metres from track centreline toward the back */
export function onPlatform(ctx: Ctx, pid: PlatformId, along: number, lat: number, y = 1.0): THREE.Vector3 {
  const P = ctx.layout.platforms[pid];
  const L = ctx.layout.lines[P.line];
  return L.offsetPoint(platCenterT(ctx, pid) + along / L.length, L.platformSide * lat, y);
}
export function onTrack(ctx: Ctx, line: LineId, t: number, y = 0.3, lateral = 0): THREE.Vector3 {
  return ctx.layout.lines[line].offsetPoint(t, lateral, y);
}
/**
 * A (non-ghost) train whose body covers, or whose head is about to reach, curve t on `line`.
 * ahead = metres in front of the head that count as "about to reach".
 */
export function trainThreat(ctx: Ctx, line: LineId, t: number, ahead = 45, margin = 6): TrainInfo | null {
  const L = ctx.layout.lines[line];
  let list: TrainInfo[] = [];
  try { list = ctx.reg.trains.list(); } catch { return null; }
  for (const tr of list) {
    if (tr.line !== line || tr.ghost || tr.state === 'inShed' || tr.state === 'toShed' || tr.state === 'fromShed') continue;
    const lenT = tr.length / L.length, a = ahead / L.length, m = margin / L.length;
    const lo = tr.dir === 'east' ? tr.headT - lenT - m : tr.headT - (tr.speed > 0.2 ? a : m);
    const hi = tr.dir === 'east' ? tr.headT + (tr.speed > 0.2 ? a : m) : tr.headT + lenT + m;
    if (t >= lo && t <= hi) return tr;
  }
  return null;
}
/** true when no train occupies the station section of `line` (between the home signals, ± slack) */
export function lineClear(ctx: Ctx, line: LineId, slack = 60): boolean {
  const L = ctx.layout.lines[line];
  const a = L.signalT.east - slack / L.length, b = L.signalT.west + slack / L.length;
  let list: TrainInfo[] = [];
  try { list = ctx.reg.trains.list(); } catch { return true; }
  return !list.some((tr) => {
    if (tr.line !== line || tr.ghost || tr.state === 'inShed' || tr.state === 'waitingSignal') return false;
    const lenT = tr.length / L.length;
    const lo = tr.dir === 'east' ? tr.headT - lenT : tr.headT, hi = tr.dir === 'east' ? tr.headT : tr.headT + lenT;
    return hi >= a && lo <= b && tr.state !== 'toShed';
  });
}
/** metres along platform from its centre for a world point */
export function alongOf(ctx: Ctx, pid: PlatformId, p: THREE.Vector3): number {
  const L = ctx.layout.lines[ctx.layout.platforms[pid].line];
  return (L.nearestT(p) - platCenterT(ctx, pid)) * L.length;
}
export function lineOfPlatform(ctx: Ctx, pid: PlatformId): LineId { return ctx.layout.platforms[pid].line; }
export function node(ctx: Ctx, id: string): THREE.Vector3 { return (ctx.layout.nav.nodes[id] ?? ctx.layout.entrance).clone(); }
export function otherDir(d: Dir): Dir { return d === 'east' ? 'west' : 'east'; }

// ───────────────────────── Victorian flavour ─────────────────────────
export const NAMES_M = ['Mr. Bartholomew Pike', 'Col. Ambrose Fitzwilliam', 'Mr. Silas Thackeray', 'the Rev. Josiah Plum', 'Mr. Horace Wetherby', 'Sir Percival Hartley', 'Mr. Ebenezer Crumb', 'Dr. Augustus Pennyfeather'];
export const NAMES_F = ['Mrs. Agatha Pennywhistle', 'Miss Constance Hargreaves', 'Lady Philippa Ashcombe', 'Miss Hester Merriweather', 'Mrs. Euphemia Tolliver', 'the Dowager Lady Bramble', 'Miss Clementine Rook'];
export const STATION = 'the Junction';
