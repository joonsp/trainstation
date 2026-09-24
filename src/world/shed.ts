import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import { Kit, V } from './kit';
import { pickProxy, type Batch } from './batch';
import type { Rng } from '../core/rng';
import { lampPost } from './platforms';

export interface ShedBuild {
  update(dt: number): void;
}

export function buildShed(ctx: Ctx, wm: WorldMats, root: THREE.Object3D, rng: Rng, pickables: THREE.Object3D[], batch: Batch): ShedBuild {
  const m = ctx.mats;
  const S = ctx.layout.shed;
  const B = S.building;
  // v2: walls, yard and props merge into the global batch; the roof is a separate occluder group
  const kit = batch;
  kit.cast = true;
  const HX = B.size.x / 2, HZ = B.size.z / 2;
  const WALL = 7.2;
  const trackZ = S.curve.getPointAt(1).z - B.center.z; // local z of the siding inside the shed

  // ── engine shed ──
  kit.push(B.center.x, 0, B.center.z, B.yaw);
  // long walls with pilasters and arched windows
  for (const sz of [-1, 1]) {
    kit.boxB(m.brick, B.size.x, WALL, 0.6, 0, 0, sz * (HZ - 0.3));
    kit.boxB(m.brickDark, B.size.x + 0.1, 0.5, 0.7, 0, 0, sz * (HZ - 0.3));
    kit.boxB(m.cream, B.size.x + 0.2, 0.25, 0.75, 0, WALL - 0.25, sz * (HZ - 0.3));
    for (let i = 0; i <= 6; i++) {
      const x = -HX + (B.size.x * i) / 6;
      kit.boxB(m.brickDark, 0.8, WALL - 0.3, 0.3, x, 0, sz * (HZ + 0.1));
    }
    for (let i = 0; i < 6; i++) {
      const x = -HX + (B.size.x * (i + 0.5)) / 6;
      kit.push(x, 0, sz * HZ, sz > 0 ? 0 : Math.PI);
      kit.archSlab(m.cream, 2.1, 3.5, 0.1, 0, 2.2, 0.02);
      kit.arch(m.windowLit, 1.7, 3.1, 0, 2.35, 0.08);
      for (let k = 1; k < 4; k++) kit.box(m.iron, 1.7, 0.04, 0.03, 0, 2.35 + k * 0.7, 0.1);
      kit.box(m.iron, 0.04, 3.0, 0.03, 0, 3.85, 0.1);
      kit.pop();
    }
  }
  // end walls: v2 through shed — both ends have an arched doorway over the road (west: the shed road to the
  // shedWest tunnel; east: the siding from the coast line)
  const doorW = 5.2, doorH = 6.0;
  {
    const zc = trackZ, r = doorW / 2;
    const leftW = HZ + zc - doorW / 2, rightW = HZ - zc - doorW / 2;
    kit.boxB(m.brick, 0.6, WALL, leftW, -HX + 0.3, 0, -HZ + leftW / 2);
    kit.boxB(m.brick, 0.6, WALL, rightW, -HX + 0.3, 0, HZ - rightW / 2);
    kit.push(-HX + 0.3, 0, zc, -Math.PI / 2);
    const s = new THREE.Shape();
    s.moveTo(-r, doorH - r); s.absarc(0, doorH - r, r, Math.PI, 0, true); s.lineTo(r, WALL); s.lineTo(-r, WALL); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.6, bevelEnabled: false, curveSegments: 8 });
    g.translate(0, 0, -0.3);
    kit.add(m.brick, g);
    const ring = new THREE.Shape();
    ring.moveTo(-r - 0.4, doorH - r); ring.absarc(0, doorH - r, r + 0.4, Math.PI, 0, true); ring.lineTo(r, doorH - r); ring.absarc(0, doorH - r, r, 0, Math.PI, false); ring.closePath();
    kit.add(m.cream, new THREE.ExtrudeGeometry(ring, { depth: 0.2, bevelEnabled: false, curveSegments: 8 }), kit.mat(0, 0, 0.25));
    kit.box(m.cream, 0.6, 0.7, 0.3, 0, doorH + 0.3, 0.4);
    kit.pop();
    // doors folded back against the west wall
    for (const sd of [-1, 1]) kit.boxB(m.bottleGreen, 0.12, doorH - 1.2, doorW / 2, -HX - 0.1 - doorW / 4 - 0.1, 0, zc + sd * (doorW / 2 + 0.1), -sd * 1.3);
  }
  {
    const zc = trackZ;
    const leftW = HZ + zc - doorW / 2, rightW = HZ - zc - doorW / 2;
    kit.boxB(m.brick, 0.8, WALL, leftW, HX - 0.4, 0, -HZ + leftW / 2);
    kit.boxB(m.brick, 0.8, WALL, rightW, HX - 0.4, 0, HZ - rightW / 2);
    // spandrel above the arch
    kit.push(HX - 0.4, 0, zc, Math.PI / 2);
    const s = new THREE.Shape();
    const r = doorW / 2;
    s.moveTo(-r, doorH - r); s.absarc(0, doorH - r, r, Math.PI, 0, true); s.lineTo(r, WALL); s.lineTo(-r, WALL); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.8, bevelEnabled: false, curveSegments: 8 });
    g.translate(0, 0, -0.4);
    kit.add(m.brick, g);
    // cream voussoir ring
    const ring = new THREE.Shape();
    ring.moveTo(-r - 0.4, doorH - r); ring.absarc(0, doorH - r, r + 0.4, Math.PI, 0, true); ring.lineTo(r, doorH - r); ring.absarc(0, doorH - r, r, 0, Math.PI, false); ring.closePath();
    const rg = new THREE.ExtrudeGeometry(ring, { depth: 0.2, bevelEnabled: false, curveSegments: 8 });
    kit.add(m.cream, rg, kit.mat(0, 0, 0.35));
    kit.box(m.cream, 0.6, 0.7, 0.3, 0, doorH + 0.3, 0.5); // keystone
    // name board above
    kit.quad(wm.signs, 4.2, 0.7, 0, WALL + 0.9, 0.45, 0, wm.atlas.shed);
    kit.pop();
    // gable over east wall
    kit.push(HX - 0.4, WALL, 0, Math.PI / 2);
    const gs = new THREE.Shape();
    gs.moveTo(-HZ, 0); gs.lineTo(HZ, 0); gs.lineTo(0, 3.6); gs.closePath();
    const gg = new THREE.ExtrudeGeometry(gs, { depth: 0.8, bevelEnabled: false });
    gg.translate(0, 0, -0.4);
    kit.add(m.brick, gg);
    kit.pop();
    // pair of open timber doors folded back against the wall
    for (const sd of [-1, 1]) {
      kit.boxB(m.bottleGreen, 0.12, doorH - 1.2, doorW / 2, HX + 0.1 + doorW / 4 + 0.1, 0, zc + sd * (doorW / 2 + 0.1), sd * 1.3);
    }
  }
  // west gable
  kit.push(-HX + 0.3, WALL, 0, Math.PI / 2);
  {
    const gs = new THREE.Shape();
    gs.moveTo(-HZ, 0); gs.lineTo(HZ, 0); gs.lineTo(0, 3.6); gs.closePath();
    const gg = new THREE.ExtrudeGeometry(gs, { depth: 0.6, bevelEnabled: false });
    gg.translate(0, 0, -0.3);
    kit.add(m.brick, gg);
  }
  kit.pop();
  // roof (v2: its own group — the camera may fade it as an occluder to show the engine in the bay)
  const roofKit = new Kit();
  roofKit.push(B.center.x, 0, B.center.z, B.yaw);
  // roof: slate slopes with glazed roof-light bands and a raised smoke-vent louvre along the ridge
  const RISE = 3.6;
  const pitch = Math.atan2(RISE, HZ);
  const slopeLen = Math.hypot(RISE, HZ);
  const onSlope = (sz: number, f: number): [number, number] => [sz * HZ * (1 - f), WALL + RISE * f + 0.08];
  for (const sz of [-1, 1]) {
    const band = (mat: THREE.Material, f0: number, f1: number, extra = 0) => {
      const fm = (f0 + f1) / 2;
      const [z, y] = onSlope(sz, fm);
      const w = slopeLen * (f1 - f0) + extra;
      const ez = extra ? sz * Math.cos(pitch) * extra / 2 : 0, ey = extra ? -Math.sin(pitch) * extra / 2 : 0;
      roofKit.add(mat, new THREE.BoxGeometry(B.size.x + 0.8, 0.14, w), roofKit.mat(0, y + ey, z + ez, 0, sz * pitch, 0));
    };
    // the south slope (toward the default iso camera) is almost all glazing so the engine under repair
    // and the fitters can be seen from above; the north slope keeps a narrow roof-light band
    const [g0, g1] = sz > 0 ? [0.14, 0.9] : [0.42, 0.72];
    band(m.slate, 0, g0, 0.7);
    band(m.glass, g0, g1);
    band(m.slate, g1, 1.02);
    for (let i = 0; i <= 12; i++) {
      const x = -HX + (B.size.x * i) / 12;
      const [z, y] = onSlope(sz, (g0 + g1) / 2);
      roofKit.add(m.iron, new THREE.BoxGeometry(0.07, 0.18, slopeLen * (g1 - g0)), roofKit.mat(x, y + 0.02, z, 0, sz * pitch, 0));
    }
  }
  // smoke vent: raised louvred clerestory
  roofKit.boxB(m.brickDark, B.size.x - 4, 0.9, 1.6, 0, WALL + 3.4, 0);
  for (let i = 0; i < 16; i++) roofKit.box(m.iron, 0.06, 0.8, 1.7, -HX + 2.5 + i * ((B.size.x - 5) / 15), WALL + 3.85, 0);
  roofKit.gable(m.slate, B.size.x - 3.4, 2.4, 0.8, 0, WALL + 4.3, 0);
  for (const x of [-12, 0, 12]) {
    roofKit.cyl(m.iron, 0.4, 0.45, 2.2, 8, x, WALL + 4.4, 0);
    roofKit.cyl(m.iron, 0.6, 0.6, 0.15, 8, x, WALL + 6.6, 0);
  }
  roofKit.pop();
  // inspection pit + dark floor inside
  kit.boxB(wm.dark, B.size.x - 1.4, 0.03, B.size.z - 1.4, 0, 0, 0);
  kit.boxB(m.stone, B.size.x - 6, 0.06, 1.1, -3, 0.01, trackZ);
  // workbench along the south wall near the worker spot
  const ws = S.workerSpot;
  const wx = ws.x - B.center.x, wz = HZ - 1.2;
  kit.boxB(m.wood, 3.6, 0.1, 0.9, wx, 0.9, wz);
  for (const sx of [-1.6, 1.6]) for (const sz of [-0.35, 0.35]) kit.boxB(m.wood, 0.1, 0.9, 0.1, wx + sx, 0, wz + sz);
  kit.boxB(m.iron, 0.4, 0.3, 0.3, wx - 1, 1.0, wz); // vice
  kit.boxB(m.bottleGreen, 0.6, 0.35, 0.35, wx + 0.8, 1.0, wz); // toolbox
  kit.box(m.wood, 3.4, 1.2, 0.05, wx, 2.0, HZ - 0.62); // tool board
  for (let i = 0; i < 6; i++) kit.box(m.iron, 0.06, 0.5, 0.04, wx - 1.4 + i * 0.55, 2.0, HZ - 0.58);
  kit.pop();

  // oil drums & spare wheelsets & sleeper stack outside the shed doors
  const drums = (x: number, z: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const dx = x + (i % 3) * 0.75, dz = z + Math.floor(i / 3) * 0.75;
      const mat = rng.pick([m.oxblood, m.iron, m.bottleGreen, m.brass]);
      kit.cyl(mat === m.brass ? wm.signalRed : mat, 0.32, 0.32, 0.95, 10, dx, 0, dz);
      kit.cyl(m.iron, 0.33, 0.33, 0.05, 10, dx, 0.3, dz);
      kit.cyl(m.iron, 0.33, 0.33, 0.05, 10, dx, 0.65, dz);
    }
  };
  const doorX = B.center.x + HX;
  drums(doorX + 3, B.center.z + trackZ + 4.2, 5);
  drums(ws.x - 2.5, ws.z + 1.2, 3);
  // wheelsets
  for (let i = 0; i < 3; i++) {
    const x = doorX + 14 + i * 1.2, z = B.center.z + trackZ + 6.5;
    for (const sz of [-0.72, 0.72]) kit.add(m.iron, new THREE.CylinderGeometry(0.55, 0.55, 0.12, 12), kit.mat(x, 0.55, z + sz, 0, Math.PI / 2, 0));
    kit.add(m.rail, new THREE.CylinderGeometry(0.07, 0.07, 1.6, 6), kit.mat(x, 0.55, z, 0, Math.PI / 2, 0));
  }
  // sleeper stack
  for (let l = 0; l < 4; l++) for (let i = 0; i < 4; i++) {
    const rot = l % 2 ? Math.PI / 2 : 0;
    kit.push(doorX + 10, 0, B.center.z + trackZ + 6, rot);
    kit.boxB(m.sleeper, 2.6, 0.24, 0.26, 0, l * 0.24, -0.6 + i * 0.4);
    kit.pop();
  }

  // ── water tower ──
  {
    const w = S.waterTower;
    const sp = S.curve.getPointAt(S.waterT);
    const toTrack = V(sp.x - w.x, 0, sp.z - w.z).normalize();
    const yaw = Math.atan2(toTrack.x, toTrack.z); // local +z toward the siding
    kit.push(w.x, 0, w.z, yaw);
    kit.boxB(m.brick, 4.4, 4.6, 4.4, 0, 0, 0);
    kit.boxB(m.cream, 4.7, 0.25, 4.7, 0, 4.6, 0);
    kit.arch(m.bottleGreen, 1.2, 2.2, 0, 0, 2.21);
    kit.arch(m.windowLit, 0.8, 1.2, -1.3, 0, 2.21);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.boxB(m.brickDark, 0.5, 4.6, 0.5, sx * 2.0, 0, sz * 2.0);
    // iron tank with panel ribs
    kit.boxB(m.iron, 5.4, 2.6, 5.4, 0, 4.85, 0);
    for (let i = -2; i <= 2; i++) {
      kit.box(m.bottleGreen, 0.08, 2.5, 5.5, i * 1.2, 6.15, 0);
      kit.box(m.bottleGreen, 5.5, 2.5, 0.08, 0, 6.15, i * 1.2);
    }
    kit.boxB(m.iron, 5.6, 0.15, 5.6, 0, 7.45, 0);
    kit.boxB(wm.water, 5.2, 0.05, 5.2, 0, 7.42, 0);
    // swinging spout (leather hose) toward the siding
    kit.beam(m.iron, 0.3, 0.3, V(0, 5.6, 2.7), V(0, 5.2, 4.9));
    kit.cyl(m.iron, 0.12, 0.18, 1.6, 6, 0, 3.6, 4.9);
    kit.cyl(wm.dark, 0.1, 0.1, 0.9, 6, 0, 2.7, 4.9);
    // chain & ladder
    for (let y = 0.5; y < 7.3; y += 0.4) kit.box(m.iron, 0.5, 0.03, 0.03, 2.8, y, -1);
    kit.box(m.iron, 0.03, 7.3, 0.03, 2.8, 3.65, -1.25);
    kit.box(m.iron, 0.03, 7.3, 0.03, 2.8, 3.65, -0.75);
    kit.pop();
  }

  // ── coal stage ──
  {
    const c = S.coalStage;
    // align with the siding: find siding tangent nearest the coal stage
    let bestT = 0, bd = Infinity;
    for (let t = 0; t <= 1; t += 0.01) { const p = S.curve.getPointAt(t); const d = (p.x - c.x) ** 2 + (p.z - c.z) ** 2; if (d < bd) { bd = d; bestT = t; } }
    const tg = S.curve.getTangentAt(bestT);
    const p = S.curve.getPointAt(bestT);
    const yaw = Math.atan2(-tg.z, tg.x);
    const toTrack = V(p.x - c.x, 0, p.z - c.z);
    const localZTrack = Math.sign(toTrack.x * Math.sin(yaw) + toTrack.z * Math.cos(yaw)) || 1;
    kit.push(c.x, 0, c.z, yaw);
    kit.boxB(m.brick, 10, 1.6, 4.2, 0, 0, 0);
    kit.boxB(m.wood, 10.4, 0.15, 4.6, 0, 1.6, 0);
    // coal heaps
    const heap = (x: number, z: number, r: number, h: number) => {
      const g = new THREE.ConeGeometry(r, h, 7, 1);
      kit.add(wm.coal, g, kit.mat(x, 1.75 + h / 2, z, rng.range(0, 3)));
    };
    heap(-3, -0.5, 1.6, 1.3); heap(-0.2, -0.8, 1.9, 1.6); heap(2.8, -0.4, 1.4, 1.0);
    // coal tubs on the edge toward the track
    for (let i = 0; i < 3; i++) {
      kit.boxB(m.iron, 0.9, 0.7, 0.9, -2.5 + i * 2.4, 1.75, localZTrack * 1.5);
      kit.boxB(wm.coal, 0.8, 0.12, 0.8, -2.5 + i * 2.4, 2.4, localZTrack * 1.5);
    }
    // small jib crane
    kit.cyl(m.iron, 0.14, 0.18, 4.2, 6, 4.4, 1.75, localZTrack * 1.3);
    kit.beam(m.iron, 0.12, 0.16, V(4.4, 5.6, localZTrack * 1.3), V(4.4, 5.0, localZTrack * 4.4));
    kit.beam(m.iron, 0.05, 0.05, V(4.4, 3.2, localZTrack * 1.3), V(4.4, 5.0, localZTrack * 4.0));
    kit.box(m.iron, 0.03, 1.6, 0.03, 4.4, 4.2, localZTrack * 4.3);
    // steps
    for (let i = 0; i < 5; i++) kit.boxB(m.stone, 0.4, 0.32 * (i + 1), 1.2, -5.2 - (4 - i) * 0.4, 0, -localZTrack * 1.2);
    kit.pop();
  }

  // ── turntable ──
  const tt = S.turntable;
  const R = 6.2;
  {
    const ring = new THREE.CylinderGeometry(R + 0.6, R + 0.6, 0.35, 28, 1, true);
    kit.add(m.stone, ring, kit.mat(tt.x, 0.1, tt.z));
    kit.add(m.stone, new THREE.RingGeometry(R, R + 0.6, 28, 1), kit.mat(tt.x, 0.28, tt.z, 0, -Math.PI / 2));
    kit.add(wm.dark, new THREE.CircleGeometry(R, 28), kit.mat(tt.x, -0.25 + 0.3, tt.z, 0, -Math.PI / 2));
    // circular rail in the pit
    kit.add(m.rail, new THREE.TorusGeometry(R - 0.3, 0.06, 3, 32), kit.mat(tt.x, 0.1, tt.z, 0, Math.PI / 2));
    // stub track leading out toward the shed
    for (let i = 0; i < 7; i++) kit.boxB(m.sleeper, 0.26, 0.1, 2.5, tt.x + R + 0.8 + i * 0.75, 0.05, tt.z, 0);
    for (const sz of [-0.7175, 0.7175]) kit.boxB(m.rail, 5.5, 0.08, 0.08, tt.x + R + 3.2, 0.14, tt.z + sz);
  }
  // rotating bridge (dynamic)
  const bridge = new THREE.Group();
  bridge.position.set(tt.x, 0, tt.z);
  {
    const bk = new Kit();
    bk.boxB(m.iron, 2 * R - 0.2, 0.5, 2.4, 0, -0.1, 0);
    bk.boxB(m.bottleGreen, 2 * R - 0.2, 0.3, 0.2, 0, 0.3, 1.3);
    bk.boxB(m.bottleGreen, 2 * R - 0.2, 0.3, 0.2, 0, 0.3, -1.3);
    for (let i = 0; i < 15; i++) bk.boxB(m.sleeper, 0.25, 0.08, 2.4, -R + 0.6 + i * 0.8, 0.4, 0);
    for (const sz of [-0.7175, 0.7175]) bk.boxB(m.rail, 2 * R - 0.3, 0.08, 0.08, 0, 0.48, sz);
    // push bars at each end
    for (const sx of [-1, 1]) {
      bk.beam(m.wood, 0.1, 0.1, V(sx * (R - 0.4), 0.5, 1.3), V(sx * (R - 0.1), 1.0, 3.0));
      bk.cyl(m.iron, 0.12, 0.12, 0.4, 6, sx * (R - 0.4), 0.1, 1.3);
    }
    // little operator cabin
    bk.boxB(m.wood, 1.2, 1.8, 1.0, 0, 0.4, -1.8);
    bk.gable(m.slate, 1.4, 1.2, 0.5, 0, 2.2, -1.8);
    const bg = bk.build('turntableBridge', { cast: true, receive: true });
    for (const c of bg.children) c.matrixAutoUpdate = false;
    bridge.add(bg);
  }
  bridge.rotation.y = 0.3;
  root.add(bridge);

  // yard lamps (two extra gas lamps with glow only)
  lampPost(kit, ctx, wm, doorX + 4, 0, B.center.z + trackZ - 3.5, 3.3);
  lampPost(kit, ctx, wm, S.waterTower.x + 3.5, 0, S.waterTower.z - 1.5, 3.3);
  kit.cast = false;

  // yard gravel apron around the shed (flat)
  kit.add(wm.cinder, new THREE.PlaneGeometry(64, 44, 4, 4), kit.mat(B.center.x + 12, 0.015, B.center.z + 8, 0, -Math.PI / 2));

  const g = roofKit.build('shed', { cast: true, receive: true });
  g.userData.pick = { kind: 'station', id: 'shed' };
  for (const c of g.children) c.userData.pick = g.userData.pick;
  root.add(g);
  pickables.push(g);
  const px = pickProxy('shedBody', { kind: 'station', id: 'shed' }, [{ center: B.center, size: new THREE.Vector3(B.size.x, B.size.y, B.size.z), yaw: B.yaw }]);
  root.add(px);
  pickables.push(px);

  // turntable slowly swings between positions now and then
  let target = 0.3, wait = 20;
  return {
    update(dt: number) {
      wait -= dt;
      if (wait <= 0) { target = rng.range(-1.2, 1.2) + (rng.chance(0.5) ? Math.PI : 0); wait = rng.range(25, 60); }
      const d = target - bridge.rotation.y;
      bridge.rotation.y += Math.sign(d) * Math.min(Math.abs(d), dt * 0.12);
    },
  };
}
