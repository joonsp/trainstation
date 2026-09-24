import * as THREE from 'three';
import type { Dir, PlatformId } from '../../core/types';
import { Scripted, NAMES_F, NAMES_M, alongOf, node, onPlatform, type EventDef, type EventEnv } from '../base';
import type { Script } from '../runner';
import { buildArch, buildBunting, buildCarpet, musicStandGeometry } from '../props';
import { InstProps, confettiBurst, worldPerPixel } from '../fx';
import { doorNear } from './animals';

const hr = (e: EventEnv) => e.ctx.clock.hour;
const wx = (e: EventEnv) => e.ctx.reg.atmosphere?.weather ?? 'clear';
const wet = (e: EventEnv) => ['rain', 'storm', 'snow'].includes(wx(e));

// ═════════════════════════ 3. ROYAL VISIT ═════════════════════════
// v2: Her Majesty steps out of the royal saloon door (a train-door origin), inspects the guard of honour, and — if
// the royal carriage-and-four from the Crown Mews has drawn up in time — drives off to Ashcombe; otherwise she
// returns to her saloon. Well-wishers and the Stationmaster come and go through proper origins.
class RoyalEvent extends Scripted {
  maxDuration = 320;
  *script(): Script {
    const { ctx, rng } = this;
    const pid: PlatformId = 1;
    const P = ctx.layout.platforms[pid];
    const L = ctx.layout.lines[P.line];
    const dir: Dir = rng.pick(['east', 'west'] as Dir[]);

    const poles: THREE.Vector3[] = [];
    for (let a = -35; a <= 35; a += 10) poles.push(onPlatform(ctx, pid, a, 8.3, 1.0));
    this.decorate(buildBunting(poles, 3.3));
    const poles2: THREE.Vector3[] = [];
    for (let a = -25; a <= 25; a += 12.5) poles2.push(onPlatform(ctx, pid, a, 2.3, 1.0));
    this.decorate(buildBunting(poles2, 2.9, [0x3a2a5a, 0xd9b95a, 0xe8dcc0]));

    const door = node(ctx, 'p1Door');
    door.y = 1.0;
    const tt = L.nearestT(door);
    const edge = P.edgePointAt(tt);
    edge.y = 1.0;
    this.decorate(buildCarpet(door, edge, 1.7));
    const axis = edge.clone().sub(door).setY(0);
    const len = axis.length();
    axis.normalize();
    const perp = new THREE.Vector3(-axis.z, 0, axis.x);

    let trainId = '';
    try {
      trainId = ctx.reg.trains.spawnSpecial({ special: 'royal', line: P.line, dir, stops: true, dwellMin: 20, name: 'The Royal Train',
        cars: ['loco_express', 'tender', 'royal_saloon', 'royal_saloon', 'coach_first', 'guard'] });
    } catch { trainId = ''; }
    let arrived = false, departed = false;
    this.on('train:arrived', (e) => { if (e.trainId === trainId) arrived = true; });
    this.on('train:departed', (e) => { if (e.trainId === trainId) departed = true; });
    this.on('train:despawned', (e) => { if (e.trainId === trainId) departed = true; });
    // the royal carriage sets out from the Crown Mews to meet the train
    const coach = this.requestVehicle({ kind: 'carriage4', to: 'forecourt:drop', wait: 120, decor: 'royal', then: 'E1', tag: 'royal' });

    this.gazette(rng.pick([
      'BY ROYAL COMMAND: Her Majesty\'s Train to call at the Junction this day. The platform is dressed in bunting and red carpet laid.',
      'ROYAL VISIT! Loyal subjects throng the Down platform in anticipation of Her Majesty',
    ]));
    ctx.bus.emit('town:bell', { kind: 'peal', town: 'ashcombe' });
    try { ctx.reg.people.density *= 1.4; this.onCleanup(() => { ctx.reg.people.density /= 1.4; }); } catch { /* stub */ }

    const mid = door.clone().lerp(edge, 0.5);
    const guests = this.actors.crowd(12, mid.clone().addScaledVector(perp, 3), 'guest', 3);
    guests.forEach((id, i) => {
      const side = i % 2 ? 1 : -1;
      const u = 0.12 + 0.76 * ((Math.floor(i / 2) + 0.5) / Math.ceil(guests.length / 2));
      const spot = door.clone().addScaledVector(axis, u * len).addScaledVector(perp, side * (1.75 + rng.range(0, 0.5)));
      this.walk(id, spot, { direct: true });
    });
    const extra = this.actors.crowd(8, onPlatform(ctx, pid, 12, 6), 'passenger', 4);
    extra.forEach((id, i) => this.walk(id, onPlatform(ctx, pid, (i < 4 ? -1 : 1) * (6 + (i % 4) * 3.5), 6.8 + rng.range(-0.4, 0.4)), { direct: true }));
    const sm = this.actors.summon('stationmaster', edge.clone().addScaledVector(axis, -1.2).addScaledVector(perp, 1.2), { from: 'door:station:p1' });

    if (!trainId) { yield 12; this.gazette('Her Majesty\'s Train is unavoidably detained; the bunting is taken down with much sighing', 'info'); return; }
    yield { until: () => arrived, max: 120 };
    if (!arrived) return;

    this.cue('fanfare', edge, 1);
    this.cue('cheer', mid, 0.9);
    [...guests, ...extra].forEach((id) => this.actors.anim(id, 'cheer'));
    this.cueLoop('cheer', [6, 10], () => mid, 0.5);
    this.gazette('God Save the Queen! Her Majesty alights at the Junction and graciously inspects the Down platform');
    const vipAt = doorNear(ctx, trainId, edge) ?? edge.clone();
    vipAt.y = 1;
    const saloonDoor = this.actors.trainDoor(vipAt);
    const vip = this.actors.fromTrain('vip', vipAt);
    if (!vip) return;
    this.marker('VR', () => this.actors.at(vip), { lift: 2.3, bg: '#3a2a5a', fg: '#d9b95a' });
    if (sm) { this.actors.anim(sm, 'work'); this.actors.look(sm, vipAt); }
    yield this.walk(vip, edge, { direct: true, speed: 0.9 });
    yield this.walk(vip, door.clone().addScaledVector(axis, 1.2), { direct: true, speed: 0.8 });
    guests.forEach((id) => this.actors.look(id, door));
    yield 4;
    const carriageHere = () => { const v = this.vehicle(coach); return !!v && v.state !== 'driving' && v.stop === 'forecourt:drop'; };
    if (coach && (carriageHere() || this.vehicle(coach))) {
      // through the booking hall to the forecourt
      yield { until: carriageHere, max: 12 };
    }
    const anchor = coach && carriageHere() ? this.safe(() => ctx.reg.traffic.anchorOf(coach), null) : null;
    if (anchor) {
      if (sm) this.walk(sm, node(ctx, 'booking'));
      yield this.actors.embark([vip], anchor, 25);
      const vpid = this.actors.pid(vip);
      if (vpid && this.safe(() => ctx.reg.people.get(vpid)?.riding, undefined)) this.actors.release(vip);
      else this.actors.remove(vip);
      this.cue('fanfare', ctx.layout.forecourtTraffic.dropOff.pos, 0.9);
      this.cue('horse', ctx.layout.forecourtTraffic.dropOff.pos, 0.7);
      this.gazette('Her Majesty proceeds by carriage-and-four to Ashcombe, where the Mayor has been rehearsing his address since Tuesday');
      this.releaseVehicle(coach);
      yield 3;
    } else {
      if (coach) this.releaseVehicle(coach);
      if (sm) this.actors.anim(sm, 'idle');
      yield this.walk(vip, edge, { direct: true, speed: 0.8 });
      yield this.walk(vip, vipAt, { direct: true, speed: 0.9 });
      this.actors.remove(vip, saloonDoor ?? this.actors.trainDoor(vipAt) ?? undefined);
      this.cue('fanfare', edge, 0.8);
    }
    yield { until: () => departed, max: 45 };
    this.gazette('The Royal Train departs amid hearty cheers. The Stationmaster is said to have wept.');
    [...guests, ...extra].forEach((id) => this.actors.remove(id));
    if (sm) this.actors.remove(sm, 'door:station:p1');
    yield 6;
  }
}

