import * as THREE from 'three';
import type { IdleStyle, LampInfo, PersonAnim, PersonRole } from '../core/apis';
import type { Origin } from '../core/origins';
import type { Building } from '../core/countryside';
import type { AccKind } from './geometry';
import type { PeopleSystem } from './system';
import { yawTo } from './system';
import { roleLook } from './looks';
import type { Person, Step } from './types';

/*
 * TOWN LIFE (v2). Everybody here comes out of a door (or a map-edge path) and goes back into one.
 *
 *  - casual townsfolk (cap knobs.caps.townsfolk): shopping, doorstep sweeping, gossiping pairs, strolls, visits,
 *    children playing (hoop & stick, tag) after school, the evening pub (with a closing-time wobble), Sunday church;
 *  - trades (small fixed slots): the smiths at their forges, anglers at the pegs (cast, wait, the odd catch, home at
 *    dusk), farmhands in the fields, the shepherd at Wyke Down, the baker with his tray, market-day costers
 *    (Thursday), the postman's round, Monday's washerwoman, the publican, the vicar, skaters on a frozen river;
 *  - school: children walk to the Board School in the morning, play in the yard at 10:30 and noon, go home at 15:30;
 *  - the LAMPLIGHTERS' rounds: at dusk (atmosphere.gloom > 0.4 or sunset − 50 min) a lamplighter per cluster of
 *    street lamps sets out from a door and lights them one by one (world.lightLamp); porters light the platform
 *    lamps; at dawn the same rounds put them out.
 *
 * Time reality: 1 sim minute = 1 s of motion, so 100 m of walking takes ~74 sim minutes. Trips stay local to the
 * home's own town; long rounds (lamps) walk briskly.
 */

type TripKind = 'shop' | 'gossip' | 'stroll' | 'visit' | 'sweep' | 'pub' | 'church' | 'play';

interface Home { o: Origin; b: Building; town: string }
interface Indoors { p: Person; until: number; then: (p: Person) => void }
interface Slot { key: string; person: Person | null; active: (h: number, wd: number) => boolean; spawn: (warm: boolean) => Person | null; nextTry: number }
interface Round { id: string; lamps: number[]; start: string; child: boolean; person: Person | null; mode: 'light' | 'douse' | null; center: THREE.Vector3 }

const _v = new THREE.Vector3();
const RESIDENTIAL = new Set(['cottage', 'terrace', 'house', 'farmhouse']);
const SHOPS = new Set(['post', 'bakery', 'shop', 'dairy']);
const PUBS = new Set(['pub', 'inn']);

export class Town {
  private homes: Home[] = [];
  private byTown = new Map<string, { homes: Home[]; shops: Origin[]; pubs: Origin[]; church: Origin | null; meet: THREE.Vector3[] }>();
  private casual = new Set<Person>();
  private indoors: Indoors[] = [];
  private slots: Slot[] = [];
  private rounds: Round[] | null = null;
  private roundDay = { light: -1, douse: -1 };
  private portersLit = { light: -1, douse: -1 };
  private portersSince = { light: -1, douse: -1 };
  private tripAcc = 0;
  private washed = new Set<string>();
  private lastDay = -1;
  private unsubs: (() => void)[] = [];
  readonly cap: number;
  private workersCap: number;
  private schoolDoor: string | null = null;
  private schoolyard: { c: THREE.Vector3; s: THREE.Vector3; yaw: number } | null = null;
  private pupils = new Set<Person>();
  private playT = -1;

  constructor(private S: PeopleSystem) {
    const ctx = S.ctx, L = ctx.layout;
    const k = ctx.quality?.knobs;
    this.cap = k?.caps.townsfolk ?? 50;
    const tier = ctx.quality?.tier ?? 'med';
    this.workersCap = tier === 'low' ? 1 : tier === 'med' ? 2 : 3;
    // index doors by building
    const doorOf = new Map<string, Origin>();
    for (const o of ctx.origins.list({ kind: 'door', for: 'people' })) if (o.building && !doorOf.has(o.building)) doorOf.set(o.building, o);
    for (const t of L.towns) {
      const rec = { homes: [] as Home[], shops: [] as Origin[], pubs: [] as Origin[], church: null as Origin | null, meet: [] as THREE.Vector3[] };
      for (const b of t.buildings) {
        const o = doorOf.get(b.id);
        if (!o) continue;
        if (RESIDENTIAL.has(b.kind) && b.residents > 0) { const h = { o, b, town: t.id }; rec.homes.push(h); this.homes.push(h); }
        if (SHOPS.has(b.kind)) rec.shops.push(o);
        if (PUBS.has(b.kind)) rec.pubs.push(o);
        if ((b.kind === 'church' || b.kind === 'chapel') && !rec.church) rec.church = o;
        if (b.kind === 'school') this.schoolDoor = o.id;
      }
      for (const a of t.areas) {
        if (a.kind === 'square' || a.kind === 'green' || a.kind === 'garden' && t.id === 'station' && a.id === 'terraceGardens') rec.meet.push(a.center.clone());
        if (a.kind === 'playground') this.schoolyard = { c: a.center.clone(), s: a.size.clone(), yaw: a.yaw };
      }
      this.byTown.set(t.id, rec);
    }
    // villages without a church walk to the nearest one
    const churches = [...this.byTown.values()].map((r) => r.church).filter((c): c is Origin => !!c);
    for (const [, r] of this.byTown) if (!r.church && r.homes.length && churches.length) {
      const hp = r.homes[0].o.pos(new THREE.Vector3());
      r.church = churches.reduce((a, c) => (c.pos(_v).distanceTo(hp) < a.pos(new THREE.Vector3()).distanceTo(hp) ? c : a));
    }
    this.buildSlots();
    this.unsubs.push(ctx.bus.on('time:hour', () => this.onHour()));
  }

  private get ctx() { return this.S.ctx; }
  private get rng() { return this.S.rng; }
  private now() { return this.ctx.clock.minutes; }

  dispose() { for (const u of this.unsubs) u(); }

  onRemoved(p: Person) {
    this.casual.delete(p);
    this.pupils.delete(p);
    for (const s of this.slots) if (s.person === p) s.person = null;
    if (this.rounds) for (const r of this.rounds) if (r.person === p) { r.person = null; r.mode = null; }
    for (let i = this.indoors.length - 1; i >= 0; i--) if (this.indoors[i].p === p) this.indoors.splice(i, 1);
  }

  // ───────────────────────── helpers ─────────────────────────
  private building(id: string | undefined): Building | undefined { return id ? this.ctx.layout.buildings.find((b) => b.id === id) : undefined; }

  /** a point in front of a building's door: `out` metres out from the facade, `side` along it */
  private frontSpot(b: Building, out: number, side: number): THREE.Vector3 {
    const d = b.doors[0];
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    const sx = Math.cos(b.yaw), sz = -Math.sin(b.yaw);
    // never out into the river (the lock-keeper's and mill cottages face the water)
    let o = out;
    while (o > 1 && this.ctx.layout.terrain.isWater(d.x + fx * o + sx * side, d.z + fz * o + sz * side)) o *= 0.6;
    const x = d.x + fx * o + sx * side, z = d.z + fz * o + sz * side;
    return new THREE.Vector3(x, this.ctx.layout.heightAt(x, z), z);
  }

  private ground(x: number, z: number): THREE.Vector3 { return new THREE.Vector3(x, this.ctx.layout.heightAt(x, z), z); }

  /** random point inside an area rectangle, clear of buildings */
  private inArea(c: THREE.Vector3, s: THREE.Vector3, yaw: number, shrink = 0.8): THREE.Vector3 {
    for (let i = 0; i < 6; i++) {
      const a = this.rng.range(-0.5, 0.5) * s.x * shrink, b = this.rng.range(-0.5, 0.5) * s.z * shrink;
      const x = c.x + a * Math.cos(yaw) + b * Math.sin(yaw), z = c.z - a * Math.sin(yaw) + b * Math.cos(yaw);
      if (!this.ctx.layout.terrain.buildingAt(x, z, 0.8)) return this.ground(x, z);
    }
    return this.ground(c.x, c.z);
  }

  private near(c: THREE.Vector3, r: number): THREE.Vector3 {
    for (let i = 0; i < 6; i++) {
      const a = this.rng.range(0, Math.PI * 2), d = this.rng.range(0.3, 1) * r;
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      if (!this.ctx.layout.terrain.buildingAt(x, z, 0.6) && !this.ctx.layout.terrain.isWater(x, z)) return this.ground(x, z);
    }
    return this.ground(c.x, c.z);
  }

