import type * as THREE from 'three';
import type { Smoke } from './smoke';

/**
 * Trains ↔ maintenance back-channel (both live in the trains+maintenance builder's directories, so this is not a
 * cross-system contract). Trains fills it during create; maintenance (created later) reads it defensively.
 */
export interface TrainsShared {
  /** the trains' smoke/steam/spark particle system (maintenance borrows it: no extra draw calls) */
  smoke: Smoke | null;
  /** sim minutes until this engine should reach the shed bay (null = unknown / not shed-bound) */
  shedEta(id: string): number | null;
  /** world point of the coupling between a rescued engine and its shed pilot (null = no pilot attached) */
  pilotCoupling(id: string, out: THREE.Vector3): THREE.Vector3 | null;
  /** the fitter has lifted the coupling: the pilot may leave (otherwise it leaves by itself after a timeout) */
  uncouple(id: string): void;
  /** set by maintenance: sim minutes until the repair bay is free (0 = free now) */
  bayFreeIn(): number;
  /** world point on the ground beside the loco cab (for a fitter to stand at), or null */
  cabSide(id: string, out: THREE.Vector3): THREE.Vector3 | null;
}

export const trainsShared: TrainsShared = {
  smoke: null,
  shedEta: () => null,
  pilotCoupling: () => null,
  uncouple: () => { /* trains not created */ },
  cabSide: () => null,
  bayFreeIn: () => 0,
};
