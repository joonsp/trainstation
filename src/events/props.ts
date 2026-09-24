/**
 * Low-poly props for station events. Each prop is mostly ONE merged vertex-coloured mesh; parts that
 * animate (wings, legs, trunk, flame) are separate children. Local +x = "forward" for creatures.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PB, glowMat, vcMat } from './fx';

const P = Math.PI;
const WHITE = 0xf2efe6, ORANGE = 0xe0892a, BLACK = 0x1c1c1c, BRASS = 0xc9a24a, CREAM = 0xe8dcc0, CRIMSON = 0x8e1f2c, IRON = 0x1f2e27;

// ───────────────────────── goose ─────────────────────────
export interface Goose { root: THREE.Group; wingL: THREE.Object3D; wingR: THREE.Object3D; body: THREE.Object3D; neck: THREE.Object3D }
export function buildGoose(): Goose {
  const root = new THREE.Group();
  const bodyG = new THREE.Group();
  root.add(bodyG);
  const b = new PB();
  b.ball(0.3, WHITE, [0, 0.46, 0], [1.5, 0.92, 1], 1)
    .ball(0.22, WHITE, [0.24, 0.5, 0], 1, 1)
    .cone(0.13, 0.28, 0xcfcac0, [-0.48, 0.55, 0], [0, 0, P / 2 + 0.3])
    .box(0.05, 0.32, 0.05, ORANGE, [0.05, 0.16, 0.09]).box(0.05, 0.32, 0.05, ORANGE, [0.05, 0.16, -0.09])
    .box(0.16, 0.025, 0.12, ORANGE, [0.1, 0.012, 0.09]).box(0.16, 0.025, 0.12, ORANGE, [0.1, 0.012, -0.09]);
  bodyG.add(b.mesh());
  const neckG = new THREE.Group();
  neckG.position.set(0.34, 0.6, 0);
  const n = new PB();
  n.cyl(0.055, 0.08, 0.48, WHITE, [0.06, 0.2, 0], [0, 0, -0.3])
    .ball(0.1, WHITE, [0.14, 0.46, 0], [1.35, 1, 1], 1)
    .cone(0.045, 0.17, ORANGE, [0.3, 0.44, 0], [0, 0, -P / 2])
    .ball(0.022, BLACK, [0.2, 0.5, 0.07]).ball(0.022, BLACK, [0.2, 0.5, -0.07]);
  neckG.add(n.mesh());
  bodyG.add(neckG);
  const wing = (side: number) => {
    const piv = new THREE.Group();
    piv.position.set(0.02, 0.6, 0.2 * side);
    const w = new PB();
    w.box(0.5, 0.05, 0.3, 0xdcd8ce, [0, 0, 0.15 * side]).box(0.3, 0.04, 0.22, 0xb8b4aa, [-0.25, -0.01, 0.13 * side]);
    piv.add(w.mesh());
    bodyG.add(piv);
    return piv;
  };
  const wingL = wing(1), wingR = wing(-1);
  root.scale.setScalar(1.35);
  return { root, wingL, wingR, body: bodyG, neck: neckG };
}

// ───────────────────────── cat ─────────────────────────
export function buildCat(): THREE.Group {
  const root = new THREE.Group();
  const G = 0xc9772e, D = 0x9a5520, W = 0xf0e6d6;
  const b = new PB();
  b.ball(0.28, G, [0, 0.17, 0], [1.3, 0.62, 1.05], 1)
    .ball(0.15, G, [0.3, 0.19, 0.14], [1.05, 0.9, 1], 1)
    .ball(0.08, W, [0.4, 0.15, 0.17], [0.8, 0.7, 1], 0)
    .cone(0.055, 0.1, G, [0.31, 0.34, 0.06], [0.3, 0, 0], 4).cone(0.055, 0.1, G, [0.31, 0.34, 0.23], [-0.3, 0, 0], 4)
    .add(new THREE.TorusGeometry(0.27, 0.05, 5, 10, P * 1.05), G, [0, 0.07, 0], [P / 2, 0, 0.2])
    .ball(0.06, D, [0.26, 0.07, -0.03])
    .box(0.05, 0.05, 0.36, D, [-0.12, 0.32, 0]).box(0.05, 0.05, 0.36, D, [0.02, 0.33, 0]).box(0.05, 0.05, 0.32, D, [-0.26, 0.28, 0]);
  root.add(b.mesh());
  root.scale.setScalar(1.6);
  return root;
}

// ───────────────────────── cow ─────────────────────────
export interface Cow { root: THREE.Group; head: THREE.Object3D; legs: THREE.Object3D[]; tail: THREE.Object3D }
export function buildCow(): Cow {
  const root = new THREE.Group();
  const W = 0xeee8dc, K = 0x2a2624, PINK = 0xe4a49a;
  const b = new PB();
  b.box(1.9, 0.95, 0.86, W, [0, 1.25, 0])
    .box(0.62, 0.52, 0.03, K, [0.3, 1.36, 0.44]).box(0.5, 0.45, 0.03, K, [-0.5, 1.16, -0.44]).box(0.4, 0.4, 0.03, K, [-0.45, 1.3, 0.44])
    .box(0.7, 0.03, 0.5, K, [-0.2, 1.735, 0.05]).box(0.36, 0.03, 0.3, K, [0.55, 1.735, -0.15])
    .ball(0.17, PINK, [-0.45, 0.72, 0], [1.1, 0.8, 1]);
  root.add(b.mesh());
  const head = new THREE.Group();
  head.position.set(0.92, 1.5, 0);
  const h = new PB();
  h.box(0.5, 0.44, 0.42, W, [0.28, 0, 0]).box(0.2, 0.2, 0.3, K, [0.2, 0.12, 0.12])
    .box(0.2, 0.26, 0.38, PINK, [0.6, -0.08, 0])
    .cone(0.05, 0.24, CREAM, [0.26, 0.3, 0.2], [0.6, 0, 0], 5).cone(0.05, 0.24, CREAM, [0.26, 0.3, -0.2], [-0.6, 0, 0], 5)
    .box(0.1, 0.06, 0.22, W, [0.22, 0.12, 0.3]).box(0.1, 0.06, 0.22, W, [0.22, 0.12, -0.3])
    .ball(0.035, BLACK, [0.44, 0.08, 0.21]).ball(0.035, BLACK, [0.44, 0.08, -0.21])
    .ball(0.09, BRASS, [0.12, -0.34, 0], 1, 0).cyl(0.2, 0.2, 0.04, 0x5a3a26, [0.1, -0.22, 0], [0, 0, P / 2 - 0.3], 8);
  head.add(h.mesh());
  root.add(head);
  const legGeo = new PB().box(0.17, 0.78, 0.17, W, [0, -0.39, 0]).box(0.19, 0.12, 0.19, K, [0, -0.78, 0]).geometry();
  const legs: THREE.Object3D[] = [];
  for (const [x, z] of [[0.7, 0.3], [0.7, -0.3], [-0.7, 0.3], [-0.7, -0.3]]) {
    const piv = new THREE.Group();
    piv.position.set(x, 0.84, z);
    const m = new THREE.Mesh(legGeo, vcMat());
    m.castShadow = true;
    m.userData.sharedGeo = true;
    piv.add(m);
    root.add(piv);
    legs.push(piv);
  }
  root.userData.legGeo = legGeo;
  const tail = new THREE.Group();
  tail.position.set(-0.95, 1.65, 0);
  tail.add(new PB().box(0.05, 0.75, 0.05, W, [0, -0.37, 0]).ball(0.08, K, [0, -0.78, 0]).mesh());
  root.add(tail);
  return { root, head, legs, tail };
}

// ───────────────────────── elephant ─────────────────────────
export interface Elephant { root: THREE.Group; legs: THREE.Object3D[]; trunk: THREE.Object3D; ears: THREE.Object3D[] }
export function buildElephant(): Elephant {
  const root = new THREE.Group();
  const G = 0x8d8a90, GD = 0x77747b, EAR = 0x9c8f98;
  const b = new PB();
  b.ball(1, G, [0, 1.95, 0], [1.6, 1.05, 1.0], 1)
    .ball(0.72, G, [1.45, 2.35, 0], 1, 1)
    .cone(0.075, 0.55, 0xf4ecd8, [1.98, 1.78, 0.3], [0, 0, -P / 2 + 0.55], 5).cone(0.075, 0.55, 0xf4ecd8, [1.98, 1.78, -0.3], [0, 0, -P / 2 + 0.55], 5)
    .ball(0.06, BLACK, [1.95, 2.55, 0.4]).ball(0.06, BLACK, [1.95, 2.55, -0.4])
    .cyl(0.04, 0.04, 0.8, GD, [-1.6, 1.8, 0], [0, 0, 0.5])
    // ceremonial blanket + trim
    .box(1.5, 0.08, 2.08, CRIMSON, [-0.05, 2.98, 0]).box(1.5, 0.95, 0.06, CRIMSON, [-0.05, 2.5, 1.02]).box(1.5, 0.95, 0.06, CRIMSON, [-0.05, 2.5, -1.02])
    .box(1.54, 0.1, 0.08, BRASS, [-0.05, 2.03, 1.04]).box(1.54, 0.1, 0.08, BRASS, [-0.05, 2.03, -1.04])
    .ball(0.08, BRASS, [-0.7, 1.93, 1.06]).ball(0.08, BRASS, [0.6, 1.93, 1.06]).ball(0.08, BRASS, [-0.7, 1.93, -1.06]).ball(0.08, BRASS, [0.6, 1.93, -1.06])
    // headdress
    .box(0.62, 0.08, 0.72, CRIMSON, [1.5, 3.03, 0], [0, 0, -0.25]).cone(0.09, 0.4, BRASS, [1.45, 3.28, 0]).ball(0.14, 0xb8323a, [1.45, 3.55, 0], [0.7, 1.3, 0.7]);
  root.add(b.mesh());
  const ears: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const piv = new THREE.Group();
    piv.position.set(1.25, 2.45, 0.5 * s);
    piv.add(new PB().ball(0.62, EAR, [-0.1, -0.1, 0.18 * s], [0.9, 1.05, 0.28], 1).mesh());
    piv.rotation.y = -0.35 * s;
    root.add(piv);
    ears.push(piv);
  }
  const trunk = new THREE.Group();
  trunk.position.set(1.95, 2.2, 0);
  trunk.add(new PB()
    .cyl(0.2, 0.25, 0.75, G, [0.12, -0.3, 0], [0, 0, 0.35])
    .cyl(0.15, 0.2, 0.65, G, [0.22, -0.92, 0], [0, 0, 0.05])
    .cyl(0.11, 0.15, 0.55, G, [0.18, -1.45, 0], [0, 0, -0.45])
    .mesh());
  root.add(trunk);
  const legGeo = new PB().cyl(0.3, 0.33, 1.35, G, [0, -0.62, 0], [0, 0, 0], 8)
    .box(0.1, 0.08, 0.08, 0xf0e8d8, [0.3, -1.28, 0.1]).box(0.1, 0.08, 0.08, 0xf0e8d8, [0.3, -1.28, -0.1]).geometry();
  const legs: THREE.Object3D[] = [];
  for (const [x, z] of [[0.9, 0.5], [0.9, -0.5], [-0.9, 0.5], [-0.9, -0.5]]) {
    const piv = new THREE.Group();
    piv.position.set(x, 1.32, z);
    const m = new THREE.Mesh(legGeo, vcMat());
    m.castShadow = true;
    m.userData.sharedGeo = true;
    piv.add(m);
    root.add(piv);
    legs.push(piv);
  }
  root.userData.legGeo = legGeo;
  return { root, legs, trunk, ears };
}

// ───────────────────────── hot-air balloon ─────────────────────────
export interface Balloon { root: THREE.Group; flame: THREE.Mesh; envelope: THREE.Object3D }
export function buildBalloon(): Balloon {
  const root = new THREE.Group();
  const prof = [[0.9, 0], [1.7, 0.8], [3.2, 2.4], [5.0, 4.8], [6.0, 7.4], [6.2, 9.6], [5.6, 12], [4.2, 13.9], [2.2, 15.1], [0.01, 15.5]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const segs = 16;
  const stripes = [0x7a2230, CREAM, 0x7a2230, CREAM, 0x2f5d3a, CREAM, 0x7a2230, CREAM];
  const b = new PB();
  b.addPainted(new THREE.LatheGeometry(prof, segs), (x, y, z) => {
    if (y > 14.6) return 0x2f5d3a;
    if (y > 9.1 && y < 10.2) return BRASS;
    if (y < 1.2) return 0x6e3326;
    const a = (Math.atan2(x, z) + P * 2) % (P * 2);
    return stripes[Math.floor(a / (P * 2 / segs)) % stripes.length];
  }, [0, 7.0, 0]);
  // basket, ropes, burner
  b.box(1.5, 1.05, 1.5, 0x8a6a3a, [0, 0.52, 0]).box(1.62, 0.14, 1.62, 0x5b4428, [0, 1.07, 0]).box(1.56, 0.1, 1.56, 0x5b4428, [0, 0.05, 0]);
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    b.rod([x * 0.72, 1.1, z * 0.72], [x * 0.95, 7.05, z * 0.95], 0.03, 0x3a2e22, 4);
    b.ball(0.13, 0xa08a60, [x * 0.8, 0.7, z * 0.84], [1, 1.2, 0.8]);
  }
  b.box(0.55, 0.35, 0.55, IRON, [0, 2.4, 0]).cyl(0.18, 0.18, 0.3, 0x444444, [0, 2.1, 0]);
  // (v2: the aeronauts are real people riding the basket via an Anchor — nobody but people draws humans)
  const envelope = b.mesh();
  root.add(envelope);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.4, 6), glowMat(0xffa040, 3.2));
  flame.position.set(0, 3.3, 0);
  root.add(flame);
  root.scale.setScalar(1.0);
  return { root, flame, envelope };
}

// ───────────────────────── trunk / luggage ─────────────────────────
export function buildTrunk(): THREE.Group {
  const root = new THREE.Group();
  const L = 0x6b4a2e, D = 0x3e2a1a;
  const b = new PB();
  b.box(1.1, 0.5, 0.62, L, [0, 0.25, 0])
    .add(new THREE.CylinderGeometry(0.31, 0.31, 1.1, 8, 1, false, 0, P), 0x7a5634, [0, 0.5, 0], [0, 0, P / 2])
    .box(0.07, 0.52, 0.66, BRASS, [0.36, 0.26, 0]).box(0.07, 0.52, 0.66, BRASS, [-0.36, 0.26, 0])
    .box(0.07, 0.04, 0.5, BRASS, [0.36, 0.78, 0]).box(0.07, 0.04, 0.5, BRASS, [-0.36, 0.78, 0])
    .box(1.12, 0.05, 0.64, D, [0, 0.5, 0])
    .box(0.12, 0.12, 0.04, BRASS, [0, 0.48, 0.32])
    .box(0.22, 0.14, 0.015, CREAM, [0.18, 0.28, 0.315], [0, 0, 0.12])
    .box(0.9, 0.03, 0.03, D, [0, 0.3, 0.315]);
  root.add(b.mesh());
  root.scale.setScalar(1.15);
  return root;
}

// ───────────────────────── snowdrift ─────────────────────────
export function buildSnowdrift(rng: () => number): THREE.Group {
  const root = new THREE.Group();
  const b = new PB();
  for (let i = 0; i < 9; i++) {
    const x = (rng() - 0.5) * 5.5, z = (rng() - 0.5) * 3.6;
    const r = 0.9 + rng() * 0.9;
    b.ball(r, i % 3 ? 0xf2f4f7 : 0xe2e9f0, [x, r * 0.25, z], [1.2, 0.5 + rng() * 0.25, 1], 1);
  }
  b.ball(1.8, 0xf4f6f9, [0, 0.35, 0], [1.8, 0.5, 1.2], 1);
  const m = b.mesh();
  m.receiveShadow = true;
  root.add(m);
  return root;
}

// ───────────────────────── bunting ─────────────────────────
/** poles at the given world points (y = base), pennants strung between them */
export function buildBunting(poles: THREE.Vector3[], height = 3.6, colors = [0x7a2230, CREAM, 0x2b3a67, BRASS]): THREE.Group {
  const root = new THREE.Group();
  const b = new PB();
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.2, 0, 0, 0.2, 0, 0, 0, -0.42, 0]), 3));
  tri.computeVertexNormals();
  let ci = 0;
  for (let i = 0; i < poles.length; i++) {
    const p = poles[i];
    b.cyl(0.05, 0.07, height + 0.3, IRON, [p.x, p.y + (height + 0.3) / 2, p.z], [0, 0, 0], 6).ball(0.1, BRASS, [p.x, p.y + height + 0.36, p.z]);
    if (i === poles.length - 1) break;
    const q = poles[i + 1];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    const yaw = Math.atan2(-(q.z - p.z), q.x - p.x);
    const n = Math.max(2, Math.floor(len / 0.55));
    for (let k = 1; k < n; k++) {
      const u = k / n;
      const sag = Math.sin(u * P) * 0.7;
      const x = p.x + (q.x - p.x) * u, z = p.z + (q.z - p.z) * u, y = p.y + height - sag;
      b.add(tri.clone(), colors[ci++ % colors.length], [x, y, z], [0, yaw, 0]);
    }
    // the string
    const mid = new THREE.Vector3((p.x + q.x) / 2, p.y + height - 0.7, (p.z + q.z) / 2);
    b.rod([p.x, p.y + height, p.z], mid, 0.015, 0xd8d0c0, 3).rod(mid, [q.x, q.y + height, q.z], 0.015, 0xd8d0c0, 3);
  }
  tri.dispose();
  root.add(b.mesh(vcMat(true), false));
  return root;
}

