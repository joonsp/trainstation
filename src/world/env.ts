import * as THREE from 'three';
import type { Layout, Rect } from '../core/layout';
import { noise2 as coreNoise2 } from '../core/poly';

/**
 * Spatial helpers shared by the world builders. v2: every height / distance query delegates to
 * `layout.heightAt` / `layout.terrain.*` (core owns the terrain); world only adds its own blockers.
 */
export interface Env {
  layout: Layout;
  coastPts: THREE.Vector3[];
  highPts: THREE.Vector3[];
  shedPts: THREE.Vector3[];
  /** distance (xz) to the nearest track centreline (coast, highland, shed siding, shed road) */
  trackDist(x: number, z: number): number;
  /** v1 "feature distance" (tracks, main road, station area, shed yard) — terrain is flat within 14 m */
  featureDist(x: number, z: number): number;
  /** true if (x,z) lies within margin of any occupied rect (station structures, buildings, world blockers) */
  blocked(x: number, z: number, margin?: number): boolean;
  /** extra occupied rects (world builder additions) */
  addBlocker(r: Rect): void;
  /** distance from the nearest road EDGE (negative on the carriageway) */
  roadDist(x: number, z: number): number;
  riverDist(x: number, z: number): number;
  heightAt(x: number, z: number): number;
  /** clear of tracks, roads, river, buildings, station (layout.terrain.clear) and world blockers */
  clear(x: number, z: number, margin?: number): boolean;
}

function inRect(x: number, z: number, r: Rect, margin: number): boolean {
  const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
  const dx = x - r.center.x, dz = z - r.center.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= r.size.x / 2 + margin && Math.abs(lz) <= r.size.z / 2 + margin;
}

function sample(c: THREE.Curve<THREE.Vector3>, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) out.push(c.getPointAt(i / n));
  return out;
}

export function noise2(x: number, z: number): number { return coreNoise2(x, z); }

export function createEnv(layout: Layout): Env {
  const T = layout.terrain;
  const coastPts = sample(layout.lines.coast.curve, 120);
  const highPts = sample(layout.lines.highland.curve, 142);
  const shedPts = sample(layout.shed.curve, 40);
  const P1 = layout.platforms[1], P2 = layout.platforms[2];
  const rects: Rect[] = [
    { center: P1.center, size: new THREE.Vector3(P1.length + 12, 1, P1.width), yaw: P1.yaw },
    { center: P2.center, size: new THREE.Vector3(P2.length + 12, 1, P2.width), yaw: P2.yaw },
    { center: layout.station.center, size: layout.station.size, yaw: layout.station.yaw },
    { center: layout.forecourt.center, size: layout.forecourt.size, yaw: layout.forecourt.yaw },
    layout.shed.building,
    { center: layout.signalBox.center, size: new THREE.Vector3(10, 1, 7), yaw: 0 },
  ];
  const blocked = (x: number, z: number, margin = 0) => rects.some((r) => inRect(x, z, r, margin)) || !!T.buildingAt(x, z, margin);
  return {
    layout, coastPts, highPts, shedPts,
    trackDist: (x, z) => T.trackDist(x, z),
    roadDist: (x, z) => T.roadDist(x, z),
    riverDist: (x, z) => T.riverDist(x, z),
    featureDist: (x, z) => T.featureDist(x, z),
    heightAt: (x, z) => layout.heightAt(x, z),
    blocked,
    addBlocker(r) { rects.push(r); },
    clear(x, z, margin = 0) { return T.clear(x, z, margin) && !rects.some((r) => inRect(x, z, r, margin)); },
  };
}
