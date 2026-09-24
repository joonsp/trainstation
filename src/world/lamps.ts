import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { LampGroup, LampInfo } from '../core/apis';
import type { WorldMats } from './materials';
import type { Batch } from './batch';
import { chain, inject } from '../core/shaderMods';

const LAMP_H = 3.3;
const GLASS_Y = LAMP_H + 0.85;

export interface LampSystem {
  readonly count: number;
  info(): LampInfo[];
  lit(i: number): number;
  light(i: number, on: boolean): void;
  /** average lit level of the station lamps (v1 lampsOn) */
  readonly stationLevel: number;
  /** gloom 0..1, manual = WorldAPI.manualLamps, flicker multiplier (ghost guttering) */
  update(dt: number, dtSim: number, gloom: number, manual: boolean, flicker: number, claim: boolean): void;
}

/**
 * GAS LAMPS (v2). Every lamp on the map — the 21 station lamps (layout.lampPositions: platforms, forecourt, road)
 * then the 15 town street lamps (layout.streetLamps) — with its own lit state for the lamplighter's round.
 *  - posts go into the global static batch; lantern glass is one InstancedMesh whose per-instance `aLit` drives
 *    the emissive, plus one additive halo billboard per lamp so a lamp glows even without a pooled light (low tier);
 *  - lit lamps `ctx.lights.claim(...)` every frame (station/forecourt priority 1, town 0.5);
 *  - FALLBACK: a lamp nobody has lit lights itself once gloom > 0.85 (or after 20 sim min of gloom > 0.5), each
 *    after its own small stagger; lamps still burning 20 sim min into full daylight go out by themselves.
 */
