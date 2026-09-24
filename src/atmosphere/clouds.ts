import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Rng } from '../core/rng';

const ARCHETYPES = 4;
const PER_ARCH = 6;
const COUNT = ARCHETYPES * PER_ARCH;
const BOX = 720;

const vert = /* glsl */ `
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const frag = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uLit;
uniform vec3 uShade;
uniform float uOpacity;
uniform float uCentreFade;
uniform vec2 uRes;
uniform float uFlash;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vec3 n = normalize(vN);
  float l = max(dot(n, uSunDir), 0.0);
  float top = n.y * 0.5 + 0.5;
  vec3 col = mix(uShade, uLit, top * 0.7 + 0.3) + uSunCol * l * 0.45;
  col += vec3(0.8, 0.85, 1.0) * uFlash * 1.5;
  // keep the view centre clear: clouds frame the diorama and thicken toward the screen edges
  vec2 sp = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  sp.x *= uRes.x / uRes.y * 0.8;
  float r = length(sp);
  float a = uOpacity * mix(1.0, smoothstep(0.45, 1.15, r), uCentreFade);
  gl_FragColor = vec4(col, a);
}`;

function puff(rng: Rng): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const n = rng.int(5, 8);
  const len = rng.range(28, 46);
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0.5 : i / (n - 1);
    const mid = 1 - Math.abs(f - 0.5) * 2;
    const r = rng.range(6, 9) + mid * rng.range(4, 8);
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.scale(1, rng.range(0.55, 0.75), rng.range(0.8, 1.05));
    g.rotateY(rng.range(0, Math.PI));
    g.translate((f - 0.5) * len + rng.range(-3, 3), mid * rng.range(2, 5), rng.range(-6, 6));
    parts.push(g.index ? g.toNonIndexed() : g);
  }
  // flat base
  return parts;
}

interface CloudInst { x: number; z: number; y: number; scale: number; yaw: number; order: number }

export class Clouds {
  readonly group = new THREE.Group();
  private visMeshes: THREE.InstancedMesh[] = [];
  private insts: CloudInst[] = [];
  private drift = new THREE.Vector2();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  readonly uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color() },
    uLit: { value: new THREE.Color(0xffffff) },
    uShade: { value: new THREE.Color(0x8890a0) },
    uOpacity: { value: 0.9 },
    uCentreFade: { value: 1 },
    uRes: { value: new THREE.Vector2(1280, 800) },
    uFlash: { value: 0 },
  };

  constructor(rng: Rng) {
    const visMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vert, fragmentShader: frag,
      transparent: true, depthWrite: false, fog: false,
    });
    for (let a = 0; a < ARCHETYPES; a++) {
      const geo = mergeGeometries(puff(rng))!;
      geo.computeVertexNormals();
      const vis = new THREE.InstancedMesh(geo, visMat, PER_ARCH);
      vis.frustumCulled = false;
      vis.renderOrder = 50;
      vis.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.visMeshes.push(vis);
      this.group.add(vis);
    }
    // order: the first clouds to appear as cover rises; spread them evenly so low cover is still scattered
    const order = Array.from({ length: COUNT }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = rng.int(0, i); [order[i], order[j]] = [order[j], order[i]]; }
    for (let i = 0; i < COUNT; i++) {
      this.insts.push({
        x: rng.range(0, BOX), z: rng.range(0, BOX), y: rng.range(62, 92),
        scale: rng.range(0.85, 1.4), yaw: rng.range(-0.4, 0.4), order: order[i] / COUNT,
      });
    }
    this.group.name = 'clouds';
  }

  /**
   * Visible low-poly puffs, only shown in perspective views where there is sky behind them (in the
   * isometric view they would sit between camera and diorama; CloudShadows covers that case).
   * @param cover 0..1 cloud cover
   */
  update(dt: number, focus: THREE.Vector3, wind: THREE.Vector2, cover: number, visible: boolean): void {
    this.drift.x += wind.x * dt * 2.2;
    this.drift.y += wind.y * dt * 2.2;
    const show = visible && cover > 0.02;
    for (const m of this.visMeshes) m.visible = show;
    if (!show) return;
    const half = BOX / 2;
    for (let i = 0; i < COUNT; i++) {
      const c = this.insts[i];
      // grow in as cover rises past this cloud's slot; heavy cover makes every cloud fatter
      const k = THREE.MathUtils.clamp((cover * 1.05 - c.order) * 6, 0, 1);
      const sc = c.scale * k * (0.8 + cover * 0.9);
      const x = focus.x + THREE.MathUtils.euclideanModulo(c.x + this.drift.x - focus.x + half, BOX) - half;
      const z = focus.z + THREE.MathUtils.euclideanModulo(c.z + this.drift.y - focus.z + half, BOX) - half;
      this.v.set(x, c.y, z);
      this.q.setFromAxisAngle(this.up, c.yaw + Math.atan2(-wind.y, wind.x) * 0.3);
      this.s.set(sc, sc * (0.9 + cover * 0.3), sc);
      this.m4.compose(this.v, this.q, this.s);
      const a = i % ARCHETYPES, j = Math.floor(i / ARCHETYPES);
      this.visMeshes[a].setMatrixAt(j, this.m4);
    }
    for (let a = 0; a < ARCHETYPES; a++) {
      this.visMeshes[a].instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of this.visMeshes) m.geometry.dispose();
    (this.visMeshes[0].material as THREE.Material).dispose();
  }
}
