import * as THREE from 'three';
import type { Rng } from '../core/rng';

const DOME_R = 1800;

const domeVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w * 0.99999; // pin to the far plane
}`;

const domeFrag = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunVis;
uniform vec3 uMoonDir;
uniform float uMoonVis;
uniform float uMoonPhase;
uniform float uCloud;
uniform float uFlash;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.45));
  // soft band of brighter haze just above the horizon
  col += uHorizon * 0.12 * exp(-abs(h) * 18.0);
  col = mix(col, uGround, smoothstep(0.0, -0.12, h));

  // sun: halo + disc
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 6.0) * 0.28 + pow(sd, 60.0) * 0.5) * uSunVis;
  col = mix(col, uSunColor * 2.2 + 0.4, smoothstep(0.9993, 0.9996, sd) * uSunVis * (1.0 - uCloud * 0.85));

  // moon: disc lit according to phase
  float md = dot(d, uMoonDir);
  if (md > 0.998 && uMoonVis > 0.001) {
    vec3 up = abs(uMoonDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 tx = normalize(cross(up, uMoonDir));
    vec3 ty = cross(uMoonDir, tx);
    vec2 uv = vec2(dot(d, tx), dot(d, ty)) / 0.0485; // angular radius ~ acos(0.99882)
    float r2 = dot(uv, uv);
    if (r2 < 1.0) {
      vec3 n = vec3(uv, sqrt(1.0 - r2));
      vec3 L = vec3(sin(uMoonPhase), 0.25, -cos(uMoonPhase));
      float lit = smoothstep(-0.05, 0.12, dot(n, normalize(L)));
      float mare = 0.85 + 0.15 * sin(uv.x * 9.0 + 1.3) * sin(uv.y * 7.0 - 0.4);
      vec3 moonCol = mix(uZenith * 1.4 + 0.02, vec3(1.0, 0.97, 0.88) * 1.6 * mare, lit);
      float edge = smoothstep(1.0, 0.9, r2);
      col = mix(col, moonCol, edge * uMoonVis * (1.0 - uCloud * 0.9));
    }
  }
  float mg = max(md, 0.0);
  col += vec3(0.55, 0.62, 0.8) * pow(mg, 40.0) * 0.18 * uMoonVis * (1.0 - uCloud * 0.7);

  col += vec3(0.75, 0.8, 1.0) * uFlash * (0.6 + 0.4 * h);
  gl_FragColor = vec4(col, 1.0);
}`;

const starVert = /* glsl */ `
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uPixelRatio;
varying float vTw;
void main() {
  vTw = 0.65 + 0.35 * sin(uTime * (1.3 + aPhase * 2.0) + aPhase * 40.0);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w * 0.99998;
  gl_PointSize = aSize * uPixelRatio;
}`;

const starFrag = /* glsl */ `
uniform float uOpacity;
varying float vTw;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.1, length(c));
  gl_FragColor = vec4(vec3(1.0, 0.96, 0.88) * 1.4, a * uOpacity * vTw);
}`;

export class Sky {
  readonly group = new THREE.Group();
  readonly uniforms = {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uGround: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uSunVis: { value: 1 },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonVis: { value: 0 },
    uMoonPhase: { value: 2.2 },
    uCloud: { value: 0 },
    uFlash: { value: 0 },
  };
  private starUniforms = { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uOpacity: { value: 0 } };
  private dome: THREE.Mesh;
  private stars: THREE.Points;

  constructor(rng: Rng) {
    const domeMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: domeVert, fragmentShader: domeFrag,
      side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_R, 32, 16), domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.name = 'skyDome';

    // stars on the upper hemisphere
    const N = 900;
    const pos = new Float32Array(N * 3), size = new Float32Array(N), phase = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = rng.next(), v = rng.range(0.04, 1);
      const th = u * Math.PI * 2, y = v, r = Math.sqrt(1 - y * y);
      const R = DOME_R * 0.95;
      pos[i * 3] = Math.cos(th) * r * R; pos[i * 3 + 1] = y * R; pos[i * 3 + 2] = Math.sin(th) * r * R;
      size[i] = rng.chance(0.08) ? rng.range(3, 4.2) : rng.range(1.2, 2.4);
      phase[i] = rng.next();
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.stars = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: this.starUniforms, vertexShader: starVert, fragmentShader: starFrag,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -999;
    this.group.add(this.dome, this.stars);
    this.group.name = 'sky';
  }

  update(camPos: THREE.Vector3, time: number, starOpacity: number, pixelRatio: number, rotY: number): void {
    this.group.position.copy(camPos);
    this.starUniforms.uTime.value = time;
    this.starUniforms.uOpacity.value = starOpacity;
    this.starUniforms.uPixelRatio.value = pixelRatio;
    this.stars.visible = starOpacity > 0.01;
    this.stars.rotation.y = rotY;
  }

  dispose(): void {
    this.dome.geometry.dispose();
    (this.dome.material as THREE.Material).dispose();
    this.stars.geometry.dispose();
    (this.stars.material as THREE.Material).dispose();
  }
}
