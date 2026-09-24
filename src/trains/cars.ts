import * as THREE from 'three';
import type { CarType } from '../core/apis';
import * as P from '../core/palette';
import { GB, shade, mix, type Bucket } from './geom';

/**
 * Car catalogue. Local frame of every car: length along +x (front = +x = towards the head of the
 * train when not flipped), y = 0 at rail top, z = across the track. Everything stays within
 * |z| <= 1.56 (the platform coping is 1.7 m from the track centreline).
 */

export interface Livery { body: number; lining: number; frame: number }
export type LiveryId = 'coast' | 'highland' | 'freight' | 'royal' | 'circus' | 'teak';

/** Coast = crimson lake, Highland = bottle green (per design brief). */
export const LIVERY: Record<LiveryId, Livery> = {
  coast: { body: 0x7a2230, lining: P.BRASS, frame: P.IRON },
  highland: { body: P.BOTTLE_GREEN, lining: P.BRASS, frame: P.IRON },
  freight: { body: 0x2e2c2a, lining: 0x8a7a68, frame: P.IRON },
  royal: { body: 0x3a2a5a, lining: 0xd9b95a, frame: 0x1a1a22 },
  circus: { body: 0xa8402f, lining: 0xe0b84a, frame: 0x2a2a2a },
  teak: { body: 0x8a5a30, lining: 0xd9b070, frame: P.IRON },
};

export interface AxleSpec { x: number; r: number; kind: 'small' | 'driver' }
export interface RodSpec { x0: number; x1: number; y: number; r: number; z: number }

export interface CarSpec {
  type: CarType;
  /** over buffers, metres */
  len: number;
  capacity: number;
  /** local x of passenger doors (people board here) */
  doors: number[];
  axles: AxleSpec[];
  loco?: 'express' | 'tank';
  /** chimney top (local) — smoke origin */
  chimney?: THREE.Vector3;
  /** cylinder drain cocks (local) — steam hiss origin */
  cocks?: THREE.Vector3;
  /** coupling rods (drivers) */
  rods?: RodSpec;
  /** nameplate centre on the +z side (mirrored to -z) */
  plate?: { x: number; y: number; z: number; w: number };
  /** head lamp (local), for the spot light */
  lamp?: THREE.Vector3;
  /** tail lamp spot on the rear end */
  tail: THREE.Vector3;
}

const W = 1.35; // coach body half width
const ROOF = 0x77736c;
const ROOF_DARK = 0x4c4a47;
const SOOT = P.SOOT;
const BEAM = 0x9a3226;
const STEEL = 0x6f7276;
const COAL = 0x1b1a19;
const CREAM = P.CREAM;
const BRASS = P.BRASS;

export const SPECS: Record<CarType, CarSpec> = {
  loco_express: {
    type: 'loco_express', len: 11, capacity: 0, doors: [],
    axles: [
      { x: 4.1, r: 0.5, kind: 'small' }, { x: 2.6, r: 0.5, kind: 'small' },
      { x: -0.4, r: 1.0, kind: 'driver' }, { x: -3.0, r: 1.0, kind: 'driver' },
    ],
    loco: 'express', chimney: new THREE.Vector3(4.35, 4.35, 0), cocks: new THREE.Vector3(3.2, 0.7, 0),
    rods: { x0: -3.0, x1: -0.4, y: 1.0, r: 0.3, z: 0.93 },
    plate: { x: -0.4, y: 1.62, z: 1.035, w: 1.55 },
    lamp: new THREE.Vector3(5.45, 1.62, 0), tail: new THREE.Vector3(-5.45, 1.8, 0.6),
  },
  loco_tank: {
    type: 'loco_tank', len: 9, capacity: 0, doors: [],
    axles: [{ x: 2.2, r: 0.7, kind: 'driver' }, { x: 0.2, r: 0.7, kind: 'driver' }, { x: -1.8, r: 0.7, kind: 'driver' }],
    loco: 'tank', chimney: new THREE.Vector3(3.45, 3.7, 0), cocks: new THREE.Vector3(3.0, 0.6, 0),
    rods: { x0: -1.8, x1: 2.2, y: 0.7, r: 0.22, z: 0.9 },
    plate: { x: 0.75, y: 1.95, z: 1.285, w: 1.6 },
    lamp: new THREE.Vector3(4.45, 1.5, 0), tail: new THREE.Vector3(-4.45, 1.6, 0.6),
  },
  tender: {
    type: 'tender', len: 7, capacity: 0, doors: [],
    axles: [{ x: 2.1, r: 0.55, kind: 'small' }, { x: 0, r: 0.55, kind: 'small' }, { x: -2.1, r: 0.55, kind: 'small' }],
    tail: new THREE.Vector3(-3.45, 1.6, 0.6),
  },
  coach_first: { type: 'coach_first', len: 13, capacity: 24, doors: [-3.8, 3.8], axles: bogies(4.6, 0.9), tail: new THREE.Vector3(-6.45, 2.2, 0.7) },
  coach_second: { type: 'coach_second', len: 13, capacity: 36, doors: [-3.8, 3.8], axles: bogies(4.6, 0.9), tail: new THREE.Vector3(-6.45, 2.2, 0.7) },
  coach_third: { type: 'coach_third', len: 13, capacity: 48, doors: [-4.2, 0, 4.2], axles: bogies(4.6, 0.9), tail: new THREE.Vector3(-6.45, 2.2, 0.7) },
  dining: { type: 'dining', len: 14, capacity: 16, doors: [-5.4], axles: bogies(5.0, 0.9), tail: new THREE.Vector3(-6.95, 2.2, 0.7) },
  mail: { type: 'mail', len: 12, capacity: 0, doors: [], axles: bogies(4.2, 0.9), tail: new THREE.Vector3(-5.95, 2.2, 0.7) },
  guard: { type: 'guard', len: 8, capacity: 0, doors: [], axles: [{ x: 2.4, r: 0.45, kind: 'small' }, { x: -2.4, r: 0.45, kind: 'small' }], tail: new THREE.Vector3(-3.95, 2.3, 0.75) },
  wagon_coal: { type: 'wagon_coal', len: 7, capacity: 0, doors: [], axles: [{ x: 1.9, r: 0.45, kind: 'small' }, { x: -1.9, r: 0.45, kind: 'small' }], tail: new THREE.Vector3(-3.45, 1.6, 0.8) },
  wagon_box: { type: 'wagon_box', len: 7, capacity: 0, doors: [], axles: [{ x: 1.9, r: 0.45, kind: 'small' }, { x: -1.9, r: 0.45, kind: 'small' }], tail: new THREE.Vector3(-3.45, 1.8, 0.8) },
  wagon_tank: { type: 'wagon_tank', len: 7, capacity: 0, doors: [], axles: [{ x: 1.9, r: 0.45, kind: 'small' }, { x: -1.9, r: 0.45, kind: 'small' }], tail: new THREE.Vector3(-3.45, 1.4, 0.8) },
  wagon_flat: { type: 'wagon_flat', len: 8, capacity: 0, doors: [], axles: [{ x: 2.4, r: 0.45, kind: 'small' }, { x: -2.4, r: 0.45, kind: 'small' }], tail: new THREE.Vector3(-3.95, 1.4, 0.8) },
  circus_cage: { type: 'circus_cage', len: 10, capacity: 0, doors: [], axles: [{ x: 3.2, r: 0.45, kind: 'small' }, { x: -3.2, r: 0.45, kind: 'small' }], tail: new THREE.Vector3(-4.95, 1.6, 0.8) },
  royal_saloon: { type: 'royal_saloon', len: 14, capacity: 10, doors: [-4.6, 4.6], axles: bogies(5.0, 0.9), tail: new THREE.Vector3(-6.95, 2.2, 0.7) },
};

