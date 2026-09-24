#!/usr/bin/env node
// Loads src/core/layout.ts through Vite's SSR loader, runs layout.validate() and prints key facts.
// Usage: node scripts/check-layout.mjs   (exit 1 if validation issues)
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { createLayout } = await server.ssrLoadModule('/src/core/layout.ts');
  const tc = Date.now();
  const L = createLayout();
  console.log(`createLayout(): ${Date.now() - tc} ms`);
  const f = (v) => `(${v.x.toFixed(1)}, ${v.y.toFixed(2)}, ${v.z.toFixed(1)})`;
  const out = [];
  for (const l of Object.values(L.lines)) {
    out.push(`${l.id}: length ${l.length.toFixed(1)} m, start ${f(l.pointAt(0))} end ${f(l.pointAt(1))}, platform ${l.platform} side ${l.platformSide}`);
    out.push(`  platformT ${l.platformStartT.toFixed(4)}..${l.platformEndT.toFixed(4)}  (${f(l.pointAt(l.platformStartT))} → ${f(l.pointAt(l.platformEndT))})`);
    out.push(`  stopT(east,80) ${l.stopT.toFixed(4)}  signalT east ${l.signalT.east.toFixed(4)} ${f(l.pointAt(l.signalT.east))} west ${l.signalT.west.toFixed(4)} ${f(l.pointAt(l.signalT.west))}`);
  }
  for (const p of Object.values(L.platforms)) out.push(`P${p.id}: center ${f(p.center)} yaw ${(p.yaw * 180 / Math.PI).toFixed(1)}° inward ${f(p.inward)} benchYaw ${(p.benches[0].yaw * 180 / Math.PI).toFixed(1)}°`);
  out.push(`station center ${f(L.station.center)} yaw ${(L.station.yaw * 180 / Math.PI).toFixed(1)}° size ${f(L.station.size)}`);
  out.push(`forecourt ${f(L.forecourt.center)} size ${f(L.forecourt.size)}; entrance ${f(L.entrance)}; booking ${f(L.bookingOffice)}`);
  out.push(`footbridge a ${f(L.footbridge.a)} b ${f(L.footbridge.b)} span ${L.footbridge.a.distanceTo(L.footbridge.b).toFixed(1)} m`);
  out.push(`road ${f(L.road.a)} → ${f(L.road.b)}`);
  const s = L.shed;
  out.push(`shed: switchT ${s.switchT.toFixed(4)} ${f(L.lines.coast.pointAt(s.switchT))}, siding length ${s.length.toFixed(1)}, end ${f(s.curve.getPointAt(1))}, bayT ${s.bayT.toFixed(4)}`);
  out.push(`  building ${f(s.building.center)} size ${f(s.building.size)}; water ${f(s.waterTower)} (waterT ${s.waterT.toFixed(3)}); coal ${f(s.coalStage)}; turntable ${f(s.turntable)}; worker ${f(s.workerSpot)}`);
  out.push(`crossing ${f(L.crossing.north)} ↔ ${f(L.crossing.south)}; lamps ${L.lampPositions.length}; trees ${L.trees.length}; nav nodes ${Object.keys(L.nav.nodes).length} edges ${L.nav.edges.length}`);
  // wedge width at platform middles
  const c = L.lines.coast, h = L.lines.highland;
  const midC = c.pointAt((c.platformStartT + c.platformEndT) / 2), midH = h.pointAt((h.platformStartT + h.platformEndT) / 2);
  out.push(`wedge: coast P1-mid → highland ${midC.distanceTo(h.pointAt(h.nearestT(midC))).toFixed(1)} m; highland P2-mid → coast ${midH.distanceTo(c.pointAt(c.nearestT(midH))).toFixed(1)} m`);
  const p = L.path(L.entrance, L.platforms[2].center);
  out.push(`path entrance→P2 centre: ${p.length} pts: ${p.map(f).join(' ')}`);
  // ── v2 countryside ──
  const t0 = Date.now();
  out.push('— countryside —');
  const R = L.river;
  out.push(`river '${R.name}': length ${R.length.toFixed(0)} m, portals up ${f(R.portals.up.pos)} down ${f(R.portals.down.pos)}, weir s=${R.weir.s.toFixed(0)} ${f(R.weir.pos)}`);
  out.push(`  mill ${f(R.mill.center)} wheel ${f(R.mill.wheel)}; boathouse ${f(R.boathouse.center)} door ${f(R.boathouse.door)} slip ${f(R.boathouse.slip)}; ford ${f(R.ford.pos)} (road ${R.ford.road})`);
  out.push(`  fishing: ${R.fishing.map((p) => `${p.id}${f(p.pos)}`).join(' ')}`);
  out.push(`  moorings: ${R.moorings.map((m) => `${m.id}${f(m.pos)}`).join(' ')}; heron ${R.heron.map(f).join(' ')}`);
  for (const b of L.bridges) out.push(`bridge ${b.id} '${b.name}' ${b.kind} carries ${b.carries} over ${b.over} at ${f(b.center)} span ${b.span} deckY ${b.deckY.toFixed(2)} soffit ${b.soffitY.toFixed(2)} angle ${b.angleDeg.toFixed(0)}°${b.line ? ` ${b.line} t=${b.lineT.toFixed(4)}` : ''}${b.road ? ` road ${b.road} s=${b.roadS.toFixed(1)}` : ''}`);
  for (const c of L.crossings) out.push(`level crossing ${c.id} '${c.name}' ${c.line} t=${c.t.toFixed(4)} at ${f(c.center)} road ${c.road} s=${c.roadS.toFixed(1)} trainStopT E ${c.trainStopT.east.toFixed(4)} W ${c.trainStopT.west.toFixed(4)} lodge door ${f(c.lodge.doors[0])}`);
  for (const e of Object.values(L.roads.edges)) out.push(`road ${e.id} '${e.name}' ${e.kind} w${e.width} ${e.a}→${e.b} length ${e.poly.length.toFixed(0)} m, ${f(e.poly.pts[0])} → ${f(e.poly.pts[e.poly.pts.length - 1])}`);
  out.push(`road nodes: ${Object.values(L.roads.nodes).map((n) => `${n.id}${f(n.pos)}`).join(' ')}`);
  for (const p of L.portals) out.push(`portal ${p.id} (${p.kind}) ${f(p.pos)} → ${p.towards}`);
  for (const t of L.towns) out.push(`town ${t.id} '${t.name}' ${f(t.center)}: ${t.buildings.length} buildings, ${t.lamps.length} lamps, areas ${t.areas.map((a) => a.id).join(',')}\n    ${t.buildings.map((b) => `${b.name}[${b.kind}] ${f(b.center)} door ${f(b.doors[0])}`).join('\n    ')}`);
  for (const fl of L.fields) out.push(`field ${fl.id} '${fl.name}' ${fl.kind}${fl.livestock ? ' (' + fl.livestock + ')' : ''} centre ${f(fl.center)} gate ${f(fl.gate)}`);
  out.push(`paths: ${L.paths.map((p) => `${p.id} ${p.poly.length.toFixed(0)} m`).join(', ')}`);
  const ft = L.forecourtTraffic;
  out.push(`forecourt loop ${ft.loop.length.toFixed(1)} m: dropOff ${f(ft.dropOff.pos)} rank ${ft.rank.map((r) => f(r.pos)).join(' ')} omnibus ${f(ft.omnibus.pos)} trough ${f(ft.trough)}`);
  out.push(`mews door ${f(L.mews.door)} yard ${f(L.mews.yard)}; windmill ${f(L.landmarks.windmill.center)}; shed road z=${L.shedRoad.z.toFixed(1)} length ${L.shedRoad.length.toFixed(0)} portal x ${L.shedRoad.portalX}`);
  out.push(`origins: ${L.origins.length} (${L.origins.filter((o) => o.kind === 'door').length} doors), walk graph ${L.walk.nodes.length} nodes, street lamps ${L.streetLamps.length}`);
  const r1 = L.roadPath('entrance', 'mews'), r2 = L.roadPath('E1', 'entrance'), r3 = L.roadPath('entrance', 'W1');
  out.push(`routes: entrance→mews ${r1?.length.toFixed(0)} m (${r1?.legs.map((l) => l.edge).join('>')}), E1→entrance ${r2?.length.toFixed(0)} m, entrance→W1 ${r3?.length.toFixed(0)} m (${r3?.legs.map((l) => l.edge).join('>')})`);
  const pub = L.buildings.find((b) => b.id === 'station:railwayArms');
  const fp = L.footPath(pub.doors[0], L.platforms[1].center);
  out.push(`footPath pub → P1 centre: ${fp.length} pts, ${L.walk.length(pub.doors[0], L.platforms[1].center).toFixed(0)} m`);
  const mb = L.buildings.find((b) => b.town === 'millbridge');
  out.push(`walk ${mb.name} → entrance: ${L.walk.length(mb.doors[0], L.entrance).toFixed(0)} m`);
  out.push(`heightAt: station ${L.heightAt(20, 0).toFixed(2)}, river@road ${L.heightAt(143, -46).toFixed(2)}, mid-river ${L.heightAt(158, 0).toFixed(2)}, Ashcombe ${L.heightAt(215, -55).toFixed(2)}, edge ${L.heightAt(410, 0).toFixed(2)}; queries took ${Date.now() - t0} ms`);
  console.log(out.join('\n'));
  const issues = L.validate();
  console.log(issues.length ? 'ISSUES:\n' + issues.join('\n') : 'validate(): OK');
  process.exitCode = issues.length ? 1 : 0;
} finally {
  await server.close();
}
