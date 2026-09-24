import * as THREE from 'three';
import { Rng } from './rng';
import type { Dir, LineId, PlatformId } from './types';
import { buildCountryside, type Countryside } from './countryside';
import { pointInPoly } from './poly';

export * from './countryside';
export { Poly, localToWorld as localToWorldV, worldToLocal, pointInPoly, noise2 } from './poly';

/*
 * WORLD LAYOUT — single source of truth for all geometry placement.
 *
 * Axes: x = east, z = south (north = -z), y = up. 1 unit = 1 m.
 * Curve parameter "t" everywhere = ARC-LENGTH fraction 0..1 → use curve.getPointAt(t) / getTangentAt(t)
 * (control points are equally spaced, so getPoint(t) is also within centimetres).
 * Track curves lie at y = RAIL_TOP (0.35): a wheel sitting on the curve point is on the rail head.
 *
 * Coast Line   : straight along z = +24, x -300 → +300 (south track).
 * Highland Line: 5 m north (z = +19) west of x = -80, then curves north by 40° (R = 100) and runs
 *                straight north-east (heading 40° north of east) → the V opens to the east.
 * Platform 1   : north side of coast (wedge side), x -15 → 95.
 * Platform 2   : south-east side of highland (wedge side), on the straight right after the curve.
 * Station building sits in the wedge on the bisector (20° north of east), forecourt east of it.
 * Engine shed  : siding branching WEST off the coast track at x = -45, running west-south-west to a shed at x≈-140, z≈48.
 */

export const RAIL_TOP = 0.35;
export const PLATFORM_TOP = 1.0;
/** distance from track centreline to platform edge (coping) */
export const PLATFORM_EDGE_OFFSET = 1.7;
export const PLATFORM_WIDTH = 7;
export const PLATFORM_LENGTH = 110;
/** canopies cover the middle CANOPY_LENGTH metres of each platform */
export const CANOPY_LENGTH = 70;
export const GROUND_SIZE = 520;

export interface LineLayout {
  id: LineId;
  name: string;
  curve: THREE.CatmullRomCurve3;
  /** metres */
  length: number;
  platform: PlatformId;
  /** head t where an eastbound train stops (= stopTFor('east', 80)) */
  stopT: number;
  /** head t so a train of `trainLength` metres travelling `dir` is centred on the platform (Highland: drawn up to the east end) */
  stopTFor(dir: Dir, trainLength: number): number;
  platformStartT: number;
  platformEndT: number;
  /** home signals just outside the platform ends; signalT.east protects entry for EASTBOUND trains (west end) */
  signalT: Record<Dir, number>;
  /** destination names at each end */
  ends: Record<Dir, string>;
  /** side of the platform relative to (tangent × up) = (-tz, 0, tx); -1 = left of travel for eastbound */
  platformSide: 1 | -1;
  // ── extras (helpers) ──
  pointAt(t: number, target?: THREE.Vector3): THREE.Vector3;
  tangentAt(t: number, target?: THREE.Vector3): THREE.Vector3;
  /** point at curve t shifted laterally by `lateral` metres along (tangent × up), y overridden if given */
  offsetPoint(t: number, lateral: number, y?: number, target?: THREE.Vector3): THREE.Vector3;
  /** nearest curve t to a world position (xz) */
  nearestT(p: THREE.Vector3): number;
  /** yaw (rotation.y) that maps local +x onto the tangent at t */
  yawAt(t: number): number;
}

export interface PlatformLayout {
  id: PlatformId;
  line: LineId;
  /** centre of the platform slab, y = PLATFORM_TOP */
  center: THREE.Vector3;
  /** rotation.y mapping local +x onto the track's eastward direction */
  yaw: number;
  length: number;
  width: number;
  height: number;
  /** random point in the walkable waiting area (away from edge), y = PLATFORM_TOP */
  randomPoint(rng: Rng): THREE.Vector3;
  /** point on the platform edge (0.5 m in from the coping) next to the track at curve t */
  edgePointAt(t: number): THREE.Vector3;
  /** 8 benches under the canopy; yaw orients the bench so its local +z (front) faces the track */
  benches: { pos: THREE.Vector3; yaw: number }[];
  // ── extras ──
  canopyLength: number;
  /** unit vector (xz) pointing from the track toward the platform's back */
  inward: THREE.Vector3;
}

export interface Rect { center: THREE.Vector3; size: THREE.Vector3; yaw: number }

/**
 * The whole map. v1 station data (lines, platforms, station, nav…) plus the v2 countryside
 * (terrain, river, roads, bridges, level crossing, towns, fields, portals, walk graph…) — see core/countryside.ts.
 */
