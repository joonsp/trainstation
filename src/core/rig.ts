import * as THREE from 'three';
import { chain, inject } from './shaderMods';

/**
 * INSTANCED RIGS (v2): one draw call per species/vehicle-part kind, animated in the vertex shader — no bones.
 * Each vertex carries its part id and the part's pivot; each instance carries 4 colours and two vec4 animation
 * channels. A species supplies a GLSL `rigPose()` that moves `p` (object-space, after the part pivot is known).
 * Materials are flat-shaded, so normals come from screen derivatives and need no rotation.
 *
 * Instance buffers are uploaded once per RENDERED frame (onBeforeRender), never per sim sub-step.
 * Hidden/free slots get a zero-scale matrix. Shadows animate too (customDepthMaterial carries the pose).
 *
 *   const horse = new InstancedRig({ name: 'horses', geometry: horseGeometry(), glsl: HORSE_POSE_GLSL, capacity: 32 });
 *   scene.add(horse.mesh);
 *   const i = horse.alloc(); horse.setTransform(i, pos, yaw); horse.setColors(i, [coat, mane, hoof, tack]);
 *   horse.setAnim(i, gaitPhase, gaitAmp, headNod, tailSwish); horse.setAux(i, stampLeg, stampPhase, graze, earFlick);
 */
export interface RigPart {
  geo: THREE.BufferGeometry;
  /** part id passed to rigPose (float) */
  part: number;
  /** pivot in object space (rotation centre for this part) */
  pivot: THREE.Vector3;
  /** which of the 4 per-instance colours this part uses */
  slot: 0 | 1 | 2 | 3;
}

/** merge parts into one non-indexed geometry with aPart / aPivot / aSlot attributes */
export function buildRigGeometry(parts: RigPart[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], part: number[] = [], piv: number[] = [], slot: number[] = [];
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const P = g.getAttribute('position'), N = g.getAttribute('normal');
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
      part.push(p.part); piv.push(p.pivot.x, p.pivot.y, p.pivot.z); slot.push(p.slot);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  out.setAttribute('aPivot', new THREE.Float32BufferAttribute(piv, 3));
  out.setAttribute('aSlot', new THREE.Float32BufferAttribute(slot, 1));
  out.computeBoundingSphere();
  return out;
}

/** GLSL helpers available to every rigPose */
export const RIG_GLSL_HELPERS = /* glsl */ `
vec3 rigRotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
vec3 rigRotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c); }
vec3 rigRotZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z); }
/** rotate p about pivot by (x, y, z) Euler angles applied Z, then X, then Y */
vec3 rigAbout(vec3 p, vec3 pivot, vec3 e) { vec3 q = p - pivot; q = rigRotZ(q, e.z); q = rigRotX(q, e.x); q = rigRotY(q, e.y); return q + pivot; }
`;

export interface RigOptions {
  name: string;
  geometry: THREE.BufferGeometry;
  /**
   * GLSL defining: `void rigPose(float part, vec3 pivot, vec4 anim, vec4 aux, inout vec3 p)`
   * (object space, local +x forward, y up, origin at ground under the body centre)
   */
  glsl: string;
  capacity: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** extra material params (roughness etc.). color is forced white (instance colours multiply). */
  material?: THREE.MeshStandardMaterialParameters;
  /** bounding sphere radius for the whole mesh (instances spread over the map; default: huge → never culled) */
  boundsRadius?: number;
}

