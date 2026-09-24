import * as THREE from 'three';
import type { Rng } from '../core/rng';
import type { Layout } from '../core/layout';

/**
 * All precipitation is animated entirely on the GPU: each particle carries a random seed and the vertex
 * shader derives its position from uTime, wrapping it in a box centred on the view focus. The CPU only
 * updates a handful of uniforms per frame.
 */

const RAIN_N = 7000;
const SNOW_N = 5000;
const SPLASH_N = 1400;
const RAIN_H = 42;
const SNOW_H = 36;

const wrapGLSL = /* glsl */ `
vec2 wrapXZ(vec2 base, vec2 focus, float box) {
  return focus + mod(base - focus + 0.5 * box, box) - 0.5 * box;
}`;

const rainVert = /* glsl */ `
attribute vec4 aSeed;   // x,z in 0..1, phase, per-drop 0..1
attribute vec2 aCorner; // along (0 head .. 1 tail), side (-1..1)
uniform float uTime;
uniform vec3 uFocus;
uniform float uBox;
uniform vec2 uWind;
uniform float uFall;
uniform float uLen;
uniform float uAmount;
uniform float uWidthPx;
uniform float uPxWorld;
uniform float uOrtho;
uniform float uPxPerDepth;
varying float vAlpha;
${wrapGLSL}
void main() {
  if (aSeed.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
  float fall = uFall * (0.85 + 0.3 * fract(aSeed.w * 13.7));
  float cyc = aSeed.z * ${RAIN_H.toFixed(1)} + uTime * fall;
  float y = ${RAIN_H.toFixed(1)} - mod(cyc, ${RAIN_H.toFixed(1)});
  float age = (${RAIN_H.toFixed(1)} - y) / fall;
  vec2 xz = wrapXZ(aSeed.xy * uBox + uWind * age, uFocus.xz, uBox);
  vec3 head = vec3(xz.x, y, xz.y);
  vec3 vel = normalize(vec3(uWind.x, -fall, uWind.y));
  vec3 tail = head - vel * uLen;
  vec4 h = viewMatrix * vec4(head, 1.0);
  vec4 t = viewMatrix * vec4(tail, 1.0);
  vec4 p = mix(h, t, aCorner.x);
  vec2 ax = t.xy - h.xy;
  float axl = length(ax);
  vec2 perp = axl > 1e-5 ? vec2(-ax.y, ax.x) / axl : vec2(1.0, 0.0);
  float px = uOrtho > 0.5 ? uPxWorld : -p.z * uPxPerDepth;
  p.xy += perp * aCorner.y * 0.5 * uWidthPx * px;
  gl_Position = projectionMatrix * p;
  // fade near the box edges so wrapping is invisible, and fade in at the top
  vec2 e = abs(xz - uFocus.xz) / (0.5 * uBox);
  vAlpha = (1.0 - smoothstep(0.75, 1.0, max(e.x, e.y))) * smoothstep(0.0, 4.0, ${RAIN_H.toFixed(1)} - y) * mix(1.0, 0.25, aCorner.x);
}`;

const rainFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, vAlpha * uOpacity);
}`;

const snowVert = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uFocus;
uniform float uBox;
uniform vec2 uWind;
uniform float uAmount;
uniform float uSizePx;
uniform float uOrtho;
uniform float uPxPerDepth;
uniform float uPxWorld;
varying float vAlpha;
${wrapGLSL}
void main() {
  if (aSeed.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
  float fall = 1.3 + 0.9 * fract(aSeed.w * 7.3);
  float cyc = aSeed.z * ${SNOW_H.toFixed(1)} + uTime * fall;
  float y = ${SNOW_H.toFixed(1)} - mod(cyc, ${SNOW_H.toFixed(1)});
  float age = (${SNOW_H.toFixed(1)} - y) / fall;
  float ph = aSeed.z * 31.0 + aSeed.w * 17.0;
  vec2 sway = vec2(sin(uTime * 0.9 + ph), cos(uTime * 0.7 + ph * 1.3)) * 0.9;
  vec2 xz = wrapXZ(aSeed.xy * uBox + uWind * age * 0.8 + sway, uFocus.xz, uBox);
  vec4 mv = viewMatrix * vec4(xz.x, y, xz.y, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = uSizePx * (0.7 + 0.6 * fract(aSeed.w * 3.1));
  // keep the flake roughly 0.3 m across in world terms, clamped to a legible pixel size
  float px = uOrtho > 0.5 ? uPxWorld : -mv.z * uPxPerDepth;
  gl_PointSize = clamp(0.3 / px, 2.0, 10.0) * s;
  vec2 e = abs(xz - uFocus.xz) / (0.5 * uBox);
  vAlpha = (1.0 - smoothstep(0.75, 1.0, max(e.x, e.y))) * smoothstep(0.0, 3.0, ${SNOW_H.toFixed(1)} - y);
}`;

const snowFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.25, length(c));
  gl_FragColor = vec4(uColor, a * vAlpha * uOpacity);
}`;

const splashVert = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uFocus;
uniform float uBox;
uniform float uAmount;
uniform vec4 uP1; // centre x, z, yaw, unused
uniform vec4 uP2;
uniform vec3 uPHalf; // canopy half length, platform half length, half width
varying float vAlpha;
varying float vT;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  if (aSeed.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
  float rate = 1.4 + fract(aSeed.w * 9.1) * 0.8;
  float cyc = uTime * rate + aSeed.z * 17.0;
  float idx = floor(cyc);
  float t = fract(cyc);
  vec2 r = vec2(hash(aSeed.xy + idx), hash(aSeed.yx * 1.7 + idx * 0.37));
  vec3 c;
  float kind = fract(aSeed.w * 5.3);
  if (kind < 0.55) {
    // on a platform surface, in world-space platform rectangles
    vec4 P = kind < 0.275 ? uP1 : uP2;
    // only the open platform ends: the canopy hides the middle from above
    float sx = r.x < 0.5 ? -1.0 : 1.0;
    vec2 l = vec2(sx * mix(uPHalf.x, uPHalf.y, fract(r.x * 2.0)), (r.y * 2.0 - 1.0) * uPHalf.z);
    float cs = cos(P.z), sn = sin(P.z);
    // yaw convention: local +x -> (cos, 0, -sin); local +z -> (sin, 0, cos)
    c = vec3(P.x + l.x * cs + l.y * sn, 1.03, P.y - l.x * sn + l.y * cs);
  } else {
    vec2 xz = uFocus.xz + (r - 0.5) * uBox;
    c = vec3(xz.x, 0.04, xz.y);
  }
  float sc = mix(0.12, 0.62, t);
  vec3 p = c + vec3(position.x * sc, 0.0, position.z * sc);
  vT = t;
  vAlpha = (1.0 - t) * (1.0 - t);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const splashFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying float vT;
void main() {
  gl_FragColor = vec4(uColor, vAlpha * uOpacity);
}`;

function seeds(n: number, rng: Rng, perVertex: number): Float32Array {
  const a = new Float32Array(n * perVertex * 4);
  for (let i = 0; i < n; i++) {
    const s0 = rng.next(), s1 = rng.next(), s2 = rng.next(), s3 = rng.next();
    for (let k = 0; k < perVertex; k++) {
      const o = (i * perVertex + k) * 4;
      a[o] = s0; a[o + 1] = s1; a[o + 2] = s2; a[o + 3] = s3;
    }
  }
  return a;
}

export interface PrecipParams {
  time: number;
  focus: THREE.Vector3;
  extent: number;
  pxWorld: number;
  ortho: boolean;
  pxPerDepth: number;
  pixelRatio: number;
  wind: THREE.Vector2;
  rain: number;
  snow: number;
  /** 0..1 how much ambient light there is to tint the particles */
  light: THREE.Color;
}

export class Precipitation {
  readonly group = new THREE.Group();
  private rain: THREE.Mesh;
  private snow: THREE.Points;
  private splash: THREE.Mesh;
  private rainU = {
    uTime: { value: 0 }, uFocus: { value: new THREE.Vector3() }, uBox: { value: 200 }, uWind: { value: new THREE.Vector2() },
    uFall: { value: 24 }, uLen: { value: 2.2 }, uAmount: { value: 0 }, uWidthPx: { value: 1.6 }, uPxWorld: { value: 0.25 },
    uOrtho: { value: 1 }, uPxPerDepth: { value: 0.001 }, uColor: { value: new THREE.Color(0xc8d4e0) }, uOpacity: { value: 0.5 },
  };
  private snowU = {
    uTime: { value: 0 }, uFocus: { value: new THREE.Vector3() }, uBox: { value: 200 }, uWind: { value: new THREE.Vector2() },
    uAmount: { value: 0 }, uSizePx: { value: 1 }, uOrtho: { value: 1 }, uPxPerDepth: { value: 0.001 }, uPxWorld: { value: 0.25 },
    uColor: { value: new THREE.Color(0xffffff) }, uOpacity: { value: 0.95 },
  };
  private splashU = {
    uTime: { value: 0 }, uFocus: { value: new THREE.Vector3() }, uBox: { value: 160 }, uAmount: { value: 0 },
    uP1: { value: new THREE.Vector4() }, uP2: { value: new THREE.Vector4() }, uPHalf: { value: new THREE.Vector3() },
    uColor: { value: new THREE.Color(0xdfe8f0) }, uOpacity: { value: 0.6 },
  };
  private boxQ = 200;

