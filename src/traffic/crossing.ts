import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { SimClock } from '../core/clock';
import type { CrossingState } from '../core/apis';
import type { Flow } from '../core/movers';
import { InstancedRig } from '../core/rig';
import { withSnowCap } from '../core/shaderMods';
import { crossingGeometry, CROSSING_POSE_GLSL } from './geom';
import type { Vehicle } from './vehicle';

/**
 * LC1 "Millbridge Gates": four hand-worked field gates (hinged at the road edges), two gate signals and the
 * interlock with trains. Protocol (docs/V2_DESIGN.md §1.5):
 *  - trains call requestCrossing('lc1', id) every update; true once the gates are shut to the road AND the road
 *    between them is clear. Honoured within ~20 motion-s: road clears (≤ 12 s, then forced) + gate swing (5 s).
 *  - traffic also shuts the gates when a coast train is close (trains.eta / train positions) even without a request.
 *  - at night (22:00–06:00) the gates stay shut to the road; the keeper opens them by lantern for each cart.
 *  - the keeper walks out of the lodge (people.summonActor) and swings the gates; if he's late the gates go anyway.
 */


export class Crossing {
  state: CrossingState = 'open';
  /** 0 = shut to road (across the road) … 1 = open to road (across the rails) */
  g = 1;
  animalsOnRoad: () => { pts: THREE.Vector3[]; n: number } = () => ({ pts: [], n: 0 });
  private readonly X;
  private readonly rig: InstancedRig;
  private requests = new Map<string, number>();
  private tState = 0;
  private swinging = false;
  private keeperId: string | null = null;
  private keeperReady = false;
  private keeperIdle = 0;
  private keeperLookT = 5;
  private keeperLookSide = 1;
  private nightPass = 0;
  private lastEta = -99;
  private trainSoon = false;
  private motion = 0;
  private warm = false;
  /** x of the coast platform's east end (eastbound trains stop there before reaching the crossing) */
  private platEndX = 95;
  private sMin: number; private sMax: number;
  private yawRoad: number[]; private yawRail: number[];
  private sigYaw = { east: -Math.PI / 2, west: Math.PI / 2 };
  private arm = { east: 0, west: 0 };
  private lodgeDoor: string;
  private keeperLookN = 0;
  private etaAt = -1e9;
  private nextEta = Infinity;
  private shiftDone = '';
  private keeperSpot = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly _c = new THREE.Color();

  constructor(private ctx: Ctx, private flow: Flow, root: THREE.Group, private vehicles: () => Vehicle[]) {
    const X = ctx.layout.crossings[0];
    this.X = X;
    const leafLen = X?.gates[0]?.length ?? 3.6;
    this.rig = new InstancedRig({ name: 'traffic-crossing', geometry: crossingGeometry(leafLen), glsl: CROSSING_POSE_GLSL, capacity: 6, castShadow: true, receiveShadow: true, material: { roughness: 0.75 } });
    withSnowCap(this.rig.mesh.material as THREE.Material, ctx.mats.uniforms.uSnow, 0.9);
    root.add(this.rig.mesh);
    const yawOf = (d: THREE.Vector3) => Math.atan2(-d.z, d.x);
    this.yawRoad = (X?.gates ?? []).map((g) => yawOf(g.closedRoadDir));
    this.yawRail = (X?.gates ?? []).map((g) => yawOf(g.closedRailDir));
    const ss = (X?.roadStop ?? []).map((r) => r.s);
    this.sMin = X ? X.roadS - 5 : 0; this.sMax = X ? X.roadS + 5 : 0;
    if (ss.length === 2) { this.sMin = Math.min(...ss) + 2.5; this.sMax = Math.max(...ss) - 2.5; }
    this.lodgeDoor = X ? `door:${X.lodge.id}:0` : '';
    try { const ln = ctx.layout.lines[X?.line ?? 'coast']; this.platEndX = Math.max(ln.pointAt(ln.platformStartT).x, ln.pointAt(ln.platformEndT).x); } catch { /* keep default */ }
    if (X) {
      // the keeper stands by the hinge nearest his lodge
      let best = X.gates[0].hinge, bd = Infinity;
      for (const g of X.gates) { const d = g.hinge.distanceTo(X.lodge.doors[0]); if (d < bd) { bd = d; best = g.hinge; } }
      this.keeperSpot.copy(best).addScaledVector(X.roadDir, 0).add(new THREE.Vector3().subVectors(X.lodge.doors[0], best).setY(0).normalize().multiplyScalar(1.2));
      this.keeperSpot.y = ctx.layout.heightAt(this.keeperSpot.x, this.keeperSpot.z);
      for (const r of X.roadStop) flow.addStopLine({ id: `lc1:${r.dir}`, edge: X.road, s: r.s, dir: r.dir, active: () => this.roadBlocked() });
      for (let i = 0; i < 4; i++) this.rig.setColors(this.rig.alloc(), [0xefeee6, 0xb32a22, 0x222222, 0xffffff]);
      for (let i = 0; i < 2; i++) this.rig.setColors(this.rig.alloc(), [0xe8e6de, 0xb32a22, 0x2a2a2a, 0xffffff]);
    }
  }

