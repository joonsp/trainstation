import * as THREE from 'three';
import type { BoatInfo } from '../../core/apis';
import { Scripted, NAMES_M, type EventDef, type EventEnv } from '../base';
import type { Script, Wait } from '../runner';
import { buildBrazier, buildBunting, buildSwan } from '../props';
import { puff } from '../fx';

const hr = (e: EventEnv) => e.ctx.clock.hour;
const wx = (e: EventEnv) => e.ctx.reg.atmosphere?.weather ?? 'clear';
const fine = (e: EventEnv) => wx(e) === 'clear' || wx(e) === 'overcast';
const ice = (e: EventEnv) => { try { return e.ctx.reg.atmosphere.iceAmount ?? 0; } catch { return 0; } };
const dow = (e: EventEnv) => e.ctx.clock.weekday;

/** a splash of river water (catch, landing swan) */
function splash(env: EventEnv, p: THREE.Vector3, n = 8, big = 1): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 0.6 * big;
    puff(env.fx, p.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.05, Math.sin(a) * r)), 0xdfeef2, {
      vx: Math.cos(a) * 1.2 * big, vy: 1.6 + Math.random() * 1.6 * big, vz: Math.sin(a) * 1.2 * big, size: 0.16 * big, life: 0.8, grow: 1.4, gravity: 7, spread: 0.2,
    });
  }
}

/** point on the river bank at river s: side −1 = east (left) bank, +1 = west (towpath) bank; y = ground */
function bankPoint(env: EventEnv, s: number, side: 1 | -1, extra = 2.5): THREE.Vector3 {
  const R = env.ctx.layout.river;
  const p = R.pointAt(s, side * (R.widthAt(s) / 2 + extra));
  p.y = env.ctx.layout.heightAt(p.x, p.z);
  return p;
}

