import type * as THREE from 'three';
import type { AudioCue, Dir, LineId, PlatformId, SignalAspect, Weather } from './types';

/*
 * SYSTEM APIs. Every system assigns its API to ctx.reg.<slot> during create<Name>(ctx).
 * v2 additions are marked "v2". Members an owner has not implemented yet are stubbed in that system's index.ts
 * with a "V2 STUB — owner replaces" comment; the stubs are safe no-ops so callers never need optional chaining.
 */

// ───────────────────────── Atmosphere ─────────────────────────
export interface AtmosphereAPI {
  /** current dominant weather */
  weather: Weather;
  /** weather being transitioned to */
  target: Weather;
  setWeather(w: Weather, instant?: boolean): void;
  /** random weather changes on/off */
  auto: boolean;
  /** 0 full day .. 1 full night */
  nightFactor: number;
  /** unit vector pointing TOWARD the sun (or moon at night) — the TRUE sun (sky glow, shadows follow keyLightDir) */
  sunDir: THREE.Vector3;
  /** 0..1 intensities */
  rain: number;
  snow: number;
  fog: number;
  /** m/s, x/z world plane; drives smoke and (through ctx.wind) all foliage */
  wind: THREE.Vector2;
  temperatureC: number;
  /** 0..1 decaying */
  lightningFlash: number;
  /** force a lightning strike `dist` metres from the view centre (random if omitted); `hold` freezes the flash (debug) */
  debugStrike?(dist?: number, hold?: boolean): void;
  /** v2: current sky/horizon colour (water reflections, fog tint) */
  skyColor: THREE.Color;
  /** v2: current key-light colour */
  sunColor: THREE.Color;
  /** v2: unit vector TOWARD the key light actually used for shading/shadows (art-directed at golden hour so the default camera sees lit faces) */
  keyLightDir: THREE.Vector3;
  /** v2: 0..1 low mist over water & meadows (dawn / fog) */
  dawnMist: number;
  /** v2: 0..1 river ice (margins at ~0.3, full freeze = 1 → frost fair) */
  iceAmount: number;
  /** v2: 0..1 "dark enough for lamps" (night, fog, storm gloom) — lamplighters start their round above ~0.4 */
  gloom: number;
  /** v2: 0..1 snow lying on the ground/roofs (lags the snowfall) */
  snowCover: number;
  /** v2: 0..1 wet surfaces (lags the rain) */
  wetness: number;
  /** v2 (optional): force the river ice level 0..1 (frost-fair trigger, debugging); it then evolves normally */
  setIce?(v: number): void;
}

// ───────────────────────── World ─────────────────────────
export type LampGroup = 'platform' | 'forecourt' | 'road' | 'town' | 'crossing' | 'pub' | 'river';
export interface LampInfo { index: number; pos: THREE.Vector3; group: LampGroup; town?: string; lit: number }

export interface WorldAPI {
  setSignal(line: LineId, end: Dir, aspect: SignalAspect): void;
  getSignal(line: LineId, end: Dir): SignalAspect;
  signalPosition(line: LineId, end: Dir): THREE.Vector3;
  /** 0..1 overall lamp level (v1 compatibility: average of lit station lamps) */
  lampsOn: number;
  clockTowerTop: THREE.Vector3;
  /** for events: bunting, red carpet, etc. */
  addDecoration(obj: THREE.Object3D): void;
  removeDecoration(obj: THREE.Object3D): void;
  stationPickables: THREE.Object3D[];
  /** walking route over the footbridge (same as layout.footbridge.route) */
  footbridgePath?: THREE.Vector3[];
  /** 0 = steady; >0 makes gas lamps (lanterns + point lights) gutter/flicker, e.g. for the ghost train */
  flickerLamps?(amount: number): void;
  /** true if a tree trunk stands within r metres of (x, z) — events use it to place props clear of trees */
  treeNear?(x: number, z: number, r: number): boolean;

