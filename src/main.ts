import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import type { Ctx, System, Weather } from './core/types';
import { EventBus } from './core/bus';
import { SimClock, MAX_SIM_STEP } from './core/clock';
import { Rng } from './core/rng';
import { createLayout } from './core/layout';
import { Registry } from './core/registry';
import { parseParams } from './core/params';
import { createMaterials } from './core/materials';
import { createLayoutDebug } from './core/debugLayout';
import { detectQuality } from './core/quality';
import { View } from './core/view';
import { Wind } from './core/wind';
import { createTexLib, withDetail } from './core/tex';
import { withSnowCap } from './core/shaderMods';
import { dressCoreMaterials } from './core/materials';
import { PointLightPool } from './core/lights';
import { createOrigins } from './core/origins';

import { createAtmosphere } from './atmosphere/index';
import { createWorld } from './world/index';
import { createNature } from './nature/index';
import { createTrains } from './trains/index';
import { createTraffic } from './traffic/index';
import { createPeople } from './people/index';
import { createMaintenance } from './maintenance/index';
import { createEvents } from './events/index';
import { createCamera } from './camera/index';
import { createUI } from './ui/index';
import { createAudio } from './audio/index';

const params = parseParams();
const appEl = document.getElementById('app')!;
const uiEl = document.getElementById('ui')!;
if (params.noui) uiEl.style.display = 'none';

// ── renderer / scene / post ──
// The scene is drawn through the EffectComposer, so canvas MSAA would only smooth the final full-screen copy.
// Anti-aliasing is done with a multisampled composer target instead (?aa=0 disables it, ?aa=8 for more).
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
// v2 quality tier (fixed for the session; ?q=low|med|high overrides)
const quality = detectQuality(renderer.getContext(), params);
const knobs = quality.knobs;
console.info(`[main] quality tier '${quality.tier}' (${quality.reason})`);
const AA_SAMPLES = Math.max(0, Math.min(8, Math.round(Number(params.raw.get('aa') ?? knobs.msaa)) || 0));
let pixelRatio = Math.min(window.devicePixelRatio, knobs.pixelRatioMax);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// three r18x removed PCFSoftShadowMap (it falls back to PCF with a warning); the high tier's softer look comes from shadow.radius
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.info.autoReset = false;
appEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ec3d6);

