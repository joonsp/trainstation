import * as THREE from 'three';
import { buildRigGeometry, type RigPart } from '../core/rig';
import { bx, cyl, NAT_GLSL_COMMON } from './util';

/**
 * NATURE RIGS — geometry + vertex-shader poses for the InstancedRig pattern (core/rig.ts). Several species share
 * one draw call: every part id encodes `kind * STRIDE + sub`, the instance's kind is in `aux.w`, and parts of
 * other kinds collapse to a degenerate point (never rasterised). Continuous "idle life" (breathing, tail swish,
 * ear flicks, head sway, bobbing boats) runs in the shader from uNatTime + a per-instance seed, so nothing alive
 * is ever frozen even when the CPU state is idle.
 *
 * Local frame: +x forward, y up, origin on the ground (water line for swimmers/boats) under the body centre.
 */

type Slot = 0 | 1 | 2 | 3;
class PartList {
  parts: RigPart[] = [];
  add(geo: THREE.BufferGeometry, part: number, pivot: THREE.Vector3 | [number, number, number], slot: Slot): this {
    this.parts.push({ geo, part, pivot: Array.isArray(pivot) ? new THREE.Vector3(...pivot) : pivot, slot });
    return this;
  }
}

// ───────────────────────── quadrupeds: sheep (0), cow (1), dog (2) ─────────────────────────
export const QUAD = { sheep: 0, cow: 1, dog: 2 } as const;
const QS = 10;
/** sub ids */
const Q = { body: 0, head: 1, fl: 2, fr: 3, hl: 4, hr: 5, tail: 6 } as const;

export function quadGeometry(): THREE.BufferGeometry {
  const P = new PartList();
  // sheep
  {
    const k = QUAD.sheep * QS, bp: [number, number, number] = [0, 0.7, 0];
    P.add(bx(1.0, 0.56, 0.66, 0, 0.74, 0), k + Q.body, bp, 0)
      .add(bx(0.78, 0.2, 0.54, -0.02, 1.06, 0), k + Q.body, bp, 0)
      .add(bx(0.3, 0.5, 0.6, -0.5, 0.76, 0), k + Q.body, bp, 0)
      .add(bx(0.26, 0.42, 0.56, 0.46, 0.8, 0), k + Q.body, bp, 0);
    const hp: [number, number, number] = [0.5, 0.92, 0];
    P.add(bx(0.34, 0.26, 0.24, 0.72, 0.96, 0, -0.3), k + Q.head, hp, 1)
      .add(bx(0.2, 0.2, 0.3, 0.6, 1.04, 0), k + Q.head, hp, 0)
      .add(bx(0.06, 0.05, 0.16, 0.62, 1.04, 0.2, 0, 0.4), k + Q.head, hp, 1)
      .add(bx(0.06, 0.05, 0.16, 0.62, 1.04, -0.2, 0, -0.4), k + Q.head, hp, 1);
    for (const [id, x, z] of [[Q.fl, 0.34, 0.17], [Q.fr, 0.34, -0.17], [Q.hl, -0.34, 0.17], [Q.hr, -0.34, -0.17]] as const) {
      P.add(bx(0.1, 0.5, 0.1, x, 0.25, z), k + id, [x, 0.5, z], 1);
    }
    P.add(bx(0.12, 0.26, 0.12, -0.66, 0.74, 0, 0.3), k + Q.tail, [-0.62, 0.88, 0], 0);
  }
  // cow
  {
    const k = QUAD.cow * QS, bp: [number, number, number] = [0, 1.05, 0];
    P.add(bx(1.7, 0.78, 0.74, 0, 1.08, 0), k + Q.body, bp, 0)
      .add(bx(0.4, 0.86, 0.76, 0.72, 1.1, 0), k + Q.body, bp, 0)
      .add(bx(0.4, 0.84, 0.78, -0.72, 1.12, 0), k + Q.body, bp, 0)
      .add(bx(0.64, 0.5, 0.755, 0.05, 1.18, 0), k + Q.body, bp, 1)
      .add(bx(0.34, 0.4, 0.785, -0.62, 1.2, 0), k + Q.body, bp, 1)
      .add(bx(0.36, 0.16, 0.3, -0.38, 0.62, 0), k + Q.body, bp, 3);
    const hp: [number, number, number] = [0.92, 1.28, 0];
    P.add(bx(0.4, 0.46, 0.36, 1.06, 1.3, 0, -0.25), k + Q.head, hp, 0)
      .add(bx(0.46, 0.34, 0.32, 1.32, 1.28, 0, -0.5), k + Q.head, hp, 0)
      .add(bx(0.18, 0.2, 0.3, 1.52, 1.12, 0, -0.5), k + Q.head, hp, 2)
      .add(bx(0.07, 0.07, 0.62, 1.18, 1.56, 0), k + Q.head, hp, 2)
      .add(bx(0.12, 0.08, 0.2, 1.14, 1.46, 0.28, 0, 0.3), k + Q.head, hp, 0)
      .add(bx(0.12, 0.08, 0.2, 1.14, 1.46, -0.28, 0, -0.3), k + Q.head, hp, 0);
    for (const [id, x, z] of [[Q.fl, 0.64, 0.24], [Q.fr, 0.64, -0.24], [Q.hl, -0.64, 0.24], [Q.hr, -0.64, -0.24]] as const) {
      P.add(bx(0.18, 0.64, 0.18, x, 0.4, z), k + id, [x, 0.72, z], 0)
        .add(bx(0.19, 0.1, 0.19, x, 0.05, z), k + id, [x, 0.72, z], 2);
    }
    P.add(bx(0.07, 0.78, 0.07, -0.9, 0.98, 0), k + Q.tail, [-0.9, 1.38, 0], 0)
      .add(bx(0.12, 0.16, 0.12, -0.9, 0.56, 0), k + Q.tail, [-0.9, 1.38, 0], 1);
  }
  // dog (collie)
  {
    const k = QUAD.dog * QS, bp: [number, number, number] = [0, 0.5, 0];
    P.add(bx(0.66, 0.28, 0.26, 0, 0.52, 0), k + Q.body, bp, 0)
      .add(bx(0.24, 0.34, 0.3, 0.3, 0.52, 0), k + Q.body, bp, 1);
    const hp: [number, number, number] = [0.38, 0.62, 0];
    P.add(bx(0.26, 0.22, 0.2, 0.5, 0.72, 0), k + Q.head, hp, 0)
      .add(bx(0.18, 0.1, 0.12, 0.68, 0.66, 0), k + Q.head, hp, 1)
      .add(bx(0.06, 0.12, 0.05, 0.46, 0.86, 0.06), k + Q.head, hp, 0)
      .add(bx(0.06, 0.12, 0.05, 0.46, 0.86, -0.06), k + Q.head, hp, 0);
    for (const [id, x, z] of [[Q.fl, 0.24, 0.09], [Q.fr, 0.24, -0.09], [Q.hl, -0.24, 0.09], [Q.hr, -0.24, -0.09]] as const) {
      P.add(bx(0.08, 0.4, 0.08, x, 0.2, z), k + id, [x, 0.4, z], 1);
    }
    P.add(bx(0.38, 0.08, 0.08, -0.5, 0.46, 0, 0.6), k + Q.tail, [-0.32, 0.56, 0], 0)
      .add(bx(0.1, 0.08, 0.08, -0.66, 0.34, 0, 0.6), k + Q.tail, [-0.32, 0.56, 0], 1);
  }
  return buildRigGeometry(P.parts);
}