// ═════════════════════════ REGATTA ═════════════════════════
// Summer Saturday on the Ashbourne: bunting along the Rowing Club bank, spectators on both banks, and two coxless
// fours launched from the boathouse (nature's boats; rowers are people riding them) racing down the regatta reach.
const CREWS = ['Ashcombe R.C.', 'Millbridge Amateurs', 'Glenmoor Scullers', 'The Kingsport Railwaymen', 'Brightmouth Grammar School'];
class RegattaEvent extends Scripted {
  maxDuration = 260;
  private boats: string[] = [];
  focus(): THREE.Vector3 | null {
    const b = this.boats.map((id) => this.safe(() => this.ctx.reg.nature.boat(id), undefined)).find((x) => !!x);
    return b ? b.pos.clone().setY(0) : this.ctx.layout.river.boathouse.slip.clone().setY(0);
  }
  *script(): Script {
    const { ctx, rng } = this;
    const R = ctx.layout.river;
    const reach = R.reaches.find((r) => r.id === 'regatta') ?? { s0: 348, s1: 505 };
    const slipS = R.boathouse.slipS;
    // bunting along the club bank and the towpath opposite
    const poles: THREE.Vector3[] = [], poles2: THREE.Vector3[] = [];
    for (let s = slipS - 40; s <= slipS + 20; s += 10) { poles.push(bankPoint(this.env, s, -1, 3.0)); poles2.push(bankPoint(this.env, s, 1, 4.2)); }
    this.decorate(buildBunting(poles, 3.2));
    this.decorate(buildBunting(poles2, 3.0, [0x2b3a67, 0xe8dcc0, 0x7a2230, 0xc9a24a]));
    const names = this.shuffled(CREWS).slice(0, 2);
    this.gazette(`ASHBOURNE REGATTA: ${names[0]} to meet ${names[1]} over the Kingsmead course this afternoon; the Rowing Club lawn en fête`);
    // spectators on both banks
    const crowdE = this.actors.crowd(8, bankPoint(this.env, slipS - 15, -1, 5), 'townsfolk', 6);
    const crowdW = this.actors.crowd(6, bankPoint(this.env, slipS - 25, 1, 2.1), 'townsfolk', 5);
    crowdE.forEach((id, i) => this.walk(id, bankPoint(this.env, slipS - 35 + i * 5, -1, 3.8 + (i % 2))));
    crowdW.forEach((id, i) => this.walk(id, bankPoint(this.env, slipS - 40 + i * 6, 1, 2.1)));
    // the crews launch from the slip
    for (let k = 0; k < 2; k++) {
      const id = this.safe(() => ctx.reg.nature.requestBoat('gig4', { from: 'boathouse', riders: [{ role: 'rower' }, { role: 'rower' }, { role: 'rower' }, { role: 'rower' }], tag: `regatta:${k}`, route: 'regatta' }), null);
      if (id) this.boats.push(id);
    }
    const umpire = this.safe(() => ctx.reg.nature.requestBoat('launch', { from: 'm1', tag: 'regatta:umpire', route: 'regatta' }), null);
    void umpire;
    this.marker('R', () => this.focus(), { lift: 5, bg: '#2b3a67', fg: '#e8dcc0' });
    this.cueLoop('crowd', [8, 14], () => bankPoint(this.env, slipS - 15, -1, 5), 0.5);
    if (!this.boats.length) {
      yield 25;
      this.gazette('The regatta is abandoned: both fours are found to be taking water "at a prodigious rate". The band plays on regardless.', 'info');
      [...crowdE, ...crowdW].forEach((id) => this.actors.remove(id));
      yield 8;
      return;
    }
    // wait for them to be afloat and under way
    const info = () => this.boats.map((id) => this.safe(() => ctx.reg.nature.boat(id), undefined)).filter((b): b is BoatInfo => !!b);
    yield { until: () => info().length > 0 && info().every((b) => b.state === 'underway'), max: 40 };
    const startS = info().map((b) => R.nearest(b.pos).s);
    this.cue('pistol', info()[0]?.pos, 1);
    this.cue('cheer', bankPoint(this.env, slipS - 15, -1, 5), 0.9);
    [...crowdE, ...crowdW].forEach((id) => this.actors.anim(id, 'cheer'));
    this.gazette('They\'re off! The starter\'s pistol echoes under Glenmoor Bridge and the fours dig in');
    const dist = [0, 0];
    const lastS = startS.slice();
    this.tick(() => {
      info().forEach((b, i) => {
        const s = R.nearest(b.pos).s;
        dist[i] = (dist[i] ?? 0) + Math.abs(s - (lastS[i] ?? s));
        lastS[i] = s;
      });
    });
    yield { until: () => dist.some((d) => d > (reach.s1 - reach.s0) * 0.8) || info().every((b) => b.state === 'moored' || b.state === 'hauled'), max: 50 };
    const winner = dist[0] >= dist[1] ? 0 : 1;
    const margin = rng.pick(['a canvas', 'half a length', 'a length and a half', 'three feet', 'a distance']);
    this.cue('cheer', info()[winner]?.pos ?? bankPoint(this.env, slipS, -1, 3), 1);
    this.cue('band', bankPoint(this.env, slipS - 15, -1, 5), 0.7);
    this.gazette(`${names[winner]} win the Ashbourne Challenge Oar by ${margin}; ${names[1 - winner]} are generous in defeat and damp in person`);
    yield 20;
    [...crowdE, ...crowdW].forEach((id) => this.actors.remove(id));
    yield 10;
  }
}

