import type { IdleStyle, PersonAnim } from '../core/apis';
import { PROP_ARM } from './geometry';
import type { Person } from './types';

/*
 * POSES & THE IDLE LAYER (visual only, evaluated once per rendered frame for on-screen people).
 *
 * NO STATIONARY PEOPLE: whenever someone stands, sits or rides, a layered idle runs on top of the base pose:
 *   - continuous: breathing (shader), slow weight sway, head glances;
 *   - clips every 2–10 s (never more than ~12 s without one): pocket-watch checks, looks down the line, weight
 *     shifts, folded arms, hat tips, yawns at night, hand-rubbing and foot-stamping in the cold, chat gestures,
 *     nods and laughs, newspaper page turns, children hopping and spinning, hawkers calling out, pipe puffs…
 * The idle style comes from setIdle()/scripts, or is derived from the person's state and role.
 */

const enum Clip {
  None = 0, Watch, Look, Shift, Fold, Scratch, Tip, Point, Yawn, Rub, Stamp, Gesture, Nod, Laugh, Page, Hop, Spin,
  Wave, Pipe, Drink, Crouch, Stretch, Cast, Reel,
}

const CLIP_DUR: Record<number, number> = {
  [Clip.Watch]: 2.6, [Clip.Look]: 3.2, [Clip.Shift]: 1.4, [Clip.Fold]: 5, [Clip.Scratch]: 1.3, [Clip.Tip]: 1.0,
  [Clip.Point]: 1.8, [Clip.Yawn]: 2.0, [Clip.Rub]: 2.4, [Clip.Stamp]: 1.8, [Clip.Gesture]: 2.4, [Clip.Nod]: 1.6,
  [Clip.Laugh]: 1.6, [Clip.Page]: 1.1, [Clip.Hop]: 1.8, [Clip.Spin]: 1.2, [Clip.Wave]: 1.8, [Clip.Pipe]: 2.2,
  [Clip.Drink]: 2.0, [Clip.Crouch]: 4, [Clip.Stretch]: 1.8, [Clip.Cast]: 1.8, [Clip.Reel]: 3.2,
};

type W = [Clip, number][];
/** clips other modules can request via person.data.forceClip */
const FORCE: Record<string, Clip> = { reel: Clip.Reel, cast: Clip.Cast, watch: Clip.Watch, wave: Clip.Wave, tip: Clip.Tip, point: Clip.Point, laugh: Clip.Laugh, stretch: Clip.Stretch };
const STYLE_CLIPS: Record<IdleStyle, W> = {
  wait: [[Clip.Watch, 2], [Clip.Look, 3], [Clip.Shift, 3], [Clip.Fold, 1.2], [Clip.Scratch, 0.5], [Clip.Tip, 0.3], [Clip.Point, 0.3]],
  chat: [[Clip.Gesture, 4], [Clip.Nod, 3], [Clip.Laugh, 1.5], [Clip.Shift, 1], [Clip.Look, 0.6], [Clip.Tip, 0.3]],
  read: [[Clip.Page, 3], [Clip.Look, 1], [Clip.Shift, 1], [Clip.Nod, 0.5]],
  watch: [[Clip.Look, 2], [Clip.Point, 1], [Clip.Shift, 1.5], [Clip.Wave, 0.4], [Clip.Watch, 0.6]],
  fidget: [[Clip.Hop, 3], [Clip.Spin, 1.5], [Clip.Look, 2], [Clip.Wave, 1], [Clip.Shift, 1], [Clip.Point, 1]],
  work: [[Clip.Shift, 1], [Clip.Look, 1.5], [Clip.Stretch, 0.4], [Clip.Scratch, 0.3]],
  fish: [[Clip.Cast, 1.2], [Clip.Look, 2], [Clip.Shift, 1], [Clip.Reel, 0.5], [Clip.Pipe, 0.3]],
  smoke: [[Clip.Pipe, 3], [Clip.Look, 2], [Clip.Shift, 1], [Clip.Nod, 0.5]],
  sweep: [[Clip.Look, 1], [Clip.Shift, 0.5], [Clip.Stretch, 0.4]],
  shelter: [[Clip.Fold, 2], [Clip.Rub, 2], [Clip.Look, 2], [Clip.Shift, 1], [Clip.Stamp, 0.8]],
  drink: [[Clip.Drink, 4], [Clip.Laugh, 2], [Clip.Gesture, 2], [Clip.Nod, 1]],
  garden: [[Clip.Crouch, 4], [Clip.Stretch, 1], [Clip.Look, 1]],
  sell: [[Clip.Wave, 3], [Clip.Gesture, 2], [Clip.Look, 2], [Clip.Point, 1]],
};

