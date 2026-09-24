import * as THREE from 'three';

/**
 * Where the active camera is looking. Computed once per frame by the atmosphere system and shared by
 * every effect (particles, mist, shadow frustum, fog distances), so they all follow the view.
 */
export interface ViewInfo {
  /** point on the ground plane (y = 0) under the view centre */
  focus: THREE.Vector3;
  /** camera world position */
  camPos: THREE.Vector3;
  /** camera forward (unit) */
  forward: THREE.Vector3;
  /** distance from the camera to the focus along the view axis */
  dist: number;
  /** approx half-size (m) of the ground area that is on screen */
  extent: number;
  /** world units per screen pixel at the focus */
  pxWorld: number;
  ortho: boolean;
  /** viewport height in device pixels */
  heightPx: number;
}

const _fwd = new THREE.Vector3();

export function createViewInfo(): ViewInfo {
  return {
    focus: new THREE.Vector3(10, 0, -5),
    camPos: new THREE.Vector3(300, 300, 300),
    forward: new THREE.Vector3(-1, -1, -1).normalize(),
    dist: 500,
    extent: 150,
    pxWorld: 0.25,
    ortho: true,
    heightPx: 800,
  };
}

export function updateViewInfo(v: ViewInfo, cam: THREE.Camera, renderer: THREE.WebGLRenderer): void {
  cam.updateMatrixWorld();
  cam.getWorldPosition(v.camPos);
  cam.getWorldDirection(_fwd);
  v.forward.copy(_fwd);
  const h = renderer.domElement.height || 800;
  v.heightPx = h;

  // intersect the view ray with the ground plane
  let t: number;
  if (_fwd.y < -0.05) t = -v.camPos.y / _fwd.y;
  else t = 150; // looking at the horizon: pick a point ahead
  t = Math.min(Math.max(t, 1), 2500);
  v.focus.copy(v.camPos).addScaledVector(_fwd, t);
  v.focus.y = 0;
  v.dist = t;

  const sinE = Math.max(0.3, -_fwd.y);
  const o = cam as THREE.OrthographicCamera;
  const p = cam as THREE.PerspectiveCamera;
  if (o.isOrthographicCamera) {
    v.ortho = true;
    const halfH = (o.top - o.bottom) / 2 / (o.zoom || 1);
    const halfW = (o.right - o.left) / 2 / (o.zoom || 1);
    v.extent = Math.max(halfW, halfH / sinE);
    v.pxWorld = (2 * halfH) / h;
  } else if (p.isPerspectiveCamera) {
    v.ortho = false;
    const halfH = t * Math.tan(THREE.MathUtils.degToRad(p.fov / 2)) / (p.zoom || 1);
    v.extent = Math.min(260, Math.max(halfH * p.aspect, halfH / sinE));
    v.pxWorld = (2 * halfH) / h;
  } else {
    v.ortho = false;
    v.extent = 150;
    v.pxWorld = 0.25;
  }
  v.extent = Math.min(Math.max(v.extent, 20), 600);
}