// ═════════════════════════ ANGLING MATCH ═════════════════════════
// Sunday morning: the Junction Piscatorial Society at their pegs; the odd splash of a catch; weigh-in and a winner.
class AnglingEvent extends Scripted {
  maxDuration = 300;
  private pegPos: THREE.Vector3[] = [];
  focus(): THREE.Vector3 | null { return this.pegPos[0]?.clone() ?? null; }
  *script(): Script {
    const { ctx, rng } = this;
    const R = ctx.layout.river;
    // the pegs nearest the station first (they are the most watched)
    const pegs = R.fishing.slice().sort((a, b) => a.pos.distanceTo(ctx.layout.station.center) - b.pos.distanceTo(ctx.layout.station.center)).slice(0, 6);
    this.pegPos = pegs.map((p) => p.pos.clone());
    this.gazette('ANGLING: The Junction Piscatorial Society holds its match upon the Ashbourne; a silver cup and a pork pie to the heaviest bag');
    const anglers: string[] = [];
    const bags: number[] = [];
    pegs.forEach((p) => { const id = this.actors.summon('angler', p.pos.clone(), { timeoutMin: 140 }); if (id) { anglers.push(id); bags.push(0); } });
    if (!anglers.length) return;
    const fishing = anglers.map(() => false);
    const waterPt = (i: number) => {
      const p = pegs[i];
      const f = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw)); // people facing convention: atan2(dx, dz)
      const w = p.pos.clone().addScaledVector(f, 3.2);
      w.y = R.waterYAt(p.s);
      return w;
    };
    // settle at the peg as each arrives
    this.tick(() => {
      anglers.forEach((id, i) => {
        if (fishing[i]) return;
        const a = this.actors.pos(id);
        if (Math.hypot(a.x - pegs[i].pos.x, a.z - pegs[i].pos.z) < 1.5) {
          fishing[i] = true;
          this.actors.look(id, waterPt(i));
          this.actors.anim(id, 'fish');
          this.actors.idle(id, 'fish');
        }
      });
    });
    this.marker('~', () => this.pegPos[0], { lift: 2.6, px: 26 });
    yield { until: () => fishing.filter(Boolean).length >= Math.ceil(anglers.length * 0.6), max: 140 };
    this.gazette('The whistle blows for the angling match: lines out along the Ashbourne from Glenmoor Bridge to Kingsmead');
    let nextBite = rng.range(3, 8);
    this.tick((_dt, dm) => {
      nextBite -= dm;
      if (nextBite > 0) return;
      nextBite = rng.range(4, 14);
      const cand = anglers.map((_, i) => i).filter((i) => fishing[i]);
      if (!cand.length) return;
      const i = rng.pick(cand);
      const w = waterPt(i);
      splash(this.env, w, 10, 1.2);
      this.cue('splash', w, 0.7);
      const oz = rng.int(3, 40);
      bags[i] += oz;
      this.actors.anim(anglers[i], 'cheer');
      const back = anglers[i];
      this.after(2, () => { this.actors.anim(back, 'fish'); });
    });
    yield rng.range(80, 110);
    // weigh-in at the Railway Arms
    const winner = bags.indexOf(Math.max(...bags));
    const w = bags[winner];
    const name = rng.pick(NAMES_M);
    this.gazette(`${name} takes the Piscatorial Cup with ${Math.floor(w / 16)} lb ${w % 16} oz of roach and chub; a pike of disputed size is the talk of the Railway Arms`);
    this.cue('cheer', this.pegPos[winner], 0.6);
    anglers.forEach((id) => this.actors.remove(id, 'door:station:railwayArms:0'));
    yield 6;
  }
}

