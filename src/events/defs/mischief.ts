import * as THREE from 'three';
import type { PlatformId } from '../../core/types';
import { Scripted, NAMES_F, NAMES_M, node, onPlatform, type EventDef, type EventEnv } from '../base';
import type { Script } from '../runner';
import { buildDog, buildPurse, buildTrunk } from '../props';
import { doorNear, dwellingAt } from './animals';

const hr = (e: EventEnv) => e.ctx.clock.hour;
const wx = (e: EventEnv) => e.ctx.reg.atmosphere?.weather ?? 'clear';

// ═════════════════════════ 4. PICKPOCKET ═════════════════════════
// v2: the victim is a real traveller on the forecourt (or one who walks in); the thief sidles in from the road,
// strikes, and either escapes up Kingsport Road off the map, or is marched off to the Ashcombe Police House.
class PickpocketEvent extends Scripted {
  maxDuration = 300;
  *script(): Script {
    const { ctx, rng } = this;
    const fc = ctx.layout.forecourt;
    const c = Math.cos(fc.yaw), s = Math.sin(fc.yaw);
    const local = (lx: number, lz: number) => new THREE.Vector3(fc.center.x + lx * c + lz * s, 0, fc.center.z - lx * s + lz * c);
    const spot = local(-6, rng.range(-4, 4));
    const existing = this.actors.nearestPerson(spot, 14, ['passenger']);
    const victim = (existing && this.actors.adopt(existing, 'passenger')) || this.actors.summon('passenger', spot);
    if (!victim) return;
    const crowd = this.actors.crowd(4, spot.clone().add(new THREE.Vector3(1.5, 0, 1.5)), 'passenger', 3);
    // the thief arrives like any other traveller: off a train (through the booking hall), or out of the Railway Arms
    yield { until: () => !!dwellingAt(ctx), max: 25 };
    const tr = dwellingAt(ctx);
    const near = this.actors.pos(victim).clone().add(new THREE.Vector3(1.0, 0, -0.8));
    let thief: string | null = null;
    if (tr?.platform) {
      const d = doorNear(ctx, tr.id, onPlatform(ctx, tr.platform, 0, 2));
      const o = d ? this.actors.trainDoor(d) : null;
      if (o) { const ids = this.actors.inside(o, [{ role: 'pickpocket' }]); thief = ids[0] ?? null; if (thief) this.walk(thief, near); }
    }
    if (!thief) thief = this.actors.summon('pickpocket', near, { from: 'door:station:railwayArms:0', timeoutMin: 120 });
    if (!thief) return;
    let stalk = 0;
    this.tick((_dt, dm) => {
      stalk -= dm;
      if (stalk <= 0 && !struck) { stalk = 3; this.actors.steer(thief, this.actors.pos(victim).clone().add(new THREE.Vector3(0.9, 0, -0.7)), { speed: 1.2 }); }
    });
    let struck = false;
    this.actors.idle(victim, 'read');
    yield { until: () => { const a = this.actors.pos(thief), b = this.actors.pos(victim); return Math.hypot(a.x - b.x, a.z - b.z) < 1.8; }, max: 160 };
    struck = true;
    const victimName = rng.pick([...NAMES_F, ...NAMES_M]);
    yield 1;
    const purse = buildPurse();
    this.group.add(purse);
    const dropPurse = this.carry(purse, thief, 1.0, 0.25);
    const here = this.actors.pos(victim).clone();
    this.marker('!', () => this.actors.at(victim), { lift: 2.3 });
    this.cue('police', here, 0.8);
    this.cue('shout', here, 0.8);
    this.gazette(`STOP THIEF! ${victimName} relieved of a purse upon the forecourt; a constable gives chase`, 'warn');
    this.actors.anim(victim, 'point');
    crowd.forEach((id) => this.actors.anim(id, 'cheer'));

    const caught = rng.chance(0.55);
    const route = [local(4, rng.range(8, 12)), local(9, rng.range(-11, -7)), local(13, rng.range(-2, 6))];
    const cop = this.actors.summon('constable', here, { run: true });
    let chasing = true, steer = 0;
    this.cueLoop('police', [3, 5], () => (cop ? this.actors.pos(cop) : undefined), 0.9);
    this.tick((_dt, dm) => {
      if (!chasing || !cop) return;
      steer -= dm;
      if (steer <= 0) { steer = 1; this.actors.steer(cop, this.actors.pos(thief).clone(), { run: true, direct: true, speed: caught ? 3.9 : 3.0 }); }
    });
    const gap = () => { if (!cop) return 99; const a = this.actors.pos(cop), b = this.actors.pos(thief); return Math.hypot(a.x - b.x, a.z - b.z); };
    const thiefSpeed = caught ? 3.0 : 3.6;
    let nabbed = false;
    for (const wp of route) {
      const w = this.walk(thief, wp, { run: true, direct: true, speed: thiefSpeed });
      yield { until: () => (typeof w === 'object' && w.until()) || (caught && gap() < 1.4), max: 40 };
      if (caught && gap() < 1.4) { nabbed = true; break; }
    }
    if (caught && !nabbed) {
      const w = this.walk(thief, ctx.layout.entrance, { run: true, direct: true, speed: 2.6 });
      yield { until: () => gap() < 1.4 || (typeof w === 'object' && w.until()), max: 30 };
      nabbed = gap() < 2.5;
    }
    chasing = false;
    if (nabbed && cop) {
      const at = this.actors.pos(thief).clone();
      this.walk(thief, at, { direct: true });
      this.walk(cop, at.clone().add(new THREE.Vector3(0.8, 0, 0)), { direct: true });
      this.actors.anim(thief, 'idle');
      this.actors.anim(cop, 'work');
      this.cue('police', at, 1);
      this.gazette(rng.pick([
        'The villain is collared by P.C. Dobbs at the forecourt gate! Purse restored to its grateful owner.',
        'Pickpocket apprehended after a lively chase; the magistrate expects him Monday',
      ]));
      yield 3;
      dropPurse();
      this.carry(purse, cop, 1.0, 0.25);
      this.actors.anim(cop, 'walk');
      yield this.walk(cop, this.actors.pos(victim).clone().add(new THREE.Vector3(0.9, 0, 0)), { direct: true });
      purse.visible = false;
      this.actors.anim(victim, 'cheer');
      this.cue('cheer', spot, 0.6);
      yield 3;
      this.actors.anim(victim, 'idle');
      // marched off together up Kingsport Road to the Police House
      const station = 'door:ashcombe:police:0';
      this.actors.remove(thief, station);
      this.actors.remove(cop, station);
      crowd.forEach((id) => this.actors.remove(id));
      this.actors.remove(victim);
      yield 4;
    } else {
      // away up the Kingsport Road and off the map
      this.actors.remove(thief, 'portal:E1');
      if (cop) this.walk(cop, ctx.layout.entrance, { run: true, direct: true, speed: 3 });
      yield 10;
      if (cop) this.actors.anim(cop, 'work');
      this.gazette(rng.pick([
        'The pickpocket escapes along the station approach; P.C. Dobbs, winded, vows vengeance',
        'Thief gets clean away; passengers advised to keep a firm hand on their valuables',
      ]), 'warn');
      yield 5;
      if (cop) this.actors.remove(cop);
      crowd.forEach((id) => this.actors.remove(id));
      this.actors.remove(victim);
      yield 4;
    }
  }
}

