import type * as THREE from 'three';
import type { Anchor, IdleStyle, PersonAnim, PersonInfo, PersonRole } from '../core/apis';
import type { Dir, LineId, PlatformId } from '../core/types';
import type { AccKind } from './geometry';
import type { Look } from './looks';

export type Kind = 'passenger' | 'alighter' | 'staff' | 'actor' | 'idler' | 'guard' | 'town' | 'meeter';

export interface Seat { plat: PlatformId; pos: THREE.Vector3; yaw: number; taken: Person | null }

export type RidePose = 'sit' | 'drive' | 'row' | 'stand' | 'pole' | 'fish' | 'push';

export interface Riding { anchor: Anchor; anchorId: string; seat: number; pose: RidePose; hidden: boolean }

/** one step of a scripted routine (townsfolk, staff shifts, anglers, lamplighters…) */
export type Step =
  | { k: 'go'; to: THREE.Vector3; run?: boolean; speed?: number; direct?: boolean; staff?: boolean; state?: string }
  | { k: 'face'; yaw: number }
  | { k: 'faceTo'; p: THREE.Vector3 }
  | {
    k: 'do'; state?: string; anim?: PersonAnim | null; idle?: IdleStyle | null; props?: AccKind[];
    /** sim minutes */
    min?: number; untilHour?: number; until?: (p: Person) => boolean;
    /** called every update while doing (sim-min dt) */
    tick?: (p: Person, dtSim: number) => void;
  }
  | { k: 'enter'; origin: string; state?: string }
  | { k: 'call'; fn: (p: Person) => void }
  | { k: 'wander'; center: THREE.Vector3; r: number; min?: number; untilHour?: number; idle?: IdleStyle; state?: string; until?: (p: Person) => boolean };

export interface FadeLeg { from: THREE.Vector3; len: number; dir: 'in' | 'out' }

export interface Person {
  num: number;
  id: string;
  name: string;
  role: PersonRole;
  look: Look;
  kind: Kind;
  state: string;
  pos: THREE.Vector3;
  yaw: number;
  faceYaw: number | null;
  // movement
  path: THREE.Vector3[];
  pathIdx: number;
  speed: number;
  speedOverride: number | undefined;
  running: boolean;
  onArrive: (() => void) | null;
  walkResolve: (() => void) | null;
  // timer (motion seconds)
  wait: number;
  onWait: (() => void) | null;
  // anim
  manualAnim: PersonAnim | null;
  phase: number;
  moving: boolean;
  sit: number;
  sitTarget: number;
  seed: number;
  seat: Seat | null;
  // v2 visuals
  fade: number;
  fadeLeg: FadeLeg | null;
  /** explicit idle style (setIdle / scripts); null = derived from state */
  idle: IdleStyle | null;
  clip: number;
  clipT: number;
  clipDur: number;
  nextClip: number;
  clipSign: number;
  headYaw: number;
  headPitch: number;
  glanceYaw: number;
  glancePitch: number;
  glanceT: number;
  rollBias: number;
  lookAt: THREE.Vector3 | null;
  lookTrain: string | null;
  lookUntil: number;
  riding: Riding | null;
  /** home building id (townsfolk / staff) */
  home?: string;
  /** origin id the person came from (default sink) */
  originId?: string;
  // passenger
  line?: LineId;
  dir?: Dir;
  platform?: PlatformId;
  destination?: string;
  patience: number;
  mood: number;
  hasTicket: boolean;
  trainId: string | null;
  refused: string | null;
  leader: Person | null;
  followers: Person[];
  followOff: THREE.Vector3;
  umbrella: boolean;
  shelterCheck: number;
  lane: THREE.Vector3;
  /** scheduled departure the passenger is aiming for (sim minutes) */
  aim: number;
  /** minutes of lateness beyond `aim` the passenger will tolerate */
  tolerance: number;
  // scripted routine
  script: Step[] | null;
  stepIdx: number;
  stepT: number;
  stepStarted: boolean;
  scriptDone: ((p: Person) => void) | null;
  // parts
  /** linear rgb triplets: body A,B,C,D (0..11) then hat A,B,C (12..20) — packed into the instance buffers each frame */
  cols: Float32Array;
  /** props currently carried (value unused) */
  accSlots: Partial<Record<AccKind, number>>;
  /** per-prop colours A,B,C */
  accCols: Partial<Record<AccKind, Float32Array>>;
  /** activity props (removed when the activity ends) */
  tempProps: AccKind[];
  info: PersonInfo;
  // misc
  data: Record<string, unknown>;
  alive: boolean;
}
