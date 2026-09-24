import * as THREE from 'three';
import type { Ctx } from '../core/types';
import * as P from '../core/palette';
import { chain, inject, withSnowCap } from '../core/shaderMods';
import { withDetail } from '../core/tex';
import { applyWind } from '../core/wind';
import { createClockDial, createSignAtlas, type SignAtlas } from './textures';

export interface WorldMats {
  /** vertex-coloured ground (snow/wet injected) */
  ground: THREE.MeshStandardMaterial;
  /** river valley ribbon (vertex coloured, drawn over the coarse ground grid with polygon offset) */
  bank: THREE.MeshStandardMaterial;
  /** field overlays: vertex tint + procedural rows along aRow + crop-wind gust sheen */
  field: THREE.MeshStandardMaterial;
  /** hedgerows (instanced unit blocks, 'foliage' wind by local height — applied in terrain.ts) */
  hedge: THREE.MeshStandardMaterial;
  /** garden shrubs / topiary on the flat station ground (height-weighted foliage wind) */
  shrub: THREE.MeshStandardMaterial;
  trunk: THREE.MeshStandardMaterial;
  roofTile: THREE.MeshStandardMaterial;
  thatch: THREE.MeshStandardMaterial;
  whitewash: THREE.MeshStandardMaterial;
  /** tarred weatherboarding (barns, boathouse, huts) */
  boards: THREE.MeshStandardMaterial;
  /** half-timber framing, doors, dark joinery */
  beams: THREE.MeshStandardMaterial;
  signalRed: THREE.MeshStandardMaterial;
  white: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  coal: THREE.MeshStandardMaterial;
  water: THREE.MeshStandardMaterial;
  /** vertex-coloured small props (flowers, headstones, stall awnings, painted doors, pub-sign boards) */
  paint: THREE.MeshStandardMaterial;
  signs: THREE.MeshStandardMaterial;
  dial: THREE.MeshStandardMaterial;
  /** lantern glass, emissive driven by world lampsOn */
  lantern: THREE.MeshStandardMaterial;
  hands: THREE.MeshStandardMaterial;
  setts: THREE.MeshStandardMaterial;
  /** paler stone courses laid through the forecourt setts */
  settsCourse: THREE.MeshStandardMaterial;
  /** metalled main road */
  road: THREE.MeshStandardMaterial;
  /** gravel lanes */
  lane: THREE.MeshStandardMaterial;
  /** worn earth tracks, footpaths */
  earth: THREE.MeshStandardMaterial;
  /** vertex-coloured ground overlays (road/lane/earth/towpath/cinder fold into this in the static batch) */
  overlay: THREE.MeshStandardMaterial;
  /** towpath gravel */
  towpath: THREE.MeshStandardMaterial;
  /** cobbled town streets / squares (setts detail) */
  street: THREE.MeshStandardMaterial;
  cinder: THREE.MeshStandardMaterial;
  /** forge / hearth glow (emissive, flickers) */
  forge: THREE.MeshStandardMaterial;
  /** weir foam (animated) */
  foam: THREE.MeshStandardMaterial;
  hay: THREE.MeshStandardMaterial;
  atlas: SignAtlas;
  /** call every frame; cheap (only uniform writes) */
  update(lampsOn: number, flicker: number, dt: number): void;
}

/**
 * Procedural roof courses: `course` m between courses (world y), `joint` m between joints along the eave (0 = none),
 * `depth` darkening of the drip line, `jitter` per-slate brightness variation.
 */
