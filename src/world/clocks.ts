import * as THREE from 'three';

export interface ClockSpot {
  /** dial centre (world), just proud of the wall */
  pos: THREE.Vector3;
  /** rotation.y of the dial (its +z faces out) */
  yaw: number;
  /** dial radius (m) */
  r: number;
}

/**
 * CLOCK HANDS for every clock face on the map (station tower + church towers): two InstancedMeshes (hour, minute)
 * — two draws in total. Dials are static and merged by their owners.
 */
export function buildClockHands(root: THREE.Object3D, spots: ClockSpot[], mat: THREE.Material): { update(hour: number): void } {
  const hourGeo = new THREE.BoxGeometry(0.14, 0.8, 0.04); hourGeo.translate(0, 0.32, 0);
  const minGeo = new THREE.BoxGeometry(0.09, 1.15, 0.04); minGeo.translate(0, 0.48, 0);
  const hours = new THREE.InstancedMesh(hourGeo, mat, spots.length);
  const mins = new THREE.InstancedMesh(minGeo, mat, spots.length);
  hours.name = 'clockHoursHands'; mins.name = 'clockMinuteHands';
  for (const im of [hours, mins]) { im.frustumCulled = false; im.castShadow = false; root.add(im); }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  let last = -1;
  const place = (im: THREE.InstancedMesh, i: number, sp: ClockSpot, ang: number, out: number) => {
    const c = Math.cos(sp.yaw), sn = Math.sin(sp.yaw);
    p.set(sp.pos.x + out * sn, sp.pos.y, sp.pos.z + out * c);
    e.set(0, sp.yaw, -ang, 'YXZ');
    q.setFromEuler(e);
    const k = sp.r / 1.3;
    im.setMatrixAt(i, m.compose(p, q, s.set(k, k, 1)));
  };
  return {
    update(hour) {
      const minute = Math.floor(hour * 60 * 4) / 4;
      if (minute === last) return;
      last = minute;
      const hA = ((hour % 12) / 12) * Math.PI * 2;
      const mA = (((hour * 60) % 60) / 60) * Math.PI * 2;
      spots.forEach((sp, i) => { place(hours, i, sp, hA, 0.03); place(mins, i, sp, mA, 0.06); });
      hours.instanceMatrix.needsUpdate = mins.instanceMatrix.needsUpdate = true;
    },
  };
}