function bogies(c: number, h: number): AxleSpec[] {
  return [c + h, c - h, -c + h, -c - h].map((x) => ({ x, r: 0.45, kind: 'small' as const }));
}

export const PASSENGER_TYPES: CarType[] = ['coach_first', 'coach_second', 'coach_third', 'dining', 'royal_saloon'];

// ───────────────────────── shared bits ─────────────────────────

function buffers(g: GB, xEnd: number, dir: 1 | -1, y = 1.05, beam = true, beamColor = BEAM) {
  if (beam) g.bx('paint', beamColor, xEnd - dir * 0.35, xEnd - dir * 0.15, y - 0.28, y + 0.28, -1.3, 1.3);
  for (const z of [-0.85, 0.85]) {
    g.cx('paint', STEEL, 0.08, 0.3, xEnd - dir * 0.0, y, z, 6);
    g.cx('paint', 0x3a3a3a, 0.19, 0.06, xEnd + dir * 0.12, y, z, 8);
  }
  g.box('paint', 0x2a2a2a, 0.3, 0.1, 0.1, xEnd, y, 0);
}

/** bogie frames + axle boxes (wheels themselves are instanced separately) */
function bogieFrames(g: GB, axles: AxleSpec[], frame: number) {
  for (let i = 0; i + 1 < axles.length; i += 2) {
    const a = axles[i].x, b = axles[i + 1].x;
    const c = (a + b) / 2, hl = Math.abs(a - b) / 2 + 0.6;
    g.bx2('paint', frame, c - hl, c + hl, 0.35, 0.72, 0.83, 0.95);
    g.bx('paint', frame, c - 0.25, c + 0.25, 0.55, 0.85, -0.9, 0.9);
    for (const x of [a, b]) g.bx2('paint', 0x3b3b3b, x - 0.18, x + 0.18, 0.3, 0.62, 0.95, 1.02);
  }
}
function fourWheelFrames(g: GB, axles: AxleSpec[], frame: number) {
  for (const a of axles) {
    g.bx2('paint', frame, a.x - 0.7, a.x + 0.7, 0.4, 0.9, 0.9, 0.98);  // W-irons / axle guards
    g.bx2('paint', 0x3b3b3b, a.x - 0.18, a.x + 0.18, 0.3, 0.62, 0.95, 1.02);
  }
}
/** window pane on both sides at local x */
function win2(g: GB, x: number, y0: number, y1: number, w: number, zOut = W, b: Bucket = 'window') {
  g.bx2(b, 0x3a3226, x - w / 2, x + w / 2, y0, y1, zOut - 0.01, zOut + 0.025);
}

// ───────────────────────── locomotives ─────────────────────────

