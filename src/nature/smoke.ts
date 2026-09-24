import * as THREE from 'three';
import type { Ctx } from '../core/types';
import { chain, inject } from '../core/shaderMods';

/**
 * PUFFS — one small instanced draw for the steam launch's funnel and the narrowboat's cabin stove.
 * CPU ring buffer (a few dozen puffs, no allocations): puffs rise, swell, drift with ctx.wind and fade through a
 * per-instance alpha. Colour dims at night so the smoke never glows.
 */
export interface Puffs {
  mesh: THREE.InstancedMesh;
  emit(x: number, y: number, z: number, size: number, dark: number, vy?: number): void;
  /** dt = seconds of smoke ageing (max of real dt and motion dt) */
  update(dt: number): void;
}

export function createPuffs(ctx: Ctx, cap: number): Puffs {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const alpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
  alpha.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iAlpha', alpha);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, flatShading: true, transparent: true, depthWrite: false });
  mat.name = 'nature:puffs';
  chain(mat, 'nature:puffs', (sh) => {
    sh.vertexShader = inject(sh.vertexShader, '#include <common>', 'attribute float iAlpha; varying float vPuffA;');
    sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', 'vPuffA = iAlpha;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'varying float vPuffA;');
    sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', 'diffuseColor.a *= vPuffA;');
  });
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.name = 'nature:puffs';
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.visible = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const col = new THREE.Color();
  for (let i = 0; i < cap; i++) mesh.setColorAt(i, col.setRGB(1, 1, 1));
  const px = new Float32Array(cap), py = new Float32Array(cap), pz = new Float32Array(cap);
  const vy = new Float32Array(cap), age = new Float32Array(cap).fill(99), life = new Float32Array(cap).fill(1), size = new Float32Array(cap), shade = new Float32Array(cap);
  let next = 0, live = 0;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3(), e = new THREE.Euler();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, ZERO);
  return {
    mesh,
    emit(x, y, z, sz, dark, up = 0.7) {
      const i = next;
      next = (next + 1) % cap;
      px[i] = x; py[i] = y; pz[i] = z; vy[i] = up; age[i] = 0; life[i] = 3.2 + (i % 5) * 0.35; size[i] = sz; shade[i] = dark;
      live = cap;
      mesh.visible = true;
    },
    update(dt) {
      if (!live) return;
      const w = ctx.wind.uniforms.uWindDir.value, ws = 0.4 + ctx.wind.speed * 0.28;
      const night = ctx.mats.uniforms.uNight.value;
      let any = 0;
      for (let i = 0; i < cap; i++) {
        if (age[i] >= life[i]) { if (age[i] < 90) { mesh.setMatrixAt(i, ZERO); age[i] = 99; } continue; }
        any++;
        age[i] += dt;
        const u = Math.min(1, age[i] / life[i]);
        px[i] += w.x * ws * dt * (0.3 + u);
        pz[i] += w.y * ws * dt * (0.3 + u);
        py[i] += vy[i] * dt * (1 - u * 0.6);
        const r = size[i] * (0.35 + 1.5 * u);
        p3.set(px[i], py[i], pz[i]);
        e.set(i * 0.7, i * 1.3 + u, 0);
        q.setFromEuler(e);
        s3.set(r, r * 0.85, r);
        m4.compose(p3, q, s3);
        mesh.setMatrixAt(i, m4);
        alpha.setX(i, (1 - u) * (1 - u) * Math.min(1, age[i] * 5) * 0.8);
        const g = (0.92 - shade[i] * 0.45) * (1 - night * 0.72);
        mesh.setColorAt(i, col.setRGB(g, g, g * 1.02));
      }
      mesh.instanceMatrix.needsUpdate = true;
      alpha.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (!any) { live = 0; mesh.visible = false; }
    },
  };
}
