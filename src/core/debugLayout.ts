import * as THREE from 'three';
import type { Layout, Rect } from './layout';
import { PLATFORM_TOP } from './layout';
import type { Dir, LineId } from './types';

/** ?debug=layout — draws curves, rects, nav graph and markers as unlit lines/boxes. Owned by core. */
export function createLayoutDebug(layout: Layout): THREE.Group {
  const g = new THREE.Group();
  g.name = 'layout-debug';
  const lineMat = (color: number) => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
  const basic = (color: number) => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });

  const addPolyline = (pts: THREE.Vector3[], color: number, y?: number) => {
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => (y === undefined ? p : new THREE.Vector3(p.x, y, p.z))));
    const l = new THREE.Line(geo, lineMat(color));
    l.renderOrder = 999;
    g.add(l);
  };
  const addRect = (r: Rect, color: number, y: number) => {
    const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
    const hx = r.size.x / 2, hz = r.size.z / 2;
    const pts = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz], [-hx, -hz]].map(
      ([lx, lz]) => new THREE.Vector3(r.center.x + lx * c + lz * s, y, r.center.z - lx * s + lz * c),
    );
    addPolyline(pts, color);
    // mark local +x (east end) with a short tick
    addPolyline([r.center.clone().setY(y), new THREE.Vector3(r.center.x + hx * c, y, r.center.z - hx * s)], color);
  };
  const marker = (p: THREE.Vector3, color: number, size = 1.2, h = 1.2) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size, h, size), basic(color));
    m.position.set(p.x, p.y + h / 2, p.z);
    m.renderOrder = 1000;
    g.add(m);
  };

  const lineColors: Record<LineId, number> = { coast: 0x3aa0ff, highland: 0xff4a4a };
  for (const L of Object.values(layout.lines)) {
    addPolyline(L.curve.getSpacedPoints(600), lineColors[L.id], 0.5);
    // platform extent on the track, drawn thicker by offsetting a second line
    const seg: THREE.Vector3[] = [];
    for (let i = 0; i <= 40; i++) seg.push(L.pointAt(L.platformStartT + ((L.platformEndT - L.platformStartT) * i) / 40));
    addPolyline(seg, 0xffffff, 0.6);
    for (const d of ['east', 'west'] as Dir[]) marker(L.offsetPoint(L.signalT[d], -L.platformSide * 2.5, 0), d === 'east' ? 0xff0000 : 0xff8800, 1, 4);
    marker(L.pointAt(L.stopT).setY(0), 0x00ffff, 0.8, 3);
    // direction arrow at t=0.5 → shows east (increasing t)
    marker(L.pointAt(0.53).setY(0), lineColors[L.id], 2, 2);
  }
  addPolyline(layout.shed.curve.getSpacedPoints(120), 0xffd400, 0.5);
  marker(layout.lines.coast.pointAt(layout.shed.switchT).setY(0), 0xffd400, 2, 2);
  marker(layout.shed.curve.getPointAt(layout.shed.bayT).setY(0), 0x00ffff, 0.8, 3);

  for (const P of Object.values(layout.platforms)) {
    addRect({ center: P.center, size: new THREE.Vector3(P.length, 1, P.width), yaw: P.yaw }, 0xffffff, PLATFORM_TOP + 0.05);
    addRect({ center: P.center, size: new THREE.Vector3(P.canopyLength, 1, P.width), yaw: P.yaw }, 0x888888, PLATFORM_TOP + 0.1);
    for (const b of P.benches) {
      marker(b.pos, 0x8b5a2b, 0.8, 0.8);
      addPolyline([b.pos, b.pos.clone().add(new THREE.Vector3(Math.sin(b.yaw) * 2, 0, Math.cos(b.yaw) * 2))], 0x8b5a2b, PLATFORM_TOP + 0.2);
    }
  }
  addRect({ center: layout.station.center, size: layout.station.size, yaw: layout.station.yaw }, 0xff9a3a, 1.2);
  addRect(layout.forecourt, 0x3ae0e0, 0.2);
  addRect(layout.shed.building, 0xb070ff, 0.3);
  addPolyline([layout.road.a, layout.road.b], 0x999999, 0.15);
  addPolyline([layout.footbridge.a.clone().setY(7), layout.footbridge.b.clone().setY(7)], 0xff40ff);
  marker(layout.footbridge.a, 0xff40ff, 1, 6); marker(layout.footbridge.b, 0xff40ff, 1, 6);
  for (const p of layout.lampPositions) marker(p, 0xffe070, 0.5, 3);
  marker(layout.shed.waterTower, 0x3060ff, 3, 8);
  marker(layout.shed.coalStage, 0x222222, 3, 3);
  marker(layout.shed.turntable, 0x777777, 12, 0.3);
  marker(layout.shed.workerSpot, 0x00ff00, 0.8, 2);
  marker(layout.entrance, 0x00ff88, 2, 3);
  marker(layout.bookingOffice, 0xffff00, 1.2, 2.5);
  for (const t of layout.trees) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(2, 5, 6), basic(0x1e5a1e));
    m.position.set(t.x, 2.5, t.z);
    g.add(m);
  }
  // nav graph
  const n = layout.nav.nodes;
  const staff = new Set(layout.staffNodes);
  for (const [a, b] of layout.nav.edges) addPolyline([n[a].clone().setY(n[a].y + 0.3), n[b].clone().setY(n[b].y + 0.3)], staff.has(a) || staff.has(b) ? 0xffa0a0 : 0x40ff40);
  for (const [id, p] of Object.entries(n)) marker(p, staff.has(id) ? 0xff6060 : 0x00c000, 0.6, 0.6);
  // sample passenger path entrance → P2 far end
  const path = layout.path(layout.entrance, layout.lines.highland.offsetPoint(layout.lines.highland.platformEndT - 0.02, 5, 1));
  addPolyline(path.map((p) => p.clone().setY(p.y + 0.8)), 0xffffff);

  // ── v2 countryside ──
  const R = layout.river;
  const bank = (lat: (s: number) => number, color: number) => {
    const pts: THREE.Vector3[] = [];
    for (let s = 0; s <= R.length; s += 4) pts.push(R.pointAt(s, lat(s), 0.3));
    addPolyline(pts, color);
  };
  bank(() => 0, 0x2060ff);
  bank((s) => R.widthAt(s) / 2, 0x60a0ff);
  bank((s) => -R.widthAt(s) / 2, 0x60a0ff);
  addPolyline(R.towpath.poly.pts, 0xc0a060, 0.3);
  marker(R.weir.pos.clone().setY(0), 0xffffff, 3, 1);
  marker(R.mill.center.clone().setY(0), 0x8a3a2a, 4, 3);
  marker(R.boathouse.center.clone().setY(0), 0x7a5a3c, 3, 2);
  marker(R.ford.pos.clone().setY(0), 0xffffff, 2, 1);
  for (const f of R.fishing) marker(f.pos.clone().setY(0.2), 0xff00ff, 1.2, 1.5);
  for (const m of R.moorings) marker(m.pos.clone().setY(0.2), 0x000000, 1, 1.5);
  for (const e of Object.values(layout.roads.edges)) {
    const pts = e.poly.pts.map((q) => q.clone().setY(0.25));
    addPolyline(pts, e.kind === 'main' ? 0xf0e0a0 : e.kind === 'loop' ? 0x00ffff : 0xd8b070);
    const edgeL: THREE.Vector3[] = [], edgeR: THREE.Vector3[] = [];
    for (let s = 0; s <= e.poly.length; s += 3) { edgeL.push(e.poly.offset(s, -e.width / 2, 0.25)); edgeR.push(e.poly.offset(s, e.width / 2, 0.25)); }
    addPolyline(edgeL, 0x8a7a5a); addPolyline(edgeR, 0x8a7a5a);
  }
  for (const n of Object.values(layout.roads.nodes)) marker(n.pos, n.kind === 'portal' ? 0xff0000 : 0xffff00, 3, 2);
  for (const pth of layout.paths) addPolyline(pth.poly.pts.map((q) => q.clone().setY(q.y + 0.3)), 0xfff0c0);
  for (const b of layout.bridges) marker(b.center, 0xffffff, 4, 2);
  for (const c of layout.crossings) {
    marker(c.center, 0xff2020, 3, 2);
    for (const gl of c.gates) addPolyline([gl.hinge, gl.hinge.clone().addScaledVector(gl.closedRailDir, gl.length)], 0xffffff, 1);
    for (const d of ['east', 'west'] as const) marker(c.gateSignal[d], 0xff0000, 0.8, 4);
  }
  const bcol: Record<string, number> = { pub: 0xffa020, inn: 0xffa020, church: 0xffffff, chapel: 0xffffff, cottage: 0xc06050, terrace: 0xc06050, barn: 0x6a4a2a, farmhouse: 0xc08050, mill: 0x8a3a2a };
  for (const b of layout.buildings) {
    addRect({ center: b.center, size: b.size, yaw: b.yaw }, bcol[b.kind] ?? 0xe0c080, b.center.y + 0.5);
    for (const d of b.doors) marker(d, 0x00ff00, 0.6, 1);
  }
  for (const t of layout.towns) for (const a of t.areas) addRect(a, 0x80ff80, a.center.y + 0.4);
  for (const f of layout.fields) {
    const pts = f.poly.map((q) => new THREE.Vector3(q.x, 0.3, q.y));
    pts.push(pts[0].clone());
    addPolyline(pts, f.kind === 'pasture' ? 0x40ff40 : f.kind === 'wheat' || f.kind === 'barley' ? 0xffe040 : 0xa08040);
    marker(f.gate, 0xffffff, 1, 1);
  }
  for (const p of layout.portals) marker(p.pos.clone().setY(0), p.kind === 'river' ? 0x0040ff : p.kind === 'rail' ? 0x404040 : 0xff00ff, 6, 3);
  for (const l of layout.streetLamps) marker(l, 0xffe070, 0.5, 3);
  const ft = layout.forecourtTraffic;
  for (const r of [ft.dropOff, ...ft.rank, ft.omnibus]) marker(r.pos, 0xff8000, 1, 1.5);
  marker(ft.trough, 0x0080ff, 1, 1);
  addPolyline([new THREE.Vector3(-300, 0.5, layout.shedRoad.z), new THREE.Vector3(-122, 0.5, layout.shedRoad.z)], 0xffd400);
  marker(layout.landmarks.windmill.center, 0xffffff, 3, 6);
  // ground-edge and playfield squares
  for (const h of [layout.terrain.half, layout.terrain.playHalf, layout.terrain.portalR]) addPolyline([[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([x, z]) => new THREE.Vector3(x, 0.5, z)), h === layout.terrain.half ? 0xffffff : h === layout.terrain.playHalf ? 0x00ffff : 0xff00ff);
  return g;
}
