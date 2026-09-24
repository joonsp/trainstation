import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildRigGeometry, type RigPart } from '../core/rig';

/**
 * Low-poly vehicle geometry, authored as kind-masked InstancedRig parts: every body group is ONE rig
 * (one draw call) holding all its kinds; the vertex shader collapses parts whose kind ≠ the instance's kind
 * (iAux.x). Part id = sub·16 + p, p: 0 static · 2..4 exhaust puffs · 5 flywheel (spins about y).
 * Colour slots: 0 body paint · 1 trim / lining · 2 dark (iron, leather, roof) · 3 cargo / accent.
 * Body frame: +x forward, +z right, origin on the ground between the axles.
 */

type Slot = 0 | 1 | 2 | 3;

class PartList {
  parts: RigPart[] = [];
  constructor(public sub: number) {}
  private add(g: THREE.BufferGeometry, p: number, slot: Slot, pivot = new THREE.Vector3()) {
    this.parts.push({ geo: g, part: this.sub * 16 + p, pivot, slot });
  }
  box(slot: Slot, w: number, h: number, d: number, x: number, y: number, z: number, rz = 0, p = 0, pivot?: THREE.Vector3, ry = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rz) g.rotateZ(rz);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    this.add(g, p, slot, pivot ?? new THREE.Vector3(x, y, z));
  }
  /** mirrored pair at ±z */
  pair(slot: Slot, w: number, h: number, d: number, x: number, y: number, z: number, rz = 0) { this.box(slot, w, h, d, x, y, z, rz); this.box(slot, w, h, d, x, y, -z, rz); }
  /** cylinder along axis 'x' | 'y' | 'z' */
  cyl(slot: Slot, r: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', seg = 8, p = 0, r2 = r) {
    const g = new THREE.CylinderGeometry(r2, r, len, seg);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.add(g, p, slot, new THREE.Vector3(x, y, z));
  }
  puff(x: number, y: number, z: number, k: number) {
    const g = new THREE.IcosahedronGeometry(0.16, 0);
    g.translate(x, y, z);
    this.add(g, 2 + k, 2, new THREE.Vector3(x, y, z));
  }
  /** shafts alongside a single horse from x0 to x1 */
  shafts(slot: Slot, x0: number, x1: number, y: number, z = 0.42) {
    this.pair(slot, x1 - x0, 0.07, 0.07, (x0 + x1) / 2, y, z, -0.05);
    this.box(slot, 0.07, 0.07, z * 2 + 0.07, x0 + 0.1, y - 0.05, 0);
  }
  /** a pole between a pair of horses */
  pole(slot: Slot, x0: number, x1: number, y: number) {
    this.box(slot, x1 - x0, 0.08, 0.08, (x0 + x1) / 2, y, 0, -0.04);
    this.box(slot, 0.08, 0.08, 1.3, x1 - 0.3, y + 0.05, 0);
  }
  lamp(x: number, y: number, z: number) { this.box(2, 0.16, 0.24, 0.16, x, y, z); this.box(2, 0.06, 0.2, 0.06, x - 0.02, y - 0.2, z); }
}

