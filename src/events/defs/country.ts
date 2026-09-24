/**
 * v2 COUNTRY EVENTS — the living world beyond the platforms. Every person comes from people (summon / crowd /
 * a stopped vehicle), every vehicle from traffic (depot doors / road portals), every flock from nature.herd;
 * the only things events place themselves are non-living props (apples, a hay rick, kites, buckets), and even
 * those are carried in or out by an actor where that reads naturally.
 *
 *  - motorwagen : Herr & Frau Benz putter in from Kingsport in the Patent-Motorwagen; horses shy, a crowd gathers
 *  - runaway    : a departing train's whistle startles the apple-cart horse on the forecourt; apples everywhere
 *  - sheep      : a drover's flock fills Millbridge Gates; the crossing stays open to the road until the collie clears it
 *  - rickFire   : a hay rick catches at Coldharbour; St Mary's alarm bell, the steam fire engine, a bucket chain
 *  - kite       : a blowy afternoon on Eastcote Down; children fly kites, and one gets away
 */
import * as THREE from 'three';
import type { PersonRole } from '../../core/apis';
import { Scripted, NAMES_M, type EventDef, type EventEnv } from '../base';
import type { Script } from '../runner';
import { buildApples, buildBucket, buildKite, buildRick, flameGeometry } from '../props';
import { InstProps, glowMat, puff, vcMat } from '../fx';

const hr = (e: EventEnv) => e.ctx.clock.hour;
const wx = (e: EventEnv) => e.ctx.reg.atmosphere?.weather ?? 'clear';
const fine = (e: EventEnv) => wx(e) === 'clear' || wx(e) === 'overcast';
const windMS = (e: EventEnv) => { try { return e.ctx.wind?.speed ?? e.ctx.reg.atmosphere.wind.length(); } catch { return 3; } };

const _f = new THREE.Vector3();
/** forward unit vector for a yaw (rotation.y convention: local +x → (cos, 0, −sin)) */
const fwd = (yaw: number, out = _f) => out.set(Math.cos(yaw), 0, -Math.sin(yaw));

// ═════════════════════════ THE HORSELESS CARRIAGE ═════════════════════════
class MotorwagenEvent extends Scripted {
  maxDuration = 340;
  private vid: string | null = null;
  focus(): THREE.Vector3 | null {
    const v = this.vehicle(this.vid);
    return v ? v.pos.clone().setY(0) : super.focus();
  }
  *script(): Script {
    const { ctx, rng } = this;
    const vid = this.requestVehicle({
      kind: 'motorwagen', to: 'forecourt:drop', wait: 16, then: 'E1', tag: 'benz',
      riders: [{ role: 'motorist', tag: 'benz' }, { role: 'guest', tag: 'bertha' }],
    });
    this.vid = vid;
    if (!vid) {
      this.gazette('A "horseless carriage" is reported broken down outside Kingsport, surrounded by jeering carters', 'info');
      yield 4;
      return;
    }
    this.gazette(rng.pick([
      'EXTRAORDINARY SPECTACLE! Herr Benz of Mannheim is expected upon the Kingsport Road in his Patent-Motorwagen, propelled by benzine alone',
      'A carriage that needs no horse! Herr and Frau Benz are motoring toward the Junction "at the terrifying speed of eight miles in the hour"',
    ]));
    // exhaust puffs and nervous horses along its way
    let puffT = 0, scareT = 0;
    this.tick((dt, dm) => {
      const v = this.vehicle(vid);
      if (!v || v.state === 'gone') return;
      puffT -= dt;
      const running = v.state === 'driving' || cranked;
      if (running && puffT <= 0 && dt > 0) {
        puffT = v.speed > 0.5 ? 0.18 : 0.45;
        const back = v.pos.clone().addScaledVector(fwd(v.yaw), -1.9);
        puff(this.env.fx, back.setY(v.pos.y + 0.55), 0x8f98a8, { vx: -Math.cos(v.yaw) * 0.6, vy: 0.5, vz: Math.sin(v.yaw) * 0.6, size: 0.22, life: 1.8, grow: 3.2 });
      }
      scareT -= dm;
      if (v.state === 'driving' && scareT <= 0) {
        scareT = 1.2;
        this.safe(() => ctx.reg.nature.scare(v.pos.clone(), 28), undefined);
      }
    });
    let cranked = false;
    this.marker('!', () => { const v = this.vehicle(vid); return v && v.state !== 'gone' ? v.pos : null; }, { lift: 2.6 });
    yield this.vehicleAt(vid, 'forecourt:drop', 200);
    const v0 = this.vehicle(vid);
    if (!v0 || v0.state === 'gone') return;
    const car = v0.pos.clone();
    this.cue('honk', car, 0.9);
    // the whole forecourt comes to look
    const crowd = this.actors.crowd(10, car, 'passenger', 4);
    crowd.forEach((id, i) => {
      const a = (i / Math.max(1, crowd.length)) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const r = rng.range(3.2, 5.0);
      this.walk(id, new THREE.Vector3(car.x + Math.cos(a) * r, 0, car.z + Math.sin(a) * r));
    });
    this.after(3, () => crowd.forEach((id) => { this.actors.look(id, car); this.actors.anim(id, this.rng.chance(0.4) ? 'point' : 'cheer'); }));
    // the Benzes step down (riders of the stopped car), or out of it if people could not seat them
    let riders = this.alight(vid, 'motorist', car);
    if (!riders.length) riders = this.actors.inside(`veh:${vid}`, [{ role: 'motorist' }, { role: 'guest' }]);
    const herr = riders[0] ?? null, frau = riders[1] ?? null;
    this.gazette(rng.pick([
      'The Motorwagen draws up at the Junction amid a cloud of blue smoke; three cab horses bolt and a curate is heard to swear',
      'Herr Benz halts his machine upon the forecourt and invites the Stationmaster to inspect the engine. The Stationmaster declines.',
    ]));
    if (herr) { yield this.walk(herr, car.clone().addScaledVector(fwd(v0.yaw), 1.9)); this.actors.anim(herr, 'work'); this.actors.look(herr, car); }
    if (frau) { this.walk(frau, car.clone().add(new THREE.Vector3(1.4, 0, 1.2))); this.actors.idle(frau, 'chat'); }
    yield rng.range(5, 8);
    // cranking: cough, cough … BANG — the cab rank goes up in the air
    for (let i = 0; i < 3; i++) {
      this.cue('motor', car, 0.7);
      puff(this.env.fx, car.clone().addScaledVector(fwd(v0.yaw), -1.9).setY(0.6), 0x6a7080, { vy: 1, size: 0.4, life: 2, grow: 3 });
      yield 0.8;
    }
    this.cue('pistol', car, 0.55);
    for (let i = 0; i < 10; i++) puff(this.env.fx, car.clone().addScaledVector(fwd(v0.yaw), -2).setY(0.6), 0x5a606c, { vx: (Math.random() - 0.5) * 2, vy: 1.2, vz: (Math.random() - 0.5) * 2, size: 0.5, life: 2.4, grow: 3 });
    cranked = true;
    try {
      const rank = ctx.layout.forecourtTraffic.rank[0].pos.clone();
      ctx.reg.traffic.scare(car.clone(), 30);
      ctx.bus.emit('animal:scared', { pos: rank, radius: 30 });
    } catch { /* stub */ }
    crowd.forEach((id) => this.actors.anim(id, 'cheer'));
    this.cue('cheer', car, 0.8);
    this.gazette('With a report like a cannon the machine springs into life; the crowd applauds and the cab horses do not', 'info');
    yield 3;
    // back aboard and away up the Kingsport Road
    const anchor = this.safe(() => ctx.reg.traffic.anchorOf(vid), null);
    const aboard = [herr, frau].filter((x): x is string => !!x);
    if (anchor && aboard.length) {
      yield this.actors.embark(aboard, anchor, 10);
      for (const id of aboard) {
        const pid = this.actors.pid(id);
        if (pid && this.safe(() => ctx.reg.people.get(pid)?.riding, undefined)) this.actors.release(id);
      }
    }
    // anyone who could not climb back in goes through the station (people's own sink logic)
    aboard.forEach((id) => { if (this.actors.has(id)) this.actors.remove(id, 'door:station:east'); });
    this.releaseVehicle(vid);
    this.cue('honk', car, 0.8);
    yield 4;
    crowd.forEach((id) => this.actors.remove(id));
    this.gazette('The Motorwagen chugs away toward Kingsport. "It will never catch on," says the Crown\'s ostler.', 'info');
    yield { until: () => { const v = this.vehicle(vid); return !v || v.state === 'gone'; }, max: 40 };
  }
}

