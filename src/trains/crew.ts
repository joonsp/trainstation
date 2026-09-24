import * as THREE from 'three';
import { SKIN } from '../core/palette';
import type { Car } from './visuals';

/**
 * Footplate crews and guards (v2 "living" trains). Every figure is built from flat-shaded boxes drawn by ONE
 * InstancedMesh (one draw call for every crew member on the map), animated per frame on the CPU (a handful of
 * figures). They are part of their train: they ride in from the tunnel in the cab / van and leave with it, so they
 * never pop in; the guard steps out of the van door onto the platform while the train dwells and back in to leave.
 *
 * Figure-local frame: feet at the origin, facing +x (the car's forward), +z = figure's left.
 */

const MAX_BOXES = 900;
const OVERALLS = 0x3b4759;
const TROUSERS = 0x262c36;
const CAP = 0x1d1d21;
const GUARD_COAT = 0x1c2233;
const GUARD_BAND = 0x8a2a2a;
const SHOVEL = 0x5a5046;
const BLADE = 0x2e2e30;
const FLAG_GREEN = 0x2f8a3a;
const BEARD = 0x3a2a1e;

export interface CrewState {
  seed: number;
  skinD: number; skinF: number; skinG: number;
  /** fireman shovel cycle 0..1 (−1 = idle) */
  shovel: number;
  nextShovel: number;
  /** driver lean-out 0..1 (eased) */
  lean: number;
  /** driver looks back along the train 0..1 */
  lookBack: number;
  /** driver pulls the whistle cord 0..1 */
  cord: number;
  /** guard: 0 inside the van … 1 standing on the platform */
  guardOut: number;
  /** guard flag raised 0..1 */
  flag: number;
  /** guard leaning out of the van as the train draws out 0..1 */
  guardLean: number;
  clock: number;
}

