import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { SelectKind, TrainInfo } from '../core/apis';
import { CANOPY_LENGTH } from '../core/layout';

/**
 * OCCLUDER FADES. Every ~0.1 s the camera gathers "subjects" (the followed / selected thing, plus the loco heads of
 * trains standing at the platforms, which is where the station building hides a Highland engine on P2) and casts a
 * ray from each subject toward the camera. Any world occluder (world.occluders()) the ray passes through is eased
 * down to FADE_TO; everything else eases back to solid. setOccluderFade is only called when a value changes.
 *
 * Precision: world hands us axis-aligned boxes, which for the 20°/40°-rotated station and canopies cover far too
 * much ground. Where layout knows the real footprint (station, canopies) we test an ORIENTED box instead.
 * Relevance: glass canopies fade for small subjects (people, animals) standing under them. The P2 track lies on
 * the far side of its canopy from the default az-60 camera, and the glazing reads nearly opaque from above, so a
 * train standing at / drawing into P2 (loco head and the first two cars) also fades canopyP2 — only part way
 * (TRAIN_FADE) so the roof still reads.
 */
const FADE_TO = 0.25;
const TRAIN_FADE = 0.42;
const FADE_RATE = 3.5; // per second
const SCAN_MS = 100;

export interface Subject { pos: THREE.Vector3; kind: SelectKind }

interface Occ {
  id: string;
  bounds: THREE.Box3;
  /** world → local for an oriented box (null: use bounds as is) */
  inv: THREE.Matrix4 | null;
  local: THREE.Box3 | null;
  /** only these subject kinds may fade it (null: all) */
  kinds: Set<SelectKind> | null;
  /** per-kind fade target (default FADE_TO) */
  fadeFor?: Partial<Record<SelectKind, number>>;
}

const SMALL = new Set<SelectKind>(['person', 'animal']);
const SMALL_OR_TRAIN = new Set<SelectKind>(['person', 'animal', 'train']);

