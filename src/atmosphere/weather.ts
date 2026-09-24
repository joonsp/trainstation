import type { Weather } from '../core/types';
import type { Rng } from '../core/rng';

/** Continuous weather parameters; every weather type is a point in this space and transitions lerp between. */
export interface WeatherMix {
  /** cloud cover 0..1 */
  cloud: number;
  /** cloud darkness 0 (white fluffy) .. 1 (storm slate) */
  gloom: number;
  rain: number;
  snow: number;
  fog: number;
  /** mean wind speed m/s */
  wind: number;
  /** direct sun multiplier */
  sun: number;
  /** lightning likelihood 0..1 */
  lightning: number;
  /** temperature offset vs the clear-sky diurnal curve */
  temp: number;
}

export const PROFILES: Record<Weather, WeatherMix> = {
  clear:    { cloud: 0.13, gloom: 0.0,  rain: 0,    snow: 0, fog: 0.0,  wind: 2.2, sun: 1.0,  lightning: 0, temp: 0 },
  overcast: { cloud: 0.85, gloom: 0.35, rain: 0,    snow: 0, fog: 0.08, wind: 4.0, sun: 0.3,  lightning: 0, temp: -2 },
  rain:     { cloud: 0.95, gloom: 0.6,  rain: 0.62, snow: 0, fog: 0.16, wind: 5.5, sun: 0.16, lightning: 0, temp: -4 },
  storm:    { cloud: 1.0,  gloom: 1.0,  rain: 1.0,  snow: 0, fog: 0.22, wind: 12,  sun: 0.07, lightning: 1, temp: -5 },
  fog:      { cloud: 0.4,  gloom: 0.2,  rain: 0,    snow: 0, fog: 1.0,  wind: 0.7, sun: 0.35, lightning: 0, temp: -3 },
  snow:     { cloud: 0.9,  gloom: 0.3,  rain: 0,    snow: 1, fog: 0.3,  wind: 3.2, sun: 0.3,  lightning: 0, temp: -17 },
};

const KEYS: (keyof WeatherMix)[] = ['cloud', 'gloom', 'rain', 'snow', 'fog', 'wind', 'sun', 'lightning', 'temp'];

/** Markov transition weights for the automatic weather. */
const NEXT: Record<Weather, { w: number; v: Weather }[]> = {
  clear:    [{ w: 4, v: 'overcast' }, { w: 1.2, v: 'fog' }, { w: 1, v: 'rain' }, { w: 0.35, v: 'snow' }],
  overcast: [{ w: 3, v: 'clear' }, { w: 3, v: 'rain' }, { w: 0.8, v: 'storm' }, { w: 0.8, v: 'snow' }, { w: 0.8, v: 'fog' }],
  rain:     [{ w: 3, v: 'overcast' }, { w: 1.2, v: 'storm' }, { w: 1.5, v: 'clear' }],
  storm:    [{ w: 3, v: 'rain' }, { w: 1, v: 'overcast' }],
  fog:      [{ w: 2.5, v: 'clear' }, { w: 2, v: 'overcast' }, { w: 0.4, v: 'rain' }],
  snow:     [{ w: 2, v: 'overcast' }, { w: 1, v: 'clear' }, { w: 0.5, v: 'fog' }],
};

/** How long a spell of each weather lasts (sim minutes). */
const SPELL: Record<Weather, [number, number]> = {
  clear: [150, 420], overcast: [90, 260], rain: [70, 220], storm: [35, 100], fog: [60, 180], snow: [90, 260],
};

const smooth = (t: number) => t * t * (3 - 2 * t);

export class WeatherMachine {
  weather: Weather = 'clear';
  target: Weather = 'clear';
  auto = true;
  readonly mix: WeatherMix = { ...PROFILES.clear };
  private from: WeatherMix = { ...PROFILES.clear };
  /** 0..1 transition progress */
  private progress = 1;
  private duration = 30;
  /** sim minutes until the automatic system picks the next weather */
  spellLeft: number;

  constructor(private rng: Rng, private onDominantChange: (from: Weather, to: Weather) => void) {
    this.spellLeft = rng.range(120, 300);
  }

  set(w: Weather, instant = false): void {
    // snapshot where we are so an interrupted transition stays continuous
    Object.assign(this.from, this.mix);
    this.target = w;
    const [a, b] = SPELL[w];
    this.spellLeft = this.rng.range(a, b);
    if (instant) {
      this.progress = 1;
      Object.assign(this.mix, PROFILES[w]);
      this.setDominant(w);
    } else {
      this.progress = 0;
      this.duration = this.rng.range(20, 40);
    }
  }

  private setDominant(w: Weather) {
    if (w === this.weather) return;
    const from = this.weather;
    this.weather = w;
    this.onDominantChange(from, w);
  }

  /** dtSim in sim minutes; hour for time-of-day biases (fog likes mornings, snow likes cold). */
  update(dtSim: number, hour: number, temperatureC: number): void {
    if (dtSim <= 0) return;
    if (this.progress < 1) {
      this.progress = Math.min(1, this.progress + dtSim / this.duration);
      const s = smooth(this.progress);
      const to = PROFILES[this.target];
      for (const k of KEYS) this.mix[k] = this.from[k] + (to[k] - this.from[k]) * s;
      if (this.progress >= 0.5) this.setDominant(this.target);
    }
    if (!this.auto) return;
    this.spellLeft -= dtSim;
    if (this.spellLeft <= 0 && this.progress >= 1) {
      const morning = hour > 4 && hour < 10;
      const opts = NEXT[this.weather].map((o) => {
        let w = o.w;
        if (o.v === 'fog') w *= morning ? 2.2 : 0.5;
        if (o.v === 'snow') w *= temperatureC < 6 ? 2.5 : 0.25;
        if (o.v === 'storm') w *= hour > 12 && hour < 21 ? 1.6 : 0.7;
        return { w, v: o.v };
      });
      this.set(this.rng.weighted(opts));
    }
  }
}

const HEADLINES: Record<Weather, string[]> = {
  clear: ['Skies clear over the junction', 'Sunshine returns to the platforms', 'Fair weather forecast for all lines'],
  overcast: ['Clouds gather over the Highland hills', 'A grey sky settles over the station', 'Leaden skies, but the trains run on'],
  rain: ['Rain sets in; porters issue umbrellas', 'Showers dampen the platforms', 'Drizzle drifts in from the coast'],
  storm: ['Thunderstorm lashes the junction!', 'Tempest rattles the canopy glass', 'Lightning over the Coast Line: passengers urged to shelter'],
  fog: ['Fog rolls in off the estuary', 'A pea-souper descends upon the junction', 'Drivers slow to a crawl in thick fog'],
  snow: ['Snow blankets the line', 'First flakes of winter fall on the junction', 'Snowfall: porters out with shovels'],
};

const CLEAR_NIGHT = ['Stars out over a clear night', 'A crisp, starry night over the junction'];

export function headlineFor(w: Weather, rng: Rng, night: boolean): { headline: string; kind: 'info' | 'warn' } {
  const pool = w === 'clear' && night ? CLEAR_NIGHT : HEADLINES[w];
  return { headline: rng.pick(pool), kind: w === 'storm' || w === 'fog' || w === 'snow' ? 'warn' : 'info' };
}
