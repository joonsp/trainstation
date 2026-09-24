import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { PlatformLayout } from '../core/layout';
import type { WorldMats } from './materials';
import type { UV } from './textures';
import { Kit, V } from './kit';
import { pickProxy, type Batch } from './batch';
import type { Rng } from '../core/rng';

/** wedge-shaped extrusion helper: a ramp from height h at x=0 down to 0 at x=len (in current frame), width w centred on z */
function ramp(kit: Kit, mat: THREE.Material, len: number, h: number, w: number, x: number, z: number, dirX: 1 | -1) {
  const s = new THREE.Shape();
  s.moveTo(0, 0); s.lineTo(len, 0); s.lineTo(0, h); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
  g.translate(0, 0, -w / 2);
  kit.add(mat, g, kit.mat(x, 0, z, dirX === 1 ? 0 : Math.PI));
}

export function bench(kit: Kit, ctx: Ctx, x: number, y: number, z: number, yaw: number) {
  const m = ctx.mats;
  kit.push(x, y, z, yaw);
  // local +z = front (faces track)
  kit.box(m.wood, 1.9, 0.07, 0.5, 0, 0.46, 0.02);
  kit.box(m.wood, 1.9, 0.12, 0.05, 0, 0.72, -0.24, 0, -0.18);
  kit.box(m.wood, 1.9, 0.12, 0.05, 0, 0.9, -0.27, 0, -0.18);
  for (const sx of [-0.85, 0.85]) {
    kit.box(m.iron, 0.07, 0.46, 0.08, sx, 0.23, 0.18);
    kit.box(m.iron, 0.07, 0.95, 0.08, sx, 0.47, -0.22, 0, -0.18);
    kit.box(m.iron, 0.07, 0.06, 0.5, sx, 0.62, 0.0);
  }
  kit.pop();
}

export function lampPost(kit: Kit, ctx: Ctx, wm: WorldMats, x: number, y: number, z: number, h = 3.3) {
  const m = ctx.mats;
  kit.cyl(m.iron, 0.13, 0.2, 0.5, 8, x, y, z);
  kit.cyl(m.iron, 0.06, 0.08, h, 6, x, y + 0.5, z);
  kit.box(m.iron, 0.7, 0.05, 0.05, x, y + h - 0.35, z); // ladder bar
  kit.cyl(m.iron, 0.16, 0.08, 0.15, 6, x, y + h + 0.45, z);
  kit.add(wm.lantern, new THREE.CylinderGeometry(0.24, 0.16, 0.5, 4, 1), kit.mat(x, y + h + 0.85, z, Math.PI / 4));
  kit.add(m.iron, new THREE.ConeGeometry(0.3, 0.3, 4), kit.mat(x, y + h + 1.25, z, Math.PI / 4));
  kit.add(m.iron, new THREE.SphereGeometry(0.06, 5, 3), kit.mat(x, y + h + 1.45, z));
}

export function signBoard(kit: Kit, ctx: Ctx, wm: WorldMats, uv: UV, w: number, h: number, x: number, y: number, z: number, yaw: number, postH: number, twoSided = true) {
  const m = ctx.mats;
  kit.push(x, y, z, yaw);
  for (const sx of [-w / 2 + 0.25, w / 2 - 0.25]) kit.cyl(m.iron, 0.06, 0.08, postH + h, 6, sx, 0, 0);
  kit.box(m.iron, w + 0.12, h + 0.12, 0.06, 0, postH + h / 2, 0);
  kit.quad(wm.signs, w, h, 0, postH + h / 2, 0.035, 0, uv);
  if (twoSided) kit.quad(wm.signs, w, h, 0, postH + h / 2, -0.035, Math.PI, uv);
  kit.pop();
}