let seedState = 0x2545f491;
function rnd(): number {
  // xorshift32: visual-only randomness (never touches the seeded sim rng)
  seedState ^= seedState << 13; seedState ^= seedState >>> 17; seedState ^= seedState << 5;
  return ((seedState >>> 0) % 100000) / 100000;
}

function pick(w: W, cold: boolean, night: boolean): Clip {
  let tot = 0;
  for (const [, x] of w) tot += x;
  const extra = (cold ? 2.6 : 0) + (night ? 0.6 : 0);
  let r = rnd() * (tot + extra);
  for (const [c, x] of w) { r -= x; if (r <= 0) return c; }
  if (cold && r <= 2.6) return rnd() < 0.6 ? Clip.Rub : Clip.Stamp;
  return Clip.Yawn;
}

const angDiff = (a: number, b: number) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

export interface PoseEnv { cold: boolean; night: boolean; lookX: number; lookZ: number; hasLook: boolean }

/** pose outputs (module-level to avoid allocation) */
export const out = { bob: 0, roll: 0, lean: 0, amp: 0, rT: 0, rW: 0, lT: 0, lW: 0, hYaw: 0, hPitch: 0, yawOff: 0, phase: 0 };

export function idleStyleOf(p: Person): IdleStyle {
  if (p.idle) return p.idle;
  const s = p.state;
  if (s === 'chatting' || s === 'meeting' || s === 'gossiping') return 'chat';
  if (p.look.child) return 'fidget';
  if (p.accSlots.newspaper !== undefined) return 'read';
  if (p.role === 'angler') return 'fish';
  if (p.role === 'vendor') return 'sell';
  if (s === 'ready' || s === 'waiting for someone') return 'watch';
  if (s === 'waiting' || s === 'queueing' || s === 'seated') return 'wait';
  if (p.role === 'bargee' || p.role === 'cabman' || p.role === 'drayman') return 'smoke';
  return 'wait';
}

/**
 * Compute the pose of `p` at visual time t. Mutates p's idle-clip / head state (visual only).
 */