// ───────────────────────── red carpet with brass stanchions ─────────────────────────
export function buildCarpet(a: THREE.Vector3, bEnd: THREE.Vector3, width = 1.7): THREE.Group {
  const root = new THREE.Group();
  const len = Math.hypot(bEnd.x - a.x, bEnd.z - a.z);
  const b = new PB();
  b.box(len, 0.03, width, 0x9a1f2c, [len / 2, 0.02, 0])
    .box(len, 0.035, 0.1, BRASS, [len / 2, 0.02, width / 2 - 0.05]).box(len, 0.035, 0.1, BRASS, [len / 2, 0.02, -width / 2 + 0.05]);
  const n = Math.max(2, Math.floor(len / 1.8));
  for (const side of [1, -1]) {
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i <= n; i++) {
      const x = 0.4 + ((len - 0.8) * i) / n, z = side * (width / 2 + 0.35);
      b.cyl(0.04, 0.04, 0.9, BRASS, [x, 0.45, z], [0, 0, 0], 6).ball(0.07, BRASS, [x, 0.95, z]).cyl(0.14, 0.16, 0.05, BRASS, [x, 0.03, z], [0, 0, 0], 8);
      const cur = new THREE.Vector3(x, 0.82, z);
      if (prev) {
        const mid = prev.clone().lerp(cur, 0.5).setY(0.68);
        b.rod(prev, mid, 0.03, 0x7a1020, 4).rod(mid, cur, 0.03, 0x7a1020, 4);
      }
      prev = cur;
    }
  }
  // potted palms at the carpet head
  for (const side of [1, -1]) {
    const z = side * (width / 2 + 0.9);
    b.cyl(0.3, 0.22, 0.5, 0x6e3326, [-0.3, 0.25, z], [0, 0, 0], 8);
    for (let k = 0; k < 5; k++) b.cone(0.12, 1.0, 0x3f6b35, [-0.3 + Math.cos(k * 1.3) * 0.2, 0.9, z + Math.sin(k * 1.3) * 0.2], [Math.cos(k * 1.3) * 0.7, 0, Math.sin(k * 1.3) * 0.7], 4);
  }
  const m = b.mesh();
  m.receiveShadow = true;
  root.add(m);
  root.position.copy(a);
  root.rotation.y = Math.atan2(-(bEnd.z - a.z), bEnd.x - a.x);
  return root;
}

