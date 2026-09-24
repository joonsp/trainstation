import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { Field } from '../core/layout';
import { applyWind } from '../core/wind';
import { addUpVarying, chain, inject } from '../core/shaderMods';
import { hash1 } from './util';

/**
 * CROPS, MEADOW GRASS, REEDS, WATER LILIES and HAYCOCKS — one merged, vertex-coloured mesh (1 draw) animated by
 * the shared wind in 'crop' mode (weight = baked aWind: 0 at the ground, 1 at the ear/tip) so gusts roll across
 * the wheat as visible waves (plus a gust sheen). On tiers without crop geometry the fields become flat sheen
 * sheets (the gust waves still show as a moving brightness).
 */
export interface Plants { mesh: THREE.Mesh; setSeason(lily: number): void }

interface Buf { p: number[]; c: number[]; w: number[]; lily: number[]; row: number[]; snowy: number[] }

const CROP: Record<string, { h: number; top: number; base: number; speck?: number; speckP?: number }> = {
  wheat: { h: 0.95, top: 0xd8b158, base: 0x8f6f33, speck: 0xc0382a, speckP: 0.05 },
  barley: { h: 0.8, top: 0xd9cf98, base: 0x958d5c, speck: 0x4a64b0, speckP: 0.03 },
  hay: { h: 0.55, top: 0xa3ad5e, base: 0x5f7c3e, speck: 0xf0e070, speckP: 0.035 },
};

