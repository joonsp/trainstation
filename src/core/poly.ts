import * as THREE from 'three';

/**
 * Arc-length parameterised polyline in xz (y carried along and interpolated).
 * `s` = metres from pts[0]. Lateral convention matches the rail lines: the side vector is
 * tangent × up = (−tz, 0, tx), i.e. +lateral is to the RIGHT of travel in +s direction.
 * Yaw convention matches three: rotation.y = yawAt(s) maps local +x onto the tangent.
 */
export class Poly {
  readonly pts: THREE.Vector3[];
  /** cumulative xz length at each point */
  readonly cum: Float64Array;
  readonly length: number;

  constructor(pts: THREE.Vector3[]) {
    if (pts.length < 2) throw new Error('Poly needs >= 2 points');
    this.pts = pts;
    this.cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
      this.cum[i] = this.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    }
    this.length = this.cum[pts.length - 1];
  }

  /** straight-segment resample of control points every ~step metres (keeps the exact corners) */
  static linear(ctrl: THREE.Vector3[], step = 2): Poly {
    const out: THREE.Vector3[] = [ctrl[0].clone()];
    for (let i = 1; i < ctrl.length; i++) {
      const a = ctrl[i - 1], b = ctrl[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
      for (let k = 1; k <= n; k++) out.push(a.clone().lerp(b, k / n));
    }
    return new Poly(out);
  }

  /** centripetal Catmull-Rom through control points, resampled every ~step metres */
  static smooth(ctrl: THREE.Vector3[], step = 2): Poly {
    if (ctrl.length === 2) return Poly.linear(ctrl, step);
    const c = new THREE.CatmullRomCurve3(ctrl.map((p) => p.clone()), false, 'centripetal');
    const approx = c.getLength();
    const n = Math.max(2, Math.ceil(approx / step));
    c.arcLengthDivisions = n * 4;
    return new Poly(c.getSpacedPoints(n));
  }

  private seg(s: number): number {
    const cum = this.cum;
    if (s <= 0) return 0;
    if (s >= this.length) return this.pts.length - 2;
    let lo = 0, hi = this.pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    return lo;
  }

  /** point at arc length s (clamped), y interpolated */
  at(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const i = this.seg(s);
    const a = this.pts[i], b = this.pts[i + 1];
    const L = this.cum[i + 1] - this.cum[i] || 1;
    const u = THREE.MathUtils.clamp((s - this.cum[i]) / L, 0, 1);
    return out.set(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
  }

  /** y at arc length s */
  yAt(s: number): number {
    const i = this.seg(s);
    const L = this.cum[i + 1] - this.cum[i] || 1;
    const u = THREE.MathUtils.clamp((s - this.cum[i]) / L, 0, 1);
    return this.pts[i].y + (this.pts[i + 1].y - this.pts[i].y) * u;
  }

  /** unit xz tangent (y = 0) at s, smoothed over ±1 m so corners of the resample don't snap */
  tangent(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const a = this.at(Math.max(0, s - 1), _a), b = this.at(Math.min(this.length, s + 1), _b);
    out.set(b.x - a.x, 0, b.z - a.z);
    const l = Math.hypot(out.x, out.z);
    if (l < 1e-9) return out.set(1, 0, 0);
    return out.multiplyScalar(1 / l);
  }

  /** point at s shifted by `lateral` along (tangent × up); y from the polyline unless given */
  offset(s: number, lateral: number, y?: number, out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.tangent(s, _t);
    this.at(s, out);
    out.x += -t.z * lateral;
    out.z += t.x * lateral;
    if (y !== undefined) out.y = y;
    return out;
  }

  /** rotation.y mapping local +x onto the tangent at s */
  yawAt(s: number): number {
    const t = this.tangent(s, _t);
    return Math.atan2(-t.z, t.x);
  }

  /** nearest point (xz): arc length, unsigned distance and signed lateral (+ = right of travel) */
  nearest(x: number, z: number): { s: number; d: number; lat: number } {
    let best = Infinity, bs = 0, blat = 0;
    const p = this.pts;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const l2 = abx * abx + abz * abz || 1e-9;
      const u = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / l2, 0, 1);
      const qx = a.x + abx * u, qz = a.z + abz * u;
      const d = Math.hypot(x - qx, z - qz);
      if (d < best) {
        best = d;
        bs = this.cum[i] + u * Math.sqrt(l2);
        // lateral sign: side = (−tz, tx) · (p − q)
        const inv = 1 / Math.sqrt(l2);
        blat = ((-abz * inv) * (x - qx) + (abx * inv) * (z - qz)) >= 0 ? d : -d;
      }
    }
    return { s: bs, d: best, lat: blat };
  }

  /** sub-polyline between s0 and s1 (s0 > s1 reverses it) */
  slice(s0: number, s1: number, step = 2): THREE.Vector3[] {
    const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / step));
    const out: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) out.push(this.at(s0 + ((s1 - s0) * i) / n));
    return out;
  }

  /** all intersections (xz) with another polyline: arc lengths on both */
  intersections(o: Poly): { s: number; so: number; p: THREE.Vector3 }[] {
    const res: { s: number; so: number; p: THREE.Vector3 }[] = [];
    const A = this.pts, B = o.pts;
    for (let i = 0; i < A.length - 1; i++) {
      const a0 = A[i], a1 = A[i + 1];
      const minx = Math.min(a0.x, a1.x), maxx = Math.max(a0.x, a1.x), minz = Math.min(a0.z, a1.z), maxz = Math.max(a0.z, a1.z);
      for (let j = 0; j < B.length - 1; j++) {
        const b0 = B[j], b1 = B[j + 1];
        if (Math.max(b0.x, b1.x) < minx || Math.min(b0.x, b1.x) > maxx || Math.max(b0.z, b1.z) < minz || Math.min(b0.z, b1.z) > maxz) continue;
        const rx = a1.x - a0.x, rz = a1.z - a0.z, sx = b1.x - b0.x, sz = b1.z - b0.z;
        const den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-12) continue;
        const qx = b0.x - a0.x, qz = b0.z - a0.z;
        const u = (qx * sz - qz * sx) / den, v = (qx * rz - qz * rx) / den;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        const s = this.cum[i] + u * (this.cum[i + 1] - this.cum[i]);
        const so = o.cum[j] + v * (o.cum[j + 1] - o.cum[j]);
        if (res.some((r) => Math.abs(r.s - s) < 0.5)) continue;
        res.push({ s, so, p: new THREE.Vector3(a0.x + rx * u, 0, a0.z + rz * u) });
      }
    }
    return res.sort((p, q) => p.s - q.s);
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _t = new THREE.Vector3();

