import * as THREE from 'three';

/**
 * Low ground mist: a few stacked horizontal sheets with world-anchored, wind-scrolled value noise.
 * Objects taller than the sheets poke through, which reads well from the isometric camera.
 */

const vert = /* glsl */ `
varying vec2 vXZ;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vXZ = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uAmount;
uniform vec2 uOffset;
uniform vec3 uFocus;
uniform float uRadius;
uniform float uSeed;
varying vec2 vXZ;
float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  vec2 p = (vXZ + uOffset) * 0.018 + uSeed;
  float n = noise(p) * 0.55 + noise(p * 2.3 + 7.1) * 0.3 + noise(p * 5.1 - 3.7) * 0.15;
  float d = length(vXZ - uFocus.xz) / uRadius;
  float a = smoothstep(0.28, 0.85, n) * uAmount * (1.0 - smoothstep(0.6, 1.0, d));
  gl_FragColor = vec4(uColor, a);
}`;

const LAYERS = [
  { y: 0.45, op: 0.55, speed: 1.0, seed: 0.0 },
  { y: 1.35, op: 0.42, speed: 1.35, seed: 13.7 },
  { y: 2.6, op: 0.28, speed: 1.8, seed: 27.1 },
];

export class Mist {
  readonly group = new THREE.Group();
  private sheets: { mesh: THREE.Mesh; u: Record<string, THREE.IUniform>; op: number; speed: number }[] = [];
  private offset = new THREE.Vector2();
  private geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  constructor() {
    for (const L of LAYERS) {
      const u = {
        uColor: { value: new THREE.Color(0xdde2e4) }, uAmount: { value: 0 }, uOffset: { value: new THREE.Vector2() },
        uFocus: { value: new THREE.Vector3() }, uRadius: { value: 200 }, uSeed: { value: L.seed },
      };
      const m = new THREE.Mesh(this.geo, new THREE.ShaderMaterial({
        uniforms: u, vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, fog: false,
      }));
      m.position.y = L.y;
      m.frustumCulled = false;
      m.renderOrder = 40;
      this.sheets.push({ mesh: m, u, op: L.op, speed: L.speed });
      this.group.add(m);
    }
    this.group.name = 'mist';
  }

  update(dt: number, focus: THREE.Vector3, extent: number, wind: THREE.Vector2, amount: number, color: THREE.Color): void {
    this.offset.x -= (wind.x * 0.6 + 0.4) * dt;
    this.offset.y -= (wind.y * 0.6 + 0.15) * dt;
    const R = THREE.MathUtils.clamp(extent * 1.6, 60, 520);
    for (const s of this.sheets) {
      s.mesh.visible = amount > 0.01;
      if (!s.mesh.visible) continue;
      s.mesh.position.x = focus.x;
      s.mesh.position.z = focus.z;
      s.mesh.scale.set(R * 2, 1, R * 2);
      s.u.uAmount.value = amount * s.op;
      s.u.uFocus.value.copy(focus);
      s.u.uRadius.value = R;
      (s.u.uOffset.value as THREE.Vector2).copy(this.offset).multiplyScalar(s.speed);
      (s.u.uColor.value as THREE.Color).copy(color);
    }
  }

  dispose(): void {
    this.geo.dispose();
    for (const s of this.sheets) (s.mesh.material as THREE.Material).dispose();
  }
}

const shadowFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
uniform float uCover;
uniform vec2 uOffset;
uniform vec3 uFocus;
uniform float uRadius;
varying vec2 vXZ;
float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  vec2 p = (vXZ + uOffset) * 0.0065;
  float n = noise(p) * 0.6 + noise(p * 2.1 + 3.3) * 0.28 + noise(p * 4.7 - 1.9) * 0.12;
  float th = 1.0 - uCover;
  float d = length(vXZ - uFocus.xz) / uRadius;
  float a = smoothstep(th - 0.06, th + 0.06, n) * uStrength * (1.0 - smoothstep(0.7, 1.0, d));
  gl_FragColor = vec4(uColor, a);
}`;

/**
 * Soft drifting cloud shadows: a darkening sheet floating above everything (roofs, trees, terrain bumps),
 * so from the elevated camera it darkens whatever lies beneath it, like a real cloud shadow. Much softer
 * (and cheaper) than shadow-map casters. Hidden when a low perspective camera would see it from below.
 */
const SHEET_Y = 38;
export class CloudShadows {
  readonly mesh: THREE.Mesh;
  private u = {
    uColor: { value: new THREE.Color(0x1c2436) }, uStrength: { value: 0 }, uCover: { value: 0.2 },
    uOffset: { value: new THREE.Vector2() }, uFocus: { value: new THREE.Vector3() }, uRadius: { value: 300 },
  };
  private offset = new THREE.Vector2();

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: vert, fragmentShader: shadowFrag, transparent: true, depthWrite: false, fog: false,
    }));
    this.mesh.position.y = SHEET_Y;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    this.mesh.name = 'cloudShadows';
  }

  /** @param strength 0..1 how visible (sun strength x patchiness) */
  update(dt: number, focus: THREE.Vector3, forward: THREE.Vector3, camY: number, extent: number, wind: THREE.Vector2, cover: number, strength: number): void {
    this.offset.x -= wind.x * dt * 2.2;
    this.offset.y -= wind.y * dt * 2.2;
    this.mesh.visible = strength > 0.01 && camY > SHEET_Y + 30 && forward.y < -0.2;
    if (!this.mesh.visible) return;
    const R = THREE.MathUtils.clamp(extent * 1.8, 80, 600);
    // centre on where the view ray crosses the sheet's height
    const k = SHEET_Y / -forward.y;
    this.mesh.position.x = focus.x - forward.x * k;
    this.mesh.position.z = focus.z - forward.z * k;
    this.mesh.scale.set(R * 2, 1, R * 2);
    this.u.uStrength.value = strength;
    this.u.uCover.value = cover;
    this.u.uFocus.value.copy(this.mesh.position);
    this.u.uRadius.value = R;
    this.u.uOffset.value.copy(this.offset);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
