import * as THREE from 'three';
import { makeBody, makeFamily, makeHat, NECK, PROP_FAMILY, setPeopleLowPoly, type AccKind, type BodyKind, type HatKind, type PropFamily } from './geometry';

/*
 * Instanced people renderer. Each body kind (4), hat kind (12) and prop family (5) is one InstancedMesh with its
 * instances packed per rendered frame (only on-screen wearers; empty meshes cost no draw call). Per-instance attributes:
 *   iColA..D : colours (A primary, B secondary, C trim, D skin)
 *   iAnim    : walkPhase, walkAmp, sit, breathPhase
 *   iArm     : rightTarget, rightWeight, leftTarget, leftWeight (arm pitch targets blended over the walk swing)
 *   iAux     : headYaw, headPitch, fade (1 visible … 0 gone; dithered), propId (prop-family meshes)
 * Limb swing, arm poses, head turns/nods, breathing, sitting, door fades and prop selection all happen in the
 * vertex/fragment shader; the CPU writes one matrix + three vec4 per part per RENDERED frame.
 * Shadows use a depth material with the same rig, so animated limbs, collapsed props and fades are correct.
 */

const shared = {
  uNight: { value: 0 },
  uGlow: { value: 0 },
  uTime: { value: 0 },
};

const VERT_COMMON = `
attribute vec3 pplMeta;
#define slot (pplMeta.x)
#define rig (pplMeta.y)
#define pid (pplMeta.z)
attribute vec4 iAnim;
attribute vec4 iArm;
attribute vec4 iAux;
uniform float uTime;
varying float vPplFade;
vec3 pplRotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
vec3 pplRotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c); }`;

const VERT_RIG = `vec3 transformed = vec3(position);
vPplFade = iAux.z;
if (pid > -0.5 && abs(pid - iAux.w) > 0.5) {
  transformed = vec3(0.0);
} else {
  float ph = iAnim.x; float amp = iAnim.y; float sit = iAnim.z;
  float breath = sin(uTime * 1.7 + iAnim.w) * 0.012 * (1.0 - clamp(amp * 3.0, 0.0, 1.0));
  if (rig > 0.5 && rig < 2.5) {
    float side = rig < 1.5 ? 1.0 : -1.0;
    float a = mix(side * sin(ph) * amp, -1.45, sit);
    transformed = pplRotX(transformed - vec3(0.0, 0.85, 0.0), a) + vec3(0.0, 0.85, 0.0);
  } else if (rig > 2.5 && rig < 4.5) {
    bool isRight = rig > 3.5;
    float side = isRight ? -1.0 : 1.0;
    float a = side * sin(ph) * amp * 0.85;
    float tgt = isRight ? iArm.x : iArm.z;
    float w = isRight ? iArm.y : iArm.w;
    a = mix(a, tgt, w);
    a = mix(a, -0.55, sit * (1.0 - w));
    transformed = pplRotX(transformed - vec3(0.0, 1.4, 0.0), a) + vec3(0.0, 1.4 + breath, 0.0);
  } else if (rig > 4.5) {
    vec3 hp = transformed - vec3(0.0, ${NECK.toFixed(3)}, 0.0);
    hp = pplRotY(pplRotX(hp, iAux.y), iAux.x);
    transformed = hp + vec3(0.0, ${NECK.toFixed(3)} + breath, 0.0);
  } else {
    if (sit > 0.0 && transformed.y < 0.85) {
      float d = 0.85 - transformed.y;
      transformed.y = mix(transformed.y, 0.85 - d * 0.3, sit);
      transformed.z += d * 0.8 * sit;
    }
    transformed.y += breath * smoothstep(0.95, 1.4, transformed.y);
  }
}`;

const FRAG_DITHER = `
float pplBayer(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  float i = q.x + q.y * 4.0;
  // 4x4 ordered dither thresholds
  float t = 0.0;
  if (i < 0.5) t = 0.0; else if (i < 1.5) t = 8.0; else if (i < 2.5) t = 2.0; else if (i < 3.5) t = 10.0;
  else if (i < 4.5) t = 12.0; else if (i < 5.5) t = 4.0; else if (i < 6.5) t = 14.0; else if (i < 7.5) t = 6.0;
  else if (i < 8.5) t = 3.0; else if (i < 9.5) t = 11.0; else if (i < 10.5) t = 1.0; else if (i < 11.5) t = 9.0;
  else if (i < 12.5) t = 15.0; else if (i < 13.5) t = 7.0; else if (i < 14.5) t = 13.0; else t = 5.0;
  return (t + 0.5) / 16.0;
}`;

function createPeopleMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82, metalness: 0 });
  mat.name = 'people';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = shared.uNight;
    sh.uniforms.uGlow = shared.uGlow;
    sh.uniforms.uTime = shared.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
${VERT_COMMON}
attribute vec3 iColA;
attribute vec3 iColB;
attribute vec3 iColC;
attribute vec3 iColD;
varying float vPplGlow;`)
      .replace('#include <begin_vertex>', `${VERT_RIG}