// ═════════════════════════ RUNAWAY HORSE ═════════════════════════
// The Kingsport cider-apple cart delivers to the Parcels Office; a departing express whistles, the horse shies and
// bolts a few yards, and a crate of apples goes everywhere. The constable catches the bridle; porters and the
// newsboy gather the apples (the newsboy eats a good share) and carry the crate into the booking hall.
class RunawayEvent extends Scripted {
  maxDuration = 200;
  private at: THREE.Vector3 | null = null;
  private vid: string | null = null;
  focus(): THREE.Vector3 | null { const v = this.at ? null : this.vehicle(this.vid); return this.at?.clone() ?? v?.pos.clone().setY(0) ?? super.focus(); }
  *script(): Script {
    const { ctx, rng } = this;
    const vid = this.requestVehicle({ kind: 'farmcart', from: 'mews', to: 'forecourt:drop', wait: 18, tag: 'apples', riders: [{ role: 'carter' }] });
    this.vid = vid;
    if (!vid) return;
    this.gazette('The Crown\'s cart sets out from the mews with cider apples for the Parcels Office', 'info');
    yield this.vehicleAt(vid, 'forecourt:drop', 120);
    const v = this.vehicle(vid);
    if (!v || v.state === 'gone') return;
    this.at = v.pos.clone();
    // wait for a whistle (a departing train), or give one ourselves after a few minutes
    let whistled = false;
    this.on('train:departing', () => { whistled = true; });
    yield { until: () => whistled, max: rng.range(4, 9) };
    if (!whistled) {
      const p = ctx.layout.platforms[1].center.clone().setY(2);
      this.cue('whistle', p, 1);
    }
    const cart = this.vehicle(vid);
    const pos = (cart ?? v).pos.clone();
    const yaw = (cart ?? v).yaw;
    this.at = pos.clone();
    try { ctx.reg.traffic.scare(pos.clone(), 9); } catch { /* stub */ }
    ctx.bus.emit('animal:scared', { pos: pos.clone(), radius: 12 });
    this.cue('horse', pos, 1);
    this.cue('shout', pos, 0.8);
    // the crate slides off the tail: apples everywhere (props that fall off the cart — non-living)
    const tail = pos.clone().addScaledVector(fwd(yaw), -2.4);
    tail.y = ctx.layout.heightAt(tail.x, tail.z);
    const apples = buildApples(38, () => rng.next());
    apples.position.copy(tail);
    apples.rotation.y = yaw;
    apples.scale.setScalar(0.05);
    this.group.add(apples);
    let spill = 0;
    this.tick((_dt, dm) => { if (spill < 1) { spill = Math.min(1, spill + dm * 1.6); apples.scale.setScalar(Math.max(0.05, spill)); } });
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      this.env.fx.puffs.emit(tail.x, tail.y + 0.8, tail.z, Math.cos(a) * 2.6, 2 + Math.random() * 2, Math.sin(a) * 2.6, { color: Math.random() < 0.3 ? 0x9aa83a : 0xb8322a, size: 0.09, life: 0.9, gravity: 9, grow: 1 });
    }
    this.gazette(rng.pick([
      'RUNAWAY! The apple-cart horse takes fright at the express whistle and bolts across the forecourt; a crate of pippins is scattered to the four winds',
      'Pandemonium upon the forecourt: a startled cob, a flying crate, and apples "as far as the eye could see"',
    ]), 'warn');
    this.marker('!', () => (spill < 1 || apples.visible ? tail : null), { lift: 1.8 });
    // the constable catches the bridle
    const cop = this.actors.summon('constable', pos.clone().addScaledVector(fwd(yaw), 2.6), { run: true, timeoutMin: 60 });
    // the gatherers: two porters and the newsboy
    const porters = [this.actors.summon('porter', tail.clone().add(new THREE.Vector3(1.2, 0, 0.6)), { from: 'door:station:east', run: true }),
      this.actors.summon('porter', tail.clone().add(new THREE.Vector3(-1, 0, 1)), { from: 'door:station:east' })].filter((x): x is string => !!x);
    const boy = this.actors.summon('newsboy', tail.clone().add(new THREE.Vector3(0.4, 0, -1.3)), { run: true });
    const onlookers = this.actors.crowd(5, tail.clone().add(new THREE.Vector3(3, 0, 3)), 'passenger', 4);
    onlookers.forEach((id) => { this.actors.look(id, tail); this.actors.anim(id, 'point'); });
    if (cop) {
      yield { until: () => { const w = this.actors.arrived(cop, 2); return typeof w === 'object' ? w.until() : true; }, max: 25 };
      this.actors.anim(cop, 'lead');
      this.actors.look(cop, pos);
      this.gazette('P.C. Dobbs seizes the bridle and speaks soothingly to the horse, "as to a magistrate"', 'info');
    }
    const gatherers = [...porters, ...(boy ? [boy] : [])];
    yield this.all(gatherers.map((id) => this.actors.arrived(id, 2)), 30);
    gatherers.forEach((id) => this.actors.anim(id, 'work'));
    if (boy) this.after(2.5, () => { this.actors.anim(boy, 'drink'); this.cue('cheer', tail, 0.3); });
    // picking up: the heap shrinks
    const dur = rng.range(7, 11);
    let left = 1;
    this.tick((_dt, dm) => { if (spill >= 1 && left > 0) { left = Math.max(0, left - dm / dur); apples.scale.set(Math.max(0.05, left), 1, Math.max(0.05, left)); } });
    yield { until: () => left <= 0, max: dur + 6 };
    this.gazette(rng.pick([
      'The apples are gathered up, less some forty the newsboy is unable to account for',
      'Order restored: the crate is returned to the Parcels Office and the horse is given a carrot by way of apology',
    ]), 'info');
    // the crate goes into the booking hall with a porter
    apples.visible = false;
    const crate = buildApples(0, () => rng.next());
    crate.position.copy(tail);
    this.group.add(crate);
    if (porters[0]) this.carryOut(crate, porters[0], { to: 'door:station:east', y: 0.9, fwd: 0.45 });
    porters.slice(1).forEach((id) => this.actors.remove(id, 'door:station:east'));
    if (boy) this.actors.remove(boy);
    onlookers.forEach((id) => this.actors.remove(id));
    if (cop) { this.actors.anim(cop, 'idle'); yield 2; this.actors.remove(cop); }
    this.releaseVehicle(vid);
    yield 3;
  }
}

