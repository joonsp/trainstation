import * as THREE from 'three';
import type { PlatformId } from '../core/types';
import type { PersonRole, TrainInfo } from '../core/apis';
import type { PeopleSystem } from './system';
import { yawTo } from './system';
import type { Person, Step } from './types';

/*
 * STATION STAFF (v2): everyone comes to work through a door and goes home through one.
 *   - stationmaster: station house (booking-hall east door), 05:45–22:30; attends trains, patrols, sees them off
 *   - booking clerk: Station Terrace, 05:30–22:30, sells tickets at the booking office
 *   - porters: Station Terrace, shifts 05:30–14:00 (2), 14:00–22:00 (2), night (1); luggage, platform lamps
 *   - signalmen: Station Terrace ↔ signal box, shift changes at 05:30 / 14:00 / 22:00 (always one in the box)
 *   - fitters: Station Terrace / Coldharbour → engine shed, 06:00–18:00 (2) + night (1); pop out to the yard
 *   - platelayers: from their hut at 07:00, walk the coast line east, stepping clear of trains, home 15:30
 *   - newsboy: 06:20–20:30 at the station entrance; constable: Police House, beat 07:00–22:00
 *   - guards step out of (and back into) their train's van door
 */

type Duty = 'stationmaster' | 'clerk' | 'porter' | 'signalman' | 'fitter' | 'platelayer' | 'newsboy' | 'constable';

interface Post { duty: Duty; role: PersonRole; count: (h: number, wd: number) => number; home: () => string | null }

const _v = new THREE.Vector3();

export class Staff {
  clerk: Person | null = null;
  stationmaster: Person | null = null;
  private roster = new Map<Duty, Person[]>();
  private guards = new Map<string, Person>();
  private posts: Post[];
  private rosterAt = -999;
  private terrace: string[] = [];
  private unsubs: (() => void)[] = [];
  private clerkPos: THREE.Vector3;
  private clerkYaw: number;
  private hutDoor: string | null = null;
  private policeDoor: string | null = null;
  private farmDoor: string | null = null;
  private porterHomes: { plat: PlatformId; pos: THREE.Vector3; yaw: number }[] = [];

  constructor(private S: PeopleSystem) {
    const ctx = S.ctx, L = ctx.layout;
    const bid = (pred: (b: typeof L.buildings[number]) => boolean) => L.buildings.find(pred)?.id;
    const terraceB = bid((b) => b.town === 'station' && b.kind === 'terrace');
    if (terraceB) for (const o of ctx.origins.list({ kind: 'door' })) if (o.building === terraceB) this.terrace.push(o.id);
    if (!this.terrace.length) this.terrace.push('door:station:east');
    const hut = L.landmarks?.platelayersHut?.id ?? bid((b) => b.kind === 'hut');
    if (hut) this.hutDoor = `door:${hut}:0`;
    const police = bid((b) => b.kind === 'police');
    if (police) this.policeDoor = `door:${police}:0`;
    const farm = bid((b) => b.town === 'coldharbour' && b.kind === 'farmhouse');
    if (farm) this.farmDoor = `door:${farm}:0`;
    const b = L.bookingOffice;
    const hall = (L.nav.nodes.hall ?? b).clone();
    const towardHall = hall.clone().sub(b).setY(0).normalize();
    this.clerkPos = b.clone().addScaledVector(towardHall, 1.1);
    this.clerkYaw = yawTo(-towardHall.x, -towardHall.z);
    for (const plat of [1, 2] as PlatformId[]) {
      const P = L.platforms[plat];
      const door = (plat === 1 ? L.nav.nodes.p1Door : L.nav.nodes.p2Door) ?? P.center;
      const ax = new THREE.Vector3(Math.cos(P.yaw), 0, -Math.sin(P.yaw));
      for (const off of [5, -9]) this.porterHomes.push({ plat, pos: door.clone().addScaledVector(P.inward, 1.2).addScaledVector(ax, off).setY(P.center.y), yaw: yawTo(-P.inward.x, -P.inward.z) });
    }
    const T = () => S.rng.pick(this.terrace);
    const day = (a: number, b: number) => (h: number) => (h >= a && h < b ? 1 : 0);
    this.posts = [
      { duty: 'stationmaster', role: 'stationmaster', count: day(5.75, 22.5), home: () => 'door:station:east' },
      { duty: 'clerk', role: 'clerk', count: day(5.5, 22.5), home: T },
      { duty: 'porter', role: 'porter', count: (h) => (h >= 5.5 && h < 22 ? 2 : 1), home: T },
      { duty: 'fitter', role: 'mechanic', count: (h) => (h >= 6 && h < 18 ? 2 : 1), home: () => (S.rng.chance(0.4) && this.farmDoor ? this.farmDoor : T()) },
      { duty: 'platelayer', role: 'platelayer', count: (h, wd) => (wd < 6 && h >= 7 && h < 15.5 ? 3 : 0), home: () => this.hutDoor },
      { duty: 'newsboy', role: 'newsboy', count: day(6.33, 20.5), home: T },
      { duty: 'constable', role: 'constable', count: day(7, 22), home: () => this.policeDoor },
    ];
    for (const p of this.posts) this.roster.set(p.duty, []);
    this.roster.set('signalman', []);
    this.unsubs.push(
      ctx.bus.on('train:arrived', (e) => this.onTrainArrived(e.trainId, e.platform)),
      ctx.bus.on('train:departing', (e) => this.onTrainDeparting(e.trainId)),
      ctx.bus.on('train:departed', (e) => this.onTrainGone(e.trainId)),
      ctx.bus.on('train:despawned', (e) => this.onTrainGone(e.trainId)),
    );
  }