  roadBlocked(): boolean { return this.state !== 'open' || this.g < 0.999; }

  request(who: string, now: number): boolean {
    if (!this.X) return true;
    this.requests.set(who, now);
    return this.state === 'closed' && this.g <= 0.001;
  }
  release(who: string): void { this.requests.delete(who); this.latched.delete(who); }

  private setState(s: CrossingState) {
    if (s === this.state) return;
    this.state = s;
    this.tState = 0;
    this.keeperIdle = 0;
    this.ctx.bus.emit('crossing:state', { id: 'lc1', state: s });
    if (s === 'closing') this.ctx.bus.emit('audio:cue', { cue: 'crossingBell', pos: this.X!.center.clone(), volume: 0.7 });
  }

  /** 0 clear · 1 a vehicle between the stop lines · 2 beasts on the crossing (a flock takes its time) */
  private roadOccupied(): 0 | 1 | 2 {
    const X = this.X!;
    for (const v of this.vehicles()) {
      if (!v.mover || v.phase === 'queued' || v.phase === 'gone') continue;
      const q = v.mover.route.locate(v.mover.d);
      if (q.edge !== X.road) continue;
      const front = q.s, rear = q.s - q.dir * v.spec.length;
      const lo = Math.min(front, rear), hi = Math.max(front, rear);
      if (hi > this.sMin && lo < this.sMax) return 1;
    }
    const a = this.animalsOnRoad();
    for (let i = 0; i < a.n; i++) if (a.pts[i].distanceTo(X.center) < 9) return 2;
    return 0;
  }

  /** a cart waiting at a stop line (night: keeper opens for it) */
  private cartWaiting(): boolean {
    const X = this.X!;
    for (const v of this.vehicles()) {
      if (!v.mover || v.phase !== 'driving') continue;
      const q = v.mover.route.locate(v.mover.d);
      if (q.edge !== X.road) continue;
      for (const r of X.roadStop) if (r.dir === q.dir && Math.abs(q.s - r.s) < 14 && v.mover.v < 0.3) return true;
    }
    return false;
  }

