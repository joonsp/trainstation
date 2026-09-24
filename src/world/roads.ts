import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import type { Batch } from './batch';
import { V } from './kit';
import { stripGeometry, pieces } from './ribbon';
import { groundColor } from './terrain';
import type { RoadEdge } from '../core/countryside';

/**
 * ROADS & PATHS: ribbons from layout.roads.edges[*].poly (road-surface y baked by core: humpback, cutting, ford,
 * crossing planking). Main road metalled, lanes gravel, tracks worn earth, Ashcombe High Street and the mews in
 * setts with raised flagged footways and kerbs. Worn verges blend into the ground. LC1 planking + gate posts,
 * footpaths, the anglers' steps and fingerposts at the junctions.
 */
export function buildRoads(ctx: Ctx, wm: WorldMats, batch: Batch): void {
  const L = ctx.layout;
  const T = L.terrain;
  const m = ctx.mats;
  const H = (x: number, z: number) => L.heightAt(x, z);
  const edges = L.roads.edges;
  const gc = new THREE.Color(), worn = new THREE.Color(0x7e7458);
  const LC = L.crossings[0];

  /** runs of consecutive samples where `keep` holds */
  const runs = (pts: THREE.Vector3[], keep: (p: THREE.Vector3, i: number) => boolean) => {
    const out: THREE.Vector3[][] = [];
    let cur: THREE.Vector3[] = [];
    pts.forEach((p, i) => { if (keep(p, i)) cur.push(p); else { if (cur.length > 1) out.push(cur); cur = []; } });
    if (cur.length > 1) out.push(cur);
    return out;
  };
  // Ashcombe High Street (setts + footways) on K
  const HS0 = 106, HS1 = 228;
  const order: Record<string, number> = { K: 0.075, MW: 0.07, W: 0.062, M: 0.06, S: 0.058, D: 0.056, F: 0.052, N: 0.05 };

  for (const e of Object.values(edges) as RoadEdge[]) {
    if (e.id === 'FC') continue; // the forecourt loop runs on the paved forecourt
    const off = order[e.id] ?? 0.05;
    const hw = e.width / 2;
    const surfMat = e.kind === 'main' ? wm.road : e.kind === 'track' ? wm.earth : e.kind === 'drive' ? wm.street : wm.lane;
    const cum = e.poly.cum;
    // skip where a level crossing's planking takes over (road near the rail head height, right over a track)
    const keep = (p: THREE.Vector3) => !(T.trackDist(p.x, p.z) < 2.6 && Math.abs(p.y - 0.35) < 1.2);
    for (const run of runs(e.poly.pts, keep)) {
      for (const ps of pieces(run, 40)) {
        // split the high street out of K so it gets setts
        const segs: { pts: THREE.Vector3[]; mat: THREE.Material; town: boolean }[] = [];
        if (e.id === 'K') {
          let cur: THREE.Vector3[] = [], curTown: boolean | null = null;
          for (const p of ps) {
            const s = e.poly.nearest(p.x, p.z).s;
            const town = s > HS0 && s < HS1;
            if (curTown !== null && town !== curTown) { cur.push(p); segs.push({ pts: cur, mat: curTown ? wm.street : surfMat, town: curTown }); cur = [p]; }
            else cur.push(p);
            curTown = town;
          }
          if (cur.length > 1) segs.push({ pts: cur, mat: curTown ? wm.street : surfMat, town: !!curTown });
        } else segs.push({ pts: ps, mat: surfMat, town: e.id === 'MW' });
        for (const sg of segs) {
          if (sg.pts.length < 2) continue;
          // carriageway (slight camber)
          batch.add(sg.mat, stripGeometry(sg.pts, [-hw, -hw * 0.5, 0, hw * 0.5, hw], (_x, _z, cy, lat) => cy + off + 0.035 * (1 - (Math.abs(lat) / hw) ** 2)));
          if (sg.town) {
            // raised flagged footways with kerbs on both sides
            for (const sd of [-1, 1]) {
              batch.add(m.stone, stripGeometry(sg.pts, sd < 0 ? [-hw - 2.2, -hw] : [hw, hw + 2.2], (_x, _z, cy) => cy + off + 0.16));
              const kerb = sg.pts.map((p) => p);
              batch.add(m.cream, stripGeometry(kerb, sd < 0 ? [-hw - 0.12, -hw + 0.02] : [hw - 0.02, hw + 0.12], (_x, _z, cy) => cy + off + 0.18));
            }
          } else {
            // worn verges (vertex coloured, blend to the ground)
            for (const sd of [-1, 1]) {
              const lats = sd < 0 ? [-hw - 1.8, -hw - 0.6, -hw + 0.15] : [hw - 0.15, hw + 0.6, hw + 1.8];
              const g = stripGeometry(sg.pts, lats, (x, z, cy, lat) => {
                const outer = Math.abs(lat) > hw + 1.0;
                const gy = H(x, z);
                if (Math.abs(gy - cy) > 0.7) return cy + off - (outer ? 0.08 : 0.02);
                return outer ? gy + 0.02 : THREE.MathUtils.lerp(cy + off - 0.01, gy + 0.03, 0.5);
              }, (x, z, _y, lat, _r, out) => {
                groundColor(L, x, z, gc);
                const k = Math.abs(lat) > hw + 1.0 ? 0.05 : Math.abs(lat) > hw + 0.3 ? 0.55 : 0.8;
                out.copy(gc).lerp(worn, k);
              });
              batch.add(wm.bank, g);
            }
          }
        }
      }
    }
    void cum;
  }
  // kerbed pavement along K from the forecourt gate to Wyke Lane junction
  {
    const K = edges.K;
    const ps = K.poly.slice(1, 33, 2);
    for (const sd of [-1, 1]) {
      batch.add(m.stone, stripGeometry(ps, sd < 0 ? [-K.width / 2 - 2.0, -K.width / 2] : [K.width / 2, K.width / 2 + 2.0], (_x, _z, cy) => cy + 0.2));
      batch.add(m.cream, stripGeometry(ps, sd < 0 ? [-K.width / 2 - 0.12, -K.width / 2 + 0.02] : [K.width / 2 - 0.02, K.width / 2 + 0.12], (_x, _z, cy) => cy + 0.22));
    }
  }

  // ───────────── level crossing LC1: planking flush with the rail head, fixed gate posts, railway fencing ─────────────
  if (LC) {
    const c = LC.center;
    const rd = LC.roadDir.clone().normalize();
    const yaw = Math.atan2(-rd.z, rd.x); // local +x along the road, local z along the track
    const e = edges[LC.road];
    const W = e.width + 1.4;
    batch.push(c.x, 0, c.z, yaw);
    // planks between and outside the rails (rails at ±0.7175 across the track = local z)
    const G = 0.7175;
    for (const [z0, z1] of [[-2.4, -G - 0.08], [-G + 0.08, G - 0.08], [G + 0.08, 2.4]]) batch.box(m.wood, W, 0.08, z1 - z0, 0, 0.31, (z0 + z1) / 2);
    batch.detail = true;
    for (let i = -Math.floor(W / 2 / 0.6); i <= Math.floor(W / 2 / 0.6); i++) batch.box(m.sleeper, 0.04, 0.085, 4.8, i * 0.6, 0.312, 0);
    batch.detail = false;
    // approach ramps from the road up to the planking
    for (const sd of [-1, 1]) batch.add(wm.lane, new THREE.BoxGeometry(W, 0.1, 2.2), batch.mat(0, 0.2, sd * 3.4, 0, sd * 0.1, 0));
    batch.pop();
    // fixed white gate posts at the hinges (traffic swings the leaves) + the closing posts across the track
    batch.cast = true;
    for (const g of LC.gates) {
      const h = g.hinge;
      batch.boxB(wm.white, 0.3, 1.9, 0.3, h.x, H(h.x, h.z), h.z);
      batch.add(m.iron, new THREE.ConeGeometry(0.25, 0.35, 4), batch.mat(h.x, H(h.x, h.z) + 2.07, h.z, Math.PI / 4));
      const stop = h.clone().addScaledVector(g.closedRailDir, g.length);
      batch.boxB(wm.white, 0.2, 1.3, 0.2, stop.x, H(stop.x, stop.z), stop.z);
    }
    batch.cast = false;
    // railway fencing either side of the crossing along the line (keeps cattle off the track)
    const C = L.lines.coast;
    batch.detail = true;
    for (const lat of [-3.6, 3.6]) for (const sgn of [-1, 1]) {
      let prev: THREE.Vector3 | null = null;
      for (let d = 5.5; d <= 20; d += 2.5) {
        const t = LC.t + (sgn * d) / C.length;
        const p = C.offsetPoint(t, lat, 0);
        p.y = H(p.x, p.z);
        batch.boxB(m.wood, 0.14, 1.2, 0.14, p.x, p.y, p.z);
        if (prev) {
          batch.beam(wm.white, 0.06, 0.1, V(prev.x, prev.y + 1.0, prev.z), V(p.x, p.y + 1.0, p.z));
          batch.beam(wm.white, 0.06, 0.1, V(prev.x, prev.y + 0.55, prev.z), V(p.x, p.y + 0.55, p.z));
        }
        prev = p;
      }
    }
    batch.detail = false;
  }

  // ───────────── footpaths, anglers' steps ─────────────
  for (const p of L.paths) {
    if (p.kind === 'towpath') continue;
    if (p.kind === 'steps') {
      const pts = p.poly.pts;
      const n = Math.max(2, Math.round(p.poly.length / 0.45));
      for (let i = 0; i < n; i++) {
        const s = (p.poly.length * (i + 0.5)) / n;
        const q = p.poly.at(s);
        const yaw = p.poly.yawAt(s);
        batch.push(q.x, 0, q.z, yaw);
        batch.boxB(m.stone, 0.5, Math.max(0.2, q.y - Math.min(pts[0].y, pts[pts.length - 1].y) + 0.25), 1.6, 0, Math.min(pts[0].y, pts[pts.length - 1].y) - 0.25, 0);
        batch.pop();
      }
      continue;
    }
    for (const ps of pieces(p.poly.pts, 40)) {
      batch.add(wm.earth, stripGeometry(ps, [-0.7, 0, 0.7], (x, z, cy) => Math.max(cy, H(x, z)) + 0.035));
    }
  }

  // ───────────── fingerposts at the main junctions ─────────────
  batch.cast = false;
  const posts: [string, string[]][] = [['jW', ['Wyke St Mary', 'Station']], ['jM', ['Millbridge', 'Ashcombe']], ['jMB', ['Hollowford', 'Coldharbour']], ['jN', ['Glenmoor', 'Wyke']], ['jD', ['Eastcote', 'Millbridge']]];
  for (const [id] of posts) {
    const n = L.roads.nodes[id];
    if (!n) continue;
    // stand it on the verge: nearest road edge + 1.5 m out
    const nr = L.nearestRoad(n.pos);
    const e = edges[nr.edge];
    const side = nr.lat >= 0 ? 1 : -1;
    const p = e.poly.offset(nr.s, side * (e.width / 2 + 1.8));
    const y = H(p.x, p.z);
    const yaw = e.poly.yawAt(nr.s);
    batch.push(p.x, y, p.z, yaw);
    batch.boxB(wm.white, 0.14, 2.6, 0.14, 0, 0, 0);
    batch.add(wm.white, new THREE.BoxGeometry(1.1, 0.22, 0.05), batch.mat(0.45, 2.3, 0, 0.3));
    batch.add(wm.white, new THREE.BoxGeometry(1.1, 0.22, 0.05), batch.mat(-0.45, 2.0, 0, -0.5));
    batch.add(m.iron, new THREE.SphereGeometry(0.1, 6, 4), batch.mat(0, 2.68, 0));
    batch.pop();
  }
}