// ───────────────────────── group 0: carriages ─────────────────────────
function hansom(): RigPart[] {
  const P = new PartList(0);
  P.box(0, 1.25, 1.3, 1.24, -0.15, 1.42, 0);            // cab
  P.box(2, 0.3, 0.5, 1.26, -0.28, 1.75, 0);             // side windows (dark band)
  P.box(1, 1.27, 0.05, 1.26, -0.15, 1.12, 0);           // lining
  P.box(2, 1.45, 0.1, 1.36, -0.12, 2.12, 0, 0.04);      // roof
  P.box(0, 0.08, 0.62, 1.2, 0.5, 1.05, 0);              // folding doors
  P.box(2, 0.05, 0.5, 1.1, 0.48, 1.7, 0);               // front glass (dark)
  P.box(2, 0.7, 0.06, 1.12, 0.78, 0.66, 0);             // footboard
  P.box(0, 0.06, 0.38, 1.12, 1.12, 0.85, 0, 0.35);      // splash board
  P.box(2, 0.12, 0.12, 1.75, 0, 0.84, 0);               // axle
  P.pair(2, 1.2, 0.08, 0.08, -0.1, 0.78, 0.55);         // springs
  P.box(2, 0.46, 0.12, 0.56, -1.25, 2.26, 0);           // driver's perch
  P.box(0, 0.12, 1.1, 0.14, -1.0, 1.72, 0, -0.25);      // perch stay
  P.box(0, 0.35, 0.9, 0.9, -0.95, 1.4, 0);              // rear panel
  P.shafts(2, 0.55, 3.15, 1.12);
  P.lamp(0.7, 1.9, 0.72); P.lamp(0.7, 1.9, -0.72);
  return P.parts;
}
function growler(): RigPart[] {
  const P = new PartList(1);
  P.box(0, 1.8, 1.3, 1.4, -0.3, 1.47, 0);               // cabin
  P.box(2, 0.6, 0.46, 1.43, -0.55, 1.72, 0);            // side windows
  P.box(2, 1.83, 0.46, 0.9, -0.3, 1.72, 0);             // front/back windows
  P.box(1, 1.83, 0.05, 1.43, -0.3, 1.22, 0);            // lining
  P.box(2, 1.95, 0.1, 1.5, -0.3, 2.16, 0);              // roof
  P.box(3, 0.9, 0.34, 0.95, -0.45, 2.38, 0);            // trunk on the roof
  P.box(2, 0.95, 0.05, 1.0, -0.45, 2.21, 0);            // roof rail base
  P.box(0, 0.62, 0.58, 1.2, 0.9, 1.52, 0);              // driver's box
  P.box(2, 0.46, 0.1, 1.05, 1.12, 1.87, 0);             // box cushion
  P.box(2, 0.55, 0.06, 1.2, 1.45, 1.25, 0);             // footboard
  P.box(0, 0.06, 0.35, 1.2, 1.55, 1.45, 0);             // dash
  P.box(0, 0.5, 0.45, 1.2, -1.45, 1.15, 0);             // boot
  P.box(2, 3.1, 0.12, 0.5, -0.1, 0.72, 0);              // perch
  P.box(2, 0.12, 0.12, 1.55, 1.0, 0.5, 0); P.box(2, 0.12, 0.12, 1.6, -0.8, 0.66, 0); // axles
  P.shafts(2, 1.3, 3.75, 1.02);
  P.lamp(1.35, 1.75, 0.8); P.lamp(1.35, 1.75, -0.8);
  return P.parts;
}
function landau(): RigPart[] {
  const P = new PartList(2);
  P.box(0, 2.3, 0.55, 1.42, -0.4, 1.0, 0);              // boat body
  P.box(0, 0.5, 0.3, 1.3, -1.5, 1.2, 0, 0.3);           // raised rear
  P.box(1, 2.32, 0.06, 1.44, -0.4, 1.28, 0);            // gilt line
  P.box(2, 0.52, 0.2, 1.2, -0.85, 1.35, 0);             // rear seat
  P.box(2, 0.12, 0.42, 1.2, -1.15, 1.6, 0);             // rear seat back
  P.box(2, 0.52, 0.2, 1.2, 0.3, 1.35, 0);               // front seat
  P.box(2, 0.12, 0.42, 1.2, 0.6, 1.6, 0);               // front seat back
  P.box(2, 0.42, 0.28, 1.38, -1.4, 1.6, 0);             // folded hood (rear)
  P.box(2, 0.36, 0.24, 1.38, 0.78, 1.52, 0);            // folded hood (front)
  P.box(0, 0.6, 0.6, 1.12, 1.35, 1.55, 0);              // driver's box
  P.box(2, 0.5, 0.1, 1.0, 1.4, 1.9, 0);                 // box cushion
  P.box(2, 0.08, 0.4, 1.1, 1.75, 1.5, 0);               // dash
  P.box(2, 0.45, 0.06, 1.05, -2.0, 1.78, 0);            // footman's board
  P.box(2, 3.6, 0.1, 0.26, -0.1, 0.64, 0);              // perch
  P.box(2, 0.12, 0.12, 1.55, 1.1, 0.55, 0); P.box(2, 0.12, 0.12, 1.6, -0.9, 0.72, 0);
  P.pole(2, 1.7, 4.3, 0.98);
  P.lamp(1.6, 1.8, 0.85); P.lamp(1.6, 1.8, -0.85);
  return P.parts;
}
function gig(): RigPart[] {
  const P = new PartList(3);
  P.box(0, 1.5, 0.55, 1.2, -0.3, 1.05, 0);              // dog-cart box
  P.box(2, 1.52, 0.18, 1.22, -0.3, 0.95, 0);            // louvres (dark band)
  P.box(2, 0.5, 0.12, 1.1, 0.05, 1.3, 0);               // front seat
  P.box(2, 0.08, 0.36, 1.1, -0.22, 1.5, 0);             // back-to-back rest
  P.box(2, 0.45, 0.12, 1.0, -0.65, 1.3, 0);             // rear seat
  P.pair(2, 0.9, 0.05, 0.3, -0.1, 1.6, 0.8);            // mudguards
  P.box(2, 0.12, 0.12, 1.7, -0.1, 0.78, 0);
  P.shafts(0, 0.4, 3.0, 1.02, 0.4);
  P.lamp(0.55, 1.35, 0.7); P.lamp(0.55, 1.35, -0.7);
  return P.parts;
}
function mailcart(): RigPart[] {
  const P = new PartList(4);
  P.box(0, 2.0, 1.2, 1.3, -0.65, 1.38, 0);              // enclosed mail box
  P.box(1, 2.02, 0.08, 1.32, -0.65, 1.08, 0);           // gold lining
  P.box(1, 0.02, 0.3, 0.3, -0.65, 1.5, 0.66);           // cypher (VR) panel
  P.box(1, 0.02, 0.3, 0.3, -0.65, 1.5, -0.66);
  P.box(2, 2.12, 0.1, 1.42, -0.65, 2.02, 0, 0.03);      // roof
  P.box(2, 0.46, 0.12, 1.0, 0.52, 1.65, 0);             // driver's seat
  P.box(2, 0.08, 0.36, 1.1, 0.95, 1.45, 0);             // dash
  P.box(2, 0.12, 0.12, 1.7, -0.2, 0.8, 0);
  P.shafts(2, 0.7, 3.25, 1.08);
  P.lamp(0.9, 1.7, 0.75); P.lamp(0.9, 1.7, -0.75);
  return P.parts;
}

