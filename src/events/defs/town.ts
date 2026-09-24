/**
 * v2 TOWN EVENTS.
 *  - market : Thursday market on Ashcombe square — traders walk in from their doors carrying their stalls, put them
 *             up, sell all morning to a browsing crowd (auctioneer's bell, farm carts delivering), then take them
 *             down and carry them home. Stalls are never popped in: they grow from the bundles their owners carry.
 *  - fete   : Millbridge village fete on the green — bunting, maypole dancing, the tea table, a coconut shy, the
 *             vicar's address and a tug-of-war; villagers come out of their own cottage doors and go home again.
 * Draw calls while visible: market 6 (2 stall sets ×2 with shadows, bundles, marker), fete 5 (bunting, ribbons, baked maypole/tea/shy ×2 with shadow, marker).
 */
import * as THREE from 'three';
import { Scripted, type EventDef, type EventEnv } from '../base';
import type { Script } from '../runner';
import { buildBunting, buildCoconutShy, buildMaypole, buildTeaTable, stallBundleGeometry, stallGeometry } from '../props';
import { InstProps, bakeStatic, confettiBurst, puff } from '../fx';

const hr = (e: EventEnv) => e.ctx.clock.hour;
const wx = (e: EventEnv) => e.ctx.reg.atmosphere?.weather ?? 'clear';
const fine = (e: EventEnv) => wx(e) === 'clear' || wx(e) === 'overcast';
const warm = (e: EventEnv) => (e.ctx.reg.atmosphere?.temperatureC ?? 12) > 9;

type Area = { center: THREE.Vector3; size: THREE.Vector3; yaw: number };
/** area-local (x along frontage, z depth) → world point on the ground */
function areaPt(ctx: EventEnv['ctx'], a: Area, lx: number, lz: number): THREE.Vector3 {
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  const p = new THREE.Vector3(a.center.x + lx * c + lz * s, 0, a.center.z - lx * s + lz * c);
  p.y = ctx.layout.heightAt(p.x, p.z);
  return p;
}

