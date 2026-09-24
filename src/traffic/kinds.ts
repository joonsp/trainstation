import type { PersonRole, VehicleKind } from '../core/apis';

/**
 * Vehicle kind specs. Body frame: local +x forward, +z = RIGHT of travel (kerb = −z, keep-left), origin on the
 * ground midway between the axles. Horses are placed ahead of the body along the route (not rigid), so the
 * team follows the road around corners.
 */
export type BodyGroup = 0 | 1 | 2;

export interface Wheel { x: number; z: number; r: number; col: number }
export interface Seat { x: number; y: number; z: number; pose: 'sit' | 'drive' | 'stand' | 'push'; hidden?: boolean; back?: boolean }

export interface KindSpec {
  kind: VehicleKind;
  label: string;
  group: BodyGroup;
  /** kind index inside its body group (vertex mask) */
  sub: number;
  horses: 0 | 1 | 2 | 4;
  /** horse size multiplier (pony 0.82 … shire 1.12) */
  horseScale: number;
  /** body length (m) from its front edge (dash) to its rear edge (shafts extend forward alongside the horse) */
  bodyLen: number;
  /** distance from the body origin forward to the body's front edge (the horse's rump is just ahead) */
  shaftFront: number;
  halfWidth: number;
  /** total mover length incl. horses */
  length: number;
  maxSpeed: number;
  speedScale: number;
  wheels: Wheel[];
  seats: Seat[];
  driver: PersonRole;
  /** lamp positions (local) — carriage lamps */
  lamps: [number, number, number][];
  /** where riders step up/down (local) */
  door: [number, number];
  /** colour sets [body, trim, dark, cargo] to pick from */
  colours: number[][];
}

const HORSE_LEN = 2.95;

const YEL = 0xc8a03a, BLK = 0x1d1c1c, RED = 0x9a2a22, GRN = 0x2f4d33, CRM = 0xd9ccaa, WOOD = 0x7a5a3c, DWOOD = 0x5a4028, IRONW = 0x2a2a2a;

function mk(k: Omit<KindSpec, 'length'> & { length?: number }): KindSpec {
  const teamLen = k.horses === 0 ? 0 : (k.horses === 4 ? HORSE_LEN * 2 + 0.4 : HORSE_LEN) * k.horseScale + 0.15;
  return { ...k, length: k.length ?? (teamLen + k.bodyLen) };
}