/**
 * anim = (gaitPhase, gaitAmp 0 stand · 0.5 walk · 1 trot/run, head 0 level · 1 grazing (−1 look up), tail excitement 0..1)
 * aux  = (lie 0..1, headTurn −1..1, sit 0..1 (dog), kind)
 */
export const QUAD_GLSL = NAT_GLSL_COMMON + /* glsl */ `
void rigPose(float part, vec3 pivot, vec4 anim, vec4 aux, inout vec3 p) {
  float kindOf = floor((part + 0.5) / ${QS}.0);
  if (abs(kindOf - aux.w) > 0.5) { p = vec3(0.0); return; }
  int sub = int(part - kindOf * ${QS}.0 + 0.5);
  float sd = natSeed(), t = uNatTime;
  float ph = anim.x, amp = anim.y, lie = clamp(aux.x, 0.0, 1.0);
  float isDog = step(1.5, aux.w), isCow = step(0.5, aux.w) * (1.0 - isDog);
  float drop = mix(mix(0.36, 0.62, isCow), 0.26, isDog);
  if (sub >= 2 && sub <= 5) {
    float off = sub == 2 ? 0.25 : sub == 3 ? 0.75 : sub == 4 ? 0.0 : 0.5;
    float trot = clamp(amp * 2.0 - 1.0, 0.0, 1.0);
    off = mix(off, (sub == 2 || sub == 5) ? 0.0 : 0.5, trot) * 6.2831853;
    float sw = min(amp, 1.3) * 0.5 * sin(ph + off);
    float front = (sub <= 3) ? 1.0 : -1.0;
    float fold = lie * 1.45 * front;
    float sit = (sub >= 4) ? aux.z * 1.2 : 0.0;
    p = rigAbout(p, pivot, vec3(0.0, 0.0, sw - fold + sit));
    p.y += max(0.0, cos(ph + off)) * min(amp, 1.2) * 0.07;
  } else if (sub == 1) {
    float graze = clamp(anim.z, -1.0, 1.0);
    float chew = graze > 0.5 ? 0.05 * sin(t * 7.0 + sd * 9.0) : 0.0;
    float look = aux.y * 0.7 + 0.18 * sin(t * 0.37 + sd * 17.0) * (1.0 - clamp(graze, 0.0, 1.0));
    float ear = 0.06 * step(0.93, natNoise(t * 0.8 + sd * 40.0));
    float pitch = -(graze * 0.95) - chew + ear + 0.04 * sin(t * 1.9 + sd * 5.0) - lie * 0.15;
    p = rigAbout(p, pivot, vec3(0.0, look, pitch));
  } else if (sub == 6) {
    float ex = clamp(anim.w, 0.0, 1.0);
    float swish = (0.25 + 0.6 * ex) * sin(t * (2.6 + 9.0 * ex * isDog + 2.0 * ex) + sd * 6.2831) * (0.35 + 0.65 * natNoise(t * 0.45 + sd * 11.0));
    p = rigAbout(p, pivot, vec3(swish, swish * 0.3, 0.1 * ex * isDog));
  } else {
    // body: breathing
    float br = 1.0 + 0.018 * sin(t * (1.6 + sd) + sd * 20.0);
    p = pivot + (p - pivot) * vec3(1.0, br, br);
  }
  // dog sitting: pitch the whole animal up about the hips
  if (isDog > 0.5 && aux.z > 0.01) p = rigAbout(p, vec3(-0.26, 0.2, 0.0), vec3(0.0, 0.0, aux.z * 0.55));
  p.y -= lie * drop;
  p.y += min(anim.y, 1.2) * 0.03 * sin(ph * 2.0);
}`;