// ═════════════════════════ MARKET DAY ═════════════════════════
const GOODS = [
  [0xb8322a, 0x9aa83a, 0xb8322a, 0xd9a040, 0x9aa83a], // apples & pears
  [0xe8dcc0, 0xd9b95a, 0xe8dcc0, 0xd9b95a], // cheeses
  [0x6a8a3a, 0x8a6a3a, 0x5e7a3a, 0xc9803a, 0x6a8a3a], // greens, potatoes, carrots
  [0xd9a86a, 0xc9905a, 0xe0b878, 0xc9905a], // loaves
  [0x7a2230, 0x2b3a67, 0xe8dcc0, 0x5e7a3a], // haberdashery
  [0xf2efe6, 0xc9a24a, 0xf2efe6, 0xf2efe6], // eggs & butter
];
class MarketEvent extends Scripted {
  maxDuration = 280;
  private c = new THREE.Vector3();
  focus(): THREE.Vector3 | null { return this.c.clone(); }
  *script(): Script {
    const { ctx, rng } = this;
    const town = ctx.layout.towns.find((t) => t.id === 'ashcombe');
    const sq: Area = town?.areas.find((a) => a.kind === 'square') ?? { center: new THREE.Vector3(209.8, 0, -51.2), size: new THREE.Vector3(30, 0.1, 22), yaw: 20 * Math.PI / 180 };
    this.c.copy(sq.center);
    // two rows of three stalls facing a middle aisle
    const N = 6;
    const slots: { p: THREE.Vector3; yaw: number }[] = [];
    for (let i = 0; i < N; i++) {
      const row = i < 3 ? -1 : 1;
      const lx = ((i % 3) - 1) * 7.5;
      const lz = row * Math.min(5.5, sq.size.z * 0.28);
      // stall local +z (customer side) faces the aisle
      slots.push({ p: areaPt(ctx, sq, lx, lz), yaw: sq.yaw + (row < 0 ? 0 : Math.PI) });
    }
    // two stall variants (red awning / fruit & greens, blue awning / cheese & bread), one instanced set each:
    // 2 draws + 2 shadow draws for all six stalls; the stall rises (scale y) as its trader puts it up
    const varA = stallGeometry(0x7a2230, rng.chance(0.5) ? GOODS[0] : GOODS[2]);
    const varB = stallGeometry(0x2b3a67, rng.chance(0.5) ? GOODS[1] : GOODS[3]);
    const stallsA = new InstProps(this.group, varA, N);
    const stallsB = new InstProps(this.group, varB, N);
    const bundles = new InstProps(this.group, stallBundleGeometry(), N, undefined, false);
    for (const ip of [stallsA, stallsB]) ip.cull(sq.center, Math.max(sq.size.x, sq.size.z) * 0.6 + 4);
    // traders come from doors within ~70 m of the square
    bundles.cull(sq.center, 90);
    const build = slots.map(() => 0);
    const carrying: (string | null)[] = slots.map(() => null); // actor ids carrying bundles in
    const leaving: (string | null)[] = slots.map(() => null); // pids carrying bundles home
    const hidden = new THREE.Vector3(0, -50, 0);
    const _s = new THREE.Vector3();
    this.tick(() => {
      slots.forEach((sl, i) => {
        const f = build[i];
        const on = i % 2 ? stallsB : stallsA, off = i % 2 ? stallsA : stallsB;
        // posts go up first, then the canopy is hauled up: a gently eased rise with a little overshoot sway
        const e = f < 1 ? THREE.MathUtils.smoothstep(f, 0, 1) : 1;
        on.set(i, f > 0.01 ? sl.p : hidden, sl.yaw, _s.set(0.9 + 0.1 * e, Math.max(0.03, e), 0.9 + 0.1 * e));
        off.set(i, hidden, 0, 0);
        // the bundle: in its owner's arms (walking in, or home again)
        let bp: THREE.Vector3 | null = null;
        if (leaving[i]) { const info = this.safe(() => ctx.reg.people.get(leaving[i]!), undefined); bp = info ? info.position.clone().setY(info.position.y + 1.0) : null; }
        else if (carrying[i] && this.actors.has(carrying[i]!)) { const p = this.actors.pos(carrying[i]!); bp = p.clone().setY(p.y + 1.0); }
        if (bp) bundles.set(i, bp, sl.yaw, 1);
        else bundles.set(i, hidden, 0, 0);
      });
      stallsA.commit(); stallsB.commit(); bundles.commit();
    });
    this.gazette(rng.pick([
      'MARKET DAY at Ashcombe: stalls go up on the square; farm carts from Wyke and Coldharbour expected with butter, eggs and "a quantity of turnips"',
      'Thursday market on Ashcombe square; the auctioneer rings his bell and the Crown does a roaring trade',
    ]));
    // the traders walk in from their doors (nearest first) carrying their stalls
    const traders: string[] = [];
    slots.forEach((sl, i) => {
      const front = sl.p.clone().add(new THREE.Vector3(Math.sin(sl.yaw) * -0.9, 0, Math.cos(sl.yaw) * -0.9));
      const id = this.actors.summon('vendor', front, { timeoutMin: 110 });
      traders.push(id ?? '');
      carrying[i] = id;
    });
    // carts deliver produce
    const carts = [this.requestVehicle({ kind: 'farmcart', to: 'building:ashcombe:post', wait: rng.range(35, 60), tag: 'market' }),
      this.requestVehicle({ kind: rng.chance(0.5) ? 'haywain' : 'farmcart', to: 'building:ashcombe:bakery', wait: rng.range(30, 50), tag: 'market' })];
    this.marker('£', () => this.c, { lift: 4.5, bg: '#e8dcc0', fg: '#2a1e16' });
    // each trader puts up his stall as he arrives
    const up = slots.map(() => false);
    this.tick((_dt, dm) => {
      slots.forEach((sl, i) => {
        const id = traders[i];
        if (!id || !this.actors.has(id)) { if (closing) build[i] = Math.max(0, build[i] - dm / 4); return; }
        if (!up[i]) {
          const p = this.actors.pos(id);
          if (Math.hypot(p.x - sl.p.x, p.z - sl.p.z) < 2.4) { up[i] = true; carrying[i] = null; this.actors.anim(id, 'hammer'); this.actors.look(id, sl.p); this.cue('hammer', sl.p, 0.5); }
          return;
        }
        if (closing) { build[i] = Math.max(0, build[i] - dm / 4); return; }
        if (build[i] < 1) {
          build[i] = Math.min(1, build[i] + dm / 5);
          if (build[i] >= 1) { this.actors.anim(id, 'idle'); this.actors.idle(id, 'sell'); }
        }
      });
    });
    let closing = false;
    yield { until: () => up.filter(Boolean).length >= Math.ceil(traders.filter(Boolean).length * 0.7), max: 110 };
    // customers browse from stall to stall
    const shoppers = this.actors.crowd(14, sq.center, 'townsfolk', Math.min(9, sq.size.x * 0.3), 90);
    let browse = 0;
    this.tick((_dt, dm) => {
      if (closing) return;
      browse -= dm;
      if (browse > 0) return;
      browse = 2.5;
      for (const id of shoppers) {
        if (!this.rng.chance(0.35)) continue;
        const k = this.rng.int(0, N - 1);
        if (build[k] < 1) continue;
        const sl = slots[k];
        const t = sl.p.clone().add(new THREE.Vector3(Math.sin(sl.yaw) * 1.9 + this.rng.range(-1.2, 1.2), 0, Math.cos(sl.yaw) * 1.9 + this.rng.range(-0.5, 0.5)));
        t.y = ctx.layout.heightAt(t.x, t.z);
        this.walk(id, t, { speed: 1.1 });
        this.after(1.5, () => { this.actors.look(id, sl.p); this.actors.idle(id, this.rng.chance(0.5) ? 'chat' : 'watch'); });
      }
    });
    // the auctioneer by the market cross
    const auct = this.actors.summon('townsfolk', areaPt(ctx, sq, 0, 0), { from: 'door:ashcombe:crown:0' });
    this.cueLoop('bell', [14, 26], () => sq.center, 0.5);
    this.cueLoop('crowd', [7, 12], () => sq.center, 0.45);
    if (auct) this.after(8, () => { this.actors.anim(auct, 'point'); this.actors.idle(auct, 'sell'); });
    this.after(30, () => this.gazette(rng.pick([
      'At the market: a fat pig fetches two guineas; the Rector buys a hat he "cannot account for"',
      'Brisk trade upon the square: eggs a shilling the score, and the cheesemonger hoarse by noon',
    ]), 'info'));
    yield rng.range(95, 140);
    // closing up: stalls come down and go home under their owners' arms
    closing = true;
    this.gazette('The market closes; the square is swept and the stalls carried home', 'info');
    shoppers.forEach((id) => this.actors.remove(id));
    if (auct) this.actors.remove(auct, 'door:ashcombe:crown:0');
    slots.forEach((_, i) => { if (traders[i] && this.actors.has(traders[i])) this.actors.anim(traders[i], 'hammer'); });
    yield { until: () => build.every((b) => b <= 0), max: 8 };
    for (let i = 0; i < N; i++) build[i] = 0;
    traders.forEach((id, i) => { if (id && this.actors.has(id)) { leaving[i] = this.actors.dismiss(id); } });
    carts.forEach((c) => this.releaseVehicle(c));
    yield { until: () => leaving.every((pid) => this.actors.gone(pid)), max: 120 };
    yield 1;
  }
}