// ═════════════════════════ SWAN CHASES ANGLER ═════════════════════════
// A cob flies in from beyond the edge of the map, lands with a great splash near an angler and, taking exception to
// him, comes up the bank hissing with wings raised. The angler retreats; the swan returns to the river and flies off.
class SwanEvent extends Scripted {
  maxDuration = 160;
  *script(): Script {
    const { ctx, rng } = this;
    const R = ctx.layout.river;
    // an angler already at a peg, or one who walks to the nearest peg to the station
    const pegs = R.fishing.slice().sort((a, b) => a.pos.distanceTo(ctx.layout.station.center) - b.pos.distanceTo(ctx.layout.station.center));
    let peg = pegs[0];
    let angler: string | null = null;
    const existing = this.actors.nearestPerson(peg.pos, 400, ['angler']);
    if (existing) {
      angler = this.actors.adopt(existing, 'angler');
      const ap = this.safe(() => ctx.reg.people.get(existing)?.position.clone(), undefined);
      if (ap) peg = pegs.reduce((a, b) => (a.pos.distanceTo(ap) < b.pos.distanceTo(ap) ? a : b));
    }
    if (!angler) {
      angler = this.actors.summon('angler', peg.pos.clone(), { timeoutMin: 120 });
      if (!angler) return;
      yield this.actors.arrived(angler, 1.5);
      this.actors.anim(angler, 'fish'); this.actors.idle(angler, 'fish');
    }
    const an = angler;
    const f = new THREE.Vector3(Math.sin(peg.yaw), 0, Math.cos(peg.yaw));
    const waterY = R.waterYAt(peg.s);
    const landing = R.pointAt(Math.max(0, peg.s - 14), 0, waterY);
    const nearWater = peg.pos.clone().addScaledVector(f, 2.6).setY(waterY);
    const sw = buildSwan();
    let wings = 0, neckUp = 0, flying = true;
    const swan = this.critter(sw.root, 'swan', (c, dt, moving) => {
      const flap = flying ? Math.sin(c.phase * 7) * 0.9 : wings * (0.6 + 0.2 * Math.sin(c.phase * 5));
      sw.wingL.rotation.x = -Math.max(0, flap); sw.wingR.rotation.x = Math.max(0, flap);
      sw.neck.rotation.z = neckUp > 0 ? -0.1 - Math.sin(c.phase * 6) * 0.08 : flying ? -1.0 : (moving ? 0.05 : Math.sin(c.phase * 0.6) * 0.25);
      sw.neck.rotation.y = !moving && !flying ? Math.sin(c.phase * 0.4) * 0.4 : 0;
      sw.root.position.y += !flying && !moving ? Math.sin(c.phase * 1.3) * 0.002 : 0;
      void dt;
    });
    swan.exitMode = 'fly';
    swan.groundY = null;
    swan.canFly = true;
    // enter from the sky, beyond the edge of the map, upstream
    const up = R.pointAt(0);
    const dirIn = landing.clone().sub(up).setY(0).normalize();
    const edge = (ctx.layout.terrain?.half ?? 420) + 25;
    let D = 80;
    while (D < 1400) { const p = landing.clone().addScaledVector(dirIn, -D); if (Math.max(Math.abs(p.x), Math.abs(p.z)) > edge) break; D += 10; }
    const start = landing.clone().addScaledVector(dirIn, -D).setY(40);
    swan.enter(start, 'sky edge');
    swan.exit = start.clone();
    yield swan.goto(landing.clone().setY(waterY + 0.1), 15);
    flying = false;
    splash(this.env, landing, 16, 1.6);
    this.cue('splash', landing, 1);
    this.cue('swan', landing, 0.8);
    this.gazette(rng.pick([
      'A cob swan of great size and uncertain temper alights upon the Ashbourne and eyes the anglers with open hostility',
      'Swan sighted near the anglers\' pegs; members of the Piscatorial Society advised to "keep their distance and their dignity"',
    ]), 'info');
    this.marker('!', () => (swan.present ? swan.pos : null), { lift: 1.6 });
    yield swan.goto(nearWater, 0.6);
    yield 1;
    // the charge: up the bank, wings raised, hissing
    wings = 1; neckUp = 1;
    this.cue('swan', nearWater, 1);
    swan.exitMode = 'walk';
    swan.groundY = (x, z) => Math.max(ctx.layout.heightAt(x, z), waterY);
    const retreat = peg.pos.clone().addScaledVector(f, -7);
    retreat.y = ctx.layout.heightAt(retreat.x, retreat.z);
    this.actors.anim(an, 'run');
    this.walk(an, retreat, { run: true, direct: true, speed: 3.2 });
    this.cue('shout', peg.pos, 0.7);
    yield swan.goto(peg.pos.clone().addScaledVector(f, -2.5), 1.8);
    yield 1.5;
    this.gazette(rng.pick([
      'The angler abandons rod, stool and luncheon and retires up the bank at speed; the swan holds the field',
      'SWAN ROUTS ANGLER: "It had a look in its eye," says the victim, from the safety of the Railway Arms',
    ]));
    wings = 0.3; neckUp = 0;
    yield swan.goto(nearWater, 0.9);
    swan.exitMode = 'fly';
    swan.groundY = null;
    wings = 0;
    yield swan.goto(R.pointAt(Math.min(R.length, peg.s + 18), 0, waterY + 0.05), 0.7);
    // and away (flies off downstream beyond the edge)
    flying = true;
    const dirOut = R.pointAt(R.length).sub(R.pointAt(Math.min(R.length, peg.s + 18))).setY(0).normalize();
    let D2 = 80;
    const from = swan.pos.clone();
    while (D2 < 1400) { const p = from.clone().addScaledVector(dirOut, D2); if (Math.max(Math.abs(p.x), Math.abs(p.z)) > edge) break; D2 += 10; }
    const far = from.clone().addScaledVector(dirOut, D2).setY(45);
    swan.exit = far;
    splash(this.env, swan.pos, 10, 1.2);
    yield swan.goto(far, 15);
    swan.leave();
    // the angler creeps back to his peg
    yield this.walk(an, peg.pos.clone());
    this.actors.anim(an, 'fish'); this.actors.idle(an, 'fish');
    this.actors.release(an);
    yield 1;
  }
}

