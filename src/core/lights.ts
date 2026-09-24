import * as THREE from 'three';

/**
 * SHARED POINT-LIGHT POOL (v2). A fixed number of PointLights (ctx.quality.knobs.pointLights) created once
 * and always in the scene, so light counts — and therefore every standard-material program — never change at
 * runtime. Anyone who wants real light (gas lamps, forge glow, event flares, boat/carriage lanterns, the pub
 * windows at night) `claim()`s every frame; after all systems have updated, main.ts calls `resolve()` which gives
 * the pool's lights to the best claims (priority, then distance to the view focus) and zeroes the rest.
 * Unserved claims simply don't light — pair every claim with an emissive mesh / halo sprite so it still glows.
 *
 * The v1 world lamp pool and the permanent point lights in events/fx.ts must be replaced by claims.
 */
export interface LightPool {
  readonly size: number;
  /**
   * Request a light for THIS frame. key: stable id (for smoothing); priority: higher wins (default 0;
   * suggested: event effects 3, forge/fire 2, platform & forecourt lamps 1, town lamps 0.5, lanterns 0).
   */
  claim(key: string, pos: THREE.Vector3, color: number | THREE.Color, intensity: number, distance: number, priority?: number): void;
  /** main.ts, once per rendered frame after systems update */
  resolve(focus: THREE.Vector3): void;
  /** number of claims last frame (debug/stats) */
  readonly lastClaims: number;
}

interface Claim { key: string; pos: THREE.Vector3; color: THREE.Color; intensity: number; distance: number; priority: number; score: number }

export class PointLightPool implements LightPool {
  readonly size: number;
  lastClaims = 0;
  private lights: THREE.PointLight[] = [];
  private claims: Claim[] = [];
  private free: Claim[] = [];
  private assigned = new Map<string, number>(); // key → light index (stickiness avoids popping between lamps)

  constructor(scene: THREE.Scene, size: number) {
    this.size = size;
    for (let i = 0; i < size; i++) {
      const l = new THREE.PointLight(0xffcf7a, 0, 20, 2);
      l.name = `vj-pool-light-${i}`;
      l.castShadow = false;
      scene.add(l);
      this.lights.push(l);
    }
  }

  claim(key: string, pos: THREE.Vector3, color: number | THREE.Color, intensity: number, distance: number, priority = 0): void {
    if (intensity <= 0.001) return;
    const c = this.free.pop() ?? { key: '', pos: new THREE.Vector3(), color: new THREE.Color(), intensity: 0, distance: 0, priority: 0, score: 0 };
    c.key = key; c.pos.copy(pos);
    if (typeof color === 'number') c.color.setHex(color); else c.color.copy(color);
    c.intensity = intensity; c.distance = distance; c.priority = priority;
    this.claims.push(c);
  }

  resolve(focus: THREE.Vector3): void {
    const cl = this.claims;
    this.lastClaims = cl.length;
    for (const c of cl) {
      const d = Math.hypot(c.pos.x - focus.x, c.pos.z - focus.z);
      // sticky bonus for claims already holding a light
      c.score = c.priority * 1000 - d + (this.assigned.has(c.key) ? 15 : 0);
    }
    cl.sort((a, b) => b.score - a.score);
    const winners = cl.slice(0, this.size);
    const next = new Map<string, number>();
    const used = new Set<number>();
    // keep previous light index for returning winners
    for (const w of winners) { const i = this.assigned.get(w.key); if (i !== undefined && !used.has(i)) { next.set(w.key, i); used.add(i); } }
    let li = 0;
    for (const w of winners) {
      if (next.has(w.key)) continue;
      while (used.has(li)) li++;
      next.set(w.key, li); used.add(li);
    }
    for (let i = 0; i < this.size; i++) if (!used.has(i)) this.lights[i].intensity = 0;
    for (const w of winners) {
      const l = this.lights[next.get(w.key)!];
      l.position.copy(w.pos);
      l.color.copy(w.color);
      l.intensity = w.intensity;
      l.distance = w.distance;
    }
    this.assigned = next;
    for (const c of cl) this.free.push(c);
    cl.length = 0;
  }
}
