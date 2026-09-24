/**
 * Train maintenance: wear, coal & water, shed requests, breakdowns + rescue, and the repair bay.
 *
 * Wear: on 'train:departed' (a knock to brakes/wheels/boiler) + per sim minute while running; scaled by
 * api.wearMultiplier and weather (rain/snow/storm faster). Coal/water burn while running; partial top-up
 * while dwelling at a platform; full refill in the shed.
 * On arrival: if min(boiler,brakes,wheels) < threshold or coal/water very low → trains.requestShed + gazette.
 * Running with any component < 0.12 → chance per sim minute of breakdown → trains.breakdown, then
 * 10-20 sim min later trains.rescue (a tank engine hauls it to the shed).
 *
 * v2 (living world):
 *  • NO POP-IN: the fitters are real people. They are summoned out of the engine-shed door (people.summonActor),
 *    walk to the engine, work through the task list with matching gestures (hammering, shovelling coal at the coal
 *    stage and barrowing it back), and are dismissed back through the shed door when the engine leaves.
 *  • A rescued engine arrives with the shed pilot coupled behind; a fitter walks out and lifts the coupling before
 *    the pilot runs back out through the shed tunnel.
 *  • The shed road has one bay: when another engine is waiting, the gang hurries the current job along.
 *  • "Send to shed" answers in the gazette with an honest ETA; the board over the shed door shows it too.
 *  • No private lights: the welding glow is a pooled ctx.lights claim paired with an emissive arc.
 */
import * as THREE from 'three';
import type { Ctx, System } from '../core/types';
import type { SimClock } from '../core/clock';
import { formatSimTime } from '../core/clock';
import type { Condition, MaintenanceAPI, PersonAnim, ShedStatus, TrainInfo, TrainState } from '../core/apis';
import { trainsShared } from '../trains/share';
import { PUFF_SMOKE, PUFF_STEAM } from '../trains/smoke';
import { ScreenSprite, drawBoard, labelTexture } from './fx';

type Comp = 'boiler' | 'wheels' | 'brakes';
const COMPS: Comp[] = ['boiler', 'wheels', 'brakes'];
const MOVING: TrainState[] = ['running', 'departing', 'approaching', 'braking', 'waitingSignal', 'toShed', 'fromShed'];
const CAN_FAIL: TrainState[] = ['running', 'approaching', 'departing'];
const OUT_OF_SERVICE: TrainState[] = ['toShed', 'inShed', 'fromShed', 'broken', 'rescued'];
const WEATHER_WEAR: Record<string, number> = { clear: 1, overcast: 1, fog: 1.1, rain: 1.35, snow: 1.6, storm: 1.8 };
const BREAKDOWN_LEVEL = 0.12;
const BREAKDOWN_PER_MIN = 0.035;
const LOW_FUEL = 0.12;
/** remaining job minutes when another engine is waiting for the bay */
const HURRY_TO = 6;
const SHED_DOOR = 'door:shed';

const RETIRE_PHRASE: Record<Comp | 'coal' | 'water', string> = {
  boiler: 'with a leaking boiler', wheels: 'with flats upon her wheels', brakes: 'with her brake blocks worn to the iron',
  coal: 'with her bunker all but empty', water: 'with her tanks run dry',
};
const FAIL_PHRASE: Record<Comp | 'coal' | 'water', string> = {
  boiler: 'with a burst tube and a prodigious quantity of steam', wheels: 'with a hot axlebox', brakes: 'her brakes seized fast',
  coal: 'for want of coal', water: 'for want of water',
};
const TASK_NAME: Record<Comp | 'fuel' | 'polish', string> = {
  boiler: 'Re-tubing boiler', wheels: 'Truing wheels', brakes: 'Adjusting brakes', fuel: 'Taking on coal & water', polish: 'Polishing the brasswork',
};
const TASK_ANIM: Record<Comp | 'fuel' | 'polish', [PersonAnim, PersonAnim]> = {
  boiler: ['hammer', 'work'], wheels: ['work', 'hammer'], brakes: ['work', 'work'], fuel: ['watch', 'shovel'], polish: ['work', 'sweep'],
};

interface Task { kind: Comp | 'fuel' | 'polish'; dur: number; from: number; fromWater: number; to: number }
interface Job { id: string; label: string; tasks: Task[]; ti: number; tt: number; total: number; elapsed: number; ready: boolean; waitT: number }

/** one fitter walking about on maintenance's behalf (drawn and animated by the people system) */
interface Fitter {
  pid: string;
  target: THREE.Vector3 | null;
  arrived: boolean;
  flag: { done: boolean };
  since: number;
  anim: PersonAnim | null;
}

