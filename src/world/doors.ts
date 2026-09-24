import * as THREE from 'three';
import type { DoorSpot } from './towns';

/**
 * COSMETIC DOORS (v2): WorldAPI.openDoor(originId) swings a door open for a moment while someone fades through it.
 * A small pool of instanced leaves (painted in the door's own colour) + dark doorway panels is placed over the
 * static door only while it is moving; when shut the leaf exactly covers the merged door again and is hidden.
 */
export interface DoorSwing {
  open(originId: string): void;
  update(dt: number): void;
}

const POOL = 8;

export function buildDoors(root: THREE.Object3D, spots: Map<string, DoorSpot>): DoorSwing {
  const leafGeo = new THREE.BoxGeometry(1, 1, 0.08);
  leafGeo.translate(0.5, 0.5, 0.04);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, flatShading: true });
  leafMat.name = 'w_doorLeaf';
  const holeGeo = new THREE.PlaneGeometry(1, 1);
  holeGeo.translate(0.5, 0.5, -0.03);
  const holeMat = new THREE.MeshStandardMaterial({ color: 0x14110e, roughness: 1, flatShading: true });
  holeMat.name = 'w_doorway';
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, POOL);
  const holes = new THREE.InstancedMesh(holeGeo, holeMat, POOL);
  leaves.name = 'doorLeaves'; holes.name = 'doorways';
  leaves.setColorAt(0, new THREE.Color(1, 1, 1));
  for (const im of [leaves, holes]) { im.count = 0; im.frustumCulled = false; im.castShadow = false; root.add(im); }
  const slots: { id: string; t: number; spot: DoorSpot }[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), c = new THREE.Color();
  const OPEN = 0.35, HOLD = 1.3, CLOSE = 0.55;
  return {
    open(id) {
      const spot = spots.get(id);
      if (!spot) return;
      const cur = slots.find((x) => x.id === id);
      if (cur) { cur.t = Math.min(cur.t, OPEN); return; }
      if (slots.length >= POOL) return;
      slots.push({ id, t: 0, spot });
    },
    update(dt) {
      if (!slots.length && leaves.count === 0) return;
      for (let i = slots.length - 1; i >= 0; i--) { slots[i].t += dt; if (slots[i].t > OPEN + HOLD + CLOSE) slots.splice(i, 1); }
      slots.forEach((sl, i) => {
        const t = sl.t;
        const a = t < OPEN ? t / OPEN : t < OPEN + HOLD ? 1 : 1 - (t - OPEN - HOLD) / CLOSE;
        const ang = THREE.MathUtils.smoothstep(a, 0, 1) * 1.25;
        const sp = sl.spot;
        e.set(0, sp.yaw - ang, 0); // swings outward so it reads in the iso view
        q.setFromEuler(e);
        m.compose(sp.hinge, q, s.set(sp.w, sp.h, 1));
        leaves.setMatrixAt(i, m);
        leaves.setColorAt(i, c.setHex(sp.color));
        e.set(0, sp.yaw, 0);
        q.setFromEuler(e);
        m.compose(sp.hinge, q, s.set(sp.w, sp.h, 1));
        holes.setMatrixAt(i, m);
      });
      leaves.count = holes.count = slots.length;
      leaves.instanceMatrix.needsUpdate = holes.instanceMatrix.needsUpdate = true;
      if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    },
  };
}