// ═════════════════════════ FROST FAIR ═════════════════════════
// Only when the Ashbourne has frozen hard (atmosphere.iceAmount ≈ 1): skaters on the skating reach, children sliding,
// a chestnut seller at a glowing brazier on the ice, and spectators along the towpath.
class FrostFairEvent extends Scripted {
  maxDuration = 240;
  private c = new THREE.Vector3();
  focus(): THREE.Vector3 | null { return this.c.clone(); }
  *script(): Script {
    const { ctx, rng } = this;
    const R = ctx.layout.river;
    const reach = R.reaches.find((r) => r.id === 'skating') ?? { s0: 470, s1: 517 };
    const mid = (reach.s0 + reach.s1) / 2;
    const iceY = (s: number) => R.waterYAt(s) + 0.04;
    const onIce = (s: number, lat: number) => R.pointAt(s, lat, iceY(s));
    this.c.copy(onIce(mid, 0)).setY(0);
    this.gazette(rng.pick([
      'FROST FAIR ON THE ASHBOURNE! The river bears; skaters, sliders and a hot-chestnut man take possession of the ice below the Rowing Club',
      'The Ashbourne frozen from bank to bank: all Ashcombe turns out upon the ice',
    ]));
    // braziers on the ice (non-living props, carried out by the chestnut seller & his boy)
    const braziers = [buildBrazier(), buildBrazier()];
    const brazAt = [onIce(mid - 8, R.widthAt(mid - 8) * 0.28), onIce(mid + 12, -R.widthAt(mid + 12) * 0.25)];
    const vendor = this.actors.summon('vendor', bankPoint(this.env, mid - 8, 1, 2.1), { timeoutMin: 120 });
    const boy = this.actors.summon('child', bankPoint(this.env, mid + 12, 1, 2.1), { timeoutMin: 120 });
    const carriers = [vendor, boy];
    const placed = [false, false];
    braziers.forEach((b, i) => {
      this.group.add(b.root);
      if (carriers[i]) this.carry(b.root, carriers[i]!, 0.1, 0.5);
      else { b.root.position.copy(brazAt[i]); placed[i] = true; }
    });
    const lights = braziers.map(() => this.env.fx.lights.acquire(this));
    this.onCleanup(() => lights.forEach((l) => this.env.fx.lights.release(l)));
    let ph = 0;
    this.tick((dt) => {
      ph += dt;
      braziers.forEach((b, i) => {
        const fl = 0.8 + 0.25 * Math.sin(ph * 13 + i * 3) + 0.1 * Math.sin(ph * 31 + i);
        b.glow.scale.set(1, 0.45 * fl, 1);
        const l = lights[i];
        l.color.set(0xff8a3a); l.distance = 12;
        l.position.copy(b.root.position).setY(b.root.position.y + 1.4);
        l.intensity = placed[i] ? 10 * fl * Math.max(0.35, this.safe(() => ctx.reg.atmosphere.nightFactor, 0) * 1.5) : 0;
        if (placed[i] && dt > 0 && Math.random() < dt * 1.2) puff(this.env.fx, b.root.position.clone().setY(b.root.position.y + 1.1), 0x8a8a8e, { vy: 0.9, size: 0.18, life: 2.2, grow: 3 });
      });
    });
    const place = (i: number): Wait => {
      const who = carriers[i];
      if (!who) return 0;
      return this.walk(who, brazAt[i].clone(), { direct: true, speed: 1.0 });
    };
    // skaters and sliders
    const skaters: string[] = [];
    for (let k = 0; k < 8; k++) {
      const s = rng.range(reach.s0, reach.s1);
      const id = this.actors.summon(k < 6 ? 'skater' : 'child', bankPoint(this.env, s, rng.chance(0.6) ? 1 : -1, 2.2), { timeoutMin: 120 });
      if (id) skaters.push(id);
    }
    const spectators = this.actors.crowd(6, bankPoint(this.env, mid, 1, 2.1), 'townsfolk', 8);
    spectators.forEach((id, i) => { this.walk(id, bankPoint(this.env, reach.s0 + ((reach.s1 - reach.s0) * (i + 0.5)) / Math.max(1, spectators.length), 1, 2.4)); });
    this.marker('❄', () => this.c, { lift: 4, bg: '#e8f0f6', fg: '#2b3a67' });
    for (let i = 0; i < 2; i++) { const w = place(i); if (w) yield { until: () => typeof w === 'object' ? w.until() : true, max: 90 }; }
    braziers.forEach((b, i) => { this.stopCarry(b.root); b.root.position.copy(brazAt[i]); placed[i] = true; });
    if (vendor) { this.actors.anim(vendor, 'work'); this.actors.idle(vendor, 'sell'); }
    if (boy) this.actors.idle(boy, 'fidget');
    // glide about the reach
    const onRiver = skaters.map(() => false);
    let steer = 0;
    this.tick((_dt, dm) => {
      steer -= dm;
      if (steer > 0) return;
      steer = 1.5;
      skaters.forEach((id, i) => {
        const p = this.actors.pos(id);
        const n = R.nearest(p);
        const w = R.widthAt(n.s);
        const inReach = n.s > reach.s0 - 20 && n.s < reach.s1 + 20;
        if (!onRiver[i] && inReach && n.d < w / 2 + 4) onRiver[i] = true;
        if (!onRiver[i]) return;
        if (rng.chance(0.45)) {
          const s = rng.range(reach.s0, reach.s1);
          this.actors.anim(id, i < 6 ? 'skate' : 'play');
          this.walk(id, onIce(s, rng.range(-w * 0.35, w * 0.35)), { direct: true, speed: i < 6 ? rng.range(2.2, 3.4) : 1.6 });
        }
      });
    });
    this.cueLoop('crowd', [8, 14], () => this.c, 0.45);
    this.cueLoop('cheer', [18, 30], () => this.c, 0.35);
    yield rng.range(90, 130);
    this.gazette('The frost fair breaks up at dusk; three hats, a muff and a curate are recovered from the ice', 'info');
    // carry the braziers off again
    braziers.forEach((b, i) => { if (carriers[i]) { placed[i] = false; lights[i].intensity = 0; this.carryOut(b.root, carriers[i]!, { y: 0.1, fwd: 0.5 }); } });
    [...skaters, ...spectators].forEach((id) => this.actors.remove(id));
    yield 4;
  }
}