export function createMaintenance(ctx: Ctx): System {
  const rng = ctx.rng.fork(0x5eed);
  const L = ctx.layout;
  const group = new THREE.Group();
  group.name = 'maintenance';
  ctx.scene.add(group);

  const queue: string[] = [];
  const requestedAt = new Map<string, number>();
  const arrivedInShed = new Set<string>();
  const shedRequested = new Set<string>();
  /** engines the user sent (the gang hurries harder for them) */
  const manualIds = new Set<string>();
  const rescues = new Map<string, { at: number; done: boolean }>();
  const seeded = new Set<string>();
  const seenCond = new WeakSet<Condition>();
  let job: Job | null = null;

  const safe = <T,>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };
  const trains = () => ctx.reg.trains;
  const people = () => ctx.reg.people;
  const getT = (id: string) => safe(() => trains().get(id), undefined as TrainInfo | undefined);
  const now = () => ctx.clock.minutes;
  const gazette = (headline: string, kind: 'info' | 'warn' | 'event' = 'info') => ctx.bus.emit('gazette', { headline, kind });
  const cue = (c: 'clank' | 'hiss' | 'whistle' | 'hammer', pos: THREE.Vector3, volume: number) => ctx.bus.emit('audio:cue', { cue: c, pos: pos.clone(), volume });
  // labels are cached at first sight: once diverted, trains' destination becomes e.g. "Engine Shed"
  const labels = new Map<string, string>();
  const label = (t: TrainInfo) => {
    const hit = labels.get(t.id);
    if (hit) return hit;
    const l = t.kind !== 'special' && t.scheduledDep > 0 && !OUT_OF_SERVICE.includes(t.state) && !/shed/i.test(t.destination)
      ? `The ${formatSimTime(t.scheduledDep)} to ${t.destination}` : (t.name || 'A locomotive').split(' · ')[0];
    if (!OUT_OF_SERVICE.includes(t.state)) labels.set(t.id, l);
    return l;
  };
  const lineName = (t: TrainInfo) => L.lines[t.line]?.name ?? t.line;
  const exempt = (t: TrainInfo) => !!t.ghost || t.special === 'ghost' || t.special === 'rescue';
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const weatherFactor = () => WEATHER_WEAR[safe(() => ctx.reg.atmosphere.weather, 'clear')] ?? 1;
  const worst = (c: Condition): Comp | 'coal' | 'water' => {
    let k: Comp | 'coal' | 'water' = 'boiler', v = Infinity;
    for (const comp of COMPS) if (c[comp] < v) { v = c[comp]; k = comp; }
    if (c.coal < LOW_FUEL && c.coal < v) { v = c.coal; k = 'coal'; }
    if (c.water < LOW_FUEL && c.water < v) { k = 'water'; }
    return k;
  };
  const minComp = (c: Condition) => Math.min(c.boiler, c.brakes, c.wheels);
  const etaOf = (id: string) => safe(() => trainsShared.shedEta(id), null as number | null);
  const etaText = (m: number | null) => m === null ? '' : m < 1.5 ? 'any moment' : `in about ${Math.max(1, Math.round(m))} minutes`;

  // ───────── API ─────────
  const api: MaintenanceAPI = {
    status: (): ShedStatus => {
      let task: string;
      if (job) task = job.ready ? TASK_NAME[job.tasks[Math.min(job.ti, job.tasks.length - 1)].kind] : 'Fitters on their way';
      else if (queue.length) {
        const eta = etaOf(queue[0]);
        task = eta !== null && eta > 0.5 ? `Expected ${etaText(eta)}` : 'Awaiting arrivals';
      } else task = 'idle';
      return {
        bay: job?.id ?? null,
        queue: queue.slice(),
        progress: job && job.total > 0 ? +(job.elapsed / job.total).toFixed(3) : 0,
        task,
      };
    },
    wearMultiplier: 1,
    threshold: 0.35,
    forceBreakdown(trainId?: string) {
      let t: TrainInfo | undefined = trainId ? getT(trainId) : undefined;
      if (!t && !trainId) {
        const list = safe(() => trains().list(), [] as TrainInfo[]).filter((x) => !exempt(x) && !rescues.has(x.id));
        const running = list.filter((x) => CAN_FAIL.includes(x.state));
        const pool = running.length ? running : list.filter((x) => !OUT_OF_SERVICE.includes(x.state));
        if (pool.length) t = rng.pick(pool);
      }
      if (!t) return;
      const comp = rng.pick(COMPS);
      t.condition[comp] = Math.min(t.condition[comp], 0.08);
      doBreakdown(t, comp);
    },
    sendToShed(trainId: string) {
      const t = getT(trainId);
      if (!t) return;
      if (job?.id === t.id || t.state === 'inShed') { gazette(`${label(t)} is already in the engine shed`, 'info'); return; }
      if (exempt(t)) { gazette(`The shed foreman declines to take charge of ${label(t).replace(/^The /, 'the ')}`, 'info'); return; }
      if (t.state === 'broken' || t.state === 'rescued') { gazette(`${label(t)} is already awaiting the breakdown engine`, 'info'); return; }
      if (t.state === 'fromShed') { gazette(`${label(t)} has only just left the shed`, 'info'); return; }
      requestShedFor(t, true);
    },
  };
  ctx.reg.maintenance = api;
  // trains' shed ETA asks how long the bay stays busy (a waiting engine makes the gang hurry: ≤ HURRY_TO)
  trainsShared.bayFreeIn = () => {
    if (!job) return 0;
    // (asked on behalf of an engine that will be waiting, so the gang is assumed to hurry)
    const wait = job.ready ? 0 : Math.max(0, (manualWaiting() ? 4 : 8) - job.waitT);
    const to = manualWaiting() || queue.length <= 1 ? 3 : HURRY_TO;
    return Math.min(Math.max(0, job.total - job.elapsed), to) + wait + 2;
  };

  function requestShedFor(t: TrainInfo, manual = false) {
    if (shedRequested.has(t.id) || job?.id === t.id) {
      if (manual) { const eta = etaOf(t.id); gazette(`${label(t)} is already bound for the shed${eta !== null ? `, expected ${etaText(eta)}` : ''}`, 'info'); }
      return;
    }
    const ok = safe(() => trains().requestShed(t.id, { urgent: manual }) !== false, false);
    if (!ok) {
      if (manual) gazette(`The shed foreman cannot take ${label(t).replace(/^The /, 'the ')} just now`, 'info');
      return;
    }
    shedRequested.add(t.id);
    if (manual) manualIds.add(t.id);
    if (!queue.includes(t.id)) queue.push(t.id);
    requestedAt.set(t.id, now());
    const why = worst(t.condition);
    const eta = etaOf(t.id);
    const when = eta !== null ? ` — expected in the shed ${etaText(eta)}` : '';
    gazette(manual ? `${label(t)} is ordered to the engine shed for inspection${when}` : `${label(t)} retires to the shed ${RETIRE_PHRASE[why]}`, manual ? 'info' : 'warn');
  }

  function doBreakdown(t: TrainInfo, comp: Comp | 'coal' | 'water') {
    if (rescues.has(t.id)) return;
    rescues.set(t.id, { at: now() + rng.range(10, 20), done: false });
    safe(() => trains().breakdown(t.id), undefined);
    gazette(`FAILURE ON THE ${lineName(t).toUpperCase()}: ${label(t)} comes to a stand ${FAIL_PHRASE[comp]}`, 'warn');
    cue('hiss', t.position, 1);
  }

  // ───────── fitters (people system actors) ─────────
  const fitters: (Fitter | null)[] = [null, null];
  let uncoupler: (Fitter & { trainId: string; workUntil: number; done: boolean }) | null = null;
  const leaving = new Set<string>();

  function summon(target: THREE.Vector3): Fitter | null {
    const P = people();
    if (!P?.summonActor) return null;
    const r = safe(() => P.summonActor('mechanic', target.clone(), { from: SHED_DOOR, timeoutMin: 40 }), null);
    if (!r || !r.id) return null;
    const flag = { done: false };
    r.arrived?.then(() => { flag.done = true; }, () => { flag.done = true; });
    return { pid: r.id, target: target.clone(), arrived: false, flag, since: now(), anim: null };
  }
  function alive(f: Fitter | null): f is Fitter {
    return !!f && !!safe(() => people().get(f.pid), undefined);
  }
  function walk(f: Fitter, target: THREE.Vector3) {
    f.target = target.clone(); f.arrived = false; f.since = now(); f.anim = null;
    const flag = { done: false };
    f.flag = flag;
    const pr = safe(() => people().walkTo(f.pid, target.clone()), null as Promise<void> | null);
    pr?.then(() => { flag.done = true; }, () => { flag.done = true; });
  }
  /** synchronous arrival test (works inside __station.advance, which runs no microtasks) */
  function arrivedAt(f: Fitter, timeout: number): boolean {
    if (f.arrived) return true;
    const p = safe(() => people().get(f.pid)?.position, undefined);
    const close = !!p && !!f.target && (p.x - f.target.x) ** 2 + (p.z - f.target.z) ** 2 < 1.4 * 1.4;
    if (close || f.flag.done || now() - f.since > timeout) f.arrived = true;
    return f.arrived;
  }
  function setAnim(f: Fitter, a: PersonAnim, look?: THREE.Vector3) {
    if (f.anim === a) return;
    f.anim = a;
    safe(() => people().setAnim(f.pid, a), undefined);
    if (look) safe(() => people().lookAt(f.pid, look.clone()), undefined);
  }
  function dismiss(f: Fitter | null) {
    if (!f) return;
    leaving.add(f.pid);
    safe(() => { people().lookAt(f.pid, null); people().setAnim(f.pid, 'walk'); }, undefined);
    const pr = safe(() => people().dismissActor(f.pid, { to: SHED_DOOR }), null as Promise<void> | null);
    const pid = f.pid;
    pr?.then(() => leaving.delete(pid), () => leaving.delete(pid));
  }

  // ───────── bus ─────────
  ctx.bus.on('train:spawned', ({ trainId }) => {
    const t = getT(trainId);
    if (t) label(t);
    if (!t || exempt(t) || seeded.has(trainId)) return;
    seeded.add(trainId);
    const c = t.condition;
    // first sight of this engine (condition objects persist per loco): some arrive already tired
    if (!seenCond.has(c)) {
      seenCond.add(c);
      if (t.kind !== 'special' && rng.chance(0.12)) { const k = rng.pick(COMPS); c[k] = Math.min(c[k], rng.range(0.22, 0.34)); }
    }
    // give pristine engines a service history so the shed has work
    if (t.kind !== 'special' && c.boiler >= 0.97 && c.brakes >= 0.97 && c.wheels >= 0.97) {
      for (const k of COMPS) c[k] = rng.range(0.55, 1);
      const r = rng.next();
      if (r < 0.16) c[rng.pick(COMPS)] = rng.range(0.2, 0.34);
      else if (r < 0.2) c[rng.pick(COMPS)] = rng.range(0.07, 0.115);
      if (c.coal >= 0.97) c.coal = rng.range(0.35, 1);
      if (c.water >= 0.97) c.water = rng.range(0.35, 1);
    }
  });
  ctx.bus.on('train:departed', ({ trainId }) => {
    const t = getT(trainId);
    if (!t || exempt(t)) return;
    const m = api.wearMultiplier * weatherFactor();
    t.condition.brakes = clamp01(t.condition.brakes - rng.range(0.005, 0.02) * m);
    t.condition.wheels = clamp01(t.condition.wheels - rng.range(0.004, 0.015) * m);
    t.condition.boiler = clamp01(t.condition.boiler - rng.range(0.004, 0.018) * m);
  });
  ctx.bus.on('train:arrived', ({ trainId }) => {
    const t = getT(trainId);
    if (!t || exempt(t) || t.kind === 'special') return;
    const c = t.condition;
    if (minComp(c) < api.threshold || c.coal < LOW_FUEL || c.water < LOW_FUEL) requestShedFor(t);
  });
  ctx.bus.on('train:breakdown', ({ trainId }) => {
    if (rescues.has(trainId)) return;
    const t = getT(trainId);
    rescues.set(trainId, { at: now() + rng.range(10, 20), done: false });
    if (t) gazette(`FAILURE ON THE ${lineName(t).toUpperCase()}: ${label(t)} comes to a stand`, 'warn');
  });
  ctx.bus.on('train:inShed', ({ trainId }) => {
    arrivedInShed.add(trainId);
    shedRequested.add(trainId);
    if (job?.id !== trainId && !queue.includes(trainId)) { queue.push(trainId); requestedAt.set(trainId, now()); }
    startUncoupling(trainId);
    tryStart();
  });
  ctx.bus.on('train:despawned', ({ trainId }) => forget(trainId));

  function forget(id: string) {
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    requestedAt.delete(id); arrivedInShed.delete(id); shedRequested.delete(id); rescues.delete(id); seeded.delete(id); labels.delete(id);
    const mk = brokenMarkers.get(id);
    if (mk) { mk.dispose(); brokenMarkers.delete(id); }
    if (job?.id === id) endJob(false);
  }

  // ───────── shed bay geometry ─────────
  const sb = L.shed.building;
  const roadZ = L.shedRoad?.z ?? sb.center.z;
  const bayX = sb.center.x;
  // fitters work either side of the engine standing in the middle of the shed (the shed road runs along its axis)
  const workSpots = [new THREE.Vector3(bayX + 3.5, 0, roadZ - 2.2), new THREE.Vector3(bayX - 4.5, 0, roadZ + 2.2)];
  const sparkSpots = [new THREE.Vector3(bayX + 3.5, 1.3, roadZ - 1.2), new THREE.Vector3(bayX - 4.5, 0.9, roadZ + 1.2)];
  const lookAtEngine = [new THREE.Vector3(bayX + 3.5, 1.2, roadZ), new THREE.Vector3(bayX - 4.5, 1.2, roadZ)];
  const doorX = sb.center.x + (sb.size.x / 2) * Math.cos(sb.yaw), doorZ = sb.center.z - (sb.size.x / 2) * Math.sin(sb.yaw);
  const boardPos = new THREE.Vector3(doorX - 4 * Math.cos(sb.yaw), (sb.size.y || 9) + 1, doorZ + 4 * Math.sin(sb.yaw));
  const doorGlow = new THREE.Vector3(doorX - 2.5 * Math.cos(sb.yaw), 3.2, doorZ + 2.5 * Math.sin(sb.yaw));
  // coal: shovelled at the coal stage (track side) and barrowed back to the engine
  const coalSpot = (() => {
    const sc = L.shed.curve;
    let bt = 0, bd = Infinity;
    for (let i = 0; i <= 60; i++) { const q = sc.getPointAt(i / 60); const d = q.distanceToSquared(L.shed.coalStage); if (d < bd) { bd = d; bt = i / 60; } }
    const q = sc.getPointAt(bt);
    return L.shed.coalStage.clone().lerp(new THREE.Vector3(q.x, 0, q.z), 0.55).setY(0);
  })();

  function tryStart() {
    if (job) return;
    const id = queue.find((q) => arrivedInShed.has(q) || getT(q)?.state === 'inShed');
    if (!id) return;
    queue.splice(queue.indexOf(id), 1);
    startJob(id);
  }

  function startJob(id: string) {
    const t = getT(id);
    if (!t) return;
    const c = t.condition;
    const tasks: Task[] = [];
    const weights: number[] = [];
    for (const k of COMPS) if (c[k] < 0.93) { tasks.push({ kind: k, dur: 0, from: c[k], fromWater: 0, to: rng.range(0.95, 1) }); weights.push(0.5 + (1 - c[k]) * 2); }
    if (!tasks.length) { tasks.push({ kind: 'polish', dur: 0, from: 0, fromWater: 0, to: 1 }); weights.push(0.4); }
    tasks.push({ kind: 'fuel', dur: 0, from: c.coal, fromWater: c.water, to: 1 });
    weights.push(0.7);
    const total = rng.range(30, 60);
    const sw = weights.reduce((a, b) => a + b, 0);
    tasks.forEach((tk, i) => { tk.dur = Math.max(4, (total * weights[i]) / sw); });
    job = { id, label: label(t), tasks, ti: 0, tt: 0, total: tasks.reduce((a, b) => a + b.dur, 0), elapsed: 0, ready: false, waitT: 0 };
    // the gang comes out of the shed's mess-room door (the uncoupler, if still about, joins them)
    for (let i = 0; i < 2; i++) {
      if (alive(fitters[i])) { walk(fitters[i]!, workSpots[i]); continue; }
      if (i === 1 && uncoupler && alive(uncoupler) && uncoupler.done) { fitters[1] = uncoupler; uncoupler = null; walk(fitters[1]!, workSpots[1]); continue; }
      fitters[i] = summon(workSpots[i]);
    }
    gazette(`${job.label} enters the repair bay at the engine shed`, 'info');
  }

  function manualWaiting(): boolean {
    for (const q of queue) if (q !== job?.id && manualIds.has(q)) return true;
    return false;
  }

  /** an engine is waiting to come in: the gang hurries (remaining work squeezed to ≤ HURRY_TO minutes) */
  function othersWaiting(): boolean {
    for (const q of queue) {
      if (q === job?.id) continue;
      const t = getT(q);
      if (t && (t.state === 'toShed' || t.state === 'rescued' || t.state === 'inShed')) return true;
    }
    return false;
  }

  function stepJob(dtSim: number) {
    if (!job) return;
    const t = getT(job.id);
    if (!t) { endJob(false); return; }
    if (!job.ready) {
      job.waitT += dtSim;
      const here = fitters.every((f) => !f || !alive(f) || arrivedAt(f, 20));
      if (here || job.waitT > (manualWaiting() ? 4 : othersWaiting() ? 8 : 22)) {
        job.ready = true;
        cue('clank', workSpots[0], 0.8);
      }
      return;
    }
    const remaining = job.total - job.elapsed;
    // someone the user sent is waiting: the gang knocks off the job in ~3 min
    const manual = manualWaiting();
    const to = manual ? 3 : HURRY_TO;
    const hurry = (manual || othersWaiting()) && remaining > to ? remaining / to : 1;
    let left = dtSim * hurry;
    while (left > 0 && job && job.ti < job.tasks.length) {
      const tk = job.tasks[job.ti];
      const use = Math.min(left, tk.dur - job.tt);
      job.tt += use; job.elapsed += use; left -= use;
      const f = Math.min(1, job.tt / tk.dur);
      const c = t.condition;
      if (tk.kind === 'fuel') { c.coal = Math.max(c.coal, THREE.MathUtils.lerp(tk.from, 1, f)); c.water = Math.max(c.water, THREE.MathUtils.lerp(tk.fromWater, 1, f)); }
      else if (tk.kind !== 'polish') c[tk.kind] = Math.max(c[tk.kind], THREE.MathUtils.lerp(tk.from, tk.to, f));
      if (job.tt >= tk.dur - 1e-6) {
        job.ti++; job.tt = 0;
        cue('hiss', workSpots[0], 0.6);
      }
    }
    if (job && job.ti >= job.tasks.length) endJob(true);
  }

  function endJob(ok: boolean) {
    if (!job) return;
    const j = job;
    job = null;
    const t = getT(j.id);
    manualIds.delete(j.id);
    shedRequested.delete(j.id); arrivedInShed.delete(j.id); rescues.delete(j.id); requestedAt.delete(j.id);
    if (ok && t) {
      for (const k of COMPS) t.condition[k] = Math.max(t.condition[k], 0.95);
      t.condition.coal = 1; t.condition.water = 1;
      safe(() => trains().releaseFromShed(j.id), undefined);
      ctx.bus.emit('train:repaired', { trainId: j.id });
      cue('whistle', workSpots[0], 0.6);
      gazette(`${j.label} leaves the shed in fine fettle, brasswork gleaming`, 'info');
    }
    coal.stage = 'idle';
    // the next engine may already be in: keep the gang, otherwise they go back in for a mug of tea
    tryStart();
    if (!job) { for (let i = 0; i < fitters.length; i++) { dismiss(fitters[i]); fitters[i] = null; } }
  }

  // ───────── uncoupling the shed pilot ─────────
  const _cp = new THREE.Vector3();
  function startUncoupling(trainId: string) {
    const p = safe(() => trainsShared.pilotCoupling(trainId, _cp), null);
    if (!p) return;
    const spot = p.clone().setZ(roadZ + 1.6);
    const f = uncoupler && alive(uncoupler) ? uncoupler : summon(spot);
    if (!f) { safe(() => trainsShared.uncouple(trainId), undefined); return; }
    if (f === uncoupler) walk(f, spot);
    uncoupler = Object.assign(f, { trainId, workUntil: -1, done: false });
  }
  function stepUncoupler() {
    const u = uncoupler;
    if (!u) return;
    if (!safe(() => !!people().get(u.pid), false)) { if (!u.done) safe(() => trainsShared.uncouple(u.trainId), undefined); uncoupler = null; return; }
    if (u.done) { if (!job) { dismiss(u); uncoupler = null; } return; }
    if (!arrivedAt(u, 25)) return;
    if (u.workUntil < 0) {
      u.workUntil = now() + 1.4;
      setAnim(u, 'work', _cp.set(u.target!.x, 0.9, roadZ));
      cue('clank', u.target!, 0.5);
    } else if (now() >= u.workUntil) {
      u.done = true;
      safe(() => trainsShared.uncouple(u.trainId), undefined);
      setAnim(u, 'wave');
      cue('clank', u.target!, 0.8);
      trainsShared.smoke?.emit(u.target!.x, 0.9, roadZ, 0, 0.8, 0, 0.35, PUFF_STEAM, 1.4);
    }
  }

  // ───────── coal barrowing (second fitter during "coal & water") ─────────
  const coal = { stage: 'idle' as 'idle' | 'toStage' | 'shovel' | 'back' | 'tip', until: 0 };
  function stepCoal(task: string | null) {
    const f = fitters[1];
    if (!alive(f)) { coal.stage = 'idle'; return; }
    const want = task === 'fuel';
    if (!want) {
      if (coal.stage !== 'idle') { coal.stage = 'idle'; walk(f, workSpots[1]); }
      return;
    }
    switch (coal.stage) {
      case 'idle': coal.stage = 'toStage'; walk(f, coalSpot); break;
      case 'toStage': if (arrivedAt(f, 30)) { coal.stage = 'shovel'; coal.until = now() + rng.range(2.5, 4); setAnim(f, 'shovel', L.shed.coalStage); } break;
      case 'shovel': if (now() >= coal.until) { coal.stage = 'back'; walk(f, workSpots[1]); setAnim(f, 'push'); } break;
      case 'back': if (arrivedAt(f, 30)) { coal.stage = 'tip'; coal.until = now() + 1.2; setAnim(f, 'work', lookAtEngine[1]); cue('clank', workSpots[1], 0.4); } break;
      case 'tip': if (now() >= coal.until) coal.stage = 'idle'; break;
    }
  }

  // ───────── visuals ─────────
  const boardTex = labelTexture(320, 112);
  const board = new ScreenSprite(group, 58, 320 / 112, boardTex, false);
  let boardKey = '';
  // welding: a blue-white arc at the work spot + a pooled light thrown out through the shed doorway
  const arcMat = new THREE.MeshBasicMaterial({ color: 0xcfe4ff, toneMapped: false });
  const arc = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), arcMat);
  arc.visible = false;
  arc.name = 'maintWeldArc';
  group.add(arc);
  const weldColor = new THREE.Color(0x9fc8ff);
  let weldT = 0.5, clankT = 2, steamT = 0, flick = 0, coalDustT = 0, washT = 0;
  const brokenMarkers = new Map<string, ScreenSprite>();
  const viewH = () => ctx.renderer.domElement.clientHeight || window.innerHeight;

  function visuals(dt: number, paused: boolean) {
    const smoke = trainsShared.smoke;
    // board
    const st = api.status();
    const show = !!job || queue.length > 0;
    board.visible = show;
    if (show) {
      const pct = Math.floor(st.progress * 20) * 5;
      const title = job ? (getT(job.id)?.name ?? 'Locomotive').split(' · ').pop()! : `${queue.length} engine${queue.length > 1 ? 's' : ''} expected`;
      const key = `${title}|${st.task}|${pct}`;
      if (key !== boardKey) { boardKey = key; drawBoard(boardTex, [title.length > 26 ? title.slice(0, 25) + '…' : title, st.task], job?.ready ? st.progress : -1); }
      board.place(boardPos, ctx.camera.current, viewH(), 0, 1.5);
    }
    const task = job && job.ready ? job.tasks[Math.min(job.ti, job.tasks.length - 1)].kind : null;
    // fitters' gestures follow the task
    if (task) {
      const [a0, a1] = TASK_ANIM[task];
      const f0 = fitters[0];
      if (alive(f0) && arrivedAt(f0, 20)) setAnim(f0, a0, lookAtEngine[0]);
      const f1 = fitters[1];
      if (task !== 'fuel' && alive(f1) && arrivedAt(f1, 20) && coal.stage === 'idle') setAnim(f1, a1, lookAtEngine[1]);
    }
    // welding sparks + light + clank
    const welding = !!task && task !== 'fuel' && !paused;
    if (welding) {
      weldT -= dt; clankT -= dt;
      if (weldT <= 0) {
        weldT = 0.25 + Math.random() * 0.9;
        const sp = sparkSpots[Math.random() < 0.6 ? 0 : 1];
        const n = task === 'polish' ? 2 : 9;
        if (smoke) for (let k = 0; k < n; k++) smoke.spark(sp.x, sp.y, sp.z, (Math.random() - 0.5) * 2, -4.5, (Math.random() - 0.5) * 2);
        flick = task === 'polish' ? 0 : 0.18;
        arc.position.copy(sp);
      }
      if (clankT <= 0) { clankT = 2.2 + Math.random() * 2.5; cue(Math.random() < 0.5 ? 'hammer' : 'clank', sparkSpots[0], 0.7); }
    }
    flick = Math.max(0, flick - dt);
    arc.visible = flick > 0;
    if (flick > 0) safe(() => ctx.lights.claim('maint:weld', doorGlow, weldColor, 60 + Math.random() * 90, 16, 2), undefined);
    // coal dust at the coal stage while shovelling
    if (coal.stage === 'shovel' && !paused && smoke) {
      coalDustT -= dt;
      if (coalDustT <= 0) {
        coalDustT = 0.5 + Math.random() * 0.6;
        const p = safe(() => people().get(fitters[1]!.pid)?.position, undefined);
        if (p) smoke.emit(p.x, 1.1, p.z, 0, 0.7, 0, 0.18, PUFF_SMOKE, 1.2);
      }
    }
    // taking on water: steam and spray round the engine's tank filler
    if (task === 'fuel' && !paused && smoke) {
      washT -= dt;
      if (washT <= 0) { washT = 0.35 + Math.random() * 0.4; smoke.emit(bayX + (Math.random() - 0.5) * 6, 2.8, roadZ, 0, 0.9, 0, 0.25, PUFF_STEAM, 1.2); }
    }
    // broken trains: leaking steam + marker
    steamT -= dt;
    const emit = steamT <= 0 && !paused;
    if (emit) steamT = 0.14;
    for (const [id] of rescues) {
      const t = getT(id);
      const broken = !!t && (t.state === 'broken' || t.state === 'rescued');
      let mk = brokenMarkers.get(id);
      if (broken && t) {
        if (!mk) { mk = new ScreenSprite(group, 30, 1); brokenMarkers.set(id, mk); }
        mk.place(t.position, ctx.camera.current, viewH(), dt, 5.5);
        if (emit && t.state === 'broken' && smoke) smoke.emit(t.position.x, 3.4, t.position.z, 0, 2.2, 0, 0.5, PUFF_STEAM, 2.2);
      } else if (mk) { mk.dispose(); brokenMarkers.delete(id); }
    }
  }

  // ───────── update ─────────
  return {
    name: 'maintenance',
    update(dt: number, clock: SimClock) {
      const dtSim = clock.dtSim;
      if (dtSim > 0) {
        const list = safe(() => trains().list(), [] as TrainInfo[]);
        const wf = weatherFactor() * api.wearMultiplier;
        for (const t of list) {
          if (exempt(t)) continue;
          const c = t.condition;
          const tank = t.cars[0] === 'loco_tank' ? 1.6 : 1;
          if (MOVING.includes(t.state)) {
            c.boiler = clamp01(c.boiler - 0.0012 * wf * dtSim);
            c.wheels = clamp01(c.wheels - 0.0009 * wf * dtSim);
            c.brakes = clamp01(c.brakes - (t.state === 'braking' ? 0.003 : 0.00045) * wf * dtSim);
            // trains burns coal & water per distance; we only add the fire kept up while standing/crawling
            c.coal = clamp01(c.coal - 0.0003 * tank * dtSim);
            c.water = clamp01(c.water - 0.0003 * tank * dtSim);
            if (CAN_FAIL.includes(t.state) && t.kind !== 'special' && !rescues.has(t.id) && (minComp(c) < BREAKDOWN_LEVEL || c.coal <= 0.003 || c.water <= 0.003)) {
              if (rng.chance(1 - Math.pow(1 - BREAKDOWN_PER_MIN, dtSim))) doBreakdown(t, worst(c));
            }
          } else if (t.state === 'dwelling') {
            // partial top-up from the platform water column / coal barrow
            if (c.coal < 0.5) c.coal = Math.min(0.62, c.coal + 0.02 * dtSim);
            if (c.water < 0.5) c.water = Math.min(0.68, c.water + 0.03 * dtSim);
          }
        }
        // rescues
        for (const [id, r] of rescues) {
          if (r.done || now() < r.at) continue;
          r.done = true;
          const t = getT(id);
          if (!t) { rescues.delete(id); continue; }
          safe(() => trains().rescue(id), undefined);
          shedRequested.add(id);
          if (!queue.includes(id) && job?.id !== id) { queue.push(id); requestedAt.set(id, now()); }
          gazette(`The breakdown engine is sent out to haul ${label(t).replace(/^The /, 'the ')} to the shed`, 'info');
        }
        // prune stale queue entries
        for (const id of [...queue]) {
          const t = getT(id);
          const age = now() - (requestedAt.get(id) ?? now());
          if (!t || (age > 360 && !arrivedInShed.has(id) && t.state !== 'inShed' && t.state !== 'toShed' && t.state !== 'rescued' && t.state !== 'broken')) forget(id);
        }
        tryStart();
        stepJob(dtSim);
        stepUncoupler();
        const task = job && job.ready ? job.tasks[Math.min(job.ti, job.tasks.length - 1)].kind : null;
        stepCoal(task);
      }
      visuals(dt, dtSim <= 0);
    },
    dispose() {
      for (const f of fitters) dismiss(f);
      if (uncoupler) dismiss(uncoupler);
      board.dispose();
      for (const mk of brokenMarkers.values()) mk.dispose();
      arc.geometry.dispose(); arcMat.dispose();
      group.removeFromParent();
    },
  };
}