  private get ctx() { return this.S.ctx; }
  private get rng() { return this.S.rng; }

  onRemoved(p: Person) {
    for (const [, arr] of this.roster) { const i = arr.indexOf(p); if (i >= 0) arr.splice(i, 1); }
    if (p === this.clerk) this.clerk = null;
    if (p === this.stationmaster) this.stationmaster = null;
    for (const [k, g] of this.guards) if (g === p) this.guards.delete(k);
  }

  // ───────────────────────── roster ─────────────────────────
  warmStart() {
    const h = this.ctx.clock.hour, wd = this.ctx.clock.weekday;
    for (const post of this.posts) {
      const n = post.count(h, wd);
      for (let i = 0; i < n; i++) {
        if (post.duty === 'platelayer' || post.duty === 'constable') continue; // they're out on their rounds: start from doors
        const p = this.S.spawnRaw(post.role, this.postPos(post.duty, i), 'staff');
        p.originId = post.home() ?? undefined;
        this.enlist(post.duty, p, true);
      }
    }
  }

  private postPos(d: Duty, i: number): THREE.Vector3 {
    const L = this.ctx.layout;
    switch (d) {
      case 'stationmaster': return (L.nav.nodes.p1Door ?? L.platforms[1].center).clone();
      case 'clerk': return this.clerkPos.clone();
      case 'porter': return this.porterHomes[i % this.porterHomes.length].pos.clone();
      case 'fitter': return L.shed.workerSpot.clone();
      case 'newsboy': return this.newsSpot();
      default: return L.entrance.clone();
    }
  }

  private newsSpot(): THREE.Vector3 {
    const L = this.ctx.layout;
    const qDir = (L.nav.nodes.steps ?? L.entrance).clone().sub(L.bookingOffice).setY(0).normalize();
    const side = new THREE.Vector3(-qDir.z, 0, qDir.x);
    return L.entrance.clone().addScaledVector(qDir, -4.5).addScaledVector(side, 5.5);
  }

