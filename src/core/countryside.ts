import * as THREE from 'three';
import type { Dir, LineId } from './types';
import { Poly, localToWorld, worldToLocal, distToPolyline, pointInPoly, noise2 } from './poly';

/*
 * V2 COUNTRYSIDE — river, roads, level crossing, bridges, towns, fields, portals, terrain height.
 * Everything here is DATA + pure helpers, built once in createLayout() and exposed on ctx.layout.
 * Axes as in layout.ts: x = east, z = south (north = −z), y = up, metres.
 *
 * Lateral convention everywhere (roads, river, paths): +lateral = RIGHT of travel in the +s direction
 * (side vector = tangent × up = (−tz, 0, tx)), same as the rail lines.
 * River s runs DOWNSTREAM (north → south), so +lateral = RIGHT bank = the WEST bank (towpath side).
 */

export const GROUND_HALF = 420;
export const SKIRT_Y = 2;
/** the camera keeps its ground footprint inside ±PLAY_HALF; nothing beyond it is ever on screen in iso */
export const PLAY_HALF = 400;
/** road/river portals sit at max(|x|,|z|) ≈ PORTAL_R (on the skirt, beyond the ground edge) */
export const PORTAL_R = 450;
const GRID_HALF = 440;
const CELL = 2;
const GN = Math.round((2 * GRID_HALF) / CELL) + 1; // 441

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const P = (x: number, z: number) => new THREE.Vector3(x, 0, z);
const smooth = THREE.MathUtils.smoothstep;
const clamp = THREE.MathUtils.clamp;

// ───────────────────────── public types ─────────────────────────

export type RoadKind = 'main' | 'lane' | 'street' | 'track' | 'drive' | 'loop';
export interface RoadNode { id: string; pos: THREE.Vector3; kind: 'junction' | 'portal' | 'end' | 'crossing' }
export interface RoadEdge {
  id: string; name: string; kind: RoadKind;
  /** node ids at s = 0 and s = length */
  a: string; b: string;
  /** full carriageway width (m) */
  width: number;
  /** 2 = two-way (keep LEFT: vehicle lateral = −width/4 in its travel direction); 1 = single lane (lateral 0) */
  lanes: 1 | 2;
  oneWay: boolean;
  /** speed limit m/s for horse traffic (trot ≈ 3.5) */
  speed: number;
  /** centreline, resampled every 2 m, y = road surface height (humpback / cutting / ford included) */
  poly: Poly;
  /** side of the footway: +1 right of +s, −1 left; footway lateral = footSide·(width/2 + 0.6) */
  footSide: 1 | -1;
}
export interface RouteLeg { edge: string; dir: 1 | -1; s0: number; s1: number }
export interface RoadRoute {
  legs: RouteLeg[];
  length: number;
  /** sample the route at distance d from its start: pos (y = road surface) and yaw of travel. lateral + = right of travel */
  sample(d: number, lateral?: number, out?: { pos: THREE.Vector3; yaw: number }): { pos: THREE.Vector3; yaw: number };
  /** edge + s on that edge at route distance d */
  locate(d: number): { edge: string; s: number; dir: 1 | -1; leg: number };
}

export interface RiverLayout {
  name: string;
  /** centreline, 2 m resample, y = water surface; s downstream (north → south) */
  poly: Poly;
  length: number;
  widthAt(s: number): number;
  /** water surface y at s: −3.0 upstream of the weir, −3.5 below (the step is at weir.s) */
  waterYAt(s: number): number;
  bedDepth: number;
  /** towpath on the RIGHT (west) bank: lateral = +(width/2 + 2.1), y = towpathYAt(s) (dips under bridges) */
  towpath: { side: 1; width: number; lateral(s: number): number; yAt(s: number): number; poly: Poly };
  pointAt(s: number, lateral?: number, y?: number, out?: THREE.Vector3): THREE.Vector3;
  tangentAt(s: number, out?: THREE.Vector3): THREE.Vector3;
  nearest(p: THREE.Vector3): { s: number; lat: number; d: number };
  weir: { s: number; pos: THREE.Vector3; yaw: number; drop: number };
  /** lock chamber inside the channel on the right (towpath) side of the weir */
  lock: { s0: number; s1: number; lateral: number; width: number; gates: THREE.Vector3[]; dropY: [number, number] };
  mill: { center: THREE.Vector3; size: THREE.Vector3; yaw: number; door: THREE.Vector3; wheel: THREE.Vector3; wheelR: number; wheelAxis: THREE.Vector3 };
  boathouse: { center: THREE.Vector3; size: THREE.Vector3; yaw: number; door: THREE.Vector3; slip: THREE.Vector3; slipS: number };
  jetty: { a: THREE.Vector3; b: THREE.Vector3; y: number };
  moorings: { id: string; s: number; lateral: number; pos: THREE.Vector3 }[];
  /** angler pegs: pos on the bank (y walkable), yaw = rotation.y facing the water, s on the river */
  fishing: { id: string; pos: THREE.Vector3; yaw: number; s: number; best?: boolean }[];
  ford: { s: number; pos: THREE.Vector3; width: number; bedY: number; road: string; roadS: number; stones: THREE.Vector3[] };
  reeds: { s0: number; s1: number; side: 1 | -1 }[];
  heron: THREE.Vector3[];
  portals: { up: { pos: THREE.Vector3; s: number }; down: { pos: THREE.Vector3; s: number } };
  /** reaches used by life: regatta (girder bridge → jetty), skating, mill pool */
  reaches: { id: 'regatta' | 'millpool' | 'skating'; s0: number; s1: number }[];
}

export interface Bridge {
  id: string; name: string;
  kind: 'girder' | 'arches' | 'humpback' | 'underbridge';
  /** what crosses over / what passes under */
  carries: 'rail' | 'road'; over: 'river' | 'road';
  line?: LineId; lineT?: number;
  road?: string; roadS?: number;
  riverS?: number;
  center: THREE.Vector3;
  /** rotation.y mapping local +x along the CARRIED way */
  yaw: number;
  /** clear span along the carried way (m) */
  span: number;
  /** deck width across the carried way (m) */
  width: number;
  /** top of deck (rail bridges: 0; humpback: road crown) */
  deckY: number;
  /** underside of the span */
  soffitY: number;
  /** angle between carried and crossed way, degrees (90 = square) */
  angleDeg: number;
}

export interface GateLeaf { hinge: THREE.Vector3; length: number; closedRoadDir: THREE.Vector3; closedRailDir: THREE.Vector3 }
export interface LevelCrossing {
  id: string; name: string; line: LineId;
  /** line t at the road centreline */
  t: number;
  road: string; roadS: number;
  center: THREE.Vector3;
  roadDir: THREE.Vector3; railDir: THREE.Vector3;
  gates: GateLeaf[];
  /** where road vehicles stop when gates are shut: s along `road` for travel in +s (dir 1) and −s (dir −1) */
  roadStop: { dir: 1 | -1; s: number }[];
  /** trains may not pass these head t without traffic.requestCrossing(id) === true */
  trainStopT: Record<Dir, number>;
  /** approach points (line t) at which traffic should start clearing and closing the road (~40 motion-s out at line speed) */
  warnT: Record<Dir, number>;
  gateSignal: Record<Dir, THREE.Vector3>;
  lodge: Building;
}

export type BuildingKind =
  | 'cottage' | 'terrace' | 'house' | 'pub' | 'inn' | 'church' | 'chapel' | 'smithy' | 'bakery' | 'post' | 'shop'
  | 'school' | 'police' | 'engineHouse' | 'mews' | 'dairy' | 'farmhouse' | 'barn' | 'stable' | 'mill' | 'windmill'
  | 'lodge' | 'boathouse' | 'hut' | 'office';
export type RoofKind = 'slate' | 'tile' | 'thatch';
export type WallKind = 'brick' | 'brickDark' | 'stone' | 'whitewash' | 'timber';
export interface Building {
  id: string; name: string; town: string; kind: BuildingKind;
  /** footprint centre at ground (y = pad height) */
  center: THREE.Vector3;
  /** x = frontage width (local x), y = eaves height, z = depth (local z) */
  size: THREE.Vector3;
  /** rotation.y; local +z = FRONT (faces its road); doors are on the +z face */
  yaw: number;
  roofH: number;
  roof: RoofKind; walls: WallKind;
  /** walkable door points just OUTSIDE the front (y = ground). doors[0] is the main door */
  doors: THREE.Vector3[];
  /** 1 m INSIDE each door (fade-through-door target) */
  doorsIn: THREE.Vector3[];
  /** chimney-pot tops (smoke origins) */
  chimneys: THREE.Vector3[];
  residents: number;
  /** windows glow at night */
  lit: boolean;
  /** church tower / spire (local x offset from centre, square size, height) */
  tower?: { lx: number; size: number; h: number; spire: boolean };
}
export interface Town {
  id: 'station' | 'ashcombe' | 'millbridge' | 'wyke' | 'coldharbour' | 'glenmoor' | 'eastcote' | 'river' | 'lc1';
  name: string; center: THREE.Vector3;
  buildings: Building[];
  lamps: THREE.Vector3[];
  /** open areas: market square, village green, school yard, churchyard, yards */
  areas: { id: string; kind: 'square' | 'green' | 'yard' | 'churchyard' | 'rickyard' | 'pond' | 'garden' | 'playground'; center: THREE.Vector3; size: THREE.Vector3; yaw: number }[];
}

export type FieldKind = 'wheat' | 'barley' | 'hay' | 'pasture' | 'plough' | 'turnips' | 'orchard';
export interface Field {
  id: string; name: string; kind: FieldKind;
  poly: THREE.Vector2[];
  /** row / furrow direction (rotation.y of the rows) */
  rowYaw: number;
  /** field gate (on the boundary, towards the nearest road/path) */
  gate: THREE.Vector3;
  livestock?: 'sheep' | 'cows' | 'horses';
  center: THREE.Vector3;
}

export type PortalKind = 'road' | 'path' | 'river' | 'rail';
export interface Portal {
  id: string; kind: PortalKind;
  /** spawn/despawn point (on the skirt for road/river, inside the tunnel for rail) */
  pos: THREE.Vector3;
  /** unit outward direction */
  dir: THREE.Vector3;
  road?: string; roadS?: number; line?: LineId;
  towards: string;
}
export interface Tunnel { id: string; x: number; z: number; dx: number; dz: number; width: number; lines: string[] }

export type OriginKindL = 'door' | 'portal';
export interface StaticOrigin {
  id: string; kind: OriginKindL;
  /** threshold point (outside) */
  pos: THREE.Vector3;
  /** inside point (fade target) — doors only */
  inside?: THREE.Vector3;
  building?: string; town?: string; portal?: string;
  for: ('people' | 'vehicles' | 'animals' | 'boats')[];
  staffOnly?: boolean;
}

export interface WalkGraph {
  nodes: THREE.Vector3[];
  /** per node: 'station' nav (staff flagged) | 'foot' | 'path' | 'door' | 'portal' */
  kind: string[];
  staff: boolean[];
  adj: number[][];
  nearest(p: THREE.Vector3, opts?: { staff?: boolean }): number;
  /** shortest walk (y at ground/platform) from → to, staff edges only if opts.staff */
  path(from: THREE.Vector3, to: THREE.Vector3, opts?: { staff?: boolean }): THREE.Vector3[];
  /** walking length in metres (Infinity if unreachable) */
  length(from: THREE.Vector3, to: THREE.Vector3, opts?: { staff?: boolean }): number;
}

export interface ForecourtTraffic {
  /** one-way loop (clockwise from above, keep-left): starts on K's inbound lane at the entrance, round the
   *  central island, ends on K's outbound lane. y = 0. Vehicles route K → loop → K. */
  loop: Poly;
  dropOff: { s: number; pos: THREE.Vector3; yaw: number };
  /** 4 cab-rank bays on the north side, nose east. s along loop */
  rank: { s: number; pos: THREE.Vector3; yaw: number }[];
  omnibus: { s: number; pos: THREE.Vector3; yaw: number };
  /** where cab horses drink */
  trough: THREE.Vector3;
  /** pedestrian spots: queue for cabs, wait for the omnibus, meeters at P1/P2 */
  cabQueue: THREE.Vector3; omnibusQueue: THREE.Vector3;
}

export interface TerrainLayout {
  half: number; skirtY: number; playHalf: number; portalR: number;
  /** ground height incl. river valley, road ramps/cuttings, building pads, tunnel hills and the edge ramp */
  heightAt(x: number, z: number): number;
  /** distance (xz) to nearest track centreline (coast, highland, shed siding, shed road); clamped at 60 */
  trackDist(x: number, z: number): number;
  /** distance from the nearest road EDGE (negative on the carriageway); clamped at 60 */
  roadDist(x: number, z: number): number;
  /** distance from the river's WATER EDGE (negative on the water); clamped at 60 */
  riverDist(x: number, z: number): number;
  isWater(x: number, z: number): boolean;
  /** the v1 "feature distance" (tracks, main road, station and shed yard) — terrain is flat (y 0) within 14 m */
  featureDist(x: number, z: number): number;
  /** clear of tracks (≥ 8 m), roads, river, buildings, station/forecourt/platforms/shed by `margin` */
  clear(x: number, z: number, margin?: number): boolean;
  /** which building footprint (+margin) contains the point */
  buildingAt(x: number, z: number, margin?: number): Building | null;
}

export interface Countryside {
  terrain: TerrainLayout;
  river: RiverLayout;
  roads: { nodes: Record<string, RoadNode>; edges: Record<string, RoadEdge> };
  /** footpaths and the towpath (walkers only). y = ground */
  paths: { id: string; name: string; kind: 'footpath' | 'towpath' | 'steps'; poly: Poly; stiles: THREE.Vector3[] }[];
  bridges: Bridge[];
  crossings: LevelCrossing[];
  towns: Town[];
  /** flat list of all buildings in all towns */
  buildings: Building[];
  fields: Field[];
  portals: Portal[];
  tunnels: Tunnel[];
  origins: StaticOrigin[];
  forecourtTraffic: ForecourtTraffic;
  /** Crown Mews stable yard in Ashcombe: vehicle depot (cabs, omnibus, carriages). door = stable door (vehicle origin/sink) */
  mews: { door: THREE.Vector3; yard: THREE.Vector3; yaw: number; road: string };
  landmarks: {
    windmill: { center: THREE.Vector3; yaw: number; hubY: number; moundR: number; moundH: number };
    platelayersHut: Building;
    signalBoxDoor: THREE.Vector3;
  };
  /** the shed's new through road: straight at z≈47.9 from inside the new west tunnel (x −300) east to where the
   *  shed siding's final straight begins. Light engines enter/leave here and never touch the coast line. */
  shedRoad: { curve: THREE.CatmullRomCurve3; length: number; portalX: number; z: number; tAtX(x: number): number };
  walk: WalkGraph;
  /** shortest road route between two road nodes (or positions snapped to the nearest node) */
  roadPath(from: string | THREE.Vector3, to: string | THREE.Vector3, opts?: { allowOneWay?: boolean }): RoadRoute | null;
  /** walking path between any two points (station nav + footways + footpaths + towpath + doors) */
  footPath(from: THREE.Vector3, to: THREE.Vector3, opts?: { staff?: boolean }): THREE.Vector3[];
  riverPointAt(t01: number, lateral?: number, out?: THREE.Vector3): THREE.Vector3;
  nearestOrigin(pos: THREE.Vector3, kinds?: OriginKindL[], forKind?: 'people' | 'vehicles' | 'animals' | 'boats'): StaticOrigin | null;
  /** nearest road edge + s + lateral for a point */
  nearestRoad(p: THREE.Vector3): { edge: string; s: number; lat: number; d: number };
  /** street lamps outside the station (town squares, pub, road into Ashcombe, Millbridge) */
  streetLamps: THREE.Vector3[];
  validate(): string[];
}