// placeholder iso camera (camera system replaces ctx.camera.current)
const aspect0 = window.innerWidth / window.innerHeight;
const placeholderCam = new THREE.OrthographicCamera(-100 * aspect0, 100 * aspect0, 100, -100, 1, 2000);
placeholderCam.position.set(200, 200, 200);
placeholderCam.lookAt(0, 0, 0);

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(
  window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio(),
  { type: THREE.HalfFloatType, samples: AA_SAMPLES },
));
const renderPass = new RenderPass(scene, placeholderCam);
composer.addPass(renderPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0, 0.6, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const bus = new EventBus();
const clock = new SimClock(bus, params.time ?? 8);
if (params.speed !== undefined) clock.timeScale = params.speed;

const layout = createLayout();
const mats = createMaterials();
const view = new View();
view.update(placeholderCam, window.innerHeight);
const debugFlags = new Set((params.debug ?? '').split(',').filter(Boolean));
const tex = createTexLib({ size: knobs.detailTexSize, enabled: knobs.detailTextures, anisotropy: Math.min(knobs.anisotropy, renderer.capabilities.getMaxAnisotropy()), uSnow: mats.uniforms.uSnow });
dressCoreMaterials(mats, tex, withDetail, withSnowCap);
const ctx: Ctx = {
  scene, renderer, composer, bloom,
  camera: { current: placeholderCam },
  ui: uiEl,
  clock, bus,
  rng: new Rng(params.seed),
  layout,
  reg: new Registry(),
  params,
  mats,
  quality,
  view,
  wind: new Wind(),
  tex,
  lights: new PointLightPool(scene, knobs.pointLights),
  origins: createOrigins(layout, { isVisible: (p, m) => view.isVisible(p, m), now: () => clock.minutes, debug: debugFlags.has('popins') }),
};

const layoutIssues = ctx.layout.validate();
if (layoutIssues.length) console.error('[layout] validation issues:\n' + layoutIssues.join('\n'));

// ── systems (creation order is part of the contract) ──
// v2 order: atmosphere, world, nature, trains, traffic, people, maintenance, events, camera, ui, audio
const factories: [string, (c: Ctx) => System][] = [
  ['atmosphere', createAtmosphere], ['world', createWorld], ['nature', createNature], ['trains', createTrains], ['traffic', createTraffic],
  ['people', createPeople], ['maintenance', createMaintenance], ['events', createEvents], ['camera', createCamera], ['ui', createUI], ['audio', createAudio],
];
const systems: System[] = [];
for (const [name, f] of factories) {
  try { systems.push(f(ctx)); } catch (e) { console.error(`[main] create ${name} failed`, e); }
}

if (debugFlags.has('layout')) scene.add(createLayoutDebug(ctx.layout));
// debug=top → top-down ortho view (north up). Optional &zoom=<half-height m>&cx=<x>&cz=<z>
let topCam: THREE.OrthographicCamera | null = null;
const topZoom = Number(params.raw.get('zoom') ?? 270) || 270;
if (debugFlags.has('top')) {
  const cx = Number(params.raw.get('cx') ?? 0) || 0, cz = Number(params.raw.get('cz') ?? 0) || 0;
  topCam = new THREE.OrthographicCamera(-topZoom * aspect0, topZoom * aspect0, topZoom, -topZoom, 1, 2000);
  topCam.position.set(cx, 800, cz);
  topCam.up.set(0, 0, -1);
  topCam.lookAt(cx, 0, cz);
}

const reported = new Set<string>();
function reportOnce(sys: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const key = sys + '|' + msg;
  if (reported.has(key)) return;
  reported.add(key);
  console.error(`[${sys}] update error:`, e);
}

function updateSystems(dt: number) {
  for (const s of systems) {
    try { s.update(dt, clock); } catch (e) { reportOnce(s.name, e); }
  }
}

/** one frame of simulation: sub-steps so clock.dtSim <= MAX_SIM_STEP inside updates */
function stepFrame(dt: number) {
  const total = clock.paused ? 0 : dt * clock.timeScale;
  const n = Math.max(1, Math.ceil(total / MAX_SIM_STEP - 1e-9));
  for (let i = 0; i < n; i++) {
    clock.advanceSim(total / n);
    updateSystems(dt / n);
  }
}

function advance(simMinutes: number) {
  const t0 = performance.now();
  let steps = 0;
  let left = Math.max(0, simMinutes);
  while (left > 1e-9) {
    const d = Math.min(MAX_SIM_STEP, left);
    clock.advanceSim(d);
    updateSystems(1 / 60);
    left -= d;
    steps++;
  }
  return { simMinutes, steps, ms: Math.round(performance.now() - t0), time: clock.format(), day: clock.day };
}

// ── resize ──
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.resolution.set(w, h);
  if (topCam) {
    const a = w / h;
    topCam.left = -topZoom * a; topCam.right = topZoom * a; topCam.updateProjectionMatrix();
  }
}
window.addEventListener('resize', onResize);

