/**
 * Actors (v2): a thin, defensive wrapper over the people system's ORIGIN-BASED actor API.
 * Nobody but people draws humans, and nobody appears out of nowhere:
 *   - summon(role, target)   → people.summonActor: walks in from the best door / portal (or a given origin)
 *   - crowd(n, near)         → people.summonCrowd: drawn from people already present, then from origins
 *   - inside(originId, role) → people.spawnInside: steps out of a door / train door / stopped vehicle
 *   - dismiss(id, to?)       → people.dismissActor: walks to a sink (door / portal / vehicle) and fades through it
 * Arrival is detected synchronously (promise flag OR distance OR timeout) so scripts work inside
 * __station.advance(), which runs without microtasks.
 */
import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { Anchor, IdleStyle, PersonAnim, PersonRole, PersonSpec } from '../core/apis';
import type { Rng } from '../core/rng';
import type { Wait } from './runner';

interface Handle {
  pid: string;
  last: THREE.Vector3;
  role: PersonRole;
  /** where the actor was summoned to (arrival test) */
  target: THREE.Vector3 | null;
  arrived: { done: boolean };
  timeout: number;
}

export interface WalkOpts { speed?: number; run?: boolean; direct?: boolean }

let seq = 0;
const _v = new THREE.Vector3();

export class Actors {
  private map = new Map<string, Handle>();
  private tmp = new THREE.Vector3();
  /** pids we dismissed and are still walking to their sink (for carried props) */
  private leaving = new Set<string>();

  /** `_parent` kept for v1 callers (maintenance); v2 actors are all drawn by the people system */
  constructor(private ctx: Ctx, private rng: Rng, _parent?: THREE.Object3D) {}

  /**
   * v1 compat (maintenance): people.spawnActor is origin-aware in v2 — at a legitimate origin it steps out there,
   * anywhere else it is SUMMONED from the best door/portal and walks in.
   */
  spawn(role: PersonRole, pos: THREE.Vector3): string {
    const pid = this.safe(() => this.people.spawnActor(role, pos.clone()), '');
    return this.wrap(pid, role, pos) ?? `A${++seq}-none`;
  }

  /** v1 compat: nothing to animate locally any more */
  update(_dt: number, _dtMotion: number): void { /* people animates everyone */ }

  private get people() { return this.ctx.reg.people; }

  private wrap(pid: string | null | undefined, role: PersonRole, target: THREE.Vector3 | null, arrived?: Promise<unknown>, timeout = 90): string | null {
    if (!pid) return null;
    const id = `A${++seq}`;
    const flag = { done: false };
    if (arrived) arrived.then(() => { flag.done = true; }, () => { flag.done = true; });
    const info = this.safe(() => this.people.get(pid), undefined);
    this.map.set(id, { pid, last: info ? info.position.clone() : (target?.clone() ?? new THREE.Vector3()), role, target: target?.clone() ?? null, arrived: flag, timeout });
    return id;
  }

