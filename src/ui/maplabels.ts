import * as THREE from 'three';
import type { Ctx } from '../core/types';

/**
 * MAP LABELS: when the view is pulled far out, engraved-map style names float over the towns, the river and a few
 * landmarks (like the lettering on an Ordnance Survey sheet). They fade in below ZOOM_IN and are clickable: a click
 * glides the camera there. Plain DOM, positioned once per UI refresh tick from the rendered camera; nothing in the
 * 3D scene, so no draw calls.
 */
const ZOOM_SHOW = 0.62; // labels start to appear below this camera zoom
const ZOOM_FULL = 0.42; // fully opaque below this

interface Label { el: HTMLElement; pos: THREE.Vector3; zoomTo: number; min: number }

export function createMapLabels(ctx: Ctx) {
  const { layout } = ctx;
  const el = document.createElement('div');
  el.className = 'vj-maplabels';
  const labels: Label[] = [];
  const add = (text: string, pos: THREE.Vector3, cls: string, zoomTo = 1.3, min = 0) => {
    const e = document.createElement('div');
    e.className = `ml ${cls}`;
    e.textContent = text;
    e.title = `Go to ${text}`;
    el.appendChild(e);
    labels.push({ el: e, pos: pos.clone(), zoomTo, min });
  };

  for (const t of layout.towns) {
    if (t.id === 'river') continue;
    if (t.id === 'lc1') { add('Millbridge Gates', t.center, 'small', 2.2); continue; }
    if (t.id === 'station') { add('Victoria Junction', layout.station.center.clone().setY(12), 'station', 1); continue; }
    const big = t.id === 'ashcombe' || t.id === 'millbridge' || t.id === 'wyke';
    add(t.name, t.center.clone().setY(8), big ? 'town' : 'hamlet', big ? 1.4 : 1.8);
  }
  // the river: lettered along two reaches, italic like water names on old maps
  try {
    const R = layout.river;
    for (const s of [150, 820]) {
      const p = R.pointAt(s);
      add('R. Ashbourne', new THREE.Vector3(p.x, 0, p.z), 'water', 1.6);
    }
  } catch { /* river layout variant */ }
  try {
    add('Wyke Post Mill', layout.landmarks.windmill.center.clone().setY(14), 'small', 2.2);
    add('Engine Shed', layout.shed.building.center.clone().setY(9), 'small', 1.8);
    for (const f of layout.fields) if (f.name && /Acre|Down|Kingsmead|Paddock/.test(f.name)) add(f.name, new THREE.Vector3(f.center.x, 0, f.center.z), 'field', 1.5, 0.3);
  } catch { /* optional */ }

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const lab = labels.find((l) => l.el === t);
    if (!lab) return;
    const cam = ctx.reg.camera;
    try {
      if (cam.lookAt) cam.lookAt(lab.pos.clone().setY(0), lab.zoomTo);
      else cam.focus(lab.pos);
    } catch { /* camera mid-edit */ }
  });

  const _v = new THREE.Vector3();
  let shown = -1;
  function update() {
    const zoom = ctx.reg.camera?.zoom ?? ctx.view.zoom ?? 1;
    const a = THREE.MathUtils.clamp((ZOOM_SHOW - zoom) / (ZOOM_SHOW - ZOOM_FULL), 0, 1);
    const persp = !ctx.view.ortho;
    const alpha = persp ? 0 : a;
    if (alpha !== shown) {
      shown = alpha;
      el.style.opacity = alpha.toFixed(2);
      el.style.display = alpha > 0 ? '' : 'none';
    }
    if (alpha <= 0) return;
    const cam = ctx.camera.current;
    const w = window.innerWidth, h = window.innerHeight;
    for (const l of labels) {
      _v.copy(l.pos).project(cam);
      const vis = Math.abs(_v.x) < 1.05 && Math.abs(_v.y) < 1.05 && _v.z < 1 && alpha >= l.min;
      l.el.style.display = vis ? '' : 'none';
      if (vis) l.el.style.transform = `translate(${((_v.x + 1) * 0.5 * w).toFixed(0)}px, ${((1 - _v.y) * 0.5 * h).toFixed(0)}px) translate(-50%, -50%)`;
    }
  }
  return { el, update };
}
