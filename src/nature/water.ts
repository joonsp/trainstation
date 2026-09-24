import * as THREE from 'three';
import type { Ctx } from '../core/types';
import { chain, inject } from '../core/shaderMods';
import { clamp01, smooth } from './util';

/**
 * RIVER WATER SURFACE (+ the Coldharbour duck pond and the lock chamber water).
 * One opaque MeshStandardMaterial ribbon (1 draw), all motion in the shader:
 *  - deep/shallow tint by distance to the bank (aEdge), flow streaks (every tier)
 *  - ripple normals from ctx.tex.detailB (blue channel), scrolling downstream + wind (knobs.water.ripples 1|2)
 *  - sky-tinted fresnel-lite reflection (atmosphere.skyColor), sun/moon glints from the key light specular
 *  - lamp streak reflections (knobs.water.lampStreaks, positions from world.lamps())
 *  - rain rings (knobs.water.rainRings), splash rings (fish, oars, ducks, boat wakes: ring buffer)
 *  - ice margins → full freeze (atmosphere.iceAmount), snow lying on the ice
 * Plus optional river-mist cards (knobs.water.mist) at dawn / in fog (1 extra transparent draw, hidden otherwise).
 */
export interface Water {
  mesh: THREE.Mesh;
  mist: THREE.Mesh | null;
  /** lock chamber level 0 (−3.5) .. 1 (−3.0) */
  lockLevel: number;
  ice: number;
  surfaceY(x: number, z: number): number;
  /** surface y at river s (no lock check) */
  riverY(s: number): number;
  flowSpeed(s: number): number;
  /** inside the Coldharbour duck pond's water */
  onPond(x: number, z: number): boolean;
  inLock(s: number, lat: number): boolean;
  splash(x: number, z: number, amp: number): void;
  update(dt: number, time: number): void;
}

const MAX_LAMPS = 8;