// ── stats ──
let fps = 60;
let lastDraw = { calls: 0, triangles: 0 };
// fps over a sliding ~1 s window (an EMA of 1/dt overestimates badly when frame times are uneven)
let fpsFrames = 0, fpsT0 = performance.now();
let updMs = 0, renMs = 0;
// cheap service metrics for QA (lateness of arrivals, passengers boarded / gave up)
const metrics = { arrivals: 0, lateSum: 0, lateMax: 0, gaveUp: 0, boarded: 0 };
bus.on('train:arrived', (e) => { metrics.arrivals++; metrics.lateSum += Math.max(0, e.lateMin); metrics.lateMax = Math.max(metrics.lateMax, e.lateMin); });
bus.on('passenger:gaveUp', () => { metrics.gaveUp++; });
bus.on('passenger:boarded', () => { metrics.boarded++; });
function stats() {
  const reg = ctx.reg;
  let trains: { id: string; name: string; line: string; state: string; platform: number | null; passengers: number; condition: unknown }[] = [];
  try {
    trains = reg.trains.list().map((t) => ({ id: t.id, name: t.name, line: t.line, state: t.state, platform: t.platform, passengers: t.passengers, condition: { ...t.condition } }));
  } catch { /* ignore */ }
  const safe = <T,>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };
  return {
    hour: +clock.hour.toFixed(3),
    day: clock.day,
    time: clock.format(),
    weather: safe(() => reg.atmosphere.weather, 'clear' as Weather),
    trains,
    people: safe(() => reg.people.count(), 0),
    activeEvents: safe(() => reg.events.active().map((e) => e.id), [] as string[]),
    shed: safe(() => reg.maintenance.status(), { bay: null, queue: [], progress: 0, task: 'n/a' }),
    fps: Math.round(fps),
    /** CPU ms per frame (EMA): simulation/system updates and the render call */
    updateMs: +updMs.toFixed(1),
    renderMs: +renMs.toFixed(1),
    drawCalls: lastDraw.calls,
    triangles: lastDraw.triangles,
    layoutIssues: layoutIssues.length,
    // ── v2 ──
    tier: quality.tier,
    tierReason: quality.reason,
    pixelRatio: +renderer.getPixelRatio().toFixed(2),
    /** VISIBLE pop-ins (spawn/despawn at a non-legit point on screen) — must stay 0 */
    popIns: { ...ctx.origins.popIns },
    popInsOffscreen: { ...ctx.origins.offscreen },
    popInLog: ctx.origins.log.slice(-5),
    vehicles: safe(() => reg.traffic.stats().vehicles, 0),
    horses: safe(() => reg.traffic.stats().horses, 0),
    boats: safe(() => reg.nature.stats().boats, 0),
    animals: safe(() => reg.nature.stats().animals, 0),
    birds: safe(() => reg.nature.stats().birds, 0),
    lightClaims: ctx.lights.lastClaims,
    service: {
      arrivals: metrics.arrivals,
      meanLateMin: metrics.arrivals ? +(metrics.lateSum / metrics.arrivals).toFixed(1) : 0,
      maxLateMin: +metrics.lateMax.toFixed(1),
      boarded: metrics.boarded,
      gaveUp: metrics.gaveUp,
      giveUpRate: metrics.boarded + metrics.gaveUp ? +(metrics.gaveUp / (metrics.boarded + metrics.gaveUp)).toFixed(3) : 0,
    },
  };
}

/** draw calls / triangles per top-level scene group (main pass only), for budget checks: __station.perf() */
function perf() {
  const out: Record<string, { meshes: number; instanced: number; instances: number; tris: number; casters: number }> = {};
  for (const child of scene.children) {
    const key = child.name || child.type;
    const r = out[key] ??= { meshes: 0, instanced: 0, instances: 0, tris: 0, casters: 0 };
    child.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry as THREE.BufferGeometry;
      const n = g.index ? g.index.count / 3 : (g.getAttribute('position')?.count ?? 0) / 3;
      const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
      r.meshes++; if (inst !== 1 || (m as THREE.InstancedMesh).isInstancedMesh) { r.instanced++; r.instances += inst; }
      r.tris += Math.round(n * inst);
      if (m.castShadow) r.casters++;
    });
  }
  return { tier: quality.tier, drawCalls: lastDraw.calls, triangles: lastDraw.triangles, programs: renderer.info.programs?.length ?? 0, textures: renderer.info.memory.textures, groups: out };
}

const station = {
  ctx,
  setHour: (h: number) => clock.setHour(h),
  setWeather: (w: Weather) => ctx.reg.atmosphere.setWeather(w, true),
  setSpeed: (s: number) => { clock.timeScale = s; },
  trigger: (id: string) => ctx.reg.events.trigger(id),
  advance,
  stats,
  perf,
  layoutIssues,
};
(window as unknown as { __station: typeof station }).__station = station;