  private weatherF(): number {
    const a = this.ctx.reg.atmosphere;
    const w = a?.weather ?? 'clear';
    return w === 'storm' ? 0.15 : w === 'rain' ? 0.5 : w === 'snow' ? 0.6 : w === 'fog' ? 0.75 : 1;
  }

  private bad(): boolean { const w = this.ctx.reg.atmosphere?.weather; return w === 'storm' || w === 'rain' || w === 'snow'; }

  private dark(): boolean { return this.S.gloom() > 0.55; }

  /** pick a home (with residents inside), favouring the part of the map the camera is looking at */
  private pickHome(filter?: (h: Home) => boolean): Home | null {
    const f = this.ctx.view?.focus;
    const R = this.ctx.quality?.knobs.lifeNearRadius ?? 220;
    let tot = 0;
    const ws: number[] = [];
    for (const h of this.homes) {
      let w = 0;
      if ((!filter || filter(h)) && this.ctx.origins.pools.count(h.b.id) > 0) {
        w = 1;
        const V = this.ctx.view;
        if (f && V) {
          // spend the townsfolk budget where the camera is looking
          h.o.pos(_v);
          if (V.isVisible(_v, 25)) w = 1;
          else { const d = _v.distanceTo(f) / R; w = d < 1 ? 0.3 : 0.03; }
        }
      }
      ws.push(w); tot += w;
    }
    if (tot <= 0) return null;
    let r = this.rng.next() * tot;
    for (let i = 0; i < this.homes.length; i++) { r -= ws[i]; if (r <= 0) return this.homes[i]; }
    return null;
  }

  private emergeFrom(o: Origin | string, role: PersonRole, opts: { pool?: boolean; child?: boolean; fixed?: boolean; home?: string; force?: boolean } = {}): Person | null {
    const look = opts.child ? roleLook('child', this.rng) : undefined;
    const p = this.S.emerge(o, role, 'town', look, { pool: opts.pool, force: opts.force });
    if (!p) return null;
    p.home = opts.home ?? (typeof o === 'string' ? this.S.origin(o)?.building : o.building);
    if (opts.fixed) p.data.fixed = true;
    return p;
  }

  /** go inside `origin` for `min` sim minutes (kept, hidden), then step out and carry on with `then` */
  private stayIn(p: Person, origin: string | Origin, min: number, then: (p: Person) => void, state = 'indoors') {
    const ok = this.S.enter(p, origin, { keep: true, state: 'going in', then: () => { p.state = state; this.indoors.push({ p, until: this.now() + min, then }); } });
    if (!ok) then(p);
  }

  private home(p: Person, state = 'going home'): void {
    const o = p.home ? this.S.origin(`door:${p.home}:0`) : undefined;
    p.idle = null; p.manualAnim = null; p.lookAt = null;
    void this.S.dismiss(p, { to: o?.id, state });
  }

  private script(p: Person, steps: Step[], done?: (p: Person) => void) { this.S.runScript(p, steps, done ?? ((q) => this.home(q))); }

  private doIdle(idle: IdleStyle, min: number, state: string, extra: Partial<Extract<Step, { k: 'do' }>> = {}): Step {
    return { k: 'do', idle, min, state, ...extra };
  }

  private doAnim(anim: PersonAnim, min: number, state: string, props?: AccKind[], extra: Partial<Extract<Step, { k: 'do' }>> = {}): Step {
    return { k: 'do', anim, props, min, state, ...extra };
  }

  // ───────────────────────── casual townsfolk ─────────────────────────
  private activity(h: number): number {
    if (h < 5.8) return 0;
    if (h < 8) return 0.15 + 0.35 * (h - 5.8) / 2.2;
    if (h < 12) return 1;
    if (h < 13) return 0.85;
    if (h < 17.5) return 1;
    if (h < 19) return 0.8;
    if (h < 22.5) return 0.55;
    if (h < 23.3) return 0.3;
    return 0.04;
  }

  private tripKind(h: number, wd: number, child: boolean, t: ReturnType<Town['townRec']>): TripKind | null {
    const sunday = wd === 6;
    const opts: { w: number; v: TripKind }[] = [];
    const schoolHours = wd < 5 && h > 8.3 && h < 15.6;
    if (child) {
      if (schoolHours) return null;
      if (h > 8 && h < 19 && !this.dark()) opts.push({ w: 5, v: 'play' });
      opts.push({ w: 1, v: 'stroll' });
    } else {
      if (sunday && h > 9.6 && h < 10.45 && t.church) return 'church';
      const pubOpen = h > 11.5 && h < 22.6 && t.pubs.length;
      if (h < 10 && h > 6.3) opts.push({ w: 2, v: 'sweep' });
      if (!sunday && h > 7.5 && h < 18 && t.shops.length) opts.push({ w: 3, v: 'shop' });
      if (h > 7 && h < 21) opts.push({ w: 2.2, v: 'gossip' });
      if (h > 8 && h < 20.5 && !this.dark()) opts.push({ w: 1.5, v: 'stroll' });
      if (h > 9 && h < 20) opts.push({ w: 0.8, v: 'visit' });
      if (pubOpen) opts.push({ w: h > 17.8 ? 6 : 0.6, v: 'pub' });
    }
    if (!opts.length) return null;
    return this.rng.weighted(opts);
  }

  private townRec(id: string) { return this.byTown.get(id) ?? { homes: [], shops: [], pubs: [], church: null, meet: [] }; }

  private startTrip(): boolean {
    const c = this.ctx.clock;
    const h = c.hour, wd = c.weekday;
    const home = this.pickHome();
    if (!home) return false;
    const t = this.townRec(home.town);
    const child = this.rng.chance(0.22);
    const kind = this.tripKind(h, wd, child, t);
    if (!kind) return false;
    if (kind === 'gossip') return this.gossip(home);
    const role: PersonRole = child ? 'child' : kind === 'pub' ? (this.rng.chance(0.8) ? 'drinker' : 'townsfolk') : 'townsfolk';
    const p = this.emergeFrom(home.o, role, { pool: true, child, home: home.b.id });
    if (!p) return false;
    this.casual.add(p);
    const b = home.b;
    switch (kind) {
      case 'sweep': {
        this.script(p, [
          { k: 'go', to: this.frontSpot(b, 1.4, this.rng.range(-1.2, 1.2)), direct: true, state: 'sweeping the step' },
          this.doAnim('sweep', this.rng.range(4, 9), 'sweeping the doorstep', ['broom']),
          this.doIdle('watch', this.rng.range(1.5, 4), 'passing the time of day'),
        ]);
        break;
      }
      case 'shop': {
        const shop = this.rng.pick(t.shops);
        const sb = this.building(shop.building);
        if (!p.look.child && this.rng.chance(0.6)) this.S.addAcc(p, 'basket');
        this.script(p, [
          { k: 'go', to: shop.pos(new THREE.Vector3()), state: `off to ${sb?.name ?? 'the shops'}` },
          { k: 'call', fn: (q) => this.stayIn(q, shop, this.rng.range(4, 12), (r) => this.afterShop(r, t, b), `in ${sb?.name ?? 'a shop'}`) },
        ], () => { /* continues in afterShop */ });
        break;
      }
      case 'stroll': {
        const spot = t.meet.length ? this.rng.pick(t.meet) : this.frontSpot(b, 8, 0);
        this.script(p, [
          { k: 'wander', center: spot, r: 7, min: this.rng.range(10, 25), state: child ? 'larking about' : 'taking the air', idle: child ? 'fidget' : 'watch' },
        ]);
        break;
      }
      case 'visit': {
        const other = t.homes.filter((x) => x !== home);
        if (!other.length) { this.home(p); break; }
        const v = this.rng.pick(other);
        this.script(p, [
          { k: 'go', to: v.o.pos(new THREE.Vector3()), state: `calling on ${v.b.name}` },
          { k: 'call', fn: (q) => this.stayIn(q, v.o, this.rng.range(15, 45), (r) => this.home(r), `taking tea at ${v.b.name}`) },
        ], () => { /* stayIn */ });
        break;
      }
      case 'pub': {
        const pub = this.nearestOf(t.pubs, home.o);
        const pb = this.building(pub?.building);
        if (!pub || !pb) { this.home(p); break; }
        const outside = !this.bad() && this.rng.chance(0.45);
        if (outside) {
          const spot = this.frontSpot(pb, this.rng.range(2.2, 4.2), this.rng.range(-4.5, 4.5));
          const until = Math.min(this.ctx.clock.minutes + this.rng.range(20, 70), this.minuteAt(22.9));
          this.script(p, [
            { k: 'go', to: spot, state: `off to ${pb.name}` },
            { k: 'call', fn: (q) => { q.faceYaw = yawTo(pb.doors[0].x - q.pos.x, pb.doors[0].z - q.pos.z) + this.rng.range(-1.6, 1.6); } },
            { k: 'do', idle: 'drink', state: `a pint outside ${pb.name}`, until: () => this.now() >= until },
          ], (q) => this.leavePub(q));
        } else {
          const stay = Math.max(8, Math.min(this.rng.range(30, 120), this.minuteAt(23) - this.now()));
          this.script(p, [
            { k: 'go', to: pub.pos(new THREE.Vector3()), state: `off to ${pb.name}` },
            { k: 'call', fn: (q) => this.stayIn(q, pub, stay, (r) => this.leavePub(r), `in ${pb.name}`) },
          ], () => { /* stayIn */ });
        }
        break;
      }
      case 'church': {
        const ch = t.church!;
        const cb = this.building(ch.building);
        const until = this.minuteAt(11.6);
        this.script(p, [
          { k: 'go', to: ch.pos(new THREE.Vector3()), state: `to ${cb?.name ?? 'church'}` },
          { k: 'call', fn: (q) => this.stayIn(q, ch, Math.max(10, until - this.now() + this.rng.range(0, 6)), (r) => this.afterChurch(r, cb), 'at church') },
        ], () => { /* stayIn */ });
        break;
      }
      case 'play': {
        const spot = t.meet.length ? this.rng.pick(t.meet) : this.frontSpot(b, 7, 0);
        this.childPlay(p, spot, this.rng.range(20, 50));
        break;
      }
      default: this.home(p);
    }
    return true;
  }

