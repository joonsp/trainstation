import * as THREE from 'three';

/** low quality tier: fewer segments on heads, hats and limbs (set before any geometry is built) */
let LOW_POLY = false;
export function setPeopleLowPoly(on: boolean) { LOW_POLY = on; }
function sph(r: number, w: number, h: number, ...rest: number[]): THREE.SphereGeometry {
  return new THREE.SphereGeometry(r, LOW_POLY ? Math.max(5, w - 3) : w, LOW_POLY ? Math.max(3, h - 2) : h, ...rest);
}
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/*
 * Low-poly person parts, modelled in person-local space: feet at y = 0, facing local +z, person's LEFT = +x.
 * Every vertex carries:
 *   slot  : which per-instance colour it takes (0 = A primary, 1 = B secondary, 2 = C trim, 3 = D skin,
 *           4 = fixed `color`, 5 = fixed `color` that GLOWS at night — lantern glass)
 *   rig   : 0 = rigid body, 1 = left leg, 2 = right leg, 3 = left arm, 4 = right arm, 5 = head (turns & nods)
 *   pid   : prop id inside a merged prop-family mesh (−1 = not a prop; the vertex shader collapses every prop
 *           whose id differs from the instance's iAux.w, so one InstancedMesh draws a whole family of props)
 *   color : shade multiplier (or absolute colour for slots 4/5)
 * Pivots: hips at y = HIP, shoulders at y = SHOULDER, neck at y = NECK.
 */

export const HIP = 0.85;
export const SHOULDER = 1.4;
export const NECK = 1.47;

export const SLOT_A = 0, SLOT_B = 1, SLOT_C = 2, SLOT_D = 3, SLOT_FIXED = 4, SLOT_GLOW = 5;
export const RIG_BODY = 0, RIG_LLEG = 1, RIG_RLEG = 2, RIG_LARM = 3, RIG_RARM = 4, RIG_HEAD = 5;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

interface PartOpts {
  slot: number;
  rig?: number;
  /** shade multiplier (slots 0-3) or grey level / absolute colour for slots 4/5 */
  shade?: number | THREE.ColorRepresentation;
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
}