function roofCourses(mat: THREE.Material, uSnow: { value: number }, course: number, joint: number, depth: number, jitter: number): void {
  chain(mat, `vjRoof${course}_${joint}`, (sh) => {
    sh.vertexShader = inject(sh.vertexShader, '#include <common>', 'varying vec3 vRfW; varying vec3 vRfN;');
    sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', `
{
  vec3 rn = length(objectNormal) > 0.01 ? objectNormal : vec3(0.0, 1.0, 0.0);
#ifdef USE_INSTANCING
  vRfW = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
  vRfN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * rn);
#else
  vRfW = (modelMatrix * vec4(position, 1.0)).xyz;
  vRfN = normalize(mat3(modelMatrix) * rn);
#endif
}`);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', `varying vec3 vRfW; varying vec3 vRfN;
float vjRfHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
{
  float up = vRfN.y;
  float pitched = smoothstep(0.2, 0.4, up) * (1.0 - smoothstep(0.94, 0.99, up));
  float c = vRfW.y / ${course.toFixed(3)};
  float w = fwidth(c);
  float fade = 1.0 - smoothstep(0.3, 0.6, w);
  if (pitched * fade > 0.001) {
    float f = fract(c);
    float drip = 1.0 - smoothstep(0.0, max(1.5 * w, 0.14), f);
    float k = ${depth.toFixed(3)} * drip;
    vec2 t = normalize(vec2(-vRfN.z, vRfN.x) + 1e-5);
    float row = floor(c);
    ${joint > 0 ? `
    float a = dot(vRfW.xz, t) / ${joint.toFixed(3)} + 0.5 * mod(row, 2.0);
    float wa = fwidth(a);
    float fa = fract(a);
    k += ${(depth * 0.6).toFixed(3)} * (1.0 - smoothstep(0.0, max(1.5 * wa, 0.06), min(fa, 1.0 - fa))) * (1.0 - smoothstep(0.3, 0.6, wa));
    float jit = vjRfHash(vec2(row, floor(a)));` : `
    float jit = vjRfHash(vec2(row, floor(dot(vRfW.xz, t) * 1.7)));`}
    k += ${jitter.toFixed(3)} * (jit - 0.5) * 2.0;
    diffuseColor.rgb *= 1.0 - k * pitched * fade * (1.0 - 0.85 * smoothstep(0.35, 0.8, up) * clamp(uVjRoofSnow, 0.0, 1.0));
  }
}`);
    sh.uniforms.uVjRoofSnow = uSnow;
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'uniform float uVjRoofSnow;');
  });
}

function std(color: number, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0, ...o });
}

/** overlay surfaces drawn on top of the ground (roads, fields, river ribbon) */
function overlay(m: THREE.MeshStandardMaterial, factor = -1, units = -2): THREE.MeshStandardMaterial {
  m.polygonOffset = true;
  m.polygonOffsetFactor = factor;
  m.polygonOffsetUnits = units;
  return m;
}

export function createWorldMaterials(ctx: Ctx): WorldMats {
  const uni = { uSnow: ctx.mats.uniforms.uSnow, uWet: ctx.mats.uniforms.uWet };

  const uTime = { value: 0 };
  /** snow (mix toward white by uSnow*k, optionally only on up-facing faces) and wetness darkening */
  const weatherize = (m: THREE.MeshStandardMaterial, snowK: number, wetK: number) => {
    chain(m, `wz${snowK}_${wetK}`, (sh) => {
      sh.uniforms.uWSnow = uni.uSnow;
      sh.uniforms.uWWet = uni.uWet;
      sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'uniform float uWSnow; uniform float uWWet;');
      sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.97), clamp(uWSnow * ${snowK.toFixed(3)}, 0.0, 1.0));
        diffuseColor.rgb *= 1.0 - ${(0.35 * wetK).toFixed(3)} * uWWet * (1.0 - uWSnow * 0.7);`);
    });
    return m;
  };

  const atlas = createSignAtlas();
  const dialTex = createClockDial();

  const m: Omit<WorldMats, 'update' | 'atlas'> = {
    ground: weatherize(std(0xffffff, { vertexColors: true, roughness: 1, flatShading: false }), 0.95, 1),
    bank: weatherize(overlay(std(0xffffff, { vertexColors: true, roughness: 0.95, flatShading: false }), -1, -1), 0.85, 1),
    field: overlay(std(0xffffff, { vertexColors: true, roughness: 1, flatShading: false }), -1, -3),
    hedge: weatherize(std(0x4a6a36, { roughness: 0.95 }), 0.6, 0.6),
    shrub: weatherize(std(0x4d6e38, { roughness: 0.95 }), 0.6, 0.6),
    trunk: std(0x5a4232, { roughness: 0.95 }),
    roofTile: weatherize(std(0x8e5040, { roughness: 0.8 }), 0.0, 0.6),
    thatch: weatherize(std(0x9a8456, { roughness: 1 }), 0.0, 0.8),
    whitewash: std(0xd9cfb8, { roughness: 0.9 }),
    boards: std(0x5b4c3f, { roughness: 0.9 }), // weathered tar: dark, but lighter than a hole in the iso view
    beams: std(0x2e2620, { roughness: 0.9 }),
    signalRed: std(0x9a2c24, { roughness: 0.5 }),
    white: std(0xe9e4d6, { roughness: 0.6 }),
    dark: std(0x231f1c, { roughness: 0.9 }),
    coal: std(0x3a3d44, { roughness: 0.45, metalness: 0.35 }), // slate-grey sheen so heaps read as heaps
    water: std(P.WATER, { roughness: 0.15, metalness: 0.3 }),
    paint: weatherize(std(0xffffff, { roughness: 0.8, vertexColors: true }), 0.0, 0.5),
    signs: std(0xffffff, { map: atlas.texture, emissive: 0xffffff, emissiveMap: atlas.texture, emissiveIntensity: 0, roughness: 0.6, flatShading: false }),
    dial: std(0xffffff, { map: dialTex, emissive: 0xfff0c8, emissiveMap: dialTex, emissiveIntensity: 0, roughness: 0.5, flatShading: false }),
    lantern: std(0x8a7a5a, { emissive: P.LAMP_GLOW, emissiveIntensity: 0.1, roughness: 0.3 }),
    hands: std(0x111111, { roughness: 0.5 }),
    setts: weatherize(std(0x7c7367, { roughness: 0.9 }), 0.9, 1),
    settsCourse: weatherize(std(0x958b7b, { roughness: 0.9 }), 0.9, 1),
    road: weatherize(overlay(std(0x8a7d6c, { roughness: 1 }), -2, -4), 0.95, 1),
    lane: weatherize(overlay(std(0x9a8b74, { roughness: 1 }), -2, -4), 0.95, 1),
    earth: weatherize(overlay(std(0x85705a, { roughness: 1 }), -2, -4), 0.9, 1.1),
    overlay: weatherize(overlay(std(0xffffff, { roughness: 1, vertexColors: true }), -2, -4), 0.93, 1),
    towpath: weatherize(overlay(std(0x9d9280, { roughness: 1 }), -2, -4), 0.9, 1),
    street: weatherize(overlay(std(0x7f766a, { roughness: 0.9 }), -2, -4), 0.9, 1),
    cinder: weatherize(overlay(std(0x6b6358, { roughness: 1 }), -1, -2), 0.9, 1),
    forge: std(0x3a1a0a, { emissive: 0xff6a1a, emissiveIntensity: 1.2, roughness: 0.6 }),
    foam: std(0xe8eef0, { roughness: 0.4, emissive: 0x9fb4c0, emissiveIntensity: 0.15 }),
    hay: weatherize(std(0xc2a55a, { roughness: 1 }), 0.8, 0.6),
  };
  for (const [k, v] of Object.entries(m)) (v as THREE.Material).name = 'w_' + k;

  // ── detail textures (no-op on the low tier) ──
  const tex = ctx.tex;
  withDetail(tex, m.roofTile, { pattern: 'slate', scale: 1 / 1.6, strength: 0.45 });
  withDetail(tex, m.thatch, { pattern: 'thatch' });
  withDetail(tex, m.boards, { pattern: 'planks', scale: 1 / 2.4, strength: 0.5 });
  withDetail(tex, m.whitewash, { pattern: 'grime', strength: 0.4 });
  withDetail(tex, m.setts, { pattern: 'setts' });
  withDetail(tex, m.street, { pattern: 'setts' });
  withDetail(tex, m.road, { pattern: 'grime', strength: 0.4 });
  withDetail(tex, m.lane, { pattern: 'grime', strength: 0.45 });
  withDetail(tex, m.earth, { pattern: 'grime', strength: 0.5 });
  withDetail(tex, m.overlay, { pattern: 'grime', strength: 0.45 });
  withDetail(tex, m.towpath, { pattern: 'grime', strength: 0.4 });
  withDetail(tex, m.cinder, { pattern: 'grime', strength: 0.5 });
  withDetail(tex, m.bank, { pattern: 'grime', strength: 0.3 });
  // snow caps on the roofs we own (slate is already capped by core via detail/snow targets)
  const uSnow = ctx.mats.uniforms.uSnow;
  for (const mm of [m.roofTile, m.thatch, m.whitewash, m.boards, m.beams, m.white, m.dark, m.paint, m.hay]) withSnowCap(mm, uSnow);

  // ── roof courses on every tier (no texture fetch): horizontal course lines = constant world y on pitched faces,
  // staggered joints along the eave direction, per-slate brightness jitter; fades out when smaller than ~2 px.
  // (core slate is only used for roofs — world owns every roof in the game; tile & thatch are world materials)
  roofCourses(m.roofTile, uni.uSnow, 0.46, 0.5, 0.26, 0.07);
  roofCourses(ctx.mats.slate, uni.uSnow, 0.52, 0.62, 0.3, 0.08);
  roofCourses(m.thatch, uni.uSnow, 0.75, 0, 0.18, 0.1);

  // ── field overlay: procedural rows along a per-vertex direction (aRow = cos, sin, pitch, amplitude) ──
  chain(m.field, 'vjField', (sh) => {
    sh.uniforms.uWSnow = uni.uSnow;
    sh.uniforms.uWWet = uni.uWet;
    sh.vertexShader = inject(sh.vertexShader, '#include <common>', 'attribute vec4 aRow; varying vec4 vRow; varying vec2 vFieldXZ;');
    sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', 'vRow = aRow; vFieldXZ = (modelMatrix * vec4(position, 1.0)).xz;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'uniform float uWSnow; uniform float uWWet; varying vec4 vRow; varying vec2 vFieldXZ;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
{
  // across-row coordinate (rows run along the aRow direction)
  float across = dot(vFieldXZ, vec2(-vRow.y, vRow.x)) / max(vRow.z, 0.05);
  float fw = fwidth(across);
  float stripe = 0.5 + 0.5 * cos(across * 6.2831853);
  float aa = 1.0 - smoothstep(0.25, 0.6, fw);
  diffuseColor.rgb *= 1.0 - vRow.w * aa * (1.0 - stripe);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.97), clamp(uWSnow * 0.95, 0.0, 1.0));
  diffuseColor.rgb *= 1.0 - 0.3 * uWWet * (1.0 - uWSnow * 0.7);
}`);
  });
  // gust sheen across all fields (crop mode on every tier; aWind = 0 → no displacement)
  applyWind(ctx, m.field, { mode: 'crop', weight: 'attr', amp: 0 });

  // hedgerows sway a little at the top (baked aWind); garden shrubs by height above the (flat) station ground
  applyWind(ctx, m.shrub, { mode: 'foliage', weight: 'localY', height: 2.4, amp: 0.1, pivot: 'vertex' });

  // weir foam: a restless strip (vertex jitter + brightness shimmer)
  chain(m.foam, 'vjFoam', (sh) => {
    sh.uniforms.uFoamT = uTime;
    sh.vertexShader = inject(sh.vertexShader, '#include <common>', 'uniform float uFoamT;');
    sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', `
{
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  transformed.y += 0.07 * sin(wp.x * 3.1 + uFoamT * 7.0) * sin(wp.z * 2.3 - uFoamT * 5.3);
}`);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'uniform float uFoamT;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
{
  vec2 q = gl_FragCoord.xy * 0.11;
  diffuseColor.rgb *= 0.86 + 0.14 * sin(q.x + uFoamT * 6.0) * sin(q.y * 1.3 - uFoamT * 4.0);
}`);
  });

  let forgeT = 0;
  return {
    ...m,
    atlas,
    update(lampsOn, flicker, dt) {
      uTime.value += dt;
      forgeT += dt;
      m.lantern.emissiveIntensity = 0.1 + lampsOn * 3.2 * flicker;
      m.signs.emissiveIntensity = lampsOn * 0.12;
      m.dial.emissiveIntensity = lampsOn * 0.9;
      m.forge.emissiveIntensity = 1.1 + 0.35 * Math.sin(forgeT * 9.1) * Math.sin(forgeT * 3.7 + 1.3);
    },
  };
}
