import * as THREE from 'three';
import type { Dir, LineId, PlatformId } from '../../core/types';
import { Scripted, alongOf, lineClear, node, onPlatform, platCenterT, trainThreat, type EventDef, type EventEnv } from '../base';
import type { Script } from '../runner';
import { buildBasket, buildCat, buildCow, buildElephant, buildGoose } from '../props';
import type { Critter } from '../critter';

const hr = (e: EventEnv) => e.ctx.clock.hour;
const wx = (e: EventEnv) => e.ctx.reg.atmosphere?.weather ?? 'clear';

/** a train standing (doors open) at platform pid, if any */
function dwellingAt(ctx: EventEnv['ctx'], pid?: PlatformId) {
  try { return ctx.reg.trains.list().find((t) => t.state === 'dwelling' && !t.ghost && (pid === undefined || t.platform === pid)) ?? null; } catch { return null; }
}
/** the door of train id nearest a point, on the platform edge */
function doorNear(ctx: EventEnv['ctx'], trainId: string, p: THREE.Vector3): THREE.Vector3 | null {
  let ds: THREE.Vector3[] = [];
  try { ds = ctx.reg.trains.getDoors(trainId); } catch { ds = []; }
  if (!ds.length) return null;
  return ds.reduce((a, b) => (a.distanceTo(p) < b.distanceTo(p) ? a : b)).clone();
}

