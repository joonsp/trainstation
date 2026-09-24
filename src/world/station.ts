import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import { Kit, V } from './kit';
import { valanceGeometry } from './canopy';
import type { ClockSpot } from './clocks';

export interface StationBuild {
  towerTop: THREE.Vector3;
  clockSpots: ClockSpot[];
  /** weather-vane pivot (top of the clock tower) */
  vane: THREE.Vector3;
}

const GF = 1.0;        // ground floor level
const STR1 = 5.4;      // first string course
const EAVES = 10.0;

export function buildStation(ctx: Ctx, wm: WorldMats, root: THREE.Object3D, pickables: THREE.Object3D[]): StationBuild {
  const S = ctx.layout.station;
  const m = ctx.mats;
  const kit = new Kit();
  const HX = S.size.x / 2, HZ = S.size.z / 2;

  kit.push(S.center.x, 0, S.center.z, S.yaw);

  // ── plinth & walls ──
  kit.boxB(m.stone, S.size.x + 1, GF, S.size.z + 1, 0, 0, 0);
  kit.boxB(m.brick, S.size.x, STR1 - GF, S.size.z, 0, GF, 0);
  kit.boxB(m.cream, S.size.x + 0.3, 0.3, S.size.z + 0.3, 0, STR1, 0);
  kit.boxB(m.brick, S.size.x - 0.2, EAVES - STR1 - 0.3, S.size.z - 0.2, 0, STR1 + 0.3, 0);
  // cornice (two steps)
  kit.boxB(m.cream, S.size.x + 0.5, 0.25, S.size.z + 0.5, 0, EAVES - 0.35, 0);
  kit.boxB(m.cream, S.size.x + 0.9, 0.2, S.size.z + 0.9, 0, EAVES - 0.1, 0);
  // dark brick band under the string course
  kit.boxB(m.brickDark, S.size.x + 0.08, 0.35, S.size.z + 0.08, 0, 1.0, 0);

  // central pavilions (project 0.6 m on both long facades) with pediments
  const PW = 9;
  for (const sz of [-1, 1]) {
    kit.boxB(m.brick, PW, EAVES - GF, 0.6, 0, GF, sz * (HZ + 0.3));
    kit.boxB(m.cream, PW + 0.3, 0.3, 0.9, 0, STR1, sz * (HZ + 0.35));
    kit.boxB(m.cream, PW + 0.6, 0.35, 1.1, 0, EAVES - 0.35, sz * (HZ + 0.4));
    // pediment (gable facing out)
    const s = new THREE.Shape();
    s.moveTo(-PW / 2 - 0.3, 0); s.lineTo(PW / 2 + 0.3, 0); s.lineTo(0, 2.6); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 3.5, bevelEnabled: false });
    g.translate(0, 0, -3.5);
    kit.add(m.cream, g, kit.mat(0, EAVES, sz * (HZ + 0.9), sz > 0 ? 0 : Math.PI));
    const s2 = new THREE.Shape();
    s2.moveTo(-PW / 2 + 0.3, 0.3); s2.lineTo(PW / 2 - 0.3, 0.3); s2.lineTo(0, 2.1); s2.closePath();
    kit.add(m.brick, new THREE.ShapeGeometry(s2), kit.mat(0, EAVES, sz * (HZ + 0.92), sz > 0 ? 0 : Math.PI));
    // round oculus in pediment
    kit.add(m.windowLit, new THREE.CircleGeometry(0.45, 10), kit.mat(0, EAVES + 1.0, sz * (HZ + 0.94), sz > 0 ? 0 : Math.PI));
    // pavilion quoins
    for (const sx of [-1, 1]) quoins(kit, m.cream, sx * PW / 2, sz * (HZ + 0.6), GF, EAVES - 0.35, sx, sz, true);
  }

  // corner quoins
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) quoins(kit, m.cream, sx * HX, sz * HZ, GF, EAVES - 0.35, sx, sz, false);

  // ── windows ──
  const win = (x: number, y: number, z: number, ry: number, w: number, h: number) => {
    kit.push(x, y, z, ry);
    kit.archSlab(m.cream, w + 0.45, h + 0.3, 0.12, 0, -0.1, 0.02);
    kit.arch(m.windowLit, w, h, 0, 0, 0.1);
    kit.box(m.cream, w + 0.6, 0.12, 0.3, 0, -0.12, 0.1);
    kit.box(m.cream, 0.28, 0.35, 0.1, 0, h + 0.05, 0.1); // keystone
    kit.box(m.iron, 0.05, h - 0.1, 0.03, 0, h / 2 - 0.05, 0.12); // mullion
    kit.box(m.iron, w - 0.05, 0.05, 0.03, 0, h * 0.55, 0.12); // transom
    kit.pop();
  };
  // long facades (z = ±HZ): ground floor & first floor bays, skipping the pavilion
  for (const sz of [-1, 1]) {
    const ry = sz > 0 ? 0 : Math.PI;
    for (let i = 0; i < 8; i++) {
      const x = -HX + 2 + i * ((S.size.x - 4) / 7);
      if (Math.abs(x) < PW / 2 + 0.6) continue;
      win(x, GF + 1.0, sz * HZ, ry, 1.3, 2.7);
      win(x, STR1 + 1.1, sz * HZ, ry, 1.1, 2.2);
    }
    // pavilion: central doors + first-floor triple window
    const zf = sz * (HZ + 0.6);
    kit.push(0, 0, zf, ry);
    kit.archSlab(m.cream, 3.2, 4.2, 0.2, 0, GF, 0.05);
    kit.arch(m.bottleGreen, 2.4, 3.6, 0, GF, 0.16);
    kit.arch(m.windowLit, 2.0, 1.0, 0, GF + 2.6, 0.18); // fanlight over the doors
    kit.box(m.iron, 0.05, 2.5, 0.05, 0, GF + 1.25, 0.2);
    kit.box(m.brass, 0.1, 0.1, 0.1, -0.2, GF + 1.2, 0.22);
    kit.box(m.brass, 0.1, 0.1, 0.1, 0.2, GF + 1.2, 0.22);
    // door canopy (little glazed awning) on brackets
    kit.box(m.iron, 3.8, 0.12, 1.4, 0, GF + 4.35, 0.8);
    kit.add(m.glass, new THREE.BoxGeometry(3.6, 0.04, 1.3), kit.mat(0, GF + 4.45, 0.8, 0, 0.12));
    for (const sx of [-1.7, 1.7]) kit.beam(m.iron, 0.06, 0.06, V(sx, GF + 3.3, 0.1), V(sx, GF + 4.3, 1.4));
    kit.pop();
    for (const dx of [-2.3, 0, 2.3]) win(dx, STR1 + 1.1, zf, ry, 1.1, 2.3);
  }
  // short facades (x = ±HX): 3 bays each floor (east has the entrance in the middle)
  for (const sx of [-1, 1]) {
    const ry = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    for (const dz of [-4.2, 0, 4.2]) {
      if (!(sx > 0 && dz === 0)) win(sx * HX, GF + 1.0, dz, ry, 1.3, 2.7);
      win(sx * HX, STR1 + 1.1, dz, ry, 1.1, 2.2);
    }
  }

  // ── booking hall entrance (east) with steps and porte-cochère ──
  {
    kit.push(HX, 0, 0, Math.PI / 2); // local +z now = station +x (outward)
    kit.archSlab(m.cream, 3.8, 4.6, 0.25, 0, GF, 0.05);
    kit.arch(wm.dark, 3.0, 4.0, 0, GF, 0.18);
    kit.arch(m.windowLit, 2.6, 1.2, 0, GF + 2.7, 0.2);
    kit.quad(wm.signs, 3.4, 0.56, 0, GF + 4.95, 0.2, 0, wm.atlas.booking);
    kit.pop();
    // top landing (queue point) then steps down to the forecourt
    kit.boxB(m.stone, 2.2, GF, 9, HX + 1.1, 0, 0);
    for (let i = 0; i < 4; i++) {
      const h = GF - (i + 1) * 0.25;
      kit.boxB(m.stone, 0.5, h, 9 + (i + 1) * 0.4, HX + 2.2 + i * 0.5 + 0.25, 0, 0);
    }
    // porte-cochère: iron columns, slate hipped roof, valance
    const px0 = HX + 0.2, px1 = HX + 9.5, pz = 5.2, roofY = 5.6;
    for (const cz of [-pz + 0.4, pz - 0.4]) {
      for (const cx of [px1 - 0.4, (px0 + px1) / 2 + 1]) {
        kit.boxB(m.stone, 0.6, 0.4, 0.6, cx, 0, cz);
        kit.cyl(m.iron, 0.12, 0.14, roofY - 0.4, 8, cx, 0.4, cz);
        kit.cyl(m.iron, 0.28, 0.12, 0.4, 8, cx, roofY - 0.45, cz);
      }
    }
    kit.boxB(m.iron, px1 - px0, 0.35, 0.25, (px0 + px1) / 2, roofY - 0.3, pz - 0.4);
    kit.boxB(m.iron, px1 - px0, 0.35, 0.25, (px0 + px1) / 2, roofY - 0.3, -pz + 0.4);
    kit.boxB(m.iron, 0.25, 0.35, 2 * pz - 0.8, px1 - 0.4, roofY - 0.3, 0);
    kit.hip(m.slate, px1 - px0 + 0.6, 2 * pz + 0.6, 1.6, (px0 + px1) / 2 + 0.3, roofY + 0.05, 0);
    kit.boxB(m.cream, px1 - px0 + 0.7, 0.18, 2 * pz + 0.7, (px0 + px1) / 2 + 0.3, roofY - 0.1, 0);
    // valance around the three open sides
    const vg = (len: number) => valanceGeometry(len, 0.55, 0.3);
    kit.add(m.cream, vg(px1 - px0), kit.mat((px0 + px1) / 2 + 0.3, roofY - 0.1, pz + 0.35));
    kit.add(m.cream, vg(px1 - px0), kit.mat((px0 + px1) / 2 + 0.3, roofY - 0.1, -pz - 0.35));
    kit.add(m.cream, vg(2 * pz + 0.7), kit.mat(px1 + 0.65, roofY - 0.1, 0, Math.PI / 2));
    // gas lamp bracket under the porte-cochère
    kit.add(wm.lantern, new THREE.CylinderGeometry(0.28, 0.2, 0.55, 4, 1), kit.mat((px0 + px1) / 2 + 0.5, roofY - 0.9, 0, Math.PI / 4));
    kit.cyl(m.iron, 0.03, 0.03, 0.6, 4, (px0 + px1) / 2 + 0.5, roofY - 0.65, 0);
  }

  // facade name board on the east face under the cornice
  kit.push(HX, 0, 0, Math.PI / 2);
  // (stood well proud of the wall so the upper windows' stone heads never poke through the lettering)
  kit.box(m.iron, 10.2, 1.25, 0.1, 0, EAVES - 1.25, 0.3);
  kit.quad(wm.signs, 10, 1.1, 0, EAVES - 1.25, 0.36, 0, wm.atlas.facade);
  kit.pop();

  // ── roofs ──
  kit.hip(m.slate, S.size.x + 1.0, S.size.z + 1.0, 4.2, 0, EAVES + 0.1, 0);
  // pavilion cross roofs
  kit.gable(m.slate, PW + 0.8, S.size.z + 2.6, 3.0, 0, EAVES + 0.1, 0, Math.PI / 2);
  // ridge cresting
  const ridgeLen = S.size.x + 1 - (S.size.z + 1);
  kit.box(m.iron, ridgeLen, 0.12, 0.12, 0, EAVES + 4.35, 0);
  for (let x = -ridgeLen / 2; x <= ridgeLen / 2 + 0.01; x += 0.9) kit.add(m.iron, new THREE.ConeGeometry(0.1, 0.45, 4), kit.mat(x, EAVES + 4.6, 0));
  // dormers on both slopes
  for (const sz of [-1, 1]) for (const dx of [-10, 10]) {
    kit.push(dx, EAVES + 0.9, sz * (HZ - 1.8), sz > 0 ? 0 : Math.PI);
    kit.boxB(m.brick, 1.8, 1.6, 1.6, 0, 0, 0);
    kit.gable(m.slate, 1.9, 2.1, 0.9, 0, 1.6, 0, Math.PI / 2);
    kit.arch(m.windowLit, 0.9, 1.2, 0, 0.2, 0.81);
    kit.pop();
  }
  // chimneys
  for (const [cx, cz] of [[-12.5, -3.2], [-12.5, 3.2], [3.5, -3.5], [3.5, 3.5]]) {
    kit.boxB(m.brick, 1.2, 4.6, 1.8, cx, EAVES + 1.8, cz);
    kit.boxB(m.cream, 1.45, 0.25, 2.05, cx, EAVES + 6.2, cz);
    for (const oz of [-0.45, 0.45]) kit.cyl(m.brickDark, 0.18, 0.22, 0.7, 6, cx, EAVES + 6.45, cz + oz);
  }

  // ── clock tower (rises from the east end) ──
  const TX = HX - 5.5, TW = 4.6;
  const T0 = EAVES - 1, TCLK = 16.5, TTOP = 19.4;
  kit.boxB(m.brick, TW, TTOP - T0, TW, TX, T0, 0);
  quoins(kit, m.cream, TX + TW / 2, TW / 2, T0 + 0.5, TTOP, 1, 1, false);
  quoins(kit, m.cream, TX - TW / 2, TW / 2, T0 + 0.5, TTOP, -1, 1, false);
  quoins(kit, m.cream, TX + TW / 2, -TW / 2, T0 + 0.5, TTOP, 1, -1, false);
  quoins(kit, m.cream, TX - TW / 2, -TW / 2, T0 + 0.5, TTOP, -1, -1, false);
  kit.boxB(m.cream, TW + 0.4, 0.3, TW + 0.4, TX, TCLK - 1.9, 0);
  kit.boxB(m.cream, TW + 0.7, 0.35, TW + 0.7, TX, TTOP - 0.1, 0);
  // belfry lantern stage with arched openings
  kit.boxB(m.brick, TW - 0.6, 2.4, TW - 0.6, TX, TTOP + 0.25, 0);
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const ox = Math.sin(a) * (TW / 2 - 0.29), oz = Math.cos(a) * (TW / 2 - 0.29);
    kit.push(TX + ox, 0, oz, a);
    kit.arch(wm.dark, 1.2, 1.9, 0, TTOP + 0.4, 0.02);
    kit.pop();
  }
  kit.boxB(m.cream, TW, 0.3, TW, TX, TTOP + 2.6, 0);
  // French pavilion spire + cresting + finial
  kit.pyramid(m.slate, TW + 0.2, 5.0, TX, TTOP + 2.9, 0);
  kit.cyl(m.iron, 0.05, 0.08, 1.8, 5, TX, TTOP + 7.3, 0);
  kit.add(m.brass, new THREE.SphereGeometry(0.22, 8, 5), kit.mat(TX, TTOP + 7.8, 0));
  // weather vane: spindle + cardinal arms here; the arrow swings (vanes.ts)
  kit.cyl(m.iron, 0.03, 0.03, 1.1, 4, TX, TTOP + 8.0, 0);
  kit.box(m.iron, 0.9, 0.03, 0.03, TX, TTOP + 8.45, 0);
  kit.box(m.iron, 0.03, 0.03, 0.9, TX, TTOP + 8.45, 0);
  // clock surrounds
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    kit.push(TX + Math.sin(a) * (TW / 2), TCLK, Math.cos(a) * (TW / 2), a);
    kit.box(m.cream, 3.3, 3.3, 0.2, 0, 0, 0.05);
    kit.add(m.iron, new THREE.CylinderGeometry(1.42, 1.42, 0.12, 20), kit.mat(0, 0, 0.18, 0, Math.PI / 2, 0));
    kit.box(m.cream, 1.6, 0.5, 0.35, 0, 1.75, 0.1); // hood
    kit.pop();
  }

  // ── clock dials (static, merged with the building; hands are instanced by clocks.ts) ──
  const clockSpots: ClockSpot[] = [];
  const toW = (lx: number, y: number, lz: number) => {
    const c = Math.cos(S.yaw), s = Math.sin(S.yaw);
    return V(S.center.x + lx * c + lz * s, y, S.center.z - lx * s + lz * c);
  };
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    kit.add(wm.dial, new THREE.CircleGeometry(1.3, 24), kit.mat(TX + Math.sin(a) * (TW / 2 + 0.25), TCLK, Math.cos(a) * (TW / 2 + 0.25), a));
    clockSpots.push({ pos: toW(TX + Math.sin(a) * (TW / 2 + 0.25), TCLK, Math.cos(a) * (TW / 2 + 0.25)), yaw: S.yaw + a, r: 1.3 });
  }
  kit.pop();

  const group = kit.build('station', { cast: true, receive: true });
  group.userData.pick = { kind: 'station', id: 'building' };
  for (const c of group.children) c.userData.pick = group.userData.pick;
  root.add(group);
  pickables.push(group);

  const towerTop = toW(TX, TTOP + 7.8, 0);
  return { towerTop, clockSpots, vane: toW(TX, TTOP + 9.0, 0) };
}

/** alternating long/short quoin blocks up a corner at local (x, z); sx/sz = outward signs */
function quoins(kit: Kit, mat: THREE.Material, x: number, z: number, y0: number, y1: number, sx: number, sz: number, onlyFront: boolean) {
  const h = 0.45;
  let i = 0;
  for (let y = y0 + 0.1; y + h <= y1; y += h + 0.1, i++) {
    const long = i % 2 === 0;
    const a = long ? 0.9 : 0.55;
    // face along x (on the z facade)
    kit.boxB(mat, a, h, 0.1, x - sx * (a / 2 - 0.05), y, z + sz * 0.05);
    if (!onlyFront) {
      const b = long ? 0.55 : 0.9;
      kit.boxB(mat, 0.1, h, b, x + sx * 0.05, y, z - sz * (b / 2 - 0.05));
    }
  }
}