vPplGlow = slot > 4.5 ? 1.0 : 0.0;
#ifdef USE_ALPHAHASH
  vPosition = vec3(position);
#endif`)
      .replace('#include <color_vertex>', `
  vec3 pplCol = slot < 0.5 ? iColA : (slot < 1.5 ? iColB : (slot < 2.5 ? iColC : (slot < 3.5 ? iColD : vec3(1.0))));
  vColor = vec4(color * pplCol, 1.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight;
uniform float uGlow;
varying float vPplFade;
varying float vPplGlow;
${FRAG_DITHER}`)
      .replace('#include <clipping_planes_fragment>', `if (vPplFade < 0.999 && vPplFade <= pplBayer(gl_FragCoord.xy)) discard;
#include <clipping_planes_fragment>`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * (uNight + vPplGlow * uGlow * 2.2);`);
  };
  mat.customProgramCacheKey = () => 'people-rig-v2';
  return mat;
}

function createDepthMaterial(): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.name = 'people-depth';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_COMMON}`)
      .replace('#include <begin_vertex>', VERT_RIG);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPplFade;')
      .replace('#include <clipping_planes_fragment>', 'if (vPplFade < 0.5) discard;\n#include <clipping_planes_fragment>');
  };
  mat.customProgramCacheKey = () => 'people-depth-v2';
  return mat;
}

/**
 * One instanced part (a body kind, a hat kind or a prop family). Instances are PACKED EVERY RENDERED FRAME: only
 * people on screen are written, densely, so `mesh.count` is the number of visible wearers — offscreen people cost no
 * triangles in the main or shadow pass, and a part nobody on screen wears costs no draw call at all.
 */
export class PartMesh {
  mesh: THREE.InstancedMesh;
  private colA: THREE.InstancedBufferAttribute;
  private colB: THREE.InstancedBufferAttribute;
  private colC: THREE.InstancedBufferAttribute;
  private colD: THREE.InstancedBufferAttribute;
  private anim: THREE.InstancedBufferAttribute;
  private arm: THREE.InstancedBufferAttribute;
  private aux: THREE.InstancedBufferAttribute;
  /** instance -> owner person number (for raycast), valid for [0, used) */
  owner: Int32Array;
  used = 0;

  constructor(public name: string, geo: THREE.BufferGeometry, mat: THREE.Material, depth: THREE.Material, public capacity: number, shadow: boolean) {
    const mk = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.colA = mk(3); this.colB = mk(3); this.colC = mk(3); this.colD = mk(3);
    this.anim = mk(4); this.arm = mk(4); this.aux = mk(4);
    geo.setAttribute('iColA', this.colA); geo.setAttribute('iColB', this.colB);
    geo.setAttribute('iColC', this.colC); geo.setAttribute('iColD', this.colD);
    geo.setAttribute('iAnim', this.anim); geo.setAttribute('iArm', this.arm); geo.setAttribute('iAux', this.aux);
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.name = 'people:' + name;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = false;
    this.mesh.customDepthMaterial = depth;
    this.owner = new Int32Array(capacity).fill(-1);
  }

  begin(): void { this.used = 0; }

  /** append one visible instance; `cols` holds rgb triplets A,B,C(,D) starting at `off` */
  push(owner: number, m: THREE.Matrix4, anim: THREE.Vector4, arm: THREE.Vector4, aux: THREE.Vector4, cols: Float32Array, off: number, hasD: boolean): void {
    if (this.used >= this.capacity) return;
    const i = this.used++;
    this.owner[i] = owner;
    m.toArray(this.mesh.instanceMatrix.array as Float32Array, i * 16);
    const an = this.anim.array as Float32Array, ar = this.arm.array as Float32Array, ax = this.aux.array as Float32Array;
    const j = i * 4;
    an[j] = anim.x; an[j + 1] = anim.y; an[j + 2] = anim.z; an[j + 3] = anim.w;
    ar[j] = arm.x; ar[j + 1] = arm.y; ar[j + 2] = arm.z; ar[j + 3] = arm.w;
    ax[j] = aux.x; ax[j + 1] = aux.y; ax[j + 2] = aux.z; ax[j + 3] = aux.w;
    const k = i * 3;
    const a = this.colA.array as Float32Array, b = this.colB.array as Float32Array, c = this.colC.array as Float32Array;
    a[k] = cols[off]; a[k + 1] = cols[off + 1]; a[k + 2] = cols[off + 2];
    b[k] = cols[off + 3]; b[k + 1] = cols[off + 4]; b[k + 2] = cols[off + 5];
    c[k] = cols[off + 6]; c[k + 1] = cols[off + 7]; c[k + 2] = cols[off + 8];
    if (hasD) { const d = this.colD.array as Float32Array; d[k] = cols[off + 9]; d[k + 1] = cols[off + 10]; d[k + 2] = cols[off + 11]; }
  }