  private nearestOf(list: Origin[], from: Origin): Origin | null {
    let best: Origin | null = null, bd = Infinity;
    const fp = from.pos(new THREE.Vector3());
    for (const o of list) { const d = o.pos(_v).distanceTo(fp); if (d < bd) { bd = d; best = o; } }
    return best;
  }

  private minuteAt(h: number): number {
    const c = this.ctx.clock;
    return c.minutes + (h - c.hour) * 60;
  }

  private afterShop(p: Person, t: ReturnType<Town['townRec']>, _home: Building) {
    if (!p.alive) return;
    if (!p.look.child && this.rng.chance(0.5)) this.S.addAcc(p, 'parcel');
    if (t.meet.length && this.rng.chance(0.35)) {
      const spot = this.near(this.rng.pick(t.meet), 5);
      this.script(p, [{ k: 'go', to: spot, state: 'dawdling' }, this.doIdle(this.rng.chance(0.5) ? 'watch' : 'wait', this.rng.range(3, 9), 'watching the world go by')]);
    } else this.home(p);
  }

  private leavePub(p: Person) {
    if (!p.alive) return;
    const late = this.ctx.clock.hour > 22;
    if (late && this.rng.chance(0.6)) { p.state = 'wobbling'; this.home(p, 'wobbling'); p.state = 'wobbling'; }
    else this.home(p);
  }

  private afterChurch(p: Person, cb: Building | undefined) {
    if (!p.alive) return;
    if (cb) {
      const spot = this.frontSpot(cb, this.rng.range(3, 7), this.rng.range(-6, 6));
      this.script(p, [{ k: 'go', to: spot, state: 'after the service' }, this.doIdle('chat', this.rng.range(4, 14), 'chatting after church')]);
    } else this.home(p);
  }

  /** two neighbours meet somewhere and have a good long natter */
  private gossip(a: Home): boolean {
    const t = this.townRec(a.town);
    const bh = this.pickHome((h) => h.town === a.town);
    if (!bh || !this.S.roomFor(2)) return false;
    const base = t.meet.length ? this.near(this.rng.pick(t.meet), 5) : this.frontSpot(a.b, 5, this.rng.range(-3, 3));
    const ang = this.rng.range(0, Math.PI * 2);
    const off = new THREE.Vector3(Math.cos(ang) * 0.62, 0, Math.sin(ang) * 0.62);
    const p1 = this.emergeFrom(a.o, 'townsfolk', { pool: true });
    if (!p1) return false;
    const p2 = this.emergeFrom(bh.o, 'townsfolk', { pool: true });
    this.casual.add(p1);
    if (!p2) { this.script(p1, [{ k: 'wander', center: base, r: 5, min: 10, state: 'taking the air' }]); return true; }
    this.casual.add(p2);
    const s1 = base.clone().add(off), s2 = base.clone().sub(off);
    s1.y = this.ctx.layout.heightAt(s1.x, s1.z); s2.y = this.ctx.layout.heightAt(s2.x, s2.z);
    const talk = this.rng.range(8, 28);
    const pair = (me: Person, other: Person, spot: THREE.Vector3): Step[] => [
      { k: 'go', to: spot, state: 'meeting a neighbour' },
      { k: 'call', fn: (q) => { q.data.atMeet = true; } },
      { k: 'do', idle: 'wait', state: 'waiting for a neighbour', min: 40, until: () => !other.alive || !!other.data.atMeet },
      { k: 'call', fn: (q) => { if (other.alive) q.faceYaw = yawTo(other.pos.x - q.pos.x, other.pos.z - q.pos.z); } },
      { k: 'do', idle: 'chat', state: 'gossiping', min: talk, until: () => !other.alive },
    ];
    this.script(p1, pair(p1, p2, s1));
    this.script(p2, pair(p2, p1, s2));
    return true;
  }

  /** hoop-and-stick or tag */
  private childPlay(p: Person, spot: THREE.Vector3, min: number) {
    const hoop = this.rng.chance(0.45);
    const end = this.now() + min;
    const steps: Step[] = [{ k: 'go', to: this.near(spot, 3), state: 'off to play' }];
    const legs = Math.round(min / 3);
    for (let i = 0; i < legs; i++) {
      steps.push({ k: 'go', to: this.near(spot, 9), run: !hoop || this.rng.chance(0.3), direct: true, state: hoop ? 'bowling a hoop' : 'playing tag' });
      steps.push(this.doAnim(this.rng.chance(0.5) ? 'play' : 'idle', this.rng.range(0.6, 2.2), hoop ? 'bowling a hoop' : 'playing tag', undefined, { until: () => this.now() > end }));
    }
    if (hoop) this.S.addAcc(p, 'hoop');
    p.idle = 'fidget';
    this.script(p, steps);
  }

