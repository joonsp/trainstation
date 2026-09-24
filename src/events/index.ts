/**
 * Random events: scheduler, gazette history, EventsAPI.
 *
 * - Every sim minute (when api.auto) roll for a new event, weighted by each event's weight() among those whose
 *   condition() holds and whose cooldown elapsed; max 2 concurrent auto events, 30 sim-min global breather.
 * - trigger(id) forces an event (runs prepare() first, e.g. the ghost forces fog). Up to 4 concurrent when forced.
 * - Gazette: listens to ALL 'gazette' bus events (any system), stamps with clock.format(); history is
 *   chronological (oldest first), capped at 200.
 * - ?noevents=1 disables the auto scheduler (handy for screenshots).
 */
import type { Ctx, System } from '../core/types';
import type { SimClock } from '../core/clock';
import type { EventMeta, EventsAPI } from '../core/apis';
import { getFx } from './fx';
import { getLinger } from './critter';
import type { EventDef, EventEnv, EventInstance } from './base';
import { animalEvents } from './defs/animals';
import { ceremonyEvents } from './defs/ceremonies';
import { mischiefEvents } from './defs/mischief';
import { weatherEvents } from './defs/weatherish';
import { riverEvents } from './defs/river';
import { countryEvents } from './defs/country';
import { townEvents } from './defs/town';

const MAX_AUTO = 2;
const MAX_FORCED = 4;
/** chance per sim minute that the scheduler tries to start something */
const ROLL_PER_MIN = 1 / 70;
const GLOBAL_GAP = 30;
const GAZETTE_CAP = 200;

interface Running { def: EventDef; inst: EventInstance; startedAt: number }