  private enlist(duty: Duty, p: Person, warm = false) {
    this.roster.get(duty)!.push(p);
    p.data.duty = duty;
    if (duty === 'stationmaster') { this.stationmaster = p; p.state = 'patrolling'; }
    else if (duty === 'clerk') {
      this.clerk = p;
      const at = () => { p.state = 'selling tickets'; p.faceYaw = this.clerkYaw; p.idle = 'work'; };
      if (warm) { p.pos.copy(this.clerkPos); at(); } else this.S.go(p, this.clerkPos.clone(), at, { staff: true });
    } else if (duty === 'porter') {
      const idx = this.roster.get('porter')!.length - 1;
      const home = this.porterHomes[idx % this.porterHomes.length];
      p.data.home = home.pos; p.data.plat = home.plat; p.data.homeYaw = home.yaw;
      const at = () => { p.state = 'idle'; p.faceYaw = home.yaw; };
      if (warm) { p.pos.copy(home.pos); at(); } else { p.state = 'coming on duty'; this.S.go(p, home.pos.clone(), at, { staff: true }); }
    } else if (duty === 'fitter') {
      if (warm) { this.S.enter(p, 'door:shed', { keep: true, state: 'in the shed' }); p.pos.copy(this.ctx.layout.shed.workerSpot); p.fade = 0; p.path = []; p.onArrive = null; p.data.indoorsOf = 'door:shed'; p.state = 'in the shed'; }
      else this.S.enter(p, 'door:shed', { keep: true, state: 'walking to the shed', then: () => { p.state = 'in the shed'; } });
      p.data.yardAt = this.ctx.clock.minutes + this.rng.range(20, 80);
    } else if (duty === 'newsboy') {
      this.S.addAcc(p, 'papers');
      const spot = this.newsSpot();
      const at = () => { p.state = 'selling newspapers'; p.faceYaw = this.rng.range(-3, 3); };
      if (warm) { p.pos.copy(spot); at(); } else { p.state = 'setting up'; this.S.go(p, spot, at); }
    } else if (duty === 'platelayer') {
      this.S.runScript(p, this.trackWalk(p));
    } else if (duty === 'constable') {
      this.S.runScript(p, this.beat());
    }
  }

  private updateRoster() {
    const now = this.ctx.clock.minutes;
    if (now - this.rosterAt < 1) return;
    this.rosterAt = now;
    const h = this.ctx.clock.hour, wd = this.ctx.clock.weekday;
    for (const post of this.posts) {
      const arr = this.roster.get(post.duty)!;
      const want = post.count(h, wd);
      const live = arr.filter((p) => !p.data.offDuty);
      if (live.length < want) {
        const home = post.home();
        if (!home) continue;
        const p = this.S.emerge(home, post.role, 'staff', undefined, { force: true });
        if (p) { p.originId = home; this.enlist(post.duty, p); }
      } else if (live.length > want) {
        const p = live.find((q) => !q.data.busy && !q.data.scripted) ?? null;
        if (p) this.sendHome(p);
      }
    }
    // signal box: exactly one signalman inside; shift change at 05:30, 14:00, 22:00
    const sm = this.roster.get('signalman')!;
    const shift = h >= 5.5 && h < 14 ? 0 : h >= 14 && h < 22 ? 1 : 2;
    if (!sm.length) {
      const p = this.S.spawnRaw('signalman', this.ctx.layout.landmarks?.signalBoxDoor ?? this.ctx.layout.entrance, 'staff');
      p.fade = 0; p.data.indoorsOf = 'door:signalbox'; p.state = 'in the signal box'; p.data.shift = shift; p.data.duty = 'signalman';
      p.originId = this.rng.pick(this.terrace);
      sm.push(p);
    } else if (sm.length === 1 && sm[0].data.shift !== shift && !sm[0].data.relief) {
      const old = sm[0];
      old.data.relief = true;
      const home = this.rng.pick(this.terrace);
      const np = this.S.emerge(home, 'signalman', 'staff', undefined, { force: true });
      if (np) {
        np.data.duty = 'signalman'; np.data.shift = shift; np.originId = home;
        sm.push(np);
        this.S.enter(np, 'door:signalbox', { keep: true, state: 'relieving the signalman', then: () => {
          np.state = 'in the signal box';
          // the old hand comes out and walks home
          if (old.alive && old.data.indoorsOf) {
            this.S.reemerge(old);
            old.state = 'going home';
            old.data.offDuty = true;
            const i = sm.indexOf(old); if (i >= 0) sm.splice(i, 1);
            void this.S.dismiss(old, { state: 'going home' });
          }
        } });
      }
    }
  }

  private sendHome(p: Person) {
    p.data.offDuty = true;
    p.script = null;
    p.manualAnim = null; p.idle = null;
    this.S.clearTempProps(p);
    if (p.data.indoorsOf) this.S.reemerge(p);
    const home = p.originId && p.originId !== 'door:shed' ? p.originId : this.rng.pick(this.terrace);
    const run = () => { void this.S.dismiss(p, { to: home, state: 'going home' }); };
    if (p.data.indoorsOf === undefined && p.fadeLeg) { const f = p.onArrive; p.onArrive = () => { f?.(); run(); }; } else run();
  }

