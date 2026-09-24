import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import type { Env } from './env';
import type { Rng } from '../core/rng';
import { V, distToPts } from './kit';
import type { Batch } from './batch';
import { bench } from './platforms';

const FLOWERS = [0xb8404a, 0xe0b84a, 0xe8dcc0, 0x9a5aa0, 0xd8805a];

/**
 * Station gardens in the wedge (flower beds, topiary, benches). v2: the static hansom cabs are gone — traffic
 * fills the cab rank with live cabs (no stationary life); the horse trough is built with the forecourt (terrain.ts).
 */
export function buildGarden(ctx: Ctx, wm: WorldMats, env: Env, kit: Batch, rng: Rng): void {
  const L = ctx.layout;
  const m = ctx.mats;
  const flowerMat = (c: number) => { kit.color.setHex(c); return wm.paint; };
  kit.cast = true;
  const nodes = L.nav.nodes;
  const navSegs = L.nav.edges.map(([a, b]) => [nodes[a], nodes[b]]);
  const fb = [L.footbridge.a, L.footbridge.b];
  const st = L.station.center;

  const inWedge = (x: number, z: number) => {
    const p = V(x, 0, z);
    for (const line of [L.lines.coast, L.lines.highland]) {
      const t = line.nearestT(p);
      const c = line.pointAt(t), tg = line.tangentAt(t);
      const side = (p.x - c.x) * -tg.z + (p.z - c.z) * tg.x;
      if (Math.sign(side) !== line.platformSide) return false;
    }
    return true;
  };
  const clear = (x: number, z: number, r: number) =>
    inWedge(x, z) && !env.blocked(x, z, r + 1.2) && env.trackDist(x, z) > 11 + r &&
    navSegs.every(([a, b]) => distToPts(x, z, [a, b]) > r + 2) &&
    distToPts(x, z, fb) > r + 3 &&
    L.lampPositions.every((p) => Math.hypot(p.x - x, p.z - z) > r + 1.5) &&
    L.trees.every((p) => Math.hypot(p.x - x, p.z - z) > r + 2.5);

  // candidate spots on a jittered grid around the station
  const spots: { x: number; z: number }[] = [];
  for (let gx = -60; gx <= 70; gx += 7) for (let gz = -60; gz <= 40; gz += 7) {
    const x = st.x + gx + rng.range(-1.5, 1.5), z = st.z + gz + rng.range(-1.5, 1.5);
    if (Math.hypot(gx, gz) > 62) continue;
    if (clear(x, z, 2.2)) spots.push({ x, z });
  }
  let beds = 0, shrubs = 0, benches = 0;
  for (const s of spots) {
    const kind = rng.weighted([{ w: 3, v: 'bed' }, { w: 3, v: 'shrubs' }, { w: 1, v: 'bench' }, { w: 1, v: 'tree' }]);
    if (kind === 'bed' && beds < 12) {
      beds++;
      const round = rng.chance(0.5);
      if (round) {
        kit.cyl(m.stone, 1.9, 1.9, 0.22, 12, s.x, 0, s.z);
        kit.cyl(wm.dark, 1.7, 1.7, 0.26, 12, s.x, 0, s.z);
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2, r = i % 2 ? 1.2 : 0.6;
          kit.add(flowerMat(FLOWERS[(i + beds) % FLOWERS.length]), new THREE.IcosahedronGeometry(0.26, 0), kit.mat(s.x + Math.cos(a) * r, 0.4, s.z + Math.sin(a) * r));
        }
        kit.add(wm.shrub, new THREE.IcosahedronGeometry(0.5, 0), kit.mat(s.x, 0.7, s.z));
      } else {
        const yaw = L.station.yaw + (rng.chance(0.5) ? 0 : Math.PI / 2);
        kit.push(s.x, 0, s.z, yaw);
        kit.boxB(m.stone, 4.2, 0.2, 1.8, 0, 0, 0);
        kit.boxB(wm.dark, 3.9, 0.24, 1.5, 0, 0, 0);
        for (let i = 0; i < 12; i++) kit.add(flowerMat(FLOWERS[(i + beds) % FLOWERS.length]), new THREE.IcosahedronGeometry(0.24, 0), kit.mat(-1.65 + (i % 6) * 0.66, 0.38, i < 6 ? -0.35 : 0.35));
        kit.pop();
      }
    } else if (kind === 'shrubs' && shrubs < 16) {
      shrubs++;
      const n = rng.int(2, 4);
      for (let i = 0; i < n; i++) {
        const r = rng.range(0.5, 0.9);
        kit.add(wm.shrub, new THREE.IcosahedronGeometry(r, 0), kit.mat(s.x + rng.range(-1.2, 1.2), r * 0.8, s.z + rng.range(-1.2, 1.2), rng.range(0, 3)));
      }
    } else if (kind === 'bench' && benches < 5) {
      benches++;
      bench(kit, ctx, s.x, 0, s.z, L.station.yaw + rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]));
    } else if (kind === 'tree') {
      // clipped topiary cone in a tub
      kit.cyl(m.wood, 0.55, 0.45, 0.6, 8, s.x, 0, s.z);
      kit.add(wm.shrub, new THREE.ConeGeometry(0.8, 2.4, 7), kit.mat(s.x, 1.8, s.z));
    }
  }

  kit.cast = false;
  kit.color.setRGB(1, 1, 1);
}
