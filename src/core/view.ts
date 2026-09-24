import * as THREE from 'three';

/**
 * VIEW STATE (v2): written by main.ts once per rendered frame (before systems update) from ctx.camera.current,
 * read by everyone for LOD, culling, "is this spawn point on screen?" and detail fades.
 * The camera system does NOT need to write it; it only has to keep its ground footprint inside
 * layout.terrain.playHalf.
 */
export interface ViewState {
  /** ground point at the screen centre */
  readonly focus: THREE.Vector3;
  /** iso zoom (1 = default framing); perspective mode reports an equivalent */
  readonly zoom: number;
  readonly ortho: boolean;
  /** ground-plane (y=0) quad of the viewport corners, xz as Vector2 (x, z); perspective rays that miss clamp at 600 m */
  readonly footprint: THREE.Vector2[];
  /** axis-aligned bounds of the footprint (xz) */
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** approx screen pixels per world metre at the focus (LOD / picking tolerance) */
  readonly pxPerMetre: number;
  readonly frustum: THREE.Frustum;
  readonly camera: THREE.Camera;
  /** true when the sphere (p, marginM) intersects the camera frustum */
  isVisible(p: THREE.Vector3, marginM?: number): boolean;
  /** distance (xz) from the focus */
  distToFocus(x: number, z: number): number;
}

export class View implements ViewState {
  readonly focus = new THREE.Vector3();
  zoom = 1;
  ortho = true;
  readonly footprint = [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()];
  readonly bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  pxPerMetre = 6;
  readonly frustum = new THREE.Frustum();
  camera: THREE.Camera = new THREE.PerspectiveCamera();
  private m = new THREE.Matrix4();
  private ray = new THREE.Raycaster();
  private s = new THREE.Sphere();
  private ndc = new THREE.Vector2();
  private hit = new THREE.Vector3();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  /** default iso half-height in metres (for zoom normalisation); set by main from the camera at startup */
  baseHalfH = 100;

  isVisible(p: THREE.Vector3, marginM = 0): boolean {
    this.s.center.copy(p);
    this.s.radius = marginM;
    return this.frustum.intersectsSphere(this.s);
  }

  distToFocus(x: number, z: number): number { return Math.hypot(x - this.focus.x, z - this.focus.z); }

  private ground(nx: number, ny: number, out: THREE.Vector2) {
    this.ndc.set(nx, ny);
    this.ray.setFromCamera(this.ndc, this.camera);
    const r = this.ray.ray;
    if (r.intersectPlane(this.plane, this.hit) && this.hit.distanceTo(r.origin) < 2000) out.set(this.hit.x, this.hit.z);
    else {
      // looking above the horizon: clamp 600 m out along the ray's ground direction
      const d = new THREE.Vector2(r.direction.x, r.direction.z);
      if (d.lengthSq() < 1e-9) d.set(1, 0);
      d.normalize().multiplyScalar(600);
      out.set(r.origin.x + d.x, r.origin.z + d.y);
    }
  }

  /** main.ts calls this each frame */
  update(cam: THREE.Camera, viewportHeightPx: number): void {
    this.camera = cam;
    cam.updateMatrixWorld();
    this.m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m);
    const c = new THREE.Vector2();
    this.ground(0, 0, c);
    this.focus.set(c.x, 0, c.y);
    this.ground(-1, -1, this.footprint[0]);
    this.ground(1, -1, this.footprint[1]);
    this.ground(1, 1, this.footprint[2]);
    this.ground(-1, 1, this.footprint[3]);
    const b = this.bounds;
    b.minX = Math.min(...this.footprint.map((p) => p.x)); b.maxX = Math.max(...this.footprint.map((p) => p.x));
    b.minZ = Math.min(...this.footprint.map((p) => p.y)); b.maxZ = Math.max(...this.footprint.map((p) => p.y));
    const o = cam as THREE.OrthographicCamera;
    this.ortho = !!o.isOrthographicCamera;
    if (this.ortho) {
      const halfH = (o.top - o.bottom) / 2 / (o.zoom || 1);
      this.zoom = this.baseHalfH / Math.max(1e-3, halfH);
      this.pxPerMetre = viewportHeightPx / Math.max(1e-3, 2 * halfH);
    } else {
      const p = cam as THREE.PerspectiveCamera;
      const dist = Math.max(1, cam.position.distanceTo(this.focus));
      const halfH = dist * Math.tan(THREE.MathUtils.degToRad((p.fov ?? 45) / 2));
      this.zoom = this.baseHalfH / Math.max(1e-3, halfH);
      this.pxPerMetre = viewportHeightPx / Math.max(1e-3, 2 * halfH);
    }
  }
}
