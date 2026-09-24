import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Static-geometry batcher: collects primitives per material (in world space) and
 * merges them into one mesh per material on build(). All geometry is normalised to
 * non-indexed position/normal/uv so mergeGeometries always succeeds.
 */
export class Kit {
  /**
   * Material folding (set once by world/index.ts): primitives added with a key material are re-routed to a
   * vertex-coloured material in that material's colour, so flat-colour props (iron, paint, joinery…) share one
   * draw per mesh group instead of one each. Geometry that already carries colours is left alone.
   */
  static fold: Map<THREE.Material, { to: THREE.Material; color: THREE.Color }> | null = null;
  protected parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  /** vertex colour applied to geometry added to vertexColors materials (see addC) */
  color = new THREE.Color(1, 1, 1);
  /** current frame (local → world) */
  frame = new THREE.Matrix4();
  private stack: THREE.Matrix4[] = [];
  private tmp = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();

  /** push a frame: translate to (x,y,z) then rotate yaw around y (and optionally pitch/roll) */
  push(x: number, y: number, z: number, yaw = 0, rx = 0, rz = 0): this {
    this.stack.push(this.frame.clone());
    this.frame.multiply(this.mat(x, y, z, yaw, rx, rz));
    return this;
  }
  pop(): this { this.frame.copy(this.stack.pop() ?? new THREE.Matrix4()); return this; }
  within(x: number, y: number, z: number, yaw: number, fn: () => void): void {
    this.push(x, y, z, yaw); try { fn(); } finally { this.pop(); }
  }

  mat(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
    this.e.set(rx, ry, rz, 'YXZ');
    this.q.setFromEuler(this.e);
    return new THREE.Matrix4().compose(this.v.set(x, y, z), this.q, this.s.set(sx, sy, sz));
  }

  /** add geometry (consumed) transformed by current frame × m */
  add(material: THREE.Material, g: THREE.BufferGeometry, m?: THREE.Matrix4): void {
    const f = Kit.fold?.get(material);
    if (f && !g.getAttribute('color')) {
      const prev = _foldPrev.copy(this.color);
      this.color.copy(f.color);
      this.addRaw(f.to, g, m);
      this.color.copy(prev);
      return;
    }
    this.addRaw(material, g, m);
  }