function locoExpress(g: GB, L: Livery) {
  const body = L.body, frame = L.frame;
  // frames, running plate, valance
  g.bx('paint', frame, -5.2, 5.2, 0.55, 1.25, -0.55, 0.55);
  g.bx('paint', SOOT, -5.35, 5.2, 1.25, 1.35, -1.32, 1.32);
  g.bx2('paint', body, -4.9, 5.0, 1.07, 1.25, 1.24, 1.3);
  g.bx2('brass', BRASS, -4.9, 5.0, 1.24, 1.27, 1.29, 1.31);
  buffers(g, 5.35, 1, 1.05);
  g.bx('paint', frame, -5.5, -5.3, 0.8, 1.3, -1.25, 1.25);
  // smokebox + door
  g.cx('paint', SOOT, 0.8, 1.15, 4.35, 2.65, 0, 14);
  g.cx('paint', 0x232325, 0.7, 0.1, 4.95, 2.65, 0, 14);
  g.cx('brass', BRASS, 0.08, 0.12, 5.02, 2.65, 0, 8);
  g.bx('paint', SOOT, 3.8, 4.95, 1.35, 2.3, -0.72, 0.72); // smokebox saddle
  // boiler with brass bands
  g.cx('paint', body, 0.72, 4.3, 1.6, 2.65, 0, 14);
  for (const x of [-0.5, 0.9, 2.3, 3.7]) g.cx('brass', BRASS, 0.745, 0.07, x, 2.65, 0, 14);
  g.bx2('brass', BRASS, -0.4, 4.0, 2.98, 3.02, 0.7, 0.74); // handrails
  // round-top firebox
  g.cx('paint', body, 0.8, 1.8, -1.5, 2.65, 0, 14);
  g.bx('paint', body, -2.4, -0.6, 1.35, 2.65, -0.8, 0.8);
  g.cx('brass', BRASS, 0.82, 0.07, -0.62, 2.65, 0, 14);
  // chimney: flared base, tall barrel, copper-brass cap
  g.cy('paint', SOOT, 0.3, 0.44, 0.22, 4.35, 3.46, 0, 12);
  g.cy('paint', SOOT, 0.3, 0.26, 0.85, 4.35, 3.95, 0, 12);
  g.cy('brass', 0xc08a4a, 0.37, 0.3, 0.18, 4.35, 4.44, 0, 12);
  // dome, safety valve, whistle
  g.cy('brass', BRASS, 0.36, 0.4, 0.42, 1.4, 3.5, 0, 12);
  g.add('brass', BRASS, new THREE.SphereGeometry(0.36, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2), 1.4, 3.7, 0);
  g.cy('brass', BRASS, 0.12, 0.16, 0.4, -1.5, 3.6, 0, 8);
  g.cy('brass', BRASS, 0.05, 0.05, 0.35, -2.25, 3.65, 0, 6);
  // cab
  g.bx2('paint', body, -5.2, -2.4, 1.35, 2.6, 1.17, 1.27);
  g.bx2('brass', BRASS, -5.2, -2.4, 2.58, 2.63, 1.25, 1.29);
  g.bx2('paint', body, -2.6, -2.4, 2.6, 3.75, 1.12, 1.27);
  g.bx2('paint', body, -5.2, -5.0, 2.6, 3.75, 1.12, 1.27);
  g.bx('paint', body, -2.5, -2.4, 1.35, 3.75, -1.27, 1.27);
  g.bx('window', 0x3a3226, -2.39, -2.33, 3.0, 3.4, 0.35, 0.8);
  g.bx('window', 0x3a3226, -2.39, -2.33, 3.0, 3.4, -0.8, -0.35);
  g.roof('paint', ROOF_DARK, 3.2, 1.36, 3.72, 0.2, -3.8, 10);
  g.bx('fire', 0x3a1a0a, -2.62, -2.52, 1.6, 2.1, -0.35, 0.35); // fire door glow
  // splashers over the drivers
  for (const x of [-0.4]) {
    g.hcz('paint', body, 1.1, 0.34, x, 1.0, 0.86, 16);
    g.hcz('paint', body, 1.1, 0.34, x, 1.0, -0.86, 16);
    g.add('brass', BRASS, new THREE.TorusGeometry(1.1, 0.045, 4, 16, Math.PI), x, 1.0, 1.03);
    g.add('brass', BRASS, new THREE.TorusGeometry(1.1, 0.045, 4, 16, Math.PI), x, 1.0, -1.03);
  }
  // sandboxes and front lamps (Victorian head code)
  g.bx2('paint', body, 1.6, 2.2, 1.35, 1.75, 0.9, 1.15);
  g.box('lamp', 0xf4ecd8, 0.22, 0.26, 0.22, 5.28, 1.62, 0.85);
  g.box('lamp', 0xf4ecd8, 0.22, 0.26, 0.22, 5.28, 1.62, -0.85);
  g.box('paint', SOOT, 0.26, 0.08, 0.26, 5.28, 1.78, 0.85);
  g.box('paint', SOOT, 0.26, 0.08, 0.26, 5.28, 1.78, -0.85);
}

function locoTank(g: GB, L: Livery) {
  const body = L.body, frame = L.frame;
  g.bx('paint', frame, -4.2, 4.2, 0.4, 1.1, -0.55, 0.55);
  g.bx('paint', SOOT, -4.4, 4.4, 1.1, 1.2, -1.3, 1.3);
  g.bx2('paint', body, -4.1, 4.1, 0.92, 1.1, 1.22, 1.28);
  buffers(g, 4.35, 1, 0.95);
  buffers(g, -4.35, -1, 0.95);
  // boiler, smokebox
  g.cx('paint', body, 0.66, 4.3, 0.85, 2.15, 0, 14);
  g.cx('paint', SOOT, 0.7, 0.9, 3.45, 2.15, 0, 14);
  g.cx('paint', 0x232325, 0.62, 0.08, 3.92, 2.15, 0, 14);
  g.bx('paint', SOOT, 3.0, 3.9, 1.2, 1.9, -0.6, 0.6);
  for (const x of [-1.0, 2.9]) g.cx('brass', BRASS, 0.685, 0.07, x, 2.15, 0, 14);
  // side tanks with brass beading
  g.bx2('paint', body, -1.3, 2.8, 1.2, 2.55, 0.62, 1.27);
  g.bx2('brass', BRASS, -1.3, 2.8, 2.52, 2.57, 1.25, 1.29);
  g.bx2('paint', shade(body, 0.8), -1.3, 2.8, 2.55, 2.6, 0.62, 1.27);
  // chimney + cap, dome, safety valves
  g.cy('paint', SOOT, 0.26, 0.38, 0.2, 3.45, 2.85, 0, 12);
  g.cy('paint', SOOT, 0.26, 0.23, 0.62, 3.45, 3.25, 0, 12);
  g.cy('brass', 0xc08a4a, 0.32, 0.26, 0.15, 3.45, 3.62, 0, 12);
  g.cy('brass', BRASS, 0.32, 0.35, 0.36, 1.2, 2.95, 0, 12);
  g.add('brass', BRASS, new THREE.SphereGeometry(0.32, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2), 1.2, 3.12, 0);
  g.cy('brass', BRASS, 0.1, 0.13, 0.32, -0.9, 3.0, 0, 8);
  // cab + bunker
  g.bx2('paint', body, -3.8, -1.3, 1.2, 2.45, 1.15, 1.27);
  g.bx2('brass', BRASS, -3.8, -1.3, 2.43, 2.48, 1.25, 1.29);
  g.bx2('paint', body, -1.5, -1.3, 2.45, 3.45, 1.1, 1.27);
  g.bx2('paint', body, -3.8, -3.6, 2.45, 3.45, 1.1, 1.27);
  g.bx('paint', body, -1.4, -1.3, 1.2, 3.45, -1.27, 1.27);
  g.bx('paint', body, -3.8, -3.7, 1.2, 3.45, -1.27, 1.27);
  g.bx('window', 0x3a3226, -1.29, -1.24, 2.8, 3.15, 0.35, 0.8);
  g.bx('window', 0x3a3226, -1.29, -1.24, 2.8, 3.15, -0.8, -0.35);
  g.roof('paint', ROOF_DARK, 2.9, 1.34, 3.42, 0.18, -2.55, 10);
  g.bx('paint', body, -4.35, -3.8, 1.2, 2.3, -1.2, 1.2);
  g.heap('paint', COAL, 0.3, 0.25, 0.9, -4.05, 2.3, 0, 3);
  g.bx('fire', 0x3a1a0a, -1.52, -1.42, 1.4, 1.85, -0.3, 0.3);
  g.box('lamp', 0xf4ecd8, 0.22, 0.26, 0.22, 4.25, 1.5, 0);
  g.box('paint', SOOT, 0.26, 0.08, 0.26, 4.25, 1.66, 0);
}

