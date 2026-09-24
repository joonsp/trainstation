import type { DebugParams } from './params';

/**
 * QUALITY TIERS (v2). Detected once at startup in main.ts and exposed as `ctx.quality`.
 * Every shader-affecting knob is FIXED for the session (program cache keys and light counts never change at
 * runtime); a tier change from the UI reloads the page with `?q=<tier>` (and stores it in localStorage 'vj.quality').
 *
 * Detection order: `?q=low|med|high` → localStorage 'vj.quality' → software GL (SwiftShader / llvmpipe …) = low →
 * ≤ 4 cores, ≤ 4 GB deviceMemory or a mobile UA = med → otherwise high.
 */
export type Tier = 'low' | 'med' | 'high';
export type WindMode = 'tree' | 'foliage' | 'crop' | 'grass' | 'cloth' | 'flag' | 'smoke' | 'water';

export interface QualityKnobs {
  // ── render path (main.ts) ──
  /** cap for renderer pixel ratio */
  pixelRatioMax: number;
  /** MSAA samples on the composer target (the canvas itself never has MSAA) */
  msaa: number;
  /** 'direct' = renderer.render straight to the canvas (tone mapping by the renderer, no bloom pass at all) */
  post: 'direct' | 'composer';
  shadowMapSize: number;
  shadowType: 'pcf' | 'pcfsoft';
  /** which meshes may cast shadows: 'major' = buildings, canopies, bridges, trains, vehicle bodies; 'near' adds trees/animals near the focus; 'all' */
  shadowCasters: 'major' | 'near' | 'all';
  // ── lights ──
  /** size of the shared point-light pool (ctx.lights) — fixed for the session */
  pointLights: number;
  /** train headlamp spot lights (0 = emissive cone meshes instead) */
  spotLights: number;
  // ── shaders ──
  /** wind modes that animate; a disabled mode makes applyWind a no-op */
  wind: Record<WindMode, boolean>;
  /** wind also applied to shadow depth materials */
  windShadows: boolean;
  /** procedural detail textures (slate / brick / setts / planks / thatch / furrows) on shared materials */
  detailTextures: boolean;
  detailTexSize: 256 | 512;
  anisotropy: number;
  water: { ripples: 0 | 1 | 2; rainRings: boolean; lampStreaks: number; mist: boolean };
  // ── population caps (systems clamp their spawning to these) ──
  caps: {
    people: number; townsfolk: number; vehicles: number; horses: number; boats: number;
    sheep: number; cows: number; birds: number; waterfowl: number; dogs: number; smokePuffs: number; chimneys: number; reeds: number;
  };
  // ── geometry detail ──
  /** hide tiny props (flowers, grass tufts, crop rows) when the iso zoom is below this */
  detailZoom: number;
  /** false = flat textured crop fields with wind sheen only (no row geometry) */
  cropGeometry: boolean;
  /** crop row pitch in metres (when cropGeometry) */
  cropPitch: number;
  /** outer ground grid cell size (inner |x|,|z| < 200 stays 5 m) */
  groundCell: number;
  /** full-rate life simulation radius around the view focus (beyond: coarse 2 Hz ticks) */
  lifeNearRadius: number;
}

export interface Quality {
  readonly tier: Tier;
  readonly knobs: Readonly<QualityKnobs>;
  /** why this tier was chosen, e.g. 'override ?q=low' | 'software GL: SwiftShader' | 'cores<=4' | 'default' */
  readonly reason: string;
  readonly softwareGL: boolean;
  readonly renderer: string;
}

const ALL_WIND: Record<WindMode, boolean> = { tree: true, foliage: true, crop: true, grass: true, cloth: true, flag: true, smoke: true, water: true };