export function computePose(p: Person, t: number, fdt: number, env: PoseEnv): void {
  const o = out;
  o.bob = 0; o.roll = 0; o.lean = 0; o.amp = 0; o.rT = 0; o.rW = 0; o.lT = 0; o.lW = 0; o.hYaw = 0; o.hPitch = 0; o.yawOff = 0;
  o.phase = p.phase;
  const sd = p.seed;
  const L = p.look;
  const rp = p.riding?.pose;
  let anim: PersonAnim;
  if (rp) anim = rp === 'stand' ? (p.manualAnim ?? 'idle') : rp === 'fish' ? 'fish' : rp;
  else if (p.moving) anim = p.manualAnim === 'skate' ? 'skate' : (p.running || p.manualAnim === 'run' ? 'run' : (p.manualAnim === 'carry' || p.manualAnim === 'push' || p.manualAnim === 'lead' ? p.manualAnim : 'walk'));
  else anim = p.manualAnim ?? 'idle';

  let still = false; // eligible for idle clips
  let style: IdleStyle | null = null;
  switch (anim) {
    case 'walk':
      o.amp = 0.42; o.bob = Math.abs(Math.sin(p.phase)) * 0.045; o.roll = Math.sin(p.phase) * 0.035; o.lean = 0.05;
      if (p.state === 'wobbling') { o.roll += Math.sin(t * 1.3 + sd) * 0.12; o.yawOff = Math.sin(t * 0.9 + sd) * 0.3; }
      break;
    case 'run':
      o.amp = 0.68; o.bob = Math.abs(Math.sin(p.phase)) * 0.08; o.roll = Math.sin(p.phase) * 0.05; o.lean = 0.18;
      break;
    case 'skate':
      o.amp = 0.22; o.phase = p.phase * 0.45; o.lean = 0.28; o.roll = Math.sin(p.phase * 0.45) * 0.16;
      o.rT = -0.5 + 0.2 * Math.sin(p.phase * 0.45); o.lT = -0.5 - 0.2 * Math.sin(p.phase * 0.45); o.rW = o.lW = 0.8;
      break;
    case 'carry':
      o.amp = p.moving ? 0.36 : 0; o.bob = p.moving ? Math.abs(Math.sin(p.phase)) * 0.04 : 0; o.rT = o.lT = -0.95; o.rW = o.lW = 1; o.lean = -0.04;
      still = !p.moving;
      break;
    case 'push':
      o.amp = p.moving ? 0.4 : 0; o.rT = o.lT = -1.2; o.rW = o.lW = 1; o.lean = 0.2;
      still = !p.moving;
      break;
    case 'lead':
      o.amp = p.moving ? 0.4 : 0; o.bob = p.moving ? Math.abs(Math.sin(p.phase)) * 0.04 : 0; o.rT = -0.55; o.rW = 1;
      still = !p.moving;
      break;
    case 'sit':
      still = true; style = null;
      break;
    case 'drive':
      o.rT = o.lT = -0.85 + 0.05 * Math.sin(t * 3 + sd); o.rW = o.lW = 1; o.bob = Math.abs(Math.sin(t * 5.5 + sd)) * 0.012;
      still = true; style = 'smoke';
      break;
    case 'row': {
      const c = Math.sin(t * 2.4 + sd);
      o.rT = o.lT = -1.3 + 0.6 * c; o.rW = o.lW = 1; o.lean = 0.28 * c;
      break;
    }
    case 'pole': {
      const c = Math.sin(t * 1.1 + sd);
      o.rT = o.lT = -2.0 + 0.5 * c; o.rW = o.lW = 1; o.lean = 0.18 * c;
      break;
    }
    case 'work':
      o.rT = -1.0 + 0.5 * Math.sin(t * 7 + sd); o.rW = 1; o.lT = -1.0 + 0.5 * Math.sin(t * 7 + sd + 2.2); o.lW = 1; o.lean = 0.18;
      break;
    case 'sweep': {
      const c = Math.sin(t * 4.2 + sd);
      o.rT = -0.5 + 0.16 * c; o.rW = 1; o.lT = -0.75 + 0.1 * c; o.lW = 0.8; o.yawOff = 0.32 * c; o.lean = 0.16;
      break;
    }
    case 'hammer': {
      const s = (t * 1.25 + sd) % 1;
      const a = s < 0.72 ? -0.9 - 1.5 * (s / 0.72) : -2.4 + 1.5 * ((s - 0.72) / 0.28);
      o.rT = a; o.rW = 1; o.lT = -0.95; o.lW = 1; o.lean = 0.14; o.hPitch = 0.3;
      break;
    }
    case 'shovel': case 'pitchfork': case 'scythe': {
      const c = Math.sin(t * 2.6 + sd);
      o.rT = -0.9 + 0.35 * c; o.lT = -0.95 + 0.35 * c; o.rW = o.lW = 1; o.lean = 0.26 + 0.14 * c; o.yawOff = 0.28 * Math.sin(t * 1.3 + sd);
      o.hPitch = 0.25;
      break;
    }
    case 'wash': {
      const c = Math.sin(t * 6 + sd);
      o.rT = -1.0 + 0.25 * c; o.lT = -1.0 - 0.25 * c; o.rW = o.lW = 1; o.lean = 0.38; o.hPitch = 0.3;
      break;
    }
    case 'light':
      o.rT = -1.45 + 0.04 * Math.sin(t * 3 + sd); o.rW = 1; o.lT = -0.4; o.lW = 0.5; o.hPitch = -0.5; o.lean = -0.05;
      break;
    case 'fish':
      o.rT = -0.8 + 0.04 * Math.sin(t * 0.7 + sd); o.rW = 1; o.lT = -0.65; o.lW = 0.7; o.hPitch = 0.15;
      still = true; style = 'fish';
      break;
    case 'read':
      still = true; style = 'read';
      break;
    case 'chat': still = true; style = 'chat'; break;
    case 'watch': still = true; style = 'watch'; break;
    case 'wave':
      o.rT = -2.8 + 0.3 * Math.sin(t * 11 + sd); o.rW = 1; o.hPitch = -0.1;
      break;
    case 'point':
      o.rT = -1.55; o.rW = 1;
      break;
    case 'drink': still = true; style = 'drink'; break;
    case 'cheer':
      o.rT = -2.75 + 0.3 * Math.sin(t * 9 + sd); o.lT = -2.75 + 0.3 * Math.sin(t * 9 + sd + 1.5); o.rW = o.lW = 1;
      o.bob = Math.max(0, Math.sin(t * 9 + sd)) * 0.12; o.hPitch = -0.25;
      break;
    case 'play':
      if (L.accs.includes('instrument')) {
        o.rT = -1.3 + 0.12 * Math.sin(t * 6 + sd); o.lT = -1.3; o.rW = o.lW = 1; o.roll = Math.sin(t * 3 + sd) * 0.05; o.bob = Math.abs(Math.sin(t * 3 + sd)) * 0.03;
      } else if (L.child) {
        o.bob = Math.abs(Math.sin(t * 8 + sd)) * 0.14; o.rT = -1.6 + 0.8 * Math.sin(t * 8 + sd); o.lT = -1.6 - 0.8 * Math.sin(t * 8 + sd); o.rW = o.lW = 0.8;
      } else {
        o.rT = -2.75 + 0.18 * Math.sin(t * 5 + sd); o.rW = 1;
      }
      break;
    default: // 'idle' and unknown clips
      still = true;
      break;
  }

  if (still) {
    const st: IdleStyle = style ?? idleStyleOf(p);
    // base pose per style
    o.roll += p.rollBias + Math.sin(t * 0.9 + sd) * 0.012;
    if (st === 'read') { o.rT = o.lT = -1.0; o.rW = o.lW = 1; o.hPitch += 0.38; }
    else if (st === 'shelter') { o.lean += 0.08; }
    else if (st === 'garden') { o.lean += 0.2; }
    // clip scheduler (visual time)
    if (p.clipT > 0) p.clipT -= fdt;
    else {
      p.nextClip -= fdt;
      if (p.nextClip <= 0) {
        const fc = p.data.forceClip as string | undefined;
        if (fc) { p.data.forceClip = undefined; p.clip = FORCE[fc] ?? Clip.Look; }
        else p.clip = pick(STYLE_CLIPS[st], env.cold && st !== 'read', env.night);
        p.clipDur = p.clipT = CLIP_DUR[p.clip] ?? 1.5;
        p.clipSign = rnd() < 0.5 ? -1 : 1;
        p.nextClip = 1.5 + rnd() * (st === 'chat' || st === 'fidget' ? 4 : 8);
        if (p.clip === Clip.Shift) p.rollBias = p.clipSign * (0.02 + rnd() * 0.025);
        if (p.clip === Clip.Look) { p.glanceYaw = p.clipSign * (0.6 + rnd() * 0.5); p.glanceT = CLIP_DUR[Clip.Look]; }
      }
    }
    if (p.clipT > 0) {
      const el = p.clipDur - p.clipT;
      const k = clamp(Math.min(el * 3.5, p.clipT * 3.5), 0, 1);
      switch (p.clip) {
        case Clip.Watch: o.lT = -1.65; o.lW = Math.max(o.lW, k); o.hPitch += 0.45 * k; break;
        case Clip.Fold: if (o.rW < 0.5) { o.rT = o.lT = -0.72; o.rW = o.lW = 0.9 * k; } break;
        case Clip.Scratch: o.rT = -2.75; o.rW = k; o.hPitch += 0.15 * k; break;
        case Clip.Tip: o.rT = -2.65; o.rW = k; o.hPitch += 0.2 * k; break;
        case Clip.Point: o.rT = -1.55; o.rW = k; break;
        case Clip.Yawn: o.rT = o.lT = -2.9; o.rW = o.lW = k; o.hPitch -= 0.35 * k; break;
        case Clip.Rub: o.rT = o.lT = -1.2 + 0.15 * Math.sin(t * 16); o.rW = o.lW = k; o.hPitch += 0.1 * k; break;
        case Clip.Stamp: o.bob += Math.abs(Math.sin(t * 7)) * 0.04 * k; o.amp = 0.22 * k; o.phase = t * 7; break;
        case Clip.Gesture: o.rT = -1.2 - 0.5 * Math.sin(t * 5 + sd); o.rW = k; if (p.clipSign > 0) { o.lT = -1.0 - 0.4 * Math.sin(t * 4 + sd); o.lW = k * 0.8; } break;
        case Clip.Nod: o.hPitch += 0.2 * Math.sin(t * 7) * k; break;
        case Clip.Laugh: o.bob += Math.abs(Math.sin(t * 11)) * 0.03 * k; o.hPitch -= 0.28 * k; break;
        case Clip.Page: o.rT = -1.0 - 0.7 * k; o.rW = 1; break;
        case Clip.Hop: o.bob += Math.abs(Math.sin(t * 9 + sd)) * 0.15 * k; o.amp = 0.2 * k; o.phase = t * 9; o.rT = o.lT = -0.6; o.rW = o.lW = 0.6 * k; break;
        case Clip.Spin: o.yawOff += p.clipSign * Math.PI * 2 * (el / p.clipDur); o.bob += Math.abs(Math.sin(t * 10)) * 0.05; o.rT = o.lT = -1.5; o.rW = o.lW = k; break;
        case Clip.Wave: o.rT = -2.8 + 0.3 * Math.sin(t * 12); o.rW = k; break;
        case Clip.Pipe: o.rT = -2.15; o.rW = k; break;
        case Clip.Drink: o.rT = -2.25; o.rW = k; o.hPitch -= 0.25 * k; break;
        case Clip.Crouch: o.lean += 0.45 * k; o.rT = o.lT = -1.0 + 0.2 * Math.sin(t * 5); o.rW = o.lW = k; o.hPitch += 0.3 * k; break;
        case Clip.Stretch: o.rT = o.lT = -3.0; o.rW = o.lW = k; o.lean -= 0.12 * k; o.hPitch -= 0.25 * k; break;
        case Clip.Cast: {
          // back-cast then flick forward (rod follows the right arm)
          const u = el / p.clipDur;
          o.rT = u < 0.45 ? -0.8 - 1.8 * (u / 0.45) : u < 0.62 ? -2.6 + 2.2 * ((u - 0.45) / 0.17) : -0.4 - 0.4 * ((u - 0.62) / 0.38);
          o.rW = 1; o.lean += (u < 0.45 ? -0.1 : 0.12) * k;
          break;
        }
        case Clip.Reel: o.rT = -1.35; o.rW = 1; o.lT = -0.9 + 0.35 * Math.sin(t * 18); o.lW = 1; o.lean -= 0.12 * k; o.hPitch += 0.2 * k; break;
        default: break;
      }
    }
  } else {
    p.rollBias *= 0.9;
  }

  // prop-held arm poses (design angle) unless the anim drives that arm
  const accs = p.accSlots;
  for (const k in accs) {
    const pa = PROP_ARM[k as keyof typeof PROP_ARM];
    if (!pa) continue;
    if (pa.side === 'r' && o.rW < 0.99) { o.rT = pa.angle; o.rW = 1; }
    else if (pa.side === 'l' && o.lW < 0.99) { o.lT = pa.angle; o.lW = 1; }
  }
  if (accs.trolley !== undefined) { if (anim !== 'work') { o.rT = o.lT = -1.2; o.rW = o.lW = 1; } o.lean = Math.max(o.lean, 0.1); }
  else if (accs.instrument !== undefined && anim !== 'play' && anim !== 'cheer') { o.rT = o.lT = -1.1; o.rW = o.lW = 1; }
  else if (accs.bouquet !== undefined && anim !== 'cheer') { o.rT = o.lT = -0.9; o.rW = o.lW = 1; }
  else if ((accs.newspaper !== undefined || accs.tray !== undefined) && anim !== 'cheer') { if (o.rW < 0.99 || o.rT > -0.6) { o.rT = -1.0; o.rW = 1; } o.lT = -1.0; o.lW = 1; }
  if ((accs.suitcase !== undefined || accs.basket !== undefined || accs.pail !== undefined || accs.parcel !== undefined) && o.lW === 0) { o.lT = 0.05; o.lW = 0.65; }

  // head: look target > clip glance > gentle wander
  let hy = 0, hp = 0;
  if (env.hasLook) {
    const want = Math.atan2(env.lookX - p.pos.x, env.lookZ - p.pos.z);
    hy = clamp(angDiff(p.yaw + o.yawOff, want), -1.15, 1.15);
  } else {
    p.glanceT -= fdt;
    if (p.glanceT <= 0) {
      p.glanceT = 1.8 + rnd() * 4.5;
      const range = p.moving ? 0.35 : 0.75;
      p.glanceYaw = (rnd() * 2 - 1) * range;
      p.glancePitch = (rnd() * 2 - 1) * 0.12;
    }
    hy = p.glanceYaw;
    hp = p.glancePitch;
  }
  const kk = Math.min(1, fdt * 4.5);
  p.headYaw += (hy - p.headYaw) * kk;
  p.headPitch += (hp - p.headPitch) * kk;
  o.hYaw = clamp(p.headYaw + o.hYaw, -1.3, 1.3);
  o.hPitch = clamp(p.headPitch + o.hPitch, -0.6, 0.65);
}