// ═════════════════════════ SHEEP AT MILLBRIDGE GATES ═════════════════════════
// The Eastcote Down flock is moved to the Kingsmead water meadow: the drover and his collie bring them down
// Millbridge Lane and over the level crossing. The road fills with sheep, the gates stay open to the road (nature's
// flock occupies it; traffic's interlock keeps trains back) and any train must wait at the gate signal until the
// collie has swept the last ewe across. (Sheep walk at their own pace — about two sim-hours from the Down.)
class SheepEvent extends Scripted {
  maxDuration = 420;
  private tag = '';
  private centroid = new THREE.Vector3();
  private have = false;
  focus(): THREE.Vector3 | null { return this.have ? this.centroid.clone() : this.ctx.layout.crossings[0].center.clone(); }
  /** the moving flock: tagged members (from a portal) or sheep being herded near Millbridge Lane (from a field) */
  private flock() {
    const lc = this.ctx.layout.crossings[0].center;
    try {
      return this.ctx.reg.nature.list('sheep').filter((c) => c.group === this.tag || (c.state === 'herded' && Math.hypot(c.pos.x - lc.x, c.pos.z - lc.z) < 190));
    } catch { return []; }
  }
  *script(): Script {
    const { ctx, rng } = this;
    const X = ctx.layout.crossings[0];
    const lc = X.center.clone();
    this.tag = `events:sheep:${Math.round(this.now)}`;
    let done = false;
    this.on('animal:herded', (e) => { if (e.tag === this.tag) done = true; });
    // from the Down if it has sheep, else a drover's flock off the Kingsport road
    const tryHerd = (from: string) => {
      try { return ctx.reg.nature.herd('sheep', from, 'FE', { count: rng.int(12, 18), dog: true, tag: this.tag }); } catch { return null; }
    };
    let from = 'FH';
    let p = tryHerd(from);
    let failed = false;
    if (p) void p.then((r) => { if (!r) failed = true; else done = true; }, () => { failed = true; });
    this.tick(() => {
      const f = this.flock();
      this.have = f.length > 0;
      if (!this.have) return;
      this.centroid.set(0, 0, 0);
      for (const c of f) this.centroid.add(c.pos);
      this.centroid.multiplyScalar(1 / f.length);
    });
    yield { until: () => this.have || failed, max: 2 };
    if (!this.have) {
      from = 'E1';
      failed = false;
      p = tryHerd(from);
      if (p) void p.then((r) => { if (!r) failed = true; else done = true; }, () => { failed = true; });
      yield { until: () => this.have || failed, max: 2 };
    }
    if (!this.have) {
      this.gazette('A flock bound for Kingsmead is turned back at the Kingsport toll-gate; Millbridge Lane is spared', 'info');
      yield 2;
      return;
    }
    const name = rng.pick(['Old Amos Pettigrew', 'Jem Stoker', 'Eli Hatherley', 'young Tom Budd']);
    this.gazette(from === 'FH'
      ? `${name} moves the Eastcote Down flock to Kingsmead meadow by way of Millbridge Lane; carters advised to be patient`
      : `${name} brings a flock in off the Kingsport Road for Kingsmead meadow; carters advised to be patient`, 'info');
    this.marker('!', () => (this.have ? this.centroid : null), { lift: 3.0 });
    this.cueLoop('sheep', [3, 7], () => (this.have ? this.centroid : undefined), 0.7);
    this.cueLoop('dog', [6, 12], () => (this.have ? this.centroid : undefined), 0.5);
    // the flock reaches the gates
    const near = (r: number) => this.flock().some((c) => Math.hypot(c.pos.x - lc.x, c.pos.z - lc.z) < r);
    yield { until: () => near(16) || done, max: 330 };
    if (!near(16)) { yield 1; return; }
    let train: string | null = null;
    try { train = ctx.reg.trains.eta('coast', X.t, 420)?.trainId ?? null; } catch { train = null; }
    const tName = train ? this.safe(() => ctx.reg.trains.get(train!)?.name, undefined) : undefined;
    this.gazette(tName
      ? `SHEEP AT THE GATES! Millbridge Gates choked with sheep; the ${tName} waits at the gate signal, whistling "in a tone of injured dignity"`
      : 'SHEEP AT THE GATES! Millbridge Lane and the level crossing vanish beneath a sea of wool; the crossing-keeper leans on his gate and lights his pipe', 'warn');
    this.cue('sheep', lc, 1);
    // a waiting train whistles now and then
    const whistle = this.cueLoop('whistle', [9, 16], () => (train ? ctx.layout.lines.coast.pointAt(X.trainStopT.east).setY(3) : undefined), train ? 0.6 : 0);
    yield { until: () => !near(9), max: 60 };
    whistle();
    this.gazette('The last ewe is chivvied over the crossing by the collie; the gates swing to and the railway resumes its business', 'info');
    yield { until: () => done, max: 60 };
    yield 1;
  }
}

