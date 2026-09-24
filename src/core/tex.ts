import * as THREE from 'three';
import { chain, inject, addUpVarying } from './shaderMods';

/**
 * PROCEDURAL DETAIL TEXTURES (v2). Two RGBA DataTextures of tileable grey patterns, multiplied over a material's
 * flat colour (so palette, weather tint and snow still come from material.color and the other injectors).
 *   A: R slate courses · G brick coursing · B setts/cobbles · A planks / weatherboarding
 *   B: R thatch · G field furrows · B ripple noise (water) · A grime / low-frequency variation
 * UVs are computed in the vertex shader from OBJECT-space position + normal (no geometry work, works on Kit's
 * merged world-space meshes and moving objects alike): flat tops use xz, walls use (along-wall, y), roofs
 * get courses parallel to the eaves. Each channel is normalised by its mean, so mipmaps fade back to the
 * plain colour when zoomed out (no moiré).
 *
 * Usage: `withDetail(ctx.tex, material, { pattern: 'slate' })` (no-op when the quality tier disables detail).
 * Shared core materials (slate, brick, brickDark, wood, platform, gravel) are patched once by main.ts (dressCoreMaterials).
 */
export type DetailPattern = 'slate' | 'brick' | 'setts' | 'planks' | 'thatch' | 'furrows' | 'ripple' | 'grime';
export interface DetailOpts {
  pattern: DetailPattern;
  /** override tiles per metre (defaults per pattern) */
  scale?: number;
  /** 0..1 mix toward the full pattern (default per pattern ≈ 0.35–0.5) */
  strength?: number;
}

const CHANNEL: Record<DetailPattern, [0 | 1, number]> = {
  slate: [0, 0], brick: [0, 1], setts: [0, 2], planks: [0, 3], thatch: [1, 0], furrows: [1, 1], ripple: [1, 2], grime: [1, 3],
};
/** metres covered by one texture tile */
const TILE_M: Record<DetailPattern, number> = { slate: 2.4, brick: 1.2, setts: 1.0, planks: 2.0, thatch: 2.0, furrows: 3.0, ripple: 6.0, grime: 16.0 };
const STRENGTH: Record<DetailPattern, number> = { slate: 0.5, brick: 0.35, setts: 0.45, planks: 0.4, thatch: 0.45, furrows: 0.4, ripple: 0.3, grime: 0.3 };

export interface TexLib {
  readonly size: number;
  readonly detailA: THREE.DataTexture;
  readonly detailB: THREE.DataTexture;
  /** per-channel means (A.rgba, B.rgba), 0..1 */
  readonly means: [THREE.Vector4, THREE.Vector4];
  /** false when the tier disables detail textures (withDetail becomes a no-op) */
  readonly enabled: boolean;
  /** cached CanvasTexture factory for one-off textures (signs, liveries…) */
  get(key: string, draw: (g: CanvasRenderingContext2D, size: number) => void, size?: number): THREE.CanvasTexture;
  /** shared snow uniform (same object as ctx.mats.uniforms.uSnow) */
  readonly uSnow: { value: number };
}

