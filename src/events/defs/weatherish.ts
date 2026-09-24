import * as THREE from 'three';
import type { Dir, LineId, PlatformId } from '../../core/types';
import type { Anchor } from '../../core/apis';
import { Scripted, NAMES_M, lineClear, onPlatform, onTrack, platCenterT, trainThreat, type EventDef, type EventEnv } from '../base';
import type { Script } from '../runner';
import { buildApparition, buildBalloon, buildGhostCar, buildLightningBolt, buildShovel, buildSnowdrift, ghostMaterial } from '../props';
import { glowMat, puff, sparkBurst } from '../fx';

const hr = (e: EventEnv) => e.ctx.clock.hour;
const wx = (e: EventEnv) => e.ctx.reg.atmosphere?.weather ?? 'clear';
const setW = (e: EventEnv, w: 'fog' | 'snow' | 'storm') => { try { if (wx(e) !== w && e.ctx.reg.atmosphere.target !== w) e.ctx.reg.atmosphere.setWeather(w); } catch { /* stub */ } };

// ═════════════════════════ 6. LIGHTNING STRIKES A SIGNAL ═════════════════════════
class SignalStrikeEvent extends Scripted {
  maxDuration = 140;
  *script(): Script {
    const { ctx, rng } = this;
    const line: LineId = rng.pick(['coast', 'highland'] as LineId[]);
    const end: Dir = rng.pick(['east', 'west'] as Dir[]);
    const L = ctx.layout.lines[line];
    let base: THREE.Vector3;
    try { base = ctx.reg.world.signalPosition(line, end).clone(); } catch { base = L.offsetPoint(L.signalT[end], -L.platformSide * 2.5, 0); }
    base.y = 0;
    const top = base.clone().setY(5.4);
    const bolt = buildLightningBolt(new THREE.Vector3(base.x + rng.range(-20, 20), 130, base.z + rng.range(-20, 20)), top, () => rng.next());
    this.group.add(bolt);
    const light = this.env.fx.lights.acquire(this);
    this.onCleanup(() => this.env.fx.lights.release(light));
    light.color.set(0xcfe0ff); light.position.copy(top).setY(8); light.distance = 60;
    let flashT = 0;
    this.tick((dt) => {
      flashT += dt;
      bolt.visible = flashT < 0.5 && (flashT < 0.12 || (flashT > 0.2 && flashT < 0.3) || flashT > 0.4);
      light.intensity = flashT < 0.6 ? 2500 * (1 - flashT / 0.6) ** 2 : 0;
    });
    this.ctx.bus.emit('weather:lightning', { pos: top.clone(), intensity: 1 });
    this.ctx.bus.emit('animal:scared', { pos: top.clone(), radius: 60 });
    this.cue('thunder', top, 1);
    try { ctx.reg.camera.shake(0.8); } catch { /* stub */ }
    sparkBurst(this.env.fx, top, 40, 1.3);
    const setSig = (a: 'failed' | 'stop') => { try { ctx.reg.world.setSignal(line, end, a); } catch { /* stub */ } };
    setSig('failed');
    let failed = true;
    this.onCleanup(() => { if (failed) setSig('stop'); });
    try { ctx.reg.trains.delayLine(line, rng.int(5, 9), 'Signal failure'); } catch { /* stub */ }
    this.gazette(`THUNDERBOLT! Lightning strikes the ${end === 'east' ? 'western' : 'eastern'} home signal of the ${L.name}; signal disabled and trains delayed`, 'warn');
    let smokeT = 0, sparkT = 1;
    this.tick((dt) => {
      if (!failed || dt <= 0) return;
      smokeT -= dt; sparkT -= dt;
      if (smokeT <= 0) { smokeT = 0.18; puff(this.env.fx, top, 0x4a4a4e, { vy: 1.4, size: 0.35, life: 2.6, grow: 3.2 }); }
      if (sparkT <= 0) { sparkT = 1.2 + Math.random() * 2.5; sparkBurst(this.env.fx, top, 6, 0.9); }
    });
    this.marker('!', () => top, { lift: 1.2 });
    const workAt = base.clone().add(L.tangentAt(L.signalT[end]).multiplyScalar(end === 'east' ? -1.1 : 1.1));
    // the signal fitter hurries out of the signal box
    const mech = this.actors.summon('mechanic', workAt, { from: end === 'east' ? 'door:signalbox' : undefined, run: true, timeoutMin: 70 });
    if (mech) yield this.actors.arrived(mech, 1.5);
    else yield 12;
    if (mech) this.actors.anim(mech, 'hammer');
    this.gazette(`A signal fitter attends the stricken ${L.name} signal, much exposed to the elements`, 'info');
    const clank = this.cueLoop('clank', [2, 4], () => base, 0.6);
    let weld = 0.5;
    this.tick((dt) => {
      if (!failed || dt <= 0 || !mech) return;
      weld -= dt;
      if (weld <= 0) { weld = 0.4 + Math.random() * 1.2; sparkBurst(this.env.fx, workAt.clone().setY(1.4).lerp(base, 0.5), 7, 1); }
    });
    yield rng.range(8, 13);
    clank();
    failed = false;
    setSig('stop');
    this.gazette(`The ${L.name} home signal is restored to working order`, 'info');
    if (mech) this.actors.remove(mech, end === 'east' ? 'door:signalbox' : undefined);
    yield 2;
  }
}