  // ───────────────────────── trades (fixed slots) ─────────────────────────
  private buildSlots() {
    const L = this.ctx.layout;
    const bk = (kind: string, town?: string) => L.buildings.find((b) => b.kind === kind && (!town || b.town === town));
    const dayWork = (a: number, b: number, sat = true) => (h: number, wd: number) => wd !== 6 && (sat || wd !== 5) && h >= a && h < b;
    // smiths at the forge
    for (const town of ['ashcombe', 'wyke']) {
      const sm = bk('smithy', town);
      if (!sm) continue;
      this.addSlot(`smith:${town}`, (h, wd) => wd !== 6 && h >= 7 && h < (wd === 5 ? 13 : 18), (warm) => this.smith(sm, warm));
    }
    // baker with his tray at the bakery door, early
    const bakery = bk('bakery');
    if (bakery) this.addSlot('baker', (h, wd) => wd !== 6 && h >= 6.8 && h < 9.8, (warm) => this.standSeller(bakery, 'baker', ['tray'], warm, 'crying hot loaves'));
    // publican sweeping his step in the morning / at the door in the evening
    const arms = L.buildings.find((b) => b.town === 'station' && b.kind === 'pub');
    if (arms) this.addSlot('publican', (h) => (h >= 9.5 && h < 10.4) || (h >= 18 && h < 22.8), (warm) => this.publican(arms, warm));
    // anglers
    const pegs = L.river.fishing.slice().sort((a, b) => (b.best ? 1 : 0) - (a.best ? 1 : 0));
    const nAnglers = Math.min(pegs.length, 2 + this.workersCap * 2);
    for (let i = 0; i < nAnglers; i++) {
      const peg = pegs[i];
      const start = 5.8 + (i % 4) * 0.7, stop = 18.5 + (i % 3) * 0.6;
      this.addSlot(`angler:${peg.id}`, (h) => h >= start && h < stop && !this.dark() && this.ctx.reg.atmosphere?.weather !== 'storm' && (this.ctx.reg.nature?.river.ice ?? 0) < 0.4, (warm) => this.angler(peg, warm));
    }
    // farmhands
    const fieldsFor: [string, string][] = [['FA', 'coldharbour'], ['FF', 'millbridge'], ['FG', 'coldharbour'], ['FD', 'wyke'], ['FL', 'eastcote'], ['FJ', 'glenmoor'], ['FI', 'millbridge']];
    const nHands = Math.min(fieldsFor.length, 1 + this.workersCap * 2);
    for (let i = 0; i < nHands; i++) {
      const [fid, town] = fieldsFor[i];
      const f = L.fields.find((x) => x.id === fid);
      if (!f) continue;
      this.addSlot(`farmhand:${fid}`, (h, wd) => dayWork(7, 17)(h, wd) && this.ctx.reg.atmosphere?.weather !== 'storm' && (this.ctx.reg.atmosphere?.snowCover ?? 0) < 0.5, (warm) => this.farmhand(f, town, warm));
    }
    // shepherd at Wyke Down
    const fb = L.fields.find((x) => x.id === 'FB');
    if (fb) this.addSlot('shepherd', (h) => h >= 7.5 && h < 17.5 && this.ctx.reg.atmosphere?.weather !== 'storm', (warm) => this.shepherd(fb, warm));
    // market day costers on Ashcombe square (Thursday)
    const sq = L.towns.find((t) => t.id === 'ashcombe')?.areas.find((a) => a.kind === 'square');
    if (sq) for (let i = 0; i < 2 + this.workersCap; i++) {
      this.addSlot(`vendor:${i}`, (h, wd) => wd === 3 && h >= 8 && h < 14.5, (warm) => this.vendor(sq, i, warm));
    }
    // postman's round
    const post = bk('post');
    if (post) this.addSlot('postman', (h, wd) => wd !== 6 && ((h >= 7.2 && h < 9.3) || (h >= 13 && h < 14.5)), (warm) => this.postman(post, warm));
    // Monday washerwoman
    this.addSlot('washer', (h, wd) => wd === 0 && h >= 8 && h < 16.5, (warm) => this.washerwoman(warm));
    // skaters on a frozen river (from Ashcombe, by the meadow walk and the boathouse)
    for (let i = 0; i < 1 + this.workersCap; i++) {
      this.addSlot(`skater:${i}`, (h) => h >= 10 + i * 0.4 && h < 16 && (this.ctx.reg.nature?.river.ice ?? 0) > 0.9 && !this.dark(), (warm) => this.skater(i, warm));
    }
    // vicar: Sunday service and a weekday stroll
    const vic = L.buildings.find((b) => b.town === 'ashcombe' && b.name === 'Church Cottage') ?? L.buildings.find((b) => b.town === 'ashcombe' && b.kind === 'cottage');
    if (vic) this.addSlot('vicar', (h, wd) => (wd === 6 && h >= 9.7 && h < 12) || (wd !== 6 && h >= 15 && h < 16.2), () => this.vicar(vic));
  }

  private addSlot(key: string, active: Slot['active'], spawn: Slot['spawn']) { this.slots.push({ key, person: null, active, spawn, nextTry: 0 }); }

  private updateSlots(warm = false) {
    const c = this.ctx.clock;
    const h = c.hour, wd = c.weekday, now = c.minutes;
    for (const s of this.slots) {
      const act = s.active(h, wd);
      if (act && !s.person && (warm || now >= s.nextTry)) {
        s.nextTry = now + 20;
        if (!this.S.roomFor(1)) continue;
        s.person = s.spawn(warm);
        if (s.person) s.person.data.slot = s.key;
      } else if (!act && s.person && s.person.alive && !s.person.data.goingHome) {
        const p = s.person;
        p.data.goingHome = true;
        if (p.data.indoorsOf) this.releaseIndoors(p, (q) => this.home(q));
        else this.home(p);
      }
    }
  }

  private releaseIndoors(p: Person, then: (p: Person) => void) {
    const i = this.indoors.findIndex((x) => x.p === p);
    if (i >= 0) this.indoors.splice(i, 1);
    this.S.reemerge(p);
    p.onArrive = () => then(p);
  }

  /** a worker's loop: the steps repeat while the slot is active, then they go home */
  private loop(p: Person, make: () => Step[]) {
    const again = (q: Person) => {
      if (!q.alive) return;
      if (q.data.goingHome) { this.home(q); return; }
      this.S.runScript(q, make(), again);
    };
    this.S.runScript(p, make(), again);
  }

  private place(p: Person, at: THREE.Vector3) { p.pos.copy(at); p.fade = 1; p.fadeLeg = null; p.path = []; p.pathIdx = 0; p.onArrive = null; }

  private warmSpawn(role: PersonRole, at: THREE.Vector3, home?: string, child = false): Person {
    const p = this.S.spawnRaw(role, at, 'town', child ? roleLook('child', this.rng) : undefined);
    p.home = home;
    p.data.fixed = true;
    if (home) { p.originId = `door:${home}:0`; this.ctx.origins.pools.take(home, 1); }
    return p;
  }

  private smith(b: Building, warm: boolean): Person | null {
    // the anvil stands just inside the open forge front, the smith side-on to the street
    const anvil = this.frontSpot(b, -1.1, 1.3);
    anvil.y = b.center.y;
    const faceYaw = b.yaw + Math.PI / 2;
    let p: Person | null;
    if (warm) p = this.warmSpawn('blacksmith', anvil, b.id);
    else p = this.emergeFrom(`door:${b.id}:0`, 'blacksmith', { pool: true, fixed: true, home: b.id, force: true });
    if (!p) return null;
    const make = (): Step[] => [
      { k: 'go', to: anvil, direct: true, state: 'at the anvil' },
      { k: 'face', yaw: faceYaw },
      this.doAnim('hammer', this.rng.range(3, 9), 'hammering a horseshoe', ['hammer'], { tick: (q) => this.forgeClang(q) }),
      this.doIdle('work', this.rng.range(1, 3), 'wiping his brow'),
      ...(this.rng.chance(0.3) ? [{ k: 'call', fn: (q: Person) => this.stayIn(q, `door:${b.id}:0`, this.rng.range(2, 6), (r) => this.loop(r, make), 'at the forge') } as Step] : []),
    ];
    this.loop(p, make);
    return p;
  }

  private forgeClang(p: Person) {
    const t = (p.data.clang as number | undefined) ?? 0;
    if (this.S.vt < t) return;
    p.data.clang = this.S.vt + 1.6 + Math.random() * 1.2;
    if (this.ctx.view?.isVisible(p.pos, 30)) this.ctx.bus.emit('audio:cue', { cue: 'forge', pos: p.pos, volume: 0.35 });
  }

  private standSeller(b: Building, role: PersonRole, props: AccKind[], warm: boolean, state: string): Person | null {
    const spot = this.frontSpot(b, 1.8, -1.4);
    const p = warm ? this.warmSpawn(role, spot, b.id) : this.emergeFrom(`door:${b.id}:0`, role, { pool: true, fixed: true, home: b.id, force: true });
    if (!p) return null;
    const make = (): Step[] => [
      { k: 'go', to: this.near(spot, 1.5), direct: true, state },
      { k: 'face', yaw: b.yaw + this.rng.range(-0.8, 0.8) },
      { k: 'do', idle: 'sell', props, min: this.rng.range(4, 10), state },
    ];
    this.loop(p, make);
    return p;
  }

  private publican(b: Building, warm: boolean): Person | null {
    const spot = this.frontSpot(b, 1.5, 1.5);
    const p = warm ? this.warmSpawn('publican', spot, b.id) : this.emergeFrom(`door:${b.id}:0`, 'publican', { pool: true, fixed: true, home: b.id, force: true });
    if (!p) return null;
    const morning = this.ctx.clock.hour < 12;
    const make = (): Step[] => morning
      ? [{ k: 'go', to: this.near(spot, 1.2), direct: true, state: 'sweeping the step' }, this.doAnim('sweep', this.rng.range(3, 7), 'sweeping the step', ['broom'])]
      : [
        { k: 'go', to: this.near(spot, 1.5), direct: true, state: 'at the door' },
        { k: 'face', yaw: b.yaw + this.rng.range(-0.6, 0.6) },
        this.doIdle('chat', this.rng.range(2, 6), 'passing the time with regulars'),
        { k: 'call', fn: (q) => this.stayIn(q, `door:${b.id}:0`, this.rng.range(8, 25), (r) => this.loop(r, make), 'behind the bar') },
      ];
    this.loop(p, make);
    return p;
  }

