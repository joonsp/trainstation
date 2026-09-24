import * as THREE from 'three';
import * as P from './palette';
import { cloneWithChain } from './shaderMods';

export interface Materials {
  brick: THREE.MeshStandardMaterial;
  brickDark: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  cream: THREE.MeshStandardMaterial;
  slate: THREE.MeshStandardMaterial;
  iron: THREE.MeshStandardMaterial;
  bottleGreen: THREE.MeshStandardMaterial;
  oxblood: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  sleeper: THREE.MeshStandardMaterial;
  rail: THREE.MeshStandardMaterial;
  ballast: THREE.MeshStandardMaterial;
  platform: THREE.MeshStandardMaterial;
  gravel: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  windowLit: THREE.MeshStandardMaterial;
  lampGlow: THREE.MeshStandardMaterial;
  snow: THREE.MeshStandardMaterial;
  /** 0..1: darkens + lowers roughness on grass/gravel/platform/stone/slate/ballast. Idempotent. */
  setWetness(w: number): void;
  /** 0..1: lerps grass/slate/ballast/platform/gravel toward snow white. Idempotent. */
  setSnow(s: number): void;
  /** 0..1: drives windowLit / lampGlow emissiveIntensity. Idempotent. */
  setNight(n: number): void;
  /** current values (read-only convenience) */
  readonly state: { wetness: number; snow: number; night: number };
  /** v2: shared shader uniforms (snow caps & detail textures read uSnow; kept in sync by setSnow) */
  readonly uniforms: { uSnow: { value: number }; uWet: { value: number }; uNight: { value: number } };
  /**
   * v2: a private copy of a shared material that still follows weather & night (colour/roughness/emissive are
   * copied from `base` whenever the setters run) and keeps base's shader patches (detail, snow caps).
   * Use it when you must change per-object state — e.g. occluder fades (withDitherFade) — never clone() shared mats.
   */
  derive(base: THREE.MeshStandardMaterial, tag: string): THREE.MeshStandardMaterial;
}

function std(color: number, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0, ...opts });
}

export function createMaterials(): Materials {
  const m = {
    brick: std(P.BRICK, { roughness: 0.9 }),
    brickDark: std(P.BRICK_DARK, { roughness: 0.9 }),
    stone: std(P.STONE, { roughness: 0.8 }),
    cream: std(P.CREAM, { roughness: 0.75 }),
    slate: std(P.SLATE, { roughness: 0.7 }),
    iron: std(P.IRON, { roughness: 0.55, metalness: 0.4 }),
    bottleGreen: std(P.BOTTLE_GREEN, { roughness: 0.45, metalness: 0.1 }),
    oxblood: std(P.OXBLOOD, { roughness: 0.45, metalness: 0.1 }),
    brass: std(P.BRASS, { roughness: 0.35, metalness: 0.7 }),
    wood: std(P.WOOD, { roughness: 0.85 }),
    sleeper: std(P.SLEEPER, { roughness: 0.95 }),
    rail: std(P.RAIL, { roughness: 0.35, metalness: 0.8 }),
    ballast: std(P.BALLAST, { roughness: 1 }),
    platform: std(P.PLATFORM, { roughness: 0.9 }),
    gravel: std(P.GRAVEL, { roughness: 1 }),
    grass: std(P.GRASS, { roughness: 1 }),
    glass: std(P.GLASS, { roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.45, depthWrite: false }),
    windowLit: std(0x3a3226, { emissive: P.WINDOW_LIT, emissiveIntensity: 0, roughness: 0.4 }),
    lampGlow: std(0x8a7a5a, { emissive: P.LAMP_GLOW, emissiveIntensity: 0.15, roughness: 0.4 }),
    snow: std(P.SNOW, { roughness: 0.9 }),
  };
  for (const [k, mat] of Object.entries(m)) mat.name = k;

  const wetTargets: THREE.MeshStandardMaterial[] = [m.grass, m.gravel, m.platform, m.stone, m.slate, m.ballast];
  const snowTargets: THREE.MeshStandardMaterial[] = [m.grass, m.slate, m.ballast, m.platform, m.gravel];
  const baseColor = new Map<THREE.MeshStandardMaterial, THREE.Color>();
  const baseRough = new Map<THREE.MeshStandardMaterial, number>();
  for (const mat of new Set([...wetTargets, ...snowTargets])) {
    baseColor.set(mat, mat.color.clone());
    baseRough.set(mat, mat.roughness);
  }
  const snowCol = new THREE.Color(P.SNOW);
  const state = { wetness: 0, snow: 0, night: 0 };

  const apply = () => {
    for (const [mat, base] of baseColor) {
      const c = mat.color.copy(base);
      const snowAmt = snowTargets.includes(mat) ? state.snow : 0;
      if (snowAmt > 0) c.lerp(snowCol, snowAmt);
      const wet = wetTargets.includes(mat) ? state.wetness * (1 - snowAmt * 0.7) : 0;
      if (wet > 0) c.multiplyScalar(1 - (mat === m.slate ? 0.18 : 0.35) * wet);
      const r0 = baseRough.get(mat)!;
      mat.roughness = THREE.MathUtils.lerp(r0, Math.min(r0, 0.35), wet);
    }
  };

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const uniforms = { uSnow: { value: 0 }, uWet: { value: 0 }, uNight: { value: 0 } };
  const derived: { base: THREE.MeshStandardMaterial; mat: THREE.MeshStandardMaterial }[] = [];
  const syncDerived = () => {
    for (const d of derived) { d.mat.color.copy(d.base.color); d.mat.roughness = d.base.roughness; d.mat.emissiveIntensity = d.base.emissiveIntensity; }
  };
  return {
    ...m,
    state,
    uniforms,
    setWetness(w) { const v = clamp01(w); uniforms.uWet.value = v; if (v === state.wetness) return; state.wetness = v; apply(); syncDerived(); },
    setSnow(s) { const v = clamp01(s); uniforms.uSnow.value = v; if (v === state.snow) return; state.snow = v; apply(); syncDerived(); },
    setNight(n) {
      const v = clamp01(n);
      uniforms.uNight.value = v;
      state.night = v;
      m.windowLit.emissiveIntensity = 1.6 * v;
      m.lampGlow.emissiveIntensity = 0.15 + 2.6 * v;
      syncDerived();
    },
    derive(base, tag) {
      const mat = cloneWithChain(base);
      mat.name = `${base.name}:${tag}`;
      derived.push({ base, mat });
      return mat;
    },
  };
}

/**
 * v2: dress the SHARED core materials once at startup (main.ts): procedural detail textures (tier permitting)
 * and snow caps on up-facing faces. Systems that clone core materials should call `mats.derive()`-style copies
 * AFTER this so the patches carry over (Material.clone copies onBeforeCompile).
 */
export function dressCoreMaterials(m: Materials, lib: import('./tex').TexLib, withDetail: typeof import('./tex').withDetail, withSnowCap: typeof import('./shaderMods').withSnowCap): void {
  withDetail(lib, m.slate, { pattern: 'slate' });
  withDetail(lib, m.brick, { pattern: 'brick' });
  withDetail(lib, m.brickDark, { pattern: 'brick' });
  withDetail(lib, m.wood, { pattern: 'planks' });
  withDetail(lib, m.platform, { pattern: 'setts', scale: 1 / 2.4, strength: 0.25 });
  withDetail(lib, m.gravel, { pattern: 'grime', strength: 0.35 });
  for (const mat of [m.stone, m.cream, m.wood, m.brick, m.brickDark, m.iron, m.bottleGreen, m.oxblood]) withSnowCap(mat, m.uniforms.uSnow);
}
