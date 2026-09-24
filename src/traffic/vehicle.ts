import * as THREE from 'three';
import type { Anchor, PersonSpec, VehicleInfo, TripRequest } from '../core/apis';
import type { RoadRoute } from '../core/countryside';
import type { Mover } from '../core/movers';
import type { Router, Pt } from './routes';
import { KINDS, type KindSpec, bodyOffset, horseOffset, HORSE_LENGTH } from './kinds';

/** why a vehicle exists (drives scheduling decisions) */
export type Purpose = 'cab' | 'omnibus' | 'request' | 'background' | 'milk' | 'mail' | 'dray' | 'coal' | 'farm' | 'motor' | 'baker' | 'cycle';

export interface Stop {
  id: string;
  pt: Pt;
  /** route distance of the stop (filled when planned) */
  d: number;
  /** extra lateral shift toward the kerb (negative = left) while standing */
  kerb: number;
  /** leaves the traffic flow while standing (others may pass) */
  pullIn: boolean;
  /** minimum stand, sim minutes */
  dwell: number;
  kind: 'drop' | 'rank' | 'omnibus' | 'kerb' | 'wait';
  bay?: number;
}

export interface HorseState { stampT: number; stampLeg: number; stampPh: number; swishT: number; swishAmp: number; nodPh: number; grazeT: number; graze: number; ear: number; phase: number; coat: number; mane: number; tack: number }

const _o = { pos: new THREE.Vector3(), yaw: 0 };
const _fr = { yaw: 0, pitch: 0 };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _dp = new THREE.Vector3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1), _m = new THREE.Matrix4();
const Y_AXIS_FLIP = new THREE.Matrix4().makeRotationY(Math.PI / 2);
const Y_AXIS_BACK = new THREE.Matrix4().makeRotationY(-Math.PI / 2);

export class Vehicle {
  readonly spec: KindSpec;
  readonly info: VehicleInfo;
  mover: Mover | null = null;
  inFlow = false;
  phase: 'queued' | 'driving' | 'parked' | 'gone' = 'queued';
  purpose: Purpose;
  origin: string;
  /** Pt of the origin (node / door) */
  originPt: Pt;
  sink: Pt;
  sinkPos = new THREE.Vector3();
  originPos = new THREE.Vector3();
  stops: Stop[] = [];
  stopIdx = 0;
  parkedAt = 0;
  /** gave up waiting on the rank (already retargeted to the mews) */
  rankGaveUp = false;
  /** stand until this sim minute (may be extended by the scheduler) */
  standUntil = 0;
  colours: number[];
  seed: number;
  queuedAt = 0;
  /** requested riders to create inside at spawn */
  pendingRiders: PersonSpec[] = [];
  riders = new Set<string>();
  crew: string[] = [];
  hiredBy: string | null = null;
  hiredAt = 0;
  boardedAt = -1;
  request: TripRequest | null = null;
  /** omnibus service window */
  window: [number, number] = [0, 0];
  // horses + animation
  horses: HorseState[] = [];
  scareT = 0; rearT = 0; boltT = 0; calmUntil = 0;
  yieldHold = false; pullOutWait = false; pullOutSince = 0; yieldT = 0; yieldIgnoreUntil = 0;
  lastMotor = 0;
  /** off-screen speed multiplier (1 = normal) */
  hurry = 1; hurryCheck = -9;
  // rendering slots
  bodySlot = -1; horseSlots: number[] = []; wheelSlots: number[] = []; lampSlots: number[] = [];
  visible = false;
  /** per-seat last frame a rider asked for the seat (occupancy) */
  seatSeen: Int32Array;
  // pose cache
  private cacheD = NaN; private cacheK = NaN;
  readonly bodyPos = new THREE.Vector3(); bodyYaw = 0; bodyPitch = 0; bodyRoll = 0;
  readonly bodyM = new THREE.Matrix4();
  readonly anchor: Anchor;
  readonly crewAnchor: Anchor;
  /** seat index map: passenger anchor seat i → spec seat; crew anchor seat i → spec seat */
  readonly paxSeats: number[] = [];
  readonly crewSeats: number[] = [];
  decor: TripRequest['decor'];
  originId = '';
  removeOrigin: (() => void) | null = null;
  spawning = false;
  tag?: string;