export interface Layout extends Omit<Countryside, 'validate'> {
  lines: Record<LineId, LineLayout>;
  platforms: Record<PlatformId, PlatformLayout>;
  station: { center: THREE.Vector3; yaw: number; size: THREE.Vector3 };
  entrance: THREE.Vector3;
  bookingOffice: THREE.Vector3;
  forecourt: { center: THREE.Vector3; size: THREE.Vector3; yaw: number };
  /**
   * a/b = stair feet on the platform centrelines (y = PLATFORM_TOP). Stairs climb WEST along each platform
   * for `stairRun` m to a `landing`-long tower at `deck` height. `route` is the full walking polyline
   * [a, stairTopA, landingA, landingB, stairTopB, b] shared by world (geometry) and people (walkers).
   */
  footbridge: { a: THREE.Vector3; b: THREE.Vector3; deck: number; stairRun: number; landing: number; route: THREE.Vector3[] };
  lampPositions: THREE.Vector3[];
  shed: {
    /** t=0 at the switch on the coast line (heading WEST), t=1 at the buffer stop inside the shed */
    curve: THREE.CatmullRomCurve3;
    /** coast-curve t of the switch */
    switchT: number;
    building: Rect;
    /** shed-curve t where the loco head stops inside the bay */
    bayT: number;
    waterTower: THREE.Vector3;
    coalStage: THREE.Vector3;
    turntable: THREE.Vector3;
    workerSpot: THREE.Vector3;
    /** extras */
    length: number;
    waterT: number;
  };
  trees: THREE.Vector3[];
  /** half-size of the ground square */
  bounds: number;
  nav: { nodes: Record<string, THREE.Vector3>; edges: [string, string][] };
  path(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[];
  // ── extras ──
  /** barrow crossing over the coast track west of P1 (staff only) */
  crossing: { north: THREE.Vector3; south: THREE.Vector3 };
  /** approach road from the entrance east to the ground edge */
  road: { a: THREE.Vector3; b: THREE.Vector3; width: number };
  /** nav node ids only staff should use */
  staffNodes: string[];
  /** signal box (world builds it here): footprint centre at ground, size x×z, yaw 0; its door is `landmarks.signalBoxDoor` / nav node `sbDoor` */
  signalBox: { center: THREE.Vector3; size: THREE.Vector3 };
  /** shortcut for terrain.heightAt — ground height anywhere (0 around the station) */
  heightAt(x: number, z: number): number;
  /** geometry self-check; returns list of problems (empty = OK) */
  validate(): string[];
}

// ───────────────────────── 2D path builder (analytic, then sampled) ─────────────────────────

type Seg = { len: number; k: number }; // k = curvature (1/R, signed; 0 = straight). heading h: dir = (cos h, sin h) in (x,z)

class Path2 {
  segs: Seg[] = [];
  constructor(public x0: number, public z0: number, public h0: number) {}
  line(len: number) { this.segs.push({ len, k: 0 }); return this; }
  arc(radius: number, angleRad: number) { this.segs.push({ len: Math.abs(angleRad) * radius, k: Math.sign(angleRad) / radius }); return this; }
  get total() { return this.segs.reduce((a, s) => a + s.len, 0); }
  at(s: number): { x: number; z: number; h: number } {
    let x = this.x0, z = this.z0, h = this.h0;
    let rem = Math.max(0, Math.min(s, this.total));
    for (const seg of this.segs) {
      const d = Math.min(rem, seg.len);
      if (seg.k === 0) { x += Math.cos(h) * d; z += Math.sin(h) * d; }
      else {
        const h1 = h + seg.k * d;
        x += (Math.sin(h1) - Math.sin(h)) / seg.k;
        z -= (Math.cos(h1) - Math.cos(h)) / seg.k;
        h = h1;
      }
      rem -= d;
      if (rem <= 0) break;
    }
    return { x, z, h };
  }
  toCurve(step = 5): THREE.CatmullRomCurve3 {
    const n = Math.max(2, Math.round(this.total / step));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) { const p = this.at((i / n) * this.total); pts.push(new THREE.Vector3(p.x, RAIL_TOP, p.z)); }
    const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    c.arcLengthDivisions = Math.ceil(this.total * 1.5);
    c.updateArcLengths();
    return c;
  }
}

const DEG = Math.PI / 180;

// ── key numbers ──
const COAST_Z = 24;
const HIGH_Z = 19;          // 5 m north of coast in the west
const DIVERGE_X = -80;      // highland starts curving here
const HIGH_R = 100;
const HIGH_ANGLE = 40 * DEG;
const P1_X0 = -15;          // P1 west end (coast is straight, s = x + 300)
const P2_S0 = 0;            // P2 west end measured along highland straight after the arc
const SWITCH_X = -45;
const STATION_YAW = 20 * DEG; // bisector: 20° north of east

function sampleCurve(c: THREE.CatmullRomCurve3, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) out.push(c.getPointAt(i / n));
  return out;
}

