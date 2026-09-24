import * as THREE from 'three';
import type { Ctx, System } from '../core/types';
import type { SimClock } from '../core/clock';
import { MOTION_SECONDS_PER_SIM_MINUTE } from '../core/clock';
import type { TrafficAPI, VehicleKind, VehicleInfo, TripRequest, PersonSpec, PersonRole, CrossingState } from '../core/apis';
import type { RoadRoute } from '../core/countryside';
import { Flow, Mover } from '../core/movers';
import { InstancedRig } from '../core/rig';
import { horseGeometry, HORSE_POSE_GLSL, HORSE_STRIDE } from '../core/rigs/horse';
import { withSnowCap } from '../core/shaderMods';
import { Router, type Pt } from './routes';
import { KINDS, type KindSpec, bodyOffset } from './kinds';
import { Vehicle, blendedLane, type Purpose, type Stop, type HorseState } from './vehicle';
import { GROUP_GEOMS, BODY_POSE_GLSL, wheelGeometry, WHEEL_POSE_GLSL } from './geom';
import { Crossing } from './crossing';

/**
 * TRAFFIC (v2): road vehicles and their horses, the Crown Mews depot, the forecourt cab rank / drop-off /
 * omnibus stand, timetabled carts, background traffic, the rare Benz motorwagen, and the LC1 level crossing.
 *
 * NO POP-IN: vehicles spawn only at road portals (off the ground edge, never while on screen) or INSIDE depot
 * buildings (Crown Mews, barns, stables, the engine house) and drive out through the door; they despawn the
 * same way. Every spawn / despawn is audited. NO STATIONARY LIFE: horses always breathe, swish, nod and stamp;
 * nothing parks forever (every stand has a limit).
 * Rendering: 3 kind-masked body rigs + 1 horse rig + 1 wheel rig + 1 lamp mesh + 1 crossing rig = 7 draws max.
 */

const HORSE_COATS = [0x5a3a24, 0x3a2618, 0x7a5232, 0x2a1e18, 0x8a6a4a, 0x6a6660, 0xb8b0a0, 0x4a3020, 0x1e1a18];
const MANES = [0x1e1612, 0x2a1e16, 0x3a2a1e, 0xd8d0c0];
const TACK = 0x1c1614;

interface Trip { kind: VehicleKind; purpose: Purpose; from: string; stops: StopSpec[]; to: string; riders?: PersonSpec[]; tag?: string; decor?: TripRequest['decor']; request?: TripRequest }
interface StopSpec { at: string; dwell: number; kind?: Stop['kind'] }