/** inputs from the v1 layout */
export interface CountrysideInput {
  coast: { curve: THREE.CatmullRomCurve3; length: number; pointAt(t: number): THREE.Vector3; tangentAt(t: number): THREE.Vector3; nearestT(p: THREE.Vector3): number };
  highland: { curve: THREE.CatmullRomCurve3; length: number; pointAt(t: number): THREE.Vector3; tangentAt(t: number): THREE.Vector3; nearestT(p: THREE.Vector3): number };
  highStraight: { x0: number; z0: number; dx: number; dz: number; s0: number };
  shedCurve: THREE.CatmullRomCurve3;
  shedStraightStart: THREE.Vector3;
  shedEnd: THREE.Vector3;
  shedBuilding: { center: THREE.Vector3; size: THREE.Vector3; yaw: number };
  station: { center: THREE.Vector3; size: THREE.Vector3; yaw: number };
  forecourt: { center: THREE.Vector3; size: THREE.Vector3; yaw: number };
  platforms: { center: THREE.Vector3; length: number; width: number; yaw: number }[];
  entrance: THREE.Vector3;
  roadA: THREE.Vector3; roadB: THREE.Vector3;
  nav: { nodes: Record<string, THREE.Vector3>; edges: [string, string][]; staffNodes: string[] };
  signalBox: THREE.Vector3;
  waterTower: THREE.Vector3; coalStage: THREE.Vector3; turntable: THREE.Vector3;
}

type FrontOpts = Partial<Omit<Building, 'town'>> & { kind: BuildingKind; name: string; setback?: number; doorLx?: number[]; chimLx?: number[] };

// ───────────────────────── builder ─────────────────────────