// ═════════════════════════ 10. LOST LUGGAGE ═════════════════════════
const CONTENTS = [
  'fourteen jars of marmalade and a stuffed owl',
  'a brass telescope, three volumes of Tennyson and a single sock',
  'a complete set of croquet mallets and a tin of humbugs',
  'a quantity of love letters, which the porter was too much of a gentleman to read',
  'an ear trumpet, a Bath bun of great antiquity, and a live tortoise named Gladstone',
  'twenty-two pairs of spats',
];
// v2: the trunk is left by a departing traveller (it is on the platform when a train pulls out); its owner comes back
// for it by hansom cab, and leaves with it the same way.
class LostLuggageEvent extends Scripted {
  maxDuration = 420;
  *script(): Script {
    const { ctx, rng } = this;
    // left behind by someone who boarded in a hurry: wait for a departure, the trunk stays on the platform
    let pid = rng.pick([1, 2] as PlatformId[]);
    const tr = dwellingAt(ctx);
    if (tr?.platform) pid = tr.platform;
    const P = ctx.layout.platforms[pid];
    const spot = onPlatform(ctx, pid, (rng.chance(0.5) ? 1 : -1) * rng.range(30, 44), rng.range(4.2, 6.5));
    const trunk = buildTrunk();
    trunk.position.copy(spot);
    trunk.rotation.y = P.yaw + rng.range(-0.4, 0.4);
    // the trunk arrives with its owner, who hurries onto the waiting train without it
    const hurry = tr ? this.actors.summon('passenger', spot, { run: true, spec: { luggage: true } }) : null;
    if (hurry) {
      this.group.add(trunk);
      this.carry(trunk, hurry, 0.25, 0.7);
      yield this.actors.arrived(hurry, 1.2);
      this.stopCarry(trunk);
      trunk.position.copy(spot);
      const d = doorNear(ctx, tr!.id, spot);
      if (d) { const w = this.walk(hurry, d, { run: true }); yield { until: () => typeof w === 'object' ? w.until() : true, max: 10 }; }
      this.actors.remove(hurry, d ? this.actors.trainDoor(d) ?? undefined : undefined);
    } else {
      // no train in: a porter finds it where a traveller set it down earlier (arrives carried by the porter's colleague)
      const carrier = this.actors.summon('porter', spot, { from: `door:station:p${pid}` });
      if (!carrier) return;
      this.group.add(trunk);
      this.carry(trunk, carrier, 0.25, 0.7);
      yield this.actors.arrived(carrier, 1.2);
      this.stopCarry(trunk);
      trunk.position.copy(spot);
      this.actors.remove(carrier, `door:station:p${pid}`);
    }
    const initials = `${'ABCEGHJMPRTW'[rng.int(0, 11)]}.${'ABCDEFGHJKLMNPRSTW'[rng.int(0, 17)]}.${'BCFHMPSTW'[rng.int(0, 8)]}.`;
    const q = this.marker('?', () => trunk.position, { lift: 1.6 });
    yield rng.range(4, 9);
    this.gazette(`MYSTERY TRUNK: A steamer trunk initialled "${initials}" discovered unattended upon Platform ${pid}`, 'info');
    const door = node(ctx, `p${pid}Door`);
    const near = spot.clone().addScaledVector(P.inward, 0.9);
    const porter = this.actors.summon('porter', near, { from: `door:station:p${pid}` });
    if (!porter) return;
    yield this.actors.arrived(porter, 1.2);
    this.actors.anim(porter, 'work');
    yield rng.range(3, 5);
    this.dropMarker(q);
    this.actors.anim(porter, 'carry');
    this.carry(trunk, porter, 0.25, 0.7);
    const alongDir = new THREE.Vector3(Math.cos(P.yaw), 0, -Math.sin(P.yaw));
    const office = door.clone().addScaledVector(P.inward, -1.4).addScaledVector(alongDir, 1.4);
    yield this.walk(porter, office);
    this.stopCarry(trunk);
    trunk.position.copy(door).addScaledVector(alongDir, 2.6).addScaledVector(P.inward, -0.4);
    trunk.position.y = door.y;
    trunk.rotation.y = P.yaw;
    this.gazette(`The trunk "${initials}" is conveyed to the Lost Property Office. The Stationmaster suspects "an absent-minded curate".`, 'info');
    yield this.walk(porter, door.clone().addScaledVector(alongDir, 1.2).addScaledVector(P.inward, -1.0));
    this.actors.idle(porter, 'wait');
    yield rng.range(10, 25);

    const female = rng.chance(0.5);
    const ownerName = rng.pick(female ? NAMES_F : NAMES_M);
    const meet = door.clone().addScaledVector(alongDir, 3.8).addScaledVector(P.inward, -1.0);
    // the owner returns by hansom from the Crown Mews
    const cab = this.requestVehicle({ kind: 'cab', to: 'forecourt:drop', riders: [{ role: female ? 'guest' : 'passenger' }], wait: 40, tag: 'lostLuggage' });
    let owner: string | null = null;
    if (cab) {
      yield this.vehicleAt(cab, 'forecourt:drop', 140);
      owner = this.alight(cab, 'passenger')[0] ?? null;
    }
    if (!owner) owner = this.actors.summon(female ? 'guest' : 'passenger', meet);
    if (!owner) return;
    const o = owner;
    const wo = this.walk(o, meet);
    const ex = this.marker('!', () => this.actors.at(o), { lift: 2.3 });
    yield wo;
    this.dropMarker(ex);
    this.marker('♥', () => this.actors.at(o), { lift: 2.3, bg: '#f6e7ee', fg: '#9a2040' });
    this.actors.anim(o, 'cheer');
    this.actors.anim(porter, 'cheer');
    this.cue('cheer', trunk.position, 0.5);
    this.gazette(`HAPPY REUNION: ${ownerName} is restored to trunk "${initials}", found to contain ${rng.pick(CONTENTS)}.`);
    yield 4;
    // the porter carries it out to the cab; owner and trunk leave together
    this.carry(trunk, porter, 0.25, 0.7);
    const drop = ctx.layout.forecourtTraffic.dropOff.pos.clone();
    this.walk(o, drop);
    yield this.walk(porter, drop.clone().add(new THREE.Vector3(1, 0, 1)));
    const anchor = cab ? this.safe(() => ctx.reg.traffic.anchorOf(cab), null) : null;
    if (anchor) {
      // loaded onto the cab roof (it leaves with the cab), owner climbs in
      this.carryOut(trunk, porter, { to: 'door:station:east', y: 0.25, fwd: 0.7 });
      yield this.actors.embark([o], anchor, 15);
      this.releaseVehicle(cab);
      this.actors.release(o);
    } else {
      this.stopCarry(trunk);
      this.carryOut(trunk, o, { y: 0.25, fwd: 0.6 });
      this.actors.remove(porter, 'door:station:east');
    }
    yield 2;
  }
}

