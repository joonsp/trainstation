import * as THREE from 'three';

/**
 * COMPOSABLE onBeforeCompile (v2). Several features patch the same material (wind, detail textures, snow caps,
 * dithered fades, a system's own weathering). Never assign `material.onBeforeCompile` directly on a material that
 * anyone else may patch — call `chain(mat, key, injector)` instead. chain() wraps an existing onBeforeCompile /
 * customProgramCacheKey if one was set before the first chain() call, is idempotent per key, and concatenates
 * the keys into customProgramCacheKey so every distinct combination gets its own program.
 */
export type Injector = (sh: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) => void;

interface ChainState { keys: string[]; injs: Injector[]; baseObc: Injector | null; baseKey: (() => string) | null }

const DEFAULT_OBC = THREE.Material.prototype.onBeforeCompile;
const DEFAULT_KEY = THREE.Material.prototype.customProgramCacheKey;
// state lives in a WeakMap (NOT userData: Material.clone JSON-copies userData and drops functions)
const STATE = new WeakMap<THREE.Material, ChainState>();

export function chain(mat: THREE.Material, key: string, inj: Injector): void {
  let c = STATE.get(mat);
  if (!c) {
    const st: ChainState = {
      keys: [], injs: [],
      baseObc: mat.onBeforeCompile !== DEFAULT_OBC ? mat.onBeforeCompile.bind(mat) : null,
      baseKey: mat.customProgramCacheKey !== DEFAULT_KEY ? mat.customProgramCacheKey.bind(mat) : null,
    };
    c = st;
    STATE.set(mat, st);
    mat.onBeforeCompile = (sh, r) => { st.baseObc?.(sh, r); for (const f of st.injs) f(sh, r); };
    mat.customProgramCacheKey = () => (st.baseKey ? st.baseKey() : '') + '|vj:' + st.keys.join(',');
  }
  if (c.keys.includes(key)) return;
  c.keys.push(key);
  c.injs.push(inj);
  mat.needsUpdate = true;
}

/** true if `key` has already been chained onto mat */
export function hasChain(mat: THREE.Material, key: string): boolean {
  return !!STATE.get(mat)?.keys.includes(key);
}

/**
 * Material.clone() does NOT carry onBeforeCompile patches. Use this instead of .clone() on any material that
 * may have been chained (all shared core materials are): it clones and re-applies every chained injector.
 */
export function cloneWithChain<T extends THREE.Material>(mat: T): T {
  const c = mat.clone() as T;
  const st = STATE.get(mat);
  if (st) {
    if (st.baseObc) c.onBeforeCompile = st.baseObc;
    if (st.baseKey) c.customProgramCacheKey = st.baseKey;
    st.keys.forEach((k, i) => chain(c, k, st.injs[i]));
  }
  return c;
}

const warned = new Set<string>();
/** insert `code` after (or before / replacing) the first occurrence of `anchor` in `src`; warns once if missing */
export function inject(src: string, anchor: string, code: string, where: 'after' | 'before' | 'replace' = 'after'): string {
  const i = src.indexOf(anchor);
  if (i < 0) {
    if (!warned.has(anchor)) { warned.add(anchor); console.warn(`[shaderMods] anchor not found: ${anchor}`); }
    return src;
  }
  if (where === 'replace') return src.slice(0, i) + code + src.slice(i + anchor.length);
  if (where === 'before') return src.slice(0, i) + code + '\n' + src.slice(i);
  return src.slice(0, i + anchor.length) + '\n' + code + src.slice(i + anchor.length);
}

/** GLSL for the model(×instance) matrix, usable after #include <begin_vertex> */
export const GLSL_MODEL_MATRIX = /* glsl */ `
#ifdef USE_INSTANCING
  mat4 vjModel = modelMatrix * instanceMatrix;
#else
  mat4 vjModel = modelMatrix;
#endif
`;

/**
 * Shared "up-facing" varying (world normal .y) used by snow caps and detail textures.
 * Idempotent: every injector that needs vVjUp calls addUpVarying(sh) first.
 */
export function addUpVarying(sh: THREE.WebGLProgramParametersWithUniforms): void {
  if (sh.vertexShader.includes('vVjUp')) return;
  sh.vertexShader = inject(sh.vertexShader, '#include <common>', 'varying float vVjUp;');
  sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', `
{
  vec3 vjN = length(objectNormal) > 0.01 ? objectNormal : vec3(0.0, 1.0, 0.0);
#ifdef USE_INSTANCING
  vjN = mat3(instanceMatrix) * vjN;
#endif
  vVjUp = normalize(mat3(modelMatrix) * vjN).y;
}`);
  sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'varying float vVjUp;');
}

/**
 * SNOW CAPS: whitens faces whose world normal points up, by the shared snow uniform (ctx.mats.uniforms.uSnow,
 * driven by atmosphere through mats.setSnow). Walls stay brick while copings, sills, benches, roofs go white.
 * `k` scales the effect (default 1).
 */
export function withSnowCap(mat: THREE.Material, uSnow: { value: number }, k = 1): void {
  chain(mat, `snowcap${k}`, (sh) => {
    sh.uniforms.uVjSnow = uSnow;
    addUpVarying(sh);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'uniform float uVjSnow;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), clamp(uVjSnow * ${k.toFixed(2)}, 0.0, 1.0) * smoothstep(0.35, 0.8, vVjUp));`);
  });
}

/**
 * DITHERED FADE for opaque meshes (occluders the camera sees through, fade-through-door). 4×4 Bayer discard,
 * so no sorting or transparency. uniform.value 1 = solid, 0 = gone. Share one uniform per group.
 */
export function withDitherFade(mat: THREE.Material, uniform: { value: number }): void {
  chain(mat, 'dither', (sh) => {
    sh.uniforms.uVjFade = uniform;
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', `
uniform float uVjFade;
float vjBayer(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  float i = q.x + q.y * 4.0;
  // 4x4 Bayer matrix, flattened
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[int(i)] + 0.5) / 16.0;
}`);
    sh.fragmentShader = inject(sh.fragmentShader, 'void main() {', 'if (uVjFade < 0.999 && vjBayer(gl_FragCoord.xy) > uVjFade) discard;');
  });
}
