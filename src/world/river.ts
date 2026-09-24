import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { WorldMats } from './materials';
import { Kit } from './kit';
import type { Batch } from './batch';
import { stripGeometry, pieces } from './ribbon';
import { groundColor } from './terrain';
import { noise2 } from './env';

const smooth = THREE.MathUtils.smoothstep;
const _rp = new THREE.Vector3();

export interface RiverBuild {
  /** lock gate targets 0 closed .. 1 open (0,1 upper pair; 2,3 lower pair) */
  setGate(i: number, open: number): void;
  setLevel(level01: number): void;
  readonly lockLevel: number;
  readonly wheelRpm: number;
  update(dt: number, clock: { hour: number }): void;
}

/**
 * RIVER LANDSCAPE (world side). The valley ribbon (banks, shingle, bed) at 2 m along layout.river.poly, the
 * towpath surface, weir + foam, the lock chamber walls with 4 animated mitre gates, the mill's undershot wheel,
 * the boathouse slipway, jetty, mooring posts, angler pegs, the ford bed and its stepping stones.
 * The WATER SURFACE belongs to nature (?wwater=1 draws a flat placeholder for world screenshots).
 */
export function buildRiver(ctx: Ctx, wm: WorldMats, root: THREE.Object3D, batch: Batch): RiverBuild {
  const L = ctx.layout;
  const R = L.river;
  const T = L.terrain;
  const m = ctx.mats;
  const H = (x: number, z: number) => L.heightAt(x, z);
  const EDGE = T.playHalf; // 400: beyond it core's grid stops carving; we carve the channel ourselves

  // ───────────── valley ribbon ─────────────
  {
    const rp = R.poly;
    const pts = rp.pts;
    const bed = new THREE.Color(0x4a4636), mud = new THREE.Color(0x6a604c), shingle = new THREE.Color(0x9b907b);
    const bankG = new THREE.Color(0x5b7c40), gc = new THREE.Color();
    const hwAt = (i: number) => R.widthAt(rp.cum[i]) / 2;
    const OUT = [0.7, 2.0, 3.8, 6.0, 9.5, 14.5, 22];
    const latsFor = (hw: number) => {
      const inner = [-hw, -(hw - 1.2), -hw * 0.55, 0, hw * 0.55, hw - 1.2, hw];
      return [...OUT.map((o) => -(hw + o)).reverse(), ...inner, ...OUT.map((o) => hw + o)];
    };
    // lateral samples change with width, so build ring by ring with a fixed count
    const N = OUT.length * 2 + 7;
    const every = 130;
    const ringIdx = pts.map((_, i) => i).filter((i) => i % 2 === 0 || i === pts.length - 1); // 4 m rings
    for (const idxs of pieces(ringIdx, every)) {
      const pos = new Float32Array(idxs.length * N * 3), col = new Float32Array(idxs.length * N * 3);
      idxs.forEach((i, r) => {
        const s = rp.cum[i], hw = hwAt(i), wy = R.waterYAt(s);
        const t = rp.tangent(s);
        const sx = -t.z, sz = t.x;
        const lats = latsFor(hw);
        const beach = smooth(noise2(s * 0.02, 3.7), 0.55, 0.8);
        lats.forEach((lat, j) => {
          const x = pts[i].x + sx * lat, z = pts[i].z + sz * lat;
          let y = H(x, z);
          const a = Math.abs(lat);
          if (Math.max(Math.abs(x), Math.abs(z)) > EDGE - 5) {
            const carve = a < hw ? wy - 0.25 - 0.6 * (1 - (a / hw) ** 2) : wy - 0.25 + (a - hw) * 0.62;
            y = Math.min(y, THREE.MathUtils.lerp(y, carve, smooth(Math.max(Math.abs(x), Math.abs(z)), EDGE - 5, EDGE + 10)));
          }
          // tuck under roads that dip through the valley (the ford approaches, bridge ramps)
          if (T.roadDist(x, z) < 4) {
            _rp.set(x, 0, z);
            const nr = L.nearestRoad(_rp);
            const e = L.roads.edges[nr.edge];
            if (e) y = Math.min(y, e.poly.yAt(nr.s) - 0.12);
          }
          const k = (r * N + j) * 3;
          pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
          // colour: bed → mud / shingle at the water line → damp bank → ground colour at the top
          groundColor(L, x, z, gc);
          const c = gc.clone();
          if (y < wy - 0.12) c.copy(bed);
          else if (y < wy + 0.45) c.copy(mud).lerp(shingle, beach * (a > hw ? 1 : 0.4));
          else {
            const up = smooth(y, wy + 0.45, wy + 2.6);
            c.copy(bankG).lerp(gc, up);
          }
          const nv = noise2(x * 0.3, z * 0.3) * 0.08 - 0.04;
          c.multiplyScalar(1 + nv);
          col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
        });
      });
      const idx: number[] = [];
      for (let r = 0; r < idxs.length - 1; r++) for (let j = 0; j < N - 1; j++) {
        const a = r * N + j, b = a + 1, d = a + N, e = d + 1;
        idx.push(a, b, d, b, e, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, wm.bank);
      mesh.name = `riverBank:${idxs[0]}`;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
    }
    // flat placeholder water for world-only screenshots (nature owns the real surface)
    if (ctx.params.raw.get('wwater') === '1') {
      const wmat = new THREE.MeshStandardMaterial({ color: 0x3d5a6c, roughness: 0.2, metalness: 0.2, flatShading: true });
      wmat.name = 'w_waterPreview';
      for (const ps of pieces(pts, 80)) {
        const g = stripGeometry(ps, [-1, 1].map((k) => k * 9), (_x, _z, cy) => cy);
        const pa = g.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < pa.count; i += 2) {
          const ring = i / 2, p = ps[ring];
          const s = rp.nearest(p.x, p.z).s, hw = R.widthAt(s) / 2 + 0.3;
          const t = rp.tangent(s);
          pa.setXYZ(i, p.x + t.z * hw, p.y, p.z - t.x * hw);
          pa.setXYZ(i + 1, p.x - t.z * hw, p.y, p.z + t.x * hw);
        }
        g.computeVertexNormals();
        const w = new THREE.Mesh(g, wmat);
        w.name = 'waterPreview';
        root.add(w);
      }
    }
  }

  // ───────────── towpath surface ─────────────
  {
    const tp = R.towpath.poly;
    const hw = R.towpath.width / 2;
    for (const ps of pieces(tp.pts, 40)) {
      // the terrace is flat at the towpath's own y; edges tuck just under it (never climb the bank → no spikes)
      const g = stripGeometry(ps, [-hw - 0.3, -hw, 0, hw, hw + 0.3], (_x, _z, cy, lat) => cy + (Math.abs(lat) > hw ? -0.04 : 0.05));
      batch.add(wm.towpath, g);
    }
  }

  // ───────────── weir, lock chamber, gates ─────────────
  const rp = R.poly;
  const side = (s: number) => { const t = rp.tangent(s); return new THREE.Vector3(-t.z, 0, t.x); };
  const lock = R.lock;
  const gateGroup = new THREE.Group();
  gateGroup.name = 'lockGates';
  root.add(gateGroup);
  const leafInfo: { hinge: THREE.Vector3; closed: number; open: number; cur: number; target: number }[] = [];
  let gateMesh: THREE.InstancedMesh | null = null;
  {
    const wS = R.weir.s;
    const hwW = R.widthAt(wS) / 2;
    const up = R.waterYAt(wS - 5), down = R.waterYAt(wS + 5);
    const tW = rp.tangent(wS), nW = side(wS);
    const yawW = Math.atan2(-tW.z, tW.x);
    const lockInner = lock.lateral - lock.width / 2; // chamber wall toward the river centre
    // sill: from the east bank to the lock's inner wall, crest 3 cm above the upper pool
    const lat0 = -hwW - 1.5, lat1 = lockInner;
    const cx = (lat0 + lat1) / 2;
    const cp = R.pointAt(wS, cx);
    batch.cast = false;
    batch.push(cp.x, 0, cp.z, yawW);
    // local x = downstream, local z = +lateral
    const wlen = lat1 - lat0;
    batch.boxB(m.stone, 1.4, up - 0.02 - (up - 1.6), wlen, 0, up - 1.6, 0);
    // downstream apron (sloped glacis)
    const gl = new THREE.Shape();
    gl.moveTo(0.7, up - 0.02); gl.lineTo(3.2, down - 0.2); gl.lineTo(3.2, down - 1.2); gl.lineTo(0.7, down - 1.2); gl.closePath();
    const gg = new THREE.ExtrudeGeometry(gl, { depth: wlen, bevelEnabled: false });
    gg.translate(0, 0, -wlen / 2);
    batch.add(m.stone, gg);
    batch.pop();
    // foam strip along the foot of the glacis
    batch.push(cp.x, 0, cp.z, yawW);
    batch.add(wm.foam, new THREE.BoxGeometry(2.4, 0.12, wlen - 0.3, 6, 1, Math.max(2, Math.round(wlen / 1.5))), batch.mat(3.4, down + 0.04, 0));
    batch.add(wm.foam, new THREE.BoxGeometry(0.5, 0.1, wlen - 0.3, 1, 1, Math.max(2, Math.round(wlen / 1.5))), batch.mat(0.95, up - 0.12, 0, 0, 0, -0.6));
    batch.pop();

    // chamber walls (inner wall = divides chamber from weir pool; outer wall = towpath side)
    const s0 = lock.s0, s1 = lock.s1;
    const wallTop = -1.9;
    for (const lat of [lockInner, lock.lateral + lock.width / 2]) {
      const outer = lat > lock.lateral;
      // the towpath-side wall runs right back to the bank (no strip of water behind it)
      const bankLat = R.widthAt((lock.s0 + lock.s1) / 2) / 2 + 0.8;
      const thick = outer ? Math.max(1.2, bankLat - lat) : 1.6;
      const off = outer ? thick / 2 : -thick / 2;
      const a = R.pointAt(s0 - 2, lat + off), b = R.pointAt(s1 + 2, lat + off);
      const mid = a.clone().lerp(b, 0.5);
      const len = a.distanceTo(b);
      const yaw = Math.atan2(-(b.z - a.z), b.x - a.x);
      batch.cast = true;
      batch.push(mid.x, 0, mid.z, yaw);
      batch.boxB(m.stone, len, wallTop - (down - 1.3), thick, 0, down - 1.3, 0);
      batch.boxB(m.cream, len + 0.2, 0.18, thick + 0.25, 0, wallTop, 0);
      batch.pop();
      // gate recesses / bollards
      for (const sg of [s0 + 1, s1 - 1]) {
        const p = R.pointAt(sg, lat + (outer ? thick + 0.4 : -thick - 0.4));
        batch.cyl(m.iron, 0.14, 0.18, 0.6, 6, p.x, wallTop + 0.1, p.z);
      }
    }
    // lower cill + upper cill (stone thresholds under the gates)
    for (const sg of [s0 + 1, s1 - 1]) {
      const p = R.pointAt(sg, lock.lateral);
      const t = rp.tangent(sg);
      batch.push(p.x, 0, p.z, Math.atan2(-t.z, t.x));
      batch.boxB(m.stone, 0.8, 0.6, lock.width, 0, down - 1.3, 0);
      batch.pop();
    }
    batch.cast = false;
    void nW;

    // gate leaves: InstancedMesh (pivot at the hinge, local +x along the leaf)
    const leafLen = (lock.width / 2) / Math.cos(0.35);
    const k = new Kit();
    const leafH = wallTop - 0.15 - (down - 1.1);
    k.addC(wm.paint, 0x3b332c, new THREE.BoxGeometry(leafLen, leafH, 0.28), k.mat(leafLen / 2, (down - 1.1) + leafH / 2, 0));
    for (let i = 1; i < 4; i++) k.addC(wm.paint, 0x2a241f, new THREE.BoxGeometry(leafLen - 0.1, 0.12, 0.34), k.mat(leafLen / 2, (down - 1.1) + (leafH * i) / 4, 0));
    // balance beam over the coping (extends back past the hinge onto the bank) + white tip
    k.addC(wm.paint, 0x3b332c, new THREE.BoxGeometry(leafLen + 4.2, 0.32, 0.34), k.mat((leafLen - 4.2) / 2, wallTop + 0.35, 0));
    k.addC(wm.paint, 0xe9e4d6, new THREE.BoxGeometry(0.9, 0.34, 0.36), k.mat(-3.8, wallTop + 0.35, 0));
    // paddle gear post on the leaf
    k.addC(wm.paint, 0x1f2e27, new THREE.BoxGeometry(0.16, 0.9, 0.16), k.mat(leafLen * 0.6, wallTop + 0.45, 0.2));
    const leafGeo = k.build('leaf').children[0] as THREE.Mesh;
    gateMesh = new THREE.InstancedMesh(leafGeo.geometry, wm.paint, 4);
    gateMesh.name = 'lockGateLeaves';
    gateMesh.castShadow = true;
    gateMesh.receiveShadow = true;
    lock.gates.forEach((h, i) => {
      const sg = i < 2 ? s0 + 1 : s1 - 1;
      const t = rp.tangent(sg), n = side(sg);
      const inner = i % 2 === 0; // gates[0], [2] on the inner (river-centre) wall
      const toCentre = n.clone().multiplyScalar(inner ? 1 : -1);
      const closed = toCentre.clone().multiplyScalar(Math.cos(0.35)).addScaledVector(t, -Math.sin(0.35)).normalize();
      const open = t.clone().negate();
      const yawOf = (d: THREE.Vector3) => Math.atan2(-d.z, d.x);
      // unwrap so the leaf swings the short way (≈70°)
      let yo = yawOf(open);
      const yc = yawOf(closed);
      while (yo - yc > Math.PI) yo -= 2 * Math.PI;
      while (yo - yc < -Math.PI) yo += 2 * Math.PI;
      leafInfo.push({ hinge: h.clone().setY(0), closed: yc, open: yo, cur: 0, target: 0 });
    });
    gateGroup.add(gateMesh);
  }
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _one = new THREE.Vector3(1, 1, 1);
  const placeGates = () => {
    if (!gateMesh) return;
    leafInfo.forEach((g, i) => {
      _e.set(0, THREE.MathUtils.lerp(g.closed, g.open, g.cur), 0);
      _q.setFromEuler(_e);
      _m.compose(g.hinge, _q, _one);
      gateMesh!.setMatrixAt(i, _m);
    });
    gateMesh.instanceMatrix.needsUpdate = true;
    gateMesh.computeBoundingSphere();
  };
  placeGates();

  // ───────────── mill wheel (undershot) ─────────────
  const wheel = new THREE.Group();
  wheel.name = 'millWheel';
  {
    const k = new Kit();
    const r = R.mill.wheelR, w = 1.6;
    for (const sx of [-w / 2, w / 2]) {
      k.addC(wm.paint, 0x4a3a2c, new THREE.TorusGeometry(r, 0.12, 4, 18), k.mat(sx, 0, 0, Math.PI / 2));
      k.addC(wm.paint, 0x4a3a2c, new THREE.TorusGeometry(r * 0.45, 0.08, 4, 10), k.mat(sx, 0, 0, Math.PI / 2));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI;
        k.addC(wm.paint, 0x5a4a38, new THREE.BoxGeometry(0.1, 2 * r, 0.12), k.mat(sx, 0, 0, 0, a, 0));
      }
    }
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      k.addC(wm.paint, 0x6a5640, new THREE.BoxGeometry(w + 0.1, 0.7, 0.08), k.mat(0, Math.cos(a) * (r - 0.25), Math.sin(a) * (r - 0.25), 0, a, 0));
    }
    k.addC(wm.paint, 0x1f2e27, new THREE.CylinderGeometry(0.18, 0.18, w + 1.6, 8), k.mat(0, 0, 0, 0, 0, Math.PI / 2));
    const g = k.build('wheel');
    for (const c of g.children) { (c as THREE.Mesh).castShadow = true; c.matrixAutoUpdate = true; }
    const spin = new THREE.Group();
    spin.add(g);
    wheel.add(spin);
    wheel.position.copy(R.mill.wheel);
    const ax = R.mill.wheelAxis;
    wheel.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), ax);
    wheel.userData.spin = spin;
    root.add(wheel);
    // stone race walls either side of the wheel + an axle bearing block on the mill side
    batch.cast = true;
    const wp = R.mill.wheel;
    const yaw = Math.atan2(-ax.z, ax.x);
    batch.push(wp.x, 0, wp.z, yaw);
    batch.boxB(m.stone, 0.6, 1.9, 7, -1.4, -4.2, 0); // river-side race wall stays low so the wheel shows
    batch.boxB(m.stone, 0.6, 2.4, 7, 1.4, -4.2, 0);
    batch.boxB(m.stone, 1.2, 1.2, 1.2, -1.6, -2.6, 0);
    batch.pop();
    batch.cast = false;
  }

  // ───────────── boathouse slipway, jetty, moorings, angler pegs, ford ─────────────
  {
    const bh = R.boathouse;
    const t = rp.tangent(bh.slipS);
    const n = side(bh.slipS);
    // slipway from the boathouse front (water side) down into the water
    const top = bh.center.clone().addScaledVector(n, bh.size.z / 2 - 0.2);
    top.y = H(top.x, top.z);
    const bot = bh.slip.clone().addScaledVector(n, 1.5);
    const yawS = Math.atan2(-(bot.z - top.z), bot.x - top.x);
    const len = Math.hypot(bot.x - top.x, bot.z - top.z);
    const drop = top.y - (bh.slip.y - 0.4);
    batch.push(top.x, top.y, top.z, yawS);
    const sl = new THREE.Shape();
    sl.moveTo(0, 0); sl.lineTo(len + 1.5, -drop); sl.lineTo(len + 1.5, -drop - 0.3); sl.lineTo(0, -0.3); sl.closePath();
    const sg = new THREE.ExtrudeGeometry(sl, { depth: 3.4, bevelEnabled: false });
    sg.translate(0, 0, -1.7);
    batch.add(m.wood, sg);
    for (const sz of [-1.9, 1.9]) batch.add(m.stone, new THREE.BoxGeometry(len + 1.5, 0.5, 0.4), batch.mat((len + 1.5) / 2, -drop / 2 - 0.3, sz, 0, 0, -Math.atan2(drop, len + 1.5)));
    batch.pop();
    void t;
    // jetty on posts
    const ja = R.jetty.a, jb = R.jetty.b;
    const jl = ja.distanceTo(jb), jyaw = Math.atan2(-(jb.z - ja.z), jb.x - ja.x);
    const jm = ja.clone().lerp(jb, 0.5);
    batch.push(jm.x, 0, jm.z, jyaw);
    batch.boxB(m.wood, jl, 0.12, 1.8, 0, R.jetty.y - 0.12, 0);
    batch.detail = true;
    for (let x = -jl / 2; x <= jl / 2 + 0.01; x += 0.45) batch.box(m.sleeper, 0.04, 0.13, 1.82, x, R.jetty.y - 0.06, 0);
    batch.detail = false;
    for (let x = -jl / 2 + 0.3; x <= jl / 2; x += 3) for (const z of [-0.8, 0.8]) batch.cyl(m.sleeper, 0.12, 0.14, 2.4, 6, x, R.jetty.y - 2.3, z);
    for (const x of [-jl / 2 + 0.3, jl / 2 - 0.3]) batch.cyl(m.sleeper, 0.12, 0.12, 0.8, 6, x, R.jetty.y, 0.8);
    batch.pop();
    // mooring posts (with iron rings)
    for (const mo of R.moorings) {
      const y = Math.max(mo.pos.y, H(mo.pos.x, mo.pos.z));
      batch.cyl(m.sleeper, 0.16, 0.2, 1.1, 6, mo.pos.x, y - 0.2, mo.pos.z);
      batch.add(m.iron, new THREE.TorusGeometry(0.16, 0.035, 4, 8), batch.mat(mo.pos.x, y + 0.55, mo.pos.z, 0, Math.PI / 2));
    }
    // angler pegs: a 2 × 2 m trodden pad (planked on the towpath side) with a peg board
    for (const f of R.fishing) {
      const y = f.pos.y;
      batch.push(f.pos.x, y, f.pos.z, f.yaw);
      batch.boxB(m.wood, 2.0, 0.1, 2.0, 0, -0.04, 0);
      batch.detail = true;
      for (let i = -2; i <= 2; i++) batch.box(m.sleeper, 0.04, 0.11, 2.02, i * 0.4, 0.01, 0);
      batch.detail = false;
      batch.boxB(m.wood, 0.12, 0.9, 0.12, 0.9, 0, -0.9);
      batch.addC(wm.paint, f.best ? 0xe0b84a : 0xe8dcc0, new THREE.BoxGeometry(0.34, 0.26, 0.04), batch.mat(0.9, 0.95, -0.86));
      batch.pop();
    }
    // ford: gravel bed across the channel + stepping stones + a depth post
    const fd = R.ford;
    if (fd.width > 0) {
      const e = L.roads.edges[fd.road];
      const s0 = fd.roadS - R.widthAt(fd.s) / 2 - 5, s1 = fd.roadS + R.widthAt(fd.s) / 2 + 5;
      const ps = e.poly.slice(s0, s1, 1);
      const g = stripGeometry(ps, [-fd.width / 2, 0, fd.width / 2], (_x, _z, cy) => Math.max(cy, fd.bedY) + 0.02);
      batch.add(wm.lane, g);
      for (const st of R.ford.stones) {
        const g2 = new THREE.CylinderGeometry(0.42, 0.5, 0.9, 6);
        batch.add(m.stone, g2, batch.mat(st.x, st.y - 0.35, st.z, noise2(st.x, st.z) * 3));
      }
      const pp = R.pointAt(fd.s + 7, R.widthAt(fd.s) / 2 + 1.2);
      batch.cyl(wm.white, 0.08, 0.08, 1.8, 6, pp.x, H(pp.x, pp.z) - 0.4, pp.z);
      for (let i = 0; i < 4; i++) batch.box(wm.dark, 0.18, 0.03, 0.18, pp.x, H(pp.x, pp.z) - 0.1 + i * 0.3, pp.z);
    }
  }

  // ───────────── animation state ─────────────
  let lockLevel = 1, wheelRpm = 0, wheelAngle = 0;
  const api: RiverBuild = {
    setGate(i, open) { const g = leafInfo[i]; if (g) g.target = THREE.MathUtils.clamp(open, 0, 1); },
    setLevel(l) { lockLevel = THREE.MathUtils.clamp(l, 0, 1); },
    get lockLevel() { return lockLevel; },
    get wheelRpm() { return wheelRpm; },
    update(dt, clock) {
      let moved = false;
      for (const g of leafInfo) {
        const d = g.target - g.cur;
        if (Math.abs(d) > 1e-4) { g.cur += Math.sign(d) * Math.min(Math.abs(d), dt / 6); moved = true; }
      }
      if (moved) placeGates();
      // the mill works by day (stops at night and when the race freezes)
      const atm = ctx.reg.atmosphere;
      const ice = atm?.iceAmount ?? 0;
      const working = clock.hour > 6 && clock.hour < 19.5 && ice < 0.6;
      const target = working ? 4.2 : 0;
      wheelRpm += (target - wheelRpm) * Math.min(1, dt * 0.25);
      wheelAngle -= (wheelRpm / 60) * Math.PI * 2 * dt;
      (wheel.userData.spin as THREE.Object3D).rotation.x = wheelAngle;
    },
  };
  return api;
}

