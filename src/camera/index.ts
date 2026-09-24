import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Ctx, System } from '../core/types';
import type { CameraAPI, CameraMode, SelectKind } from '../core/apis';
import { AIM_Y, FOLLOW_ZOOM, createPicker, positionOf } from './picking';
import { createOccluderFader, type Subject } from './occlusion';

/*
 * Camera system.
 *  - ISO (default): true isometric OrthographicCamera (azimuth 45°, elevation atan(1/√2) ≈ 35.264°).
 *    Pan: left/middle drag, WASD/arrows (view-relative). Zoom: wheel/pinch toward cursor. Q/E rotate 90° (eased), R reset.
 *  - PERSP (P toggles): PerspectiveCamera + damped OrbitControls, clamped above ground.
 *  - FOLLOW (F, or double-click): the view smoothly tracks the selected train, person, vehicle, boat or animal; Esc exits.
 *  - Click picks trains → vehicles → boats/animals → people → station pickables → town buildings, emits 'select'.
 *  - v2: the ground FOOTPRINT (not just the target) is clamped inside layout.terrain.playHalf, which also sets the
 *    widest zoom-out, so the skirt and the map-edge portals are never on screen in iso.
 *  - v2: occluders (world.occluders) fade when they hide the followed / selected thing or a train at a platform.
 * Both cameras share `userData.target` (a live Vector3 = focus point) for atmosphere particles.
 */

const ISO_EL = Math.atan(1 / Math.SQRT2); // 35.264°
const DIST = 900; // ortho camera distance from target (far enough to never clip)
/** the footprint clamp usually stops the zoom-out before this */
const MIN_ZOOM = 0.16;
const MAX_ZOOM = 9;
/** margin kept between the view footprint and the edge of the play area */
const EDGE_MARGIN = 4;
const FOLLOWABLE = new Set<SelectKind>(['train', 'person', 'vehicle', 'boat', 'animal']);
const KIND_NOUN: Record<SelectKind, string> = { train: 'train', person: 'person', vehicle: 'carriage', boat: 'boat', animal: 'animal', building: 'building', station: 'building' };
const ROT_TIME = 0.7;
/** default azimuth: camera sits ESE of the station so the V of the two lines opens toward the viewer
 *  and neither platform hides behind the station building (override with ?az=<deg> for testing). */
const BASE_AZ_DEFAULT = THREE.MathUtils.degToRad(60);

