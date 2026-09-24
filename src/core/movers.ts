import * as THREE from 'three';
import type { Layout, RoadRoute } from './layout';

/**
 * MOVERS (v2): road agents that follow a RoadRoute (layout.roadPath) with UK keep-left lanes, car-following
 * gaps, stop lines (level-crossing gates, junction yields, rank slots), corner slow-downs and smooth yaw.
 * Shared by traffic (carriages, carts, omnibus, motor car, bicycles) and nature (drovers' flocks leaders,
 * towpath horse on the towpath if it wants a route). Integrate with `clock.dtMotion` (≤ 0.5 s per sub-step).
 *
 *   const flow = new Flow(ctx.layout);
 *   const m = new Mover('V1', { length: 5.5, maxSpeed: 3.5 }, ctx.layout.roadPath('E1', 'entrance')!);
 *   flow.add(m);  … each update: flow.step(clock.dtMotion); then read m.pos / m.yaw / m.odometer.
 *   flow.addStopLine({ edge: 'M', s: xing.roadStop[0].s, dir: 1, active: () => gatesShut });
 */
export interface MoverSpec {
  /** body length incl. horse (m) — the follower keeps `gap` behind the leader's tail */
  length: number;
  /** m/s (also capped by the edge speed limit × speedScale) */
  maxSpeed: number;
  accel?: number;      // m/s², default 0.8
  decel?: number;      // m/s², default 1.6
  gap?: number;        // metres kept behind the leader's tail at standstill, default 2.5
  /** multiplier on the edge speed limit (motor car 1.2, cyclist 1.3, dray 0.6) */
  speedScale?: number;
  /** lateral cornering acceleration (m/s²) for corner slow-downs, default 1.2 */
  latAccel?: number;
}

export interface StopLine {
  edge: string;
  /** s on the edge where the FRONT must stop */
  s: number;
  /** travel direction it applies to (1 = increasing s, −1 = decreasing, 0 = both) */
  dir: 1 | -1 | 0;
  active(): boolean;
  id?: string;
}

const _o = { pos: new THREE.Vector3(), yaw: 0 };
const _o2 = { pos: new THREE.Vector3(), yaw: 0 };

export class Mover {
  readonly id: string;
  spec: Required<MoverSpec>;
  route: RoadRoute;
  /** distance along the route of the FRONT */
  d = 0;
  v = 0;
  readonly pos = new THREE.Vector3();
  yaw = 0;
  /** metres travelled in total (drives wheel spin / gait phase) */
  odometer = 0;
  state: 'moving' | 'waiting' | 'stopped' | 'arrived' = 'moving';
  /** optional stop target (route distance of the front) — e.g. a rank slot; null = drive to the end */
  stopAt: number | null = null;
  /** set by the owner to hold the vehicle (loading, driver chatting) */
  hold = false;
  onArrive?: () => void;
  /** user data for the owning system */
  data: Record<string, unknown> = {};
  private arrivedFired = false;

  constructor(id: string, spec: MoverSpec, route: RoadRoute, startD = 0) {
    this.id = id;
    this.spec = { accel: 0.8, decel: 1.6, gap: 2.5, speedScale: 1, latAccel: 1.2, ...spec };
    this.route = route;
    this.d = startD;
    this.place(true);
  }

  /** give a new route (e.g. from the rank back to the mews); resets d to startD */
  setRoute(route: RoadRoute, startD = 0): void {
    this.route = route; this.d = startD; this.arrivedFired = false; this.state = 'moving'; this.stopAt = null;
  }

  /** lateral lane offset for the edge at route distance d (keep left on two-way edges) */
  laneAt(layout: Layout, d: number): number {
    const q = this.route.locate(d);
    const e = layout.roads.edges[q.edge];
    return e && e.lanes === 2 ? -e.width / 4 : 0;
  }

  /** pose of a point `offset` metres behind the front along the route (carriage body behind the horse) */
  trail(offset: number, out = { pos: new THREE.Vector3(), yaw: 0 }, layout?: Layout): { pos: THREE.Vector3; yaw: number } {
    const dd = this.d - offset;
    const lat = layout ? this.laneAt(layout, Math.max(0, dd)) : 0;
    if (dd >= 0) return this.route.sample(dd, lat, out);
    // before the route start: extrapolate backward along the start tangent
    this.route.sample(0, lat, out);
    out.pos.x -= Math.cos(out.yaw) * -dd; out.pos.z += Math.sin(out.yaw) * -dd;
    return out;
  }

  /** @internal */
  place(snapYaw = false, layout?: Layout, dt = 0): void {
    const lat = layout ? this.laneAt(layout, this.d) : 0;
    this.route.sample(this.d, lat, _o);
    this.pos.copy(_o.pos);
    if (snapYaw) { this.yaw = _o.yaw; return; }
    let dy = _o.yaw - this.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
    const maxTurn = 1.6 * dt + 0.02;
    this.yaw += THREE.MathUtils.clamp(dy, -maxTurn, maxTurn);
  }

  /** @internal */
  fireArrive(): void { if (!this.arrivedFired) { this.arrivedFired = true; this.onArrive?.(); } }
}