// ═════════════════════════ 11. WEDDING PARTY ═════════════════════════
// v2: St Mary's bells ring; the newly-weds arrive by beribboned landau from the Crown Mews, their guests walk in,
// and the couple board the train through a real train door.
class WeddingEvent extends Scripted {
  maxDuration = 400;
  *script(): Script {
    const { ctx, rng } = this;
    let pid: PlatformId = rng.pick([1, 2] as PlatformId[]);
    try {
      const next = ctx.reg.trains.timetable(6).find((d) => d.status !== 'Departed' && d.status !== 'Cancelled' && d.time > this.now + 40);
      if (next) pid = next.platform;
    } catch { /* stub */ }
    const P = ctx.layout.platforms[pid];
    const door = node(ctx, `p${pid}Door`);
    const doorAlong = alongOf(ctx, pid, door);
    const arch = buildArch();
    arch.position.copy(onPlatform(ctx, pid, doorAlong + 7, 5.4));
    arch.rotation.y = P.yaw;
    this.decorate(arch);
    const dest = onPlatform(ctx, pid, doorAlong + 10, 5.2);
    const ent = ctx.layout.entrance.clone();
    const drop = ctx.layout.forecourtTraffic.dropOff.pos.clone();
    const groomName = rng.pick(NAMES_M), brideName = rng.pick(NAMES_F).replace(/^(Mrs\.|Lady|the Dowager Lady)/, 'Miss');
    this.gazette(`WEDDING BELLS: ${groomName} and ${brideName}, newly wed at St. Mary's, Ashcombe, set out for the Junction to depart upon their honeymoon`);
    ctx.bus.emit('town:bell', { kind: 'wedding', town: 'ashcombe' });

    const landau = this.requestVehicle({ kind: 'landau', to: 'forecourt:drop', riders: [{ role: 'bride' }, { role: 'groom' }], decor: 'wedding', wait: 4, tag: 'wedding' });
    const guests = this.actors.crowd(7, ent.clone().add(new THREE.Vector3(-6, 0, 4)), 'guest', 3);
    guests.forEach((id, i) => this.walk(id, drop.clone().add(new THREE.Vector3((i % 4) * 1.2 - 2, 0, 2 + Math.floor(i / 4) * 1.2))));
    let bride: string | null = null, groom: string | null = null;
    if (landau) {
      yield this.vehicleAt(landau, 'forecourt:drop', 150);
      const riders = this.alight(landau, 'bride', drop);
      bride = riders.find((id) => this.safe(() => ctx.reg.people.get(this.actors.pid(id) ?? '')?.role === 'bride', false)) ?? riders[0] ?? null;
      groom = riders.find((id) => id !== bride) ?? null;
    }
    if (!bride) bride = this.actors.summon('bride', drop, { from: 'door:station:terrace:0' });
    if (!groom) groom = this.actors.summon('groom', drop.clone().add(new THREE.Vector3(0.8, 0, 0)), { from: 'door:station:terrace:0' });
    if (!bride || !groom) return;
    const b = bride, g = groom;
    if (!landau) yield this.all([this.actors.arrived(b), this.actors.arrived(g)], 90);
    this.cue('chime', drop, 1);
    this.cue('cheer', drop, 0.8);
    confettiBurst(this.env.fx, this.actors.pos(b).clone(), 60);
    this.marker('♥', () => this.actors.at(b), { lift: 2.4, bg: '#f6e7ee', fg: '#9a2040' });
    const side = new THREE.Vector3(Math.cos(P.yaw + Math.PI / 2), 0, -Math.sin(P.yaw + Math.PI / 2));
    this.walk(b, dest.clone().addScaledVector(side, 0.5));
    const wg = this.walk(g, dest);
    guests.forEach((id, i) => this.walk(id, onPlatform(ctx, pid, doorAlong + 3 + (i % 4) * 1.4 + rng.range(-0.3, 0.3), 3.6 + Math.floor(i / 4) * 2.6 + rng.range(0, 0.8))));
    let confT = 0;
    this.tick((dt) => {
      confT -= dt;
      if (confT <= 0) { confT = 1.6 + Math.random() * 1.6; if (Math.random() < 0.7 && this.actors.has(b)) confettiBurst(this.env.fx, this.actors.pos(b), 14, 3); }
    });
    yield { until: () => Math.hypot(this.actors.pos(g).x - dest.x, this.actors.pos(g).z - dest.z) < 1.2 || (typeof wg === 'object' && wg.until()), max: 160 };
    this.cue('cheer', dest, 0.9);
    this.cue('chime', dest, 0.7);
    confettiBurst(this.env.fx, dest, 90, 5);
    guests.forEach((id) => this.actors.anim(id, 'cheer'));
    this.actors.idle(b, 'chat'); this.actors.idle(g, 'chat');

    let trainAt: string | null = null;
    this.on('train:arrived', (e) => { if (e.platform === pid && !trainAt) trainAt = e.trainId; });
    try { trainAt = ctx.reg.trains.list().find((t) => t.platform === pid && t.state === 'dwelling')?.id ?? null; } catch { /* stub */ }
    yield { until: () => !!trainAt, max: 70 };
    if (trainAt) {
      const tid: string = trainAt;
      const target = doorNear(ctx, tid, dest) ?? P.edgePointAt(ctx.layout.lines[P.line].nearestT(dest));
      target.y = 1;
      yield this.all([this.walk(b, target, { direct: true }), this.walk(g, target, { direct: true })], 30);
      confettiBurst(this.env.fx, target, 110, 5);
      this.cue('cheer', target, 1);
      const tdoor = this.actors.trainDoor(target) ?? undefined;
      this.actors.remove(b, tdoor);
      this.actors.remove(g, tdoor);
      let destName = 'parts unknown';
      try { const t = ctx.reg.trains.get(tid); if (t) { destName = t.destination; ctx.reg.trains.addPassengers(tid, 2); } } catch { /* stub */ }
      this.gazette(`The happy couple depart for ${destName} in a blizzard of confetti. The porters will be sweeping until Tuesday.`);
      yield 6;
    } else {
      this.gazette('No train being forthcoming, the wedding party repairs to the Railway Arms for further refreshment');
      this.actors.remove(b, 'door:station:railwayArms:0');
      this.actors.remove(g, 'door:station:railwayArms:0');
    }
    guests.forEach((id) => this.actors.remove(id));
    yield 8;
  }
}

