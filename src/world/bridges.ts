import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import type { Batch } from './batch';
import { V } from './kit';

/**
 * BRIDGES (layout.bridges): Glenmoor Warren-truss girder bridge (Highland over the river), Kingsmead brick arches
 * with cutwaters (coast over the river), Ashbourne stone humpback (Kingsport Road over the river) and the Wyke Arch
 * underbridge (Highland over Wyke Lane) with brick retaining walls along the cutting.
 * Rails stay at y 0.35 (the ballast sweep runs over every deck); road ribbons carry their own baked y.
 */
export function buildBridges(ctx: Ctx, wm: WorldMats, batch: Batch): void {
  const L = ctx.layout;
  const m = ctx.mats;
  const H = (x: number, z: number) => L.heightAt(x, z);
  const by = (id: string) => L.bridges.find((b) => b.id === id);
  batch.cast = true;

  /** extruded elevation (shape in local x/y), extruded across local z by `w`, centred */
  const elevation = (mat: THREE.Material, shape: THREE.Shape, w: number, z = 0) => {
    const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, curveSegments: 10 });
    g.translate(0, 0, z - w / 2);
    batch.add(mat, g);
  };
  /** frame of the bridge currently being built (for ground sampling from local coords) */
  let fx = 0, fz = 0, fyaw = 0;
  const gAt = (lx: number, lz: number) => {
    const c = Math.cos(fyaw), s = Math.sin(fyaw);
    return H(fx + lx * c + lz * s, fz - lx * s + lz * c);
  };
  /**
   * wing wall (brick, stone coping) from local (x, z) running out at angle a for len metres; its top follows the
   * bank (ground + 0.25, never above `top`) so it retains the bank instead of standing proud of it.
   */
  const wing = (mat: THREE.Material, x: number, z: number, a: number, len: number, top: number, bottom: number, th = 0.8) => {
    const dx = Math.cos(a), dz = -Math.sin(a);
    // the wall stands ~0.6 m proud of the bank it retains (never above the deck), stepping down to the far end
    const t0 = Math.min(top, Math.max(bottom + 0.5, gAt(x, z) + 0.95));
    const t1 = Math.min(top, Math.max(bottom + 0.3, gAt(x + dx * len, z + dz * len) + 0.4));
    batch.push(x, 0, z, a);
    const s = new THREE.Shape();
    s.moveTo(0, bottom); s.lineTo(len, bottom); s.lineTo(len, t1); s.lineTo(0, t0); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: th, bevelEnabled: false });
    g.translate(0, 0, -th / 2);
    batch.add(mat, g);
    // a slim blue-brick coping (no wider than the wall + a lip; a pale one read as a loose plank on the grass)
    const cg = new THREE.BoxGeometry(Math.hypot(len, t1 - t0) + 0.1, 0.12, th + 0.08);
    batch.add(m.brickDark, cg, batch.mat(len / 2, (t0 + t1) / 2 + 0.06, 0, 0, 0, Math.atan2(t1 - t0, len)));
    batch.pop();
  };
  /**
   * yaw (bridge-local) for a wing wall at abutment corner (sx, sz): along the river bank, running away from the
   * deck on the corner's side — so the walls line the banks instead of splaying across the grass.
   */
  const bankYaw = (riverS: number, sx: number, sz: number): number => {
    const ry = L.river.poly.yawAt(riverS);
    const wx = Math.cos(ry), wz = -Math.sin(ry);
    const c = Math.cos(fyaw), s = Math.sin(fyaw);
    let lx = wx * c - wz * s, lz = wx * s + wz * c;
    if (lz * sz < 0) { lx = -lx; lz = -lz; }
    // keep it on the land side of the abutment
    if (lx * sx < -0.2) lx = -0.2 * sx;
    return Math.atan2(-lz, lx);
  };

  // ───────────── Glenmoor: Warren-truss girder bridge ─────────────
  {
    const b = by('glenmoor');
    if (b) {
      const R = L.river;
      const bed = R.waterYAt(b.riverS ?? 0) - 1.4;
      fx = b.center.x; fz = b.center.z; fyaw = b.yaw;
      batch.push(b.center.x, 0, b.center.z, b.yaw);
      const half = b.span / 2;
      // abutments (dressed stone) with cream copings, and wing walls along the banks
      for (const sx of [-1, 1]) {
        batch.boxB(m.stone, 3.2, 0 - bed, 8.4, sx * (half + 1.6), bed, 0);
        batch.boxB(m.cream, 3.4, 0.25, 8.6, sx * (half + 1.6), -0.25, 0);
        for (const sz of [-1, 1]) wing(m.brick, sx * (half + 0.2), sz * 4.0, bankYaw(b.riverS ?? 0, sx, sz), 8, 0.1, bed, 0.7);
        // the abutment's river face shows above the bank: a dressed-stone breast wall under the truss ends
        batch.boxB(m.stone, 0.9, 0.45, 8.4, sx * (half + 0.45), -0.3, 0);
      }
      // deck plate + cross girders
      batch.boxB(m.iron, b.span + 3, 0.45, 6.2, 0, b.soffitY, 0);
      for (let x = -half; x <= half + 0.01; x += 2.75) batch.boxB(m.iron, 0.3, 0.3, 6.6, x, b.soffitY - 0.05, 0);
      // two Warren trusses in bottle green
      const TOP = 3.4, n = 8, pl = b.span / n;
      for (const sz of [-3.2, 3.2]) {
        batch.box(m.bottleGreen, b.span + 2, 0.5, 0.45, 0, 0.1, sz);          // bottom chord
        batch.box(m.bottleGreen, b.span - pl + 0.3, 0.45, 0.5, 0, TOP, sz);   // top chord
        for (let i = 0; i < n; i++) {
          const x0 = -half + i * pl, x1 = x0 + pl;
          const up = i % 2 === 0;
          const a = V(x0, up ? 0.1 : TOP, sz), c = V(x0 + pl / 2, up ? TOP : 0.1, sz), d = V(x1, up ? 0.1 : TOP, sz);
          if (i === 0) batch.beam(m.bottleGreen, 0.4, 0.35, V(-half - 0.3, 0.1, sz), V(-half + pl / 2, TOP, sz));
          else if (i === n - 1) batch.beam(m.bottleGreen, 0.4, 0.35, V(half - pl / 2, TOP, sz), V(half + 0.3, 0.1, sz));
          else { batch.beam(m.bottleGreen, 0.3, 0.3, a, c); batch.beam(m.bottleGreen, 0.3, 0.3, c, d); }
          batch.box(m.iron, 0.12, TOP - 0.3, 0.2, x0 + pl / 2, TOP / 2 + 0.1, sz + (sz > 0 ? 0.24 : -0.24));
        }
        // end posts
        for (const sx of [-1, 1]) batch.boxB(m.bottleGreen, 0.5, 1.2, 0.6, sx * (half + 0.4), 0, sz);
      }
      // top lateral bracing (open so trains read through it)
      for (let x = -half + pl; x <= half - pl + 0.01; x += pl * 2) batch.box(m.iron, 0.2, 0.2, 6.4, x, TOP + 0.05, 0);
      batch.pop();
    }
  }

  // ───────────── Kingsmead: three segmental brick arches with cutwaters ─────────────
  {
    const b = by('kingsmead');
    if (b) {
      const R = L.river;
      const wy = R.waterYAt(b.riverS ?? 0);
      const bed = wy - 1.4;
      const half = b.span / 2, abut = 4.5;
      const pier = 1.3;
      const clear = (b.span - 2 * pier) / 3;
      const spring = wy - 0.1, crown = b.soffitY;
      fx = b.center.x; fz = b.center.z; fyaw = b.yaw;
      batch.push(b.center.x, 0, b.center.z, b.yaw);
      const x0 = -half - abut, x1 = half + abut;
      // build the outline with the arch openings notched out of the bottom (walk left→right along the base)
      const outline = new THREE.Shape();
      outline.moveTo(x0, bed); outline.lineTo(x0, 0); outline.lineTo(x1, 0); outline.lineTo(x1, bed);
      let xc = half;
      for (let k = 2; k >= 0; k--) {
        const xb = xc, xa = xb - clear;
        outline.lineTo(xb, bed);
        outline.lineTo(xb, spring);
        const mid = (xa + xb) / 2, hw = clear / 2, rise = crown - spring;
        for (let i = 1; i <= 12; i++) { const x = xb - (clear * i) / 12; outline.lineTo(x, spring + rise * Math.sqrt(Math.max(0, 1 - ((x - mid) / hw) ** 2))); }
        outline.lineTo(xa, bed);
        xc = xa - pier;
      }
      outline.closePath();
      elevation(m.brick, outline, b.width + 0.6);
      // voussoir rings (cream) on both faces + parapets with copings
      for (const sz of [-1, 1]) {
        let xr = half;
        for (let k = 0; k < 3; k++) {
          const xb = xr, xa = xb - clear, mid = (xa + xb) / 2, hw = clear / 2, rise = crown - spring;
          const ring = new THREE.Shape();
          const N = 12;
          ring.moveTo(xb + 0.45, spring);
          for (let i = 0; i <= N; i++) { const x = xb + 0.45 - ((clear + 0.9) * i) / N; ring.lineTo(x, spring + (rise + 0.45) * Math.sqrt(Math.max(0, 1 - ((x - mid) / (hw + 0.45)) ** 2))); }
          ring.lineTo(xa, spring);
          for (let i = 0; i <= N; i++) { const x = xa + (clear * i) / N; ring.lineTo(x, spring + rise * Math.sqrt(Math.max(0, 1 - ((x - mid) / hw) ** 2))); }
          ring.closePath();
          const g = new THREE.ExtrudeGeometry(ring, { depth: 0.12, bevelEnabled: false, curveSegments: 4 });
          g.translate(0, 0, sz * ((b.width + 0.6) / 2) + (sz > 0 ? 0 : -0.12));
          batch.add(m.cream, g);
          xr = xa - pier;
        }
        batch.boxB(m.brick, x1 - x0, 1.0, 0.45, 0, 0, sz * ((b.width + 0.6) / 2 - 0.22));
        batch.boxB(m.cream, x1 - x0 + 0.2, 0.16, 0.6, 0, 1.0, sz * ((b.width + 0.6) / 2 - 0.22));
        batch.boxB(m.cream, x1 - x0, 0.25, 0.3, 0, -0.35, sz * ((b.width + 0.6) / 2 + 0.1)); // string course
      }
      // cutwaters on both piers, both faces (pointed, stone caps)
      let xp = half - clear;
      for (let k = 0; k < 2; k++) {
        const px = xp - pier / 2;
        for (const sz of [-1, 1]) {
          const cw = new THREE.Shape();
          cw.moveTo(-pier / 2, 0); cw.lineTo(pier / 2, 0); cw.lineTo(0, 1.5); cw.closePath();
          let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(cw, { depth: spring + 0.8 - bed, bevelEnabled: false });
          // extrusion along +z → rotate so it rises along y; the point then faces −z
          g.rotateX(-Math.PI / 2);
          g.translate(px, bed, 0);
          if (sz > 0) g = mirrorZ(g, 0);
          g.translate(0, 0, sz * ((b.width + 0.6) / 2));
          batch.add(m.stone, g);
          batch.add(m.stone, new THREE.ConeGeometry(pier * 0.72, 1.0, 4), batch.mat(px, spring + 1.3, sz * ((b.width + 0.6) / 2 + 0.55), Math.PI / 4));
        }
        xp -= pier + clear;
      }
      // wing walls splaying along the banks
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) wing(m.brick, sx * (half + abut - 0.4), sz * ((b.width + 0.6) / 2), bankYaw(b.riverS ?? 0, sx, sz), 6, 0.0, bed + 0.6, 0.6);
      // the deck is ballasted from parapet to parapet (no bare brick slab beside the single track)
      batch.boxB(m.ballast, x1 - x0, 0.06, b.width + 0.6 - 0.9, 0, 0, 0);
      batch.pop();
    }
  }

  // ───────────── Ashbourne: stone humpback road bridge ─────────────
  {
    const b = by('ashbourne');
    if (b && b.road && b.roadS !== undefined) {
      const e = L.roads.edges[b.road];
      const R = L.river;
      const wy = R.waterYAt(b.riverS ?? 0), bed = wy - 1.4;
      const c = e.poly.at(b.roadS);
      const yaw = e.poly.yawAt(b.roadS);
      const t = e.poly.tangent(b.roadS);
      const HALFL = 13;
      // top profile from the road's baked y (local x along the road)
      const top: [number, number][] = [];
      for (let x = -HALFL; x <= HALFL + 0.01; x += 1) {
        const p = V(c.x + t.x * x, 0, c.z + t.z * x);
        const n = e.poly.nearest(p.x, p.z);
        top.push([x, e.poly.yAt(n.s) - 0.06]);
      }
      const half = 10.2, spring = wy + 0.1, rise = b.soffitY - spring;
      const sh = new THREE.Shape();
      sh.moveTo(-HALFL, Math.min(bed, H(c.x - t.x * HALFL, c.z - t.z * HALFL) - 1));
      for (const [x, y] of top) sh.lineTo(x, y);
      sh.lineTo(HALFL, Math.min(bed, H(c.x + t.x * HALFL, c.z + t.z * HALFL) - 1));
      sh.lineTo(half, bed);
      sh.lineTo(half, spring);
      for (let i = 1; i < 16; i++) { const x = half - (2 * half * i) / 16; sh.lineTo(x, spring + rise * Math.sqrt(Math.max(0, 1 - (x / half) ** 2))); }
      sh.lineTo(-half, spring);
      sh.lineTo(-half, bed);
      sh.closePath();
      batch.push(c.x, 0, c.z, yaw);
      // wide enough that the Kingsport Road footway (width/2 + 0.6 off the crown) runs INSIDE the parapet
      const W = b.width + 2.4;
      elevation(m.stone, sh, W);
      // voussoirs + parapets following the hump
      for (const sz of [-1, 1]) {
        const ring = new THREE.Shape();
        ring.moveTo(half + 0.6, spring);
        for (let i = 0; i <= 16; i++) { const x = half + 0.6 - ((2 * half + 1.2) * i) / 16; ring.lineTo(x, spring + (rise + 0.6) * Math.sqrt(Math.max(0, 1 - (x / (half + 0.6)) ** 2))); }
        ring.lineTo(-half, spring);
        for (let i = 0; i <= 16; i++) { const x = -half + (2 * half * i) / 16; ring.lineTo(x, spring + rise * Math.sqrt(Math.max(0, 1 - (x / half) ** 2))); }
        ring.closePath();
        const g = new THREE.ExtrudeGeometry(ring, { depth: 0.14, bevelEnabled: false });
        g.translate(0, 0, sz > 0 ? W / 2 : -W / 2 - 0.14);
        batch.add(m.cream, g);
        // parapet: a strip of boxes riding the road profile
        for (let i = 0; i < top.length - 1; i++) {
          const [xa, ya] = top[i], [xb, yb] = top[i + 1];
          const zz = sz * (W / 2 - 0.3);
          batch.add(m.stone, new THREE.BoxGeometry(0.55, 1.0, Math.hypot(xb - xa, yb - ya) + 0.02), lookMat(V(xa, ya + 0.56, zz), V(xb, yb + 0.56, zz)));
          batch.add(m.cream, new THREE.BoxGeometry(0.7, 0.14, Math.hypot(xb - xa, yb - ya) + 0.02), lookMat(V(xa, ya + 1.12, zz), V(xb, yb + 1.12, zz)));
        }
        // end piers
        for (const sx of [-1, 1]) {
          const [, ye] = top[sx < 0 ? 0 : top.length - 1];
          batch.boxB(m.stone, 0.9, 1.5, 0.9, sx * HALFL, ye, sz * (W / 2 - 0.3));
          batch.add(m.cream, new THREE.ConeGeometry(0.62, 0.5, 4), batch.mat(sx * HALFL, ye + 1.75, sz * (W / 2 - 0.3), Math.PI / 4));
        }
      }
      batch.pop();
    }
  }

  // ───────────── Wyke Arch: brick underbridge + cutting walls along Wyke Lane ─────────────
  {
    const b = by('wykeArch');
    if (b && b.road && b.roadS !== undefined) {
      const e = L.roads.edges[b.road];
      const ry = e.poly.yAt(b.roadS);
      const half = b.span / 2, spring = ry + 2.3, rise = b.soffitY - spring;
      batch.push(b.center.x, 0, b.center.z, b.yaw);
      const W = b.width + 1.2, X = half + 7;
      const sh = new THREE.Shape();
      sh.moveTo(-X, ry - 0.3); sh.lineTo(-X, 0); sh.lineTo(X, 0); sh.lineTo(X, ry - 0.3);
      sh.lineTo(half, ry - 0.3); sh.lineTo(half, spring);
      for (let i = 1; i < 14; i++) { const x = half - (2 * half * i) / 14; sh.lineTo(x, spring + rise * Math.sqrt(Math.max(0, 1 - (x / half) ** 2))); }
      sh.lineTo(-half, spring); sh.lineTo(-half, ry - 0.3); sh.closePath();
      elevation(m.brick, sh, W);
      for (const sz of [-1, 1]) {
        const ring = new THREE.Shape();
        ring.moveTo(half + 0.5, spring);
        for (let i = 0; i <= 14; i++) { const x = half + 0.5 - ((2 * half + 1) * i) / 14; ring.lineTo(x, spring + (rise + 0.5) * Math.sqrt(Math.max(0, 1 - (x / (half + 0.5)) ** 2))); }
        ring.lineTo(-half, spring);
        for (let i = 0; i <= 14; i++) { const x = -half + (2 * half * i) / 14; ring.lineTo(x, spring + rise * Math.sqrt(Math.max(0, 1 - (x / half) ** 2))); }
        ring.closePath();
        const g = new THREE.ExtrudeGeometry(ring, { depth: 0.12, bevelEnabled: false });
        g.translate(0, 0, sz > 0 ? W / 2 : -W / 2 - 0.12);
        batch.add(m.cream, g);
        // low parapet over the arch + string course
        batch.boxB(m.brick, 2 * X, 1.0, 0.45, 0, 0, sz * (W / 2 - 0.22));
        batch.boxB(m.cream, 2 * X + 0.2, 0.16, 0.6, 0, 1.0, sz * (W / 2 - 0.22));
        // pilasters at the arch
        for (const sx of [-1, 1]) batch.boxB(m.brickDark, 0.8, 1.6 - (ry - 0.3), 0.3, sx * (half + 1.2), ry - 0.3, sz * (W / 2 + 0.15));
      }
      batch.pop();
      // retaining walls along the cutting (both sides), stepped every 2 m, following road and ground
      const s0 = b.roadS - 48, s1 = b.roadS + 48;
      const hw = e.width / 2 + 0.55;
      for (const side of [-1, 1]) {
        for (let s = s0; s < s1; s += 2) {
          const pa = e.poly.offset(s, side * hw), pb = e.poly.offset(s + 2, side * hw);
          const yr = Math.min(pa.y, pb.y);
          const ga = H(e.poly.offset(s, side * (hw + 2.2)).x, e.poly.offset(s, side * (hw + 2.2)).z);
          const gb = H(e.poly.offset(s + 2, side * (hw + 2.2)).x, e.poly.offset(s + 2, side * (hw + 2.2)).z);
          const topY = Math.max(ga, gb) + 0.35;
          if (topY - yr < 0.9) continue;
          // skip under the bridge deck itself
          const mid = pa.clone().lerp(pb, 0.5);
          if (Math.hypot(mid.x - b.center.x, mid.z - b.center.z) < W / 2 + 0.5) continue;
          const len = pa.distanceTo(pb) + 0.05;
          const yaw = Math.atan2(-(pb.z - pa.z), pb.x - pa.x);
          batch.push(mid.x, 0, mid.z, yaw);
          batch.boxB(m.brick, len, topY - yr + 0.3, 0.6, 0, yr - 0.3, side * 0.3);
          batch.boxB(m.cream, len + 0.02, 0.14, 0.75, 0, topY, side * 0.3);
          batch.pop();
        }
      }
    }
  }
  batch.cast = false;
  void wm;
}


function mirrorZ(g: THREE.BufferGeometry, w: number): THREE.BufferGeometry {
  // reflect across z = 0 then flip winding (used for the upstream cutwaters)
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setZ(i, -p.getZ(i));
  const ix = g.getIndex();
  if (ix) { const a = ix.array as Uint16Array | Uint32Array; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } }
  else {
    const arr = p.array as Float32Array;
    for (let i = 0; i < arr.length; i += 9) for (let k = 0; k < 3; k++) { const t = arr[i + 3 + k]; arr[i + 3 + k] = arr[i + 6 + k]; arr[i + 6 + k] = t; }
  }
  g.computeVertexNormals();
  void w;
  return g;
}

/** matrix placing a box (length along local z) between two points */
function lookMat(a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  const d = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), d, new THREE.Vector3(0, 1, 0));
  m.setPosition(a.clone().add(b).multiplyScalar(0.5));
  return m;
}
