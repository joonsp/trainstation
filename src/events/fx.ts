/**
 * Shared visual helpers for events + maintenance:
 *  - PB: tiny "prop builder" that merges primitives into ONE vertex-coloured mesh (1 draw call per prop)
 *  - ParticlePool: capped InstancedMesh particles (sparks, confetti, puffs); zero per-frame allocation
 *  - LightPool: light REQUESTS turned into ctx.lights claims (priority 3) once per rendered frame
 *    (the shared pool keeps light counts constant, so effects never trigger shader recompiles)
 *  - Marker: screen-sized badge sprite (map pin) so events are findable from the wide iso view
 *
 * getFx(ctx) returns a per-ctx singleton. The EVENTS system calls fx.update(dt) once per update.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Ctx } from '../core/types';

// ───────────────────────── materials ─────────────────────────
const matCache = new Map<string, THREE.Material>();

/** Shared flat-shaded vertex-coloured material. */
export function vcMat(double = false): THREE.MeshStandardMaterial {
  const key = 'vc' + (double ? 'D' : '');
  let m = matCache.get(key) as THREE.MeshStandardMaterial | undefined;
  if (!m) {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8, metalness: 0.05, side: double ? THREE.DoubleSide : THREE.FrontSide });
    m.name = 'events-' + key;
    matCache.set(key, m);
  }
  return m;
}

/** Shared unlit glowing material (colour may exceed 1 → blooms at night). */
export function glowMat(hex: number, boost = 2.5, opts: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  const key = `glow${hex}_${boost}_${opts.transparent ? 't' : ''}${opts.opacity ?? ''}`;
  let m = matCache.get(key) as THREE.MeshBasicMaterial | undefined;
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(boost), ...opts });
    matCache.set(key, m);
  }
  return m;
}

// ───────────────────────── prop builder ─────────────────────────
type V3 = [number, number, number];
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _c = new THREE.Color();

export class PB {
  private parts: THREE.BufferGeometry[] = [];

  /** add a geometry (consumed) with a colour and a transform */
  add(geo: THREE.BufferGeometry, color: number, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: V3 | number = 1): this {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    if (g.getAttribute('uv')) g.deleteAttribute('uv');
    if (g.getAttribute('uv1')) g.deleteAttribute('uv1');
    _e.set(r[0], r[1], r[2]);
    _q.setFromEuler(_e);
    if (typeof s === 'number') _s.set(s, s, s); else _s.set(s[0], s[1], s[2]);
    _m.compose(_p.set(p[0], p[1], p[2]), _q, _s);
    g.applyMatrix4(_m);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    _c.setHex(color);
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(g);
    return this;
  }
  /** add with an explicit matrix */
  addM(geo: THREE.BufferGeometry, color: number, m: THREE.Matrix4): this {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    if (g.getAttribute('uv')) g.deleteAttribute('uv');
    g.applyMatrix4(m);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    _c.setHex(color);
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(g);
    return this;
  }
  /** cylinder rod between two points */
  rod(a: THREE.Vector3 | V3, b: THREE.Vector3 | V3, r: number, color: number, seg = 5): this {
    const A = Array.isArray(a) ? new THREE.Vector3(...a) : a, B = Array.isArray(b) ? new THREE.Vector3(...b) : b;
    const d = B.clone().sub(A);
    const len = d.length() || 1e-3;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    const m = new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    return this.addM(new THREE.CylinderGeometry(r, r, len, seg), color, m);
  }
  /** add geometry painting each triangle by its centroid (local coords, before transform) */
  addPainted(geo: THREE.BufferGeometry, paint: (x: number, y: number, z: number) => number, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: V3 | number = 1): this {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    if (g.getAttribute('uv')) g.deleteAttribute('uv');
    const pos = g.getAttribute('position');
    const n = pos.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 3) {
      const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
      const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
      const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      _c.setHex(paint(cx, cy, cz));
      for (let k = 0; k < 3; k++) { col[(i + k) * 3] = _c.r; col[(i + k) * 3 + 1] = _c.g; col[(i + k) * 3 + 2] = _c.b; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    _e.set(r[0], r[1], r[2]); _q.setFromEuler(_e);
    if (typeof s === 'number') _s.set(s, s, s); else _s.set(s[0], s[1], s[2]);
    _m.compose(_p.set(p[0], p[1], p[2]), _q, _s);
    g.applyMatrix4(_m);
    this.parts.push(g);
    return this;
  }
  box(w: number, h: number, d: number, color: number, p: V3, r: V3 = [0, 0, 0]): this {
    return this.add(new THREE.BoxGeometry(w, h, d), color, p, r);
  }
  cyl(rt: number, rb: number, h: number, color: number, p: V3, r: V3 = [0, 0, 0], seg = 7): this {
    return this.add(new THREE.CylinderGeometry(rt, rb, h, seg), color, p, r);
  }
  ball(rad: number, color: number, p: V3, s: V3 | number = 1, detail = 0, r: V3 = [0, 0, 0]): this {
    return this.add(new THREE.IcosahedronGeometry(rad, detail), color, p, r, s);
  }
  cone(rad: number, h: number, color: number, p: V3, r: V3 = [0, 0, 0], seg = 6): this {
    return this.add(new THREE.ConeGeometry(rad, h, seg), color, p, r);
  }
  get empty(): boolean { return this.parts.length === 0; }
  geometry(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false) ?? new THREE.BufferGeometry();
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingSphere();
    return g;
  }
  mesh(mat: THREE.Material = vcMat(), shadow = true): THREE.Mesh {
    const m = new THREE.Mesh(this.geometry(), mat);
    m.castShadow = shadow;
    m.receiveShadow = false;
    return m;
  }
}