  private addRaw(material: THREE.Material, g: THREE.BufferGeometry, m?: THREE.Matrix4): void {
    let geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const n = geo.getAttribute('position').count;
    if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    const vc = (material as THREE.MeshStandardMaterial).vertexColors;
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(vc && name === 'color')) geo.deleteAttribute(name);
    }
    if (vc && !geo.getAttribute('color')) {
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = this.color.r; c[i * 3 + 1] = this.color.g; c[i * 3 + 2] = this.color.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    geo.clearGroups();
    this.tmp.copy(this.frame);
    if (m) this.tmp.multiply(m);
    geo.applyMatrix4(this.tmp);
    this.sink(material, geo);
  }

  /** add with a vertex colour (material must have vertexColors) */
  addC(material: THREE.Material, color: number | THREE.Color, g: THREE.BufferGeometry, m?: THREE.Matrix4): void {
    const prev = this.color.clone();
    if (typeof color === 'number') this.color.setHex(color); else this.color.copy(color);
    this.add(material, g, m);
    this.color.copy(prev);
  }

  /** receives each transformed, normalised geometry (Batch overrides this to bin by chunk) */
  protected sink(material: THREE.Material, geo: THREE.BufferGeometry): void {
    let arr = this.parts.get(material);
    if (!arr) { arr = []; this.parts.set(material, arr); }
    arr.push(geo);
  }

  /** axis-aligned box in the current frame, centred at (x,y,z) */
  box(mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0): void {
    this.add(mat, new THREE.BoxGeometry(sx, sy, sz), this.mat(x, y, z, ry, rx, rz));
  }
  /** box whose bottom sits at y */
  boxB(mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0, ry = 0): void {
    this.box(mat, sx, sy, sz, x, y + sy / 2, z, ry);
  }
  /** vertical cylinder, bottom at y */
  cyl(mat: THREE.Material, rTop: number, rBot: number, h: number, seg: number, x = 0, y = 0, z = 0, ry = 0): void {
    this.add(mat, new THREE.CylinderGeometry(rTop, rBot, h, seg), this.mat(x, y + h / 2, z, ry));
  }
  /** cylinder between two local points */
  rod(mat: THREE.Material, r: number, a: THREE.Vector3, b: THREE.Vector3, seg = 5): void {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return;
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    this.add(mat, g, m);
  }
  /** thin box between two local points (w = width across, h = height) */
  beam(mat: THREE.Material, w: number, h: number, a: THREE.Vector3, b: THREE.Vector3): void {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return;
    const g = new THREE.BoxGeometry(w, h, len);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), d, Math.abs(d.y / len) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
    m.setPosition(a.clone().add(b).multiplyScalar(0.5));
    this.add(mat, g, m);
  }
  /** triangular prism roof (gable along local x): width sz, ridge height h, bottom at y */
  gable(mat: THREE.Material, sx: number, sz: number, h: number, x = 0, y = 0, z = 0, ry = 0): void {
    const s = new THREE.Shape();
    s.moveTo(-sz / 2, 0); s.lineTo(sz / 2, 0); s.lineTo(0, h); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: sx, bevelEnabled: false });
    g.translate(0, 0, -sx / 2);
    g.rotateY(Math.PI / 2);
    this.add(mat, g, this.mat(x, y, z, ry));
  }
  /** hip roof: base sx × sz at y, height h, ridge length sx - sz (min 0) */
  hip(mat: THREE.Material, sx: number, sz: number, h: number, x = 0, y = 0, z = 0, ry = 0, ridgeInset?: number): void {
    const hx = sx / 2, hz = sz / 2;
    const r = Math.max(0, ridgeInset !== undefined ? hx - ridgeInset : hx - hz);
    const P = [
      [-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz], // base 0..3
      [-r, h, 0], [r, h, 0], // ridge 4,5
    ];
    const tri = [
      [0, 4, 5], [0, 5, 1], // north
      [2, 5, 4], [2, 4, 3], // south
      [1, 5, 2], // east
      [3, 4, 0], // west
      [0, 1, 2], [0, 2, 3], // bottom
    ];
    const pos: number[] = [];
    for (const t of tri) for (const i of t) pos.push(...P[i]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    this.add(mat, g, this.mat(x, y, z, ry));
  }
  /** pyramid (4-sided cone), bottom at y */
  pyramid(mat: THREE.Material, w: number, h: number, x = 0, y = 0, z = 0): void {
    const g = new THREE.ConeGeometry(w * Math.SQRT1_2, h, 4, 1);
    this.add(mat, g, this.mat(x, y + h / 2, z, Math.PI / 4));
  }
  /** flat quad in the local XY plane facing +z, centred at (x,y,z), rotated ry; optional uv rect [u0,v0,u1,v1] */
  quad(mat: THREE.Material, w: number, h: number, x = 0, y = 0, z = 0, ry = 0, uv?: [number, number, number, number]): void {
    const g = new THREE.PlaneGeometry(w, h);
    if (uv) {
      const a = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) a.setXY(i, uv[0] + a.getX(i) * (uv[2] - uv[0]), uv[1] + a.getY(i) * (uv[3] - uv[1]));
    }
    this.add(mat, g, this.mat(x, y, z, ry));
  }
  /** arched window/door panel facing +z: rect w×h (bottom at y) topped by a half-disc */
  arch(mat: THREE.Material, w: number, h: number, x = 0, y = 0, z = 0, ry = 0, seg = 6): void {
    const s = new THREE.Shape();
    const r = w / 2;
    s.moveTo(-r, 0); s.lineTo(r, 0); s.lineTo(r, h - r);
    s.absarc(0, h - r, r, 0, Math.PI, false);
    s.lineTo(-r, 0);
    const g = new THREE.ShapeGeometry(s, seg);
    this.add(mat, g, this.mat(x, y, z, ry));
  }
  /** extruded arch-shaped slab (depth d along z), for door/window surrounds */
  archSlab(mat: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0, ry = 0, seg = 6): void {
    const s = new THREE.Shape();
    const r = w / 2;
    s.moveTo(-r, 0); s.lineTo(r, 0); s.lineTo(r, h - r);
    s.absarc(0, h - r, r, 0, Math.PI, false);
    s.lineTo(-r, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: seg });
    g.translate(0, 0, -d / 2);
    this.add(mat, g, this.mat(x, y, z, ry));
  }

  get empty(): boolean { return this.parts.size === 0; }

  /** merge everything into one mesh per material */
  build(name: string, opts: { cast?: boolean; receive?: boolean; noCast?: THREE.Material[] } = {}): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [mat, geos] of this.parts) {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      for (const g of geos) if (g !== merged) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${name}:${mat.name || 'mat'}`;
      const transparent = (mat as THREE.MeshStandardMaterial).transparent;
      mesh.castShadow = !!opts.cast && !transparent && !(opts.noCast ?? []).includes(mat);
      mesh.receiveShadow = opts.receive ?? true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }
    this.parts.clear();
    group.matrixAutoUpdate = false;
    return group;
  }
}

const _foldPrev = new THREE.Color();
export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Sweep a 2D cross-section profile (pairs of [lateral, y], closed loop, CCW when looking along +t)
 * along a curve between t0..t1. Lateral uses (tangent × up) = (-tz, 0, tx), y is absolute.
 */
export function sweep(
  curve: THREE.Curve<THREE.Vector3>, t0: number, t1: number, profile: [number, number][], stepM: number,
  opts: { caps?: boolean; lateralOffset?: number } = {},
): THREE.BufferGeometry {
  const len = curve.getLength() * (t1 - t0);
  const n = Math.max(1, Math.ceil(len / stepM));
  const P = profile.length;
  const pos: number[] = [];
  const p = new THREE.Vector3(), tg = new THREE.Vector3();
  const rings: THREE.Vector3[][] = [];
  const off = opts.lateralOffset ?? 0;
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    curve.getPointAt(Math.min(1, Math.max(0, t)), p);
    curve.getTangentAt(Math.min(1, Math.max(0, t)), tg);
    const sx = -tg.z, sz = tg.x;
    const l = Math.hypot(sx, sz) || 1;
    const ring: THREE.Vector3[] = [];
    for (const [lat, y] of profile) ring.push(new THREE.Vector3(p.x + (sx / l) * (lat + off), y, p.z + (sz / l) * (lat + off)));
    rings.push(ring);
  }
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < n; i++) {
    const A = rings[i], B = rings[i + 1];
    for (let j = 0; j < P; j++) {
      const j2 = (j + 1) % P;
      push(A[j], B[j], B[j2]);
      push(A[j], B[j2], A[j2]);
    }
  }
  if (opts.caps) {
    const cap = (R: THREE.Vector3[], flip: boolean) => {
      for (let j = 1; j < P - 1; j++) flip ? push(R[0], R[j + 1], R[j]) : push(R[0], R[j], R[j + 1]);
    };
    cap(rings[0], false);
    cap(rings[n], true);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** helper: local (lx along yaw, lz lateral) → world xz, matching layout's localToWorld */
export function localToWorld(ox: number, oz: number, yaw: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [ox + lx * c + lz * s, oz - lx * s + lz * c];
}

/** distance from p to a polyline (xz) */
export function distToPts(x: number, z: number, pts: THREE.Vector3[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const abx = b.x - a.x, abz = b.z - a.z;
    const l2 = abx * abx + abz * abz || 1;
    const u = Math.min(1, Math.max(0, ((x - a.x) * abx + (z - a.z) * abz) / l2));
    const d = Math.hypot(x - (a.x + abx * u), z - (a.z + abz * u));
    if (d < best) best = d;
  }
  return best;
}
