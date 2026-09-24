import * as THREE from 'three';
import type { Ctx, Dir, LineId, SignalAspect, System } from '../core/types';
import type { WorldAPI } from '../core/apis';
import { createWorldMaterials } from './materials';
import { createEnv } from './env';
import { Batch } from './batch';
import { Kit } from './kit';
import { buildTerrain } from './terrain';
import { buildRiver } from './river';
import { buildBridges } from './bridges';
import { buildRoads } from './roads';
import { buildTowns } from './towns';
import { buildTrack } from './track';
import { buildPlatforms } from './platforms';
import { buildStation } from './station';
import { buildCanopies } from './canopy';
import { buildFootbridge } from './footbridge';
import { buildLamps, gloomNow } from './lamps';
import { buildSignals } from './signals';
import { buildShed } from './shed';
import { buildLineside } from './lineside';
import { buildTrees } from './trees';
import { buildGarden } from './garden';
import { buildChimneySmoke } from './smoke';
import { createOccluders } from './occluders';
import { buildDoors } from './doors';
import { buildClockHands } from './clocks';
import { buildVanes } from './vanes';

/**
 * WORLD (v2): everything static on the ground — terrain from layout.heightAt, the river valley and its structures,
 * bridges, roads, towns, fields, hedges, trees, the station, platforms, canopies, footbridge, signals, engine shed —
 * plus the animated building fixtures (windmill, water wheel, lock gates, clocks, pub signs and flags, washing,
 * chimney smoke, door swings, lamps with per-lamp state, the signalman, forge glow) and occluder fades.
 *
 * Static scenery goes through one global chunked batcher (material × 200 m chunk × shadow flag) so the whole map
 * costs few draw calls and far chunks frustum-cull. Tiny detail meshes hide below knobs.detailZoom.
 */