  // ── v2: per-lamp control (the lamplighter's round) ──
  /** every gas lamp on the map: station lamps (layout.lampPositions) first, then layout.streetLamps */
  lamps(): LampInfo[];
  /** 0..1 lit level of lamp i (fades up/down over ~1 s) */
  lampLit(i: number): number;
  /** light / extinguish lamp i (called by people's lamplighter & porters). */
  lightLamp(i: number, on: boolean): void;
  /**
   * true (default) = lamps only change when lit by hand; world's FALLBACK still lights any unlit lamp once
   * atmosphere.gloom > 0.85 (or puts it out at full day) so a missed round never leaves the station dark.
   * false = v1 behaviour (all lamps follow gloom automatically).
   */
  manualLamps: boolean;

  // ── v2: occluders (camera fades the station roof etc. when the followed/selected thing is behind it) ──
  occluders(): { id: string; bounds: THREE.Box3 }[];
  /** 1 = solid, 0 = fully faded (dithered) */
  setOccluderFade(id: string, a: number): void;

  // ── v2: building life ──
  /** chimney smoke on/off for a building (default: world decides from time of day, temperature and occupancy) */
  setChimney(buildingId: string, on: boolean | null): void;
  /** Monday wash: show/hide washing on the line behind a cottage (people's washerwoman calls this) */
  setWashing(buildingId: string, amount: number): void;
  /** a door swings open briefly (cosmetic; people call it when fading through) */
  openDoor(originId: string): void;
  /** windmill / water wheel / lock gates state for audio & events */
  mills(): { windmillRpm: number; waterwheelRpm: number; lockLevel: number };
  /** lock gates: 0 closed, 1 open (index 0..3 = upper pair, lower pair) — nature's narrowboat calls this */
  setLockGate(i: number, open: number): void;
  /** water level in the lock chamber 0 = low (−3.5) .. 1 = high (−3.0) */
  setLockLevel(level01: number): void;
}

// ───────────────────────── Trains ─────────────────────────
export type CarType =
  | 'loco_express' | 'loco_tank' | 'tender'
  | 'coach_first' | 'coach_second' | 'coach_third' | 'dining' | 'mail' | 'guard'
  | 'wagon_coal' | 'wagon_box' | 'wagon_tank' | 'wagon_flat'
  | 'circus_cage' | 'royal_saloon';

/** 0..1, 1 = perfect/full */
export interface Condition { boiler: number; brakes: number; wheels: number; coal: number; water: number }

export type TrainState =
  | 'approaching' | 'waitingSignal' | 'braking' | 'dwelling' | 'departing' | 'running'
  | 'toShed' | 'inShed' | 'fromShed' | 'broken' | 'rescued';

/** LIVE mutable record owned by trains; others read; maintenance may write .condition fields only. */
export interface TrainInfo {
  id: string;
  name: string;
  kind: 'express' | 'local' | 'freight' | 'special';
  special?: string;
  line: LineId;
  dir: Dir;
  origin: string;
  destination: string;
  state: TrainState;
  /** m/s */
  speed: number;
  /** loco head world pos */
  position: THREE.Vector3;
  headT: number;
  platform: PlatformId | null;
  cars: CarType[];
  /** metres */
  length: number;
  condition: Condition;
  passengers: number;
  capacity: number;
  /** sim minutes */
  scheduledArr: number;
  /** sim minutes */
  scheduledDep: number;
  delayMin: number;
  doorsOpen: boolean;
  ghost?: boolean;
  /** false once the user has ordered it to the shed: no boarding, 'Not in service' on the board (undefined = in service) */
  inService?: boolean;
  object: THREE.Object3D;
}

export interface Departure {
  trainId: string | null;
  /** sim minutes */
  time: number;
  line: LineId;
  platform: PlatformId;
  destination: string;
  name: string;
  /** 'On time'|'Delayed 5 min'|'Boarding'|'Departed'|'Cancelled'|'Approaching' */
  status: string;
  /** v2: travel direction (which way the train will leave) */
  dir?: Dir;
  /** v2: expected departure (time + current delay), sim minutes */
  expected?: number;
  /** v2: planned train length (m) and head t at its stop — lets people walk to the right part of the platform early */
  trainLength?: number;
  stopHeadT?: number;
  /** v2: rough free seats for new travellers (known for small consists such as the Night Mail), undefined = plenty */
  seats?: number;
}