  constructor(readonly id: string, kind: VehicleInfo['kind'], purpose: Purpose, origin: string, originPt: Pt, sink: Pt, seed: number, private sys: VehicleHost) {
    this.spec = KINDS[kind];
    this.purpose = purpose;
    this.origin = origin;
    this.originPt = originPt;
    this.sink = sink;
    this.seed = seed;
    const cs = this.spec.colours;
    this.colours = cs[Math.floor(seed * 7919) % cs.length];
    this.info = {
      id, kind, state: 'depot', pos: new THREE.Vector3(), yaw: 0, speed: 0, edge: '', s: 0,
      horses: this.spec.horses, seats: 0, riders: [], label: this.spec.label,
    };
    const S = this.spec.seats;
    for (let i = 0; i < S.length; i++) {
      const crewish = i === 0 || (S[i].pose === 'stand' && (kind === 'omnibus' || kind === 'carriage4' || kind === 'fireengine'));
      (crewish ? this.crewSeats : this.paxSeats).push(i);
    }
    this.info.seats = this.paxSeats.length;
    this.seatSeen = new Int32Array(S.length).fill(-100);
    const self = this;
    const mkAnchor = (aid: string, map: number[]): Anchor => ({
      id: aid,
      seats: map.length,
      seatMatrix(seat: number, out: THREE.Matrix4): boolean {
        if (self.phase === 'gone' || self.phase === 'queued' || !self.mover) return false;
        const si = map[seat];
        if (si === undefined) return false;
        self.seatSeen[si] = self.sys.frame;
        self.pose();
        const st = self.spec.seats[si];
        _m.makeTranslation(st.x, st.y, st.z);
        out.multiplyMatrices(self.bodyM, _m);
        // people: local +z forward. body: +x forward
        out.multiply(st.back ? Y_AXIS_BACK : Y_AXIS_FLIP);
        return true;
      },
      seatPose(seat: number) { const si = map[seat]; return si === undefined ? 'sit' : self.spec.seats[si].pose; },
      hidden(seat: number) { const si = map[seat]; return si !== undefined && !!self.spec.seats[si].hidden; },
      doorPoint(out: THREE.Vector3) { return self.doorPoint(out); },
      stopped() { return self.phase === 'parked' || self.spawning; },
    });
    this.anchor = mkAnchor(id, this.paxSeats);
    this.crewAnchor = mkAnchor(`${id}:crew`, this.crewSeats);
  }

  get route(): RoadRoute | null { return this.mover ? this.mover.route : null; }
  get stop(): Stop | null { return this.stops[this.stopIdx] ?? null; }

  /** world point beside the vehicle's door (kerb side) */
  doorPoint(out: THREE.Vector3): THREE.Vector3 {
    const [dx, dz] = this.spec.door;
    // not there yet (queued at the depot, or driving to its stand): where the door WILL be at the stop
    if (!this.mover || (this.phase !== 'parked' && !this.spawning && this.stop)) {
      if (!this.mover || !this.stop) return this.sys.stopPos(this, out);
      const f = this.frame(this.stop.d - bodyOffset(this.spec), 0, Math.max(1.0, this.spec.bodyLen * 0.4), _dp);
      const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
      out.set(_dp.x + dx * c + dz * s, _dp.y, _dp.z - dx * s + dz * c);
      out.y = this.sys.groundY(out.x, out.z, _dp.y);
      return out;
    }
    this.pose();
    const c = Math.cos(this.bodyYaw), s = Math.sin(this.bodyYaw);
    out.set(this.bodyPos.x + dx * c + dz * s, this.bodyPos.y, this.bodyPos.z - dx * s + dz * c);
    out.y = this.sys.groundY(out.x, out.z, this.bodyPos.y);
    return out;
  }

  /** kerb lateral bump along the route (path property, so the whole vehicle follows it and parks parallel) */
  kerbAt(d: number): number {
    let k = 0;
    const L = this.spec.length;
    for (let i = 0; i < this.stops.length; i++) {
      const st = this.stops[i];
      if (!st.kerb) continue;
      const x = d - st.d;
      let w = 0;
      if (x < -L - 9 || x > 9) continue;
      if (x < -L - 1) w = THREE.MathUtils.smoothstep(x, -L - 9, -L - 1);
      else if (x <= 0.6) w = 1;
      else w = 1 - THREE.MathUtils.smoothstep(x, 0.6, 9);
      k += st.kerb * w;
    }
    return k;
  }

