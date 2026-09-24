import type * as THREE from 'three';
import type { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { SimClock } from './clock';
import type { EventBus } from './bus';
import type { Rng } from './rng';
import type { Layout } from './layout';
import type { Registry } from './registry';
import type { DebugParams } from './params';
import type { Materials } from './materials';
import type { Quality } from './quality';
import type { ViewState } from './view';
import type { Wind } from './wind';
import type { TexLib } from './tex';
import type { LightPool } from './lights';
import type { OriginRegistry } from './origins';

/**
 * A subsystem. `dt` = real seconds since last frame (clamped <= 0.1) — use for visual animation.
 * `clock.dtSim` = sim minutes elapsed this tick — use for simulation logic (0 when paused).
 */
export interface System {
  name: string;
  update(dt: number, clock: SimClock): void;
  dispose?(): void;
}

export type Weather = 'clear' | 'overcast' | 'rain' | 'storm' | 'fog' | 'snow';
export type LineId = 'coast' | 'highland';
/** Travel direction along a line (east = increasing curve t). */
export type Dir = 'east' | 'west';
/** 1 = coast, 2 = highland */
export type PlatformId = 1 | 2;

export type AudioCue =
  | 'whistle' | 'bell' | 'brake' | 'doors' | 'thunder' | 'honk' | 'moo' | 'meow'
  | 'fanfare' | 'band' | 'cheer' | 'clank' | 'hiss' | 'police' | 'spooky' | 'chime'
  // v2 (living world). Positional where it makes sense; audio fades by distance to view.focus.
  | 'hooves' | 'wheels' | 'horse' | 'motor' | 'gate' | 'crossingBell' | 'townBell' | 'churchPeal' | 'forge'
  | 'water' | 'oars' | 'splash' | 'boatWhistle' | 'lock' | 'mill' | 'duck' | 'goose' | 'hens' | 'swan' | 'sheep' | 'dog'
  | 'crow' | 'birdsong' | 'crowd' | 'fire' | 'pistol' | 'hammer' | 'shout';

export type SignalAspect = 'stop' | 'clear' | 'failed';

export interface Ctx {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  camera: { current: THREE.Camera };
  /** #ui overlay root */
  ui: HTMLElement;
  clock: SimClock;
  bus: EventBus;
  rng: Rng;
  layout: Layout;
  reg: Registry;
  params: DebugParams;
  mats: Materials;
  // ── v2 shared services (created by main.ts before any system) ──
  /** quality tier + knobs, fixed for the session (see core/quality.ts) */
  quality: Quality;
  /** camera footprint / focus / zoom / frustum, updated by main each rendered frame (see core/view.ts) */
  view: ViewState;
  /** global wind uniforms + CPU sampler (see core/wind.ts) */
  wind: Wind;
  /** procedural detail textures (see core/tex.ts) */
  tex: TexLib;
  /** shared point-light pool (see core/lights.ts) */
  lights: LightPool;
  /** legitimate spawn/despawn points + the no-pop-in audit (see core/origins.ts) */
  origins: OriginRegistry;
}

export const WEATHERS: Weather[] = ['clear', 'overcast', 'rain', 'storm', 'fog', 'snow'];
export const LINE_IDS: LineId[] = ['coast', 'highland'];
export const DIRS: Dir[] = ['east', 'west'];
