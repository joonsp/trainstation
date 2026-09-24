import * as THREE from 'three';
import type { Layout } from '../core/layout';
import type { RoadRoute, RouteLeg, Building } from '../core/countryside';
import { Poly, localToWorld } from '../core/poly';

/**
 * TRAFFIC ROUTER. Builds RoadRoutes (compatible with core/movers Flow) over the layout road graph PLUS
 * traffic-private edges:
 *  - the forecourt loop 'FC' (layout edge, excluded from core's roadPath) entered from K's inbound lane and left
 *    onto K's outbound lane;
 *  - door spurs 'spur:<originId>' from inside a depot building (mews, barns, stables, engine house) out through
 *    its door to the nearest road point — vehicles spawn/despawn INSIDE the building (walls hide them).
 * Routing never U-turns: a vehicle arriving at a node on edge e may not leave on e in the opposite direction.
 */

export type Pt =
  | { k: 'node'; id: string }
  | { k: 'edge'; edge: string; s: number }
  | { k: 'loop'; s: number }
  | { k: 'door'; origin: string };

interface Seg { edge: string; dir: 1 | -1; s0: number; s1: number; from: string; to: string; len: number }

export interface Spur { id: string; origin: string; poly: Poly; edge: string; s: number; door: THREE.Vector3; doorD: number; building: Building }

const _v = new THREE.Vector3();
/** routing penalty (m) for turning a vehicle round in the road */
const TURN_COST = 30;

export class Router {
  readonly polys = new Map<string, Poly>();
  readonly lanes = new Map<string, number>();
  /** road nodes lying on each edge (sorted by s) */
  private onEdge = new Map<string, { id: string; s: number }[]>();
  private arcs = new Map<string, Seg[]>();
  readonly spurs = new Map<string, Spur>();
  /** K s where the forecourt loop starts (inbound lane) / ends (outbound lane) */
  readonly kIn: number;
  readonly kOut: number;
  readonly loopLen: number;

  constructor(readonly L: Layout) {
    const E = L.roads.edges;
    for (const e of Object.values(E)) {
      this.polys.set(e.id, e.poly);
      this.lanes.set(e.id, e.kind === 'loop' ? 0.55 : e.lanes === 2 ? -e.width / 4 : 0);
    }
    const loop = L.forecourtTraffic.loop;
    this.loopLen = loop.length;
    const K = E.K.poly;
    this.kIn = K.nearest(loop.pts[0].x, loop.pts[0].z).s;
    const lp = loop.pts[loop.pts.length - 1];
    this.kOut = K.nearest(lp.x, lp.z).s;
    // nodes on edges
    for (const e of Object.values(E)) {
      if (e.kind === 'loop') continue;
      const on: { id: string; s: number }[] = [];
      for (const n of Object.values(L.roads.nodes)) {
        const q = e.poly.nearest(n.pos.x, n.pos.z);
        if (q.d < 0.8) on.push({ id: n.id, s: q.s });
      }
      on.sort((a, b) => a.s - b.s);
      this.onEdge.set(e.id, on);
      for (let k = 0; k < on.length - 1; k++) {
        const a = on[k], b = on[k + 1];
        if (b.s - a.s < 0.5) continue;
        let s0 = a.s, s1 = b.s;
        // K's entrance end: the loop joins at kIn/kOut, never at s 0
        this.addArc({ edge: e.id, dir: 1, s0: e.id === 'K' && a.id === 'entrance' ? this.kOut : s0, s1, from: a.id, to: b.id, len: 0 });
        this.addArc({ edge: e.id, dir: -1, s0: s1, s1: e.id === 'K' && a.id === 'entrance' ? this.kIn : s0, from: b.id, to: a.id, len: 0 });
      }
    }
  }

  private addArc(a: Seg) { a.len = Math.abs(a.s1 - a.s0); const l = this.arcs.get(a.from) ?? []; l.push(a); this.arcs.set(a.from, l); }

  poly(edge: string): Poly | undefined { return this.polys.get(edge); }