  /** finish the frame: draw exactly the packed instances and upload only that range */
  end(): void {
    const n = this.used;
    this.mesh.count = n;
    if (n === 0) return;
    const up = (a: THREE.BufferAttribute) => { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; };
    up(this.mesh.instanceMatrix);
    up(this.anim); up(this.arm); up(this.aux);
    up(this.colA); up(this.colB); up(this.colC); up(this.colD);
  }
}

export const BODY_KINDS: BodyKind[] = ['coat', 'uniform', 'jacket', 'dress'];
export const HAT_KINDS: HatKind[] = ['topHat', 'bowler', 'bonnet', 'flatCap', 'peakedCap', 'helmet', 'veil', 'shako', 'boater', 'hairShort', 'hairBun', 'straw'];
export const FAMILIES: PropFamily[] = ['umbrella', 'trolley', 'bags', 'tools', 'fete'];

export class PeopleRenderer {
  group = new THREE.Group();
  bodies = {} as Record<BodyKind, PartMesh>;
  hats = {} as Record<HatKind, PartMesh>;
  fams = {} as Record<PropFamily, PartMesh>;
  all: PartMesh[] = [];
  material = createPeopleMaterial();
  depth = createDepthMaterial();
  /** called once per rendered frame (before the scene draws) */
  onFrame: (() => void) | null = null;
  private lastFrame = -1;

  constructor(private renderer: THREE.WebGLRenderer, capacity: number, lowTier = false) {
    this.group.name = 'people';
    // low tier: fewer segments, and figures cast no shadows (the shadow pass would double their triangles)
    setPeopleLowPoly(lowTier);
    const shadows = !lowTier;
    const cap = (k: string) => {
      if (k === 'coat' || k === 'dress') return capacity;
      if (k === 'uniform' || k === 'jacket') return Math.ceil(capacity * 0.6);
      if (k === 'bowler' || k === 'topHat' || k === 'bonnet' || k === 'hairShort' || k === 'hairBun' || k === 'flatCap' || k === 'straw') return Math.ceil(capacity * 0.6);
      if (k === 'umbrella' || k === 'bags') return capacity;
      if (k === 'tools') return Math.ceil(capacity * 0.4);
      return 96;
    };
    for (const k of BODY_KINDS) this.add(this.bodies, k, new PartMesh(k, makeBody(k), this.material, this.depth, cap(k), shadows));
    for (const k of HAT_KINDS) this.add(this.hats, k, new PartMesh(k, makeHat(k), this.material, this.depth, cap(k), false));
    for (const f of FAMILIES) this.add(this.fams, f, new PartMesh(f, makeFamily(f), this.material, this.depth, cap(f), shadows && (f === 'trolley' || f === 'umbrella' || f === 'tools')));

    // Flush hook: an invisible, never-culled mesh drawn first each frame. Sim updates may run many times per
    // frame (sub-stepping at 60x, advance()), so instance buffers are written once, right before drawing.
    const hookGeo = new THREE.BufferGeometry();
    hookGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const hook = new THREE.Mesh(hookGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
    hook.frustumCulled = false;
    hook.renderOrder = -1e9;
    hook.name = 'people:flush';
    hook.onBeforeRender = () => this.frame();
    this.group.add(hook);
    // shadows render before the main pass; flush there too so shadows don't lag a frame
    this.bodies.coat.mesh.onBeforeShadow = () => this.frame();
  }

  private add<K extends string>(rec: Record<K, PartMesh>, k: K, pm: PartMesh) {
    rec[k] = pm;
    this.all.push(pm);
    this.group.add(pm.mesh);
  }

  famOf(a: AccKind): PartMesh { return this.fams[PROP_FAMILY[a]]; }

  private frame() {
    const f = this.renderer.info.render.frame;
    if (f === this.lastFrame) return;
    this.lastFrame = f;
    this.flush();
  }

  /** pack + upload now (also used by raycasts between frames) */
  flush() {
    for (const pm of this.all) pm.begin();
    this.onFrame?.();
    for (const pm of this.all) pm.end();
  }

  setNightLift(v: number, glow: number, time: number) { shared.uNight.value = v; shared.uGlow.value = glow; shared.uTime.value = time; }

  /** nearest hit among bodies + hats */
  raycast(r: THREE.Raycaster): { owner: number; distance: number } | null {
    let best: { owner: number; distance: number } | null = null;
    const hits: THREE.Intersection[] = [];
    for (const pm of [...Object.values(this.bodies), ...Object.values(this.hats)]) {
      if (pm.used === 0) continue;
      pm.mesh.computeBoundingSphere();
      hits.length = 0;
      pm.mesh.raycast(r, hits);
      for (const h of hits) {
        if (h.instanceId === undefined) continue;
        const o = pm.owner[h.instanceId];
        if (o < 0) continue;
        if (!best || h.distance < best.distance) best = { owner: o, distance: h.distance };
      }
    }
    return best;
  }

  dispose() {
    for (const pm of this.all) { pm.mesh.geometry.dispose(); pm.mesh.dispose(); }
    this.material.dispose();
    this.depth.dispose();
  }
}
