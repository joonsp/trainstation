import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Material buckets a car's static geometry is merged into (one draw call per non-empty bucket). */
export type Bucket = 'paint' | 'window' | 'brass' | 'lamp' | 'fire';
export const BUCKETS: Bucket[] = ['paint', 'window', 'brass', 'lamp', 'fire'];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

export function shade(hex: number, f: number): number {
  _c.setHex(hex);
  _c.r = Math.min(1, _c.r * f); _c.g = Math.min(1, _c.g * f); _c.b = Math.min(1, _c.b * f);
  return _c.getHex();
}
export function mix(a: number, b: number, t: number): number {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return ca.lerp(cb, t).getHex();
}

/**
 * Geometry builder: accumulates primitive parts (already transformed, non-indexed, vertex-coloured)
 * per material bucket and merges them into one BufferGeometry per bucket.
 */
export class GB {
  private parts: Record<Bucket, THREE.BufferGeometry[]> = { paint: [], window: [], brass: [], lamp: [], fire: [] };

  add(b: Bucket, color: number, g: THREE.BufferGeometry, x = 0, y = 0, z = 0,
    rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): this {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    if (geo.getAttribute('uv')) geo.deleteAttribute('uv');
    if (geo.getAttribute('uv1')) geo.deleteAttribute('uv1');
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
    geo.applyMatrix4(_m);
    const n = geo.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    _c.setHex(color);
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts[b].push(geo);
    return this;
  }

  /** axis-aligned box by extents */
  bx(b: Bucket, color: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): this {
    return this.add(b, color, new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)),
      (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  }
  /** box mirrored on both sides (z and -z), z0..z1 given for the +z side */
  bx2(b: Bucket, color: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): this {
    this.bx(b, color, x0, x1, y0, y1, z0, z1);
    return this.bx(b, color, x0, x1, y0, y1, -z1, -z0);
  }
  /** box by centre/size with rotation */
  box(b: Bucket, color: number, sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): this {
    return this.add(b, color, new THREE.BoxGeometry(sx, sy, sz), x, y, z, rx, ry, rz);
  }
  /** cylinder with axis along x */
  cx(b: Bucket, color: number, r: number, len: number, x: number, y: number, z: number, seg = 10, r2 = r): this {
    return this.add(b, color, new THREE.CylinderGeometry(r2, r, len, seg), x, y, z, 0, 0, -Math.PI / 2);
  }
  /** vertical cylinder */
  cy(b: Bucket, color: number, rTop: number, rBot: number, h: number, x: number, y: number, z: number, seg = 10): this {
    return this.add(b, color, new THREE.CylinderGeometry(rTop, rBot, h, seg), x, y, z);
  }
  /** cylinder with axis along z */
  cz(b: Bucket, color: number, r: number, len: number, x: number, y: number, z: number, seg = 10): this {
    return this.add(b, color, new THREE.CylinderGeometry(r, r, len, seg), x, y, z, Math.PI / 2, 0, 0);
  }
  /** half cylinder (upper half) with axis along z — splashers */
  hcz(b: Bucket, color: number, r: number, len: number, x: number, y: number, z: number, seg = 10): this {
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false, -Math.PI / 2, Math.PI);
    return this.add(b, color, g, x, y, z, -Math.PI / 2, 0, 0);
  }
  /** shallow arched roof along x: a flattened cylinder whose lower half hides inside the body */
  roof(b: Bucket, color: number, len: number, halfW: number, yBase: number, rise: number, x = 0, seg = 12): this {
    // Rz(-90deg) maps local x -> world -y, so local-x scale squashes the arch height.
    const g = new THREE.CylinderGeometry(halfW, halfW, len, seg, 1, false);
    return this.add(b, color, g, x, yBase, 0, 0, 0, -Math.PI / 2, rise / halfW, 1, 1);
  }
  /** jittered low-poly heap (coal, loads) */
  heap(b: Bucket, color: number, sx: number, sy: number, sz: number, x: number, y: number, z: number, seed = 1): this {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    // hash by position so duplicated (non-indexed) corner vertices move together — no cracks
    const h = (x: number, y: number, z: number) => {
      const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 3.17) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      const k = 0.82 + h(Math.round(px * 100), Math.round(py * 100), Math.round(pz * 100)) * 0.36;
      pos.setXYZ(i, px * k, Math.max(py, -0.1) * k, pz * k);
    }
    return this.add(b, color, g, x, y, z, 0, 0, 0, sx, sy, sz);
  }

  build(): Partial<Record<Bucket, THREE.BufferGeometry>> {
    const out: Partial<Record<Bucket, THREE.BufferGeometry>> = {};
    for (const b of BUCKETS) {
      const arr = this.parts[b];
      if (!arr.length) continue;
      for (const g of arr) g.computeVertexNormals();
      const merged = mergeGeometries(arr, false);
      for (const g of arr) g.dispose();
      if (merged) { merged.computeBoundingSphere(); merged.computeBoundingBox(); out[b] = merged; }
    }
    return out;
  }
}