  // ───────────────────────── scripted rounds ─────────────────────────
  private trackWalk(p: Person): Step[] {
    const L = this.ctx.layout;
    const line = L.lines.coast;
    const steps: Step[] = [];
    const side = 3.6; // cess on the south side of the coast line
    const xs = [132, 150, 172, 196, 214, 236, 250];
    const k = this.roster.get('platelayer')!.length;
    for (const x of xs) {
      const t = line.nearestT(new THREE.Vector3(x + k * 2.2, 0, 24));
      const pt = line.offsetPoint(t, side + (k % 2) * 0.8, 0);
      pt.y = L.heightAt(pt.x, pt.z);
      steps.push({ k: 'go', to: pt, direct: true, state: 'walking the length' });
      steps.push({ k: 'face', yaw: yawTo(0, -1) });
      const anim = k % 3 === 0 ? 'hammer' : k % 3 === 1 ? 'shovel' : 'work';
      steps.push({ k: 'do', anim, props: anim === 'hammer' ? ['hammer'] : ['pitchfork'], min: this.rng.range(12, 30), state: 'keying up the chairs', tick: (q) => this.clearOfTrains(q) });
    }
    steps.push({ k: 'call', fn: (q) => { void this.S.dismiss(q, { to: this.hutDoor ?? undefined, state: 'back to the hut' }); } });
    // start in the hut yard
    return [{ k: 'go', to: line.offsetPoint(line.nearestT(new THREE.Vector3(190, 0, 24)), side, 0), direct: false }, ...steps];
  }

  /** platelayers step clear when a train is near (coast line) */
  private clearOfTrains(p: Person) {
    const trains = this.ctx.reg.trains;
    if (!trains) return;
    const line = this.ctx.layout.lines.coast;
    const t = line.nearestT(p.pos);
    let near = false;
    try { near = trains.occupied('coast', Math.max(0, t - 0.12), Math.min(1, t + 0.12)); } catch { near = false; }
    if (!near) { try { const e = trains.eta('coast', t, 40); near = !!e && e.seconds < 25; } catch { near = false; } }
    if (near && !p.data.stoodClear) {
      p.data.stoodClear = true;
      const away = line.offsetPoint(t, 6.5, 0);
      away.y = this.ctx.layout.heightAt(away.x, away.z);
      p.manualAnim = null; p.idle = 'watch';
      p.lookTrain = trains.list().find((x) => x.line === 'coast')?.id ?? null;
      p.lookUntil = this.S.vt + 8;
      this.S.go(p, away, () => { p.faceYaw = yawTo(0, -1); }, { direct: true });
    } else if (!near && p.data.stoodClear && p.pathIdx >= p.path.length) {
      p.data.stoodClear = false;
      p.idle = null;
      const back = line.offsetPoint(t, 3.6, 0);
      back.y = this.ctx.layout.heightAt(back.x, back.z);
      this.S.go(p, back, () => { p.manualAnim = 'hammer'; }, { direct: true });
    }
  }

  private beat(): Step[] {
    const L = this.ctx.layout;
    const F = L.forecourt;
    const pub = L.buildings.find((b) => b.town === 'station' && b.kind === 'pub');
    const pubPt = pub ? pub.doors[0].clone().add(new THREE.Vector3(2, 0, 2)) : L.entrance.clone();
    const sq = L.towns.find((t) => t.id === 'ashcombe')?.areas.find((a) => a.kind === 'square')?.center.clone() ?? L.entrance.clone();
    const steps: Step[] = [];
    for (let lap = 0; lap < 4; lap++) {
      steps.push({ k: 'go', to: sq.clone().add(new THREE.Vector3(this.rng.range(-4, 4), 0, this.rng.range(-4, 4))), state: 'on his beat' });
      steps.push({ k: 'do', idle: 'watch', min: this.rng.range(6, 14), state: 'keeping an eye on the square' });
      steps.push({ k: 'go', to: pubPt, state: 'on his beat' });
      steps.push({ k: 'do', idle: 'watch', min: this.rng.range(4, 10), state: 'outside the Railway Arms' });
      const fc = F.center.clone().add(new THREE.Vector3(Math.sin(F.yaw) * 7, 0, Math.cos(F.yaw) * 7));
      steps.push({ k: 'go', to: fc, state: 'on his beat' });
      steps.push({ k: 'do', idle: 'watch', min: this.rng.range(8, 16), state: 'watching the forecourt' });
    }
    steps.push({ k: 'call', fn: (q) => { void this.S.dismiss(q, { to: this.policeDoor ?? undefined, state: 'back to the Police House' }); } });
    return steps;
  }