export function buildLamps(ctx: Ctx, wm: WorldMats, batch: Batch, root: THREE.Object3D): LampSystem {
  const L = ctx.layout;
  const m = ctx.mats;
  const st = L.lampPositions;
  const towns = L.towns;
  const townOf = (p: THREE.Vector3): string | undefined => {
    let best: string | undefined, bd = 60;
    for (const t of towns) for (const l of t.lamps) { const d = Math.hypot(l.x - p.x, l.z - p.z); if (d < bd) { bd = d; best = t.id; } }
    return best;
  };
  const infos: LampInfo[] = [
    ...st.map((pos, index) => ({ index, pos: pos.clone(), group: (index < 14 ? 'platform' : index < 18 ? 'forecourt' : 'road') as LampGroup, lit: 0 })),
    ...L.streetLamps.map((pos, k) => {
      const t = townOf(pos);
      const group: LampGroup = t === 'lc1' ? 'crossing' : t === 'river' ? 'river' : 'town';
      return { index: st.length + k, pos: pos.clone(), group, town: t, lit: 0 };
    }),
  ];
  const n = infos.length;

  // ── posts (static) ──
  batch.cast = true;
  for (const l of infos) {
    const { x, y, z } = l.pos;
    batch.cyl(m.iron, 0.13, 0.2, 0.5, 8, x, y, z);
    batch.cyl(m.iron, 0.06, 0.08, LAMP_H, 6, x, y + 0.5, z);
    batch.box(m.iron, 0.7, 0.05, 0.05, x, y + LAMP_H - 0.35, z); // ladder bar (the lamplighter's)
    batch.cyl(m.iron, 0.16, 0.08, 0.15, 6, x, y + LAMP_H + 0.45, z);
    batch.add(m.iron, new THREE.ConeGeometry(0.3, 0.3, 4), batch.mat(x, y + LAMP_H + 1.25, z, Math.PI / 4));
    batch.add(m.iron, new THREE.SphereGeometry(0.06, 5, 3), batch.mat(x, y + LAMP_H + 1.45, z));
  }
  batch.cast = false;

  // ── glass: instanced, per-lamp emissive ──
  const litArr = new Float32Array(n);
  const aLit = new THREE.InstancedBufferAttribute(litArr, 1);
  aLit.setUsage(THREE.DynamicDrawUsage);
  const glassGeo = new THREE.CylinderGeometry(0.24, 0.16, 0.5, 4, 1);
  glassGeo.rotateY(Math.PI / 4);
  glassGeo.setAttribute('aLit', aLit);
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5a, emissive: 0xffc46a, emissiveIntensity: 1, roughness: 0.3, flatShading: true });
  glassMat.name = 'w_lampGlass';
  const uFlick = { value: 1 };
  chain(glassMat, 'vjLampGlass', (sh) => {
    sh.uniforms.uLampFlick = uFlick;
    sh.vertexShader = inject(sh.vertexShader, '#include <common>', 'attribute float aLit; varying float vLit;');
    sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', 'vLit = aLit;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'uniform float uLampFlick; varying float vLit;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <emissivemap_fragment>', 'totalEmissiveRadiance *= 0.06 + 3.3 * vLit * uLampFlick;');
  });
  const glass = new THREE.InstancedMesh(glassGeo, glassMat, n);
  glass.name = 'lampGlass';
  const mt = new THREE.Matrix4();
  infos.forEach((l, i) => { glass.setMatrixAt(i, mt.makeTranslation(l.pos.x, l.pos.y + GLASS_Y, l.pos.z)); });
  glass.instanceMatrix.needsUpdate = true;
  glass.computeBoundingSphere();
  glass.frustumCulled = false;

  // ── halos: additive camera-facing quads ──
  const haloTex = ctx.tex.get('w_lampHalo', (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,230,170,1)');
    grd.addColorStop(0.18, 'rgba(255,205,120,0.55)');
    grd.addColorStop(0.5, 'rgba(255,170,80,0.12)');
    grd.addColorStop(1, 'rgba(255,160,70,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }, 64);
  const haloGeo = new THREE.PlaneGeometry(1, 1);
  haloGeo.setAttribute('aLit', aLit);
  const haloMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: haloTex }, uFlick: uFlick, uSize: { value: ctx.quality.knobs.post === 'direct' ? 3.6 : 2.6 }, uFog: { value: 0 }, uGain: { value: ctx.quality.knobs.post === 'direct' ? 1.0 : 0.6 } },
    vertexShader: /* glsl */`
      attribute float aLit; varying float vLit; varying vec2 vUv; uniform float uSize; uniform float uFog;
      void main() {
        vLit = aLit; vUv = uv;
        vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float s = uSize * (1.0 + 0.8 * uFog) * (0.6 + 0.4 * aLit);
        c.xy += position.xy * s;
        c.z += 0.6; // pull toward the camera so the glass never clips the halo
        gl_Position = projectionMatrix * c;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uTex; uniform float uFlick; uniform float uFog; uniform float uGain; varying float vLit; varying vec2 vUv;
      void main() {
        vec4 t = texture2D(uTex, vUv);
        float a = t.a * vLit * uFlick * uGain * (0.7 + 0.5 * uFog);
        if (a < 0.004) discard;
        gl_FragColor = vec4(t.rgb * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  haloMat.name = 'w_lampHalo';
  const halos = new THREE.InstancedMesh(haloGeo, haloMat, n);
  halos.name = 'lampHalos';
  infos.forEach((l, i) => { halos.setMatrixAt(i, mt.makeTranslation(l.pos.x, l.pos.y + GLASS_Y, l.pos.z)); });
  halos.instanceMatrix.needsUpdate = true;
  halos.frustumCulled = false;
  halos.renderOrder = 3;

  const group = new THREE.Group();
  group.name = 'lamps';
  group.add(glass, halos);
  root.add(group);

  // ── state ──
  const want = new Uint8Array(n);      // 1 = lit (target)
  const byHand = new Uint8Array(n);    // last change was by hand (lamplighter) → fallback leaves it alone
  const stagger = new Float32Array(n);
  for (let i = 0; i < n; i++) { const s = Math.sin(i * 91.7 + 3.1) * 43758.5; stagger[i] = (s - Math.floor(s)) * 20; }
  let gloomMin = 0;
  /** per lamp: sim minutes of daylight (gloom < 0.3) since it was lit — a lamp lit by hand in the dusk is never doused
   *  straight away because the afternoon was bright */
  const dayMinI = new Float32Array(n);
  let time = 0;
  const lightPos = new THREE.Vector3();
  const col = new THREE.Color(0xffc878);

  // warm start: if it is already dark, the round was done before we arrived
  const g0 = gloomNow(ctx);
  if (g0 > 0.5) for (let i = 0; i < n; i++) { want[i] = 1; litArr[i] = 1; }
  aLit.needsUpdate = true;

  let stationLevel = 0;
  const api: LampSystem = {
    count: n,
    info() { infos.forEach((l, i) => { l.lit = litArr[i]; }); return infos; },
    lit: (i) => litArr[i] ?? 0,
    light(i, on) {
      if (i < 0 || i >= n) return;
      byHand[i] = 1;
      dayMinI[i] = 0;
      if (want[i] === (on ? 1 : 0)) return;
      want[i] = on ? 1 : 0;
      ctx.bus.emit('lamp:lit', { index: i, on });
    },
    get stationLevel() { return stationLevel; },
    update(dt, dtSim, gloom, manual, flicker, claim) {
      // warm start on the first update too (atmosphere's gloom is only live once it has updated): if the app opens
      // after dark, the evening round was done before we arrived
      if (time === 0 && gloom > 0.5) for (let i = 0; i < n; i++) if (!want[i]) { want[i] = 1; litArr[i] = 1; aLit.needsUpdate = true; }
      time += dt;
      uFlick.value = flicker;
      haloMat.uniforms.uFog.value = Math.min(1, (ctx.reg.atmosphere?.fog ?? 0) * 1.3);
      // fallback timers (sim minutes)
      gloomMin = gloom > 0.5 ? gloomMin + dtSim : 0;
      // (in the evening the lamplighters are out before the gloom deepens: their lamps are not doused as 'daylight')
      const eveningH = ctx.clock.hour > 16 && ctx.clock.hour < 23.9;
      for (let i = 0; i < n; i++) {
        if (!manual) { want[i] = gloom > 0.45 ? 1 : 0; continue; }
        // backstop only: give the lamplighters' rounds (≈ 1 h at walking pace) first go at the evening lamps
        // lamps in plain view near the focus wait longer (their lamplighter is on the way); the rest, off-screen or far
        // off, come on one by one over ~20 min instead of the whole station lighting at once
        const seen = ctx.view && ctx.view.isVisible(infos[i].pos, 5) && ctx.view.distToFocus(infos[i].pos.x, infos[i].pos.z) < 130 ? 25 : 0;
        if (!want[i] && (gloom > 0.85 ? gloomMin > 30 + stagger[i] + seen : gloomMin > 50 + stagger[i] + seen)) {
          want[i] = 1; byHand[i] = 0; ctx.bus.emit('lamp:lit', { index: i, on: true });
        }
        dayMinI[i] = want[i] && gloom < 0.3 ? dayMinI[i] + dtSim : 0;
        if (want[i] && dayMinI[i] > (eveningH ? 90 : 40) + stagger[i] + (ctx.view && ctx.view.isVisible(infos[i].pos, 5) ? 20 : 0)) { want[i] = 0; byHand[i] = 0; ctx.bus.emit('lamp:lit', { index: i, on: false }); }
      }
      // ease lit levels (~1 s), claim lights
      let changed = false, sum = 0;
      for (let i = 0; i < n; i++) {
        const t = want[i], c = litArr[i];
        if (c !== t) {
          const d = t - c;
          litArr[i] = Math.abs(d) < dt * 1.2 ? t : c + Math.sign(d) * dt * 1.2;
          changed = true;
        }
        if (i < st.length) sum += litArr[i];
        const lv = litArr[i] * flicker;
        if (claim && lv > 0.02) {
          const p = infos[i].pos;
          const f = 0.93 + 0.07 * Math.sin(time * 11 + i * 2.1) * Math.sin(time * 4.3 + i);
          lightPos.set(p.x, p.y + GLASS_Y, p.z);
          ctx.lights.claim(`lamp${i}`, lightPos, col, 38 * lv * f, 18, i < st.length ? 1 : 0.5);
        }
      }
      stationLevel = sum / Math.max(1, st.length);
      if (changed) aLit.needsUpdate = true;
      void wm;
    },
  };
  return api;
}

/** 0..1 "dark enough for lamps": atmosphere.gloom when it is driven, else the v1 night/fog/storm target */
export function gloomNow(ctx: Ctx): number {
  const a = ctx.reg.atmosphere;
  if (!a) return 0;
  const night = THREE.MathUtils.smoothstep(a.nightFactor ?? 0, 0.3, 0.65);
  const fog = (a.fog ?? 0) > 0.35 ? 0.85 * THREE.MathUtils.smoothstep(a.fog, 0.35, 0.7) : 0;
  const storm = a.weather === 'storm' ? 0.65 : (a.rain ?? 0) > 0.6 ? 0.4 : 0;
  return Math.max(a.gloom ?? 0, night, fog, storm);
}