export interface SpecialTrainSpec {
  /** 'royal'|'circus'|'ghost'|'rescue'|'freight'... */
  special: string;
  line?: LineId;
  dir?: Dir;
  cars?: CarType[];
  name?: string;
  stops?: boolean;
  ghost?: boolean;
  dwellMin?: number;
  /** v2: sim minute the special should reach the platform (trains picks the nearest free slot at or after it) */
  arriveBy?: number;
}

export interface TrainsAPI {
  list(): TrainInfo[];
  get(id: string): TrainInfo | undefined;
  timetable(count?: number): Departure[];
  spawnSpecial(spec: SpecialTrainSpec): string;
  delayLine(line: LineId, minutes: number, reason: string): void;
  /** hold trains outside the home signals until this sim minute (only ever extends an existing hold) */
  holdAtSignal(line: LineId, holdUntilSimMin: number): void;
  /** clear any hold/delay on the line immediately */
  releaseHold(line: LineId): void;
  /**
   * After its current duty it goes to the shed (state inShed, emits train:inShed). `urgent` (user-ordered): it runs
   * not in service from now on, with an abbreviated stop. Returns false when the train can't be sent (already leaving
   * the shed, broken, ghost, unknown).
   */
  requestShed(id: string, opts?: { urgent?: boolean }): boolean;
  /** leaves shed and re-enters service */
  releaseFromShed(id: string): void;
  /** stops where it is, state 'broken', emits train:breakdown */
  breakdown(id: string): void;
  /** sends a tank engine to haul the broken train into the shed */
  rescue(id: string): void;
  /** world positions on the platform edge next to each passenger car door, only meaningful while dwelling */
  getDoors(id: string): THREE.Vector3[];
  /** call once on arrival: returns how many passengers alight and removes them from the load */
  takeAlighting(id: string): number;
  /** returns accepted count (capacity-limited) */
  addPassengers(id: string, n: number): number;
  raycast(r: THREE.Raycaster): string | null;

  // ── v2 ──
  /** door positions (platform edge) where this train WILL stop — valid from 'train:approaching' until departure */
  predictedDoors(id: string): THREE.Vector3[];
  /**
   * Motion seconds (= sim minutes, since MOTION_SECONDS_PER_SIM_MINUTE is 1; a remaining platform dwell is included
   * in the same units) until the next train's HEAD reaches line t (either direction), including trains still
   * waiting off-map to enter (their planned entry + running time). null = nothing within `horizonS` (default 180).
   * Used by traffic to close level-crossing gates in time.
   */
  eta(line: LineId, t: number, horizonS?: number): { trainId: string | null; seconds: number; dir: Dir } | null;
  /** true while any train body overlaps line t0..t1 (t0 < t1) */
  occupied(line: LineId, t0: number, t1: number): boolean;
  /** next window (sim minutes) of at least `minutes` with no train on / due on `line` — for line-blocking events */
  nextGap(line: LineId, minutes: number): { start: number; end: number };
  /** expected departure time (sim minutes) of a train at/approaching the station, or null */
  expectedDeparture(id: string): number | null;
  /** v2 (optional): sim minutes until this engine is expected in the shed bay (after requestShed), or null */
  shedEta?(id: string): number | null;
  /**
   * v2 (optional): keep a dwelling train's doors (and its train-door origins) open until at least `untilSimMin`
   * (capped at +30 min past its booked departure). Events use it while an actor/animal a special carries is ashore.
   */
  holdDoors?(trainId: string, untilSimMin: number): void;
}