// ───────────────────────── wedding arch ─────────────────────────
export function buildArch(): THREE.Group {
  const root = new THREE.Group();
  const b = new PB();
  const W = 0xf4efe6;
  b.cyl(0.08, 0.09, 2.4, W, [0, 1.2, 1.15]).cyl(0.08, 0.09, 2.4, W, [0, 1.2, -1.15])
    .add(new THREE.TorusGeometry(1.15, 0.08, 5, 14, P), W, [0, 2.4, 0], [0, P / 2, 0]);
  const flowers = [0xf2c6d0, 0xffffff, 0xe8a0b4, 0xf6e7a8, 0xd88aa0];
  let k = 0;
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * P;
    const z = Math.cos(a) * 1.15, y = 2.4 + Math.sin(a) * 1.15;
    b.ball(0.15, flowers[k++ % flowers.length], [0.05, y, z], 1, 0);
    if (i % 2) b.ball(0.1, 0x4f7a3a, [-0.08, y - 0.05, z * 1.05]);
  }
  for (const s of [1, -1]) for (let j = 0; j < 4; j++) b.ball(0.13, flowers[(j + (s > 0 ? 0 : 2)) % flowers.length], [0.06, 0.4 + j * 0.5, s * 1.15], 1, 0);
  for (const s of [1, -1]) b.cyl(0.25, 0.2, 0.35, 0xc9a24a, [0, 0.17, s * 1.15], [0, 0, 0], 8);
  root.add(b.mesh());
  return root;
}