// ───────────────────────── particles ─────────────────────────
export interface EmitOpts {
  life?: number; size?: number; color?: number | THREE.Color; gravity?: number; drag?: number;
  /** size multiplier reached at end of life (puffs grow, sparks shrink) */
  grow?: number; spin?: number;
}

export class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private pos: Float32Array; private vel: Float32Array; private rot: Float32Array; private spin: Float32Array;
  private life: Float32Array; private age: Float32Array; private size: Float32Array; private grow: Float32Array;
  private grav: Float32Array; private drag: Float32Array; private col: Float32Array;
  private dirty = true;

  constructor(scene: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, readonly cap: number, readonly shrinkOut = true) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);
    this.pos = new Float32Array(cap * 3); this.vel = new Float32Array(cap * 3); this.rot = new Float32Array(cap * 3);
    this.spin = new Float32Array(cap * 3); this.col = new Float32Array(cap * 3);
    this.life = new Float32Array(cap); this.age = new Float32Array(cap); this.size = new Float32Array(cap);
    this.grow = new Float32Array(cap); this.grav = new Float32Array(cap); this.drag = new Float32Array(cap);
  }

  get live(): number { return this.n; }

  emit(px: number, py: number, pz: number, vx: number, vy: number, vz: number, o: EmitOpts = {}): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    const i3 = i * 3;
    this.pos[i3] = px; this.pos[i3 + 1] = py; this.pos[i3 + 2] = pz;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    const sp = o.spin ?? 0;
    this.rot[i3] = Math.random() * 6.28; this.rot[i3 + 1] = Math.random() * 6.28; this.rot[i3 + 2] = Math.random() * 6.28;
    this.spin[i3] = (Math.random() - 0.5) * sp; this.spin[i3 + 1] = (Math.random() - 0.5) * sp; this.spin[i3 + 2] = (Math.random() - 0.5) * sp;
    this.life[i] = o.life ?? 1; this.age[i] = 0; this.size[i] = o.size ?? 1; this.grow[i] = o.grow ?? 1;
    this.grav[i] = o.gravity ?? 0; this.drag[i] = o.drag ?? 0;
    const c = o.color;
    if (c instanceof THREE.Color) { this.col[i3] = c.r; this.col[i3 + 1] = c.g; this.col[i3 + 2] = c.b; }
    else { _c.setHex(c ?? 0xffffff); this.col[i3] = _c.r; this.col[i3 + 1] = _c.g; this.col[i3 + 2] = _c.b; }
    this.dirty = true;
  }

  update(dt: number): void {
    // an empty pool is hidden so it costs no draw call
    this.mesh.visible = this.n > 0;
    if (this.n === 0) { if (this.dirty) { this.mesh.count = 0; this.dirty = false; } return; }
    let w = 0;
    const P = this.pos, V = this.vel, R = this.rot, S = this.spin, C = this.col;
    const im = this.mesh.instanceMatrix.array as Float32Array;
    const ic = this.mesh.instanceColor!.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      const a = this.age[i] + dt;
      if (a >= this.life[i]) continue;
      const i3 = i * 3, w3 = w * 3;
      const k = Math.max(0, 1 - this.drag[i] * dt);
      const vx = V[i3] * k, vy = (V[i3 + 1] - this.grav[i] * dt) * k, vz = V[i3 + 2] * k;
      const px = P[i3] + vx * dt, py = P[i3 + 1] + vy * dt, pz = P[i3 + 2] + vz * dt;
      const rx = R[i3] + S[i3] * dt, ry = R[i3 + 1] + S[i3 + 1] * dt, rz = R[i3 + 2] + S[i3 + 2] * dt;
      // compact into slot w
      P[w3] = px; P[w3 + 1] = py; P[w3 + 2] = pz;
      V[w3] = vx; V[w3 + 1] = vy; V[w3 + 2] = vz;
      R[w3] = rx; R[w3 + 1] = ry; R[w3 + 2] = rz;
      S[w3] = S[i3]; S[w3 + 1] = S[i3 + 1]; S[w3 + 2] = S[i3 + 2];
      C[w3] = C[i3]; C[w3 + 1] = C[i3 + 1]; C[w3 + 2] = C[i3 + 2];
      this.age[w] = a; this.life[w] = this.life[i]; this.size[w] = this.size[i]; this.grow[w] = this.grow[i];
      this.grav[w] = this.grav[i]; this.drag[w] = this.drag[i];
      const f = a / this.life[w];
      let sc = this.size[w] * (1 + (this.grow[w] - 1) * f);
      if (this.shrinkOut && f > 0.7) sc *= 1 - (f - 0.7) / 0.3;
      _e.set(rx, ry, rz); _q.setFromEuler(_e);
      _m.compose(_p.set(px, py, pz), _q, _s.set(sc, sc, sc));
      _m.toArray(im, w * 16);
      ic[w3] = C[w3]; ic[w3 + 1] = C[w3 + 1]; ic[w3 + 2] = C[w3 + 2];
      w++;
    }
    this.n = w;
    this.mesh.count = w;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