// ───────────────────────── group 1: big vehicles ─────────────────────────
function omnibus(): RigPart[] {
  const P = new PartList(0);
  P.box(0, 4.4, 1.5, 1.9, -0.95, 1.66, 0);              // lower saloon
  P.box(2, 3.7, 0.48, 1.93, -0.9, 2.05, 0);             // windows
  P.box(1, 4.42, 0.24, 1.93, -0.95, 2.36, 0);           // cream letter board
  P.box(1, 4.42, 0.06, 1.93, -0.95, 1.2, 0);            // lining
  P.box(2, 4.7, 0.08, 2.05, -0.95, 2.51, 0);            // roof
  P.box(3, 4.3, 0.34, 0.05, -0.95, 2.72, 1.0);          // advertising boards
  P.box(3, 4.3, 0.34, 0.05, -0.95, 2.72, -1.0);
  P.box(1, 4.0, 0.62, 0.07, -0.25, 3.28, 0);            // knifeboard back
  P.pair(1, 4.0, 0.08, 0.34, -0.25, 2.98, 0.26);        // knifeboard seats
  P.box(2, 4.0, 0.36, 0.2, -0.25, 2.75, 0);             // bench support
  P.box(0, 0.25, 1.05, 1.5, 1.35, 2.05, 0);             // front bulkhead
  P.box(2, 0.7, 0.1, 1.1, 1.85, 2.62, 0);               // driver's seat
  P.box(2, 0.55, 0.06, 1.3, 2.2, 2.08, 0);              // footboard
  P.box(0, 0.06, 0.45, 1.3, 2.42, 2.3, 0);              // dash
  P.box(2, 0.8, 0.08, 1.25, -3.55, 0.55, 0);            // rear platform
  P.box(2, 0.1, 2.35, 0.45, -3.55, 1.65, 0.62, 0.32);   // stair to the roof
  P.box(2, 0.05, 2.0, 0.05, -3.9, 1.55, -0.58);         // grab pole
  P.box(2, 0.05, 0.5, 1.9, -3.2, 2.8, 0);               // rear rail
  P.box(2, 4.6, 0.12, 0.6, -0.7, 0.76, 0);              // undercarriage
  P.box(2, 0.12, 0.12, 1.95, 1.45, 0.55, 0); P.box(2, 0.12, 0.12, 2.05, -1.35, 0.75, 0);
  P.pole(2, 2.3, 5.4, 1.0);
  P.lamp(2.2, 2.2, 1.0); P.lamp(2.2, 2.2, -1.0); P.lamp(-3.3, 1.9, 0.9);
  return P.parts;
}
function fireengine(): RigPart[] {
  const P = new PartList(1);
  P.box(0, 4.2, 0.25, 1.4, -0.35, 1.05, 0);             // chassis
  P.cyl(3, 0.42, 1.5, -1.4, 1.95, 0, 'y', 10);          // brass boiler
  P.cyl(2, 0.16, 0.6, -1.4, 3.0, 0, 'y', 8, 0, 0.24);   // chimney
  P.box(3, 0.6, 0.5, 0.95, -0.35, 1.45, 0);             // pump
  P.cyl(3, 0.1, 0.9, -0.35, 1.95, 0, 'y', 6);           // air vessel
  P.box(0, 1.1, 0.45, 1.3, 0.75, 1.38, 0);              // hose box
  P.box(2, 1.0, 0.1, 1.45, 0.7, 1.62, 0);               // crew seats
  P.box(1, 1.12, 0.06, 1.32, 0.75, 1.2, 0);
  P.box(2, 0.45, 0.12, 1.0, 1.6, 1.8, 0);               // driver's seat
  P.box(0, 0.08, 0.4, 1.1, 1.95, 1.55, 0);
  P.box(2, 0.55, 0.06, 1.2, -2.45, 0.8, 0);             // footplate
  P.box(2, 0.12, 0.12, 1.85, 1.3, 0.55, 0); P.box(2, 0.12, 0.12, 1.95, -1.1, 0.8, 0);
  P.pole(2, 1.9, 5.0, 1.0);
  P.lamp(1.8, 1.6, 0.9); P.lamp(1.8, 1.6, -0.9);
  return P.parts;
}
function circus(): RigPart[] {
  const P = new PartList(2);
  P.box(0, 4.8, 2.1, 2.0, -0.45, 1.95, 0);              // wagon body
  P.box(3, 3.9, 1.2, 2.03, -0.45, 1.95, 0);             // painted panels
  P.box(1, 4.9, 0.18, 2.06, -0.45, 3.02, 0);            // gilt cornice
  P.box(1, 4.9, 0.16, 2.06, -0.45, 0.92, 0);            // gilt skirt
  P.box(1, 5.0, 0.22, 2.1, -0.45, 3.15, 0);             // roof
  P.box(2, 0.1, 1.2, 2.04, -0.45, 1.95, 0);             // panel divider
  P.box(0, 0.5, 0.55, 1.3, 2.05, 2.05, 0);              // driver's box
  P.box(2, 0.45, 0.1, 1.2, 2.1, 2.36, 0);
  P.box(2, 4.6, 0.12, 0.6, -0.4, 0.78, 0);
  P.box(2, 0.12, 0.12, 2.05, 1.4, 0.6, 0); P.box(2, 0.12, 0.12, 2.05, -1.4, 0.75, 0);
  P.pole(2, 2.3, 5.4, 1.0);
  P.lamp(2.3, 2.0, 1.0); P.lamp(2.3, 2.0, -1.0);
  return P.parts;
}
function dray(): RigPart[] {
  const P = new PartList(3);
  P.box(0, 4.2, 0.18, 1.8, -0.4, 1.28, 0);              // bed
  P.pair(1, 4.2, 0.28, 0.08, -0.4, 1.5, 0.9);           // side rails
  for (let i = 0; i < 5; i++) for (const z of [0.44, -0.44]) P.cyl(3, 0.33, 0.78, -2.2 + i * 0.72, 1.7, z, 'z', 8);
  for (let i = 0; i < 3; i++) P.cyl(3, 0.33, 0.78, -1.85 + i * 0.72, 2.3, 0, 'z', 8);
  for (let i = 0; i < 5; i++) P.box(2, 0.05, 0.68, 1.68, -2.2 + i * 0.72, 1.7, 0); // hoops
  P.box(0, 0.5, 0.62, 1.5, 1.8, 1.7, 0);                // driver's seat box
  P.box(2, 0.46, 0.12, 1.4, 1.8, 2.04, 0);
  P.box(2, 0.08, 0.3, 1.5, 2.1, 1.95, 0);
  P.box(2, 0.12, 0.12, 1.95, 1.35, 0.62, 0); P.box(2, 0.12, 0.12, 2.0, -1.3, 0.82, 0);
  P.pole(2, 2.2, 5.6, 1.05);
  P.lamp(1.9, 1.9, 0.95); P.lamp(1.9, 1.9, -0.95);
  return P.parts;
}
function haywain(): RigPart[] {
  const P = new PartList(4);
  P.box(0, 4.4, 0.2, 1.8, -0.5, 1.32, 0);               // bed
  P.pair(0, 4.4, 0.35, 0.08, -0.5, 1.55, 0.95);         // sides
  P.box(0, 0.1, 1.0, 2.1, 1.8, 1.9, 0);                 // front ladder
  P.box(0, 0.1, 1.0, 2.1, -2.75, 1.9, 0);               // rear ladder
  P.box(3, 4.3, 1.55, 2.35, -0.5, 2.3, 0);              // hay load
  P.box(3, 3.9, 0.45, 2.0, -0.5, 3.2, 0);               // rounded top
  P.box(3, 3.2, 0.2, 1.4, -0.5, 3.5, 0);
  P.box(2, 0.45, 0.1, 1.2, 1.9, 1.6, 0);                // front board
  P.box(2, 0.12, 0.12, 1.95, 1.35, 0.62, 0); P.box(2, 0.12, 0.12, 2.05, -1.35, 0.85, 0);
  P.pole(2, 2.2, 5.5, 1.05);
  return P.parts;
}