// ═════════════════════════ 1. RUNAWAY GOOSE ═════════════════════════
// v2: a farmer steps off a train with a goose in his market basket; the goose makes a break for it along the open
// end of the platform. Caught → back in the basket and out through the booking hall; escaped → it flies off the map.
class GooseEvent extends Scripted {
  maxDuration = 150;
  *script(): Script {
    const { ctx, rng } = this;
    // wait for a stopping train (the goose arrives by rail)
    yield { until: () => !!dwellingAt(this.ctx), max: 45 };
    const tr = dwellingAt(this.ctx);
    const pid: PlatformId = tr?.platform ?? rng.pick([1, 2] as PlatformId[]);
    const endS = rng.chance(0.5) ? 1 : -1;
    const lo = 37, hi = 52;
    const chaseMid = onPlatform(ctx, pid, endS * 42, 4.5);
    const alight = (tr && doorNear(this.ctx, tr.id, onPlatform(ctx, pid, endS * 30, 2))) ?? onPlatform(ctx, pid, endS * 30, 2.5);
    const farmer = tr ? this.actors.fromTrain('farmer', alight) : this.actors.summon('farmer', alight, { from: this.actors.stationDoorNear(alight) });
    if (!farmer) return;
    const basket = buildBasket();
    this.group.add(basket);
    basket.position.copy(this.actors.pos(farmer)).setY(this.actors.pos(farmer).y + 0.9);
    this.carry(basket, farmer, 0.62, 0.38);
    const g = buildGoose();
    g.root.scale.setScalar(1.0);
    const goose: Critter = this.critter(g.root, 'goose', (c, dt, moving) => {
      const flee = mode === 'flee';
      g.body.rotation.x = moving && !c.held ? Math.sin(c.phase * 5) * 0.14 : 0;
      g.body.position.y = flee ? Math.abs(Math.sin(c.phase * 3)) * 0.12 : 0;
      // always alive: the neck bobs, pecks and turns even when standing
      g.neck.rotation.z = flee ? -0.5 : mode === 'fly' ? -0.9 : (moving ? Math.sin(c.phase * 3) * 0.12 : Math.sin(c.phase * 0.9) * 0.35 - 0.25);
      g.neck.rotation.y = !moving ? Math.sin(c.phase * 0.37) * 0.5 : 0;
      flapAmp += ((flee ? 1.1 : mode === 'fly' ? 1.2 : mode === 'basket' ? 0.25 + 0.25 * Math.sin(c.phase * 0.5) : 0) - flapAmp) * Math.min(1, dt * 6);
      const f = flapAmp * (0.55 + 0.45 * Math.sin(c.phase * 9));
      g.wingL.rotation.x = -f; g.wingR.rotation.x = f;
    });
    goose.groundY = null; // platform deck, not the terrain
    goose.canFly = true;
    let mode: 'basket' | 'wander' | 'flee' | 'held' | 'fly' = 'basket';
    let flapAmp = 0;
    // the goose rides in the basket: its origin is the basket (a carried "vehicle")
    const basketOrigin = this.origin({ id: `events:basket:${this.now.toFixed(2)}`, kind: 'vehicle', pos: (o) => o.copy(basket.position), radius: 1.5, for: ['animals'], open: () => true });
    goose.enter(basket.position.clone(), basketOrigin);
    goose.held = true;
    basket.add(g.root); g.root.position.set(0, 0.12, 0); g.root.rotation.set(0, 0, 0); g.root.scale.setScalar(0.62);
    yield this.walk(farmer, chaseMid.clone().add(new THREE.Vector3(0, 0, 0)), { speed: 1.1 });
    this.actors.idle(farmer, 'wait');
    yield rng.range(1, 3);

    // ── the escape ──
    const out = basket.localToWorld(new THREE.Vector3(0, 0.3, 0));
    this.group.attach(g.root);
    g.root.position.copy(out).setY(1.0);
    g.root.scale.setScalar(1.35);
    goose.held = false;
    mode = 'wander';
    const tgt = g.root.position.clone();
    let retarget = 0;
    const porter = { id: '' as string | null };
    const inward = ctx.layout.platforms[pid].inward;
    const newTarget = (flee: boolean) => {
      const a = alongOf(ctx, pid, g.root.position);
      let na: number;
      if (flee && porter.id) {
        const pa = alongOf(ctx, pid, this.actors.pos(porter.id));
        const away = Math.sign(a - pa) || (rng.chance(0.5) ? 1 : -1);
        na = a + away * rng.range(7, 13);
        if (na * endS > hi || na * endS < lo) na = a - away * rng.range(6, 10); // cornered: double back past him
      } else na = a + rng.range(-5, 5);
      na = endS > 0 ? THREE.MathUtils.clamp(na, lo, hi) : THREE.MathUtils.clamp(na, -hi, -lo);
      tgt.copy(onPlatform(ctx, pid, na, rng.range(2.8, 7.5)));
      retarget = rng.range(3, 7);
    };
    this.tick((_dt, dm) => {
      if (mode !== 'wander' && mode !== 'flee') return;
      const p = g.root.position;
      const pp = porter.id ? this.actors.pos(porter.id) : null;
      const dist = pp ? Math.hypot(pp.x - p.x, pp.z - p.z) : 99;
      const was = mode;
      mode = dist < 6.5 ? 'flee' : 'wander';
      retarget -= dm;
      if (p.distanceTo(tgt) < 0.3 || retarget <= 0 || (mode === 'flee' && was !== 'flee')) newTarget(mode === 'flee');
      goose.goto(tgt, mode === 'flee' ? 3.9 : 0.8);
    });
    const where = pid === 1 ? 'Down platform' : 'Highland platform';
    this.gazette(rng.pick([
      `GOOSE AT LARGE ON THE ${where.toUpperCase()}! A market goose quits its basket and alarms passengers with "singularly ill temper"`,
      `A goose of no fixed abode takes possession of the ${where}; its owner, a Coldharbour farmer, calls for the porters`,
    ]));
    this.cueLoop('honk', [1.8, 4.5], () => g.root.position, 0.9);
    this.marker('!', () => (mode === 'fly' || mode === 'held' ? null : g.root.position), { lift: 1.8 });
    this.actors.anim(farmer, 'point');
    yield rng.range(2, 4);

    porter.id = this.actors.summon('porter', g.root.position.clone(), { from: `door:station:p${pid}`, run: true });
    const chaseMin = rng.range(18, 30);
    const escapes = rng.chance(0.4);
    let chaseT = 0, steerT = 0;
    this.tick((_dt, dm) => {
      if (!porter.id || (mode !== 'wander' && mode !== 'flee')) return;
      chaseT += dm; steerT -= dm;
      if (steerT <= 0) {
        steerT = 1.2;
        const gp = g.root.position;
        this.actors.steer(porter.id, new THREE.Vector3(gp.x, 1, gp.z), { run: true, direct: chaseT > 2, speed: 3.3 });
      }
    });
    const gap = () => { if (!porter.id) return 99; const a = this.actors.pos(porter.id), b = g.root.position; return Math.hypot(a.x - b.x, a.z - b.z); };
    yield { until: () => chaseT >= chaseMin && (escapes || gap() < 1.8), max: chaseMin + 30 };

    if (escapes || gap() >= 1.8 || !porter.id) {
      // off it goes, out over the fields and beyond the edge of the map (birds leave by air)
      mode = 'fly';
      goose.exitMode = 'fly';
      goose.groundY = null;
      const dir = new THREE.Vector3(-inward.x, 0, -inward.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(-0.6, 0.6)).normalize();
      const far = g.root.position.clone().addScaledVector(dir, 700).setY(70);
      goose.exit = far;
      goose.goto(far, 11);
      this.cue('honk', g.root.position, 1);
      if (porter.id) this.actors.anim(porter.id, 'point');
      this.actors.anim(farmer, 'wave');
      this.gazette(rng.pick([
        'The goose, having outwitted three porters and a stationmaster, departs by air. No ticket was purchased.',
        'Goose escapes custody; last seen flying north "in a most insolent manner"',
      ]));
      yield { until: () => !goose.target, max: 80 };
      goose.leave();
      yield 2;
    } else {
      mode = 'held';
      goose.held = true;
      goose.target = null;
      this.actors.anim(porter.id, 'carry');
      this.carry(g.root, porter.id, 1.0, 0.35);
      this.gazette(rng.pick([
        'Porter Hobbs apprehends the goose after a spirited pursuit; the bird is returned to its basket under protest',
        'Goose captured! Porter commended by the Stationmaster; the bird expresses no remorse',
      ]));
      yield this.walk(porter.id, this.actors.pos(farmer).clone().add(new THREE.Vector3(0.9, 0, 0)), { direct: true });
      // back into the basket
      basket.add(g.root); g.root.position.set(0, 0.12, 0); g.root.rotation.set(0, 0, 0); g.root.scale.setScalar(0.62);
      mode = 'basket';
      this.cue('honk', basket.position, 0.6);
      this.actors.anim(farmer, 'cheer');
      yield 2;
      this.actors.remove(porter.id);
      // the farmer carries basket and goose out through the booking hall
      this.carryOut(basket, farmer, { to: 'door:station:east', y: 0.62, fwd: 0.38, critter: goose });
      yield 3;
    }
  }
}

