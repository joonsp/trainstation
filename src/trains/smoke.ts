import * as THREE from 'three';

export const PUFF_SMOKE = 0;
export const PUFF_STEAM = 1;
export const PUFF_GHOST = 2;

const MAX_PUFFS = 420;
const MAX_SPARKS = 160;

const C_SMOKE0 = new THREE.Color(0x353434);
const C_SMOKE1 = new THREE.Color(0xa29d96);
const C_STEAM0 = new THREE.Color(0xf4f2ee);
const C_STEAM1 = new THREE.Color(0xd9d6d0);
const C_GHOST0 = new THREE.Color(0xdcecf2);
const C_GHOST1 = new THREE.Color(0xa8c4ce);

/**
 * Pooled chimney smoke / steam puffs (one InstancedMesh, flat-shaded low-poly blobs that grow and shrink
 * instead of fading so they stay opaque and cheap) plus additive night sparks (one Points object).
 * Ages with REAL dt (visual effect); emission is driven by the trains.
 */
export class Smoke {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private glowAttr: THREE.InstancedBufferAttribute;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private pos = new Float32Array(MAX_PUFFS * 3);
  private vel = new Float32Array(MAX_PUFFS * 3);
  private age = new Float32Array(MAX_PUFFS);
  private life = new Float32Array(MAX_PUFFS);
  private size = new Float32Array(MAX_PUFFS);
  private kind = new Uint8Array(MAX_PUFFS);
  private spin = new Float32Array(MAX_PUFFS);
  private next = 0;
  private alive = 0;
  private uNight = { value: 0 };