export const KNOBS: Record<Tier, QualityKnobs> = {
  low: {
    pixelRatioMax: 1, msaa: 0, post: 'direct', shadowMapSize: 1024, shadowType: 'pcf', shadowCasters: 'major',
    pointLights: 3, spotLights: 0,
    wind: { tree: true, foliage: false, crop: true, grass: false, cloth: true, flag: true, smoke: true, water: true }, windShadows: false,
    detailTextures: false, detailTexSize: 256, anisotropy: 1,
    water: { ripples: 0, rainRings: false, lampStreaks: 0, mist: false },
    caps: { people: 240, townsfolk: 25, vehicles: 11, horses: 16, boats: 3, sheep: 20, cows: 6, birds: 40, waterfowl: 8, dogs: 2, smokePuffs: 60, chimneys: 10, reeds: 120 },
    detailZoom: 1.4, cropGeometry: false, cropPitch: 1.6, groundCell: 20, lifeNearRadius: 160,
  },
  med: {
    pixelRatioMax: 1.25, msaa: 2, post: 'composer', shadowMapSize: 2048, shadowType: 'pcf', shadowCasters: 'near',
    pointLights: 6, spotLights: 2,
    wind: { ...ALL_WIND, grass: false }, windShadows: true,
    detailTextures: true, detailTexSize: 512, anisotropy: 4,
    water: { ripples: 1, rainRings: true, lampStreaks: 4, mist: true },
    caps: { people: 360, townsfolk: 50, vehicles: 14, horses: 22, boats: 6, sheep: 40, cows: 10, birds: 120, waterfowl: 14, dogs: 3, smokePuffs: 200, chimneys: 25, reeds: 300 },
    detailZoom: 0.9, cropGeometry: true, cropPitch: 1.6, groundCell: 10, lifeNearRadius: 220,
  },
  high: {
    pixelRatioMax: 2, msaa: 4, post: 'composer', shadowMapSize: 2048, shadowType: 'pcfsoft', shadowCasters: 'all',
    pointLights: 8, spotLights: 2,
    wind: ALL_WIND, windShadows: true,
    detailTextures: true, detailTexSize: 512, anisotropy: 8,
    water: { ripples: 2, rainRings: true, lampStreaks: 8, mist: true },
    caps: { people: 440, townsfolk: 80, vehicles: 20, horses: 32, boats: 9, sheep: 60, cows: 14, birds: 250, waterfowl: 20, dogs: 4, smokePuffs: 400, chimneys: 40, reeds: 600 },
    detailZoom: 0.6, cropGeometry: true, cropPitch: 0.8, groundCell: 10, lifeNearRadius: 300,
  },
};

const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i;

/** read the unmasked renderer string from a GL context (may be '' when blocked) */
export function glRendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { return ''; }
}

export function detectQuality(gl: WebGLRenderingContext | WebGL2RenderingContext, params: DebugParams): Quality {
  const renderer = glRendererName(gl);
  const softwareGL = SOFTWARE_RE.test(renderer);
  const mk = (tier: Tier, reason: string): Quality => ({ tier, knobs: KNOBS[tier], reason, softwareGL, renderer });
  const q = params.raw.get('q');
  if (q === 'low' || q === 'med' || q === 'high') return mk(q, `override ?q=${q}`);
  try {
    const s = localStorage.getItem('vj.quality');
    if (s === 'low' || s === 'med' || s === 'high') return mk(s, `saved '${s}'`);
  } catch { /* storage blocked */ }
  if (softwareGL) return mk('low', `software GL: ${renderer.slice(0, 40)}`);
  const nav = typeof navigator !== 'undefined' ? navigator as Navigator & { deviceMemory?: number } : undefined;
  const cores = nav?.hardwareConcurrency ?? 8;
  const mem = nav?.deviceMemory ?? 8;
  const mobile = /Mobi|Android|iPhone|iPad/i.test(nav?.userAgent ?? '');
  if (mobile) return mk('med', 'mobile');
  if (cores <= 4) return mk('med', `cores<=4 (${cores})`);
  if (mem <= 4) return mk('med', `deviceMemory<=4 (${mem})`);
  return mk('high', 'default');
}

/** persist a tier choice and reload with ?q= (UI tier picker) */
export function setQualityAndReload(t: Tier): void {
  try { localStorage.setItem('vj.quality', t); } catch { /* ignore */ }
  const u = new URL(location.href);
  u.searchParams.set('q', t);
  location.href = u.toString();
}