export function createWorld(ctx: Ctx): System {
  const t0 = performance.now();
  const rng = ctx.rng.fork(0x57a7);
  const root = new THREE.Group();
  root.name = 'world';
  ctx.scene.add(root);
  const knobs = ctx.quality.knobs;

  const wm = createWorldMaterials(ctx);
  const env = createEnv(ctx.layout);
  const pickables: THREE.Object3D[] = [];
  const batch = new Batch();
  {
    // fold flat-colour materials into vertex-coloured ones inside the static batch (fewer draws per chunk)
    const m = ctx.mats;
    const fold = new Map<THREE.Material, { to: THREE.Material; color: THREE.Color }>();
    for (const mat of [m.iron, m.bottleGreen, m.oxblood, m.brass, m.sleeper, wm.signalRed, wm.white, wm.dark, wm.coal, wm.beams, wm.trunk, wm.water])
      fold.set(mat, { to: wm.paint, color: mat.color.clone() });
    for (const mat of [wm.road, wm.lane, wm.earth, wm.towpath, wm.cinder])
      fold.set(mat, { to: wm.overlay, color: mat.color.clone() });
    Kit.fold = fold;
  }

  const safe = <T,>(name: string, f: () => T): T | undefined => {
    try { return f(); } catch (e) { console.error(`[world] building ${name} failed`, e); return undefined; }
  };

  const terrain = safe('terrain', () => buildTerrain(ctx, wm, env, root, batch, rng.fork(1)));
  const river = safe('river', () => buildRiver(ctx, wm, root, batch));
  safe('bridges', () => buildBridges(ctx, wm, batch));
  safe('roads', () => buildRoads(ctx, wm, batch));
  const towns = safe('towns', () => buildTowns(ctx, wm, root, batch, rng.fork(6)));
  const lineside = safe('lineside', () => buildLineside(ctx, wm, env, root, pickables, batch));
  safe('track', () => buildTrack(ctx, wm, root, batch));
  safe('platforms', () => buildPlatforms(ctx, wm, root, rng.fork(2), pickables, batch));
  const station = safe('station', () => buildStation(ctx, wm, root, pickables));
  const canopies = safe('canopies', () => buildCanopies(ctx, wm, root, pickables)) ?? [];
  const footbridgePath = safe('footbridge', () => buildFootbridge(ctx, wm, root, pickables)) ?? [];
  const lamps = safe('lamps', () => buildLamps(ctx, wm, batch, root));
  const signals = safe('signals', () => buildSignals(ctx, wm, root, batch));
  const shed = safe('shed', () => buildShed(ctx, wm, root, rng.fork(3), pickables, batch));
  safe('garden', () => buildGarden(ctx, wm, env, batch, rng.fork(5)));
  const treePts = safe('trees', () => buildTrees(ctx, wm, env, root, rng.fork(4), terrain?.treeSpots ?? [])) ?? [];

  // ── merge the static batch ──
  let detailMeshes: THREE.Mesh[] = [];
  safe('batch', () => {
    const major = new Set<THREE.Material>([ctx.mats.brick, ctx.mats.brickDark, ctx.mats.stone, ctx.mats.slate, ctx.mats.cream, wm.roofTile, wm.thatch, wm.whitewash, wm.boards, ctx.mats.bottleGreen, ctx.mats.iron]);
    if (knobs.shadowCasters === 'major') batch.castPolicy = (mat) => major.has(mat);
    const { group, detail } = batch.buildChunks('worldStatic');
    detailMeshes = detail;
    // shadow policy: on 'major' only the big chunks near the station cast
    root.add(group);
  });

  // ── chimney smoke (station + signal box stoves count too) ──
  const smoke = safe('smoke', () => {
    const S = ctx.layout.station;
    const c = Math.cos(S.yaw), s = Math.sin(S.yaw);
    const stationPots = ([[-12.5, -3.2], [3.5, 3.5]] as const).map(([lx, lz], i) => ({
      pos: new THREE.Vector3(S.center.x + lx * c + lz * s, 17.2, S.center.z - lx * s + lz * c), b: 'station', kind: 'station' as const, residents: 0, seed: i * 0.37,
    }));
    const sb = { pos: new THREE.Vector3(-11 + 1.8, 3.2 + 3.0 + 2.2, 33 + 0.6), b: 'signalbox', kind: 'signalbox' as const, residents: 0, seed: 0.77 };
    return buildChimneySmoke(ctx, root, [...stationPots, sb]);
  });

  // ── occluders (camera fades them) ──
  const occ = createOccluders();
  safe('occluders', () => {
    const byName = (n: string) => root.getObjectByName(n);
    const st = [byName('station')].filter((o): o is THREE.Object3D => !!o);
    if (st.length) occ.add('station', st);
    for (const g of canopies) occ.add(g.name === 'canopy2' ? 'canopyP2' : 'canopyP1', [g]);
    const fb = byName('footbridge'); if (fb) occ.add('footbridge', [fb]);
    const sh = byName('shed'); if (sh) occ.add('shed', [sh]);
  });

  // ── clock hands: station tower + church towers, two instanced draws ──
  const clockHands = safe('clocks', () => buildClockHands(root, [...(station?.clockSpots ?? []), ...(towns?.clocks ?? [])], wm.hands));

  const vanes = safe('vanes', () => buildVanes(ctx, root, [...(station ? [station.vane] : []), ...(towns?.vanes ?? [])]));

  // ── door swings ──
  const doors = safe('doors', () => buildDoors(root, towns?.doors ?? new Map()));

  root.userData.buildMs = Math.round(performance.now() - t0);

  const decorations = new THREE.Group();
  decorations.name = 'decorations';
  ctx.scene.add(decorations);

  const fallbackSignals: Record<string, SignalAspect> = {};
  const key = (l: LineId, e: Dir) => `${l}:${e}`;
  let flickAmt = 0, gutter = 1, gutterT = 0;
  let lockLevel = 1;
  let windmillRpm = 0;
  const washAmount = new Map<string, number>();
  let washTouched = false;

  const setWash = (id: string, amount: number) => {
    const w = towns?.washing.find((x) => x.building === id);
    if (!w || !towns?.washMesh) return;
    const spot = (towns.washMesh.userData.spots as { building: string; a: THREE.Vector3; b: THREE.Vector3 }[]).find((x) => x.building === id);
    if (!spot) return;
    const k = Math.round(THREE.MathUtils.clamp(amount, 0, 1) * w.count);
    washAmount.set(id, amount);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const yaw = Math.atan2(-(spot.b.z - spot.a.z), spot.b.x - spot.a.x);
    for (let j = 0; j < w.count; j++) {
      if (j >= k) { m4.makeScale(0, 0, 0); w.mesh.setMatrixAt(w.first + j, m4); continue; }
      const u = (j + 0.5) / w.count;
      p.lerpVectors(spot.a, spot.b, u);
      p.y += 2.18 - 0.05 * Math.sin(u * Math.PI);
      const hsh = Math.sin((w.first + j) * 12.9898) * 43758.5;
      const r = hsh - Math.floor(hsh);
      e.set(0, yaw, 0); q.setFromEuler(e);
      m4.compose(p, q, s.set(0.55 + r * 0.45, 0.55 + ((r * 7) % 1) * 0.6, 1));
      w.mesh.setMatrixAt(w.first + j, m4);
    }
    w.mesh.instanceMatrix.needsUpdate = true;
  };

  const api: WorldAPI = {
    setSignal(line, end, aspect) {
      if (signals) {
        if (!signals.set(line, end, aspect)) return;
      } else {
        if (fallbackSignals[key(line, end)] === aspect) return;
        fallbackSignals[key(line, end)] = aspect;
      }
      ctx.bus.emit('signal:changed', { line, end, aspect });
    },
    getSignal: (line, end) => signals ? signals.get(line, end) : (fallbackSignals[key(line, end)] ?? 'stop'),
    signalPosition(line, end) {
      if (signals) return signals.position(line, end);
      const L = ctx.layout.lines[line];
      return L.offsetPoint(L.signalT[end], -L.platformSide * 2.5, 0);
    },
    lampsOn: 0,
    clockTowerTop: station?.towerTop.clone() ?? ctx.layout.station.center.clone().setY(26),
    addDecoration: (o) => { decorations.add(o); },
    removeDecoration: (o) => { decorations.remove(o); },
    stationPickables: pickables,
    footbridgePath: footbridgePath.length ? footbridgePath : ctx.layout.footbridge.route.map((v) => v.clone()),
    flickerLamps(amount) { flickAmt = Math.max(0, Math.min(1, amount)); },
    treeNear(x, z, r) { const r2 = r * r; for (const t of treePts) if ((t.x - x) ** 2 + (t.z - z) ** 2 < r2) return true; return false; },
    lamps: () => lamps?.info() ?? [],
    lampLit: (i) => lamps?.lit(i) ?? 0,
    lightLamp: (i, on) => { lamps?.light(i, on); },
    manualLamps: true,
    occluders: () => occ.list(),
    setOccluderFade: (id, a) => occ.setFade(id, a),
    setChimney: (id, on) => { smoke?.set(id, on); },
    setWashing: (id, amount) => { washTouched = true; setWash(id, amount); },
    openDoor: (id) => { doors?.open(id); },
    mills: () => ({ windmillRpm, waterwheelRpm: river?.wheelRpm ?? 0, lockLevel }),
    setLockGate: (i, open) => { river?.setGate(i, open); },
    setLockLevel: (l) => { lockLevel = THREE.MathUtils.clamp(l, 0, 1); river?.setLevel(lockLevel); },
  };
  ctx.reg.world = api;
  ctx.bus.on('signal:changed', () => lineside?.pull());

  // windmill state
  const wmill = towns?.windmill ?? null;
  let sailAngle = 0;
  if (wmill) {
    const d = ctx.wind.uniforms.uWindDir.value;
    wmill.body.rotation.y = Math.atan2(-d.x, -d.y);
  }
  // ── view culling for the chunked static meshes: frustum × expanded world box (three's bounding-sphere test is too
  // loose for 280 m chunks — neighbour chunks' spheres always touch the view). Margin keeps near off-screen casters.
  const culled: { o: THREE.Object3D; box: THREE.Box3; detail: boolean; far: boolean }[] = [];
  // low tier, zoomed right out: sleepers and hedges are sub-pixel texture — drop them (hundreds of thousands of triangles)
  const farDetailRe = ctx.quality.tier === 'low' ? /^(sleepers|hedges)/ : null;
  const detailSet = new Set<THREE.Object3D>(detailMeshes);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !/^(worldStatic|ground|trees|conifers|hedges|riverBank|fields|sleepers)/.test(mesh.name)) return;
    const im = o as THREE.InstancedMesh;
    let box: THREE.Box3 | null = null;
    if (im.isInstancedMesh) { if (!im.boundingBox) im.computeBoundingBox(); box = im.boundingBox!.clone(); }
    else { mesh.geometry.computeBoundingBox(); box = mesh.geometry.boundingBox!.clone(); }
    box.applyMatrix4(mesh.matrixWorld);
    box.expandByScalar(2);
    culled.push({ o, box, detail: detailSet.has(o), far: !!farDetailRe && farDetailRe.test(mesh.name) });
  });
  const forgeCol = new THREE.Color(0xff7a2a);
  let forgeT = 0, washTimer = 0, detailVis = true, lastFrame = -1;
  const noCull = ctx.params.raw.get('wcull') === '0';

  return {
    name: 'world',
    update(dt, clock) {
      const hour = clock.hour;
      // light claims & culling once per RENDERED frame (main sub-steps update up to ~12× per frame at 60×)
      const frame = ctx.renderer.info.render.frame;
      const newFrame = frame !== lastFrame;
      lastFrame = frame;
      const weekday = clock.weekday;
      // lamps (per-lamp state + lamplighter fallback)
      let g = 1;
      if (flickAmt > 0) {
        gutterT -= dt;
        if (gutterT <= 0) {
          gutter = Math.random() < 0.35 ? 0.05 + Math.random() * 0.3 : 0.8 + Math.random() * 0.2;
          gutterT = 0.05 + Math.random() * (gutter < 0.5 ? 0.15 : 0.6);
        }
        g = 1 + (gutter - 1) * flickAmt;
      }
      const gloom = gloomNow(ctx);
      lamps?.update(dt, clock.dtSim, gloom, api.manualLamps, g, newFrame);
      api.lampsOn = lamps ? lamps.stationLevel : gloom;
      const flicker = (0.95 + 0.05 * Math.sin(clock.minutes * 0.7 + dt)) * g;
      wm.update(Math.max(api.lampsOn, gloom * 0.8), flicker, dt);
      signals?.update(dt, Math.max(ctx.reg.atmosphere?.nightFactor ?? 0, api.lampsOn));
      clockHands?.update(hour);
      if (newFrame) vanes?.update(dt);
      shed?.update(dt);
      lineside?.update(dt);
      doors?.update(dt);
      occ.update(dt);
      smoke?.update(dt, hour, weekday);
      river?.update(dt, clock);
      towns?.update(dt, ctx.reg.atmosphere?.nightFactor ?? 0);

      // Coldharbour Ley is ploughed across three working days, then harrowed back to stubble overnight
      if (terrain) terrain.setPlough(((clock.day % 3) * 10 + THREE.MathUtils.clamp(hour - 7, 0, 10)) / 30);

      // smithy forges: glow + a pooled light while the smith works
      forgeT += dt;
      const working = hour >= 7 && hour < 18 && weekday < 6;
      wm.forge.emissiveIntensity *= working ? 1 : 0.12;
      if (working && towns && newFrame) {
        for (const f of towns.forges) {
          const fl = 0.8 + 0.2 * Math.sin(forgeT * 9.1 + f.pos.x) * Math.sin(forgeT * 3.7);
          ctx.lights.claim(`forge:${f.building}`, f.pos, forgeCol, 14 * fl, 9, 2);
        }
      }

      // windmill: faces the wind (the miller winds the tail pole round slowly); sails turn by day with canvas set,
      // stopped & furled at night, on Sundays and in storms
      if (wmill) {
        const d = ctx.wind.uniforms.uWindDir.value;
        const want = Math.atan2(-d.x, -d.y);
        let da = want - wmill.body.rotation.y;
        while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        wmill.body.rotation.y += THREE.MathUtils.clamp(da, -dt * 0.05, dt * 0.05);
        const storm = ctx.reg.atmosphere?.weather === 'storm' || ctx.wind.speed > 14;
        const work = hour > 6 && hour < 20 && weekday !== 6 && !storm && ctx.wind.speed > 1.5;
        const target = work ? THREE.MathUtils.clamp(ctx.wind.speed * 1.5, 3, 14) : 0;
        windmillRpm += (target - windmillRpm) * Math.min(1, dt * 0.15);
        if (windmillRpm < 0.05 && !work) windmillRpm = 0;
        sailAngle += (windmillRpm / 60) * Math.PI * 2 * dt;
        wmill.sails.rotation.z = sailAngle;
        wmill.canvas.visible = work || windmillRpm > 1;
      }

      // Monday wash fallback: if no washerwoman has pegged anything out by 10:00, lines fill (and later empty)
      // one by one while they are off-screen
      washTimer -= dt;
      if (washTimer <= 0 && towns && !washTouched) {
        washTimer = 2;
        const monday = weekday === 0 && hour >= 10 && hour < 16.5;
        for (const w of towns.washing) {
          const h = Math.sin(w.first * 7.31) * 1000;
          const pick = h - Math.floor(h) < 0.45;
          const want = monday && pick ? 1 : 0;
          if ((washAmount.get(w.building) ?? 0) === want) continue;
          const spot = (towns.washMesh!.userData.spots as { building: string; a: THREE.Vector3 }[]).find((x) => x.building === w.building);
          if (spot && ctx.view.isVisible(spot.a, 6)) continue;
          setWash(w.building, want);
        }
      }

      // tiny props hide when zoomed far out (tier knob); chunk culling
      detailVis = ctx.view.zoom >= knobs.detailZoom;
      const farVis = ctx.view.zoom >= 0.55;
      const quad = newFrame && !noCull ? footprintQuad(ctx, 30) : null;
      // perspective: the footprint runs to the horizon, so small detail and far-detail chunks are dropped by their
      // distance from the camera instead (the same far-field reductions the zoomed-out iso view gets)
      const persp = !ctx.view.ortho;
      const camP = ctx.view.camera?.position;
      if (quad) for (const c of culled) {
        let v = (detailVis || !c.detail) && (farVis || !c.far) && (quad ? rectHitsQuad(c.box, quad) : true);
        if (v && persp && camP && (c.detail || c.far)) {
          const d = c.box.distanceToPoint(camP);
          if (d > (c.detail ? 140 : 230)) v = false;
        }
        if (c.o.visible !== v) c.o.visible = v;
      }
    },
    dispose() {
      ctx.scene.remove(root);
      ctx.scene.remove(decorations);
    },
  };
}

