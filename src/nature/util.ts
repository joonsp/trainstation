import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { InstancedRig } from '../core/rig';
import { chain } from '../core/shaderMods';

/** shared little helpers for the nature system (no allocations in hot paths) */

export const TAU = Math.PI * 2;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** wrap an angle to (−π, π] */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
/** ease angle a toward b by at most maxStep radians */
export function turnToward(a: number, b: number, maxStep: number): number {
  const d = wrapPi(b - a);
  return a + clamp(d, -maxStep, maxStep);
}
/** rotation.y yaw that faces local +x along world (dx, dz) */
export const yawOf = (dx: number, dz: number) => Math.atan2(-dz, dx);
/** forward unit vector (x, z) for a yaw */
export const fwdX = (yaw: number) => Math.cos(yaw);
export const fwdZ = (yaw: number) => -Math.sin(yaw);

/** deterministic hash 0..1 */
export function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** box geometry translated (and optionally rotated about its own centre: z then x then y) */
export function bx(w: number, h: number, d: number, x: number, y: number, z: number, rz = 0, rx = 0, ry = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rz) g.rotateZ(rz);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}
/** low-poly cylinder translated (axis y unless rotated) */
export function cyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, rz = 0, rx = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (rz) g.rotateZ(rz);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return g;
}

/** season-ish reading from the atmosphere (the diorama has no calendar): warm = summer life, cold = winter */
export function warmth(ctx: Ctx): number {
  const t = ctx.reg.atmosphere?.temperatureC ?? 12;
  return clamp01((t - 4) / 14);
}

/** 0..1 daylight (1 = full day) */
export function daylight(ctx: Ctx): number {
  return 1 - clamp01(ctx.reg.atmosphere?.nightFactor ?? 0);
}

/** reusable temporaries */
export const V1 = new THREE.Vector3();
export const V2 = new THREE.Vector3();
export const V3 = new THREE.Vector3();

/** uniforms shared by all nature shaders */
export interface NatureUniforms {
  uNatTime: { value: number };
  uNatNight: { value: number };
}

/**
 * Adds the shared nature uniforms to an InstancedRig's colour + depth materials (the rig GLSL declares them).
 * Also optional glow: rig GLSL may write `vNatGlow` (lantern parts) which lights up at night.
 */
export function rigUniforms(mesh: THREE.InstancedMesh, u: NatureUniforms, glow: boolean, chainFn: (m: THREE.Material, k: string, f: (sh: THREE.WebGLProgramParametersWithUniforms) => void) => void, inject: (src: string, anchor: string, code: string) => string): void {
  const mat = mesh.material as THREE.Material;
  chainFn(mat, 'natU', (sh) => {
    sh.uniforms.uNatTime = u.uNatTime;
    sh.uniforms.uNatNight = u.uNatNight;
    if (glow) {
      sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'varying float vNatGlow;\nuniform float uNatNight;');
      sh.fragmentShader = inject(sh.fragmentShader, '#include <emissivemap_fragment>', 'totalEmissiveRadiance += vec3(1.0, 0.72, 0.36) * vNatGlow * (0.15 + 2.4 * uNatNight);');
    }
  });
  if (mesh.customDepthMaterial) chainFn(mesh.customDepthMaterial, 'natU', (sh) => { sh.uniforms.uNatTime = u.uNatTime; sh.uniforms.uNatNight = u.uNatNight; });
}

/** per-instance seeds live in a uniform array (the rig already uses all 16 vertex attributes) */
export const NAT_SEED_VEC4 = 72;
/** GLSL: per-instance seed (stable per critter via Drawer) + shared time */
export const NAT_GLSL_COMMON = /* glsl */ `
uniform float uNatTime;
uniform float uNatNight;
uniform vec4 uNatSeeds[${NAT_SEED_VEC4}];
float natSeed() { int i = gl_InstanceID; vec4 v = uNatSeeds[i / 4]; int k = i - (i / 4) * 4; return k == 0 ? v.x : k == 1 ? v.y : k == 2 ? v.z : v.w; }
float natNoise(float x) { float i = floor(x), f = fract(x); float a = fract(sin(i * 91.7) * 4375.5), b = fract(sin((i + 1.0) * 91.7) * 4375.5); return mix(a, b, f * f * (3.0 - 2.0 * f)); }
`;

/**
 * Per-frame instance compaction for an InstancedRig: only on-screen instances are written (front of the buffers)
 * and mesh.count is trimmed, so hidden / off-screen / unused capacity costs nothing. Each drawn instance carries
 * its owner's stable seed (iSeed) so shader idle animation never jumps when the draw order changes.
 * Call begin() once per rendered frame, next() per visible instance, end() after all writers.
 */
export class Drawer {
  readonly rig: InstancedRig;
  private n = 0;
  private cap: number;
  private seeds = new Float32Array(NAT_SEED_VEC4 * 4);
  constructor(rig: InstancedRig) {
    this.rig = rig;
    this.cap = Math.min(rig.capacity, NAT_SEED_VEC4 * 4);
    const u = { value: this.seeds };
    chain(rig.mesh.material as THREE.Material, 'natSeeds', (sh) => { sh.uniforms.uNatSeeds = u; });
    if (rig.mesh.customDepthMaterial) chain(rig.mesh.customDepthMaterial, 'natSeeds', (sh) => { sh.uniforms.uNatSeeds = u; });
    rig.mesh.count = 0;
    rig.mesh.visible = false;
  }
  begin(): void { this.n = 0; }
  /** returns the draw index for this frame (−1 when full) */
  next(seed: number, cols: number[]): number {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.seeds[i] = seed;
    this.rig.setColors(i, cols);
    return i;
  }
  end(): void {
    this.rig.mesh.count = this.n;
    this.rig.mesh.visible = this.n > 0;
  }
}