// ───────────────────────── fowl: duck 0, swan 1, goose 2, hen 3, heron 4, fish 5, duckling 6 ─────────────────────────
export const FOWL = { duck: 0, swan: 1, goose: 2, hen: 3, heron: 4, fish: 5, duckling: 6 } as const;
const FS = 10;
const F = { body: 0, head: 1, wingL: 2, wingR: 3, legs: 4, tail: 5 } as const;

export function fowlGeometry(): THREE.BufferGeometry {
  const P = new PartList();
  const wings = (k: number, x: number, y: number, z: number, len: number, span: number) => {
    // plates hanging against the body side, hinge at the shoulder (x, y, ±z); spread by rotating about +x
    P.add(bx(len, span, 0.03, x, y - span / 2, z), k + F.wingL, [x, y, z], 0);
    P.add(bx(len, span, 0.03, x, y - span / 2, -z), k + F.wingR, [x, y, -z], 0);
  };
  { // duck (origin at the water line)
    const k = FOWL.duck * FS;
    P.add(bx(0.4, 0.16, 0.22, 0, 0.06, 0), k + F.body, [0, 0.06, 0], 0)
      .add(bx(0.14, 0.1, 0.14, -0.2, 0.1, 0, 0.5), k + F.tail, [-0.16, 0.08, 0], 0);
    P.add(bx(0.06, 0.16, 0.08, 0.16, 0.18, 0), k + F.head, [0.15, 0.12, 0], 1)
      .add(bx(0.13, 0.11, 0.1, 0.2, 0.27, 0), k + F.head, [0.15, 0.12, 0], 1)
      .add(bx(0.09, 0.03, 0.07, 0.3, 0.25, 0), k + F.head, [0.15, 0.12, 0], 2);
    wings(k, 0.0, 0.13, 0.115, 0.26, 0.12);
    P.add(bx(0.04, 0.1, 0.12, 0.02, -0.02, 0), k + F.legs, [0.02, 0.04, 0], 2);
  }
  { // swan
    const k = FOWL.swan * FS;
    P.add(bx(0.78, 0.26, 0.4, 0, 0.1, 0), k + F.body, [0, 0.1, 0], 0)
      .add(bx(0.3, 0.2, 0.34, -0.4, 0.2, 0, 0.45), k + F.tail, [-0.34, 0.16, 0], 0);
    const hp: [number, number, number] = [0.3, 0.18, 0];
    P.add(bx(0.1, 0.36, 0.1, 0.36, 0.38, 0, 0.35), k + F.head, hp, 0)
      .add(bx(0.1, 0.3, 0.1, 0.36, 0.64, 0, -0.2), k + F.head, hp, 0)
      .add(bx(0.16, 0.1, 0.1, 0.43, 0.8, 0), k + F.head, hp, 0)
      .add(bx(0.13, 0.05, 0.07, 0.55, 0.77, 0), k + F.head, hp, 2)
      .add(bx(0.05, 0.06, 0.08, 0.5, 0.81, 0), k + F.head, hp, 3);
    wings(k, 0.05, 0.24, 0.2, 0.55, 0.22);
    P.add(bx(0.06, 0.1, 0.2, 0.0, -0.05, 0), k + F.legs, [0, 0.0, 0], 3);
  }
  { // goose (on land: legs 0.2)
    const k = FOWL.goose * FS;
    P.add(bx(0.52, 0.24, 0.3, 0, 0.36, 0), k + F.body, [0, 0.36, 0], 0)
      .add(bx(0.16, 0.14, 0.24, -0.28, 0.42, 0, 0.4), k + F.tail, [-0.24, 0.4, 0], 0);
    const hp: [number, number, number] = [0.22, 0.44, 0];
    P.add(bx(0.08, 0.3, 0.08, 0.26, 0.6, 0, -0.15), k + F.head, hp, 1)
      .add(bx(0.14, 0.09, 0.09, 0.32, 0.76, 0), k + F.head, hp, 1)
      .add(bx(0.1, 0.04, 0.06, 0.42, 0.74, 0), k + F.head, hp, 2);
    wings(k, 0.02, 0.46, 0.155, 0.36, 0.16);
    P.add(bx(0.04, 0.24, 0.04, 0.02, 0.12, 0.07), k + F.legs, [0.02, 0.24, 0.07], 2)
      .add(bx(0.04, 0.24, 0.04, 0.02, 0.12, -0.07), k + F.legs, [0.02, 0.24, -0.07], 2);
  }
  { // hen
    const k = FOWL.hen * FS;
    P.add(bx(0.3, 0.24, 0.22, 0, 0.3, 0), k + F.body, [0, 0.3, 0], 0)
      .add(bx(0.12, 0.2, 0.16, -0.16, 0.42, 0, 0.5), k + F.tail, [-0.12, 0.36, 0], 1);
    const hp: [number, number, number] = [0.12, 0.38, 0];
    P.add(bx(0.12, 0.13, 0.1, 0.16, 0.47, 0), k + F.head, hp, 0)
      .add(bx(0.08, 0.06, 0.03, 0.15, 0.56, 0), k + F.head, hp, 3)
      .add(bx(0.06, 0.03, 0.04, 0.24, 0.46, 0), k + F.head, hp, 2);
    wings(k, 0.0, 0.38, 0.115, 0.2, 0.14);
    P.add(bx(0.03, 0.2, 0.03, 0.02, 0.1, 0.05), k + F.legs, [0.02, 0.2, 0.05], 2)
      .add(bx(0.03, 0.2, 0.03, 0.02, 0.1, -0.05), k + F.legs, [0.02, 0.2, -0.05], 2);
  }
  { // heron (stands in the shallows; origin at the water line / ground)
    const k = FOWL.heron * FS;
    P.add(bx(0.46, 0.24, 0.22, 0, 0.98, 0, 0.35), k + F.body, [0, 0.98, 0], 0)
      .add(bx(0.2, 0.1, 0.18, -0.26, 0.86, 0, 0.5), k + F.tail, [-0.2, 0.9, 0], 0);
    const hp: [number, number, number] = [0.18, 1.1, 0];
    P.add(bx(0.06, 0.34, 0.06, 0.22, 1.26, 0, -0.35), k + F.head, hp, 3)
      .add(bx(0.06, 0.24, 0.06, 0.3, 1.46, 0, 0.5), k + F.head, hp, 3)
      .add(bx(0.12, 0.08, 0.08, 0.28, 1.6, 0), k + F.head, hp, 0)
      .add(bx(0.24, 0.035, 0.035, 0.46, 1.59, 0), k + F.head, hp, 2)
      .add(bx(0.14, 0.03, 0.02, 0.18, 1.64, 0), k + F.head, hp, 1);
    wings(k, 0.02, 1.08, 0.12, 0.44, 0.8);
    P.add(bx(0.03, 0.9, 0.03, 0.0, 0.45, 0.05), k + F.legs, [0.0, 0.9, 0.05], 2)
      .add(bx(0.03, 0.9, 0.03, 0.0, 0.45, -0.05), k + F.legs, [0.0, 0.9, -0.05], 2);
  }
  { // fish (jumps: CPU pitches the instance along the arc)
    const k = FOWL.fish * FS;
    P.add(bx(0.34, 0.1, 0.06, 0, 0, 0), k + F.body, [0, 0, 0], 0)
      .add(bx(0.1, 0.14, 0.02, -0.2, 0, 0), k + F.tail, [-0.16, 0, 0], 1);
  }
  { // duckling
    const k = FOWL.duckling * FS;
    P.add(bx(0.16, 0.08, 0.1, 0, 0.03, 0), k + F.body, [0, 0.03, 0], 0)
      .add(bx(0.08, 0.08, 0.07, 0.07, 0.1, 0), k + F.head, [0.06, 0.06, 0], 0)
      .add(bx(0.04, 0.02, 0.03, 0.12, 0.09, 0), k + F.head, [0.06, 0.06, 0], 2);
  }
  return buildRigGeometry(P.parts);
}

