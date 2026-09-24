import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { Building } from '../core/countryside';
import { chain, inject } from '../core/shaderMods';

/**
 * CHIMNEY SMOKE (v2). One InstancedMesh of low-poly puffs whose whole life (rise, wind drift, growth, fade) is
 * computed in the vertex shader from a per-instance source (chimney pot + phase) and a per-instance on-strength —
 * zero per-frame CPU work except easing a slot's strength while it fades in/out.
 *
 * `knobs.caps.chimneys` slots × (smokePuffs / chimneys) puffs. Every ~1.5 s the slots are given to the smoking
 * chimneys nearest the view focus (sticky; a released slot fades out before it moves, so smoke never pops).
 * Default on/off per building: household awake / cold nights, bakery 04:00–10:00, smithy working hours, pubs,
 * the school on weekdays, nobody home (ctx.origins.pools) = cold hearth. `setChimney(id, on|null)` overrides.
 */
export interface ChimneySmoke {
  set(buildingId: string, on: boolean | null): void;
  isOn(buildingId: string): boolean;
  update(dt: number, hour: number, weekday: number): void;
}

interface Pot { pos: THREE.Vector3; b: string; kind: Building['kind'] | 'station' | 'signalbox'; residents: number; seed: number }

const LIFE = 7.5; // seconds per puff (real time)

