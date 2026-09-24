/**
 * Event-owned living props (goose, cat, cow, elephant, dog, swan …) under the v2 rules:
 *  - NO POP-IN: a critter only enters at a legitimate origin (door / train door / field gate registered as an
 *    animal origin / the map edge for birds) and leaves the same way; both are audited via ctx.origins.audit.
 *  - NO STATIONARY LIFE: the animate callback runs every frame, moving or not (breathing, head bobs, tail swish).
 *  - If the event ends while a critter is still on the map, it is handed to the Linger manager, which walks
 *    (or flies) it to its exit and only then removes it. Carried critters/props follow their dismissed carrier
 *    until that person has faded through a door.
 */
import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { Wait } from './runner';
import { disposeTree } from './fx';
import { PartRig } from './partrig';

export type CritterAnim = (c: Critter, dt: number, moving: boolean, speed: number) => void;

const _d = new THREE.Vector3();
let lingerSeq = 0;

export class Critter {
  readonly root: THREE.Object3D;
  present = false;
  /** where it leaves the map (defaults to where it came in) */
  exit: THREE.Vector3 | null = null;
  exitMode: 'walk' | 'fly' = 'walk';
  target: THREE.Vector3 | null = null;
  speed = 1;
  /** yaw easing rate (1/s) */
  turn = 6;
  /** metres per second actually moved last update (for gait) */
  moved = 0;
  phase = Math.random() * 6;
  /** follow the terrain (layout.heightAt) when walking on the ground; null = keep target y */
  groundY: ((x: number, z: number) => number) | null;
  /** extra y offset (e.g. on the track ballast) */
  lift = 0;
  /** carried: position is driven externally */
  held = false;
  /** a bird: may leave by air over the edge of the map */
  canFly = false;
  private prev = new THREE.Vector3();

  /** all the animated parts drawn as one mesh (see partrig.ts) */
  private rig: PartRig;

  constructor(private ctx: Ctx, public host: THREE.Object3D, root: THREE.Object3D, readonly label: string, private animate: CritterAnim) {
    this.root = root;
    this.groundY = (x, z) => ctx.layout.heightAt(x, z);
    this.rig = new PartRig(root);
  }

  /** appear AT a legitimate origin point */
  enter(pos: THREE.Vector3, originLabel: string): this {
    this.root.position.copy(pos);
    this.prev.copy(pos);
    this.host.add(this.root);
    this.present = true;
    if (!this.exit) this.exit = pos.clone();
    try { this.ctx.origins.audit('events', 'spawn', 'animals', pos, `${this.label} @ ${originLabel}`); } catch { /* no registry */ }
    return this;
  }

  /**
   * disappear through the origin it is standing at. Safety net for the no-pop-in rule: if it is NOT at a
   * legitimate origin, it first goes to its exit (where it came in) and only vanishes there.
   */
  leave(): void {
    if (!this.present) return;
    if (!this.forceLeave && this.exit && !this.atLegit()) {
      if (!this.leavePending) { this.leavePending = true; this.goto(this.exit, Math.max(this.speed, this.exitMode === 'fly' ? 12 : 1.6)); }
      return;
    }
    this.leavePending = false;
    this.present = false;
    try { this.ctx.origins.audit('events', 'despawn', 'animals', this.root.position, this.label); } catch { /* no registry */ }
    this.root.removeFromParent();
  }

  private leavePending = false;
  private forceLeave = false;
  /** leave right here (the caller guarantees an origin: Linger's held exit, the sky beyond the map) */
  leaveNow(): void { this.forceLeave = true; this.leave(); this.forceLeave = false; }
  /** true while a deferred leave() is walking it to its exit */
  get leaving(): boolean { return this.leavePending; }
  private atLegit(): boolean {
    try { return !!this.ctx.origins.legit(this.root.position, 'animals'); } catch { return true; }
  }

  goto(target: THREE.Vector3, speed = this.speed): Wait {
    if (this.leavePending && this.exit && target.distanceToSquared(this.exit) > 0.01) return 0;
    this.target = target.clone();
    this.speed = speed;
    return { until: () => !this.present || !this.target, max: this.root.position.distanceTo(target) / Math.max(0.2, speed) * 2 + 10 };
  }

  get pos(): THREE.Vector3 { return this.root.position; }

  update(dt: number, dm: number): void {
    // a critter being carried out (present = false, held) still breathes and fidgets
    if (!this.present && !this.held) return;
    const p = this.root.position;
    if (!this.held && this.target && dm > 0) {
      _d.subVectors(this.target, p);
      const flat = this.exitMode === 'fly' || this.groundY === null ? _d.length() : Math.hypot(_d.x, _d.z);
      if (flat < 0.12) this.target = null;
      else {
        const st = Math.min(flat, this.speed * dm);
        if (this.exitMode === 'fly' || this.groundY === null) p.addScaledVector(_d, st / flat);
        else { p.x += (_d.x / flat) * st; p.z += (_d.z / flat) * st; }
        const yaw = Math.atan2(-_d.z, _d.x);
        this.root.rotation.y += Math.atan2(Math.sin(yaw - this.root.rotation.y), Math.cos(yaw - this.root.rotation.y)) * Math.min(1, dt * this.turn + dm * 2);
      }
    }
    if (!this.held && this.groundY && this.exitMode === 'walk') p.y = this.groundY(p.x, p.z) + this.lift;
    const moved = Math.hypot(p.x - this.prev.x, p.z - this.prev.z);
    this.moved = dm > 0 ? moved / dm : 0;
    this.prev.copy(p);
    this.phase += dt * (1.2 + this.moved * 2.2);
    this.animate(this, dt, moved > 1e-4, this.moved);
    this.rig.update();
    // a deferred leave(): arrived at the exit → go through it now
    if (this.leavePending && (!this.target || (this.exit && this.root.position.distanceTo(this.exit) < 0.4))) {
      this.forceLeave = true;
      this.leave();
      this.forceLeave = false;
    }
  }

