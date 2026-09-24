import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import { Kit, V } from './kit';

const WIDTH = 2.2;

/** lattice girder side between a and b (local points at deck level), height h */
function lattice(kit: Kit, mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, h: number, panel = 1.2) {
  const len = a.distanceTo(b);
  const n = Math.max(1, Math.round(len / panel));
  const up = V(0, h, 0);
  kit.beam(mat, 0.12, 0.14, a.clone(), b.clone());
  kit.beam(mat, 0.14, 0.12, a.clone().add(up), b.clone().add(up));
  for (let i = 0; i < n; i++) {
    const p0 = a.clone().lerp(b, i / n), p1 = a.clone().lerp(b, (i + 1) / n);
    kit.beam(mat, 0.05, 0.05, p0.clone(), p1.clone().add(up));
    kit.beam(mat, 0.05, 0.05, p0.clone().add(up), p1.clone());
    if (i > 0) kit.beam(mat, 0.07, 0.07, p0.clone(), p0.clone().add(up));
  }
}

/** returns the walking route a → stair top → deck → stair top → b (deck points at walking height) */
export function buildFootbridge(ctx: Ctx, wm: WorldMats, root: THREE.Object3D, pickables: THREE.Object3D[]): THREE.Vector3[] {
  void wm;
  const L = ctx.layout;
  const m = ctx.mats;
  const kit = new Kit();
  const { a, b, deck: DECK, stairRun: STAIR_RUN, landing: LANDING } = L.footbridge;
  const P1 = L.platforms[1], P2 = L.platforms[2];
  const along = (yaw: number) => V(Math.cos(yaw), 0, -Math.sin(yaw));
  // stairs climb westward (away from the building) to landings above the platforms
  const d1 = along(P1.yaw), d2 = along(P2.yaw);
  const topA = a.clone().addScaledVector(d1, -STAIR_RUN);
  const topB = b.clone().addScaledVector(d2, -STAIR_RUN);
  const landA = topA.clone().addScaledVector(d1, -LANDING), landB = topB.clone().addScaledVector(d2, -LANDING);
  // landing towers
  for (const [top, land, d] of [[topA, landA, d1], [topB, landB, d2]] as const) {
    const c = top.clone().lerp(land, 0.5);
    const yaw = Math.atan2(-d.z, d.x);
    kit.push(c.x, 0, c.z, yaw);
    kit.boxB(m.iron, 2.6, 0.3, WIDTH + 0.6, 0, DECK - 0.3, 0);
    kit.boxB(m.platform, 2.6, 0.06, WIDTH + 0.5, 0, DECK - 0.02, 0);
    for (const sx of [-1.2, 1.2]) for (const sz of [-1, 1]) {
      kit.cyl(m.iron, 0.12, 0.16, DECK - 1.3, 6, sx, 1, sz * (WIDTH / 2 + 0.2));
    }
    // cross bracing
    for (const sz of [-1, 1]) {
      kit.beam(m.iron, 0.05, 0.05, V(-1.2, 1.3, sz * 1.3), V(1.2, DECK - 0.4, sz * 1.3));
      kit.beam(m.iron, 0.05, 0.05, V(1.2, 1.3, sz * 1.3), V(-1.2, DECK - 0.4, sz * 1.3));
    }
    kit.pop();
    // stair flight from the foot (a/b at y=1) up to the landing
    const foot = top.clone().addScaledVector(d, STAIR_RUN);
    const steps = 22;
    const rise = (DECK - 1) / steps, run = STAIR_RUN / steps;
    kit.push(foot.x, 0, foot.z, yaw + Math.PI); // local +x = up the stairs (westward)
    for (let i = 0; i < steps; i++) {
      kit.boxB(m.wood, run + 0.02, 0.08, WIDTH, (i + 0.5) * run, 1 + (i + 1) * rise - 0.08, 0);
    }
    for (const sz of [-1, 1]) {
      const zz = sz * (WIDTH / 2 + 0.05);
      // stringers
      kit.beam(m.iron, 0.1, 0.3, V(0, 1.1, zz), V(STAIR_RUN, DECK - 0.1, zz));
      // handrail lattice (rake)
      lattice(kit, m.iron, V(0, 1.1, zz), V(STAIR_RUN, DECK, zz), 1.05, 0.9);
    }
    // newel posts with ball tops at the foot
    for (const sz of [-1, 1]) {
      kit.boxB(m.iron, 0.14, 1.3, 0.14, 0, 1, sz * (WIDTH / 2 + 0.05));
      kit.add(m.brass, new THREE.SphereGeometry(0.1, 6, 4), kit.mat(0, 2.35, sz * (WIDTH / 2 + 0.05)));
    }
    kit.pop();
  }

  // main span between the two landings (deck, lattice girders, roof)
  const cA = topA.clone().lerp(landA, 0.5), cB = topB.clone().lerp(landB, 0.5);
  const span = cB.clone().sub(cA);
  const spanLen = span.length();
  const yaw = Math.atan2(-span.z, span.x);
  const mid = cA.clone().lerp(cB, 0.5);
  kit.push(mid.x, 0, mid.z, yaw);
  kit.boxB(m.iron, spanLen, 0.35, WIDTH + 0.5, 0, DECK - 0.35, 0);
  kit.boxB(m.wood, spanLen, 0.05, WIDTH + 0.3, 0, DECK - 0.02, 0);
  for (const sz of [-1, 1]) {
    lattice(kit, m.iron, V(-spanLen / 2, DECK, sz * (WIDTH / 2 + 0.2)), V(spanLen / 2, DECK, sz * (WIDTH / 2 + 0.2)), 1.5, 1.3);
    kit.box(m.bottleGreen, spanLen, 0.25, 0.3, 0, DECK - 0.15, sz * (WIDTH / 2 + 0.35));
  }
  // arched roof over the span (curved corrugated iron approximated by 5 facets) on posts
  const RY = DECK + 2.7;
  for (let i = 0; i <= 6; i++) {
    const x = -spanLen / 2 + (spanLen * i) / 6;
    for (const sz of [-1, 1]) kit.box(m.iron, 0.08, RY - DECK - 1.5, 0.08, x, DECK + 1.5 + (RY - DECK - 1.5) / 2, sz * (WIDTH / 2 + 0.2));
  }
  const facets = 5, R = WIDTH / 2 + 0.6;
  for (let k = 0; k < facets; k++) {
    const a0 = Math.PI * (k / facets), a1 = Math.PI * ((k + 1) / facets);
    const z0 = Math.cos(a0) * R, y0 = Math.sin(a0) * R * 0.5, z1 = Math.cos(a1) * R, y1 = Math.sin(a1) * R * 0.5;
    const w = Math.hypot(z1 - z0, y1 - y0);
    kit.add(m.slate, new THREE.BoxGeometry(spanLen + 1.2, 0.06, w), kit.mat(0, RY + (y0 + y1) / 2, (z0 + z1) / 2, 0, Math.atan2(y1 - y0, z1 - z0) * -1, 0));
  }
  for (const sx of [-1, 1]) {
    kit.add(m.cream, valanceGeometry2(WIDTH + 1.4), kit.mat(sx * (spanLen / 2 + 0.6), RY, 0, Math.PI / 2));
  }
  kit.pop();

  const g = kit.build('footbridge', { cast: true, receive: true });
  g.userData.pick = { kind: 'station', id: 'footbridge' };
  for (const c of g.children) c.userData.pick = g.userData.pick;
  root.add(g);
  pickables.push(g);
  const at = (p: THREE.Vector3) => p.clone().setY(DECK);
  return [a.clone(), at(topA), at(cA), at(cB), at(topB), b.clone()];
}

function valanceGeometry2(len: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const n = Math.round(len / 0.3), tw = len / n;
  s.moveTo(-len / 2, 0); s.lineTo(len / 2, 0); s.lineTo(len / 2, -0.25);
  for (let i = n - 1; i >= 0; i--) { const x0 = -len / 2 + i * tw; s.lineTo(x0 + tw / 2, -0.55); s.lineTo(x0, -0.25); }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: false });
  g.translate(0, 0, -0.025);
  return g;
}