/**
 * anim = (walk/paddle phase, walkAmp, headDip 0..1 (dabble / peck / strike), flap 0 folded .. 1 flying)
 * aux  = (neckStretch 0..1 (heron strike, goose hiss), headTurn −1..1, onWater 0..1 (hides legs, bobs), kind)
 */
export const FOWL_GLSL = NAT_GLSL_COMMON + /* glsl */ `
void rigPose(float part, vec3 pivot, vec4 anim, vec4 aux, inout vec3 p) {
  float kindOf = floor((part + 0.5) / ${FS}.0);
  if (abs(kindOf - aux.w) > 0.5) { p = vec3(0.0); return; }
  int sub = int(part - kindOf * ${FS}.0 + 0.5);
  float sd = natSeed(), t = uNatTime;
  float ph = anim.x, amp = anim.y, flap = clamp(anim.w, 0.0, 1.0), water = clamp(aux.z, 0.0, 1.0);
  if (sub == ${F.head}) {
    float dip = clamp(anim.z, 0.0, 1.0);
    float look = aux.y * 0.8 + 0.3 * (natNoise(t * 0.9 + sd * 23.0) - 0.5);
    float bob = amp * 0.12 * sin(ph * 2.0) * (1.0 - water);
    float stretch = aux.x;
    p = rigAbout(p, pivot, vec3(0.0, look, -dip * 1.35 + bob + stretch * 0.55));
    p += vec3(stretch * 0.22, stretch * 0.08, 0.0);
  } else if (sub == ${F.wingL} || sub == ${F.wingR}) {
    float sgn = sub == ${F.wingL} ? 1.0 : -1.0;
    float beat = sin(t * (7.0 - 3.5 * step(3.5, aux.w)) + sd * 6.28);
    float a = flap * (1.35 + 0.75 * beat) + 0.06 * step(0.96, natNoise(t * 0.6 + sd * 31.0));
    p = rigAbout(p, pivot, vec3(sgn * -a, 0.0, 0.0));
  } else if (sub == ${F.legs}) {
    if (water > 0.5 && aux.w != ${FOWL.heron}.0) { p = pivot + (p - pivot) * 0.4; p.y -= 0.02; }
    else {
      float sw = amp * 0.5 * sin(ph + (p.z > 0.0 ? 0.0 : 3.14159));
      p = rigAbout(p, pivot, vec3(0.0, 0.0, sw - flap * 1.2));
    }
  } else if (sub == ${F.tail}) {
    float wag = 0.25 * sin(t * 5.0 + sd * 9.0) * step(0.8, natNoise(t * 0.7 + sd * 13.0));
    p = rigAbout(p, pivot, vec3(0.0, wag, 0.0));
  } else {
    float br = 1.0 + 0.03 * sin(t * 2.3 + sd * 11.0);
    p = pivot + (p - pivot) * vec3(1.0, br, br);
  }
  // swimmers bob and waddle; walkers bob with the step
  p.y += water * 0.012 * sin(t * 1.7 + sd * 30.0) + (1.0 - water) * amp * 0.02 * abs(sin(ph));
  if (water < 0.5) p = rigAbout(p, vec3(0.0), vec3(amp * 0.08 * sin(ph), 0.0, 0.0));
}`;