  // ───────────────────────── train duties ─────────────────────────
  private onTrainArrived(trainId: string, platform: PlatformId) {
    const t = this.ctx.reg.trains?.get(trainId);
    if (!t || t.kind === 'freight' || t.ghost) return;
    this.sendPorter(t, platform);
    this.spawnGuard(t, platform);
    this.stationmasterAttend(t, platform);
  }

  private stationmasterAttend(t: TrainInfo, plat: PlatformId) {
    const sm = this.stationmaster;
    if (!sm || !sm.alive || sm.kind !== 'staff' || sm.data.playing || sm.data.offDuty || sm.data.scripted) return;
    const L = this.ctx.layout;
    const line = L.lines[t.line];
    const P = L.platforms[plat];
    const mid = (line.platformStartT + line.platformEndT) / 2;
    const spot = P.edgePointAt(mid + this.rng.range(-0.01, 0.01)).addScaledVector(P.inward, 2.2);
    sm.data.attending = t.id;
    sm.state = 'attending train';
    sm.wait = 0; sm.onWait = null;
    const far = sm.pos.distanceTo(spot) > 45;
    this.S.go(sm, spot, () => { sm.faceYaw = yawTo(-P.inward.x, -P.inward.z); }, { run: far });
  }

  private onTrainDeparting(trainId: string) {
    const sm = this.stationmaster;
    if (sm && sm.alive && sm.kind === 'staff' && sm.data.attending === trainId) {
      this.S.stop(sm);
      sm.manualAnim = 'play';
      sm.data.playing = true;
      sm.state = 'signalling departure';
      this.S.sleep(sm, 4, () => { sm.manualAnim = null; sm.data.playing = false; sm.data.attending = null; sm.state = 'patrolling'; });
    }
    const g = this.guards.get(trainId);
    if (g && g.alive) {
      g.manualAnim = 'play';
      g.state = 'waving flag';
      g.faceYaw = (g.data.faceHead as number) ?? g.yaw;
      this.S.sleep(g, 1.2, () => this.guardStepIn(g, trainId));
    }
  }

  private guardStepIn(g: Person, trainId: string) {
    if (!g.alive) return;
    g.manualAnim = null;
    const door = g.data.door as THREE.Vector3;
    g.state = 'stepping aboard';
    g.fadeLeg = { from: g.pos.clone(), len: Math.max(0.3, g.pos.distanceTo(door)), dir: 'in' };
    this.S.go(g, door.clone(), () => { this.guards.delete(trainId); this.S.removeAt(g, door, `guard ${trainId}`); }, { direct: true, speed: 2.2 });
  }

  private onTrainGone(trainId: string) {
    const g = this.guards.get(trainId);
    if (g && g.alive && g.state !== 'stepping aboard') {
      // left behind (should not happen): walk into the station building
      this.guards.delete(trainId);
      g.manualAnim = null;
      const P = this.ctx.layout.platforms[(g.data.plat as PlatformId) ?? 1];
      void this.S.dismiss(g, { to: P.id === 2 ? 'door:station:p2' : 'door:station:p1', state: 'left behind!' });
    }
    if (this.stationmaster?.data.attending === trainId && !this.stationmaster.data.playing) this.stationmaster.data.attending = null;
  }

