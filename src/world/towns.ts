import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import type { Batch } from './batch';
import { Kit, V } from './kit';
import type { Building, Town } from '../core/countryside';
import type { Rng } from '../core/rng';
import { worldToLocal } from '../core/poly';
import { applyWind } from '../core/wind';
import type { ClockSpot } from './clocks';

const DOOR_COLS = [0x2f5d3a, 0x7a2230, 0x1f2a3a, 0x231f1c, 0x4a3b32, 0x3a4f5a, 0x5a2a3a];
const FASCIA = [0x1f3b2a, 0x5a1a24, 0x1f2a3a, 0x3a2a1a];

export interface TownsBuild {
  /** smithy forges (glow + light claims while working) */
  forges: { pos: THREE.Vector3; building: string }[];
  /** church clock faces (hands instanced by clocks.ts) */
  clocks: ClockSpot[];
  washing: { building: string; mesh: THREE.InstancedMesh; first: number; count: number }[];
  washMesh: THREE.InstancedMesh | null;
  windmill: { body: THREE.Object3D; sails: THREE.Object3D; canvas: THREE.Object3D } | null;
  /** weather-vane pivots on spires */
  vanes: THREE.Vector3[];
  /** door leaves for WorldAPI.openDoor (origin id → hinge in world space, facing yaw, size, colour) */
  doors: Map<string, DoorSpot>;
  /** police lamp etc. (small emissive fixtures that follow night) */
  update(dt: number, night: number): void;
}

export interface DoorSpot { hinge: THREE.Vector3; yaw: number; w: number; h: number; color: number }