// ───────────────────────── bandstand dais ─────────────────────────
export function buildBandstand(standAngles: number[], radius: number): THREE.Group {
  const root = new THREE.Group();
  const b = new PB();
  b.cyl(radius + 1.2, radius + 1.35, 0.32, CREAM, [0, 0.16, 0], [0, 0, 0], 10)
    .cyl(radius + 1.22, radius + 1.22, 0.06, 0x2f5d3a, [0, 0.34, 0], [0, 0, 0], 10)
    .box(0.8, 0.35, 0.8, 0x7a2230, [radius + 0.3, 0.5, 0]); // conductor's box
  for (const a of standAngles) {
    const x = Math.cos(a) * (radius - 0.9), z = Math.sin(a) * (radius - 0.9);
    b.cyl(0.02, 0.02, 1.1, IRON, [x, 0.9, z], [0, 0, 0], 4).box(0.36, 0.03, 0.28, IRON, [x, 1.45, z], [0, -a + P / 2, 0.5]).box(0.3, 0.2, 0.01, 0xf4ecd8, [x + 0.03, 1.5, z], [0, -a + P / 2, 0.5]);
  }
  // bass drum at the back
  b.cyl(0.5, 0.5, 0.38, 0xf4ecd8, [-radius - 0.2, 0.85, 0], [P / 2, 0, 0], 12).cyl(0.52, 0.52, 0.08, 0x7a2230, [-radius - 0.2, 0.85, 0.2], [P / 2, 0, 0], 12).cyl(0.52, 0.52, 0.08, 0x7a2230, [-radius - 0.2, 0.85, -0.2], [P / 2, 0, 0], 12);
  // sign board on an easel: "BAND TODAY" in brass lettering suggested by stripes
  b.box(1.4, 0.9, 0.06, 0x2f5d3a, [radius + 1.8, 1.2, 1.8], [0, -0.6, 0]).box(1.2, 0.08, 0.07, BRASS, [radius + 1.8, 1.38, 1.8], [0, -0.6, 0]).box(0.9, 0.08, 0.07, BRASS, [radius + 1.8, 1.14, 1.8], [0, -0.6, 0])
    .rod([radius + 1.5, 0, 1.6], [radius + 1.6, 1.3, 1.7], 0.03, 0x5b4428, 4).rod([radius + 2.2, 0, 2.1], [radius + 2.0, 1.3, 1.95], 0.03, 0x5b4428, 4);
  const m = b.mesh();
  m.receiveShadow = true;
  root.add(m);
  return root;
}