export function createPlants(ctx: Ctx, uLily: { value: number }): Plants {
  const L = ctx.layout, R = L.river, K = ctx.quality.knobs;
  const b: Buf = { p: [], c: [], w: [], lily: [], row: [], snowy: [] };
  /** how readily this geometry takes snow regardless of its normal: 1 crop/hay, 2 flower specks (hidden), 0 none */
  let curSnowy = 0;
  /** row direction (yaw) of the flat crop sheet being built (low tier), −99 = not a crop sheet */
  let curRow = -99;
  const col = new THREE.Color(), col2 = new THREE.Color();
  const push = (x: number, y: number, z: number, c: THREE.Color, w: number, lily = 0) => { b.p.push(x, y, z); b.c.push(c.r, c.g, c.b); b.w.push(w); b.lily.push(lily); b.row.push(curRow); b.snowy.push(curSnowy); };
  const tri = (ax: number, ay: number, az: number, ca: THREE.Color, wa: number, bx: number, by: number, bz: number, cb: THREE.Color, wb: number, cx: number, cy: number, cz: number, cc: THREE.Color, wc: number, lily = 0) => {
    push(ax, ay, az, ca, wa, lily); push(bx, by, bz, cb, wb, lily); push(cx, cy, cz, cc, wc, lily);
  };
  const H = (x: number, z: number) => L.heightAt(x, z);

  // ── crops: corrugated rows along rowYaw ──
  curSnowy = 1;
  const cropFields = L.fields.filter((f) => f.kind === 'wheat' || f.kind === 'barley' || (f.kind === 'hay' && f.id !== 'FL'));
  const fieldSegments = (f: Field, pitch: number, inset: number) => {
    const dx = Math.cos(f.rowYaw), dz = -Math.sin(f.rowYaw);
    const nx = -dz, nz = dx;
    let nmin = Infinity, nmax = -Infinity;
    for (const v of f.poly) { const o = v.x * nx + v.y * nz; nmin = Math.min(nmin, o); nmax = Math.max(nmax, o); }
    const segs: { ox: number; oz: number; t0: number; t1: number }[] = [];
    for (let o = nmin + inset; o <= nmax - inset; o += pitch) {
      const ox = nx * o, oz = nz * o;
      const ts: number[] = [];
      for (let i = 0; i < f.poly.length; i++) {
        const a = f.poly[i], c = f.poly[(i + 1) % f.poly.length];
        const ea = (a.x - ox) * nx + (a.y - oz) * nz, ec = (c.x - ox) * nx + (c.y - oz) * nz;
        if ((ea > 0) === (ec > 0)) continue;
        const u = ea / (ea - ec);
        const px = a.x + (c.x - a.x) * u, pz = a.y + (c.y - a.y) * u;
        ts.push((px - ox) * dx + (pz - oz) * dz);
      }
      ts.sort((p, q) => p - q);
      for (let k = 0; k + 1 < ts.length; k += 2) {
        const t0 = ts[k] + inset, t1 = ts[k + 1] - inset;
        if (t1 - t0 > 2) segs.push({ ox, oz, t0, t1 });
      }
    }
    return { segs, dx, dz, nx, nz };
  };

  if (K.cropGeometry) {
    const pitch = K.cropPitch;
    for (const f of cropFields) {
      const cp = CROP[f.kind];
      const { segs, dx, dz, nx, nz } = fieldSegments(f, pitch, 2.2);
      const hw = pitch * 0.48;
      const cTop = new THREE.Color(cp.top), cBase = new THREE.Color(cp.base), cSpeck = new THREE.Color(cp.speck ?? cp.top);
      let seed = 0;
      for (const sg of segs) {
        const n = Math.max(1, Math.round((sg.t1 - sg.t0) / 2));
        let prev: number[] | null = null;
        for (let i = 0; i <= n; i++) {
          const t = sg.t0 + ((sg.t1 - sg.t0) * i) / n;
          const cx = sg.ox + dx * t, cz = sg.oz + dz * t;
          const lx = cx - nx * hw, lz = cz - nz * hw, rx = cx + nx * hw, rz = cz + nz * hw;
          const gy = H(cx, cz);
          const hh = cp.h * (0.82 + 0.36 * hash1(cx * 3.1 + cz * 7.7 + seed));
          const cur = [lx, H(lx, lz) - 0.05, lz, cx, gy + hh, cz, rx, H(rx, rz) - 0.05, rz];
          if (prev) {
            const sp = hash1(cx * 1.3 + cz * 2.9 + 17) < (cp.speckP ?? 0);
            col.copy(cTop).multiplyScalar(0.94 + 0.12 * hash1(cx + cz * 3));
            if (sp) {
              // a poppy / cornflower / clover head poking above the ears
              const px = cx + (hash1(cx * 7.1) - 0.5) * 1.2 * dx, pz = cz + (hash1(cz * 5.3) - 0.5) * 1.2 * dz, py = gy + hh + 0.08, r = 0.2;
              curSnowy = 2;
              tri(px - r, py, pz, cSpeck, 1, px + r, py, pz, cSpeck, 1, px, py + r * 1.6, pz, cSpeck, 1);
              tri(px, py, pz - r, cSpeck, 1, px, py, pz + r, cSpeck, 1, px, py + r * 1.6, pz, cSpeck, 1);
              curSnowy = 1;
            }
            col2.copy(cBase);
            // left slope (base→top), right slope (top→base)
            tri(prev[0], prev[1], prev[2], col2, 0, prev[3], prev[4], prev[5], col, 1, cur[0], cur[1], cur[2], col2, 0);
            tri(prev[3], prev[4], prev[5], col, 1, cur[3], cur[4], cur[5], col, 1, cur[0], cur[1], cur[2], col2, 0);
            tri(prev[3], prev[4], prev[5], col, 1, prev[6], prev[7], prev[8], col2, 0, cur[3], cur[4], cur[5], col, 1);
            tri(prev[6], prev[7], prev[8], col2, 0, cur[6], cur[7], cur[8], col2, 0, cur[3], cur[4], cur[5], col, 1);
          }
          prev = cur;
          seed++;
        }
      }
    }
  } else {
    // flat sheen sheets (gust waves as brightness)
    const cell = 6;
    for (const f of cropFields) {
      const cp = CROP[f.kind];
      const cTop = new THREE.Color(cp.top);
      curRow = f.rowYaw;
      const { segs, dx, dz, nx, nz } = fieldSegments(f, cell, 2.2);
      // colour varies smoothly per VERTEX (shared corners), not per cell — no checkerboard
      const cA = new THREE.Color(), cB = new THREE.Color(), cC = new THREE.Color(), cD = new THREE.Color();
      const vc = (out: THREE.Color, q: number[]) => out.copy(cTop).multiplyScalar(0.93 + 0.1 * (0.5 + 0.5 * Math.sin(q[0] * 0.21 + Math.sin(q[2] * 0.17) * 2.0)));
      for (let k = 0; k + 1 < segs.length; k++) {
        const A = segs[k], B = segs[k + 1];
        const t0 = Math.max(A.t0, B.t0), t1 = Math.min(A.t1, B.t1);
        if (t1 - t0 < 1) continue;
        const n = Math.max(1, Math.round((t1 - t0) / cell));
        for (let i = 0; i < n; i++) {
          const ta = t0 + ((t1 - t0) * i) / n, tb = t0 + ((t1 - t0) * (i + 1)) / n;
          const p = (S: typeof A, t: number) => { const x = S.ox + dx * t, z = S.oz + dz * t; return [x, H(x, z) + cp.h * 0.5, z]; };
          const a = p(A, ta), bq = p(A, tb), c = p(B, ta), d = p(B, tb);
          vc(cA, a); vc(cB, bq); vc(cC, c); vc(cD, d);
          tri(a[0], a[1], a[2], cA, 0, bq[0], bq[1], bq[2], cB, 0, c[0], c[1], c[2], cC, 0);
          tri(bq[0], bq[1], bq[2], cB, 0, d[0], d[1], d[2], cD, 0, c[0], c[1], c[2], cC, 0);
          void nx; void nz;
        }
      }
      curRow = -99;
    }
  }

  // ── haycocks in Church Acre (cut hay) ──
  const fl = L.fields.find((f) => f.id === 'FL');
  if (fl) {
    const { segs, dx, dz } = fieldSegments(fl, 7, 4);
    const cHay = new THREE.Color(0xc2ad62), cHayD = new THREE.Color(0x8d7a40);
    for (const sg of segs) {
      for (let t = sg.t0 + 2; t < sg.t1 - 2; t += 8) {
        const x = sg.ox + dx * t + (hash1(t + sg.ox) - 0.5) * 1.5, z = sg.oz + dz * t + (hash1(t * 3 + sg.oz) - 0.5) * 1.5;
        const gy = H(x, z), r = 0.9, h = 1.5;
        const SEG = 6;
        for (let k = 0; k < SEG; k++) {
          const a0 = (k / SEG) * Math.PI * 2, a1 = ((k + 1) / SEG) * Math.PI * 2;
          col.copy(k % 2 ? cHay : cHayD);
          tri(x + Math.cos(a0) * r, gy, z + Math.sin(a0) * r, col, 0, x, gy + h, z, cHay, 0.15, x + Math.cos(a1) * r, gy, z + Math.sin(a1) * r, col, 0);
        }
      }
    }
  }

  // ── reeds ──
  curSnowy = 0.35;
  const reedTotal = R.reeds.reduce((a, r) => a + (r.s1 - r.s0), 0);
  const spacing = Math.max(0.5, reedTotal / Math.max(20, K.caps.reeds));
  const cReed = new THREE.Color(0x6f7f3a), cReedD = new THREE.Color(0x4a5a2a), cHead = new THREE.Color(0x4a3222), cTip = new THREE.Color(0xa5a060);
  let clump = 0;
  for (const bed of R.reeds) {
    for (let s = bed.s0; s < bed.s1; s += spacing) {
      const hw = R.widthAt(s) / 2;
      const lat = bed.side * (hw - 0.6 + hash1(s * 7.1) * 1.4);
      const p = R.pointAt(s, lat, 0);
      const wy = R.waterYAt(s) - 0.15;
      const blades = 3 + (clump % 2);
      for (let k = 0; k < blades; k++) {
        const a = hash1(s * 13 + k) * Math.PI;
        const h = 1.2 + hash1(s * 3 + k * 5) * 0.9;
        const lean = (hash1(s + k * 11) - 0.5) * 0.5;
        const ox = (hash1(s * 5 + k) - 0.5) * 0.5, oz = (hash1(s * 9 + k) - 0.5) * 0.5;
        const cx = Math.cos(a) * 0.07, cz = Math.sin(a) * 0.07;
        const bx = p.x + ox, bz = p.z + oz;
        const tx = bx + lean * Math.sin(a), tz = bz + lean * Math.cos(a);
        col.copy(k % 2 ? cReed : cReedD);
        tri(bx - cx, wy, bz - cz, col, 0, bx + cx, wy, bz + cz, col, 0, tx, wy + h, tz, cTip, 1);
        if (k === 0 && clump % 3 === 0) {
          // bulrush head: small dark diamond near the top
          const hy = wy + h * 0.78, hx = bx + lean * Math.sin(a) * 0.78, hz = bz + lean * Math.cos(a) * 0.78;
          tri(hx - 0.07, hy, hz, cHead, 0.78, hx + 0.07, hy, hz, cHead, 0.78, hx, hy + 0.3, hz, cHead, 0.9);
          tri(hx, hy, hz - 0.07, cHead, 0.78, hx, hy, hz + 0.07, cHead, 0.78, hx, hy + 0.3, hz, cHead, 0.9);
        }
      }
      clump++;
    }
  }

  // ── water lilies in the slow reaches (hidden in winter / under ice) ──
  curSnowy = 0;
  const pool = R.reaches.find((r) => r.id === 'millpool');
  if (pool) {
    const cPad = new THREE.Color(0x3f6a34), cPadL = new THREE.Color(0x5b8a44), cFl = new THREE.Color(0xf2e8ec);
    for (let s = pool.s0; s < pool.s1; s += 2.3) {
      const hw = R.widthAt(s) / 2;
      const side = hash1(s) > 0.5 ? 1 : -1;
      if (side > 0 && s > R.lock.s0 - 20) continue; // keep the lock approach clear
      const lat = side * (hw - 1.2 - hash1(s * 3) * 2.2);
      const p = R.pointAt(s, lat, 0);
      const y = R.waterYAt(s) + 0.02;
      const r = 0.35 + hash1(s * 5) * 0.35;
      const SEG = 6;
      col.copy(hash1(s * 7) > 0.5 ? cPad : cPadL);
      for (let k = 0; k < SEG - 1; k++) {
        const a0 = (k / SEG) * Math.PI * 2 + s, a1 = ((k + 1) / SEG) * Math.PI * 2 + s;
        tri(p.x, y, p.z, col, 0, p.x + Math.cos(a1) * r, y, p.z + Math.sin(a1) * r, col, 0, p.x + Math.cos(a0) * r, y, p.z + Math.sin(a0) * r, col, 0, 1);
      }
      if (hash1(s * 11) > 0.6) {
        const fx = p.x + 0.1, fz = p.z + 0.05;
        tri(fx - 0.1, y + 0.02, fz, cFl, 0, fx + 0.1, y + 0.02, fz, cFl, 0, fx, y + 0.16, fz, cFl, 0, 1);
        tri(fx, y + 0.02, fz - 0.1, cFl, 0, fx, y + 0.02, fz + 0.1, cFl, 0, fx, y + 0.16, fz, cFl, 0, 1);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
  geo.setAttribute('aWind', new THREE.Float32BufferAttribute(b.w, 1));
  geo.setAttribute('aLily', new THREE.Float32BufferAttribute(b.lily, 1));
  const lowCrops = !K.cropGeometry;
  if (lowCrops) geo.setAttribute('aRow', new THREE.Float32BufferAttribute(b.row, 1));
  geo.setAttribute('aSnowy', new THREE.Float32BufferAttribute(b.snowy, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  mat.name = 'nature:plants';
  // lilies collapse when out of season / under ice (degenerate triangles are never rasterised)
  chain(mat, 'nature:lily', (sh) => {
    sh.uniforms.uLily = uLily;
    sh.vertexShader = inject(sh.vertexShader, '#include <common>', 'attribute float aLily; uniform float uLily;');
    sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', 'if (aLily > 0.5 && uLily < 0.5) transformed = vec3(0.0, -50.0, 0.0);');
  });
  const depth = applyWind(ctx, mat, { mode: 'crop', weight: 'attr', amp: 0.32, pivot: 'vertex' });
  if (K.wind.crop) {
    // stronger gust sheen than the core default (the wind injector declares vWindGust in the fragment for crops)
    chain(mat, 'nature:cropSheen', (sh) => {
      sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', 'diffuseColor.rgb *= 1.0 + 1.1 * vWindGust;');
    });
  }
  if (lowCrops) {
    // low tier (no row geometry): painted drill rows plus travelling gust bands in the fragment shader, so the
    // wind still visibly combs the corn at zoom 1-2 (a few ALU ops, no extra geometry or draw)
    const W = ctx.wind.uniforms;
    chain(mat, 'nature:cropBands', (sh) => {
      sh.uniforms.uCropT = W.uWindTime; sh.uniforms.uCropDir = W.uWindDir; sh.uniforms.uCropStr = W.uWindStr;
      sh.vertexShader = inject(sh.vertexShader, '#include <common>', 'attribute float aRow; varying float vRow; varying vec2 vCropXZ;');
      sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', 'vRow = aRow; vCropXZ = (modelMatrix * vec4(position, 1.0)).xz;');
      sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'uniform float uCropT, uCropStr; uniform vec2 uCropDir; varying float vRow; varying vec2 vCropXZ;');
      sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
if (vRow > -50.0) {
  vec2 rd = vec2(cos(vRow), -sin(vRow));
  vec2 rn = vec2(-rd.y, rd.x);
  // drill rows (1.6 m pitch): soft dark furrows between lighter ridges
  float r = 0.5 + 0.5 * sin(dot(vCropXZ, rn) * 3.927);
  diffuseColor.rgb *= 0.9 + 0.13 * r;
  // gusts: bright bands racing downwind (wavelength ~11 m) broken up by a slower cross wave
  float along = dot(vCropXZ, uCropDir);
  float cross = dot(vCropXZ, vec2(-uCropDir.y, uCropDir.x));
  float band = sin(along * 0.57 - uCropT * 2.6 + sin(cross * 0.09 + uCropT * 0.3) * 2.2);
  float gust = smoothstep(-0.2, 1.0, band) * (0.6 + 0.4 * sin(cross * 0.21 - uCropT * 0.7));
  // ears bent over by a gust show their pale undersides; the lulls between read a shade darker
  diffuseColor.rgb *= 1.0 + (0.2 + 0.25 * clamp(uCropStr, 0.0, 1.5)) * (gust - 0.3) * (0.8 + 0.2 * r);
}`);
    });
  }
  // snow: crops, stooks and reeds whiten by the snow cover whatever their normals (steep ridges / flat sheets),
  // and the poppy / cornflower specks sink out of sight once snow lies
  chain(mat, 'nature:plantSnow', (sh) => {
    sh.uniforms.uVjSnowP = ctx.mats.uniforms.uSnow;
    addUpVarying(sh);
    sh.vertexShader = inject(sh.vertexShader, '#include <common>', 'attribute float aSnowy; varying float vSnowy; uniform float uVjSnowP;');
    sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', 'vSnowy = aSnowy; if (aSnowy > 1.5 && uVjSnowP > 0.3) transformed.y -= 0.6;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'uniform float uVjSnowP; varying float vSnowy;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
{ float up = smoothstep(0.35, 0.8, abs(vVjUp));
  float k = max(up, min(vSnowy, 1.0) * 0.92);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), clamp(uVjSnowP * 1.1, 0.0, 1.0) * k); }`);
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'nature:plants';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  if (depth) mesh.customDepthMaterial = depth;
  mesh.frustumCulled = false;
  return { mesh, setSeason(l) { uLily.value = l; } };
}