/** extra members beyond CameraAPI (UI uses them through a structural check) */
export interface CameraExtras {
  followed(): { kind: SelectKind | null; id: string | null };
  zoomTo(z: number): void;
  lookAt(pos: THREE.Vector3, zoom?: number): void;
  occluderState(): Record<string, number>;
  readonly zoom: number;
}

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export function createCamera(ctx: Ctx): System {
  const { layout, bus, reg } = ctx;
  const canvas = ctx.renderer.domElement;
  canvas.style.touchAction = 'none';

  const target = new THREE.Vector3();
  const home = new THREE.Vector3();
  let baseHalfH = 80; // ortho half height at zoom 1 (fit to station)

  // ── cameras ──
  const iso = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
  const persp = new THREE.PerspectiveCamera(42, 1, 0.5, 3000);
  iso.userData.target = target;
  persp.userData.target = target;
  iso.name = 'isoCamera';
  persp.name = 'perspCamera';

  const controls = new OrbitControls(persp, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(78);
  controls.minPolarAngle = THREE.MathUtils.degToRad(8);
  controls.minDistance = 12;
  controls.maxDistance = 380;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
  controls.enabled = false;

  // ── state ──
  let view: 'iso' | 'persp' = 'iso';
  let followId: string | null = null;
  let followKind: SelectKind | null = null;
  let selected: { kind: SelectKind | null; id: string | null } = { kind: null, id: null };
  const azParam = Number(ctx.params.raw.get('az'));
  const BASE_AZ = Number.isFinite(azParam) && ctx.params.raw.get('az') ? THREE.MathUtils.degToRad(azParam) : BASE_AZ_DEFAULT;
  let az = BASE_AZ; // current azimuth (camera offset direction angle measured from +z toward +x)
  let azFrom = az, azTo = az, rotT = 1;
  let zoom = 1, zoomTarget = 1;
  let shakeAmt = 0;
  let shakeSeed = 0;
  const keys = new Set<string>();

  // tmp
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _ndc = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ray = new THREE.Raycaster();

  function aspect() { return Math.max(0.1, window.innerWidth / Math.max(1, window.innerHeight)); }

  function isoOffset(a: number, out: THREE.Vector3) {
    return out.set(Math.cos(ISO_EL) * Math.sin(a), Math.sin(ISO_EL), Math.cos(ISO_EL) * Math.cos(a)).multiplyScalar(DIST);
  }

  /** Fit the station + both platforms + forecourt into view for azimuth `a`. Sets home + baseHalfH. */
  function computeFraming(a: number) {
    const pts: THREE.Vector3[] = [];
    for (const p of [layout.platforms[1], layout.platforms[2]]) {
      const dx = Math.cos(p.yaw) * p.length / 2, dz = -Math.sin(p.yaw) * p.length / 2;
      const ix = p.inward.x * p.width, iz = p.inward.z * p.width;
      pts.push(new THREE.Vector3(p.center.x + dx, 0, p.center.z + dz), new THREE.Vector3(p.center.x - dx, 0, p.center.z - dz));
      // include the track side (outward) with a little extra for trains
      pts.push(new THREE.Vector3(p.center.x + dx - ix, 0, p.center.z + dz - iz), new THREE.Vector3(p.center.x - dx - ix, 0, p.center.z - dz - iz));
    }
    pts.push(layout.station.center.clone().setY(18));
    // footbridge (with deck height) so the wedge tip isn't lost under the left-hand panels
    pts.push(layout.footbridge.a.clone().setY(layout.footbridge.deck), layout.footbridge.b.clone().setY(layout.footbridge.deck));
    const fc = layout.forecourt;
    pts.push(new THREE.Vector3(fc.center.x, 0, fc.center.z));
    // view basis
    const off = isoOffset(a, _v).normalize();
    const fwd = off.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      const x = p.dot(right), y = p.dot(up);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    // shift content slightly down/left of centre: the top corners carry the clock panel and the departures board
    const cx = (minX + maxX) / 2 + (maxX - minX) * 0.03, cy = (minY + maxY) / 2 + (maxY - minY) * 0.07;
    // screen centre point → back onto ground plane: point P with P·right = cx, P·up = cy, P.y = 0
    const centre = right.clone().multiplyScalar(cx).add(up.clone().multiplyScalar(cy));
    // move along fwd until y = 0
    const s = -centre.y / fwd.y;
    centre.addScaledVector(fwd, s);
    home.copy(centre).setY(0);
    const halfW = (maxX - minX) / 2, halfH = (maxY - minY) / 2;
    // leave room for UI overlays (≈10% margin + extra vertical)
    baseHalfH = Math.max(halfH * 1.32, (halfW * 1.18) / aspect(), 40);
  }

  function applyIsoProjection() {
    const a = aspect();
    const h = baseHalfH;
    iso.left = -h * a; iso.right = h * a; iso.top = h; iso.bottom = -h;
    iso.zoom = zoom;
    iso.updateProjectionMatrix();
  }

  function placeIso() {
    isoOffset(az, _v);
    iso.position.copy(target).add(_v);
    iso.up.set(0, 1, 0);
    iso.lookAt(target);
    if (shakeAmt > 0.001) {
      const s = shakeAmt * (baseHalfH / zoom) * 0.02;
      shakeSeed += 1;
      iso.position.x += (Math.sin(shakeSeed * 12.9898) * 0.5) * s * 2;
      iso.position.y += (Math.sin(shakeSeed * 78.233) * 0.5) * s * 2;
      iso.position.z += (Math.sin(shakeSeed * 37.719) * 0.5) * s * 2;
    }
    iso.updateMatrixWorld();
  }

  /**
   * Keep the iso view's ground footprint inside ±playHalf: first cap the zoom-out so the footprint fits at all, then
   * slide the target in. The footprint is the rectangle target ± halfW·R ± halfH·G, where R is the screen-right
   * ground vector and G the ground vector of screen-up (screen-up slid along the view ray onto y = 0).
   */
  const _F = new THREE.Vector3(), _R = new THREE.Vector3(), _U = new THREE.Vector3(), _G = new THREE.Vector3();
  function clampFootprint() {
    const P = layout.terrain.playHalf - EDGE_MARGIN;
    if (view === 'persp') {
      const B = P - 140;
      const dx = THREE.MathUtils.clamp(controls.target.x, -B, B) - controls.target.x;
      const dz = THREE.MathUtils.clamp(controls.target.z, -B, B) - controls.target.z;
      if (dx || dz) { controls.target.x += dx; controls.target.z += dz; persp.position.x += dx; persp.position.z += dz; }
      target.x = THREE.MathUtils.clamp(target.x, -B, B);
      target.z = THREE.MathUtils.clamp(target.z, -B, B);
      return;
    }
    isoOffset(az, _F).normalize().negate();
    _R.crossVectors(_F, THREE.Object3D.DEFAULT_UP).normalize();
    _U.crossVectors(_R, _F);
    _G.copy(_U).addScaledVector(_F, -_U.y / _F.y);
    const hw = baseHalfH * aspect(), hh = baseHalfH;
    const ex1 = Math.abs(_R.x) * hw + Math.abs(_G.x) * hh;
    const ez1 = Math.abs(_R.z) * hw + Math.abs(_G.z) * hh;
    const minZ = Math.max(MIN_ZOOM, Math.max(ex1, ez1) / P);
    if (zoomTarget < minZ) zoomTarget = minZ;
    if (zoom < minZ) { zoom = minZ; applyIsoProjection(); }
    const ex = ex1 / zoom, ez = ez1 / zoom;
    target.x = THREE.MathUtils.clamp(target.x, -P + ex, P - ex);
    target.z = THREE.MathUtils.clamp(target.z, -P + ez, P - ez);
  }

  function onResize() {
    applyIsoProjection();
    persp.aspect = aspect();
    persp.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);

  function reset() {
    rotT = 1; az = azFrom = azTo = BASE_AZ;
    computeFraming(az);
    target.copy(home);
    zoom = zoomTarget = 1;
    followId = null; followKind = null;
    applyIsoProjection();
    if (view === 'persp') enterPersp();
    syncMode();
  }

  // ── mode switching ──
  function enterPersp() {
    view = 'persp';
    // place persp so it roughly matches the iso framing
    const visibleH = (baseHalfH * 2) / zoom;
    const dist = THREE.MathUtils.clamp(visibleH / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2))), 30, 480);
    const el = THREE.MathUtils.degToRad(40);
    persp.position.set(
      target.x + Math.cos(el) * Math.sin(az) * dist,
      target.y + Math.sin(el) * dist,
      target.z + Math.cos(el) * Math.cos(az) * dist,
    );
    controls.target.copy(target);
    persp.aspect = aspect();
    persp.updateProjectionMatrix();
    controls.enabled = true;
    controls.update();
    ctx.camera.current = persp;
  }

  function enterIso() {
    view = 'iso';
    controls.enabled = false;
    // derive azimuth + zoom from persp
    _v.copy(persp.position).sub(controls.target);
    const q = Math.round((Math.atan2(_v.x, _v.z) - BASE_AZ) / (Math.PI / 2));
    az = azFrom = azTo = BASE_AZ + q * (Math.PI / 2);
    rotT = 1;
    target.copy(controls.target).setY(0);
    const dist = _v.length();
    const visibleH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
    zoom = zoomTarget = THREE.MathUtils.clamp((baseHalfH * 2) / visibleH, MIN_ZOOM, MAX_ZOOM);
    applyIsoProjection();
    ctx.camera.current = iso;
  }

  function syncMode() { api.mode = followId ? 'follow' : view; }

  // ── picking ──
  function setRayFromClient(cx: number, cy: number) {
    const r = canvas.getBoundingClientRect();
    _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(_ndc, ctx.camera.current);
  }

  function groundAt(cx: number, cy: number, out: THREE.Vector3): boolean {
    setRayFromClient(cx, cy);
    return ray.ray.intersectPlane(ground, out) !== null;
  }

  const picker = createPicker(ctx);
  function pick(cx: number, cy: number) {
    setRayFromClient(cx, cy);
    return picker.pick(ray);
  }
  /** forgiving click pick: a direct hit wins; otherwise (or when only scenery was hit) try a small ring of rays
   *  around the cursor for small moving things — a sheep or a person is only a few pixels wide in iso */
  const RING = [[0, -7], [7, 0], [0, 7], [-7, 0], [5, -5], [5, 5], [-5, 5], [-5, -5], [0, -13], [12, 0], [0, 12], [-12, 0]] as const;
  function clickPick(cx: number, cy: number) {
    const direct = pick(cx, cy);
    if (direct && direct.kind !== 'building' && direct.kind !== 'station') return direct;
    for (const [dx, dy] of RING) {
      setRayFromClient(cx + dx, cy + dy);
      const h = picker.pickLiving(ray);
      if (h) return h;
    }
    return direct;
  }

  // ── pointer handling (iso mode: custom pan/zoom; persp: OrbitControls, we only pick) ──
  const pointers = new Map<number, { x: number; y: number }>();
  let downPos: { x: number; y: number; t: number; button: number } | null = null;
  let dragMoved = false;
  let pinchDist = 0;
  const panPrev = new THREE.Vector3();
  let panning = false;
  let hoverDirty = false;
  let hoverX = 0, hoverY = 0;
  let lastHover = 0;

  function onPointerDown(e: PointerEvent) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    downPos = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
    dragMoved = false;
    if (view !== 'iso') return;
    canvas.setPointerCapture?.(e.pointerId);
    if (pointers.size === 1 && (e.button === 0 || e.button === 1 || e.button === 2)) {
      panning = groundAt(e.clientX, e.clientY, panPrev);
    } else if (pointers.size === 2) {
      panning = false;
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }

  function onPointerMove(e: PointerEvent) {
    hoverX = e.clientX; hoverY = e.clientY; hoverDirty = true;
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (downPos && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) dragMoved = true;
    const prevX = p.x, prevY = p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (view !== 'iso') return;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) {
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
      }
      pinchDist = d;
      // two-finger pan
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const pmx = mx - (e.clientX - prevX) / 2, pmy = my - (e.clientY - prevY) / 2;
      if (groundAt(pmx, pmy, _v) && groundAt(mx, my, _v2)) { target.add(_v.sub(_v2)); breakFollowOnPan(); }
      return;
    }
    if (panning && dragMoved) {
      placeIso();
      if (groundAt(e.clientX, e.clientY, _v)) {
        target.x += panPrev.x - _v.x;
        target.z += panPrev.z - _v.z;
        placeIso();
        breakFollowOnPan();
      }
    }
  }

  function breakFollowOnPan() {
    if (followId) { followId = null; followKind = null; syncMode(); }
  }

  function onPointerUp(e: PointerEvent) {
    const wasClick = downPos && !dragMoved && e.button === 0 && performance.now() - downPos.t < 600 && pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) panning = false;
    else if (view === 'iso' && pointers.size === 1) {
      const [p] = [...pointers.values()];
      panning = groundAt(p.x, p.y, panPrev);
    }
    canvas.releasePointerCapture?.(e.pointerId);
    if (wasClick) handleClick(e.clientX, e.clientY);
    downPos = null;
  }

  let lastClick = { t: 0, kind: null as SelectKind | null, id: null as string | null };
  function handleClick(cx: number, cy: number) {
    const p = clickPick(cx, cy);
    const now = performance.now();
    if (!p) { bus.emit('select', { kind: null, id: null }); lastClick.t = 0; return; }
    // double-click on the same thing: follow it
    if (now - lastClick.t < 420 && lastClick.kind === p.kind && lastClick.id === p.id && FOLLOWABLE.has(p.kind)) {
      api.followAny(p.kind, p.id);
      lastClick.t = 0;
      return;
    }
    lastClick = { t: now, kind: p.kind, id: p.id };
    if (selected.kind !== p.kind || selected.id !== p.id) bus.emit('select', { kind: p.kind, id: p.id });
  }

  /** zoom immediately, keeping the ground point under the cursor fixed (wheel steps are small enough to feel smooth) */
  function zoomAt(cx: number, cy: number, factor: number) {
    const hadBefore = groundAt(cx, cy, _v2);
    zoomTarget = THREE.MathUtils.clamp(zoomTarget * factor, MIN_ZOOM, MAX_ZOOM);
    zoom = zoomTarget;
    applyIsoProjection();
    placeIso();
    if (hadBefore && !followId && groundAt(cx, cy, _v)) {
      target.x += _v2.x - _v.x;
      target.z += _v2.z - _v.z;
    }
  }

  function onWheel(e: WheelEvent) {
    if (view !== 'iso') return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const factor = Math.exp(-THREE.MathUtils.clamp(delta, -200, 200) * 0.0015);
    zoomAt(e.clientX, e.clientY, factor);
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', () => { canvas.style.cursor = ''; });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ── keyboard ──
  function isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }
  const PAN_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (PAN_KEYS.has(k)) { keys.add(k); if (k.startsWith('arrow')) e.preventDefault(); return; }
    if (e.repeat) return;
    switch (k) {
      case 'q': api.rotateQuarter(-1); break;
      case 'e': api.rotateQuarter(1); break;
      case 'r': reset(); break;
      case 'p': api.setMode(view === 'iso' ? 'persp' : 'iso'); break;
      case 'f':
        if (followId) api.followAny(null, null);
        else if (selected.kind && selected.id && FOLLOWABLE.has(selected.kind)) api.followAny(selected.kind, selected.id);
        else { try { reg.ui?.toast('Select a train, traveller, carriage, boat or beast first, then press F to follow it'); } catch { /* */ } }
        break;
      case 'escape': if (followId) api.followAny(null, null); break;
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  bus.on('select', (s) => {
    selected = s;
  });

  // ── API ──
  const api: CameraAPI & CameraExtras = {
    mode: 'iso',
    setMode(m: CameraMode) {
      if (m === 'follow') {
        if (selected.kind && selected.id && FOLLOWABLE.has(selected.kind)) api.followAny(selected.kind, selected.id);
        return;
      }
      if (m === view) return;
      if (m === 'persp') enterPersp(); else enterIso();
      syncMode();
    },
    focus(pos: THREE.Vector3) {
      followId = null; followKind = null;
      if (view === 'persp') {
        _v.copy(pos).setY(0).sub(controls.target);
        controls.target.add(_v);
        persp.position.add(_v);
      }
      focusGoal.copy(pos).setY(0);
      focusing = true;
      syncMode();
    },
    follow(trainId: string | null) {
      api.followAny(trainId ? 'train' : null, trainId);
    },
    shake(amount: number) {
      shakeAmt = Math.min(3, shakeAmt + Math.max(0, amount));
    },
    followAny(kind, id) {
      if (!kind || !id || !FOLLOWABLE.has(kind) || !positionOf(ctx, kind, id, _v)) {
        followId = null; followKind = null; syncMode(); return;
      }
      followId = id; followKind = kind;
      focusing = false;
      const z = FOLLOW_ZOOM[kind];
      if (view === 'iso' && zoomTarget < z) zoomTarget = z;
      syncMode();
    },
    rotateQuarter(dir: 1 | -1) {
      if (view === 'persp') {
        // rotate orbit around target by 90°
        _v.copy(persp.position).sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), (dir * Math.PI) / 2);
        perspRotFrom.copy(persp.position).sub(controls.target);
        perspRotTo.copy(_v);
        perspRotT = 0;
        return;
      }
      azFrom = az;
      azTo = (rotT < 1 ? azTo : az) + (dir * Math.PI) / 2;
      rotT = 0;
    },
    followed: () => ({ kind: followId ? followKind : null, id: followId }),
    zoomTo(z: number) { zoomTarget = THREE.MathUtils.clamp(z, MIN_ZOOM, MAX_ZOOM); },
    lookAt(pos: THREE.Vector3, z?: number) { api.focus(pos); if (z !== undefined) api.zoomTo(z); },
    occluderState: () => occluders.state(),
    get zoom() { return zoom; },
  };
  ctx.reg.camera = api;
  // ?cx=&cz=[&zoom=] frames an iso close-up for screenshots (the top-down debug view uses the same params itself)
  bus.on('ready', () => {
    const raw = ctx.params.raw;
    if (!raw.get('cx') || !raw.get('cz') || (ctx.params.debug ?? '').includes('top')) return;
    const cx = Number(raw.get('cx')), cz = Number(raw.get('cz')), z = Number(raw.get('zoom'));
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
    api.lookAt(new THREE.Vector3(cx, 0, cz), Number.isFinite(z) && raw.get('zoom') ? z : undefined);
  });

  const occluders = createOccluderFader(ctx);
  const occFocus: Subject[] = [{ pos: new THREE.Vector3(), kind: 'train' }, { pos: new THREE.Vector3(), kind: 'train' }];
  const _sel = new THREE.Vector3();
  let focusing = false;
  const focusGoal = new THREE.Vector3();
  const perspRotFrom = new THREE.Vector3(), perspRotTo = new THREE.Vector3();
  let perspRotT = 1;

  // ── init ──
  computeFraming(az);
  target.copy(home);
  applyIsoProjection();
  placeIso();
  onResize();
  ctx.camera.current = iso;

  let lastT = performance.now();

  return {
    name: 'camera',
    update() {
      // main sub-steps update(); animate on real frame time instead so easing is frame-consistent
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastT) / 1000);
      if (dt <= 0.0005) return;
      lastT = now;

      // follow target
      if (followId) {
        if (!positionOf(ctx, followKind, followId, _v)) {
          const noun = KIND_NOUN[followKind ?? 'train'];
          followId = null; followKind = null; syncMode();
          try { reg.ui?.toast(`The ${noun} has passed beyond sight.`); } catch { /* */ }
        } else {
          _v.setY(0);
          const k = 1 - Math.exp(-dt * 4);
          const dx = (_v.x - target.x) * k, dz = (_v.z - target.z) * k;
          target.x += dx; target.z += dz;
          if (view === 'persp') { controls.target.x += dx; controls.target.z += dz; persp.position.x += dx; persp.position.z += dz; }
        }
      } else if (focusing) {
        const k = 1 - Math.exp(-dt * 5);
        target.x += (focusGoal.x - target.x) * k;
        target.z += (focusGoal.z - target.z) * k;
        if (Math.hypot(focusGoal.x - target.x, focusGoal.z - target.z) < 0.05) focusing = false;
      }

      // keyboard pan (view relative)
      if (keys.size) {
        let fx = 0, fz = 0;
        if (keys.has('w') || keys.has('arrowup')) fz += 1;
        if (keys.has('s') || keys.has('arrowdown')) fz -= 1;
        if (keys.has('d') || keys.has('arrowright')) fx += 1;
        if (keys.has('a') || keys.has('arrowleft')) fx -= 1;
        if (fx || fz) {
          ctx.camera.current.getWorldDirection(_fwd); _fwd.y = 0; _fwd.normalize();
          _right.set(-_fwd.z, 0, _fwd.x);
          const speed = view === 'iso' ? (baseHalfH / zoom) * 1.1 : Math.max(20, persp.position.distanceTo(controls.target) * 0.9);
          _v.copy(_fwd).multiplyScalar(fz).addScaledVector(_right, fx).normalize().multiplyScalar(speed * dt);
          target.add(_v);
          if (view === 'persp') { controls.target.add(_v); persp.position.add(_v); }
          breakFollowOnPan();
          focusing = false;
        }
      }

      // rotation tween
      if (rotT < 1) {
        rotT = Math.min(1, rotT + dt / ROT_TIME);
        az = azFrom + (azTo - azFrom) * easeInOut(rotT);
      }
      // smooth zoom (only if not already applied)
      if (Math.abs(zoom - zoomTarget) > 1e-4) {
        zoom += (zoomTarget - zoom) * (1 - Math.exp(-dt * 8));
        applyIsoProjection();
      }
      clampFootprint();

      shakeAmt *= Math.exp(-dt * 3.5);
      if (shakeAmt < 0.002) shakeAmt = 0;

      if (view === 'iso') {
        placeIso();
      } else {
        if (perspRotT < 1) {
          perspRotT = Math.min(1, perspRotT + dt / ROT_TIME);
          const e = easeInOut(perspRotT);
          const a0 = Math.atan2(perspRotFrom.x, perspRotFrom.z);
          let a1 = Math.atan2(perspRotTo.x, perspRotTo.z);
          if (a1 - a0 > Math.PI) a1 -= Math.PI * 2; else if (a0 - a1 > Math.PI) a1 += Math.PI * 2;
          const a = a0 + (a1 - a0) * e;
          const r = Math.hypot(perspRotFrom.x, perspRotFrom.z);
          persp.position.set(controls.target.x + Math.sin(a) * r, controls.target.y + perspRotFrom.y, controls.target.z + Math.cos(a) * r);
        }
        controls.update();
        if (persp.position.y < 3) persp.position.y = 3;
        target.copy(controls.target).setY(0);
        if (shakeAmt > 0.001) {
          shakeSeed++;
          const s = shakeAmt * 0.4;
          persp.position.x += Math.sin(shakeSeed * 12.9898) * s;
          persp.position.y += Math.sin(shakeSeed * 78.233) * s;
        }
        persp.updateMatrixWorld();
      }

      // occluder fades: the followed thing, the selected thing, and trains at the platforms
      let nf = 0;
      if (followId && followKind && positionOf(ctx, followKind, followId, occFocus[0]!.pos)) { occFocus[0]!.pos.y += AIM_Y[followKind]; occFocus[0]!.kind = followKind; nf = 1; }
      if (selected.kind && selected.id && FOLLOWABLE.has(selected.kind) && selected.id !== followId && positionOf(ctx, selected.kind, selected.id, _sel)) {
        occFocus[nf]!.pos.copy(_sel); occFocus[nf]!.pos.y += AIM_Y[selected.kind]; occFocus[nf]!.kind = selected.kind; nf++;
      }
      occluders.update(dt, now, occFocus.slice(0, nf), ctx.camera.current);

      // hover cursor (throttled)
      if (hoverDirty && pointers.size === 0 && now - lastHover > 120) {
        hoverDirty = false;
        lastHover = now;
        const p = pick(hoverX, hoverY);
        canvas.style.cursor = p ? 'pointer' : '';
      }
    },
    dispose() {
      window.removeEventListener('resize', onResize);
      controls.dispose();
    },
  };
}
