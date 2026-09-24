/** Seeded PRNG (mulberry32). */
export class Rng {
  private s: number;
  constructor(seed = 1) { this.s = (seed >>> 0) || 1; }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  /** inclusive */
  int(a: number, b: number): number { return a + Math.floor(this.next() * (b - a + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p: number): boolean { return this.next() < p; }
  weighted<T>(items: readonly { w: number; v: T }[]): T {
    let total = 0;
    for (const i of items) total += Math.max(0, i.w);
    let r = this.next() * total;
    for (const i of items) { r -= Math.max(0, i.w); if (r <= 0) return i.v; }
    return items[items.length - 1].v;
  }
  /** standard normal (mean 0, sd 1) */
  gauss(): number {
    const u = 1 - this.next(), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** derive an independent child stream */
  fork(salt = 0): Rng { return new Rng(Math.floor(this.next() * 4294967296) ^ salt); }
}