// ───────────────────────── lights ─────────────────────────
/**
 * v2: events never add PointLights to the scene. acquire() hands out a DETACHED PointLight used purely as a
 * request record (position, color, intensity, distance — it is never added to the scene, so it costs nothing and
 * v1 callers such as maintenance keep compiling); flush() claims every active request from the shared pool
 * (ctx.lights, priority 3 or userData.priority) once per rendered frame. Pair each with an emissive mesh.
 */
export type LightReq = THREE.PointLight;
let lightSeq = 0;
export class LightPool {
  private reqs = new Map<LightReq, string>();
  private lastFrame = -1;
  constructor(private ctx: Ctx) {}
  acquire(_owner: object): LightReq {
    const r = new THREE.PointLight(0xffc070, 0, 22, 2);
    r.position.set(0, -50, 0);
    r.userData.priority = 3;
    this.reqs.set(r, `events:${++lightSeq}`);
    return r;
  }
  release(l: LightReq | null): void { if (l) { this.reqs.delete(l); l.intensity = 0; } }
  flush(): void {
    const f = this.ctx.renderer.info.render.frame;
    if (f === this.lastFrame) return;
    this.lastFrame = f;
    for (const [r, key] of this.reqs) {
      if (r.intensity > 0.001) { try { this.ctx.lights.claim(key, r.position, r.color, r.intensity, r.distance, r.userData.priority ?? 3); } catch { /* no pool */ } }
    }
  }
}