// ═════════════════════════ 8. THE GHOST TRAIN ═════════════════════════
// v2 (issue 6): pick a line & direction that is clear now and for the next half hour (trains.nextGap), ask trains
// for a ghost special due in ~15 minutes, and only start the haunting (lamps guttering, wisps, the spectral guard
// riding the rear of the train) once the Phantom Mail is ~150 m from the platform. The guard rides the train,
// so nothing appears out of thin air; it leaves with the train through the tunnel.
class GhostEvent extends Scripted {
  maxDuration = 80;
  *script(): Script {
    const { ctx, rng } = this;
    const opts: { line: LineId; dir: Dir; start: number }[] = [];
    for (const line of ['coast', 'highland'] as LineId[]) {
      const g = this.safe(() => ctx.reg.trains.nextGap(line, 30), { start: this.now, end: this.now + 30 });
      const busy = this.safe(() => ctx.reg.trains.list().some((t) => t.line === line && t.state !== 'inShed' && !t.ghost), false);
      for (const dir of ['east', 'west'] as Dir[]) opts.push({ line, dir, start: Math.max(g.start, this.now) + (busy ? 8 : 0) + rng.range(0, 2) });
    }
    opts.sort((a, b) => a.start - b.start);
    const pick = opts[0];
    const { line, dir } = pick;
    const L = ctx.layout.lines[line];
    const pid = L.platform as PlatformId;
    const cT = platCenterT(ctx, pid);
    let trainId = '';
    try { trainId = ctx.reg.trains.spawnSpecial({ special: 'ghost', ghost: true, stops: false, line, dir, name: 'The Phantom Mail', arriveBy: Math.max(this.now + 12, Math.min(pick.start, this.now + 16)) }); } catch { trainId = ''; }
    let gone = false;
    this.on('train:despawned', (e) => { if (e.trainId === trainId) gone = true; });
    this.gazette(rng.pick([
      'The night staff report an unscheduled bell from the signal box, though no train is booked. The fog thickens.',
      'A lamp gutters on the ' + L.name + '; old Jenkins the signalman crosses himself and will not say why',
    ]), 'info');

    // where is the ghost? (head t and length on this line; null while it is not on the map)
    let fallbackS: number | null = null;
    const ghostHead = (): { t: number; len: number } | null => {
      if (fallbackS !== null) return { t: THREE.MathUtils.clamp(fallbackS / L.length, 0, 1), len: 45 };
      const t = trainId ? this.safe(() => ctx.reg.trains.get(trainId), undefined) : undefined;
      return t && t.line === line ? { t: t.headT, len: t.length } : null;
    };
    // fallback phantom (only if trains couldn't give us one): starts inside the tunnel at the line's end
    const mat = ghostMaterial();
    const fallbackCars: THREE.Mesh[] = [];
    const startFallback = () => {
      const cars: THREE.Mesh[] = [buildGhostCar('loco', mat), buildGhostCar('coach', mat), buildGhostCar('coach', mat), buildGhostCar('coach', mat)];
      cars.forEach((c) => { c.userData.ownMat = c === cars[0]; this.group.add(c); fallbackCars.push(c); });
      fallbackS = dir === 'east' ? 0 : L.length;
      try { ctx.origins.audit('events', 'spawn', 'vehicles', L.pointAt(dir === 'east' ? 0 : 1), 'phantom (tunnel)'); } catch { /* none */ }
    };
    let ph = 0;
    this.tick((dt, dm) => {
      if (fallbackS === null || gone) return;
      const sgn = dir === 'east' ? 1 : -1;
      const hd = ghostHead()!;
      const distToPlat = Math.abs(hd.t - cT) * L.length;
      const v = distToPlat < 130 ? 7 : 26; // the slow spectral glide past the platform
      fallbackS += sgn * v * dm;
      ph += dt;
      mat.opacity = 0.28 + Math.sin(ph * 5) * 0.08;
      fallbackCars.forEach((c, i) => {
        const off = i === 0 ? 0 : 7.5 + (i - 1) * 12.5;
        const t = THREE.MathUtils.clamp((fallbackS! - sgn * off) / L.length, 0, 1);
        c.position.copy(L.pointAt(t)).setY(0.35);
        c.rotation.y = L.yawAt(t) + (dir === 'west' ? Math.PI : 0);
      });
      if ((dir === 'east' && fallbackS > L.length + 60) || (dir === 'west' && fallbackS < -60)) {
        gone = true;
        try { ctx.origins.audit('events', 'despawn', 'vehicles', L.pointAt(dir === 'east' ? 1 : 0), 'phantom (tunnel)'); } catch { /* none */ }
      }
    });
    if (!trainId) startFallback();
    else {
      yield { until: () => !!ghostHead() || gone, max: 24 };
      if (!ghostHead() && !gone) startFallback();
    }
    // the haunting begins when it is ~150 m out
    yield { until: () => { const h = ghostHead(); return gone || (!!h && Math.abs(h.t - cT) * L.length < 150); }, max: 30 };

    this.safe(() => ctx.reg.world.flickerLamps?.(1), undefined);
    this.onCleanup(() => this.safe(() => ctx.reg.world.flickerLamps?.(0), undefined));
    const lampMats = [ctx.mats.lampGlow, ctx.mats.windowLit];
    const bases = lampMats.map((m) => m.emissiveIntensity);
    const written = lampMats.map(() => -1);
    let flick = 1, flickT = 0, haunting = true;
    this.tick((dt) => {
      if (!haunting) return;
      flickT -= dt;
      if (flickT <= 0) { flick = Math.random() < 0.35 ? 0.05 + Math.random() * 0.3 : 0.8 + Math.random() * 0.2; flickT = 0.05 + Math.random() * (flick < 0.5 ? 0.15 : 0.6); }
      lampMats.forEach((m, i) => {
        if (Math.abs(m.emissiveIntensity - written[i]) > 1e-6) bases[i] = m.emissiveIntensity;
        const v = bases[i] * flick;
        m.emissiveIntensity = v;
        written[i] = v;
      });
    });
    this.onCleanup(() => lampMats.forEach((m, i) => { if (Math.abs(m.emissiveIntensity - written[i]) < 1e-6) m.emissiveIntensity = bases[i]; }));

    // the spectral guard rides the tail of the train, lantern swinging
    const gmat = ghostMaterial();
    const app = buildApparition(gmat);
    (app.root.children[0] as THREE.Mesh).userData.ownMat = true;
    app.root.visible = false;
    this.group.add(app.root);
    const wisps: THREE.Mesh[] = [];
    const wmat = glowMat(0x9affc8, 2.2, { transparent: true, opacity: 0.8 });
    const wgeo = new THREE.IcosahedronGeometry(0.16, 0);
    const winst = new THREE.InstancedMesh(wgeo, wmat, 6);
    winst.frustumCulled = false;
    this.group.add(winst);
    void wisps;
    const light = this.env.fx.lights.acquire(this);
    this.onCleanup(() => this.env.fx.lights.release(light));
    light.color.set(0x9affc8); light.distance = 14;
    let wispA = 0;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    this.tick((dt) => {
      ph += dt;
      const hd = ghostHead();
      const fade = 0.5 + 0.5 * Math.sin(ph * 0.9);
      gmat.opacity = 0.14 + 0.36 * fade;
      if (hd && !gone) {
        const sgn = dir === 'east' ? 1 : -1;
        const tailT = hd.t - sgn * (hd.len - 1.5) / L.length;
        const p = L.offsetPoint(THREE.MathUtils.clamp(tailT, 0, 1), 0, 1.35 + Math.sin(ph * 1.4) * 0.1);
        app.root.position.copy(p);
        app.root.rotation.y = L.yawAt(THREE.MathUtils.clamp(tailT, 0, 1)) + (dir === 'east' ? Math.PI : 0);
        app.root.visible = tailT > 0.02 && tailT < 0.98; // inside the tunnels it is hidden by the hill anyway
        app.lantern.rotation.z = Math.sin(ph * 2.1) * 0.35;
        light.position.copy(p).add(new THREE.Vector3(0, 1.2, 0));
        light.intensity = app.root.visible ? 12 * fade + Math.random() * 3 : 0;
      } else { app.root.visible = false; light.intensity = 0; }
      // will-o'-wisps swell while the phantom is near and fade after
      const near = hd && !gone ? THREE.MathUtils.clamp(1 - (Math.abs(hd.t - cT) * L.length - 60) / 120, 0, 1) : 0;
      wispA += (near - wispA) * Math.min(1, dt * 1.5);
      for (let i = 0; i < 6; i++) {
        const a = ph * (0.3 + i * 0.05) + i * 1.7;
        const t = cT + (Math.sin(a) * 40) / L.length;
        const p = L.offsetPoint(t, L.platformSide * (4.5 + Math.cos(a * 1.3) * 2.5), 2.2 + Math.sin(a * 2.3) * 0.6);
        m4.compose(p, q, sc.setScalar(Math.max(1e-4, wispA)));
        winst.setMatrixAt(i, m4);
      }
      winst.instanceMatrix.needsUpdate = true;
    });
    this.cue('spooky', onPlatform(ctx, pid, 0, 4), 1);
    this.cueLoop('spooky', [12, 20], () => app.root.position, 0.8);
    this.gazette(rng.pick([
      'GHOSTLY APPARITION! Night staff report a spectral train passing through the Junction without stopping, its lamps burning a dreadful green',
      'The Phantom Mail is seen again upon the ' + L.name + '; a lantern-bearing guard stands upon its tail. The signalman takes the pledge.',
    ]));
    this.marker('?', () => (app.root.visible ? app.root.position : null), { lift: 2.6, bg: '#cfeee8', fg: '#1f2e27' });
    // the haunting lasts while the phantom glides through; it ends once the train is well past the platform
    const sgnDir = dir === 'east' ? 1 : -1;
    yield { until: () => { const h = ghostHead(); return gone || !h || (h.t - cT) * sgnDir * L.length > 220; }, max: 40 };
    // the lamps steady again; the lantern-bearing guard rides on until the train is swallowed by the tunnel
    haunting = false;
    this.safe(() => ctx.reg.world.flickerLamps?.(0), undefined);
    lampMats.forEach((m, i) => { if (Math.abs(m.emissiveIntensity - written[i]) < 1e-6) m.emissiveIntensity = bases[i]; written[i] = -1; });
    yield { until: () => gone || !ghostHead(), max: 40 };
    this.gazette('Dawn cannot come soon enough: the Stationmaster declares the matter "fog and cheese"', 'info');
    yield 3;
  }
}