/** the view's ground footprint (convex quad, xz) grown by `m` metres — null if the view has no footprint yet */
const _q: { x: number; z: number }[] = [0, 1, 2, 3].map(() => ({ x: 0, z: 0 }));
function footprintQuad(ctx: Ctx, m: number): { x: number; z: number }[] | null {
  const f = ctx.view.footprint; // Vector2 (x, y = world z)
  if (!f || f.length !== 4) return null;
  let cx = 0, cz = 0;
  for (let i = 0; i < 4; i++) { cx += f[i].x / 4; cz += f[i].y / 4; }
  for (let i = 0; i < 4; i++) {
    const zz = f[i].y;
    const dx = f[i].x - cx, dz = zz - cz, l = Math.hypot(dx, dz) || 1;
    _q[i].x = f[i].x + (dx / l) * m * 1.42; _q[i].z = zz + (dz / l) * m * 1.42;
  }
  return _q;
}
/** 2D SAT: axis-aligned box (xz) vs convex quad */
function rectHitsQuad(b: THREE.Box3, q: { x: number; z: number }[]): boolean {
  let qx0 = Infinity, qx1 = -Infinity, qz0 = Infinity, qz1 = -Infinity;
  for (const p of q) { qx0 = Math.min(qx0, p.x); qx1 = Math.max(qx1, p.x); qz0 = Math.min(qz0, p.z); qz1 = Math.max(qz1, p.z); }
  if (qx1 < b.min.x || qx0 > b.max.x || qz1 < b.min.z || qz0 > b.max.z) return false;
  const cs = [[b.min.x, b.min.z], [b.max.x, b.min.z], [b.max.x, b.max.z], [b.min.x, b.max.z]];
  for (let i = 0; i < 4; i++) {
    const a = q[i], c = q[(i + 1) % 4];
    const nx = -(c.z - a.z), nz = c.x - a.x;
    let q0 = Infinity, q1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (const p of q) { const d = p.x * nx + p.z * nz; q0 = Math.min(q0, d); q1 = Math.max(q1, d); }
    for (const [x, z] of cs) { const d = x * nx + z * nz; r0 = Math.min(r0, d); r1 = Math.max(r1, d); }
    if (r1 < q0 || r0 > q1) return false;
  }
  return true;
}