// ═════════════════════════ VILLAGE FETE ═════════════════════════
class FeteEvent extends Scripted {
  maxDuration = 260;
  private c = new THREE.Vector3();
  focus(): THREE.Vector3 | null { return this.c.clone(); }
  *script(): Script {
    const { ctx, rng } = this;
    const town = ctx.layout.towns.find((t) => t.id === 'millbridge');
    const g: Area = town?.areas.find((a) => a.kind === 'green') ?? { center: new THREE.Vector3(146.4, 1.2, 117.9), size: new THREE.Vector3(26, 0.1, 18), yaw: 0 };
    this.c.copy(g.center);
    const hx = g.size.x / 2 - 0.8, hz = g.size.z / 2 - 0.8;
    // the committee dresses the green while nobody is watching
    yield { until: () => !this.safe(() => ctx.view.isVisible(g.center, 16), false), max: 3 };
    const ring: THREE.Vector3[] = [];
    for (const [x, z] of [[-hx, -hz], [0, -hz], [hx, -hz], [hx, 0], [hx, hz], [0, hz], [-hx, hz], [-hx, 0], [-hx, -hz]] as [number, number][]) ring.push(areaPt(ctx, g, x, z));
    this.decorate(buildBunting(ring, 3.0, [0x7a2230, 0xe8dcc0, 0x2b3a67, 0xd9b95a, 0x5e7a3a]));
    const mpAt = areaPt(ctx, g, -g.size.x * 0.18, 0);
    const mp = buildMaypole();
    mp.root.position.copy(mpAt);
    const tea = buildTeaTable();
    tea.position.copy(areaPt(ctx, g, g.size.x * 0.3, -g.size.z * 0.28));
    tea.rotation.y = g.yaw;
    const shy = buildCoconutShy();
    shy.root.position.copy(areaPt(ctx, g, g.size.x * 0.3, g.size.z * 0.3));
    shy.root.rotation.y = g.yaw + Math.PI;
    shy.root.updateMatrixWorld(true);
    const nutWorld = [0, 1, 2].map((i) => shy.root.localToWorld(shy.nutAt(i)));
    const shyW = shy.root.position.clone();
    const teaPos = tea.position.clone();
    // the ribbons turn as the children dance; everything else is baked into one static mesh (1 draw + shadow)
    const ribbons = mp.ribbons;
    mp.root.remove(ribbons);
    ribbons.position.copy(mpAt);
    this.decorate(bakeStatic([mp.root, tea, shy.root]));
    this.decorate(ribbons);
    this.gazette(rng.pick([
      'MILLBRIDGE FETE: maypole, coconut shy and a tea tent upon the green; proceeds to the Chapel roof fund',
      'The Millbridge Fete opens this afternoon: tug-of-war, a baby show, and Mrs. Tolliver\'s celebrated seed cake',
    ]));
    // villagers turn out of their doors
    const folk = this.actors.crowd(14, g.center, 'townsfolk', Math.min(8, hx), 90);
    folk.forEach((id, i) => {
      const a = (i / Math.max(1, folk.length)) * Math.PI * 2;
      this.walk(id, areaPt(ctx, g, Math.cos(a) * hx * 0.75 + rng.range(-1, 1), Math.sin(a) * hz * 0.7 + rng.range(-1, 1)));
    });
    const lady = this.actors.summon('vendor', teaPos.clone().add(new THREE.Vector3(Math.sin(g.yaw) * -1.0, 0, Math.cos(g.yaw) * -1.0)), { timeoutMin: 80 });
    const vicar = this.actors.summon('vicar', areaPt(ctx, g, 0, -hz * 0.5), { from: 'door:millbridge:chapel:0', timeoutMin: 80 });
    const kids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const id = this.actors.summon('child', mpAt.clone().add(new THREE.Vector3(Math.cos(a) * 3, 0, Math.sin(a) * 3)), { timeoutMin: 90 });
      if (id) kids.push(id);
    }
    this.marker('✿', () => this.c, { lift: 5, bg: '#f6e7ee', fg: '#5e7a3a' });
    yield { until: () => { const ws = [vicar, lady, ...kids].filter((x): x is string => !!x).map((id) => this.actors.arrived(id, 2.5)); return ws.every((w) => typeof w !== 'object' || w.until()); }, max: 90 };
    if (lady) { this.actors.idle(lady, 'sell'); this.actors.look(lady, g.center); }
    // the vicar declares the fete open
    if (vicar) { this.actors.anim(vicar, 'wave'); this.actors.look(vicar, g.center); }
    folk.forEach((id) => this.actors.look(id, vicar ? this.actors.pos(vicar) : g.center));
    this.cue('cheer', g.center, 0.7);
    this.cue('band', g.center, 0.6);
    this.gazette('The Rev. Mr. Plum declares the fete open "under Providence and a fair sky"; the band strikes up', 'info');
    yield 3;
    folk.forEach((id) => this.actors.idle(id, 'chat'));
    this.cueLoop('band', [9, 14], () => g.center, 0.55);
    this.cueLoop('crowd', [8, 13], () => g.center, 0.4);
    // maypole dance: the children circle the pole, winding the ribbons
    let danceA = 0, dancing = true, steer = 0;
    this.tick((dt, dm) => {
      if (!dancing) return;
      danceA += dm * 0.55;
      ribbons.rotation.y = -danceA;
      steer -= dt;
      if (steer > 0) return;
      steer = 0.5;
      kids.forEach((id, i) => {
        const dir = i % 2 ? 1 : -1; // weaving in and out
        const a = danceA * dir + (i / kids.length) * Math.PI * 2 + 0.35 * dir;
        const r = 3.0 + 0.45 * Math.sin(danceA * 3 + i * Math.PI);
        const t = new THREE.Vector3(mpAt.x + Math.cos(a) * r, mpAt.y, mpAt.z + Math.sin(a) * r);
        this.walk(id, t, { direct: true, speed: 1.9 });
      });
    });
    // coconut shy: a villager tries his luck now and then
    let shyT = 3;
    this.tick((_dt, dm) => {
      shyT -= dm;
      if (shyT > 0 || !folk.length) return;
      shyT = rng.range(4, 9);
      const who = folk[rng.int(0, folk.length - 1)];
      const stand = shyW.clone().add(new THREE.Vector3(Math.sin(g.yaw) * 4.5, 0, Math.cos(g.yaw) * 4.5));
      this.walk(who, stand);
      this.after(2, () => {
        this.actors.look(who, shyW);
        this.actors.anim(who, 'point');
        const nut = nutWorld[rng.int(0, 2)].clone();
        if (rng.chance(0.4)) { puff(this.env.fx, nut, 0x6a4a2e, { vy: 1.5, size: 0.2, life: 0.8, grow: 2 }); this.cue('cheer', nut, 0.5); }
      });
    });
    yield rng.range(35, 55);
    // tug-of-war
    dancing = false;
    kids.forEach((id) => this.actors.anim(id, 'cheer'));
    const teams = folk.slice(0, Math.min(8, folk.length));
    const mid = areaPt(ctx, g, g.size.x * 0.05, g.size.z * 0.05);
    const ax = new THREE.Vector3(Math.cos(g.yaw), 0, -Math.sin(g.yaw));
    teams.forEach((id, i) => {
      const side = i % 2 ? 1 : -1, k = Math.floor(i / 2);
      const p = mid.clone().addScaledVector(ax, side * (1.4 + k * 1.1));
      this.walk(id, p, { direct: true });
      this.after(3, () => { this.actors.look(id, mid); this.actors.anim(id, 'work'); });
    });
    this.gazette('TUG-OF-WAR: Millbridge Dairy versus the Mill; the rope is of "doubtful parentage"', 'info');
    yield 12;
    const win = rng.chance(0.5) ? 'the Dairy' : 'the Mill';
    teams.forEach((id) => this.actors.anim(id, 'cheer'));
    confettiBurst(this.env.fx, mid.clone().setY(mid.y + 1), 50, 4);
    this.cue('cheer', mid, 1);
    this.gazette(`${win === 'the Dairy' ? 'Millbridge Dairy' : 'The Mill'} win the tug-of-war; ${win === 'the Dairy' ? 'the Mill' : 'the Dairy'} end up in the duck pond, by tradition`);
    yield rng.range(20, 35);
    this.gazette('The fete closes with three cheers for the Committee; the Chapel roof fund stands at £4 7s. 2d.', 'info');
    // everyone home (the committee takes the bunting down after dark)
    this.actors.removeAll();
    yield 20;
    yield { until: () => !this.safe(() => ctx.view.isVisible(g.center, 16), false), max: 90 };
  }
}

export const townEvents: EventDef[] = [
  {
    id: 'market', title: 'Market Day', blurb: 'Thursday market on Ashcombe square: traders carry in and put up their stalls, carts deliver, the auctioneer rings.',
    cooldown: 1440, condition: (e) => hr(e) > 7.5 && hr(e) < 12 && wx(e) !== 'storm' && wx(e) !== 'snow',
    weight: (e) => (e.ctx.clock.weekday === 3 ? 8 : 0.05),
    create: (e) => new MarketEvent(e),
  },
  {
    id: 'fete', title: 'Village Fete', blurb: 'Millbridge fete on the green: maypole dancing, the tea table, a coconut shy and a tug-of-war.',
    cooldown: 2880, condition: (e) => hr(e) > 12 && hr(e) < 16.5 && fine(e) && warm(e),
    weight: (e) => (e.ctx.clock.weekday === 5 ? 3 : 0.1),
    create: (e) => new FeteEvent(e),
  },
];