function makeLine(
  id: LineId, name: string, path: Path2, platform: PlatformId, platStartS: number, platformSide: 1 | -1,
  ends: Record<Dir, string>,
): LineLayout {
  const curve = path.toCurve(5);
  const length = curve.getLength();
  const total = path.total;
  const tOf = (s: number) => THREE.MathUtils.clamp(s / total, 0, 1);
  const platformStartT = tOf(platStartS);
  const platformEndT = tOf(platStartS + PLATFORM_LENGTH);
  const centerT = (platformStartT + platformEndT) / 2;
  // Platform 2's west half lies behind the station building as seen from the default iso camera, so
  // Highland trains draw up toward the platform's EAST end (5 m clear of the ramp) instead of centring.
  const eastBias = id === 'highland';
  // v2 (issue 3): a WESTBOUND Highland train stops with its engine at least 48 m in from P2's west end so it is
  // clear of the station building / clock tower from the default az-60 camera (30 m still hid it). Highland stopping
  // consists are therefore ≤ 68 m (only the van may overhang P2's east end; trains drops off-platform doors).
  const WEST_HEAD_MIN = 48 / length;
  const stopTFor = (dir: Dir, trainLength: number) => {
    const mid = eastBias ? Math.max(centerT, platformEndT - (trainLength / 2 + 5) / length) : centerT;
    let head = mid + (dir === 'east' ? 1 : -1) * (trainLength / 2) / length;
    if (eastBias && dir === 'west') head = Math.max(head, platformStartT + WEST_HEAD_MIN);
    return THREE.MathUtils.clamp(head, 0, 1);
  };
  const samples = sampleCurve(curve, Math.ceil(length / 2));
  const tmpT = new THREE.Vector3();
  const L: LineLayout = {
    id, name, curve, length, platform,
    stopT: 0,
    stopTFor,
    platformStartT, platformEndT,
    signalT: { east: tOf(platStartS - 6), west: tOf(platStartS + PLATFORM_LENGTH + 6) },
    ends, platformSide,
    pointAt: (t, target = new THREE.Vector3()) => curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1), target),
    tangentAt: (t, target = new THREE.Vector3()) => curve.getTangentAt(THREE.MathUtils.clamp(t, 0, 1), target),
    offsetPoint(t, lateral, y, target = new THREE.Vector3()) {
      curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1), target);
      curve.getTangentAt(THREE.MathUtils.clamp(t, 0, 1), tmpT);
      target.x += -tmpT.z * lateral;
      target.z += tmpT.x * lateral;
      if (y !== undefined) target.y = y;
      return target;
    },
    nearestT(p) {
      let best = 0, bd = Infinity;
      for (let i = 0; i < samples.length; i++) {
        const d = (samples[i].x - p.x) ** 2 + (samples[i].z - p.z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      // refine around best sample
      const n = samples.length - 1;
      let lo = Math.max(0, (best - 1) / n), hi = Math.min(1, (best + 1) / n);
      for (let it = 0; it < 24; it++) {
        const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
        const pa = curve.getPointAt(a), pb = curve.getPointAt(b);
        const da = (pa.x - p.x) ** 2 + (pa.z - p.z) ** 2, db = (pb.x - p.x) ** 2 + (pb.z - p.z) ** 2;
        if (da < db) hi = b; else lo = a;
      }
      return (lo + hi) / 2;
    },
    yawAt(t) { curve.getTangentAt(THREE.MathUtils.clamp(t, 0, 1), tmpT); return Math.atan2(-tmpT.z, tmpT.x); },
  };
  L.stopT = stopTFor('east', 80);
  return L;
}

function makePlatform(id: PlatformId, line: LineLayout): PlatformLayout {
  const side = line.platformSide;
  const tc = (line.platformStartT + line.platformEndT) / 2;
  const centerOff = side * (PLATFORM_EDGE_OFFSET + PLATFORM_WIDTH / 2);
  const center = line.offsetPoint(tc, centerOff, PLATFORM_TOP);
  const yaw = line.yawAt(tc);
  const tan = line.tangentAt(tc);
  const inward = new THREE.Vector3(-tan.z * side, 0, tan.x * side).normalize();
  const tPerM = 1 / line.length;
  const benches: { pos: THREE.Vector3; yaw: number }[] = [];
  const toTrack = inward.clone().negate();
  const benchYaw = Math.atan2(toTrack.x, toTrack.z);
  for (let i = 0; i < 8; i++) {
    const along = -30 + (60 * i) / 7;
    benches.push({ pos: line.offsetPoint(tc + along * tPerM, side * (PLATFORM_EDGE_OFFSET + 4.6), PLATFORM_TOP), yaw: benchYaw });
  }
  return {
    id, line: line.id, center, yaw,
    length: PLATFORM_LENGTH, width: PLATFORM_WIDTH, height: PLATFORM_TOP,
    randomPoint(rng) {
      const along = rng.range(-48, 48);
      const lat = rng.range(PLATFORM_EDGE_OFFSET + 1.4, PLATFORM_EDGE_OFFSET + PLATFORM_WIDTH - 0.6);
      return line.offsetPoint(tc + along * tPerM, side * lat, PLATFORM_TOP);
    },
    edgePointAt(t) { return line.offsetPoint(t, side * (PLATFORM_EDGE_OFFSET + 0.5), PLATFORM_TOP); },
    benches,
    canopyLength: CANOPY_LENGTH,
    inward,
  };
}