  private spawnGuard(t: TrainInfo, plat: PlatformId) {
    if (this.guards.has(t.id)) return;
    let doors: THREE.Vector3[] = [];
    try { doors = this.ctx.reg.trains.getDoors(t.id) ?? []; } catch { doors = []; }
    if (!doors.length) return;
    const P = this.ctx.layout.platforms[plat];
    // rear door = farthest from the loco head
    let rear: THREE.Vector3 | null = null, bd = -1;
    for (const d of doors) { const dd = d.distanceToSquared(t.position); if (dd > bd) { bd = dd; rear = d; } }
    if (!rear) return;
    const door = rear.clone();
    {
      // the guard's van door stays a legitimate origin until the train has pulled out (the train's own door
      // origins close with the doors, a moment before the guard hops aboard)
      const id = t.id;
      const rem = this.ctx.origins.add({ id: `train:${id}:guard`, kind: 'train', owner: 'people', radius: 2.6, for: ['people'], pos: (o) => o.copy(door),
        open: () => { const tr = this.ctx.reg.trains?.get(id); return !!tr && tr.speed < 6 && tr.position.distanceTo(door) < (tr.length || 60) + 20; } });
      const off2 = this.ctx.bus.on('train:despawned', (e) => { if (e.trainId === id) { rem(); off(); off2(); } });
      const off = this.ctx.bus.on('train:departed', (e) => { if (e.trainId === id) { setTimeout(rem, 0); off(); off2(); } });
    }
    const start = door.clone().addScaledVector(P.inward, -0.3);
    const g = this.S.spawnRaw('guard', start, 'guard');
    this.S.auditAt('spawn', door, `guard ${t.id}`);
    g.fade = 0; g.fadeLeg = { from: start.clone(), len: 0.6, dir: 'out' };
    g.state = 'on duty';
    g.data.door = door;
    g.data.plat = plat;
    const toHead = yawTo(t.position.x - door.x, t.position.z - door.z);
    g.data.faceHead = toHead;
    g.yaw = toHead;
    this.S.go(g, door.clone().addScaledVector(P.inward, 1.1), () => { g.faceYaw = toHead; }, { direct: true });
    this.guards.set(t.id, g);
  }

  private sendPorter(t: TrainInfo, plat: PlatformId) {
    const free = (this.roster.get('porter') ?? []).filter((p) => p.alive && !p.data.busy && !p.data.offDuty && !p.data.scripted && !p.script && p.fade > 0.9);
    if (!free.length) return;
    const por = free.find((p) => p.data.plat === plat) ?? free[0];
    let doors: THREE.Vector3[] = [];
    try { doors = this.ctx.reg.trains.getDoors(t.id) ?? []; } catch { doors = []; }
    if (!doors.length) return;
    const P = this.ctx.layout.platforms[plat];
    const door = doors[doors.length - 1];
    const spot = door.clone().addScaledVector(P.inward, 1.8);
    por.data.busy = true;
    por.state = 'fetching luggage';
    por.wait = 0; por.onWait = null;
    this.S.go(por, spot, () => {
      por.faceYaw = yawTo(-P.inward.x, -P.inward.z);
      por.manualAnim = 'work';
      por.state = 'loading luggage';
      this.S.addAcc(por, 'trolley');
      this.S.sleep(por, this.rng.range(6, 12), () => {
        por.manualAnim = null;
        const toCab = this.rng.chance(0.5);
        por.state = toCab ? 'wheeling luggage to the cab rank' : 'returning';
        const back = () => this.S.go(por, por.data.home as THREE.Vector3, () => { por.data.busy = false; por.state = 'idle'; this.S.removeAcc(por, 'trolley'); por.faceYaw = por.data.homeYaw as number; });
        if (toCab) {
          const q = this.ctx.layout.forecourtTraffic?.cabQueue ?? this.ctx.layout.entrance;
          this.S.go(por, q.clone(), () => { por.manualAnim = 'work'; this.S.sleep(por, 3, () => { por.manualAnim = null; por.state = 'returning'; back(); }); });
        } else back();
      });
    });
  }