export function buildCountryside(I: CountrysideInput): Countryside {
  const issues0: string[] = [];
  let mews0: Countryside['mews'] | undefined;
  const coastPts = sample(I.coast.curve, 300), highPts = sample(I.highland.curve, 360), shedPts = sample(I.shedCurve, 60);

  // ── shed through-road + tunnels ──
  const SHED_Z = I.shedEnd.z;
  const shedRoadX0 = -300, shedRoadX1 = I.shedStraightStart.x;
  const shedRoadCurve = new THREE.CatmullRomCurve3([V(shedRoadX0, 0.35, SHED_Z), V((shedRoadX0 + shedRoadX1) / 2, 0.35, SHED_Z), V(shedRoadX1, 0.35, SHED_Z)], false, 'centripetal');
  const shedRoadLen = shedRoadX1 - shedRoadX0;
  const shedRoadPts = [V(shedRoadX0, 0.35, SHED_Z), V(shedRoadX1, 0.35, SHED_Z)];
  const tunnels: Tunnel[] = [
    { id: 'west', x: -268, z: 21.5, dx: -1, dz: 0, width: 16, lines: ['coast', 'highland'] },
    { id: 'coastEast', x: 272, z: 24, dx: 1, dz: 0, width: 9, lines: ['coast'] },
    (() => {
      const t = I.highland.nearestT(P(255, -231));
      const p = I.highland.pointAt(t), tg = I.highland.tangentAt(t);
      return { id: 'highlandNE', x: p.x, z: p.z, dx: tg.x, dz: tg.z, width: 9, lines: ['highland'] };
    })(),
    { id: 'shedWest', x: -268, z: SHED_Z, dx: -1, dz: 0, width: 8, lines: ['shed'] },
  ];

  const allTrackPts = [coastPts, highPts, shedPts, shedRoadPts];
  const trackDistExact = (x: number, z: number) => Math.min(...allTrackPts.map((pts) => distToPolyline(x, z, pts)));
  const highAt = (s: number) => P(I.highStraight.x0 + I.highStraight.dx * s, I.highStraight.z0 + I.highStraight.dz * s);
  const highN = P(-I.highStraight.dz, I.highStraight.dx); // tangent × up (toward SE / wedge)

  // ── river ──
  const riverCtrl = [
    P(118, -480), P(118, -440), P(124, -380), P(106, -320), P(108, -262), P(114, -215), P(132, -178), P(152, -150),
    P(166, -128), P(162, -100), P(148, -74), P(143, -46), P(150, -15), P(158, 24), P(152, 60), P(136, 95),
    P(118, 122), P(100, 150), P(88, 178), P(76, 215), P(62, 262), P(46, 320), P(34, 380), P(26, 440), P(22, 480),
  ];
  const rpoly0 = Poly.smooth(riverCtrl, 2);
  const rNear = (x: number, z: number) => rpoly0.nearest(x, z).s;
  const sWeir = rNear(116, 125);
  const sRegatta0 = rNear(152, -150), sRegatta1 = rNear(143, -46);
  const sPool0 = rNear(136, 95);
  const W_WATER = (s: number) => {
    let w = 11;
    w += 3 * smooth(s, sRegatta0 - 30, sRegatta0) * (1 - smooth(s, sRegatta1, sRegatta1 + 30));
    w += 5 * smooth(s, sPool0 - 25, sPool0 + 5) * (1 - smooth(s, sWeir, sWeir + 3));
    return w;
  };
  const waterY = (s: number) => (s < sWeir ? -3.0 : -3.5);
  const rpts = rpoly0.pts.map((p, i) => V(p.x, waterY(rpoly0.cum[i]), p.z));
  const rpoly = new Poly(rpts);

  // ── roads ──
  const nodes: Record<string, RoadNode> = {};
  const edges: Record<string, RoadEdge> = {};
  const addNode = (id: string, pos: THREE.Vector3, kind: RoadNode['kind']) => { nodes[id] = { id, pos: pos.clone().setY(0), kind }; return id; };
  // K: existing straight from the entrance, then on to the east portal
  const kDir = I.roadB.clone().sub(I.roadA).setY(0).normalize();
  const kStraightLen = I.roadA.distanceTo(I.roadB);
  const kCtrl: THREE.Vector3[] = [];
  for (let s = 0; s < kStraightLen - 1; s += 25) kCtrl.push(I.roadA.clone().addScaledVector(kDir, s).setY(0));
  kCtrl.push(I.roadB.clone().setY(0), P(320, -100), P(380, -110), P(440, -117), P(480, -120));
  const K0 = Poly.smooth(kCtrl, 2);
  const kAt = (s: number) => K0.at(s);
  const kOff = (s: number, lat: number) => K0.offset(s, lat, 0);

  // highland bridge for Wyke Lane: square to the track at straight distance 130 m
  const wykeBridge = highAt(130);
  const u = highN.clone().negate(); // NW (away from wedge)
  const S_JW = 33, S_JM = 186;
  // Millbridge Lane leaves K square to it heading SSE, swings south-west to cross the coast line square at x=220
  const LC1_X = 220;
  const specs: { id: string; name: string; kind: RoadKind; width: number; lanes: 1 | 2; speed: number; footSide: 1 | -1; ctrl: THREE.Vector3[]; a: string; b: string; linear?: boolean }[] = [];
  addNode('entrance', I.entrance, 'end');
  addNode('jW', kAt(S_JW), 'junction');
  addNode('jM', kAt(S_JM), 'junction');
  specs.push({ id: 'K', name: 'Kingsport Road', kind: 'main', width: 10, lanes: 2, speed: 3.6, footSide: -1, ctrl: kCtrl, a: 'entrance', b: 'E1' });
  specs.push({
    id: 'W', name: 'Wyke Lane', kind: 'lane', width: 6, lanes: 2, speed: 3.0, footSide: 1, a: 'jW', b: 'NW1',
    ctrl: [kAt(S_JW), P(97.5, -44), wykeBridge.clone().addScaledVector(u, -26), wykeBridge.clone(), wykeBridge.clone().addScaledVector(u, 22), P(44, -138), P(10, -156), P(-40, -166), P(-120, -168), P(-170, -162), P(-205, -160), P(-240, -163), P(-280, -168), P(-360, -176), P(-440, -180), P(-480, -181)],
  });
  specs.push({
    id: 'M', name: 'Millbridge Lane', kind: 'lane', width: 6, lanes: 2, speed: 3.0, footSide: -1, a: 'jM', b: 'jMB',
    ctrl: [kAt(S_JM), kOff(S_JM, 14), kOff(S_JM, 30), P(240, -20), P(226, -2), P(LC1_X, 12), P(LC1_X, 24), P(LC1_X, 36), P(214, 56), P(196, 92), P(170, 124), P(150, 148), P(136, 168)],
  });
  addNode('jMB', P(136, 168), 'junction');
  specs.push({
    id: 'S', name: 'Hollowford Road', kind: 'lane', width: 6, lanes: 2, speed: 3.0, footSide: 1, a: 'jMB', b: 'S1',
    ctrl: [P(136, 168), P(133, 200), P(131, 240), P(127, 300), P(121, 380), P(118, 440), P(117, 480)],
  });
  specs.push({
    id: 'F', name: 'Coldharbour Track', kind: 'track', width: 5, lanes: 2, speed: 2.6, footSide: 1, a: 'jMB', b: 'W1',
    ctrl: [P(136, 168), P(114, 175), P(88, 179), P(50, 186), P(-40, 189), P(-110, 183), P(-170, 176), P(-230, 185), P(-300, 195), P(-360, 202), P(-440, 205), P(-480, 206)],
  });
  specs.push({
    id: 'N', name: 'Glenmoor Drove', kind: 'track', width: 5, lanes: 2, speed: 2.6, footSide: 1, a: 'jN', b: 'N1',
    ctrl: [P(10, -156), P(12, -200), P(15, -250), P(10, -320), P(6, -400), P(4, -440), P(4, -480)],
  });
  addNode('jN', P(10, -156), 'junction');
  specs.push({
    id: 'D', name: 'Eastcote Lane', kind: 'lane', width: 5, lanes: 2, speed: 3.0, footSide: 1, a: 'jD', b: 'E2',
    ctrl: [P(216, 50), P(250, 64), P(290, 80), P(330, 92), P(400, 83), P(440, 78), P(480, 76)],
  });
  addNode('jD', P(216, 50), 'junction');

  // build the edges (y = draped later, once the base terrain exists)
  const pending: { spec: (typeof specs)[number]; poly: Poly }[] = [];
  for (const sp of specs) pending.push({ spec: sp, poly: sp.id === 'K' ? K0 : Poly.smooth(sp.ctrl, 2) });
  // snap junction nodes onto their parent polylines (W/N/M/D/S/F start or end exactly on a node)
  const edgePoly = (id: string) => pending.find((p) => p.spec.id === id)!.poly;
  {
    const W = edgePoly('W');
    const jn = W.nearest(10, -156);
    nodes.jN.pos.copy(W.at(jn.s).setY(0));
    const rebuild = (id: string, start: THREE.Vector3) => {
      const pe = pending.find((p) => p.spec.id === id)!;
      pe.spec.ctrl = [start.clone(), ...pe.spec.ctrl.slice(1)];
      pe.poly = Poly.smooth(pe.spec.ctrl, 2);
    };
    rebuild('N', nodes.jN.pos);
    const M = edgePoly('M');
    const jd = M.nearest(216, 50);
    nodes.jD.pos.copy(M.at(jd.s).setY(0));
    rebuild('D', nodes.jD.pos);
  }

  // ── portals (roads) ──
  const portals: Portal[] = [];
  const roadPortal = (edgeId: string, nodeId: string, towards: string) => {
    const poly = edgePoly(edgeId);
    let sP = poly.length;
    for (let s = poly.length; s > 0; s -= 1) { const p = poly.at(s); if (Math.max(Math.abs(p.x), Math.abs(p.z)) < PORTAL_R) { sP = s; break; } }
    const pos = poly.at(sP).setY(SKIRT_Y);
    const dir = poly.tangent(sP);
    addNode(nodeId, pos, 'portal');
    portals.push({ id: nodeId, kind: 'road', pos, dir, road: edgeId, roadS: sP, towards });
  };
  roadPortal('K', 'E1', 'Kingsport');
  roadPortal('W', 'NW1', 'Ashby');
  roadPortal('S', 'S1', 'Hollowford');
  roadPortal('F', 'W1', 'Brightmouth Downs');
  roadPortal('N', 'N1', 'Glenmoor');
  roadPortal('D', 'E2', 'Eastcote & the coast');

  // ── base terrain (v1 look: flat near features, noise elsewhere, tunnel hills, edge ramp) ──
  const st = I.station.center, sb = I.shedBuilding.center;
  const kStraightPts = [I.roadA, I.roadB];
  const G = new Grid();
  // track distance field
  G.stampDist(G.track, allTrackPts, 60);
  const featureDistAt = (x: number, z: number, td: number) => {
    let d = Math.min(td, distToPolyline(x, z, kStraightPts) - 5);
    d = Math.min(d, Math.hypot(x - st.x, z - (st.z - 15)) - 70);
    d = Math.min(d, Math.hypot(x - sb.x - 20, z - sb.z - 5) - 45);
    return d;
  };
  const hill = (x: number, z: number) => {
    let h = 0;
    for (const p of tunnels) {
      const rx = x - p.x, rz = z - p.z;
      const uu = rx * p.dx + rz * p.dz;
      const vv = Math.abs(-rx * p.dz + rz * p.dx);
      const side = 1 - smooth(vv, p.width * 0.5 + 10, p.width * 0.5 + 60);
      const start = vv < p.width / 2 + 6 ? 5 : THREE.MathUtils.lerp(5, -8, smooth(vv, p.width / 2 + 6, p.width / 2 + 24));
      // the hill shoulders up quickly behind the portal (so the portal's own mound blends into real ground),
      // then climbs gently to its crest
      const along = Math.max(smooth(uu, start, start + 18), 0.72 * smooth(uu, start - 3, start + 6));
      h = Math.max(h, 15 * along * side);
    }
    return h;
  };
  const baseAt = (x: number, z: number, td: number) => {
    const f = featureDistAt(x, z, td);
    const k = smooth(f, 14, 50);
    let h = 0;
    if (k > 0) {
      const n = noise2(x * 0.018, z * 0.018) * 0.7 + noise2(x * 0.05 + 7, z * 0.05 - 3) * 0.3;
      const edge = smooth(Math.max(Math.abs(x), Math.abs(z)), 180, 260);
      h = k * (n * 2.2 + edge * 3.5);
    }
    h = Math.max(h, hill(x, z));
    const e2 = smooth(Math.max(Math.abs(x), Math.abs(z)), GROUND_HALF - 50, GROUND_HALF);
    h = THREE.MathUtils.lerp(h, SKIRT_Y + 1.5 + noise2(x * 0.02, z * 0.02) * 2, e2);
    return h;
  };
  G.forEach((i, x, z) => {
    const td = G.track[i];
    G.feature[i] = featureDistAt(x, z, td);
    G.h[i] = Math.max(Math.abs(x), Math.abs(z)) > GROUND_HALF ? SKIRT_Y : baseAt(x, z, td);
  });

  // ── road surfaces: drape on base terrain, smooth, then bridges / cuttings / ford / level crossing ──
  const crossHumps: { edge: string; s: number; dy: number; flat: number; ramp: number }[] = [];
  for (const { spec, poly } of pending) {
    const ys = poly.pts.map((p) => G.sample(G.h, p.x, p.z));
    const sm = movingAvg(ys, 5);
    for (let i = 0; i < poly.pts.length; i++) poly.pts[i].y = sm[i];
    // river crossings
    for (const X of poly.intersections(rpoly)) {
      if (spec.id === 'K') crossHumps.push({ edge: 'K', s: X.s, dy: 1.4, flat: 0, ramp: 20 });
      else if (spec.id === 'F') crossHumps.push({ edge: 'F', s: X.s, dy: NaN, flat: 5, ramp: 14 }); // ford
      else issues0.push(`road ${spec.id} crosses the river at (${X.p.x.toFixed(1)},${X.p.z.toFixed(1)}) with no bridge`);
    }
  }
  const newEdge = (sp: (typeof specs)[number], poly: Poly): RoadEdge => ({
    id: sp.id, name: sp.name, kind: sp.kind, a: sp.a, b: sp.b, width: sp.width, lanes: sp.lanes, oneWay: false, speed: sp.speed, poly, footSide: sp.footSide,
  });
  for (const { spec, poly } of pending) edges[spec.id] = newEdge(spec, poly);
  // K humpback
  const applyProfile = (e: RoadEdge, s0: number, f: (ds: number, y: number) => number) => {
    const p = e.poly;
    for (let i = 0; i < p.pts.length; i++) p.pts[i].y = f(p.cum[i] - s0, p.pts[i].y);
  };
  for (const h of crossHumps) {
    const e = edges[h.edge];
    if (!Number.isNaN(h.dy)) applyProfile(e, h.s, (ds, y) => y + h.dy * Math.max(0, 1 - (ds / h.ramp) ** 2));
  }
  // Wyke Lane underbridge (cutting under the Highland line)
  const W = edges.W;
  const wX = W.poly.intersections(new Poly(highPts))[0];
  if (!wX) issues0.push('Wyke Lane does not meet the Highland line');
  const W_CUT = -4.3;
  if (wX) applyProfile(W, wX.s, (ds, y) => {
    const a = Math.abs(ds);
    const f = a < 7 ? 1 : a < 46 ? 0.5 + 0.5 * Math.cos((Math.PI * (a - 7)) / 39) : 0;
    return THREE.MathUtils.lerp(y, W_CUT, f);
  });
  // ford on the Coldharbour Track
  const fordHump = crossHumps.find((h) => h.edge === 'F');
  const sFordRiver = fordHump ? rpoly.nearest(edges.F.poly.at(fordHump.s).x, edges.F.poly.at(fordHump.s).z).s : 0;
  const fordBedY = waterY(sFordRiver) - 0.28;
  if (fordHump) applyProfile(edges.F, fordHump.s, (ds, y) => {
    const a = Math.abs(ds);
    const f = a < 5 ? 1 : a < 19 ? 0.5 + 0.5 * Math.cos((Math.PI * (a - 5)) / 14) : 0;
    return THREE.MathUtils.lerp(y, fordBedY, f);
  });
  // Millbridge Lane over the coast line (level crossing): rise to rail-top planking
  const coastPoly = new Poly(coastPts);
  const mX = edges.M.poly.intersections(coastPoly)[0];
  if (!mX) issues0.push('Millbridge Lane does not meet the coast line');
  if (mX) applyProfile(edges.M, mX.s, (ds, y) => Math.max(y, 0.3 * (1 - smooth(Math.abs(ds), 3, 10))));
  // lanes never cross track elsewhere
  for (const e of Object.values(edges)) {
    for (const [nm, pts] of [['coast', coastPts], ['highland', highPts], ['shed', shedPts], ['shedRoad', shedRoadPts]] as const) {
      const xs = e.poly.intersections(new Poly(pts as THREE.Vector3[]));
      const ok = (e.id === 'M' && nm === 'coast' && xs.length === 1) || (e.id === 'W' && nm === 'highland' && xs.length === 1);
      if (xs.length && !ok) issues0.push(`road ${e.id} crosses ${nm} track ${xs.length}× at (${xs[0].p.x.toFixed(1)},${xs[0].p.z.toFixed(1)})`);
    }
  }

  // ── forecourt loop (forecourt-local: x toward the entrance (ENE), z toward SSE) ──
  const F = I.forecourt;
  const fl = (lx: number, lz: number) => localToWorld(F.center, F.yaw, lx, lz, 0);
  const loopLocal: [number, number][] = [
    [22, 2.5], [17, 2.5], [13, 5], [9, 9.5], [2, 10], [-5, 9.5], [-8.6, 6.5], [-9.6, 1.5], [-9.6, -2], [-8.4, -6.5], [-5, -9.2],
    [2, -9.6], [9, -9.2], [13, -5], [17, -2.5], [22, -2.5],
  ];
  const loop = Poly.smooth(loopLocal.map(([a, b]) => fl(a, b)), 1);
  const lnear = (lx: number, lz: number) => { const p = fl(lx, lz); return loop.nearest(p.x, p.z).s; };
  const stopAt = (s: number) => ({ s, pos: loop.at(s), yaw: loop.yawAt(s) });
  const forecourtTraffic: ForecourtTraffic = {
    loop,
    dropOff: stopAt(lnear(-9.6, 0)),
    rank: [lnear(-5, -9.6), lnear(-0.5, -9.6), lnear(4, -9.6), lnear(8.5, -9.4)].map(stopAt),
    omnibus: stopAt(lnear(-1, 10)),
    trough: fl(6, -13.4),
    cabQueue: fl(-11.8, -8.5),
    omnibusQueue: fl(-1, 13.2),
  };
  edges.FC = { id: 'FC', name: 'Station forecourt', kind: 'loop', a: 'entrance', b: 'entrance', width: 5, lanes: 1, oneWay: true, speed: 2.2, poly: loop, footSide: 1 };

  // ── bridges ──
  const bridges: Bridge[] = [];
  const angleBetween = (a: THREE.Vector3, b: THREE.Vector3) => THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(a.x * b.x + a.z * b.z))));
  for (const [line, pts, name, kind] of [['highland', highPts, 'Glenmoor Bridge', 'girder'], ['coast', coastPts, 'Kingsmead Arches', 'arches']] as const) {
    const L = line === 'coast' ? I.coast : I.highland;
    const xs = rpoly.intersections(new Poly(pts as unknown as THREE.Vector3[]));
    if (xs.length !== 1) { issues0.push(`river crosses ${line} ${xs.length}× (expected 1)`); continue; }
    const X = xs[0];
    const t = L.nearestT(X.p);
    const tg = L.tangentAt(t);
    const rt = rpoly.tangent(X.s);
    const ang = angleBetween(tg, rt);
    const w = W_WATER(X.s);
    const span = (w + 2 * 3.6) / Math.max(0.35, Math.sin(THREE.MathUtils.degToRad(ang)));
    bridges.push({
      id: line === 'coast' ? 'kingsmead' : 'glenmoor', name, kind, carries: 'rail', over: 'river', line, lineT: t, riverS: X.s,
      center: L.pointAt(t).setY(0), yaw: Math.atan2(-tg.z, tg.x), span: Math.ceil(span), width: 6, deckY: 0, soffitY: kind === 'girder' ? -0.5 : -0.6, angleDeg: ang,
    });
  }
  {
    const X = edges.K.poly.intersections(rpoly)[0];
    if (X) {
      const tg = edges.K.poly.tangent(X.s), rt = rpoly.tangent(X.so);
      bridges.push({
        id: 'ashbourne', name: 'Ashbourne Bridge', kind: 'humpback', carries: 'road', over: 'river', road: 'K', roadS: X.s, riverS: X.so,
        center: edges.K.poly.at(X.s).setY(0), yaw: edges.K.poly.yawAt(X.s), span: 14, width: 11, deckY: edges.K.poly.yAt(X.s), soffitY: waterY(X.so) + 2.6, angleDeg: angleBetween(tg, rt),
      });
    } else issues0.push('Kingsport Road does not cross the river');
  }
  if (wX) {
    const tg = W.poly.tangent(wX.s);
    const t = I.highland.nearestT(wX.p);
    bridges.push({
      id: 'wykeArch', name: 'Wyke Arch', kind: 'underbridge', carries: 'rail', over: 'road', line: 'highland', lineT: t, road: 'W', roadS: wX.s,
      center: wX.p.clone(), yaw: Math.atan2(-I.highland.tangentAt(t).z, I.highland.tangentAt(t).x), span: 9, width: 7, deckY: 0, soffitY: W_CUT + 4.1,
      angleDeg: angleBetween(tg, I.highland.tangentAt(t)),
    });
  }

  // ── level crossing LC1 (Millbridge Gates) on the coast line ──
  const crossings: LevelCrossing[] = [];
  const buildings: Building[] = [];
  const towns: Town[] = [];
  const mkBuilding = (b: Omit<Building, 'doors' | 'doorsIn' | 'chimneys'> & { doorLx?: number[]; chimLx?: number[] }): Building => {
    const doorLx = b.doorLx ?? [0];
    const doors = doorLx.map((lx) => localToWorld(b.center, b.yaw, lx, b.size.z / 2 + 0.7, b.center.y));
    const doorsIn = doorLx.map((lx) => localToWorld(b.center, b.yaw, lx, b.size.z / 2 - 1.0, b.center.y));
    const chimLx = b.chimLx ?? [b.size.x / 2 - 0.9];
    const chimneys = chimLx.map((lx) => localToWorld(b.center, b.yaw, lx, 0, b.center.y + b.size.y + b.roofH * 0.9 + 1.0));
    const out: Building = { ...b, doors, doorsIn, chimneys };
    delete (out as unknown as Record<string, unknown>).doorLx; delete (out as unknown as Record<string, unknown>).chimLx;
    return out;
  };
  if (mX) {
    const t = I.coast.nearestT(mX.p);
    const c = I.coast.pointAt(t).setY(0);
    const roadDir = edges.M.poly.tangent(mX.s);
    const railDir = P(1, 0);
    const HR = 3.6;
    const gates: GateLeaf[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      // hinge at the road edge (sx: west/east of road) and rail side (sz: north/south of track)
      const hinge = c.clone().addScaledVector(P(1, 0), sx * HR).addScaledVector(P(0, 1), sz * (HR + 0.4));
      gates.push({ hinge, length: HR, closedRoadDir: P(-sx, 0), closedRailDir: P(0, -sz) });
    }
    const tOfX = (x: number) => THREE.MathUtils.clamp((x + 300) / 600, 0, 1);
    const lodgeC = P(c.x - 10.5, c.z + 10);
    const lodge = mkBuilding({ id: 'lc1:lodge', name: "Crossing Keeper's Lodge", town: 'lc1', kind: 'lodge', center: lodgeC.setY(0), size: V(6, 3.6, 5), yaw: Math.PI / 2, roofH: 2.2, roof: 'tile', walls: 'brick', residents: 2, lit: true, chimLx: [-2.2] });
    crossings.push({
      id: 'lc1', name: 'Millbridge Gates', line: 'coast', t, road: 'M', roadS: mX.s, center: c, roadDir, railDir, gates,
      roadStop: [{ dir: 1, s: mX.s - 8 }, { dir: -1, s: mX.s + 8 }],
      trainStopT: { east: tOfX(c.x - 32), west: tOfX(c.x + 32) },
      warnT: { east: tOfX(c.x - 250), west: tOfX(c.x + 250) },
      gateSignal: { east: P(c.x - 32, 24 + 2.8), west: P(c.x + 32, 24 - 2.8) },
      lodge,
    });
  }

  // ── towns ──
  const front = (edgeId: string, s0: number, s1: number, side: 1 | -1, d: number, o: FrontOpts & { town: string }) => {
    const e = edges[edgeId];
    const w = Math.abs(s1 - s0), sm = (s0 + s1) / 2;
    const setback = o.setback ?? 2.5;
    const lat = side * (e.width / 2 + setback + d / 2);
    const c = e.poly.offset(sm, lat, 0);
    const t = e.poly.tangent(sm);
    // front faces the road: local +z → toward road = −side·(tangent × up)
    const fx = -side * -t.z, fz = -side * t.x;
    const yaw = Math.atan2(fx, fz);
    const b = mkBuilding({
      id: `${o.town}:${o.id ?? o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: o.name, town: o.town, kind: o.kind, center: c, size: V(w, o.size?.y ?? 5.5, d), yaw, roofH: o.roofH ?? 2.6,
      roof: o.roof ?? 'slate', walls: o.walls ?? 'brick', residents: o.residents ?? (o.kind === 'cottage' ? 2 : o.kind === 'terrace' ? 6 : 1),
      lit: o.lit ?? true, tower: o.tower, doorLx: o.doorLx, chimLx: o.chimLx,
    });
    buildings.push(b);
    return b;
  };
  const areaFront = (edgeId: string, s0: number, s1: number, side: 1 | -1, d: number, setback: number) => {
    const e = edges[edgeId];
    const sm = (s0 + s1) / 2;
    const c = e.poly.offset(sm, side * (e.width / 2 + setback + d / 2), 0);
    return { center: c, size: V(Math.abs(s1 - s0), 0.1, d), yaw: e.poly.yawAt(sm) };
  };
  const atPoint = (b: Omit<Building, 'doors' | 'doorsIn' | 'chimneys'> & { doorLx?: number[]; chimLx?: number[] }) => { const x = mkBuilding(b); buildings.push(x); return x; };

  // station quarter
  {
    const T = 'station';
    const terrace = front('K', 3, 25, -1, 7, { town: T, id: 'terrace', name: 'Station Terrace', kind: 'terrace', size: V(0, 5.6, 0), doorLx: [-8.2, -2.7, 2.7, 8.2], chimLx: [-5.5, 0, 5.5], residents: 8 });
    const pub = front('K', 49, 60, -1, 9, { town: T, id: 'railwayArms', name: 'The Railway Arms', kind: 'pub', size: V(0, 6.6, 0), doorLx: [-1.5, 4.2], chimLx: [-5, 5], residents: 3 });
    const coal = front('K', 17, 24, 1, 5, { town: T, id: 'coalOffice', name: "Pell & Sons, Coal Merchants", kind: 'office', size: V(0, 3.4, 0), roof: 'slate', walls: 'brickDark', residents: 0, roofH: 1.6 });
    const coalYard = areaFront('K', 16, 36, 1, 16, 8.2);
    towns.push({
      id: 'station', name: 'Victoria Junction', center: I.entrance.clone(), buildings: [terrace, pub, coal],
      lamps: [kOff(42, -5.8), kOff(60, -5.8)],
      areas: [{ id: 'coalYard', kind: 'yard', ...coalYard }, { id: 'terraceGardens', kind: 'garden', ...areaFront('K', 3, 25, -1, 9, 2.5 + 7 + 0.5) }, { id: 'pubGarden', kind: 'garden', ...areaFront('K', 49, 60, -1, 8, 2.5 + 9 + 0.5) }],
    });
  }
  // Ashcombe
  {
    const T = 'ashcombe';
    const B = (s0: number, s1: number, side: 1 | -1, d: number, o: FrontOpts) => front('K', s0, s1, side, d, { ...o, town: T });
    const list: Building[] = [
      B(113, 121, -1, 8, { name: 'The Smithy', kind: 'smithy', size: V(0, 4.4, 0), roof: 'tile', walls: 'stone', residents: 1 }),
      B(123, 129, -1, 6.5, { name: 'Forge Cottage', kind: 'cottage', roof: 'tile', walls: 'whitewash' }),
      B(131, 137, -1, 6.5, { name: 'Bell Cottage', kind: 'cottage' }),
      B(140, 150, -1, 8, { name: 'Post Office', id: 'post', kind: 'post', size: V(0, 6.2, 0), doorLx: [-2, 3] }),
      B(152, 160, -1, 7.5, { name: "Hobbs' Bakery", id: 'bakery', kind: 'bakery', walls: 'whitewash', roof: 'tile', chimLx: [-2.8] }),
      B(162, 169, -1, 7.5, { name: 'Pratt the Chemist', id: 'chemist', kind: 'shop', size: V(0, 6.2, 0), walls: 'brickDark' }),
      B(172, 186, -1, 11, { name: 'The Crown', id: 'crown', kind: 'inn', size: V(0, 7.6, 0), walls: 'stone', doorLx: [-3.5], chimLx: [-6, 6], residents: 4 }),
      B(203, 210, -1, 7.5, { name: 'Police House', id: 'police', kind: 'police', size: V(0, 6, 0) }),
      B(212, 218, -1, 6.5, { name: 'Rose Cottage', kind: 'cottage', roof: 'thatch', walls: 'whitewash' }),
      B(220, 227, -1, 6.5, { name: 'Ivy Cottage', kind: 'cottage', roof: 'tile' }),
      B(113, 121, 1, 8, { name: 'Engine House', id: 'engineHouse', kind: 'engineHouse', size: V(0, 5, 0), walls: 'brickDark', residents: 0, lit: false }),
      B(123, 134, 1, 7, { name: 'Forge Row', kind: 'terrace', doorLx: [-2.8, 2.8], chimLx: [-2.8, 2.8], residents: 4 }),
      B(166, 177, 1, 10, { name: 'Board School', id: 'school', kind: 'school', size: V(0, 6.2, 0), residents: 0, chimLx: [-4] }),
      B(194, 200, 1, 6.5, { name: 'Church Cottage', kind: 'cottage', walls: 'stone' }),
      B(202, 208, 1, 6.5, { name: 'Laurel Cottage', kind: 'cottage', roof: 'tile', walls: 'whitewash' }),
      B(211, 223, 1, 10, { name: 'Ashcombe House', id: 'ashcombeHouse', kind: 'house', size: V(0, 7.2, 0), walls: 'stone', chimLx: [-5, 5], residents: 3 }),
    ];
    const sq = areaFront('K', 133, 163, 1, 22, 2);
    const church = mkBuilding({
      id: 'ashcombe:church', name: "St Mary's Church", town: T, kind: 'church',
      center: edges.K.poly.offset(148, 5 + 2 + 22 + 3 + 5, 0), size: V(17, 7.5, 9), yaw: 0, roofH: 4.2, roof: 'slate', walls: 'stone', residents: 0, lit: true,
      tower: { lx: -10.8, size: 4.8, h: 20, spire: false }, doorLx: [-5], chimLx: [],
    });
    // the church faces the square (front = local +z toward K)
    {
      const t = edges.K.poly.tangent(148);
      church.yaw = Math.atan2(t.z, -t.x);
      Object.assign(church, mkBuilding({ ...church, doorLx: [-5], chimLx: [] }));
    }
    buildings.push(church);
    // Crown Mews: yard behind the inn, stable block across its back; drive from K
    const mewsS = 190;
    const mewsDir = edges.K.poly.offset(mewsS, -1, 0).sub(kAt(mewsS)).normalize();
    const yard = kAt(mewsS).addScaledVector(mewsDir, 26).setY(0);
    const mewsBlock = mkBuilding({
      id: 'ashcombe:mews', name: 'Crown Mews', town: T, kind: 'mews', center: yard.clone().addScaledVector(mewsDir, 9.5), size: V(16, 4.6, 7), yaw: 0, roofH: 2.4,
      roof: 'slate', walls: 'brick', residents: 1, lit: true, doorLx: [-4, 0, 4], chimLx: [6.5],
    });
    mewsBlock.yaw = Math.atan2(-mewsDir.x, -mewsDir.z);
    Object.assign(mewsBlock, mkBuilding({ ...mewsBlock, doorLx: [-4, 0, 4], chimLx: [6.5] }));
    buildings.push(mewsBlock);
    addNode('mews', yard, 'end');
    addNode('jMW', kAt(mewsS), 'junction');
    const mwPoly = Poly.linear([kAt(mewsS), yard], 2);
    for (const p of mwPoly.pts) p.y = G.sample(G.h, p.x, p.z);
    edges.MW = { id: 'MW', name: 'Crown Mews drive', kind: 'drive', a: 'jMW', b: 'mews', width: 4, lanes: 1, oneWay: false, speed: 2, poly: mwPoly, footSide: 1 };
    mews0 = { door: mewsBlock.doors[1].clone(), yard, yaw: mewsBlock.yaw, road: 'MW' };
    const lamps = [
      kOff(115, -5.8), kOff(146, -5.8), kOff(176, 5.8), kOff(204, -5.8),
      localToWorld(sq.center, sq.yaw, -14, -10), localToWorld(sq.center, sq.yaw, 14, -10), localToWorld(sq.center, sq.yaw, -14, 10), localToWorld(sq.center, sq.yaw, 14, 10),
    ];
    towns.push({
      id: 'ashcombe', name: 'Ashcombe', center: sq.center.clone(), buildings: [...list, church, mewsBlock], lamps,
      areas: [
        { id: 'square', kind: 'square', ...sq },
        { id: 'churchyard', kind: 'churchyard', center: church.center.clone(), size: V(28, 0.1, 16), yaw: church.yaw },
        { id: 'schoolyard', kind: 'playground', ...areaFront('K', 166, 177, 1, 10, 2.5 + 10 + 0.5) },
        { id: 'mewsYard', kind: 'yard', center: yard.clone(), size: V(18, 0.1, 12), yaw: mewsBlock.yaw },
      ],
    });
  }
  // Millbridge (east bank, around the M / S / F junction)
  {
    const T = 'millbridge';
    const M = edges.M, S = edges.S;
    const sEnd = M.poly.length;
    const Bm = (s0: number, s1: number, side: 1 | -1, d: number, o: FrontOpts) => front('M', sEnd - s1, sEnd - s0, side, d, { ...o, town: T });
    const Bs = (s0: number, s1: number, side: 1 | -1, d: number, o: FrontOpts) => front('S', s0, s1, side, d, { ...o, town: T });
    const list: Building[] = [
      Bm(14, 26, 1, 9, { name: "The Miller's Arms", id: 'millersArms', kind: 'pub', size: V(0, 6.2, 0), walls: 'whitewash', roof: 'thatch', chimLx: [-4.5, 4.5], residents: 3 }),
      Bm(30, 38, 1, 7, { name: 'Wheel Cottage', kind: 'cottage', roof: 'thatch', walls: 'whitewash' }),
      Bm(12, 22, -1, 9, { name: 'Millbridge Dairy', id: 'dairy', kind: 'dairy', size: V(0, 5, 0), roof: 'tile', walls: 'brick', residents: 2 }),
      Bm(26, 32, -1, 6.5, { name: 'Brook Cottage', kind: 'cottage', roof: 'thatch', walls: 'whitewash' }),
      Bm(35, 41, -1, 6.5, { name: 'Weir Cottage', kind: 'cottage', roof: 'tile', walls: 'stone' }),
      Bs(13, 19, 1, 6.5, { name: 'Pear Tree Cottage', kind: 'cottage', roof: 'thatch', walls: 'whitewash' }),
      Bs(22, 28, 1, 6.5, { name: 'Mill Cottage', kind: 'cottage', roof: 'tile' }),
      Bs(8, 18, -1, 8, { name: 'Bethel Chapel', id: 'chapel', kind: 'chapel', size: V(0, 6, 0), walls: 'stone', residents: 0, chimLx: [] }),
      Bs(22, 28, -1, 6.5, { name: 'Hollow Cottage', kind: 'cottage', roof: 'thatch', walls: 'whitewash' }),
      Bs(31, 37, -1, 6.5, { name: 'Well Cottage', kind: 'cottage', roof: 'tile', walls: 'brick' }),
    ];
    const green = { center: M.poly.offset(sEnd - 45, 22, 0), size: V(26, 0.1, 18), yaw: M.poly.yawAt(sEnd - 45) };
    towns.push({
      id: 'millbridge', name: 'Millbridge', center: nodes.jMB.pos.clone(), buildings: list,
      lamps: [M.poly.offset(sEnd - 10, 3.8, 0), S.poly.offset(20, -3.8, 0)],
      areas: [{ id: 'green', kind: 'green', ...green }],
    });
  }
  // Wyke St Mary (NW, on Wyke Lane)
  {
    const T = 'wyke';
    const Wp = edges.W.poly;
    const sAt = (x: number, z: number) => Wp.nearest(x, z).s;
    const s0 = sAt(-170, -162);
    const Bw = (a: number, b: number, side: 1 | -1, d: number, o: FrontOpts) => front('W', s0 + a, s0 + b, side, d, { ...o, town: T });
    const list: Building[] = [
      Bw(0, 6, -1, 6.5, { name: 'Down Cottage', kind: 'cottage', roof: 'thatch', walls: 'whitewash' }),
      Bw(9, 15, -1, 6.5, { name: 'Thyme Cottage', kind: 'cottage', roof: 'tile' }),
      Bw(18, 30, -1, 8, { name: 'The Plough', id: 'plough', kind: 'pub', size: V(0, 6, 0), walls: 'whitewash', roof: 'thatch', chimLx: [-4, 4] }),
      Bw(34, 42, -1, 8, { name: 'Wheelwright & Smithy', id: 'smithy', kind: 'smithy', size: V(0, 4.4, 0), roof: 'tile', walls: 'stone' }),
      Bw(45, 51, -1, 6.5, { name: 'Church Cottage', kind: 'cottage', walls: 'stone' }),
      Bw(3, 9, 1, 6.5, { name: 'Holly Cottage', kind: 'cottage', roof: 'thatch', walls: 'whitewash' }),
      Bw(12, 18, 1, 6.5, { name: 'Lark Cottage', kind: 'cottage', roof: 'tile', walls: 'brick' }),
      Bw(40, 46, 1, 6.5, { name: 'Wren Cottage', kind: 'cottage', roof: 'thatch', walls: 'whitewash' }),
      Bw(49, 55, 1, 6.5, { name: 'Vicarage Lodge', kind: 'cottage', roof: 'slate', walls: 'stone' }),
    ];
    const ch = mkBuilding({
      id: 'wyke:church', name: "St Peter's, Wyke", town: T, kind: 'church', center: Wp.offset(s0 + 28, 5 + 3 + 12, 0), size: V(15, 7, 8), yaw: 0, roofH: 3.8,
      roof: 'slate', walls: 'stone', residents: 0, lit: true, tower: { lx: -9.5, size: 4.4, h: 12, spire: true }, doorLx: [-4], chimLx: [],
    });
    { const t = Wp.tangent(s0 + 28); ch.yaw = Math.atan2(t.z, -t.x); Object.assign(ch, mkBuilding({ ...ch, doorLx: [-4], chimLx: [] })); }
    buildings.push(ch);
    const farmC = Wp.offset(s0 - 30, -(3 + 3 + 9), 0);
    const farm = atPoint({ id: 'wyke:farm', name: 'Wyke Farm', town: T, kind: 'farmhouse', center: farmC, size: V(11, 6, 8), yaw: Wp.yawAt(s0 - 30) + Math.PI, roofH: 3, roof: 'tile', walls: 'brick', residents: 4, lit: true, chimLx: [-4, 4] });
    const barn = atPoint({ id: 'wyke:barn', name: 'Wyke Barn', town: T, kind: 'barn', center: Wp.offset(s0 - 52, -(3 + 3 + 9), 0), size: V(18, 6, 9), yaw: Wp.yawAt(s0 - 52) + Math.PI, roofH: 4.5, roof: 'tile', walls: 'timber', residents: 0, lit: false, chimLx: [] });
    towns.push({ id: 'wyke', name: 'Wyke St Mary', center: Wp.at(s0 + 25).setY(0), buildings: [...list, ch, farm, barn], lamps: [Wp.offset(s0 + 24, 3.6, 0)], areas: [{ id: 'churchyard', kind: 'churchyard', center: ch.center.clone(), size: V(24, 0.1, 14), yaw: ch.yaw }] });
  }
  // Coldharbour Farm (on the Coldharbour Track, west)
  {
    const T = 'coldharbour';
    const Fp = edges.F.poly;
    const s0 = Fp.nearest(-170, 176).s;
    const list: Building[] = [
      front('F', s0 - 6, s0 + 6, -1, 8, { town: T, name: 'Coldharbour Farmhouse', id: 'farmhouse', kind: 'farmhouse', size: V(0, 6, 0), roof: 'tile', walls: 'brick', residents: 5, chimLx: [-4.5, 4.5] }),
      front('F', s0 + 12, s0 + 32, -1, 10, { town: T, name: 'Great Barn', id: 'barn1', kind: 'barn', size: V(0, 6.5, 0), roof: 'tile', walls: 'timber', residents: 0, lit: false, chimLx: [], setback: 6 }),
      front('F', s0 - 26, s0 - 12, -1, 8, { town: T, name: 'Cart Shed', id: 'cartshed', kind: 'barn', size: V(0, 4, 0), roof: 'tile', walls: 'timber', residents: 0, lit: false, chimLx: [], setback: 5 }),
      front('F', s0 + 4, s0 + 20, 1, 9, { town: T, name: 'Stables', id: 'stable', kind: 'stable', size: V(0, 4.2, 0), roof: 'slate', walls: 'brick', residents: 0, lit: false, chimLx: [], setback: 5 }),
    ];
    towns.push({
      id: 'coldharbour', name: 'Coldharbour Farm', center: Fp.at(s0).setY(0), buildings: list, lamps: [],
      areas: [
        { id: 'pond', kind: 'pond', center: Fp.offset(s0 + 30, 20, 0), size: V(14, 0.1, 10), yaw: 0.3 },
        { id: 'rickyard', kind: 'rickyard', center: Fp.offset(s0 + 22, -30, 0), size: V(22, 0.1, 14), yaw: Fp.yawAt(s0 + 22) },
      ],
    });
  }
  // Glenmoor Road hamlet (on the drove) and Eastcote
  {
    const Np = edges.N.poly, s0 = Np.nearest(15, -250).s;
    const list = [
      front('N', s0 - 12, s0 - 6, -1, 6.5, { town: 'glenmoor', name: 'Drovers Cottage', kind: 'cottage', roof: 'thatch', walls: 'whitewash' }),
      front('N', s0 - 3, s0 + 3, -1, 6.5, { town: 'glenmoor', name: 'Heath Cottage', kind: 'cottage', roof: 'tile' }),
      front('N', s0 + 6, s0 + 12, 1, 6.5, { town: 'glenmoor', name: 'Moor End', kind: 'cottage', roof: 'slate', walls: 'stone' }),
      front('N', s0 - 8, s0 + 2, 1, 9, { town: 'glenmoor', name: 'Glenmoor Barn', id: 'barn', kind: 'barn', size: V(0, 5, 0), roof: 'tile', walls: 'timber', residents: 0, lit: false, chimLx: [], setback: 4 }),
    ];
    towns.push({ id: 'glenmoor', name: 'Glenmoor Road', center: Np.at(s0).setY(0), buildings: list, lamps: [], areas: [] });
    const Dp = edges.D.poly, d0 = Dp.nearest(330, 92).s;
    const list2 = [
      front('D', d0 - 14, d0 - 8, -1, 6.5, { town: 'eastcote', name: 'Eastcote Cottage', kind: 'cottage', roof: 'thatch', walls: 'whitewash' }),
      front('D', d0 - 5, d0 + 1, -1, 6.5, { town: 'eastcote', name: 'Sea View', kind: 'cottage', roof: 'slate' }),
      front('D', d0 + 4, d0 + 10, -1, 6.5, { town: 'eastcote', name: 'Gull Cottage', kind: 'cottage', roof: 'tile', walls: 'stone' }),
      front('D', d0 - 6, d0 + 8, 1, 9, { town: 'eastcote', name: 'Eastcote Farm', id: 'farm', kind: 'farmhouse', size: V(0, 6, 0), roof: 'tile', residents: 4, chimLx: [-4.5, 4.5], setback: 4 }),
    ];
    towns.push({ id: 'eastcote', name: 'Eastcote', center: Dp.at(d0).setY(0), buildings: list2, lamps: [], areas: [] });
  }

  // ── river structures ──
  const hwAt = (s: number) => W_WATER(s) / 2;
  const TOW_W = 3;
  const towLat = (s: number) => hwAt(s) + 0.6 + TOW_W / 2;
  const bridgeSs = bridges.filter((b) => b.riverS !== undefined).map((b) => b.riverS!);
  const towY = (s: number) => {
    let y = -2.2;
    for (const bs of bridgeSs) y = Math.min(y, THREE.MathUtils.lerp(-2.8, -2.2, smooth(Math.abs(s - bs), 8, 22)));
    // below the weir the whole valley sits 0.5 lower
    return y - (s > sWeir ? 0.5 : 0);
  };
  // the Coldharbour Track meets the towpath level where it crosses it (flat across the path), then drops into the
  // ford: the towpath terrace stays continuous and the road ribbon never tears against it
  if (fordHump) {
    const pts = edges.F.poly.pts;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      const n = rpoly.nearest(q.x, q.z);
      if (n.lat > 0 && Math.abs(n.d - towLat(n.s)) < TOW_W / 2 + 0.9) q.y = Math.max(q.y, towY(n.s) + 0.01);
    }
  }
  const weirPos = rpoly.at(sWeir).setY(-3.0);
  const weir = { s: sWeir, pos: weirPos, yaw: rpoly.yawAt(sWeir) + 0.35, drop: 0.5 };
  const lockLat = hwAt(sWeir - 1) - 2.6;
  const lock = {
    s0: sWeir - 14, s1: sWeir + 14, lateral: lockLat, width: 5,
    gates: [sWeir - 13, sWeir + 13].flatMap((s) => [rpoly.offset(s, lockLat - 2.5, -3.0), rpoly.offset(s, lockLat + 2.5, -3.0)]),
    dropY: [-3.0, -3.5] as [number, number],
  };
  const millS = sWeir - 6;
  const millYaw = rpoly.yawAt(millS);
  const millC = rpoly.offset(millS, -(hwAt(millS) + 7.5), 0);
  const millDoorFace = rpoly.offset(millS, -(hwAt(millS) + 13.2), 0);
  const mill = {
    center: millC, size: V(13, 8.5, 9), yaw: millYaw,
    door: millDoorFace, wheel: rpoly.offset(millS, -(hwAt(millS) + 1.4), -2.0), wheelR: 2.6, wheelAxis: rpoly.offset(millS, -1, 0).sub(rpoly.at(millS)).setY(0).normalize(),
  };
  const millB = mkBuilding({ id: 'river:mill', name: 'Millbridge Mill', town: 'river', kind: 'mill', center: millC.clone(), size: V(13, 8.5, 9), yaw: millYaw + Math.PI, roofH: 3.4, roof: 'slate', walls: 'brick', residents: 0, lit: true, chimLx: [4.5] });
  // front of the mill faces away from the water (toward the village)
  buildings.push(millB);
  const keeperC = rpoly.offset(sWeir + 4, towLat(sWeir) + TOW_W / 2 + 8.5, 0);
  const keeper = mkBuilding({ id: 'river:lockCottage', name: "Lock-keeper's Cottage", town: 'river', kind: 'cottage', center: keeperC, size: V(7, 4.6, 6), yaw: rpoly.yawAt(sWeir + 4) - Math.PI / 2 + Math.PI, roofH: 2.6, roof: 'tile', walls: 'whitewash', residents: 2, lit: true });
  {
    // front faces the towpath (toward the river): local +z → −(tangent×up)
    const t = rpoly.tangent(sWeir + 4);
    keeper.yaw = Math.atan2(t.z, -t.x);
    Object.assign(keeper, mkBuilding({ ...keeper }));
  }
  buildings.push(keeper);
  const sBoat = rpoly.nearest(150, -15).s;
  const boatYaw = rpoly.yawAt(sBoat);
  const boatC = rpoly.offset(sBoat, -(hwAt(sBoat) + 1.8), 0);
  const boathouse = {
    center: boatC, size: V(10, 4.2, 6), yaw: boatYaw,
    door: rpoly.offset(sBoat, -(hwAt(sBoat) + 5.6), 0), slip: rpoly.offset(sBoat, -(hwAt(sBoat) - 1.5), -3.0), slipS: sBoat,
  };
  const boathouseB = mkBuilding({ id: 'river:boathouse', name: 'Ashcombe Rowing Club', town: 'river', kind: 'boathouse', center: boatC.clone(), size: V(10, 4.2, 6), yaw: boatYaw + Math.PI, roofH: 2.2, roof: 'slate', walls: 'timber', residents: 0, lit: false, chimLx: [] });
  buildings.push(boathouseB);
  const jetty = { a: rpoly.offset(sBoat + 7, -(hwAt(sBoat) - 0.8), -2.3), b: rpoly.offset(sBoat + 16, -(hwAt(sBoat) - 0.8), -2.3), y: -2.3 };
  const mooring = (id: string, x: number, z: number, lat = 1) => {
    const s = rpoly.nearest(x, z).s;
    return { id, s, lateral: lat * (hwAt(s) - 1.2), pos: rpoly.offset(s, lat * (hwAt(s) + 0.4), towY(s)) };
  };
  /** angler peg; side +1 = towpath (west) bank, −1 = east bank (y resolved after the carve) */
  const peg = (id: string, x: number, z: number, best = false, side: 1 | -1 = 1) => {
    const s = rpoly.nearest(x, z).s;
    const pos = side > 0 ? rpoly.offset(s, hwAt(s) + 0.9, towY(s)) : rpoly.offset(s, -(hwAt(s) + 1.6), 0);
    const t = rpoly.tangent(s);
    // yaw uses the people convention (local +z faces the water): toward −side·(tangent × up)
    const fx = -side * -t.z, fz = -side * t.x;
    return { id, pos, yaw: Math.atan2(fx, fz), s, best };
  };
  const fordE = edges.F;
  const fordX = fordE.poly.intersections(rpoly)[0];
  const ford = fordX ? {
    s: fordX.so, pos: fordX.p.clone().setY(fordBedY), width: fordE.width + 4, bedY: fordBedY, road: 'F', roadS: fordX.s,
    stones: Array.from({ length: 11 }, (_, i) => rpoly.offset(fordX.so - 4.5, -hwAt(fordX.so) + 0.3 + (i * (2 * hwAt(fordX.so) - 0.6)) / 10, waterY(fordX.so) + 0.12)),
  } : { s: 0, pos: P(0, 0), width: 0, bedY: 0, road: 'F', roadS: 0, stones: [] };
  const riverPortal = (up: boolean) => {
    if (up) { for (let s = 0; s < rpoly.length; s += 1) { const p = rpoly.at(s); if (Math.max(Math.abs(p.x), Math.abs(p.z)) < PORTAL_R) return { pos: p, s }; } }
    else { for (let s = rpoly.length; s > 0; s -= 1) { const p = rpoly.at(s); if (Math.max(Math.abs(p.x), Math.abs(p.z)) < PORTAL_R) return { pos: p, s }; } }
    return { pos: rpoly.at(0), s: 0 };
  };
  const rPortals = { up: riverPortal(true), down: riverPortal(false) };
  const towPoly = new Poly(rpoly.pts.map((_, i) => { const s = rpoly.cum[i]; return rpoly.offset(s, towLat(s), towY(s)); }));
  const river: RiverLayout = {
    name: 'River Ashbourne', poly: rpoly, length: rpoly.length, widthAt: W_WATER, waterYAt: waterY, bedDepth: 0.8,
    towpath: { side: 1, width: TOW_W, lateral: towLat, yAt: towY, poly: towPoly },
    pointAt: (s, lateral = 0, y, out) => rpoly.offset(s, lateral, y, out),
    tangentAt: (s, out) => rpoly.tangent(s, out),
    nearest: (p) => { const n = rpoly.nearest(p.x, p.z); return { s: n.s, lat: n.lat, d: n.d }; },
    weir, lock, mill, boathouse, jetty,
    moorings: [mooring('m1', 164, -120), mooring('m2', 160, -96), mooring('m3', 140, 90), mooring('m4', 46, 320)],
    fishing: [peg('F1', 153, -112), peg('F2', 146, -84), peg('F3', 146, -3, false, -1), peg('F4', 154, 50, false, -1), peg('F5', 128, 108, true), peg('F6', 94, 164), peg('F7', 66, 250), peg('F8', 110, -300)],
    ford,
    reeds: [
      { s0: rNear(114, -215) - 12, s1: rNear(114, -215) + 14, side: -1 }, { s0: rNear(166, -128) - 10, s1: rNear(166, -128) + 10, side: 1 },
      { s0: rNear(148, -74) - 8, s1: rNear(148, -74) + 8, side: -1 }, { s0: rNear(152, 60) - 10, s1: rNear(152, 60) + 12, side: -1 },
      { s0: rNear(76, 215) - 12, s1: rNear(76, 215) + 12, side: 1 }, { s0: rNear(46, 320) - 10, s1: rNear(46, 320) + 10, side: -1 },
    ],
    heron: [rpoly.offset(rNear(108, -262), -(hwAt(rNear(108, -262)) - 0.6), -3.0), rpoly.offset(rNear(62, 262), -(hwAt(rNear(62, 262)) - 0.6), -3.5)],
    portals: rPortals,
    reaches: [
      { id: 'regatta', s0: bridges.find((b) => b.id === 'glenmoor')?.riverS ?? sRegatta0, s1: sBoat + 16 },
      { id: 'millpool', s0: sPool0 - 20, s1: sWeir - 15 },
      { id: 'skating', s0: rNear(143, -46) + 15, s1: rNear(158, 24) - 12 },
    ],
  };
  towns.push({ id: 'river', name: 'River Ashbourne', center: millC.clone(), buildings: [millB, keeper, boathouseB], lamps: [boathouse.door.clone().setY(0)], areas: [] });
  towns.push({ id: 'lc1', name: 'Millbridge Gates', center: crossings[0]?.center.clone() ?? P(LC1_X, 24), buildings: crossings[0] ? [crossings[0].lodge] : [], lamps: crossings[0] ? [crossings[0].lodge.doors[0].clone()] : [], areas: [{ id: 'henRun', kind: 'garden', center: crossings[0]?.lodge.center.clone().add(P(-7, 0)) ?? P(0, 0), size: V(8, 0.1, 6), yaw: 0 }] });
  if (crossings[0]) buildings.push(crossings[0].lodge);

  // platelayers' hut, signal box door, windmill
  const hut = mkBuilding({ id: 'station:platelayers', name: "Platelayers' Hut", town: 'station', kind: 'hut', center: P(188, 31.5), size: V(5, 2.8, 3.2), yaw: 0, roofH: 1.2, roof: 'slate', walls: 'timber', residents: 3, lit: false, chimLx: [1.8] });
  buildings.push(hut);
  towns.find((t) => t.id === 'station')!.buildings.push(hut);
  const windmill = { center: edges.W.poly.offset(edges.W.poly.nearest(-245, -163).s, -42, 0), yaw: 0.6, hubY: 11.5, moundR: 11, moundH: 3 };

  // ── fields ──
  const rectPoly = (cx: number, cz: number, w: number, d: number, yaw: number) => {
    const c = P(cx, cz);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => { const p = localToWorld(c, yaw, (a * w) / 2, (b * d) / 2); return new THREE.Vector2(p.x, p.z); });
  };
  const field = (id: string, name: string, kind: FieldKind, poly: THREE.Vector2[], rowYaw: number, livestock?: Field['livestock']): Field => {
    const cx = poly.reduce((a, p) => a + p.x, 0) / poly.length, cz = poly.reduce((a, p) => a + p.y, 0) / poly.length;
    // gate: boundary midpoint nearest to any road
    let best = { d: Infinity, p: P(cx, cz) };
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      for (let k = 1; k < 8; k++) {
        const x = a.x + ((b.x - a.x) * k) / 8, z = a.y + ((b.y - a.y) * k) / 8;
        let d = Infinity;
        for (const e of Object.values(edges)) if (e.kind !== 'loop') d = Math.min(d, e.poly.nearest(x, z).d);
        if (d < best.d) best = { d, p: P(x, z) };
      }
    }
    return { id, name, kind, poly, rowYaw, gate: best.p, livestock, center: P(cx, cz) };
  };
  const fields: Field[] = [
    field('FA', 'Long Acre', 'wheat', rectPoly(-120, 132, 70, 42, 0.1), 0.1),
    field('FB', 'Wyke Down', 'pasture', rectPoly(-110, -118, 86, 56, 0.2), 0.2, 'sheep'),
    field('FC', 'Coldharbour Ley', 'plough', rectPoly(-250, 128, 50, 64, 0), Math.PI / 2),
    field('FD', 'Glenmoor Field', 'wheat', rectPoly(-62, -236, 76, 48, -0.2), -0.2),
    field('FE', 'Kingsmead', 'pasture', [new THREE.Vector2(174, 36), new THREE.Vector2(204, 36), new THREE.Vector2(200, 60), new THREE.Vector2(184, 92), new THREE.Vector2(171, 96), new THREE.Vector2(169, 62)], 0, 'cows'),
    field('FF', 'Millbridge Field', 'barley', rectPoly(46, 130, 56, 44, 0.05), 0.05),
    field('FG', 'Shed Meadow', 'hay', rectPoly(-30, 118, 60, 40, 0), 0),
    field('FH', 'Eastcote Down', 'pasture', rectPoly(310, -40, 64, 46, 0.3), 0.3, 'sheep'),
    field('FI', 'Hollow Field', 'turnips', rectPoly(190, 260, 70, 50, 0.15), 0.15),
    field('FJ', 'Top Field', 'wheat', rectPoly(60, -255, 50, 60, 0.1), 0.1),
    field('FK', 'Paddock', 'pasture', rectPoly(-200, -210, 40, 32, 0.4), 0.4, 'horses'),
    field('FL', 'Church Acre', 'hay', rectPoly(275, 122, 60, 40, -0.1), -0.1),
  ];

  // ── footpaths & towpath ──
  const paths: Countryside['paths'] = [];
  paths.push({ id: 'towpath', name: 'Ashbourne Towpath', kind: 'towpath', poly: towPoly, stiles: [] });
  const kSide = (s: number, lat: number) => edges.K.poly.offset(s, lat, 0);
  const sHump = bridges.find((b) => b.id === 'ashbourne')?.roadS ?? 83;
  // steps from the humpback's west ramp (north side) down to the towpath
  {
    const top = kSide(sHump - 18, -5.8);
    const n = rpoly.nearest(top.x, top.z);
    const low = rpoly.offset(n.s, towLat(n.s), towY(n.s));
    paths.push({ id: 'anglersSteps', name: 'Anglers’ Steps', kind: 'steps', poly: Poly.linear([top, low], 2), stiles: [] });
  }
  // Meadow Walk: Ashcombe west end (south side of K) down the east bank to the boathouse
  {
    const a = kSide(sHump + 24, 5.8);
    paths.push({ id: 'meadowWalk', name: 'Meadow Walk', kind: 'footpath', poly: Poly.smooth([a, P(a.x - 2, a.z + 14), rpoly.offset(sBoat - 12, -(hwAt(sBoat) + 6), 0), boathouse.door.clone()], 2), stiles: [P(a.x - 1.4, a.z + 8)] });
  }
  // Kingsmead Path: Millbridge north over the meadow to the river bank below the arches (anglers)
  {
    const a = edges.M.poly.at(edges.M.poly.length - 40);
    const sA = rNear(154, 50);
    paths.push({ id: 'kingsmeadPath', name: 'Kingsmead Path', kind: 'footpath', poly: Poly.smooth([a, P(166, 110), P(166, 80), rpoly.offset(sA, -(hwAt(sA) + 4), 0)], 2), stiles: [P(166, 100)] });
  }
  // Headland Path: Coldharbour Farm round Long Acre to the shed yard (fitters)
  {
    const fh = towns.find((t) => t.id === 'coldharbour')!.buildings[0].doors[0];
    paths.push({ id: 'headlandPath', name: 'Headland Path', kind: 'footpath', poly: Poly.smooth([fh, P(-162, 150), P(-160, 108), P(-128, 100), P(-110, 76)], 2), stiles: [P(-160, 120)] });
  }
  // Church Path: Wyke church east over Wyke Down to Glenmoor Drove
  {
    const cd = towns.find((t) => t.id === 'wyke')!.buildings.find((b) => b.kind === 'church')!.doors[0];
    paths.push({ id: 'churchPath', name: 'Church Path', kind: 'footpath', poly: Poly.smooth([cd, P(-150, -180), P(-60, -190), P(0, -205), edges.N.poly.at(edges.N.poly.nearest(12, -205).s).setY(0)], 2), stiles: [P(-150, -180), P(-60, -190)] });
  }
  // Millbridge mill lane (footpath from the village to the mill door)
  {
    const a = edges.M.poly.at(edges.M.poly.length - 6);
    paths.push({ id: 'millPath', name: 'Mill Lane', kind: 'footpath', poly: Poly.smooth([a, P((a.x + mill.door.x) / 2, (a.z + mill.door.z) / 2 - 3), mill.door.clone()], 2), stiles: [] });
  }
  // drape footpaths (not the towpath/steps, which carry their own y)
  for (const p of paths) if (p.kind === 'footpath') for (const q of p.poly.pts) q.y = G.sample(G.h, q.x, q.z);

  // ── rail portals ──
  for (const tn of tunnels) {
    for (const ln of tn.lines) {
      const z = ln === 'coast' ? 24 : ln === 'highland' ? 19 : SHED_Z;
      const pos = tn.id === 'west' ? P(-300, z) : tn.id === 'shedWest' ? P(-300, z) : P(tn.x + tn.dx * 30, tn.z + tn.dz * 30);
      portals.push({ id: `rail:${tn.id}:${ln}`, kind: 'rail', pos, dir: P(tn.dx, tn.dz), line: ln === 'shed' ? undefined : (ln as LineId), towards: ln });
    }
  }
  portals.push({ id: 'river:up', kind: 'river', pos: rPortals.up.pos.clone(), dir: rpoly.tangent(rPortals.up.s).negate(), towards: 'upstream (Glenmoor)' });
  portals.push({ id: 'river:down', kind: 'river', pos: rPortals.down.pos.clone(), dir: rpoly.tangent(rPortals.down.s), towards: 'downstream (Brightmouth)' });
  // towpath portals for walkers & the bargehorse
  portals.push({ id: 'path:towUp', kind: 'path', pos: towPoly.at(rPortals.up.s), dir: rpoly.tangent(rPortals.up.s).negate(), towards: 'Glenmoor (towpath)' });
  portals.push({ id: 'path:towDown', kind: 'path', pos: towPoly.at(rPortals.down.s), dir: rpoly.tangent(rPortals.down.s), towards: 'Brightmouth (towpath)' });

  // ── terrain: road stamps, building pads, river carve ──
  G.roadY.fill(NaN); G.roadW.fill(0); G.road.fill(60);
  for (const e of Object.values(edges)) {
    if (e.kind === 'loop') continue;
    G.stampRoad(e.poly, e.width);
  }
  const blendRoad = new Float32Array(G.h.length);
  G.forEach((i) => {
    const w = G.roadW[i];
    blendRoad[i] = w > 0 && !Number.isNaN(G.roadY[i]) ? THREE.MathUtils.lerp(G.h[i], G.roadY[i], w) : G.h[i];
  });
  G.h.set(blendRoad);
  // building pads & town areas (flat pad at the centre height, 4 m blend)
  const padRects: { c: THREE.Vector3; sx: number; sz: number; yaw: number }[] = [];
  for (const b of buildings) padRects.push({ c: b.center, sx: b.size.x + 2, sz: b.size.z + 2, yaw: b.yaw });
  for (const t of towns) for (const a of t.areas) if (a.kind !== 'pond') padRects.push({ c: a.center, sx: a.size.x, sz: a.size.z, yaw: a.yaw });
  padRects.push({ c: windmill.center, sx: 1, sz: 1, yaw: 0 });
  // Coldharbour (and any) pond: flat pad at the centre height + a shallow 0.3 m elliptical bowl; area.center.y = rim
  const pondRims: { a: Town['areas'][number]; y: number }[] = [];
  for (const t of towns) for (const a of t.areas) if (a.kind === 'pond') {
    const y0 = G.sample(G.h, a.center.x, a.center.z);
    G.stampPad(a.center, a.size.x, a.size.z, a.yaw, y0, 4);
    const rx = a.size.x / 2, rz = a.size.z / 2;
    G.forEachNear(a.center.x, a.center.z, Math.max(rx, rz) + 1, (i, x, z) => {
      const [lx, lz] = worldToLocal(a.center, a.yaw, x, z);
      const r2 = (lx / rx) ** 2 + (lz / rz) ** 2;
      if (r2 < 1) G.h[i] = y0 - 0.3 * (1 - r2);
    });
    pondRims.push({ a, y: y0 });
  }
  for (const r of padRects) {
    const y0 = G.sample(G.h, r.c.x, r.c.z);
    r.c.y = y0;
    G.stampPad(r.c, r.sx, r.sz, r.yaw, y0, 4);
  }
  // windmill mound
  G.forEachNear(windmill.center.x, windmill.center.z, windmill.moundR + 8, (i, x, z) => {
    const d = Math.hypot(x - windmill.center.x, z - windmill.center.z);
    const k = 1 - smooth(d, windmill.moundR * 0.45, windmill.moundR + 6);
    G.h[i] = Math.max(G.h[i], windmill.center.y + windmill.moundH * k);
  });
  windmill.center.y += windmill.moundH;
  // river signed distance + carve
  G.stampRiver(rpoly);
  const fordC = ford.pos;
  G.forEach((i, x, z) => {
    const d = G.riverD[i];
    if (d > 60) return;
    const s = G.riverS[i];
    const hw = hwAt(s);
    const wy = waterY(s);
    const fd = Math.min(G.track[i], G.road[i] + 3);
    const slope = THREE.MathUtils.lerp(4.5, 0.62, smooth(fd, 5, 22));
    const a = Math.abs(d);
    let prof: number;
    if (a < hw) prof = wy - 0.25 - 0.6 * (1 - (a / hw) ** 2);
    else if (d > 0) {
      // right (west) bank: small edge, towpath terrace, then bank
      const tl = hw + 0.6, tr = hw + 0.6 + TOW_W;
      const ty = towY(s);
      if (a < tl) prof = THREE.MathUtils.lerp(wy - 0.25, ty, (a - hw) / 0.6);
      else if (a < tr) prof = ty;
      else prof = ty + (a - tr) * slope + Math.max(0, a - tr - 6) * 0.1;
    } else prof = wy - 0.25 + (a - hw) * slope * 1.1 + Math.max(0, a - hw - 6) * 0.1;
    if (fordX) {
      const df = Math.hypot(x - fordC.x, z - fordC.z);
      if (df < ford.width / 2 + 6) prof = Math.max(prof, THREE.MathUtils.lerp(fordBedY, prof, smooth(df, ford.width / 2, ford.width / 2 + 6)));
    }
    G.h[i] = Math.min(G.h[i], prof);
  });
  // the ford approaches: ground and road ribbon agree exactly (no shards floating over the carve, no grass through
  // the road); the margins blend out over the road stamp's soft edge
  if (fordX) G.forEachNear(fordC.x, fordC.z, 32, (i) => {
    const w = G.roadW[i];
    if (w <= 0 || Number.isNaN(G.roadY[i])) return;
    const k = w > 0.85 ? 1 : w;
    G.h[i] = THREE.MathUtils.lerp(G.h[i], G.roadY[i], k);
  });

  // final building heights (after the river carve) → doors / chimneys follow
  for (const b of buildings) {
    b.center.y = G.sample(G.h, b.center.x, b.center.z);
    const re = mkBuilding({ ...b, doorLx: b.doors.map((d) => worldToLocal(b.center, b.yaw, d.x, d.z)[0]), chimLx: b.chimneys.map((c) => worldToLocal(b.center, b.yaw, c.x, c.z)[0]) });
    for (const d of re.doors) d.y = G.sample(G.h, d.x, d.z);
    for (const d of re.doorsIn) d.y = b.center.y;
    b.doors = re.doors; b.doorsIn = re.doorsIn; b.chimneys = re.chimneys;
  }
  if (mews0) { const mb = buildings.find((b) => b.id === 'ashcombe:mews')!; mews0.door = mb.doors[1].clone(); mews0.yard.y = G.sample(G.h, mews0.yard.x, mews0.yard.z); }
  for (const f of river.fishing) if (f.pos.y > -1.9 || f.pos.y === 0) f.pos.y = G.sample(G.h, f.pos.x, f.pos.z);
  for (const p of paths) if (p.kind === 'footpath') for (const q of p.poly.pts) q.y = Math.max(G.sample(G.h, q.x, q.z), q.y - 10);
  for (const t of towns) for (const a of t.areas) a.center.y = G.sample(G.h, a.center.x, a.center.z);
  for (const pr of pondRims) pr.a.center.y = pr.y; // pond areas report the rim (water ≈ rim − 0.06)

  // ── walk graph ──
  const walk = buildWalkGraph(I, edges, paths, buildings, portals, crossings);

  // ── static origins (doors & portals) ──
  const origins: StaticOrigin[] = [];
  for (const b of buildings) b.doors.forEach((d, k) => origins.push({ id: `door:${b.id}:${k}`, kind: 'door', pos: d, inside: b.doorsIn[k], building: b.id, town: b.town, for: b.kind === 'mews' || b.kind === 'barn' || b.kind === 'stable' || b.kind === 'engineHouse' ? ['people', 'vehicles', 'animals'] : b.kind === 'boathouse' ? ['people', 'boats'] : b.kind === 'dairy' ? ['people', 'animals'] : ['people'] }));
  const nn = I.nav.nodes;
  const stationDoor = (id: string, p: THREE.Vector3, inside: THREE.Vector3, staffOnly = false) => origins.push({ id, kind: 'door', pos: p.clone(), inside: inside.clone(), building: 'station', town: 'station', for: ['people'], staffOnly });
  stationDoor('door:station:east', nn.booking, nn.hall);
  stationDoor('door:station:p1', nn.p1Door, nn.hall);
  stationDoor('door:station:p2', nn.p2Door, nn.hall);
  if (nn.shedDoor) stationDoor('door:shed', nn.shedDoor, nn.worker ?? nn.shedDoor, true);
  const sbDoor = (I.nav.nodes.sbDoor ?? P(I.signalBox.x, I.signalBox.z - 2.6)).clone();
  stationDoor('door:signalbox', sbDoor, I.signalBox.clone().setY(3.4), true);
  for (const p of portals) {
    if (p.kind === 'rail') continue;
    origins.push({ id: `portal:${p.id}`, kind: 'portal', pos: p.pos, portal: p.id, for: p.kind === 'river' ? ['boats'] : p.kind === 'path' ? ['people', 'animals'] : ['people', 'vehicles', 'animals'] });
  }

  // ── street lamps ──
  const streetLamps: THREE.Vector3[] = [];
  for (const t of towns) for (const l of t.lamps) streetLamps.push(l.clone().setY(G.sample(G.h, l.x, l.z)));

  // ── route finding on roads ──
  const roadAdj = new Map<string, { edge: string; dir: 1 | -1; to: string; len: number }[]>();
  const addAdj = (n: string, e: { edge: string; dir: 1 | -1; to: string; len: number }) => { if (!roadAdj.has(n)) roadAdj.set(n, []); roadAdj.get(n)!.push(e); };
  // junction nodes that sit part-way along an edge split it virtually: record (edge, s) for each junction
  const nodeOn = new Map<string, { edge: string; s: number }[]>();
  for (const n of Object.values(nodes)) {
    for (const e of Object.values(edges)) {
      if (e.kind === 'loop') continue;
      const q = e.poly.nearest(n.pos.x, n.pos.z);
      if (q.d < 0.8) { if (!nodeOn.has(e.id)) nodeOn.set(e.id, []); nodeOn.get(e.id)!.push({ edge: n.id, s: q.s }); }
    }
  }
  const segOf: { edge: string; a: string; b: string; s0: number; s1: number }[] = [];
  for (const e of Object.values(edges)) {
    if (e.kind === 'loop') continue;
    const on = (nodeOn.get(e.id) ?? []).sort((p, q) => p.s - q.s);
    for (let k = 0; k < on.length - 1; k++) {
      const a = on[k], b = on[k + 1];
      if (b.s - a.s < 0.5) continue;
      segOf.push({ edge: e.id, a: a.edge, b: b.edge, s0: a.s, s1: b.s });
      addAdj(a.edge, { edge: e.id, dir: 1, to: b.edge, len: b.s - a.s });
      addAdj(b.edge, { edge: e.id, dir: -1, to: a.edge, len: b.s - a.s });
    }
  }
  const nearestNodeId = (p: THREE.Vector3) => {
    let best = '', bd = Infinity;
    for (const n of Object.values(nodes)) { const d = (n.pos.x - p.x) ** 2 + (n.pos.z - p.z) ** 2; if (d < bd) { bd = d; best = n.id; } }
    return best;
  };
  const makeRoute = (legs: RouteLeg[]): RoadRoute => {
    const cum: number[] = [0];
    for (const l of legs) cum.push(cum[cum.length - 1] + Math.abs(l.s1 - l.s0));
    const length = cum[cum.length - 1];
    const locate = (d: number) => {
      const dd = clamp(d, 0, length);
      let k = 0;
      while (k < legs.length - 1 && cum[k + 1] < dd) k++;
      const l = legs[k];
      const s = l.s0 + (dd - cum[k]) * Math.sign(l.s1 - l.s0 || 1);
      return { edge: l.edge, s, dir: l.dir, leg: k };
    };
    return {
      legs, length, locate,
      sample(d, lateral = 0, out = { pos: new THREE.Vector3(), yaw: 0 }) {
        const q = locate(d);
        const e = edges[q.edge];
        e.poly.offset(q.s, lateral * q.dir, undefined, out.pos);
        out.yaw = e.poly.yawAt(q.s) + (q.dir < 0 ? Math.PI : 0);
        return out;
      },
    };
  };
  const roadPath = (from: string | THREE.Vector3, to: string | THREE.Vector3): RoadRoute | null => {
    const a = typeof from === 'string' ? from : nearestNodeId(from);
    const b = typeof to === 'string' ? to : nearestNodeId(to);
    if (!nodes[a] || !nodes[b]) return null;
    if (a === b) return makeRoute([]);
    const dist = new Map<string, number>([[a, 0]]);
    const prev = new Map<string, { from: string; edge: string; dir: 1 | -1 }>();
    const heap = new MinHeap<string>();
    heap.push(0, a);
    while (heap.size) {
      const [d, cur] = heap.pop()!;
      if (d > (dist.get(cur) ?? Infinity)) continue;
      if (cur === b) break;
      for (const e of roadAdj.get(cur) ?? []) {
        const nd = d + e.len;
        if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: cur, edge: e.edge, dir: e.dir }); heap.push(nd, e.to); }
      }
    }
    if (!prev.has(b)) return null;
    const legs: RouteLeg[] = [];
    for (let c = b; c !== a;) {
      const p = prev.get(c)!;
      const seg = segOf.find((sg) => sg.edge === p.edge && ((sg.a === p.from && sg.b === c) || (sg.b === p.from && sg.a === c)))!;
      legs.unshift(p.dir === 1 ? { edge: p.edge, dir: 1, s0: seg.s0, s1: seg.s1 } : { edge: p.edge, dir: -1, s0: seg.s1, s1: seg.s0 });
      c = p.from;
    }
    // merge consecutive legs on the same edge & direction
    const merged: RouteLeg[] = [];
    for (const l of legs) {
      const last = merged[merged.length - 1];
      if (last && last.edge === l.edge && last.dir === l.dir && Math.abs(last.s1 - l.s0) < 1e-6) last.s1 = l.s1; else merged.push({ ...l });
    }
    return makeRoute(merged);
  };

  // ── terrain API ──
  const buildingAt = (x: number, z: number, margin = 0) => {
    for (const b of buildings) {
      const [lx, lz] = worldToLocal(b.center, b.yaw, x, z);
      if (Math.abs(lx) <= b.size.x / 2 + margin && Math.abs(lz) <= b.size.z / 2 + margin) return b;
    }
    return null;
  };
  const stationRects = [
    ...I.platforms.map((p) => ({ center: p.center, size: V(p.length + 12, 1, p.width), yaw: p.yaw })),
    { center: I.station.center, size: I.station.size, yaw: I.station.yaw },
    { center: I.forecourt.center, size: I.forecourt.size, yaw: I.forecourt.yaw },
    I.shedBuilding,
  ];
  const inStation = (x: number, z: number, m: number) => stationRects.some((r) => { const [lx, lz] = worldToLocal(r.center, r.yaw, x, z); return Math.abs(lx) <= r.size.x / 2 + m && Math.abs(lz) <= r.size.z / 2 + m; });
  const riverDistF = (x: number, z: number) => { const i = G.idx(x, z); return i < 0 ? 60 : Math.min(60, Math.abs(G.riverD[i]) - hwAt(G.riverS[i])); };
  const terrain: TerrainLayout = {
    half: GROUND_HALF, skirtY: SKIRT_Y, playHalf: PLAY_HALF, portalR: PORTAL_R,
    heightAt: (x, z) => {
      if (Math.max(Math.abs(x), Math.abs(z)) > GROUND_HALF) return SKIRT_Y;
      const h = G.sample(G.h, x, z);
      if (h <= 0.02) return h;
      // tunnel mouths: the 2 m grid lets the tunnel hill bleed over the rails; keep the track bed level (≤ 0)
      // within 4 m of any track out to ~5 m inside each portal, blending back to the hill by 7 m.
      for (const tn of tunnels) {
        const rx = x - tn.x, rz = z - tn.z;
        const uu = rx * tn.dx + rz * tn.dz;
        if (uu > 7 || uu < -40) continue;
        if (Math.abs(-rx * tn.dz + rz * tn.dx) > tn.width / 2 + 4) continue;
        const td = G.sample(G.track, x, z);
        if (td >= 4) continue;
        return THREE.MathUtils.lerp(Math.min(h, 0), h, smooth(uu, 5, 7));
      }
      return h;
    },
    trackDist: (x, z) => G.sample(G.track, x, z),
    roadDist: (x, z) => G.sample(G.road, x, z),
    riverDist: riverDistF,
    isWater: (x, z) => { const i = G.idx(x, z); return i >= 0 && Math.abs(G.riverD[i]) < hwAt(G.riverS[i]); },
    featureDist: (x, z) => G.sample(G.feature, x, z),
    clear(x, z, margin = 0) {
      if (G.sample(G.track, x, z) < 8 + margin) return false;
      if (G.sample(G.road, x, z) < margin) return false;
      if (riverDistF(x, z) < 4 + margin) return false;
      if (buildingAt(x, z, margin)) return false;
      if (inStation(x, z, margin)) return false;
      return true;
    },
    buildingAt,
  };

  const nearestRoad = (p: THREE.Vector3) => {
    let best = { edge: '', s: 0, lat: 0, d: Infinity };
    for (const e of Object.values(edges)) { const q = e.poly.nearest(p.x, p.z); if (q.d < best.d) best = { edge: e.id, s: q.s, lat: q.lat, d: q.d }; }
    return best;
  };
  const nearestOrigin = (pos: THREE.Vector3, kinds?: OriginKindL[], forKind?: 'people' | 'vehicles' | 'animals' | 'boats') => {
    let best: StaticOrigin | null = null, bd = Infinity;
    for (const o of origins) {
      if (kinds && !kinds.includes(o.kind)) continue;
      if (forKind && !o.for.includes(forKind)) continue;
      const d = (o.pos.x - pos.x) ** 2 + (o.pos.z - pos.z) ** 2;
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  };

  const validate = (): string[] => {
    const out = [...issues0];
    // river meets tracks only at the two bridges (checked above), roads only at the humpback + ford
    for (const e of Object.values(edges)) {
      if (e.kind === 'loop') continue;
      const xs = e.poly.intersections(rpoly).length;
      const want = e.id === 'K' || e.id === 'F' ? 1 : 0;
      if (xs !== want) out.push(`road ${e.id} crosses the river ${xs}× (expected ${want})`);
    }
    // roads clear of platforms/station/shed; roads never overlap each other except at junctions
    for (const e of Object.values(edges)) {
      if (e.kind === 'loop') continue;
      for (let s = 0; s <= e.poly.length; s += 3) {
        const p = e.poly.at(s);
        if (inStation(p.x, p.z, e.width / 2 + 1) && !(e.id === 'K' && s < 8)) { out.push(`road ${e.id} runs into the station area at (${p.x.toFixed(1)},${p.z.toFixed(1)})`); break; }
        if (e.id !== 'M' && e.id !== 'W' && trackDistExact(p.x, p.z) < e.width / 2 + 4) { out.push(`road ${e.id} within ${(e.width / 2 + 4)} m of a track at (${p.x.toFixed(1)},${p.z.toFixed(1)})`); break; }
      }
    }
    // buildings: clear of tracks (10 m), roads (1.5 m from edge), river (3 m from water, except river buildings), each other, station
    for (const b of buildings) {
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0], [0, 1], [0, -1], [1, 0], [-1, 0]].map(([a, c]) => localToWorld(b.center, b.yaw, (a * b.size.x) / 2, (c * b.size.z) / 2));
      const tmin = Math.min(...corners.map((q) => trackDistExact(q.x, q.z)));
      if (tmin < (b.kind === 'lodge' || b.kind === 'hut' ? 5 : 10)) out.push(`building ${b.id} ${tmin.toFixed(1)} m from a track`);
      for (const e of Object.values(edges)) {
        if (e.kind === 'loop' || (b.id === 'ashcombe:mews' && e.id === 'MW')) continue;
        const dmin = Math.min(...corners.map((q) => e.poly.nearest(q.x, q.z).d)) - e.width / 2;
        if (dmin < 1.2) { out.push(`building ${b.id} ${dmin.toFixed(1)} m from road ${e.id} edge`); break; }
      }
      if (b.town !== 'river') {
        const rmin = Math.min(...corners.map((q) => { const n = rpoly.nearest(q.x, q.z); return n.d - hwAt(n.s); }));
        if (rmin < 6) out.push(`building ${b.id} only ${rmin.toFixed(1)} m from the water`);
      }
      if (corners.some((q) => inStation(q.x, q.z, 3))) out.push(`building ${b.id} overlaps the station area`);
      for (const o of buildings) {
        if (o === b) continue;
        if (corners.some((q) => { const [lx, lz] = worldToLocal(o.center, o.yaw, q.x, q.z); return Math.abs(lx) < o.size.x / 2 + 0.8 && Math.abs(lz) < o.size.z / 2 + 0.8; })) { out.push(`building ${b.id} overlaps ${o.id}`); break; }
      }
    }
    // fields clear of roads/tracks/river/buildings
    for (const f of fields) {
      for (let k = 0; k < 60; k++) {
        const x = f.center.x + (k % 8 - 3.5) * 6, z = f.center.z + (Math.floor(k / 8) - 3.5) * 5;
        if (!pointInPoly(x, z, f.poly)) continue;
        if (trackDistExact(x, z) < 12) { out.push(`field ${f.id} on/near track`); break; }
        const nr = nearestRoad(P(x, z));
        if (nr.d < edges[nr.edge].width / 2 + 3) { out.push(`field ${f.id} on road ${nr.edge}`); break; }
        const n = rpoly.nearest(x, z);
        if (n.d < hwAt(n.s) + 7) { out.push(`field ${f.id} on the river bank`); break; }
        if (buildingAt(x, z, 3)) { out.push(`field ${f.id} over building ${buildingAt(x, z, 3)!.id}`); break; }
      }
    }
    // portals outside the ground
    for (const p of portals) if (p.kind !== 'rail' && Math.max(Math.abs(p.pos.x), Math.abs(p.pos.z)) < GROUND_HALF + 20) out.push(`portal ${p.id} inside the ground edge`);
    // walk graph: connected; entrance reaches every door and every portal
    {
      const start = walk.nearest(I.entrance);
      const seen = new Uint8Array(walk.nodes.length); const st2 = [start]; seen[start] = 1;
      while (st2.length) { const c = st2.pop()!; for (const nb of walk.adj[c]) if (!seen[nb]) { seen[nb] = 1; st2.push(nb); } }
      let unreach = 0;
      for (let i = 0; i < walk.nodes.length; i++) if (!seen[i]) unreach++;
      if (unreach) {
        const ex: string[] = [];
        for (let i = 0; i < walk.nodes.length && ex.length < 6; i++) if (!seen[i]) ex.push(`${walk.kind[i]}(${walk.nodes[i].x.toFixed(0)},${walk.nodes[i].z.toFixed(0)})`);
        out.push(`walk graph: ${unreach} nodes unreachable from the entrance, e.g. ${ex.join(' ')}`);
      }
      // walk edges never cross tracks except LC1, the staff barrow crossing and the footbridge deck
      const lcC = crossings[0]?.center;
      for (let i = 0; i < walk.nodes.length; i++) for (const j of walk.adj[i]) {
        if (j < i) continue;
        const a = walk.nodes[i], b = walk.nodes[j];
        if (a.y > 3 || b.y > 3) continue; // footbridge / signal box stairs
        for (let k = 0; k <= 8; k++) {
          const q = a.clone().lerp(b, k / 8);
          if (lcC && Math.abs(q.x - lcC.x) < 5 && Math.abs(q.z - lcC.z) < 8) continue;
          if (Math.abs(q.x + 30) < 2 && Math.abs(q.z - 24) < 5) continue;
          if (q.y < -1.5) continue; // towpath / Wyke Lane cutting under bridges
          if (trackDistExact(q.x, q.z) < 1.6) { out.push(`walk edge crosses a track at (${q.x.toFixed(1)},${q.z.toFixed(1)}) [${walk.kind[i]}-${walk.kind[j]}]`); break; }
        }
      }
    }
    // road graph connected: entrance reaches every portal and the mews
    for (const id of ['E1', 'E2', 'S1', 'W1', 'N1', 'NW1', 'mews']) if (!roadPath('entrance', id)) out.push(`no road route entrance → ${id}`);
    return out;
  };

  return {
    terrain, river, roads: { nodes, edges }, paths, bridges, crossings, towns, buildings, fields, portals, tunnels, origins, forecourtTraffic,
    mews: mews0!,
    landmarks: { windmill, platelayersHut: hut, signalBoxDoor: sbDoor },
    shedRoad: { curve: shedRoadCurve, length: shedRoadLen, portalX: -268, z: SHED_Z, tAtX: (x) => clamp((x - shedRoadX0) / shedRoadLen, 0, 1) },
    walk,
    roadPath,
    footPath: (a, b, o) => walk.path(a, b, o),
    riverPointAt: (t, lateral = 0, out) => rpoly.offset(clamp(t, 0, 1) * rpoly.length, lateral, undefined, out),
    nearestOrigin, nearestRoad, streetLamps,
    validate,
  };
}

// ───────────────────────── walk graph ─────────────────────────

function buildWalkGraph(I: CountrysideInput, edges: Record<string, RoadEdge>, paths: Countryside['paths'], buildings: Building[], portals: Portal[], crossings: LevelCrossing[]): WalkGraph {
  const nodes: THREE.Vector3[] = [];
  const kind: string[] = [];
  const staff: boolean[] = [];
  const adj: number[][] = [];
  const add = (p: THREE.Vector3, k: string, isStaff = false) => { nodes.push(p.clone()); kind.push(k); staff.push(isStaff); adj.push([]); return nodes.length - 1; };
  const link = (a: number, b: number) => { if (a === b || adj[a].includes(b)) return; adj[a].push(b); adj[b].push(a); };
  // station nav
  const navIdx = new Map<string, number>();
  const staffSet = new Set(I.nav.staffNodes);
  for (const [id, p] of Object.entries(I.nav.nodes)) navIdx.set(id, add(p, 'station', staffSet.has(id)));
  for (const [a, b] of I.nav.edges) link(navIdx.get(a)!, navIdx.get(b)!);
  // footways along roads
  const footStart = nodes.length;
  const lineIdx: { edge: string; idx: number[] }[] = [];
  for (const e of Object.values(edges)) {
    if (e.kind === 'loop') continue;
    const lat = e.footSide * (e.width / 2 + 0.6);
    const n = Math.max(1, Math.ceil(e.poly.length / 7));
    const idx: number[] = [];
    for (let k = 0; k <= n; k++) {
      const s = (e.poly.length * k) / n;
      const p = e.poly.offset(s, lat);
      // footway follows the road surface height (humpback deck, cutting)
      p.y = e.poly.yAt(s);
      idx.push(add(p, 'foot'));
      if (k > 0) link(idx[k - 1], idx[k]);
    }
    lineIdx.push({ edge: e.id, idx });
  }
  // paths
  for (const pth of paths) {
    const n = Math.max(1, Math.ceil(pth.poly.length / 7));
    let prev = -1;
    const idx: number[] = [];
    for (let k = 0; k <= n; k++) {
      const p = pth.poly.at((pth.poly.length * k) / n);
      const i = add(p, 'path');
      idx.push(i);
      if (prev >= 0) link(prev, i);
      prev = i;
    }
    lineIdx.push({ edge: pth.id, idx });
  }
  const footEnd = nodes.length;
  // connect footway/path END nodes to the nearest node of another line within 14 m (junctions), and the entrance
  const nearestIn = (p: THREE.Vector3, lo: number, hi: number, exclude: Set<number>, maxD: number) => {
    let best = -1, bd = maxD * maxD;
    for (let i = lo; i < hi; i++) {
      if (exclude.has(i)) continue;
      const d = (nodes[i].x - p.x) ** 2 + (nodes[i].z - p.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  // each line END links to the nearest node of EVERY other line within reach (junctions, path ends)
  for (const L of lineIdx) {
    const isPath = !edges[L.edge];
    for (const end of [L.idx[0], L.idx[L.idx.length - 1]]) {
      for (const L2 of lineIdx) {
        if (L2 === L) continue;
        let best = -1, bd = (isPath || !edges[L2.edge] ? 13 : 16) ** 2;
        for (const i of L2.idx) {
          const d = (nodes[i].x - nodes[end].x) ** 2 + (nodes[i].z - nodes[end].z) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
        if (best >= 0) link(end, best);
      }
    }
  }
  // K footway start ↔ station entrance
  const ent = navIdx.get('entrance')!;
  const kLine = lineIdx.find((l) => l.edge === 'K')!;
  link(ent, kLine.idx[0]);
  link(ent, kLine.idx[1]);
  // level crossing: M footway passes over the track (already continuous) — nothing to add
  void crossings;
  // doors
  for (const b of buildings) for (const d of b.doors) {
    const i = add(d, 'door');
    const j = nearestIn(d, footStart, footEnd, new Set(), 45);
    if (j >= 0) link(i, j);
    else { const k = nearestIn(d, 0, nodes.length - 1, new Set([i]), 400); if (k >= 0) link(i, k); }
  }
  // portals (walkers)
  for (const p of portals) {
    if (p.kind !== 'road' && p.kind !== 'path') continue;
    const i = add(p.pos.clone().setY(2), 'portal');
    const j = nearestIn(p.pos, footStart, footEnd, new Set(), 40);
    if (j >= 0) link(i, j);
  }
  const N = nodes.length;
  const nearest = (p: THREE.Vector3, o?: { staff?: boolean }) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < N; i++) {
      if (staff[i] && !o?.staff) continue;
      const d = (nodes[i].x - p.x) ** 2 + (nodes[i].z - p.z) ** 2 + 4 * (nodes[i].y - p.y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const dij = (s: number, g: number, o?: { staff?: boolean }) => {
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    dist[s] = 0;
    const h = new MinHeap<number>();
    h.push(0, s);
    while (h.size) {
      const [d, c] = h.pop()!;
      if (d > dist[c]) continue;
      if (c === g) break;
      for (const nb of adj[c]) {
        if (staff[nb] && !o?.staff && nb !== g) continue;
        const nd = d + nodes[c].distanceTo(nodes[nb]);
        if (nd < dist[nb]) { dist[nb] = nd; prev[nb] = c; h.push(nd, nb); }
      }
    }
    return { dist, prev };
  };
  return {
    nodes, kind, staff, adj, nearest,
    path(from, to, o) {
      const s = nearest(from, o), g = nearest(to, o);
      const { prev } = dij(s, g, o);
      const ids: number[] = [];
      if (s === g || prev[g] >= 0) for (let c = g; c >= 0; c = prev[c]) { ids.unshift(c); if (c === s) break; }
      const out = [from.clone(), ...ids.map((i) => nodes[i].clone()), to.clone()];
      return out.filter((p, i) => i === 0 || p.distanceToSquared(out[i - 1]) > 1e-6);
    },
    length(from, to, o) {
      const s = nearest(from, o), g = nearest(to, o);
      const { dist } = dij(s, g, o);
      return dist[g] + from.distanceTo(nodes[s]) + to.distanceTo(nodes[g]);
    },
  };
}

// ───────────────────────── helpers ─────────────────────────

function sample(c: THREE.Curve<THREE.Vector3>, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) out.push(c.getPointAt(i / n));
  return out;
}

function movingAvg(a: number[], r: number): number[] {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(a.length - 1, i + r); k++) { s += a[k]; n++; }
    out[i] = s / n;
  }
  return out;
}

class MinHeap<T> {
  private k: number[] = [];
  private v: T[] = [];
  get size() { return this.k.length; }
  push(key: number, val: T) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop(): [number, T] | undefined {
    const k = this.k, v = this.v;
    if (!k.length) return undefined;
    const top: [number, T] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

/** 2 m grid over ±440 holding height and distance fields. */
class Grid {
  readonly n = GN;
  readonly h = new Float32Array(GN * GN);
  readonly track = new Float32Array(GN * GN).fill(60);
  readonly feature = new Float32Array(GN * GN);
  readonly road = new Float32Array(GN * GN).fill(60);
  readonly roadY = new Float32Array(GN * GN);
  readonly roadW = new Float32Array(GN * GN);
  readonly riverD = new Float32Array(GN * GN).fill(1e3);
  readonly riverS = new Float32Array(GN * GN);
  idx(x: number, z: number): number {
    const i = Math.round((x + GRID_HALF) / CELL), j = Math.round((z + GRID_HALF) / CELL);
    if (i < 0 || j < 0 || i >= GN || j >= GN) return -1;
    return j * GN + i;
  }
  forEach(f: (i: number, x: number, z: number) => void) {
    for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) f(j * GN + i, -GRID_HALF + i * CELL, -GRID_HALF + j * CELL);
  }
  forEachNear(x: number, z: number, r: number, f: (i: number, x: number, z: number) => void) {
    const i0 = Math.max(0, Math.floor((x - r + GRID_HALF) / CELL)), i1 = Math.min(GN - 1, Math.ceil((x + r + GRID_HALF) / CELL));
    const j0 = Math.max(0, Math.floor((z - r + GRID_HALF) / CELL)), j1 = Math.min(GN - 1, Math.ceil((z + r + GRID_HALF) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * GN + i, -GRID_HALF + i * CELL, -GRID_HALF + j * CELL);
  }
  sample(a: Float32Array, x: number, z: number): number {
    const fx = clamp((x + GRID_HALF) / CELL, 0, GN - 1.0001), fz = clamp((z + GRID_HALF) / CELL, 0, GN - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const k = j * GN + i;
    return (a[k] * (1 - u) + a[k + 1] * u) * (1 - v) + (a[k + GN] * (1 - u) + a[k + GN + 1] * u) * v;
  }
  private segCells(ax: number, az: number, bx: number, bz: number, r: number, f: (i: number, x: number, z: number) => void) {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r + GRID_HALF) / CELL)), i1 = Math.min(GN - 1, Math.ceil((Math.max(ax, bx) + r + GRID_HALF) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r + GRID_HALF) / CELL)), j1 = Math.min(GN - 1, Math.ceil((Math.max(az, bz) + r + GRID_HALF) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * GN + i, -GRID_HALF + i * CELL, -GRID_HALF + j * CELL);
  }
  stampDist(dst: Float32Array, polys: THREE.Vector3[][], r: number) {
    for (const pts of polys) for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const abx = b.x - a.x, abz = b.z - a.z, l2 = abx * abx + abz * abz || 1e-9;
      this.segCells(a.x, a.z, b.x, b.z, r, (i, x, z) => {
        const u = clamp(((x - a.x) * abx + (z - a.z) * abz) / l2, 0, 1);
        const d = Math.hypot(x - a.x - abx * u, z - a.z - abz * u);
        if (d < dst[i]) dst[i] = d;
      });
    }
  }
  stampRoad(poly: Poly, width: number) {
    const R = width / 2 + 6;
    const pts = poly.pts;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const abx = b.x - a.x, abz = b.z - a.z, l2 = abx * abx + abz * abz || 1e-9;
      this.segCells(a.x, a.z, b.x, b.z, R, (i, x, z) => {
        const u = clamp(((x - a.x) * abx + (z - a.z) * abz) / l2, 0, 1);
        const d = Math.hypot(x - a.x - abx * u, z - a.z - abz * u);
        const edgeD = d - width / 2;
        if (edgeD < this.road[i]) this.road[i] = edgeD;
        const w = 1 - smooth(d, width / 2 + 0.4, R);
        if (w > this.roadW[i] + 1e-4 || (Math.abs(w - this.roadW[i]) <= 1e-4 && w > 0)) {
          this.roadW[i] = w;
          this.roadY[i] = a.y + (b.y - a.y) * u - 0.04;
        }
      });
    }
  }
  stampPad(c: THREE.Vector3, sx: number, sz: number, yaw: number, y: number, blend: number) {
    const r = Math.hypot(sx, sz) / 2 + blend;
    this.forEachNear(c.x, c.z, r, (i, x, z) => {
      const [lx, lz] = worldToLocal(c, yaw, x, z);
      const dx = Math.max(0, Math.abs(lx) - sx / 2), dz = Math.max(0, Math.abs(lz) - sz / 2);
      const d = Math.hypot(dx, dz);
      if (d >= blend) return;
      const w = 1 - smooth(d, 0, blend);
      if (this.roadW[i] > 0.6) return; // never lift a road
      this.h[i] = THREE.MathUtils.lerp(this.h[i], y, w);
    });
  }
  stampRiver(poly: Poly) {
    const pts = poly.pts, R = 60;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const abx = b.x - a.x, abz = b.z - a.z, l2 = abx * abx + abz * abz || 1e-9, inv = 1 / Math.sqrt(l2);
      this.segCells(a.x, a.z, b.x, b.z, R, (i, x, z) => {
        const u = clamp(((x - a.x) * abx + (z - a.z) * abz) / l2, 0, 1);
        const qx = a.x + abx * u, qz = a.z + abz * u;
        const d = Math.hypot(x - qx, z - qz);
        if (d < Math.abs(this.riverD[i])) {
          const side = (-abz * inv) * (x - qx) + (abx * inv) * (z - qz);
          this.riverD[i] = side >= 0 ? d : -d;
          this.riverS[i] = poly.cum[k] + u * Math.sqrt(l2);
        }
      });
    }
  }
}