// ═════════════════════════ 9. SNOWDRIFT ═════════════════════════
// v2: the drift builds up in a quiet spell on the line; platelayers walk out with shovels. The line is held for at
// most 10 minutes — if they are not done by then the next train ploughs through in a white explosion.
class SnowdriftEvent extends Scripted {
  maxDuration = 200;
  *script(): Script {
    const { ctx, rng } = this;
    let line: LineId = rng.pick(['coast', 'highland'] as LineId[]);
    if (!lineClear(ctx, line) && lineClear(ctx, line === 'coast' ? 'highland' : 'coast')) line = line === 'coast' ? 'highland' : 'coast';
    const L = ctx.layout.lines[line];
    const pid = L.platform as PlatformId;
    const P = ctx.layout.platforms[pid];
    const endS = rng.chance(0.5) ? 1 : -1;
    const t = platCenterT(ctx, pid) + (endS * rng.range(42, 49)) / L.length;
    yield this.lineWindow(line, 18, 45);
    yield { until: () => lineClear(ctx, line), max: 15 };
    const release = this.holdLine(line);
    try { ctx.reg.trains.delayLine(line, rng.int(6, 10), 'Snowdrift'); } catch { /* stub */ }
    const drift = buildSnowdrift(() => rng.next());
    drift.position.copy(onTrack(ctx, line, t, 0.1));
    drift.rotation.y = L.yawAt(t);
    drift.scale.setScalar(0.01);
    this.group.add(drift);
    let amount = 1, grow = 0, ploughed = false;
    this.gazette(`SNOWBOUND! A great drift buries the ${L.name} at the Junction; a gang of platelayers is summoned with shovels`, 'warn');
    this.marker('!', () => (drift.visible ? drift.position : null), { lift: 2.4 });
    this.tick((dt, dm) => {
      // the drift piles up over a few minutes of blowing snow
      if (grow < 1) { grow = Math.min(1, grow + dm * 0.35 + dt * 0.02); if (amount >= 1) drift.scale.setScalar(Math.max(0.01, grow)); }
      if (!ploughed && amount > 0.05 && trainThreat(ctx, line, t, 4, 2)) {
        ploughed = true;
        for (let i = 0; i < 40; i++) puff(this.env.fx, drift.position.clone().setY(1), 0xf2f4f7, { vx: (Math.random() - 0.5) * 8, vy: 3 + Math.random() * 3, vz: (Math.random() - 0.5) * 8, size: 0.5, life: 1.4, grow: 1, gravity: 7, spread: 3 });
        amount = 0.02;
        drift.visible = false;
        release();
        this.gazette(`A locomotive ploughs clean through the ${L.name} drift in a white explosion; the platelayers lean on their shovels`, 'info');
      }
    });
    const out = -L.platformSide;
    const spots = [L.offsetPoint(t - 3.4 / L.length, 0, 0.3), L.offsetPoint(t + 3.4 / L.length, 0, 0.3), L.offsetPoint(t, out * 2.8, 0.1)];
    const crew: string[] = [];
    for (let i = 0; i < 3; i++) { const id = this.actors.summon('crew', spots[i], { timeoutMin: 60 }); if (id) crew.push(id); }
    const shovels = crew.map((id) => {
      const sh = buildShovel();
      this.group.add(sh);
      this.carry(sh, id, 0.25, 0.45, Math.PI / 2);
      return sh;
    });
    yield this.all(crew.map((id) => this.actors.arrived(id, 1.5)), 70);
    if (ploughed) { crew.forEach((id) => this.actors.remove(id)); yield 2; return; }
    crew.forEach((id) => this.actors.anim(id, 'shovel'));
    const dur = rng.range(7, 11);
    let throwT = 0, ph = 0;
    this.tick((dt, dm) => {
      if (amount <= 0.02 || !crew.length) return;
      ph += dt;
      amount = Math.max(0.02, amount - dm / dur);
      drift.scale.set(0.4 + 0.6 * amount, Math.max(0.05, amount), 0.5 + 0.5 * amount);
      shovels.forEach((sh, i) => { sh.rotation.z = Math.sin(ph * 4 + i * 2) * 0.5; });
      throwT -= dt;
      if (dt > 0 && throwT <= 0) {
        throwT = 0.25;
        const sp = spots[Math.floor(Math.random() * spots.length)];
        const away = sp.clone().sub(drift.position).setY(0).normalize();
        puff(this.env.fx, sp.clone().setY(1.2), 0xf2f4f7, { vx: away.x * 2.5 + (Math.random() - 0.5), vy: 2.8, vz: away.z * 2.5 + (Math.random() - 0.5), size: 0.45, life: 1.1, grow: 0.8, gravity: 7, spread: 0.6 });
      }
    });
    yield { until: () => amount <= 0.02, max: dur + 10 };
    drift.visible = false;
    release();
    if (!ploughed) this.gazette(`The ${L.name} is dug out; the platelayers are rewarded with hot cocoa and the Stationmaster's thanks`, 'info');
    crew.forEach((id) => this.actors.remove(id));
    yield 2;
  }
}

