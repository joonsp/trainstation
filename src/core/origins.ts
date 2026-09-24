import * as THREE from 'three';
import type { Layout } from './layout';
import type { PersonRole } from './apis';

/**
 * ORIGINS & THE NO-POP-IN AUDIT (v2).
 *
 * HARD RULE: no person, animal, vehicle or boat may appear or vanish in the visible playfield. Spawning /
 * despawning only happens at a LEGITIMATE origin: a map-edge portal (roads, paths, river, rail tunnels), a building
 * door (fade through the doorway), a stopped vehicle, a moored boat, or a train door while dwelling.
 *
 * - `ctx.origins` is created by main.ts and pre-filled with every static door and portal from `layout.origins`.
 * - Systems register dynamic origins (train doors while dwelling, stopped vehicles, moored boats) with `add()`.
 * - EVERY spawn / despawn of a living thing must call `audit()`; it returns whether the point is legitimate and
 *   counts a pop-in otherwise (only after the first rendered frame — warm-start placement is exempt).
 *   `__station.stats().popIns` shows the counters; `?debug=popins` logs each violation to the console.
 * - `pools` tracks how many residents are "inside" each building so townsfolk leave from and return to
 *   the right doors (a cottage can't emit more people than live there).
 */
export type OriginKind = 'portal' | 'door' | 'vehicle' | 'train' | 'boat' | 'tunnel';
export type LifeKind = 'people' | 'vehicles' | 'boats' | 'animals';

export interface Origin {
  /** e.g. 'portal:E1', 'door:ashcombe:post:0', 'veh:V12', 'train:T3:d4', 'boat:B2' */
  id: string;
  kind: OriginKind;
  /** registering system */
  owner: string;
  /** LIVE position of the threshold (vehicle/train doors move) */
  pos(out: THREE.Vector3): THREE.Vector3;
  /** point just inside (fade target) */
  inside?(out: THREE.Vector3): THREE.Vector3;
  /** metres around pos within which spawn/despawn counts as "at" this origin */
  radius: number;
  for: LifeKind[];
  /** restricted to these roles (staff doors) */
  roles?: PersonRole[];
  /** train doors only while doorsOpen, vehicles only while stopped, boats only while moored */
  open(): boolean;
  building?: string;
}

export interface PopInEntry { t: number; system: string; what: 'spawn' | 'despawn'; kind: LifeKind; label?: string; pos: [number, number, number] }

export interface OriginRegistry {
  add(o: Origin): () => void;
  remove(id: string): void;
  get(id: string): Origin | undefined;
  list(f?: { kind?: OriginKind; for?: LifeKind; near?: THREE.Vector3; maxDist?: number; open?: boolean }): Origin[];
  /** nearest open origin serving `forKind` (optionally within maxDist) */
  nearest(p: THREE.Vector3, forKind: LifeKind, opts?: { kinds?: OriginKind[]; maxDist?: number; role?: PersonRole }): Origin | null;
  /** best origin to walk to `target` from (fewest walking metres along layout.walk), or null */
  bestFor(target: THREE.Vector3, forKind: LifeKind, opts?: { kinds?: OriginKind[]; exclude?: string[]; role?: PersonRole }): Origin | null;
  /** the legitimate origin covering p (within its radius + slack), or null */
  legit(p: THREE.Vector3, forKind: LifeKind, slack?: number): Origin | null;
  /**
   * EVERY spawn/despawn calls this. Returns true when legit. Counts a pop-in when not legit, the point is on
   * screen (ctx.view.isVisible) and the first frame has been rendered. Off-screen violations are counted
   * separately in `offscreen` (still bugs, but not visible).
   */
  audit(system: string, what: 'spawn' | 'despawn', forKind: LifeKind, p: THREE.Vector3, label?: string): boolean;
  readonly popIns: Record<LifeKind, number>;
  readonly offscreen: Record<LifeKind, number>;
  /** last 50 violations */
  readonly log: PopInEntry[];
  /** set by main.ts after the first rendered frame; before that audit() never counts */
  armed: boolean;
  pools: {
    /** residents currently inside building id */
    count(building: string): number;
    /** n people went inside (after a door fade) */
    enter(building: string, n?: number): void;
    /** take up to n people out (returns how many were available) */
    take(building: string, n?: number): number;
  };
}