/** local (along-yaw x, lateral z) → world, yaw as rotation.y */
function localToWorld(origin: THREE.Vector3, yaw: number, lx: number, lz: number, y = origin.y): THREE.Vector3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // rotation.y: local +x → (c, 0, -s); local +z → (s, 0, c)
  return new THREE.Vector3(origin.x + lx * c + lz * s, y, origin.z - lx * s + lz * c);
}

function pointInRect(p: THREE.Vector3, r: Rect, margin = 0): boolean {
  const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
  const dx = p.x - r.center.x, dz = p.z - r.center.z;
  const lx = dx * c - dz * s;   // inverse of localToWorld
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= r.size.x / 2 + margin && Math.abs(lz) <= r.size.z / 2 + margin;
}

function distToPolyline(p: THREE.Vector3, pts: THREE.Vector3[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const abx = b.x - a.x, abz = b.z - a.z;
    const l2 = abx * abx + abz * abz || 1;
    const u = THREE.MathUtils.clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / l2, 0, 1);
    const d = Math.hypot(p.x - (a.x + abx * u), p.z - (a.z + abz * u));
    if (d < best) best = d;
  }
  return best;
}

export function createLayout(): Layout {
  // ── lines ──
  const coastPath = new Path2(-300, COAST_Z, 0).line(600);
  const highPath = new Path2(-300, HIGH_Z, 0).line(DIVERGE_X + 300).arc(HIGH_R, -HIGH_ANGLE).line(420);
  const highArcEndS = (DIVERGE_X + 300) + HIGH_R * HIGH_ANGLE;

  const coast = makeLine('coast', 'Coast Line', coastPath, 1, P1_X0 + 300, -1, { west: 'Brightmouth', east: 'Kingsport' });
  const highland = makeLine('highland', 'Highland Line', highPath, 2, highArcEndS + P2_S0, 1, { west: 'Ashby Vale', east: 'Glenmoor' });
  const lines: Record<LineId, LineLayout> = { coast, highland };

  const p1 = makePlatform(1, coast);
  const p2 = makePlatform(2, highland);
  const platforms: Record<PlatformId, PlatformLayout> = { 1: p1, 2: p2 };

  // ── wedge / station ──
  // apex of the two platforms' inner (back) edge lines
  const innerOff = PLATFORM_EDGE_OFFSET + PLATFORM_WIDTH; // 8.7
  const p1InnerZ = COAST_Z - innerOff;
  const hs = highPath.at(highArcEndS);
  const hDir = new THREE.Vector2(Math.cos(hs.h), Math.sin(hs.h));          // (cos40, -sin40)
  const hNorm = new THREE.Vector2(-hDir.y, hDir.x);                          // (tangent × up) = toward SE (wedge)
  const p2Inner0 = new THREE.Vector2(hs.x + hNorm.x * innerOff, hs.z + hNorm.y * innerOff);
  const uApex = (p1InnerZ - p2Inner0.y) / hDir.y;
  const apex = new THREE.Vector3(p2Inner0.x + hDir.x * uApex, 0, p1InnerZ);
  const bis = (r: number, lateral = 0, y = 0) => localToWorld(apex, STATION_YAW, r, lateral, y);

  const STATION_R = 46;
  const stationSize = new THREE.Vector3(32, 9, 14);
  const station = { center: bis(STATION_R), yaw: STATION_YAW, size: stationSize };
  const frontR = STATION_R + stationSize.x / 2;           // east facade
  const forecourt = { center: bis(frontR + 18), size: new THREE.Vector3(28, 0.1, 32), yaw: STATION_YAW };
  const entrance = bis(frontR + 34);
  const bookingOffice = bis(frontR + 1.5, 0, PLATFORM_TOP);
  const road = { a: entrance.clone(), b: bis(frontR + 34 + 200), width: 10 };
  // clamp road end to the ground edge
  {
    const dir = road.b.clone().sub(road.a).normalize();
    const ux = (GROUND_SIZE / 2 - road.a.x) / dir.x;
    road.b.copy(road.a).addScaledVector(dir, ux);
  }

  // ── footbridge (west of the building, across the wedge tip) ──
  const fbA = coast.offsetPoint(coast.nearestT(new THREE.Vector3(-6, 0, 0)), -(PLATFORM_EDGE_OFFSET + PLATFORM_WIDTH / 2), PLATFORM_TOP);
  const fbB = highland.offsetPoint(highland.platformStartT + 10 / highland.length, PLATFORM_EDGE_OFFSET + PLATFORM_WIDTH / 2, PLATFORM_TOP);
  const FB_DECK = 6.6, FB_STAIR_RUN = 7.5, FB_LANDING = 1.4;
  const fbRoute = (() => {
    const d1 = new THREE.Vector3(Math.cos(p1.yaw), 0, -Math.sin(p1.yaw));
    const d2 = new THREE.Vector3(Math.cos(p2.yaw), 0, -Math.sin(p2.yaw));
    const topA = fbA.clone().addScaledVector(d1, -FB_STAIR_RUN).setY(FB_DECK);
    const topB = fbB.clone().addScaledVector(d2, -FB_STAIR_RUN).setY(FB_DECK);
    const cA = topA.clone().addScaledVector(d1, -FB_LANDING / 2), cB = topB.clone().addScaledVector(d2, -FB_LANDING / 2);
    return [fbA.clone(), topA, cA, cB, topB, fbB.clone()];
  })();
  const footbridge = { a: fbA, b: fbB, deck: FB_DECK, stairRun: FB_STAIR_RUN, landing: FB_LANDING, route: fbRoute };

  // ── lamps ──
  const lampPositions: THREE.Vector3[] = [];
  for (const L of [coast, highland]) {
    const tc = (L.platformStartT + L.platformEndT) / 2;
    for (let i = -3; i <= 3; i++) lampPositions.push(L.offsetPoint(tc + (i * 16) / L.length, L.platformSide * (PLATFORM_EDGE_OFFSET + PLATFORM_WIDTH - 0.8), PLATFORM_TOP));
  }
  for (const [lx, lz] of [[-13, -15], [-13, 15], [13, -15], [13, 15]]) lampPositions.push(localToWorld(forecourt.center, STATION_YAW, lx, lz, 0));
  for (const r of [60, 110, 160]) { lampPositions.push(bis(frontR + 34 + r, 6.5)); }

  // ── shed siding: leaves coast heading west at SWITCH_X, S-curve 24 m south, into the shed ──
  const shedPath = new Path2(SWITCH_X, COAST_Z, Math.PI).arc(60, -25 * DEG).line(30).arc(60, 25 * DEG).line(34);
  const shedCurve = shedPath.toCurve(2);
  const shedLen = shedCurve.getLength();
  const switchT = (SWITCH_X + 300) / 600;
  const shedEnd = shedPath.at(shedPath.total);
  const shedBuilding: Rect = {
    center: new THREE.Vector3(shedEnd.x + 14, 0, shedEnd.z),
    size: new THREE.Vector3(38, 9, 13),
    yaw: 0,
  };
  const bayT = 1 - 4 / shedLen;
  const shedOff = (s: number, lateral: number) => {
    const p = shedPath.at(s);
    // lateral along (tangent × up) = (-sin h, cos h)
    return new THREE.Vector3(p.x - Math.sin(p.h) * lateral, 0, p.z + Math.cos(p.h) * lateral);
  };
  const waterS = 26 + 15;
  const waterTower = shedOff(waterS, -5.5);                     // heading west: -lateral = south side
  const coalStage = shedOff(shedPath.total - 34 - 8, 5.0);      // north side, just before shed
  const turntable = new THREE.Vector3(shedBuilding.center.x - 2, 0, shedBuilding.center.z + 22);
  const workerSpot = new THREE.Vector3(shedEnd.x + 8, 0, shedEnd.z + 3);

  // ── nav graph ──
  const nodes: Record<string, THREE.Vector3> = {};
  const edges: [string, string][] = [];
  const E = (a: string, b: string) => edges.push([a, b]);
  nodes.entrance = entrance.clone();
  // offset 4.5 m off the axis so the entrance→steps walk skirts the central flower-bed island (local 1,0; 6×3.2 m)
  nodes.forecourt = bis(frontR + 18, 4.5);
  nodes.steps = bis(frontR + 4);
  nodes.booking = bookingOffice.clone();
  nodes.hall = bis(STATION_R, 0, PLATFORM_TOP);
  nodes.p1Door = bis(STATION_R, stationSize.z / 2 + 1.2, PLATFORM_TOP);
  nodes.p2Door = bis(STATION_R, -(stationSize.z / 2 + 1.2), PLATFORM_TOP);
  E('entrance', 'forecourt'); E('forecourt', 'steps'); E('steps', 'booking'); E('booking', 'hall');
  E('hall', 'p1Door'); E('hall', 'p2Door');
  const platNodes: Record<PlatformId, string[]> = { 1: [], 2: [] };
  for (const P of [p1, p2]) {
    const L = lines[P.line];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const s = 4 + ((PLATFORM_LENGTH - 8) * i) / (n - 1);
      const id = `p${P.id}_${i}`;
      nodes[id] = L.offsetPoint(L.platformStartT + s / L.length, L.platformSide * (PLATFORM_EDGE_OFFSET + PLATFORM_WIDTH / 2), PLATFORM_TOP);
      platNodes[P.id].push(id);
      if (i > 0) E(`p${P.id}_${i - 1}`, id);
    }
  }
  const nearestOf = (ids: string[], p: THREE.Vector3, k = 1) =>
    [...ids].sort((a, b) => nodes[a].distanceToSquared(p) - nodes[b].distanceToSquared(p)).slice(0, k);
  for (const id of nearestOf(platNodes[1], nodes.p1Door, 2)) E('p1Door', id);
  for (const id of nearestOf(platNodes[2], nodes.p2Door, 2)) E('p2Door', id);
  nodes.fbA = fbA.clone(); nodes.fbB = fbB.clone();
  for (const id of nearestOf(platNodes[1], fbA, 2)) E('fbA', id);
  for (const id of nearestOf(platNodes[2], fbB, 2)) E('fbB', id);
  E('fbA', 'fbB');
  // staff route to the shed: P1 west ramp → barrow crossing over the coast track → yard
  const XING_X = -30;
  nodes.p1Ramp = new THREE.Vector3(P1_X0 - 6, 0, p1.center.z);
  nodes.xingN = new THREE.Vector3(XING_X, 0, COAST_Z - 3.5);
  nodes.xingS = new THREE.Vector3(XING_X, 0, COAST_Z + 3.5);
  nodes.yardA = new THREE.Vector3(-60, 0, 44);
  nodes.water = waterTower.clone().add(new THREE.Vector3(0, 0, 3.5));
  nodes.yard = new THREE.Vector3(shedBuilding.center.x + shedBuilding.size.x / 2 + 6, 0, shedBuilding.center.z + 9);
  nodes.shedDoor = new THREE.Vector3(shedBuilding.center.x + shedBuilding.size.x / 2 - 1, 0, shedEnd.z + 3);
  nodes.worker = workerSpot.clone();
  nodes.turntable = turntable.clone().add(new THREE.Vector3(9, 0, 0));
  E(platNodes[1][0], 'p1Ramp'); E('p1Ramp', 'xingN'); E('xingN', 'xingS'); E('xingS', 'yardA');
  E('yardA', 'water'); E('water', 'yard'); E('yardA', 'yard'); E('yard', 'shedDoor'); E('shedDoor', 'worker'); E('yard', 'turntable');
  // v2: signal box door (signalmen's shift changes walk P1 → barrow crossing → box)
  const signalBox = { center: new THREE.Vector3(-11, 0, 33), size: new THREE.Vector3(7, 6.4, 4) };
  nodes.sbDoor = new THREE.Vector3(signalBox.center.x, 0, signalBox.center.z - signalBox.size.z / 2 - 0.6);
  E('xingS', 'sbDoor');
  const staffNodes = ['p1Ramp', 'xingN', 'xingS', 'yardA', 'water', 'yard', 'shedDoor', 'worker', 'turntable', 'sbDoor'];

  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b); adj.get(b)!.push(a);
  }
  const nodeIds = Object.keys(nodes);
  const nearestNode = (p: THREE.Vector3) => {
    let best = nodeIds[0], bd = Infinity;
    for (const id of nodeIds) {
      const n = nodes[id];
      const d = (n.x - p.x) ** 2 + (n.z - p.z) ** 2 + 4 * (n.y - p.y) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  };
  const path = (from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] => {
    const s = nearestNode(from), g = nearestNode(to);
    const dist = new Map<string, number>([[s, 0]]);
    const prev = new Map<string, string>();
    const open = new Set<string>([s]);
    const done = new Set<string>();
    while (open.size) {
      let cur = '', cd = Infinity;
      for (const id of open) { const d = dist.get(id)!; if (d < cd) { cd = d; cur = id; } }
      open.delete(cur); done.add(cur);
      if (cur === g) break;
      for (const nb of adj.get(cur) ?? []) {
        if (done.has(nb)) continue;
        const nd = cd + nodes[cur].distanceTo(nodes[nb]);
        if (nd < (dist.get(nb) ?? Infinity)) { dist.set(nb, nd); prev.set(nb, cur); open.add(nb); }
      }
    }
    const ids: string[] = [];
    if (s === g || prev.has(g)) {
      for (let c: string | undefined = g; c !== undefined; c = prev.get(c)) { ids.unshift(c); if (c === s) break; }
    }
    const out = [from.clone(), ...ids.map((id) => nodes[id].clone()), to.clone()];
    // drop consecutive duplicates
    return out.filter((p, i) => i === 0 || p.distanceToSquared(out[i - 1]) > 1e-6);
  };

  // ── v2 countryside ──
  const shedStraightStart = (() => { const q = shedPath.at(shedPath.total - 34); return new THREE.Vector3(q.x, RAIL_TOP, q.z); })();
  const cs = buildCountryside({
    coast: { curve: coast.curve, length: coast.length, pointAt: (t) => coast.pointAt(t), tangentAt: (t) => coast.tangentAt(t), nearestT: (p) => coast.nearestT(p) },
    highland: { curve: highland.curve, length: highland.length, pointAt: (t) => highland.pointAt(t), tangentAt: (t) => highland.tangentAt(t), nearestT: (p) => highland.nearestT(p) },
    highStraight: { x0: hs.x, z0: hs.z, dx: hDir.x, dz: hDir.y, s0: highArcEndS },
    shedCurve, shedStraightStart, shedEnd: new THREE.Vector3(shedEnd.x, RAIL_TOP, shedEnd.z),
    shedBuilding, station: { center: station.center, size: stationSize, yaw: STATION_YAW }, forecourt,
    platforms: [p1, p2].map((P) => ({ center: P.center, length: P.length, width: P.width, yaw: P.yaw })),
    entrance, roadA: road.a, roadB: road.b,
    nav: { nodes, edges, staffNodes }, signalBox: signalBox.center,
    waterTower, coalStage, turntable,
  });

  // ── trees ──
  const coastPts = sampleCurve(coast.curve, 300), highPts = sampleCurve(highland.curve, 360), shedPts = sampleCurve(shedCurve, 80);
  const platRect = (P: PlatformLayout): Rect => ({ center: P.center, size: new THREE.Vector3(P.length, 1, P.width), yaw: P.yaw });
  const blockers: { r: Rect; m: number }[] = [
    { r: platRect(p1), m: 5 }, { r: platRect(p2), m: 5 },
    { r: { center: station.center, size: stationSize, yaw: STATION_YAW }, m: 7 },
    { r: forecourt, m: 6 },
    { r: shedBuilding, m: 7 },
  ];
  const points: THREE.Vector3[] = [waterTower, coalStage, turntable, ...lampPositions];
  const navSegs: [THREE.Vector3, THREE.Vector3][] = edges.map(([a, b]) => [nodes[a], nodes[b]]);
  const rng = new Rng(20260923);
  const trees: THREE.Vector3[] = [];
  const TREE_COUNT = 150;
  let guard = 0;
  while (trees.length < TREE_COUNT && guard++ < 20000) {
    const p = new THREE.Vector3(rng.range(-245, 245), 0, rng.range(-245, 245));
    if (distToPolyline(p, coastPts) < 11 || distToPolyline(p, highPts) < 11 || distToPolyline(p, shedPts) < 9) continue;
    if (blockers.some((b) => pointInRect(p, b.r, b.m))) continue;
    if (points.some((q) => q.distanceTo(p) < 9)) continue;
    if (navSegs.some(([a, b]) => distToPolyline(p, [a, b]) < 5)) continue;
    if (distToPolyline(p, [road.a, road.b]) < road.width / 2 + 5) continue;
    if (trees.some((q) => q.distanceTo(p) < 6)) continue;
    // v2: keep off roads, the river valley, town buildings and authored fields
    if (!cs.terrain.clear(p.x, p.z, 3) || cs.terrain.riverDist(p.x, p.z) < 9) continue;
    if (cs.fields.some((f) => pointInPoly(p.x, p.z, f.poly))) continue;
    if (Math.abs(p.x - signalBox.center.x) < 8 && Math.abs(p.z - signalBox.center.z) < 7) continue;
    // keep the central station area airy: thin out trees inside the wedge near the building
    if (p.distanceTo(station.center) < 55 && rng.chance(0.8)) continue;
    trees.push(p);
  }

  const validate = (): string[] => {
    const issues: string[] = [];
    // 1. tracks never intersect (min separation of coast vs highland >= 4.5 m everywhere)
    let minSep = Infinity;
    for (const p of highPts) minSep = Math.min(minSep, distToPolyline(p, coastPts));
    if (minSep < 4.5) issues.push(`coast/highland min separation ${minSep.toFixed(2)} m < 4.5`);
    // shed siding vs highland
    let shedHigh = Infinity;
    for (const p of shedPts) shedHigh = Math.min(shedHigh, distToPolyline(p, highPts));
    if (shedHigh < 4.5) issues.push(`shed siding within ${shedHigh.toFixed(2)} m of highland`);
    // shed siding end must be >= 20 m from coast
    if (distToPolyline(shedCurve.getPointAt(1), coastPts) < 20) issues.push('shed end too close to coast');
    // 2. V opens east: separation grows eastward and wedge >= 45 m at platform middles
    for (const L of [coast, highland]) {
      const mid = L.pointAt((L.platformStartT + L.platformEndT) / 2);
      const other = L.id === 'coast' ? highPts : coastPts;
      const d = distToPolyline(mid, other);
      if (d < 45) issues.push(`${L.id} platform middle: other track only ${d.toFixed(1)} m away (< 45)`);
    }
    // 3. platform rects must not overlap either track (except own edge offset) and must not overlap each other
    for (const P of [p1, p2]) {
      const r = platRect(P);
      for (const pts of [coastPts, highPts, shedPts]) {
        const q = pts.find((q) => pointInRect(q, r, PLATFORM_EDGE_OFFSET - 0.2));
        if (q) issues.push(`platform ${P.id} overlaps track at (${q.x.toFixed(1)},${q.z.toFixed(1)})`);
      }
      // platform must be straight: tangent at ends equals tangent at centre
      const L = lines[P.line];
      const a = L.tangentAt(L.platformStartT), b = L.tangentAt(L.platformEndT);
      if (a.dot(b) < 0.9995) issues.push(`platform ${P.id} is on a curved section`);
    }
    // 4. station building, forecourt, shed building, trees clear of tracks
    const clearRect = (name: string, r: Rect, need: number) => {
      for (const pts of [coastPts, highPts, shedPts]) for (const q of pts) if (pointInRect(q, r, need)) { issues.push(`${name} within ${need} m of a track at (${q.x.toFixed(1)},${q.z.toFixed(1)})`); return; }
    };
    clearRect('station', { center: station.center, size: stationSize, yaw: STATION_YAW }, PLATFORM_EDGE_OFFSET + PLATFORM_WIDTH + 1);
    clearRect('forecourt', forecourt, 8);
    // station must not overlap platforms
    for (const P of [p1, p2]) {
      const pr = platRect(P);
      const c = [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sz]) => localToWorld(station.center, STATION_YAW, sx * stationSize.x / 2, sz * stationSize.z / 2));
      if (c.some((q) => pointInRect(q, pr, 0.5))) issues.push(`station overlaps platform ${P.id}`);
    }
    for (const pts of [coastPts, highPts]) for (const q of pts) if (pointInRect(q, shedBuilding, 3)) { issues.push('shed building near main line'); break; }
    for (const [n, p] of [['waterTower', waterTower], ['coalStage', coalStage], ['turntable', turntable]] as const) {
      const dm = Math.min(distToPolyline(p, coastPts), distToPolyline(p, highPts));
      const ds = distToPolyline(p, shedPts);
      if (dm < 8) issues.push(`${n} ${dm.toFixed(1)} m from main line`);
      if (ds < 3.5) issues.push(`${n} ${ds.toFixed(1)} m from siding`);
    }
    for (const t of trees) {
      if (Math.min(distToPolyline(t, coastPts), distToPolyline(t, highPts)) < 8) { issues.push('tree on track'); break; }
    }
    // 5. nav: edges don't cross tracks (except the staff barrow crossing); graph connected
    for (const [a, b] of edges) {
      if ((a === 'xingN' && b === 'xingS') || (a === 'xingS' && b === 'xingN')) continue;
      const A = nodes[a], B = nodes[b];
      for (let i = 0; i <= 20; i++) {
        const q = A.clone().lerp(B, i / 20);
        const d = Math.min(distToPolyline(q, coastPts), distToPolyline(q, highPts), distToPolyline(q, shedPts));
        if (d < 2.2) { issues.push(`nav edge ${a}-${b} passes ${d.toFixed(2)} m from a track`); break; }
      }
    }
    const seen = new Set<string>(['entrance']);
    const stack = ['entrance'];
    while (stack.length) { const c = stack.pop()!; for (const nb of adj.get(c) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); } }
    for (const id of nodeIds) if (!seen.has(id)) issues.push(`nav node ${id} unreachable`);
    // path sanity: entrance → P2 must not use staff nodes
    const pth = path(entrance, p2.center);
    if (pth.length < 4) issues.push('path entrance→P2 suspiciously short');
    for (const q of pth) for (const s of staffNodes) if (q.distanceTo(nodes[s]) < 1e-3) issues.push(`passenger path uses staff node ${s}`);
    // lamps not on tracks
    for (const l of lampPositions) if (Math.min(distToPolyline(l, coastPts), distToPolyline(l, highPts)) < PLATFORM_EDGE_OFFSET + 1) issues.push('lamp too close to track');
    // road clear of tracks
    for (let i = 0; i <= 40; i++) {
      const q = road.a.clone().lerp(road.b, i / 40);
      if (Math.min(distToPolyline(q, coastPts), distToPolyline(q, highPts)) < road.width / 2 + 3) { issues.push('road too close to track'); break; }
    }
    for (const i of cs.validate()) issues.push(i);
    return issues;
  };

  const { validate: _csValidate, ...csData } = cs;
  void _csValidate;
  return {
    ...csData,
    signalBox,
    heightAt: cs.terrain.heightAt,
    lines, platforms, station, entrance, bookingOffice, forecourt, footbridge, lampPositions,
    shed: {
      curve: shedCurve, switchT, building: shedBuilding, bayT, waterTower, coalStage, turntable, workerSpot,
      length: shedLen, waterT: waterS / shedPath.total,
    },
    trees, bounds: GROUND_SIZE / 2,
    nav: { nodes, edges },
    path,
    crossing: { north: nodes.xingN.clone(), south: nodes.xingS.clone() },
    road, staffNodes,
    validate,
  };
}