// ═════════════════════════ NEW: LOST DOG ═════════════════════════
// A lady steps off a train with her terrier; it slips its lead, bolts through the station into the forecourt
// gardens, and is found by the newsboy. Owner and dog leave together through the booking hall.
const DOG_NAMES = ['Pip', 'Bouncer', 'Toby', 'Mr. Jingles', 'Captain', 'Muffin'];
class LostDogEvent extends Scripted {
  maxDuration = 200;
  *script(): Script {
    const { ctx, rng } = this;
    yield { until: () => !!dwellingAt(ctx), max: 45 };
    const tr = dwellingAt(ctx);
    const pid: PlatformId = tr?.platform ?? rng.pick([1, 2] as PlatformId[]);
    const at = (tr && doorNear(ctx, tr.id, onPlatform(ctx, pid, 12, 2))) ?? onPlatform(ctx, pid, 12, 2.5);
    const owner = tr ? this.actors.fromTrain('guest', at) : this.actors.summon('guest', at, { from: `door:station:p${pid}` });
    if (!owner) return;
    const name = rng.pick(DOG_NAMES);
    const d = buildDog(rng.pick([0xe8dcc4, 0xc9a070, 0x3a3230]), rng.pick([0x6a4a2e, 0x2a2420, 0xf0e8dc]));
    let wag = 1, sniff = false;
    const dog = this.critter(d.root, 'dog', (c, _dt, moving, sp) => {
      const g = moving ? Math.sin(c.phase * (3 + sp)) * 0.6 : 0;
      d.legs[0].rotation.z = g; d.legs[3].rotation.z = g; d.legs[1].rotation.z = -g; d.legs[2].rotation.z = -g;
      d.tail.rotation.x = Math.sin(c.phase * 9) * 0.5 * wag;
      d.head.rotation.z = sniff && !moving ? -0.35 + Math.sin(c.phase * 3) * 0.1 : Math.sin(c.phase * 0.7) * 0.08;
      d.head.rotation.y = !moving ? Math.sin(c.phase * 0.5) * 0.5 : 0;
    });
    dog.groundY = null;
    // the dog comes out on its lead with the lady: its origin is her (a leashed dog is part of its walker)
    const leash = this.actors.pos(owner).clone();
    let walkerPid: string | null = this.actors.pid(owner);
    this.tick(() => { const info = walkerPid ? this.safe(() => ctx.reg.people.get(walkerPid!), undefined) : undefined; if (info) leash.copy(info.position); });
    const leashOrigin = this.origin({ id: `events:leash:${this.now.toFixed(2)}`, kind: 'vehicle', pos: (o) => o.copy(leash), radius: 2.5, for: ['animals'], open: () => true });
    const op = this.actors.pos(owner).clone();
    dog.enter(op.clone().setY(op.y), leashOrigin);
    let leashed = true;
    this.tick(() => {
      if (!leashed || !dog.present) return;
      const p = this.actors.pos(owner);
      const dd = Math.hypot(p.x - dog.pos.x, p.z - dog.pos.z);
      if (dd > 1.2) dog.goto(new THREE.Vector3(p.x + 0.8, p.y, p.z + 0.6), 1.8);
    });
    this.walk(owner, onPlatform(ctx, pid, 4, 5), { speed: 1.0 });
    yield 3;
    // SQUIRREL! (or a pigeon): off it goes
    leashed = false;
    const hideouts = [ctx.layout.forecourt.center.clone().add(new THREE.Vector3(-8, 0, 12)), ctx.layout.nav.nodes.forecourt?.clone() ?? ctx.layout.entrance.clone()];
    const bush = hideouts[0]; bush.y = 0;
    const via = node(ctx, `p${pid}Door`); via.y = 1;
    this.cue('dog', dog.pos, 1);
    this.gazette(rng.pick([
      `DOG AT LARGE! ${name}, a terrier of good family, slips his lead upon Platform ${pid} and makes for the open country`,
      `A lady's terrier, answering (occasionally) to "${name}", bolts through the booking hall; porters and passengers join the search`,
    ]));
    const book = node(ctx, 'booking'); book.y = 1;
    const steps = node(ctx, 'steps'); steps.y = 0;
    yield dog.goto(via, 4.2);
    yield dog.goto(book, 4.2);
    yield dog.goto(steps, 4.0);
    yield dog.goto(bush, 3.6);
    sniff = true;
    this.marker('?', () => (dog.present ? dog.pos : null), { lift: 1.6, px: 26 });
    this.actors.anim(owner, 'point');
    this.cueLoop('dog', [4, 9], () => dog.pos, 0.6);
    // the lady searches; the newsboy finds him
    this.walk(owner, node(ctx, 'booking'));
    let wander = 0;
    this.tick((_dt, dm) => {
      if (!sniff || !dog.present) return;
      wander -= dm;
      if (wander <= 0) { wander = rng.range(3, 6); dog.goto(bush.clone().add(new THREE.Vector3(rng.range(-3, 3), 0, rng.range(-3, 3))), 1.2); }
    });
    yield rng.range(6, 12);
    const boy = this.actors.summon('newsboy', bush.clone().add(new THREE.Vector3(1.2, 0, 0)));
    if (boy) {
      yield this.actors.arrived(boy, 2);
      this.actors.anim(boy, 'wave');
      this.cue('shout', bush, 0.6);
    }
    yield this.walk(owner, bush.clone().add(new THREE.Vector3(-1, 0, 0.5)));
    sniff = false; wag = 1.8;
    yield dog.goto(this.actors.pos(owner).clone().add(new THREE.Vector3(0.6, 0, 0)), 3);
    this.marker('♥', () => this.actors.at(owner), { lift: 2.3, bg: '#f6e7ee', fg: '#9a2040' });
    this.actors.anim(owner, 'cheer');
    if (boy) this.actors.anim(boy, 'cheer');
    this.cue('dog', dog.pos, 0.8);
    this.gazette(`${name} is restored to his mistress by young Alfie the newsboy, who is rewarded with a shilling and a very wet face`);
    yield 3;
    // home together: back on the lead, out through the booking hall
    leashed = true;
    if (boy) this.actors.remove(boy);
    const pid0 = this.actors.dismiss(owner, { to: 'door:station:east' });
    walkerPid = pid0;
    this.tick(() => {
      if (!dog.present) return;
      const info = pid0 ? this.safe(() => ctx.reg.people.get(pid0), undefined) : undefined;
      if (!info) { dog.leave(); return; } // went in at the door with her
      const p = info.position;
      if (Math.hypot(p.x - dog.pos.x, p.z - dog.pos.z) > 1.0) dog.goto(new THREE.Vector3(p.x + 0.6, p.y, p.z + 0.5), 2.2);
    });
    yield { until: () => !dog.present, max: 80 };
    yield 1;
  }
}

export const mischiefEvents: EventDef[] = [
  {
    id: 'pickpocket', title: 'Stop, Thief!', blurb: 'A pickpocket works the forecourt crowd; a constable gives chase.',
    cooldown: 480, condition: (e) => hr(e) > 7 && hr(e) < 22, weight: () => 0.8,
    create: (e) => new PickpocketEvent(e),
  },
  {
    id: 'lostLuggage', title: 'Lost Luggage', blurb: 'A trunk is left behind on a platform; its owner returns for it by cab.',
    cooldown: 480, condition: (e) => hr(e) > 7 && hr(e) < 21, weight: () => 0.8,
    create: (e) => new LostLuggageEvent(e),
  },
  {
    id: 'lostDog', title: 'Lost Dog', blurb: 'A terrier slips its lead and bolts through the station; the newsboy saves the day.',
    cooldown: 720, condition: (e) => hr(e) > 7 && hr(e) < 20 && wx(e) !== 'storm', weight: () => 0.6,
    create: (e) => new LostDogEvent(e),
  },
];
