import * as THREE from 'three';
import { buildRigGeometry, type RigPart } from '../rig';

/**
 * SHARED HORSE RIG (v2) — used by traffic (cab, omnibus, dray, cart, fire-engine horses) and nature
 * (plough team, towpath bargehorse, paddock horses, the hunt). Local +x = forward, y up, origin on the ground
 * under the body centre. ~1.6 m at the withers, 2.4 m nose to tail.
 *
 * Instance colours: [0] coat, [1] mane & tail, [2] hooves & muzzle, [3] tack (harness / collar / saddle — set it
 * to the coat colour for an untacked horse).
 * iAnim = (gaitPhase radians, gaitAmp 0 stand · 0.5 walk · 1 trot · 1.5 canter/gallop, headNod −1..1, tailSwish −1..1)
 * iAux  = (stampLeg 0 none · 1 FL · 2 FR · 3 HL · 4 HR, stampPhase 0..1, graze 0..1 (head down to the grass), earFlick 0..1)
 * Advance gaitPhase by `odometer / strideLength` (≈ 2.2 m walk, 2.8 m trot) × 2π so hooves don't skate.
 * Idle life (NO STATIONARY ANIMALS): even when stopped keep tailSwish, occasional stamps, head nods, grazing.
 */
export const HORSE_PART = { body: 0, head: 1, legFL: 2, legFR: 3, legHL: 4, legHR: 5, tail: 6 } as const;
export const HORSE_STRIDE = { walk: 2.2, trot: 2.8, canter: 3.6 };

function box(w: number, h: number, d: number, x: number, y: number, z: number, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

let cached: THREE.BufferGeometry | null = null;
export function horseGeometry(): THREE.BufferGeometry {
  if (cached) return cached;
  const P = HORSE_PART;
  const parts: RigPart[] = [];
  const add = (geo: THREE.BufferGeometry, part: number, pivot: THREE.Vector3, slot: 0 | 1 | 2 | 3) => parts.push({ geo, part, pivot, slot });
  const bodyPiv = new THREE.Vector3(0, 1.2, 0);
  // barrel + chest + rump
  add(box(1.55, 0.62, 0.56, 0, 1.24, 0), P.body, bodyPiv, 0);
  add(box(0.42, 0.66, 0.58, 0.72, 1.28, 0), P.body, bodyPiv, 0);
  add(box(0.46, 0.64, 0.6, -0.72, 1.3, 0), P.body, bodyPiv, 0);
  // tack: collar band + back pad (slot 3)
  add(box(0.18, 0.74, 0.62, 0.62, 1.3, 0), P.body, bodyPiv, 3);
  add(box(0.5, 0.08, 0.6, 0.05, 1.58, 0), P.body, bodyPiv, 3);
  // neck + head (pivot at the withers / neck base)
  const neckPiv = new THREE.Vector3(0.8, 1.5, 0);
  add(box(0.34, 0.78, 0.3, 1.02, 1.82, 0, -0.55), P.head, neckPiv, 0);
  add(box(0.12, 0.6, 0.08, 0.95, 1.95, 0, -0.55), P.head, neckPiv, 1); // mane
  add(box(0.62, 0.28, 0.26, 1.42, 2.1, 0, -0.35), P.head, neckPiv, 0); // head
  add(box(0.16, 0.2, 0.22, 1.7, 1.99, 0, -0.35), P.head, neckPiv, 2);  // muzzle
  add(box(0.06, 0.16, 0.05, 1.2, 2.33, 0.08), P.head, neckPiv, 0);     // ears
  add(box(0.06, 0.16, 0.05, 1.2, 2.33, -0.08), P.head, neckPiv, 0);
  // legs (pivot at shoulder / hip), hooves slot 2
  const legs: [number, number, number][] = [[P.legFL, 0.66, 0.17], [P.legFR, 0.66, -0.17], [P.legHL, -0.66, 0.17], [P.legHR, -0.66, -0.17]];
  for (const [id, x, z] of legs) {
    const piv = new THREE.Vector3(x, 1.02, z);
    add(box(0.17, 0.62, 0.17, x, 0.72, z), id, piv, 0);
    add(box(0.12, 0.34, 0.12, x, 0.26, z), id, piv, 0);
    add(box(0.15, 0.1, 0.15, x + 0.02, 0.05, z), id, piv, 2);
  }
  // tail
  const tailPiv = new THREE.Vector3(-0.95, 1.46, 0);
  add(box(0.14, 0.7, 0.12, -1.03, 1.1, 0, -0.25), P.tail, tailPiv, 1);
  cached = buildRigGeometry(parts);
  return cached;
}

/** rigPose for the horse (see header for the channel meanings) */
export const HORSE_POSE_GLSL = /* glsl */ `
void rigPose(float part, vec3 pivot, vec4 anim, vec4 aux, inout vec3 p) {
  float ph = anim.x, amp = anim.y;
  float trotK = clamp(amp * 2.0 - 1.0, 0.0, 1.0);
  float bob = amp * 0.045 * sin(ph * 2.0) * (0.4 + 0.6 * trotK);
  int id = int(part + 0.5);
  if (id >= 2 && id <= 5) {
    // 4-beat walk offsets (cycles): HL 0, FL .25, HR .5, FR .75; trot: diagonal pairs FL+HR 0, FR+HL .5
    float wo = id == 2 ? 0.25 : id == 3 ? 0.75 : id == 4 ? 0.0 : 0.5;
    float to = id == 2 ? 0.0 : id == 3 ? 0.5 : id == 4 ? 0.5 : 0.0;
    float off = mix(wo, to, trotK) * 6.2831853;
    float swing = min(amp, 1.2) * 0.42 * sin(ph + off);
    // lift the hoof on the forward swing (knee bend approximated by a lift)
    float lift = max(0.0, cos(ph + off)) * min(amp, 1.2) * 0.12;
    float stamp = (abs(aux.x - float(id - 1)) < 0.5) ? sin(3.14159 * clamp(aux.y, 0.0, 1.0)) : 0.0;
    p = rigAbout(p, pivot, vec3(0.0, 0.0, swing - 0.35 * stamp));
    p.y += lift + 0.14 * stamp;
  } else if (id == 1) {
    float nod = 0.15 * anim.z + amp * 0.07 * sin(ph * 2.0 + 0.6);
    float graze = clamp(aux.z, 0.0, 1.0);
    p = rigAbout(p, pivot, vec3(0.0, 0.12 * sin(aux.w * 6.2831853) * aux.w, -(nod + 1.15 * graze)));
  } else if (id == 6) {
    p = rigAbout(p, pivot, vec3(0.5 * anim.w, 0.0, -0.1 * amp + 0.25 * trotK));
  }
  p.y += bob;
}`;
