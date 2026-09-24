import * as THREE from 'three';
import type { Ctx } from '../core/types';

/**
 * WEATHER VANES on the station clock tower and the church spires: one InstancedMesh, each arrow swinging into the
 * wind (ctx.wind) with a little gust flutter. The static spindles are part of their buildings.
 */
export function buildVanes(ctx: Ctx, root: THREE.Object3D, spots: THREE.Vector3[]): { update(dt: number): void } {
  const parts: THREE.BufferGeometry[] = [];
  const shaft = new THREE.BoxGeometry(1.3, 0.05, 0.05);
  const head = new THREE.ConeGeometry(0.13, 0.34, 4); head.rotateZ(-Math.PI / 2); head.translate(0.8, 0, 0);
  const fin = new THREE.BoxGeometry(0.4, 0.34, 0.03); fin.translate(-0.62, 0.05, 0);
  for (const g of [shaft, head, fin]) parts.push(g.index ? g.toNonIndexed() : g);
  const pos: number[] = [];
  for (const g of parts) pos.push(...(g.getAttribute('position').array as Float32Array));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.5, metalness: 0.4, flatShading: true });
  mat.name = 'w_vanes';
  const im = new THREE.InstancedMesh(geo, mat, Math.max(1, spots.length));
  im.name = 'weatherVanes';
  im.frustumCulled = false;
  im.count = spots.length;
  root.add(im);
  const yaw = spots.map(() => 0);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
  let t = 0;
  const sample = { dir: new THREE.Vector2(), strength: 0, gust: 0 };
  return {
    update(dt) {
      t += dt;
      spots.forEach((p, i) => {
        ctx.wind.sample(p.x, p.z, sample);
        const want = Math.atan2(sample.dir.y, -sample.dir.x) + Math.sin(t * (2.3 + i) + i * 1.7) * 0.25 * (0.2 + sample.gust);
        let d = want - yaw[i];
        while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        yaw[i] += d * Math.min(1, dt * 1.5);
        e.set(0, yaw[i], 0);
        q.setFromEuler(e);
        im.setMatrixAt(i, m.compose(p, q, one));
      });
      im.instanceMatrix.needsUpdate = true;
    },
  };
}