function tender(g: GB, L: Livery) {
  const body = L.body;
  g.bx('paint', L.frame, -3.3, 3.3, 0.45, 1.0, -0.6, 0.6);
  g.bx2('paint', L.frame, -3.0, 3.0, 0.4, 0.95, 0.9, 1.0);
  for (const x of [-2.1, 0, 2.1]) g.bx2('paint', 0x3b3b3b, x - 0.18, x + 0.18, 0.35, 0.72, 1.0, 1.06);
  g.bx('paint', SOOT, -3.3, 3.35, 1.0, 1.1, -1.3, 1.3);
  g.bx('paint', body, -3.2, 3.2, 1.1, 2.4, -1.25, 1.25);
  g.bx('paint', shade(body, 0.85), -3.25, 3.25, 2.4, 2.55, -1.3, 1.3);
  // lining panel
  g.bx2('brass', BRASS, -3.0, 3.0, 1.25, 1.29, 1.25, 1.27);
  g.bx2('brass', BRASS, -3.0, 3.0, 2.22, 2.26, 1.25, 1.27);
  g.bx2('brass', BRASS, -3.04, -2.96, 1.25, 2.26, 1.25, 1.27);
  g.bx2('brass', BRASS, 2.96, 3.04, 1.25, 2.26, 1.25, 1.27);
  // coal heap + water filler + tool boxes
  g.heap('paint', COAL, 2.0, 0.55, 1.1, 1.0, 2.45, 0, 7);
  g.bx('paint', shade(body, 0.8), -3.2, -1.2, 2.4, 2.5, -1.2, 1.2);
  g.cy('brass', BRASS, 0.28, 0.28, 0.22, -2.3, 2.6, 0, 10);
  buffers(g, -3.35, -1, 1.05);
}

// ───────────────────────── coaches ─────────────────────────

interface CoachOpts { lower: number; upper: number; band: number; roof: number; frame: number }

function coachShell(g: GB, len: number, o: CoachOpts, axles: AxleSpec[], opts: { roofRise?: number; noRoof?: boolean } = {}) {
  const hx = len / 2 - 0.3;
  g.bx('paint', o.frame, -hx + 0.1, hx - 0.1, 0.8, 1.05, -1.1, 1.1);
  g.bx2('paint', 0x3b3029, -hx + 0.4, hx - 0.4, 0.5, 0.58, 1.36, 1.54); // footboards
  g.cx('paint', 0x2a2a2a, 0.24, 2.6, 0, 0.62, 0, 8); // gas cylinder
  g.bx('paint', o.lower, -hx, hx, 1.05, 2.2, -W, W);
  g.bx('paint', o.upper, -hx, hx, 2.2, 3.3, -W, W);
  g.bx2('paint', o.band, -hx, hx, 2.16, 2.24, W, W + 0.015);
  g.bx('paint', shade(o.upper, 0.8), -hx - 0.02, hx + 0.02, 3.3, 3.42, -W - 0.03, W + 0.03);
  if (!opts.noRoof) g.roof('paint', o.roof, len - 0.5, W + 0.08, 3.38, opts.roofRise ?? 0.42, 0, 12);
  bogieFrames(g, axles, o.frame);
  buffers(g, len / 2, 1, 1.05, false);
  buffers(g, -len / 2, -1, 1.05, false);
  // headstocks
  g.bx('paint', o.frame, hx - 0.05, hx + 0.1, 0.8, 1.3, -1.3, 1.3);
  g.bx('paint', o.frame, -hx - 0.1, -hx + 0.05, 0.8, 1.3, -1.3, 1.3);
}

function roofLamps(g: GB, xs: number[], y = 3.82) {
  for (const x of xs) g.cy('paint', 0x55524d, 0.11, 0.14, 0.14, x, y, 0, 6);
}

/** compartment stock: each compartment = door droplight flanked by two quarterlights */
function compartments(g: GB, len: number, n: number, o: CoachOpts, wide: boolean) {
  const hx = len / 2 - 0.3;
  const cw = (2 * hx) / n;
  const groove = shade(o.lower, 0.6);
  for (let i = 0; i < n; i++) {
    const c = -hx + cw * (i + 0.5);
    const dw = wide ? 0.62 : 0.5, qw = wide ? 0.5 : 0.34;
    win2(g, c, 2.4, 3.1, dw);
    win2(g, c - dw / 2 - 0.14 - qw / 2, 2.45, 3.05, qw);
    win2(g, c + dw / 2 + 0.14 + qw / 2, 2.45, 3.05, qw);
    // door grooves + handle
    g.bx2('paint', groove, c - dw / 2 - 0.06, c - dw / 2 - 0.03, 1.12, 3.2, W, W + 0.02);
    g.bx2('paint', groove, c + dw / 2 + 0.03, c + dw / 2 + 0.06, 1.12, 3.2, W, W + 0.02);
    g.bx2('paint', BRASS, c + dw / 2 - 0.12, c + dw / 2 - 0.02, 1.9, 1.95, W, W + 0.04);
    // lower panel beading between compartments
    if (i > 0) g.bx2('paint', groove, c - cw / 2 - 0.02, c - cw / 2 + 0.02, 1.12, 3.25, W, W + 0.018);
  }
  roofLamps(g, Array.from({ length: n }, (_, i) => -hx + cw * (i + 0.5)));
}

