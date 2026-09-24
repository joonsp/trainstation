import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import type { Env } from './env';
import { noise2 } from './env';
import { V } from './kit';
import { Batch, CHUNK, CHUNK_X0, CHUNK_Z0, chunkOf, chunkedInstances } from './batch';
import type { Rng } from '../core/rng';
import type { Field } from '../core/countryside';
import { applyWind } from '../core/wind';
import { chain, inject } from '../core/shaderMods';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const smooth = THREE.MathUtils.smoothstep;
const _p = new THREE.Vector3();

export interface TerrainBuild {
  /** extra tree spots (hedgerow oaks, portal copses) for trees.ts */
  treeSpots: { p: THREE.Vector3; conifer?: boolean; scale?: number }[];
  /** plough progress 0..1 for Coldharbour Ley (time-driven; world-internal) */
  setPlough(f: number): void;
}

/** field kind → [tint, row pitch (m), row contrast] */
const FIELD_STYLE: Record<Field['kind'], [number, number, number]> = {
  wheat: [0xbfa95c, 1.1, 0.16],
  barley: [0xc6b877, 0.95, 0.14],
  hay: [0x9fae5e, 5.5, 0.12],
  pasture: [0x6f9a4c, 9, 0.035],
  plough: [0x7a5d43, 0.9, 0.34],
  turnips: [0x5d7a3e, 0.85, 0.3],
  orchard: [0x76a052, 9, 0.03],
};
const STUBBLE = 0xb49a5e;