export function createWater(ctx: Ctx, uTime: { value: number }): Water {
  const L = ctx.layout, R = L.river, K = ctx.quality.knobs;
  const ripples = K.water.ripples, rainRings = K.water.rainRings, nLamps = Math.min(MAX_LAMPS, K.water.lampStreaks);
  const nSplash = ctx.quality.tier === 'low' ? 6 : 12;
  const lock = R.lock;
  const weirS = R.weir.s;
  const reach = (id: string) => R.reaches.find((r) => r.id === id);
  const pool = reach('millpool');
  const flowSpeed = (s: number) => {
    let f = 0.42;
    if (pool) f = f - 0.26 * smooth(pool.s0 - 30, pool.s0, s) * (1 - smooth(weirS - 4, weirS, s));
    if (s > weirS) f = 0.55;
    return f;
  };

  // ── geometry ──
  const pos: number[] = [], uv: number[] = [], edge: number[] = [], flow: number[] = [], dir: number[] = [], lk: number[] = [];
  const idx: number[] = [];
  const ACROSS = 4;
  const rows: number[] = [];
  for (let s = 0; s < R.length; s += 3) {
    if (s < weirS && s + 3 > weirS) { rows.push(s, weirS - 0.08, weirS + 0.08); continue; }
    rows.push(s);
  }
  rows.push(R.length);
  const tg = new THREE.Vector3(), p = new THREE.Vector3();
  let base = 0;
  for (let r = 0; r < rows.length; r++) {
    const s = rows[r];
    const hw = R.widthAt(s) / 2;
    const wy = R.waterYAt(s);
    R.tangentAt(s, tg);
    for (let i = 0; i <= ACROSS; i++) {
      const u = i / ACROSS * 2 - 1;
      const lat = u * (hw + 1.1);
      R.pointAt(s, lat, wy, p);
      pos.push(p.x, wy, p.z);
      uv.push(lat, s);
      edge.push(Math.abs(lat) / hw);
      flow.push(flowSpeed(s));
      dir.push(tg.x, tg.z);
      lk.push(0);
    }
    if (r > 0) {
      const a0 = base - (ACROSS + 1), b0 = base;
      for (let i = 0; i < ACROSS; i++) idx.push(a0 + i, a0 + i + 1, b0 + i, a0 + i + 1, b0 + i + 1, b0 + i);
    }
    base += ACROSS + 1;
  }
  // lock chamber water (y driven by uLock)
  {
    const n = 10;
    const start = base;
    for (let k = 0; k <= n; k++) {
      const s = lock.s0 + (lock.s1 - lock.s0) * (k / n);
      R.tangentAt(s, tg);
      for (const side of [-1, 1]) {
        const lat = lock.lateral + side * (lock.width / 2 - 0.05);
        R.pointAt(s, lat, -3.0, p);
        pos.push(p.x, -3.0, p.z);
        uv.push(lat, s); edge.push(0.4); flow.push(0); dir.push(tg.x, tg.z); lk.push(1);
      }
      if (k > 0) { const a = start + (k - 1) * 2, b = start + k * 2; idx.push(a, a + 1, b, a + 1, b + 1, b); }
    }
    base += (n + 1) * 2;
  }
  // Coldharbour pond (flat ellipse on the ground; world leaves the area unpadded)
  const pondArea = L.towns.find((t) => t.id === 'coldharbour')?.areas.find((a) => a.kind === 'pond');
  let pondY = 0;
  const PSEG = 18;
  /** per-angle radius factor: the pond sits flat at the pad height and shrinks where the ground rises above it */
  const pondF = new Float32Array(PSEG);
  const pondLocal = (x: number, z: number) => {
    const A = pondArea!, cs = Math.cos(A.yaw), sn = Math.sin(A.yaw);
    const dx = x - A.center.x, dz = z - A.center.z;
    return { lx: dx * cs - dz * sn, lz: dx * sn + dz * cs };
  };
  const onPond = (x: number, z: number): boolean => {
    if (!pondArea) return false;
    const rx = pondArea.size.x / 2, rz = pondArea.size.z / 2;
    const { lx, lz } = pondLocal(x, z);
    const r = Math.hypot(lx / rx, lz / rz);
    if (r > 1.1) return false;
    let a = Math.atan2(lz / rz, lx / rx); if (a < 0) a += Math.PI * 2;
    const u = (a / (Math.PI * 2)) * PSEG, k0 = Math.floor(u) % PSEG, k1 = (k0 + 1) % PSEG, f = u - Math.floor(u);
    return r < (pondF[k0] * (1 - f) + pondF[k1] * f) * 0.98;
  };
  if (pondArea) {
    const c = pondArea.center, rx = pondArea.size.x / 2, rz = pondArea.size.z / 2, yaw = pondArea.yaw;
    const gy = c.y - 0.06; // core pads the pond flat with a 0.3 m bowl; area.center.y is the rim
    pondY = gy;
    const RINGS = 3;
    const start = base;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const wob = (a: number) => 1 + 0.08 * Math.sin(a * 3 + 1.3) + 0.05 * Math.sin(a * 5);
    for (let k = 0; k < PSEG; k++) {
      const a = (k / PSEG) * Math.PI * 2;
      let f = 1;
      for (; f > 0.35; f -= 0.05) {
        const lx = Math.cos(a) * rx * f * wob(a), lz = Math.sin(a) * rz * f * wob(a);
        const h = L.heightAt(c.x + lx * cs + lz * sn, c.z - lx * sn + lz * cs);
        if (h < gy - 0.03 && h > gy - 0.3) break;
      }
      pondF[k] = f * wob(a);
    }
    pos.push(c.x, gy, c.z); uv.push(1000, 0); edge.push(0); flow.push(0); dir.push(0, 1); lk.push(0);
    for (let r = 1; r <= RINGS; r++) {
      const fr = r / RINGS;
      for (let k = 0; k < PSEG; k++) {
        const a = (k / PSEG) * Math.PI * 2;
        const lx = Math.cos(a) * rx * fr * pondF[k], lz = Math.sin(a) * rz * fr * pondF[k];
        const x = c.x + lx * cs + lz * sn, z = c.z - lx * sn + lz * cs;
        pos.push(x, gy, z); uv.push(1000 - (x - c.x), z - c.z); edge.push(fr * 1.02); flow.push(0); dir.push(0, 1); lk.push(0);
      }
    }
    for (let k = 0; k < PSEG; k++) idx.push(start, start + 1 + ((k + 1) % PSEG), start + 1 + k);
    for (let r = 1; r < RINGS; r++) {
      const a0 = start + 1 + (r - 1) * PSEG, b0 = start + 1 + r * PSEG;
      for (let k = 0; k < PSEG; k++) {
        const k1 = (k + 1) % PSEG;
        idx.push(a0 + k, a0 + k1, b0 + k, a0 + k1, b0 + k1, b0 + k);
      }
    }
    base += 1 + PSEG * RINGS;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 1));
  geo.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 2));
  geo.setAttribute('aLock', new THREE.Float32BufferAttribute(lk, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  // ── material ──
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.16, metalness: 0.0 });
  mat.name = 'nature:water';
  const U = {
    uNatTime: uTime,
    uLock: { value: 1 },
    uLockRect: { value: new THREE.Vector4(lock.s0, lock.s1, lock.lateral - lock.width / 2, lock.lateral + lock.width / 2) },
    uIce: { value: 0 },
    uSnowW: ctx.mats.uniforms.uSnow,
    uRain: { value: 0 },
    uSky: { value: new THREE.Color(0x9ec3d6) },
    uWindW: ctx.wind.uniforms.uWindDir,
    uWindS: ctx.wind.uniforms.uWindStr,
    uRip: { value: ctx.tex.detailB },
    uLamps: { value: Array.from({ length: Math.max(1, nLamps) }, () => new THREE.Vector4()) },
    uCamF: { value: new THREE.Vector3(0, -1, 0) },
    uSplash: { value: Array.from({ length: nSplash }, () => new THREE.Vector4(0, 0, -100, 0)) },
    uNightW: ctx.mats.uniforms.uNight,
  };
  const FRAG_PARS = /* glsl */ `
uniform float uNatTime, uLock, uIce, uSnowW, uRain, uWindS, uNightW;
uniform vec4 uLockRect;
uniform vec3 uSky, uCamF;
uniform vec2 uWindW;
uniform sampler2D uRip;
uniform vec4 uLamps[${Math.max(1, nLamps)}];
uniform vec4 uSplash[${nSplash}];
varying vec2 vWUv; varying float vWEdge; varying float vWFlow; varying vec2 vWDir; varying float vWLock; varying vec3 vWPos;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;
  chain(mat, `nature:water:${ripples}:${rainRings ? 1 : 0}:${nLamps}:${nSplash}`, (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = inject(sh.vertexShader, '#include <common>', `