function coach(g: GB, L: Livery, cls: 'first' | 'second' | 'third') {
  const len = 13;
  const o: CoachOpts = cls === 'first'
    ? { lower: L.body, upper: CREAM, band: L.lining, roof: ROOF, frame: L.frame }
    : cls === 'second'
      ? { lower: L.body, upper: mix(L.body, CREAM, 0.14), band: CREAM, roof: ROOF, frame: L.frame }
      : { lower: shade(L.body, 0.88), upper: shade(L.body, 0.88), band: shade(L.body, 0.7), roof: ROOF, frame: L.frame };
  coachShell(g, len, o, SPECS.coach_first.axles);
  compartments(g, len, cls === 'first' ? 5 : cls === 'second' ? 6 : 7, o, cls === 'first');
  if (cls === 'first') {
    // gilt class panel mid-coach, lower body
    g.bx2('paint', L.lining, -0.35, 0.35, 1.45, 1.85, W, W + 0.02);
    g.bx2('paint', L.body, -0.28, 0.28, 1.51, 1.79, W + 0.005, W + 0.025);
  }
}

function dining(g: GB, L: Livery) {
  const len = 14, hx = len / 2 - 0.3;
  const T = LIVERY.teak;
  const o: CoachOpts = { lower: T.body, upper: shade(T.body, 1.08), band: T.lining, roof: ROOF, frame: L.frame };
  coachShell(g, len, o, SPECS.dining.axles, { roofRise: 0.3 });
  // big saloon windows + kitchen end with small windows
  for (let i = 0; i < 5; i++) win2(g, -3.6 + i * 2.05, 2.35, 3.1, 1.45);
  win2(g, -5.9, 2.6, 3.0, 0.4); win2(g, -5.2, 2.6, 3.0, 0.4);
  g.bx2('paint', shade(T.body, 0.6), -hx, hx, 1.62, 1.66, W, W + 0.02);
  // clerestory with lights
  g.bx('paint', o.upper, -hx + 1.2, hx - 0.6, 3.55, 3.95, -0.6, 0.6);
  for (let i = 0; i < 9; i++) g.bx2('window', 0x3a3226, -4.6 + i * 1.12, -4.1 + i * 1.12, 3.63, 3.87, 0.59, 0.62);
  g.bx('paint', ROOF, -hx + 1.0, hx - 0.4, 3.95, 4.05, -0.75, 0.75);
  // kitchen chimney
  g.cy('paint', 0x3a3a3a, 0.1, 0.12, 0.45, -5.6, 3.9, 0.4, 6);
  roofLamps(g, [-4.2, -1.6, 1.0, 3.6], 4.08);
}

function mail(g: GB, L: Livery) {
  const len = 12, hx = len / 2 - 0.3;
  const o: CoachOpts = { lower: L.body, upper: L.body, band: L.lining, roof: ROOF, frame: L.frame };
  coachShell(g, len, o, SPECS.mail.axles);
  win2(g, -4.6, 2.5, 3.05, 0.5); win2(g, 4.6, 2.5, 3.05, 0.5);
  // double doors
  for (const c of [-2.6, 2.6]) {
    g.bx2('paint', shade(L.body, 0.6), c - 0.7, c - 0.66, 1.15, 3.2, W, W + 0.02);
    g.bx2('paint', shade(L.body, 0.6), c + 0.66, c + 0.7, 1.15, 3.2, W, W + 0.02);
    g.bx2('paint', shade(L.body, 0.6), c - 0.02, c + 0.02, 1.15, 3.2, W, W + 0.02);
  }
  // royal crest-ish panel: gold roundel with a crown hint
  g.add('brass', BRASS, new THREE.CylinderGeometry(0.42, 0.42, 0.04, 16), 0, 2.3, W + 0.02, Math.PI / 2, 0, 0);
  g.add('brass', BRASS, new THREE.CylinderGeometry(0.42, 0.42, 0.04, 16), 0, 2.3, -W - 0.02, Math.PI / 2, 0, 0);
  g.bx2('paint', 0x6b1a1a, -0.28, 0.28, 2.1, 2.5, W + 0.035, W + 0.05);
  g.bx2('brass', BRASS, -0.2, 0.2, 2.55, 2.72, W + 0.02, W + 0.05);
  g.bx2('paint', L.lining, -hx, hx, 1.35, 1.38, W, W + 0.02);
  roofLamps(g, [-4.6, 4.6]);
}