// ───────────────────────── People ─────────────────────────
export type PersonRole =
  | 'passenger' | 'porter' | 'stationmaster' | 'guard' | 'mechanic' | 'constable' | 'pickpocket'
  | 'bride' | 'groom' | 'guest' | 'bandsman' | 'vip' | 'crew'
  | 'clerk' | 'newsboy' | 'farmer' | 'ringmaster'
  // v2 roles
  | 'signalman' | 'platelayer' | 'lamplighter' | 'gatekeeper' | 'lockkeeper'
  | 'cabman' | 'coachman' | 'conductor' | 'drayman' | 'carter' | 'milkman' | 'postman' | 'motorist'
  | 'townsfolk' | 'child' | 'schoolchild' | 'vendor' | 'publican' | 'drinker' | 'vicar' | 'washerwoman' | 'baker' | 'blacksmith' | 'miller'
  | 'angler' | 'rower' | 'bargee' | 'punter' | 'skater'
  | 'farmhand' | 'shepherd' | 'drover' | 'ploughman' | 'dairymaid' | 'huntsman'
  | 'firefighter' | 'aeronaut';

export interface PersonInfo {
  id: string;
  name: string;
  role: PersonRole;
  state: string;
  line?: LineId;
  dir?: Dir;
  destination?: string;
  /** 0..1 */
  mood: number;
  patience: number;
  position: THREE.Vector3;
  umbrella: boolean;
  /** v2: anchor id while riding a vehicle / boat */
  riding?: string;
  /** v2: home building id (townsfolk) */
  home?: string;
  /** v2: current idle style when standing */
  idle?: IdleStyle | null;
}

export type PersonAnim =
  | 'idle' | 'walk' | 'run' | 'work' | 'cheer' | 'play'
  // v2 clips (people implements; unknown clips fall back to 'idle' + gestures)
  | 'sit' | 'drive' | 'row' | 'pole' | 'fish' | 'read' | 'chat' | 'watch' | 'sweep' | 'shovel' | 'hammer'
  | 'pitchfork' | 'scythe' | 'light' | 'skate' | 'carry' | 'push' | 'lead' | 'wave' | 'point' | 'drink' | 'wash';

/**
 * Idle behaviour while not walking (NO STATIONARY PEOPLE: every idle style is a looping set of gestures —
 * weight shifts, head turns, pocket-watch checks, newspaper, chatting hands, fidgeting children…).
 */
export type IdleStyle = 'wait' | 'chat' | 'read' | 'watch' | 'fidget' | 'work' | 'fish' | 'smoke' | 'sweep' | 'shelter' | 'drink' | 'garden' | 'sell';

/** what kind of person to create inside an origin */
export interface PersonSpec {
  role: PersonRole;
  child?: boolean;
  luggage?: boolean;
  /** passengers: the service they are heading for */
  dest?: { line: LineId; dir: Dir; trainId?: string };
  /** home building (returns there when done) */
  home?: string;
  tag?: string;
  seed?: number;
}

/**
 * A moving seat provider (vehicle, boat, cart tail). People asks it every frame for the seat's world matrix.
 * Implemented by traffic (vehicles) and nature (boats); obtained via traffic.anchorOf / nature.anchorOf.
 */
export interface Anchor {
  id: string;
  /** number of seats (0 = driver seat for vehicles that have one) */
  seats: number;
  /** world matrix of the seat frame (person origin at seat, local +z forward). false = anchor gone → people disembarks */
  seatMatrix(seat: number, out: THREE.Matrix4): boolean;
  seatPose(seat: number): 'sit' | 'drive' | 'row' | 'stand' | 'pole' | 'fish' | 'push';
  /** closed carriage interior: the rider is not drawn */
  hidden?(seat: number): boolean;
  /** world point beside the vehicle where riders step down / up (valid while stopped) */
  doorPoint(out: THREE.Vector3): THREE.Vector3;
  /** true while stopped so people may board / alight */
  stopped(): boolean;
}