  // ───────────────────────── per-person update ─────────────────────────
  updateStaff(p: Person, dtm: number) {
    if (p.data.scripted || p.data.offDuty) return;
    const duty = p.data.duty as Duty | undefined;
    if ((p.data.scriptHold as number) > 0) { p.data.scriptHold = (p.data.scriptHold as number) - dtm; return; }
    if (duty === 'newsboy') {
      if (p.pathIdx < p.path.length || p.wait > 0) return;
      p.data.cry = ((p.data.cry as number) ?? 0) - dtm;
      if ((p.data.cry as number) <= 0) {
        p.data.cry = this.rng.range(6, 14);
        p.manualAnim = 'wave';
        p.state = '"Extra! Extra!"';
        this.ctx.bus.emit('audio:cue', { cue: 'shout', pos: p.pos, volume: 0.25 });
        this.S.sleep(p, 2.2, () => { p.manualAnim = null; p.state = 'selling newspapers'; p.faceYaw = this.rng.range(-3, 3); });
      }
      return;
    }
    if (duty === 'stationmaster') {
      if (p.pathIdx < p.path.length || p.wait > 0 || p.data.playing) return;
      const att = p.data.attending as string | null | undefined;
      if (att) {
        const t = this.ctx.reg.trains.get(att);
        if (t && t.state === 'dwelling') return;
        p.data.attending = null;
      }
      const L = this.ctx.layout;
      const r = this.rng.next();
      let target: THREE.Vector3;
      if (r < 0.4) target = this.platformPoint(1, 42, -1.5, 1.5);
      else if (r < 0.8) target = this.platformPoint(2, 42, -1.5, 1.5);
      else {
        const F = L.forecourt;
        const ax = _v.set(Math.cos(F.yaw), 0, -Math.sin(F.yaw));
        target = F.center.clone().addScaledVector(ax, this.rng.range(-7, 7));
        const lat = this.rng.range(4.5, 8);
        target.x += Math.sin(F.yaw) * lat;
        target.z += Math.cos(F.yaw) * lat;
      }
      p.state = 'patrolling';
      this.S.go(p, target, () => {
        p.faceYaw = this.rng.range(-Math.PI, Math.PI);
        p.state = 'surveying the station';
        this.S.sleep(p, this.rng.range(8, 22), () => {});
      });
      return;
    }
    if (duty === 'porter') {
      if (p.data.busy || p.pathIdx < p.path.length || p.wait > 0 || p.script) return;
      if (this.rng.chance(dtm * 0.014)) {
        const plat = p.data.plat as PlatformId;
        const tgt = this.platformPoint(plat, 35, -0.5, 1.5);
        const sweep = this.rng.chance(0.45);
        p.state = sweep ? 'sweeping the platform' : 'tidying the platform';
        this.S.go(p, tgt, () => {
          if (sweep) { this.S.setTempProps(p, ['broom']); p.manualAnim = 'sweep'; }
          this.S.sleep(p, this.rng.range(5, 12), () => {
            p.manualAnim = null; this.S.clearTempProps(p);
            this.S.go(p, p.data.home as THREE.Vector3, () => { p.state = 'idle'; p.faceYaw = p.data.homeYaw as number; });
          });
        });
      }
      return;
    }
    if (duty === 'fitter') {
      // pops out of the shed to the water tower / coal stage / turntable now and then
      if (p.data.indoorsOf && this.ctx.clock.minutes > (p.data.yardAt as number)) {
        p.data.yardAt = this.ctx.clock.minutes + this.rng.range(40, 120);
        const L = this.ctx.layout;
        const spots = [L.shed.waterTower, L.shed.coalStage, L.shed.turntable];
        const s = this.rng.pick(spots).clone().add(new THREE.Vector3(this.rng.range(-2.5, 2.5), 0, 3.2));
        s.y = L.heightAt(s.x, s.z);
        this.S.reemerge(p);
        this.S.runScript(p, [
          { k: 'go', to: s, staff: true, state: 'off to the yard' },
          { k: 'do', anim: this.rng.chance(0.5) ? 'hammer' : 'work', props: ['hammer'], min: this.rng.range(8, 20), state: 'working in the yard' },
          { k: 'call', fn: (q) => { this.S.enter(q, 'door:shed', { keep: true, state: 'back to the shed', then: () => { q.state = 'in the shed'; } }); } },
        ]);
      }
    }
  }

  private platformPoint(plat: PlatformId, alongMax: number, latMin: number, latMax: number): THREE.Vector3 {
    const P = this.ctx.layout.platforms[plat];
    const along = this.rng.range(-alongMax, alongMax);
    const lat = this.rng.range(latMin, latMax);
    const ax = Math.cos(P.yaw), az = -Math.sin(P.yaw);
    return new THREE.Vector3(P.center.x + ax * along + P.inward.x * lat, P.center.y, P.center.z + az * along + P.inward.z * lat);
  }

  /** porters on duty (the town lamplighter hands platform lamps to them) */
  porters(): Person[] { return (this.roster.get('porter') ?? []).filter((p) => p.alive && !p.data.offDuty && !p.data.busy && !p.data.scripted); }

  update(_dtm: number, _dtSim: number) {
    this.updateRoster();
  }
}
