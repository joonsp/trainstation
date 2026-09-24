import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { CritterInfo, CritterKind } from '../core/apis';
import type { InstancedRig } from '../core/rig';
import type { Poly } from '../core/layout';
import { pointInPoly } from '../core/poly';

/**
 * Shared bookkeeping for every living thing nature owns: a registry (list/get/raycast/stats), the pick radius,
 * visibility + level-of-detail helpers and the path helpers used by herds, dogs and trips.
 */
export interface Critter {
  info: CritterInfo;
  kind: CritterKind;
  /** instance slot in its rig (−1 = none) */
  slot: number;
  rig: InstancedRig | null;
  /** hidden inside a building / off-map (not listed as present) */
  away: boolean;
  radius: number;
}

export class Registry {
  readonly all: Critter[] = [];
  private byId = new Map<string, Critter>();
  private seq = 0;
  private cache: CritterInfo[] | null = null;
  birdsFlying = 0;

  add(kind: CritterKind, pos: THREE.Vector3, label: string, group?: string, radius = 1): Critter {
    const id = `${kind}:${++this.seq}`;
    const c: Critter = { info: { id, kind, pos: pos.clone(), state: 'idle', group, label }, kind, slot: -1, rig: null, away: false, radius };
    this.all.push(c);
    this.byId.set(id, c);
    this.cache = null;
    return c;
  }
  remove(c: Critter): void {
    const i = this.all.indexOf(c);
    if (i >= 0) this.all.splice(i, 1);
    this.byId.delete(c.info.id);
    this.cache = null;
  }
  get(id: string): Critter | undefined { return this.byId.get(id); }
  list(kind?: CritterKind): CritterInfo[] {
    if (!this.cache) this.cache = this.all.filter((c) => !c.away).map((c) => c.info);
    return kind ? this.cache.filter((i) => i.kind === kind) : this.cache;
  }
  invalidate(): void { this.cache = null; }
  count(kinds?: CritterKind[]): number {
    let n = 0;
    for (const c of this.all) if (!c.away && (!kinds || kinds.includes(c.kind))) n++;
    return n;
  }
  byKind(): Partial<Record<CritterKind, number>> {
    const o: Partial<Record<CritterKind, number>> = {};
    for (const c of this.all) if (!c.away) o[c.kind] = (o[c.kind] ?? 0) + 1;
    return o;
  }
  /** nearest critter hit by the ray (sphere test) */
  raycast(r: THREE.Raycaster, isVisible: (p: THREE.Vector3) => boolean): Critter | null {
    let best: Critter | null = null, bd = Infinity;
    const ray = r.ray, tmp = _v;
    for (const c of this.all) {
      if (c.away) continue;
      tmp.copy(c.info.pos);
      tmp.y += c.radius * 0.6;
      if (!isVisible(tmp)) continue;
      const d2 = ray.distanceSqToPoint(tmp);
      const rr = c.radius * c.radius * 1.4 + 0.3;
      if (d2 > rr) continue;
      const along = tmp.sub(ray.origin).dot(ray.direction);
      if (along < bd) { bd = along; best = c; }
    }
    return best;
  }
}
const _v = new THREE.Vector3();

/** LOD helper: accumulates motion time and says when a far critter should tick (2 Hz) */
export class Ticker {
  private acc = 0;
  /** returns the dt to integrate now (0 = skip this sub-step) */
  step(dt: number, near: boolean): number {
    if (near) { const a = this.acc + dt; this.acc = 0; return a; }
    this.acc += dt;
    if (this.acc >= 0.5) { const a = this.acc; this.acc = 0; return a; }
    return 0;
  }
}

/** point-in-field with an inset margin */
export function insideField(poly: THREE.Vector2[], x: number, z: number, margin: number): boolean {
  if (!pointInPoly(x, z, poly)) return false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const abx = b.x - a.x, abz = b.y - a.y;
    const l2 = abx * abx + abz * abz || 1e-9;
    const u = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.y) * abz) / l2));
    if (Math.hypot(x - (a.x + abx * u), z - (a.y + abz * u)) < margin) return false;
  }
  return true;
}