attribute float aEdge; attribute float aFlow; attribute vec2 aDir; attribute float aLock;
uniform float uLock;
varying vec2 vWUv; varying float vWEdge; varying float vWFlow; varying vec2 vWDir; varying float vWLock; varying vec3 vWPos;`);
    sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', `
transformed.y += aLock * (mix(-3.5, -3.0, uLock) + 3.0 + 0.02);
vWUv = uv; vWEdge = aEdge; vWFlow = aFlow; vWDir = aDir; vWLock = aLock;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', FRAG_PARS);
    sh.fragmentShader = inject(sh.fragmentShader, 'void main() {', `
float wIceM = 0.0; float wRefl = 1.0; vec3 wNrm = vec3(0.0, 1.0, 0.0); float wRipV = 0.5; vec3 wEmis = vec3(0.0);`, 'after');
    // colour + all surface maths (world-space normal wNrm)
    sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
{
  if (vWLock < 0.5 && vWUv.y > uLockRect.x && vWUv.y < uLockRect.y && vWUv.x > uLockRect.z && vWUv.x < uLockRect.w) discard;
  vec2 side = vec2(-vWDir.y, vWDir.x);
  float t = uNatTime;
  // along-flow coordinates (metres), drifting downstream
  vec2 fuv = vec2(vWUv.x, vWUv.y - t * vWFlow);
  // cheap ALU swell (every tier)
  float w1 = sin(fuv.y * 0.9 + sin(fuv.x * 0.7 + t * 0.4) * 1.3 + t * 0.6);
  float w2 = sin(dot(vWPos.xz, vec2(0.41, -0.57)) * 1.7 - t * 1.3 * (0.6 + uWindS));
  vec2 g = vec2(0.05 * cos(fuv.x * 0.7) * w1, 0.07 * w1) + (0.03 + 0.07 * uWindS) * vec2(w2 * 0.6, w2);
${ripples >= 1 ? `
  {
    float e = 0.02;
    vec2 q = fuv / 6.0 + uWindW * t * 0.02;
    float h0 = texture2D(uRip, q).b, hx = texture2D(uRip, q + vec2(e, 0.0)).b, hz = texture2D(uRip, q + vec2(0.0, e)).b;
    g += vec2(hx - h0, hz - h0) * (2.2 + 3.0 * uWindS);
    wRipV = h0;
  }` : ''}
${ripples >= 2 ? `
  {
    float e = 0.02;
    vec2 q = vWPos.xz / 2.7 + uWindW * t * 0.09;
    float h0 = texture2D(uRip, q).b, hx = texture2D(uRip, q + vec2(e, 0.0)).b, hz = texture2D(uRip, q + vec2(0.0, e)).b;
    g += vec2(hx - h0, hz - h0) * (0.8 + 3.5 * uWindS);
  }` : ''}
  // gradient in (lateral, downstream) → world xz
  vec2 gw = g.x * side + g.y * vWDir;
${rainRings ? `
  if (uRain > 0.02) {
    for (int k = 0; k < 2; k++) {
      float sc = k == 0 ? 1.1 : 0.73;
      vec2 cg = vWPos.xz / sc + float(k) * 17.3;
      vec2 id = floor(cg); vec2 f = fract(cg) - 0.5;
      float h = wHash(id + float(k) * 3.1);
      float ph = fract(t * 1.1 + h);
      vec2 o = (vec2(wHash(id + 1.7), wHash(id + 4.3)) - 0.5) * 0.5;
      vec2 dv = f - o; float r = length(dv);
      float ring = exp(-pow((r - ph * 0.46) * 22.0, 2.0)) * (1.0 - ph) * step(h, uRain * 0.9);
      gw += normalize(dv + 1e-4) * ring * 0.9;
      wEmis += vec3(0.05) * ring * uRain;
    }
  }` : ''}
  // splash rings (fish, oars, ducks, wakes)
  for (int k = 0; k < ${nSplash}; k++) {
    vec4 sp = uSplash[k];
    float age = t - sp.z;
    if (age < 0.0 || age > 3.0) continue;
    vec2 dv = vWPos.xz - sp.xy; float d = length(dv);
    float r = 0.15 + age * 1.1;
    float fade = sp.w * (1.0 - age / 3.0);
    float ring = exp(-pow((d - r) * 5.0, 2.0)) + 0.6 * exp(-pow((d - r * 0.55) * 6.0, 2.0));
    gw += normalize(dv + 1e-4) * ring * fade * 0.9;
    wEmis += vec3(0.06) * ring * fade;
  }
  // ice: margins first (aEdge ~1 at the bank), full cover at 1
  float crack = abs(fract(dot(vWPos.xz, vec2(0.21, 0.13)) + 0.3 * sin(vWPos.x * 0.37)) - 0.5);
  float iceN = 0.12 * sin(vWPos.x * 0.9 + sin(vWPos.z * 0.7)) + 0.08 * sin(vWPos.z * 1.7);
  float margin = clamp(vWEdge, 0.0, 1.0);
  wIceM = uIce < 0.01 ? 0.0 : smoothstep(0.0, 0.08, uIce * 1.15 - (1.0 - margin) - iceN * (1.0 - uIce) * 0.5);
  if (uIce > 0.98) wIceM = 1.0;
  gw *= (1.0 - wIceM);
  wNrm = normalize(vec3(-gw.x, 1.0, -gw.y));
  // colour: deep centre → shallow margins, flow streaks
  vec3 deep = vec3(0.13, 0.22, 0.27), shallow = vec3(0.30, 0.38, 0.33);
  vec3 wc = mix(deep, shallow, smoothstep(0.35, 1.05, vWEdge));
  float streak = sin(fuv.y * 0.55 + sin(fuv.x * 1.1 + fuv.y * 0.13) * 2.0) * 0.5 + 0.5;
  wc *= 0.93 + 0.1 * streak * (1.0 - smoothstep(0.7, 1.0, vWEdge)) + 0.08 * (wRipV - 0.5);
  // ice & snow on it
  // snow drifts along the banks; mid-channel it is blown / swept thinner (skating lanes), so the frozen river
  // still reads as ice under snow instead of vanishing into the white meadows
  float drift = smoothstep(0.45, 0.95, margin) + 0.35 * smoothstep(0.1, 0.6, 0.5 + 0.5 * sin(vWPos.x * 0.23 + sin(vWPos.z * 0.19) * 2.0));
  float snowOn = clamp(uSnowW * 1.2, 0.0, 1.0) * (0.6 + 0.4 * wIceM) * clamp(0.3 + 0.7 * drift, 0.0, 1.0);
  vec3 iceC = mix(vec3(0.62, 0.75, 0.82), vec3(0.93, 0.95, 0.98), snowOn);
  iceC *= 1.0 - 0.18 * smoothstep(0.03, 0.0, crack) * (1.0 - snowOn);
  diffuseColor.rgb = mix(wc, iceC, wIceM);
  wRefl = 1.0 - wIceM * 0.85;
}`);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <roughnessmap_fragment>', 'roughnessFactor = mix(roughnessFactor, 0.55, wIceM);');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(wNrm, 0.0)).xyz);');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <emissivemap_fragment>', `
{
  vec3 Vv = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  float ndv = clamp(dot(normal, Vv), 0.0, 1.0);
  float fres = 0.22 + 0.78 * pow(1.0 - ndv, 2.5);
  totalEmissiveRadiance += uSky * fres * 0.42 * wRefl;
${nLamps > 0 ? `
  // lamp streaks: reflection of lamp L seen where the camera ray through its mirror image meets the water
  vec2 a = normalize(uCamF.xz + 1e-5); vec2 pr = vec2(-a.y, a.x);
  for (int k = 0; k < ${nLamps}; k++) {
    vec4 lp = uLamps[k];
    if (lp.w <= 0.001) continue;
    float h = max(0.5, lp.y - vWPos.y);
    vec2 Q = lp.xz + uCamF.xz * (h / min(-0.2, uCamF.y));
    vec2 rel = vWPos.xz - Q;
    float al = dot(rel, a), ac = dot(rel, pr);
    float len = 1.2 + h * 0.55;
    float s = exp(-ac * ac / 0.09 - al * al / (len * len)) * (0.55 + 0.9 * wRipV);
    totalEmissiveRadiance += vec3(1.0, 0.72, 0.38) * s * lp.w * 1.8 * wRefl;
  }` : ''}
  totalEmissiveRadiance += wEmis * (1.0 - uNightW * 0.7);
}`);
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'nature:water';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;

  // ── mist cards ──
  let mist: THREE.Mesh | null = null;
  let mistMat: THREE.MeshBasicMaterial | null = null;
  if (K.water.mist) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g2 = cv.getContext('2d')!;
    g2.clearRect(0, 0, 128, 128);
    for (let i = 0; i < 26; i++) {
      const x = (i * 37.7) % 128, y = (i * 71.3) % 128, r = 18 + ((i * 13) % 22);
      for (const ox of [-128, 0, 128]) for (const oy of [-128, 0, 128]) {
        const gr = g2.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        gr.addColorStop(0, 'rgba(255,255,255,0.35)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g2.fillStyle = gr;
        g2.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const mp: number[] = [], mu: number[] = [], mi: number[] = [];
    let mb = 0;
    for (let s = 0; s < R.length; s += 4) {
      const hw = R.widthAt(s) / 2 + 7;
      const wy = R.waterYAt(s);
      for (const [k, lat] of [[0, -hw], [1, 0], [2, hw]] as const) {
        R.pointAt(s, lat, 0, p);
        const y = wy + 0.5 + (k === 1 ? 0.25 : 0.7);
        mp.push(p.x, y, p.z);
        mu.push(k / 2, s / 26);
      }
      if (s > 0) { for (let k = 0; k < 2; k++) { const a = mb - 3 + k, b = mb + k; mi.push(a, a + 1, b, a + 1, b + 1, b); } }
      mb += 3;
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    mg.setAttribute('uv', new THREE.Float32BufferAttribute(mu, 2));
    mg.setIndex(mi);
    mg.computeBoundingSphere();
    mistMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, color: 0xffffff });
    mistMat.name = 'nature:mist';
    // soften the card edges across the valley
    chain(mistMat, 'nature:mistEdge', (sh) => {
      sh.fragmentShader = inject(sh.fragmentShader, '#include <map_fragment>', 'diffuseColor.a *= sin(3.14159 * clamp(vMapUv.x, 0.0, 1.0));');
    });
    mist = new THREE.Mesh(mg, mistMat);
    mist.name = 'nature:mist';
    mist.renderOrder = 5;
    mist.frustumCulled = false;
    mist.visible = false;
  }

  // ── lamps near the water (for streaks): candidates once, selection at 2 Hz, lit level per frame ──
  let lampCand: { i: number; x: number; y: number; z: number }[] | null = null;
  const lampSel = new Int32Array(Math.max(1, nLamps)).fill(-1);
  let lampTimer = 0;
  const camF = new THREE.Vector3();
  const selectLamps = () => {
    const W = ctx.reg.world;
    if (!W?.lamps) return;
    if (!lampCand) {
      lampCand = [];
      for (const l of W.lamps()) if (L.terrain.riverDist(l.pos.x, l.pos.z) < 24) lampCand.push({ i: l.index, x: l.pos.x, y: l.pos.y, z: l.pos.z });
    }
    const f = ctx.view.focus;
    lampSel.fill(-1);
    for (let k = 0; k < lampSel.length; k++) {
      let best = -1, bd = Infinity;
      for (let c = 0; c < lampCand.length; c++) {
        let taken = false;
        for (let j = 0; j < k; j++) if (lampSel[j] === c) taken = true;
        if (taken) continue;
        const l = lampCand[c];
        const d = Math.hypot(l.x - f.x, l.z - f.z);
        if (d < bd) { bd = d; best = c; }
      }
      lampSel[k] = best;
    }
  };

  let splashNext = 0;
  const water: Water = {
    mesh, mist, lockLevel: 1, ice: 0,
    riverY: (s) => R.waterYAt(s),
    onPond,
    flowSpeed,
    inLock(s, lat) { return s > lock.s0 && s < lock.s1 && Math.abs(lat - lock.lateral) < lock.width / 2; },
    surfaceY(x, z) {
      const n = R.nearest(p.set(x, 0, z));
      if (water.inLock(n.s, n.lat)) return THREE.MathUtils.lerp(-3.5, -3.0, water.lockLevel);
      if (onPond(x, z)) return pondY;
      return R.waterYAt(n.s);
    },
    splash(x, z, amp) {
      const v = U.uSplash.value[splashNext];
      v.set(x, z, uTime.value, amp);
      splashNext = (splashNext + 1) % nSplash;
    },
    update(dt) {
      const atm = ctx.reg.atmosphere;
      if (atm) {
        U.uSky.value.copy(atm.skyColor ?? U.uSky.value);
        U.uRain.value = clamp01(atm.rain ?? 0);
      }
      const iceOverride = ctx.params.raw.get('ice');
      const target = iceOverride !== null ? clamp01(Number(iceOverride) || 0) : clamp01(atm?.iceAmount ?? 0);
      water.ice += (target - water.ice) * Math.min(1, dt * 0.5);
      if (Math.abs(target - water.ice) < 0.002) water.ice = target;
      U.uIce.value = water.ice;
      U.uLock.value = water.lockLevel;
      // camera forward (world) for lamp streaks
      const cam = ctx.camera.current;
      if (cam) { cam.getWorldDirection(camF); U.uCamF.value.copy(camF); }
      if (nLamps > 0) {
        lampTimer -= dt;
        if (lampTimer <= 0) { lampTimer = 0.5; selectLamps(); }
        const W = ctx.reg.world;
        const arr = U.uLamps.value;
        for (let k = 0; k < arr.length; k++) {
          const c = lampSel[k];
          const l = c >= 0 && lampCand ? lampCand[c] : null;
          if (!l || !W) { arr[k].w = 0; continue; }
          const lit = W.lampLit ? W.lampLit(l.i) : W.lampsOn;
          arr[k].set(l.x, l.y + 3.4, l.z, lit);
        }
      }
      if (mist && mistMat && atm) {
        const m = Math.max(atm.dawnMist ?? 0, (atm.fog ?? 0) * 0.7);
        mistMat.opacity = 0.6 * m;
        mist.visible = mistMat.opacity > 0.01;
        const day = 1 - clamp01(atm.nightFactor ?? 0);
        mistMat.color.setRGB(0.25 + 0.75 * day, 0.27 + 0.73 * day, 0.32 + 0.68 * day);
        if (mistMat.map) mistMat.map.offset.set(0, -uTime.value * 0.004);
      }
    },
  };
  return water;
}