// ═════════════════════════ RICK FIRE AT COLDHARBOUR ═════════════════════════
class RickFireEvent extends Scripted {
  maxDuration = 320;
  private at = new THREE.Vector3();
  focus(): THREE.Vector3 | null { return this.at.clone(); }
  *script(): Script {
    const { ctx, rng } = this;
    const town = ctx.layout.towns.find((t) => t.id === 'coldharbour');
    const yard = town?.areas.find((a) => a.kind === 'rickyard');
    const pondA = town?.areas.find((a) => a.kind === 'pond');
    const base = yard ? yard.center.clone() : new THREE.Vector3(-187, 2, 207);
    // a fresh rick built beside the stackyard on the side the usual (ESE) camera sees — world's ricks fill the yard.
    // First candidate spot that is clear ground, away from the farm buildings.
    const cands: [number, number][] = [[15, 7], [16, -1], [6, 13], [-3, 13], [14, 14], [0, 0]];
    const rp = new THREE.Vector3(base.x, 0, base.z);
    for (const [dx, dz] of cands) {
      const x = base.x + dx, z = base.z + dz;
      const clearGround = this.safe(() => ctx.layout.terrain.clear(x, z, 3), true);
      const nearB = ctx.layout.buildings.some((b) => Math.hypot(b.center.x - x, b.center.z - z) < Math.max(b.size.x, b.size.z) / 2 + 5);
      if (clearGround && !nearB) { rp.set(x, 0, z); break; }
    }
    rp.y = ctx.layout.heightAt(rp.x, rp.z);
    this.at.copy(rp);
    // the rick is set up while nobody is looking
    yield { until: () => !this.safe(() => ctx.view.isVisible(rp, 8), false), max: 4 };
    const rick = buildRick();
    rick.root.position.copy(rp);
    rick.root.scale.setScalar(0.8);
    this.group.add(rick.root);
    // fire state
    let level = 0.05, target = 1, charred = 0, out = false, grow = true;
    const flames = new InstProps(this.group, flameGeometry(), 12, glowMat(0xff6414, 1.75), false).cull(rp, 9);
    const light = this.env.fx.lights.acquire(this);
    this.onCleanup(() => this.env.fx.lights.release(light));
    light.color.set(0xff8a3a); light.distance = 38;
    let ph = 0, smokeT = 0;
    const wind = () => { try { return ctx.reg.atmosphere.wind; } catch { return new THREE.Vector2(1, 0); } };
    const _p = new THREE.Vector3();
    this.tick((dt, dm) => {
      ph += dt;
      if (grow) level = Math.min(target, level + dm * 0.09);
      charred = Math.max(charred, Math.min(1, level * 0.9 + (out ? 1 : 0)));
      rick.setChar(Math.min(1, charred));
      const f = out ? 0 : level;
      // tongues of flame licking up the outside of the drum (8) and out of the thatched cap (4); they spread as
      // the fire takes hold (ring k lights at level k/8)
      for (let i = 0; i < 12; i++) {
        const drum = i < 8;
        const a = drum ? (i / 8) * Math.PI * 2 + 0.3 : ((i - 8) / 4) * Math.PI * 2 + 1.1;
        const r = drum ? 2.35 : 1.25;
        const fl = 0.75 + 0.25 * Math.sin(ph * (9 + i) + i * 2) + 0.12 * Math.sin(ph * 23 + i);
        const lit = THREE.MathUtils.clamp((f - (drum ? i / 10 : 0.35)) * 3, 0, 1);
        _p.set(rp.x + Math.cos(a) * r, rp.y + (drum ? 0.5 + (i % 3) * 0.35 : 2.6), rp.z + Math.sin(a) * r);
        const h = (drum ? 1.8 + (i % 3) * 0.5 : 2.6) * fl * lit;
        flames.set(i, _p, a, new THREE.Vector3(1.1 * lit + 1e-3, h + 1e-3, 1.1 * lit + 1e-3));
      }
      flames.commit();
      light.position.set(rp.x, rp.y + 4, rp.z);
      const night = this.safe(() => ctx.reg.atmosphere.nightFactor, 0);
      light.intensity = f > 0.02 ? (40 + 25 * Math.sin(ph * 11)) * f * (0.5 + night) : 0;
      // the smoke column leans with the wind
      smokeT -= dt;
      const smoke = out ? Math.max(0, 1 - charred * 0.2) * 0.25 : 0.2 + f * 0.8;
      if (dt > 0 && smokeT <= 0 && (level > 0.02 || out)) {
        smokeT = 0.12 / Math.max(0.15, smoke);
        const w = wind();
        const col = out ? 0xd8d8d8 : f > 0.5 ? 0x3a3634 : 0x6a6660;
        puff(this.env.fx, _p.set(rp.x + (Math.random() - 0.5) * 2, rp.y + 4.2, rp.z + (Math.random() - 0.5) * 2), col, { vx: w.x * 0.5, vy: 2.2 + f * 1.5, vz: w.y * 0.5, size: 0.7 + f * 0.6, life: 5 + f * 3, grow: 4.5 });
      }
    });
    this.gazette('Smoke is seen rising over Coldharbour Farm; a rick is believed to have fired in the heat', 'info');
    this.marker('!', () => (out ? null : rp), { lift: 7 });
    yield 2;
    // the alarm: St Mary's bell, and the Ashcombe Volunteer Fire Brigade turns out
    ctx.bus.emit('town:bell', { kind: 'alarm', town: 'ashcombe' });
    let bellT = 5;
    this.tick((_dt, dm) => { if (out) return; bellT -= dm; if (bellT <= 0) { bellT = 6; ctx.bus.emit('town:bell', { kind: 'alarm', town: 'ashcombe' }); } });
    this.cueLoop('fire', [3, 6], () => (out ? undefined : rp), 0.8);
    this.gazette(rng.pick([
      'FIRE AT COLDHARBOUR! A hay rick is ablaze; St Mary\'s bell rings the alarm and the Ashcombe Volunteer Fire Brigade turns out with the steam engine',
      'RICK FIRE! Flames seen from the Junction footbridge; the Brigade\'s engine gallops out of Ashcombe "at a pace to frighten the parish"',
    ]), 'warn');
    const barnDoor = 'door:coldharbour:barn1:0';
    const engine = this.requestVehicle({ kind: 'fireengine', to: barnDoor, wait: 60, tag: 'fire', riders: [{ role: 'firefighter' }, { role: 'firefighter' }, { role: 'firefighter' }] });
    // the farm turns out: a bucket chain from the duck pond
    const pond = pondA ? pondA.center.clone() : rp.clone().add(new THREE.Vector3(-16, 0, -46));
    const chainA = pond.clone().lerp(rp, (pondA ? Math.max(pondA.size.x, pondA.size.z) * 0.55 : 6) / Math.max(1, pond.distanceTo(rp)));
    const chainB = rp.clone().lerp(pond, 3.2 / Math.max(1, pond.distanceTo(rp)));
    const hands = this.actors.crowd(7, rp.clone().lerp(pond, 0.5), 'farmhand', 6, 80);
    const posts = hands.map((_, i) => {
      const p = chainA.clone().lerp(chainB, hands.length > 1 ? i / (hands.length - 1) : 0.5);
      p.y = ctx.layout.heightAt(p.x, p.z);
      return p;
    });
    hands.forEach((id, i) => this.walk(id, posts[i]));
    const buckets = new InstProps(this.group, (buildBucket().children[0] as THREE.Mesh).geometry, 6, vcMat(), false).cull(rp.clone().lerp(pond, 0.5), pond.distanceTo(rp) * 0.5 + 6);
    const inChain = hands.map(() => false);
    let bucketPh = 0, fireAge = 0;
    this.tick((dt, dm) => {
      hands.forEach((id, i) => {
        if (inChain[i]) return;
        const a = this.actors.pos(id);
        if (Math.hypot(a.x - posts[i].x, a.z - posts[i].z) < 1.4) { inChain[i] = true; this.actors.anim(id, 'carry'); this.actors.look(id, rp); }
      });
      const working = inChain.filter(Boolean).length;
      const chainOn = working >= Math.max(2, Math.ceil(hands.length * 0.6)) && !out;
      bucketPh += chainOn ? dt * 0.35 : 0;
      for (let k = 0; k < 6; k++) {
        if (!chainOn) { buckets.set(k, rp, 0, 0); continue; }
        const u = (bucketPh + k / 6) % 1;
        _p.copy(chainA).lerp(chainB, u);
        _p.y = ctx.layout.heightAt(_p.x, _p.z) + 1.05;
        buckets.set(k, _p, 0, 1);
      }
      buckets.commit();
      fireAge += dm;
      if (chainOn && fireAge > 10) {
        target = Math.max(0, target - dm * 0.0036 * working);
        if (dt > 0 && Math.random() < dt * 1.5) puff(this.env.fx, chainB.clone().setY(rp.y + 1.8), 0xe8eef2, { vx: (rp.x - chainB.x) * 0.5, vy: 2.6, vz: (rp.z - chainB.z) * 0.5, size: 0.25, life: 1.2, grow: 2 });
      }
    });
    // the engine: whenever it gets here (it has a long way to come) it pumps from the pond; if the chain has already
    // won, the crew stand about, accept cider and go home
    let pumping = false, engineArrived = false;
    let engineAtBarn = false;
    this.on('vehicle:arrived', (e) => { if (e.vehicleId === engine && e.stop === barnDoor) engineAtBarn = true; });
    // (a vehicle still waiting inside its depot is not 'driving' either: it must actually be here)
    const engineHere = () => { const v = this.vehicle(engine); return !!v && v.state !== 'driving' && v.state !== 'gone' && (engineAtBarn || v.pos.distanceTo(rp) < 45); };
    let jetT = 0;
    const nozzle = new THREE.Vector3();
    this.tick((dt, dm) => {
      if (!engineArrived && engine && engineHere()) {
        engineArrived = true;
        const ev = this.vehicle(engine)!;
        const crew = this.alight(engine, 'firefighter', rp.clone().lerp(ev.pos, 0.5));
        nozzle.copy(rp).lerp(ev.pos, 5 / Math.max(1, rp.distanceTo(ev.pos)));
        nozzle.y = ctx.layout.heightAt(nozzle.x, nozzle.z);
        crew.forEach((id, i) => { this.walk(id, nozzle.clone().add(new THREE.Vector3(i * 0.9 - 0.9, 0, (i % 2) * 0.8))); this.after(3, () => { this.actors.anim(id, out ? 'drink' : 'work'); this.actors.look(id, rp); }); });
        if (!out) { pumping = true; this.gazette('The Brigade arrives in a lather; the steam pump is set in the duck pond and a jet is played upon the rick', 'info'); }
        else this.gazette('The Brigade arrives to find the fire already out; the crew accept cider "in lieu of a blaze"', 'info');
      }
      if (!pumping || out) return;
      const ev = this.vehicle(engine);
      target = Math.max(0, target - dm * 0.06);
      jetT -= dt;
      if (dt > 0 && jetT <= 0) {
        jetT = 0.06;
        const d = rp.clone().sub(nozzle); d.y = 0;
        const L = d.length(); d.normalize();
        puff(this.env.fx, nozzle.clone().setY(nozzle.y + 1.2), 0xdfeef6, { vx: d.x * L * 0.55, vy: 5.2, vz: d.z * L * 0.55, size: 0.14, life: 1.4, grow: 1.6, gravity: 7 });
      }
      // the engine's own firebox smoke
      if (ev && dt > 0 && Math.random() < dt * 3) puff(this.env.fx, ev.pos.clone().setY(ev.pos.y + 2.4), 0x4a4644, { vy: 1.6, size: 0.3, life: 2.5, grow: 3 });
    });
    yield { until: () => level <= 0.03, max: 150 };
    out = true;
    this.gazette(rng.pick([
      'The rick fire at Coldharbour is extinguished; the rick is lost but the barn is saved. Farmer Hatherley stands the Brigade a barrel of cider.',
      'FIRE OUT. The Brigade is commended; a small boy with a box of lucifers is "helping the constable with his enquiries"',
    ]));
    this.cue('cheer', rp, 0.6);
    yield 5;
    // the charred remains are forked apart and carted off (a Brigade still on the road is stood down)
    pumping = false;
    if (engine) { if (engineArrived) this.after(12, () => this.releaseVehicle(engine)); else this.releaseVehicle(engine); }
    this.actors.ids().forEach((id) => { if (!hands.includes(id)) this.actors.remove(id, barnDoor); });
    hands.slice(0, 3).forEach((id, i) => { this.walk(id, rp.clone().add(new THREE.Vector3(Math.cos(i * 2.1) * 3.2, 0, Math.sin(i * 2.1) * 3.2))); this.after(2, () => this.actors.anim(id, 'pitchfork')); });
    hands.slice(3).forEach((id) => this.actors.remove(id));
    let pile = 1;
    this.tick((_dt, dm) => { if (out) { pile = Math.max(0, pile - dm / 14); rick.root.scale.set(0.8 + (1 - pile) * 0.3, 0.8 * Math.max(0.02, pile), 0.8 + (1 - pile) * 0.3); } });
    yield { until: () => pile <= 0.02, max: 20 };
    rick.root.visible = false;
    yield 1;
  }
}

