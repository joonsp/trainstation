import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import type { Env } from './env';
import { V } from './kit';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pickProxy, type Batch } from './batch';

export interface LinesideBuild {
  /** the signalman at the lever frame: idles (paces, looks down the line) and pulls a lever on signal:changed */
  update(dt: number): void;
  pull(): void;
}

/** Signal box beside the coast line (v2: door at nav sbDoor, a signalman at the frame), telegraph poles with wires. */
export function buildLineside(ctx: Ctx, wm: WorldMats, env: Env, root: THREE.Object3D, pickables: THREE.Object3D[], batch: Batch): LinesideBuild {
  const m = ctx.mats;
  const kit = batch;
  kit.cast = true;

  // ── signal box ──
  const SB = V(-11, 0, 33);
  env.addBlocker({ center: SB, size: new THREE.Vector3(10, 1, 7), yaw: 0 });
  {
    kit.push(SB.x, 0, SB.z, 0);
    const W = 7, D = 4, LOW = 3.2, UP = 3.0;
    // brick locking room
    kit.boxB(m.brick, W, LOW, D, 0, 0, 0);
    kit.boxB(m.cream, W + 0.2, 0.2, D + 0.2, 0, LOW - 0.2, 0);
    for (const x of [-2.2, 2.2]) kit.arch(m.windowLit, 0.8, 1.4, x, 0.9, -D / 2 - 0.02, Math.PI);
    // v2: the locking-room door at nav node sbDoor (signalmen fade through it)
    kit.boxB(m.bottleGreen, 1.0, 2.1, 0.1, 0, 0.05, -D / 2 - 0.04);
    kit.box(m.cream, 1.3, 0.14, 0.14, 0, 2.2, -D / 2 - 0.08);
    kit.boxB(m.stone, 1.5, 0.12, 0.7, 0, 0, -D / 2 - 0.35);
    kit.add(m.brass, new THREE.SphereGeometry(0.05, 4, 3), kit.mat(0.32, 1.05, -D / 2 - 0.1));
    // lever frame along the line-side windows (the signalman works it)
    for (let i = 0; i < 10; i++) kit.add(i % 3 === 0 ? wm.signalRed : m.iron, new THREE.BoxGeometry(0.06, 0.9, 0.06), kit.mat(-2.4 + i * 0.5, LOW + 1.35, -D / 2 + 0.7, 0, 0.25, 0));
    kit.boxB(m.iron, 5.4, 0.3, 0.3, -0.15, LOW + 0.9, -D / 2 + 0.75);
    // timber operating floor with continuous windows (facing the line = -z)
    kit.boxB(m.cream, W, 0.9, D, 0, LOW, 0);
    kit.boxB(m.cream, W, 0.4, D, 0, LOW + UP - 0.4, 0);
    // v2: glazed operating floor you can see into (the signalman works the frame inside); the back of the room
    // is a lit panel so the box glows through its glass at night
    const GY = LOW + 0.9 + (UP - 1.3) / 2;
    kit.boxB(m.wood, W - 0.2, 0.05, D - 0.2, 0, LOW + 0.9, 0);
    kit.boxB(wm.dark, W - 0.2, 0.1, D - 0.2, 0, LOW + UP - 0.5, 0);
    kit.quad(m.windowLit, W - 0.4, UP - 1.4, 0, GY, D / 2 - 0.35, Math.PI);
    kit.quad(m.windowLit, W - 0.4, UP - 1.4, 0, GY, -D / 2 + 0.1, 0);
    for (const sz of [-1, 1]) {
      kit.quad(m.glass, W - 0.4, UP - 1.4, 0, GY, sz * (D / 2 - 0.05), sz > 0 ? 0 : Math.PI);
      for (let i = 0; i <= 7; i++) kit.box(m.bottleGreen, 0.08, UP - 1.3, 0.1, -W / 2 + 0.1 + (i * (W - 0.2)) / 7, GY, sz * (D / 2 - 0.02));
    }
    for (const sx of [-1, 1]) {
      kit.quad(m.glass, D - 0.6, UP - 1.4, sx * (W / 2 - 0.05), GY, 0, sx * Math.PI / 2);
      kit.quad(m.windowLit, D - 0.6, UP - 1.4, sx * (W / 2 - 0.15), GY, 0, -sx * Math.PI / 2);
      for (let i = 0; i <= 3; i++) kit.box(m.bottleGreen, 0.1, UP - 1.3, 0.08, sx * (W / 2 - 0.02), GY, -D / 2 + 0.1 + (i * (D - 0.2)) / 3);
    }
    // hipped slate roof with finials and a stove chimney
    kit.hip(m.slate, W + 1.2, D + 1.2, 1.8, 0, LOW + UP, 0);
    kit.cyl(m.iron, 0.12, 0.12, 1.4, 6, 1.8, LOW + UP + 0.6, 0.6);
    kit.cyl(m.iron, 0.2, 0.12, 0.2, 6, 1.8, LOW + UP + 2.0, 0.6);
    // name board on the line side
    kit.quad(wm.signs, 3.0, 0.5, 0, LOW + 0.45, -D / 2 - 0.03, Math.PI, wm.atlas.signalBox);
    // external stair + landing on the east end
    kit.boxB(m.wood, 1.4, 0.12, 1.4, W / 2 + 0.7, LOW, 1.0);
    const steps = 12;
    for (let i = 0; i < steps; i++) kit.boxB(m.wood, 1.0, 0.07, 0.28, W / 2 + 0.7, (LOW / steps) * (i + 1) - 0.07, 1.7 + (steps - i) * 0.26);
    kit.beam(m.wood, 0.08, 0.2, V(W / 2 + 0.2, 0.1, 1.7 + steps * 0.26 + 0.2), V(W / 2 + 0.2, LOW, 1.7));
    kit.beam(m.wood, 0.08, 0.2, V(W / 2 + 1.2, 0.1, 1.7 + steps * 0.26 + 0.2), V(W / 2 + 1.2, LOW, 1.7));
    kit.beam(m.wood, 0.05, 0.05, V(W / 2 + 1.2, 1.0, 1.7 + steps * 0.26 + 0.2), V(W / 2 + 1.2, LOW + 1.0, 1.7));
    // little garden: fire buckets and a water butt
    kit.cyl(m.wood, 0.4, 0.4, 1.0, 8, -W / 2 - 0.7, 0, 1.2);
    kit.pop();
  }

  // ── telegraph poles with wires ──
  const wirePts: number[] = [];
  const poles = (line: 'coast' | 'highland', lateral: number, spacing: number) => {
    const L = ctx.layout.lines[line];
    let prev: THREE.Vector3[] | null = null;
    for (let s = 20; s < L.length - 20; s += spacing) {
      const t = s / L.length;
      const p = L.offsetPoint(t, lateral, 0);
      const ownD = Math.abs(lateral);
      const others = Math.min(
        line === 'coast' ? Infinity : distPts(p, env.coastPts),
        line === 'highland' ? Infinity : distPts(p, env.highPts),
        distPts(p, env.shedPts),
      );
      if (others < 4 || env.blocked(p.x, p.z, 2) || ctx.layout.terrain.roadDist(p.x, p.z) < 1.5 || env.heightAt(p.x, p.z) > 0.6 || Math.abs(p.x) > 330 || Math.abs(p.z) > 330
        || ctx.layout.trees.some((tr) => tr.distanceTo(p) < 2) || ctx.layout.lampPositions.some((l) => l.distanceTo(p) < 3)) { prev = null; continue; }
      void ownD;
      const yaw = L.yawAt(t);
      const H = 7.5;
      kit.push(p.x, 0, p.z, yaw);
      kit.cyl(m.sleeper, 0.1, 0.14, H, 6, 0, 0, 0);
      const arms = [H - 0.4, H - 1.1];
      const tops: THREE.Vector3[] = [];
      for (const ay of arms) {
        kit.box(m.wood, 0.1, 0.1, 1.6, 0, ay, 0);
        for (const az of [-0.65, -0.22, 0.22, 0.65]) {
          kit.cyl(wm.white, 0.04, 0.05, 0.14, 5, 0, ay + 0.05, az);
        }
      }
      kit.pop();
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      for (const ay of arms) for (const az of [-0.65, 0.65]) tops.push(V(p.x + az * sn, ay + 0.2, p.z + az * c));
      if (prev) {
        for (let i = 0; i < tops.length; i++) {
          const a = prev[i], b = tops[i];
          // sagging wire in 3 segments
          const mid = a.clone().lerp(b, 0.5); mid.y -= 0.5;
          const q1 = a.clone().lerp(b, 0.25); q1.y -= 0.37;
          const q3 = a.clone().lerp(b, 0.75); q3.y -= 0.37;
          const seq = [a, q1, mid, q3, b];
          for (let k = 0; k < seq.length - 1; k++) wirePts.push(seq[k].x, seq[k].y, seq[k].z, seq[k + 1].x, seq[k + 1].y, seq[k + 1].z);
        }
      }
      prev = tops;
    }
  };
  poles('coast', 7, 42);
  poles('highland', -7, 42);

  if (wirePts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wirePts, 3));
    const wires = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2a2a2a, transparent: true, opacity: 0.55 }));
    wires.name = 'telegraphWires';
    wires.matrixAutoUpdate = false;
    root.add(wires);
  }

  kit.cast = false;
  const g = pickProxy('signalbox', { kind: 'station', id: 'signalbox' }, [{ center: SB, size: new THREE.Vector3(8, 8, 5), yaw: 0 }]);
  root.add(g);
  pickables.push(g);

  // ── the signalman (a simple animated figure behind the operating-floor glass) ──
  const man = new THREE.Group();
  man.name = 'signalman';
  const fig = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  fig.name = 'w_signalman';
  const tint = (g: THREE.BufferGeometry, hex: number) => {
    const c = new THREE.Color(hex), n = g.getAttribute('position').count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g.index ? g.toNonIndexed() : g;
  };
  const part = (g: THREE.BufferGeometry, hex: number, x: number, y: number, z: number) => { g.translate(x, y, z); return tint(g, hex); };
  const torsoGeo = mergeGeometries([
    part(new THREE.BoxGeometry(0.46, 0.8, 0.28), 0xe6e0d2, 0, 0.95, 0), // shirtsleeves (reads through the glass)
    part(new THREE.BoxGeometry(0.48, 0.5, 0.3), 0x2a2622, 0, 0.84, 0), // waistcoat
    part(new THREE.IcosahedronGeometry(0.15, 0), 0xd9a58a, 0, 1.52, 0),
    part(new THREE.CylinderGeometry(0.15, 0.16, 0.1, 6), 0x1f2a3a, 0, 1.64, 0),
  ].map((g) => { g.deleteAttribute('uv'); return g; }))!;
  const body = new THREE.Mesh(torsoGeo, fig);
  const head = body; // head turns are a torso twist (one mesh)
  const legs = new THREE.Mesh(part(new THREE.BoxGeometry(0.4, 0.62, 0.24), 0x1f2a3a, 0, 0, 0), fig); legs.position.y = 0.31;
  const arm = new THREE.Group(); arm.position.set(0.28, 1.28, 0);
  const armM = new THREE.Mesh(part(new THREE.BoxGeometry(0.12, 0.6, 0.12), 0xe6e0d2, 0, -0.28, 0), fig); arm.add(armM);
  const torso = new THREE.Group(); torso.add(body, arm);
  man.add(legs, torso);
  // operating floor: signal box at SB, floor at LOW + 0.9 = 4.1; frame along local −z (line side)
  man.position.set(SB.x, 3.2 + 0.9, SB.z + 0.55); // stands back from the frame, where the iso camera sees him through the glass
  man.rotation.y = Math.PI; // facing the frame / the line (north)
  root.add(man);
  let t = 0, pullT = -1, x = 0, tx = 0, wait = 3, look = 0;
  return {
    pull() { if (pullT < 0) { pullT = 0; tx = THREE.MathUtils.clamp(tx + (Math.random() - 0.5) * 2, -2, 2); } },
    update(dt) {
      t += dt;
      wait -= dt;
      if (wait <= 0) { wait = 4 + Math.random() * 7; if (pullT < 0) tx = -2.2 + Math.random() * 4.4; look = (Math.random() - 0.5) * 0.8; }
      x += THREE.MathUtils.clamp(tx - x, -dt * 0.8, dt * 0.8);
      man.position.x = SB.x + x;
      const walking = Math.abs(tx - x) > 0.02;
      legs.scale.y = walking ? 1 + 0.06 * Math.sin(t * 9) : 1;
      torso.rotation.z = 0.03 * Math.sin(t * 1.3);
      head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, walking ? 0 : look, Math.min(1, dt * 2));
      if (pullT >= 0) {
        pullT += dt;
        const k = Math.sin(Math.min(1, pullT / 1.6) * Math.PI);
        torso.rotation.x = -0.35 * k;
        arm.rotation.x = -1.3 * k;
        if (pullT > 1.6) pullT = -1;
      } else {
        torso.rotation.x = 0.02 * Math.sin(t * 0.9);
        arm.rotation.x = -0.1 + 0.08 * Math.sin(t * 1.7);
      }
    },
  };
}

function distPts(p: THREE.Vector3, pts: THREE.Vector3[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const abx = b.x - a.x, abz = b.z - a.z;
    const l2 = abx * abx + abz * abz || 1;
    const u = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + abx * u), p.z - (a.z + abz * u)));
  }
  return best;
}
