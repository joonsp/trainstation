import * as THREE from 'three';
import type { Ctx } from './types';
import type { WindMode } from './quality';
import { chain, inject } from './shaderMods';

/**
 * GLOBAL WIND (v2) — one set of uniforms shared by every wind-animated material (trees, hedges, crops, reeds,
 * washing, flags, pub signs, chimney smoke, water ripples).
 *
 * - main.ts calls `ctx.wind.follow(atmosphere)` + `ctx.wind.tick(dt)` ONCE per rendered frame with REAL dt, so
 *   foliage keeps moving while the sim is paused (like smoke). Atmosphere owns `AtmosphereAPI.wind` (m/s vector);
 *   gustiness comes from the weather (storm 1 … fog 0.1). Atmosphere may call `ctx.wind.set()` to override.
 * - Phases are integrated (never jump when the wind changes); strength/direction are eased.
 * - `applyWind(ctx, material, opts)` patches a material (chains with other patches) and returns the matching
 *   depth material for `mesh.customDepthMaterial` (or null when wind shadows are off / the mode is disabled).
 * - CPU code that needs the wind (windmill rpm, smoke drift, boats, kites, audio) uses `ctx.wind.sample(x, z)`
 *   — same gust field as the shader.
 */
export interface WindUniforms {
  uWindTime: { value: number };
  uWindDir: { value: THREE.Vector2 };
  /** 0..1 (≈ m/s / 12, eased) */
  uWindStr: { value: number };
  uGustPhase: { value: number };
  uGustAmt: { value: number };
}

export interface WindSample { dir: THREE.Vector2; strength: number; gust: number }

export class Wind {
  readonly uniforms: WindUniforms = {
    uWindTime: { value: 0 }, uWindDir: { value: new THREE.Vector2(1, 0) }, uWindStr: { value: 0.3 },
    uGustPhase: { value: 0 }, uGustAmt: { value: 0.4 },
  };
  /** eased wind speed, m/s */
  speed = 3.5;
  private tDir = new THREE.Vector2(1, 0);
  private tSpeed = 3.5;
  private tGust = 0.4;
  private overrideUntil = 0;
  private t = 0;

  /** target wind (m/s vector in world xz) and gustiness 0..1; eased internally */
  set(windMS: THREE.Vector2, gustiness: number): void {
    const l = windMS.length();
    if (l > 1e-3) this.tDir.copy(windMS).multiplyScalar(1 / l);
    this.tSpeed = l;
    this.tGust = THREE.MathUtils.clamp(gustiness, 0, 1);
    this.overrideUntil = this.t + 1.5;
  }

  /** main.ts: follow atmosphere's wind unless someone called set() in the last 1.5 s */
  follow(atm: { wind?: THREE.Vector2; weather?: string; rain?: number; snow?: number; fog?: number } | undefined): void {
    if (!atm?.wind || this.t < this.overrideUntil) return;
    const g = atm.weather === 'storm' ? 1 : atm.weather === 'rain' ? 0.65 : atm.weather === 'snow' ? 0.5 : atm.weather === 'fog' ? 0.1 : atm.weather === 'overcast' ? 0.45 : 0.35;
    const l = atm.wind.length();
    if (l > 1e-3) this.tDir.copy(atm.wind).multiplyScalar(1 / l);
    this.tSpeed = l;
    this.tGust = g;
  }

  /** once per rendered frame, real dt */
  tick(dt: number): void {
    this.t += dt;
    const u = this.uniforms;
    const k = 1 - Math.exp(-dt * 0.5);
    this.speed += (this.tSpeed - this.speed) * k;
    u.uGustAmt.value += (this.tGust - u.uGustAmt.value) * k;
    // shortest-arc direction ease
    const d = u.uWindDir.value;
    const a0 = Math.atan2(d.y, d.x), a1 = Math.atan2(this.tDir.y, this.tDir.x);
    let da = a1 - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    const a = a0 + da * Math.min(1, dt * 0.3);
    d.set(Math.cos(a), Math.sin(a));
    const str = THREE.MathUtils.clamp(this.speed / 12, 0, 1);
    u.uWindStr.value = str;
    u.uWindTime.value += dt * (0.6 + 1.8 * str);
    u.uGustPhase.value += dt * (4 + 10 * str);
  }

  /** CPU gust field, identical to the shader's vjGust */
  sample(x: number, z: number, out: WindSample = { dir: new THREE.Vector2(), strength: 0, gust: 0 }): WindSample {
    const u = this.uniforms, dir = u.uWindDir.value;
    const s = (x * dir.x + z * dir.y) * 0.045 - u.uGustPhase.value * 0.045;
    let w = 0.5 + 0.5 * Math.sin(s);
    w *= 0.65 + 0.35 * Math.sin((x * -dir.y + z * dir.x) * 0.031 + s * 0.37);
    out.dir.copy(dir);
    out.gust = w * w * u.uGustAmt.value;
    out.strength = u.uWindStr.value * (0.35 + 0.65 * out.gust);
    return out;
  }
}