/** local (x along yaw, z lateral) → world for rotation.y = yaw (local +x → (cos,0,−sin), +z → (sin,0,cos)) */
export function localToWorld(origin: THREE.Vector3, yaw: number, lx: number, lz: number, y = origin.y, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return out.set(origin.x + lx * c + lz * s, y, origin.z - lx * s + lz * c);
}

/** inverse of localToWorld (xz only): returns (lx, lz) */
export function worldToLocal(origin: THREE.Vector3, yaw: number, x: number, z: number): [number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const dx = x - origin.x, dz = z - origin.z;
  return [dx * c - dz * s, dx * s + dz * c];
}

/** distance (xz) from p to a polyline given as raw points */
export function distToPolyline(x: number, z: number, pts: THREE.Vector3[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const abx = b.x - a.x, abz = b.z - a.z;
    const l2 = abx * abx + abz * abz || 1e-9;
    const u = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / l2, 0, 1);
    const d = Math.hypot(x - (a.x + abx * u), z - (a.z + abz * u));
    if (d < best) best = d;
  }
  return best;
}

/** point in polygon (xz; polygon as Vector2 x/y = world x/z) */
export function pointInPoly(x: number, z: number, poly: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > z) !== (b.y > z) && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** cheap deterministic value noise in [0,1] (identical to the v1 world/env.ts noise2) */
function hash(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
export function noise2(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