// ═════════════════════════ 2. CAT ON THE LINE ═════════════════════════
// v2: the Stationmaster's cat comes out of the station through its own flap, settles on the warm ballast, and is
// carried back in by a porter (or bolts back in by itself when a train comes).
const CAT_NAMES = ['Whiskers', 'Sir Pounce', 'Mrs. Marmalade', 'Bismarck', 'Tibbles', 'Old Tom'];
class CatEvent extends Scripted {
  maxDuration = 180;
  *script(): Script {
    const { ctx, rng } = this;
    let line: LineId = rng.pick(['coast', 'highland'] as LineId[]);
    if (!lineClear(ctx, line) && lineClear(ctx, line === 'coast' ? 'highland' : 'coast')) line = line === 'coast' ? 'highland' : 'coast';
    const L = ctx.layout.lines[line];
    const pid = L.platform;
    const P = ctx.layout.platforms[pid];
    // she only strolls out into a quiet spell on the line
    yield this.lineWindow(line, 22, 50);
    yield { until: () => lineClear(ctx, line), max: 20 };
    const t = platCenterT(ctx, pid) + rng.range(-30, 30) / L.length;
    const door = node(ctx, `p${pid}Door`); door.y = 1;
    const flap = this.animalGate(`events:catflap:p${pid}`, door, 1.6);
    const cat = buildCat();
    let napping = false, held = false;
    const c = this.critter(cat, 'cat', (cc, dt, moving) => {
      // breathing, tail flick and ear twitches — never a still life
      const br = 1 + Math.sin(cc.phase * 2.2) * 0.05;
      cat.scale.set(1.6, 1.6 * (napping ? br : 1), 1.6);
      cat.rotation.z = held ? 0.5 : moving ? Math.sin(cc.phase * 6) * 0.04 : 0;
      cat.position.y += moving ? Math.abs(Math.sin(cc.phase * 6)) * 0.02 * dt : 0;
    });
    c.groundY = null;
    c.enter(door.clone(), flap);
    const edge = P.edgePointAt(t); edge.y = 1.0;
    const onTrackP = L.offsetPoint(t, 0, 0.3);
    yield c.goto(edge, 1.3);
    yield c.goto(onTrackP, 1.6);
    napping = true;
    cat.rotation.y = L.yawAt(t) + rng.range(-0.5, 0.5);
    const release = this.holdLine(line);
    const name = rng.pick(CAT_NAMES);
    let fled = false;
    this.tick(() => {
      if (!held && !fled && c.present && trainThreat(ctx, line, t, 50)) {
        // a train is coming regardless: she leaps up onto the platform and dashes back indoors
        fled = true; napping = false;
        c.goto(edge, 3.5);
        this.cue('meow', c.pos, 1);
      }
    });
    this.gazette(`TRAFFIC SUSPENDED on the ${L.name}: the Stationmaster's cat, ${name}, asleep upon the permanent way`, 'warn');
    const zz = this.marker('Zz', () => (napping ? c.pos : null), { lift: 0.9, px: 26 });
    this.cueLoop('meow', [7, 14], () => c.pos, 0.5);
    yield { until: () => fled, max: rng.range(5, 9) };

    if (fled) {
      yield { until: () => !c.target, max: 10 };
      yield c.goto(door, 3);
      c.leave();
      release();
      this.gazette(`${name} vacates the ${L.name} with seconds to spare and is next seen washing in the booking hall`);
      yield 2;
      return;
    }
    const porter = this.actors.summon('porter', edge.clone().addScaledVector(P.inward, 0.6), { from: `door:station:p${pid}` });
    if (!porter) { release(); napping = false; yield c.goto(edge, 1.3); yield c.goto(door, 1.3); c.leave(); return; }
    yield this.actors.arrived(porter, 1.5);
    this.actors.anim(porter, 'work');
    this.cue('meow', c.pos, 0.9);
    yield rng.range(2, 4);
    held = true; napping = false; c.held = true;
    this.dropMarker(zz);
    cat.scale.setScalar(1.3);
    this.carry(cat, porter, 1.0, 0.3);
    this.marker('♥', () => (held ? cat.position : null), { lift: 1.2, px: 24 });
    release();
    this.gazette(`${name} is lifted from the ${L.name} "in a state of profound indignation"; traffic resumes`);
    this.actors.anim(porter, 'walk');
    yield this.walk(porter, door.clone().addScaledVector(P.inward, -0.2));
    // set down at the door: she stalks back inside
    held = false; c.held = false;
    this.stopCarry(cat);
    cat.position.copy(door).setY(1);
    cat.rotation.z = 0;
    yield c.goto(door.clone().addScaledVector(P.inward, -0.5), 1.0);
    c.leave();
    this.actors.remove(porter);
    yield 1;
  }
}