  /** a spur from inside a depot building through its door to the nearest road point */
  spurFor(originId: string): Spur | null {
    const have = this.spurs.get(originId);
    if (have) return have;
    const o = this.L.origins.find((x) => x.id === originId);
    if (!o || o.kind !== 'door' || !o.building) return null;
    const b = this.L.buildings.find((x) => x.id === o.building);
    if (!b) return null;
    const door = o.pos.clone();
    // road join point: the mews yard node for the Crown Mews, else the nearest road edge point
    let edge: string, s: number, join: THREE.Vector3;
    if (b.kind === 'mews') { edge = this.L.mews.road; const P = this.polys.get(edge)!; s = P.length; join = P.at(s); }
    else {
      const q = this.L.nearestRoad(door);
      if (!q.edge || q.edge === 'FC' || q.d > 40) return null;
      edge = q.edge; s = q.s; join = this.polys.get(edge)!.at(s);
    }
    // inside path: door → centre line of the building → along the frontage (so a long vehicle fits inside)
    const [dlx] = worldLocal(b, door);
    const side = dlx > 0 ? -1 : 1;
    const depthIn = b.size.z / 2;
    const run = Math.max(2, b.size.x / 2 - 1.2);
    const yIn = b.center.y;
    const pIn0 = localToWorld(b.center, b.yaw, dlx, depthIn - 1.2, yIn);
    const pMid = localToWorld(b.center, b.yaw, dlx, 0, yIn);
    const pEnd = localToWorld(b.center, b.yaw, dlx + side * run, -0.2, yIn);
    const out = localToWorld(b.center, b.yaw, dlx, b.size.z / 2 + 2.2, door.y);
    const ctrl = [pEnd, pMid, pIn0, door.clone(), out, join.clone()];
    const poly = Poly.smooth(ctrl, 1);
    const doorD = poly.nearest(door.x, door.z).s;
    const sp: Spur = { id: `spur:${originId}`, origin: originId, poly, edge, s, door, doorD, building: b };
    this.spurs.set(originId, sp);
    this.polys.set(sp.id, poly);
    this.lanes.set(sp.id, 0);
    return sp;
  }

  /** metres available inside a depot from its innermost point to the door */
  insideLength(originId: string): number { const sp = this.spurFor(originId); return sp ? sp.doorD : 0; }

  // ─────────────── route building ───────────────

