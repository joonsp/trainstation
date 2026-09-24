import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import { Kit, V } from './kit';

/**
 * Dagger-board valance: a thin board of `len` (along local x, centred) hanging DOWN from y=0,
 * solid strip `h*0.4` then pointed teeth of width `tooth`. Thickness 0.05 along z.
 */
export function valanceGeometry(len: number, h: number, tooth: number): THREE.BufferGeometry {
  const n = Math.max(1, Math.round(len / tooth));
  const tw = len / n;
  const strip = h * 0.4;
  const s = new THREE.Shape();
  s.moveTo(-len / 2, 0);
  s.lineTo(len / 2, 0);
  s.lineTo(len / 2, -strip);
  for (let i = n - 1; i >= 0; i--) {
    const x0 = -len / 2 + i * tw;
    s.lineTo(x0 + tw / 2, -h);
    s.lineTo(x0, -strip);
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -0.025);
  return g;
}

export function buildCanopies(ctx: Ctx, wm: WorldMats, root: THREE.Object3D, pickables: THREE.Object3D[]): THREE.Group[] {
  void wm;
  const L = ctx.layout;
  const m = ctx.mats;
  const out: THREE.Group[] = [];

  for (const P of [L.platforms[1], L.platforms[2]]) {
    const kit = new Kit();
    const side = L.lines[P.line].platformSide;
    const e = -side;                    // local z toward the track
    const CL = P.canopyLength;
    const zEdge = e * (P.width / 2 - 0.1);   // track-side eave (over the coping)
    const zBack = -e * (P.width / 2 + 0.2);
    const zCol = -e * 0.2;              // single row of columns, just behind the centreline (clear of benches)
    const Y0 = 1;                       // platform top
    const EAVE = Y0 + 4.3;
    const BAY = 3.5;
    const RIDGE = 1.1;
    const nBays = Math.round(CL / BAY);
    const bay = CL / nBays;
    const zMin = Math.min(zEdge, zBack), zMax = Math.max(zEdge, zBack);
    const depth = zMax - zMin, zMid = (zMin + zMax) / 2;

    kit.push(P.center.x, 0, P.center.z, P.yaw);

    // columns every two bays, with bases, capitals and spandrel brackets
    for (let i = 0; i <= nBays; i += 2) {
      const x = -CL / 2 + i * bay;
      kit.cyl(m.iron, 0.2, 0.24, 0.5, 8, x, Y0, zCol);
      kit.cyl(m.iron, 0.1, 0.12, EAVE - Y0 - 0.9, 8, x, Y0 + 0.5, zCol);
      kit.cyl(m.iron, 0.26, 0.1, 0.35, 8, x, EAVE - 0.45, zCol);
      // transverse beam across the full width
      kit.boxB(m.iron, 0.18, 0.3, depth, x, EAVE - 0.3, zMid);
      // curved brackets approximated by two braces each side + a ring
      for (const sz of [-1, 1]) {
        const zt = zCol + sz * 2.2;
        kit.beam(m.iron, 0.07, 0.1, V(x, EAVE - 1.5, zCol), V(x, EAVE - 0.3, zt));
        kit.beam(m.iron, 0.05, 0.07, V(x, EAVE - 0.9, zCol), V(x, EAVE - 0.3, zCol + sz * 1.1));
        kit.add(m.iron, new THREE.TorusGeometry(0.22, 0.03, 4, 8), kit.mat(x, EAVE - 0.72, zCol + sz * 0.8, Math.PI / 2));
      }
    }
    // longitudinal girders: over the columns, and eaves (gutters) at both edges
    kit.boxB(m.iron, CL, 0.4, 0.2, 0, EAVE - 0.4, zCol);
    kit.boxB(m.iron, CL + 0.2, 0.22, 0.3, 0, EAVE - 0.05, zEdge);
    kit.boxB(m.iron, CL + 0.2, 0.22, 0.3, 0, EAVE - 0.05, zBack);

    // ridge-and-furrow glazing: transverse ridges, each bay two sloped panes
    const slope = Math.atan2(RIDGE, bay / 2);
    const paneLen = Math.hypot(RIDGE, bay / 2);
    for (let i = 0; i < nBays; i++) {
      const x0 = -CL / 2 + i * bay, xm = x0 + bay / 2;
      for (const sx of [-1, 1]) {
        const cx = xm + sx * (bay / 4);
        kit.add(m.glass, new THREE.BoxGeometry(paneLen, 0.04, depth), kit.mat(cx, EAVE + 0.15 + RIDGE / 2, zMid, 0, 0, -sx * slope));
        // glazing bars on the pane
        for (let k = 0; k <= 4; k++) {
          const zz = zMin + (depth * k) / 4;
          kit.add(m.iron, new THREE.BoxGeometry(paneLen, 0.06, 0.05), kit.mat(cx, EAVE + 0.17 + RIDGE / 2, zz, 0, 0, -sx * slope));
        }
      }
      // ridge cap
      kit.box(m.iron, 0.12, 0.1, depth + 0.1, xm, EAVE + 0.17 + RIDGE, zMid);
      // valley gutter
      kit.box(m.iron, 0.2, 0.12, depth + 0.1, x0, EAVE + 0.12, zMid);
      // gable-end triangles (board) on the track side and back
      for (const zz of [zEdge, zBack]) {
        const s = new THREE.Shape();
        s.moveTo(-bay / 2, 0); s.lineTo(bay / 2, 0); s.lineTo(0, RIDGE); s.closePath();
        const g = new THREE.ExtrudeGeometry(s, { depth: 0.06, bevelEnabled: false });
        g.translate(0, 0, -0.03);
        kit.add(m.cream, g, kit.mat(xm, EAVE + 0.1, zz + Math.sign(zz) * 0.12));
      }
    }
    kit.box(m.iron, 0.2, 0.12, depth + 0.1, CL / 2, EAVE + 0.12, zMid);

    // valance: dagger boards along both long edges and across the ends
    kit.add(m.cream, valanceGeometry(CL + 0.4, 0.75, 0.28), kit.mat(0, EAVE + 0.1, zEdge + Math.sign(zEdge) * 0.2));
    kit.add(m.cream, valanceGeometry(CL + 0.4, 0.75, 0.28), kit.mat(0, EAVE + 0.1, zBack + Math.sign(zBack) * 0.2));
    for (const sx of [-1, 1]) {
      kit.add(m.cream, valanceGeometry(depth + 0.4, 0.75, 0.28), kit.mat(sx * (CL / 2 + 0.2), EAVE + 0.1, zMid, Math.PI / 2));
    }

    // hanging platform number signs and a clock under the canopy
    for (const sx of [-0.25, 0.25]) {
      const x = sx * CL;
      kit.box(m.iron, 0.03, 0.6, 0.03, x - 0.4, EAVE - 0.7, zMid);
      kit.box(m.iron, 0.03, 0.6, 0.03, x + 0.4, EAVE - 0.7, zMid);
      kit.box(m.iron, 1.2, 1.2, 0.06, x, EAVE - 1.6, zMid);
      const uv = P.id === 1 ? wm.atlas.num1 : wm.atlas.num2;
      kit.quad(wm.signs, 1.1, 1.1, x, EAVE - 1.6, zMid + 0.035, 0, uv);
      kit.quad(wm.signs, 1.1, 1.1, x, EAVE - 1.6, zMid - 0.035, Math.PI, uv);
    }
    // big number on the canopy ends (gable boards)
    for (const sx of [-1, 1]) {
      kit.quad(wm.signs, 1.2, 1.2, sx * (CL / 2 + 0.26), EAVE - 1.0, zMid, sx > 0 ? Math.PI / 2 : -Math.PI / 2, P.id === 1 ? wm.atlas.num1 : wm.atlas.num2);
      kit.box(m.iron, 0.04, 1.3, 1.3, sx * (CL / 2 + 0.23), EAVE - 1.0, zMid);
      kit.box(m.iron, 0.04, 0.8, 0.04, sx * (CL / 2 + 0.23), EAVE - 0.1, zMid);
    }
    // timetable board on a column
    kit.box(m.bottleGreen, 1.3, 1.6, 0.08, 0, Y0 + 1.7, zCol - e * 0.16);
    kit.quad(wm.signs, 1.1, 1.3, 0, Y0 + 1.7, zCol - e * 0.21, e > 0 ? Math.PI : 0, wm.atlas.timetable);
    kit.pop();
    // one group per platform so the camera can fade the P2 canopy on its own (occluders)
    const g = kit.build(`canopy${P.id}`, { cast: true, receive: true });
    g.userData.pick = { kind: 'station', id: 'canopies' };
    for (const c of g.children) c.userData.pick = g.userData.pick;
    root.add(g);
    pickables.push(g);
    out.push(g);
  }
  return out;
}