// ═════════════════════════ 12. HOT-AIR BALLOON (v2: it lands) ═════════════════════════
// The balloon drifts in from beyond the edge of the map on the wind, descends and lands in Shed Meadow. Its two
// aeronauts ride the basket (an Anchor), climb out, and walk to the station to go home by train; farmhands help pack
// the envelope and carry it off to the booking hall to be sent on by rail.
class BalloonEvent extends Scripted {
  maxDuration = 320;
  private b = buildBalloon();
  focus(): THREE.Vector3 | null {
    const p = this.b.root.position.clone().add(new THREE.Vector3(0, 10, 0));
    const cam = this.ctx.camera.current;
    const d = new THREE.Vector3();
    cam.getWorldDirection(d);
    if (d.y > -0.05) return p.setY(0);
    return p.addScaledVector(d, p.y / -d.y).setY(0);
  }
  *script(): Script {
    const { ctx, rng } = this;
    const b = this.b;
    this.group.add(b.root);
    let wind = new THREE.Vector2(1, -0.3);
    try { const w = ctx.reg.atmosphere.wind; if (w.lengthSq() > 0.01) wind = w.clone(); } catch { /* stub */ }
    const dir = new THREE.Vector3(wind.x, 0, wind.y).normalize();
    const field = ctx.layout.fields.find((f) => f.id === 'FG') ?? ctx.layout.fields[0];
    const land = field.poly ? (() => { let x = 0, z = 0; for (const p of field.poly) { x += p.x; z += p.y; } return new THREE.Vector3(x / field.poly.length, 0, z / field.poly.length); })() : new THREE.Vector3(-30, 0, 118);
    land.y = ctx.layout.heightAt(land.x, land.z);
    // start upwind, beyond the edge of the map (legit: it comes in from the sky)
    const edge = (ctx.layout.terrain?.half ?? 420) + 25;
    let D = 100;
    while (D < 1400) { const p = land.clone().addScaledVector(dir, -D); if (Math.max(Math.abs(p.x), Math.abs(p.z)) > edge) break; D += 10; }
    const start = land.clone().addScaledVector(dir, -D);
    const height0 = rng.range(55, 70);
    b.root.position.copy(start).setY(height0);
    try { ctx.origins.audit('events', 'spawn', 'vehicles', b.root.position, 'balloon (sky edge)'); } catch { /* none */ }
    const speed = THREE.MathUtils.clamp(wind.length() * 1.1, 3.5, 6.5);
    let travelled = 0, ph = rng.range(0, 6), burn = 0, burnT = 2, landed = false, deflate = 0;
    const light = this.env.fx.lights.acquire(this);
    this.onCleanup(() => this.env.fx.lights.release(light));
    light.color.set(0xffa040); light.distance = 30;
    const seatOff = [new THREE.Vector3(0.35, 0.06, 0.25), new THREE.Vector3(-0.35, 0.06, -0.25)];
    const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), yAxis = new THREE.Vector3(0, 1, 0);
    const anchor: Anchor = {
      id: `events:balloon:${Math.round(this.now)}`, seats: 2,
      seatMatrix: (seat, out) => {
        if (!b.root.parent || deflate >= 1) return false;
        _p.copy(seatOff[seat % 2]).applyQuaternion(b.root.quaternion).add(b.root.position);
        _q.setFromAxisAngle(yAxis, b.root.rotation.y + Math.PI / 2);
        out.compose(_p, _q, _s);
        return true;
      },
      seatPose: () => 'stand',
      hidden: () => false,
      doorPoint: (out) => out.copy(b.root.position).add(new THREE.Vector3(1.6, 0, 0.4)).setY(land.y),
      stopped: () => landed,
    };
    const basketOrigin = this.origin({ id: anchor.id, kind: 'vehicle', pos: (o) => o.copy(b.root.position), radius: 2.5, for: ['people'], open: () => landed || Math.max(Math.abs(b.root.position.x), Math.abs(b.root.position.z)) > edge - 15 });
    // aeronauts are aboard from the start (created inside the basket while it is still off the map)
    let crew = this.actors.inside(basketOrigin, [{ role: 'aeronaut' }, { role: 'aeronaut' }]);
    if (crew.length) this.actors.ride(crew, anchor, [0, 1]);
    let checked = false;
    this.tick((dt, dm) => {
      ph += dt;
      if (!checked && crew.length) {
        checked = true;
        // a people system that can't seat riders yet: let them walk off (they are off the map) and spawn on landing
        const riding = crew.every((id) => { const pid = this.actors.pid(id); return !!pid && !!this.safe(() => ctx.reg.people.get(pid)?.riding, undefined); });
        if (!riding) { crew.forEach((id) => this.actors.remove(id)); crew = []; }
      }
      if (!landed) {
        travelled += speed * dm;
        const f = THREE.MathUtils.clamp(travelled / D, 0, 1);
        const p = start.clone().lerp(land, f);
        // glide down over the last third, with a gentle bob
        const h = f < 0.62 ? height0 : THREE.MathUtils.lerp(height0, 0, THREE.MathUtils.smoothstep(f, 0.62, 1));
        b.root.position.set(p.x, land.y + h + (f < 0.95 ? Math.sin(ph * 0.4) * 1.6 : 0), p.z);
        b.envelope.rotation.y += dt * 0.05;
        if (f >= 1) { landed = true; this.cue('cheer', land, 0.6); this.ctx.bus.emit('animal:scared', { pos: land.clone(), radius: 40 }); }
      } else if (deflate > 0 && deflate < 1) {
        deflate = Math.min(1, deflate + dm / 9);
        const k = 1 - deflate;
        b.envelope.scale.set(1 + deflate * 0.5, Math.max(0.12, k), 1 + deflate * 0.5);
        b.envelope.rotation.z = deflate * 0.5;
      }
      burnT -= dt;
      if (burnT <= 0) { burn = 1.4 + Math.random() * 1.2; burnT = burn + (landed ? 60 : 4 + Math.random() * 7); }
      if (burn > 0) burn -= dt;
      const on = burn > 0 && deflate === 0;
      b.flame.visible = on;
      if (on) b.flame.scale.set(1, 0.8 + Math.random() * 0.5, 1);
      const night = this.safe(() => ctx.reg.atmosphere.nightFactor, 0);
      light.position.copy(b.root.position).add(new THREE.Vector3(0, 4.5, 0));
      light.intensity = on ? (120 + Math.random() * 60) * Math.max(0.15, night) : 0;
    });
    const aeronaut = rng.pick(NAMES_M);
    this.gazette(rng.pick([
      `AERIAL VISITOR: The celebrated aeronaut ${aeronaut} is sighted over the Downs in his balloon "Britannia", drifting toward the Junction`,
      `A balloon is sighted beyond the Junction! ${aeronaut} is believed bound for the Continent, or failing that, Kent`,
    ]), 'info');
    this.marker('!', () => (deflate < 1 ? b.root.position : null), { lift: landed ? 18 : 24 });
    yield { until: () => landed, max: 260 };
    if (!landed) return;
    this.gazette(`${aeronaut} brings the "Britannia" down in Shed Meadow, scattering the rooks and one very surprised farmhand`);
    // the aeronauts climb out (spawned inside the landed basket when they could not ride)
    if (!crew.length) crew = this.actors.inside(basketOrigin, [{ role: 'aeronaut' }, { role: 'aeronaut' }]);
    else {
      const pids = this.safe(() => ctx.reg.people.disembark(anchor.id, { then: 'actor' }), [] as string[]);
      if (pids.length) { crew.forEach((id) => this.actors.release(id)); crew = pids.map((p) => this.actors.adopt(p, 'aeronaut')).filter((x): x is string => !!x); }
    }
    const helpers = this.actors.crowd(3, land.clone().add(new THREE.Vector3(4, 0, 3)), 'farmhand', 4, 90);
    helpers.forEach((id, i) => this.walk(id, land.clone().add(new THREE.Vector3(Math.cos(i * 2.1) * 3.2, 0, Math.sin(i * 2.1) * 3.2))));
    crew.forEach((id, i) => { this.walk(id, land.clone().add(new THREE.Vector3(i ? -2 : 2, 0, 1.8))); this.actors.anim(id, 'wave'); });
    yield 6;
    deflate = 0.001;
    this.cue('hiss', land, 0.6);
    helpers.forEach((id) => this.actors.anim(id, 'work'));
    yield { until: () => deflate >= 1, max: 20 };
    // pack up: the helpers carry the envelope bundle and basket off to the booking hall; the aeronauts take the train
    b.envelope.visible = false; b.flame.visible = false;
    const bundle = new THREE.Group();
    const bm = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 2.2, 7).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9a3a3a, roughness: 0.9, flatShading: true }));
    bm.userData.ownMat = true;
    bundle.add(bm);
    bundle.position.copy(land).setY(land.y + 0.45);
    this.group.add(bundle);
    b.root.visible = false;
    // everyone leaves by the nearest door on THIS side of the railway (the station is a 1 km detour via the level
    // crossing): the envelope goes into the nearest barn or cottage to await the carrier
    const near = this.safe(() => ctx.origins.bestFor(land, 'people', { kinds: ['door'], exclude: ['door:station:east', 'door:station:p1', 'door:station:p2'] })?.id, undefined) ?? 'door:station:east';
    crew.forEach((id) => this.actors.remove(id, near));
    if (helpers.length) {
      this.carryOut(bundle, helpers[0], { to: near, y: 1.1, fwd: 0.2 });
      helpers.slice(1).forEach((id) => this.actors.remove(id));
    } else {
      const porter = this.actors.summon('farmhand', land.clone().add(new THREE.Vector3(1.5, 0, 0)), { from: near });
      if (porter) { yield this.actors.arrived(porter, 2); this.carryOut(bundle, porter, { to: near, y: 1.1, fwd: 0.2 }); }
    }
    this.gazette(`The "Britannia" is folded and stowed in a farmer's barn to await the carrier; ${aeronaut} accepts a cup of tea and declines to comment`, 'info');
    yield 4;
  }
}

