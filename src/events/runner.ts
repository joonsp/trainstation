/**
 * Synchronous coroutine runner for event scripts. A script is a generator that yields Waits:
 *   yield 5                               → wait 5 sim minutes
 *   yield () => cond                      → wait until cond() is true
 *   yield { until: () => cond, max: 30 }  → wait until cond() or 30 sim minutes elapsed
 * Everything is polled from System.update with clock.dtSim, so pause / 60x / __station.advance()
 * (which runs synchronously with no microtasks) all behave identically. No Promises are awaited.
 */
export type Wait = number | (() => boolean) | { until: () => boolean; max: number };
export type Script = Generator<Wait, void, unknown>;

export class Runner {
  private cur: Wait | undefined;
  private started = false;
  /** sim minutes spent in the current wait */
  t = 0;
  done = false;

  constructor(private gen: Script) {}

  step(dtSim: number): void {
    if (this.done) return;
    this.t += dtSim;
    for (let i = 0; i < 48; i++) {
      if (this.started && !this.satisfied()) return;
      this.started = true;
      const r = this.gen.next();
      if (r.done) { this.done = true; return; }
      this.cur = r.value;
      this.t = 0;
    }
  }

  private satisfied(): boolean {
    const w = this.cur;
    if (w === undefined) return true;
    if (typeof w === 'number') return this.t >= w;
    if (typeof w === 'function') return w();
    return w.until() || this.t >= w.max;
  }

  stop(): void {
    if (this.done) return;
    this.done = true;
    try { this.gen.return(undefined); } catch { /* ignore */ }
  }
}