  dispose(): void { this.root.removeFromParent(); disposeTree(this.root); this.rig.dispose(); }
}

interface Carried { obj: THREE.Object3D; pid: string; y: number; fwd: number; yaw: number; prev: THREE.Vector3; critter?: Critter }

/** per-ctx manager for things that must outlive their event (see header) */
export class Linger {
  readonly group = new THREE.Group();
  private critters: Critter[] = [];
  private carried: Carried[] = [];
  constructor(private ctx: Ctx) {
    this.group.name = 'events-linger';
    ctx.scene.add(this.group);
  }

  /**
   * take over a critter still on the map: it heads for its exit and leaves there. The origin it came in by may
   * have been a temporary one owned by the ended event (a basket, a lead, a car ramp): birds then simply fly off
   * over the edge of the map; anything else keeps a doorway at its way in (the gate / flap is still there)
   * until it has gone through.
   */
  adoptCritter(c: Critter): void {
    if (!c.present) { c.dispose(); return; }
    c.held = false;
    this.group.attach(c.root);
    c.host = this.group;
    const exit = c.exit ?? c.pos.clone();
    const legit = (() => { try { return !!this.ctx.origins.legit(exit, 'animals') || !!this.ctx.origins.legit(exit, 'people'); } catch { return true; } })();
    if (!legit && c.canFly) {
      c.exitMode = 'fly';
      c.groundY = null;
      const d = new THREE.Vector3(c.pos.x, 0, c.pos.z);
      if (d.lengthSq() < 1) d.set(1, 0, 0);
      d.normalize();
      c.exit = c.pos.clone().addScaledVector(d, 700).setY(70);
    } else if (c.exitMode === 'walk') {
      // (always: the event's own gate / flap origin is removed during the same cleanup)
      const id = `events:linger:${++lingerSeq}`;
      const p = exit.clone();
      try { this.exitsHeld.set(c, this.ctx.origins.add({ id, kind: 'door', owner: 'events', pos: (o) => o.copy(p), radius: 2.5, for: ['animals'], open: () => true })); } catch { /* none */ }
      c.exit = exit;
    }
    c.goto(c.exit ?? c.pos, Math.max(c.speed, c.exitMode === 'fly' ? 12 : 1.4));
    this.critters.push(c);
  }
  private exitsHeld = new Map<Critter, () => void>();

  /** a prop (or held critter) that follows a person until they have gone through their sink */
  adoptCarried(obj: THREE.Object3D, pid: string, y = 1.0, fwd = 0.35, critter?: Critter): void {
    this.group.attach(obj);
    const info = this.person(pid);
    this.carried.push({ obj, pid, y, fwd, yaw: obj.rotation.y, prev: info ? info.position.clone() : obj.position.clone(), critter });
  }

  private person(pid: string) { try { return this.ctx.reg.people.get(pid); } catch { return undefined; } }

  get busy(): boolean { return this.critters.length > 0 || this.carried.length > 0; }

  update(dt: number, dm: number): void {
    for (let i = this.critters.length - 1; i >= 0; i--) {
      const c = this.critters[i];
      c.update(dt, dm);
      if (!c.target || !c.present) {
        c.leaveNow();
        c.dispose();
        this.exitsHeld.get(c)?.();
        this.exitsHeld.delete(c);
        this.critters.splice(i, 1);
      }
    }
    for (let i = this.carried.length - 1; i >= 0; i--) {
      const k = this.carried[i];
      const info = this.person(k.pid);
      if (!info) {
        // the carrier faded through a door / into a vehicle: the prop went with them
        // (a carried animal goes wherever its carrier went: audited as part of that person's legit exit)
        if (k.critter) { try { this.ctx.origins.audit('events', 'despawn', 'people', k.obj.position, `${k.critter.label} (carried)`); } catch { /* none */ } }
        k.obj.removeFromParent();
        disposeTree(k.obj);
        this.carried.splice(i, 1);
        continue;
      }
      // a carried animal is still alive (the goose fidgets in its basket, the cat squirms)
      if (k.critter) { k.critter.held = true; k.critter.update(dt, 0); }
      const p = info.position;
      const dx = p.x - k.prev.x, dz = p.z - k.prev.z;
      if (dx * dx + dz * dz > 1e-5) k.yaw = Math.atan2(-dz, dx);
      k.prev.copy(p);
      k.obj.position.set(p.x + Math.cos(k.yaw) * k.fwd, p.y + k.y, p.z - Math.sin(k.yaw) * k.fwd);
      k.obj.rotation.y = k.yaw;
    }
  }
}

const lingerByCtx = new WeakMap<object, Linger>();
export function getLinger(ctx: Ctx): Linger {
  let l = lingerByCtx.get(ctx);
  if (!l) { l = new Linger(ctx); lingerByCtx.set(ctx, l); }
  return l;
}