// ═════════════════════════ 13. BRASS BAND CONCERT ═════════════════════════
// v2: the Railwaymen's band marches out of the Railway Arms carrying their music stands, sets up on the forecourt
// lawn, plays, and marches back to the pub. No stage pops into existence: the stands are carried in and out.
let noteTex: THREE.CanvasTexture | null = null;
function noteTexture(): THREE.CanvasTexture {
  if (noteTex) return noteTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#2a1e16';
  g.font = "bold 52px 'DejaVu Sans', sans-serif";
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('♪', 30, 34);
  noteTex = new THREE.CanvasTexture(cv);
  noteTex.colorSpace = THREE.SRGBColorSpace;
  return noteTex;
}

class BandEvent extends Scripted {
  maxDuration = 330;
  *script(): Script {
    const { ctx, rng } = this;
    const fc = ctx.layout.forecourt;
    const c = Math.cos(fc.yaw), s = Math.sin(fc.yaw);
    const local = (lx: number, lz: number, y = 0) => new THREE.Vector3(fc.center.x + lx * c + lz * s, y, fc.center.z - lx * s + lz * c);
    const center = local(-1, -10.8);
    const faceYaw = Math.atan2(-c, s);
    const R = 3.0;
    const n = 7;
    const angles: number[] = [];
    for (let i = 0; i < n; i++) angles.push(Math.PI * 0.58 + (Math.PI * 0.84 * i) / (n - 1));
    const toWorld = (lx: number, lz: number, y: number) => {
      const cy = Math.cos(faceYaw), sy = Math.sin(faceYaw);
      return new THREE.Vector3(center.x + lx * cy + lz * sy, y, center.z - lx * sy + lz * cy);
    };
    const pub = 'door:station:railwayArms:0';
    this.gazette(rng.pick([
      'AFTERNOON CONCERT: The Junction Silver Prize Band marches from the Railway Arms to perform selections from Sullivan upon the forecourt',
      'The Railwaymen\'s Brass Band strikes up on the forecourt; "Rule, Britannia!" much called for',
    ]));
    const band: string[] = [];
    const spots: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const a = angles[i];
      const sp = toWorld(Math.cos(a) * (R - 0.1), Math.sin(a) * (R - 0.1), 0);
      spots.push(sp);
      const id = this.actors.summon('bandsman', sp, { from: pub, timeoutMin: 100 });
      if (id) band.push(id);
    }
    const podium = toWorld(R + 0.3, 0, 0);
    const conductor = this.actors.summon('bandsman', podium, { from: pub, timeoutMin: 100 });
    if (!band.length) return;
    // each bandsman carries his music stand (one instanced draw for all of them)
    const stands = new InstProps(this.group, musicStandGeometry(), band.length);
    const placed = band.map(() => false);
    const standAt = spots.map((sp) => sp.clone().add(new THREE.Vector3(Math.cos(faceYaw) * 0.55, 0, -Math.sin(faceYaw) * 0.55)));
    /** pids of bandsmen walking home with their stands */
    const leaving: (string | null)[] = band.map(() => null);
    const carrierPos = (i: number): THREE.Vector3 | null => {
      if (leaving[i]) { const info = this.safe(() => ctx.reg.people.get(leaving[i]!), undefined); return info ? info.position : null; }
      return this.actors.has(band[i]) ? this.actors.pos(band[i]) : null;
    };
    this.tick(() => {
      band.forEach((_, i) => {
        if (placed[i]) { stands.set(i, standAt[i], faceYaw + Math.PI / 2, 1); return; }
        const p = carrierPos(i);
        if (!p) { stands.set(i, standAt[i], 0, 0); return; } // gone indoors with its owner
        stands.set(i, new THREE.Vector3(p.x, p.y + 0.5, p.z), faceYaw, 0.8, 1.2);
      });
      stands.commit();
    });
    const crowd = this.actors.crowd(12, toWorld(R + 7, 0, 0), 'passenger', 4);
    crowd.forEach((id, i) => {
      const half = Math.ceil(crowd.length / 2);
      const k = i % half, wing = i < half ? 1 : -1;
      const a = wing * (0.45 + (0.85 * k) / Math.max(1, half - 1));
      const r = R + 3.4 + (i % 3) * 1.0 + rng.range(-0.3, 0.3);
      this.walk(id, toWorld(Math.cos(a) * r, Math.sin(a) * r, 0), { direct: true });
    });
    // they drift in from the pub (a few minutes' walk); set stands down as each arrives
    yield { until: () => band.every((id, i) => { if (!placed[i] && Math.hypot(this.actors.pos(id).x - spots[i].x, this.actors.pos(id).z - spots[i].z) < 1.2) placed[i] = true; return placed[i]; }), max: 110 };
    band.forEach((_, i) => { placed[i] = true; });
    band.forEach((id) => { this.actors.look(id, center); this.actors.anim(id, 'play'); });
    if (conductor) { this.actors.anim(conductor, 'work'); this.actors.look(conductor, center); }
    this.cue('band', center, 1);
    this.cueLoop('band', [8, 12], () => center, 0.9);
    this.marker('♪', () => center, { lift: 4.0 });
    // six floating notes in ONE instanced billboard draw (they face the camera; scale fades them in and out)
    const NOTES = 6;
    const noteMat = new THREE.MeshBasicMaterial({ map: noteTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const noteMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), noteMat, NOTES);
    noteMesh.userData.ownMat = true;
    noteMesh.frustumCulled = false;
    noteMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(noteMesh);
    const notes: { t: number; x: number; z: number; y: number }[] = [];
    for (let i = 0; i < NOTES; i++) notes.push({ t: -i * 0.5, x: 0, z: 0, y: 0 });
    const _nm = new THREE.Matrix4(), _np = new THREE.Vector3(), _ns = new THREE.Vector3(), _nq = new THREE.Quaternion();
    let playing = true;
    this.tick((dt) => {
      noteMesh.visible = playing;
      if (!playing) return;
      const cam = ctx.camera.current;
      cam.getWorldQuaternion(_nq);
      const wpp = worldPerPixel(cam, center, this.env.fx.viewH());
      const sz = THREE.MathUtils.clamp(18 * wpp, 0.5, 6);
      notes.forEach((nt, i) => {
        nt.t += dt;
        if (nt.t > 2.6) { nt.t = 0; const src = spots[Math.floor(Math.random() * spots.length)]; nt.x = src.x; nt.z = src.z; nt.y = src.y + 1.9; }
        const f = nt.t / 2.6;
        const k = nt.t < 0 ? 0 : f < 0.2 ? f * 5 : 1 - (f - 0.2) / 0.8;
        _np.set(nt.x + Math.sin(nt.t * 3) * 0.4, nt.y + f * 2.8 * Math.max(1, sz), nt.z);
        _nm.compose(_np, _nq, _ns.setScalar(Math.max(1e-4, sz * k)));
        noteMesh.setMatrixAt(i, _nm);
      });
      noteMesh.instanceMatrix.needsUpdate = true;
    });
    yield rng.range(50, 80);
    playing = false;
    band.forEach((id) => this.actors.anim(id, 'idle'));
    crowd.forEach((id) => this.actors.anim(id, 'cheer'));
    this.cue('cheer', center, 1);
    this.gazette('The band concludes with the National Anthem; a collection raises 14s. 6d. for the Railway Orphanage');
    yield 3;
    // pick up the stands and march back to the pub (the stands go in with them)
    band.forEach((id, i) => { placed[i] = false; leaving[i] = this.actors.dismiss(id, { to: pub }); });
    if (conductor) this.actors.remove(conductor, pub);
    crowd.forEach((id) => this.actors.remove(id));
    yield { until: () => leaving.every((pid) => this.actors.gone(pid)), max: 120 };
    yield 1;
  }
}