export function buildTerrain(ctx: Ctx, wm: WorldMats, env: Env, root: THREE.Object3D, batch: Batch, rng: Rng): TerrainBuild {
  const L = ctx.layout;
  const T = L.terrain;
  const mats = ctx.mats;
  const H = (x: number, z: number) => L.heightAt(x, z);
  const HALF = T.half; // 420
  const treeSpots: TerrainBuild['treeSpots'] = [];

  // ───────────── ground grid (from layout.heightAt), chunked ─────────────
  {
    const gc = ctx.quality.knobs.groundCell;
    const coords = new Set<number>();
    // 5 m cells over the playfield proper (tunnel mouths at ±268 included), knobs.groundCell beyond
    for (let v = -HALF; v <= -300; v += gc) coords.add(v);
    for (let v = -300; v <= 300; v += 5) coords.add(v);
    for (let v = 300; v <= HALF; v += gc) coords.add(v);
    coords.add(-HALF); coords.add(HALF);
    const xs0 = [...coords];
    const addBounds = (arr: number[], o: number) => { for (let b = o; b < HALF; b += CHUNK) if (b > -HALF) arr.push(b); for (let b = o - CHUNK; b > -HALF; b -= CHUNK) arr.push(b); return [...new Set(arr)].sort((a, b) => a - b); };
    const xs = addBounds([...xs0], CHUNK_X0);
    const zs = addBounds([...xs0], CHUNK_Z0);
    const bx = [-HALF, ...xs.filter((v) => (v - CHUNK_X0) % CHUNK === 0 && v > -HALF && v < HALF), HALF].sort((a, b) => a - b);
    const bz = [-HALF, ...zs.filter((v) => (v - CHUNK_Z0) % CHUNK === 0 && v > -HALF && v < HALF), HALF].sort((a, b) => a - b);

    const inTunnel = (x: number, z: number) => L.tunnels.some((t) => {
      const rx = x - t.x, rz = z - t.z;
      return rx * t.dx + rz * t.dz > 5.5 && Math.abs(-rx * t.dz + rz * t.dx) < t.width / 2 + 4; // (the first 5 m under the portal stay level: tunnel floor)
    });
    /** the level floor of a tunnel's approach cutting (between its retaining walls, up to 60 m out) */
    const inCutting = (x: number, z: number) => L.tunnels.some((t) => {
      const rx = x - t.x, rz = z - t.z;
      const u = rx * t.dx + rz * t.dz;
      return u < 1 && u > -60 && Math.abs(-rx * t.dz + rz * t.dx) < (t.width + 6) / 2 - 0.6;
    });
    const base = new THREE.Color(0x6f8f4e);
    const c = new THREE.Color();
    const vert = (x: number, z: number, pos: number[], col: number[]) => {
      let y = H(x, z);
      const rd = T.riverDist(x, z);
      if (rd < 14) y -= 1.6 * (1 - smooth(rd, 10, 14));
      // never bury the track outside the tunnels (the hills rise right at the portals)
      if ((T.trackDist(x, z) < 4 || inCutting(x, z)) && !inTunnel(x, z)) y = Math.min(y, -0.03);
      const rdd = T.roadDist(x, z);
      if (rdd < 6) {
        // keep the coarse grid under the road ribbon (cuttings, humpback ramps, the ford dip); in cuttings the
        // clamp reaches one grid cell further so no cell slopes across the carriageway (the walls hide the step)
        _p.set(x, 0, z);
        const nr = L.nearestRoad(_p);
        const e = L.roads.edges[nr.edge];
        if (e) {
          const ry = e.poly.yAt(nr.s);
          if (rdd < 3 || ry < y - 0.6) y = Math.min(y, ry - (rdd < 0.4 ? 0.2 : 0.12));
        }
      }
      pos.push(x, y - 0.02, z);
      groundColor(L, x, z, c);
      col.push(c.r, c.g, c.b);
    };
    for (let ci = 0; ci < bx.length - 1; ci++) for (let cj = 0; cj < bz.length - 1; cj++) {
      const cx = xs.filter((v) => v >= bx[ci] && v <= bx[ci + 1]);
      const cz = zs.filter((v) => v >= bz[cj] && v <= bz[cj + 1]);
      if (cx.length < 2 || cz.length < 2) continue;
      const pos: number[] = [], col: number[] = [], idx: number[] = [];
      for (const z of cz) for (const x of cx) vert(x, z, pos, col);
      const nx = cx.length;
      for (let j = 0; j < cz.length - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
        // alternate the diagonal for a less regular look
        if ((i + j) % 2) idx.push(a, d, b, b, d, e); else idx.push(a, d, e, a, e, b);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, wm.ground);
      mesh.name = `ground:${ci},${cj}`;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
    }

    // skirt out to the horizon, with notches where the river leaves the map
    const outer = new THREE.Shape([[-3000, -3000], [3000, -3000], [3000, 3000], [-3000, 3000]].map(([x, y]) => new THREE.Vector2(x, y)));
    const hi = HALF - 12;
    const up = L.river.portals.up.pos, dn = L.river.portals.down.pos;
    // hole outline (clockwise in shape space x, y=z): square with two notches (north at up.x, south at dn.x)
    const NW = 16, OUT = 520;
    const hole = [
      [-hi, -hi], [up.x - NW, -hi], [up.x - NW, -OUT], [up.x + NW, -OUT], [up.x + NW, -hi], [hi, -hi],
      [hi, hi], [dn.x + NW, hi], [dn.x + NW, OUT], [dn.x - NW, OUT], [dn.x - NW, hi], [-hi, hi],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    outer.holes.push(new THREE.Path(hole.reverse()));
    const sk = new THREE.ShapeGeometry(outer);
    sk.rotateX(Math.PI / 2); // shape y → +z (keeps z = shape y), faces down: flip below
    // rotateX(+90°) maps (x, y, 0) → (x, 0, y) with the normal pointing down; flip winding so it faces up
    {
      const ix = sk.getIndex();
      if (ix) { const a = ix.array as Uint16Array | Uint32Array; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } }
      sk.computeVertexNormals();
    }
    const sc = new Float32Array(sk.getAttribute('position').count * 3);
    const skc = base.clone().multiplyScalar(0.93);
    for (let i = 0; i < sc.length; i += 3) { sc[i] = skc.r; sc[i + 1] = skc.g; sc[i + 2] = skc.b; }
    sk.setAttribute('color', new THREE.BufferAttribute(sc, 3));
    const skirt = new THREE.Mesh(sk, wm.ground);
    skirt.position.y = T.skirtY;
    skirt.name = 'skirt';
    skirt.matrixAutoUpdate = false; skirt.updateMatrix();
    root.add(skirt);
  }

  // ───────────── forecourt: paved setts with stone kerb, central island, horse trough ─────────────
  {
    const F = L.forecourt;
    batch.cast = false;
    batch.push(F.center.x, 0, F.center.z, F.yaw);
    batch.boxB(wm.setts, F.size.x, 0.06, F.size.z, 0, 0, 0);
    const hx = F.size.x / 2, hz = F.size.z / 2;
    for (const sz of [-1, 1]) batch.box(wm.settsCourse, F.size.x - 0.4, 0.03, 1.1, 0, 0.06, sz * (hz - 0.75));
    for (const sx of [-1, 1]) batch.box(wm.settsCourse, 1.1, 0.03, F.size.z - 2.6, sx * (hx - 0.75), 0.06, 0);
    for (let x = -hx + 4; x < hx - 1; x += 4) batch.box(wm.settsCourse, 0.14, 0.02, F.size.z - 2.6, x, 0.06, 0);
    for (let z = -hz + 4; z < hz - 1; z += 4) batch.box(wm.settsCourse, F.size.x - 2.6, 0.02, 0.14, 0, 0.06, z);
    batch.boxB(mats.stone, F.size.x + 0.6, 0.14, 0.3, 0, 0, hz);
    batch.boxB(mats.stone, F.size.x + 0.6, 0.14, 0.3, 0, 0, -hz);
    // central island with flower bed
    batch.boxB(mats.stone, 6, 0.3, 3.2, 1, 0, 0);
    batch.addC(wm.paint, 0x5b4632, new THREE.BoxGeometry(5.4, 0.34, 2.6), batch.mat(1, 0.17, 0));
    // clipped box edging + bedding plants (big enough to read from the default view)
    for (const sz of [-1.12, 1.12]) batch.add(wm.shrub, new THREE.BoxGeometry(5.2, 0.32, 0.36), batch.mat(1, 0.5, sz));
    for (const sx of [-1.45, 3.45]) batch.add(wm.shrub, new THREE.BoxGeometry(0.36, 0.32, 1.9), batch.mat(sx, 0.5, 0));
    const fcols = [0xb8404a, 0xe0b84a, 0xe8dcc0, 0x9a5aa0];
    for (let i = 0; i < 14; i++) {
      const fx = 1 - 2.1 + (i % 7) * 0.7, fz = i < 7 ? -0.45 : 0.45;
      batch.addC(wm.paint, fcols[(i + (i < 7 ? 0 : 2)) % fcols.length], new THREE.IcosahedronGeometry(0.3, 0), batch.mat(fx, 0.52, fz));
    }
    // a cast-iron drinking fountain in the middle of the island
    batch.cast = true;
    batch.cyl(mats.iron, 0.35, 0.5, 0.5, 8, 1, 0.34, 0);
    batch.cyl(mats.iron, 0.14, 0.18, 1.5, 6, 1, 0.84, 0);
    batch.add(mats.bottleGreen, new THREE.SphereGeometry(0.28, 8, 5), batch.mat(1, 2.4, 0));
    batch.cast = false;
    // bollards along the carriage loop
    for (let i = -3; i <= 3; i++) batch.cyl(mats.iron, 0.12, 0.16, 0.9, 6, i * 3.5, 0, hz - 1.2);
    batch.cast = true;
    for (const sz of [-1, 1]) {
      batch.boxB(mats.stone, F.size.x, 0.9, 0.5, 0, 0, sz * (hz + 0.5));
      batch.boxB(mats.cream, F.size.x + 0.1, 0.12, 0.65, 0, 0.9, sz * (hz + 0.5));
      const segLen = hz - 6;
      batch.boxB(mats.stone, 0.5, 0.9, segLen, hx + 0.5, 0, sz * (6 + segLen / 2));
      batch.boxB(mats.cream, 0.65, 0.12, segLen, hx + 0.5, 0.9, sz * (6 + segLen / 2));
      batch.boxB(mats.stone, 1.0, 2.2, 1.0, hx + 0.5, 0, sz * 6.3);
      batch.boxB(mats.cream, 1.2, 0.2, 1.2, hx + 0.5, 2.2, sz * 6.3);
      batch.add(mats.cream, new THREE.IcosahedronGeometry(0.4, 1), batch.mat(hx + 0.5, 2.8, sz * 6.3));
    }
    batch.pop();
    // horse trough where the cab horses drink (traffic's forecourtTraffic.trough)
    const tr = L.forecourtTraffic.trough;
    const ly = L.forecourtTraffic.rank[0]?.yaw ?? F.yaw;
    batch.push(tr.x, 0, tr.z, ly);
    batch.boxB(mats.stone, 2.6, 0.8, 1.0, 0, 0, 0);
    batch.boxB(wm.water, 2.3, 0.05, 0.7, 0, 0.72, 0);
    batch.cyl(mats.iron, 0.08, 0.1, 1.2, 6, 1.5, 0, 0); // pump standard
    batch.pop();
    batch.cast = false;
  }

  // ───────────── fields: overlays with procedural rows, hedgerows / walls / rails, gates ─────────────
  const plough = { value: 0 };
  {
    const byChunk = new Map<string, { pos: number[]; col: number[]; row: number[]; pl: number[] }>();
    const c = new THREE.Color();
    for (const f of L.fields) {
      const [tint, pitch, amp] = FIELD_STYLE[f.kind];
      const dir = new THREE.Vector2(Math.cos(f.rowYaw), -Math.sin(f.rowYaw));
      const isPlough = f.kind === 'plough';
      // across-row extent for the plough progress
      let a0 = Infinity, a1 = -Infinity;
      for (const p of f.poly) { const a = -dir.y * p.x + dir.x * p.y; a0 = Math.min(a0, a); a1 = Math.max(a1, a); }
      const contour = f.poly.map((p) => new THREE.Vector2(p.x, p.y));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const bin = byChunk.get('all') ?? { pos: [], col: [], row: [], pl: [] };
      byChunk.set('all', bin); // one mesh for all field overlays (one draw)
      const emit = (p: THREE.Vector2) => {
        const y = H(p.x, p.y) + 0.04;
        bin.pos.push(p.x, y, p.y);
        c.setHex(tint);
        const n = noise2(p.x * 0.035 + f.center.x, p.y * 0.035) * 0.12 - 0.06;
        c.multiplyScalar(1 + n);
        bin.col.push(c.r, c.g, c.b);
        bin.row.push(dir.x, dir.y, pitch, amp);
        bin.pl.push(isPlough ? (-dir.y * p.x + dir.x * p.y - a0) / Math.max(1, a1 - a0) : -1);
      };
      const sub = (a: THREE.Vector2, b: THREE.Vector2, d: THREE.Vector2, depth: number) => {
        const ab = a.distanceTo(b), bd = b.distanceTo(d), da = d.distanceTo(a);
        const m = Math.max(ab, bd, da);
        if (m <= 9 || depth > 12) { emit(a); emit(b); emit(d); return; }
        // split the longest edge
        if (m === ab) { const q = a.clone().lerp(b, 0.5); sub(a, q, d, depth + 1); sub(q, b, d, depth + 1); }
        else if (m === bd) { const q = b.clone().lerp(d, 0.5); sub(a, b, q, depth + 1); sub(a, q, d, depth + 1); }
        else { const q = d.clone().lerp(a, 0.5); sub(a, b, q, depth + 1); sub(q, b, d, depth + 1); }
      };
      for (const [i, j, k] of tris) {
        // triangulateShape winding follows the contour; make every triangle face up (+y)
        const A = contour[i], B = contour[j], C = contour[k];
        const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
        if (cross > 0) sub(A, C, B, 0); else sub(A, B, C, 0);
      }
    }
    for (const [k, b] of byChunk) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      g.setAttribute('aRow', new THREE.Float32BufferAttribute(b.row, 4));
      g.setAttribute('aPlough', new THREE.Float32BufferAttribute(b.pl, 1));
      g.setAttribute('aWind', new THREE.Float32BufferAttribute(new Float32Array(b.pos.length / 3), 1));
      const gi = mergeVertices(g, 1e-3); // shared vertices → smooth normals (no triangle checker on rolling fields)
      gi.computeVertexNormals();
      gi.computeBoundingSphere();
      const mesh = new THREE.Mesh(gi, wm.field);
      mesh.name = `fields:${k}`;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
    }
    // plough progress: stubble ahead of the plough line
    wm.field.userData.plough = plough;
    const stub = new THREE.Color(STUBBLE);
    chain(wm.field, 'vjPlough', (sh) => {
      sh.uniforms.uPlough = plough;
      sh.uniforms.uStubble = { value: stub };
      sh.vertexShader = inject(sh.vertexShader, '#include <common>', 'attribute float aPlough; varying float vPlough;');
      sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', 'vPlough = aPlough;');
      sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'uniform float uPlough; uniform vec3 uStubble; varying float vPlough;');
      sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
  if (vPlough >= 0.0 && vPlough > uPlough) { diffuseColor.rgb = uStubble; }`);
    });

    // ── boundaries ──
    const hedgeM: THREE.Matrix4[] = [], hedgeC: THREE.Color[] = [];
    const q = new THREE.Quaternion(), s = new THREE.Vector3(), pp = new THREE.Vector3(), e = new THREE.Euler();
    const hrng = rng.fork(21);
    const okAt = (x: number, z: number, m = 1.2) => T.roadDist(x, z) > m && T.trackDist(x, z) > 5 && T.riverDist(x, z) > 2 && !env.blocked(x, z, 0.8) && Math.max(Math.abs(x), Math.abs(z)) < HALF - 8;
    for (const f of L.fields) {
      const walls = f.livestock === 'sheep';
      const rails = f.livestock === 'horses';
      const n = f.poly.length;
      for (let i = 0; i < n; i++) {
        const A = f.poly[i], B = f.poly[(i + 1) % n];
        const len = A.distanceTo(B);
        const yaw = Math.atan2(-(B.y - A.y), B.x - A.x);
        const segs = Math.max(1, Math.round(len / (walls || rails ? 3 : 4.5)));
        let prev: THREE.Vector3 | null = null;
        for (let k = 0; k < segs; k++) {
          const u = (k + 0.5) / segs;
          const x = A.x + (B.x - A.x) * u, z = A.y + (B.y - A.y) * u;
          const gd = Math.hypot(x - f.gate.x, z - f.gate.z);
          if (gd < 3.2 || !okAt(x, z)) { prev = null; continue; }
          const y = H(x, z);
          const sl = len / segs;
          if (walls) {
            batch.cast = false;
            batch.push(x, y, z, yaw);
            batch.boxB(mats.stone, sl + 0.05, 0.95 + hrng.range(-0.08, 0.08), 0.7, 0, -0.1, 0);
            batch.boxB(mats.stone, sl + 0.1, 0.16, 0.5, 0, 0.84, 0);
            batch.pop();
          } else if (rails) {
            const p = V(x, y, z);
            batch.detail = true;
            batch.boxB(mats.wood, 0.16, 1.3, 0.16, x, y, z);
            if (prev) {
              batch.beam(mats.wood, 0.08, 0.14, V(prev.x, prev.y + 1.1, prev.z), V(p.x, p.y + 1.1, p.z));
              batch.beam(mats.wood, 0.08, 0.14, V(prev.x, prev.y + 0.6, prev.z), V(p.x, p.y + 0.6, p.z));
            }
            batch.detail = false;
            prev = p;
          } else {
            const h = hrng.range(1.3, 2.0);
            e.set(0, yaw + hrng.range(-0.05, 0.05), 0);
            q.setFromEuler(e);
            hedgeM.push(new THREE.Matrix4().compose(pp.set(x, y - 0.25, z), q, s.set(sl + 0.6, h, hrng.range(1.4, 1.9))));
            hedgeC.push(new THREE.Color().setHSL(0.26 + hrng.range(-0.03, 0.03), 0.35 + hrng.range(-0.08, 0.08), 0.85 + hrng.range(-0.1, 0.1)));
            if (hrng.chance(0.07)) treeSpots.push({ p: V(x, y, z), scale: hrng.range(1.0, 1.3) });
          }
        }
      }
      // field gate (five-bar, standing open against the hedge) with two posts
      const gx = f.gate.x, gz = f.gate.z, gy = H(gx, gz);
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) {
        const A = f.poly[i], B = f.poly[(i + 1) % n];
        const abx = B.x - A.x, abz = B.y - A.y, l2 = abx * abx + abz * abz;
        const u = Math.max(0, Math.min(1, ((gx - A.x) * abx + (gz - A.y) * abz) / l2));
        const d = Math.hypot(gx - A.x - abx * u, gz - A.y - abz * u);
        if (d < bd) { bd = d; best = Math.atan2(-abz, abx); }
      }
      batch.cast = false;
      batch.push(gx, gy, gz, best);
      for (const sx of [-1.7, 1.7]) batch.boxB(mats.wood, 0.25, 1.45, 0.25, sx, 0, 0);
      batch.push(-1.6, 0, 0, -1.25);
      for (let b = 0; b < 5; b++) batch.box(wm.white, 3.1, 0.09, 0.07, 1.6, 0.3 + b * 0.24, 0);
      batch.beam(wm.white, 0.07, 0.09, V(0.1, 0.3, 0), V(3.0, 1.26, 0));
      batch.box(wm.white, 0.1, 1.2, 0.08, 3.1, 0.8, 0);
      batch.pop();
      batch.pop();
    }
    // path stiles
    for (const p of L.paths) for (const st of p.stiles) {
      const y = H(st.x, st.z);
      const n0 = p.poly.nearest(st.x, st.z);
      const yaw = p.poly.yawAt(n0.s) + Math.PI / 2;
      batch.push(st.x, y, st.z, yaw);
      for (const sx of [-0.8, 0.8]) batch.boxB(mats.wood, 0.14, 1.3, 0.14, sx, 0, 0);
      batch.box(mats.wood, 1.8, 0.1, 0.12, 0, 1.0, 0);
      batch.box(mats.wood, 1.8, 0.1, 0.12, 0, 0.6, 0);
      batch.box(mats.wood, 0.9, 0.08, 0.35, 0, 0.42, 0.3);
      batch.box(mats.wood, 0.9, 0.08, 0.35, 0, 0.42, -0.3);
      batch.pop();
    }
    if (hedgeM.length) {
      const hg = hedgeGeometry();
      const depth = applyWind(ctx, wm.hedge, { mode: 'foliage', weight: 'localY', height: 1, amp: 0.12, pivot: 'vertex' });
      for (const im of chunkedInstances(hg, wm.hedge, hedgeM, hedgeC, 'hedges', { cast: ctx.quality.knobs.shadowCasters !== 'major', depth })) root.add(im);
    }
  }

  // ───────────── copses where roads and the river leave the map (they vanish into woodland, not off an edge) ─────────────
  {
    const crng = rng.fork(0xc0e);
    const edgeOf = (x: number, z: number) => Math.max(Math.abs(x), Math.abs(z));
    const lines: { pts: THREE.Vector3[]; hw: number }[] = [];
    for (const e of Object.values(L.roads.edges)) lines.push({ pts: e.poly.pts, hw: e.width / 2 });
    lines.push({ pts: L.river.poly.pts, hw: 14 });
    for (const ln of lines) {
      for (let i = 0; i < ln.pts.length; i += 3) {
        const p = ln.pts[i];
        const ed = edgeOf(p.x, p.z);
        if (ed < 350 || ed > 416) continue;
        const a = ln.pts[Math.max(0, i - 1)], b = ln.pts[Math.min(ln.pts.length - 1, i + 1)];
        let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        for (const sd of [-1, 1]) {
          if (!crng.chance(0.75)) continue;
          const off = ln.hw + 3.5 + crng.range(0, 9);
          const x = p.x - tz * off * sd, z = p.z + tx * off * sd;
          if (T.roadDist(x, z) < 2.5 || T.riverDist(x, z) < 2.5 || T.trackDist(x, z) < 8 || edgeOf(x, z) > 417) continue;
          treeSpots.push({ p: V(x, 0, z), conifer: crng.chance(0.35), scale: crng.range(0.95, 1.35) });
        }
      }
    }
  }

  // ───────────── lineside fences (post & rail) on the outer sides of both lines near the station ─────────────
  {
    batch.detail = true;
    const fence = (line: 'coast' | 'highland', lateral: number, t0: number, t1: number) => {
      const Ln = L.lines[line];
      const step = 3 / Ln.length;
      let prev: THREE.Vector3 | null = null;
      for (let t = t0; t <= t1; t += step) {
        const p = Ln.offsetPoint(t, lateral, 0);
        const other = line === 'coast' ? env.highPts : env.coastPts;
        const bad = env.blocked(p.x, p.z, 1.5) || L.lampPositions.some((l) => l.distanceTo(p) < 2)
          || distOf(p, other) < 5 || distOf(p, env.shedPts) < 5
          || T.roadDist(p.x, p.z) < 1 || T.riverDist(p.x, p.z) < 3
          || Math.hypot(p.x - L.crossing.south.x, p.z - L.crossing.south.z) < 4
          || Math.hypot(p.x - L.crossing.north.x, p.z - L.crossing.north.z) < 4;
        if (bad) { prev = null; continue; }
        p.y = H(p.x, p.z);
        batch.boxB(mats.wood, 0.14, 1.1, 0.14, p.x, p.y, p.z);
        if (prev && Math.abs(prev.y - p.y) < 1.5) {
          batch.beam(mats.wood, 0.06, 0.1, V(prev.x, prev.y + 0.95, prev.z), V(p.x, p.y + 0.95, p.z));
          batch.beam(mats.wood, 0.06, 0.1, V(prev.x, prev.y + 0.5, prev.z), V(p.x, p.y + 0.5, p.z));
        }
        prev = p;
      }
    };
    const C = L.lines.coast, Hl = L.lines.highland;
    fence('coast', 5, C.nearestT(V(-22, 0, 24)), C.nearestT(V(250, 0, 24)));
    fence('highland', -5, Hl.nearestT(V(-40, 0, 12)), Hl.nearestT(V(225, 0, -205)));
    batch.detail = false;
  }

  // ───────────── tunnel portals (layout.tunnels, incl. the new shed tunnel) ─────────────
  batch.cast = true;
  for (const p of L.tunnels) {
    const yaw = Math.atan2(-p.dz, p.dx); // local +x = outward
    batch.push(p.x, 0, p.z, yaw);
    const W = p.width + 6;
    batch.boxB(mats.stone, 1.6, 9, W, 0.8, 0, 0);
    batch.boxB(mats.cream, 1.9, 0.5, W + 0.4, 0.8, 9, 0);
    for (const sd of [-1, 1]) {
      batch.boxB(mats.stone, 1.2, 10, 1.4, 0.6, 0, sd * (W / 2 - 0.4));
      // sloping wing wall (stone, cream coping) retaining a grassy shoulder of the hill in front of the portal
      batch.push(0, 0, sd * (W / 2 - 0.2), sd * 0.22);
      const ws = new THREE.Shape();
      ws.moveTo(0.4, 0); ws.lineTo(-9, 0); ws.lineTo(-9, 0.9); ws.lineTo(0.4, 9.2); ws.closePath();
      const wg = new THREE.ExtrudeGeometry(ws, { depth: 1.0, bevelEnabled: false });
      wg.translate(0, 0, -0.5);
      batch.add(mats.stone, wg);
      batch.add(mats.cream, new THREE.BoxGeometry(Math.hypot(9.4, 8.3) + 0.3, 0.2, 1.25), batch.mat(-4.3, 5.15, 0, 0, 0, Math.atan2(8.3, 9.4)));
      // shoulder: a convex wedge sloping down both away from the portal and away from the track
      const z0 = sd * 0.4, z1 = sd * 14;
      batch.add(mats.grass, convexHullTris([
        [0.4, 9.0, z0], [0.4, -0.4, z1], [-9.5, 0.3, z0], [-9.5, -0.4, z1], [0.4, -0.4, z0], [-9.5, -0.4, z0],
      ], [[0, 2, 3], [0, 3, 1], [0, 4, 5], [0, 5, 2], [0, 1, 4], [2, 5, 3], [4, 1, 3], [4, 3, 5]]));
      batch.pop();
    }
    const ah = p.id === 'shedWest' ? 6.2 : 7;
    batch.archSlab(wm.dark, p.width, ah, 0.2, -0.05, 0, 0, -Math.PI / 2);
    batch.archSlab(mats.cream, p.width + 1.0, ah + 0.5, 0.1, -0.02, 0, 0, -Math.PI / 2);
    batch.boxB(wm.dark, 16, ah, p.width - 0.2, 8.8, 0, 0);
    {
      // the hill over the portal: a grid mound in the GROUND material (vertex colours from groundColor, smooth
      // normals) that crowns just above the parapet and dives under the real terrain wherever that is higher, so from
      // behind it reads as part of the hillside instead of a faceted tent
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const U1 = 26, V1 = W / 2 + 16, NU = 10, NV = 14;
      const pos: number[] = [], cols: number[] = [], idx: number[] = [];
      const gc = new THREE.Color();
      for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
        const u = 1.2 + (U1 - 1.2) * (i / NU) ** 1.3;
        const v = -V1 + (2 * V1 * j) / NV;
        const av = Math.abs(v);
        const across = 1 - smooth(av, W / 2 - 1, V1);
        const along = 1 - smooth(u, 9, U1);
        const prof = 9.9 * across * along;
        const wx = p.x + u * c + v * s, wz = p.z - u * s + v * c;
        const g = H(wx, wz);
        pos.push(u, prof > g - 0.1 ? Math.max(prof, g) - 0.04 : g - 1.5, v);
        groundColor(L, wx, wz, gc);
        cols.push(gc.r, gc.g, gc.b);
      }
      for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
        const a = j * (NU + 1) + i, b = a + 1, d = a + NU + 1, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
      const mg = new THREE.BufferGeometry();
      mg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      mg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      mg.setIndex(idx);
      mg.computeVertexNormals();
      mg.computeBoundingSphere();
      const mound = new THREE.Mesh(mg, wm.ground);
      mound.name = `tunnelHill:${p.id}`;
      mound.position.set(p.x, 0, p.z);
      mound.rotation.y = yaw;
      mound.receiveShadow = true;
      mound.castShadow = true;
      mound.updateMatrix();
      mound.matrixAutoUpdate = false;
      root.add(mound);
    }
    batch.pop();
  }
  batch.cast = false;

  return {
    treeSpots,
    setPlough(f) { plough.value = f; },
  };
}

const _gc = {
  base: new THREE.Color(0x6f8f4e), worn: new THREE.Color(0x857a5e), lawn: new THREE.Color(0x7c9c54),
  damp: new THREE.Color(0x5d8446), upland: new THREE.Color(0x8a9a58), green: new THREE.Color(0x86a85c),
};
let _greens: { center: THREE.Vector3; size: THREE.Vector3 }[] | null = null;
/** the ground's vertex colour at (x, z) — shared by the ground grid and the river-bank ribbon so they blend */
export function groundColor(L: Ctx['layout'], x: number, z: number, c: THREE.Color): THREE.Color {
  const T = L.terrain;
  _greens ??= L.towns.flatMap((t) => t.areas.filter((a) => a.kind === 'green' || a.kind === 'churchyard'));
  const st = L.station.center;
  const td = T.trackDist(x, z);
  c.copy(_gc.base);
  if (Math.hypot(x - st.x, z - st.z) < 60) c.lerp(_gc.lawn, 0.5);
  c.lerp(_gc.worn, (1 - smooth(td, 2.5, 7)) * 0.6);
  const hy = L.heightAt(x, z);
  if (hy < -0.5) c.lerp(_gc.damp, 0.5);
  if (hy > 4) c.lerp(_gc.upland, smooth(hy, 4, 12) * 0.5);
  for (const g of _greens) if (Math.abs(x - g.center.x) < g.size.x * 0.6 && Math.abs(z - g.center.z) < g.size.x * 0.6) c.lerp(_gc.green, 0.35);
  const nv = noise2(x * 0.08, z * 0.08) * 0.16 + noise2(x * 0.3, z * 0.3) * 0.06 - 0.11;
  c.multiplyScalar(1 + nv + Math.max(-2, Math.min(6, hy)) * 0.008);
  return c;
}

/** unit hedge block: 1 × 1 × 1 (x length, y height, z width), bottom at 0, lumpy rounded top */
function hedgeGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1, 3, 1, 1);
  g.translate(0, 0.5, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (y > 0.9) {
      // round the top edge inwards and add lumps
      p.setZ(i, z * 0.72);
      p.setY(i, y + 0.12 * Math.sin(x * 9.0 + 1.3));
    }
  }
  g.computeVertexNormals();
  return g;
}

function distOf(p: THREE.Vector3, pts: THREE.Vector3[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const abx = b.x - a.x, abz = b.z - a.z;
    const l2 = abx * abx + abz * abz || 1;
    const u = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + abx * u), p.z - (a.z + abz * u)));
  }
  return best;
}

/** triangles over a small convex solid, each wound to face away from the centroid */
function convexHullTris(pts: [number, number, number][], tris: [number, number, number][]): THREE.BufferGeometry {
  const c = new THREE.Vector3();
  for (const p of pts) c.add(new THREE.Vector3(...p));
  c.multiplyScalar(1 / pts.length);
  const pos: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
  for (const [i, j, k] of tris) {
    a.set(...pts[i]); b.set(...pts[j]); d.set(...pts[k]);
    n.subVectors(b, a).cross(m.subVectors(d, a));
    m.copy(a).add(b).add(d).multiplyScalar(1 / 3).sub(c);
    const q = n.dot(m) >= 0 ? [a, b, d] : [a, d, b];
    for (const v of q) pos.push(v.x, v.y, v.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