  private safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }

  /** walk in from the best legitimate origin (or opts.from) to `target` */
  summon(role: PersonRole, target: THREE.Vector3, opts: { from?: string; run?: boolean; timeoutMin?: number; spec?: Partial<PersonSpec> } = {}): string | null {
    const r = this.safe(() => this.people.summonActor(role, target.clone(), opts), null);
    return r ? this.wrap(r.id, role, target, r.arrived, opts.timeoutMin ?? 90) : null;
  }

  /** a crowd gathers near a point */
  crowd(n: number, near: THREE.Vector3, role: PersonRole = 'passenger', spread = 3, timeoutMin = 60): string[] {
    const r = this.safe(() => this.people.summonCrowd(n, near.clone(), role, { spread, timeoutMin }), null);
    if (!r) return [];
    const out: string[] = [];
    for (const pid of r.ids) {
      const id = this.wrap(pid, role, null, undefined, timeoutMin);
      if (id) out.push(id);
    }
    return out;
  }

  /** people created inside a legitimate origin (door / train door / stopped vehicle), stepping out of it */
  inside(originId: string, specs: PersonSpec[]): string[] {
    const pids = this.safe(() => this.people.spawnInside(originId, specs), [] as string[]);
    const out: string[] = [];
    pids.forEach((pid, i) => { const id = this.wrap(pid, specs[i]?.role ?? 'passenger', null); if (id) out.push(id); });
    return out;
  }

  /** adopt an existing person (e.g. riders who just stepped down from a vehicle) */
  adopt(pid: string, role: PersonRole): string | null { return this.wrap(pid, role, null); }

  /**
   * an actor stepping out of the open train door nearest `near` (train-door origin registered by trains);
   * falls back to the nearest station door when trains registers none.
   */
  fromTrain(role: PersonRole, near: THREE.Vector3, spec: Partial<PersonSpec> = {}): string | null {
    const o = this.trainDoor(near);
    if (o) {
      const ids = this.inside(o, [{ role, ...spec }]);
      if (ids.length) return ids[0];
    }
    return this.summon(role, near, { from: this.stationDoorNear(near), spec });
  }

  /** id of the open train-door origin nearest `near` (within 30 m), or null */
  trainDoor(near: THREE.Vector3): string | null {
    const o = this.safe(() => this.ctx.origins.nearest(near, 'people', { kinds: ['train'], maxDist: 30 }), null);
    return o ? o.id : null;
  }

  stationDoorNear(p: THREE.Vector3): string {
    const ids = ['door:station:p1', 'door:station:p2', 'door:station:east'];
    let best = ids[0], bd = Infinity;
    for (const id of ids) {
      const o = this.ctx.origins.get(id);
      if (!o) continue;
      const d = o.pos(_v).distanceTo(p);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  has(id: string): boolean { return this.map.has(id); }
  pid(id: string): string | null { return this.map.get(id)?.pid ?? null; }

  /** true while the underlying person still exists */
  alive(id: string): boolean {
    const h = this.map.get(id);
    return !!h && !!this.safe(() => this.people.get(h.pid), undefined);
  }

  /** position, or null once the actor is gone (for markers / focus) */
  at(id: string): THREE.Vector3 | null { return this.map.has(id) ? this.pos(id) : null; }

  /** current position (internal vector: copy before mutating) */
  pos(id: string): THREE.Vector3 {
    const h = this.map.get(id);
    if (!h) return this.tmp.set(0, -100, 0);
    const p = this.safe(() => this.people.get(h.pid)?.position, undefined);
    if (p) h.last.copy(p);
    return h.last;
  }

  /** Wait: the summoned actor reached its summon target (promise, distance or timeout) */
  arrived(id: string, near = 2.5): Wait {
    const h = this.map.get(id);
    if (!h) return 0;
    return {
      until: () => {
        if (h.arrived.done || !this.map.has(id)) return true;
        const info = this.safe(() => this.people.get(h.pid), undefined);
        if (!info) return true;
        return !!h.target && Math.hypot(info.position.x - h.target.x, info.position.z - h.target.z) < near;
      },
      max: h.timeout,
    };
  }

  /** start walking; returns a Wait satisfied on arrival (or timeout) */
  walk(id: string, target: THREE.Vector3, opts: WalkOpts = {}): Wait {
    const h = this.map.get(id);
    if (!h) return 0;
    const tgt = target.clone();
    const speed = opts.speed ?? (opts.run ? 3.4 : 1.4);
    const from = this.pos(id).clone();
    const max = (from.distanceTo(tgt) * 2.2) / speed + 12;
    const flag = { done: false };
    try {
      this.people.walkTo(h.pid, tgt, opts).then(() => { flag.done = true; }, () => { flag.done = true; });
    } catch { flag.done = true; }
    return {
      until: () => {
        if (flag.done || !this.map.has(id)) return true;
        const info = this.safe(() => this.people.get(h.pid), undefined);
        if (!info) return true;
        return Math.hypot(info.position.x - tgt.x, info.position.z - tgt.z) < 0.6;
      },
      max,
    };
  }

  /** re-target without needing the Wait (chases) */
  steer(id: string, target: THREE.Vector3, opts: WalkOpts = {}): void { this.walk(id, target, opts); }

  anim(id: string, a: PersonAnim): void {
    const h = this.map.get(id);
    if (h) this.safe(() => this.people.setAnim(h.pid, a), undefined);
  }

  idle(id: string, style: IdleStyle | null): void {
    const h = this.map.get(id);
    if (h) this.safe(() => this.people.setIdle(h.pid, style), undefined);
  }

  look(id: string, target: THREE.Vector3 | null): void {
    const h = this.map.get(id);
    if (h) this.safe(() => this.people.lookAt(h.pid, target ? target.clone() : null), undefined);
  }

  /** seat actors on a moving anchor (vehicle / boat / balloon basket) */
  ride(ids: string[], anchor: Anchor, seats?: number[]): void {
    const pids = ids.map((i) => this.map.get(i)?.pid).filter((p): p is string => !!p);
    if (pids.length) this.safe(() => this.people.ride(pids, anchor, seats), undefined);
  }

  /** walk to an anchor and board it; returns a Wait (seated or timed out) */
  embark(ids: string[], anchor: Anchor, max = 30): Wait {
    const pids = ids.map((i) => this.map.get(i)?.pid).filter((p): p is string => !!p);
    const flag = { done: false };
    try { this.people.embark(pids, anchor).then(() => { flag.done = true; }, () => { flag.done = true; }); } catch { flag.done = true; }
    return { until: () => flag.done || pids.every((p) => !!this.safe(() => this.people.get(p)?.riding, undefined)), max };
  }

  /**
   * walk to a sink and fade through it (people's dismiss). The handle is dropped at once; `gone(pid)` tells when
   * the person has actually left (for props they carry).
   */
  dismiss(id: string, opts: { to?: string; run?: boolean } = {}): string | null {
    const h = this.map.get(id);
    if (!h) return null;
    this.map.delete(id);
    this.leaving.add(h.pid);
    try { void this.people.dismissActor(h.pid, opts).catch(() => undefined); } catch { /* stub */ }
    return h.pid;
  }

  /** true once a dismissed / removed person no longer exists */
  gone(pid: string | null): boolean {
    if (!pid) return true;
    const alive = !!this.safe(() => this.people.get(pid), undefined);
    if (!alive) this.leaving.delete(pid);
    return !alive;
  }

  /** stop managing an actor WITHOUT dismissing them (they now ride a vehicle / belong to another system) */
  release(id: string): void { this.map.delete(id); }

  /** v1 name kept for scripts: dismiss */
  remove(id: string, to?: string): void { this.dismiss(id, to ? { to } : {}); }

  /** event end: everyone still held walks off to a sink */
  removeAll(): void { for (const id of [...this.map.keys()]) this.dismiss(id); }

  ids(): string[] { return [...this.map.keys()]; }

  /** nearest live person (optional role filter) to p, within maxDist — for "pick someone in the crowd" */
  nearestPerson(p: THREE.Vector3, maxDist: number, roles?: PersonRole[]): string | null {
    const list = this.safe(() => this.people.list(), []);
    let best: string | null = null, bd = maxDist;
    for (const x of list) {
      if (roles && !roles.includes(x.role)) continue;
      if (x.riding) continue;
      const d = Math.hypot(x.position.x - p.x, x.position.z - p.z);
      if (d < bd) { bd = d; best = x.id; }
    }
    return best;
  }

  /** random helper for scripts */
  jitter(p: THREE.Vector3, r: number): THREE.Vector3 {
    const a = this.rng.range(0, Math.PI * 2), d = this.rng.range(0, r);
    return p.clone().add(new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d));
  }
}