  /**
   * Route from `a` (with incoming travel direction if continuing) through waypoints to `b`.
   * Returns null if unreachable.
   */
  plan(pts: Pt[]): { route: RoadRoute; marks: number[] } | null {
    const legs: RouteLeg[] = [];
    const marks: number[] = [];
    let cur: Cursor | null = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i === 0) {
        const c = this.startCursor(p, legs);
        if (!c) return null;
        cur = c;
        marks.push(0);
        continue;
      }
      const res = this.connect(cur!, p, legs);
      if (!res) return null;
      cur = res;
      marks.push(sumLegs(legs));
    }
    return { route: this.makeRoute(legs), marks };
  }

  /** continue an existing route from distance d (keeps the prefix so d stays valid) */
  replanFrom(route: RoadRoute, d: number, pts: Pt[]): { route: RoadRoute; marks: number[] } | null {
    const q = route.locate(d);
    const legs: RouteLeg[] = [];
    for (let k = 0; k < q.leg; k++) legs.push({ ...route.legs[k] });
    const L0 = route.legs[q.leg];
    if (L0) legs.push({ edge: L0.edge, dir: L0.dir, s0: L0.s0, s1: q.s });
    const cur = this.cursorAt(q.edge, q.s, q.dir);
    if (!cur) return null;
    const marks: number[] = [];
    let c: Cursor = cur;
    for (const p of pts) {
      const r = this.connect(c, p, legs);
      if (!r) return null;
      c = r;
      marks.push(sumLegs(legs));
    }
    return { route: this.makeRoute(legs.filter((l) => Math.abs(l.s1 - l.s0) > 1e-6)), marks };
  }

  private startCursor(p: Pt, legs: RouteLeg[]): Cursor | null {
    if (p.k === 'node') return { at: 'node', node: p.id, inEdge: null };
    if (p.k === 'door') {
      const sp = this.spurFor(p.origin);
      if (!sp) return null;
      legs.push({ edge: sp.id, dir: 1, s0: 0, s1: sp.poly.length });
      return { at: 'edge', edge: sp.edge, s: sp.s, dir: 0 };
    }
    if (p.k === 'edge') return { at: 'edge', edge: p.edge, s: p.s, dir: 0 };
    return this.cursorAt('FC', p.s, 1);
  }

  private cursorAt(edge: string, s: number, dir: 1 | -1): Cursor | null {
    if (edge === 'FC') return { at: 'loop', s };
    if (edge.startsWith('spur:')) {
      const sp = [...this.spurs.values()].find((x) => x.id === edge);
      if (!sp) return null;
      return dir > 0 ? { at: 'edge', edge: sp.edge, s: sp.s, dir: 0, pre: { edge, s0: s, s1: sp.poly.length } } : null;
    }
    return { at: 'edge', edge, s, dir };
  }

  /** append legs from cursor to target; returns the new cursor */
  private connect(c: Cursor, p: Pt, legs: RouteLeg[]): Cursor | null {
    if (c.at === 'edge' && c.pre) { legs.push({ edge: c.pre.edge, dir: 1, s0: c.pre.s0, s1: c.pre.s1 }); c = { ...c, pre: undefined }; }
    // leaving the loop: finish it and join K outbound
    if (c.at === 'loop') {
      if (p.k === 'loop' && p.s >= c.s - 0.01) { legs.push({ edge: 'FC', dir: 1, s0: c.s, s1: p.s }); return { at: 'loop', s: p.s }; }
      legs.push({ edge: 'FC', dir: 1, s0: c.s, s1: this.loopLen });
      c = { at: 'edge', edge: 'K', s: this.kOut, dir: 1 };
    }
    // target description
    let tEdge: string | null = null, tS = 0, tNode: string | null = null, tail: RouteLeg | null = null, tDoor: Spur | null = null;
    if (p.k === 'node') tNode = p.id;
    else if (p.k === 'edge') { tEdge = p.edge; tS = p.s; }
    else if (p.k === 'loop') { tEdge = 'K'; tS = this.kIn; tail = { edge: 'FC', dir: 1, s0: 0, s1: p.s }; }
    else { const sp = this.spurFor(p.origin); if (!sp) return null; tDoor = sp; tEdge = sp.edge; tS = sp.s; }
    const needDir: 0 | 1 | -1 = p.k === 'loop' ? -1 : 0;

    const best = this.search(c, tNode, tEdge, tS, needDir);
    if (!best) return null;
    for (const l of best) legs.push(l);
    if (tail) { legs.push(tail); return { at: 'loop', s: tail.s1 }; }
    if (tDoor) { legs.push({ edge: tDoor.id, dir: -1, s0: tDoor.poly.length, s1: 0 }); return { at: 'node', node: '__inside', inEdge: null }; }
    const last = best[best.length - 1];
    if (tNode) return { at: 'node', node: tNode, inEdge: last ? { edge: last.edge, dir: last.dir } : (c.at === 'node' ? c.inEdge : null) };
    return { at: 'edge', edge: tEdge!, s: tS, dir: last ? last.dir : (c.at === 'edge' ? (c.dir || 1) as 1 | -1 : 1), turn: true };
  }

  /** Dijkstra over (node, incoming edge/dir) states; returns legs */
  private search(c: Cursor, tNode: string | null, tEdge: string | null, tS: number, needDir: 0 | 1 | -1): RouteLeg[] | null {
    type St = { node: string; inE: string | null; inD: number; cost: number; legs: RouteLeg[] };
    const open: St[] = [];
    let bestDone: { cost: number; legs: RouteLeg[] } | null = null;
    // direct hit on the same edge
    if (c.at === 'edge' && tEdge === c.edge) {
      const dir = tS >= c.s ? 1 : -1;
      const straight = c.dir === 0 || c.dir === dir;
      if ((straight || c.turn) && (needDir === 0 || needDir === dir) && !this.nodeBetween(c.edge, c.s, tS)) {
        const pre = straight ? [] : [this.turnLeg(c.edge, c.s, c.dir as 1 | -1)];
        bestDone = { cost: Math.abs(tS - c.s) + (straight ? 0 : TURN_COST), legs: [...pre, ...(Math.abs(tS - c.s) > 1e-6 ? [{ edge: c.edge, dir: dir as 1 | -1, s0: c.s, s1: tS }] : [])] };
      }
    }
    if (c.at === 'node') {
      if (tNode === c.node) return [];
      open.push({ node: c.node, inE: c.inEdge?.edge ?? null, inD: c.inEdge?.dir ?? 0, cost: 0, legs: [] });
    } else if (c.at === 'edge') {
      const on = this.onEdge.get(c.edge) ?? [];
      for (const dir of [1, -1] as const) {
        const turning = c.dir !== 0 && c.dir !== dir;
        if (turning && !c.turn) continue;
        // next node in this direction
        let n: { id: string; s: number } | undefined;
        if (dir > 0) n = on.find((x) => x.s > c.s + 0.01); else n = [...on].reverse().find((x) => x.s < c.s - 0.01);
        if (!n) continue;
        let s1 = n.s;
        if (c.edge === 'K' && n.id === 'entrance') s1 = this.kIn;
        if (dir < 0 && s1 > c.s) continue;
        if (turning && c.edge === 'K' && c.s < this.kOut + 12) continue; // never turn in the forecourt mouth
        const pre = turning ? [this.turnLeg(c.edge, c.s, c.dir as 1 | -1)] : [];
        open.push({ node: n.id, inE: c.edge, inD: dir, cost: Math.abs(s1 - c.s) + (turning ? TURN_COST : 0), legs: [...pre, { edge: c.edge, dir, s0: c.s, s1 }] });
      }
    }
    const seen = new Map<string, number>();
    while (open.length) {
      open.sort((a, b) => a.cost - b.cost);
      const st = open.shift()!;
      if (bestDone && st.cost >= bestDone.cost) break;
      const key = `${st.node}|${st.inE}|${st.inD}`;
      if ((seen.get(key) ?? Infinity) <= st.cost) continue;
      seen.set(key, st.cost);
      if (tNode && st.node === tNode) { bestDone = { cost: st.cost, legs: st.legs }; break; }
      // the entrance node is the forecourt: arriving there means you must go round the loop
      if (st.node === 'entrance') {
        if (tEdge === 'K' && needDir === -1 && Math.abs(tS - this.kIn) < 0.5) { bestDone = { cost: st.cost, legs: st.legs }; break; }
        const nl = [...st.legs, { edge: 'FC', dir: 1 as const, s0: 0, s1: this.loopLen }];
        // continue on K outbound from kOut
        const on = this.onEdge.get('K')!;
        const n = on.find((x) => x.s > this.kOut + 0.01);
        if (n) open.push({ node: n.id, inE: 'K', inD: 1, cost: st.cost + this.loopLen + (n.s - this.kOut), legs: [...nl, { edge: 'K', dir: 1, s0: this.kOut, s1: n.s }] });
        continue;
      }
      for (const a of this.arcs.get(st.node) ?? []) {
        if (st.inE === a.edge && st.inD === -a.dir && (this.arcs.get(st.node)?.length ?? 0) > 1) continue; // no U-turn
        // target on this arc?
        if (tEdge === a.edge) {
          const lo = Math.min(a.s0, a.s1), hi = Math.max(a.s0, a.s1);
          const inside = tS >= lo - 0.01 && tS <= hi + 0.01;
          if (inside && (needDir === 0 || needDir === a.dir)) {
            const cost = st.cost + Math.abs(tS - a.s0);
            if (!bestDone || cost < bestDone.cost) bestDone = { cost, legs: [...st.legs, { edge: a.edge, dir: a.dir, s0: a.s0, s1: tS }] };
          }
        }
        open.push({ node: a.to, inE: a.edge, inD: a.dir, cost: st.cost + a.len, legs: [...st.legs, { edge: a.edge, dir: a.dir, s0: a.s0, s1: a.s1 }] });
      }
    }
    return bestDone ? mergeLegs(bestDone.legs) : null;
  }

  /**
   * A U-turn "in the road" at (edge, s) while travelling dir: a semicircle from the travel lane, swinging right
   * across the carriageway into the opposite lane (keep-left), as carters turned their carts. Private edge 'turn:…'.
   */
  turnLeg(edge: string, s: number, dir: 1 | -1): RouteLeg {
    const key = `turn:${edge}:${s.toFixed(1)}:${dir}`;
    let P = this.polys.get(key);
    if (!P) {
      const E = this.polys.get(edge)!;
      const w = this.L.roads.edges[edge]?.width ?? 6;
      const R = Math.max(1.3, w / 4);
      const c = E.at(s);
      const t = E.tangent(s).multiplyScalar(dir);
      const r = new THREE.Vector3(-t.z, 0, t.x);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 10; i++) {
        const a = (i / 10) * Math.PI;
        pts.push(new THREE.Vector3(c.x + t.x * R * 1.3 * Math.sin(a) - r.x * R * Math.cos(a), c.y, c.z + t.z * R * 1.3 * Math.sin(a) - r.z * R * Math.cos(a)));
      }
      P = new Poly(pts);
      this.polys.set(key, P);
      this.lanes.set(key, 0);
    }
    return { edge: key, dir: 1, s0: 0, s1: P.length };
  }

  private nodeBetween(edge: string, a: number, b: number): boolean {
    const lo = Math.min(a, b) + 0.01, hi = Math.max(a, b) - 0.01;
    return (this.onEdge.get(edge) ?? []).some((n) => n.s > lo && n.s < hi && n.id !== 'entrance');
  }

  makeRoute(legs: RouteLeg[]): RoadRoute {
    const cum: number[] = [0];
    for (const l of legs) cum.push(cum[cum.length - 1] + Math.abs(l.s1 - l.s0));
    const length = cum[cum.length - 1];
    const polys = this.polys;
    const locate = (d: number) => {
      const dd = Math.min(Math.max(d, 0), length);
      let k = 0;
      while (k < legs.length - 1 && cum[k + 1] < dd) k++;
      const l = legs[k] ?? { edge: 'K', dir: 1 as const, s0: 0, s1: 0 };
      const s = l.s0 + (dd - (cum[k] ?? 0)) * Math.sign(l.s1 - l.s0 || 1);
      return { edge: l.edge, s, dir: l.dir, leg: k };
    };
    return {
      legs, length, locate,
      sample(d, lateral = 0, out = { pos: new THREE.Vector3(), yaw: 0 }) {
        const q = locate(d);
        const P = polys.get(q.edge)!;
        P.offset(q.s, lateral * q.dir, undefined, out.pos);
        out.yaw = P.yawAt(q.s) + (q.dir < 0 ? Math.PI : 0);
        return out;
      },
    };
  }

  /** lane lateral (right of travel) for a leg's edge */
  laneOf(edge: string): number { return this.lanes.get(edge) ?? 0; }

  /** route distance of a point on the route's legs (first leg matching edge containing s), or -1 */
  distOf(route: RoadRoute, edge: string, s: number, fromD = 0): number {
    let base = 0;
    for (const l of route.legs) {
      const len = Math.abs(l.s1 - l.s0);
      if (l.edge === edge) {
        const along = (s - l.s0) * l.dir;
        if (along >= -0.01 && along <= len + 0.01 && base + along >= fromD - 0.01) return base + along;
      }
      base += len;
    }
    return -1;
  }

  /** point on the nearest (non-loop) road to p */
  roadPt(p: THREE.Vector3): Pt | null {
    let best: { edge: string; s: number; d: number } | null = null;
    for (const e of Object.values(this.L.roads.edges)) {
      if (e.kind === 'loop' || e.kind === 'drive') continue;
      const q = e.poly.nearest(p.x, p.z);
      if (!best || q.d < best.d) best = { edge: e.id, s: q.s, d: q.d };
    }
    return best ? { k: 'edge', edge: best.edge, s: best.s } : null;
  }

  /** world position of a node */
  nodePos(id: string, out = _v): THREE.Vector3 { return out.copy(this.L.roads.nodes[id]?.pos ?? out.set(0, 0, 0)); }
}

type Cursor =
  | { at: 'node'; node: string; inEdge: { edge: string; dir: 1 | -1 } | null }
  | { at: 'edge'; edge: string; s: number; dir: 0 | 1 | -1; pre?: { edge: string; s0: number; s1: number }; turn?: boolean }
  | { at: 'loop'; s: number };

function sumLegs(legs: RouteLeg[]): number { let s = 0; for (const l of legs) s += Math.abs(l.s1 - l.s0); return s; }

function mergeLegs(legs: RouteLeg[]): RouteLeg[] {
  const out: RouteLeg[] = [];
  for (const l of legs) {
    if (Math.abs(l.s1 - l.s0) < 1e-6) continue;
    const last = out[out.length - 1];
    if (last && last.edge === l.edge && last.dir === l.dir && Math.abs(last.s1 - l.s0) < 1e-4) last.s1 = l.s1; else out.push({ ...l });
  }
  return out;
}

function worldLocal(b: Building, p: THREE.Vector3): [number, number] {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const dx = p.x - b.center.x, dz = p.z - b.center.z;
  return [dx * c - dz * s, dx * s + dz * c];
}