function guardVan(g: GB, L: Livery, freight: boolean) {
  const body = freight ? 0x5a4a3c : L.body;
  const frame = L.frame;
  g.bx('paint', frame, -3.8, 3.8, 0.75, 1.0, -1.1, 1.1);
  fourWheelFrames(g, SPECS.guard.axles, frame);
  g.bx('paint', body, -3.6, 2.4, 1.0, 3.1, -W, W);
  // verandah end
  g.bx('paint', shade(body, 0.7), 2.4, 3.7, 1.0, 1.08, -W, W);
  g.bx2('paint', 0x2a2a2a, 2.45, 3.65, 1.08, 2.0, W - 0.05, W);
  g.bx('paint', 0x2a2a2a, 3.6, 3.65, 1.08, 2.0, -W, W);
  g.roof('paint', ROOF, 7.3, W + 0.08, 3.08, 0.36, 0.05, 12);
  // duckets (bay windows) — the guard's lookout
  g.bx2('paint', body, -0.7, 0.7, 1.7, 3.0, W, 1.55);
  g.bx2('paint', shade(body, 0.8), -0.75, 0.75, 3.0, 3.08, W, 1.58);
  g.bx2('window', 0x3a3226, -0.72, -0.69, 2.3, 2.8, W + 0.04, 1.5);
  g.bx2('window', 0x3a3226, 0.69, 0.72, 2.3, 2.8, W + 0.04, 1.5);
  win2(g, -2.6, 2.3, 2.85, 0.55); win2(g, 1.6, 2.3, 2.85, 0.55);
  // end windows + planking
  for (let y = 1.4; y < 3.0; y += 0.4) g.bx2('paint', shade(body, 0.75), -3.6, 2.4, y, y + 0.03, W, W + 0.015);
  g.cy('paint', 0x2a2a2a, 0.08, 0.08, 0.5, -3.0, 3.5, 0.5, 6); // stove chimney
  buffers(g, 3.95, 1, 1.0, false);
  buffers(g, -3.95, -1, 1.0, false);
}

// ───────────────────────── wagons ─────────────────────────

const WAGON_COLORS = [0x6b6660, 0x7a4a36, 0x5d5a52, 0x4f4a44];

function wagonBase(g: GB, len: number, axles: AxleSpec[], frame = P.IRON) {
  const hx = len / 2 - 0.3;
  g.bx('paint', frame, -hx, hx, 0.72, 0.98, -1.2, 1.2);
  fourWheelFrames(g, axles, frame);
  buffers(g, len / 2, 1, 1.0, false);
  buffers(g, -len / 2, -1, 1.0, false);
}

function wagonCoal(g: GB, variant: number) {
  const c = WAGON_COLORS[variant % WAGON_COLORS.length];
  wagonBase(g, 7, SPECS.wagon_coal.axles);
  const hx = 3.2;
  g.bx('paint', c, -hx, hx, 0.98, 1.08, -1.25, 1.25);
  g.bx2('paint', c, -hx, hx, 1.08, 2.05, 1.13, 1.25);
  g.bx('paint', c, -hx, -hx + 0.12, 1.08, 2.05, -1.13, 1.13);
  g.bx('paint', c, hx - 0.12, hx, 1.08, 2.05, -1.13, 1.13);
  for (const y of [1.4, 1.72]) g.bx2('paint', shade(c, 0.7), -hx, hx, y, y + 0.03, 1.25, 1.265);
  for (const x of [-hx + 0.05, 0, hx - 0.05]) g.bx2('paint', 0x2a2a2a, x - 0.06, x + 0.06, 1.08, 2.05, 1.25, 1.28);
  g.box('paint', 0x2a2a2a, 0.08, 1.4, 0.03, -1.5, 1.55, 1.27, 0, 0, 0.62);
  g.box('paint', 0x2a2a2a, 0.08, 1.4, 0.03, 1.5, 1.55, 1.27, 0, 0, -0.62);
  g.heap('paint', COAL, 2.9, 0.5, 1.05, 0, 1.85, 0, variant + 11);
}

function wagonBox(g: GB, variant: number) {
  const c = [0x6a4a3a, 0x5a5048, 0x7a6a50, 0x4a4a52][variant % 4];
  wagonBase(g, 7, SPECS.wagon_box.axles);
  const hx = 3.2;
  g.bx('paint', c, -hx, hx, 0.98, 2.85, -1.25, 1.25);
  g.roof('paint', mix(ROOF, 0xffffff, 0.15), 6.6, 1.32, 2.83, 0.32, 0, 10);
  for (let y = 1.25; y < 2.8; y += 0.3) g.bx2('paint', shade(c, 0.78), -hx, hx, y, y + 0.025, 1.25, 1.262);
  // door + diagonal bracing
  g.bx2('paint', shade(c, 0.85), -0.7, 0.7, 1.05, 2.7, 1.25, 1.28);
  g.box('paint', 0x2a2a2a, 0.07, 2.3, 0.03, -2.1, 1.9, 1.29, 0, 0, 0.55);
  g.box('paint', 0x2a2a2a, 0.07, 2.3, 0.03, 2.1, 1.9, 1.29, 0, 0, -0.55);
  g.box('paint', 0x2a2a2a, 0.07, 2.3, 0.03, -2.1, 1.9, -1.29, 0, 0, 0.55);
  g.box('paint', 0x2a2a2a, 0.07, 2.3, 0.03, 2.1, 1.9, -1.29, 0, 0, -0.55);
  g.bx2('paint', CREAM, -2.9, -2.3, 2.3, 2.55, 1.25, 1.27);
}

function wagonTank(g: GB, variant: number) {
  const c = [0x2a2a2c, 0xcfc3a8, 0x4a5a4a, 0x6a2a24][variant % 4];
  wagonBase(g, 7, SPECS.wagon_tank.axles);
  g.bx2('paint', P.IRON, -2.2, -1.9, 0.98, 1.4, 0.4, 1.0);
  g.bx2('paint', P.IRON, 1.9, 2.2, 0.98, 1.4, 0.4, 1.0);
  g.cx('paint', c, 0.95, 6.0, 0, 2.05, 0, 14);
  for (const x of [-3.0, 3.0]) g.cx('paint', shade(c, 0.8), 0.9, 0.06, x, 2.05, 0, 14);
  for (const x of [-1.5, 1.5]) g.cx('paint', 0x222222, 0.97, 0.08, x, 2.05, 0, 14);
  g.cy('paint', shade(c, 0.9), 0.35, 0.4, 0.4, 0, 3.1, 0, 10);
  g.cy('brass', BRASS, 0.18, 0.18, 0.08, 0, 3.34, 0, 10);
  g.bx2('paint', CREAM, -1.0, 1.0, 1.85, 2.15, 0.96, 0.99);
}