// ───────────────────────── ghostly things ─────────────────────────
export function ghostMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(0x9fe6dc).multiplyScalar(1.4), transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
}
export function buildApparition(mat: THREE.Material): { root: THREE.Group; lantern: THREE.Object3D } {
  const root = new THREE.Group();
  const g = new PB();
  g.cone(0.5, 1.6, 0xffffff, [0, 0.8, 0], [0, 0, 0], 7).ball(0.2, 0xffffff, [0, 1.75, 0], 1, 1)
    .cyl(0.2, 0.22, 0.14, 0xffffff, [0, 1.95, 0]).box(0.24, 0.03, 0.14, 0xffffff, [0.14, 1.9, 0])
    .box(0.12, 0.55, 0.12, 0xffffff, [0.3, 1.25, 0], [0, 0, -0.9]);
  const m = new THREE.Mesh(g.geometry(), mat);
  root.add(m);
  const lantern = new THREE.Group();
  lantern.position.set(0.62, 1.05, 0);
  const lg = new PB().box(0.18, 0.24, 0.18, 0x1a1a1a, [0, -0.2, 0]).rod([0, 0, 0], [0, -0.08, 0], 0.01, 0x1a1a1a, 3);
  lantern.add(lg.mesh(vcMat(), false));
  const glow = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.16, 0.13), glowMat(0xb8ff9a, 3.5));
  glow.position.y = -0.2;
  lantern.add(glow);
  root.add(lantern);
  return { root, lantern };
}

/** stand-in translucent ghost train (only used if trains.spawnSpecial isn't available) */
export function buildGhostCar(kind: 'loco' | 'coach', mat: THREE.Material): THREE.Mesh {
  const b = new PB();
  if (kind === 'loco') {
    b.cyl(0.85, 0.85, 6.5, 0xffffff, [0.6, 2.25, 0], [0, 0, P / 2], 10).box(2.6, 2.8, 2.6, 0xffffff, [-3.2, 2.4, 0]).box(10, 0.5, 2.4, 0xffffff, [-0.4, 0.9, 0])
      .cyl(0.28, 0.35, 1.2, 0xffffff, [3.2, 3.5, 0]).ball(0.9, 0xffffff, [3.9, 1.1, 0], [0.5, 0.6, 1.4]);
    for (const x of [-3, -1, 1.2, 3.2]) { b.cyl(0.7, 0.7, 0.12, 0xffffff, [x, 0.7, 1.1], [P / 2, 0, 0], 10).cyl(0.7, 0.7, 0.12, 0xffffff, [x, 0.7, -1.1], [P / 2, 0, 0], 10); }
  } else {
    b.box(11.5, 2.5, 2.6, 0xffffff, [0, 2.1, 0]).add(new THREE.CylinderGeometry(1.4, 1.4, 11.5, 10, 1, false, 0, P), 0xffffff, [0, 3.35, 0], [0, 0, P / 2], [1, 1, 0.25]);
    for (const x of [-4, -3, 3, 4]) { b.cyl(0.45, 0.45, 0.1, 0xffffff, [x, 0.6, 1.1], [P / 2, 0, 0], 8).cyl(0.45, 0.45, 0.1, 0xffffff, [x, 0.6, -1.1], [P / 2, 0, 0], 8); }
  }
  return new THREE.Mesh(b.geometry(), mat);
}

// ───────────────────────── small carried items ─────────────────────────
export function buildShovel(): THREE.Group {
  const root = new THREE.Group();
  root.add(new PB().cyl(0.025, 0.025, 1.3, 0x7a5a3c, [0, 0.65, 0], [0, 0, 0], 5).box(0.26, 0.03, 0.32, 0x3a3f44, [0, 0.02, 0.1], [0.5, 0, 0]).box(0.16, 0.04, 0.04, 0x7a5a3c, [0, 1.3, 0]).mesh());
  return root;
}
export function buildPurse(): THREE.Group {
  const root = new THREE.Group();
  root.add(new PB().box(0.3, 0.22, 0.12, 0x4a2a3a, [0, 0, 0]).box(0.3, 0.04, 0.13, BRASS, [0, 0.11, 0]).add(new THREE.TorusGeometry(0.1, 0.015, 3, 8, P), 0x2a1a20, [0, 0.12, 0]).mesh());
  root.scale.setScalar(1.6);
  return root;
}
export function buildLightningBolt(from: THREE.Vector3, to: THREE.Vector3, rnd: () => number): THREE.Group {
  const root = new THREE.Group();
  const b = new PB();
  const pts: THREE.Vector3[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const p = from.clone().lerp(to, u);
    if (i > 0 && i < n) { p.x += (rnd() - 0.5) * 7 * (1 - u * 0.6); p.z += (rnd() - 0.5) * 7 * (1 - u * 0.6); }
    pts.push(p);
  }
  for (let i = 0; i < n; i++) b.rod(pts[i], pts[i + 1], 0.32 - i * 0.015, 0xffffff, 4);
  // a fork
  const f0 = pts[4];
  const f1 = f0.clone().add(new THREE.Vector3((rnd() - 0.5) * 16, -14, (rnd() - 0.5) * 16));
  b.rod(f0, f1, 0.14, 0xffffff, 3);
  const m = new THREE.Mesh(b.geometry(), glowMat(0xdde8ff, 6));
  root.add(m);
  return root;
}

// ───────────────────────── v2 props ─────────────────────────
/** a farmer's wicker market basket with a lid (the goose travels in it) */
export function buildBasket(): THREE.Group {
  const root = new THREE.Group();
  const W = 0xa8844a, D = 0x7a5a30;
  const b = new PB();
  b.cyl(0.36, 0.3, 0.42, W, [0, 0.21, 0], [0, 0, 0], 8)
    .add(new THREE.TorusGeometry(0.36, 0.035, 4, 10), D, [0, 0.42, 0], [P / 2, 0, 0])
    .add(new THREE.TorusGeometry(0.31, 0.03, 4, 10), D, [0, 0.12, 0], [P / 2, 0, 0])
    .add(new THREE.TorusGeometry(0.3, 0.03, 4, 8, P), D, [0, 0.42, 0], [0, 0, 0]);
  root.add(b.mesh());
  return root;
}