export const ceremonyEvents: EventDef[] = [
  {
    id: 'royal', title: 'Royal Visit', blurb: 'The Royal Train calls: bunting, red carpet, cheering crowds, a fanfare and the royal carriage.',
    cooldown: 2880, condition: (e) => hr(e) > 10 && hr(e) < 16 && !wet(e), weight: () => 0.3,
    create: (e) => new RoyalEvent(e),
  },
  {
    id: 'wedding', title: 'Wedding Party', blurb: 'Wedding bells at St Mary’s; the newly-weds arrive by landau in a flurry of confetti to catch the train.',
    cooldown: 720, condition: (e) => hr(e) > 10 && hr(e) < 16 && !wet(e),
    weight: (e) => (e.ctx.clock.weekday === 5 ? 1.6 : 0.45),
    create: (e) => new WeddingEvent(e),
  },
  {
    id: 'bandConcert', title: 'Brass Band Concert', blurb: 'The Railwaymen’s band marches out of the Railway Arms to play on the forecourt, most often on a Sunday.',
    cooldown: 1200, condition: (e) => hr(e) > 13 && hr(e) < 17 && !wet(e),
    weight: (e) => (e.ctx.clock.weekday === 6 ? 3 : e.ctx.clock.weekday === 5 ? 0.8 : 0.2),
    create: (e) => new BandEvent(e),
  },
];