export interface WindOpts {
  mode: WindMode;
  /** metres of sway at full weight & strength (defaults: tree .35, foliage .08, crop .25, grass .12, cloth .25, flag .45, smoke 1.5, water 0) */
  amp?: number;
  /**
   * how much each vertex sways:
   *  'localY' = clamp(position.y / height) (unit instanced geometry: trees, reeds);
   *  'attr'   = float attribute `aWind` 0..1 baked by the builder (merged meshes: hedges, crops);
   *  'uvX'    = uv.x (cloth / flags: 0 at the attached edge)
   */
  weight?: 'localY' | 'attr' | 'uvX';
  /** for 'localY' (metres at which weight reaches 1) */
  height?: number;
  /** 'object' = gust/phase sampled at the instance/object origin (rigid sway); 'vertex' = per vertex (waves through crops) */
  pivot?: 'object' | 'vertex';
  /** phase speed multiplier (default 1) */
  freq?: number;
}

const DEF_AMP: Record<WindMode, number> = { tree: 0.35, foliage: 0.08, crop: 0.25, grass: 0.12, cloth: 0.25, flag: 0.45, smoke: 1.5, water: 0 };

const PARS = /* glsl */ `
uniform float uWindTime, uWindStr, uGustPhase, uGustAmt;
uniform vec2 uWindDir;
varying float vWindGust;
float vjGust(vec2 xz) {
  float s = dot(xz, uWindDir) * 0.045 - uGustPhase * 0.045;
  float w = 0.5 + 0.5 * sin(s);
  w *= 0.65 + 0.35 * sin(dot(xz, vec2(-uWindDir.y, uWindDir.x)) * 0.031 + s * 0.37);
  return w * w * uGustAmt;
}`;

function body(o: Required<WindOpts>): string {
  const weight = o.weight === 'attr' ? 'aWind' : o.weight === 'uvX' ? 'uv.x' : `clamp(position.y / ${o.height.toFixed(3)}, 0.0, 1.0)`;
  const exp = o.mode === 'tree' ? '1.5' : '1.0';
  const cloth = o.mode === 'cloth' || o.mode === 'flag';
  return /* glsl */ `
{
#ifdef USE_INSTANCING
  mat4 vjM = modelMatrix * instanceMatrix;
#else
  mat4 vjM = modelMatrix;
#endif
  vec3 vjP = (vjM * vec4(${o.pivot === 'object' ? 'vec3(0.0)' : 'position'}, 1.0)).xyz;
  float vjW = ${weight};
  float g = vjGust(vjP.xz);
  float ph = uWindTime * ${o.freq.toFixed(3)} + dot(vjP.xz, vec2(0.13, 0.17));
  float sw = uWindStr * (0.35 + 0.65 * g);
  vec2 off = uWindDir * sw * (0.55 + 0.45 * sin(ph)) + vec2(sin(ph * 1.7), cos(ph * 1.3)) * 0.12 * sw;
  vec3 wOff = vec3(off.x, -0.2 * length(off), off.y) * ${o.amp.toFixed(3)} * pow(max(vjW, 0.0), ${exp});
  ${cloth ? `wOff += normalize(vec3(-uWindDir.y, 0.0, uWindDir.x)) * sin(uv.x * 9.0 - uWindTime * 6.0) * 0.25 * ${o.amp.toFixed(3)} * vjW * (0.3 + sw);` : ''}
  transformed += inverse(mat3(vjM)) * wOff;
  vWindGust = g * uWindStr;
}`;
}

function patch(sh: THREE.WebGLProgramParametersWithUniforms, u: WindUniforms, o: Required<WindOpts>, tint: boolean) {
  Object.assign(sh.uniforms, u);
  sh.vertexShader = inject(sh.vertexShader, '#include <common>', PARS + (o.weight === 'attr' ? '\nattribute float aWind;' : ''));
  sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', body(o));
  if (tint) {
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'varying float vWindGust;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', 'diffuseColor.rgb *= 1.0 + 0.2 * vWindGust;');
  }
}

/**
 * Patch `mat` with wind sway. Returns a MeshDepthMaterial carrying the same sway for `mesh.customDepthMaterial`
 * (null when the tier disables wind shadows or this mode). Crops/grass also get the gust sheen in the fragment.
 * Materials patched with different opts must be different material instances.
 */
export function applyWind(ctx: Ctx, mat: THREE.Material, opts: WindOpts): THREE.MeshDepthMaterial | null {
  const knobs = ctx.quality.knobs;
  if (!knobs.wind[opts.mode]) return null;
  const o: Required<WindOpts> = {
    mode: opts.mode, amp: opts.amp ?? DEF_AMP[opts.mode], weight: opts.weight ?? 'localY', height: opts.height ?? 1,
    pivot: opts.pivot ?? (opts.mode === 'tree' ? 'object' : 'vertex'), freq: opts.freq ?? 1,
  };
  const key = `wind:${o.mode}:${o.amp}:${o.weight}:${o.height}:${o.pivot}:${o.freq}`;
  const tint = o.mode === 'crop' || o.mode === 'grass';
  const u = ctx.wind.uniforms;
  chain(mat, key, (sh) => patch(sh, u, o, tint));
  if (!knobs.windShadows) return null;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  chain(depth, key, (sh) => patch(sh, u, o, false));
  return depth;
}