/** small terrier-ish dog; returns leg pivots, tail and head for gait/wag */
export interface Dog { root: THREE.Group; legs: THREE.Object3D[]; tail: THREE.Object3D; head: THREE.Object3D }
export function buildDog(coat = 0xe8dcc4, patch = 0x6a4a2e): Dog {
  const root = new THREE.Group();
  const b = new PB();
  b.box(0.62, 0.3, 0.3, coat, [0, 0.46, 0]).box(0.26, 0.31, 0.31, patch, [-0.12, 0.47, 0]);
  root.add(b.mesh());
  const head = new THREE.Group();
  head.position.set(0.34, 0.6, 0);
  head.add(new PB().box(0.24, 0.24, 0.24, coat, [0.08, 0.04, 0]).box(0.16, 0.12, 0.16, coat, [0.24, -0.02, 0])
    .ball(0.035, BLACK, [0.33, 0.01, 0]).box(0.06, 0.14, 0.1, patch, [0.02, 0.18, 0.1], [0.3, 0, 0]).box(0.06, 0.14, 0.1, patch, [0.02, 0.18, -0.1], [-0.3, 0, 0])
    .ball(0.025, BLACK, [0.2, 0.09, 0.08]).ball(0.025, BLACK, [0.2, 0.09, -0.08]).box(0.04, 0.05, 0.26, CRIMSON, [-0.06, -0.08, 0]).mesh());
  root.add(head);
  const legGeo = new PB().box(0.08, 0.32, 0.08, coat, [0, -0.16, 0]).geometry();
  const legs: THREE.Object3D[] = [];
  for (const [x, z] of [[0.22, 0.1], [0.22, -0.1], [-0.22, 0.1], [-0.22, -0.1]]) {
    const piv = new THREE.Group();
    piv.position.set(x, 0.33, z);
    const m = new THREE.Mesh(legGeo, vcMat());
    m.castShadow = true; m.userData.sharedGeo = true;
    piv.add(m); root.add(piv); legs.push(piv);
  }
  root.userData.legGeo = legGeo;
  const tail = new THREE.Group();
  tail.position.set(-0.3, 0.56, 0);
  tail.add(new PB().box(0.06, 0.24, 0.06, coat, [0, 0.11, 0], [0, 0, 0.5]).mesh());
  root.add(tail);
  root.scale.setScalar(1.2);
  return { root, legs, tail, head };
}

/** mute swan (neck pivot for the menacing hiss, wing pivots for the charge) */
export interface Swan { root: THREE.Group; neck: THREE.Object3D; wingL: THREE.Object3D; wingR: THREE.Object3D }
export function buildSwan(): Swan {
  const root = new THREE.Group();
  const b = new PB();
  b.ball(0.34, WHITE, [0, 0.28, 0], [1.6, 0.8, 1], 1).cone(0.16, 0.3, WHITE, [-0.56, 0.36, 0], [0, 0, P / 2 + 0.5]);
  root.add(b.mesh());
  const neck = new THREE.Group();
  neck.position.set(0.42, 0.38, 0);
  neck.add(new PB().cyl(0.06, 0.08, 0.7, WHITE, [0.02, 0.33, 0], [0, 0, 0.12]).ball(0.1, WHITE, [0.02, 0.7, 0], [1.3, 1, 1])
    .cone(0.05, 0.2, ORANGE, [0.2, 0.66, 0], [0, 0, -P / 2]).ball(0.035, BLACK, [0.11, 0.7, 0]).ball(0.022, BLACK, [0.1, 0.74, 0.07]).ball(0.022, BLACK, [0.1, 0.74, -0.07]).mesh());
  root.add(neck);
  const wing = (s: number) => {
    const piv = new THREE.Group();
    piv.position.set(0.05, 0.42, 0.22 * s);
    piv.add(new PB().box(0.7, 0.06, 0.4, 0xeeebe2, [-0.05, 0, 0.2 * s]).box(0.4, 0.05, 0.3, 0xdcd8ce, [-0.35, 0.02, 0.18 * s]).mesh());
    root.add(piv);
    return piv;
  };
  const wingL = wing(1), wingR = wing(-1);
  root.scale.setScalar(1.25);
  return { root, neck, wingL, wingR };
}

/** a steaming brazier (frost fair / chestnut seller). glow = flame mesh to flicker */
export function buildBrazier(): { root: THREE.Group; glow: THREE.Mesh } {
  const root = new THREE.Group();
  const b = new PB();
  b.cyl(0.32, 0.26, 0.45, IRON, [0, 0.72, 0], [0, 0, 0], 8)
    .rod([0.25, 0, 0.25], [0.2, 0.55, 0.2], 0.03, IRON, 4).rod([-0.25, 0, 0.25], [-0.2, 0.55, 0.2], 0.03, IRON, 4)
    .rod([0.25, 0, -0.25], [0.2, 0.55, -0.2], 0.03, IRON, 4).rod([-0.25, 0, -0.25], [-0.2, 0.55, -0.2], 0.03, IRON, 4)
    .ball(0.1, 0x3a2a20, [0.1, 0.96, 0]).ball(0.09, 0x3a2a20, [-0.1, 0.96, 0.08]);
  root.add(b.mesh(vcMat(), false));
  const glow = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 0), glowMat(0xff7a2a, 2.6));
  glow.position.y = 0.98; glow.scale.set(1, 0.45, 1);
  root.add(glow);
  return { root, glow };
}

/** a hay rick (for the fire): thatched cone on a drum; `char` 0..1 blackens it via vertex colour lerp */
export function buildRick(): { root: THREE.Group; mesh: THREE.Mesh; setChar(c: number): void } {
  const root = new THREE.Group();
  const b = new PB();
  b.cyl(2.6, 2.8, 2.6, 0xc9a85a, [0, 1.3, 0], [0, 0, 0], 10).cone(3.0, 2.4, 0xb8964a, [0, 3.8, 0], [0, 0, 0], 10)
    .ball(0.25, 0x8a6a30, [0, 5.0, 0]);
  const mesh = b.mesh();
  root.add(mesh);
  const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
  const base = Float32Array.from(col.array as Float32Array);
  const setChar = (c: number) => {
    const a = col.array as Float32Array;
    for (let i = 0; i < a.length; i += 3) {
      a[i] = base[i] * (1 - c) + 0.09 * c; a[i + 1] = base[i + 1] * (1 - c) + 0.08 * c; a[i + 2] = base[i + 2] * (1 - c) + 0.07 * c;
    }
    col.needsUpdate = true;
  };
  return { root, mesh, setChar };
}

