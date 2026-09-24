import type * as THREE from 'three';
import type { AudioCue, Dir, LineId, PlatformId, SignalAspect, Weather } from './types';
import type { SelectKind, VehicleKind, CrossingState } from './apis';

export type { AudioCue, SignalAspect } from './types';

export interface Events {
  'ready': {};
  'time:hour': { hour: number; day: number };
  'weather:changed': { from: Weather; to: Weather };
  'weather:lightning': { pos: THREE.Vector3; intensity: number };
  'train:spawned': { trainId: string };
  'train:despawned': { trainId: string };
  'train:approaching': { trainId: string; line: LineId; platform: PlatformId };
  'train:arrived': { trainId: string; line: LineId; platform: PlatformId; lateMin: number };
  /** whistle moment */
  'train:departing': { trainId: string };
  'train:departed': { trainId: string; line: LineId };
  'train:inShed': { trainId: string };
  'train:repaired': { trainId: string };
  'train:breakdown': { trainId: string; pos: THREE.Vector3 };
  'passenger:boarded': { personId: string; trainId: string };
  'passenger:alighted': { personId: string; trainId: string };
  'passenger:gaveUp': { personId: string };
  'event:started': { id: string; title: string };
  'event:ended': { id: string };
  'gazette': { headline: string; kind: 'info' | 'warn' | 'event' };
  /**
   * kind 'station': id is the pickable id ('building'|'platforms'|'canopies'|'footbridge'|'shed'|'signalbox').
   * v2 kinds: 'vehicle' (traffic id), 'boat' (nature boat id), 'animal' (nature critter id), 'building' (layout building id).
   */
  'select': { kind: SelectKind | null; id: string | null };
  'signal:changed': { line: LineId; end: Dir; aspect: SignalAspect };
  'audio:cue': { cue: AudioCue; pos?: THREE.Vector3; volume?: number };

  // ── v2: living world ──
  /** a vehicle entered the map (portal or depot door) */
  'vehicle:spawned': { vehicleId: string; kind: VehicleKind };
  /** a vehicle reached a stop ('forecourt:drop' | 'forecourt:rank:<n>' | 'forecourt:omnibus' | door origin id | road node) */
  'vehicle:arrived': { vehicleId: string; stop: string };
  'vehicle:departed': { vehicleId: string; stop: string };
  'vehicle:despawned': { vehicleId: string };
  /** level-crossing gates ('open' = open to road) */
  'crossing:state': { id: string; state: CrossingState };
  'boat:moored': { boatId: string; where: string };
  'boat:departed': { boatId: string; where: string };
  /** a flock / herd finished moving */
  'animal:herded': { kind: string; to: string; tag?: string };
  /** something startled animals (whistle, motor, gunshot) — nature & traffic react */
  'animal:scared': { pos: THREE.Vector3; radius: number };
  /** a person faded in/out through a door (for chimney/occupancy/audio) */
  'person:door': { personId: string; originId: string; dir: 'in' | 'out' };
  /** a gas lamp was lit (on) or put out */
  'lamp:lit': { index: number; on: boolean };
  /** church / town bells: 'hour' strikes, Sunday 'peal', 'wedding' peal, fire 'alarm' */
  'town:bell': { kind: 'hour' | 'peal' | 'wedding' | 'alarm'; town: string };
  /** weekly rhythm hooks (people / traffic / nature scale activity) */
  'town:day': { weekday: number; kind: 'washday' | 'dray' | 'drover' | 'market' | 'regatta' | 'sunday' | 'ordinary' };
}

export type EventKey = keyof Events;
type Handler<K extends EventKey> = (payload: Events[K]) => void;

/** Typed synchronous pub/sub. Handler exceptions are caught and logged so one listener can't break others. */
export class EventBus {
  private map = new Map<EventKey, Set<Handler<any>>>();

  on<K extends EventKey>(k: K, fn: Handler<K>): () => void {
    let set = this.map.get(k);
    if (!set) { set = new Set(); this.map.set(k, set); }
    set.add(fn);
    return () => this.off(k, fn);
  }

  off<K extends EventKey>(k: K, fn: Handler<K>): void {
    this.map.get(k)?.delete(fn);
  }

  once<K extends EventKey>(k: K, fn: Handler<K>): () => void {
    const wrap: Handler<K> = (p) => { this.off(k, wrap); fn(p); };
    return this.on(k, wrap);
  }

  emit<K extends EventKey>(k: K, payload: Events[K]): void {
    const set = this.map.get(k);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error(`[bus] handler for '${k}' threw`, e); }
    }
  }
}