  constructor(rng: Rng, layout: Layout) {
    // ── rain: one camera-facing quad per drop ──
    {
      const g = new THREE.BufferGeometry();
      const corner = new Float32Array(RAIN_N * 4 * 2);
      const idx = new Uint32Array(RAIN_N * 6);
      for (let i = 0; i < RAIN_N; i++) {
        corner.set([0, -1, 0, 1, 1, -1, 1, 1], i * 8);
        const b = i * 4;
        idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], i * 6);
      }
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_N * 4 * 3), 3));
      g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seeds(RAIN_N, rng, 4), 4));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      this.rain = new THREE.Mesh(g, new THREE.ShaderMaterial({
        uniforms: this.rainU, vertexShader: rainVert, fragmentShader: rainFrag,
        transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      }));
      this.rain.frustumCulled = false;
      this.rain.renderOrder = 60;
      this.rain.name = 'rain';
    }
    // ── snow: points ──
    {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SNOW_N * 3), 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seeds(SNOW_N, rng, 1), 4));
      this.snow = new THREE.Points(g, new THREE.ShaderMaterial({
        uniforms: this.snowU, vertexShader: snowVert, fragmentShader: snowFrag,
        transparent: true, depthWrite: false, fog: false,
      }));
      this.snow.frustumCulled = false;
      this.snow.renderOrder = 60;
      this.snow.name = 'snow';
    }
    // ── splash ripples: flat rings ──
    {
      const ring = new THREE.RingGeometry(0.72, 1, 10, 1);
      ring.rotateX(-Math.PI / 2);
      const g = new THREE.InstancedBufferGeometry();
      g.index = ring.index;
      g.setAttribute('position', ring.getAttribute('position'));
      g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds(SPLASH_N, rng, 1), 4));
      g.instanceCount = SPLASH_N;
      this.splash = new THREE.Mesh(g, new THREE.ShaderMaterial({
        uniforms: this.splashU, vertexShader: splashVert, fragmentShader: splashFrag,
        transparent: true, depthWrite: false, fog: false,
      }));
      this.splash.frustumCulled = false;
      this.splash.renderOrder = 55;
      this.splash.name = 'splashes';
      const p1 = layout.platforms[1], p2 = layout.platforms[2];
      this.splashU.uP1.value.set(p1.center.x, p1.center.z, p1.yaw, 0);
      this.splashU.uP2.value.set(p2.center.x, p2.center.z, p2.yaw, 0);
      this.splashU.uPHalf.value.set(p1.canopyLength / 2 + 0.6, p1.length / 2 - 0.8, p1.width / 2 - 0.5);
    }
    this.group.add(this.rain, this.snow, this.splash);
    this.group.name = 'precipitation';
  }

  update(p: PrecipParams): void {
    // quantise the box so zooming doesn't constantly reshuffle the drops
    const want = THREE.MathUtils.clamp(p.extent * 2.3, 70, 460);
    if (Math.abs(want - this.boxQ) / this.boxQ > 0.2) this.boxQ = want;
    const box = this.boxQ;
    const ortho = p.ortho ? 1 : 0;

    const r = this.rainU;
    r.uTime.value = p.time;
    r.uFocus.value.copy(p.focus);
    r.uBox.value = box;
    r.uWind.value.copy(p.wind).multiplyScalar(1.3);
    r.uAmount.value = p.rain;
    r.uLen.value = 1.2 + p.rain * 1.1;
    r.uOrtho.value = ortho;
    r.uPxWorld.value = p.pxWorld;
    r.uPxPerDepth.value = p.pxPerDepth;
    r.uWidthPx.value = 1.3 * p.pixelRatio;
    r.uColor.value.copy(p.light);
    r.uOpacity.value = 0.26 + 0.16 * p.rain;
    this.rain.visible = p.rain > 0.002;

    const s = this.snowU;
    s.uTime.value = p.time;
    s.uFocus.value.copy(p.focus);
    s.uBox.value = box;
    s.uWind.value.copy(p.wind);
    s.uAmount.value = p.snow;
    s.uOrtho.value = ortho;
    s.uPxWorld.value = p.pxWorld;
    s.uPxPerDepth.value = p.pxPerDepth;
    s.uSizePx.value = p.pixelRatio;
    s.uColor.value.copy(p.light).multiplyScalar(1.25);
    this.snow.visible = p.snow > 0.002;

    const sp = this.splashU;
    sp.uTime.value = p.time;
    sp.uFocus.value.copy(p.focus);
    sp.uBox.value = Math.min(box * 0.6, 200);
    sp.uAmount.value = Math.min(1, p.rain * 1.3);
    sp.uColor.value.copy(p.light).multiplyScalar(1.1);
    sp.uOpacity.value = 0.55;
    this.splash.visible = p.rain > 0.05;
  }

  dispose(): void {
    for (const o of [this.rain, this.snow, this.splash]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}