  /**
   * A request only shuts the road once its train is really coming: within ~30 s of the crossing, or about to leave
   * the platform (trains request early — on approach and all through their dwell). Gate cycle ≈ 11–23 s, so the
   * train is never held at the gate signal for long; a train we can't locate counts at once.
   */
  private imminentRequest(): boolean {
    if (!this.requests.size) return false;
    for (const id of this.requests.keys()) if (this.latched.has(id)) return true;
    for (const id of this.requests.keys()) if (this.isImminent(id)) { this.latched.add(id); return true; }
    return false;
  }
  private isImminent(id: string): boolean {
    const X = this.X!;
    const T = this.ctx.reg.trains;
    {
      let t: ReturnType<typeof T.get> | undefined;
      try { t = T?.get(id); } catch { t = undefined; }
      if (!t) return true;
      const ahead = (X.center.x - t.position.x) * (t.dir === 'east' ? 1 : -1);
      if (ahead < 30) return true; // at / over the crossing (or just short of it)
      // still to call at the platform (between it and us): its dwell comes first
      const platEnd = this.platEndX;
      if (t.dir === 'east' && t.position.x < platEnd && (t.state === 'approaching' || t.state === 'braking' || t.state === 'waitingSignal')) return false;
      if (t.state === 'dwelling') {
        let dep: number | null = null;
        try { dep = T.expectedDeparture(id); } catch { dep = null; }
        if (dep === null || dep - this.ctx.clock.minutes < 10) return true;
        return false;
      }
      // waiting for us (in the tunnel mouth / at the gate signal), or running in within ~30 s
      if (ahead < 150 || ahead / Math.max(8, t.speed) < 18) return true;
    }
    return false;
  }
  /** requests that have shut the road stay honoured until released / expired (no flapping) */
  private latched = new Set<string>();

  private trainNear(): boolean {
    const X = this.X!;
    if (this.motion - this.lastEta < 0.5) return this.trainSoon;
    this.lastEta = this.motion;
    let soon = false;
    const T = this.ctx.reg.trains;
    try {
      // (trains.eta ignores platform dwells, so positions decide: requests + trains really on their way)
      if (T?.occupied(X.line, X.t - 0.015, X.t + 0.015)) soon = true;
      if (!soon) for (const t of T?.list() ?? []) {
        if (t.line !== X.line) continue;
        const dx = X.center.x - t.position.x;
        const toward = (t.dir === 'east' && dx > 0) || (t.dir === 'west' && dx < 0);
        // head approaching within ~40 s, or any part of the train still over the crossing
        const tailX = t.position.x + (t.dir === 'east' ? -t.length : t.length);
        const over = (Math.min(t.position.x, tailX) < X.center.x + 6) && (Math.max(t.position.x, tailX) > X.center.x - 6) && Math.abs(t.position.z - X.center.z) < 20;
        // (close range only: an eastbound train far to the west still has its platform stop ahead of it)
        if (over || (toward && t.speed > 1 && Math.abs(dx) < Math.min(130, Math.max(60, t.speed * 12)))) { soon = true; break; }
      }
    } catch { /* trains mid-edit */ }
    this.trainSoon = soon;
    return soon;
  }

