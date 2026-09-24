import * as THREE from 'three';
import type { Ctx, System } from '../core/types';
import type { CritterKind, NatureAPI } from '../core/apis';
import { InstancedRig } from '../core/rig';
import { horseGeometry, HORSE_POSE_GLSL } from '../core/rigs/horse';
import { chain, inject } from '../core/shaderMods';
import { createWater } from './water';
import { createPlants } from './plants';
import { debugGround } from './debugGround';
import { Registry } from './life';
import { quadGeometry, QUAD_GLSL, fowlGeometry, FOWL_GLSL, birdGeometry, BIRD_GLSL, boatGeometry, BOAT_GLSL } from './rigs';
import { createHerds } from './herds';
import { createFowl } from './fowl';
import { createBirds } from './birds';
import { createBoats } from './boats';
import { createPuffs } from './smoke';
import { rigUniforms, type NatureUniforms, clamp01, warmth, Drawer } from './util';

/**
 * NATURE (v2): the River Ashbourne's water (+ the Coldharbour pond and the lock chamber), reeds, crops and hay,
 * every animal and bird, and the boats (with the towpath horse). Draw calls: water 1 (+ mist when misty), plants 1,
 * beasts 1, horses 1, fowl 1, birds 1, boats 1, puffs 1.
 * Simulation integrates clock.dtMotion (pause / 60× / advance() consistent); far life ticks at 2 Hz; instance
 * buffers are written once per rendered frame; off-screen instances get a zero matrix.
 */
const BIRD_KINDS: CritterKind[] = ['crow', 'rook', 'starling', 'swallow'];