  private sparkGeo: THREE.BufferGeometry;
  private sparkPos = new Float32Array(MAX_SPARKS * 3);
  private sparkCol = new Float32Array(MAX_SPARKS * 3);
  private sparkVel = new Float32Array(MAX_SPARKS * 3);
  private sparkAge = new Float32Array(MAX_SPARKS);
  private sparkLife = new Float32Array(MAX_SPARKS);
  private sparkNext = 0;
  private sparks: THREE.Points;

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  constructor() {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    // transparent so old puffs dissolve instead of lingering as solid grey balls in the iso view
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1, metalness: 0, transparent: true, depthWrite: false });
    const uNight = this.uNight;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = uNight;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute float aAlpha;\nvarying float vGlow;\nvarying float vAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\nvAlpha = aAlpha;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vGlow;\nvarying float vAlpha;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            vec3 wn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
            float under = clamp(-wn.y * 0.8 + 0.25, 0.0, 1.0);
            totalEmissiveRadiance += vec3(1.0, 0.45, 0.16) * under * vGlow * uNight * 1.3 + vec3(0.05, 0.05, 0.06) * uNight;
          }`);
    };
    mat.customProgramCacheKey = () => 'trainSmokeGlow';
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_PUFFS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS), 1);
    this.glowAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aGlow', this.glowAttr);
    this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS), 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alphaAttr);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.name = 'trainSmoke';
    this.group.add(this.mesh);

    this.sparkGeo = new THREE.BufferGeometry();
    for (let i = 0; i < MAX_SPARKS; i++) { this.sparkPos[i * 3 + 1] = -1000; }
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.sparkGeo.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3).setUsage(THREE.DynamicDrawUsage));
    const smat = new THREE.PointsMaterial({
      size: 5, sizeAttenuation: false, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.sparks = new THREE.Points(this.sparkGeo, smat);
    this.sparks.frustumCulled = false;
    this.sparks.name = 'trainSparks';
    this.group.add(this.sparks);
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, kind: number, life = 3.2): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PUFFS;
    if (this.age[i] >= this.life[i]) this.alive++;
    this.alive = Math.min(this.alive, MAX_PUFFS);
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life * (0.8 + Math.random() * 0.4);
    this.size[i] = size;
    this.kind[i] = kind;
    this.spin[i] = Math.random() * 6.28;
  }

  spark(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const i = this.sparkNext;
    this.sparkNext = (this.sparkNext + 1) % MAX_SPARKS;
    this.sparkPos[i * 3] = x; this.sparkPos[i * 3 + 1] = y; this.sparkPos[i * 3 + 2] = z;
    this.sparkVel[i * 3] = vx + (Math.random() - 0.5) * 2.5;
    this.sparkVel[i * 3 + 1] = vy + 3 + Math.random() * 4;
    this.sparkVel[i * 3 + 2] = vz + (Math.random() - 0.5) * 2.5;
    this.sparkAge[i] = 0;
    this.sparkLife[i] = 0.5 + Math.random() * 0.7;
  }

  update(dt: number, windX: number, windZ: number, night: number): void {
    this.uNight.value = night;
    const n = MAX_PUFFS;
    let count = 0;
    const mesh = this.mesh;
    const col = mesh.instanceColor!;
    const glow = this.glowAttr.array as Float32Array;
    const alpha = this.alphaAttr.array as Float32Array;
    for (let i = 0; i < n; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      const k = this.age[i] / this.life[i];
      if (k >= 1) continue;
      const j = i * 3;
      // rise decays, wind takes over, initial (train-induced) drift damps
      const damp = Math.exp(-1.6 * dt);
      this.vel[j] = this.vel[j] * damp + windX * (1 - damp);
      this.vel[j + 2] = this.vel[j + 2] * damp + windZ * (1 - damp);
      this.vel[j + 1] = this.vel[j + 1] * Math.exp(-0.9 * dt) + 0.25 * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      const grow = k < 0.15 ? k / 0.15 : 1;
      // late in life: dissolve (alpha) while shrinking gently, so stragglers never read as solid balls
      const fade = k > 0.45 ? 1 - (k - 0.45) / 0.55 : 1;
      const sc = this.size[i] * (0.45 + 1.25 * Math.sqrt(k)) * grow * (0.55 + 0.45 * fade);
      this.e.set(this.spin[i], this.spin[i] * 0.7 + k, 0);
      this.q.setFromEuler(this.e);
      this.m.compose(this.v.set(this.pos[j], this.pos[j + 1], this.pos[j + 2]), this.q, this.s.set(sc, sc * 0.85, sc));
      mesh.setMatrixAt(count, this.m);
      const kd = this.kind[i];
      const a = kd === PUFF_STEAM ? C_STEAM0 : kd === PUFF_GHOST ? C_GHOST0 : C_SMOKE0;
      const b = kd === PUFF_STEAM ? C_STEAM1 : kd === PUFF_GHOST ? C_GHOST1 : C_SMOKE1;
      this.c.copy(a).lerp(b, Math.min(1, k * 1.4));
      // at night the scene light is dim already; lift smoke slightly so the plume still reads against dark ground
      if (night > 0 && kd === PUFF_SMOKE) this.c.lerp(C_SMOKE1, 0.35 * night);
      col.setXYZ(count, this.c.r, this.c.g, this.c.b);
      alpha[count] = (kd === PUFF_GHOST ? 0.7 : 0.92) * fade * fade;
      glow[count] = kd === PUFF_SMOKE ? Math.max(0, 1 - k * 2.2) : kd === PUFF_STEAM ? 0.25 : 0;
      count++;
    }
    mesh.count = count;
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      col.needsUpdate = true;
      this.glowAttr.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
    }

    // sparks
    let anySpark = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.sparkAge[i] >= this.sparkLife[i]) continue;
      anySpark = true;
      this.sparkAge[i] += dt;
      const j = i * 3;
      const k = this.sparkAge[i] / this.sparkLife[i];
      if (k >= 1) { this.sparkPos[j + 1] = -1000; continue; }
      this.sparkVel[j + 1] -= 6 * dt;
      this.sparkVel[j] += (windX - this.sparkVel[j]) * dt;
      this.sparkVel[j + 2] += (windZ - this.sparkVel[j + 2]) * dt;
      this.sparkPos[j] += this.sparkVel[j] * dt;
      this.sparkPos[j + 1] += this.sparkVel[j + 1] * dt;
      this.sparkPos[j + 2] += this.sparkVel[j + 2] * dt;
      const f = (1 - k) * (1 - k);
      this.sparkCol[j] = 1.0 * f * 1.6; this.sparkCol[j + 1] = 0.55 * f * 1.6; this.sparkCol[j + 2] = 0.15 * f * 1.6;
    }
    if (anySpark) {
      this.sparkGeo.getAttribute('position').needsUpdate = true;
      this.sparkGeo.getAttribute('color').needsUpdate = true;
    }
    this.sparks.visible = anySpark;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.sparkGeo.dispose();
    (this.sparks.material as THREE.Material).dispose();
  }
}