// ───────────────────────── flying birds (one shape; kinds by scale & colour) ─────────────────────────
export function birdGeometry(): THREE.BufferGeometry {
  const P = new PartList();
  P.add(bx(0.32, 0.09, 0.1, 0, 0, 0), 0, [0, 0, 0], 0)
    .add(bx(0.1, 0.08, 0.08, 0.19, 0.03, 0), 0, [0, 0, 0], 0)
    .add(bx(0.05, 0.02, 0.03, 0.26, 0.02, 0), 0, [0, 0, 0], 2)
    .add(bx(0.16, 0.02, 0.14, -0.22, 0.01, 0), 3, [-0.14, 0.01, 0], 0);
  // wings as plates spanning ±z, hinge at the body side
  P.add(bx(0.18, 0.015, 0.34, 0.02, 0.03, 0.2), 1, [0.02, 0.03, 0.05], 1)
    .add(bx(0.18, 0.015, 0.34, 0.02, 0.03, -0.2), 2, [0.02, 0.03, -0.05], 1);
  return buildRigGeometry(P.parts);
}
/**
 * anim = (flapFreq Hz, flapAmp 0..1, grounded 0..1 (wings folded, hops/pecks), bank −1..1)
 * aux  = (peck 0..1, _, _, _)
 */
export const BIRD_GLSL = NAT_GLSL_COMMON + /* glsl */ `
void rigPose(float part, vec3 pivot, vec4 anim, vec4 aux, inout vec3 p) {
  float sd = natSeed(), t = uNatTime;
  int id = int(part + 0.5);
  float g = clamp(anim.z, 0.0, 1.0);
  if (id == 1 || id == 2) {
    float sgn = id == 1 ? 1.0 : -1.0;
    float beat = sin(t * anim.x * 6.2831853 + sd * 6.2831853);
    float a = mix(anim.y * 0.9 * beat + 0.08, 1.4 + 0.1 * sin(t * 3.0 + sd * 20.0) * step(0.9, natNoise(t + sd * 9.0)), g);
    p = rigAbout(p, pivot, vec3(sgn * a, 0.0, 0.0));
    if (g > 0.5) p = pivot + (p - pivot) * vec3(1.0, 1.0, 0.45);
  } else if (id == 3) {
    p = rigAbout(p, pivot, vec3(0.0, 0.0, 0.25 * g + 0.1 * sin(t * 2.0 + sd * 7.0)));
  }
  if (g > 0.01) {
    float pk = clamp(aux.x, 0.0, 1.0) * abs(sin(t * 5.0 + sd * 13.0));
    p = rigAbout(p, vec3(0.0), vec3(0.0, 0.0, -pk * 0.6 * g + 0.15 * g));
    p.y += 0.05 * g;
  }
  p = rigAbout(p, vec3(0.0), vec3(anim.w * 0.6, 0.0, 0.0));
}`;

// ───────────────────────── boats: rowing 0, gig4 1, launch 2, narrowboat 3, punt 4 ─────────────────────────
export const BOATK = { rowing: 0, gig4: 1, launch: 2, narrowboat: 3, punt: 4 } as const;
const BS = 20;
export const BSUB = { hull: 0, rim: 1, floor: 2, detail: 3, oar0: 4, funnel: 12, glow: 13, pole: 14, towline: 15 } as const;

