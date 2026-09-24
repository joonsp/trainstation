import * as THREE from 'three';
import type { Ctx } from '../core/types';

/**
 * DEBUG ONLY (`?debug=natureground`): a plain ground mesh from layout.heightAt so the river valley, banks and
 * nature can be judged while world still renders the v1 terrain. Hides the world group after 'ready'.
 */
export function debugGround(ctx: Ctx): THREE.Mesh {
  const L = ctx.layout;
  const half = 420, cell = 3;
  const n = Math.round((2 * half) / cell) + 1;
  const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3);
  const c = new THREE.Color();
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = -half + i * cell, z = -half + j * cell;
    const y = L.heightAt(x, z);
    const k = (j * n + i) * 3;
    pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
    const rd = L.terrain.roadDist(x, z);
    const tw = L.river.towpath;
    void tw;
    if (rd < 0) c.set(0x9b8f7e);
    else if (y < -1.8) c.set(0x7d8a52);
    else c.set(0x6f8f4e);
    col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
  }
  const idx: number[] = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
  m.name = 'nature:debugGround';
  m.receiveShadow = true;
  ctx.bus.on('ready', () => {
    const w = ctx.scene.getObjectByName('world');
    if (w) w.visible = false;
  });
  return m;
}