function wagonFlat(g: GB, variant: number) {
  wagonBase(g, 8, SPECS.wagon_flat.axles);
  g.bx('paint', P.WOOD, -3.7, 3.7, 0.98, 1.14, -1.28, 1.28);
  const crate = (sx: number, sy: number, sz: number, x: number, z: number, c: number) => {
    g.bx('paint', c, x - sx / 2, x + sx / 2, 1.14, 1.14 + sy, z - sz / 2, z + sz / 2);
    g.bx('paint', shade(c, 0.7), x - sx / 2 - 0.02, x + sx / 2 + 0.02, 1.14 + sy * 0.45, 1.14 + sy * 0.55, z - sz / 2 - 0.02, z + sz / 2 + 0.02);
  };
  if (variant % 2 === 0) {
    crate(1.6, 1.2, 2.2, -2.3, 0, 0x9a7a52);
    crate(1.2, 0.9, 1.1, -0.6, 0.5, 0x8a6a44);
    crate(1.0, 0.7, 1.0, -0.6, -0.6, 0xa88a60);
    // tarpaulin-covered load
    g.heap('paint', 0x3f4a3c, 1.5, 0.9, 1.15, 2.0, 1.2, 0, variant + 5);
  } else {
    crate(1.4, 1.0, 2.0, -2.4, 0, 0xa88a60);
    crate(1.4, 1.3, 2.0, -0.6, 0, 0x8a6a44);
    crate(1.2, 0.8, 1.8, 1.2, 0.1, 0x9a7a52);
    g.cx('paint', 0x6a5236, 0.5, 1.2, 2.9, 1.64, 0.4, 10); // barrel
    g.cx('paint', 0x6a5236, 0.5, 1.2, 2.9, 1.64, -0.6, 10);
  }
}

function circusCage(g: GB, variant: number) {
  const L = LIVERY.circus;
  wagonBase(g, 10, SPECS.circus_cage.axles, 0x2a2a2a);
  const hx = 4.7;
  g.bx('paint', L.body, -hx, hx, 0.98, 1.45, -1.3, 1.3);
  g.bx2('paint', L.lining, -hx, hx, 1.3, 1.36, 1.3, 1.32);
  g.bx('paint', shade(L.body, 0.8), -hx, hx, 3.0, 3.25, -1.3, 1.3);
  g.bx2('paint', L.lining, -hx, hx, 3.08, 3.14, 1.3, 1.32);
  // bars
  for (let x = -hx + 0.25; x <= hx - 0.1; x += 0.62) g.bx2('brass', 0xd8b04a, x - 0.035, x + 0.035, 1.45, 3.0, 1.2, 1.26);
  for (let z = -1.0; z <= 1.01; z += 0.5) {
    g.bx('brass', 0xd8b04a, hx - 0.06, hx, 1.45, 3.0, z - 0.03, z + 0.03);
    g.bx('brass', 0xd8b04a, -hx, -hx + 0.06, 1.45, 3.0, z - 0.03, z + 0.03);
  }
  g.bx('paint', 0x6a5236, -hx + 0.1, hx - 0.1, 1.45, 1.52, -1.2, 1.2); // straw floor
  // striped gable roof
  const n = 10, seg = (2 * hx) / n;
  for (let i = 0; i < n; i++) {
    const c = i % 2 ? CREAM : L.body;
    const x = -hx + seg * (i + 0.5);
    g.box('paint', c, seg, 0.1, 1.55, x, 3.55, 0.7, 0.42, 0, 0);
    g.box('paint', c, seg, 0.1, 1.55, x, 3.55, -0.7, -0.42, 0, 0);
  }
  g.cy('brass', L.lining, 0.05, 0.12, 0.4, 0, 4.0, 0, 6);
  // the passenger
  if (variant % 2 === 0) {
    // lion
    const tawny = 0xc8964e, mane = 0x8a4a22;
    g.box('paint', tawny, 1.9, 0.75, 0.75, -0.4, 2.0, 0);
    g.add('paint', mane, new THREE.IcosahedronGeometry(0.55, 0), 0.8, 2.35, 0);
    g.add('paint', tawny, new THREE.IcosahedronGeometry(0.34, 0), 1.2, 2.35, 0);
    for (const [x, z] of [[-1.1, 0.25], [-1.1, -0.25], [0.3, 0.25], [0.3, -0.25]]) g.bx('paint', tawny, x - 0.1, x + 0.1, 1.52, 1.8, z - 0.1, z + 0.1);
    g.box('paint', tawny, 0.9, 0.08, 0.08, -1.7, 2.2, 0, 0, 0, 0.6);
  } else {
    // bear
    const brown = 0x5a3a26;
    g.add('paint', brown, new THREE.IcosahedronGeometry(0.75, 0), -0.2, 2.2, 0, 0, 0, 0, 1.3, 0.95, 0.85);
    g.add('paint', brown, new THREE.IcosahedronGeometry(0.4, 0), 1.0, 2.55, 0);
    g.add('paint', 0x8a6a4a, new THREE.IcosahedronGeometry(0.16, 0), 1.35, 2.5, 0);
    g.add('paint', brown, new THREE.IcosahedronGeometry(0.12, 0), 0.95, 2.95, 0.22);
    g.add('paint', brown, new THREE.IcosahedronGeometry(0.12, 0), 0.95, 2.95, -0.22);
  }
}