export const riverEvents: EventDef[] = [
  {
    id: 'regatta', title: 'Ashbourne Regatta', blurb: 'Bunting, crowds on both banks and two fours racing down the Kingsmead reach (summer Saturdays).',
    cooldown: 2880, condition: (e) => hr(e) > 12 && hr(e) < 17 && fine(e) && ice(e) < 0.1 && (e.ctx.reg.atmosphere?.temperatureC ?? 12) > 8,
    weight: (e) => (dow(e) === 5 ? 4 : 0.15),
    create: (e) => new RegattaEvent(e),
  },
  {
    id: 'angling', title: 'Angling Match', blurb: 'The Piscatorial Society fish from their pegs along the river; splashes, catches and a weigh-in.',
    cooldown: 1440, condition: (e) => hr(e) > 6 && hr(e) < 12 && wx(e) !== 'storm' && ice(e) < 0.3,
    weight: (e) => (dow(e) === 6 ? 3 : 0.3),
    create: (e) => new AnglingEvent(e),
  },
  {
    id: 'swan', title: 'Swan Chases Angler', blurb: 'A cob swan flies in and takes exception to an angler, who beats a hasty retreat up the bank.',
    cooldown: 900, condition: (e) => hr(e) > 7 && hr(e) < 19 && wx(e) !== 'storm' && ice(e) < 0.3, weight: () => 0.7,
    create: (e) => new SwanEvent(e),
  },
  {
    id: 'frostFair', title: 'Frost Fair', blurb: 'The river has frozen hard: skaters, sliding children and a chestnut brazier on the ice.',
    cooldown: 1440, condition: (e) => ice(e) > 0.95 && hr(e) > 9 && hr(e) < 17, weight: () => 3,
    prepare: (e) => {
      try {
        const atm = e.ctx.reg.atmosphere;
        if (atm.weather !== 'snow') atm.setWeather('snow', true);
        atm.setIce?.(1);
      } catch { /* stub */ }
    },
    create: (e) => new FrostFairEvent(e),
  },
];