/** a simple hull: stations along x with a pointed bow; exterior slot 0, rim slot 1, floor slot 2 */
function hull(P: PartList, part: number, len: number, beam: number, depth: number, opts: { transom?: number; bowRise?: number; floorY?: number; flat?: boolean } = {}) {
  const N = 9;
  const st: { x: number; b: number; top: number }[] = [];
  const transom = opts.transom ?? 0.6, rise = opts.bowRise ?? 0.12;
  for (let i = 0; i <= N; i++) {
    const u = i / N; // 0 stern .. 1 bow
    const x = -len / 2 + len * u;
    let b: number;
    if (opts.flat) b = beam / 2 * (u < 0.06 || u > 0.94 ? 0.85 : 1);
    else b = beam / 2 * Math.max(0.04, Math.min(1, (u < 0.5 ? transom + (1 - transom) * Math.sin(Math.PI * u) : Math.cos((u - 0.5) * Math.PI * 0.98) ** 0.8)));
    st.push({ x, b, top: depth + rise * (u > 0.6 ? ((u - 0.6) / 0.4) ** 2 : 0) + rise * 0.4 * (u < 0.15 ? (0.15 - u) / 0.15 : 0) });
  }
  const pos: number[] = [], rim: number[] = [], flo: number[] = [];
  const q = (arr: number[], a: number[], b: number[], c: number[], d: number[]) => { arr.push(...a, ...b, ...c, ...a, ...c, ...d); };
  const bottom = opts.flat ? 0.0 : -0.06;
  for (let i = 0; i < N; i++) {
    const A = st[i], B = st[i + 1];
    for (const s of [1, -1]) {
      const cA = A.b * (opts.flat ? 1 : 0.72), cB = B.b * (opts.flat ? 1 : 0.72);
      // side (gunwale → chine) and bottom (chine → keel), wound outward
      const g0 = [A.x, A.top, s * A.b], g1 = [B.x, B.top, s * B.b], c0 = [A.x, 0.06, s * cA], c1 = [B.x, 0.06, s * cB];
      const k0 = [A.x, bottom, 0], k1 = [B.x, bottom, 0];
      if (s > 0) { q(pos, g0, c0, c1, g1); q(pos, c0, k0, k1, c1); } else { q(pos, g0, g1, c1, c0); q(pos, c0, c1, k1, k0); }
      // rim band (inner lip)
      const i0 = [A.x, A.top, s * Math.max(0, A.b - 0.07)], i1 = [B.x, B.top, s * Math.max(0, B.b - 0.07)];
      if (s > 0) q(rim, g0, g1, i1, i0); else q(rim, g0, i0, i1, g1);
      // floor
      const fy = opts.floorY ?? depth * 0.35;
      const f0 = [A.x, fy, s * A.b * 0.8], f1 = [B.x, fy, s * B.b * 0.8], m0 = [A.x, fy, 0], m1 = [B.x, fy, 0];
      if (s > 0) q(flo, m0, m1, f1, f0); else q(flo, m0, f0, f1, m1);
    }
  }
  // transom (stern face)
  const S = st[0];
  q(pos, [S.x, S.top, -S.b], [S.x, S.top, S.b], [S.x, 0.06, S.b * 0.72], [S.x, 0.06, -S.b * 0.72]);
  const mk = (arr: number[]) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); g.computeVertexNormals(); return g; };
  P.add(mk(pos), part + BSUB.hull, [0, 0, 0], 0);
  P.add(mk(rim), part + BSUB.rim, [0, 0, 0], 1);
  P.add(mk(flo), part + BSUB.floor, [0, 0, 0], 2);
}

export interface BoatDims { len: number; beam: number; depth: number; seats: THREE.Vector3[]; oars: { x: number; z: number; len: number }[]; mast?: THREE.Vector3; funnel?: THREE.Vector3; chimney?: THREE.Vector3; lamp?: THREE.Vector3; air: number }
export const BOAT_DIMS: Record<number, BoatDims> = {
  [BOATK.rowing]: { len: 4.2, beam: 1.3, depth: 0.45, seats: [new THREE.Vector3(0.1, 0.22, 0), new THREE.Vector3(-1.4, 0.22, 0), new THREE.Vector3(1.35, 0.22, 0)], oars: [{ x: 0.35, z: 0.62, len: 2.6 }, { x: 0.35, z: -0.62, len: 2.6 }], air: 1.2 },
  [BOATK.gig4]: { len: 9.0, beam: 0.85, depth: 0.36, seats: [new THREE.Vector3(2.4, 0.15, 0), new THREE.Vector3(1.0, 0.15, 0), new THREE.Vector3(-0.4, 0.15, 0), new THREE.Vector3(-1.8, 0.15, 0), new THREE.Vector3(-3.6, 0.15, 0)], oars: [{ x: 2.7, z: 0.42, len: 3.4 }, { x: 1.3, z: -0.42, len: 3.4 }, { x: -0.1, z: 0.42, len: 3.4 }, { x: -1.5, z: -0.42, len: 3.4 }], air: 1.2 },
  [BOATK.launch]: { len: 7.2, beam: 1.9, depth: 0.85, seats: [new THREE.Vector3(-2.6, 0.55, 0), new THREE.Vector3(-1.4, 0.45, 0.5), new THREE.Vector3(-1.4, 0.45, -0.5), new THREE.Vector3(-0.4, 0.45, 0.5), new THREE.Vector3(-0.4, 0.45, -0.5), new THREE.Vector3(1.4, 0.45, 0)], oars: [], funnel: new THREE.Vector3(0.7, 2.7, 0), lamp: new THREE.Vector3(3.2, 1.3, 0), air: 2.9 },
  [BOATK.narrowboat]: { len: 14, beam: 2.0, depth: 0.8, seats: [new THREE.Vector3(-6.4, 0.75, 0)], oars: [], mast: new THREE.Vector3(1.6, 2.2, 0), chimney: new THREE.Vector3(-2.2, 2.35, 0.5), lamp: new THREE.Vector3(-0.7, 1.9, 0.95), air: 2.3 },
  [BOATK.punt]: { len: 6.2, beam: 1.1, depth: 0.32, seats: [new THREE.Vector3(-2.5, 0.3, 0), new THREE.Vector3(0.6, 0.18, 0.2), new THREE.Vector3(1.4, 0.18, -0.15)], oars: [], air: 1.9 },
};