// ═════════════════════════ KITE DAY ON EASTCOTE DOWN ═════════════════════════
const KITE_COLS = [0xb8322a, 0x2b4a8a, 0xd9b95a, 0x5e7a3a, 0x8a3a7a];
class KiteEvent extends Scripted {
  maxDuration = 200;
  private spot = new THREE.Vector3();
  focus(): THREE.Vector3 | null { return this.spot.clone().setY(this.spot.y + 8); }
  *script(): Script {
    const { ctx, rng } = this;
    const field = ctx.layout.fields.find((f) => f.id === 'FH') ?? ctx.layout.fields[0];
    // just inside the gate, toward the middle of the Down
    const gate = field.gate.clone();
    const cen = field.center.clone();
    const spot = gate.clone().lerp(cen, 0.35);
    spot.y = ctx.layout.heightAt(spot.x, spot.z);
    this.spot.copy(spot);
    const n = rng.int(3, 5);
    const kids: string[] = [];
    const roles: PersonRole[] = ['child', 'child', 'schoolchild', 'child', 'townsfolk'];
    for (let i = 0; i < n; i++) {
      const at = spot.clone().add(new THREE.Vector3((i - n / 2) * 3.2, 0, rng.range(-2, 2)));
      at.y = ctx.layout.heightAt(at.x, at.z);
      const id = this.actors.summon(roles[i], at, { timeoutMin: 120 });
      if (id) kids.push(id);
    }
    if (!kids.length) return;
    this.gazette(rng.pick([
      'A capital blow! The children of Ashcombe take their kites up to Eastcote Down, where the wind is said to be "fit to lift a curate"',
      'KITE DAY: a fresh wind brings out every kite in the parish; Eastcote Down bright with paper and string',
    ]));
    // kites: carried in hand, then flown; strings are one LineSegments draw
    const kiteGeo = (buildKite(0xffffff).children[0] as THREE.Mesh).geometry;
    // kids walk in from Ashcombe (≤ ~90 m); the runaway kite is culled once it is well on its way
    const kites = new InstProps(this.group, kiteGeo, kids.length, vcMat(true), false).cull(spot, 110);
    /** chunky enough to read from the iso camera */
    const KS = 2.4;
    kids.forEach((_, i) => kites.color(i, KITE_COLS[i % KITE_COLS.length]));
    const strPos = new Float32Array(kids.length * 4 * 3);
    const strGeo = new THREE.BufferGeometry();
    strGeo.setAttribute('position', new THREE.BufferAttribute(strPos, 3));
    const strings = new THREE.LineSegments(strGeo, new THREE.LineBasicMaterial({ color: 0xe8e0d0, transparent: true, opacity: 0.8 }));
    strGeo.boundingSphere = new THREE.Sphere(spot.clone(), 110);
    strings.userData.ownMat = true;
    this.group.add(strings);
    type K = { state: 'carry' | 'launch' | 'fly' | 'free' | 'reel' | 'home'; line: number; pos: THREE.Vector3; ph: number; pid: string | null };
    const K: K[] = kids.map(() => ({ state: 'carry', line: 0, pos: new THREE.Vector3(), ph: rng.range(0, 6), pid: null }));
    const _q = new THREE.Vector3(), _a = new THREE.Vector3(), _w = { dir: new THREE.Vector2(), strength: 0, gust: 0 };
    const handOf = (i: number): THREE.Vector3 | null => {
      const k = K[i];
      if (k.pid) { const info = this.safe(() => ctx.reg.people.get(k.pid!), undefined); return info ? info.position : null; }
      return this.actors.has(kids[i]) ? this.actors.pos(kids[i]) : null;
    };
    this.tick((dt, dm) => {
      K.forEach((k, i) => {
        k.ph += dt;
        const h = handOf(i);
        if (!h && k.state !== 'free') { kites.set(i, k.pos, 0, 0); return; }
        const hand = _a.copy(h ?? k.pos).setY((h ?? k.pos).y + 1.2);
        ctx.wind.sample(hand.x, hand.z, _w);
        const dir = _w.dir;
        const lean = 0.6 + 0.8 * Math.min(1, ctx.wind.speed / 8);
        if (k.state === 'carry' || k.state === 'home') {
          k.pos.copy(hand).add(_q.set(0.3, 0.1, 0.2));
          kites.set(i, k.pos, 0, KS * 0.45);
        } else if (k.state === 'free') {
          // away on the wind, climbing, until it is off the map
          k.pos.x += dir.x * (4 + ctx.wind.speed) * dm; k.pos.z += dir.y * (4 + ctx.wind.speed) * dm; k.pos.y += 1.2 * dm;
          kites.set(i, k.pos, Math.atan2(dir.y, -dir.x), KS, Math.sin(k.ph * 3) * 0.6);
        } else {
          if (k.state === 'launch') k.line = Math.min(26, k.line + dm * 2.4);
          if (k.state === 'reel') k.line = Math.max(0, k.line - dm * 3.2);
          const Lk = k.line;
          const bob = Math.sin(k.ph * 1.3 + i) * 1.4 + Math.sin(k.ph * 3.1) * 0.5 * (0.5 + _w.gust);
          k.pos.set(hand.x + dir.x * Lk * 0.62 * lean + Math.sin(k.ph * 0.7 + i) * 1.5, hand.y + Lk * 0.78 + bob, hand.z + dir.y * Lk * 0.62 * lean + Math.cos(k.ph * 0.6 + i) * 1.5);
          kites.set(i, k.pos, Math.atan2(dir.y, -dir.x), KS, -0.5 + Math.sin(k.ph * 2.2 + i) * 0.25);
        }
        // string (hand → kite with a slight sag), hidden while carried / free
        const o = i * 12;
        const show = k.state === 'launch' || k.state === 'fly' || k.state === 'reel';
        const mid = _q.copy(hand).lerp(k.pos, 0.5); mid.y -= show ? Math.min(2, k.line * 0.06) : 0;
        const A = show ? hand : k.pos, B = show ? mid : k.pos, C = k.pos;
        strPos[o] = A.x; strPos[o + 1] = A.y; strPos[o + 2] = A.z; strPos[o + 3] = B.x; strPos[o + 4] = B.y; strPos[o + 5] = B.z;
        strPos[o + 6] = B.x; strPos[o + 7] = B.y; strPos[o + 8] = B.z; strPos[o + 9] = C.x; strPos[o + 10] = C.y; strPos[o + 11] = C.z;
      });
      kites.commit();
      strGeo.attributes.position.needsUpdate = true;
    });
    // they drift up in ones and twos; each launches on arrival with a running start downwind
    const launched = kids.map(() => false);
    this.tick(() => {
      kids.forEach((id, i) => {
        if (launched[i] || !this.actors.has(id)) return;
        const w = this.actors.arrived(id, 3);
        if (typeof w === 'object' && !w.until()) return;
        launched[i] = true;
        K[i].state = 'launch';
        const p = this.actors.pos(id);
        const d = ctx.wind.uniforms.uWindDir.value;
        const run = new THREE.Vector3(p.x - d.x * 7, 0, p.z - d.y * 7);
        run.y = ctx.layout.heightAt(run.x, run.z);
        this.walk(id, run, { run: true, direct: true, speed: 2.8 });
        this.after(4, () => { if (this.actors.has(id)) { K[i].state = 'fly'; this.actors.anim(id, 'point'); this.actors.look(id, K[i].pos); } });
      });
    });
    this.marker('~', () => spot, { lift: 3, px: 26 });
    yield { until: () => launched.every(Boolean), max: 130 };
    yield rng.range(25, 45);
    // one breaks its string and sails away over the edge of the map
    const lucky = rng.int(0, kids.length - 1);
    if (K[lucky].state === 'fly' && this.actors.has(kids[lucky])) {
      K[lucky].state = 'free';
      this.actors.anim(kids[lucky], 'wave');
      this.cue('shout', this.actors.pos(kids[lucky]), 0.6);
      this.gazette(rng.pick([
        'A kite breaks its string over Eastcote Down and sails off toward the coast; its small owner is consoled with a humbug',
        'One kite, having slipped its string, is last seen over Eastcote "heading for France with every appearance of intent"',
      ]), 'info');
    }
    yield rng.range(25, 40);
    // reel in and home for tea
    K.forEach((k) => { if (k.state === 'fly' || k.state === 'launch') k.state = 'reel'; });
    yield { until: () => K.every((k) => k.state !== 'reel' || k.line <= 0.2), max: 12 };
    K.forEach((k, i) => {
      if (k.state === 'free') { if (this.actors.has(kids[i])) this.actors.remove(kids[i]); return; }
      k.state = 'home';
      k.pid = this.actors.dismiss(kids[i]);
    });
    this.gazette('The kite-fliers go home for tea, very windswept and entirely happy', 'info');
    yield { until: () => K.every((k) => (k.state === 'free' ? Math.max(Math.abs(k.pos.x), Math.abs(k.pos.z)) > 440 : this.actors.gone(k.pid))), max: 150 };
  }
}