// ───────────────────────── group 2: carts, cycles, motor ─────────────────────────
function coalcart(): RigPart[] {
  const P = new PartList(0);
  P.box(0, 2.3, 0.7, 1.6, -0.5, 1.3, 0);                // box
  P.box(1, 2.32, 0.08, 1.62, -0.5, 1.62, 0);            // top rail
  for (let i = 0; i < 3; i++) for (const z of [0.36, -0.36]) P.box(3, 0.48, 0.5, 0.58, -1.2 + i * 0.62, 1.82, z, 0.1 * (i - 1));
  P.box(3, 1.0, 0.3, 0.9, -0.6, 2.2, 0);
  P.box(2, 0.42, 0.08, 0.6, 0.92, 1.48, -0.25);         // driver's board
  P.box(2, 0.12, 0.12, 1.85, -0.35, 0.78, 0);
  P.shafts(0, 0.65, 3.4, 1.12);
  return P.parts;
}
function farmcart(): RigPart[] {
  const P = new PartList(1);
  P.box(0, 2.4, 0.6, 1.7, -0.45, 1.3, 0);               // tumbril box
  P.pair(0, 2.4, 0.3, 0.08, -0.45, 1.7, 0.95, 0);       // flared sides
  P.box(3, 1.9, 0.45, 1.5, -0.55, 1.75, 0);             // load (sacks / turnips)
  P.box(3, 0.6, 0.3, 0.6, -1.0, 2.05, 0.3);
  P.box(3, 0.6, 0.3, 0.6, -0.2, 2.05, -0.35);
  P.box(2, 0.42, 0.08, 0.6, 0.9, 1.48, -0.3);
  P.box(2, 0.12, 0.12, 1.95, -0.3, 0.8, 0);
  P.shafts(0, 0.75, 3.5, 1.12);
  return P.parts;
}
function milkfloat(): RigPart[] {
  const P = new PartList(2);
  P.box(2, 2.2, 0.08, 1.3, -0.5, 0.6, 0);               // low floor (cranked axle)
  P.pair(0, 2.2, 0.55, 0.06, -0.5, 0.92, 0.65);         // side panels
  P.box(0, 0.08, 0.8, 1.3, 0.58, 1.05, 0, 0.2);         // curved dash
  P.box(1, 2.22, 0.06, 1.32, -0.5, 1.12, 0);            // lining
  for (const [x, z] of [[0.15, 0.3], [0.15, -0.3], [-0.35, 0.3], [-0.35, -0.3]] as const) {
    P.cyl(3, 0.2, 0.62, x, 0.95, z, 'y', 8, 0, 0.14);
    P.cyl(3, 0.12, 0.12, x, 1.32, z, 'y', 6);
  }
  P.box(2, 0.1, 0.1, 1.6, -0.25, 0.66, 0);
  P.box(2, 0.3, 0.05, 0.6, -1.65, 0.35, 0);             // rear step
  P.shafts(0, 0.55, 2.95, 0.98, 0.38);
  P.lamp(0.5, 1.2, 0.65); P.lamp(0.5, 1.2, -0.65);
  return P.parts;
}
function handcart(): RigPart[] {
  const P = new PartList(3);
  P.box(0, 1.6, 0.55, 0.9, 0.2, 0.98, 0);
  P.box(1, 1.64, 0.08, 0.94, 0.2, 1.28, 0);
  P.box(3, 1.2, 0.2, 0.7, 0.2, 1.4, 0);
  P.pair(2, 1.1, 0.05, 0.05, -1.1, 0.95, 0.35);
  P.box(2, 0.1, 0.1, 1.0, 0, 0.45, 0);
  return P.parts;
}
function bicycle(): RigPart[] {
  const P = new PartList(4);
  P.box(0, 0.62, 0.04, 0.04, 0.05, 0.86, 0);            // top tube
  P.box(0, 0.7, 0.04, 0.04, 0.1, 0.6, 0, 0.6);          // down tube
  P.box(0, 0.05, 0.55, 0.04, -0.2, 0.62, 0, 0.25);      // seat tube
  P.box(0, 0.55, 0.035, 0.1, -0.38, 0.36, 0, -0.1);     // chain stays
  P.box(0, 0.05, 0.75, 0.05, 0.47, 0.72, 0, -0.3);      // fork
  P.box(1, 0.06, 0.05, 0.5, 0.42, 1.08, 0);             // handlebar
  P.box(3, 0.24, 0.06, 0.14, -0.22, 0.97, 0);           // saddle
  P.cyl(1, 0.09, 0.03, -0.12, 0.34, 0, 'z', 8);         // chainring
  return P.parts;
}
function pennyfarthing(): RigPart[] {
  const P = new PartList(5);
  P.box(0, 0.06, 0.9, 0.05, -0.2, 1.05, 0, 1.05);       // backbone (upper)
  P.box(0, 0.06, 0.6, 0.05, -0.58, 0.52, 0, 0.55);      // backbone (lower)
  P.box(0, 0.05, 0.25, 0.05, 0.3, 1.5, 0);              // head
  P.box(1, 0.05, 0.05, 0.6, 0.36, 1.62, 0);             // handlebar
  P.box(3, 0.22, 0.06, 0.13, 0.1, 1.5, 0);              // saddle
  return P.parts;
}
function motorwagen(): RigPart[] {
  const P = new PartList(6);
  P.pair(2, 2.1, 0.05, 0.05, -0.1, 0.55, 0.45);         // tubular frame
  P.box(2, 0.05, 0.05, 0.95, 0.9, 0.5, 0);
  P.box(0, 0.62, 0.2, 0.92, -0.15, 0.82, 0);            // seat box
  P.box(3, 0.55, 0.12, 0.86, -0.15, 0.98, 0);           // leather bench
  P.box(3, 0.1, 0.42, 0.86, -0.42, 1.2, 0);             // back
  P.box(0, 0.62, 0.36, 0.7, -0.95, 0.7, 0);             // engine / crankcase
  P.cyl(2, 0.12, 0.45, -0.85, 0.98, 0.2, 'y', 8);       // cylinder
  P.cyl(1, 0.3, 0.05, -1.08, 0.42, 0, 'y', 10, 5);      // flywheel (spins)
  P.box(2, 0.05, 0.62, 0.05, 0.4, 1.12, 0, -0.35);      // steering column
  P.box(1, 0.04, 0.04, 0.3, 0.5, 1.42, 0);              // tiller handle
  P.box(2, 0.06, 0.45, 0.05, 1.02, 0.52, 0, -0.35);     // front fork
  P.box(0, 0.5, 0.05, 0.9, 0.55, 0.62, 0);              // footboard
  P.cyl(2, 0.05, 0.3, -1.3, 0.62, 0.28, 'x', 6);        // exhaust stub
  for (let k = 0; k < 3; k++) P.puff(-1.48, 0.62, 0.28, k);
  P.lamp(0.75, 1.1, 0.35); P.lamp(0.75, 1.1, -0.35);
  return P.parts;
}