function royalSaloon(g: GB) {
  const L = LIVERY.royal;
  const len = 14, hx = len / 2 - 0.3;
  const o: CoachOpts = { lower: L.body, upper: mix(L.body, 0xffffff, 0.12), band: L.lining, roof: 0xd8d2c4, frame: L.frame };
  coachShell(g, len, o, SPECS.royal_saloon.axles, { roofRise: 0.3 });
  for (let i = 0; i < 5; i++) {
    const x = -4.4 + i * 2.2;
    win2(g, x, 2.35, 3.12, 1.4);
    g.bx2('paint', L.lining, x - 0.74, x + 0.74, 2.3, 2.34, W, W + 0.03);
    g.bx2('paint', L.lining, x - 0.74, x + 0.74, 3.13, 3.17, W, W + 0.03);
  }
  g.bx2('paint', L.lining, -hx, hx, 1.5, 1.54, W, W + 0.02);
  g.bx2('paint', L.lining, -hx, hx, 3.26, 3.3, W, W + 0.02);
  // royal cypher roundel
  g.add('brass', L.lining, new THREE.CylinderGeometry(0.3, 0.3, 0.04, 14), 0, 1.78, W + 0.03, Math.PI / 2, 0, 0);
  g.add('brass', L.lining, new THREE.CylinderGeometry(0.3, 0.3, 0.04, 14), 0, 1.78, -W - 0.03, Math.PI / 2, 0, 0);
  // clerestory + crown
  g.bx('paint', o.upper, -hx + 1.0, hx - 1.0, 3.55, 3.95, -0.62, 0.62);
  for (let i = 0; i < 8; i++) g.bx2('window', 0x3a3226, -4.3 + i * 1.2, -3.8 + i * 1.2, 3.63, 3.87, 0.61, 0.64);
  g.bx('paint', 0xd8d2c4, -hx + 0.8, hx - 0.8, 3.95, 4.05, -0.78, 0.78);
  g.cy('brass', L.lining, 0.32, 0.26, 0.2, 0, 4.15, 0, 8);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    g.add('brass', L.lining, new THREE.ConeGeometry(0.07, 0.25, 4), Math.cos(a) * 0.26, 4.36, Math.sin(a) * 0.26);
  }
  g.add('brass', L.lining, new THREE.IcosahedronGeometry(0.1, 0), 0, 4.5, 0);
  g.cy('paint', 0x8a1a2a, 0.24, 0.3, 0.12, 0, 4.12, 0, 8);
}

// ───────────────────────── cache ─────────────────────────

export type CarGeoms = Partial<Record<Bucket, THREE.BufferGeometry>>;
const cache = new Map<string, CarGeoms>();

/** Merged static geometry for one car (cached per type/livery/variant; shared between cars). */
export function carGeometry(type: CarType, liv: LiveryId, variant: number): CarGeoms {
  const v = type.startsWith('wagon') || type === 'circus_cage' ? variant % 4 : 0;
  const key = `${type}|${liv}|${v}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = new GB();
  const L = LIVERY[liv];
  switch (type) {
    case 'loco_express': locoExpress(g, L); break;
    case 'loco_tank': locoTank(g, L); break;
    case 'tender': tender(g, L); break;
    case 'coach_first': coach(g, L, 'first'); break;
    case 'coach_second': coach(g, L, 'second'); break;
    case 'coach_third': coach(g, L, 'third'); break;
    case 'dining': dining(g, L); break;
    case 'mail': mail(g, L); break;
    case 'guard': guardVan(g, L, liv === 'freight'); break;
    case 'wagon_coal': wagonCoal(g, v); break;
    case 'wagon_box': wagonBox(g, v); break;
    case 'wagon_tank': wagonTank(g, v); break;
    case 'wagon_flat': wagonFlat(g, v); break;
    case 'circus_cage': circusCage(g, v); break;
    case 'royal_saloon': royalSaloon(g); break;
  }
  const out = g.build();
  cache.set(key, out);
  return out;
}

// ───────────────────────── wheels & rods ─────────────────────────

/** base small wheel, radius 0.5, axis z (scaled per instance) */
export function smallWheelGeometry(): THREE.BufferGeometry {
  const g = new GB();
  g.cz('paint', 0x3c3c3c, 0.5, 0.12, 0, 0, 0, 12);
  g.cz('paint', 0x777a7d, 0.52, 0.05, 0, 0, 0.03, 12); // flange/tyre
  for (const zs of [1, -1]) {
    g.box('paint', 0x8a8a86, 0.86, 0.1, 0.02, 0, 0, zs * 0.065);
    g.box('paint', 0x8a8a86, 0.1, 0.86, 0.02, 0, 0, zs * 0.065);
    g.cz('paint', 0x9a9a96, 0.1, 0.03, 0, 0, zs * 0.07, 6);
  }
  return g.build().paint!;
}

/** base driving wheel, radius 1.0, axis z: spokes + counterweight so rotation reads clearly */
export function driverWheelGeometry(): THREE.BufferGeometry {
  const g = new GB();
  g.cz('paint', 0x1e1e1f, 1.0, 0.14, 0, 0, 0, 20);
  g.cz('paint', 0x8a8c8f, 1.04, 0.06, 0, 0, 0.035, 20);
  for (const zs of [1, -1]) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.box('paint', 0x7a2a22, 0.1, 0.84, 0.03, Math.cos(a) * 0.46, Math.sin(a) * 0.46, zs * 0.075, 0, 0, a - Math.PI / 2);
    }
    // counterweight opposite the crank pin (crank at angle 0 => +x)
    g.add('paint', 0x7a2a22, new THREE.CylinderGeometry(0.85, 0.85, 0.035, 12, 1, false, Math.PI * 0.72, Math.PI * 0.56), 0, 0, zs * 0.08, Math.PI / 2, 0, 0);
    g.cz('paint', 0xa8a8a4, 0.17, 0.05, 0, 0, zs * 0.085, 8);
    g.cz('paint', 0xa8a8a4, 0.09, 0.08, 0.3, 0, zs * 0.1, 6); // crank boss
  }
  return g.build().paint!;
}

/** coupling rod: a bar of unit length along x (scaled per loco) with bosses at the ends */
export function rodGeometry(len: number): THREE.BufferGeometry {
  const g = new GB();
  g.box('paint', 0xffffff, len, 0.13, 0.05, 0, 0, 0);
  g.cz('paint', 0xffffff, 0.11, 0.07, -len / 2, 0, 0, 8);
  g.cz('paint', 0xffffff, 0.11, 0.07, len / 2, 0, 0, 8);
  const out = g.build().paint!;
  out.deleteAttribute('color');
  return out;
}

/** thin plane for nameplates (faces +z) */
export const plateGeometry = (w: number) => new THREE.PlaneGeometry(w, w * 0.19);