// ── tileable value noise ──
function h2(x: number, y: number, seed: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function pnoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period, y = v * period;
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const w = (a: number) => ((a % period) + period) % period;
  const a = h2(w(xi), w(yi), seed), b = h2(w(xi + 1), w(yi), seed), c = h2(w(xi), w(yi + 1), seed), d = h2(w(xi + 1), w(yi + 1), seed);
  const U = xf * xf * (3 - 2 * xf), V = yf * yf * (3 - 2 * yf);
  return a + (b - a) * U + (c - a) * V + (a - b - c + d) * U * V;
}
function fbm(u: number, v: number, p0: number, seed: number, oct = 4): number {
  let s = 0, amp = 0.5, p = p0, n = 0;
  for (let i = 0; i < oct; i++) { s += amp * pnoise(u, v, p, seed + i * 13); n += amp; amp *= 0.5; p *= 2; }
  return s / n;
}
const fr = (x: number) => x - Math.floor(x);
const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// pattern functions: (u, v) in [0,1) of one tile → 0..1
const PAT: Record<DetailPattern, (u: number, v: number) => number> = {
  slate(u, v) {
    const rows = 8, cols = 4;
    const r = Math.floor(v * rows), fv = fr(v * rows);
    const cu = u * cols + (r % 2) * 0.5, c = Math.floor(cu), fu = fr(cu);
    let val = 0.72 + 0.22 * h2(c % cols, r, 3) + 0.06 * (pnoise(u, v, 32, 5) - 0.5);
    val *= 0.55 + 0.45 * sm(0.0, 0.16, fv);          // shadowed drip edge of the course above
    val *= 0.78 + 0.22 * sm(0.0, 0.05, Math.min(fu, 1 - fu)); // vertical joint
    return val;
  },
  brick(u, v) {
    const rows = 4, cols = 2;
    const r = Math.floor(v * rows), fv = fr(v * rows);
    const cu = u * cols + (r % 2) * 0.5, c = Math.floor(cu), fu = fr(cu);
    const mortar = Math.min(fv, 1 - fv) < 0.07 || Math.min(fu, 1 - fu) < 0.035;
    if (mortar) return 0.97;
    const header = h2(c % cols, r, 9) > 0.86;
    return (header ? 0.52 : 0.68) + 0.2 * h2(c % cols, r, 7) + 0.05 * (pnoise(u, v, 24, 2) - 0.5);
  },
  setts(u, v) {
    const n = 4;
    const r = Math.floor(v * n), fv = fr(v * n);
    const cu = u * n + (r % 2) * 0.5, c = Math.floor(cu), fu = fr(cu);
    const e = Math.min(fu, 1 - fu, fv, 1 - fv);
    return (0.62 + 0.26 * h2(c % n, r, 11)) * (0.5 + 0.5 * sm(0.02, 0.12, e));
  },
  planks(u, v) {
    const boards = 8;
    const r = Math.floor(v * boards), fv = fr(v * boards);
    const grain = 0.06 * Math.sin((u * 60 + h2(r, 1, 2) * 20) + 3 * pnoise(u, v * boards, 8, r));
    const joint = sm(0.0, 0.08, Math.min(fv, 1 - fv));
    const butt = Math.min(fr(u * 2 + h2(r, 3, 4)), 1 - fr(u * 2 + h2(r, 3, 4))) < 0.01 ? 0.7 : 1;
    return (0.72 + 0.16 * h2(r, 0, 6) + grain) * (0.55 + 0.45 * joint) * butt;
  },
  thatch(u, v) {
    const streak = pnoise(u * 1, v, 48, 21) * 0.6 + pnoise(u, v, 96, 22) * 0.4;
    const course = sm(0.0, 0.25, fr(v * 4));
    return 0.6 + 0.3 * streak * (0.7 + 0.3 * course) + 0.1 * course;
  },
  furrows(u, v) {
    const rows = 2;
    const ridge = 0.5 + 0.5 * Math.cos(v * rows * Math.PI * 2);
    return 0.62 + 0.28 * ridge + 0.1 * (fbm(u, v, 16, 31, 3) - 0.5);
  },
  ripple(u, v) { return fbm(u, v, 4, 41, 5); },
  grime(u, v) { return 0.8 + 0.2 * fbm(u, v, 3, 51, 4); },
};