export const KINDS: Record<VehicleKind, KindSpec> = {
  hansom: mk({
    kind: 'hansom', label: 'Hansom cab', group: 0, sub: 0, horses: 1, horseScale: 1, bodyLen: 2.7, shaftFront: 0.9, halfWidth: 0.8,
    maxSpeed: 3.6, speedScale: 1.05,
    wheels: [{ x: 0, z: 0.82, r: 0.85, col: YEL }, { x: 0, z: -0.82, r: 0.85, col: YEL }],
    seats: [{ x: -1.25, y: 2.35, z: 0, pose: 'drive' }, { x: 0.05, y: 1.05, z: 0, pose: 'sit', hidden: true }, { x: 0.05, y: 1.05, z: 0.3, pose: 'sit', hidden: true }],
    driver: 'cabman', lamps: [[0.7, 1.9, 0.72], [0.7, 1.9, -0.72]], door: [0.8, -1.4],
    colours: [[BLK, YEL, IRONW, 0x3a3a3a], [GRN, YEL, IRONW, 0x3a3a3a], [0x3a2228, 0xb8a060, IRONW, 0x3a3a3a], [0x22303a, 0xb89a52, IRONW, 0x3a3a3a]],
  }),
  growler: mk({
    kind: 'growler', label: 'Four-wheeler (growler)', group: 0, sub: 1, horses: 1, horseScale: 1.02, bodyLen: 3.5, shaftFront: 1.55, halfWidth: 0.85,
    maxSpeed: 3.0, speedScale: 0.95,
    wheels: [{ x: 1.0, z: 0.78, r: 0.5, col: BLK }, { x: 1.0, z: -0.78, r: 0.5, col: BLK }, { x: -0.8, z: 0.8, r: 0.66, col: BLK }, { x: -0.8, z: -0.8, r: 0.66, col: BLK }],
    seats: [{ x: 1.2, y: 1.95, z: 0, pose: 'drive' }, { x: -0.3, y: 0.95, z: 0.35, pose: 'sit', hidden: true }, { x: -0.3, y: 0.95, z: -0.35, pose: 'sit', hidden: true }, { x: 0.3, y: 0.95, z: 0.35, pose: 'sit', hidden: true, back: true }, { x: 0.3, y: 0.95, z: -0.35, pose: 'sit', hidden: true, back: true }],
    driver: 'cabman', lamps: [[1.35, 1.75, 0.8], [1.35, 1.75, -0.8]], door: [0, -1.45],
    colours: [[0x2a2622, 0x6a5a40, IRONW, 0x5a4030], [0x33301f, 0x7a6a44, IRONW, 0x4a3a2a], [0x3a2a24, 0x7a5a3a, IRONW, 0x6a5040]],
  }),
  landau: mk({
    kind: 'landau', label: 'Landau', group: 0, sub: 2, horses: 2, horseScale: 1, bodyLen: 4.0, shaftFront: 1.75, halfWidth: 0.9,
    maxSpeed: 3.6, speedScale: 1.05,
    wheels: [{ x: 1.1, z: 0.8, r: 0.55, col: YEL }, { x: 1.1, z: -0.8, r: 0.55, col: YEL }, { x: -0.9, z: 0.82, r: 0.72, col: YEL }, { x: -0.9, z: -0.82, r: 0.72, col: YEL }],
    seats: [{ x: 1.45, y: 2.0, z: 0, pose: 'drive' }, { x: -0.65, y: 1.1, z: 0.35, pose: 'sit' }, { x: -0.65, y: 1.1, z: -0.35, pose: 'sit' }, { x: 0.35, y: 1.1, z: 0.35, pose: 'sit', back: true }, { x: 0.35, y: 1.1, z: -0.35, pose: 'sit', back: true }],
    driver: 'coachman', lamps: [[1.6, 1.8, 0.85], [1.6, 1.8, -0.85]], door: [-0.15, -1.5],
    colours: [[0x2a3a52, 0xc8a24a, IRONW, 0x1a1a1a], [0x4a1e24, 0xc8a24a, IRONW, 0x1a1a1a], [0x2f4d33, 0xc8a24a, IRONW, 0x1a1a1a]],
  }),
  gig: mk({
    kind: 'gig', label: 'Dog-cart (gig)', group: 0, sub: 3, horses: 1, horseScale: 0.92, bodyLen: 2.2, shaftFront: 0.9, halfWidth: 0.75,
    maxSpeed: 4.0, speedScale: 1.15,
    wheels: [{ x: -0.1, z: 0.8, r: 0.78, col: RED }, { x: -0.1, z: -0.8, r: 0.78, col: RED }],
    seats: [{ x: 0.05, y: 1.35, z: 0.28, pose: 'drive' }, { x: 0.05, y: 1.35, z: -0.28, pose: 'sit' }, { x: -0.7, y: 1.35, z: 0, pose: 'sit', back: true }],
    driver: 'coachman', lamps: [[0.55, 1.35, 0.7], [0.55, 1.35, -0.7]], door: [-0.2, -1.3],
    colours: [[0x8a6a3a, RED, IRONW, 0x3a2a1a], [0x6a5030, 0x2a4a3a, IRONW, 0x3a2a1a], [CRM, 0x2a3a52, IRONW, 0x3a2a1a]],
  }),
  carriage4: mk({
    kind: 'carriage4', label: 'Carriage and four', group: 0, sub: 2, horses: 4, horseScale: 1, bodyLen: 4.0, shaftFront: 1.75, halfWidth: 0.9,
    maxSpeed: 3.4, speedScale: 1,
    wheels: [{ x: 1.1, z: 0.8, r: 0.55, col: 0xd9b95a }, { x: 1.1, z: -0.8, r: 0.55, col: 0xd9b95a }, { x: -0.9, z: 0.82, r: 0.72, col: 0xd9b95a }, { x: -0.9, z: -0.82, r: 0.72, col: 0xd9b95a }],
    seats: [{ x: 1.45, y: 2.0, z: 0, pose: 'drive' }, { x: -0.65, y: 1.1, z: 0.35, pose: 'sit' }, { x: -0.65, y: 1.1, z: -0.35, pose: 'sit' }, { x: 0.35, y: 1.1, z: 0.35, pose: 'sit', back: true }, { x: 0.35, y: 1.1, z: -0.35, pose: 'sit', back: true }, { x: -1.9, y: 1.85, z: 0.3, pose: 'stand' }, { x: -1.9, y: 1.85, z: -0.3, pose: 'stand' }],
    driver: 'coachman', lamps: [[1.6, 1.8, 0.85], [1.6, 1.8, -0.85]], door: [-0.15, -1.5],
    colours: [[0x3a2a5a, 0xd9b95a, 0x1a1a22, 0x1a1a22]],
  }),
  mailcart: mk({
    kind: 'mailcart', label: 'Royal Mail cart', group: 0, sub: 4, horses: 1, horseScale: 1, bodyLen: 2.8, shaftFront: 1.0, halfWidth: 0.8,
    maxSpeed: 3.8, speedScale: 1.1,
    wheels: [{ x: -0.2, z: 0.8, r: 0.8, col: RED }, { x: -0.2, z: -0.8, r: 0.8, col: RED }],
    seats: [{ x: 0.55, y: 1.75, z: 0, pose: 'drive' }],
    driver: 'postman', lamps: [[0.9, 1.7, 0.75], [0.9, 1.7, -0.75]], door: [-1.8, -0.6],
    colours: [[0xa0231c, 0xd8b04a, BLK, 0x1a1a1a]],
  }),
  omnibus: mk({
    kind: 'omnibus', label: 'Horse omnibus', group: 1, sub: 0, horses: 2, horseScale: 1.02, bodyLen: 6.2, shaftFront: 2.35, halfWidth: 1.05,
    maxSpeed: 2.9, speedScale: 0.9,
    wheels: [{ x: 1.45, z: 0.95, r: 0.55, col: YEL }, { x: 1.45, z: -0.95, r: 0.55, col: YEL }, { x: -1.35, z: 1.0, r: 0.75, col: YEL }, { x: -1.35, z: -1.0, r: 0.75, col: YEL }],
    seats: [
      { x: 2.05, y: 2.75, z: 0, pose: 'drive' },
      // knifeboard (back-to-back bench along the roof), 4 a side
      { x: 1.0, y: 3.05, z: 0.35, pose: 'sit' }, { x: 1.0, y: 3.05, z: -0.35, pose: 'sit' },
      { x: 0.2, y: 3.05, z: 0.35, pose: 'sit' }, { x: 0.2, y: 3.05, z: -0.35, pose: 'sit' },
      { x: -0.6, y: 3.05, z: 0.35, pose: 'sit' }, { x: -0.6, y: 3.05, z: -0.35, pose: 'sit' },
      { x: -1.4, y: 3.05, z: 0.35, pose: 'sit' }, { x: -1.4, y: 3.05, z: -0.35, pose: 'sit' },
      // lower saloon (hidden)
      { x: 0.6, y: 1.05, z: 0.5, pose: 'sit', hidden: true }, { x: 0.6, y: 1.05, z: -0.5, pose: 'sit', hidden: true },
      { x: -0.4, y: 1.05, z: 0.5, pose: 'sit', hidden: true }, { x: -0.4, y: 1.05, z: -0.5, pose: 'sit', hidden: true },
      { x: -1.2, y: 1.05, z: 0.5, pose: 'sit', hidden: true }, { x: -1.2, y: 1.05, z: -0.5, pose: 'sit', hidden: true },
      // conductor on the rear platform
      { x: -3.15, y: 0.55, z: 0.3, pose: 'stand' },
    ],
    driver: 'coachman', lamps: [[2.2, 2.2, 1.0], [2.2, 2.2, -1.0], [-3.3, 1.9, 0.9]], door: [-3.9, -0.4],
    colours: [[0x2f4d33, 0xd9ccaa, IRONW, 0xb8402a], [0x6a2226, 0xd9ccaa, IRONW, 0x2a5a8a], [0x2a3a5a, 0xd9ccaa, IRONW, 0xc8a02a]],
  }),
  fireengine: mk({
    kind: 'fireengine', label: 'Steam fire engine', group: 1, sub: 1, horses: 2, horseScale: 1.05, bodyLen: 4.6, shaftFront: 1.95, halfWidth: 0.95,
    maxSpeed: 4.6, speedScale: 1.3,
    wheels: [{ x: 1.3, z: 0.9, r: 0.55, col: RED }, { x: 1.3, z: -0.9, r: 0.55, col: RED }, { x: -1.1, z: 0.95, r: 0.8, col: RED }, { x: -1.1, z: -0.95, r: 0.8, col: RED }],
    seats: [{ x: 1.6, y: 1.9, z: 0, pose: 'drive' }, { x: 0.6, y: 1.5, z: 0.6, pose: 'sit' }, { x: 0.6, y: 1.5, z: -0.6, pose: 'sit' }, { x: -2.1, y: 0.8, z: 0, pose: 'stand' }],
    driver: 'firefighter', lamps: [[1.8, 1.6, 0.9], [1.8, 1.6, -0.9]], door: [0.3, -1.5],
    colours: [[0xb02a1e, 0xd9b04a, BLK, 0xc9a24a]],
  }),
  circuswagon: mk({
    kind: 'circuswagon', label: 'Circus wagon', group: 1, sub: 2, horses: 2, horseScale: 1.05, bodyLen: 5.4, shaftFront: 2.35, halfWidth: 1.05,
    maxSpeed: 2.6, speedScale: 0.85,
    wheels: [{ x: 1.4, z: 1.0, r: 0.6, col: 0xe0b84a }, { x: 1.4, z: -1.0, r: 0.6, col: 0xe0b84a }, { x: -1.4, z: 1.0, r: 0.75, col: 0xe0b84a }, { x: -1.4, z: -1.0, r: 0.75, col: 0xe0b84a }],
    seats: [{ x: 2.1, y: 2.1, z: 0, pose: 'drive' }],
    driver: 'ringmaster', lamps: [[2.3, 2.0, 1.0], [2.3, 2.0, -1.0]], door: [0, -1.6],
    colours: [[0xb5473a, 0xe0b84a, 0x2a2a2a, 0x2a4a8a], [0x2a4a8a, 0xe0b84a, 0x2a2a2a, 0xb5473a]],
  }),
  dray: mk({
    kind: 'dray', label: 'Brewer\'s dray', group: 1, sub: 3, horses: 2, horseScale: 1.12, bodyLen: 4.6, shaftFront: 2.15, halfWidth: 1.0,
    maxSpeed: 2.3, speedScale: 0.75,
    wheels: [{ x: 1.35, z: 0.95, r: 0.62, col: RED }, { x: 1.35, z: -0.95, r: 0.62, col: RED }, { x: -1.3, z: 0.98, r: 0.82, col: RED }, { x: -1.3, z: -0.98, r: 0.82, col: RED }],
    seats: [{ x: 1.75, y: 2.1, z: 0.3, pose: 'drive' }, { x: 1.75, y: 2.1, z: -0.3, pose: 'sit' }],
    driver: 'drayman', lamps: [[1.9, 1.9, 0.95], [1.9, 1.9, -0.95]], door: [1.2, -1.6],
    colours: [[0x2a4a7a, 0xc8a24a, IRONW, 0x8a6030]],
  }),
  haywain: mk({
    kind: 'haywain', label: 'Hay wain', group: 1, sub: 4, horses: 2, horseScale: 1.1, bodyLen: 5.0, shaftFront: 2.15, halfWidth: 1.05,
    maxSpeed: 2.0, speedScale: 0.7,
    wheels: [{ x: 1.35, z: 0.95, r: 0.62, col: RED }, { x: 1.35, z: -0.95, r: 0.62, col: RED }, { x: -1.35, z: 1.0, r: 0.85, col: RED }, { x: -1.35, z: -1.0, r: 0.85, col: RED }],
    seats: [{ x: 1.9, y: 1.7, z: 0, pose: 'drive' }, { x: -0.3, y: 3.45, z: 0, pose: 'sit' }],
    driver: 'carter', lamps: [], door: [1.5, -1.6],
    colours: [[0x3a6a9a, RED, DWOOD, 0xd8c070], [0xb89a52, RED, DWOOD, 0xd0b860]],
  }),
  coalcart: mk({
    kind: 'coalcart', label: 'Coal cart', group: 2, sub: 0, horses: 1, horseScale: 1.08, bodyLen: 2.9, shaftFront: 1.25, halfWidth: 0.85,
    maxSpeed: 2.4, speedScale: 0.75,
    wheels: [{ x: -0.35, z: 0.9, r: 0.78, col: BLK }, { x: -0.35, z: -0.9, r: 0.78, col: BLK }],
    seats: [{ x: 0.95, y: 1.55, z: -0.25, pose: 'drive' }],
    driver: 'carter', lamps: [], door: [0.6, -1.4],
    colours: [[0x3a3a38, 0x7a2a22, IRONW, 0x1c1c1e], [0x4a4036, 0x2a4a33, IRONW, 0x1c1c1e]],
  }),
  farmcart: mk({
    kind: 'farmcart', label: 'Farm cart', group: 2, sub: 1, horses: 1, horseScale: 1.1, bodyLen: 3.0, shaftFront: 1.25, halfWidth: 0.9,
    maxSpeed: 2.4, speedScale: 0.8,
    wheels: [{ x: -0.3, z: 0.95, r: 0.8, col: RED }, { x: -0.3, z: -0.95, r: 0.8, col: RED }],
    seats: [{ x: 0.9, y: 1.55, z: -0.3, pose: 'drive' }, { x: -0.6, y: 1.35, z: 0.3, pose: 'sit' }],
    driver: 'carter', lamps: [], door: [0.6, -1.5],
    colours: [[0x3a6a9a, RED, DWOOD, 0x8a6a3a], [0x8a6a3a, 0x3a6a9a, DWOOD, 0xa06a3a], [0x6a7a4a, RED, DWOOD, 0xc8a860]],
  }),
  milkfloat: mk({
    kind: 'milkfloat', label: 'Milk float', group: 2, sub: 2, horses: 1, horseScale: 0.82, bodyLen: 2.6, shaftFront: 0.85, halfWidth: 0.75,
    maxSpeed: 3.0, speedScale: 0.9,
    wheels: [{ x: -0.25, z: 0.8, r: 0.66, col: RED }, { x: -0.25, z: -0.8, r: 0.66, col: RED }],
    seats: [{ x: -0.7, y: 0.75, z: 0, pose: 'stand' }],
    driver: 'milkman', lamps: [[0.5, 1.2, 0.65], [0.5, 1.2, -0.65]], door: [-1.5, -0.4],
    colours: [[CRM, 0x2a5a8a, DWOOD, 0xc8ccd0], [0x2a5a8a, CRM, DWOOD, 0xc8ccd0]],
  }),
  handcart: mk({
    kind: 'handcart', label: 'Baker\'s handcart', group: 2, sub: 3, horses: 0, horseScale: 1, bodyLen: 2.9, shaftFront: 1.1, halfWidth: 0.55,
    maxSpeed: 1.3, speedScale: 0.5,
    wheels: [{ x: 0, z: 0.55, r: 0.45, col: RED }, { x: 0, z: -0.55, r: 0.45, col: RED }],
    seats: [{ x: -1.25, y: 0, z: 0, pose: 'push' }],
    driver: 'baker', lamps: [], door: [-1.6, -0.4],
    colours: [[0x5a3a22, CRM, DWOOD, 0xd8b070]],
  }),
  bicycle: mk({
    kind: 'bicycle', label: 'Safety bicycle', group: 2, sub: 4, horses: 0, horseScale: 1, bodyLen: 1.9, shaftFront: 0.95, halfWidth: 0.3,
    maxSpeed: 4.6, speedScale: 1.35,
    wheels: [{ x: 0.55, z: 0, r: 0.36, col: BLK }, { x: -0.55, z: 0, r: 0.36, col: BLK }],
    seats: [{ x: -0.2, y: 1.0, z: 0, pose: 'drive' }],
    driver: 'townsfolk', lamps: [[0.62, 0.95, 0]], door: [0, -0.8],
    colours: [[0x1a1a1a, 0x8a8d90, 0x1a1a1a, 0x5a4028], [0x2a3a4a, 0x8a8d90, 0x1a1a1a, 0x5a4028]],
  }),
  pennyfarthing: mk({
    kind: 'pennyfarthing', label: 'Penny-farthing', group: 2, sub: 5, horses: 0, horseScale: 1, bodyLen: 1.9, shaftFront: 1.05, halfWidth: 0.3,
    maxSpeed: 4.2, speedScale: 1.25,
    wheels: [{ x: 0.3, z: 0, r: 0.72, col: BLK }, { x: -0.72, z: 0, r: 0.22, col: BLK }],
    seats: [{ x: 0.12, y: 1.55, z: 0, pose: 'drive' }],
    driver: 'townsfolk', lamps: [[0.45, 1.3, 0.1]], door: [0, -0.8],
    colours: [[0x1a1a1a, 0x9a9da0, 0x1a1a1a, 0x5a3a28]],
  }),
  motorwagen: mk({
    kind: 'motorwagen', label: 'Benz Patent-Motorwagen', group: 2, sub: 6, horses: 0, horseScale: 1, bodyLen: 2.9, shaftFront: 1.4, halfWidth: 0.75,
    maxSpeed: 4.0, speedScale: 1.2,
    wheels: [{ x: 1.05, z: 0, r: 0.3, col: 0x1a1a1a }, { x: -0.55, z: 0.68, r: 0.56, col: 0x1a1a1a }, { x: -0.55, z: -0.68, r: 0.56, col: 0x1a1a1a }],
    seats: [{ x: -0.15, y: 1.05, z: 0.22, pose: 'drive' }, { x: -0.15, y: 1.05, z: -0.22, pose: 'sit' }],
    driver: 'motorist', lamps: [[0.75, 1.1, 0.35], [0.75, 1.1, -0.35]], door: [0, -1.3],
    colours: [[0x1a1a1a, 0xc9a24a, 0x2a2a2a, 0x7a2a22]],
  }),
};

/** position of the first horse's body centre behind the mover front */
export function horseOffset(k: KindSpec): number { return 1.82 * k.horseScale; }
/** team length (front of the leaders' noses to the wheelers' rumps) */
export function teamLength(k: KindSpec): number { return k.horses === 0 ? 0 : (k.horses === 4 ? HORSE_LEN * 2 + 0.4 : HORSE_LEN) * k.horseScale + 0.15; }
/** body origin behind the mover front */
export function bodyOffset(k: KindSpec): number { return teamLength(k) + k.shaftFront; }
export const HORSE_LENGTH = HORSE_LEN;