  private angler(peg: { id: string; pos: THREE.Vector3; s: number; best?: boolean }, warm: boolean): Person | null {
    const O = this.ctx.origins;
    const R = this.ctx.layout.river;
    const c = R.pointAt(peg.s);
    const face = yawTo(c.x - peg.pos.x, c.z - peg.pos.z);
    const home = O.bestFor(peg.pos, 'people', { kinds: ['door', 'portal'], exclude: ['door:station:east', 'door:station:p1', 'door:station:p2'] });
    if (!home) return null;
    const hb = this.building(home.building);
    const fromDoor = !!hb && RESIDENTIAL.has(hb.kind);
    let p: Person | null;
    if (warm) p = this.warmSpawn('angler', peg.pos, fromDoor ? hb!.id : undefined);
    else p = this.emergeFrom(home, 'angler', { pool: fromDoor, fixed: true, home: fromDoor ? hb!.id : undefined, force: true });
    if (!p) return null;
    if (!fromDoor) p.originId = home.id;
    p.data.catches = 0;
    const fishStep = (): Step => ({
      k: 'do', anim: 'fish', props: ['rod', 'basket'], min: this.rng.range(15, 60), state: p!.data.catches ? `fishing (${p!.data.catches} caught)` : 'fishing',
      tick: (q, dts) => this.fishTick(q, dts, peg.pos),
    });
    if (!warm) this.S.addAcc(p, 'rodCarry');
    const make = (): Step[] => [
      { k: 'call', fn: (q) => this.S.addAcc(q, 'rodCarry') },
      { k: 'go', to: peg.pos, state: `off fishing at ${peg.best ? 'the mill pool' : 'the river'}` },
      { k: 'call', fn: (q) => this.S.removeAcc(q, 'rodCarry') },
      { k: 'face', yaw: face },
      fishStep(),
      this.doIdle('smoke', this.rng.range(1, 3), 'baiting the hook'),
      fishStep(),
    ];
    if (warm) {
      p.faceYaw = face; p.yaw = face;
      this.S.runScript(p, [fishStep()], (q) => this.loop(q, make));
    } else this.loop(p, make);
    return p;
  }

  private fishTick(p: Person, dts: number, peg: THREE.Vector3) {
    if (dts <= 0) return;
    if (this.rng.chance(dts / 28)) {
      p.data.catches = ((p.data.catches as number) ?? 0) + 1;
      p.data.forceClip = 'reel';
      p.nextClip = 0; p.clipT = 0;
      p.state = `landed a ${this.rng.pick(['roach', 'perch', 'chub', 'dace', 'gudgeon', 'fine trout', 'boot'])}!`;
      if (this.ctx.view?.isVisible(peg, 20)) this.ctx.bus.emit('audio:cue', { cue: 'splash', pos: peg, volume: 0.3 });
    }
  }

  private farmCache = new Map<string, Building | undefined>();
  /** the farm (or cottage) whose door is the shortest WALK from the field gate — never across the river and railway */
  private farmFor(f: { id: string; gate: THREE.Vector3 }, town: string): Building | undefined {
    if (this.farmCache.has(f.id)) return this.farmCache.get(f.id)!;
    const L = this.ctx.layout;
    const def = L.buildings.find((b) => b.town === town && b.kind === 'farmhouse') ?? L.buildings.find((b) => b.town === town && RESIDENTIAL.has(b.kind));
    const cands = L.buildings.filter((b) => (b.kind === 'farmhouse' || RESIDENTIAL.has(b.kind)) && b.town !== 'station' && b.doors.length && b.residents > 0)
      .map((b) => ({ b, d: Math.hypot(b.doors[0].x - f.gate.x, b.doors[0].z - f.gate.z) }))
      .sort((a, b) => a.d - b.d).slice(0, 6);
    let best = def, bl = Infinity;
    for (const c of cands) {
      let l = Infinity;
      try { l = L.walk.length(c.b.doors[0], f.gate); } catch { /* */ }
      // farmhouses preferred a little
      const score = l * (c.b.kind === 'farmhouse' ? 0.8 : 1);
      if (score < bl) { bl = score; best = c.b; }
    }
    this.farmCache.set(f.id, best);
    return best;
  }

  private farmhand(f: { id: string; poly: THREE.Vector2[]; gate: THREE.Vector3; center: THREE.Vector3; kind: string; rowYaw: number }, town: string, warm: boolean): Person | null {
    const L = this.ctx.layout;
    const farm = this.farmFor(f, town);
    if (!farm) return null;
    const work = (): THREE.Vector3 => {
      // a point inside the field, 6-25 m in from the gate towards the centre
      const k = this.rng.range(0.15, 0.55);
      const x = f.gate.x + (f.center.x - f.gate.x) * k + this.rng.range(-6, 6), z = f.gate.z + (f.center.z - f.gate.z) * k + this.rng.range(-6, 6);
      return this.ground(x, z);
    };
    const month = Math.floor(((this.ctx.clock.day % 365) / 30.4)) % 12;
    const hay = f.kind === 'hay' && month >= 5 && month <= 7;
    const anim: PersonAnim = hay ? 'scythe' : f.kind === 'turnips' ? 'shovel' : 'pitchfork';
    const props: AccKind[] = anim === 'shovel' ? ['pitchfork'] : ['pitchfork'];
    const at = work();
    const p = warm ? this.warmSpawn('farmhand', at, farm.id) : this.emergeFrom(`door:${farm.id}:0`, 'farmhand', { pool: true, fixed: true, home: farm.id, force: true });
    if (!p) return null;
    const make = (): Step[] => {
      const h = this.ctx.clock.hour;
      const lunch = h >= 12 && h < 12.8;
      if (lunch) return [{ k: 'go', to: this.near(f.gate, 2.5), direct: true, state: 'lunch by the gate' }, this.doIdle('drink', this.rng.range(10, 25), 'bread and cheese by the gate')];
      const w = work();
      return [
        { k: 'go', to: w, state: 'off to the field' },
        { k: 'face', yaw: f.rowYaw + (this.rng.chance(0.5) ? 0 : Math.PI) },
        this.doAnim(anim, this.rng.range(6, 16), hay ? 'mowing hay' : f.kind === 'turnips' ? 'hoeing turnips' : 'working the field', props),
        this.doIdle('work', this.rng.range(1, 3), 'straightening his back'),
      ];
    };
    if (warm) this.S.runScript(p, [this.doAnim(anim, this.rng.range(3, 12), 'working the field', props)], (q) => this.loop(q, make));
    else {
      this.S.addAcc(p, 'pitchfork');
      this.S.runScript(p, [{ k: 'go', to: f.gate.clone(), state: 'off to the field' }, { k: 'call', fn: (q) => this.S.removeAcc(q, 'pitchfork') }], (q) => this.loop(q, make));
    }
    return p;
  }

  private shepherd(f: { gate: THREE.Vector3; center: THREE.Vector3 }, warm: boolean): Person | null {
    const L = this.ctx.layout;
    const farm = L.buildings.find((b) => b.town === 'wyke' && b.kind === 'farmhouse');
    if (!farm) return null;
    const spot = (): THREE.Vector3 => this.ground(f.gate.x + (f.center.x - f.gate.x) * this.rng.range(0.1, 0.4) + this.rng.range(-5, 5), f.gate.z + (f.center.z - f.gate.z) * this.rng.range(0.1, 0.4) + this.rng.range(-5, 5));
    const p = warm ? this.warmSpawn('shepherd', spot(), farm.id) : this.emergeFrom(`door:${farm.id}:0`, 'shepherd', { pool: true, fixed: true, home: farm.id, force: true });
    if (!p) return null;
    const make = (): Step[] => [
      { k: 'go', to: spot(), state: 'minding the flock' },
      { k: 'faceTo', p: f.center },
      this.doIdle('watch', this.rng.range(6, 18), 'leaning on his crook, watching the flock'),
    ];
    this.loop(p, make);
    return p;
  }

