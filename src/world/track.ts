import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import { sweep, V } from './kit';
import { chunkedInstances, type Batch } from './batch';

const GAUGE_HALF = 0.7175;
const SLEEPER_STEP = 0.75;
const BALLAST: [number, number][] = [[-1.9, 0.0], [1.9, 0.0], [1.35, 0.2], [-1.35, 0.2]];
const railProfile = (side: number): [number, number][] => {
  const c = side * GAUGE_HALF;
  // simple bull-head: foot, web, head (CCW looking along +t)
  return [[c - 0.07, 0.28], [c + 0.07, 0.28], [c + 0.07, 0.3], [c + 0.025, 0.3], [c + 0.025, 0.325], [c + 0.05, 0.325], [c + 0.05, 0.35], [c - 0.05, 0.35], [c - 0.05, 0.325], [c - 0.025, 0.325], [c - 0.025, 0.3], [c - 0.07, 0.3]];
};

export function buildTrack(ctx: Ctx, wm: WorldMats, root: THREE.Object3D, batch: Batch): void {
  const L = ctx.layout;
  const mats = ctx.mats;
  // v2: ballast, rails and trackside details merge into the global static batch
  const kit = batch;
  const railKit = batch;
  kit.cast = false;
  const coast = L.lines.coast, high = L.lines.highland;
  const shed = L.shed.curve;
  const shedLen = L.shed.length;

  // ── ballast ──
  kit.add(mats.ballast, sweep(coast.curve, 0, 1, BALLAST, 6));
  kit.add(mats.ballast, sweep(high.curve, 0, 1, BALLAST, 3));
  const shedBallast: [number, number][] = BALLAST.map(([a, b]) => [a * 0.95, b * 0.93]);
  kit.add(mats.ballast, sweep(shed, 0.02, 1, shedBallast, 2, { caps: true }));
  // v2: the shed through-road (light engines to/from the shedWest tunnel) continues the siding west
  const SR = L.shedRoad;
  const srEnd = Math.min(1, SR.tAtX(shed.getPointAt(1).x) + 0.004);
  kit.add(mats.ballast, sweep(SR.curve, 0, srEnd, shedBallast, 4));

  // ── sleepers ──
  const tmpP = new THREE.Vector3(), tmpT = new THREE.Vector3();
  const sleeperGeo = new THREE.BoxGeometry(2.6, 0.08, 0.24);
  const sleepers: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  // lateral offset of the siding relative to coast (for the turnout timbers)
  const sidingOffsetAtX = (x: number): number => {
    // siding heads west from x=-45; find siding t with that x (monotonic)
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      if (shed.getPointAt(m, tmpP).x > x) lo = m; else hi = m;
    }
    return shed.getPointAt((lo + hi) / 2, tmpP).z - 24;
  };
  const swX = coast.pointAt(L.shed.switchT).x;
  const placeSleepers = (curve: THREE.Curve<THREE.Vector3>, len: number, t0: number, t1: number, y: number, isCoast: boolean) => {
    const n = Math.floor(((t1 - t0) * len) / SLEEPER_STEP);
    for (let i = 0; i <= n; i++) {
      const t = t0 + (i * SLEEPER_STEP) / len;
      curve.getPointAt(Math.min(1, t), tmpP);
      curve.getTangentAt(Math.min(1, t), tmpT);
      let length = 1, shift = 0;
      if (isCoast && tmpP.x < swX + 0.5 && tmpP.x > swX - 26) {
        const off = sidingOffsetAtX(tmpP.x);
        if (off < 3.2) { length = (2.6 + off) / 2.6; shift = off / 2; }
      }
      const yaw = Math.atan2(-tmpT.z, tmpT.x);
      q.setFromAxisAngle(up, yaw + Math.PI / 2);
      s.set(length, 1, 1);
      const pos = V(tmpP.x + -tmpT.z * shift, y, tmpP.z + tmpT.x * shift);
      sleepers.push(new THREE.Matrix4().compose(pos, q, s));
    }
  };
  placeSleepers(coast.curve, coast.length, 0, 1, 0.24, true);
  placeSleepers(high.curve, high.length, 0, 1, 0.24, false);
  // siding sleepers begin where they no longer overlap the coast timbers
  let sidingStart = 0;
  for (let t = 0; t < 0.5; t += 0.002) { if (shed.getPointAt(t, tmpP).z - 24 >= 3.2) { sidingStart = t; break; } }
  placeSleepers(shed, shedLen, sidingStart, 1, 0.235, false);
  placeSleepers(SR.curve, SR.length, 0, srEnd - 0.002, 0.235, false);
  // chunked so far sleepers cull with their chunk
  for (const im of chunkedInstances(sleeperGeo, mats.sleeper, sleepers, null, 'sleepers', { cast: false })) root.add(im);

  // ── rails ── (low tier: a plain box section — the bull-head detail is invisible at iso zoom and costs 3× the triangles)
  const low = ctx.quality.tier === 'low';
  const prof = (side: number): [number, number][] => {
    if (!low) return railProfile(side);
    const c = side * GAUGE_HALF;
    return [[c - 0.05, 0.28], [c + 0.05, 0.28], [c + 0.05, 0.35], [c - 0.05, 0.35]];
  };
  for (const side of [-1, 1]) {
    railKit.add(mats.rail, sweep(coast.curve, 0, 1, prof(side), 10));
    railKit.add(mats.rail, sweep(high.curve, 0, 1, prof(side), low ? 4 : 2.5));
    railKit.add(mats.rail, sweep(shed, 0, 1, prof(side), low ? 2.5 : 1.5, { caps: true }));
    railKit.add(mats.rail, sweep(SR.curve, 0, srEnd, prof(side), 6, { caps: true }));
  }

  // ── turnout details at the switch: check rails, point rodding, ground frame lever ──
  {
    const sw = coast.pointAt(L.shed.switchT);
    // check rails beside the running rails opposite the frog region
    const tA = L.shed.switchT - 6 / coast.length, tB = L.shed.switchT - 14 / coast.length;
    railKit.add(mats.rail, sweep(coast.curve, tB, tA, railProfile(-1).map(([a, b]) => [a + 0.12, b]) as [number, number][], 2, { caps: true }));
    // stretcher bars (tie bars) near the switch toe
    for (let i = 0; i < 2; i++) kit.boxB(mats.iron, 0.08, 0.06, 1.6, sw.x - 0.6 - i * 0.7, 0.28, sw.z + 0.1);
    // ground frame: a small lever frame on the north side
    kit.push(sw.x - 2, 0, sw.z - 3.2, 0);
    kit.boxB(mats.wood, 2.2, 0.35, 0.9, 0, 0, 0);
    kit.boxB(mats.iron, 1.8, 0.25, 0.4, 0, 0.35, 0);
    kit.add(wm.signalRed, new THREE.BoxGeometry(0.08, 1.2, 0.08), kit.mat(-0.3, 1.1, 0, 0, 0, 0.35));
    kit.add(wm.white, new THREE.BoxGeometry(0.1, 0.2, 0.1), kit.mat(-0.5, 1.66, 0, 0, 0, 0.35));
    kit.add(mats.iron, new THREE.BoxGeometry(0.08, 1.2, 0.08), kit.mat(0.3, 1.1, 0, 0, 0, -0.2));
    // rodding run to the points
    kit.pop();
    kit.beam(mats.iron, 0.05, 0.05, V(sw.x - 2, 0.12, sw.z - 2.7), V(sw.x - 0.6, 0.12, sw.z - 0.9));
    // points indicator disc
    kit.cyl(mats.iron, 0.04, 0.04, 1.2, 5, sw.x + 1.5, 0, sw.z - 2.4);
    kit.add(wm.white, new THREE.CylinderGeometry(0.25, 0.25, 0.04, 10), kit.mat(sw.x + 1.5, 1.35, sw.z - 2.4, 0, Math.PI / 2, 0));
    kit.add(wm.signalRed, new THREE.BoxGeometry(0.4, 0.1, 0.05), kit.mat(sw.x + 1.5, 1.35, sw.z - 2.37));
  }

  // ── barrow crossing (planks) ──
  {
    const x = L.crossing.north.x;
    kit.push(x, 0, 24, 0);
    for (const [z0, z1] of [[-2.1, -GAUGE_HALF - 0.08], [-GAUGE_HALF + 0.08, GAUGE_HALF - 0.08], [GAUGE_HALF + 0.08, 2.1]]) {
      kit.box(mats.wood, 2.4, 0.08, z1 - z0, 0, 0.31, (z0 + z1) / 2);
    }
    // plank seams
    for (let i = -1; i <= 1; i++) kit.box(mats.sleeper, 0.04, 0.085, 4.2, i * 0.8, 0.312, 0);
    // approach ramps
    for (const sd of [-1, 1]) {
      const g = new THREE.BoxGeometry(2.4, 0.08, 1.8);
      kit.add(mats.gravel, g, kit.mat(0, 0.16, sd * 2.9, 0, sd * 0.17, 0));
    }
    kit.pop();
  }

  // (v2: no buffer stop — the shed is a through shed onto the shed road)

}