export function createNature(ctx: Ctx): System {
  const R = ctx.layout.river, K = ctx.quality.knobs;
  const rng = ctx.rng.fork(0x4e41);
  const root = new THREE.Group();
  root.name = 'nature';
  ctx.scene.add(root);
  const uTime = { value: 0 };
  const uLily = { value: 1 };
  const U: NatureUniforms = { uNatTime: uTime, uNatNight: ctx.mats.uniforms.uNight };

  // ── water, plants ──
  const water = createWater(ctx, uTime);
  root.add(water.mesh);
  if (water.mist) root.add(water.mist);
  const plants = createPlants(ctx, uLily);
  root.add(plants.mesh);
  if ((ctx.params.debug ?? '').split(',').includes('natureground')) root.add(debugGround(ctx));

  // ── rigs (one draw each) ──
  const shadows = K.shadowCasters !== 'major';
  const mkRig = (name: string, geometry: THREE.BufferGeometry, glsl: string, capacity: number, glow = false, cast = shadows) => {
    const r = new InstancedRig({ name: `nature:${name}`, geometry, glsl, capacity, castShadow: cast, receiveShadow: false, material: { roughness: 0.9 } });
    rigUniforms(r.mesh, U, glow, chain, inject);
    root.add(r.mesh);
    return r;
  };
  const quad = mkRig('beasts', quadGeometry(), QUAD_GLSL, K.caps.sheep + K.caps.cows + K.caps.dogs + 16);
  const horses = mkRig('horses', horseGeometry(), HORSE_POSE_GLSL, 8);
  const fowlRig = mkRig('fowl', fowlGeometry(), FOWL_GLSL, K.caps.waterfowl + 24, false, false);
  const birdRig = mkRig('birds', birdGeometry(), BIRD_GLSL, K.caps.birds + 8, false, false);
  const boatRig = mkRig('boats', boatGeometry(), BOAT_GLSL, K.caps.boats + 4, true);
  const DQ = new Drawer(quad), DH = new Drawer(horses), DF = new Drawer(fowlRig), DB = new Drawer(birdRig), DBo = new Drawer(boatRig);
  const drawers = [DQ, DH, DF, DB, DBo];
  const puffs = createPuffs(ctx, ctx.quality.tier === 'low' ? 28 : 48);
  root.add(puffs.mesh);

  // ── life ──
  const reg = new Registry();
  const herds = createHerds(ctx, reg, quad, horses, rng.fork(1));
  const boats = createBoats(ctx, boatRig, horses, water, puffs, rng.fork(4));
  const fowl = createFowl(ctx, reg, fowlRig, water, boats.probe, rng.fork(2));
  const birds = createBirds(ctx, reg, birdRig, rng.fork(3));

  // startle: train whistles near crows, the motorwagen, gunshots, thunder
  const scare = (pos: THREE.Vector3, r: number) => { herds.scare(pos, r); fowl.scare(pos, r); birds.scare(pos, r); };
  let busScare = false;
  ctx.bus.on('animal:scared', (e) => {
    if (busScare) return;
    busScare = true;
    try { scare(e.pos, Math.max(4, e.radius)); } finally { busScare = false; }
  });
  ctx.bus.on('audio:cue', (e) => {
    if (!e.pos) return;
    if (e.cue === 'whistle') scare(e.pos, 150);
    else if (e.cue === 'thunder' || e.cue === 'pistol') scare(e.pos, 220);
    else if (e.cue === 'motor') scare(e.pos, 30);
  });

  const _p = new THREE.Vector3(), _v2 = new THREE.Vector2();
  const api: NatureAPI = {
    river: {
      surfaceY: (x, z) => water.surfaceY(x, z),
      flowAt(p) {
        const n = R.nearest(p);
        const t = R.tangentAt(n.s, _p);
        const f = water.flowSpeed(n.s) * (1 - water.ice);
        const w = ctx.wind.uniforms.uWindDir.value, ws = ctx.wind.speed * 0.012 * (1 - water.ice);
        return _v2.set(t.x * f + w.x * ws, t.z * f + w.y * ws).clone();
      },
      ice: 0,
    },
    list: (kind) => reg.list(kind),
    get: (id) => { const c = reg.get(id); return c && !c.away ? c.info : undefined; },
    boats: () => boats.infos(),
    boat: (id) => boats.get(id),
    anchorOf: (id) => boats.anchorOf(id),
    requestBoat: (kind, opts) => boats.request(kind, opts),
    herd: (kind, from, to, opts) => herds.herd(kind, from, to, opts),
    scare: (pos, r) => scare(pos, r),
    raycast(r) {
      const b = boats.raycast(r);
      const c = reg.raycast(r, (p) => ctx.view.isVisible(p, 1));
      if (b && c) {
        const bi = boats.get(b);
        const db = bi ? bi.pos.distanceTo(r.ray.origin) : Infinity, dc = c.info.pos.distanceTo(r.ray.origin);
        return dc < db ? { kind: 'animal', id: c.info.id } : { kind: 'boat', id: b };
      }
      if (b) return { kind: 'boat', id: b };
      if (c) return { kind: 'animal', id: c.info.id };
      return null;
    },
    stats: () => ({ animals: reg.count() - reg.count(BIRD_KINDS), birds: reg.count(BIRD_KINDS), boats: boats.count(), byKind: reg.byKind() }),
  };
  ctx.reg.nature = api;
  (api as unknown as { _debug: () => unknown })._debug = () => { const ms = perfMs; perfMs = 0; return { boats: boats.debug(), trips: herds.debug(), ms }; };

  // ambient livestock voices near the view (real time)
  let cueT = 4;
  const ambient = (dt: number) => {
    cueT -= dt;
    if (cueT > 0) return;
    cueT = 6 + rng.next() * 12;
    const r = rng.next();
    const kind = r < 0.4 ? 'sheep' : r < 0.7 ? 'cow' : r < 0.85 ? 'horse' : 'dog';
    const p = herds.nearestCueTarget(kind);
    if (!p) return;
    if (ctx.view.distToFocus(p.x, p.z) > 120) return;
    ctx.bus.emit('audio:cue', { cue: kind === 'cow' ? 'moo' : kind === 'sheep' ? 'sheep' : kind === 'horse' ? 'horse' : 'dog', pos: p, volume: kind === 'cow' ? 0.45 : 0.35 });
  };

  let lastFrame = -1, perfMs = 0;
  let visAcc = 0;
  return {
    name: 'nature',
    update(dt, clock) {
      const t0 = performance.now();
      const dtM = clock.dtMotion;
      // real-time idle life in the shaders (keeps breathing / bobbing while paused)
      uTime.value += dt;
      water.update(dt, uTime.value);
      api.river.ice = water.ice;
      const lilyT = water.ice < 0.3 && warmth(ctx) > 0.25 ? 1 : 0;
      if (uLily.value !== lilyT) uLily.value = lilyT;
      herds.update(dtM, dt);
      boats.update(dtM, dt);
      fowl.update(dtM, dt);
      birds.update(dtM, dt);
      visAcc += dt;
      // instance buffers once per rendered frame (the first sub-step after a render)
      const frame = ctx.renderer.info.render.frame;
      if (frame !== lastFrame) {
        lastFrame = frame;
        for (const d of drawers) d.begin();
        herds.sync(DQ, DH);
        fowl.sync(visAcc, DF);
        birds.sync(DB);
        boats.sync(visAcc, DBo, DH);
        for (const d of drawers) d.end();
        visAcc = 0;
        ambient(dt);
      }
      perfMs += performance.now() - t0;
      void clamp01;
    },
  };
}