const byProgressDesc = (a: Mover, b: Mover) => (b.d / Math.max(1, b.route.length)) - (a.d / Math.max(1, a.route.length));

export class Flow {
  readonly movers: Mover[] = [];
  private stops: StopLine[] = [];
  private readonly _order: Mover[] = [];
  /** deterministic speed-up beyond the playfield (never visible): 1 inside ±playHalf, up to 3 at the portals */
  fastFactor = (x: number, z: number) => 1 + 2 * THREE.MathUtils.smoothstep(Math.max(Math.abs(x), Math.abs(z)), this.layout.terrain.half, this.layout.terrain.portalR);

  constructor(readonly layout: Layout) {}

  add(m: Mover): void { if (!this.movers.includes(m)) { this.movers.push(m); m.place(true, this.layout); } }
  remove(m: Mover): void { const i = this.movers.indexOf(m); if (i >= 0) this.movers.splice(i, 1); }
  addStopLine(s: StopLine): () => void { this.stops.push(s); return () => { const i = this.stops.indexOf(s); if (i >= 0) this.stops.splice(i, 1); }; }

  /** distance along m's route to the tail of the nearest mover ahead (same edge & direction, this or next leg) */
  private leaderGap(m: Mover): number {
    const me = m.route.locate(m.d);
    const legs = m.route.legs;
    let best = Infinity;
    for (const o of this.movers) {
      if (o === m) continue;
      const q = o.route.locate(o.d);
      for (let k = me.leg; k < Math.min(legs.length, me.leg + 3); k++) {
        const L = legs[k];
        if (q.edge !== L.edge || q.dir !== L.dir) continue;
        // distance along L from its start to o's front
        const along = (q.s - L.s0) * L.dir;
        if (along < -0.01 || along > Math.abs(L.s1 - L.s0) + 0.01) continue;
        // route distance of o's front on my route
        let base = 0;
        for (let j = 0; j < k; j++) base += Math.abs(legs[j].s1 - legs[j].s0);
        const dFront = base + along;
        const gap = dFront - o.spec.length - m.d;
        if (dFront > m.d + 0.01 && gap < best) best = gap;
        break;
      }
    }
    return best;
  }

  private stopDist(m: Mover): number {
    let best = m.stopAt !== null ? m.stopAt - m.d : m.route.length - m.d;
    const me = m.route.locate(m.d);
    const legs = m.route.legs;
    let base = 0;
    for (let j = 0; j < me.leg; j++) base += Math.abs(legs[j].s1 - legs[j].s0);
    for (let k = me.leg; k < Math.min(legs.length, me.leg + 3); k++) {
      const L = legs[k];
      for (const s of this.stops) {
        if (s.edge !== L.edge || (s.dir !== 0 && s.dir !== L.dir)) continue;
        const along = (s.s - L.s0) * L.dir;
        if (along < 0 || along > Math.abs(L.s1 - L.s0)) continue;
        const dist = base + along - m.d;
        if (dist < -0.5 || dist >= best) continue;
        if (!s.active()) continue;
        best = dist;
      }
      base += Math.abs(L.s1 - L.s0);
    }
    return best;
  }

  step(dt: number): void {
    if (dt <= 0) return;
    // leaders first (furthest along their route) so clamps see updated positions
    const order = this._order;
    order.length = 0;
    for (const m of this.movers) order.push(m);
    order.sort(byProgressDesc);
    for (const m of order) {
      const sp = m.spec;
      const e = this.layout.roads.edges[m.route.locate(m.d).edge];
      const fast = this.fastFactor(m.pos.x, m.pos.z);
      let vmax = Math.min(sp.maxSpeed, (e?.speed ?? sp.maxSpeed) * sp.speedScale) * fast;
      // corner slow-down: heading change over the next 8 m
      if (m.d + 8 < m.route.length) {
        m.route.sample(m.d, 0, _o); m.route.sample(m.d + 8, 0, _o2);
        let dy = Math.abs(_o2.yaw - _o.yaw); if (dy > Math.PI) dy = 2 * Math.PI - dy;
        if (dy > 0.05) vmax = Math.min(vmax, Math.max(1.0, Math.sqrt(sp.latAccel * (8 / dy))));
      }
      const gap = this.leaderGap(m) - sp.gap;
      const stop = this.stopDist(m);
      let target = m.hold ? 0 : vmax;
      target = Math.min(target, Math.sqrt(2 * sp.decel * Math.max(0, gap)), Math.sqrt(2 * sp.decel * Math.max(0, stop)));
      if (target > m.v) m.v = Math.min(target, m.v + sp.accel * dt * fast); else m.v = Math.max(target, m.v - sp.decel * 2 * dt);
      let dd = m.v * dt;
      dd = Math.min(dd, Math.max(0, gap), Math.max(0, stop));
      m.d += dd;
      m.odometer += dd;
      if (dd < 1e-4 && m.v < 0.05) m.v = 0;
      m.place(false, this.layout, dt);
      const atEnd = m.d >= (m.stopAt ?? m.route.length) - 0.05;
      m.state = atEnd ? (m.stopAt !== null ? 'stopped' : 'arrived') : m.v < 0.05 ? 'waiting' : 'moving';
      if (atEnd) m.fireArrive();
    }
  }
}