  update(dtM: number, clock: SimClock) {
    if (!this.X) return;
    if (!this.warm) {
      // warm start (before the first frame): at night the gates already stand shut to the road
      this.warm = true;
      const h0 = clock.hour;
      if (h0 >= 22 || h0 < 6) { this.g = 0; this.state = 'closed'; }
    }
    this.motion += dtM;
    this.tState += dtM;
    // requests expire if a train stops asking (despawned without releasing)
    for (const [k, t] of this.requests) if (this.motion - t > 4) { this.requests.delete(k); this.latched.delete(k); }
    const h = clock.hour;
    const nightShut = h >= 22 || h < 6;
    const rail = this.imminentRequest() || this.trainNear();
    if (nightShut && !rail && this.cartWaiting()) this.nightPass = 30;
    if (this.nightPass > 0) this.nightPass = Math.max(0, this.nightPass - dtM);
    const want = rail || (nightShut && this.nightPass <= 0);
    const swing = dtM / 3.6;
    switch (this.state) {
      case 'open':
        if (want) { this.setState('closing'); this.summonKeeper(); }
        break;
      case 'closing': {
        if (!want && this.g >= 0.999) { this.setState('open'); break; }
        // vehicles get 12 s to clear; a flock is waited for (the train stands at the gate signal) up to 3 min
        const occ = this.roadOccupied();
        const clear = occ === 0 || (occ === 1 && this.tState > 12) || this.tState > 180;
        const ready = this.keeperReady || this.tState > 4;
        if (clear && ready) {
          if (!this.swinging) { this.swinging = true; this.ctx.bus.emit('audio:cue', { cue: 'gate', pos: this.X.center.clone(), volume: 0.6 }); this.keeperAnim('push'); }
          this.g = Math.max(0, this.g - swing);
          if (this.g <= 0) { this.swinging = false; this.setState('closed'); this.keeperAnim(null); }
        }
        break;
      }
      case 'closed':
        if (!want && this.tState > 1) { this.setState('opening'); this.summonKeeper(); }
        break;
      case 'opening':
        if (want) { this.setState('closing'); break; }
        if (this.keeperReady || this.tState > 3) {
          if (!this.swinging) { this.swinging = true; this.ctx.bus.emit('audio:cue', { cue: 'gate', pos: this.X.center.clone(), volume: 0.6 }); this.keeperAnim('push'); }
          this.g = Math.min(1, this.g + swing);
          if (this.g >= 1) { this.swinging = false; this.setState('open'); this.keeperAnim(null); }
        }
        break;
    }
    // signal arms: clear only while shut to the road for a train
    const clearSig = this.state === 'closed' && rail;
    const tgt = clearSig ? -0.7 : 0;
    this.arm.east += (tgt - this.arm.east) * Math.min(1, dtM * 2.5);
    this.arm.west += (tgt - this.arm.west) * Math.min(1, dtM * 2.5);
    // the keeper on duty looks up and down the line now and then (this also tells people he is still wanted)
    this.keeperLookT -= dtM;
    if (this.keeperId && this.keeperLookT <= 0) {
      this.keeperLookT = 12;
      const P = this.ctx.reg.people;
      try {
        if (!P?.get(this.keeperId)) { this.keeperId = null; this.keeperReady = false; }
        else if (this.keeperReady && !this.swinging) {
          this.keeperLookSide = -this.keeperLookSide;
          const c = this.X.center;
          const look = this.keeperLookSide === 0 ? c.clone() : new THREE.Vector3(c.x + this.keeperLookSide * 60, c.y, c.z);
          P.lookAt(this.keeperId, look);
          // a little life between trains: a pipe, a stamp of the feet, a long look up the line
          const k = (this.keeperLookN = (this.keeperLookN + 1) % 3);
          P.setIdle(this.keeperId, k === 0 ? 'watch' : k === 1 ? 'smoke' : 'wait');
        }
      } catch { /* */ }
    }
    // between trains the keeper goes back into his lodge (a door origin) when the next train is more than ~20 min off,
    // and comes out again when he's wanted; at 06:00 and 18:00 the relief takes over (the next call brings him out)
    this.keeperIdle += dtM;
    if (this.motion - this.etaAt > 1) {
      this.etaAt = this.motion;
      let e: number | null = null;
      try { e = this.ctx.reg.trains?.eta(this.X.line, this.X.t, 40)?.seconds ?? null; } catch { e = null; }
      this.nextEta = e ?? Infinity;
    }
    const idleGates = !this.swinging && !rail && ((this.state === 'open' && !want) || (this.state === 'closed' && nightShut && this.nightPass <= 0));
    const shift = Math.floor(h) === 6 || Math.floor(h) === 18 ? Math.floor(h) : -1;
    if (this.keeperId && idleGates && this.tState > 3) {
      if (shift >= 0 && this.shiftDone !== `${clock.day}:${shift}`) { this.shiftDone = `${clock.day}:${shift}`; this.dismissKeeper(); }
      else if (this.keeperReady && this.keeperIdle > 6 && this.nextEta > 20) this.dismissKeeper();
    }
    if (shift >= 0 && !this.keeperId) this.shiftDone = `${clock.day}:${shift}`;
  }