export function buildTowns(ctx: Ctx, wm: WorldMats, root: THREE.Object3D, batch: Batch, rng: Rng): TownsBuild {
  const L = ctx.layout;
  const m = ctx.mats;
  const H = (x: number, z: number) => L.heightAt(x, z);
  const forges: TownsBuild['forges'] = [];
  const clothPos: number[] = [], clothCol: number[] = [], clothW: number[] = [];
  const washSpots: { building: string; a: THREE.Vector3; b: THREE.Vector3 }[] = [];
  const brng = rng.fork(0xb1d);
  const doorSpots = new Map<string, DoorSpot>();

  const wallMat = (b: Building): THREE.Material =>
    b.walls === 'brick' ? m.brick : b.walls === 'brickDark' ? m.brickDark : b.walls === 'stone' ? m.stone : b.walls === 'whitewash' ? wm.whitewash : wm.boards;
  const roofMat = (b: Building): THREE.Material => (b.roof === 'slate' ? m.slate : b.roof === 'tile' ? wm.roofTile : wm.thatch);

  // ── cloth (pub signs, flags) collected into one wind-animated mesh ──
  const clothQuad = (a: THREE.Vector3, right: THREE.Vector3, down: THREE.Vector3, col: number, wTop = 0, wBot = 1, wRight = -1) => {
    // quad corners: a (top-left), a+right, a+down, a+right+down; aWind by row (or by column for flags)
    const c = new THREE.Color(col);
    const P = [a, a.clone().add(right), a.clone().add(down), a.clone().add(right).add(down)];
    const Wt = wRight >= 0 ? [0, wRight, 0, wRight] : [wTop, wTop, wBot, wBot];
    for (const [i0, i1, i2] of [[0, 2, 1], [1, 2, 3]]) {
      for (const i of [i0, i1, i2]) { clothPos.push(P[i].x, P[i].y, P[i].z); clothCol.push(c.r, c.g, c.b); clothW.push(Wt[i]); }
    }
  };

  /** two pitched slabs + wall-coloured gable triangles; ridge along local x */
  const pitchedRoof = (k: Kit, rmat: THREE.Material, wmat: THREE.Material, sx: number, sz: number, h: number, y: number, over = 0.35, thick = 0.2) => {
    const half = sz / 2;
    const pitch = Math.atan2(h, half);
    const slope = Math.hypot(h, half) + over;
    for (const sd of [-1, 1]) {
      // slab from the ridge down past the eave by `over`; its centre sits over/2 further down the slope
      const cz = sd * (half / 2 + (over / 2) * Math.cos(pitch)), cy = y + h / 2 - (over / 2) * Math.sin(pitch);
      k.add(rmat, new THREE.BoxGeometry(sx + 2 * over, thick, slope), k.mat(0, cy + (thick / 2) * Math.cos(pitch), cz + sd * (thick / 2) * Math.sin(pitch), 0, sd * pitch, 0));
    }
    // gable walls
    k.gable(wmat, sx - 0.02, sz - 0.02, h - 0.05, 0, y, 0);
    // ridge tiles
    k.box(rmat, sx + 2 * over, 0.18, 0.3, 0, y + h + 0.08, 0);
  };

  const windowAt = (k: Kit, lit: boolean, x: number, y: number, z: number, ry: number, w = 0.9, h = 1.2, sill: THREE.Material = m.cream) => {
    k.push(x, y, z, ry);
    k.box(sill, w + 0.25, h + 0.22, 0.08, 0, h / 2, 0.02);
    k.quad(lit ? m.windowLit : wm.dark, w, h, 0, h / 2, 0.08);
    k.box(wm.white, 0.06, h, 0.04, 0, h / 2, 0.1);
    k.box(sill, w + 0.35, 0.1, 0.22, 0, -0.03, 0.1);
    k.pop();
  };

  const buildOne = (b: Building) => {
    const k = batch;
    const sx = b.size.x, sz = b.size.z, eaves = b.size.y;
    const wmat = wallMat(b), rmat = roofMat(b);
    const lit = b.lit;
    const doorsLx = b.doors.map((d) => worldToLocal(b.center, b.yaw, d.x, d.z)[0]);
    // foundation depth: lowest ground under the footprint corners
    let minG = b.center.y;
    for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const lx = (cx * sx) / 2, lz = (cz * sz) / 2;
      minG = Math.min(minG, H(b.center.x + lx * c + lz * s, b.center.z - lx * s + lz * c));
    }
    const foot = minG - b.center.y - 0.3;
    k.cast = true;
    k.push(b.center.x, b.center.y, b.center.z, b.yaw);
    const kind = b.kind;
    const doorCol = DOOR_COLS[Math.floor(brng.next() * DOOR_COLS.length)];

    if (kind === 'church' || kind === 'chapel') {
      buildChurch(k, b, wmat, rmat, foot);
      k.pop();
      return;
    }
    // plinth + walls
    if (foot < -0.05) k.boxB(m.stone, sx + 0.2, -foot + 0.35, sz + 0.2, 0, foot, 0);
    else k.boxB(m.stone, sx + 0.2, 0.35, sz + 0.2, 0, -0.05, 0);
    const open = kind === 'smithy';
    if (open) {
      // open-fronted forge: back + side walls, the front has a big dark opening
      k.boxB(wmat, sx, eaves, 0.5, 0, 0, -sz / 2 + 0.25);
      for (const s of [-1, 1]) k.boxB(wmat, 0.5, eaves, sz, s * (sx / 2 - 0.25), 0, 0);
      k.boxB(wmat, sx, eaves - 2.9, 0.5, 0, 2.9, sz / 2 - 0.25);
      k.boxB(wmat, 1.3, 2.9, 0.5, -sx / 2 + 0.65, 0, sz / 2 - 0.25);
      k.boxB(wm.dark, sx - 1, 0.05, sz - 1, 0, 0.02, 0);
      k.boxB(m.wood, sx - 1.2, 0.3, 0.3, 0.3, 2.75, sz / 2 - 0.2); // lintel beam
      // hearth + forge glow + hood + anvil
      k.boxB(m.brickDark, 2.2, 1.0, 1.6, -sx / 2 + 1.8, 0, -sz / 2 + 1.3);
      k.boxB(wm.forge, 1.4, 0.18, 0.9, -sx / 2 + 1.8, 1.0, -sz / 2 + 1.3);
      k.add(m.brickDark, new THREE.CylinderGeometry(0.35, 1.2, 1.4, 4), k.mat(-sx / 2 + 1.8, 2.3, -sz / 2 + 1.3, Math.PI / 4));
      k.boxB(m.iron, 0.8, 0.3, 0.35, 0.8, 0.55, 0.4);
      k.boxB(m.iron, 0.3, 0.55, 0.3, 0.8, 0, 0.4);
      k.cyl(m.wood, 0.35, 0.35, 0.8, 8, 1.8, 0, 1.3); // quench tub
      // horseshoe over the door
      k.add(m.iron, new THREE.TorusGeometry(0.22, 0.05, 4, 8, Math.PI * 1.4), k.mat(0.3, 3.2, sz / 2 + 0.02, 0, 0, Math.PI * 0.8));
      const fp = new THREE.Vector3(-sx / 2 + 1.8, 1.4, -sz / 2 + 1.3);
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      forges.push({ pos: V(b.center.x + fp.x * c + fp.z * s, b.center.y + fp.y, b.center.z - fp.x * s + fp.z * c), building: b.id });
    } else {
      k.boxB(wmat, sx, eaves, sz, 0, 0, 0);
    }
    // half-timbering on some whitewashed buildings
    if (b.walls === 'whitewash' && (kind === 'pub' || brng.chance(0.35))) {
      for (const fz of [-1, 1]) {
        const zf = fz * (sz / 2 + 0.03), ry = fz > 0 ? 0 : Math.PI;
        k.push(0, 0, zf, ry);
        k.box(wm.beams, sx, 0.22, 0.06, 0, eaves - 0.12, 0);
        k.box(wm.beams, sx, 0.2, 0.06, 0, eaves * 0.5, 0);
        k.box(wm.beams, sx, 0.2, 0.06, 0, 0.4, 0);
        for (let x = -sx / 2 + 0.1; x <= sx / 2; x += Math.max(1.6, sx / Math.round(sx / 1.8))) k.box(wm.beams, 0.2, eaves - 0.3, 0.06, x, eaves / 2 + 0.1, 0);
        k.pop();
      }
    }
    // cream quoins on brick buildings (pubs, inns, houses, post office)
    if ((b.walls === 'brick' || b.walls === 'brickDark') && ['pub', 'inn', 'house', 'post', 'police', 'school', 'office'].includes(kind)) {
      for (const qx of [-1, 1]) for (const qz of [-1, 1]) {
        for (let y = 0.3, i = 0; y < eaves - 0.4; y += 0.55, i++) {
          const a = i % 2 ? 0.45 : 0.75;
          k.boxB(m.cream, a, 0.42, 0.08, qx * (sx / 2 - a / 2 + 0.02), y, qz * (sz / 2 + 0.03));
        }
      }
      k.boxB(m.cream, sx + 0.1, 0.18, sz + 0.1, 0, eaves - 0.2, 0); // eaves band
    }

    // ── roof ──
    const roofH = b.roofH;
    if (b.roof === 'thatch') {
      k.hip(wm.thatch, sx + 1.1, sz + 1.2, roofH + 0.6, 0, eaves - 0.35, 0);
      k.box(wm.thatch, Math.max(0.5, sx - sz + 0.6), 0.35, 0.7, 0, eaves - 0.35 + roofH + 0.5, 0); // ridge roll
    } else if (kind === 'house' || kind === 'inn' || kind === 'police' || kind === 'lodge') {
      k.hip(rmat, sx + 0.8, sz + 0.8, roofH, 0, eaves, 0);
    } else if (kind === 'barn' || kind === 'stable' || kind === 'mews' || kind === 'dairy') {
      pitchedRoof(k, rmat, wmat, sx, sz, roofH, eaves, 0.45, 0.22);
    } else {
      pitchedRoof(k, rmat, wmat, sx, sz, roofH, eaves, 0.35, 0.2);
    }

    // ── chimneys (stacks rising through the roof to the pot tops) ──
    for (const cp of b.chimneys) {
      const [lx, lz] = worldToLocal(b.center, b.yaw, cp.x, cp.z);
      const topY = cp.y - b.center.y;
      const base = eaves + 0.2;
      k.boxB(m.brickDark, 0.85, topY - 0.45 - base, 1.0, lx, base, lz);
      k.boxB(m.cream, 1.0, 0.16, 1.15, lx, topY - 0.55, lz);
      k.cyl(wm.roofTile, 0.14, 0.18, 0.5, 6, lx - 0.18, topY - 0.45, lz);
      k.cyl(wm.roofTile, 0.14, 0.18, 0.45, 6, lx + 0.2, topY - 0.45, lz);
    }

    // ── windows + doors ──
    const floors = eaves > 5.2 ? [1.0, eaves * 0.5 + 0.6] : eaves > 3.8 ? [1.0] : [0.9];
    const winW = kind === 'barn' ? 0 : kind === 'school' ? 1.1 : 0.9;
    const winH = kind === 'school' ? 2.0 : 1.2;
    const litWin = lit && kind !== 'barn' && kind !== 'stable';
    if (winW > 0) {
      for (const fz of [1, -1]) {
        const zf = fz * (sz / 2 + 0.02), ry = fz > 0 ? 0 : Math.PI;
        const n = Math.max(1, Math.round(sx / 2.8));
        for (let i = 0; i < n; i++) {
          const x = -sx / 2 + (sx * (i + 0.5)) / n;
          floors.forEach((fy, fi) => {
            if (fz > 0 && fi === 0 && doorsLx.some((d) => Math.abs(d - x) < 1.1)) return;
            if (open && fz > 0 && fi === 0) return;
            windowAt(k, litWin, x, fy, zf, ry, winW, winH);
          });
        }
      }
      // a small gable window
      if (eaves > 4 && b.roof !== 'thatch') for (const fx of [-1, 1]) windowAt(k, litWin, fx * (sx / 2 + 0.02), eaves + 0.3, 0, fx * Math.PI / 2, 0.6, 0.8);
    }
    // shop fronts
    if (kind === 'post' || kind === 'bakery' || kind === 'shop') {
      const fasc = FASCIA[Math.floor(brng.next() * FASCIA.length)];
      k.addC(wm.paint, fasc, new THREE.BoxGeometry(sx - 0.4, 0.6, 0.12), k.mat(0, 3.2, sz / 2 + 0.1));
      for (const sd of [-1, 1]) {
        const x = sd * sx * 0.25;
        if (doorsLx.some((d) => Math.abs(d - x) < 1.3)) continue;
        k.addC(wm.paint, fasc, new THREE.BoxGeometry(2.3, 2.1, 0.1), k.mat(x, 1.55, sz / 2 + 0.05));
        k.quad(litWin ? m.windowLit : wm.dark, 2.0, 1.7, x, 1.6, sz / 2 + 0.11);
        k.box(m.cream, 2.4, 0.12, 0.3, x, 0.5, sz / 2 + 0.12);
      }
      // striped canvas awning over the shop window (cloth: stirs in the wind)
      {
        const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
        const W = (lx: number, y: number, lz: number) => V(b.center.x + lx * c + lz * s, b.center.y + y, b.center.z - lx * s + lz * c);
        const aw = sx - 0.8, n = Math.max(3, Math.round(aw / 0.8));
        const col = kind === 'bakery' ? 0xc8b88a : 0x5a2a3a;
        const down = W(0, 2.68, sz / 2 + 1.26).sub(W(0, 3.12, sz / 2 + 0.04));
        for (let i = 0; i < n; i++) {
          const a = W(-aw / 2 + (aw * i) / n, 3.12, sz / 2 + 0.04), r = W(-aw / 2 + (aw * (i + 1)) / n, 3.12, sz / 2 + 0.04).sub(a);
          clothQuad(a, r, down, i % 2 ? 0xe8dcc0 : col, 0, 0.3);
        }
      }
    }
    // doors
    doorsLx.forEach((dx, di) => {
      const wide = kind === 'barn' || kind === 'engineHouse' || kind === 'mews' || kind === 'dairy' || (kind === 'stable');
      const dw = wide ? (kind === 'mews' && di === 0 ? 1.1 : 3.0) : 1.05, dh = wide ? 3.0 : 2.15;
      const col = kind === 'engineHouse' ? 0x9a2c24 : kind === 'barn' ? 0x3b332c : doorCol;
      k.addC(wm.paint, col, new THREE.BoxGeometry(dw, dh, 0.1), k.mat(dx, dh / 2 + 0.02, sz / 2 + 0.04));
      {
        const c = Math.cos(b.yaw), s = Math.sin(b.yaw), hx = dx - dw / 2, hz = sz / 2 + 0.13;
        doorSpots.set(`door:${b.id}:${di}`, { hinge: V(b.center.x + hx * c + hz * s, b.center.y + 0.02, b.center.z - hx * s + hz * c), yaw: b.yaw, w: dw, h: dh, color: col });
      }
      if (!wide) {
        k.box(m.cream, dw + 0.3, 0.14, 0.14, dx, dh + 0.1, sz / 2 + 0.08);
        k.quad(litWin ? m.windowLit : wm.dark, dw - 0.2, 0.35, dx, dh - 0.3, sz / 2 + 0.1); // fanlight
        k.boxB(m.stone, dw + 0.5, 0.18, 0.6, dx, -0.1, sz / 2 + 0.3); // step
        k.add(m.brass, new THREE.SphereGeometry(0.05, 4, 3), k.mat(dx + dw * 0.32, 1.05, sz / 2 + 0.12));
      } else {
        k.box(wm.beams, 0.08, dh, 0.14, dx, dh / 2, sz / 2 + 0.1);
        k.box(wm.beams, dw, 0.1, 0.14, dx, dh * 0.5, sz / 2 + 0.1);
      }
    });
    // extra doors along the stable/mews front (the data carries the main ones)
    if (kind === 'stable' || kind === 'mews') {
      for (let x = -sx / 2 + 1.6; x < sx / 2 - 1; x += 3.2) {
        if (doorsLx.some((d) => Math.abs(d - x) < 1.8)) continue;
        k.addC(wm.paint, 0x2f5d3a, new THREE.BoxGeometry(1.2, 1.1, 0.1), k.mat(x, 0.6, sz / 2 + 0.04));
        k.addC(wm.paint, 0x2f5d3a, new THREE.BoxGeometry(1.2, 1.0, 0.1), k.mat(x, 1.8, sz / 2 + 0.02, 0, -0.3, 0)); // upper half open
        k.quad(wm.dark, 1.1, 0.9, x, 1.75, sz / 2 + 0.01);
      }
    }

    // ── per-kind extras ──
    if (kind === 'pub' || kind === 'inn') {
      // bracket + swinging sign (cloth mesh) + a lantern over the door
      const dx = doorsLx[0] ?? 0;
      const bx = dx + (dx > 0 ? -2.2 : 2.2);
      k.box(m.iron, 0.08, 0.08, 1.4, bx, eaves - 1.0, sz / 2 + 0.7);
      k.box(m.iron, 0.06, 0.8, 0.06, bx, eaves - 1.4, sz / 2 + 0.05);
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const W = (lx: number, y: number, lz: number) => V(b.center.x + lx * c + lz * s, b.center.y + y, b.center.z - lx * s + lz * c);
      const top = W(bx, eaves - 1.08, sz / 2 + 0.25), right = W(bx, eaves - 1.08, sz / 2 + 1.25).sub(top), down = new THREE.Vector3(0, -1.0, 0);
      const signCol = kind === 'inn' ? 0x5a1a24 : b.id.includes('plough') ? 0x2f5d3a : b.id.includes('miller') ? 0x3a4f5a : 0x1f3b2a;
      clothQuad(top, right, down, signCol, 0, 0.6);
      clothQuad(top.clone().add(new THREE.Vector3(0, -0.12, 0)).addScaledVector(right, 0.12), right.clone().multiplyScalar(0.76), new THREE.Vector3(0, -0.6, 0), 0xc9a24a, 0.05, 0.5);
      k.add(wm.lantern, new THREE.CylinderGeometry(0.2, 0.14, 0.4, 4), k.mat(dx, 2.75, sz / 2 + 0.45, Math.PI / 4));
      k.box(m.iron, 0.05, 0.05, 0.45, dx, 3.0, sz / 2 + 0.25);
      // benches out front
      k.boxB(m.wood, 1.8, 0.45, 0.45, dx + (dx > 0 ? 2.8 : -2.8), 0, sz / 2 + 0.8);
      if (kind === 'inn') {
        // carriage arch into the yard at one end (Crown Mews behind)
        k.boxB(wm.dark, 3.0, 3.4, 0.2, sx / 2 - 2.0, 0, sz / 2 + 0.02);
        k.archSlab(m.cream, 3.4, 3.8, 0.2, sx / 2 - 2.0, 0, sz / 2 + 0.05);
      }
    } else if (kind === 'post') {
      const dx = doorsLx[0] ?? 0;
      k.cyl(wm.signalRed, 0.28, 0.3, 1.35, 10, dx + 1.6, 0, sz / 2 + 0.9);
      k.add(wm.signalRed, new THREE.SphereGeometry(0.32, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), k.mat(dx + 1.6, 1.35, sz / 2 + 0.9));
      k.box(wm.dark, 0.3, 0.04, 0.05, dx + 1.6, 1.05, sz / 2 + 0.9 + 0.29);
    } else if (kind === 'police') {
      const dx = doorsLx[0] ?? 0;
      k.box(m.iron, 0.05, 0.05, 0.5, dx, 2.95, sz / 2 + 0.25);
      k.add(policeLamp, new THREE.BoxGeometry(0.3, 0.35, 0.3), k.mat(dx, 2.75, sz / 2 + 0.5));
    } else if (kind === 'school') {
      // bell-cote on the ridge
      k.boxB(m.cream, 0.9, 1.2, 0.9, 0, eaves + roofH - 0.2, 0);
      k.pyramid(m.slate, 1.3, 1.0, 0, eaves + roofH + 1.0, 0);
      k.add(m.brass, new THREE.CylinderGeometry(0.12, 0.25, 0.4, 8), k.mat(0, eaves + roofH + 0.35, 0));
    } else if (kind === 'mill') {
      // lucam (hoist housing) jutting from the front gable + sack door
      k.boxB(wm.boards, 2.0, 2.4, 1.6, 0, eaves - 1.2, sz / 2 + 0.8);
      k.gable(m.slate, 2.2, 1.9, 0.9, 0, eaves + 1.2, sz / 2 + 0.8, Math.PI / 2);
      for (const y of [2.0, 4.6]) k.addC(wm.paint, 0x3b332c, new THREE.BoxGeometry(1.2, 1.6, 0.1), k.mat(0, y, sz / 2 + 0.06));
    } else if (kind === 'boathouse') {
      // open boat doors on the water side (−z) + a balcony rail
      k.boxB(wm.dark, sx - 2.0, eaves - 0.8, 0.1, 0, 0, -sz / 2 - 0.02);
      k.box(wm.white, sx, 0.1, 0.1, 0, eaves - 0.2, -sz / 2 - 0.5);
      for (let x = -sx / 2; x <= sx / 2; x += 1.2) k.box(wm.white, 0.06, 0.7, 0.06, x, eaves - 0.55, -sz / 2 - 0.5);
      k.addC(wm.paint, 0x7a2230, new THREE.BoxGeometry(3.4, 0.5, 0.08), k.mat(0, eaves + 0.5, sz / 2 + 0.1)); // club board
    } else if (kind === 'hut') {
      k.cyl(m.iron, 0.1, 0.1, 1.4, 6, sx / 2 - 0.7, eaves + 0.6, 0);
    } else if (kind === 'office') {
      k.addC(wm.paint, 0x1f2e27, new THREE.BoxGeometry(sx - 0.6, 0.55, 0.1), k.mat(0, eaves - 0.55, sz / 2 + 0.06));
    } else if (kind === 'farmhouse' || kind === 'cottage' || kind === 'terrace' || kind === 'lodge') {
      // porch hood over the main door on some
      const dx = doorsLx[0] ?? 0;
      if (brng.chance(0.5)) {
        k.box(rmat === wm.thatch ? wm.thatch : rmat, 1.7, 0.12, 0.9, dx, 2.55, sz / 2 + 0.45, 0, -0.25, 0);
        for (const s of [-0.7, 0.7]) k.box(m.wood, 0.1, 0.1, 0.8, dx + s, 2.4, sz / 2 + 0.4, 0, 0.5, 0);
      }
      // window boxes / climbing rose
      if (brng.chance(0.4)) {
        k.detail = true;
        k.addC(wm.paint, 0x7a3a3a, new THREE.IcosahedronGeometry(0.5, 0), k.mat(-sx / 2 + 0.6, 1.8, sz / 2 + 0.2, 0.3));
        k.addC(wm.paint, 0x4f6e38, new THREE.IcosahedronGeometry(0.7, 0), k.mat(-sx / 2 + 0.5, 0.9, sz / 2 + 0.25));
        k.detail = false;
      }
    }
    k.pop();

    // washing-line spot behind homes with residents
    if ((kind === 'cottage' || kind === 'terrace' || kind === 'farmhouse' || kind === 'lodge') && b.residents > 0) {
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const lz = -(sz / 2 + 3.2);
      const A = V(b.center.x + (-sx * 0.35) * c + lz * s, 0, b.center.z - (-sx * 0.35) * s + lz * c);
      const B = V(b.center.x + (sx * 0.35) * c + lz * s, 0, b.center.z - (sx * 0.35) * s + lz * c);
      if (L.terrain.roadDist(A.x, A.z) > 1 && L.terrain.roadDist(B.x, B.z) > 1 && !L.terrain.buildingAt(A.x, A.z, 0.3) && !L.terrain.buildingAt(B.x, B.z, 0.3) && L.terrain.trackDist(A.x, A.z) > 6) {
        A.y = H(A.x, A.z); B.y = H(B.x, B.z);
        washSpots.push({ building: b.id, a: A, b: B });
      }
    }
  };

  const policeLamp = new THREE.MeshStandardMaterial({ color: 0x1a2a5a, emissive: 0x3a6aff, emissiveIntensity: 0.2, roughness: 0.3 });
  policeLamp.name = 'w_policeLamp';

  // ── churches & chapels ──
  const clockSpots: ClockSpot[] = [];
  const vanes: THREE.Vector3[] = [];
  const buildChurch = (k: Kit, b: Building, wmat: THREE.Material, rmat: THREE.Material, foot: number) => {
    const sx = b.size.x, sz = b.size.z, eaves = b.size.y;
    k.boxB(m.stone, sx + 0.3, -foot + 0.4, sz + 0.3, 0, foot, 0);
    k.boxB(wmat, sx, eaves, sz, 0, 0, 0);
    pitchedRoof(k, rmat, wmat, sx, sz, b.roofH, eaves, 0.4, 0.25);
    // buttresses + lancets along both long sides
    const n = Math.max(3, Math.round(sx / 3.2));
    for (let i = 0; i <= n; i++) {
      const x = -sx / 2 + (sx * i) / n;
      for (const fz of [-1, 1]) k.boxB(wmat, 0.55, eaves * 0.8, 0.7, x, 0, fz * (sz / 2 + 0.3));
    }
    for (let i = 0; i < n; i++) {
      const x = -sx / 2 + (sx * (i + 0.5)) / n;
      for (const fz of [-1, 1]) {
        k.push(x, 1.4, fz * (sz / 2 + 0.03), fz > 0 ? 0 : Math.PI);
        k.archSlab(m.cream, 1.2, eaves - 2.4, 0.08, 0, 0, 0);
        k.arch(m.windowLit, 0.9, eaves - 2.7, 0, 0.12, 0.06);
        k.pop();
      }
    }
    // chancel end: big window on the far gable; porch on the door side
    const tw = b.tower;
    const endX = tw ? -Math.sign(tw.lx) * (sx / 2 + 0.03) : sx / 2 + 0.03;
    k.push(endX, 1.4, 0, Math.sign(endX) * Math.PI / 2);
    k.archSlab(m.cream, 2.6, eaves + 0.6, 0.1, 0, 0, 0);
    k.arch(m.windowLit, 2.1, eaves + 0.2, 0, 0.15, 0.07);
    k.pop();
    for (const d of b.doors) {
      const [dx] = worldToLocal(b.center, b.yaw, d.x, d.z);
      for (const sd of [-1, 1]) k.boxB(wmat, 0.4, 2.8, 2.2, dx + sd * 1.3, 0, sz / 2 + 1.1);
      k.gable(rmat, 3.2, 2.6, 1.2, dx, 2.8, sz / 2 + 1.1, Math.PI / 2);
      k.push(dx, 0, sz / 2 + 0.04, 0);
      k.arch(wm.beams, 1.4, 2.4, 0, 0, 0);
      k.pop();
    }
    if (b.kind === 'chapel') {
      k.addC(wm.paint, 0xe8dcc0, new THREE.BoxGeometry(2.0, 0.5, 0.08), k.mat(0, eaves + 0.9, sz / 2 + 0.05));
    }
    if (!tw) return;
    // tower
    const tx = tw.lx, ts = tw.size, th = tw.h;
    k.boxB(wmat, ts, th, ts, tx, 0, 0);
    k.boxB(m.cream, ts + 0.3, 0.3, ts + 0.3, tx, th * 0.45, 0);
    k.boxB(m.cream, ts + 0.4, 0.35, ts + 0.4, tx, th - 0.35, 0);
    // belfry louvres
    for (let a = 0; a < 4; a++) {
      const ang = (a * Math.PI) / 2;
      k.push(tx + Math.sin(ang) * (ts / 2 + 0.02), th - 3.4, Math.cos(ang) * (ts / 2 + 0.02), ang);
      k.archSlab(m.cream, 1.4, 2.4, 0.08, 0, 0, 0);
      k.arch(wm.dark, 1.1, 2.1, 0, 0.1, 0.05);
      for (let i = 0; i < 4; i++) k.box(m.stone, 1.0, 0.08, 0.12, 0, 0.35 + i * 0.4, 0.1);
      k.pop();
    }
    if (tw.spire) {
      k.pyramid(m.slate, ts * 0.95, th * 0.9, tx, th, 0);
      k.cyl(m.iron, 0.04, 0.06, 1.6, 4, tx, th + th * 0.9, 0);
      { const c = Math.cos(b.yaw), s = Math.sin(b.yaw); vanes.push(V(b.center.x + tx * c, b.center.y + th + th * 0.9 + 1.5, b.center.z - tx * s)); }
    } else {
      // battlements + pinnacles + a flagpole
      for (let a = 0; a < 4; a++) {
        const ang = (a * Math.PI) / 2;
        for (let i = -2; i <= 2; i++) {
          const along = (i * ts) / 5;
          const ox = Math.sin(ang) * (ts / 2) + Math.cos(ang) * along, oz = Math.cos(ang) * (ts / 2) - Math.sin(ang) * along;
          if (i % 2 === 0) k.boxB(m.stone, 0.5, 0.6, 0.5, tx + ox, th, oz);
        }
      }
      for (const [px, pz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        k.boxB(m.stone, 0.5, 1.2, 0.5, tx + (px * ts) / 2, th, (pz * ts) / 2);
        k.pyramid(m.stone, 0.5, 0.8, tx + (px * ts) / 2, th + 1.2, (pz * ts) / 2);
      }
      k.cyl(wm.white, 0.05, 0.07, 5.0, 5, tx, th, 0);
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const top = V(b.center.x + tx * c, b.center.y + th + 4.8, b.center.z - tx * s);
      const fr = new THREE.Vector3(1.8 * c, 0, -1.8 * s);
      clothQuad(top, fr, new THREE.Vector3(0, -1.1, 0), 0xe8dcc0, 0, 0, 1);
      clothQuad(top.clone().add(new THREE.Vector3(0, -0.42, 0)), fr, new THREE.Vector3(0, -0.26, 0), 0x9a2c24, 0, 0, 1);
    }
    // clock faces (two sides that face the town)
    for (const ang of [0, Math.PI, Math.sign(tx || 1) * Math.PI / 2]) {
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const lx = tx + Math.sin(ang) * (ts / 2 + 0.1), lz = Math.cos(ang) * (ts / 2 + 0.1);
      const y = th * 0.62;
      k.push(tx + Math.sin(ang) * (ts / 2), y, Math.cos(ang) * (ts / 2), ang);
      k.box(m.cream, 1.9, 1.9, 0.12, 0, 0, 0.02);
      k.pop();
      clockSpots.push({ pos: V(b.center.x + lx * c + lz * s, b.center.y + y, b.center.z - lx * s + lz * c), yaw: b.yaw + ang, r: 0.8 });
    }
  };

  for (const b of L.buildings) {
    try { buildOne(b); } catch (e) { console.error('[world] building', b.id, e); }
  }

  // ── church clock dials (static; hands are instanced by clocks.ts) ──
  for (const cs of clockSpots) batch.add(wm.dial, new THREE.CircleGeometry(cs.r, 20), batch.mat(cs.pos.x, cs.pos.y, cs.pos.z, cs.yaw));
  const clocks = clockSpots.map((c) => ({ ...c, pos: c.pos.clone() }));

  // ── town areas ──
  for (const t of L.towns) for (const a of t.areas) {
    try { buildArea(t, a); } catch (e) { console.error('[world] area', a.id, e); }
  }
  function buildArea(t: Town, a: Town['areas'][number]) {
    const k = batch;
    const y = a.center.y;
    k.cast = false;
    k.push(a.center.x, y, a.center.z, a.yaw);
    const hx = a.size.x / 2, hz = a.size.z / 2;
    if (a.kind === 'square') {
      k.boxB(wm.street, a.size.x, 0.12, a.size.z, 0, -0.04, 0);
      // market cross: stepped base, shaft, cross head
      k.cast = true;
      for (let i = 0; i < 3; i++) k.boxB(m.stone, 3.2 - i * 0.9, 0.3, 3.2 - i * 0.9, 0, 0.08 + i * 0.3, 0);
      k.cyl(m.stone, 0.22, 0.28, 3.4, 8, 0, 0.98, 0);
      k.box(m.stone, 0.9, 0.22, 0.22, 0, 4.2, 0);
      k.box(m.stone, 0.22, 0.9, 0.22, 0, 4.2, 0);
      // pump + trough
      k.boxB(m.iron, 0.4, 1.8, 0.4, hx - 4, 0.08, -hz + 3);
      k.box(m.iron, 0.9, 0.08, 0.08, hx - 4.4, 1.7, -hz + 3, 0, 0, -0.4);
      k.boxB(m.stone, 2.0, 0.6, 0.9, hx - 4, 0.08, -hz + 4.2);
      // stall frames along the edges (empty trestles; market-day traders dress them)
      const stalls = [[-hx + 4, hz - 3], [-hx + 9, hz - 3], [hx - 9, hz - 3], [-hx + 4, -hz + 3], [-hx + 9, -hz + 3]];
      stalls.forEach(([sx, sz], i) => {
        k.push(sx, 0.08, sz, 0);
        for (const px of [-1.3, 1.3]) for (const pz of [-0.8, 0.8]) k.boxB(m.wood, 0.1, pz < 0 ? 2.4 : 2.1, 0.1, px, 0, pz);
        k.boxB(m.wood, 2.8, 0.08, 1.4, 0, 0.85, 0);
        {
          // canvas awning (cloth) sloping toward the square's edge
          const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
          const AW = (lx: number, yy: number, lz: number) => V(a.center.x + (sx + lx) * c + (sz + lz) * s, y + 0.08 + yy, a.center.z - (sx + lx) * s + (sz + lz) * c);
          const hi = sz > 0 ? -0.95 : 0.95;
          const p0 = AW(-1.5, 2.44, hi);
          clothQuad(p0, AW(1.5, 2.44, hi).sub(p0), AW(-1.5, 2.16, -hi).sub(p0), i % 2 ? 0xe8dcc0 : 0x7a2230, 0, 0.35);
        }
        k.pop();
      });
      for (let i = 0; i < 6; i++) k.cyl(m.wood, 0.3, 0.3, 0.7, 8, -hx + 2 + (i % 3) * 0.7, 0.08, hz - 6 - Math.floor(i / 3) * 0.7);
    } else if (a.kind === 'churchyard') {
      // headstones in loose rows + a low wall with a lych gate + yews
      k.detail = true;
      const hr = brng.fork(a.id.length);
      for (let gx = -hx + 2; gx < hx - 1.5; gx += 1.8) for (let gz = -hz + 1.8; gz < hz - 1.5; gz += 2.2) {
        const wx = a.center.x + gx * Math.cos(a.yaw) + gz * Math.sin(a.yaw), wz = a.center.z - gx * Math.sin(a.yaw) + gz * Math.cos(a.yaw);
        if (L.terrain.buildingAt(wx, wz, 1.5) || hr.chance(0.35)) continue;
        const gy = H(wx, wz) - y;
        const tall = hr.chance(0.2);
        k.addC(wm.paint, hr.pick([0x8a8a86, 0x9a968a, 0x77776f, 0xa8a496]), new THREE.BoxGeometry(tall ? 0.35 : 0.7, tall ? 1.4 : 0.8, 0.14), k.mat(gx + hr.range(-0.3, 0.3), gy + (tall ? 0.7 : 0.4), gz, hr.range(-0.1, 0.1), hr.range(-0.12, 0.08)));
        if (tall) k.addC(wm.paint, 0x8a8a86, new THREE.BoxGeometry(0.7, 0.14, 0.14), k.mat(gx, gy + 1.1, gz));
      }
      k.detail = false;
      k.cast = false;
      for (const [x0, z0, x1, z1] of [[-hx, -hz, hx, -hz], [hx, -hz, hx, hz], [-hx, hz, -2.5, hz], [2.5, hz, hx, hz], [-hx, -hz, -hx, hz]]) {
        const len = Math.hypot(x1 - x0, z1 - z0), mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        const wx = a.center.x + mx * Math.cos(a.yaw) + mz * Math.sin(a.yaw), wz = a.center.z - mx * Math.sin(a.yaw) + mz * Math.cos(a.yaw);
        if (L.terrain.roadDist(wx, wz) < 0.5) continue;
        k.boxB(m.stone, x1 === x0 ? 0.5 : len, 0.9, x1 === x0 ? len : 0.5, mx, H(wx, wz) - y - 0.3, mz);
      }
      // lych gate at the front gap
      const gwx = a.center.x + hz * Math.sin(a.yaw), gwz = a.center.z + hz * Math.cos(a.yaw);
      const gy = H(gwx, gwz) - y;
      for (const px of [-1.8, 1.8]) for (const pz of [-0.8, 0.8]) k.boxB(m.wood, 0.2, 2.2, 0.2, px, gy, hz + pz);
      k.gable(wm.roofTile, 4.4, 2.6, 1.3, 0, gy + 2.2, hz, 0);
    } else if (a.kind === 'garden') {
      // veg rows or a pub garden with tables, fenced (picket)
      if (a.id.includes('pub')) {
        for (const [tx, tz] of [[-2.5, -1.5], [2.5, -1.5], [0, 2]]) {
          k.boxB(m.wood, 1.8, 0.08, 0.8, tx, 0.72, tz);
          for (const s of [-1, 1]) k.boxB(m.wood, 1.8, 0.06, 0.3, tx, 0.42, tz + s * 0.65);
          k.boxB(m.wood, 0.1, 0.72, 0.6, tx - 0.7, 0, tz); k.boxB(m.wood, 0.1, 0.72, 0.6, tx + 0.7, 0, tz);
        }
      } else if (a.id.includes('hen')) {
        k.boxB(wm.boards, 2.0, 1.2, 1.4, -hx + 1.8, 0, 0);
        k.gable(wm.roofTile, 2.3, 1.7, 0.6, -hx + 1.8, 1.2, 0, 0);
        k.boxB(m.wood, 0.9, 0.06, 0.25, -hx + 3.0, 0.3, 0, 0);
      } else {
        k.detail = true;
        for (let r = -hz + 1; r < hz - 0.8; r += 0.9) {
          k.addC(wm.paint, 0x5b4632, new THREE.BoxGeometry(a.size.x * 0.4, 0.12, 0.45), k.mat(-hx * 0.45, 0.02, r));
          k.addC(wm.paint, brng.pick([0x5d7a3e, 0x6f8f4e, 0x4f6e38]), new THREE.BoxGeometry(a.size.x * 0.38, 0.25, 0.22), k.mat(-hx * 0.45, 0.2, r));
        }
        k.detail = false;
      }
      k.detail = true;
      for (const [x0, z0, x1, z1] of [[-hx, -hz, hx, -hz], [hx, -hz, hx, hz], [-hx, hz, hx - 2, hz], [-hx, -hz, -hx, hz]]) {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const n = Math.max(1, Math.round(len / 0.35));
        for (let i = 0; i <= n; i++) {
          const px = x0 + ((x1 - x0) * i) / n, pz = z0 + ((z1 - z0) * i) / n;
          k.boxB(wm.white, 0.07, 0.85, 0.05, px, 0, pz);
        }
        k.box(wm.white, x1 === x0 ? 0.05 : len, 0.08, x1 === x0 ? len : 0.05, (x0 + x1) / 2, 0.6, (z0 + z1) / 2);
      }
      k.detail = false;
    } else if (a.kind === 'yard') {
      k.boxB(a.id.includes('coal') ? wm.setts : wm.cinder, a.size.x, 0.1, a.size.z, 0, -0.04, 0);
      if (a.id.includes('coal')) {
        // the cart track in from the Station Approach (beside the office), in short pieces that follow the ground
        const K = L.roads.edges.K;
        if (K) {
          const sT = 31, side = 1, hwK = K.width / 2;
          const p0 = K.poly.offset(sT, side * (hwK - 0.3), 0), p1 = K.poly.offset(sT, side * (hwK + 8.2 + 1.2), 0);
          const [l0x, l0z] = worldToLocal(a.center, a.yaw, p0.x, p0.z), [l1x, l1z] = worldToLocal(a.center, a.yaw, p1.x, p1.z);
          const n = Math.max(2, Math.ceil(Math.hypot(l1x - l0x, l1z - l0z) / 1.5));
          const len = Math.hypot(l1x - l0x, l1z - l0z) / n;
          const ang = Math.atan2(l1x - l0x, l1z - l0z);
          for (let i = 0; i < n; i++) {
            const u = (i + 0.5) / n;
            const lx = l0x + (l1x - l0x) * u, lz = l0z + (l1z - l0z) * u;
            const wx = a.center.x + lx * Math.cos(a.yaw) + lz * Math.sin(a.yaw), wz = a.center.z - lx * Math.sin(a.yaw) + lz * Math.cos(a.yaw);
            k.boxB(wm.cinder, 3.4, 0.1, len + 0.25, lx, H(wx, wz) - y - 0.03, lz, ang);
          }
        }
        // weighbridge office (a little clapboard hut beside the plate), coal sacks stacked by the bins, a sack barrow
        k.cast = true;
        k.boxB(wm.boards, 2.4, 2.2, 2.0, hx - 1.6, 0, hz - 6.2);
        k.gable(wm.roofTile, 2.8, 2.4, 0.8, hx - 1.6, 2.2, hz - 6.2, Math.PI / 2);
        k.boxB(wm.white, 0.7, 0.6, 0.05, hx - 2.81, 1.1, hz - 6.2, Math.PI / 2);
        for (let i = 0; i < 7; i++) {
          const sx = -hx + 11.8 + (i % 4) * 0.62, sz = -hz + 1.6 + Math.floor(i / 4) * 0.02, sy = Math.floor(i / 4) * 0.42;
          k.addC(wm.paint, 0x3a3128, new THREE.BoxGeometry(0.55, 0.42, 0.8), k.mat(sx + (i >= 4 ? 0.3 : 0), sy, sz + 0.6, (i * 0.37) % 0.3));
        }
        k.boxB(m.wood, 0.5, 0.06, 1.3, -hx + 14.6, 0.35, -hz + 3.4, 0.4);
        k.cyl(m.iron, 0.28, 0.28, 0.08, 8, -hx + 14.6, 0.28, -hz + 4.1);
        // a tipping shovel and a stack of coal scuttles by the office wall
        for (let i = 0; i < 3; i++) k.cyl(m.iron, 0.22, 0.17, 0.34, 6, -hx + 17.2 + i * 0.5, 0, -hz + 1.0);
        k.cast = false;
        // coal bins (three bays), a heap, weighbridge plate and sack barrow
        k.cast = true;
        for (let i = 0; i < 3; i++) {
          k.boxB(m.brickDark, 0.4, 1.4, 3.2, -hx + 1 + i * 3.6, 0, -hz + 2.2);
          k.add(wm.coal, new THREE.ConeGeometry(1.4, 1.0, 7), k.mat(-hx + 2.8 + i * 3.6, 0.5, -hz + 2.2, i));
          // a few loose lumps on and around the heap catch the light
          for (let j = 0; j < 4; j++) {
            const a = i * 1.7 + j * 1.9, r = j === 0 ? 0 : 0.9 + (j % 2) * 0.4;
            k.add(wm.coal, new THREE.DodecahedronGeometry(j === 0 ? 0.32 : 0.22, 0), k.mat(-hx + 2.8 + i * 3.6 + Math.cos(a) * r, j === 0 ? 0.95 : 0.35 - r * 0.12, -hz + 2.2 + Math.sin(a) * r, a));
          }
        }
        k.boxB(m.brickDark, 11, 1.4, 0.4, -hx + 5.5, 0, -hz + 0.6);
        k.boxB(m.iron, 3.2, 0.06, 2.4, hx - 4, 0.02, hz - 3);
        k.cast = false;
      } else if (a.id.includes('mews')) {
        k.boxB(m.stone, 2.4, 0.7, 0.9, hx - 2.5, 0, -hz + 1.5);
        k.boxB(wm.water, 2.1, 0.05, 0.6, hx - 2.5, 0.64, -hz + 1.5);
        k.boxB(m.stone, 1.0, 0.5, 1.0, -hx + 1.5, 0, hz - 1.5); // mounting block
      }
    } else if (a.kind === 'rickyard') {
      // haystacks on staddle stones
      k.cast = true;
      for (let i = 0; i < 5; i++) {
        const px = -hx + 3 + (i % 3) * 7, pz = -hz + 4 + Math.floor(i / 3) * 6;
        for (let s = 0; s < 6; s++) { const an = (s / 6) * Math.PI * 2; k.cyl(m.stone, 0.18, 0.26, 0.6, 5, px + Math.cos(an) * 1.8, 0, pz + Math.sin(an) * 1.8); }
        k.cyl(wm.hay, 2.4, 2.3, 2.6, 9, px, 0.6, pz);
        k.add(wm.hay, new THREE.ConeGeometry(2.6, 2.0, 9), k.mat(px, 4.2, pz));
      }
      k.cast = false;
    } else if (a.kind === 'playground') {
      k.boxB(wm.cinder, a.size.x, 0.1, a.size.z, 0, -0.04, 0);
      for (const [x0, z0, x1, z1] of [[-hx, -hz, hx, -hz], [hx, -hz, hx, hz], [-hx, -hz, -hx, hz]]) {
        const len = Math.hypot(x1 - x0, z1 - z0);
        k.boxB(m.brick, x1 === x0 ? 0.35 : len, 1.2, x1 === x0 ? len : 0.35, (x0 + x1) / 2, 0, (z0 + z1) / 2);
      }
    } else if (a.kind === 'pond') {
      k.detail = true;
      for (let i = 0; i < 14; i++) {
        const an = (i / 14) * Math.PI * 2;
        k.addC(wm.paint, 0x8a8478, new THREE.DodecahedronGeometry(0.35, 0), k.mat(Math.cos(an) * hx * 0.95, 0.05, Math.sin(an) * hz * 0.95, an));
      }
      k.detail = false;
    } else if (a.kind === 'green') {
      // maypole + benches + a village pump on the green
      k.cast = true;
      k.cyl(wm.white, 0.12, 0.16, 8, 6, 0, 0, 0);
      k.addC(wm.paint, 0x2f5d3a, new THREE.TorusGeometry(0.5, 0.06, 4, 10), k.mat(0, 7.6, 0, 0, Math.PI / 2));
      k.cast = false;
      for (const [bx, bz, r] of [[-hx + 3, 0, Math.PI / 2], [hx - 3, 2, -Math.PI / 2]]) {
        k.push(bx, 0, bz, r);
        k.boxB(m.wood, 1.8, 0.07, 0.5, 0, 0.45, 0);
        k.boxB(m.wood, 1.8, 0.4, 0.07, 0, 0.5, -0.24);
        for (const s of [-0.8, 0.8]) k.boxB(m.iron, 0.07, 0.45, 0.5, s, 0, 0);
        k.pop();
      }
    }
    k.pop();
    k.cast = false;
  }

  // ── windmill (Wyke post mill): trestle static, buck + sails dynamic ──
  let windmill: TownsBuild['windmill'] = null;
  {
    const w = L.landmarks.windmill;
    const baseY = w.center.y;
    const k = batch;
    k.cast = true;
    k.push(w.center.x, baseY, w.center.z, w.yaw);
    // brick roundhouse around the trestle
    k.cyl(m.brick, 3.4, 3.6, 2.6, 12, 0, -0.3, 0);
    k.add(wm.roofTile, new THREE.ConeGeometry(4.0, 1.4, 12), k.mat(0, 3.0, 0));
    k.addC(wm.paint, 0x3b332c, new THREE.BoxGeometry(1.0, 1.8, 0.1), k.mat(0, 0.9, 3.55));
    k.cyl(m.wood, 0.45, 0.5, 2.0, 8, 0, 3.4, 0); // post crown
    k.pop();
    k.cast = false;
    const body = new THREE.Group();
    body.name = 'windmillBuck';
    body.position.set(w.center.x, baseY + 5.0, w.center.z);
    body.rotation.y = w.yaw;
    const bk = new Kit();
    // buck: weatherboarded body with a curved (two-slab) roof, tail pole and steps
    bk.boxB(wm.white, 4.6, 5.4, 5.4, 0, 0, 0);
    bk.boxB(wm.beams, 4.7, 0.2, 5.5, 0, 0.2, 0);
    bk.add(wm.roofTile, new THREE.CylinderGeometry(2.9, 2.9, 5.6, 8, 1, false, -Math.PI / 2, Math.PI), bk.mat(0, 5.2, 0, 0, 0, Math.PI / 2));
    bk.boxB(wm.dark, 1.0, 1.5, 0.1, 0, 2.2, -2.75);
    for (let i = 0; i < 8; i++) bk.boxB(m.wood, 1.2, 0.08, 0.3, 0, -4.6 + i * 0.6, -3.4 - (8 - i) * 0.45);
    bk.beam(m.wood, 0.14, 0.14, V(-0.6, -5.0, -7.2), V(-0.6, 0.2, -2.8));
    bk.beam(m.wood, 0.14, 0.14, V(0.6, -5.0, -7.2), V(0.6, 0.2, -2.8));
    bk.beam(m.wood, 0.2, 0.2, V(0, -4.4, -8.5), V(0, 0.6, -2.7)); // tail pole
    windowAt(bk, true, 1.2, 3.0, 2.72, 0, 0.6, 0.7);
    const bg = bk.build('buck', { cast: true });
    for (const c of bg.children) c.matrixAutoUpdate = true;
    body.add(bg);
    // sails on the front (+z) at the hub
    const sails = new THREE.Group();
    sails.position.set(0, 4.6, 4.3);
    const sk = new Kit(), ck = new Kit();
    sk.add(m.iron, new THREE.CylinderGeometry(0.35, 0.35, 0.8, 8), sk.mat(0, 0, -0.3, 0, Math.PI / 2, 0));
    sk.add(m.wood, new THREE.CylinderGeometry(0.22, 0.22, 1.8, 6), sk.mat(0, 0, -1.2, 0, Math.PI / 2, 0));
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      sk.push(0, 0, 0.3, 0, 0, a);
      sk.box(m.wood, 0.25, 8.8, 0.2, 0, 4.4, 0);                 // stock / whip
      for (let j = 0; j < 8; j++) sk.box(m.wood, 2.0, 0.07, 0.07, 0.75, 1.5 + j * 0.95, 0.05); // sail bars
      sk.box(m.wood, 0.07, 7.2, 0.07, 1.75, 4.9, 0.05);
      ck.push(0, 0, 0.35, 0, 0, a);
      ck.box(wm.whitewash, 1.6, 7.0, 0.04, 0.85, 4.9, 0.06);         // canvas
      ck.pop();
      sk.pop();
    }
    const sg = sk.build('sails', { cast: true });
    for (const c of sg.children) c.matrixAutoUpdate = true;
    const cg = ck.build('canvas', { cast: true });
    for (const c of cg.children) c.matrixAutoUpdate = true;
    sails.add(sg, cg);
    body.add(sails);
    root.add(body);
    windmill = { body, sails, canvas: cg };
  }

  // ── cloth mesh: pub signs + church flags (wind 'cloth') ──
  if (clothPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(clothPos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(clothCol, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(clothW, 1));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true, side: THREE.DoubleSide });
    mat.name = 'w_cloth';
    const depth = applyWind(ctx, mat, { mode: 'cloth', weight: 'attr', amp: 0.35, pivot: 'vertex', freq: 1.3 });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'signsAndFlags';
    mesh.castShadow = true;
    if (depth) mesh.customDepthMaterial = depth;
    mesh.frustumCulled = false; // spread over the whole map, tiny
    root.add(mesh);
  }

  // ── washing lines: posts + line (static), garments InstancedMesh (setWashing shows them) ──
  let washMesh: THREE.InstancedMesh | null = null;
  const washing: TownsBuild['washing'] = [];
  if (washSpots.length) {
    batch.detail = true;
    for (const w of washSpots) {
      batch.boxB(m.wood, 0.1, 2.3, 0.1, w.a.x, w.a.y, w.a.z);
      batch.boxB(m.wood, 0.1, 2.3, 0.1, w.b.x, w.b.y, w.b.z);
      batch.beam(wm.white, 0.02, 0.02, V(w.a.x, w.a.y + 2.2, w.a.z), V(w.b.x, w.b.y + 2.2, w.b.z));
    }
    batch.detail = false;
    const per = 5;
    const geo = new THREE.PlaneGeometry(1, 1, 1, 2);
    geo.translate(0, -0.5, 0);
    const pa = geo.getAttribute('position') as THREE.BufferAttribute;
    const aw = new Float32Array(pa.count);
    for (let i = 0; i < pa.count; i++) aw[i] = -pa.getY(i);
    geo.setAttribute('aWind', new THREE.BufferAttribute(aw, 1));
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide, flatShading: true });
    mat.name = 'w_washing';
    applyWind(ctx, mat, { mode: 'cloth', weight: 'attr', amp: 0.4, pivot: 'vertex', freq: 1.6 });
    washMesh = new THREE.InstancedMesh(geo, mat, washSpots.length * per);
    washMesh.name = 'washing';
    const cols = [0xf2efe6, 0xe8dcc0, 0xd8c8b0, 0x9fb8c8, 0xc8b0b0, 0xf6f4ee, 0xb8c4a8];
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    washSpots.forEach((w, i) => {
      for (let j = 0; j < per; j++) {
        washMesh!.setMatrixAt(i * per + j, zero);
        washMesh!.setColorAt(i * per + j, new THREE.Color(cols[(i * 3 + j) % cols.length]));
      }
      washing.push({ building: w.building, mesh: washMesh!, first: i * per, count: per });
    });
    washMesh.userData.spots = washSpots;
    washMesh.instanceMatrix.needsUpdate = true;
    if (washMesh.instanceColor) washMesh.instanceColor.needsUpdate = true;
    washMesh.frustumCulled = false;
    root.add(washMesh);
  }

  return {
    forges, clocks, washing, washMesh, windmill, doors: doorSpots, vanes,
    update(_dt, night) {
      policeLamp.emissiveIntensity = 0.2 + night * 2.2;
    },
  };
}