  private vendor(sq: { center: THREE.Vector3; size: THREE.Vector3; yaw: number }, i: number, warm: boolean): Person | null {
    const L = this.ctx.layout;
    const col = i % 3, row = Math.floor(i / 3);
    const a = (col - 1) * sq.size.x * 0.28, b = (row === 0 ? -1 : 1) * sq.size.z * 0.22;
    const spot = this.ground(sq.center.x + a * Math.cos(sq.yaw) + b * Math.sin(sq.yaw), sq.center.z - a * Math.sin(sq.yaw) + b * Math.cos(sq.yaw));
    const face = yawTo(sq.center.x - spot.x, sq.center.z - spot.z);
    let p: Person | null;
    if (warm) p = this.warmSpawn('vendor', spot);
    else {
      // costers walk in with their wares from the road portals / Ashcombe doors
      const home = this.pickHome((h) => h.town === 'ashcombe' || h.town === 'station');
      p = home ? this.emergeFrom(home.o, 'vendor', { pool: true, fixed: true, home: home.b.id, force: true }) : null;
      if (!p) {
        const o = this.ctx.origins.bestFor(spot, 'people', { kinds: ['portal'] });
        p = o ? this.emergeFrom(o, 'vendor', { fixed: true, force: true }) : null;
        if (p && o) p.originId = o.id;
      }
    }
    if (!p) return null;
    const wares: AccKind[] = [this.rng.pick(['tray', 'basket', 'tray'] as AccKind[])];
    void L;
    const make = (): Step[] => [
      { k: 'go', to: this.near(spot, 1.2), direct: this.S.list.length > 0 && p!.pos.distanceTo(spot) < 12, state: 'setting out wares' },
      { k: 'face', yaw: face + this.rng.range(-0.7, 0.7) },
      { k: 'do', idle: 'sell', props: wares, min: this.rng.range(5, 14), state: this.rng.pick(['"Apples, fine apples!"', '"Fresh watercress!"', '"Ribbons and laces!"', '"Hot chestnuts!"', '"Buy my sweet lavender!"']) },
    ];
    this.loop(p, make);
    return p;
  }

  private postman(post: Building, warm: boolean): Person | null {
    const doors = this.townRec('ashcombe').homes.concat(this.townRec('station').homes);
    const p = warm ? this.warmSpawn('postman', this.frontSpot(post, 2, 0), post.id) : this.emergeFrom(`door:${post.id}:0`, 'postman', { pool: true, fixed: true, home: post.id, force: true });
    if (!p) return null;
    const steps: Step[] = [];
    const n = Math.min(doors.length, 5 + this.rng.int(0, 3));
    const pool = doors.slice();
    for (let i = 0; i < n; i++) {
      const d = pool.splice(this.rng.int(0, pool.length - 1), 1)[0];
      if (!d) break;
      const at = d.o.pos(new THREE.Vector3());
      steps.push({ k: 'go', to: at, state: 'delivering the post' });
      steps.push({ k: 'faceTo', p: d.o.inside ? d.o.inside(new THREE.Vector3()) : d.b.center });
      steps.push(this.doAnim('point', this.rng.range(0.6, 1.4), `a letter for ${d.b.name}`));
      steps.push(this.doIdle('chat', this.rng.range(0, 1) < 0.3 ? this.rng.range(1, 3) : 0.2, 'a word on the doorstep'));
    }
    this.S.runScript(p, steps, (q) => this.home(q, 'back to the Post Office'));
    return p;
  }

  private washerwoman(warm: boolean): Person | null {
    const cands = this.townRec('ashcombe').homes.concat(this.townRec('station').homes).filter((h) => h.b.kind === 'cottage' || h.b.kind === 'terrace');
    if (!cands.length) return null;
    const own = this.rng.pick(cands);
    const p = warm ? this.warmSpawn('washerwoman', this.frontSpot(own.b, 1.8, 0), own.b.id) : this.emergeFrom(own.o, 'washerwoman', { pool: true, fixed: true, home: own.b.id, force: true });
    if (!p) return null;
    const make = (): Step[] => {
      const h = this.ctx.clock.hour;
      const bringIn = h >= 14.5;
      const todo = cands.filter((c) => (bringIn ? this.washed.has(c.b.id) : !this.washed.has(c.b.id)));
      if (!todo.length) return [this.doIdle('chat', 4, 'resting her arms')];
      const c = this.rng.pick(todo);
      return [
        { k: 'go', to: this.frontSpot(c.b, 1.8, this.rng.range(-1.5, 1.5)), state: bringIn ? 'bringing in the washing' : 'doing the wash' },
        bringIn ? this.doAnim('carry', this.rng.range(3, 6), `taking in ${c.b.name}'s washing`) : this.doAnim('wash', this.rng.range(10, 25), `washday at ${c.b.name}`, ['pail']),
        { k: 'call', fn: () => { if (bringIn) { this.washed.delete(c.b.id); this.setWashing(c.b.id, 0); } else { this.washed.add(c.b.id); this.setWashing(c.b.id, 1); } } },
      ];
    };
    this.loop(p, make);
    return p;
  }

  private setWashing(id: string, a: number) { try { this.ctx.reg.world?.setWashing(id, a); } catch { /* stub */ } }

  private skater(i: number, warm: boolean): Person | null {
    const R = this.ctx.layout.river;
    const reach = R.reaches.find((r) => r.id === 'skating');
    if (!reach) return null;
    const onIce = (): THREE.Vector3 => {
      const s = this.rng.range(reach.s0 + 4, reach.s1 - 4);
      const w = R.widthAt(s);
      return R.pointAt(s, this.rng.range(-w / 2 + 1.6, w / 2 - 1.6), R.waterYAt(s) + 0.02);
    };
    const bankS = (reach.s0 + reach.s1) / 2;
    const bank = R.pointAt(bankS, R.towpath.lateral(bankS), R.towpath.yAt(bankS));
    const edge = R.pointAt(bankS, R.widthAt(bankS) / 2 - 0.8, R.waterYAt(bankS) + 0.02);
    let p: Person | null;
    if (warm) p = this.warmSpawn('skater', onIce(), undefined, i % 3 === 2);
    else {
      const home = this.pickHome((h) => h.town === 'ashcombe' || h.town === 'station');
      if (!home) return null;
      p = this.emergeFrom(home.o, 'skater', { pool: true, fixed: true, child: i % 3 === 2, home: home.b.id, force: true });
    }
    if (!p) return null;
    const skate = (): Step[] => {
      const out: Step[] = [];
      for (let k = 0; k < 5; k++) {
        out.push({ k: 'call', fn: (q) => { q.manualAnim = 'skate'; } });
        out.push({ k: 'go', to: onIce(), direct: true, speed: this.rng.range(2.2, 3.4), state: 'skating' });
        out.push({ k: 'call', fn: (q) => { q.manualAnim = null; } });
        out.push(this.doIdle(i % 3 === 2 ? 'fidget' : 'chat', this.rng.range(0.5, 3), 'catching breath on the ice'));
      }
      return out;
    };
    const again = (q: Person) => {
      if (!q.alive) return;
      if (q.data.goingHome || (this.ctx.reg.nature?.river.ice ?? 0) < 0.9) {
        q.manualAnim = null;
        this.S.runScript(q, [{ k: 'go', to: edge, direct: true, state: 'off the ice' }, { k: 'go', to: bank, direct: true, state: 'going home' }], (r) => this.home(r));
        return;
      }
      this.S.runScript(q, skate(), again);
    };
    if (warm) this.S.runScript(p, skate(), again);
    else this.S.runScript(p, [{ k: 'go', to: bank, state: 'off to skate' }, { k: 'go', to: edge, direct: true, state: 'stepping onto the ice' }], again);
    return p;
  }

  private vicar(b: Building): Person | null {
    const p = this.emergeFrom(`door:${b.id}:0`, 'vicar', { pool: true, fixed: true, home: b.id, force: true });
    if (!p) return null;
    const ch = this.townRec('ashcombe').church;
    const cb = this.building(ch?.building);
    if (this.ctx.clock.weekday === 6 && ch && cb) {
      const until = this.minuteAt(11.55);
      this.S.runScript(p, [
        { k: 'go', to: ch.pos(new THREE.Vector3()), state: 'to take the service' },
        { k: 'call', fn: (q) => this.stayIn(q, ch, Math.max(5, until - this.now()), (r) => this.S.runScript(r, [
          { k: 'go', to: this.frontSpot(cb, 1.8, 1), direct: true, state: 'at the church door' },
          this.doIdle('chat', this.rng.range(12, 25), 'shaking hands at the church door'),
        ], (s) => this.home(s)), 'taking the service') },
      ], () => { /* stayIn */ });
    } else {
      const sq = this.townRec('ashcombe').meet[0] ?? b.doors[0];
      this.S.runScript(p, [{ k: 'wander', center: sq, r: 8, min: this.rng.range(15, 35), state: 'on his pastoral round', idle: 'chat' }], (q) => this.home(q));
    }
    return p;
  }