// ═════════════════════════ 5. COW ON THE LINE ═════════════════════════
// v2: a cow pushes through the gate of Shed Meadow, ambles across to the Coast Line at the west end of the Down
// platform and settles on the track; the farmer drives her home through the same gate.
class CowEvent extends Scripted {
  maxDuration = 380;
  *script(): Script {
    const { ctx, rng } = this;
    const line: LineId = 'coast';
    const L = ctx.layout.lines[line];
    const field = ctx.layout.fields.find((f) => f.id === 'FG') ?? ctx.layout.fields[0];
    const gatePos = field.gate.clone(); gatePos.y = ctx.layout.heightAt(gatePos.x, gatePos.z);
    const gate = this.animalGate(`events:gate:${field.id}`, gatePos, 3);
    const out = -L.platformSide; // the field side, away from the platform
    const t0 = L.platformStartT + rng.range(3, 8) / L.length;
    const cowB = buildCow();
    let grazing = false;
    const cow = this.critter(cowB.root, 'cow', (c, dt, moving) => {
      const sw = moving ? Math.sin(c.phase * 3) * 0.35 : 0;
      cowB.legs[0].rotation.z = sw; cowB.legs[3].rotation.z = sw; cowB.legs[1].rotation.z = -sw; cowB.legs[2].rotation.z = -sw;
      const headTarget = grazing && !moving ? -0.75 + Math.sin(c.phase * 0.8) * 0.08 : 0.05 + Math.sin(c.phase * 0.4) * 0.05;
      cowB.head.rotation.z += (headTarget - cowB.head.rotation.z) * Math.min(1, dt * 2);
      cowB.head.rotation.y = Math.sin(c.phase * 0.23) * 0.25;
      cowB.tail.rotation.x = Math.sin(c.phase * 1.7) * 0.4;
    });
    cow.turn = 3;
    cow.enter(gatePos, gate);
    this.gazette(rng.pick([
      'A cow of the Friesian persuasion has pushed open the gate of Shed Meadow and is observed making for the railway',
      'Livestock at liberty: a cow quits Shed Meadow "with evident purpose"; railway staff alerted',
    ]), 'info');
    this.cueLoop('moo', [6, 12], () => cow.pos, 0.8);
    this.marker('!', () => (cow.present ? cow.pos : null), { lift: 2.6 });
    const lineSpot = L.offsetPoint(t0, 0, 0);
    const approach = L.offsetPoint(t0, out * 7, 0);
    // amble to the lineside, grazing on the way
    const mid = gatePos.clone().lerp(approach, 0.5).add(new THREE.Vector3(rng.range(-6, 6), 0, rng.range(-6, 6)));
    yield cow.goto(mid, 1.6);
    grazing = true; yield rng.range(3, 6); grazing = false;
    // summon the farmer now: he walks in while she finishes her approach
    let farmer: string | null = null;
    yield cow.goto(approach, 1.6);
    // only stray onto the rails in a quiet spell (the hold is capped at 10 minutes)
    yield this.lineWindow(line, 16, 30);
    yield { until: () => lineClear(ctx, line), max: 15 };
    const release = this.holdLine(line);
    try { ctx.reg.trains.delayLine(line, rng.int(6, 10), 'Cow on the line'); } catch { /* stub */ }
    this.gazette(rng.pick([
      'BOVINE OBSTRUCTION! A cow halts the Coast Line at the Junction and declines to yield the right of way',
      'Coast Line services held: a cow takes up residence upon the Down main',
    ]), 'warn');
    yield cow.goto(lineSpot, 1.2);
    cow.lift = 0.2;
    grazing = true;
    // the farmer comes from the nearest door people can find for him (walking the long way round if he must)
    farmer = this.actors.summon('farmer', L.offsetPoint(t0 + 3 / L.length, out * 3, 0), { timeoutMin: 60 });
    let fled = false;
    this.tick(() => {
      if (!fled && cow.present && trainThreat(ctx, line, L.nearestT(cow.pos), 70, 8)) {
        fled = true; grazing = false;
        cow.goto(L.offsetPoint(L.nearestT(cow.pos), out * 10, 0), 3.2);
        this.cue('moo', cow.pos, 1);
      }
    });
    yield farmer ? this.either(this.actors.arrived(farmer), () => fled, 40) : 8;
    if (farmer) { this.actors.anim(farmer, 'wave'); this.cue('shout', cow.pos, 0.7); }
    this.cue('moo', cow.pos, 1);
    yield 3;
    grazing = false;
    cow.lift = 0;
    yield cow.goto(approach, 1.3);
    release();
    this.gazette(rng.pick([
      'The cow is persuaded from the Coast Line by Farmer Gubbins and a stout stick; traffic resumes',
      'Line cleared of livestock. The cow, interviewed, had "nothing further to add"',
    ]));
    // home through the gate, the farmer at her heels
    let steer = 0;
    this.tick((_dt, dm) => {
      if (!farmer || !cow.present) return;
      steer -= dm;
      if (steer <= 0) { steer = 2; const p = cow.pos.clone().add(new THREE.Vector3(1.5, 0, 1.5)); this.actors.steer(farmer, p, { direct: true, speed: 1.4 }); }
    });
    yield cow.goto(gatePos, 1.3);
    cow.leave();
    if (farmer) this.actors.remove(farmer);
    yield 2;
  }
}