export const weatherEvents: EventDef[] = [
  {
    id: 'signalStrike', title: 'Lightning Strike', blurb: 'Lightning disables a signal in the storm; a fitter braves the weather to repair it.',
    cooldown: 90, condition: (e) => wx(e) === 'storm', weight: () => 4,
    prepare: (e) => setW(e, 'storm'),
    create: (e) => new SignalStrikeEvent(e),
  },
  {
    id: 'ghost', title: 'The Phantom Mail', blurb: 'In the small hours and thick fog, a spectral train passes through without stopping.',
    cooldown: 1440, condition: (e) => hr(e) < 3 && wx(e) === 'fog', weight: () => 4,
    prepare: (e) => setW(e, 'fog'),
    create: (e) => new GhostEvent(e),
  },
  {
    id: 'snowdrift', title: 'Snowdrift', blurb: 'A drift blocks the line; a gang of platelayers digs it out.',
    cooldown: 360, condition: (e) => wx(e) === 'snow', weight: () => 2,
    prepare: (e) => setW(e, 'snow'),
    create: (e) => new SnowdriftEvent(e),
  },
  {
    id: 'balloon', title: 'Balloon Landing', blurb: 'A striped balloon drifts in on the wind and lands in Shed Meadow; its aeronauts go home by train.',
    cooldown: 720, condition: (e) => hr(e) > 6.5 && hr(e) < 18 && (wx(e) === 'clear' || wx(e) === 'overcast'), weight: () => 0.5,
    create: (e) => new BalloonEvent(e),
  },
];