  // ───────────────────────── school ─────────────────────────
  private updateSchool() {
    if (!this.schoolDoor) return;
    const c = this.ctx.clock;
    const h = c.hour, wd = c.weekday;
    if (wd >= 5) return;
    const now = c.minutes;
    // morning: pupils walk from Ashcombe & station cottages to school
    if (h >= 7.6 && h < 8.7 && this.pupils.size < 4 + this.workersCap * 3 && this.rng.chance(0.08) && this.S.roomFor(1)) {
      const home = this.pickHome((x) => x.town === 'ashcombe' || x.town === 'station');
      if (home) {
        const p = this.emergeFrom(home.o, 'schoolchild', { pool: true, child: true, fixed: true, home: home.b.id });
        if (p) {
          this.pupils.add(p);
          p.idle = 'fidget';
          this.S.runScript(p, [{ k: 'go', to: this.S.origin(this.schoolDoor)!.pos(new THREE.Vector3()), state: 'off to school', run: this.rng.chance(0.3) },
            { k: 'call', fn: (q) => this.stayIn(q, this.schoolDoor!, 60 * 10, (r) => this.home(r, 'home from school'), 'at lessons') }], () => { /* stayIn */ });
        }
      }
    }
    // playtime 10:30-10:50 and 12:00-12:55
    const play = (h >= 10.5 && h < 10.83) || (h >= 12 && h < 12.9);
    if (play && this.schoolyard && now > this.playT) {
      this.playT = now + 200;
      const end = h < 11 ? this.minuteAt(10.83) : this.minuteAt(12.9);
      for (const p of this.pupils) {
        if (!p.alive || !p.data.indoorsOf) continue;
        this.releaseIndoors(p, (q) => this.yardPlay(q, end));
      }
    }
    // home time
    if (h >= 15.5 && h < 16) {
      for (const p of [...this.pupils]) if (p.alive && p.data.indoorsOf) this.releaseIndoors(p, (q) => { this.pupils.delete(q); this.home(q, 'home from school'); });
    }
  }

  private yardPlay(p: Person, end: number) {
    const Y = this.schoolyard!;
    const steps: Step[] = [];
    const legs = 8;
    for (let i = 0; i < legs; i++) {
      steps.push({ k: 'go', to: this.inArea(Y.c, Y.s, Y.yaw), run: this.rng.chance(0.7), direct: i > 0, state: 'playtime!' });
      steps.push(this.doAnim(this.rng.chance(0.6) ? 'play' : 'idle', this.rng.range(0.5, 2), 'playtime!', undefined, { until: () => this.now() > end }));
    }
    p.idle = 'fidget';
    this.S.runScript(p, steps, (q) => {
      if (!q.alive) return;
      if (this.now() < end) { this.yardPlay(q, end); return; }
      if (this.ctx.clock.hour >= 15.5) { this.pupils.delete(q); this.home(q, 'home from school'); return; }
      this.S.runScript(q, [{ k: 'go', to: this.S.origin(this.schoolDoor!)!.pos(new THREE.Vector3()), state: 'back to lessons', run: true },
        { k: 'call', fn: (r) => this.stayIn(r, this.schoolDoor!, 60 * 8, (s) => { this.pupils.delete(s); this.home(s, 'home from school'); }, 'at lessons') }], () => { /* stayIn */ });
    });
  }

  // ───────────────────────── lamplighters ─────────────────────────
  private lamps(): LampInfo[] {
    try { return this.ctx.reg.world?.lamps() ?? []; } catch { return []; }
  }

  private lampLit(i: number): number { try { return this.ctx.reg.world?.lampLit(i) ?? 0; } catch { return 0; } }

  private buildRounds(): Round[] {
    const lamps = this.lamps();
    const out: Round[] = [];
    // non-platform lamps, clustered by single-link at 45 m
    const idx = lamps.filter((l) => l.group !== 'platform' && l.group !== 'crossing').map((l) => l.index);
    const pos = (i: number) => lamps.find((l) => l.index === i)!.pos;
    const seen = new Set<number>();
    const chunks: number[][] = [];
    for (const i of idx) {
      if (seen.has(i)) continue;
      const cl: number[] = [i]; seen.add(i);
      for (let k = 0; k < cl.length; k++) for (const j of idx) if (!seen.has(j) && pos(cl[k]).distanceTo(pos(j)) < 45) { seen.add(j); cl.push(j); }
      // long chains (the Kingsport road) become several short rounds of ≤ 4 lamps, walked nearest-neighbour —
      // at 1 m per sim minute a 12-lamp round would still be going at 3 a.m.
      // short rounds of 2–3 lamps each (at 1 m per sim minute a long round is still walking at midnight)
      const ordered = this.order(lamps, cl, pos(cl[0]));
      const per = ordered.length <= 3 ? ordered.length : ordered.length % 3 === 1 ? 2 : 3;
      for (let k = 0; k < ordered.length; k += per) chunks.push(ordered.slice(k, k + per));
    }
    const used = new Set<string>();
    for (const cl of chunks) {
      const c = new THREE.Vector3();
      for (const j of cl) c.add(pos(j));
      c.divideScalar(cl.length);
      // start door: the nearest home door not already sending out another lamplighter (Crown Mews when it's close)
      const mews = this.ctx.layout.buildings.find((b) => b.kind === 'mews');
      let start: string | null = null;
      if (mews && c.distanceTo(mews.center) < 40 && !used.has(`door:${mews.id}:0`)) start = `door:${mews.id}:0`;
      if (!start || !this.S.origin(start)) {
        start = null;
        let bd = Infinity;
        for (const h of this.homes) { if (used.has(h.o.id)) continue; const d = h.o.pos(_v).distanceTo(c); if (d < bd) { bd = d; start = h.o.id; } }
      }
      if (!start) continue;
      used.add(start);
      const child = out.length % 2 === 1 || this.S.origin(start)?.building?.startsWith('station') === true;
      out.push({ id: `round${out.length}`, lamps: cl, start, child, person: null, mode: null, center: c });
    }
    return out;
  }

  /** nearest-neighbour order from `from` */
  private order(lamps: LampInfo[], ids: number[], from: THREE.Vector3): number[] {
    const left = ids.slice();
    const out: number[] = [];
    const cur = from.clone();
    while (left.length) {
      let bi = 0, bd = Infinity;
      for (let k = 0; k < left.length; k++) { const d = lamps[left[k]]?.pos.distanceTo(cur) ?? Infinity; if (d < bd) { bd = d; bi = k; } }
      const i = left.splice(bi, 1)[0];
      out.push(i);
      if (lamps[i]) cur.copy(lamps[i].pos);
    }
    return out;
  }

  private lampSteps(lamps: LampInfo[], ids: number[], from: THREE.Vector3, on: boolean, staff: boolean): Step[] {
    const steps: Step[] = [];
    const prev = from.clone();
    const order = this.order(lamps, ids, from).filter((i) => !!lamps[i]);
    order.forEach((i, k) => {
      const L = lamps[i];
      const rest = order.slice(k);
      // before each lamp: if the backstop (or someone else) already did the rest of the round, go home now;
      // if just this one is done, skip to the next
      const PER_LAMP = 6;
      steps.push({ k: 'call', fn: (q) => {
        const done = (j: number) => (on ? this.lampLit(j) > 0.5 : this.lampLit(j) < 0.5);
        if (rest.every(done)) { if (q.script) q.stepIdx = q.script.length; }
        else if (done(i)) q.stepIdx += PER_LAMP - 1;
      } });
      const d = new THREE.Vector3(prev.x - L.pos.x, 0, prev.z - L.pos.z);
      if (d.lengthSq() < 0.01) d.set(1, 0, 0);
      d.normalize().multiplyScalar(1.1);
      const stand = new THREE.Vector3(L.pos.x + d.x, L.pos.y, L.pos.z + d.z);
      if (!staff) stand.y = this.ctx.layout.heightAt(stand.x, stand.z);
      steps.push({ k: 'go', to: stand, speed: 1.75, staff, state: on ? 'lighting the lamps' : 'putting out the lamps' });
      steps.push({ k: 'faceTo', p: L.pos });
      steps.push({ k: 'call', fn: (q) => { q.data.carryPole = q.accSlots.poleCarry !== undefined; this.S.removeAcc(q, 'poleCarry'); } });
      steps.push({ k: 'do', anim: 'light', props: ['pole'], min: this.rng.range(2.5, 4), state: on ? 'lighting a lamp' : 'putting out a lamp' });
      steps.push({ k: 'call', fn: (q) => {
        try { this.ctx.reg.world?.lightLamp(i, on); } catch { /* stub */ }
        if (q.data.carryPole) this.S.addAcc(q, 'poleCarry');
      } });
      prev.copy(stand);
    });
    return steps;
  }