export const GROUP_GEOMS: (() => THREE.BufferGeometry)[] = [
  () => buildRigGeometry([...hansom(), ...growler(), ...landau(), ...gig(), ...mailcart()]),
  () => buildRigGeometry([...omnibus(), ...fireengine(), ...circus(), ...dray(), ...haywain()]),
  () => buildRigGeometry([...coalcart(), ...farmcart(), ...milkfloat(), ...handcart(), ...bicycle(), ...pennyfarthing(), ...motorwagen()]),
];

/** body rig pose: kind mask, exhaust puffs (anim.x phase, anim.y strength), flywheel (anim.z angle), shake (anim.w) */
export const BODY_POSE_GLSL = /* glsl */ `
void rigPose(float part, vec3 pivot, vec4 anim, vec4 aux, inout vec3 p) {
  float sub = floor(part / 16.0 + 0.001);
  float pp = part - sub * 16.0;
  if (abs(sub - aux.x) > 0.5) { p = vec3(0.0); return; }
  if (pp > 1.5 && pp < 4.5) {
    float ph = fract(anim.x + (pp - 2.0) / 3.0);
    vec3 q = (p - pivot) * mix(0.5, 2.2, ph) * (1.0 - smoothstep(0.7, 1.0, ph)) * anim.y;
    p = pivot + q + vec3(-ph * 1.2, ph * 0.9, ph * 0.25);
    return;
  }
  if (pp > 4.5 && pp < 5.5) p = rigAbout(p, pivot, vec3(0.0, anim.z, 0.0));
  p.y += anim.w * sin(anim.x * 40.0 + p.x * 3.0) * 0.012;
}`;