export function createOrigins(layout: Layout, deps: { isVisible: (p: THREE.Vector3, m?: number) => boolean; now: () => number; debug: boolean }): OriginRegistry {
  const map = new Map<string, Origin>();
  const popIns: Record<LifeKind, number> = { people: 0, vehicles: 0, boats: 0, animals: 0 };
  const offscreen: Record<LifeKind, number> = { people: 0, vehicles: 0, boats: 0, animals: 0 };
  const log: PopInEntry[] = [];
  const inside = new Map<string, number>();
  const _p = new THREE.Vector3();

  // static doors & portals from the layout
  for (const so of layout.origins) {
    const pos = so.pos.clone(), ins = so.inside?.clone();
    map.set(so.id, {
      id: so.id, kind: so.kind, owner: 'layout',
      pos: (o) => o.copy(pos), inside: ins ? (o) => o.copy(ins) : undefined,
      radius: so.kind === 'portal' ? 14 : 2.2,
      for: so.for as LifeKind[], roles: so.staffOnly ? ['porter', 'stationmaster', 'guard', 'mechanic', 'clerk', 'signalman', 'crew'] as PersonRole[] : undefined,
      open: () => true, building: so.building,
    });
  }
  // rail tunnels: trains (and anything riding them) enter/leave here
  for (const p of layout.portals) if (p.kind === 'rail') {
    const pos = p.pos.clone();
    map.set(`tunnel:${p.id}`, { id: `tunnel:${p.id}`, kind: 'tunnel', owner: 'layout', pos: (o) => o.copy(pos), radius: 40, for: ['people', 'vehicles', 'animals'], open: () => true });
  }
  // station building & cottages start with their residents inside
  for (const b of layout.buildings) inside.set(b.id, b.residents);
  inside.set('station', 999);

  const R: OriginRegistry = {
    armed: false,
    popIns, offscreen, log,
    add(o) { map.set(o.id, o); return () => { if (map.get(o.id) === o) map.delete(o.id); }; },
    remove(id) { map.delete(id); },
    get: (id) => map.get(id),
    list(f) {
      const out: Origin[] = [];
      for (const o of map.values()) {
        if (f?.kind && o.kind !== f.kind) continue;
        if (f?.for && !o.for.includes(f.for)) continue;
        if (f?.open && !o.open()) continue;
        if (f?.near && f.maxDist !== undefined && o.pos(_p).distanceTo(f.near) > f.maxDist) continue;
        out.push(o);
      }
      return out;
    },
    nearest(p, forKind, opts) {
      let best: Origin | null = null, bd = (opts?.maxDist ?? Infinity) ** 2;
      for (const o of map.values()) {
        if (!o.for.includes(forKind) || !o.open()) continue;
        if (opts?.kinds && !opts.kinds.includes(o.kind)) continue;
        // role-restricted origins (staff doors, a loco's cab) only serve callers that name a matching role
        if (o.roles && (!opts?.role || !o.roles.includes(opts.role))) continue;
        o.pos(_p);
        const d = (_p.x - p.x) ** 2 + (_p.z - p.z) ** 2;
        if (d < bd) { bd = d; best = o; }
      }
      return best;
    },
    bestFor(target, forKind, opts) {
      // prefilter the 8 nearest by straight line, then rank by walking length
      const cands: { o: Origin; d: number }[] = [];
      for (const o of map.values()) {
        if (!o.for.includes(forKind) || !o.open()) continue;
        if (opts?.kinds && !opts.kinds.includes(o.kind)) continue;
        if (opts?.exclude?.includes(o.id)) continue;
        if (o.roles && (!opts?.role || !o.roles.includes(opts.role))) continue;
        cands.push({ o, d: o.pos(_p).distanceTo(target) });
      }
      cands.sort((a, b) => a.d - b.d);
      let best: Origin | null = null, bl = Infinity;
      for (const c of cands.slice(0, 8)) {
        const l = layout.walk.length(c.o.pos(new THREE.Vector3()), target);
        if (l < bl) { bl = l; best = c.o; }
      }
      return best;
    },
    legit(p, forKind, slack = 2) {
      for (const o of map.values()) {
        if (!o.for.includes(forKind) || !o.open()) continue;
        o.pos(_p);
        if (Math.hypot(_p.x - p.x, _p.z - p.z) <= o.radius + slack) return o;
      }
      // anything beyond the playfield edge is off-map by construction
      if (Math.max(Math.abs(p.x), Math.abs(p.z)) > layout.terrain.half + 10) return map.get('portal:E1') ?? null;
      return null;
    },
    audit(system, what, forKind, p, label) {
      if (R.legit(p, forKind)) return true;
      if (!R.armed) return false;
      const vis = deps.isVisible(p, 3);
      if (vis) popIns[forKind]++; else offscreen[forKind]++;
      const e: PopInEntry = { t: deps.now(), system, what, kind: forKind, label, pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)] };
      log.push(e);
      if (log.length > 50) log.shift();
      if (deps.debug) console.warn(`[popin] ${vis ? 'VISIBLE' : 'offscreen'} ${what} of ${forKind} by ${system}${label ? ` (${label})` : ''} at`, e.pos);
      return false;
    },
    pools: {
      count: (b) => inside.get(b) ?? 0,
      enter(b, n = 1) { inside.set(b, (inside.get(b) ?? 0) + n); },
      take(b, n = 1) { const have = inside.get(b) ?? 0; const k = Math.min(have, n); inside.set(b, have - k); return k; },
    },
  };
  return R;
}