export interface PeopleAPI {
  count(): number;
  list(): PersonInfo[];
  get(id: string): PersonInfo | undefined;
  /** passengers still walking to this train's doors; trains extends dwell (up to a max) while > 0 */
  boardingPending(trainId: string): number;
  /**
   * v1 compat. v2: spawns at `pos` only if it is a legitimate origin (ctx.origins.legit); otherwise the actor is
   * SUMMONED from the best door/portal and walks in (state 'summoned') — the id is returned immediately.
   */
  spawnActor(role: PersonRole, pos: THREE.Vector3): string;
  walkTo(id: string, target: THREE.Vector3, opts?: { speed?: number; run?: boolean; direct?: boolean }): Promise<void>;
  setAnim(id: string, a: PersonAnim): void;
  /** v1 compat. v2: equivalent to dismissActor (walks to the nearest sink and fades through it) */
  removeActor(id: string): void;
  /** v1 compat. v2: equivalent to summonCrowd(...).ids */
  spawnCrowd(n: number, near: THREE.Vector3, role?: PersonRole): string[];
  /** current spawn multiplier; events may scale it */
  density: number;
  raycast(r: THREE.Raycaster): string | null;

  // ── v2: origins-based life ──
  /** create people INSIDE a legitimate origin (door / stopped vehicle / train door / portal); they fade out through it */
  spawnInside(originId: string, specs: PersonSpec[]): string[];
  /** walk in from the best origin (ctx.origins.bestFor) to `target`; resolves true on arrival, false on timeout */
  summonActor(role: PersonRole, target: THREE.Vector3, opts?: { from?: string; run?: boolean; timeoutMin?: number; spec?: Partial<PersonSpec> }): { id: string; arrived: Promise<boolean> };
  /** n people gather near a point (drawn from people already present first, then from origins) */
  summonCrowd(n: number, near: THREE.Vector3, role?: PersonRole, opts?: { spread?: number; timeoutMin?: number }): { ids: string[]; assembled: Promise<number> };
  /** walk to a sink (a specific origin id, or the nearest suitable door/portal) and fade through it */
  dismissActor(id: string, opts?: { to?: string; run?: boolean }): Promise<void>;
  /** seat people on an anchor (vehicle / boat) immediately (they must already be at its doorPoint or spawned inside it) */
  ride(ids: string[], anchor: Anchor, seats?: number[]): void;
  /** walk to the anchor's doorPoint and board when it is stopped; resolves true when seated */
  embark(ids: string[], anchor: Anchor): Promise<boolean>;
  /** everyone riding `anchorId` steps down at its doorPoint; `then` decides what they do next */
  disembark(anchorId: string, opts?: { to?: THREE.Vector3; then?: 'passenger' | 'wander' | 'home' | 'actor' | 'dismiss' }): string[];
  setIdle(id: string, style: IdleStyle | null): void;
  /** head/body turn toward a point (null = free look) */
  lookAt(id: string, target: THREE.Vector3 | null): void;
  /** for trains: longest remaining walk (sim minutes) of passengers committed to this train */
  boardingEta(trainId: string): number;
  stats(): { byRole: Partial<Record<PersonRole, number>>; riding: number; hidden: number; waiting: number; gaveUp: number; boarded: number };
}

/** the v1 subset of PeopleAPI (people/system.ts builds this; people/index.ts adds the v2 members) */
export type PeopleAPIV1 = Pick<PeopleAPI, 'count' | 'list' | 'get' | 'boardingPending' | 'spawnActor' | 'walkTo' | 'setAnim' | 'removeActor' | 'spawnCrowd' | 'density' | 'raycast'>;

// ───────────────────────── Traffic (v2, src/traffic) ─────────────────────────
export type VehicleKind =
  | 'hansom' | 'growler' | 'omnibus' | 'landau' | 'gig' | 'mailcart' | 'dray' | 'coalcart' | 'farmcart' | 'haywain'
  | 'milkfloat' | 'handcart' | 'bicycle' | 'pennyfarthing' | 'motorwagen' | 'fireengine' | 'carriage4' | 'circuswagon';

