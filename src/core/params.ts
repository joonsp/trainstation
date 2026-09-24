import type { Weather } from './types';
import { WEATHERS } from './types';

export interface DebugParams {
  /** start hour (float) */
  time?: number;
  weather?: Weather;
  /** clock.timeScale */
  speed?: number;
  seed: number;
  /** event id to trigger ~2 s after start */
  event?: string;
  cam?: 'iso' | 'persp';
  /** sim minutes to fast-forward at start */
  advance?: number;
  mute: boolean;
  noui: boolean;
  select?: 'train' | 'person';
  /** 'layout' draws layout debug geometry */
  debug?: string;
  /** raw query parameters for ad-hoc flags */
  raw: URLSearchParams;
}

export function parseParams(search: string = typeof location !== 'undefined' ? location.search : ''): DebugParams {
  const q = new URLSearchParams(search);
  const num = (k: string): number | undefined => {
    const v = q.get(k);
    if (v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const w = q.get('weather');
  const cam = q.get('cam');
  const sel = q.get('select');
  return {
    time: num('time'),
    weather: w && (WEATHERS as string[]).includes(w) ? (w as Weather) : undefined,
    speed: num('speed'),
    seed: Math.floor(num('seed') ?? 1),
    event: q.get('event') || undefined,
    cam: cam === 'iso' || cam === 'persp' ? cam : undefined,
    advance: num('advance'),
    mute: q.get('mute') === '1',
    noui: q.get('noui') === '1',
    select: sel === 'train' || sel === 'person' ? sel : undefined,
    debug: q.get('debug') || undefined,
    raw: q,
  };
}