// ═════════════════════════ 7. CIRCUS TRAIN ═════════════════════════
// v2: Duchess the elephant steps down from her car (an animal origin at the car door while the train stands) and
// back up into it at the end; the ringmaster and the crowd come and go through proper origins.
class CircusEvent extends Scripted {
  maxDuration = 260;
  *script(): Script {
    const { ctx, rng } = this;
    const pid: PlatformId = 2;
    const line: LineId = 'highland';
    const dir: Dir = rng.pick(['east', 'west'] as Dir[]);
    let trainId = '';
    try {
      trainId = ctx.reg.trains.spawnSpecial({ special: 'circus', line, dir, stops: true, dwellMin: 48, name: "Signor Bellini's Circus Special",
        cars: ['loco_tank', 'circus_cage', 'circus_cage', 'coach_third', 'guard'] });
    } catch { trainId = ''; }
    let arrived = false, departed = false;
    this.on('train:arrived', (e) => { if (e.trainId === trainId) arrived = true; });
    this.on('train:departed', (e) => { if (e.trainId === trainId) departed = true; });
    this.on('train:despawned', (e) => { if (e.trainId === trainId) departed = true; });
    this.gazette(rng.pick([
      "SIGNOR BELLINI'S GRAND TRAVELLING CIRCUS expected upon the Highland platform: elephants, acrobats & a learned pig!",
      'The Circus is coming! Crowds gather at the Junction for a glimpse of the famous elephant, Duchess',
    ]));
    const crowd = this.actors.crowd(9, onPlatform(ctx, pid, 30, 6.5), 'passenger', 5);
    const spots = crowd.map((_, i) => onPlatform(ctx, pid, 22 + (i * 18) / Math.max(1, crowd.length) + rng.range(-0.6, 0.6), rng.range(7.2, 8.2)));
    crowd.forEach((id, i) => this.walk(id, spots[i]));
    try { ctx.reg.people.density *= 1.3; this.onCleanup(() => { ctx.reg.people.density /= 1.3; }); } catch { /* stub */ }
    if (!trainId) { this.gazette('The Circus Special is reported delayed beyond Glenmoor; the crowd disperses in disappointment', 'info'); yield 6; return; }
    yield { until: () => arrived, max: 110 };
    if (!arrived) return;

    const east = onPlatform(ctx, pid, 32, 2.4);
    const door = doorNear(this.ctx, trainId, east) ?? east.clone();
    door.y = 1;
    const inwardV = ctx.layout.platforms[pid].inward;
    const P2 = ctx.layout.platforms[pid];
    const inCar = P2.edgePointAt(ctx.layout.lines[line].nearestT(door)).addScaledVector(inwardV, -2.0).setY(1.0);
    // the car ramp is an animal origin while the special stands with its doors open
    const ramp = this.origin({
      id: `events:circus:${trainId}`, kind: 'train', pos: (o) => o.copy(inCar), radius: 3, for: ['animals'],
      open: () => { const t = this.safe(() => ctx.reg.trains.get(trainId), undefined); return !!t && (t.state === 'dwelling' || t.doorsOpen); },
    });
    const start = door.clone().addScaledVector(inwardV, 1.8);
    const el = buildElephant();
    el.root.scale.setScalar(0.95);
    const duchess = this.critter(el.root, 'elephant', (c, _dt, moving) => {
      const sw = moving ? Math.sin(c.phase * 2) * 0.28 : 0;
      el.legs[0].rotation.z = sw; el.legs[3].rotation.z = sw; el.legs[1].rotation.z = -sw; el.legs[2].rotation.z = -sw;
      el.trunk.rotation.z = Math.sin(c.phase * 0.5 + 1) * 0.25 - 0.05;
      el.trunk.rotation.x = Math.sin(c.phase * 0.37) * 0.2;
      el.ears[0].rotation.y = -0.35 + Math.sin(c.phase * 0.9) * 0.2;
      el.ears[1].rotation.y = 0.35 - Math.sin(c.phase * 0.9) * 0.2;
    });
    duchess.groundY = null;
    duchess.turn = 2.5;
    duchess.enter(inCar.clone(), ramp);
    // keep the special's doors (and so her ramp origin) open for as long as she is ashore
    let ashore = true;
    const leftNow = () => { const d = this.safe(() => ctx.reg.trains.expectedDeparture(trainId), null); return d === null ? 99 : d - this.now; };
    this.tick(() => { if (ashore && leftNow() < 5) this.safe(() => ctx.reg.trains.holdDoors?.(trainId, this.now + 5), undefined); });
    yield duchess.goto(start, 0.9);
    this.cue('band', start, 1);
    this.cue('cheer', start, 0.8);
    crowd.forEach((id) => this.actors.anim(id, 'cheer'));
    this.cueLoop('band', [7, 11], () => el.root.position, 0.8);
    this.marker('♪', () => (duchess.present ? el.root.position : null), { lift: 4.0 });

    const handler = this.actors.fromTrain('ringmaster', door, {}) ;
    let follow = true;
    this.tick(() => {
      if (!follow || !handler) return;
      const h = this.actors.pos(handler);
      const p = el.root.position;
      const d = Math.hypot(h.x - p.x, h.z - p.z);
      if (d > 3.4) duchess.goto(new THREE.Vector3(p.x + (h.x - p.x) * (1 - 3.2 / d), 1, p.z + (h.z - p.z) * (1 - 3.2 / d)), 1.9);
    });
    this.gazette('Duchess the elephant parades the length of the Highland platform to thunderous applause');
    yield 3;
    // the parade lasts as long as the special stands: Duchess must be back in her car well before it leaves
    const left = () => { const d = this.safe(() => ctx.reg.trains.expectedDeparture(trainId), null); return d === null ? 99 : d - this.now; };
    const startAlong = alongOf(ctx, pid, start);
    if (handler) {
      const route: [number, number][] = [[startAlong + 7, 4.8], [startAlong + 9, 3.4], [startAlong + 2, 5.4], [startAlong - 4, 4.4]];
      let k = 0;
      while (left() > 16 && k < 8) {
        const [a, lat] = route[k % route.length];
        const w = this.walk(handler, onPlatform(ctx, pid, a, lat), { direct: true, speed: 1.4 });
        yield { until: () => (typeof w === 'object' ? w.until() : true) || left() < 13, max: 12 };
        this.actors.anim(handler, 'wave');
        this.cue('cheer', el.root.position, 0.5);
        yield 1.5;
        k++;
      }
      this.cue('cheer', el.root.position, 0.9);
      const wb = this.walk(handler, start.clone().addScaledVector(inwardV, 3.2), { direct: true, speed: 1.2 });
      yield { until: () => (typeof wb === 'object' ? wb.until() : true) || left() < 8, max: 12 };
    } else yield { until: () => left() < 14, max: 20 };
    follow = false;
    // back up the ramp into her car (briskly, if the guard is already looking at his watch)
    yield duchess.goto(start, left() < 8 ? 2.2 : 1.2);
    yield duchess.goto(inCar, left() < 8 ? 2.0 : 1.0);
    duchess.leave();
    ashore = false;
    if (handler) { const o = this.actors.trainDoor(door); this.actors.remove(handler, o ?? undefined); }
    yield 2;
    crowd.forEach((id) => this.actors.remove(id));
    yield { until: () => departed, max: 40 };
    yield 4;
  }
}