  /** route sample (with lane + kerb + extra lateral), extrapolated beyond the route ends */
  sample(d: number, extraLat: number, out: THREE.Vector3): THREE.Vector3 {
    const r = this.mover!.route;
    const dd = Math.min(Math.max(d, 0), r.length);
    const q = r.locate(dd);
    const lat = this.sys.laneAt(r, dd, q.edge) + this.kerbAt(dd) + extraLat;
    r.sample(dd, lat, _o);
    out.copy(_o.pos);
    const over = d - dd;
    if (over !== 0) { out.x += Math.cos(_o.yaw) * over; out.z -= Math.sin(_o.yaw) * over; }
    return out;
  }

  /** smoothed position (corner rounding) + heading between d−h and d+h */
  frame(d: number, extraLat: number, h: number, outPos: THREE.Vector3): { yaw: number; pitch: number } {
    this.sample(d - 1.4, extraLat, _a);
    this.sample(d, extraLat, outPos);
    this.sample(d + 1.4, extraLat, _b);
    outPos.x = (_a.x + outPos.x * 2 + _b.x) / 4;
    outPos.z = (_a.z + outPos.z * 2 + _b.z) / 4;
    this.sample(d - h, extraLat, _a);
    this.sample(d + h, extraLat, _c);
    const dx = _c.x - _a.x, dz = _c.z - _a.z, dy = _c.y - _a.y;
    const L = Math.hypot(dx, dz) || 1;
    _fr.yaw = Math.atan2(-dz, dx); _fr.pitch = Math.atan2(dy, L);
    return _fr;
  }

  /** body pose (cached per mover distance) → bodyPos/Yaw/Pitch/bodyM */
  pose(): void {
    const m = this.mover!;
    const k = this.rearT + this.scareT * 0.01;
    if (m.d === this.cacheD && k === this.cacheK) return;
    this.cacheD = m.d; this.cacheK = k;
    const f = this.frame(m.d - bodyOffset(this.spec), 0, Math.max(1.0, this.spec.bodyLen * 0.4), this.bodyPos);
    this.bodyYaw = f.yaw;
    this.bodyPitch = f.pitch;
    // two-wheelers balance on the horse: tip slightly nose-down when stopped with the shafts dropped
    this.bodyRoll = 0;
    _e.set(this.bodyRoll, this.bodyYaw, this.bodyPitch, 'YZX');
    _q.setFromEuler(_e);
    this.bodyM.compose(this.bodyPos, _q, _s);
  }

  /** pose of horse h (0-based; pairs abreast; 4-in-hand = 2 rows) */
  horsePose(h: number, outPos: THREE.Vector3): { yaw: number; pitch: number } {
    const sp = this.spec;
    const row = sp.horses === 4 ? (h < 2 ? 0 : 1) : 0;
    const pair = sp.horses >= 2;
    const lat = pair ? (h % 2 === 0 ? -0.5 : 0.5) * sp.horseScale : 0;
    const d = this.mover!.d - horseOffset(sp) - row * (HORSE_LENGTH + 0.4) * sp.horseScale;
    return this.frame(d, lat, 1.1, outPos);
  }
}

/** services the vehicle needs from the traffic system */
export interface VehicleHost {
  frame: number;
  laneAt(route: RoadRoute, d: number, edge: string): number;
  groundY(x: number, z: number, fallback: number): number;
  stopPos(v: Vehicle, out: THREE.Vector3): THREE.Vector3;
}

/** lane lateral with smooth blends across leg boundaries (no snapping at junctions) */
export function blendedLane(router: Router, route: RoadRoute, d: number): number {
  const q = route.locate(d);
  const legs = route.legs;
  const here = router.laneOf(q.edge);
  if (q.edge.startsWith('turn:')) return 0;
  // distance to the start / end of this leg
  let base = 0;
  for (let k = 0; k < q.leg; k++) base += Math.abs(legs[k].s1 - legs[k].s0);
  const len = Math.abs(legs[q.leg].s1 - legs[q.leg].s0);
  const into = d - base, left = len - into;
  const B = 5;
  if (left < B && q.leg + 1 < legs.length) {
    if (legs[q.leg + 1].edge.startsWith('turn:')) return here;
    const nxt = router.laneOf(legs[q.leg + 1].edge);
    const w = 0.5 * (1 - left / B);
    return here + (nxt - here) * w;
  }
  if (into < B && q.leg > 0) {
    if (legs[q.leg - 1].edge.startsWith('turn:')) return here;
    const prv = router.laneOf(legs[q.leg - 1].edge);
    const w = 0.5 * (1 - into / B);
    return here + (prv - here) * w;
  }
  return here;
}