export function createTraffic(ctx: Ctx): System {
  const L = ctx.layout;
  const K = ctx.quality.knobs;
  const tier = ctx.quality.tier;
  const router = new Router(L);
  const flow = new Flow(L);
  const root = new THREE.Group();
  root.name = 'traffic';
  ctx.scene.add(root);
  const rng = mulberry(ctx.params.seed * 7331 + 17);

  const capV = K.caps.vehicles, capH = K.caps.horses;
  const MSPM = MOTION_SECONDS_PER_SIM_MINUTE;

  // ───────────── rendering ─────────────
  const bodies = GROUP_GEOMS.map((g, i) => new InstancedRig({ name: `traffic-body${i}`, geometry: g(), glsl: BODY_POSE_GLSL, capacity: capV + 2, castShadow: true, receiveShadow: true, material: { roughness: 0.7 } }));
  const horsesRig = new InstancedRig({ name: 'traffic-horses', geometry: horseGeometry(), glsl: HORSE_POSE_GLSL, capacity: capH + 4, castShadow: tier !== 'low', material: { roughness: 0.8 } });
  const wheelsRig = new InstancedRig({ name: 'traffic-wheels', geometry: wheelGeometry(), glsl: WHEEL_POSE_GLSL, capacity: (capV + 2) * 4, castShadow: tier !== 'low', material: { roughness: 0.7 } });
  for (const r of [...bodies, horsesRig]) withSnowCap(r.mesh.material as THREE.Material, ctx.mats.uniforms.uSnow, 0.8);
  for (const r of [...bodies, horsesRig, wheelsRig]) { r.mesh.count = 0; root.add(r.mesh); }
  // carriage lamps (emissive, no lighting) — 1 draw
  const lampCap = (capV + 2) * 3;
  const lampGeo = new THREE.OctahedronGeometry(0.13, 0);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, lampCap);
  lamps.name = 'traffic-lamps';
  lamps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  lamps.setColorAt(0, new THREE.Color(1, 1, 1));
  lamps.count = 0;
  lamps.frustumCulled = false;
  let lampsDirty = false;
  lamps.onBeforeRender = () => { if (lampsDirty) { lamps.instanceMatrix.needsUpdate = true; if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true; lampsDirty = false; } };
  root.add(lamps);

  const crossing = new Crossing(ctx, flow, root, () => vehicles);

  // ───────────── state ─────────────
  const vehicles: Vehicle[] = [];
  const byId = new Map<string, Vehicle>();
  let nextId = 1;
  let frame = 0, lastRenderFrame = -1, subInFrame = 0;
  let motionNow = 0;
  let peopleRide: boolean | null = null; // null = untested
  let rideProbe: { id: string; v: Vehicle; t: number } | null = null;
  const host = {
    get frame() { return frame; },
    laneAt: (route: RoadRoute, d: number) => blendedLane(router, route, d),
    groundY: (x: number, z: number, fb: number) => { const h = L.heightAt(x, z); return Number.isFinite(h) ? Math.max(h, fb - 0.6) : fb; },
    stopPos: (v: Vehicle, out: THREE.Vector3) => (v.stop ? posOfPt(v.stop.pt, out) : out.copy(v.originPos)),
  };
  /** cab rank queue (front first), incl. cabs still driving to it. Slots are packed nose-to-tail by real length. */
  const rankQ: string[] = [];
  const RANK_FRONT = Math.max(...L.forecourtTraffic.rank.map((r) => r.s));
  const RANK_BACK = L.forecourtTraffic.dropOff.s + 3.2;
  let dropOwner: string | null = null, omniOwner: string | null = null;

  // depots (vehicle doors) — keep only those whose inside path fits the vehicle
  const depotDoors = L.origins.filter((o) => o.kind === 'door' && o.for.includes('vehicles'));
  const mewsDoor = depotDoors.find((o) => o.building === 'ashcombe:mews' && o.pos.distanceTo(L.mews.door) < 0.5)?.id ?? depotDoors.find((o) => o.building === 'ashcombe:mews')?.id ?? 'portal:E1';
  const doorOf = (building: string) => depotDoors.find((o) => o.building === building)?.id;
  const farmDoors = ['wyke:barn', 'coldharbour:cartshed', 'coldharbour:barn', 'coldharbour:stables', 'glenmoor:barn']
    .map((b) => doorOf(b) ?? depotDoors.find((o) => o.building?.startsWith(b.split(':')[0]) && o.building !== 'ashcombe:mews')?.id)
    .filter((x): x is string => !!x);
  const allFarmDoors = depotDoors.filter((o) => o.building && !o.building.startsWith('ashcombe')).map((o) => o.id);
  const engineDoor = depotDoors.find((o) => o.building === 'ashcombe:engine' || (o.building ?? '').includes('engine'))?.id;
  const portals = ['E1', 'E2', 'S1', 'W1', 'N1', 'NW1'];
  const buildingById = new Map(L.buildings.map((b) => [b.id, b]));
  const findB = (pred: (b: typeof L.buildings[number]) => boolean) => L.buildings.find(pred);
  const pub = findB((b) => b.town === 'station' && b.kind === 'pub');
  const crown = findB((b) => b.town === 'ashcombe' && b.kind === 'inn');
  const chemist = findB((b) => b.town === 'ashcombe' && b.kind === 'shop');
  const postOffice = findB((b) => b.town === 'ashcombe' && b.kind === 'post');
  const coalOffice = findB((b) => b.town === 'station' && b.kind === 'office');
  const bakery = findB((b) => b.town === 'ashcombe' && b.kind === 'bakery');
  const bakeryDoor = bakery ? L.origins.find((o) => o.kind === 'door' && o.building === bakery.id)?.id : undefined;
  // the baker keeps his handcart inside the bakery: its door is a (handcart-sized) vehicle origin too
  if (bakeryDoor) {
    const bo = L.origins.find((o) => o.id === bakeryDoor)!;
    ctx.origins.add({ id: `yard:${bakeryDoor}`, kind: 'door', owner: 'traffic', radius: 2.5, for: ['vehicles'], building: bo.building, pos: (o) => o.copy(bo.pos), open: () => true });
  }
  const ashDoors = L.buildings.filter((b) => b.town === 'ashcombe' && (b.kind === 'cottage' || b.kind === 'terrace' || b.kind === 'house' || b.kind === 'bakery'));

  // ───────────── helpers ─────────────
  const now = () => ctx.clock.minutes;
  const hourOf = () => ctx.clock.hour;
  const people = () => ctx.reg.people;
  const trains = () => ctx.reg.trains;
  const atmo = () => ctx.reg.atmosphere;
  const emit = ctx.bus.emit.bind(ctx.bus);
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _sc = new THREE.Vector3();
  const _col = new THREE.Color();

  /** resolve a place string to a routing point */
  function ptOf(place: string, asStop: boolean): Pt | null {
    const ft = L.forecourtTraffic;
    if (place === 'forecourt:drop') return { k: 'loop', s: ft.dropOff.s };
    if (place === 'forecourt:omnibus') return { k: 'loop', s: ft.omnibus.s };
    if (place.startsWith('forecourt:rank')) return { k: 'loop', s: RANK_FRONT };
    if (place === 'mews') return asStop ? { k: 'edge', edge: 'MW', s: router.poly('MW')!.length - 4 } : { k: 'door', origin: mewsDoor };
    const node = place.startsWith('portal:') ? place.slice(7) : place;
    if (L.roads.nodes[node]) return { k: 'node', id: node };
    // a small vehicle (handcart) kept inside an ordinary shop/house: 'yard:<door origin id>'
    if (place.startsWith('yard:')) {
      const id = place.slice(5);
      if (!asStop && router.spurFor(id)) return { k: 'door', origin: id };
      const o = L.origins.find((x) => x.id === id);
      return o ? router.roadPt(o.pos) : null;
    }
    if (place.startsWith('door:')) {
      const o = L.origins.find((x) => x.id === place);
      if (!o) return null;
      if (!asStop && o.for.includes('vehicles') && router.spurFor(place)) return { k: 'door', origin: place };
      return router.roadPt(o.pos);
    }
    if (place.startsWith('building:')) {
      const b = buildingById.get(place.slice(9));
      return b ? router.roadPt(b.doors[0] ?? b.center) : null;
    }
    return null;
  }
  function posOfPt(p: Pt, out: THREE.Vector3): THREE.Vector3 {
    if (p.k === 'node') return router.nodePos(p.id, out);
    if (p.k === 'door') { const o = ctx.origins.get(p.origin); return o ? o.pos(out) : out.set(0, 0, 0); }
    if (p.k === 'edge') return out.copy(router.poly(p.edge)!.at(p.s));
    return out.copy(L.forecourtTraffic.loop.at(p.s));
  }
  function stopKind(place: string): Stop['kind'] {
    if (place === 'forecourt:drop') return 'drop';
    if (place.startsWith('forecourt:rank')) return 'rank';
    if (place === 'forecourt:omnibus') return 'omnibus';
    return 'kerb';
  }
  function kerbFor(p: Pt): { kerb: number; pullIn: boolean } {
    if (p.k === 'loop') return { kerb: -2.0, pullIn: true };
    if (p.k === 'edge') {
      const e = L.roads.edges[p.edge];
      if (e && e.width >= 8) return { kerb: -(e.width / 2 - e.width / 4 - 0.95), pullIn: true };
      return { kerb: -0.55, pullIn: false };
    }
    return { kerb: 0, pullIn: false };
  }
  const liveCount = () => { let n = 0; for (const v of vehicles) if (v.phase !== 'queued' && v.phase !== 'gone') n++; return n; };
  const CYCLE_EXTRA = 2;
  const liveCycles = () => { let n = 0; for (const v of vehicles) if (v.purpose === 'cycle' && v.phase !== 'queued' && v.phase !== 'gone') n++; return n; };
  const liveHorses = () => { let n = 0; for (const v of vehicles) if (v.phase !== 'queued' && v.phase !== 'gone') n += v.spec.horses; return n; };
  const count = (f: (v: Vehicle) => boolean) => { let n = 0; for (const v of vehicles) if (v.phase !== 'gone' && f(v)) n++; return n; };

  /** estimated sim minutes to drive a route */
  function travelMin(route: RoadRoute, spec: KindSpec): number {
    const vAvg = Math.min(spec.maxSpeed, 3.3 * spec.speedScale) * 0.78;
    return route.length / Math.max(0.5, vAvg) / MSPM;
  }

  // ───────────── creation ─────────────
  function makeVehicle(t: Trip): Vehicle | null {
    const originPt = ptOf(t.from, false);
    const sinkPt = ptOf(t.to, false);
    if (!originPt || !sinkPt) return null;
    // long vehicles need room inside a depot
    if (originPt.k === 'door' && router.insideLength(originPt.origin) < KINDS[t.kind].length + 0.6) return null;
    if (sinkPt.k === 'door' && router.insideLength(sinkPt.origin) < KINDS[t.kind].length + 0.6) return null;
    const id = `V${nextId++}`;
    const v = new Vehicle(id, t.kind, t.purpose, t.from, originPt, sinkPt, rng(), host);
    v.decor = t.decor; v.tag = t.tag; v.request = t.request ?? null;
    if (t.riders) v.pendingRiders = t.riders.slice();
    for (const s of t.stops) {
      const p = ptOf(s.at, true);
      if (!p) continue;
      const k = kerbFor(p);
      v.stops.push({ id: s.at, pt: p, d: 0, kerb: k.kerb, pullIn: k.pullIn, dwell: s.dwell, kind: s.kind ?? stopKind(s.at) });
    }
    posOfPt(originPt, v.originPos);
    posOfPt(sinkPt, v.sinkPos);
    applyDecor(v);
    v.queuedAt = now();
    vehicles.push(v);
    byId.set(id, v);
    return v;
  }
  function applyDecor(v: Vehicle) {
    const nh = v.spec.horses;
    const coatBase = v.decor === 'wedding' ? [0xd8d4cc, 0xc8c4bc] : v.decor === 'funeral' ? [0x151313] : v.decor === 'royal' ? [0x5a3a24, 0x4a2e1c] : HORSE_COATS;
    const pairCoat = coatBase[Math.floor(rng() * coatBase.length)];
    for (let i = 0; i < nh; i++) {
      const coat = nh >= 2 && rng() < 0.75 ? pairCoat : coatBase[Math.floor(rng() * coatBase.length)];
      v.horses.push({ stampT: 1 + rng() * 6, stampLeg: 0, stampPh: 0, swishT: rng() * 3, swishAmp: 0.3, nodPh: rng() * 6, grazeT: 0, graze: 0, ear: 0, phase: rng() * 6, coat, mane: coat === 0xb8b0a0 || coat === 0xd8d4cc ? 0xd8d0c0 : MANES[Math.floor(rng() * 3)], tack: v.decor === 'royal' ? 0x8a1a1a : TACK });
    }
    if (v.decor === 'wedding') v.colours = [0xe8e4dc, 0xd9b95a, 0x3a3a3a, 0xffffff];
    else if (v.decor === 'funeral') v.colours = [0x121212, 0x6a6a6a, 0x0a0a0a, 0x1a1a1a];
    else if (v.decor === 'royal') v.colours = [0x3a2a5a, 0xd9b95a, 0x1a1a22, 0x8a1a1a];
    else if (v.decor === 'circus') v.colours = [0xb5473a, 0xe0b84a, 0x2a2a2a, 0x2a4a8a];
    if (v.spec.kind === 'motorwagen') v.colours = [0x1a1a1a, 0xc9a24a, 0x7a8088, 0x7a2a22];
  }

  /** try to put a queued vehicle on the road; returns true when spawned */
  const isCycle = (k: VehicleKind) => k === 'bicycle' || k === 'pennyfarthing';
  function trySpawn(v: Vehicle): boolean {
    // cyclists ride on a small allowance of their own (no horses, tiny, cheap), so they appear even when the carts are busy
    if (isCycle(v.spec.kind) && v.purpose === 'cycle') { if (liveCount() >= capV + CYCLE_EXTRA || count((o) => o.purpose === 'cycle' && o.phase !== 'queued') >= CYCLE_EXTRA) return false; }
    else if (liveCount() - liveCycles() >= capV) return false;
    // background & farm traffic never takes the last few slots: they are kept for travellers' cabs and the omnibus
    else if (priorityOf(v) >= 3 && liveCount() - liveCycles() >= capV - paxReserve()) return false;
    if (liveHorses() + v.spec.horses > capH) return false;
    if (priorityOf(v) >= 3 && liveHorses() + v.spec.horses > capH - paxReserve()) return false;
    const op = v.originPt;
    // portals: never while the portal is on screen; doors: always legit (walls hide the inside)
    if (op.k === 'node' && ctx.view.isVisible(v.originPos, 10)) return false;
    // room at the origin
    for (const o of vehicles) {
      if (o === v || o.phase === 'queued' || o.phase === 'gone' || !o.mover) continue;
      if (o.mover.pos.distanceTo(v.originPos) < v.spec.length + 6) return false;
      if (o.bodyPos.distanceTo(v.originPos) < v.spec.length + 4) return false;
    }
    const pts: Pt[] = [op, ...v.stops.map((s) => s.pt), v.sink];
    const plan = router.plan(pts);
    if (!plan) { v.phase = 'gone'; return false; }
    v.stops.forEach((s, i) => {
      s.d = plan.marks[i + 1];
      // kerb stops: draw up so the vehicle's door (not its horse's nose) is level with the building door
      if (s.pt.k === 'edge' && s.id.startsWith('building:')) {
        const shift = bodyOffset(v.spec) - v.spec.door[0];
        const next = v.stops[i + 1] ? plan.marks[i + 2] : plan.route.length;
        if (shift > 0 && s.d + shift < next - 1 && plan.route.locate(s.d + shift).edge === s.pt.edge) s.d += shift;
      }
    });
    const startD = op.k === 'door' ? Math.min(v.spec.length + 0.2, router.insideLength(op.origin) - 0.3) : 0;
    const m = new Mover(v.id, { length: v.spec.length, maxSpeed: v.spec.maxSpeed, speedScale: v.spec.speedScale * weatherSpeed(), gap: 2.4, accel: v.spec.horses ? 0.7 : 1.0 }, plan.route, startD);
    v.mover = m;
    m.stopAt = v.stops[0] ? v.stops[0].d : null;
    flow.add(m); v.inFlow = true;
    v.phase = 'driving';
    v.stopIdx = 0;
    allocSlots(v);
    // origin for people (riders step in/out while stopped; spawnInside while spawning)
    const vo = v;
    v.originId = `veh:${v.id}`;
    v.removeOrigin = ctx.origins.add({
      id: v.originId, kind: 'vehicle', owner: 'traffic', radius: 3, for: ['people'],
      pos: (o) => vo.doorPoint(o), open: () => vo.phase === 'parked' || vo.spawning,
    });
    ctx.origins.audit('traffic', 'spawn', 'vehicles', posOfPt(op, _v1), `${v.spec.kind} ${v.id} @${v.origin}`);
    emit('vehicle:spawned', { vehicleId: v.id, kind: v.spec.kind });
    seatPeople(v);
    return true;
  }

  /** driver (+ conductor) and requested riders are created INSIDE the vehicle at its origin, then seated */
  function seatPeople(v: Vehicle) {
    if (peopleRide === false) { v.pendingRiders.length = 0; return; }
    const P = people();
    if (!P) return;
    v.spawning = true;
    try {
      const crewSpecs: PersonSpec[] = [{ role: v.spec.driver, seed: v.seed, tag: `traffic:${v.id}` }];
      if (v.spec.kind === 'omnibus') crewSpecs.push({ role: 'conductor', seed: v.seed + 1, tag: `traffic:${v.id}` });
      if (v.spec.kind === 'carriage4') crewSpecs.push({ role: 'coachman', seed: v.seed + 2 }, { role: 'coachman', seed: v.seed + 3 });
      const crew = P.spawnInside(v.originId, crewSpecs.slice(0, v.crewSeats.length)) ?? [];
      if (crew.length) { P.ride(crew, v.crewAnchor, crew.map((_, i) => i)); v.crew = crew; }
      if (v.pendingRiders.length) {
        const ids = P.spawnInside(v.originId, v.pendingRiders.slice(0, v.paxSeats.length)) ?? [];
        if (ids.length) { P.ride(ids, v.anchor, ids.map((_, i) => seatOrder(v, i))); for (const id of ids) v.riders.add(id); }
        v.pendingRiders.length = 0;
      }
      if (peopleRide === null && crew.length && !rideProbe) rideProbe = { id: crew[0], v, t: motionNow };
    } catch (e) { reportOnce('seat', e); }
    v.spawning = false;
    syncRiders(v);
  }
  /** fill visible (open) seats first on the omnibus top deck, hidden seats in closed cabs */
  function seatOrder(v: Vehicle, i: number): number { return i % Math.max(1, v.paxSeats.length); }
  function syncRiders(v: Vehicle) { v.info.riders = [...v.crew, ...v.riders]; }

  function allocSlots(v: Vehicle) {
    v.bodySlot = bodies[v.spec.group].alloc();
    if (v.bodySlot >= 0) bodies[v.spec.group].setColors(v.bodySlot, v.colours);
    v.horseSlots = [];
    for (let i = 0; i < v.spec.horses; i++) {
      const s = horsesRig.alloc();
      v.horseSlots.push(s);
      if (s >= 0) { const h = v.horses[i]; horsesRig.setColors(s, [h.coat, h.mane, 0x2a2420, h.tack]); }
    }
    v.wheelSlots = [];
    for (const w of v.spec.wheels) {
      const s = wheelsRig.alloc();
      v.wheelSlots.push(s);
      if (s >= 0) wheelsRig.setColors(s, [v.decor === 'wedding' ? 0xe8e4dc : w.col, 0x222222, 0, 0]);
    }
  }
  function freeSlots(v: Vehicle) {
    if (v.bodySlot >= 0) bodies[v.spec.group].free(v.bodySlot);
    for (const s of v.horseSlots) horsesRig.free(s);
    for (const s of v.wheelSlots) wheelsRig.free(s);
    v.bodySlot = -1; v.horseSlots = []; v.wheelSlots = [];
  }

  function despawn(v: Vehicle) {
    if (v.phase === 'gone') return;
    const P = people();
    if (v.mover) {
      try {
        if (v.riders.size || v.crew.length) {
          P?.disembark(v.id, { then: 'dismiss' });
          P?.disembark(`${v.id}:crew`, { then: 'dismiss' });
        }
      } catch (e) { reportOnce('disembark', e); }
      ctx.origins.audit('traffic', 'despawn', 'vehicles', posOfPt(v.sink, _v1), `${v.spec.kind} ${v.id} @${sinkName(v)}`);
      emit('vehicle:despawned', { vehicleId: v.id });
      if (v.inFlow) flow.remove(v.mover);
    }
    v.inFlow = false;
    v.phase = 'gone';
    v.info.state = 'gone';
    v.removeOrigin?.(); v.removeOrigin = null;
    freeSlots(v);
    releaseStops(v);
  }
  function sinkName(v: Vehicle): string { const p = v.sink; return p.k === 'node' ? p.id : p.k === 'door' ? p.origin : 'road'; }
  function releaseStops(v: Vehicle) {
    const qi = rankQ.indexOf(v.id); if (qi >= 0) rankQ.splice(qi, 1);
    if (dropOwner === v.id) dropOwner = null;
    if (omniOwner === v.id) omniOwner = null;
  }

  // ───────────── driving logic ─────────────
  function stepVehicle(v: Vehicle, dtM: number, simDt: number) {
    const m = v.mover!;
    const st = v.stop;
    // stop targets & queuing behind an occupied single stop (drop-off / omnibus stand)
    if (v.phase === 'driving') {
      if (st) {
        if (st.kind === 'rank') st.d = rankSlotD(v, st.d);
        let target = st.d;
        const owner = st.kind === 'drop' ? dropOwner : st.kind === 'omnibus' ? omniOwner : null;
        if (owner && owner !== v.id) {
          const o = byId.get(owner);
          if (o && o.phase === 'parked') target = st.d - o.spec.length - 1.8;
          else if (st.kind !== 'rank') target = st.d - 10;
        }
        // rank: queue behind a parked cab in the bay ahead is fine (they're at the kerb)
        m.stopAt = target;
        if (m.state === 'stopped' && Math.abs(m.d - st.d) < 0.3 && (!owner || owner === v.id)) arrive(v, st);
      } else {
        m.stopAt = null;
        if (m.state === 'arrived' || m.d >= m.route.length - 0.05) { despawn(v); return; }
      }
    } else if (v.phase === 'parked' && st) {
      if (st.kind === 'rank') rankCreep(v, st, dtM);
      standLogic(v, st, simDt);
    }
    // off-screen and far from the view: hurry (nobody sees it; keeps the few vehicle slots cycling)
    if (motionNow - v.hurryCheck > 0.5) {
      v.hurryCheck = motionNow;
      const far = !ctx.view.isVisible(m.pos, 40) && ctx.view.distToFocus(m.pos.x, m.pos.z) > 90;
      const k = far && v.boltT <= 0 ? 2.6 : 1;
      if (k !== v.hurry) { v.hurry = k; m.spec.maxSpeed = v.spec.maxSpeed * k; m.spec.speedScale = v.spec.speedScale * weatherSpeed() * k; m.spec.accel = (v.spec.horses ? 0.7 : 1.0) * k; }
    }
    // holds: scared horses, yielding to animals on the road, waiting to pull out
    m.hold = v.phase === 'parked' || v.scareT > 0 || v.yieldHold || v.pullOutWait;
    if (v.scareT > 0) v.scareT = Math.max(0, v.scareT - dtM);
    if (v.rearT > 0) v.rearT = Math.max(0, v.rearT - dtM);
    if (v.boltT > 0) {
      v.boltT = Math.max(0, v.boltT - dtM);
      m.spec.maxSpeed = v.spec.maxSpeed * (v.boltT > 0 ? 1.7 : 1);
      m.spec.speedScale = v.spec.speedScale * weatherSpeed() * (v.boltT > 0 ? 1.6 : 1);
      v.hurry = 0; // re-evaluate the off-screen hurry
    }
    // motorwagen: puttering scares horses nearby
    if (v.spec.kind === 'motorwagen' && v.phase === 'driving' && motionNow - v.lastMotor > 3) {
      v.lastMotor = motionNow;
      emit('audio:cue', { cue: 'motor', pos: m.pos.clone(), volume: 0.8 });
      scare(m.pos, 22, v);
    }
    // info
    const q = m.route.locate(m.d);
    v.info.pos.copy(m.pos); v.info.yaw = m.yaw; v.info.speed = m.v; v.info.edge = q.edge; v.info.s = q.s;
    v.info.state = v.phase === 'parked' ? (st?.kind === 'rank' ? 'waiting' : 'loading') : m.v < 0.05 ? 'stopped' : 'driving';
    v.info.stop = v.phase === 'parked' && st ? stopLabel(st) : undefined;
    const sk = v.sink;
    v.info.dest = st ? st.id : sk.k === 'node' ? sk.id : sk.k === 'door' ? sk.origin : undefined;
  }
  function stopLabel(st: Stop): string { return st.id; }
  /** route distance of this cab's current rank slot (front slot at the head of the rank; the rest nose-to-tail) */
  function rankSlotD(v: Vehicle, fallback: number): number {
    const i = rankQ.indexOf(v.id);
    if (i < 0) return fallback;
    let s = RANK_FRONT;
    for (let j = 0; j < i; j++) { const o = byId.get(rankQ[j]); s -= (o ? o.spec.length : 6) + 1.1; }
    const d = router.distOf(v.mover!.route, 'FC', s, 0);
    return d >= 0 ? d : fallback;
  }
  /** room on the rank for one more cab of this kind */
  function rankRoom(kind: VehicleKind): boolean {
    let s = RANK_FRONT;
    for (const id of rankQ) { const o = byId.get(id); s -= (o ? o.spec.length : 6) + 1.1; }
    return s - KINDS[kind].length >= RANK_BACK;
  }
  /** creep up the rank (cabs are pulled in at the kerb, out of the flow) */
  function rankCreep(v: Vehicle, st: Stop, dtM: number) {
    const m = v.mover!;
    const tgt = rankSlotD(v, st.d);
    st.d = tgt;
    const gap = tgt - m.d;
    if (gap > 0.05) {
      const vmax = Math.min(1.3, Math.sqrt(2 * 0.8 * gap));
      m.v = Math.min(vmax, m.v + 0.6 * dtM);
      const dd = Math.min(gap, m.v * dtM);
      m.d += dd; m.odometer += dd;
      m.place(false, L, dtM);
    } else { m.v = 0; }
  }

  function arrive(v: Vehicle, st: Stop) {
    v.phase = 'parked';
    v.parkedAt = now();
    v.standUntil = Math.max(v.standUntil, now() + st.dwell);
    if (st.kind === 'drop') dropOwner = v.id;
    if (st.kind === 'omnibus') omniOwner = v.id;
    if (st.pullIn && v.inFlow) { flow.remove(v.mover!); v.inFlow = false; }
    emit('vehicle:arrived', { vehicleId: v.id, stop: stopLabel(st) });
    // riders step down at drop-offs, the omnibus stand and at kerb stops that are a trip's destination
    const P = people();
    const isDest = v.request && v.stopIdx === 0;
    if (v.riders.size && (st.kind === 'drop' || st.kind === 'omnibus' || isDest)) {
      try {
        const then = st.kind === 'drop' || st.kind === 'omnibus' ? 'passenger' : (v.purpose === 'omnibus' ? 'wander' : 'wander');
        const out = P?.disembark(v.id, { then }) ?? [];
        for (const id of out) v.riders.delete(id);
        if (!out.length && peopleRide === false) v.riders.clear();
      } catch (e) { reportOnce('disembark', e); }
      syncRiders(v);
    }
  }

  function standLogic(v: Vehicle, st: Stop, _simDt: number) {
    const t = now();
    let go = t >= v.standUntil;
    if (st.kind === 'rank') {
      const front = rankQ.indexOf(v.id) <= 0;
      if (!front) { v.standUntil = Math.max(v.standUntil, t + 4); if (!v.hiredBy) return; }
      if (v.hiredBy) {
        // leave once the fare is aboard (or give up on them)
        const P = people();
        const inside = P?.get(v.hiredBy)?.riding === v.id || seatOccupied(v);
        if (inside && v.boardedAt < 0) v.boardedAt = motionNow;
        go = (v.boardedAt >= 0 && motionNow - v.boardedAt > 2.5) || t - v.hiredAt > 20;
        if (go && v.boardedAt < 0) { v.hiredBy = null; go = false; v.standUntil = t + 5; }
        if (go && !front) go = false;
        if (go) { v.riders.add(v.hiredBy!); syncRiders(v); retarget(v, pick(cabDestinations())); }
      } else if (go) {
        // unhired too long: off to try the Crown
        retarget(v, 'mews');
      }
    } else if (st.kind === 'drop') {
      // riders off (seats no longer asked for) or 3 sim min
      const occupied = seatOccupied(v);
      go = t >= v.standUntil && (!occupied || t - v.parkedAt > 3);
      if (go && v.purpose === 'cab' || go && v.purpose === 'request' && v.spec.kind !== 'omnibus' && isCab(v.spec.kind) && !v.request?.then) {
        // join the rank if it needs cabs, else leave
        if (rankRoom(v.spec.kind) && rankWant() > rankHave()) { rankQ.push(v.id); insertStop(v, 'forecourt:rank', rankDwell(), 'rank'); v.purpose = 'cab'; }
      }
    } else if (st.kind === 'omnibus') {
      go = t >= v.window[1] && t >= v.parkedAt + 3;
      // hard cap: a bus never stands more than ~35 sim min (it leaves half full; the next run picks up the rest)
      if (t - v.parkedAt > 35) go = true;
    } else if (st.kind === 'wait') {
      go = t >= v.standUntil;
    }
    if (!go) return;
    leaveStop(v);
  }

  function leaveStop(v: Vehicle) {
    const st = v.stop!;
    const m = v.mover!;
    // pull out only into a gap
    if (!v.inFlow) {
      if (!v.pullOutWait) v.pullOutSince = now();
      if (!gapClear(v, now() - v.pullOutSince)) { v.pullOutWait = true; return; }
      flow.add(m); v.inFlow = true;
      // flow.add snapped the yaw; keep driving from where we are
    }
    v.pullOutWait = false;
    if (st.kind === 'drop' && dropOwner === v.id) dropOwner = null;
    if (st.kind === 'omnibus' && omniOwner === v.id) omniOwner = null;
    if (st.kind === 'rank') { const qi = rankQ.indexOf(v.id); if (qi >= 0) rankQ.splice(qi, 1); }
    emit('vehicle:departed', { vehicleId: v.id, stop: stopLabel(st) });
    v.phase = 'driving';
    v.stopIdx++;
    const nx = v.stop;
    m.stopAt = nx ? nx.d : null;
    m.state = 'moving';
  }

  /** nothing coming from behind on this edge & direction, and nothing just ahead */
  function gapClear(v: Vehicle, waited = 0): boolean {
    const m = v.mover!;
    const me = m.route.locate(m.d);
    for (const o of vehicles) {
      if (o === v || !o.inFlow || !o.mover) continue;
      const q = o.mover.route.locate(o.mover.d);
      if (q.edge !== me.edge || q.dir !== me.dir) continue;
      const behind = (me.s - q.s) * me.dir;
      // after a short wait the queue behind lets it out: creeping cabs (and, after a longer wait, anything that can
      // still brake) hold back for the pulling-out vehicle — the forecourt never starves a bus at the stand
      const ov = o.mover.v;
      const yields = waited > 4 ? behind > 2.5 + ov * ov / 3 : waited > 1.5 ? behind > 3 && (ov < 2.6 || o.mover.state === 'waiting') : false;
      if (behind > -0.5 && behind < v.spec.length + 9 && ov > 0.2 && !yields) return false;
      if (behind <= -0.5 && -behind < o.spec.length + 3) return false;
    }
    return true;
  }

  function seatOccupied(v: Vehicle): boolean {
    for (const si of v.paxSeats) if (v.seatSeen[si] >= frame - 3) return true;
    return false;
  }

  /** replace everything after the current stop with a new destination (keeps the route prefix) */
  function retarget(v: Vehicle, place: string, extraStops: StopSpec[] = []) {
    const m = v.mover!;
    const sink = ptOf(place, false);
    if (!sink) return;
    const newStops: Stop[] = [];
    for (const s of extraStops) {
      const p = ptOf(s.at, true); if (!p) continue;
      const k = kerbFor(p);
      newStops.push({ id: s.at, pt: p, d: 0, kerb: k.kerb, pullIn: k.pullIn, dwell: s.dwell, kind: s.kind ?? stopKind(s.at) });
    }
    const plan = router.replanFrom(m.route, m.d + 0.01, [...newStops.map((s) => s.pt), sink]);
    if (!plan) return;
    newStops.forEach((s, i) => { s.d = plan.marks[i]; });
    // keep the current stop (we're standing at it) then the new ones
    const cur = v.stops[v.stopIdx];
    v.stops = [...v.stops.slice(0, v.stopIdx), ...(cur ? [cur] : []), ...newStops];
    v.sink = sink; posOfPt(sink, v.sinkPos);
    const d = m.d;
    m.setRoute(plan.route, d);
    if (v.phase === 'parked') m.stopAt = d; else m.stopAt = v.stop ? v.stop.d : null;
  }

  /** add a stop after the current one (same route continues) — used for drop-off → rank */
  function insertStop(v: Vehicle, place: string, dwell: number, kind: Stop['kind'], bay?: number) {
    const p = ptOf(place, true);
    if (!p) return;
    const m = v.mover!;
    const d0 = p.k === 'loop' ? router.distOf(m.route, 'FC', p.s, m.d) : -1;
    if (d0 < 0) return;
    const k = kerbFor(p);
    const st: Stop = { id: place, pt: p, d: d0, kerb: k.kerb, pullIn: k.pullIn, dwell, kind, bay };
    v.stops.splice(v.stopIdx + 1, 0, st);
  }

  /** 0 event / special requests · 1 passenger requests · 2 omnibus & rank cabs & timetabled · 3 background */
  function priorityOf(v: Vehicle): number {
    if (v.purpose === 'request') return v.request?.tag === 'passenger' ? 1 : 0;
    if ((v.purpose === 'cab' && v.hiredBy) || v.purpose === 'omnibus') return 1;
    if (v.purpose === 'background' || v.purpose === 'farm' || v.purpose === 'cycle') return 3;
    return 2;
  }
  function isStale(v: Vehicle, age: number): boolean {
    switch (v.purpose) {
      case 'background': case 'farm': case 'cycle': return age > 60;
      case 'cab': return age > (v.hiredBy ? 45 : 25);
      case 'omnibus': return now() > v.window[1] - 4;
      case 'coal': case 'dray': case 'milk': case 'baker': return age > 90;
      case 'request': return v.request?.tag === 'passenger' ? age > 70 : false;
      default: return false;
    }
  }
  /** can a new passenger request be served soon? (else people's planner walks them in from a door instead) */
  function canServe(kind: VehicleKind): boolean {
    let queuedReq = 0;
    for (const v of vehicles) if (v.phase === 'queued' && priorityOf(v) <= 1) queuedReq++;
    const free = capV - (liveCount() - liveCycles());
    const freeH = capH - liveHorses();
    // a few trips may queue at the depot / portal for the next free slot (they spawn ahead of all background traffic)
    return queuedReq < Math.max(0, free) + 3 && (KINDS[kind].horses === 0 || freeH >= KINDS[kind].horses || queuedReq < 3);
  }
  /** vehicle (and horse) slots kept free of background / farm traffic so passenger trips can always get on the road */
  function paxReserve(): number {
    const h = hourOf();
    return h >= 6 && h < 22 ? Math.min(3, Math.max(1, Math.floor(capV * 0.25))) : 1;
  }

  // ───────────── cabs & rank ─────────────
  const isCab = (k: VehicleKind) => k === 'hansom' || k === 'growler';
  const rankDwell = () => 18 + rng() * 14;
  function rankWant(): number {
    const h = hourOf();
    const peak = (h >= 7 && h < 9.5) || (h >= 16.5 && h < 19);
    const want = h >= 7 && h < 21 ? (peak ? 4 : 3) : (h >= 5.5 && h < 7) || (h >= 21 && h < 23.5) ? 2 : 1;
    return Math.min(want, Math.max(1, Math.floor(capV * 0.26)));
  }
  function rankHave(): number { return count((v) => v.purpose === 'cab' && !v.hiredBy && v.stops.some((s, i) => s.kind === 'rank' && i >= v.stopIdx)); }

  function cabDestinations(): string[] { return ['E1', 'E1', 'mews', 'mews', 'NW1', 'E2', 'S1', 'W1', 'N1']; }
  let lastCabDispatch = -99;
  function dispatchCab(hiredBy: string | null): Vehicle | null {
    const kind: VehicleKind = rng() < 0.65 ? 'hansom' : 'growler';
    if (!rankRoom(kind)) return null;
    const from = rng() < 0.72 ? 'mews' : 'E1';
    const v = makeVehicle({ kind, purpose: 'cab', from, stops: [{ at: 'forecourt:rank', dwell: rankDwell(), kind: 'rank' }], to: pick(cabDestinations()) });
    if (!v) return null;
    rankQ.push(v.id);
    if (hiredBy) { v.hiredBy = hiredBy; v.hiredAt = now() + 60; }
    lastCabDispatch = now();
    return v;
  }
  function rankTick() {
    const h = hourOf();
    if (rankHave() < rankWant() && now() - lastCabDispatch > 4 && (h >= 5 || h < 1)) dispatchCab(null);
  }

  // ───────────── omnibus ─────────────
  const busTravel = (() => { const p = router.plan([ptOf('mews', false)!, ptOf('forecourt:omnibus', true)!]); return p ? travelMin(p.route, KINDS.omnibus) : 90; })();
  let pendingOmni: PersonSpec[] = [];
  let pendingOmniAt = 0;
  let lastBusCheck = -99;
  function busTick() {
    const t = now();
    if (t - lastBusCheck < 1) return;
    lastBusCheck = t;
    const h = hourOf();
    let deps: ReturnType<TrafficAPI['list']> extends never ? never : { time: number; expected?: number; status: string }[] = [];
    try { deps = trains()?.timetable(10) ?? []; } catch { deps = []; }
    const wins: [number, number][] = [];
    const day0 = Math.floor(t / 1440) * 1440;
    for (const d of deps) {
      if (d.status === 'Departed' || d.status === 'Cancelled') continue;
      const E = d.expected ?? d.time;
      const A = E - 4;
      const hA = ((A - day0) / 60 + 24) % 24;
      if (hA < 6.5 || hA > 22.5) continue;
      if (E + 6 < t) continue;
      wins.push([A - 8, E + 6]);
    }
    wins.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const w of wins) {
      const last = merged[merged.length - 1];
      if (last && w[0] <= last[1] + 12 && w[1] - last[0] <= 50) last[1] = Math.max(last[1], w[1]); else merged.push([w[0], w[1]]);
    }
    const buses = vehicles.filter((v) => v.purpose === 'omnibus' && v.phase !== 'gone');
    const peak = (h >= 7 && h < 9.5) || (h >= 16.5 && h < 19);
    const maxBuses = peak ? 3 : 2;
    for (const w of merged) {
      // extend a bus already covering / about to cover this window
      const cover = buses.find((b) => b.window[0] <= w[1] && b.window[1] >= w[0] - 10 && (b.phase !== 'parked' || b.stopIdx === 0) && !leftStand(b));
      if (cover) { if (w[1] - cover.window[0] <= 60) cover.window[1] = Math.max(cover.window[1], w[1]); continue; }
      const busy = buses.filter((b) => !leftStand(b)).length;
      if (busy >= maxBuses) continue;
      if (t >= w[0] - busTravel - 8 && t < w[1] - busTravel) {
        const v = dispatchBus([w[0], w[1]]);
        if (v) buses.push(v);
      }
    }
    // riders waiting for a bus with no run coming soon: special run
    // (never seen yet, so a stale booking simply lapses)
    if (pendingOmni.length && t - pendingOmniAt > 60) pendingOmni = [];
    const out = buses.filter((b) => !leftStand(b)).length;
    if (pendingOmni.length && !buses.some((b) => b.phase === 'queued') && out <= maxBuses && h >= 6 && h < 23) dispatchBus([t + busTravel, t + busTravel + 8]);
  }
  const leftStand = (b: Vehicle) => b.stopIdx > 0 && b.stops[0]?.kind === 'omnibus';
  function dispatchBus(win: [number, number]): Vehicle | null {
    const crownStop = crown ? `building:${crown.id}` : null;
    const v = makeVehicle({ kind: 'omnibus', purpose: 'omnibus', from: 'mews', stops: [{ at: 'forecourt:omnibus', dwell: 3, kind: 'omnibus' }, ...(crownStop ? [{ at: crownStop, dwell: 2 }] : [])], to: 'mews' });
    if (!v) return null;
    v.window = win;
    if (pendingOmni.length) { v.pendingRiders.push(...pendingOmni.splice(0, v.paxSeats.length)); }
    const n = vehicles.filter((b) => b.purpose === 'omnibus').length;
    v.colours = KINDS.omnibus.colours[n % KINDS.omnibus.colours.length];
    if (v.bodySlot >= 0) bodies[1].setColors(v.bodySlot, v.colours);
    return v;
  }

  // ───────────── timetabled & background traffic ─────────────
  const plannedToday = new Set<string>();
  let dayKey = -1;
  let motorDay = false, motorAt = 0;
  let farmPlan: number[] = [];
  function dailyPlan() {
    const d = ctx.clock.day;
    if (d === dayKey) return;
    dayKey = d;
    plannedToday.clear();
    const r = mulberry(ctx.params.seed * 101 + d * 977);
    motorDay = r() < 0.2 || ctx.params.raw.get('motor') === '1';
    motorAt = (ctx.params.raw.get('motor') === '1' ? hourOf() + 0.05 : 10 + r() * 6) * 60;
    const nFarm = 4 + Math.floor(r() * 7) + (ctx.clock.weekday === 3 ? 4 : 0);
    const tod0 = now() - Math.floor(now() / 1440) * 1440;
    farmPlan = Array.from({ length: nFarm }, () => (6 + r() * 12) * 60).sort((a, b) => a - b).filter((t) => t >= tod0 - 20);
  }
  function once(key: string, atMin: number, travel: number, f: () => void) {
    const tod = now() - Math.floor(now() / 1440) * 1440;
    if (plannedToday.has(key)) return;
    if (tod >= atMin - travel && tod < atMin - travel + 90) { plannedToday.add(key); f(); }
  }
  /** order a delivery round (building kerb stops) so the vehicle works along the road instead of doubling back */
  function orderRound(from: string, blds: { id: string }[], to: string, dwell: () => number, head: StopSpec[] = []): StopSpec[] {
    const withS = blds.map((b) => { const p = ptOf(`building:${b.id}`, true); return { b, k: p && p.k === 'edge' ? `${p.edge}` : '', s: p && p.k === 'edge' ? p.s : 0 }; });
    const o = ptOf(from, false), t = ptOf(to, false);
    let best: StopSpec[] = [], bestLen = Infinity;
    for (const sign of [1, -1]) {
      const sorted = withS.slice().sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : (a.s - b.s) * sign));
      const stops: StopSpec[] = [...head, ...sorted.map((x) => ({ at: `building:${x.b.id}`, dwell: dwell() }))];
      if (!o || !t) return stops;
      const pts = [o, ...stops.map((st) => ptOf(st.at, true)).filter((p): p is Pt => !!p), t];
      const plan = router.plan(pts);
      const len = plan ? plan.route.length : 1e9;
      if (len < bestLen) { bestLen = len; best = stops; }
    }
    return best;
  }
  function kerbOf(b: { doors: THREE.Vector3[]; id: string } | undefined): string | null { return b ? `building:${b.id}` : null; }
  function timedTick() {
    dailyPlan();
    const wd = ctx.clock.weekday;
    const w = weatherKind();
    // milk float: to the 06:10 up train with churns, then the Ashcombe doorstep round
    const milkFrom = doorOf('wyke:barn') ?? 'NW1';
    once('milk', 6 * 60 + 10, 110, () => {
      const round = orderRound('forecourt:omnibus', ashDoors.slice(0, 5), 'E1', () => 3);
      makeVehicle({ kind: 'milkfloat', purpose: 'milk', from: milkFrom, stops: [{ at: 'forecourt:drop', dwell: 8 }, ...round], to: 'E1' });
    });
    // mail cart meets the last train (and the night mail) — waits at the drop-off
    once('mail', 22 * 60 + 30, 80, () => {
      const v = makeVehicle({ kind: 'mailcart', purpose: 'mail', from: 'mews', stops: [{ at: 'forecourt:drop', dwell: 35 }, ...(postOffice ? [{ at: `building:${postOffice.id}`, dwell: 4 }] : [])], to: 'mews' });
      if (v) v.standUntil = 0;
    });
    // brewery dray Tuesday & Friday: E1 → The Crown → Railway Arms → round the forecourt → E1
    if (wd === 1 || wd === 4) once('dray', 10 * 60, 0, () => {
      makeVehicle({ kind: 'dray', purpose: 'dray', from: 'E1', stops: [...(crown ? [{ at: kerbOf(crown)!, dwell: 12 }] : []), ...(pub ? [{ at: kerbOf(pub)!, dwell: 12 }] : [])], to: 'E1' });
    });
    // coal cart on weekdays: loads at Pell & Sons, delivers round Ashcombe, back to the mews (three rounds)
    if (wd < 5) for (const [i, at] of [[0, 9 * 60], [1, 11 * 60 + 20], [2, 13 * 60 + 40]] as const) once(`coal${i}`, at, 60, () => {
      const r = orderRound(coalOffice ? `building:${coalOffice.id}` : 'mews', ashDoors.slice(i * 3, i * 3 + 3), 'mews', () => 4);
      makeVehicle({ kind: 'coalcart', purpose: 'coal', from: 'mews', stops: [...(coalOffice ? [{ at: `building:${coalOffice.id}`, dwell: 6 }] : []), ...r], to: 'mews' });
    });
    // Hobbs the baker pushes his handcart round Ashcombe's doors (morning & afternoon), back into the bakery
    if (bakeryDoor && wd !== 6) for (const [i, at] of [[0, 7 * 60], [1, 15 * 60 + 30]] as const) once(`bake${i}`, at, 0, () => {
      const near = ashDoors.filter((b) => b.kind !== 'bakery' && b.center.distanceTo(bakery!.center) < 70).sort(() => rng() - 0.5).slice(0, 3);
      makeVehicle({ kind: 'handcart', purpose: 'baker', from: `yard:${bakeryDoor}`, stops: orderRound(`yard:${bakeryDoor}`, near, `yard:${bakeryDoor}`, () => 1.5 + rng() * 2), to: `yard:${bakeryDoor}` });
    });
    // farm carts
    const tod = now() % 1440;
    while (farmPlan.length && tod >= farmPlan[0]) {
      farmPlan.shift();
      const from = pick(allFarmDoors.length ? [...farmDoors, ...allFarmDoors] : portals);
      const kind: VehicleKind = wd === 3 || (ctx.clock.day % 365 > 160 && ctx.clock.day % 365 < 240 && rng() < 0.4) ? pick(['farmcart', 'haywain', 'farmcart']) : 'farmcart';
      const dest = rng() < 0.5 ? (rng() < 0.5 ? 'forecourt:drop' : `building:${pick(ashDoors).id}`) : null;
      makeVehicle({ kind, purpose: 'farm', from, stops: dest ? [{ at: dest, dwell: 4 + rng() * 6 }] : [], to: rng() < 0.5 ? from : pick(portals) });
    }
    // the horseless carriage (rare): E1 → the chemist for ligroin → the forecourt → E1
    if (motorDay && w !== 'snow' && w !== 'storm') once('motor', motorAt, 0, () => {
      makeVehicle({ kind: 'motorwagen', purpose: 'motor', from: 'E1', stops: [...(chemist ? [{ at: `building:${chemist.id}`, dwell: 8 }] : []), { at: 'forecourt:drop', dwell: 10 }], to: 'E1' });
    });
  }

  let bgAcc = 0;
  let cycAcc = 0;
  function cycleTick(simDt: number) {
    const h = hourOf();
    const w = weatherKind();
    if (h < 6.5 || h > 20.5 || (w !== 'clear' && w !== 'overcast')) return;
    cycAcc += (2.2 / 60) * simDt; // ~2 cyclists per sim hour
    if (cycAcc < 1) return;
    cycAcc -= 1;
    if (count((o) => o.purpose === 'cycle') >= CYCLE_EXTRA) return;
    const kind: VehicleKind = h > 9 && h < 18 && rng() < 0.3 ? 'pennyfarthing' : 'bicycle';
    const r = rng();
    const trip: Trip = r < 0.45
      ? { kind, purpose: 'cycle', from: pick(['E1', 'NW1', 'S1']), stops: [{ at: 'forecourt:drop', dwell: 1 + rng() * 2 }], to: pick(['E1', 'NW1', 'N1', 'E2']) }
      : { kind, purpose: 'cycle', from: pick(portals), stops: rng() < 0.5 ? [{ at: `building:${pick(ashDoors).id}`, dwell: 2 + rng() * 4 }] : [], to: pick(portals) };
    if (trip.from === trip.to) trip.to = trip.from === 'E1' ? 'NW1' : 'E1';
    makeVehicle(trip);
  }

  function backgroundTick(simDt: number) {
    const h = hourOf();
    const w = weatherKind();
    const wd = ctx.clock.weekday;
    let rate = h < 5 ? 0.3 : h < 7 ? 2 : h < 10 ? 7 : h < 17 ? 5.5 : h < 20 ? 5 : h < 23 ? 2 : 0.6; // trips per sim hour
    if (wd === 3 && h >= 7 && h < 14) rate *= 1.8;
    if (wd === 6) rate *= 0.6;
    if (w === 'snow' || w === 'storm') rate *= 0.4; else if (w === 'rain' || w === 'fog') rate *= 0.75;
    bgAcc += (rate / 60) * simDt;
    if (bgAcc < 1) return;
    bgAcc -= 1;
    // only with spare room: passengers, the omnibus and the rank come first
    let waitingHi = 0;
    for (const v of vehicles) if (v.phase === 'queued' && priorityOf(v) <= 2) waitingHi++;
    if (waitingHi > 0 || capV - (liveCount() - liveCycles()) < 2) return;
    // leave room for the rank, the omnibus and timetabled carts
    const reserved = Math.min(capV - 2, rankWant() + 1 + 1);
    if (count((v) => v.purpose === 'background' || v.purpose === 'farm') >= capV - reserved) return;
    const fair = w === 'clear' || w === 'overcast';
    const kinds: [VehicleKind, number][] = [
      ['gig', 3], ['landau', h >= 10 && h < 18 ? 1.5 : 0.3], ['growler', 1], ['farmcart', 2], ['coalcart', 0.4],
      ['bicycle', fair && h > 7 && h < 20 ? 2 : 0], ['pennyfarthing', fair && h > 9 && h < 18 ? 0.8 : 0], ['haywain', 0.4], ['dray', 0.2],
    ];
    const kind = weighted(kinds);
    // routes that show off the station: through K and the forecourt, Wyke Lane, Ashcombe, Millbridge
    const r = rng();
    let trip: Trip;
    if (r < 0.3) trip = { kind, purpose: 'background', from: pick(['E1', 'mews', 'NW1', 'N1']), stops: [{ at: 'forecourt:drop', dwell: 2 + rng() * 3 }], to: pick(['E1', 'NW1', 'mews', 'E2']) };
    else if (r < 0.55) trip = { kind, purpose: 'background', from: pick(['E1', 'E2', 'S1']), stops: [{ at: `building:${pick(ashDoors).id}`, dwell: 3 + rng() * 6 }], to: pick(['NW1', 'N1', 'W1', 'mews']) };
    else if (r < 0.8) trip = { kind, purpose: 'background', from: pick(['NW1', 'N1', 'W1', 'S1']), stops: pub && rng() < 0.4 ? [{ at: `building:${pub.id}`, dwell: 4 + rng() * 8 }] : [], to: pick(['E1', 'E2', 'mews', 'S1']) };
    else trip = { kind, purpose: 'background', from: pick(portals), stops: [], to: pick(portals) };
    if (trip.from === trip.to) trip.to = trip.from === 'E1' ? 'NW1' : 'E1';
    if (kind === 'bicycle' || kind === 'pennyfarthing') { if (trip.from === 'mews') trip.from = 'E1'; if (trip.to === 'mews') trip.to = 'E1'; }
    const v = makeVehicle(trip);
    if (v && (kind === 'gig' || kind === 'landau') && rng() < 0.6) v.pendingRiders.push({ role: 'townsfolk', seed: rng() * 1e6 });
  }

  // ───────────── horses & scaring ─────────────
  function scare(pos: THREE.Vector3, radius: number, src?: Vehicle) {
    let neighed = false;
    for (const v of vehicles) {
      if (v === src || v.phase === 'queued' || v.phase === 'gone' || !v.spec.horses || !v.mover) continue;
      if (v.mover.pos.distanceTo(pos) > radius) continue;
      if (v.scareT > 0.5 || motionNow < v.calmUntil) continue;
      v.scareT = 2.2 + rng() * 1.5;
      v.calmUntil = motionNow + 25; // they get used to it (and nobody deadlocks behind a shying horse)
      v.rearT = 1.3;
      if (rng() < 0.2 && v.phase === 'driving') v.boltT = 6 + rng() * 5;
      if (!neighed) { neighed = true; emit('audio:cue', { cue: 'horse', pos: v.mover.pos.clone(), volume: 0.9 }); }
    }
    if (src) emit('animal:scared', { pos: pos.clone(), radius });
  }
  ctx.bus.on('animal:scared', (e) => { if (e.radius > 0) scareFromBus(e.pos, e.radius); });
  let busScareGuard = 0;
  function scareFromBus(p: THREE.Vector3, r: number) { if (busScareGuard) return; busScareGuard = 1; try { scare(p, r); } finally { busScareGuard = 0; } }

  // animals on the road (drovers' flocks, cows to the byre): vehicles yield
  const animalPts: THREE.Vector3[] = [];
  let animalN = 0, lastAnimalScan = -99;
  function scanAnimals() {
    if (motionNow - lastAnimalScan < 0.5) return;
    lastAnimalScan = motionNow;
    animalN = 0;
    const N = ctx.reg.nature;
    if (!N) return;
    try {
      for (const kind of ['sheep', 'cow', 'dog'] as const) {
        for (const c of N.list(kind)) {
          if (L.terrain.roadDist(c.pos.x, c.pos.z) > -0.3) continue; // only beasts actually on the carriageway
          if (animalN >= 64) break;
          const p = animalPts[animalN] ?? (animalPts[animalN] = new THREE.Vector3());
          p.copy(c.pos); animalN++;
        }
      }
    } catch { animalN = 0; }
  }
  function yieldToAnimals(v: Vehicle, dtM: number) {
    const was = v.yieldHold;
    v.yieldHold = false;
    if (was) v.yieldT += dtM; else v.yieldT = Math.max(0, v.yieldT - dtM);
    // a beast that won't budge: the carter edges through at a walk (never a permanent hold)
    if (v.yieldT > 12) { v.yieldT = 0; v.yieldIgnoreUntil = motionNow + 15; }
    if (!animalN || !v.mover || v.phase !== 'driving' || motionNow < v.yieldIgnoreUntil) return;
    const m = v.mover;
    const c = Math.cos(m.yaw), s = Math.sin(m.yaw);
    for (let i = 0; i < animalN; i++) {
      const p = animalPts[i];
      const dx = p.x - m.pos.x, dz = p.z - m.pos.z;
      const ahead = dx * c - dz * s, side = dx * s + dz * c;
      if (ahead > -1 && ahead < 9 && Math.abs(side) < 3.2) { v.yieldHold = true; return; }
    }
  }
  crossing.animalsOnRoad = () => ({ pts: animalPts, n: animalN });

  // ───────────── the frame's visuals ─────────────
  function horseAnim(v: Vehicle, dt: number) {
    const m = v.mover!;
    const spd = m.v;
    const amp = spd < 0.08 ? 0 : spd < 2.2 ? 0.5 * Math.min(1, spd / 1.2) : THREE.MathUtils.lerp(0.5, 1.0, Math.min(1, (spd - 2.2) / 1.2));
    const stride = amp > 0.6 ? HORSE_STRIDE.trot : HORSE_STRIDE.walk;
    const t = performance.now() / 1000;
    for (let i = 0; i < v.horses.length; i++) {
      const h = v.horses[i];
      const slot = v.horseSlots[i];
      if (slot < 0) continue;
      h.phase = (m.odometer / stride) * Math.PI * 2 + i * 0.35;
      // idle life (NO STATIONARY ANIMALS): stamps, tail swishes, nods, ear flicks, grazing at the kerb
      h.stampT -= dt;
      if (h.stampT <= 0 && amp === 0) { h.stampLeg = 1 + Math.floor(rng() * 4); h.stampPh = 0; h.stampT = 2.5 + rng() * 6; }
      if (h.stampLeg) { h.stampPh += dt * 1.8; if (h.stampPh >= 1) { h.stampLeg = 0; h.stampPh = 0; } }
      h.swishT -= dt;
      if (h.swishT <= 0) { h.swishT = 1.5 + rng() * 4; h.swishAmp = 0.6 + rng() * 0.4; }
      h.swishAmp = Math.max(0.12, h.swishAmp - dt * 0.35);
      const swish = Math.sin(t * 3.1 + i) * h.swishAmp;
      h.nodPh += dt * (amp > 0 ? 0 : 0.7);
      const nod = amp > 0 ? 0 : 0.35 * Math.sin(h.nodPh) * Math.max(0, Math.sin(h.nodPh * 0.37));
      const standing = v.phase === 'parked' || (m.v < 0.05 && v.phase === 'driving');
      h.grazeT -= dt;
      if (h.grazeT <= 0) { h.grazeT = 4 + rng() * 8; h.graze = standing && v.phase === 'parked' && rng() < 0.35 ? 0.35 + rng() * 0.4 : 0; }
      h.ear = (Math.sin(t * 0.9 + i * 2.1) > 0.93) ? 1 : Math.max(0, h.ear - dt * 3);
      const rear = v.rearT > 0 ? Math.sin(Math.PI * Math.min(1, v.rearT / 1.3)) : 0;
      horsesRig.setAnim(slot, h.phase, v.scareT > 0 && amp === 0 ? 0.6 : amp, nod - rear * 0.8, swish);
      horsesRig.setAux(slot, h.stampLeg || (rear > 0.1 ? 1 + (Math.floor(t * 4) % 2) : 0), rear > 0.1 ? (t * 3) % 1 : h.stampPh, h.graze * (standing ? 1 : 0), h.ear);
    }
  }

  const bodyMax = [0, 0, 0];
  function renderFrame(dt: number) {
    const nightK = night();
    let lampN = 0;
    const lit = nightK > 0.22;
    bodyMax[0] = bodyMax[1] = bodyMax[2] = 0;
    let horseMax = 0, wheelMax = 0;
    for (const v of vehicles) {
      if (v.phase === 'queued' || v.phase === 'gone' || !v.mover) continue;
      const m = v.mover;
      const vis = ctx.view.isVisible(m.pos, v.spec.length + 6) || ctx.view.isVisible(v.bodyPos, 8);
      v.visible = vis;
      const bRig = bodies[v.spec.group];
      if (!vis) {
        if (v.bodySlot >= 0) bRig.hide(v.bodySlot);
        for (const s of v.horseSlots) if (s >= 0) horsesRig.hide(s);
        for (const s of v.wheelSlots) if (s >= 0) wheelsRig.hide(s);
        continue;
      }
      v.pose();
      // body (a little sway at a trot, puffs & flywheel for the motor)
      const sway = m.v > 1 ? Math.sin(m.odometer * 1.3) * 0.012 * Math.min(1, m.v / 3) : 0;
      if (v.bodySlot >= 0) {
        bRig.setTransform(v.bodySlot, v.bodyPos, v.bodyYaw, 1, v.bodyPitch + (v.spec.horses === 1 && v.spec.wheels.length === 2 ? -0.02 : 0), sway);
        const motor = v.spec.kind === 'motorwagen';
        const tt = performance.now() / 1000;
        bRig.setAnim(v.bodySlot, motor ? tt * 1.6 : 0, motor ? 1 : 0, motor ? tt * 9 : 0, motor ? 1 : 0);
        bRig.setAux(v.bodySlot, v.spec.sub, 0, 0, 0);
        bodyMax[v.spec.group] = Math.max(bodyMax[v.spec.group], v.bodySlot + 1);
      }
      // wheels
      const c = Math.cos(v.bodyYaw), s = Math.sin(v.bodyYaw);
      for (let i = 0; i < v.spec.wheels.length; i++) {
        const slot = v.wheelSlots[i];
        if (slot < 0) continue;
        const w = v.spec.wheels[i];
        _v1.set(v.bodyPos.x + w.x * c + w.z * s, 0, v.bodyPos.z - w.x * s + w.z * c);
        _v1.y = v.bodyPos.y + w.r + w.x * Math.sin(v.bodyPitch);
        wheelsRig.setTransform(slot, _v1, v.bodyYaw, w.r, v.bodyPitch, 0);
        wheelsRig.setAnim(slot, m.odometer / w.r, 0, 0, 0);
        wheelMax = Math.max(wheelMax, slot + 1);
      }
      // horses
      for (let i = 0; i < v.horses.length; i++) {
        const slot = v.horseSlots[i];
        if (slot < 0) continue;
        const f = v.horsePose(i, _v2);
        let pitch = f.pitch;
        if (v.rearT > 0) {
          const r = Math.sin(Math.PI * Math.min(1, v.rearT / 1.3)) * 0.55;
          pitch += r;
          // pivot on the hind hooves
          _v2.x += Math.cos(f.yaw) * (-0.66 + 0.66 * Math.cos(r)); _v2.z -= Math.sin(f.yaw) * (-0.66 + 0.66 * Math.cos(r));
          _v2.y += 0.66 * Math.sin(r);
        }
        horsesRig.setTransform(slot, _v2, f.yaw, v.spec.horseScale, pitch, 0);
        horseMax = Math.max(horseMax, slot + 1);
      }
      horseAnim(v, dt);
      // lamps at night
      if (lit && v.spec.lamps.length && lampN + v.spec.lamps.length <= lampCap) {
        for (const lp of v.spec.lamps) {
          _v3.set(lp[0], lp[1], lp[2]).applyMatrix4(v.bodyM);
          _m4.makeScale(1.45, 1.45, 1.45).setPosition(_v3.x, _v3.y, _v3.z);
          lamps.setMatrixAt(lampN, _m4);
          lamps.setColorAt(lampN, _col.setRGB(1.0 * nightK + 0.3, 0.72 * nightK + 0.2, 0.35 * nightK + 0.1));
          lampN++;
        }
        // one pooled light per vehicle (lanterns: lowest priority; unserved claims still glow)
        _v3.set(v.spec.lamps[0][0] + 0.4, v.spec.lamps[0][1], 0).applyMatrix4(v.bodyM);
        ctx.lights.claim(`traffic:${v.id}`, _v3, 0xffb860, 1.4 * nightK, 9, 0);
      }
    }
    lampN = crossing.render(dt, lampN, lamps, nightK, lampCap);
    if (lamps.count !== lampN || lampN) { lamps.count = lampN; lampsDirty = true; }
    for (let i = 0; i < bodies.length; i++) { bodies[i].mesh.count = bodyMax[i]; bodies[i].mesh.visible = bodyMax[i] > 0; }
    horsesRig.mesh.count = horseMax; horsesRig.mesh.visible = horseMax > 0;
    wheelsRig.mesh.count = wheelMax; wheelsRig.mesh.visible = wheelMax > 0;
  }

  // ───────────── weather ─────────────
  function weatherKind(): string { try { return atmo()?.weather ?? 'clear'; } catch { return 'clear'; } }
  function weatherSpeed(): number { const w = weatherKind(); return w === 'snow' ? 0.72 : w === 'fog' ? 0.8 : w === 'storm' ? 0.85 : w === 'rain' ? 0.92 : 1; }
  function night(): number { try { const a = atmo(); return Math.max(a?.nightFactor ?? 0, (a?.gloom ?? 0) * 0.9); } catch { return 0; } }

  const reported = new Set<string>();
  function reportOnce(k: string, e: unknown) { if (reported.has(k)) return; reported.add(k); console.warn(`[traffic] ${k}:`, e); }

  // ───────────── warm start (before the first frame: exempt from the audit) ─────────────
  let warm = false;
  function warmStart() {
    warm = true;
    // a couple of cabs on the rank and one vehicle on the road so the forecourt is alive from the start
    const h = hourOf();
    const nCabs = Math.min(rankWant(), 2);
    for (let i = 0; i < nCabs; i++) {
      const v = dispatchCab(null);
      if (!v) continue;
      if (trySpawnWarm(v)) { /* placed */ }
    }
    if (h >= 6 && h < 22.5) {
      const bg = makeVehicle({ kind: 'gig', purpose: 'background', from: 'E1', stops: [], to: 'NW1' });
      if (bg) trySpawnWarm(bg, 0.45);
    }
  }
  /** place a vehicle part-way along its route (warm start only — before any frame is rendered) */
  function trySpawnWarm(v: Vehicle, frac?: number): boolean {
    if (!trySpawn(v)) return false;
    const m = v.mover!;
    const st = v.stops[0];
    if (frac === undefined && st) {
      if (st.kind === 'rank') st.d = rankSlotD(v, st.d);
      m.d = st.d; m.stopAt = st.d; m.state = 'stopped';
      arrive(v, st);
      v.parkedAt = now() - rng() * 15;
    } else {
      m.d = m.route.length * (frac ?? 0.5);
    }
    m.place(true, L);
    return true;
  }

  // ───────────── API ─────────────
  function request(r: TripRequest): string | null {
    const kind: VehicleKind = r.kind === 'cab' ? ((r.riders?.length ?? 0) > 2 || r.riders?.some((p) => p.luggage) ? 'growler' : rng() < 0.6 ? 'hansom' : 'growler') : r.kind;
    const passenger = r.tag === 'passenger';
    const nR = r.riders?.length ?? 0;
    if (kind === 'omnibus' && r.to === 'forecourt:omnibus' && !r.from) {
      // join the next bus setting out from the mews (riders are created inside it when it leaves) — if it has seats
      const seats = KINDS.omnibus.seats.length - 2;
      const q = vehicles.find((v) => v.purpose === 'omnibus' && v.phase === 'queued' && v.pendingRiders.length + nR <= seats);
      if (q) { if (r.riders) q.pendingRiders.push(...r.riders); return q.id; }
      if (passenger && !canServe('omnibus')) return null;
      // at most one bus (two in the peaks) on its way to / standing at the forecourt
      const h = hourOf();
      const peak = (h >= 7 && h < 9.5) || (h >= 16.5 && h < 19);
      let onWay = 0;
      for (const b of vehicles) if (b.purpose === 'omnibus' && b.phase !== 'gone' && !leftStand(b)) onWay++;
      if (onWay >= (peak ? 3 : 2)) {
        // every bus is out: travellers wait at home for the next one (a special run picks them up)
        if (passenger && r.riders && pendingOmni.length + nR <= seats * 3) { pendingOmni.push(...r.riders); pendingOmniAt = now(); return 'omnibus:pending'; }
        return null;
      }
      const v = dispatchBus([now() + busTravel, now() + busTravel + 10]);
      if (v) { if (r.riders) v.pendingRiders.push(...r.riders); return v.id; }
      return null;
    }
    if (passenger && !canServe(kind)) return null;
    const farmish = kind === 'farmcart' || kind === 'haywain';
    let from = r.from ?? (kind === 'fireengine' && engineDoor ? engineDoor : kind === 'circuswagon' || kind === 'carriage4' || kind === 'motorwagen' || kind === 'bicycle' || kind === 'pennyfarthing' ? 'E1' : farmish && farmDoors.length ? (passenger ? farmDoors[0] : pick(farmDoors)) : passenger || rng() < 0.6 ? 'mews' : 'E1');
    let to = r.then ?? (from.startsWith('door:') || from === 'mews' ? from : 'E1');
    if (!ptOf(from, false)) from = 'E1';
    if (!ptOf(to, false)) to = 'E1';
    const stops: StopSpec[] = [{ at: r.to, dwell: r.wait ?? (r.riders?.length ? 2 : 3), kind: r.to.startsWith('forecourt:rank') ? 'rank' : r.wait !== undefined && !r.to.startsWith('forecourt') ? 'wait' : undefined }];
    const v = makeVehicle({ kind, purpose: 'request', from, stops, to, riders: r.riders, tag: r.tag, decor: r.decor, request: r });
    if (!v) {
      // depot too small for this vehicle: come from the nearest portal instead
      const v2 = makeVehicle({ kind, purpose: 'request', from: 'E1', stops, to: to.startsWith('door:') ? 'E1' : to, riders: r.riders, tag: r.tag, decor: r.decor, request: r });
      return v2 ? v2.id : null;
    }
    if (r.to.startsWith('forecourt:rank')) {
      if (rankRoom(kind)) { rankQ.push(v.id); v.stops[0].pt = { k: 'loop', s: RANK_FRONT }; v.stops[0].id = 'forecourt:rank'; v.stops[0].kind = 'rank'; v.purpose = 'cab'; }
      else { v.stops[0].pt = { k: 'loop', s: L.forecourtTraffic.dropOff.s }; v.stops[0].id = 'forecourt:drop'; v.stops[0].kind = 'drop'; }
    }
    return v.id;
  }

  const api: TrafficAPI & { estimate(r: TripRequest): number | null } = {
    list: () => vehicles.filter((v) => v.phase !== 'queued' && v.phase !== 'gone').map((v) => v.info),
    get: (id) => { const v = byId.get(id); return v && v.phase !== 'gone' ? v.info : undefined; },
    request,
    cancel(id) {
      const v = byId.get(id);
      if (!v || v.phase === 'gone') return;
      if (v.phase === 'queued') { v.phase = 'gone'; releaseStops(v); return; }
      const home = v.originPt.k === 'door' ? v.origin : 'E1';
      if (v.phase === 'parked') { v.standUntil = 0; v.window[1] = 0; retarget(v, home); leaveStop(v); }
      else retarget(v, home);
    },
    anchorOf: (id) => {
      const v = byId.get(id.endsWith(':crew') ? id.slice(0, -5) : id);
      if (!v || v.phase === 'gone') return null;
      return id.endsWith(':crew') ? v.crewAnchor : v.anchor;
    },
    rank: () => {
      const waiting = rankQ.filter((id) => { const v = byId.get(id); return !!v && v.phase === 'parked' && !v.hiredBy && v.stop?.kind === 'rank'; });
      return {
        waiting,
        hail(personId?: string) {
          if (personId) for (const v of vehicles) if (v.hiredBy === personId && v.phase !== 'gone' && v.stop?.kind === 'rank') return v.id;
          const front = waiting[0] ? byId.get(waiting[0]) : null;
          if (front) { front.hiredBy = personId ?? 'anon'; front.hiredAt = now(); front.boardedAt = -1; return front.id; }
          const coming = vehicles.find((v) => v.purpose === 'cab' && !v.hiredBy && v.phase !== 'gone' && v.phase !== 'parked' && v.stops.some((s, i) => s.kind === 'rank' && i >= v.stopIdx));
          if (coming) { coming.hiredBy = personId ?? 'anon'; coming.hiredAt = now() + 90; coming.boardedAt = -1; return coming.id; }
          const v = dispatchCab(personId ?? 'anon');
          return v ? v.id : null;
        },
      };
    },
    omnibusAt: () => {
      const v = omniOwner ? byId.get(omniOwner) : null;
      return v && v.phase === 'parked' ? v.id : null;
    },
    crossingState: (id) => (id === 'lc1' ? crossing.state : 'open') as CrossingState,
    requestCrossing: (id, who) => (id === 'lc1' ? crossing.request(who, motionNow) : true),
    releaseCrossing: (id, who) => { if (id === 'lc1') crossing.release(who); },
    scare: (pos, r) => scare(pos, r),
    raycast(r) {
      let best: string | null = null, bd = Infinity;
      const ray = new THREE.Ray();
      const box = new THREE.Box3();
      const inv = new THREE.Matrix4();
      const hit = new THREE.Vector3();
      for (const v of vehicles) {
        if (v.phase === 'queued' || v.phase === 'gone' || !v.mover || !v.visible) continue;
        v.pose();
        inv.copy(v.bodyM).invert();
        ray.copy(r.ray).applyMatrix4(inv);
        const sp = v.spec;
        box.min.set(-(sp.bodyLen - sp.shaftFront) - 0.2, 0, -sp.halfWidth - 0.3);
        box.max.set(bodyOffset(sp) + 0.2, sp.kind === 'haywain' || sp.kind === 'omnibus' ? 3.6 : 2.6, sp.halfWidth + 0.3);
        if (!ray.intersectBox(box, hit)) continue;
        hit.applyMatrix4(v.bodyM);
        const d = hit.distanceTo(r.ray.origin);
        if (d < bd) { bd = d; best = v.id; }
      }
      return best;
    },
    stats: () => {
      const byKind: Partial<Record<VehicleKind, number>> = {};
      let n = 0, h = 0;
      for (const v of vehicles) if (v.phase !== 'queued' && v.phase !== 'gone') { n++; h += v.spec.horses; byKind[v.spec.kind] = (byKind[v.spec.kind] ?? 0) + 1; }
      return { vehicles: n, horses: h, byKind };
    },
    /** estimated sim minutes for a trip (people's honest lead times) */
    estimate(r) {
      const kind: VehicleKind = r.kind === 'cab' ? 'hansom' : r.kind;
      const from = ptOf(r.from ?? (kind === 'omnibus' ? 'mews' : 'mews'), false);
      const to = ptOf(r.to, true);
      if (!from || !to) return null;
      const p = router.plan([from, to]);
      return p ? travelMin(p.route, KINDS[kind]) + (kind === 'omnibus' ? 0 : 2) : null;
    },
  };
  ctx.reg.traffic = api;
  (api as unknown as { _debug: unknown })._debug = { vehicles, router, crossing, rankQ, flow };

  // ───────────── update ─────────────
  let logicAcc = 0;
  return {
    name: 'traffic',
    update(dt: number, clock: SimClock) {
      const dtM = clock.dtMotion;
      const simDt = clock.dtSim;
      motionNow += dtM;
      const rf = ctx.renderer.info.render.frame;
      if (rf !== lastRenderFrame) { lastRenderFrame = rf; subInFrame = 0; frame++; }
      subInFrame++;
      if (!warm) warmStart();
      // people riding support probe (drivers must actually sit on the box)
      if (rideProbe && motionNow - rideProbe.t > 0.6) {
        let ok = false;
        try { ok = people()?.get(rideProbe.id)?.riding === rideProbe.v.id + ':crew' || people()?.get(rideProbe.id)?.riding === rideProbe.v.id; } catch { ok = false; }
        if (!ok) {
          peopleRide = false;
          for (const v of vehicles) {
            for (const id of [...v.crew, ...v.riders]) { try { people()?.dismissActor(id); } catch { /* */ } }
            v.crew = []; v.riders.clear(); syncRiders(v);
          }
        } else peopleRide = true;
        rideProbe = null;
      }
      // scheduling (coarse, sim-time based)
      logicAcc += simDt;
      if (logicAcc >= 1 || simDt === 0 && frame % 30 === 0) {
        logicAcc = 0;
        try { timedTick(); } catch (e) { reportOnce('timed', e); }
        try { busTick(); } catch (e) { reportOnce('bus', e); }
        try { rankTick(); } catch (e) { reportOnce('rank', e); }
      }
      if (simDt > 0) { backgroundTick(simDt); cycleTick(simDt); }
      // spawn queue, by priority (event requests → passengers → omnibus / rank → carts → background)
      let blocked = false;
      for (let pri = 0; pri < 4; pri++) {
        for (const v of vehicles) {
          if (v.phase !== 'queued' || priorityOf(v) !== pri || v.purpose === 'cycle') continue;
          if (trySpawn(v)) continue;
          // a higher-priority trip is waiting for room: lower ones wait too (unless it waits on its portal view)
          if (liveCount() - liveCycles() >= capV || liveHorses() + v.spec.horses > capH) blocked = true;
          // stale trips that never got on the road are dropped (never seen, so nothing vanishes)
          if (isStale(v, now() - v.queuedAt)) { v.phase = 'gone'; releaseStops(v); }
        }
        if (blocked) break;
      }
      for (const v of vehicles) if (v.phase === 'queued' && v.purpose === 'cycle' && !trySpawn(v) && isStale(v, now() - v.queuedAt)) v.phase = 'gone';
      // animals & crossing & movement
      if (dtM > 0) {
        scanAnimals();
        for (const v of vehicles) if (v.phase === 'driving') yieldToAnimals(v, dtM);
        crossing.update(dtM, clock);
        flow.step(dtM);
        for (const v of vehicles) if (v.mover && (v.phase === 'driving' || v.phase === 'parked')) stepVehicle(v, dtM, simDt);
        // parked vehicles out of the flow wait to pull out
        for (const v of vehicles) if (v.phase === 'parked' && v.pullOutWait) leaveStop(v);
      }
      // prune
      for (let i = vehicles.length - 1; i >= 0; i--) if (vehicles[i].phase === 'gone') { byId.delete(vehicles[i].id); vehicles.splice(i, 1); }
      // visuals: once per rendered frame (plus a few sub-steps at 10×/60× so riders never lag their seats)
      if (subInFrame <= 3) renderFrame(dt);
    },
    dispose() {
      for (const b of bodies) b.dispose();
      horsesRig.dispose(); wheelsRig.dispose(); crossing.dispose();
      lampGeo.dispose(); lampMat.dispose();
      ctx.scene.remove(root);
    },
  };

  function pick<T>(a: T[]): T { return a[Math.floor(rng() * a.length) % a.length]; }
  function weighted<T>(a: [T, number][]): T {
    let tot = 0; for (const [, w] of a) tot += w;
    let r = rng() * tot;
    for (const [k, w] of a) { if ((r -= w) <= 0) return k; }
    return a[0][0];
  }
}

function mulberry(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type { VehicleInfo, PersonRole };
