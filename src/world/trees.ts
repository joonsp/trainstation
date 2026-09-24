import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import type { Env } from './env';
import type { Rng } from '../core/rng';
import { noise2 } from './env';
import { chunkedInstances, chunkOf } from './batch';
import { chain, inject } from '../core/shaderMods';
import { applyWind } from '../core/wind';
import { pointInPoly } from '../core/poly';

/**
 * TREES (v2): layout.trees + countryside copses (where terrain.clear holds, never in fields or town areas),
 * hedgerow oaks, a wooded belt towards the map edge. Two instanced species (broadleaf, conifer) with trunk and
 * crown baked into one geometry (aLeaf mixes trunk colour ↔ per-instance crown colour), split per chunk so they
 * frustum-cull, swaying with ctx.wind ('tree' mode, conifers at half amplitude).
 */
export function buildTrees(ctx: Ctx, wm: WorldMats, env: Env, root: THREE.Object3D, rng: Rng, extra: { p: THREE.Vector3; conifer?: boolean; scale?: number }[]): void {
  const L = ctx.layout;
  const T = L.terrain;
  const fields = L.fields.map((f) => f.poly);
  const areas = L.towns.flatMap((t) => t.areas);
  const inArea = (x: number, z: number, m = 2) => areas.some((a) => {
    const c = Math.cos(a.yaw), s = Math.sin(a.yaw), dx = x - a.center.x, dz = z - a.center.z;
    return Math.abs(dx * c - dz * s) < a.size.x / 2 + m && Math.abs(dx * s + dz * c) < a.size.z / 2 + m;
  });
  const inField = (x: number, z: number) => fields.some((p) => pointInPoly(x, z, p));
  const ponds = areas.filter((a) => a.kind === 'pond');
  const inPond = (x: number, z: number) => ponds.some((a) => {
    const c = Math.cos(a.yaw), s = Math.sin(a.yaw), dx = x - a.center.x, dz = z - a.center.z;
    return ((dx * c - dz * s) / (a.size.x / 2 + 2.5)) ** 2 + ((dx * s + dz * c) / (a.size.z / 2 + 2.5)) ** 2 < 1;
  });

  const spots: { p: THREE.Vector3; conifer: boolean; scale: number }[] = [];
  for (const t of L.trees) if (!env.blocked(t.x, t.z, 1.5) && !inPond(t.x, t.z)) spots.push({ p: t.clone(), conifer: rng.chance(0.3), scale: rng.range(0.8, 1.35) });
  for (const e of extra) if ((env.clear(e.p.x, e.p.z, 1) || T.roadDist(e.p.x, e.p.z) > 1.5) && !inPond(e.p.x, e.p.z)) spots.push({ p: e.p.clone(), conifer: !!e.conifer, scale: e.scale ?? rng.range(0.9, 1.3) });
  // copses and the edge belt
  const wrng = rng.fork(77);
  const wood = (x: number, z: number) => noise2(x * 0.012 + 3.1, z * 0.012 - 7.7);
  const grid = new Map<string, THREE.Vector3[]>();
  const key = (x: number, z: number) => `${Math.floor(x / 6)},${Math.floor(z / 6)}`;
  const near = (x: number, z: number) => {
    const gx = Math.floor(x / 6), gz = Math.floor(z / 6);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of grid.get(`${gx + i},${gz + j}`) ?? []) if ((q.x - x) ** 2 + (q.z - z) ** 2 < 18) return true;
    return false;
  };
  for (const s of spots) { const k = key(s.p.x, s.p.z); (grid.get(k) ?? grid.set(k, []).get(k)!).push(s.p); }
  const target = ctx.quality.tier === 'low' ? 950 : 1400;
  let guard = 0, added = 0;
  while (added < target && guard++ < 90000) {
    const x = wrng.range(-414, 414), z = wrng.range(-414, 414);
    const edge = Math.max(Math.abs(x), Math.abs(z));
    const belt = edge > 355 ? THREE.MathUtils.smoothstep(edge, 355, 395) * 1.4 : 0;
    // woods (low-frequency noise), small spinneys (higher frequency) and the edge belt; very few lone trees
    // (value noise clusters around 0.5, so only its top ~10 % makes woodland)
    const w1 = wood(x, z) + belt * 0.45, w2 = noise2(x * 0.034 - 11.3, z * 0.034 + 5.1);
    const pAcc = Math.max(THREE.MathUtils.smoothstep(w1, 0.7, 0.8), THREE.MathUtils.smoothstep(w2, 0.79, 0.86), 0.002);
    if (!wrng.chance(pAcc)) continue;
    if (T.trackDist(x, z) < 12 || T.roadDist(x, z) < 4 || T.riverDist(x, z) < 3 || !env.clear(x, z, 2.5)) continue;
    if (T.featureDist(x, z) < 20 || inField(x, z) || inArea(x, z)) continue;
    if (near(x, z)) continue;
    const p = new THREE.Vector3(x, 0, z);
    spots.push({ p, conifer: wrng.chance(edge > 330 ? 0.45 : 0.25), scale: wrng.range(0.8, 1.3) });
    const k = key(x, z); (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
    added++;
  }
  // yews in the churchyards
  for (const a of areas) if (a.kind === 'churchyard') {
    const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
    for (const [lx, lz] of [[-a.size.x / 2 + 1.5, -a.size.z / 2 + 1.5], [a.size.x / 2 - 1.5, -a.size.z / 2 + 1.5]]) {
      const x = a.center.x + lx * c + lz * s, z = a.center.z - lx * s + lz * c;
      if (!T.buildingAt(x, z, 1.5)) spots.push({ p: new THREE.Vector3(x, 0, z), conifer: true, scale: 0.7 });
    }
  }

  // ── geometry ──
  const decidGeo = mergeTagged([
    [trunk(0.2, 0.3, 3.2), 0],
    [blob(2.7, 0, 4.6, 0), 1],
    [blob(1.8, 0.9, 6.3, 0.6), 1],
    [blob(1.5, -1.0, 5.6, -0.7), 1],
  ]);
  const conGeo = mergeTagged([
    [trunk(0.18, 0.26, 1.4), 0],
    [cone(1.6, 3.6, 1.2, 7), 1],
    [cone(1.2, 3.0, 3.6, 7), 1],
    [cone(0.75, 2.4, 5.8, 6), 1],
  ]);
  const mkMat = (name: string, amp: number) => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    mat.name = name;
    chain(mat, 'vjTree', (sh) => {
      sh.uniforms.uTrunk = { value: new THREE.Color(0x5a4232) };
      sh.uniforms.uTSnow = ctx.mats.uniforms.uSnow;
      sh.vertexShader = inject(sh.vertexShader, '#include <common>', 'attribute float aLeaf; varying float vLeaf;');
      sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', 'vLeaf = aLeaf;');
      sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'uniform vec3 uTrunk; uniform float uTSnow; varying float vLeaf;');
      sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
  diffuseColor.rgb = mix(uTrunk, diffuseColor.rgb, vLeaf);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.97), clamp(uTSnow * 0.55, 0.0, 1.0) * vLeaf);`);
    });
    const depth = applyWind(ctx, mat, { mode: 'tree', weight: 'localY', height: 7.5, amp, pivot: 'object' });
    return { mat, depth };
  };
  const dm = mkMat('w_tree', 0.35), cm = mkMat('w_conifer', 0.18);
  void wm;

  const dM: THREE.Matrix4[] = [], dC: THREE.Color[] = [], cM: THREE.Matrix4[] = [], cC: THREE.Color[] = [];
  const greens = [0x4f7a38, 0x5c8a3e, 0x6a9444, 0x456b33, 0x7a9a48, 0x8a8a3a];
  const conGreens = [0x2f5a36, 0x3a6340, 0x2a4f33];
  const q = new THREE.Quaternion(), e = new THREE.Euler(), s3 = new THREE.Vector3();
  for (const t of spots) {
    const y = L.heightAt(t.p.x, t.p.z) - 0.1;
    e.set(rng.range(-0.05, 0.05), rng.range(0, Math.PI * 2), rng.range(-0.05, 0.05), 'YXZ');
    q.setFromEuler(e);
    const sc = t.scale;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(t.p.x, y, t.p.z), q, s3.set(sc * rng.range(0.9, 1.1), sc * rng.range(0.9, 1.15), sc * rng.range(0.9, 1.1)));
    if (t.conifer) { cM.push(m); cC.push(new THREE.Color(rng.pick(conGreens)).multiplyScalar(rng.range(0.9, 1.1))); }
    else { dM.push(m); dC.push(new THREE.Color(rng.pick(greens)).multiplyScalar(rng.range(0.9, 1.1))); }
  }
  const castAll = ctx.quality.knobs.shadowCasters !== 'major';
  const add = (list: THREE.InstancedMesh[]) => {
    for (const im of list) {
      // on the low tier only the central (default-view) chunk casts tree shadows
      if (!castAll) im.castShadow = im.name.endsWith(':' + chunkOf(46, -18));
      root.add(im);
    }
  };
  add(chunkedInstances(decidGeo, dm.mat, dM, dC, 'trees', { cast: true, depth: dm.depth }));
  add(chunkedInstances(conGeo, cm.mat, cM, cC, 'conifers', { cast: true, depth: cm.depth }));
}

function trunk(r0: number, r1: number, h: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r0, r1, h, 5);
  g.translate(0, h / 2, 0);
  return g;
}
function blob(r: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, 0);
  g.scale(1, 0.85, 1);
  g.translate(x, y, z);
  return g;
}
function cone(r: number, h: number, y: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.translate(0, y + h / 2, 0);
  return g;
}
/** merge non-indexed parts, tagging each with aLeaf */
function mergeTagged(parts: [THREE.BufferGeometry, number][]): THREE.BufferGeometry {
  const pos: number[] = [], leaf: number[] = [];
  for (const [g0, tag] of parts) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const p = g.getAttribute('position').array as ArrayLike<number>;
    for (let i = 0; i < p.length; i++) pos.push(p[i]);
    for (let i = 0; i < p.length / 3; i++) leaf.push(tag);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(leaf, 1));
  g.computeVertexNormals();
  return g;
}