export function createOccluderFader(ctx: Ctx) {
  const { reg, layout } = ctx;
  const cur = new Map<string, number>();
  const want = new Map<string, number>();
  let occ: Occ[] = [];
  let occSig = '';
  let occAt = -1e9;
  let lastScan = 0;
  const ray = new THREE.Ray();
  const lray = new THREE.Ray();
  const dir = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _hit = new THREE.Vector3();
  const subjects: Subject[] = [];
  const pool: Subject[] = Array.from({ length: 16 }, () => ({ pos: new THREE.Vector3(), kind: 'train' as SelectKind }));

  function oriented(center: THREE.Vector3, yaw: number, hx: number, hz: number, y0: number, y1: number) {
    const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(center.x, 0, center.z);
    return { inv: m.invert(), local: new THREE.Box3(new THREE.Vector3(-hx, y0, -hz), new THREE.Vector3(hx, y1, hz)) };
  }

  function describe(o: { id: string; bounds: THREE.Box3 }): Occ {
    const id = o.id;
    const b = o.bounds;
    try {
      if (id === 'station') {
        const s = layout.station;
        return { id, bounds: b, ...oriented(s.center, s.yaw, s.size.x / 2 + 3, s.size.z / 2 + 1, b.min.y, b.max.y), kinds: null };
      }
      const m = /^canopyP?([12])$/.exec(id);
      if (m) {
        const p = layout.platforms[Number(m[1]) as 1 | 2];
        const o = oriented(p.center, p.yaw, CANOPY_LENGTH / 2 + 1, p.width / 2 + 0.6, b.min.y, b.max.y);
        if (m[1] === '2') return { id, bounds: b, ...o, kinds: SMALL_OR_TRAIN, fadeFor: { train: TRAIN_FADE } };
        return { id, bounds: b, ...o, kinds: SMALL };
      }
      if (id === 'footbridge') return { id, bounds: b, inv: null, local: null, kinds: SMALL };
    } catch { /* layout variant: fall back to the box */ }
    return { id, bounds: b, inv: null, local: null, kinds: null };
  }

  function refreshOccluders(now: number) {
    if (now - occAt < 2000) return;
    occAt = now;
    let list: { id: string; bounds: THREE.Box3 }[] = [];
    try { list = reg.world.occluders() ?? []; } catch { list = []; }
    const sig = list.map((o) => o.id).join('|');
    if (sig !== occSig) { occSig = sig; occ = list.map(describe); }
  }

  /** loco heads of trains at a platform that the default camera should never lose */
  function addPlatformTrains() {
    let trains: TrainInfo[] = [];
    try { trains = reg.trains.list(); } catch { return; }
    for (const t of trains) {
      if (subjects.length >= pool.length - 2) break;
      if (t.platform == null) continue;
      if (t.state !== 'dwelling' && t.state !== 'braking' && t.state !== 'departing') continue;
      if (!ctx.view.isVisible(t.position, 4)) continue;
      const s = pool[subjects.length]!;
      s.pos.copy(t.position).setY(2.6);
      s.kind = 'train';
      subjects.push(s);
      // at P2 also the first two cars behind the engine (the canopy hides the whole front of the train)
      if (t.platform === 2) {
        try {
          const L = layout.lines[t.line];
          const t0 = L.nearestT(t.position);
          const sg = t.dir === 'east' ? -1 : 1;
          for (const back of [14, 28]) {
            if (subjects.length >= pool.length - 2 || back > t.length) break;
            const q = pool[subjects.length]!;
            q.pos.copy(L.curve.getPointAt(Math.min(1, Math.max(0, t0 + (sg * back) / L.length)))).setY(2.6);
            q.kind = 'train';
            subjects.push(q);
          }
        } catch { /* layout variant */ }
      }
    }
  }

  function hides(o: Occ, s: Subject): boolean {
    if (o.kinds && !o.kinds.has(s.kind)) return false;
    if (o.inv && o.local) {
      lray.copy(ray).applyMatrix4(o.inv);
      if (o.local.containsPoint(lray.origin)) return SMALL.has(s.kind);
      return lray.intersectBox(o.local, _hit) !== null;
    }
    // a small subject standing inside a footprint (a person in the booking hall) counts as hidden
    if (o.bounds.containsPoint(s.pos)) return SMALL.has(s.kind);
    const h = ray.intersectBox(o.bounds, _hit);
    return !!h && _v.copy(h).sub(s.pos).lengthSq() < 250 * 250;
  }

  return {
    /**
     * @param focus explicit subjects (followed / selected, positions with aim height applied)
     * @param cam the rendered camera
     */
    update(dt: number, now: number, focus: Subject[], cam: THREE.Camera) {
      refreshOccluders(now);
      if (!occ.length) return;
      if (now - lastScan >= SCAN_MS) {
        lastScan = now;
        subjects.length = 0;
        for (const f of focus) {
          if (subjects.length >= 4) break;
          const s = pool[subjects.length]!;
          s.pos.copy(f.pos); s.kind = f.kind;
          subjects.push(s);
        }
        addPlatformTrains();
        want.clear();
        const ortho = (cam as THREE.OrthographicCamera).isOrthographicCamera;
        if (ortho) cam.getWorldDirection(dir).negate();
        for (const s of subjects) {
          if (!ortho) dir.copy(cam.position).sub(s.pos).normalize();
          ray.origin.copy(s.pos);
          ray.direction.copy(dir);
          for (const o of occ) {
            const f = o.fadeFor?.[s.kind] ?? FADE_TO;
            if ((want.get(o.id) ?? 1) <= f) continue;
            if (hides(o, s)) want.set(o.id, f);
          }
        }
      }
      // ease every known occluder toward its wanted value
      for (const o of occ) {
        const target = want.get(o.id) ?? 1;
        const c = cur.get(o.id) ?? 1;
        if (Math.abs(c - target) < 1e-3) continue;
        const step = FADE_RATE * dt;
        const n = c < target ? Math.min(target, c + step) : Math.max(target, c - step);
        cur.set(o.id, n);
        try { reg.world.setOccluderFade(o.id, n); } catch { /* world stub */ }
      }
    },
    /** current fade values (debug) */
    state(): Record<string, number> { return Object.fromEntries(cur); },
  };
}