export function buildChimneySmoke(ctx: Ctx, root: THREE.Object3D, extra: Pot[]): ChimneySmoke {
  const L = ctx.layout;
  const caps = ctx.quality.knobs.caps;
  const slots = Math.max(1, caps.chimneys);
  const per = Math.max(4, Math.min(12, Math.floor(caps.smokePuffs / slots)));
  const N = slots * per;

  const pots: Pot[] = [];
  let seed = 0;
  for (const b of L.buildings) for (const c of b.chimneys) pots.push({ pos: c.clone(), b: b.id, kind: b.kind, residents: b.residents, seed: (seed++ * 0.618) % 1 });
  for (const e of extra) pots.push({ ...e, seed: (seed++ * 0.618) % 1 });
  const byBuilding = new Map<string, Building>();
  for (const b of L.buildings) byBuilding.set(b.id, b);

  // ── mesh ──
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const src = new Float32Array(N * 4);
  const on = new Float32Array(N);
  const tint = new Float32Array(N);
  for (let s = 0; s < slots; s++) for (let k = 0; k < per; k++) {
    const i = s * per + k;
    src[i * 4 + 3] = k / per; // phase (plus the pot's seed, written on assignment)
  }
  const aSrc = new THREE.InstancedBufferAttribute(src, 4);
  const aOn = new THREE.InstancedBufferAttribute(on, 1);
  const aTint = new THREE.InstancedBufferAttribute(tint, 1);
  aSrc.setUsage(THREE.DynamicDrawUsage);
  aOn.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aSrc', aSrc);
  geo.setAttribute('aOn', aOn);
  geo.setAttribute('aTint', aTint);
  const mat = new THREE.MeshStandardMaterial({ color: 0xa8a39b, roughness: 1, flatShading: true, transparent: true, depthWrite: false });
  mat.name = 'w_chimneySmoke';
  const uT = { value: 0 };
  const w = ctx.wind.uniforms;
  chain(mat, 'vjChimney', (sh) => {
    sh.uniforms.uSmT = uT;
    sh.uniforms.uWindDir = w.uWindDir;
    sh.uniforms.uWindStr = w.uWindStr;
    sh.uniforms.uSmRain = { get value() { return ctx.reg.atmosphere?.rain ?? 0; } };
    sh.vertexShader = inject(sh.vertexShader, '#include <common>', `
attribute vec4 aSrc; attribute float aOn; attribute float aTint;
uniform float uSmT, uWindStr, uSmRain; uniform vec2 uWindDir;
varying float vSmA; varying float vSmTint;`);
    // puffs live in world space: the instance matrix is identity; the source position comes from aSrc
    sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', `
{
  float t = fract(uSmT / ${LIFE.toFixed(2)} + aSrc.w);
  float str = 0.25 + uWindStr;
  vec2 drift = uWindDir * (t * (2.0 + 13.0 * uWindStr) + t * t * 4.0 * uWindStr);
  vec2 curl = vec2(sin(t * 6.0 + aSrc.w * 40.0), cos(t * 5.0 + aSrc.w * 31.0)) * 0.5 * t;
  float rise = t * (5.5 - 3.0 * uWindStr) * (1.0 - 0.4 * uSmRain);
  float sc = (0.35 + 1.7 * t) * step(0.01, aOn) * (0.7 + 0.3 * aOn);
  transformed = position * sc + vec3(aSrc.x + drift.x + curl.x, aSrc.y + rise, aSrc.z + drift.y + curl.y);
  vSmA = aOn * smoothstep(0.0, 0.06, t) * pow(1.0 - t, 1.1) * (0.92 - 0.3 * uSmRain);
  vSmTint = aTint;
}`);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'varying float vSmA; varying float vSmTint;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', `
diffuseColor.rgb *= mix(1.0, 0.55, vSmTint);
diffuseColor.a *= vSmA;
if (diffuseColor.a < 0.01) discard;`);
  });
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.name = 'chimneySmoke';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 2;
  const I = new THREE.Matrix4();
  for (let i = 0; i < N; i++) mesh.setMatrixAt(i, I);
  mesh.instanceMatrix.needsUpdate = true;
  root.add(mesh);

  // ── slot management ──
  const slot = Array.from({ length: slots }, () => ({ pot: -1, cur: 0, target: 0 }));
  const override = new Map<string, boolean>();
  const onCache = new Map<string, boolean>();
  let timer = 0;

  const defaultOn = (p: Pot, hour: number, weekday: number): boolean => {
    const T = ctx.reg.atmosphere?.temperatureC ?? 10;
    const cold = T < 9;
    const awake = hour >= 6 && hour < 23;
    const meal = (hour >= 6 && hour < 9) || (hour >= 11.5 && hour < 13.5) || (hour >= 17 && hour < 20.5);
    const home = p.residents <= 0 || ctx.origins.pools.count(p.b) > 0;
    switch (p.kind) {
      case 'bakery': return (hour >= 4 && hour < 10) || (awake && cold && home);
      case 'smithy': return hour >= 7 && hour < 18 && weekday < 6;
      case 'pub': case 'inn': return (hour >= 10 && hour < 23.5) || (cold && hour >= 6);
      case 'school': return weekday < 5 && hour >= 7.5 && hour < 16 && cold;
      case 'church': case 'chapel': return weekday === 6 && hour >= 8 && hour < 12 && cold;
      case 'mill': return hour >= 6 && hour < 19;
      case 'station': return awake || cold;
      case 'signalbox': return true;
      case 'barn': case 'stable': case 'hut': case 'boathouse': case 'engineHouse': return false;
      default: return home && (awake ? (cold || meal || T < 15) : cold);
    }
  };

  const assign = (si: number, pi: number) => {
    const s = slot[si];
    s.pot = pi;
    const p = pots[pi];
    const tintV = p.kind === 'smithy' || p.kind === 'mill' ? 0.9 : p.kind === 'bakery' ? 0.1 : 0.35;
    for (let k = 0; k < per; k++) {
      const i = si * per + k;
      src[i * 4] = p.pos.x; src[i * 4 + 1] = p.pos.y + 0.2; src[i * 4 + 2] = p.pos.z;
      src[i * 4 + 3] = (k / per + p.seed) % 1;
      tint[i] = tintV;
    }
    aSrc.needsUpdate = true;
    aTint.needsUpdate = true;
  };

  const choose = (hour: number, weekday: number) => {
    const f = ctx.view.focus;
    onCache.clear();
    const cand: { i: number; d: number }[] = [];
    pots.forEach((p, i) => {
      let o = onCache.get(p.b);
      if (o === undefined) { o = override.get(p.b) ?? defaultOn(p, hour, weekday); onCache.set(p.b, o); }
      if (!o) return;
      if (!ctx.view.isVisible(p.pos, 25)) return;
      cand.push({ i, d: Math.hypot(p.pos.x - f.x, p.pos.z - f.z) });
    });
    cand.sort((a, b) => a.d - b.d);
    const want = new Set(cand.slice(0, slots).map((c) => c.i));
    // keep slots on wanted pots; fade out the rest
    const held = new Set<number>();
    for (const s of slot) {
      if (s.pot >= 0 && want.has(s.pot) && !held.has(s.pot)) { s.target = 1; held.add(s.pot); }
      else s.target = 0;
    }
    // give idle (fully faded) slots to wanted pots not yet held
    const waiting = [...want].filter((i) => !held.has(i));
    slot.forEach((s, si) => {
      if (!waiting.length) return;
      if (s.cur <= 0.001 && s.target === 0) { assign(si, waiting.shift()!); s.target = 1; }
    });
  };

  return {
    set(id, v) { if (v === null) override.delete(id); else override.set(id, v); timer = 0; },
    isOn(id) { return onCache.get(id) ?? override.get(id) ?? false; },
    update(dt, hour, weekday) {
      uT.value += dt;
      timer -= dt;
      if (timer <= 0) { timer = 1.5; choose(hour, weekday); }
      let dirty = false;
      slot.forEach((s, si) => {
        if (s.cur === s.target) return;
        const d = s.target - s.cur;
        s.cur += Math.sign(d) * Math.min(Math.abs(d), dt / 3);
        for (let k = 0; k < per; k++) on[si * per + k] = s.cur;
        dirty = true;
      });
      if (dirty) aOn.needsUpdate = true;
    },
  };
}