  private summonKeeper() {
    this.keeperIdle = 0;
    const P = this.ctx.reg.people;
    if (this.keeperId) {
      try { if (!P?.get(this.keeperId)) { this.keeperId = null; this.keeperReady = false; } } catch { /* */ }
    }
    if (this.keeperId || !P) return;
    try {
      const h = P.summonActor('gatekeeper', this.keeperSpot, { from: this.lodgeDoor, timeoutMin: 20 });
      this.keeperId = h.id;
      this.keeperReady = false;
      const id = h.id;
      h.arrived.then((ok) => { if (this.keeperId === id) { this.keeperReady = ok; try { P.setIdle(id, 'watch'); P.lookAt(id, this.X!.center); } catch { /* */ } } }).catch(() => { /* */ });
    } catch { this.keeperId = null; }
  }
  private dismissKeeper() {
    const id = this.keeperId;
    this.keeperId = null; this.keeperReady = false;
    if (!id) return;
    try { void this.ctx.reg.people?.dismissActor(id, { to: this.lodgeDoor }); } catch { /* */ }
  }
  private keeperAnim(a: 'push' | null) {
    if (!this.keeperId || !this.keeperReady) return;
    try { const P = this.ctx.reg.people; if (a) P.setAnim(this.keeperId, 'push'); else P.setIdle(this.keeperId, 'watch'); } catch { /* */ }
  }

  /** gates, signals and their lamps; returns the next free lamp index */
  render(_dt: number, lampN: number, lamps: THREE.InstancedMesh, nightK: number, cap: number): number {
    const X = this.X;
    if (!X) return lampN;
    const g = this.g;
    const e = g * g * (3 - 2 * g);
    for (let i = 0; i < 4; i++) {
      const G = X.gates[i];
      let a = this.yawRoad[i], b = this.yawRail[i];
      let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      const yaw = a + d * e;
      this._p.copy(G.hinge); this._p.y = Math.max(G.hinge.y, 0.3);
      this.rig.setTransform(i, this._p, yaw);
      this.rig.setAux(i, 0, 0, 0, 0);
      if (nightK > 0.22 && lampN < cap) {
        this._p.set(G.length * 0.55, 1.5, 0);
        const c = Math.cos(yaw), s = Math.sin(yaw);
        this._m.makeScale(1.7, 1.7, 1.7).setPosition(G.hinge.x + this._p.x * c, Math.max(G.hinge.y, 0.3) + 1.52, G.hinge.z - this._p.x * s);
        lamps.setMatrixAt(lampN, this._m);
        lamps.setColorAt(lampN, this._c.setRGB(1.3 * nightK, 0.18, 0.1));
        lampN++;
      }
    }
    let k = 4;
    for (const dir of ['east', 'west'] as const) {
      const p = X.gateSignal[dir];
      this._p.copy(p); this._p.y = this.ctx.layout.heightAt(p.x, p.z);
      this.rig.setTransform(k, this._p, this.sigYaw[dir]);
      this.rig.setAux(k, 1, 0, 0, 0);
      this.rig.setAnim(k, this.arm[dir], 0, 0, 0);
      if (nightK > 0.22 && lampN < cap) {
        const yaw = this.sigYaw[dir];
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const lz = 0.36;
        this._m.makeScale(1.7, 1.7, 1.7).setPosition(this._p.x + lz * s + 0.05 * c, this._p.y + 4.55, this._p.z + lz * c - 0.05 * s);
        lamps.setMatrixAt(lampN, this._m);
        const clear = this.arm[dir] < -0.4;
        lamps.setColorAt(lampN, clear ? this._c.setRGB(0.2, 1.2 * nightK, 0.5) : this._c.setRGB(1.3 * nightK, 0.15, 0.1));
        lampN++;
      }
      k++;
    }
    if (nightK > 0.22) { this._p.copy(X.center).setY(3); this.ctx.lights.claim('traffic:lc1', this._p, 0xff6a4a, 0.8 * nightK, 10, 0.4); }
    return lampN;
  }

  dispose() { this.rig.dispose(); }
}