export function createEvents(ctx: Ctx): System {
  const rng = ctx.rng.fork(0xe7e7);
  const fx = getFx(ctx);
  const linger = getLinger(ctx);
  const history: { time: string; headline: string; kind: string }[] = [];

  const env: EventEnv = {
    ctx, rng, fx,
    gazette: (headline, kind = 'event') => ctx.bus.emit('gazette', { headline, kind }),
  };

  ctx.bus.on('gazette', (g) => {
    history.push({ time: ctx.clock.format(), headline: g.headline, kind: g.kind });
    if (history.length > GAZETTE_CAP) history.splice(0, history.length - GAZETTE_CAP);
  });

  const pick = (list: EventDef[], id: string) => list.find((d) => d.id === id)!;
  const defs: EventDef[] = [
    // the station classics (v1, now origin-based)
    pick(animalEvents, 'goose'),
    pick(animalEvents, 'cat'),
    pick(ceremonyEvents, 'royal'),
    pick(mischiefEvents, 'pickpocket'),
    pick(animalEvents, 'cow'),
    pick(weatherEvents, 'signalStrike'),
    pick(animalEvents, 'circus'),
    pick(weatherEvents, 'ghost'),
    pick(weatherEvents, 'snowdrift'),
    pick(mischiefEvents, 'lostLuggage'),
    pick(ceremonyEvents, 'wedding'),
    pick(weatherEvents, 'balloon'),
    pick(ceremonyEvents, 'bandConcert'),
    // v2: the living countryside
    pick(countryEvents, 'motorwagen'),
    pick(countryEvents, 'runaway'),
    pick(countryEvents, 'sheep'),
    pick(townEvents, 'market'),
    pick(riverEvents, 'regatta'),
    pick(riverEvents, 'angling'),
    pick(countryEvents, 'rickFire'),
    pick(riverEvents, 'frostFair'),
    pick(countryEvents, 'kite'),
    pick(riverEvents, 'swan'),
    pick(townEvents, 'fete'),
    pick(mischiefEvents, 'lostDog'),
  ];
  const byId = new Map(defs.map((d) => [d.id, d]));
  const lastRun = new Map<string, number>();
  const running: Running[] = [];
  let lastAnyStart = -1e9;
  let rollAcc = 0;

  const available = (d: EventDef) => {
    try { return d.condition(env); } catch { return false; }
  };

  const start = (d: EventDef, forced: boolean): boolean => {
    if (running.some((r) => r.def.id === d.id)) return false;
    if (running.length >= (forced ? MAX_FORCED : MAX_AUTO)) return false;
    if (forced && d.prepare) { try { d.prepare(env); } catch (e) { console.error('[events] prepare', d.id, e); } }
    let inst: EventInstance;
    try {
      inst = d.create(env);
      running.push({ def: d, inst, startedAt: ctx.clock.minutes });
      lastRun.set(d.id, ctx.clock.minutes);
      lastAnyStart = ctx.clock.minutes;
      ctx.bus.emit('event:started', { id: d.id, title: d.title });
      inst.start();
    } catch (e) {
      console.error('[events] failed to start', d.id, e);
      const i = running.findIndex((r) => r.def.id === d.id);
      if (i >= 0) { try { running[i].inst.end(); } catch { /* ignore */ } running.splice(i, 1); ctx.bus.emit('event:ended', { id: d.id }); }
      return false;
    }
    return true;
  };

  const finish = (r: Running) => {
    try { r.inst.end(); } catch (e) { console.error('[events] end', r.def.id, e); }
    const i = running.indexOf(r);
    if (i >= 0) running.splice(i, 1);
    ctx.bus.emit('event:ended', { id: r.def.id });
  };

  const api: EventsAPI = {
    catalog: (): EventMeta[] => defs.map((d) => ({ id: d.id, title: d.title, blurb: d.blurb, available: available(d) })),
    active: () => running.map((r) => ({ id: r.def.id, title: r.def.title, startedAt: r.startedAt })),
    trigger: (id: string) => {
      const d = byId.get(id);
      if (!d) return false;
      return start(d, true);
    },
    auto: ctx.params.raw.get('noevents') !== '1',
    gazette: () => history.slice(),
    /** extra (not in contract yet): world position of an active event's focal point */
    focusOf: (id: string) => {
      const r = running.find((x) => x.def.id === id);
      try { return r?.inst.focus?.() ?? null; } catch { return null; }
    },
  };
  ctx.reg.events = api;

  const reported = new Set<string>();

  // ── weekly rhythm (V2_DESIGN §4.6.6): town:day at midnight, St Mary's strikes the hours, Sunday peal at 10:30 ──
  const DAY_KIND = ['washday', 'dray', 'drover', 'market', 'dray', 'regatta', 'sunday'] as const;
  const emitDay = () => ctx.bus.emit('town:day', { weekday: ctx.clock.weekday, kind: DAY_KIND[ctx.clock.weekday] ?? 'ordinary' });
  let lastDay = -1, pealDay = -1;
  ctx.bus.on('time:hour', (e) => {
    if (e.hour >= 7 && e.hour <= 21) ctx.bus.emit('town:bell', { kind: 'hour', town: 'ashcombe' });
  });
  ctx.bus.on('ready', () => { lastDay = ctx.clock.day; emitDay(); });

  return {
    name: 'events',
    update(dt: number, clock: SimClock) {
      const dtSim = clock.dtSim;
      if (clock.day !== lastDay && lastDay >= 0) { lastDay = clock.day; emitDay(); }
      if (clock.weekday === 6 && clock.hour >= 10.5 && clock.hour < 10.6 && pealDay !== clock.day) { pealDay = clock.day; ctx.bus.emit('town:bell', { kind: 'peal', town: 'ashcombe' }); }
      fx.update(dt);
      linger.update(dt, clock.dtMotion);
      for (const r of [...running]) {
        let done = false;
        try { done = r.inst.update(dt, dtSim, clock.dtMotion); } catch (e) {
          const k = r.def.id + String(e);
          if (!reported.has(k)) { reported.add(k); console.error('[events] update', r.def.id, e); }
          done = true;
        }
        if (done) finish(r);
      }
      if (!api.auto || dtSim <= 0) return;
      rollAcc += dtSim;
      while (rollAcc >= 1) {
        rollAcc -= 1;
        if (running.length >= MAX_AUTO) continue;
        if (clock.minutes - lastAnyStart < GLOBAL_GAP) continue;
        if (!rng.chance(ROLL_PER_MIN)) continue;
        const cands = defs.filter((d) => {
          if (running.some((r) => r.def.id === d.id)) return false;
          const lr = lastRun.get(d.id);
          if (lr !== undefined && clock.minutes - lr < d.cooldown) return false;
          return available(d);
        }).map((d) => ({ w: Math.max(0, d.weight ? d.weight(env) : 1), v: d })).filter((c) => c.w > 0);
        if (!cands.length) continue;
        start(rng.weighted(cands), false);
      }
    },
    dispose() { for (const r of [...running]) finish(r); },
  };
}
