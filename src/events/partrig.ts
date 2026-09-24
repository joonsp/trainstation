/**
 * PART RIG: turns a hierarchy of separately-animated vertex-coloured meshes (a goose's body, neck and wings; a
 * cow's legs, head and tail …) into ONE draw call (+ one shadow draw) without touching the code that animates it.
 *
 *  - At construction every vcMat mesh under `root` is baked into a single geometry in root space (bind pose) with
 *    a per-vertex part index; the original meshes stay in the hierarchy as invisible transform nodes (layers
 *    mask 0: not drawn in the main or shadow pass, but their children are still traversed).
 *  - Each frame `update()` computes, for every part, (current root-relative matrix) × (bind matrix)⁻¹ and uploads
 *    it as a uniform array; the vertex shader applies it (positions and normals), and the shadow depth material
 *    does the same so shadows move with the limbs.
 *  - Meshes with other materials (glowing flames, transparent envelopes) are left alone and drawn as they are.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { chain, inject } from '../core/shaderMods';

const MAXP = 12;
const _m = new THREE.Matrix4();

function isVc(m: THREE.Mesh): boolean {
  const mat = m.material as THREE.Material & { vertexColors?: boolean; transparent?: boolean };
  return !Array.isArray(m.material) && !!mat.vertexColors && !mat.transparent && !!m.geometry.getAttribute('color');
}

export class PartRig {
  readonly mesh: THREE.Mesh | null = null;
  private parts: THREE.Object3D[] = [];
  private bindInv: THREE.Matrix4[] = [];
  private u: { value: THREE.Matrix4[] } = { value: [] };
  private depth: THREE.MeshDepthMaterial | null = null;

  constructor(private root: THREE.Object3D, double = false) {
    root.updateMatrixWorld(true);
    const rootInv = root.matrixWorld.clone().invert();
    const found: THREE.Mesh[] = [];
    root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && isVc(m) && found.length < MAXP) found.push(m); });
    if (found.length < 2) return; // nothing to gain
    const geos: THREE.BufferGeometry[] = [];
    found.forEach((m, i) => {
      const rel = rootInv.clone().multiply(m.matrixWorld);
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') g.deleteAttribute(k);
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      g.applyMatrix4(rel);
      g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(i), 1));
      geos.push(g);
      this.parts.push(m);
      this.bindInv.push(rel.clone().invert());
      this.u.value.push(new THREE.Matrix4());
      m.layers.mask = 0;
    });
    while (this.u.value.length < MAXP) this.u.value.push(new THREE.Matrix4());
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) { found.forEach((m) => m.layers.set(0)); this.parts = []; return; }
    merged.computeBoundingSphere();
    if (merged.boundingSphere) merged.boundingSphere.radius *= 1.6; // limbs swing beyond the bind pose
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8, metalness: 0.05, side: double ? THREE.DoubleSide : THREE.FrontSide });
    mat.name = 'events-partrig';
    const u = this.u;
    chain(mat, 'events:partrig', (sh) => {
      sh.uniforms.uPart = u;
      sh.vertexShader = inject(sh.vertexShader, '#include <common>', `attribute float aPart;\nuniform mat4 uPart[${MAXP}];`);
      sh.vertexShader = inject(sh.vertexShader, '#include <beginnormal_vertex>', 'objectNormal = mat3(uPart[int(aPart + 0.5)]) * objectNormal;');
      sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', 'transformed = (uPart[int(aPart + 0.5)] * vec4(transformed, 1.0)).xyz;');
    });
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    chain(depth, 'events:partrig', (sh) => {
      sh.uniforms.uPart = u;
      sh.vertexShader = inject(sh.vertexShader, '#include <common>', `attribute float aPart;\nuniform mat4 uPart[${MAXP}];`);
      sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', 'transformed = (uPart[int(aPart + 0.5)] * vec4(transformed, 1.0)).xyz;');
    });
    this.depth = depth;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = 'partrig';
    mesh.castShadow = true;
    mesh.customDepthMaterial = depth;
    mesh.userData.ownMat = true;
    root.add(mesh);
    (this as { mesh: THREE.Mesh | null }).mesh = mesh;
    this.update();
  }

  /** after the animation code has posed the parts */
  update(): void {
    if (!this.mesh) return;
    for (let i = 0; i < this.parts.length; i++) {
      // root-relative matrix of the part now = product of local matrices up to (not including) root
      let o: THREE.Object3D | null = this.parts[i];
      o.updateMatrix();
      _m.copy(o.matrix);
      o = o.parent;
      while (o && o !== this.root) { o.updateMatrix(); _m.premultiply(o.matrix); o = o.parent; }
      this.u.value[i].multiplyMatrices(_m, this.bindInv[i]);
    }
  }

  dispose(): void { this.depth?.dispose(); }
}