export function buildPlatforms(ctx: Ctx, wm: WorldMats, root: THREE.Object3D, rng: Rng, pickables: THREE.Object3D[], batch: Batch): void {
  const L = ctx.layout;
  const m = ctx.mats;
  // v2: merged into the global static batch (one draw per material for the whole station area)
  const kit = batch;
  kit.cast = true;

  for (const P of [L.platforms[1], L.platforms[2]]) buildOne(P);

  function buildOne(P: PlatformLayout) {
    const line = L.lines[P.line];
    const side = line.platformSide;
    const e = -side; // local z direction toward the track edge
    const W = P.width, Ln = P.length;
    kit.push(P.center.x, 0, P.center.z, P.yaw);
    // body: brick with paved top and cream coping on the track face
    kit.boxB(m.brick, Ln, 0.92, W - 0.2, 0, 0, -e * 0.1);
    kit.boxB(m.platform, Ln, 0.08, W - 0.55, 0, 0.92, -e * 0.275);
    kit.boxB(m.cream, Ln, 0.1, 0.6, 0, 0.9, e * (W / 2 - 0.15));
    // shadow recess under the coping
    kit.boxB(wm.dark, Ln - 0.02, 0.5, 0.05, 0, 0.35, e * (W / 2 - 0.36));
    // yellowed edge line of paving slabs (subtle)
    kit.boxB(m.stone, Ln, 0.085, 0.25, 0, 0.92, e * (W / 2 - 0.62));
    // ramps at both ends (on the back 5.5 m)
    const rw = W - 1.2, rz = -e * 0.6;
    ramp(kit, m.platform, 6, 1.0, rw, Ln / 2, rz, 1);
    ramp(kit, m.platform, 6, 1.0, rw, -Ln / 2, rz, -1);
    for (const sx of [-1, 1]) {
      // ramp side walls / railings
      kit.boxB(m.brick, 6, 0.3, 0.2, sx * (Ln / 2 + 3), 0, rz - rw / 2 + 0.1);
    }

    // back-edge railings except where the concourse joins the station (and at the footbridge)
    const backZ = -e * (W / 2 - 0.1);
    const toLocal = (p: THREE.Vector3) => {
      const c = Math.cos(P.yaw), s = Math.sin(P.yaw);
      const dx = p.x - P.center.x, dz = p.z - P.center.z;
      return { x: dx * c - dz * s, z: dx * s + dz * c };
    };
    const st = L.station;
    const stLocal = toLocal(st.center);
    const gap0 = stLocal.x - st.size.x / 2 - 3, gap1 = stLocal.x + st.size.x / 2 + 3;
    let prevX: number | null = null;
    for (let x = -Ln / 2 + 1; x <= Ln / 2 - 1; x += 2.2) {
      if (x > gap0 && x < gap1) { prevX = null; continue; }
      kit.boxB(m.iron, 0.07, 1.1, 0.07, x, 1, backZ);
      kit.add(m.iron, new THREE.SphereGeometry(0.06, 4, 2), kit.mat(x, 2.13, backZ));
      if (prevX !== null) {
        kit.box(m.iron, x - prevX, 0.05, 0.04, (x + prevX) / 2, 2.0, backZ);
        kit.box(m.iron, x - prevX, 0.04, 0.04, (x + prevX) / 2, 1.2, backZ);
        for (let k = 1; k < 5; k++) kit.box(m.iron, 0.025, 0.8, 0.025, prevX + ((x - prevX) * k) / 5, 1.6, backZ);
      }
      prevX = x;
    }

    // luggage trolleys, milk churns, fire buckets, weighing machine
    const trolley = (x: number, z: number, yaw: number) => {
      kit.push(x, 1, z, yaw);
      kit.box(m.wood, 1.6, 0.08, 0.8, 0, 0.5, 0);
      for (const sx of [-0.7, 0.7]) kit.box(m.wood, 0.06, 0.25, 0.8, sx, 0.62, 0);
      for (const sz of [-0.42, 0.42]) kit.add(m.iron, new THREE.CylinderGeometry(0.28, 0.28, 0.06, 10), kit.mat(0.25, 0.28, sz, 0, Math.PI / 2, 0));
      kit.box(m.iron, 0.06, 0.4, 0.06, -0.7, 0.25, 0);
      kit.beam(m.iron, 0.04, 0.04, V(0.8, 0.52, -0.35), V(1.4, 1.0, -0.35));
      kit.beam(m.iron, 0.04, 0.04, V(0.8, 0.52, 0.35), V(1.4, 1.0, 0.35));
      kit.box(m.iron, 0.04, 0.04, 0.74, 1.4, 1.0, 0);
      // a trunk and a hatbox
      kit.box(m.oxblood, 0.9, 0.45, 0.6, -0.2, 0.8, 0);
      kit.box(m.brass, 0.92, 0.05, 0.62, -0.2, 0.9, 0);
      if (rng.chance(0.6)) kit.cyl(m.bottleGreen, 0.2, 0.2, 0.3, 8, -0.2, 1.03, 0);
      kit.pop();
    };
    const churn = (x: number, z: number) => {
      kit.cyl(m.rail, 0.22, 0.25, 0.7, 8, x, 1, z);
      kit.cyl(m.rail, 0.12, 0.22, 0.15, 8, x, 1.7, z);
      kit.cyl(m.iron, 0.14, 0.14, 0.08, 8, x, 1.85, z);
    };
    const tLane = -e * 1.9; // toward the back
    trolley(-Ln / 2 + 10, tLane, 0.3 + rng.range(-0.3, 0.3));
    trolley(Ln / 2 - 12, tLane + 0.3, Math.PI - 0.4 + rng.range(-0.3, 0.3));
    for (let i = 0; i < 4; i++) churn(Ln / 2 - 5 + (i % 2) * 0.6, -e * (1.5 + Math.floor(i / 2) * 0.6));
    churn(Ln / 2 - 4.3, -e * 2.4);
    // fire-bucket rack
    {
      const fx = -28, fz = -e * (W / 2 - 0.35);
      kit.box(m.bottleGreen, 1.6, 0.9, 0.1, fx, 1.9, fz);
      for (let i = 0; i < 4; i++) kit.cyl(wm.signalRed, 0.14, 0.11, 0.3, 7, fx - 0.6 + i * 0.4, 1.55, fz + e * 0.12);
    }

    // poster hoardings (two-sided) at the back, outside the station gap
    // between the lamp posts (lamps every 16 m from the centre)
    const posterXs = [-40, -24, 24, 40].filter((x) => x < gap0 || x > gap1);
    posterXs.forEach((x, i) => {
      const z = -e * (W / 2 - 0.5);
      kit.push(x, 1, z, 0);
      kit.box(m.bottleGreen, 2.4, 1.8, 0.12, 0, 1.4, 0);
      for (const sx of [-1.25, 1.25]) kit.boxB(m.iron, 0.1, 2.4, 0.1, sx, 0, 0);
      const uvA = wm.atlas.posters[(i * 2 + P.id) % wm.atlas.posters.length];
      const uvB = wm.atlas.posters[(i * 2 + P.id + 3) % wm.atlas.posters.length];
      kit.quad(wm.signs, 1.0, 1.5, -0.55, 1.4, e * 0.07, e > 0 ? 0 : Math.PI, uvA);
      kit.quad(wm.signs, 1.0, 1.5, 0.55, 1.4, e * 0.07, e > 0 ? 0 : Math.PI, uvB);
      kit.quad(wm.signs, 1.0, 1.5, 0, 1.4, -e * 0.07, e > 0 ? Math.PI : 0, uvB);
      kit.pop();
    });

    // name boards near each end of the canopy, parallel to the track, facing it
    for (const sx of [-1, 1]) {
      signBoard(kit, ctx, wm, wm.atlas.nameBoard, 5.2, 0.8, sx * (P.canopyLength / 2 + 6), 1, e * 0.6, e > 0 ? 0 : Math.PI, 1.9);
    }
    // line board near the ends
    signBoard(kit, ctx, wm, P.line === 'coast' ? wm.atlas.toCoast : wm.atlas.toHighland, 2.4, 0.45, -Ln / 2 + 4, 1, -e * 1.2, e > 0 ? 0 : Math.PI, 1.8);
    signBoard(kit, ctx, wm, P.line === 'coast' ? wm.atlas.toCoast : wm.atlas.toHighland, 2.4, 0.45, Ln / 2 - 3, 1, -e * 1.2, e > 0 ? 0 : Math.PI, 1.8);
    kit.pop();

    // benches from layout
    for (const b of P.benches) bench(kit, ctx, b.pos.x, b.pos.y, b.pos.z, b.yaw);

    // concourse: raised paved apron between the station facade and the platform back edge
    {
      const sc = Math.cos(st.yaw), ss = Math.sin(st.yaw);
      const facadeSide = Math.sign((P.center.x - st.center.x) * ss + (P.center.z - st.center.z) * sc) || 1;
      const hx = st.size.x / 2 + 2.5, hz = st.size.z / 2 - 0.5;
      const corner = (lx: number) => V(st.center.x + lx * sc + facadeSide * hz * ss, 0, st.center.z - lx * ss + facadeSide * hz * sc);
      const A = corner(-hx), B = corner(hx);
      // project onto platform back line
      const pc = Math.cos(P.yaw), ps = Math.sin(P.yaw);
      const backOff = -e * (W / 2 - 0.3);
      const proj = (p: THREE.Vector3) => {
        const dx = p.x - P.center.x, dz = p.z - P.center.z;
        const lx = THREE.MathUtils.clamp(dx * pc - dz * ps, -Ln / 2, Ln / 2);
        return V(P.center.x + lx * pc + backOff * ps, 0, P.center.z - lx * ps + backOff * pc);
      };
      const A2 = proj(A), B2 = proj(B);
      const shape = new THREE.Shape([A, B, B2, A2].map((p) => new THREE.Vector2(p.x, -p.z)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: 1.0, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      kit.add(m.platform, g);
      // brick skirt along the outer edges
      kit.beam(m.brick, 0.25, 0.95, V(A.x, 0.47, A.z).lerp(V(A2.x, 0.47, A2.z), 0.0), V(A2.x, 0.47, A2.z));
      kit.beam(m.brick, 0.25, 0.95, V(B.x, 0.47, B.z), V(B2.x, 0.47, B2.z));
      // flower tubs at the concourse corners
      for (const p of [A.clone().lerp(A2, 0.5), B.clone().lerp(B2, 0.5)]) {
        kit.cyl(m.wood, 0.45, 0.35, 0.5, 8, p.x, 1, p.z);
        kit.add(wm.shrub, new THREE.IcosahedronGeometry(0.5, 0), kit.mat(p.x, 1.7, p.z));
      }
    }
  }

  kit.cast = false;
  const g = pickProxy('platforms', { kind: 'station', id: 'platforms' },
    [L.platforms[1], L.platforms[2]].map((P) => ({ center: P.center, size: new THREE.Vector3(P.length, 1.1, P.width), yaw: P.yaw })));
  root.add(g);
  pickables.push(g);
}
