import * as THREE from 'three';

/**
 * Ribbon strips along a polyline (roads, towpath, footpaths, river banks).
 * `lats` are lateral offsets (+ = right of travel, side = tangent × up = (−tz, tx)), left to right.
 * `yOf(x, z, cy, lat, i)` gives the vertex height (cy = the polyline's own y at that ring).
 * Returns indexed geometry with position + normal (+ optional colour from `colOf`).
 */
export function stripGeometry(
  pts: THREE.Vector3[], lats: number[],
  yOf: (x: number, z: number, cy: number, lat: number, ring: number) => number,
  colOf?: (x: number, z: number, y: number, lat: number, ring: number, out: THREE.Color) => void,
): THREE.BufferGeometry {
  const n = pts.length, m = lats.length;
  const pos = new Float32Array(n * m * 3);
  const col = colOf ? new Float32Array(n * m * 3) : null;
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    const sx = -tz, sz = tx;
    const p = pts[i];
    for (let j = 0; j < m; j++) {
      const x = p.x + sx * lats[j], z = p.z + sz * lats[j];
      const y = yOf(x, z, p.y, lats[j], i);
      const k = (i * m + j) * 3;
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      if (col && colOf) { colOf(x, z, y, lats[j], i, c); col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b; }
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < m - 1; j++) {
    const a = i * m + j, b = a + 1, d = a + m, e = d + 1;
    // winding so faces point up: ring i → i+1 is "forward", j → j+1 is "right"
    idx.push(a, b, d, b, e, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // ensure the faces point up (flip if the average normal is down)
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  let sy = 0;
  for (let i = 0; i < nrm.count; i++) sy += nrm.getY(i);
  if (sy < 0) {
    const ix = g.getIndex()!.array as Uint16Array | Uint32Array;
    for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
    g.computeVertexNormals();
  }
  return g;
}

/** split points into overlapping pieces of ~`every` samples (so each piece chunks / culls on its own) */
export function pieces<T>(pts: T[], every: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < pts.length - 1; i += every) out.push(pts.slice(i, Math.min(pts.length, i + every + 1)));
  return out;
}