export function boatGeometry(): THREE.BufferGeometry {
  const P = new PartList();
  const oar = (k: number, i: number, x: number, z: number, len: number, y: number) => {
    const s = Math.sign(z);
    // loom from the rowlock outward, blade at the tip (slot 3)
    P.add(bx(0.06, 0.06, len * 0.8, x, y, z + s * len * 0.3), k + BSUB.oar0 + i, [x, y, z], 1);
    P.add(bx(0.18, 0.03, len * 0.22, x, y, z + s * len * 0.78), k + BSUB.oar0 + i, [x, y, z], 3);
  };
  { // rowing boat
    const k = BOATK.rowing * BS, d = BOAT_DIMS[BOATK.rowing];
    hull(P, k, d.len, d.beam, d.depth, { transom: 0.65 });
    P.add(bx(0.24, 0.05, d.beam * 0.9, 0.1, 0.3, 0), k + BSUB.detail, [0, 0, 0], 1)
      .add(bx(0.24, 0.05, d.beam * 0.85, -1.35, 0.3, 0), k + BSUB.detail, [0, 0, 0], 1)
      .add(bx(0.24, 0.05, d.beam * 0.7, 1.35, 0.32, 0), k + BSUB.detail, [0, 0, 0], 1);
    d.oars.forEach((o, i) => oar(k, i, o.x, o.z, o.len, d.depth + 0.04));
  }
  { // gig four
    const k = BOATK.gig4 * BS, d = BOAT_DIMS[BOATK.gig4];
    hull(P, k, d.len, d.beam, d.depth, { transom: 0.3, bowRise: 0.05 });
    for (const s of d.seats) P.add(bx(0.22, 0.04, d.beam * 0.7, s.x, 0.2, 0), k + BSUB.detail, [0, 0, 0], 1);
    d.oars.forEach((o, i) => { P.add(bx(0.06, 0.06, 0.5, o.x, d.depth + 0.05, Math.sign(o.z) * 0.62), k + BSUB.detail, [0, 0, 0], 1); oar(k, i, o.x, Math.sign(o.z) * 0.86, o.len, d.depth + 0.06); });
  }
  { // steam launch "Kingfisher"
    const k = BOATK.launch * BS, d = BOAT_DIMS[BOATK.launch];
    hull(P, k, d.len, d.beam, d.depth, { transom: 0.55, bowRise: 0.18, floorY: 0.42 });
    // canopy on 4 posts, cushions, boiler casing
    for (const [x, z] of [[-3.0, 0.78], [-3.0, -0.78], [0.2, 0.78], [0.2, -0.78]] as const) P.add(bx(0.06, 1.3, 0.06, x, 1.3, z), k + BSUB.rim, [0, 0, 0], 1);
    P.add(bx(3.5, 0.08, 1.8, -1.4, 1.98, 0), k + BSUB.detail, [0, 0, 0], 3)
      .add(bx(3.3, 0.18, 0.3, -1.5, 0.55, 0.62), k + BSUB.floor, [0, 0, 0], 2)
      .add(bx(3.3, 0.18, 0.3, -1.5, 0.55, -0.62), k + BSUB.floor, [0, 0, 0], 2)
      .add(bx(1.0, 0.8, 1.0, 0.7, 0.8, 0), k + BSUB.detail, [0, 0, 0], 1);
    // funnel (hinges back at bridges) with a brass band
    const fp: [number, number, number] = [0.7, 1.2, 0];
    P.add(cyl(0.16, 0.18, 1.5, 7, 0.7, 1.95, 0), k + BSUB.funnel, fp, 0)
      .add(cyl(0.2, 0.2, 0.12, 7, 0.7, 2.62, 0), k + BSUB.funnel, fp, 1);
    P.add(bx(0.16, 0.2, 0.16, d.lamp!.x, d.lamp!.y, 0), k + BSUB.glow, [0, 0, 0], 1);
  }
  { // narrowboat
    const k = BOATK.narrowboat * BS, d = BOAT_DIMS[BOATK.narrowboat];
    hull(P, k, d.len, d.beam, d.depth, { transom: 0.8, bowRise: 0.25, floorY: 0.5 });
    // stern cabin (slot 1 green) + roof (slot 2) + cream band (slot 3)
    P.add(bx(6.0, 1.0, 1.8, -3.4, 1.3, 0), k + BSUB.detail, [0, 0, 0], 1)
      .add(bx(6.2, 0.1, 1.9, -3.4, 1.85, 0), k + BSUB.floor, [0, 0, 0], 2)
      .add(bx(6.05, 0.16, 1.83, -3.4, 1.6, 0), k + BSUB.detail, [0, 0, 0], 3)
      // cargo hold: tarpaulin ridge + stands
      .add(bx(6.6, 0.55, 1.7, 2.8, 1.05, 0), k + BSUB.floor, [0, 0, 0], 2)
      .add(bx(6.6, 0.14, 1.1, 2.8, 1.38, 0), k + BSUB.floor, [0, 0, 0], 2)
      .add(bx(0.12, 1.45, 0.12, d.mast!.x, 1.5, 0), k + BSUB.rim, [0, 0, 0], 1)
      // chimney + tiller
      .add(cyl(0.07, 0.07, 0.5, 6, d.chimney!.x, 2.1, d.chimney!.z), k + BSUB.hull, [0, 0, 0], 0)
      .add(bx(1.0, 0.05, 0.05, -7.2, 1.1, 0, 0.2), k + BSUB.rim, [0, 0, 0], 1);
    P.add(bx(0.14, 0.2, 0.14, d.lamp!.x, d.lamp!.y, d.lamp!.z), k + BSUB.glow, [0, 0, 0], 1);
    // towline: authored along x ∈ [0,1], mapped in the shader from the mast top to aux.xyz
    P.add(bx(1, 0.035, 0.035, 0.5, 0, 0), k + BSUB.towline, [0, 0, 0], 3);
  }
  { // punt
    const k = BOATK.punt * BS, d = BOAT_DIMS[BOATK.punt];
    hull(P, k, d.len, d.beam, d.depth, { flat: true, floorY: 0.1, bowRise: 0.08 });
    P.add(bx(1.2, 0.06, d.beam * 0.95, -2.5, 0.3, 0), k + BSUB.detail, [0, 0, 0], 1)
      .add(bx(0.8, 0.14, d.beam * 0.7, 1.0, 0.18, 0), k + BSUB.detail, [0, 0, 0], 3);
    // pole: 4.6 m, held at the stern; anim swings it
    P.add(bx(0.05, 4.6, 0.05, -2.5, 1.2, 0.3), k + BSUB.pole, [-2.5, 1.4, 0.3], 1);
  }
  return buildRigGeometry(P.parts);
}

