import * as THREE from 'three';
import type { Ctx, Dir, LineId, SignalAspect } from '../core/types';
import type { WorldMats } from './materials';
import { Kit } from './kit';
import type { Batch } from './batch';

interface SignalObj {
  line: LineId;
  end: Dir;
  aspect: SignalAspect;
  pos: THREE.Vector3;
  yaw: number;
  armSign: number;
  angle: number;
  lampPos: THREE.Vector3;
}

export interface SignalSystem {
  get(line: LineId, end: Dir): SignalAspect;
  set(line: LineId, end: Dir, a: SignalAspect): boolean;
  position(line: LineId, end: Dir): THREE.Vector3;
  update(dt: number, night: number): void;
}

const PIVOT_Y = 6.4;
const RED = new THREE.Color(0xff3a22), GREEN = new THREE.Color(0x49ff7a), AMBER = new THREE.Color(0xffa020);

export function buildSignals(ctx: Ctx, wm: WorldMats, root: THREE.Object3D, batch: Batch): SignalSystem {
  const m = ctx.mats;
  const kit = batch;
  const sigs: SignalObj[] = [];
  // arm + spectacle as ONE vertex-coloured geometry (pivot at the origin), instanced for all four signals
  const armGeo = (() => {
    const k = new Kit();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true });
    k.addC(mat, 0x9a2c24, new THREE.BoxGeometry(1.7, 0.32, 0.06), k.mat(1.05, 0, 0));
    k.addC(mat, 0xe9e4d6, new THREE.BoxGeometry(0.22, 0.33, 0.065), k.mat(1.55, 0, 0));
    k.addC(mat, 0x3a3a3c, new THREE.BoxGeometry(0.5, 0.9, 0.05), k.mat(-0.15, -0.35, 0));
    const g = k.build('arm');
    const geo = (g.children[0] as THREE.Mesh).geometry;
    mat.dispose();
    return geo;
  })();
  const armMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, flatShading: true, side: THREE.DoubleSide });
  armMat.name = 'w_signalArms';

  for (const line of ['coast', 'highland'] as LineId[]) {
    const L = ctx.layout.lines[line];
    for (const end of ['east', 'west'] as Dir[]) {
      const t = L.signalT[end];
      const pos = L.offsetPoint(t, -L.platformSide * 2.5, 0);
      const tan = L.tangentAt(t);
      // face normal points toward the approaching train
      const face = end === 'east' ? tan.clone().negate() : tan.clone();
      const yaw = Math.atan2(face.x, face.z); // rotation.y mapping +z → face
      const localX = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const trackP = L.pointAt(t);
      const toTrack = trackP.sub(pos);
      const armSign = toTrack.dot(localX) > 0 ? -1 : 1;

      // static post (merged)
      kit.cast = true;
      kit.push(pos.x, 0, pos.z, yaw);
      kit.boxB(m.stone, 0.7, 0.3, 0.7, 0, 0, 0);
      kit.add(wm.white, new THREE.CylinderGeometry(0.1, 0.16, PIVOT_Y + 0.9, 4, 1), kit.mat(0, 0.3 + (PIVOT_Y + 0.9) / 2, 0, Math.PI / 4));
      kit.add(m.iron, new THREE.ConeGeometry(0.16, 0.5, 4), kit.mat(0, PIVOT_Y + 1.45, 0, Math.PI / 4));
      kit.add(m.iron, new THREE.SphereGeometry(0.08, 5, 3), kit.mat(0, PIVOT_Y + 1.75, 0));
      // ladder
      for (const sx of [-0.2, 0.2]) kit.box(m.iron, 0.04, PIVOT_Y - 0.8, 0.04, sx, (PIVOT_Y - 0.8) / 2 + 0.3, -0.3);
      for (let y = 0.6; y < PIVOT_Y - 0.6; y += 0.4) kit.box(m.iron, 0.4, 0.03, 0.03, 0, y, -0.3);
      // small working platform & lamp housing
      kit.box(m.iron, 0.8, 0.05, 0.6, 0, PIVOT_Y - 0.8, -0.15);
      kit.box(m.iron, 0.34, 0.4, 0.3, armSign * -0.32, PIVOT_Y - 0.35, -0.02);
      kit.pop();
      kit.cast = false;

      const c = Math.cos(yaw), sn = Math.sin(yaw);
      const lx = armSign * -0.32, lz = 0.34;
      const lampPos = new THREE.Vector3(pos.x + lx * c + lz * sn, PIVOT_Y - 0.35, pos.z - lx * sn + lz * c);
      sigs.push({ line, end, aspect: 'stop', pos, yaw, armSign, angle: 0, lampPos });
    }
  }
  const arms = new THREE.InstancedMesh(armGeo, armMat, sigs.length);
  arms.name = 'signalArms';
  arms.castShadow = true;
  arms.frustumCulled = false;
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  lampMat.name = 'w_signalLamps';
  const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 8, 6), lampMat, sigs.length);
  lamps.name = 'signalLamps';
  lamps.frustumCulled = false;
  const g = new THREE.Group();
  g.name = 'signals';
  g.add(arms, lamps);
  root.add(g);
  const mt = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
  sigs.forEach((s, i) => lamps.setMatrixAt(i, mt.makeTranslation(s.lampPos.x, s.lampPos.y, s.lampPos.z)));
  lamps.instanceMatrix.needsUpdate = true;
  sigs.forEach((_s, i) => lamps.setColorAt(i, RED));

  const find = (line: LineId, end: Dir) => sigs.find((s) => s.line === line && s.end === end)!;
  let time = 0;
  return {
    get: (line, end) => find(line, end)?.aspect ?? 'stop',
    set(line, end, a) {
      const s = find(line, end);
      if (!s || s.aspect === a) return false;
      s.aspect = a;
      return true;
    },
    position: (line, end) => find(line, end).pos.clone(),
    update(dt, night) {
      time += dt;
      const base = 0.35 + night * 0.9;
      sigs.forEach((s, i) => {
        const target = s.aspect === 'clear' ? Math.PI / 4 : s.aspect === 'failed' ? -Math.PI / 6 : 0;
        const k = Math.min(1, dt * 4);
        s.angle += (target - s.angle) * k;
        // pivot (0, PIVOT_Y, 0.16) in the post frame; arm rotates about the pivot's local z
        const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
        p.set(s.pos.x + 0.16 * sn, PIVOT_Y, s.pos.z + 0.16 * c);
        e.set(0, s.yaw, s.angle * s.armSign, 'YXZ');
        q.setFromEuler(e);
        arms.setMatrixAt(i, mt.compose(p, q, sc.set(s.armSign, 1, 1)));
        if (s.aspect === 'failed') col.copy(AMBER).multiplyScalar((Math.sin(time * 6) > 0 ? 1 : 0.08) * (base + 0.3));
        else col.copy(s.aspect === 'clear' ? GREEN : RED).multiplyScalar(base);
        lamps.setColorAt(i, col);
      });
      arms.instanceMatrix.needsUpdate = true;
      if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
    },
  };
}
