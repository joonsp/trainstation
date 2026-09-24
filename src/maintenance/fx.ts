import * as THREE from 'three';

/**
 * Small screen-space sprites for maintenance: the shed progress board and the "!" badge over a failed engine.
 * (Self-contained so maintenance does not depend on another builder's effects module.)
 */

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

export function labelTexture(w: number, h: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** a bottle-green enamel board with brass edging; optional progress bar (0..1) */
export function drawBoard(t: THREE.CanvasTexture, lines: string[], progress = -1): void {
  const cv = t.image as HTMLCanvasElement;
  const g = cv.getContext('2d');
  if (!g) return;
  const w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(31,46,39,0.93)';
  g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 14); g.fill();
  g.strokeStyle = '#c9a24a'; g.lineWidth = 4; g.stroke();
  g.fillStyle = '#e8dcc0';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const n = lines.length;
  lines.forEach((ln, i) => {
    g.font = `${i === 0 ? 'bold 24' : '20'}px Georgia, 'DejaVu Serif', serif`;
    g.fillText(ln, w / 2, (h / (n + (progress >= 0 ? 1 : 0) + 0.2)) * (i + 0.8));
  });
  if (progress >= 0) {
    const bx = 24, by = h - 26, bw = w - 48, bh = 10;
    g.fillStyle = '#4d5866'; g.fillRect(bx, by, bw, bh);
    g.fillStyle = '#c9a24a'; g.fillRect(bx, by, bw * Math.min(1, Math.max(0, progress)), bh);
  }
  t.needsUpdate = true;
}

let badgeTex: THREE.CanvasTexture | null = null;
function badgeTexture(): THREE.CanvasTexture {
  if (badgeTex) return badgeTex;
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const g = cv.getContext('2d');
  if (g) {
    g.fillStyle = 'rgba(20,24,22,0.55)';
    g.beginPath(); g.ellipse(64, 60, 50, 46, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e8dcc0';
    g.beginPath(); g.ellipse(64, 56, 46, 42, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(50, 90); g.lineTo(78, 90); g.lineTo(64, 118); g.closePath(); g.fill();
    g.strokeStyle = '#c9a24a'; g.lineWidth = 6;
    g.beginPath(); g.ellipse(64, 56, 40, 36, 0, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#7a2230';
    g.font = `bold 62px Georgia, 'DejaVu Serif', serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('!', 64, 58);
  }
  badgeTex = new THREE.CanvasTexture(cv);
  badgeTex.colorSpace = THREE.SRGBColorSpace;
  return badgeTex;
}

/** a sprite kept ~px pixels tall on screen, floating above a world point */
export class ScreenSprite {
  readonly sprite: THREE.Sprite;
  private phase = Math.random() * 6;
  constructor(parent: THREE.Object3D, readonly px: number, readonly aspect: number, tex?: THREE.Texture, bob = true) {
    const mat = new THREE.SpriteMaterial({ map: tex ?? badgeTexture(), depthTest: false, depthWrite: false, transparent: true, toneMapped: false, fog: false });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.renderOrder = 999;
    this.sprite.center.set(0.5, bob ? 0.05 : 0);
    this.bob = bob;
    parent.add(this.sprite);
  }
  private bob: boolean;
  place(p: THREE.Vector3, cam: THREE.Camera, viewH: number, dt: number, lift: number): void {
    this.phase += dt * 3;
    const s = THREE.MathUtils.clamp(this.px * worldPerPixel(cam, p, viewH), 0.9, 30);
    this.sprite.scale.set(s * this.aspect, s, 1);
    this.sprite.position.set(p.x, p.y + lift + (this.bob ? Math.sin(this.phase) * s * 0.06 : 0), p.z);
  }
  set visible(v: boolean) { this.sprite.visible = v; }
  get visible(): boolean { return this.sprite.visible; }
  dispose(): void {
    this.sprite.removeFromParent();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
  }
}
