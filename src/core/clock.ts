import type { EventBus } from './bus';

/**
 * Seconds of PHYSICAL motion per sim minute. Train/people motion integrates `clock.dtMotion`
 * (= dtSim * MOTION_SECONDS_PER_SIM_MINUTE) so pause, 10x/60x and __station.advance() all scale motion
 * consistently. At timeScale 1 this is real time. Purely visual animation (smoke, rain, limb swing) uses `dt`.
 */
export const MOTION_SECONDS_PER_SIM_MINUTE = 1;
/** main.ts sub-steps so that clock.dtSim never exceeds this inside System.update */
export const MAX_SIM_STEP = 0.5;

/** Simulation clock. `minutes` = total sim minutes since day 0 00:00. */
export class SimClock {
  minutes = 0;
  /** sim minutes per real second (UI offers 0/1/10/60) */
  timeScale = 1;
  paused = false;
  /** sim minutes elapsed during the last tick */
  dtSim = 0;
  private lastHourInt = -1;

  constructor(private bus: EventBus, startHour = 8) {
    this.minutes = startHour * 60;
    this.lastHourInt = Math.floor(this.minutes / 60);
  }

  /** seconds of physical motion to integrate this tick (0 when paused) */
  get dtMotion(): number { return this.dtSim * MOTION_SECONDS_PER_SIM_MINUTE; }

  get hour(): number { return (this.minutes / 60) % 24; }
  get day(): number { return Math.floor(this.minutes / 1440); }
  get dayFraction(): number { return (this.minutes % 1440) / 1440; }
  /** 0 = Mon .. 6 = Sun */
  get weekday(): number { return this.day % 7; }

  /** Jump to hour h (0..24) on the current day (does not go backwards in days). */
  setHour(h: number): void {
    const hh = ((h % 24) + 24) % 24;
    this.minutes = this.day * 1440 + hh * 60;
    this.lastHourInt = Math.floor(this.minutes / 60);
    this.bus.emit('time:hour', { hour: Math.floor(this.hour), day: this.day });
  }

  format(): string {
    const m = Math.floor(this.minutes % 1440);
    const hh = Math.floor(m / 60), mm = m % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  /** Advance by dtReal seconds. Sets dtSim; emits 'time:hour' when the integer hour changes. */
  tick(dtReal: number): void {
    this.dtSim = this.paused ? 0 : dtReal * this.timeScale;
    this.advanceSim(this.dtSim);
  }

  /** Advance by a number of sim minutes directly (used by fast-forward). */
  advanceSim(simMin: number): void {
    this.dtSim = simMin;
    this.minutes += simMin;
    const hi = Math.floor(this.minutes / 60);
    if (hi !== this.lastHourInt) {
      this.lastHourInt = hi;
      this.bus.emit('time:hour', { hour: hi % 24, day: this.day });
    }
  }
}

/** Format any sim-minute value as HH:MM (wraps per day). */
export function formatSimTime(min: number): string {
  const m = Math.floor(((min % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