export interface VehicleInfo {
  id: string;
  kind: VehicleKind;
  /** 'depot' = queued / still inside its depot or beyond the map edge (not yet on the road) */
  state: 'driving' | 'stopped' | 'loading' | 'waiting' | 'gone' | 'depot';
  pos: THREE.Vector3;
  yaw: number;
  /** m/s */
  speed: number;
  /** road edge + s of the front */
  edge: string; s: number;
  horses: number;
  seats: number;
  /** person ids riding (incl. driver) */
  riders: string[];
  /** current stop id ('forecourt:drop', 'forecourt:rank:2', 'forecourt:omnibus', a door origin id…) */
  stop?: string;
  /** v2 (optional): where the vehicle is heading — a town id, portal id or door origin id */
  dest?: string;
  tag?: string;
  label: string;
}

export interface TripRequest {
  kind: VehicleKind | 'cab';
  /** road node / door origin id to start from (default: the kind's depot — Crown Mews — or a portal) */
  from?: string;
  /** 'forecourt:drop' | 'forecourt:rank' | 'forecourt:omnibus' | road node id | door origin id */
  to: string;
  /** passengers created inside the vehicle at its origin (people.spawnInside) */
  riders?: PersonSpec[];
  /** sim minutes to wait at `to` before leaving (default: until riders are off) */
  wait?: number;
  /** where to go afterwards (default: back to its depot or out through the nearest portal) */
  then?: string;
  decor?: 'wedding' | 'royal' | 'funeral' | 'circus';
  tag?: string;
}

export type CrossingState = 'open' | 'closing' | 'closed' | 'opening';

export interface TrafficAPI {
  list(): VehicleInfo[];
  get(id: string): VehicleInfo | undefined;
  /** book a vehicle; returns its id (null if caps/roads prevent it). It enters from a legit origin and follows roads. */
  request(r: TripRequest): string | null;
  /** send a vehicle home now */
  cancel(id: string): void;
  /** seat provider for people.ride/embark */
  anchorOf(id: string): Anchor | null;
  /** cab rank at the forecourt: waiting cab ids (front first). hail() reserves the front cab (or summons one from the mews) */
  rank(): { waiting: string[]; hail(personId?: string): string | null };
  /** the omnibus standing at the forecourt stop, if any */
  omnibusAt(): string | null;
  /** level crossing state; 'open' = open to ROAD (closed to rail) */
  crossingState(id: string): CrossingState;
  /**
   * Trains call this every update while wanting to pass crossing `id` (before trainStopT, and before entering the map
   * or departing a platform when the crossing is close). Returns true once the gates are closed to the road and the
   * crossing is clear. Traffic must honour a request within ~20 motion-s; never block a train indefinitely.
   */
  requestCrossing(id: string, requester: string): boolean;
  /** the requesting train has passed / no longer needs the crossing */
  releaseCrossing(id: string, requester: string): void;
  /** horses within r shy / bolt briefly (motorwagen, gunshot, thunder) */
  scare(pos: THREE.Vector3, radius: number): void;
  raycast(r: THREE.Raycaster): string | null;
  stats(): { vehicles: number; horses: number; byKind: Partial<Record<VehicleKind, number>> };
}

// ───────────────────────── Nature (v2, src/nature) ─────────────────────────
export type CritterKind =
  | 'sheep' | 'cow' | 'horse' | 'dog' | 'hen' | 'goose' | 'duck' | 'swan' | 'heron' | 'crow' | 'starling' | 'rook' | 'swallow' | 'cat';
export interface CritterInfo { id: string; kind: CritterKind; pos: THREE.Vector3; state: string; group?: string; label: string }
export type BoatKind = 'rowing' | 'gig4' | 'launch' | 'narrowboat' | 'punt';
export interface BoatInfo {
  id: string; kind: BoatKind; name: string;
  pos: THREE.Vector3; yaw: number; speed: number;
  state: 'moored' | 'underway' | 'inLock' | 'hauled';
  riders: string[];
}