class Builder {
  parts: THREE.BufferGeometry[] = [];
  /** rig applied to every part added while set (>= 0) */
  forceRig = -1;
  pid = -1;
  add(g: THREE.BufferGeometry, o: PartOpts): this {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    _p.set(...(o.pos ?? [0, 0, 0]));
    _e.set(...(o.rot ?? [0, 0, 0]));
    _q.setFromEuler(_e);
    _s.set(...(o.scale ?? [1, 1, 1]));
    geo.applyMatrix4(_m.compose(_p, _q, _s));
    geo.deleteAttribute('uv');
    geo.deleteAttribute('normal');
    const n = geo.getAttribute('position').count;
    // slot / rig / prop id packed in one vec3 (software GL caps vertex attributes at 16)
    const meta = new Float32Array(n * 3);
    const rigV = this.forceRig >= 0 ? this.forceRig : (o.rig ?? 0);
    for (let i = 0; i < n; i++) { meta[i * 3] = o.slot; meta[i * 3 + 1] = rigV; meta[i * 3 + 2] = this.pid; }
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    const sh = o.shade ?? 1;
    if (typeof sh === 'number' && o.slot < SLOT_FIXED) c.setRGB(sh, sh, sh);
    else if (typeof sh === 'number' && sh <= 1) c.setRGB(sh, sh, sh);
    else c.set(sh as THREE.ColorRepresentation);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    geo.setAttribute('pplMeta', new THREE.BufferAttribute(meta, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(geo);
    return this;
  }
  box(w: number, h: number, d: number, o: PartOpts): this { return this.add(new THREE.BoxGeometry(w, h, d), o); }
  cyl(rt: number, rb: number, h: number, seg: number, o: PartOpts, open = false): this {
    return this.add(new THREE.CylinderGeometry(rt, rb, h, LOW_POLY && seg >= 6 ? seg - 1 : seg, 1, open), o);
  }
  /** a stick from a to b (square section) */
  stick(a: [number, number, number], b: [number, number, number], r: number, o: Omit<PartOpts, 'pos' | 'rot' | 'scale'>): this {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    const g = new THREE.BoxGeometry(r * 2, len, r * 2);
    const mid = A.clone().add(B).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    g.applyQuaternion(q);
    g.translate(mid.x, mid.y, mid.z);
    return this.add(g, o);
  }
  /**
   * Parts added inside `fn` are modelled in the POSED frame of an arm raised to `angle` (the vertex shader's
   * rotation for that arm); they are stored in the arm's rest frame and bound to the arm rig, so at runtime
   * with the arm at `angle` they reproduce the design exactly (and follow the arm when it moves).
   */
  armPosed(side: 'l' | 'r', angle: number, fn: () => void): this {
    const start = this.parts.length;
    const prev = this.forceRig;
    this.forceRig = side === 'l' ? RIG_LARM : RIG_RARM;
    fn();
    this.forceRig = prev;
    const m = new THREE.Matrix4().makeTranslation(0, SHOULDER, 0)
      .multiply(new THREE.Matrix4().makeRotationX(-angle))
      .multiply(new THREE.Matrix4().makeTranslation(0, -SHOULDER, 0));
    for (let i = start; i < this.parts.length; i++) this.parts[i].applyMatrix4(m);
    return this;
  }
  rigged(rig: number, fn: () => void): this {
    const prev = this.forceRig;
    this.forceRig = rig;
    fn();
    this.forceRig = prev;
    return this;
  }
  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false)!;
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const SHOE = 0x1c1a18;
const DARK = 0x1a1a1c;
const WOODC = 0x6a4a30;
const IRONC = 0x2a2a2c;
const BRASS_C = 0xc9a24a;


// ───────────── shared body bits ─────────────
function headAndNeck(b: Builder) {
  b.cyl(0.055, 0.06, 0.1, 6, { slot: SLOT_D, pos: [0, 1.47, 0] });
  b.add(new THREE.IcosahedronGeometry(0.125, LOW_POLY ? 0 : 1), { slot: SLOT_D, rig: RIG_HEAD, pos: [0, 1.6, 0.005], scale: [0.95, 1.05, 1] });
  // nose: gives the face a direction at a glance
  b.box(0.035, 0.05, 0.05, { slot: SLOT_D, rig: RIG_HEAD, shade: 0.92, pos: [0, 1.585, 0.13] });
}

function legs(b: Builder, slot = SLOT_B) {
  for (const [x, rig] of [[0.095, RIG_LLEG], [-0.095, RIG_RLEG]] as const) {
    b.box(0.14, 0.8, 0.16, { slot, rig, pos: [x, 0.47, 0] });
    b.box(0.15, 0.08, 0.26, { slot: SLOT_FIXED, shade: SHOE, rig, pos: [x, 0.04, 0.04] });
  }
}

function arms(b: Builder, slot = SLOT_A, len = 0.5) {
  for (const [x, rig] of [[0.265, RIG_LARM], [-0.265, RIG_RARM]] as const) {
    b.box(0.11, len, 0.13, { slot, rig, pos: [x, SHOULDER - len / 2 + 0.02, 0], rot: [0, 0, x > 0 ? 0.06 : -0.06] });
    b.box(0.085, 0.09, 0.1, { slot: SLOT_D, rig, pos: [x * 1.03, SHOULDER - len - 0.03, 0.01] });
  }
}

// ───────────── bodies ─────────────
export type BodyKind = 'coat' | 'uniform' | 'jacket' | 'dress';

/** Gentleman's frock coat (also the farm smock in pale linen): A coat, B trousers, C shirt front, D skin. */
function coatBody(): THREE.BufferGeometry {
  const b = new Builder();
  legs(b);
  b.cyl(0.2, 0.225, 0.56, 6, { slot: SLOT_A, pos: [0, 1.13, 0], scale: [1, 1, 0.74] });
  b.cyl(0.228, 0.27, 0.36, 6, { slot: SLOT_A, shade: 0.9, pos: [0, 0.68, -0.01], scale: [1, 1, 0.78] }, true);
  b.box(0.5, 0.1, 0.25, { slot: SLOT_A, pos: [0, 1.37, 0] });
  b.box(0.12, 0.2, 0.03, { slot: SLOT_C, pos: [0, 1.32, 0.15], rot: [-0.12, 0, 0] });
  b.box(0.05, 0.035, 0.03, { slot: SLOT_FIXED, shade: DARK, pos: [0, 1.41, 0.165] }); // cravat
  arms(b);
  headAndNeck(b);
  return b.build();
}

/** Railway / police / band uniform: shorter tunic with double row of buttons in C. */
function uniformBody(): THREE.BufferGeometry {
  const b = new Builder();
  legs(b);
  b.cyl(0.2, 0.23, 0.62, 6, { slot: SLOT_A, pos: [0, 1.1, 0], scale: [1, 1, 0.76] });
  b.box(0.5, 0.1, 0.26, { slot: SLOT_A, pos: [0, 1.37, 0] });
  b.box(0.42, 0.05, 0.3, { slot: SLOT_FIXED, shade: DARK, pos: [0, 0.86, 0] }); // belt
  for (let i = 0; i < 4; i++) {
    for (const x of [-0.06, 0.06]) b.box(0.035, 0.035, 0.03, { slot: SLOT_C, pos: [x, 1.0 + i * 0.1, 0.16] });
  }
  b.box(0.2, 0.06, 0.2, { slot: SLOT_C, shade: 0.85, pos: [0, 1.44, 0] }); // collar
  arms(b);
  headAndNeck(b);
  return b.build();
}

/** Working man: waistcoat A, shirt sleeves C, trousers B. */
function jacketBody(): THREE.BufferGeometry {
  const b = new Builder();
  legs(b);
  b.cyl(0.19, 0.21, 0.56, 6, { slot: SLOT_A, pos: [0, 1.14, 0], scale: [1, 1, 0.74] });
  b.box(0.46, 0.09, 0.24, { slot: SLOT_C, pos: [0, 1.37, 0] });
  b.box(0.36, 0.06, 0.28, { slot: SLOT_B, shade: 0.8, pos: [0, 0.87, 0] });
  b.box(0.1, 0.12, 0.03, { slot: SLOT_C, pos: [0, 1.36, 0.14] });
  arms(b, SLOT_C);
  headAndNeck(b);
  return b.build();
}

/** Lady's dress: bodice A, skirt B, lace C. */
function dressBody(): THREE.BufferGeometry {
  const b = new Builder();
  b.cyl(0.17, 0.36, 0.92, 8, { slot: SLOT_B, pos: [0, 0.5, 0], scale: [1, 1, 0.9] });
  b.cyl(0.36, 0.36, 0.05, 8, { slot: SLOT_B, shade: 0.8, pos: [0, 0.05, 0], scale: [1.01, 1, 0.91] });
  b.box(0.3, 0.2, 0.18, { slot: SLOT_B, shade: 0.92, pos: [0, 0.86, -0.17] }); // bustle
  b.cyl(0.165, 0.16, 0.48, 7, { slot: SLOT_A, pos: [0, 1.18, 0], scale: [1, 1, 0.78] });
  b.box(0.42, 0.1, 0.22, { slot: SLOT_A, pos: [0, 1.37, 0] });
  b.box(0.18, 0.06, 0.18, { slot: SLOT_C, pos: [0, 1.43, 0.01] }); // lace collar
  arms(b, SLOT_A, 0.48);
  headAndNeck(b);
  return b.build();
}

export function makeBody(k: BodyKind): THREE.BufferGeometry {
  switch (k) {
    case 'coat': return coatBody();
    case 'uniform': return uniformBody();
    case 'jacket': return jacketBody();
    case 'dress': return dressBody();
  }
}

// ───────────── hats (A hat, B band/trim, C hair) — every vertex turns with the head ─────────────
export type HatKind =
  | 'topHat' | 'bowler' | 'bonnet' | 'flatCap' | 'peakedCap' | 'helmet' | 'veil' | 'shako' | 'boater'
  | 'hairShort' | 'hairBun' | 'straw';

const TOP = 1.7;

export function makeHat(k: HatKind): THREE.BufferGeometry {
  const b = new Builder();
  b.forceRig = RIG_HEAD;
  switch (k) {
    case 'topHat':
      b.cyl(0.2, 0.2, 0.025, 10, { slot: SLOT_A, pos: [0, TOP - 0.02, 0], scale: [1, 1, 0.9] });
      b.cyl(0.125, 0.115, 0.3, 9, { slot: SLOT_A, pos: [0, TOP + 0.13, 0] });
      b.cyl(0.119, 0.118, 0.05, 9, { slot: SLOT_B, pos: [0, TOP + 0.02, 0] });
      break;
    case 'bowler':
      b.cyl(0.17, 0.17, 0.02, 10, { slot: SLOT_A, pos: [0, TOP - 0.03, 0], scale: [1, 1, 0.92] });
      b.add(sph(0.13, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2), { slot: SLOT_A, pos: [0, TOP - 0.03, 0], scale: [1, 1.05, 1] });
      b.cyl(0.132, 0.132, 0.035, 9, { slot: SLOT_B, pos: [0, TOP - 0.01, 0] });
      break;
    case 'boater':
      b.cyl(0.21, 0.21, 0.02, 10, { slot: SLOT_A, pos: [0, TOP - 0.02, 0] });
      b.cyl(0.125, 0.125, 0.09, 9, { slot: SLOT_A, pos: [0, TOP + 0.03, 0] });
      b.cyl(0.127, 0.127, 0.035, 9, { slot: SLOT_B, pos: [0, TOP + 0.005, 0] });
      break;
    case 'straw':
      // broad-brimmed countryman's straw / wideawake: a chunky disc that reads from far away
      b.cyl(0.3, 0.3, 0.025, 10, { slot: SLOT_A, pos: [0, TOP - 0.03, 0] });
      b.cyl(0.12, 0.135, 0.11, 8, { slot: SLOT_A, shade: 0.94, pos: [0, TOP + 0.03, 0] });
      b.cyl(0.137, 0.137, 0.03, 8, { slot: SLOT_B, pos: [0, TOP - 0.005, 0] });
      break;
    case 'bonnet':
      b.add(sph(0.165, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), { slot: SLOT_A, pos: [0, 1.6, -0.02], rot: [-0.55, 0, 0] });
      b.add(new THREE.IcosahedronGeometry(0.07, 0), { slot: SLOT_C, pos: [0, 1.6, -0.17] }); // bun
      b.box(0.05, 0.14, 0.03, { slot: SLOT_B, pos: [0.1, 1.49, 0.07], rot: [0, 0, 0.3] });
      b.box(0.05, 0.14, 0.03, { slot: SLOT_B, pos: [-0.1, 1.49, 0.07], rot: [0, 0, -0.3] });
      b.box(0.08, 0.06, 0.04, { slot: SLOT_B, pos: [0.13, 1.72, 0.02] }); // bow
      break;
    case 'flatCap':
      b.cyl(0.14, 0.135, 0.07, 8, { slot: SLOT_A, pos: [0, TOP - 0.01, -0.01], scale: [1, 1, 1.1], rot: [0.12, 0, 0] });
      b.box(0.22, 0.025, 0.1, { slot: SLOT_A, shade: 0.85, pos: [0, TOP - 0.035, 0.14], rot: [0.15, 0, 0] });
      break;
    case 'peakedCap':
      b.cyl(0.15, 0.13, 0.11, 8, { slot: SLOT_A, pos: [0, TOP + 0.03, -0.01] });
      b.cyl(0.133, 0.133, 0.04, 8, { slot: SLOT_B, pos: [0, TOP - 0.01, -0.01] });
      b.box(0.2, 0.02, 0.1, { slot: SLOT_FIXED, shade: 0x141414, pos: [0, TOP - 0.035, 0.13], rot: [0.25, 0, 0] });
      break;
    case 'helmet':
      b.cyl(0.165, 0.165, 0.02, 10, { slot: SLOT_A, pos: [0, TOP - 0.04, 0] });
      b.cyl(0.085, 0.14, 0.3, 9, { slot: SLOT_A, pos: [0, TOP + 0.11, 0] });
      b.add(sph(0.085, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), { slot: SLOT_A, pos: [0, TOP + 0.26, 0] });
      b.cyl(0.02, 0.025, 0.05, 6, { slot: SLOT_B, pos: [0, TOP + 0.35, 0] });
      b.box(0.07, 0.08, 0.03, { slot: SLOT_B, pos: [0, TOP + 0.08, 0.125], rot: [-0.2, 0, 0] });
      break;
    case 'veil':
      b.add(new THREE.IcosahedronGeometry(0.13, 1), { slot: SLOT_C, pos: [0, 1.62, -0.02], scale: [1, 0.9, 1] });
      b.cyl(0.13, 0.33, 0.95, 9, { slot: SLOT_A, pos: [0, 1.22, -0.12], scale: [1, 1, 0.55] }, true);
      b.cyl(0.11, 0.12, 0.04, 9, { slot: SLOT_B, pos: [0, TOP + 0.005, -0.01] }); // tiara
      break;
    case 'shako':
      b.cyl(0.13, 0.12, 0.24, 8, { slot: SLOT_A, pos: [0, TOP + 0.09, 0] });
      b.cyl(0.123, 0.123, 0.04, 8, { slot: SLOT_B, pos: [0, TOP + 0.19, 0] });
      b.box(0.2, 0.02, 0.09, { slot: SLOT_FIXED, shade: 0x141414, pos: [0, TOP - 0.03, 0.13], rot: [0.25, 0, 0] });
      b.box(0.04, 0.12, 0.04, { slot: SLOT_B, pos: [0, TOP + 0.27, 0.05] }); // plume
      break;
    case 'hairShort':
      b.add(sph(0.135, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.55), { slot: SLOT_A, pos: [0, 1.6, -0.012], rot: [-0.25, 0, 0] });
      break;
    case 'hairBun':
      b.add(sph(0.137, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.6), { slot: SLOT_A, pos: [0, 1.6, -0.01], rot: [-0.3, 0, 0] });
      b.add(new THREE.IcosahedronGeometry(0.075, 0), { slot: SLOT_A, pos: [0, 1.69, -0.12] });
      break;
  }
  return b.build();
}

// ───────────── accessories / props ─────────────
/**
 * Props are grouped in FAMILIES; each family is ONE InstancedMesh whose geometry holds every prop of the family
 * (tagged by `pid`). A person holding a prop owns one instance in that family's mesh with iAux.w = pid, and the
 * vertex shader collapses the other props. Common families stay small so the per-instance vertex cost is low.
 */
export type AccKind =
  // own meshes
  | 'umbrella' | 'trolley'
  // 'bags' — travellers & townsfolk
  | 'suitcase' | 'basket' | 'newspaper' | 'parcel' | 'apron' | 'satchel' | 'pipe' | 'papers'
  // 'tools' — trades & pastimes
  | 'rod' | 'rodCarry' | 'pole' | 'poleCarry' | 'ladder' | 'broom' | 'hoop' | 'pail' | 'tray' | 'hammer'
  | 'pitchfork' | 'crook' | 'lantern' | 'stick'
  // 'fete' — ceremonies
  | 'flag' | 'instrument' | 'bouquet';

export type PropFamily = 'umbrella' | 'trolley' | 'bags' | 'tools' | 'fete';

export const PROP_FAMILY: Record<AccKind, PropFamily> = {
  umbrella: 'umbrella', trolley: 'trolley',
  suitcase: 'bags', basket: 'bags', newspaper: 'bags', parcel: 'bags', apron: 'bags', satchel: 'bags', pipe: 'bags', papers: 'bags',
  rod: 'tools', rodCarry: 'tools', pole: 'tools', poleCarry: 'tools', ladder: 'tools', broom: 'tools', hoop: 'tools', pail: 'tools',
  tray: 'tools', hammer: 'tools', pitchfork: 'tools', crook: 'tools', lantern: 'tools', stick: 'tools',
  flag: 'fete', instrument: 'fete', bouquet: 'fete',
};

export const FAMILY_MEMBERS: Record<PropFamily, AccKind[]> = { umbrella: [], trolley: [], bags: [], tools: [], fete: [] };
for (const [k, f] of Object.entries(PROP_FAMILY) as [AccKind, PropFamily][]) FAMILY_MEMBERS[f].push(k);
/** prop id inside its family mesh */
export const PROP_ID = {} as Record<AccKind, number>;
for (const f of Object.keys(FAMILY_MEMBERS) as PropFamily[]) FAMILY_MEMBERS[f].forEach((k, i) => { PROP_ID[k] = i; });

/** the arm pose each held prop was designed for (the anim layer holds the arm there while the prop is in use) */
export const PROP_ARM: Partial<Record<AccKind, { side: 'l' | 'r'; angle: number }>> = {
  rod: { side: 'r', angle: -0.8 },
  pole: { side: 'r', angle: -1.45 },
  broom: { side: 'r', angle: -0.5 },
  hammer: { side: 'r', angle: -1.0 },
  pitchfork: { side: 'r', angle: -0.9 },
  crook: { side: 'r', angle: -0.3 },
  stick: { side: 'r', angle: -0.9 },
  umbrella: { side: 'r', angle: -1.15 },
  lantern: { side: 'l', angle: -0.35 },
};

function addProp(b: Builder, k: AccKind) {
  switch (k) {
    // ── own meshes (v1) ──
    case 'umbrella': {
      // held in the right hand, which is raised forward (see anim); canopy over the head
      b.add(new THREE.ConeGeometry(0.46, 0.22, 8, 1, true), { slot: SLOT_A, pos: [-0.12, 2.13, 0.1] });
      b.cyl(0.46, 0.46, 0.015, 8, { slot: SLOT_A, shade: 0.75, pos: [-0.12, 2.02, 0.1] }, true);
      b.cyl(0.012, 0.012, 0.95, 4, { slot: SLOT_FIXED, shade: 0x2a2420, pos: [-0.12, 1.72, 0.1] });
      b.cyl(0.018, 0.004, 0.09, 4, { slot: SLOT_FIXED, shade: 0x2a2420, pos: [-0.12, 2.28, 0.1] });
      break;
    }
    case 'trolley': {
      const z0 = 1.0;
      b.box(0.7, 0.06, 1.25, { slot: SLOT_FIXED, shade: 0x5a4632, pos: [0, 0.3, z0] });
      for (const x of [-0.3, 0.3]) for (const z of [z0 - 0.45, z0 + 0.45]) {
        b.cyl(0.12, 0.12, 0.05, 8, { slot: SLOT_FIXED, shade: 0x1a1a1a, pos: [x + Math.sign(x) * 0.06, 0.13, z], rot: [0, 0, Math.PI / 2] });
      }
      for (const x of [-0.32, 0.32]) b.box(0.04, 0.7, 0.04, { slot: SLOT_FIXED, shade: 0x2a2a28, pos: [x, 0.62, z0 - 0.6], rot: [-0.25, 0, 0] });
      b.box(0.72, 0.04, 0.04, { slot: SLOT_FIXED, shade: 0x2a2a28, pos: [0, 0.95, z0 - 0.68] });
      b.box(0.6, 0.36, 0.5, { slot: SLOT_A, pos: [0, 0.51, z0 + 0.2] });
      b.box(0.62, 0.04, 0.52, { slot: SLOT_FIXED, shade: 0x3a2e22, pos: [0, 0.6, z0 + 0.2] });
      b.box(0.45, 0.26, 0.34, { slot: SLOT_B, pos: [0, 0.82, z0 + 0.22] });
      b.cyl(0.14, 0.14, 0.2, 8, { slot: SLOT_C, pos: [0.05, 0.43, z0 - 0.3] });
      break;
    }
    // ── bags ──
    case 'suitcase':
      b.box(0.1, 0.3, 0.4, { slot: SLOT_A, rig: RIG_LARM, pos: [0.3, 0.63, 0.02] });
      b.box(0.11, 0.04, 0.41, { slot: SLOT_A, shade: 0.7, rig: RIG_LARM, pos: [0.3, 0.63, 0.02] });
      b.box(0.03, 0.06, 0.12, { slot: SLOT_FIXED, shade: 0x1c1a18, rig: RIG_LARM, pos: [0.3, 0.8, 0.02] });
      break;
    case 'basket': // wicker basket on the left arm, cloth over the top
      b.cyl(0.16, 0.12, 0.2, 7, { slot: SLOT_FIXED, shade: 0x9a7040, rig: RIG_LARM, pos: [0.3, 0.7, 0.05] });
      b.cyl(0.15, 0.15, 0.03, 7, { slot: SLOT_FIXED, shade: 0xe8e0cc, rig: RIG_LARM, pos: [0.3, 0.81, 0.05] });
      b.box(0.03, 0.2, 0.03, { slot: SLOT_FIXED, shade: 0x7a5530, rig: RIG_LARM, pos: [0.3, 0.9, 0.05] });
      break;
    case 'parcel': // brown-paper parcel carried at the left hip
      b.box(0.16, 0.22, 0.3, { slot: SLOT_FIXED, shade: 0xb08a5a, rig: RIG_LARM, pos: [0.3, 0.72, 0.04] });
      b.box(0.17, 0.02, 0.31, { slot: SLOT_FIXED, shade: 0x5a3a20, rig: RIG_LARM, pos: [0.3, 0.74, 0.04] });
      break;
    case 'papers': // newsboy's bundle under the left arm
      b.box(0.14, 0.2, 0.34, { slot: SLOT_FIXED, shade: 0xe6e0d0, pos: [0.29, 1.08, 0.02] });
      b.box(0.15, 0.03, 0.35, { slot: SLOT_FIXED, shade: 0x8a3a2a, pos: [0.29, 1.08, 0.02] });
      break;
    case 'newspaper': { // broadsheet held open at chest height (both arms at ≈ −1.0)
      b.box(0.62, 0.42, 0.02, { slot: SLOT_FIXED, shade: 0xeae4d4, pos: [0, 1.2, 0.46], rot: [-0.25, 0, 0] });
      b.box(0.02, 0.42, 0.03, { slot: SLOT_FIXED, shade: 0xb8b0a0, pos: [0, 1.2, 0.465], rot: [-0.25, 0, 0] });
      for (let i = 0; i < 3; i++) b.box(0.24, 0.02, 0.025, { slot: SLOT_FIXED, shade: 0x3a3632, pos: [-0.16, 1.33 - i * 0.09, 0.48 - i * 0.02], rot: [-0.25, 0, 0] });
      break;
    }
    case 'apron': // bib apron (white for bakers & publicans, leather for the smith — colour A)
      b.box(0.34, 0.5, 0.03, { slot: SLOT_A, pos: [0, 1.02, 0.17] });
      b.box(0.44, 0.34, 0.03, { slot: SLOT_A, pos: [0, 0.68, 0.2], rot: [0.08, 0, 0] });
      break;
    case 'satchel': // postman's bag on a cross strap
      b.box(0.12, 0.26, 0.3, { slot: SLOT_A, pos: [0.25, 0.9, 0.05] });
      b.box(0.04, 0.62, 0.05, { slot: SLOT_A, shade: 0.8, pos: [0.02, 1.15, 0.15], rot: [0, 0, -0.62] });
      break;
    case 'pipe': // clay pipe in the mouth (turns with the head)
      b.box(0.02, 0.02, 0.12, { slot: SLOT_FIXED, shade: 0xe8e0d0, rig: RIG_HEAD, pos: [-0.03, 1.55, 0.18] });
      b.box(0.04, 0.05, 0.04, { slot: SLOT_FIXED, shade: 0x5a3a2a, rig: RIG_HEAD, pos: [-0.03, 1.575, 0.25] });
      break;
    // ── tools ──
    case 'rod': // fishing rod held out over the water, line hanging from the tip
      b.armPosed('r', -0.8, () => {
        const h: [number, number, number] = [-0.273, 1.4 - 0.53 * Math.cos(0.8), 0.53 * Math.sin(0.8)];
        const tip: [number, number, number] = [h[0] - 0.05, h[1] + 3.0 * 0.57, h[2] + 3.0 * 0.82];
        b.stick([h[0], h[1] - 0.25 * 0.57, h[2] - 0.25 * 0.82], tip, 0.034, { slot: SLOT_FIXED, shade: 0x9a7a44 });
        b.cyl(0.04, 0.04, 0.05, 6, { slot: SLOT_FIXED, shade: 0x3a3a3a, pos: [h[0], h[1] - 0.1, h[2] - 0.05], rot: [0, 0, Math.PI / 2] });
        b.stick(tip, [tip[0], tip[1] - 2.6, tip[2] + 0.4], 0.01, { slot: SLOT_FIXED, shade: 0xe8e8e0 });
        b.box(0.08, 0.12, 0.08, { slot: SLOT_FIXED, shade: 0xd83a2a, pos: [tip[0], tip[1] - 2.62, tip[2] + 0.4] }); // float
      });
      break;
    case 'rodCarry': // rod sloped over the right shoulder, pointing back, and a creel at the hip
      b.stick([-0.2, 0.9, 0.35], [-0.24, 2.9, -1.4], 0.02, { slot: SLOT_FIXED, shade: 0x8a6a3a });
      b.box(0.14, 0.18, 0.26, { slot: SLOT_FIXED, shade: 0x9a7040, pos: [0.25, 0.85, -0.06] });
      b.box(0.15, 0.03, 0.27, { slot: SLOT_FIXED, shade: 0x6a4a2a, pos: [0.25, 0.95, -0.06] });
      break;
    case 'pole': // lamplighter's pole raised to a lamp head (≈3.8 m up, 1.3 m in front)
      b.armPosed('r', -1.45, () => {
        const a = 1.45;
        const h: [number, number, number] = [-0.273, 1.4 - 0.53 * Math.cos(a), 0.53 * Math.sin(a)];
        const d = [0, 0.95, 0.31];
        b.stick([h[0], h[1] - 0.3 * d[1], h[2] - 0.3 * d[2]], [h[0], h[1] + 2.5 * d[1], h[2] + 2.5 * d[2]], 0.022, { slot: SLOT_FIXED, shade: WOODC });
        b.box(0.07, 0.12, 0.07, { slot: SLOT_FIXED, shade: BRASS_C, pos: [h[0], h[1] + 2.55 * d[1], h[2] + 2.55 * d[2]] });
        b.box(0.04, 0.05, 0.04, { slot: SLOT_GLOW, shade: 0xffb050, pos: [h[0], h[1] + 2.66 * d[1], h[2] + 2.66 * d[2]] });
      });
      break;
    case 'poleCarry': // pole on the shoulder, sloping up and forward, tiny wick glowing
      b.stick([-0.22, 1.1, -0.9], [-0.2, 2.35, 1.5], 0.022, { slot: SLOT_FIXED, shade: WOODC });
      b.box(0.07, 0.12, 0.07, { slot: SLOT_FIXED, shade: BRASS_C, pos: [-0.2, 2.38, 1.54] });
      b.box(0.04, 0.05, 0.04, { slot: SLOT_GLOW, shade: 0xffb050, pos: [-0.2, 2.47, 1.58] });
      break;
    case 'ladder': { // short ladder carried on the left shoulder
      const y = 1.5, x = 0.24;
      for (const dx of [-0.13, 0.13]) b.stick([x + dx, y - 0.25, -1.1], [x + dx, y + 0.1, 1.0], 0.022, { slot: SLOT_FIXED, shade: WOODC });
      for (let i = 0; i < 6; i++) {
        const t = i / 5, z = -1.0 + 1.9 * t, yy = y - 0.23 + 0.32 * t;
        b.box(0.28, 0.025, 0.03, { slot: SLOT_FIXED, shade: 0x7a5a3a, pos: [x, yy, z] });
      }
      break;
    }
    case 'broom': // besom broom, head on the ground in front
      b.armPosed('r', -0.5, () => {
        const h: [number, number, number] = [-0.273, 1.4 - 0.53 * Math.cos(0.5), 0.53 * Math.sin(0.5)];
        b.stick([h[0], h[1] + 0.2, h[2] - 0.15], [-0.25, 0.22, 0.95], 0.02, { slot: SLOT_FIXED, shade: WOODC });
        b.cyl(0.02, 0.13, 0.32, 6, { slot: SLOT_FIXED, shade: 0x9a8050, pos: [-0.25, 0.12, 1.0], rot: [0.35, 0, 0] });
      });
      break;
    case 'hoop': { // hoop bowled beside a child, stick in the right hand
      const cx = -0.5, cy = 0.36, cz = 0.55, R = 0.34, n = 10;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        b.stick([cx, cy + Math.cos(a0) * R, cz + Math.sin(a0) * R], [cx, cy + Math.cos(a1) * R, cz + Math.sin(a1) * R], 0.02, { slot: SLOT_FIXED, shade: 0x8a6a40 });
      }
      b.stick([-0.28, 0.86, 0.05], [cx + 0.02, cy + 0.22, cz - 0.18], 0.012, { slot: SLOT_FIXED, shade: 0x5a4028 });
      break;
    }
    case 'stick': // a walking stick / hoop-less cane (right hand, tip on the ground ahead)
      b.armPosed('r', -0.25, () => {
        const h: [number, number, number] = [-0.273, 1.4 - 0.53 * Math.cos(0.25), 0.53 * Math.sin(0.25)];
        b.stick([h[0], h[1] + 0.05, h[2]], [-0.3, 0.02, h[2] + 0.35], 0.017, { slot: SLOT_FIXED, shade: 0x3a2a1c });
      });
      break;
    case 'pail': // milk pail / wash bucket at the left hand
      b.cyl(0.13, 0.1, 0.22, 7, { slot: SLOT_FIXED, shade: 0x9aa0a4, rig: RIG_LARM, pos: [0.3, 0.64, 0.04] });
      b.box(0.02, 0.18, 0.02, { slot: SLOT_FIXED, shade: 0x5a5a5a, rig: RIG_LARM, pos: [0.3, 0.8, 0.04] });
      break;
    case 'tray': // vendor's tray / baker's board of loaves held in front
      b.box(0.56, 0.04, 0.36, { slot: SLOT_FIXED, shade: 0x7a5a3a, pos: [0, 1.1, 0.42] });
      for (let i = 0; i < 4; i++) b.add(new THREE.IcosahedronGeometry(0.075, 0), { slot: SLOT_B, pos: [-0.19 + i * 0.13, 1.17, 0.42 + (i % 2 ? 0.06 : -0.06)], scale: [1.2, 0.8, 1] });
      b.box(0.02, 0.5, 0.02, { slot: SLOT_FIXED, shade: 0x5a4028, pos: [0.2, 1.3, 0.2], rot: [0.5, 0, 0.3] });
      b.box(0.02, 0.5, 0.02, { slot: SLOT_FIXED, shade: 0x5a4028, pos: [-0.2, 1.3, 0.2], rot: [0.5, 0, -0.3] });
      break;
    case 'hammer': // smith's hammer, head forward of the fist
      b.armPosed('r', -1.0, () => {
        const h: [number, number, number] = [-0.273, 1.4 - 0.53 * Math.cos(1.0), 0.53 * Math.sin(1.0)];
        b.stick([h[0], h[1], h[2] - 0.05], [h[0], h[1] + 0.05, h[2] + 0.42], 0.018, { slot: SLOT_FIXED, shade: WOODC });
        b.box(0.08, 0.16, 0.08, { slot: SLOT_FIXED, shade: IRONC, pos: [h[0], h[1] + 0.06, h[2] + 0.42] });
      });
      break;
    case 'pitchfork':
      b.armPosed('r', -0.9, () => {
        const h: [number, number, number] = [-0.273, 1.4 - 0.53 * Math.cos(0.9), 0.53 * Math.sin(0.9)];
        const tip: [number, number, number] = [h[0] + 0.05, 0.18, h[2] + 1.05];
        b.stick([h[0], h[1] + 0.45, h[2] - 0.4], tip, 0.02, { slot: SLOT_FIXED, shade: WOODC });
        for (const dx of [-0.06, 0.06]) b.stick([tip[0] + dx, tip[1] + 0.02, tip[2] - 0.02], [tip[0] + dx, tip[1] - 0.12, tip[2] + 0.18], 0.012, { slot: SLOT_FIXED, shade: 0x3a3a3a });
      });
      break;
    case 'crook': // shepherd's crook planted beside the right foot
      b.armPosed('r', -0.3, () => {
        const h: [number, number, number] = [-0.273, 1.4 - 0.53 * Math.cos(0.3), 0.53 * Math.sin(0.3)];
        b.stick([h[0] - 0.05, 0.03, h[2] + 0.15], [h[0] - 0.05, h[1] + 0.85, h[2] + 0.1], 0.02, { slot: SLOT_FIXED, shade: 0x6a4a2a });
        b.stick([h[0] - 0.05, h[1] + 0.85, h[2] + 0.1], [h[0] - 0.05, h[1] + 0.97, h[2] + 0.2], 0.02, { slot: SLOT_FIXED, shade: 0x6a4a2a });
        b.stick([h[0] - 0.05, h[1] + 0.97, h[2] + 0.2], [h[0] - 0.05, h[1] + 0.88, h[2] + 0.3], 0.02, { slot: SLOT_FIXED, shade: 0x6a4a2a });
      });
      break;
    case 'lantern': // hand lantern (glows at night)
      b.armPosed('l', -0.35, () => {
        const h: [number, number, number] = [0.273, 1.4 - 0.53 * Math.cos(0.35), 0.53 * Math.sin(0.35)];
        b.box(0.14, 0.18, 0.14, { slot: SLOT_FIXED, shade: 0x2a2a28, pos: [h[0], h[1] - 0.2, h[2] + 0.04] });
        b.box(0.1, 0.12, 0.155, { slot: SLOT_GLOW, shade: 0xffc060, pos: [h[0], h[1] - 0.2, h[2] + 0.04] });
        b.box(0.02, 0.1, 0.02, { slot: SLOT_FIXED, shade: 0x2a2a28, pos: [h[0], h[1] - 0.06, h[2] + 0.04] });
      });
      break;
    // ── fete ──
    case 'flag':
      b.cyl(0.012, 0.012, 0.55, 4, { slot: SLOT_FIXED, shade: 0x5a4632, rig: RIG_RARM, pos: [-0.27, 0.65, 0.03] });
      b.box(0.02, 0.2, 0.28, { slot: SLOT_A, rig: RIG_RARM, pos: [-0.27, 0.48, 0.17] });
      break;
    case 'instrument':
      b.add(new THREE.ConeGeometry(0.16, 0.3, 8, 1, true), { slot: SLOT_A, pos: [0, 1.32, 0.3], rot: [-Math.PI / 2 - 0.5, 0, 0] });
      b.cyl(0.035, 0.035, 0.45, 6, { slot: SLOT_A, shade: 0.8, pos: [0.0, 1.2, 0.22], rot: [0.3, 0, 0] });
      b.add(new THREE.TorusGeometry(0.11, 0.025, 4, 8), { slot: SLOT_A, shade: 0.9, pos: [0, 1.05, 0.2] });
      break;
    case 'bouquet':
      b.add(new THREE.IcosahedronGeometry(0.11, 0), { slot: SLOT_A, pos: [0, 1.02, 0.3] });
      b.add(new THREE.IcosahedronGeometry(0.06, 0), { slot: SLOT_C, pos: [0.06, 1.08, 0.36] });
      b.cyl(0.03, 0.015, 0.2, 5, { slot: SLOT_B, pos: [0, 0.88, 0.28] });
      break;
  }
}

/** geometry for one family mesh: every member prop tagged with its pid */
export function makeFamily(f: PropFamily): THREE.BufferGeometry {
  const b = new Builder();
  if (f === 'umbrella') addProp(b, 'umbrella');
  else if (f === 'trolley') addProp(b, 'trolley');
  else {
    for (const k of FAMILY_MEMBERS[f]) {
      b.pid = PROP_ID[k];
      addProp(b, k);
    }
  }
  return b.build();
}
