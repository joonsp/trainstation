import * as THREE from 'three';
import type { LineId } from '../core/types';

/** a piece of track: the two main lines, the old shed siding from the coast switch, or the v2 shed through-road */
export type Track = LineId | 'shed' | 'shedRoad';

export interface Leg {
  curve: THREE.CatmullRomCurve3;
  /** arc-length fractions; t1 < t0 means travelling towards decreasing t */
  t0: number;
  t1: number;
  /** metres */
  len: number;
  /** route distance at the leg start */
  start: number;
  curveLen: number;
  /** which track this leg lies on */
  track: Track;
}

const _t = new THREE.Vector3();

/**
 * A 1-D path made of pieces of curves. Trains always move FORWARD (increasing s) along their route;
 * reversing is done by building a new route. Beyond both ends the path extrapolates straight along the
 * end tangents so trains can enter/leave the world smoothly from off-screen.
 */
export class Route {
  legs: Leg[] = [];
  total = 0;

  add(curve: THREE.CatmullRomCurve3, t0: number, t1: number, track: Track): this {
    const curveLen = curve.getLength();
    const len = Math.abs(t1 - t0) * curveLen;
    this.legs.push({ curve, t0, t1, len, start: this.total, curveLen, track });
    this.total += len;
    return this;
  }

  private legAt(s: number): Leg {
    const L = this.legs;
    for (let i = 0; i < L.length - 1; i++) if (s < L[i].start + L[i].len) return L[i];
    return L[L.length - 1];
  }

  private _res: { leg: Leg; t: number } = { leg: undefined as unknown as Leg, t: 0 };

  /** curve parameter + leg at route distance s (clamped). Returns a SHARED object — read it immediately. */
  tAt(s: number): { leg: Leg; t: number } {
    const cs = Math.min(Math.max(s, 0), this.total);
    const leg = this.legAt(cs);
    const u = leg.len > 0 ? (cs - leg.start) / leg.len : 0;
    this._res.leg = leg;
    this._res.t = THREE.MathUtils.clamp(leg.t0 + (leg.t1 - leg.t0) * u, 0, 1);
    return this._res;
  }

  /** unit tangent in the direction of travel at s */
  tangentAt(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const { leg, t } = this.tAt(s);
    leg.curve.getTangentAt(t, out);
    if (leg.t1 < leg.t0) out.multiplyScalar(-1);
    return out;
  }

  pointAt(s: number, out = new THREE.Vector3()): THREE.Vector3 {
    if (s < 0) {
      const leg = this.legs[0];
      leg.curve.getPointAt(leg.t0, out);
      this.tangentAt(0, _t);
      return out.addScaledVector(_t, s);
    }
    if (s > this.total) {
      const leg = this.legs[this.legs.length - 1];
      leg.curve.getPointAt(leg.t1, out);
      this.tangentAt(this.total, _t);
      return out.addScaledVector(_t, s - this.total);
    }
    const { leg, t } = this.tAt(s);
    return leg.curve.getPointAt(t, out);
  }

  /** route distance of curve parameter t on the given leg index */
  sOfT(legIndex: number, t: number): number {
    const leg = this.legs[legIndex];
    const u = (t - leg.t0) / (leg.t1 - leg.t0 || 1);
    return leg.start + u * leg.len;
  }

  /**
   * Metres along a line (t * length) for route distance s, or null if s is off that line's legs.
   * Off-route extrapolation is mapped onto the line coordinate as well.
   */
  lineM(s: number, line: Track): number | null {
    if (s < 0) {
      const leg = this.legs[0];
      if (leg.track !== line) return null;
      return leg.t0 * leg.curveLen - Math.sign(leg.t1 - leg.t0) * -s * 1;
    }
    if (s > this.total) {
      const leg = this.legs[this.legs.length - 1];
      if (leg.track !== line) return null;
      return leg.t1 * leg.curveLen + Math.sign(leg.t1 - leg.t0) * (s - this.total);
    }
    const { leg, t } = this.tAt(s);
    if (leg.track !== line) return null;
    return t * leg.curveLen;
  }
}
