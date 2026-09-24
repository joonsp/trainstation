import * as THREE from 'three';
import type { Layout } from '../core/layout';

/**
 * v2 atmosphere extras (1 draw each, hidden when unused):
 *  - RiverMist: a soft ribbon of mist lying in the river valley (dawn in calm cool weather, and fog). It sits a
 *    little above the water, so the valley banks and bridges clip it naturally and it reads as mist pooled in the
 *    low ground. World-anchored drifting noise, stretched along the flow.
 *  - EdgeHaze: a square "frame" beyond the playfield (|x|,|z| > ~415) that fades the skirt into the horizon colour,
 *    so low perspective views never see the edge of the world. Frustum-culled away in the default iso view.
 */

const mistVert = /* glsl */ `
attribute float aEdge;
attribute float aS;
varying vec2 vXZ;
varying float vEdge;
varying float vS;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vXZ = wp.xz; vEdge = aEdge; vS = aS;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const mistFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uAmount;
uniform float uTime;
uniform vec2 uDrift;
varying vec2 vXZ;
varying float vEdge;
varying float vS;
float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  // noise along the river (s) and across it, drifting slowly downstream and with the wind
  vec2 p = vec2(vS * 0.035 - uTime * 0.012, vEdge * 1.7) + (vXZ + uDrift) * 0.02;
  float n = noise(p) * 0.6 + noise(p * 2.7 + 5.3) * 0.28 + noise(p * 6.1 - 2.1) * 0.12;
  float core = smoothstep(0.0, 0.75, 1.0 - abs(vEdge));
  float a = smoothstep(0.22, 0.8, n) * core * uAmount;
  gl_FragColor = vec4(uColor, a * 0.85);
}`;

export class RiverMist {
  readonly mesh: THREE.Mesh;
  private u = {
    uColor: { value: new THREE.Color(0xe4e8ea) }, uAmount: { value: 0 }, uTime: { value: 0 }, uDrift: { value: new THREE.Vector2() },
  };
  private t = 0;

  constructor(layout: Layout) {
    const R = layout.river;
    const pos: number[] = [], edge: number[] = [], sAttr: number[] = [], idx: number[] = [];
    const ACROSS = [-1, -0.5, 0, 0.5, 1];
    const step = 5;
    const n = Math.max(2, Math.floor(R.length / step) + 1);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const s = Math.min(R.length, i * step);
      const half = R.widthAt(s) / 2 + 9;
      const y = R.waterYAt(s) + 0.75;
      for (const a of ACROSS) {
        R.pointAt(s, a * half, y, p);
        pos.push(p.x, p.y, p.z);
        edge.push(a);
        sAttr.push(s);
      }
    }
    const W = ACROSS.length;
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < W - 1; j++) {
      const a = i * W + j, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    g.setAttribute('aS', new THREE.Float32BufferAttribute(sAttr, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: mistVert, fragmentShader: mistFrag, transparent: true, depthWrite: false, fog: false,
      side: THREE.DoubleSide,
    }));
    this.mesh.name = 'riverMist';
    this.mesh.renderOrder = 39;
    this.mesh.visible = false;
  }

  update(dt: number, amount: number, color: THREE.Color, wind: THREE.Vector2): void {
    this.t += dt;
    this.mesh.visible = amount > 0.01;
    if (!this.mesh.visible) return;
    this.u.uAmount.value = amount;
    this.u.uTime.value = this.t;
    this.u.uDrift.value.addScaledVector(wind, -dt * 0.25);
    this.u.uColor.value.copy(color);
  }

  dispose(): void { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

const hazeVert = /* glsl */ `
varying vec2 vXZ;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vXZ = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const hazeFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uInner;
uniform float uOuter;
varying vec2 vXZ;
void main() {
  float d = max(abs(vXZ.x), abs(vXZ.y));
  float a = smoothstep(uInner, uOuter, d);
  gl_FragColor = vec4(uColor, a);
}`;

export class EdgeHaze {
  readonly mesh: THREE.Mesh;
  private u = { uColor: { value: new THREE.Color(0xc9dce6) }, uInner: { value: 412 }, uOuter: { value: 470 } };

  constructor(inner = 412, outer = 470, y = 6) {
    this.u.uInner.value = inner; this.u.uOuter.value = outer;
    // square frame: inner square ±(inner-4) .. outer square ±2400, as 4 trapezoids
    const a = inner - 4, b = 2400;
    const quads = [
      [-b, -b, b, -b, a, -a, -a, -a], // north
      [b, -b, b, b, a, a, a, -a], // east
      [b, b, -b, b, -a, a, a, a], // south
      [-b, b, -b, -b, -a, -a, -a, a], // west
    ];
    const pos: number[] = [];
    for (const q of quads) {
      const [x0, z0, x1, z1, x2, z2, x3, z3] = q;
      pos.push(x0, y, z0, x1, y, z1, x2, y, z2, x0, y, z0, x2, y, z2, x3, y, z3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeBoundingSphere();
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: hazeVert, fragmentShader: hazeFrag, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    }));
    this.mesh.name = 'edgeHaze';
    this.mesh.renderOrder = 5;
  }

  update(color: THREE.Color): void { this.u.uColor.value.copy(color); }

  dispose(): void { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}