// ───────────────────────── wheels ─────────────────────────
let wheelCache: THREE.BufferGeometry | null = null;
/** unit-radius spoked wheel in the xy plane (axle along z); slot 0 = paint, slot 1 = iron tyre / hub */
export function wheelGeometry(): THREE.BufferGeometry {
  if (wheelCache) return wheelCache;
  const tyre = new THREE.TorusGeometry(0.93, 0.075, 3, 12);
  const felloe = new THREE.TorusGeometry(0.83, 0.06, 3, 12);
  const spokes: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) { const g = new THREE.BoxGeometry(1.66, 0.055, 0.045); g.rotateZ((i * Math.PI) / 4); spokes.push(g); }
  const hub = new THREE.CylinderGeometry(0.13, 0.13, 0.22, 6); hub.rotateX(Math.PI / 2);
  const parts: RigPart[] = [
    { geo: tyre, part: 0, pivot: new THREE.Vector3(), slot: 1 },
    { geo: felloe, part: 0, pivot: new THREE.Vector3(), slot: 0 },
    { geo: mergeGeometries(spokes.map((g) => g.toNonIndexed()))!, part: 0, pivot: new THREE.Vector3(), slot: 0 },
    { geo: hub, part: 0, pivot: new THREE.Vector3(), slot: 1 },
  ];
  wheelCache = buildRigGeometry(parts);
  return wheelCache;
}
/** wheel spin: anim.x = roll angle (radians) about the axle (z) */
export const WHEEL_POSE_GLSL = /* glsl */ `
void rigPose(float part, vec3 pivot, vec4 anim, vec4 aux, inout vec3 p) {
  p = rigRotZ(p, -anim.x);
}`;