export function polyCentroid(poly: THREE.Vector2[]): THREE.Vector2 {
  const c = new THREE.Vector2();
  for (const v of poly) c.add(v);
  return c.multiplyScalar(1 / poly.length);
}

/** random point inside a field polygon (rejection sampling) */
export function randomInField(poly: THREE.Vector2[], margin: number, rnd: () => number, out = new THREE.Vector2()): THREE.Vector2 {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const v of poly) { minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x); minz = Math.min(minz, v.y); maxz = Math.max(maxz, v.y); }
  for (let k = 0; k < 40; k++) {
    const x = minx + (maxx - minx) * rnd(), z = minz + (maxz - minz) * rnd();
    if (insideField(poly, x, z, margin)) return out.set(x, z);
  }
  return out.copy(polyCentroid(poly));
}

/**
 * A walking route along roads between two points (both ends connected straight to the nearest road samples).
 * Returns points every ~3 m with y = road/ground height. Used by cow trips, drovers' flocks and dogs.
 */
export function roadWalk(ctx: Ctx, from: THREE.Vector3, to: THREE.Vector3, lateral = 0): THREE.Vector3[] {
  const L = ctx.layout;
  const out: THREE.Vector3[] = [from.clone()];
  const ea = L.nearestRoad(from), eb = L.nearestRoad(to);
  const pushEdge = (poly: Poly, s0: number, s1: number, lat: number) => {
    const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / 3));
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n;
      const dir = s1 >= s0 ? 1 : -1;
      const p = poly.offset(s, lat * dir);
      p.y = L.heightAt(p.x, p.z);
      out.push(p);
    }
  };
  if (ea.edge === eb.edge && ea.d < 30 && eb.d < 30) {
    pushEdge(L.roads.edges[ea.edge].poly, ea.s, eb.s, lateral);
  } else {
    const route = L.roadPath(from, to);
    if (route) {
      const pts: THREE.Vector3[] = [];
      const o = { pos: new THREE.Vector3(), yaw: 0 };
      for (let d = 0; d <= route.length; d += 3) { route.sample(d, lateral, o); pts.push(o.pos.clone().setY(L.heightAt(o.pos.x, o.pos.z))); }
      route.sample(route.length, lateral, o); pts.push(o.pos.clone().setY(L.heightAt(o.pos.x, o.pos.z)));
      // trim the node-snapping detours at both ends
      let i0 = 0, i1 = pts.length - 1, b0 = Infinity, b1 = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const da = pts[i].distanceTo(from), db = pts[i].distanceTo(to);
        if (i < pts.length * 0.6 && da < b0) { b0 = da; i0 = i; }
        if (i > pts.length * 0.4 && db < b1) { b1 = db; i1 = i; }
      }
      out.push(...pts.slice(i0, Math.max(i0 + 1, i1 + 1)));
    }
  }
  out.push(to.clone());
  return out;
}

/** a simple polyline walker (xz arc length), no allocations when sampling */
export class Path {
  readonly pts: THREE.Vector3[];
  readonly cum: number[];
  readonly length: number;
  constructor(pts: THREE.Vector3[]) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    this.length = this.cum[this.cum.length - 1];
  }
  at(d: number, out: THREE.Vector3): THREE.Vector3 {
    const c = this.cum;
    if (d <= 0) return out.copy(this.pts[0]);
    if (d >= this.length) return out.copy(this.pts[this.pts.length - 1]);
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
    const u = (d - c[lo]) / (c[hi] - c[lo] || 1);
    return out.lerpVectors(this.pts[lo], this.pts[hi], u);
  }
  /** heading (rotation.y) at d */
  yawAt(d: number): number {
    const a = this.at(Math.max(0, d - 1), _pa), b = this.at(Math.min(this.length, d + 1), _pb);
    return Math.atan2(-(b.z - a.z), b.x - a.x);
  }
}
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3();