export function newCrewState(seed: number): CrewState {
  const r = (k: number) => { const v = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
  return {
    seed, skinD: SKIN[Math.floor(r(1) * 4)], skinF: SKIN[Math.floor(r(2) * 5)], skinG: SKIN[Math.floor(r(3) * 4)],
    shovel: -1, nextShovel: r(4) * 3, lean: 0, lookBack: 0, cord: 0, guardOut: 0, flag: 0, guardLean: 0, clock: r(5) * 50,
  };
}

export interface LocoCrewInput {
  /** m/s */
  speed: number;
  /** regulator open (accelerating / holding speed) */
  working: boolean;
  /** approaching a stop / signal (driver leans out to watch) */
  watching: boolean;
  /** standing at the platform */
  standing: boolean;
  /** departure imminent: driver looks back for the guard's flag */
  lookBack: boolean;
  /** whistle being blown */
  whistle: boolean;
}

const _m = new THREE.Matrix4();
const _f = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _a = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const ONE = new THREE.Vector3(1, 1, 1);

const ease = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * Math.min(1, rate * dt);

export class CrewRenderer {
  readonly mesh: THREE.InstancedMesh;
  readonly lamp: THREE.InstancedMesh;
  private n = 0;
  private nl = 0;

  constructor(lampMat: THREE.Material) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.85, metalness: 0 });
    mat.name = 'trainCrew';
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_BOXES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOXES * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.name = 'trainCrew';
    // the guard's hand lamp at night (emissive, shared head-lamp material)
    this.lamp = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.2, 0.16), lampMat, 8);
    this.lamp.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lamp.count = 0;
    this.lamp.frustumCulled = false;
    this.lamp.name = 'trainGuardLamp';
  }

  begin(): void { this.n = 0; this.nl = 0; }

  end(): void {
    this.mesh.count = this.n;
    this.lamp.count = this.nl;
    this.mesh.visible = this.n > 0;
    this.lamp.visible = this.nl > 0;
    if (this.n) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor!.needsUpdate = true; }
    if (this.nl) this.lamp.instanceMatrix.needsUpdate = true;
  }

  /** one box: frame · T(x,y,z) · S(sx,sy,sz) */
  private box(frame: THREE.Matrix4, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number): void {
    if (this.n >= MAX_BOXES) return;
    _m.compose(_p.set(x, y, z), _q.identity(), _s.set(sx, sy, sz));
    _t.multiplyMatrices(frame, _m);
    this.mesh.setMatrixAt(this.n, _t);
    _c.setHex(color);
    this.mesh.instanceColor!.setXYZ(this.n, _c.r, _c.g, _c.b);
    this.n++;
  }

  /** frame' = frame · T(x,y,z) · R(rx,ry,rz) (writes out) */
  private sub(frame: THREE.Matrix4, x: number, y: number, z: number, rx: number, ry: number, rz: number, out: THREE.Matrix4): THREE.Matrix4 {
    _e.set(rx, ry, rz, 'YZX');
    _q.setFromEuler(_e);
    _a.compose(_p.set(x, y, z), _q, ONE);
    return out.multiplyMatrices(frame, _a);
  }

  /**
   * A standing figure. bend: forward lean at the hips (rad); twist: torso yaw; headYaw: extra head turn;
   * armL/armR: forward swing of each arm (rad, 0 = hanging); spread: sideways lift of both arms.
   * Returns the torso frame in `torsoOut` (for tools).
   */
  private figure(base: THREE.Matrix4, o: {
    coat: number; legs: number; skin: number; cap: number; band?: number; beard?: boolean;
    bend: number; twist: number; headYaw: number; headPitch?: number; armL: number; armR: number; spread?: number; shift?: number;
  }, torsoOut: THREE.Matrix4): void {
    const shift = o.shift ?? 0;
    // legs
    this.box(base, 0, 0.42, 0.1 + shift * 0.03, 0.2, 0.84, 0.15, o.legs);
    this.box(base, 0, 0.42, -0.1 + shift * 0.03, 0.2, 0.84, 0.15, o.legs);
    // torso (pivot at the hips)
    const torso = this.sub(base, 0, 0.84, shift * 0.04, 0, o.twist, -o.bend, torsoOut);
    this.box(torso, 0, 0.29, 0, 0.27, 0.6, 0.44, o.coat);
    // head
    const head = this.sub(torso, 0, 0.62, 0, 0, o.headYaw, -(o.headPitch ?? 0), _f);
    this.box(head, 0, 0.1, 0, 0.21, 0.23, 0.2, o.skin);
    if (o.beard) this.box(head, 0.07, 0.02, 0, 0.09, 0.1, 0.18, BEARD);
    this.box(head, 0.0, 0.25, 0, 0.26, 0.08, 0.25, o.cap);
    if (o.band) this.box(head, 0.0, 0.21, 0, 0.265, 0.03, 0.255, o.band);
    this.box(head, 0.15, 0.22, 0, 0.1, 0.025, 0.2, o.cap);
    // arms (pivot at the shoulders)
    const sp = o.spread ?? 0;
    for (const side of [1, -1]) {
      const swing = side > 0 ? o.armL : o.armR;
      const arm = this.sub(torso, 0, 0.53, side * 0.27, side * sp, 0, swing, _t.clone());
      this.box(arm, 0, -0.28, 0, 0.12, 0.58, 0.12, o.coat);
      this.box(arm, 0, -0.6, 0, 0.1, 0.09, 0.1, o.skin);
    }
  }

  /** driver + fireman on the footplate of a locomotive car */
  drawLoco(car: Car, st: CrewState, inp: LocoCrewInput, dt: number): void {
    if (!car.spec.loco || !car.group.visible) return;
    st.clock += dt;
    const express = car.spec.loco === 'express';
    const floorY = express ? 1.35 : 1.2;
    const cabX0 = express ? -5.0 : -3.6, cabX1 = express ? -2.55 : -1.45;
    const cabMid = (cabX0 + cabX1) / 2;
    const T = st.clock;
    const cm = car.group.matrix;

    // ── driver: right-hand side (−z when facing +x … Victorian lines drove from either side; we use −z) ──
    st.lean = ease(st.lean, inp.watching || inp.lookBack ? 1 : 0, 2.5, dt);
    st.lookBack = ease(st.lookBack, inp.lookBack ? 1 : 0, 3, dt);
    st.cord = ease(st.cord, inp.whistle ? 1 : 0, 8, dt);
    const lean = st.lean;
    const dz = -0.62 - lean * 0.28;
    const base = this.sub(cm, cabMid + 0.35, floorY, dz, 0, 0, 0, new THREE.Matrix4());
    const breathe = Math.sin(T * 1.7 + st.seed) * 0.02;
    const look = Math.sin(T * 0.37 + st.seed * 2) * 0.35;
    const headYaw = THREE.MathUtils.lerp(look * (1 - lean), -0.35 * lean, lean) + st.lookBack * -2.4;
    this.figure(base, {
      coat: OVERALLS, legs: TROUSERS, skin: st.skinD, cap: CAP, beard: (st.seed % 3) === 0,
      bend: 0.08 + breathe + lean * 0.12, twist: -lean * 0.35 + st.lookBack * -0.5, headYaw, armL: 0.9 + Math.sin(T * 0.8) * 0.05,
      armR: st.cord > 0.05 ? 2.6 * st.cord : 0.55 + lean * 0.4, spread: lean * -0.25,
      shift: Math.sin(T * 0.45 + st.seed) ,
    }, _f.clone());

    // ── fireman: shovels coal from the tender (rear, −x) into the firebox (front, +x) ──
    st.nextShovel -= dt;
    if (st.shovel < 0 && st.nextShovel <= 0) {
      st.shovel = 0;
      st.nextShovel = inp.working ? 2.5 + Math.random() * 3 : inp.speed > 0.5 ? 7 + Math.random() * 6 : 10 + Math.random() * 10;
    }
    let bend = 0.12, twist = 0, armL = 0.6, armR = 0.6, tool = -1.1, turn = 0;
    if (st.shovel >= 0) {
      st.shovel += dt / 2.1;
      const k = st.shovel;
      if (k >= 1) st.shovel = -1;
      else {
        // 0–.3 turn to the tender and stoop, .3–.45 scoop, .45–.7 swing round, .7–.85 pitch into the fire, .85–1 recover
        const sm = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);
        turn = Math.PI * (sm(0.0, 0.3, k) - sm(0.45, 0.7, k));
        bend = 0.12 + 0.55 * sm(0.1, 0.3, k) * (1 - sm(0.45, 0.6, k)) + 0.35 * sm(0.7, 0.8, k) * (1 - sm(0.85, 1, k));
        const reach = sm(0.25, 0.4, k) * (1 - sm(0.45, 0.55, k)) + sm(0.68, 0.8, k) * (1 - sm(0.88, 1, k));
        armL = armR = 0.5 + 0.8 * reach;
        tool = -1.1 + 0.9 * reach;
      }
    } else {
      // between rounds: a look out over the cab side, a wipe of the brow
      twist = Math.sin(T * 0.3 + st.seed) * 0.3;
      armR = 0.4 + Math.max(0, Math.sin(T * 0.21 + 1.3)) * 1.6 * (inp.speed < 0.5 ? 1 : 0.3);
    }
    const fx = cabMid - 0.35;
    const fbase = this.sub(cm, fx, floorY, 0.55, 0, turn, 0, new THREE.Matrix4());
    const torso = new THREE.Matrix4();
    this.figure(fbase, {
      coat: OVERALLS, legs: TROUSERS, skin: st.skinF, cap: CAP,
      bend: bend + breathe, twist, headYaw: Math.sin(T * 0.5 + st.seed * 3) * 0.3, armL, armR, shift: Math.sin(T * 0.6 + st.seed),
    }, torso);
    // shovel held in front of the hands
    const tf = this.sub(torso, 0, 0.53, 0, 0, 0, (armL + armR) / 2, new THREE.Matrix4());
    const tl = this.sub(tf, 0, -0.56, 0, 0, 0, tool, new THREE.Matrix4());
    this.box(tl, 0.35, 0, 0, 0.8, 0.05, 0.05, SHOVEL);
    this.box(tl, 0.82, 0, 0, 0.26, 0.04, 0.24, BLADE);
  }

  /**
   * The guard beside his van. `side` = +1/−1: which car-local z side the platform is on. `out` 0..1 (inside → on
   * the platform), `flag` 0..1 (raised), night → hand lamp instead of the green flag.
   */
  drawGuard(car: Car, st: CrewState, side: number, forward: number, platformY: number, wantOut: boolean, wantFlag: boolean, night: number, dt: number, leanOut = false): void {
    st.guardOut = ease(st.guardOut, wantOut ? 1 : 0, 5, dt);
    st.flag = ease(st.flag, wantFlag || leanOut ? 1 : 0, 7, dt);
    st.guardLean = ease(st.guardLean, leanOut ? 1 : 0, 4, dt);
    if (car.group.visible && st.guardLean > 0.02 && st.guardOut < 0.05) { this.guardLeaning(car, st, side, forward, night); return; }
    if (!car.group.visible || st.guardOut < 0.02) return;
    const T = st.clock + 13;
    const o = st.guardOut;
    // inside the van body (hidden by the van) → out through the door onto the platform
    const lat = side * THREE.MathUtils.lerp(0.2, 2.35, o);
    const cm = car.group.matrix;
    const y = THREE.MathUtils.lerp(1.2, platformY - car.group.position.y, Math.min(1, o * 1.4));
    const facing = side > 0 ? -Math.PI / 2 : Math.PI / 2; // faces out of the door while stepping…
    const upTrain = (forward > 0 ? 0 : Math.PI) - side * 0.45 + Math.sin(T * 0.4) * 0.25;
    const yaw = THREE.MathUtils.lerp(facing, upTrain, THREE.MathUtils.smoothstep(o, 0.6, 1)); // …then looks up the train
    const base = this.sub(cm, 0.4, y, lat, 0, yaw, 0, new THREE.Matrix4());
    const f = st.flag;
    const wave = f > 0.5 ? Math.sin(T * 9) * 0.25 * f : 0;
    const torso = new THREE.Matrix4();
    this.figure(base, {
      coat: GUARD_COAT, legs: GUARD_COAT, skin: st.skinG, cap: CAP, band: GUARD_BAND, beard: (st.seed % 2) === 0,
      bend: 0.03 + Math.sin(T * 1.6) * 0.015, twist: 0, headYaw: Math.sin(T * 0.33 + st.seed) * 0.4 * (1 - f), headPitch: 0,
      armL: 0.2 + Math.sin(T * 0.7) * 0.05, armR: 0.25 + f * 2.5 + wave, spread: f * 0.15, shift: Math.sin(T * 0.5 + st.seed),
    }, torso);
    if (f > 0.05) {
      const arm = this.sub(torso, 0, 0.53, -0.27, -f * 0.15, 0, 0.25 + f * 2.5 + wave, new THREE.Matrix4());
      if (night > 0.45) {
        const lp = this.sub(arm, 0, -0.72, 0, 0, 0, 0, new THREE.Matrix4());
        if (this.nl < 8) { this.lamp.setMatrixAt(this.nl++, lp); }
      } else {
        this.box(arm, 0.0, -0.95, 0, 0.03, 0.6, 0.03, SHOVEL);
        this.box(arm, 0.2, -1.1, 0, 0.38, 0.28, 0.02, FLAG_GREEN);
      }
    }
  }

  /** the guard leans out of the van doorway as the train draws out, flag (or lamp) held up to the driver */
  private guardLeaning(car: Car, st: CrewState, side: number, forward: number, night: number): void {
    const T = st.clock + 13;
    const k = st.guardLean;
    const cm = car.group.matrix;
    const facing = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    const base = this.sub(cm, 0.4 * forward, 1.2, side * (0.55 + 0.75 * k), 0, facing, 0, new THREE.Matrix4());
    const torso = new THREE.Matrix4();
    const lookFwd = (forward > 0 ? 1 : -1) * side * 1.1;
    this.figure(base, {
      coat: GUARD_COAT, legs: GUARD_COAT, skin: st.skinG, cap: CAP, band: GUARD_BAND, beard: (st.seed % 2) === 0,
      bend: 0.35 * k + Math.sin(T * 1.6) * 0.015, twist: lookFwd * 0.4 * k, headYaw: lookFwd * 0.6 * k, headPitch: 0,
      armL: 0.9, armR: 0.3 + 2.3 * st.flag + Math.sin(T * 7) * 0.12 * st.flag, spread: 0.1, shift: 0,
    }, torso);
    const arm = this.sub(torso, 0, 0.53, -0.27, -0.1, 0, 0.3 + 2.3 * st.flag, new THREE.Matrix4());
    if (night > 0.45) {
      const lp = this.sub(arm, 0, -0.72, 0, 0, 0, 0, new THREE.Matrix4());
      if (this.nl < 8) this.lamp.setMatrixAt(this.nl++, lp);
    } else if (st.flag > 0.3) {
      this.box(arm, 0.0, -0.95, 0, 0.03, 0.6, 0.03, SHOVEL);
      this.box(arm, 0.2, -1.1, 0, 0.38, 0.28, 0.02, FLAG_GREEN);
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.lamp.geometry.dispose();
  }
}