/** market stall: timber frame + striped awning + trestle of produce. build 0..1 raises it (assembled by the vendor) */
export function buildStall(awning: number, goods: number[]): { root: THREE.Group; setBuild(f: number): void } {
  const root = new THREE.Group();
  const frame = new PB();
  for (const [x, z] of [[1.4, 0.8], [1.4, -0.8], [-1.4, 0.8], [-1.4, -0.8]]) frame.box(0.1, 2.3, 0.1, 0x5b4428, [x, 1.15, z]);
  frame.box(3.0, 0.08, 1.4, 0x7a5a36, [0, 0.85, 0.15]).box(0.08, 0.85, 0.08, 0x5b4428, [1.3, 0.42, 0.7]).box(0.08, 0.85, 0.08, 0x5b4428, [-1.3, 0.42, 0.7]);
  goods.forEach((g, i) => frame.ball(0.22, g, [-1.0 + i * 0.5, 1.0, 0.35 + (i % 2) * 0.25], [1, 0.7, 1]));
  frame.box(0.5, 0.3, 0.4, 0x8a6a3a, [1.0, 0.15, -0.3]).box(0.5, 0.3, 0.4, 0x8a6a3a, [-0.9, 0.15, -0.4]);
  const fm = frame.mesh();
  root.add(fm);
  const aw = new PB();
  for (let i = 0; i < 6; i++) aw.box(0.52, 0.05, 1.9, i % 2 ? CREAM : awning, [-1.3 + i * 0.52, 2.38, 0.1], [0.18, 0, 0]);
  aw.box(3.14, 0.22, 0.03, awning, [0, 2.2, 1.06]);
  const am = aw.mesh(vcMat(true), true);
  root.add(am);
  const setBuild = (f: number) => {
    const a = THREE.MathUtils.clamp(f * 1.6, 0, 1), c = THREE.MathUtils.clamp(f * 2 - 1, 0, 1);
    fm.scale.set(1, Math.max(0.02, a), 1);
    am.visible = c > 0.02;
    am.scale.set(Math.max(0.05, c), 1, Math.max(0.05, c));
  };
  setBuild(1);
  return { root, setBuild };
}

/** diamond kite with a ribbon tail (kite local +x = toward the flyer) */
export function buildKite(color: number): THREE.Group {
  const root = new THREE.Group();
  const shape = new THREE.BufferGeometry();
  shape.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0.75, 0, 0, 0, 0.45, 0, -0.9, 0, 0, 0.75, 0, 0, -0.9, 0, 0, 0, -0.45,
  ]), 3));
  shape.computeVertexNormals();
  const b = new PB();
  b.add(shape, color).rod([0, 0.75, 0], [0, -0.9, 0], 0.015, 0x5b4428, 3).rod([0, 0, 0.45], [0, 0, -0.45], 0.015, 0x5b4428, 3);
  for (let i = 0; i < 4; i++) b.box(0.03, 0.12, 0.22, i % 2 ? CREAM : CRIMSON, [0, -1.15 - i * 0.35, Math.sin(i * 1.3) * 0.12], [0.4, 0, 0]);
  root.add(b.mesh(vcMat(true), false));
  root.scale.setScalar(1.3);
  return root;
}

/** a small heap of spilled apples / a crate */
export function buildApples(n: number, rng: () => number): THREE.Group {
  const root = new THREE.Group();
  const b = new PB();
  for (let i = 0; i < n; i++) {
    const a = rng() * P * 2, r = rng() * 2.2;
    b.ball(0.09, rng() < 0.3 ? 0x9aa83a : 0xb8322a, [Math.cos(a) * r, 0.08, Math.sin(a) * r], 1, 0);
  }
  b.box(0.6, 0.4, 0.45, 0x8a6a3a, [0.3, 0.2, 0.2], [0.2, 0.5, 1.2]);
  root.add(b.mesh(vcMat(), false));
  return root;
}

/** a coil of fire hose + bucket (props left by the chain) */
export function buildBucket(): THREE.Group {
  const root = new THREE.Group();
  root.add(new PB().cyl(0.16, 0.12, 0.28, 0x6a6a70, [0, 0.14, 0], [0, 0, 0], 7).add(new THREE.TorusGeometry(0.15, 0.012, 3, 8, P), 0x3a3a3a, [0, 0.3, 0]).mesh(vcMat(), false));
  return root;
}

/** geometry: a folding music stand (for the band's InstProps) */
export function musicStandGeometry(): THREE.BufferGeometry {
  return new PB().rod([0, 0, 0], [0, 1.1, 0], 0.02, IRON, 4).rod([0, 0.02, 0], [0.22, 0, 0.13], 0.015, IRON, 3).rod([0, 0.02, 0], [-0.22, 0, 0.13], 0.015, IRON, 3)
    .rod([0, 0.02, 0], [0, 0, -0.25], 0.015, IRON, 3).box(0.42, 0.3, 0.02, IRON, [0, 1.22, 0.02], [-0.35, 0, 0]).box(0.38, 0.26, 0.012, CREAM, [0, 1.225, 0.035], [-0.35, 0, 0]).geometry();
}
/** geometry: a bunting pole with a pennant string toward local +x (length 1, scale x to span) */
export function penantGeometry(): THREE.BufferGeometry {
  return new PB().cyl(0.04, 0.05, 3.2, IRON, [0, 1.6, 0], [0, 0, 0], 5).ball(0.08, BRASS, [0, 3.25, 0]).geometry();
}

// ───────────────────────── v2 props for the town & country events ─────────────────────────
/**
 * Market-stall parts as two geometries for InstProps (so N stalls cost 2 draws): frame (timber, trestle, produce,
 * crates) and awning (striped canopy, stripes baked). Both share the stall's local frame: +z = customer side.
 * Assembly is shown by instance scale: frame y 0→1, then awning x/z 0→1.
 */
