// Core v2 utilities self-test (Integrator). Also a usage example for InstancedRig + horse, applyWind, withDitherFade,
// withDetail/mats.derive, Flow/Mover and origins. Run:
//   node scripts/shot.mjs --port <yours> --out shots/selftest --eval "$(cat scripts/core-selftest.js)" "noui=1&mute=1&time=12&q=high"
// (prefix the eval with "window.__selftestCam=1; " for a close-up perspective camera on the test horses).
const depUrl = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /deps\/three\.js/.test(n));
const THREE = await import(depUrl);
const { InstancedRig } = await import('/src/core/rig.ts');
const { horseGeometry, HORSE_POSE_GLSL } = await import('/src/core/rigs/horse.ts');
const { applyWind } = await import('/src/core/wind.ts');
const { withDitherFade } = await import('/src/core/shaderMods.ts');
const { withDetail } = await import('/src/core/tex.ts');
const { Flow, Mover } = await import('/src/core/movers.ts');
const ctx = __station.ctx;
const L = ctx.layout;
const root = new THREE.Group();
root.name = 'selftest';
ctx.scene.add(root);
// horses along the forecourt / road
const horse = new InstancedRig({ name: 'horse-test', geometry: horseGeometry(), glsl: HORSE_POSE_GLSL, capacity: 8, castShadow: true });
root.add(horse.mesh);
const out = {};
const idx = [];
for (let k = 0; k < 5; k++) {
  const i = horse.alloc(); idx.push(i);
  const p = L.roads.edges.K.poly.offset(8 + k * 5, -2.5); p.y = L.heightAt(p.x, p.z);
  horse.setTransform(i, p, L.roads.edges.K.poly.yawAt(8 + k * 5) , 1);
  horse.setColors(i, [[0x6b4a2e, 0x2a1d14, 0x151515, 0x3a2a1a], [0xd8d0c0, 0x9a9080, 0x222222, 0x3a2a1a], [0x2a2420, 0x1a1410, 0x111111, 0x7a2230]][k % 3]);
  horse.setAnim(i, k * 1.3, [0, 0.5, 1, 1.5, 0.2][k], k === 0 ? 0.5 : 0, Math.sin(k));
  horse.setAux(i, k === 0 ? 2 : 0, 0.5, k === 4 ? 1 : 0, 0.3);
}
// wind-patched boxes (trees) + dithered box + detail textured wall
const geo = new THREE.BoxGeometry(1, 6, 1); geo.translate(0, 3, 0);
const mTree = new THREE.MeshStandardMaterial({ color: 0x4a7a3a, flatShading: true });
const depth = applyWind(ctx, mTree, { mode: 'tree', weight: 'localY', height: 6, amp: 1.5 });
const im = new THREE.InstancedMesh(geo, mTree, 6);
const m4 = new THREE.Matrix4();
for (let k = 0; k < 6; k++) { m4.makeTranslation(72 + k * 3, 0, -4); im.setMatrixAt(k, m4); }
if (depth) im.customDepthMaterial = depth;
im.castShadow = true;
root.add(im);
const fadeU = { value: 0.5 };
const mFade = new THREE.MeshStandardMaterial({ color: 0xaa4444, flatShading: true });
withDitherFade(mFade, fadeU);
const fb = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), mFade); fb.position.set(80, 2, 4); root.add(fb);
const mBrick = ctx.mats.derive(ctx.mats.brick, 'selftest');
withDetail(ctx.tex, mBrick, { pattern: 'thatch', strength: 0.6 });
const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 1), mBrick); wall.position.set(88, 2, 4); root.add(wall);
// movers: 3 carts from E1 to the entrance
const flow = new Flow(L);
const r = L.roadPath('E1', 'entrance');
const movers = [0, 1, 2].map((k) => { const mv = new Mover('M' + k, { length: 6, maxSpeed: 3.5 }, r, 300 + k * 3); flow.add(mv); return mv; });
flow.addStopLine({ edge: 'K', s: 20, dir: -1, active: () => true });
for (let s = 0; s < 400; s++) flow.step(0.5);
out.movers = movers.map((m) => ({ d: +m.d.toFixed(1), v: +m.v.toFixed(2), state: m.state, pos: [+m.pos.x.toFixed(1), +m.pos.y.toFixed(2), +m.pos.z.toFixed(1)] }));
out.routeLen = +r.length.toFixed(1);
out.walkPub = L.footPath(L.buildings.find(b => b.id === 'station:railwayArms').doors[0], L.platforms[1].center).length;
out.origin = !!ctx.origins.legit(L.buildings[0].doors[0], 'people');
out.notOrigin = !!ctx.origins.legit(new THREE.Vector3(30, 0, 60), 'people');
ctx.reg.camera.focus(new THREE.Vector3(76, 0, -2)); if (window.__selftestCam) { const c = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.5, 500); c.position.set(84, 3.2, -12); c.lookAt(76, 1.0, -22); ctx.camera.current = c; }
await new Promise((res) => setTimeout(res, 2500));
out.programs = ctx.renderer.info.programs.length;
return out;
