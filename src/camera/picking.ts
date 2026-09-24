import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { SelectKind } from '../core/apis';
import type { Building } from '../core/countryside';

/**
 * Picking for everything selectable. Order matters: moving things first (trains, road vehicles, boats and animals,
 * people), then the station's own pickables, then town buildings (ray-marched against layout footprints so no
 * extra meshes or raycast targets are needed from world).
 */
export interface PickHit { kind: SelectKind; id: string }

export function createPicker(ctx: Ctx) {
  const { reg, layout } = ctx;
  const _p = new THREE.Vector3();

  function tryCall<T>(f: () => T): T | null { try { return f() ?? null; } catch { return null; } }

  /** top of a building's silhouette at local (lx) — roof ridge or tower */
  function heightOf(b: Building, lx: number): number {
    let h = b.size.y + b.roofH;
    if (b.tower && Math.abs(lx - b.tower.lx) <= b.tower.size / 2 + 0.5) h = Math.max(h, b.tower.h + (b.tower.spire ? 4 : 0));
    return b.center.y + h;
  }

  /** march the ray through the town volume and return the first building footprint whose silhouette it is inside */
  function pickBuilding(ray: THREE.Raycaster): Building | null {
    const o = ray.ray.origin, d = ray.ray.direction;
    if (d.y > -1e-3) return null;
    const tTop = (46 - o.y) / d.y, tBot = (-4 - o.y) / d.y;
    const t0 = Math.max(0, tTop);
    const step = 0.6;
    for (let t = t0; t <= tBot; t += step) {
      _p.copy(o).addScaledVector(d, t);
      const b = layout.terrain.buildingAt(_p.x, _p.z, 0);
      if (!b) continue;
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const lx = (_p.x - b.center.x) * c - (_p.z - b.center.z) * s;
      if (_p.y <= heightOf(b, lx) && _p.y >= b.center.y - 1.5) return b;
    }
    return null;
  }

  function pickStation(ray: THREE.Raycaster): string | null {
    const objs = tryCall(() => reg.world.stationPickables);
    if (!objs || !objs.length) return null;
    const hit = ray.intersectObjects(objs, true)[0];
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o && !o.userData.pick && !o.userData.label && o.parent) o = o.parent;
    return (o?.userData.pick?.id as string) || (o?.userData.label as string) || o?.name || 'building';
  }

  return {
    /** only moving things (trains, vehicles, boats, animals, people) — used for the forgiving click ring */
    pickLiving(ray: THREE.Raycaster): PickHit | null {
      const v = tryCall(() => reg.traffic.raycast(ray));
      if (v) return { kind: 'vehicle', id: v };
      const n = tryCall(() => reg.nature.raycast(ray));
      if (n && n.id) return { kind: n.kind === 'boat' ? 'boat' : 'animal', id: n.id };
      const p = tryCall(() => reg.people.raycast(ray));
      if (p) return { kind: 'person', id: p };
      return null;
    },
    pick(ray: THREE.Raycaster): PickHit | null {
      const t = tryCall(() => reg.trains.raycast(ray));
      if (t) return { kind: 'train', id: t };
      const v = tryCall(() => reg.traffic.raycast(ray));
      if (v) return { kind: 'vehicle', id: v };
      const n = tryCall(() => reg.nature.raycast(ray));
      if (n && n.id) return { kind: n.kind === 'boat' ? 'boat' : 'animal', id: n.id };
      const p = tryCall(() => reg.people.raycast(ray));
      if (p) return { kind: 'person', id: p };
      const st = tryCall(() => pickStation(ray));
      if (st) return { kind: 'station', id: st };
      const b = tryCall(() => pickBuilding(ray));
      if (b) return { kind: 'building', id: b.id };
      return null;
    },
  };
}

/** live world position of a selectable thing (false when it no longer exists) */
export function positionOf(ctx: Ctx, kind: SelectKind | null, id: string | null, out: THREE.Vector3): boolean {
  if (!kind || !id) return false;
  const { reg, layout } = ctx;
  try {
    switch (kind) {
      case 'train': { const t = reg.trains.get(id); if (!t) return false; out.copy(t.position); return true; }
      case 'person': { const p = reg.people.get(id); if (!p) return false; out.copy(p.position); return true; }
      case 'vehicle': { const v = reg.traffic.get(id); if (!v || v.state === 'gone') return false; out.copy(v.pos); return true; }
      case 'boat': { const b = reg.nature.boat(id); if (!b) return false; out.copy(b.pos); return true; }
      case 'animal': { const a = reg.nature.get(id); if (!a) return false; out.copy(a.pos); return true; }
      case 'building': { const b = layout.buildings.find((x) => x.id === id); if (!b) return false; out.copy(b.center); out.y += b.size.y * 0.5; return true; }
      case 'station': {
        if (id === 'shed') { out.copy(layout.shed.building.center); return true; }
        out.copy(layout.station.center); return true;
      }
    }
  } catch { /* system stubbed or mid-edit */ }
  return false;
}

/** eye height to aim at / test occlusion from, per kind */
export const AIM_Y: Record<SelectKind, number> = { train: 2.4, person: 1.1, vehicle: 1.4, boat: 0.6, animal: 0.6, building: 0, station: 0 };
/** zoom to settle at when following */
export const FOLLOW_ZOOM: Record<SelectKind, number> = { train: 1.6, person: 3.2, vehicle: 2.4, boat: 2.2, animal: 3.0, building: 2, station: 1.2 };