export { dwellingAt, doorNear };
export const animalEvents: EventDef[] = [
  {
    id: 'goose', title: 'Runaway Goose', blurb: 'A market goose escapes from a farmer’s basket onto a platform, pursued by a porter.',
    cooldown: 600, condition: (e) => hr(e) > 6 && hr(e) < 20 && wx(e) !== 'storm', weight: () => 0.7,
    create: (e) => new GooseEvent(e),
  },
  {
    id: 'cat', title: 'Cat on the Line', blurb: "The Stationmaster's cat naps on the track; trains are held until a porter carries it off.",
    cooldown: 900, condition: (e) => wx(e) !== 'storm' && wx(e) !== 'snow', weight: () => 0.55,
    create: (e) => new CatEvent(e),
  },
  {
    id: 'cow', title: 'Cow on the Line', blurb: 'A cow wanders out of Shed Meadow onto the Coast Line until the farmer shoos her home.',
    cooldown: 1080, condition: (e) => hr(e) > 5 && hr(e) < 19, weight: () => 0.45,
    create: (e) => new CowEvent(e),
  },
  {
    id: 'circus', title: 'The Circus Comes to Town', blurb: 'A circus special calls; Duchess the elephant parades along the platform.',
    cooldown: 2880, condition: (e) => hr(e) > 9 && hr(e) < 17 && wx(e) !== 'storm', weight: () => 0.35,
    create: (e) => new CircusEvent(e),
  },
];