export class InstancedRig {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  private freeList: number[] = [];
  private used: Uint8Array;
  private anim: THREE.InstancedBufferAttribute;
  private aux: THREE.InstancedBufferAttribute;
  private cols: THREE.InstancedBufferAttribute[];
  private dirtyM = false; private dirtyA = false; private dirtyX = false; private dirtyC = false;
  private _m = new THREE.Matrix4(); private _q = new THREE.Quaternion(); private _s = new THREE.Vector3(); private _e = new THREE.Euler(); private _c = new THREE.Color();
  private static ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(o: RigOptions) {
    this.capacity = o.capacity;
    const geo = o.geometry.clone();
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(o.capacity * 4), 4);
    this.aux = new THREE.InstancedBufferAttribute(new Float32Array(o.capacity * 4), 4);
    this.cols = [0, 1, 2, 3].map(() => new THREE.InstancedBufferAttribute(new Float32Array(o.capacity * 3).fill(1), 3));
    for (const a of [this.anim, this.aux, ...this.cols]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iAnim', this.anim);
    geo.setAttribute('iAux', this.aux);
    this.cols.forEach((c, i) => geo.setAttribute(`iC${i}`, c));
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, flatShading: true, ...o.material, color: 0xffffff });
    mat.name = `rig:${o.name}`;
    const poseInj = (sh: THREE.WebGLProgramParametersWithUniforms, withColor: boolean) => {
      sh.vertexShader = inject(sh.vertexShader, '#include <common>', `
attribute float aPart; attribute vec3 aPivot; attribute float aSlot;
attribute vec4 iAnim; attribute vec4 iAux;
${withColor ? 'attribute vec3 iC0; attribute vec3 iC1; attribute vec3 iC2; attribute vec3 iC3; varying vec3 vRigCol;' : ''}
${RIG_GLSL_HELPERS}
${o.glsl}`);
      sh.vertexShader = inject(sh.vertexShader, '#include <begin_vertex>', `
rigPose(aPart, aPivot, iAnim, iAux, transformed);
${withColor ? 'vRigCol = aSlot < 0.5 ? iC0 : aSlot < 1.5 ? iC1 : aSlot < 2.5 ? iC2 : iC3;' : ''}`);
      if (withColor) {
        sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', 'varying vec3 vRigCol;');
        sh.fragmentShader = inject(sh.fragmentShader, '#include <color_fragment>', 'diffuseColor.rgb *= vRigCol;');
      }
    };
    chain(mat, `rig:${o.name}`, (sh) => poseInj(sh, true));
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    chain(depth, `rig:${o.name}`, (sh) => poseInj(sh, false));
    this.mesh = new THREE.InstancedMesh(geo, mat, o.capacity);
    this.mesh.name = `rig:${o.name}`;
    this.mesh.customDepthMaterial = depth;
    this.mesh.castShadow = o.castShadow ?? false;
    this.mesh.receiveShadow = o.receiveShadow ?? false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // instances roam the whole map: never frustum-cull the batch unless the owner gives explicit bounds
    this.mesh.frustumCulled = o.boundsRadius !== undefined;
    if (o.boundsRadius !== undefined) this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), o.boundsRadius);
    this.used = new Uint8Array(o.capacity);
    for (let i = o.capacity - 1; i >= 0; i--) { this.freeList.push(i); this.mesh.setMatrixAt(i, InstancedRig.ZERO); }
    this.mesh.count = o.capacity;
    this.mesh.onBeforeRender = () => this.flush();
  }

  get live(): number { return this.capacity - this.freeList.length; }

  /** returns a slot index, or −1 when full */
  alloc(): number {
    const i = this.freeList.pop();
    if (i === undefined) return -1;
    this.used[i] = 1;
    return i;
  }

  free(i: number): void {
    if (i < 0 || !this.used[i]) return;
    this.used[i] = 0;
    this.mesh.setMatrixAt(i, InstancedRig.ZERO);
    this.dirtyM = true;
    this.freeList.push(i);
  }

  /** position (y = ground), yaw (rotation.y: local +x → (cos, 0, −sin)), optional pitch/roll and uniform scale */
  setTransform(i: number, pos: THREE.Vector3, yaw: number, scale = 1, pitch = 0, roll = 0): void {
    this._e.set(roll, yaw, pitch, 'YZX');
    this._q.setFromEuler(this._e);
    this._s.setScalar(scale);
    this._m.compose(pos, this._q, this._s);
    this.mesh.setMatrixAt(i, this._m);
    this.dirtyM = true;
  }

  setMatrix(i: number, m: THREE.Matrix4): void { this.mesh.setMatrixAt(i, m); this.dirtyM = true; }

  /** hide without freeing (e.g. inside a closed carriage or off-screen) */
  hide(i: number): void { this.mesh.setMatrixAt(i, InstancedRig.ZERO); this.dirtyM = true; }

  setColors(i: number, c: (number | THREE.Color)[]): void {
    for (let k = 0; k < 4 && k < c.length; k++) {
      const v = c[k];
      const col = typeof v === 'number' ? this._c.setHex(v) : v;
      this.cols[k].setXYZ(i, col.r, col.g, col.b);
    }
    this.dirtyC = true;
  }

  setAnim(i: number, x: number, y: number, z: number, w: number): void { this.anim.setXYZW(i, x, y, z, w); this.dirtyA = true; }
  setAux(i: number, x: number, y: number, z: number, w: number): void { this.aux.setXYZW(i, x, y, z, w); this.dirtyX = true; }

  /** uploads dirty buffers (called automatically before rendering) */
  flush(): void {
    if (this.dirtyM) { this.mesh.instanceMatrix.needsUpdate = true; this.dirtyM = false; }
    if (this.dirtyA) { this.anim.needsUpdate = true; this.dirtyA = false; }
    if (this.dirtyX) { this.aux.needsUpdate = true; this.dirtyX = false; }
    if (this.dirtyC) { for (const c of this.cols) c.needsUpdate = true; this.dirtyC = false; }
  }

  dispose(): void { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.customDepthMaterial?.dispose(); }
}