function makeTex(size: number, pats: DetailPattern[], anis: number): { tex: THREE.DataTexture; mean: THREE.Vector4 } {
  const data = new Uint8Array(size * size * 4);
  const sum = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    for (let c = 0; c < 4; c++) {
      const val = Math.round(Math.min(1, Math.max(0, PAT[pats[c]](u, v))) * 255);
      data[(y * size + x) * 4 + c] = val;
      sum[c] += val;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = anis;
  tex.needsUpdate = true;
  const n = size * size * 255;
  return { tex, mean: new THREE.Vector4(sum[0] / n, sum[1] / n, sum[2] / n, sum[3] / n) };
}

export function createTexLib(opts: { size: number; enabled: boolean; anisotropy: number; uSnow: { value: number } }): TexLib {
  // even when disabled keep tiny textures so code referencing them never breaks
  const size = opts.enabled ? opts.size : 16;
  const A = makeTex(size, ['slate', 'brick', 'setts', 'planks'], opts.anisotropy);
  const B = makeTex(size, ['thatch', 'furrows', 'ripple', 'grime'], opts.anisotropy);
  const cache = new Map<string, THREE.CanvasTexture>();
  return {
    size, detailA: A.tex, detailB: B.tex, means: [A.mean, B.mean], enabled: opts.enabled, uSnow: opts.uSnow,
    get(key, draw, s = 256) {
      let t = cache.get(key);
      if (!t) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = s;
        draw(cv.getContext('2d')!, s);
        t = new THREE.CanvasTexture(cv);
        t.colorSpace = THREE.SRGBColorSpace;
        cache.set(key, t);
      }
      return t;
    },
  };
}

/**
 * Multiply a procedural detail pattern over `mat`'s colour (object-space UVs, see file header).
 * No-op when detail textures are disabled for the tier. Snow reduces the detail on up-facing faces.
 */
export function withDetail(lib: TexLib, mat: THREE.Material, o: DetailOpts): void {
  if (!lib.enabled) return;
  const [ti, ch] = CHANNEL[o.pattern];
  const scale = o.scale ?? 1 / TILE_M[o.pattern];
  const str = o.strength ?? STRENGTH[o.pattern];
  const mask = new THREE.Vector4(ch === 0 ? 1 : 0, ch === 1 ? 1 : 0, ch === 2 ? 1 : 0, ch === 3 ? 1 : 0);
  const mean = Math.max(0.05, lib.means[ti].getComponent(ch));
  const tex = ti === 0 ? lib.detailA : lib.detailB;
  // identifiers are suffixed per pattern so several details can stack on one material
  const X = o.pattern;
  chain(mat, `detail:${o.pattern}:${scale.toFixed(4)}:${str.toFixed(3)}`, (sh) => {
    sh.uniforms[`uDetTex_${X}`] = { value: tex };
    sh.uniforms[`uDetMask_${X}`] = { value: mask };
    sh.uniforms.uVjSnowD = lib.uSnow;
    addUpVarying(sh);
    sh.vertexShader = inject(sh.vertexShader, '#include <common>', `varying vec2 vDetUv_${X};`);
    sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', `
{
  vec3 dn = length(objectNormal) > 0.01 ? normalize(objectNormal) : vec3(0.0, 1.0, 0.0);
  vec3 dp = position;
  vec2 duv;
  if (abs(dn.y) > 0.92) duv = dp.xz;
  else {
    vec2 t = normalize(vec2(-dn.z, dn.x));
    float s = max(length(dn.xz), 0.25);
    duv = vec2(dot(dp.xz, t), dp.y / s);
  }
  vDetUv_${X} = duv * ${scale.toFixed(5)};
}`);
    if (!sh.fragmentShader.includes('uniform float uVjSnowD;')) sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'uniform float uVjSnowD;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', `varying vec2 vDetUv_${X};\nuniform sampler2D uDetTex_${X};\nuniform vec4 uDetMask_${X};`);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
{
  float dv = dot(texture2D(uDetTex_${X}, vDetUv_${X}), uDetMask_${X}) / ${mean.toFixed(4)};
  float dk = ${str.toFixed(3)} * (1.0 - clamp(uVjSnowD, 0.0, 1.0) * smoothstep(0.35, 0.8, vVjUp));
  diffuseColor.rgb *= mix(1.0, dv, dk);
}`);
  });
}