export interface NatureAPI {
  river: {
    /** water surface y at (x,z) (−3.0 above the weir, −3.5 below; the lock chamber follows world.setLockLevel) */
    surfaceY(x: number, z: number): number;
    /** surface flow velocity m/s (downstream + wind drift) */
    flowAt(p: THREE.Vector3): THREE.Vector2;
    /** 0..1 ice (from atmosphere.iceAmount); skating possible at 1 */
    ice: number;
  };
  list(kind?: CritterKind): CritterInfo[];
  get(id: string): CritterInfo | undefined;
  boats(): BoatInfo[];
  boat(id: string): BoatInfo | undefined;
  /** seat provider for a boat (rowers, launch passengers, punter) */
  anchorOf(boatId: string): Anchor | null;
  /** launch a boat from the boathouse / a mooring / a river portal; riders spawn inside (or embark) */
  requestBoat(kind: BoatKind, opts?: { from?: string; riders?: PersonSpec[]; tag?: string; route?: 'loop' | 'upstream' | 'downstream' | 'regatta' }): string | null;
  /**
   * Move a flock / herd from one place to another along roads & paths: from/to = field id | door origin id | portal id.
   * Resolves true on arrival. The herd occupies road edges while travelling (traffic yields; level crossings stay open to road).
   */
  herd(kind: 'sheep' | 'cows', from: string, to: string, opts?: { count?: number; dog?: boolean; tag?: string }): Promise<boolean>;
  /** birds take off, sheep scatter, ducks flap (a train whistle, the motorwagen, a gunshot) */
  scare(pos: THREE.Vector3, radius: number): void;
  raycast(r: THREE.Raycaster): { kind: 'animal' | 'boat'; id: string } | null;
  stats(): { animals: number; birds: number; boats: number; byKind: Partial<Record<CritterKind, number>> };
}

// ───────────────────────── Maintenance ─────────────────────────
export interface ShedStatus { bay: string | null; queue: string[]; progress: number; task: string }

export interface MaintenanceAPI {
  status(): ShedStatus;
  wearMultiplier: number;
  threshold: number;
  forceBreakdown(trainId?: string): void;
  sendToShed(trainId: string): void;
}

// ───────────────────────── Events ─────────────────────────
export interface EventMeta {
  id: string;
  title: string;
  blurb: string;
  /** conditions met now */
  available: boolean;
}

export interface EventsAPI {
  catalog(): EventMeta[];
  active(): { id: string; title: string; startedAt: number }[];
  trigger(id: string): boolean;
  auto: boolean;
  gazette(): { time: string; headline: string; kind: string }[];
  /** world position of an active event's focal point (for 'go to event'), or null */
  focusOf(id: string): THREE.Vector3 | null;
}

// ───────────────────────── Camera / UI / Audio ─────────────────────────
export type CameraMode = 'iso' | 'persp' | 'follow';
/** v2: everything selectable / followable */
export type SelectKind = 'train' | 'person' | 'station' | 'vehicle' | 'boat' | 'animal' | 'building';

export interface CameraAPI {
  mode: CameraMode;
  setMode(m: CameraMode): void;
  focus(pos: THREE.Vector3): void;
  follow(trainId: string | null): void;
  shake(amount: number): void;
  rotateQuarter(dir: 1 | -1): void;
  /** v2: follow any live thing (train, person, vehicle, boat, animal); null stops following */
  followAny(kind: SelectKind | null, id: string | null): void;
  /** v2 (optional): current zoom factor (1 = default framing) */
  readonly zoom?: number;
  zoomTo?(z: number): void;
  /** v2 (optional): glide to a ground point (and zoom) */
  lookAt?(pos: THREE.Vector3, zoom?: number): void;
  followed?(): { kind: SelectKind | null; id: string | null };
  /** v2 (optional): current occluder fade per world occluder id */
  occluderState?(): Record<string, number>;
}

export interface UIAPI { toast(msg: string): void }

export interface AudioAPI {
  muted: boolean;
  setMuted(m: boolean): void;
  play(cue: AudioCue, pos?: THREE.Vector3, volume?: number): void;
  unlocked: boolean;
}