/** a whole stall (frame + goods + awning) as ONE geometry — assembled by scaling y 0 → 1 */
export function stallGeometry(awning: number, goods: number[]): THREE.BufferGeometry {
  const p = stallGeometries(awning, goods);
  const g = mergeGeometries([p.frame, p.awning], false) ?? p.frame;
  p.frame.dispose(); p.awning.dispose();
  g.computeBoundingSphere();
  return g;
}

export function stallGeometries(awning: number, goods: number[]): { frame: THREE.BufferGeometry; awning: THREE.BufferGeometry } {
  const frame = new PB();
  for (const [x, z] of [[1.4, 0.8], [1.4, -0.8], [-1.4, 0.8], [-1.4, -0.8]]) frame.box(0.1, 2.3, 0.1, 0x5b4428, [x, 1.15, z]);
  frame.box(3.0, 0.08, 1.4, 0x7a5a36, [0, 0.85, 0.15]).box(0.08, 0.85, 0.08, 0x5b4428, [1.3, 0.42, 0.7]).box(0.08, 0.85, 0.08, 0x5b4428, [-1.3, 0.42, 0.7]);
  goods.forEach((g, i) => frame.ball(0.22, g, [-1.0 + i * 0.5, 1.0, 0.35 + (i % 2) * 0.25], [1, 0.7, 1]));
  frame.box(0.5, 0.3, 0.4, 0x8a6a3a, [1.0, 0.15, -0.3]).box(0.5, 0.3, 0.4, 0x8a6a3a, [-0.9, 0.15, -0.4]);
  const aw = new PB();
  for (let i = 0; i < 6; i++) aw.box(0.52, 0.05, 1.9, i % 2 ? CREAM : awning, [-1.3 + i * 0.52, 2.38, 0.1], [0.18, 0, 0]);
  aw.box(3.14, 0.22, 0.03, awning, [0, 2.2, 1.06]);
  return { frame: frame.geometry(), awning: aw.geometry() };
}

/** a folded stall bundle (poles + rolled canvas) carried in and out by its trader */
export function stallBundleGeometry(): THREE.BufferGeometry {
  return new PB().cyl(0.14, 0.14, 1.9, CREAM, [0, 0, 0], [0, 0, P / 2], 6).rod([-1.1, 0.12, 0.05], [1.1, 0.12, 0.05], 0.035, 0x5b4428, 4)
    .rod([-1.1, 0.12, -0.08], [1.1, 0.12, -0.08], 0.035, 0x5b4428, 4).geometry();
}

/** maypole with a garland crown; ribbons are a separate mesh (rotated as the dancers wind them) */
export function buildMaypole(): { root: THREE.Group; ribbons: THREE.Mesh } {
  const root = new THREE.Group();
  root.add(new PB().cyl(0.09, 0.12, 6.2, 0xe8dcc0, [0, 3.1, 0], [0, 0, 0], 7).add(new THREE.TorusGeometry(0.42, 0.09, 4, 10), 0x5e7a3a, [0, 5.7, 0], [P / 2, 0, 0])
    .ball(0.16, BRASS, [0, 6.3, 0]).cyl(0.5, 0.6, 0.18, 0x5b4428, [0, 0.09, 0], [0, 0, 0], 8).mesh());
  const rb = new PB();
  const cols = [CRIMSON, 0x2b3a67, 0xd9b95a, CREAM, 0x5e7a3a, 0x9a4a7a, CRIMSON, 0x2b3a67];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * P * 2;
    rb.rod([Math.cos(a) * 0.12, 5.6, Math.sin(a) * 0.12], [Math.cos(a) * 3.2, 1.0, Math.sin(a) * 3.2], 0.035, cols[i], 3);
  }
  const ribbons = rb.mesh(vcMat(), false);
  root.add(ribbons);
  return { root, ribbons };
}

/** a tongue of flame (unit height, base at y 0) for instanced fire */
export function flameGeometry(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.5, 1, 5, 1);
  g.translate(0, 0.5, 0);
  return g;
}

/** trestle table with a white cloth, tea urn and cake stands (the fete tea table) */
export function buildTeaTable(): THREE.Group {
  const root = new THREE.Group();
  const b = new PB();
  b.box(2.6, 0.06, 1.0, 0xf2efe6, [0, 0.82, 0]).box(2.62, 0.4, 0.02, 0xf2efe6, [0, 0.62, 0.5]).box(2.62, 0.4, 0.02, 0xf2efe6, [0, 0.62, -0.5])
    .box(0.06, 0.8, 0.9, 0x5b4428, [1.1, 0.4, 0]).box(0.06, 0.8, 0.9, 0x5b4428, [-1.1, 0.4, 0])
    .cyl(0.18, 0.2, 0.5, 0xb8a060, [-0.8, 1.1, 0]).cyl(0.22, 0.22, 0.03, 0xe8dcc0, [0.3, 0.95, 0.1]).ball(0.14, 0x9a5a3a, [0.3, 1.04, 0.1], [1, 0.6, 1])
    .cyl(0.22, 0.22, 0.03, 0xe8dcc0, [0.9, 0.95, -0.1]).ball(0.14, 0xe8b0b8, [0.9, 1.04, -0.1], [1, 0.6, 1]);
  root.add(b.mesh());
  return root;
}

/** coconut shy: a frame with three posts topped by coconuts (one merged mesh); `nutAt(i)` = local nut position */
export function buildCoconutShy(): { root: THREE.Group; nutAt: (i: number) => THREE.Vector3 } {
  const root = new THREE.Group();
  const b = new PB();
  b.box(3.2, 0.1, 0.1, 0x7a2230, [0, 1.9, 0]).box(0.1, 1.9, 0.1, 0x7a2230, [1.55, 0.95, 0]).box(0.1, 1.9, 0.1, 0x7a2230, [-1.55, 0.95, 0])
    .box(3.2, 0.3, 0.04, CREAM, [0, 2.1, 0]);
  for (const x of [-0.9, 0, 0.9]) b.rod([x, 0, 0], [x, 1.1, 0], 0.03, 0x5b4428, 4).ball(0.12, 0x4a3424, [x, 1.2, 0]);
  root.add(b.mesh());
  return { root, nutAt: (i) => new THREE.Vector3([-0.9, 0, 0.9][i % 3], 1.2, 0) };
}
