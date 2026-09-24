import type { CarType, Condition, TrainInfo } from '../core/apis';
import type { Dir, LineId } from '../core/types';
import type { Rng } from '../core/rng';
import { SPECS, type LiveryId } from './cars';

export type TrainKind = TrainInfo['kind'];

export interface CarPlan { type: CarType; livery: LiveryId; variant: number; flipped?: boolean }

/** A named locomotive. Its Condition object persists between services (shared with TrainInfo.condition). */
export interface Loco {
  name: string;
  type: 'loco_express' | 'loco_tank';
  home: LineId;
  condition: Condition;
  busy: boolean;
}

const EXPRESS_NAMES: Record<LineId, string[]> = {
  coast: ['Duchess of Albany', 'Iron Duke', 'Lord of the Isles', 'Princess Beatrice', 'Queen Empress', 'Hardwicke', 'Tamerlane'],
  highland: ['Lady of the Lake', 'Sir Walter Scott', 'Ben Nevis', 'Glen Douglas', 'Loch Ness', 'Cairngorm', 'Monarch of the Glen'],
};
const TANK_NAMES: Record<LineId, string[]> = {
  coast: ['Terrier', 'Fenchurch', 'Stepney', 'Morning Star'],
  highland: ['Thistle', 'Cromarty', 'Bluebell', 'Primrose'],
};

export function createLocoPool(rng: Rng): Loco[] {
  const pool: Loco[] = [];
  const cond = (): Condition => ({
    boiler: rng.range(0.6, 1), brakes: rng.range(0.6, 1), wheels: rng.range(0.6, 1),
    coal: rng.range(0.7, 1), water: rng.range(0.7, 1),
  });
  for (const line of ['coast', 'highland'] as LineId[]) {
    for (const name of EXPRESS_NAMES[line]) pool.push({ name, type: 'loco_express', home: line, condition: cond(), busy: false });
    for (const name of TANK_NAMES[line]) pool.push({ name, type: 'loco_tank', home: line, condition: cond(), busy: false });
  }
  return pool;
}

let spare = 0;
/** Pick a free loco of the wanted type, preferring the line's own engines; never fails. */
export function takeLoco(pool: Loco[], rng: Rng, line: LineId, type: 'loco_express' | 'loco_tank'): Loco {
  const free = (f: (l: Loco) => boolean) => pool.filter((l) => !l.busy && f(l));
  let cands = free((l) => l.type === type && l.home === line);
  if (!cands.length) cands = free((l) => l.type === type);
  if (!cands.length) cands = free(() => true);
  let loco: Loco;
  if (cands.length) {
    // prefer the healthiest engines for service (maintenance loves this)
    cands.sort((a, b) => health(b) - health(a));
    loco = rng.chance(0.7) ? cands[0] : rng.pick(cands);
  } else {
    loco = {
      name: `No. ${++spare + 100}`, type, home: line, busy: false,
      condition: { boiler: 0.9, brakes: 0.9, wheels: 0.9, coal: 1, water: 1 },
    };
    pool.push(loco);
  }
  loco.busy = true;
  return loco;
}

export function health(l: Loco): number {
  const c = l.condition;
  return Math.min(c.boiler, c.brakes, c.wheels) * 0.7 + Math.min(c.coal, c.water) * 0.3;
}

/** loco (+ tender) car plans for a named engine */
export function locoCars(loco: Loco, livery: LiveryId): CarPlan[] {
  return loco.type === 'loco_express'
    ? [{ type: 'loco_express', livery, variant: 0 }, { type: 'tender', livery, variant: 0 }]
    : [{ type: 'loco_tank', livery, variant: 0 }];
}

/** v2 (issue 3): Highland trains stand at Platform 2 with the engine ≥ 30 m in from its west end (clear of the
 * station building); only ~80 m then fits, so Highland passenger consists are capped here. */
/** stopping Highland trains: westbound they stand ≥ 48 m in from P2's west end (issue 3), so ~62 m fits; the guard's van may overhang */
export const HIGHLAND_MAX_LEN = 68;
export const planLength = (cars: CarPlan[]) => cars.reduce((a, c) => a + SPECS[c.type].len, 0);

/** drop coaches from the rear of the body (keeping the guard's van last) until the train fits `max` metres */
export function trimToLength(cars: CarPlan[], max: number): CarPlan[] {
  const out = cars.slice();
  while (planLength(out) > max) {
    let i = -1;
    for (let k = out.length - 1; k >= 0; k--) {
      const t = out[k].type;
      if (t === 'coach_second' || t === 'coach_third' || t === 'mail') { i = k; break; }
    }
    if (i < 0) for (let k = out.length - 1; k >= 0; k--) if (out[k].type === 'coach_first' || out[k].type === 'dining') { i = k; break; }
    if (i < 0) { const g = out.findIndex((c) => c.type === 'guard'); if (g >= 0) i = g; }
    if (i < 0) break;
    out.splice(i, 1);
  }
  return out;
}