  private updateLamps() {
    const c = this.ctx.clock;
    const h = c.hour, day = c.day;
    // a round whose lamps are all done already (the backstop, or a porter) ends at once: home by the shortest way
    if (this.rounds) for (const r of this.rounds) {
      const q = r.person;
      if (!q || !q.alive || !r.mode) continue;
      const lit = r.mode === 'light';
      if (!r.lamps.every((i) => (lit ? this.lampLit(i) > 0.5 : this.lampLit(i) < 0.5))) continue;
      if (q.state === 'lighting a lamp' || q.state === 'putting out a lamp') continue; // finish the lamp in hand
      r.person = null; r.mode = null;
      q.originId = undefined;
      void this.S.dismiss(q, { state: lit ? 'round done, home for supper' : 'round done, home to bed' });
    }
    const g = this.S.gloom();
    // rounds start early in the dusk (the lamplighter is out before it is properly dark) and at first light
    const evening = h >= 14 && h < 23.5 && (g > 0.3 || (h >= 19.3 && g > 0.005));
    const morning = h >= 4 && h < 12 && (g < 0.5 || (h >= 5.2 && g < 0.92));
    if (!evening && !morning) return;
    const mode: 'light' | 'douse' = evening ? 'light' : 'douse';
    const on = mode === 'light';
    if (!this.rounds) this.rounds = this.buildRounds();
    const lamps = this.lamps();
    if (!lamps.length) return;
    // town rounds
    if (this.roundDay[mode] !== day) {
      this.roundDay[mode] = day;
      for (const r of this.rounds) {
        if (r.person && r.person.alive) continue;
        const todo = r.lamps.filter((i) => (on ? this.lampLit(i) < 0.5 : this.lampLit(i) > 0.5) || !this.worldManual());
        if (!todo.length) continue;
        const o = this.S.origin(r.start);
        if (!o) continue;
        const p = this.emergeFrom(o, 'lamplighter', { pool: false, child: r.child, fixed: true, force: true });
        if (!p) continue;
        p.originId = o.id; p.home = undefined;
        if (r.child) { this.S.addAcc(p, 'ladder'); }
        this.S.addAcc(p, 'poleCarry');
        r.person = p; r.mode = mode;
        const steps = this.lampSteps(lamps, todo, o.pos(new THREE.Vector3()), on, false);
        this.S.runScript(p, steps, (q) => { r.person = null; r.mode = null; q.originId = undefined; void this.S.dismiss(q, { state: on ? 'round done, home for supper' : 'round done, home to bed' }); });
      }
    }
    // porters light the platform lamps
    if (this.portersLit[mode] !== day) {
      const porters = this.S.staff.porters();
      if (this.portersSince[mode] < 0 || c.minutes - this.portersSince[mode] > 600) this.portersSince[mode] = c.minutes;
      // every porter busy with luggage (or none on duty): the station's own lamp man comes out of the booking hall
      if (!porters.length && c.minutes - this.portersSince[mode] > 10) {
        const todo = lamps.filter((l) => l.group === 'platform').map((l) => l.index).filter((i) => (on ? this.lampLit(i) < 0.5 : this.lampLit(i) > 0.5));
        this.portersLit[mode] = day;
        this.portersSince[mode] = -1;
        // one man per platform, each out of his platform's door
        for (const pid of [1, 2] as const) {
          const o = this.S.origin(`door:station:p${pid}`) ?? this.S.origin('door:station:east');
          const P = this.ctx.layout.platforms[pid];
          const mine = todo.filter((i) => { const lp = lamps[i]?.pos; if (!lp) return false; const o1 = this.ctx.layout.platforms[pid === 1 ? 2 : 1]; return lp.distanceToSquared(P.center) <= lp.distanceToSquared(o1.center); });
          const p = mine.length && o ? this.emergeFrom(o, 'lamplighter', { pool: false, fixed: true, force: true }) : null;
          if (!p || !o) continue;
          p.originId = o.id; p.home = undefined;
          this.S.addAcc(p, 'poleCarry');
          const steps = this.lampSteps(lamps, mine, o.pos(new THREE.Vector3()), on, true);
          this.S.runScript(p, steps, (q) => { void this.S.dismiss(q, { to: o.id, state: 'back to the booking hall' }); });
        }
      } else if (porters.length) {
        this.portersSince[mode] = -1;
        this.portersLit[mode] = day;
        const plat = lamps.filter((l) => l.group === 'platform').map((l) => l.index);
        const P1 = this.ctx.layout.platforms[1];
        const a = plat.filter((i) => Math.abs(lamps[i].pos.z - P1.center.z) < 6 && lamps[i].pos.x > P1.center.x - 60);
        const b = plat.filter((i) => !a.includes(i));
        const jobs = porters.length >= 2 ? [a, b] : [plat];
        jobs.forEach((ids, k) => {
          const por = porters[k];
          if (!por || !ids.length) return;
          por.data.busy = true;
          this.S.removeAcc(por, 'trolley');
          por.idle = null; por.manualAnim = null;
          const steps = this.lampSteps(lamps, ids, por.pos, on, true);
          this.S.runScript(por, steps, (q) => {
            q.data.busy = false;
            const home = q.data.home as THREE.Vector3 | undefined;
            if (home) this.S.go(q, home, () => { q.state = 'idle'; q.faceYaw = (q.data.homeYaw as number) ?? q.faceYaw; });
          });
        });
      }
    }
  }

  private worldManual(): boolean { try { return this.ctx.reg.world?.manualLamps !== false; } catch { return true; } }

  // ───────────────────────── warm start ─────────────────────────
  warmStart() {
    this.updateSlots(true);
    // a few townsfolk already about: gossips in the squares, strollers
    const h = this.ctx.clock.hour;
    const n = Math.round(this.cap * this.activity(h) * this.weatherF() * 0.7);
    for (let i = 0; i < n; i++) {
      if (!this.S.roomFor(2)) break;
      const home = this.pickHome();
      if (!home) break;
      const t = this.townRec(home.town);
      if (!t.meet.length) continue;
      const spot = this.near(this.rng.pick(t.meet), 7);
      const p = this.S.spawnRaw('townsfolk', spot, 'town');
      p.home = home.b.id; p.originId = home.o.id;
      this.ctx.origins.pools.take(home.b.id, 1);
      this.casual.add(p);
      this.script(p, [{ k: 'wander', center: spot, r: 6, min: this.rng.range(5, 30), state: 'taking the air', idle: this.rng.chance(0.4) ? 'chat' : 'watch' }]);
    }
  }

  private onHour() {
    const c = this.ctx.clock;
    if (c.day !== this.lastDay) {
      this.lastDay = c.day;
      // stray washing from yesterday comes in overnight
      if (c.weekday !== 0) { for (const id of this.washed) this.setWashing(id, 0); this.washed.clear(); }
    }
    // 23:00 closing time: everyone out of the pubs
    if (Math.floor(c.hour) === 23) {
      for (const it of [...this.indoors]) if (/^in The|^in the/.test(it.p.state) && it.p.role === 'drinker') it.until = Math.min(it.until, c.minutes + this.rng.range(0, 6));
    }
  }

  // ───────────────────────── tick ─────────────────────────
  update(dtm: number, dtSim: number) {
    if (dtSim <= 0) return;
    const now = this.now();
    // people inside buildings come back out when their time is up
    for (let i = this.indoors.length - 1; i >= 0; i--) {
      const it = this.indoors[i];
      if (!it.p.alive) { this.indoors.splice(i, 1); continue; }
      if (now >= it.until) {
        this.indoors.splice(i, 1);
        this.S.reemerge(it.p);
        const then = it.then, p = it.p;
        p.onArrive = () => then(p);
      }
    }
    // casual trips
    const h = this.ctx.clock.hour;
    const target = this.cap * this.activity(h) * this.weatherF();
    this.tripAcc += dtSim;
    let guard = 0;
    while (this.tripAcc >= 1.2 && guard++ < 3) {
      this.tripAcc -= 1.2;
      if (this.casual.size >= target || !this.S.roomFor(4)) continue;
      this.startTrip();
    }
    if (this.tripAcc > 4) this.tripAcc = 4;
    this.updateSlots();
    this.updateSchool();
    this.updateLamps();
    void dtm;
  }
}