// ───────────────────────── badge markers ─────────────────────────
const texCache = new Map<string, THREE.CanvasTexture>();
function badgeTexture(text: string, bg: string, fg: string): THREE.CanvasTexture {
  const key = text + bg + fg;
  let t = texCache.get(key);
  if (t) return t;
  const cv = document.createElement('canvas');
  const W = 128, H = 128;
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  // pin shape: rounded badge + small pointer
  g.fillStyle = 'rgba(20,24,22,0.55)';
  g.beginPath(); g.ellipse(64, 60, 50, 46, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = bg;
  g.beginPath(); g.ellipse(64, 56, 46, 42, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(50, 90); g.lineTo(78, 90); g.lineTo(64, 118); g.closePath(); g.fill();
  g.strokeStyle = '#c9a24a'; g.lineWidth = 6;
  g.beginPath(); g.ellipse(64, 56, 40, 36, 0, 0, Math.PI * 2); g.stroke();
  g.fillStyle = fg;
  const fs = text.length > 2 ? 34 : text.length > 1 ? 46 : 62;
  g.font = `bold ${fs}px Georgia, 'DejaVu Serif', serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 64, 58);
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

/** text label texture (wide) — used for the shed progress board */
export function labelTexture(lines: string[], w = 256, h = 96): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  drawLabel(t, lines);
  return t;
}
export function drawLabel(t: THREE.CanvasTexture, lines: string[], progress = -1): void {
  const cv = t.image as HTMLCanvasElement;
  const g = cv.getContext('2d')!;
  const w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(31,46,39,0.92)';
  const r = 14;
  g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, r); g.fill();
  g.strokeStyle = '#c9a24a'; g.lineWidth = 4; g.stroke();
  g.fillStyle = '#e8dcc0';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const n = lines.length;
  lines.forEach((ln, i) => {
    g.font = `${i === 0 ? 'bold ' : ''}${i === 0 ? 24 : 20}px Georgia, 'DejaVu Serif', serif`;
    g.fillText(ln, w / 2, (h / (n + (progress >= 0 ? 1 : 0) + 0.2)) * (i + 0.8));
  });
  if (progress >= 0) {
    const bx = 24, by = h - 26, bw = w - 48, bh = 10;
    g.fillStyle = '#4d5866'; g.fillRect(bx, by, bw, bh);
    g.fillStyle = '#c9a24a'; g.fillRect(bx, by, bw * Math.min(1, Math.max(0, progress)), bh);
  }
  t.needsUpdate = true;
}

export class Marker {
  readonly sprite: THREE.Sprite;
  private phase = Math.random() * 6;
  constructor(parent: THREE.Object3D, text: string, readonly px = 30, bg = '#e8dcc0', fg = '#7a2230', readonly aspect = 1, tex?: THREE.Texture) {
    const mat = new THREE.SpriteMaterial({ map: tex ?? badgeTexture(text, bg, fg), depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.renderOrder = 999;
    this.sprite.center.set(0.5, 0.05);
    parent.add(this.sprite);
  }
  /** place above a world point; size is kept ~px pixels on screen */
  place(p: THREE.Vector3, cam: THREE.Camera, viewH: number, dt: number, lift = 2.4): void {
    this.phase += dt * 3;
    const wpp = worldPerPixel(cam, p, viewH);
    const s = THREE.MathUtils.clamp(this.px * wpp, 0.9, 30);
    this.sprite.scale.set(s * this.aspect, s, 1);
    this.sprite.position.set(p.x, p.y + lift + Math.sin(this.phase) * s * 0.06, p.z);
  }
  set visible(v: boolean) { this.sprite.visible = v; }
  dispose(): void {
    this.sprite.removeFromParent();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
  }
}

const _v = new THREE.Vector3();
export function worldPerPixel(cam: THREE.Camera, p: THREE.Vector3, viewH: number): number {
  const h = Math.max(1, viewH);
  if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
    const c = cam as THREE.OrthographicCamera;
    return (c.top - c.bottom) / c.zoom / h;
  }
  if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const c = cam as THREE.PerspectiveCamera;
    const d = _v.copy(p).sub(c.position).length();
    return (2 * Math.tan(THREE.MathUtils.degToRad(c.fov) / 2) * d) / h;
  }
  return 0.05;
}

/**
 * Bake several static vertex-coloured props (PB meshes, already positioned in world space) into ONE mesh, so a
 * dressed scene (tea table + coconut shy + maypole …) costs one draw (+ one shadow draw) instead of one per prop.
 */
export function bakeStatic(objs: THREE.Object3D[], mat: THREE.Material = vcMat(), shadow = true): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  for (const o of objs) {
    o.updateMatrixWorld(true);
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh) return;
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone());
      g.applyMatrix4(m.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') g.deleteAttribute(k);
      parts.push(g);
    });
    disposeTree(o);
  }
  const g = mergeGeometries(parts, false) ?? new THREE.BufferGeometry();
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = shadow;
  return mesh;
}

// ───────────────────────── Fx singleton ─────────────────────────
export interface Fx {
  root: THREE.Group;
  sparks: ParticlePool;
  confetti: ParticlePool;
  puffs: ParticlePool;
  lights: LightPool;
  update(dt: number): void;
  viewH(): number;
}

const fxByCtx = new WeakMap<object, Fx>();

export function getFx(ctx: Ctx): Fx {
  let fx = fxByCtx.get(ctx);
  if (fx) return fx;
  const root = new THREE.Group();
  root.name = 'events-fx';
  ctx.scene.add(root);
  const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const sparks = new ParticlePool(root, new THREE.BoxGeometry(0.07, 0.07, 0.07), sparkMat, 220);
  const confMat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.7, flatShading: true });
  const confetti = new ParticlePool(root, new THREE.PlaneGeometry(0.16, 0.11), confMat, 420, false);
  const puffMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true, transparent: true, opacity: 0.82, depthWrite: false });
  const puffs = new ParticlePool(root, new THREE.IcosahedronGeometry(0.5, 0), puffMat, 260);
  const lights = new LightPool(ctx);
  fx = {
    root, sparks, confetti, puffs, lights,
    update(dt) { sparks.update(dt); confetti.update(dt); puffs.update(dt); lights.flush(); },
    viewH: () => ctx.renderer.domElement.clientHeight || window.innerHeight,
  };
  fxByCtx.set(ctx, fx);
  return fx;
}

/** burst helper: n sparks at p */
export function sparkBurst(fx: Fx, p: THREE.Vector3, n = 12, hot = 1): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, u = Math.random();
    const sp = 2 + Math.random() * 4;
    const col = _c.setRGB(3 * hot, (1.6 + u * 1.2) * hot, 0.5 * hot);
    fx.sparks.emit(p.x, p.y, p.z, Math.cos(a) * sp * 0.6, 1.5 + Math.random() * 3.5, Math.sin(a) * sp * 0.6,
      { life: 0.35 + Math.random() * 0.5, size: 0.6 + Math.random() * 0.8, color: col, gravity: 9.8, drag: 0.6, grow: 0.3 });
  }
}

/** disposes geometry of every mesh under obj (materials are shared unless userData.ownMat) */
export function disposeTree(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !o.userData.sharedGeo) m.geometry?.dispose();
    if (o.userData.ownMat) {
      const mat = (o as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else (mat as THREE.Material)?.dispose();
    }
  });
}

const CONFETTI = [0xf2c6d0, 0xffffff, 0xe8a0b4, 0xf6e7a8, 0xbfd8e8, 0xd9b95a, 0xc8e0b0];
/** celebratory confetti burst at p */
export function confettiBurst(fx: Fx, p: THREE.Vector3, n = 40, up = 4, colors: number[] = CONFETTI): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 2.2;
    fx.confetti.emit(p.x + Math.cos(a) * 0.3, p.y + 1.8, p.z + Math.sin(a) * 0.3,
      Math.cos(a) * r, up * (0.6 + Math.random() * 0.6), Math.sin(a) * r,
      { life: 3 + Math.random() * 2.5, size: 1 + Math.random() * 0.8, color: colors[i % colors.length], gravity: 3.2, drag: 1.6, spin: 14 });
  }
}

/** a puff of smoke/steam/snow */
export function puff(fx: Fx, p: THREE.Vector3, color: number, o: { vx?: number; vy?: number; vz?: number; size?: number; life?: number; grow?: number; gravity?: number; spread?: number } = {}): void {
  const s = o.spread ?? 0.3;
  fx.puffs.emit(p.x + (Math.random() - 0.5) * s, p.y, p.z + (Math.random() - 0.5) * s,
    (o.vx ?? 0) + (Math.random() - 0.5) * 0.4, o.vy ?? 1.2, (o.vz ?? 0) + (Math.random() - 0.5) * 0.4,
    { life: o.life ?? 2.5, size: o.size ?? 0.6, color, grow: o.grow ?? 2.6, gravity: o.gravity ?? 0, drag: 0.4, spin: 1 });
}

// ───────────────────────── instanced props ─────────────────────────
const _im = new THREE.Matrix4(), _iq = new THREE.Quaternion(), _iy = new THREE.Vector3(0, 1, 0), _is = new THREE.Vector3(), _ip = new THREE.Vector3();
/**
 * N copies of one merged, vertex-coloured prop in ONE draw call (music stands, kites, stall parts, buckets …).
 * set(i, pos, yaw, scale); scale 0 hides an instance. Call commit() after changes (cheap; flags the buffer).
 */
export class InstProps {
  readonly mesh: THREE.InstancedMesh;
  constructor(parent: THREE.Object3D, geo: THREE.BufferGeometry, readonly count: number, mat: THREE.Material = vcMat(), shadow = true) {
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = shadow;
    this.mesh.frustumCulled = false;
    for (let i = 0; i < count; i++) this.set(i, _ip.set(0, -100, 0), 0, 0);
    this.commit();
    parent.add(this.mesh);
  }
  set(i: number, p: THREE.Vector3, yaw: number, scale: number | THREE.Vector3 = 1, tiltX = 0): void {
    _iq.setFromAxisAngle(_iy, yaw);
    if (tiltX) _iq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tiltX));
    if (typeof scale === 'number') _is.setScalar(Math.max(1e-4, scale)); else _is.copy(scale);
    _im.compose(p, _iq, _is);
    this.mesh.setMatrixAt(i, _im);
  }
  color(i: number, hex: number): void {
    this.mesh.setColorAt(i, _c.setHex(hex));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  commit(): void { this.mesh.instanceMatrix.needsUpdate = true; }
  /**
   * cull the whole set as one sphere (world space; the mesh's parent must sit at the origin): all instances are
   * expected to stay within `radius` of `center`. Off-screen sets then cost no draw calls (main or shadow pass).
   */
  cull(center: THREE.Vector3, radius: number): this {
    this.mesh.boundingSphere = new THREE.Sphere(center.clone(), radius);
    this.mesh.frustumCulled = true;
    return this;
  }
  dispose(): void { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.dispose(); }
}