export function buildConsist(kind: TrainKind | 'mail', line: LineId, rng: Rng, loco: Loco): CarPlan[] {
  const cars = buildConsistRaw(kind, line, rng, loco);
  return line === 'highland' && kind !== 'freight' ? trimToLength(cars, HIGHLAND_MAX_LEN) : cars;
}

function buildConsistRaw(kind: TrainKind | 'mail', line: LineId, rng: Rng, loco: Loco): CarPlan[] {
  const liv: LiveryId = line;
  const cars: CarPlan[] = locoCars(loco, kind === 'freight' ? liv : liv);
  const c = (type: CarType, livery: LiveryId = liv): CarPlan => ({ type, livery, variant: rng.int(0, 3) });
  if (kind === 'express') {
    const n = rng.int(4, 6);
    const body: CarType[] = ['coach_first', 'coach_first', 'dining'];
    while (body.length < n) body.push(rng.chance(0.5) ? 'coach_second' : 'coach_third');
    // firsts near the front, dining in the middle, thirds at the back
    const order: Record<string, number> = { coach_first: 0, dining: 1, coach_second: 2, coach_third: 3 };
    body.sort((a, b) => order[a] - order[b]);
    for (const t of body) cars.push(c(t));
    if (rng.chance(0.5)) cars.push(c('guard'));
  } else if (kind === 'local') {
    const n = rng.int(2, 3);
    for (let i = 0; i < n; i++) cars.push(c(i === 0 && rng.chance(0.5) ? 'coach_second' : 'coach_third'));
    cars.push(c('guard'));
  } else if (kind === 'mail') {
    cars.push(c('mail'), c('mail'), c('coach_second'), c('guard'));
  } else if (kind === 'freight') {
    const n = rng.int(5, 8);
    const mixT = rng.weighted<CarType[]>([
      { w: 3, v: ['wagon_coal'] }, { w: 2, v: ['wagon_box', 'wagon_coal'] },
      { w: 2, v: ['wagon_box', 'wagon_flat', 'wagon_tank'] }, { w: 1, v: ['wagon_tank'] },
    ]);
    for (let i = 0; i < n; i++) cars.push(c(rng.pick(mixT), 'freight'));
    cars.push(c('guard', 'freight'));
  }
  return cars;
}

export function specialConsist(special: string, line: LineId, rng: Rng, loco: Loco): { cars: CarPlan[]; livery: LiveryId } {
  const c = (type: CarType, livery: LiveryId, variant = rng.int(0, 3)): CarPlan => ({ type, livery, variant });
  if (special === 'royal') {
    const cars = locoCars(loco, 'royal');
    cars.push(c('coach_first', 'royal'), c('royal_saloon', 'royal'), c('coach_first', 'royal'), c('guard', 'royal'));
    return { cars, livery: 'royal' };
  }
  if (special === 'circus') {
    const cars = locoCars(loco, 'circus');
    cars.push(c('coach_third', 'circus'), c('circus_cage', 'circus', 0), c('circus_cage', 'circus', 1), c('wagon_flat', 'circus', 0), c('circus_cage', 'circus', 2), c('wagon_flat', 'circus', 1), c('guard', 'circus'));
    return { cars, livery: 'circus' };
  }
  if (special === 'ghost') {
    const cars = locoCars(loco, line);
    cars.push(c('coach_first', line), c('coach_third', line), c('coach_third', line), c('guard', line));
    return { cars, livery: line };
  }
  if (special === 'freight') return { cars: buildConsist('freight', line, rng, loco), livery: line };
  return { cars: buildConsist('local', line, rng, loco), livery: line };
}

// ───────────────────────── service names ─────────────────────────

const EXPRESS_TITLES: Record<LineId, Record<Dir, string[]>> = {
  coast: { east: ['The Kingsport Flyer', 'Kingsport Express'], west: ['The Brightmouth Belle', 'Brightmouth Express'] },
  highland: { east: ['The Glenmoor Highlander', 'Glenmoor Express'], west: ['The Ashby Vale Express', 'The Vale Limited'] },
};

export function serviceName(kind: TrainKind | 'mail', line: LineId, dir: Dir, dest: string, rng: Rng): string {
  if (kind === 'express') return rng.pick(EXPRESS_TITLES[line][dir]);
  if (kind === 'mail') return 'The Night Mail';
  if (kind === 'freight') return `Goods for ${dest}`;
  return `${dest} Stopping Train`;
}