// ───────────────────────── level crossing (gates + gate signals) ─────────────────────────
/** sub 0 = gate leaf (local +x along the leaf from the hinge), sub 1 = gate signal post with a pivoting arm */
export function crossingGeometry(leafLen: number): THREE.BufferGeometry {
  const G = new PartList(0);
  const L = leafLen;
  G.box(0, L, 0.13, 0.1, L / 2, 1.22, 0);               // top rail
  G.box(0, L - 0.2, 0.09, 0.08, L / 2 + 0.1, 0.42, 0);  // bottom rail
  G.box(0, L - 0.2, 0.08, 0.08, L / 2 + 0.1, 0.82, 0);  // mid rail
  G.box(0, 0.16, 1.3, 0.12, 0.08, 0.72, 0);             // hanging stile
  for (let i = 1; i <= 4; i++) G.box(0, 0.06, 0.82, 0.07, (L * i) / 4.4, 0.82, 0);
  G.box(0, Math.hypot(L * 0.5, 0.8), 0.07, 0.07, L * 0.27, 0.82, 0, Math.atan2(0.8, L * 0.5));
  G.box(1, 0.56, 0.56, 0.14, L * 0.55, 0.9, 0, Math.PI / 4); // red target
  G.box(2, 0.2, 0.26, 0.2, L * 0.55, 1.42, 0);          // lamp housing
  const S = new PartList(1);
  S.box(0, 0.2, 5.6, 0.2, 0, 2.8, 0);                   // post
  S.box(2, 0.3, 0.3, 0.3, 0, 5.72, 0);                  // finial cap
  S.box(2, 0.1, 0.4, 0.1, 0, 5.95, 0);
  const piv = new THREE.Vector3(0, 5.0, 0.16);
  S.box(1, 1.35, 0.24, 0.05, 0.72, 5.0, 0.16, 0, 1, piv); // arm (red, pivots)
  S.box(0, 0.12, 0.25, 0.06, 1.05, 5.0, 0.16, 0, 1, piv); // white band
  S.box(2, 0.28, 0.32, 0.26, 0.05, 4.55, 0.2);          // lamp case
  S.box(2, 0.05, 4.2, 0.35, 0, 2.3, -0.25);             // ladder (flat)
  return buildRigGeometry([...G.parts, ...S.parts]);
}
/** anim.x = signal arm angle (0 horizontal = danger, −0.7 lowered = clear) */
export const CROSSING_POSE_GLSL = /* glsl */ `
void rigPose(float part, vec3 pivot, vec4 anim, vec4 aux, inout vec3 p) {
  float sub = floor(part / 16.0 + 0.001);
  float pp = part - sub * 16.0;
  if (abs(sub - aux.x) > 0.5) { p = vec3(0.0); return; }
  if (pp > 0.5 && pp < 1.5) p = rigAbout(p, pivot, vec3(0.0, 0.0, anim.x));
}`;