export const countryEvents: EventDef[] = [
  {
    id: 'motorwagen', title: 'The Horseless Carriage', blurb: 'Herr and Frau Benz motor in from Kingsport; horses shy, a crowd gathers, and the machine backfires.',
    cooldown: 2880, condition: (e) => hr(e) > 9 && hr(e) < 16 && wx(e) !== 'storm' && wx(e) !== 'snow', weight: () => 0.55,
    create: (e) => new MotorwagenEvent(e),
  },
  {
    id: 'runaway', title: 'Runaway Horse!', blurb: 'An express whistle startles the apple-cart horse on the forecourt; apples everywhere, the constable catches the bridle.',
    cooldown: 600, condition: (e) => hr(e) > 7 && hr(e) < 19 && wx(e) !== 'storm', weight: () => 0.8,
    create: (e) => new RunawayEvent(e),
  },
  {
    id: 'sheep', title: 'Sheep at the Gates', blurb: 'A drover’s flock fills Millbridge level crossing; the trains wait while the collie clears it.',
    cooldown: 720, condition: (e) => hr(e) > 6 && hr(e) < 18 && wx(e) !== 'storm',
    weight: (e) => (e.ctx.clock.weekday === 2 ? 2.5 : 0.5),
    create: (e) => new SheepEvent(e),
  },
  {
    id: 'rickFire', title: 'Rick Fire', blurb: 'A hay rick catches at Coldharbour Farm: the alarm bell, the steam fire engine and a bucket chain from the pond.',
    cooldown: 2880, condition: (e) => hr(e) > 10 && hr(e) < 19 && (wx(e) === 'clear' || wx(e) === 'overcast') && (e.ctx.reg.atmosphere?.temperatureC ?? 12) > 14,
    weight: () => 0.3,
    create: (e) => new RickFireEvent(e),
  },
  {
    id: 'kite', title: 'Kite Day', blurb: 'A blowy afternoon: the children fly kites on Eastcote Down, and one gets away.',
    cooldown: 1440, condition: (e) => hr(e) > 10 && hr(e) < 17 && fine(e) && windMS(e) > 4.2, weight: (e) => (windMS(e) > 6 ? 2 : 1),
    create: (e) => new KiteEvent(e),
  },
];

export { NAMES_M };