/**
 * anim = (strokePhase, strokeAmp, _, lamp 0..1)
 * aux  = narrowboat: towline end (local xyz, relative to the boat origin); launch: aux.x = funnel down 0..1; kind in aux.w
 */
export const BOAT_GLSL = NAT_GLSL_COMMON + /* glsl */ `
varying float vNatGlow;
void rigPose(float part, vec3 pivot, vec4 anim, vec4 aux, inout vec3 p) {
  vNatGlow = 0.0;
  float kindOf = floor((part + 0.5) / ${BS}.0);
  if (abs(kindOf - aux.w) > 0.5) { p = vec3(0.0); return; }
  int sub = int(part - kindOf * ${BS}.0 + 0.5);
  float sd = natSeed(), t = uNatTime;
  if (sub >= ${BSUB.oar0} && sub < ${BSUB.oar0 + 8}) {
    float i = float(sub - ${BSUB.oar0});
    float side = sign(p.z - pivot.z + 1e-4);
    float ph = anim.x + (kindOf == ${BOATK.gig4}.0 ? 0.0 : 0.0);
    float sweep = -0.6 * cos(ph) * anim.y;
    float lift = (0.12 + 0.22 * max(0.0, -sin(ph))) * anim.y + (1.0 - anim.y) * 0.35;
    p = rigAbout(p, pivot, vec3(-side * lift, side * sweep, 0.0));
  } else if (sub == ${BSUB.funnel}) {
    p = rigAbout(p, pivot, vec3(0.0, 0.0, aux.x * 1.45));
  } else if (sub == ${BSUB.glow}) {
    vNatGlow = anim.w;
  } else if (sub == ${BSUB.pole}) {
    float ph = anim.x;
    float lean = 0.35 + 0.35 * sin(ph);
    p = rigAbout(p, pivot, vec3(0.1 * cos(ph), 0.0, lean * anim.y + 0.15));
    p.y += 0.6 * anim.y * sin(ph + 1.2);
  } else if (sub == ${BSUB.towline}) {
    vec3 A = vec3(${BOAT_DIMS[BOATK.narrowboat].mast!.x.toFixed(2)}, ${BOAT_DIMS[BOATK.narrowboat].mast!.y.toFixed(2)}, 0.0);
    vec3 B = aux.xyz;
    float u = clamp(p.x, 0.0, 1.0);
    vec3 q = mix(A, B, u);
    float len = length(B - A);
    q.y -= sin(3.14159 * u) * (0.25 + 0.02 * len) * (0.8 + 0.2 * sin(t * 1.3 + sd));
    p = q + vec3(0.0, p.y, p.z);
    return;
  }
  // gentle bob, roll and pitch (every boat, moored or not)
  float heave = 0.03 * sin(t * 1.3 + sd * 6.0);
  p = rigAbout(p, vec3(0.0), vec3(0.025 * sin(t * 0.9 + sd * 5.0), 0.0, 0.012 * sin(t * 1.1 + sd * 3.0)));
  p.y += heave;
}`;
