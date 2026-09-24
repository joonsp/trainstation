import * as THREE from 'three';
import { cloneWithChain, withDitherFade } from '../core/shaderMods';

/**
 * OCCLUDERS (v2): big station structures the camera may fade (dithered, opaque — no sorting) when the followed or
 * selected thing is behind them. Each occluder's meshes get private material copies (cloneWithChain keeps the
 * detail/snow/weather patches) sharing one fade uniform; the copies re-sync colour/roughness/emissive from their
 * base every frame so night, weather and lamp glow stay global. No extra draw calls.
 */
export interface Occluders {
  add(id: string, objects: THREE.Object3D[]): void;
  list(): { id: string; bounds: THREE.Box3 }[];
  setFade(id: string, a: number): void;
  update(dt: number): void;
}

export function createOccluders(): Occluders {
  const items = new Map<string, { bounds: THREE.Box3; u: { value: number }; target: number; objs: THREE.Object3D[] }>();
  const pairs: { base: THREE.MeshStandardMaterial; copy: THREE.MeshStandardMaterial }[] = [];
  return {
    add(id, objects) {
      const u = { value: 1 };
      const cache = new Map<THREE.Material, THREE.Material>();
      const bounds = new THREE.Box3();
      for (const o of objects) {
        o.updateMatrixWorld(true);
        bounds.expandByObject(o);
        o.traverse((c) => {
          const mesh = c as THREE.Mesh;
          if (!mesh.isMesh) return;
          const base = mesh.material as THREE.Material;
          if (Array.isArray(base)) return;
          let copy = cache.get(base);
          if (!copy) {
            copy = cloneWithChain(base);
            copy.name = `${base.name}:occ:${id}`;
            withDitherFade(copy, u);
            cache.set(base, copy);
            if ((base as THREE.MeshStandardMaterial).isMeshStandardMaterial) pairs.push({ base: base as THREE.MeshStandardMaterial, copy: copy as THREE.MeshStandardMaterial });
          }
          mesh.material = copy;
          c.userData.occluder = id;
        });
        o.userData.occluder = id;
      }
      items.set(id, { bounds, u, target: 1, objs: objects });
    },
    list() { return [...items].map(([id, v]) => ({ id, bounds: v.bounds })); },
    setFade(id, a) { const it = items.get(id); if (it) it.target = THREE.MathUtils.clamp(a, 0, 1); },
    update(dt) {
      for (const it of items.values()) {
        const d = it.target - it.u.value;
        if (d !== 0) it.u.value = Math.abs(d) < dt * 3 ? it.target : it.u.value + Math.sign(d) * dt * 3;
        // hide completely when fully faded (saves the draw too)
        const vis = it.u.value > 0.02;
        for (const o of it.objs) if (o.visible !== vis) o.visible = vis;
      }
      for (const p of pairs) {
        p.copy.color.copy(p.base.color);
        p.copy.roughness = p.base.roughness;
        p.copy.emissiveIntensity = p.base.emissiveIntensity;
      }
    },
  };
}