// ── apply params ──
bus.emit('ready', {});
if (params.weather) { try { ctx.reg.atmosphere.setWeather(params.weather, true); } catch (e) { console.error(e); } }
if (params.cam) { try { ctx.reg.camera.setMode(params.cam); } catch (e) { console.error(e); } }
if (params.mute) { try { ctx.reg.audio.setMuted(true); } catch (e) { console.error(e); } }
if (params.advance) advance(params.advance);
if (params.event) {
  const id = params.event;
  setTimeout(() => { try { if (!ctx.reg.events.trigger(id)) console.warn(`[main] event '${id}' did not trigger`); } catch (e) { console.error(e); } }, 2000);
}
if (params.select) {
  const kind = params.select;
  setTimeout(() => {
    try {
      const id = kind === 'train' ? ctx.reg.trains.list()[0]?.id : ctx.reg.people.list()[0]?.id;
      if (id) bus.emit('select', { kind, id });
    } catch (e) { console.error(e); }
  }, 2500);
}


// ── loop ──
let viewBased = false;
// runtime-safe auto downgrade (pixel ratio only, never shader-affecting knobs): after 8 s of real frames at
// low fps on med/high, step the pixel ratio down (max twice). Never on low tier or with an explicit ?q=.
const t0Frames = performance.now();
let downSteps = 0, lastDownCheck = 0;
function autoDowngrade(now: number) {
  if (quality.tier === 'low' || params.raw.get('q') || downSteps >= 2) return;
  if (now - t0Frames < 8000 || now - lastDownCheck < 4000) return;
  lastDownCheck = now;
  if (fps < 24 && pixelRatio > 1) {
    pixelRatio = Math.max(1, pixelRatio - 0.25);
    downSteps++;
    onResize();
    console.info(`[main] low fps (${fps.toFixed(0)}): pixel ratio → ${pixelRatio}`);
  }
}
let last = performance.now();
let prewarmed = false;
function frame(now: number) {
  const raw = (now - last) / 1000;
  last = now;
  const dt = Math.min(Math.max(raw, 0), 0.1);
  fpsFrames++;
  if (now - fpsT0 >= 1000) { fps = (fpsFrames * 1000) / (now - fpsT0); fpsFrames = 0; fpsT0 = now; }
  const tu = performance.now();
  const cam = topCam ?? ctx.camera.current;
  // v2 shared services: view state (from last frame's camera), wind phases (real dt, once per rendered frame)
  if (!viewBased && cam !== placeholderCam && (cam as THREE.OrthographicCamera).isOrthographicCamera) {
    const o = cam as THREE.OrthographicCamera;
    view.baseHalfH = (o.top - o.bottom) / 2 / (o.zoom || 1);
    viewBased = true;
  }
  view.update(cam, window.innerHeight);
  try { ctx.wind.follow(ctx.reg.atmosphere); } catch { /* atmosphere missing */ }
  ctx.wind.tick(dt);
  stepFrame(dt);
  ctx.lights.resolve(view.focus);
  const tr = performance.now();
  updMs = updMs * 0.9 + (tr - tu) * 0.1;
  renderPass.camera = cam;
  renderer.info.reset();
  if (knobs.post === 'direct') {
    renderer.render(scene, cam);
  } else {
    // the bloom pass costs several full-screen blurs; skip it entirely while atmosphere has it at ~0 (daytime)
    bloom.enabled = bloom.strength > 0.01;
    composer.render(dt);
  }
  renMs = renMs * 0.9 + (performance.now() - tr) * 0.1;
  lastDraw = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  if (!ctx.origins.armed) ctx.origins.armed = true;
  // pre-warm: compile every material already in the scene (hidden rigs, event props held in reserve, night / fog
  // variants share programs) once after the first frame, so first use later doesn't hitch on a real GPU
  if (!prewarmed) {
    prewarmed = true;
    const c0 = cam;
    setTimeout(() => {
      try {
        const r = renderer as THREE.WebGLRenderer & { compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<unknown> };
        // compile against the target the scene really renders into (the composer's buffer on med/high: tone mapping
        // and colour space are part of the program key, so canvas-target programs would be the wrong variants)
        const prevRT = renderer.getRenderTarget();
        renderer.setRenderTarget(knobs.post === 'direct' ? null : composer.readBuffer);
        if (r.compileAsync && renderer.extensions.has('KHR_parallel_shader_compile')) void r.compileAsync(scene, c0).catch(() => { /* ignore */ });
        else renderer.compile(scene, c0);
        renderer.setRenderTarget(prevRT);
      } catch { /* ignore */ }
    }, 50);
  }
  autoDowngrade(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
