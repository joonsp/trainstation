import * as THREE from 'three';
import type { Ctx } from '../core/types';
import type { BoatInfo, CritterInfo, PersonInfo, VehicleInfo } from '../core/apis';
import {
  BOAT_NAME, BUILDING_KIND, CRITTER_NAME, FLOCK_NOUN, HORSELESS, IDLE_NAME, VEHICLE_FLAVOUR, VEHICLE_NAME, cap, doingPhrase, esc, horseNames, humanize,
  nearTown, placeName, roadName, roleName,
} from './names';
import { townActivity } from './worldcard';

/**
 * Inspect cards for the v2 selectables. Each factory returns the card's static HTML (with data-k slots) and an
 * update(refs) that refreshes the live values; update returns false once the thing has gone.
 */
export interface LiveCard {
  html: string;
  update(r: Record<string, HTMLElement>): boolean;
  /** text shown in the 'state' slot once the thing has gone */
  gone: string;
  followable: boolean;
}

const safe = <T,>(f: () => T, d: T): T => { try { return f() ?? d; } catch { return d; } };
const mph = (ms: number) => `${Math.round(Math.abs(ms) * 2.237)} mph`;
const set = (el: HTMLElement | undefined, html: string) => { if (el && el.innerHTML !== html) el.innerHTML = html; };
const person = (ctx: Ctx, id: string) => safe(() => ctx.reg.people.get(id), undefined as PersonInfo | undefined);
const who = (p: PersonInfo | undefined) => {
  if (!p) return '';
  const role = roleName(p.role);
  // "Coachman Fotheringham (Coachman)" reads badly: only add the role when the name doesn't already carry it
  return p.name.toLowerCase().startsWith(role.split(' ')[0]!.toLowerCase()) ? esc(p.name) : `${esc(p.name)} <span class="muted">(${esc(role)})</span>`;
};

/** where a road leads: the portal's far town, or the town nearest the node */
function nodePlace(ctx: Ctx, nodeId: string): string {
  const L = ctx.layout;
  const portal = L.portals.find((p) => p.kind === 'road' && (p.id === nodeId || p.road && (L.roads.edges[p.road]?.a === nodeId || L.roads.edges[p.road]?.b === nodeId) && L.roads.nodes[nodeId]?.kind === 'portal'));
  if (portal) return portal.towards;
  if (nodeId === 'mews' || nodeId.includes('mews')) return 'Crown Mews';
  if (nodeId === 'entrance' || nodeId.startsWith('fc')) return 'the station';
  const n = L.roads.nodes[nodeId];
  return n ? nearTown(ctx, n.pos.x, n.pos.z) : '';
}

const BTNS = (follow: boolean) => `<div class="btns">${follow ? '<button class="brass" data-act="follow" data-k="fbtn">Follow</button>' : ''}<button data-act="focus">Look closer</button></div>`;

// ───────────────────────── vehicles ─────────────────────────
const VSTATE: Record<VehicleInfo['state'], string> = { driving: 'On the road', stopped: 'Drawn up', loading: 'Taking up', waiting: 'Waiting', gone: 'Gone', depot: 'In the yard' };

export function vehicleCard(ctx: Ctx, id: string): LiveCard | null {
  const v0 = safe(() => ctx.reg.traffic.get(id), undefined);
  if (!v0) return null;
  const horseless = HORSELESS.has(v0.kind);
  let lastEdge = '', lastS = 0, heading = '';
  return {
    followable: true,
    gone: 'Gone beyond the district',
    html: `<button class="x" data-act="close" title="Close">×</button>
      <div class="plate" data-k="name"></div>
      <div class="muted sub" data-k="kind"></div>
      <dl class="kv">
        ${horseless ? '' : '<dt>Horses</dt><dd data-k="horse"></dd>'}
        <dt>${v0.kind === 'motorwagen' ? 'Motorist' : 'Driver'}</dt><dd data-k="driver"></dd>
        <dt>${v0.kind === 'omnibus' ? 'Passengers' : 'Fares'}</dt><dd data-k="fares"></dd>
        <dt>Where</dt><dd data-k="where"></dd>
        <dt>Doing</dt><dd data-k="state"></dd>
        <dt>Bound for</dt><dd data-k="dest"></dd>
      </dl>${BTNS(true)}`,
    update(r) {
      const v = safe(() => ctx.reg.traffic.get(id), undefined);
      if (!v || v.state === 'gone') return false;
      set(r.name, esc(v.label || VEHICLE_NAME[v.kind] || humanize(v.kind)));
      const kname = VEHICLE_NAME[v.kind] ?? humanize(v.kind);
      const lead = v.label && v.label !== kname ? kname : VEHICLE_FLAVOUR[v.kind] ?? '';
      set(r.kind, `${esc(lead)}${v.tag ? ` · ${esc(humanize(v.tag))}` : ''}`);
      if (r.horse) set(r.horse, v.horses > 0 ? `${v.horses} · <i>${esc(horseNames(id, v.horses))}</i>` : '<span class="muted">—</span>');
      const riders = v.riders ?? [];
      set(r.driver, riders.length ? who(person(ctx, riders[0]!)) || '<span class="muted">unknown</span>' : '<span class="muted">none aboard</span>');
      const fares = Math.max(0, riders.length - 1), room = Math.max(0, (v.seats ?? 0) - 1);
      set(r.fares, room ? `${fares} of ${room}` : String(fares));
      const road = roadName(ctx, v.edge);
      const town = nearTown(ctx, v.pos.x, v.pos.z);
      const beyond = Math.max(Math.abs(v.pos.x), Math.abs(v.pos.z)) > ctx.layout.terrain.half;
      set(r.where, esc(v.edge === 'FC' ? 'Station forecourt' : beyond ? `${road ? `${road}, b` : 'B'}eyond the parish bounds` : `${road || 'Off the road'}${town && !road.includes(town) ? `, near ${town}` : ''}`));
      const st = VSTATE[v.state] ?? humanize(v.state);
      set(r.state, esc(v.state === 'driving' ? `${st} at ${mph(v.speed)}` : v.stop ? `${st} at ${placeName(ctx, v.stop)}` : st));
      // direction of travel along the current road edge → the town at that end
      if (v.edge === lastEdge && Math.abs(v.s - lastS) > 0.3) {
        const e = ctx.layout.roads.edges[v.edge];
        if (e) heading = nodePlace(ctx, v.s > lastS ? e.b : e.a);
      }
      if (v.edge !== lastEdge || Math.abs(v.s - lastS) > 0.3) { lastEdge = v.edge; lastS = v.s; }
      const vd = v.dest;
      const dest = vd ? (ctx.layout.roads.nodes[vd] ? nodePlace(ctx, vd) : placeName(ctx, vd)) || heading : v.stop && v.state === 'driving' ? placeName(ctx, v.stop) : heading;
      set(r.dest, esc(dest || (v.tag ? humanize(v.tag) : '—')));
      return true;
    },
  };
}

// ───────────────────────── boats ─────────────────────────
const BSTATE: Record<BoatInfo['state'], string> = { moored: 'Moored', underway: 'Under way', inLock: 'Working through the lock', hauled: 'Hauled out' };
const ACTIVITY_BY_ROLE: Record<string, string> = { angler: 'fishing', rower: 'rowing', bargee: 'working the boat', punter: 'punting', skater: 'skating' };

export function boatCard(ctx: Ctx, id: string): LiveCard | null {
  const b0 = safe(() => ctx.reg.nature.boat(id), undefined);
  if (!b0) return null;
  return {
    followable: true,
    gone: 'Gone down the river',
    html: `<button class="x" data-act="close" title="Close">×</button>
      <div class="plate p" data-k="name"></div>
      <div class="muted sub" data-k="kind"></div>
      <dl class="kv">
        <dt>Crew</dt><dd data-k="crew"></dd>
        <dt>Doing</dt><dd data-k="state"></dd>
        <dt>Reach</dt><dd data-k="where"></dd>
      </dl>${BTNS(true)}`,
    update(r) {
      const b = safe(() => ctx.reg.nature.boat(id), undefined);
      if (!b) return false;
      set(r.name, esc(b.name || BOAT_NAME[b.kind]));
      set(r.kind, esc(BOAT_NAME[b.kind] ?? humanize(b.kind)));
      const crew = (b.riders ?? []).map((pid) => person(ctx, pid)).filter((p): p is PersonInfo => !!p);
      set(r.crew, crew.length ? crew.slice(0, 5).map((p) => who(p)).join('<br>') + (crew.length > 5 ? `<br><span class="muted">and ${crew.length - 5} more</span>` : '') : '<span class="muted">none aboard</span>');
      const act = crew.map((p) => ACTIVITY_BY_ROLE[p.role]).find(Boolean);
      const st = BSTATE[b.state] ?? humanize(b.state);
      set(r.state, esc(b.state === 'underway' ? `${st}${act ? `, ${act}` : ''} at ${mph(b.speed)}` : `${st}${act ? `; ${act}` : ''}`));
      set(r.where, esc(riverReach(ctx, b.pos)));
      return true;
    },
  };
}

function riverReach(ctx: Ctx, p: THREE.Vector3): string {
  const R = ctx.layout.river;
  const n = safe(() => R.nearest(p), { s: 0, lat: 0, d: 0 });
  const reach = R.reaches.find((x) => n.s >= x.s0 && n.s <= x.s1);
  if (reach) return reach.id === 'regatta' ? 'The regatta reach' : reach.id === 'millpool' ? 'The mill pool' : 'The skating reach';
  if (Math.abs(n.s - R.lock.s0) < 30 || Math.abs(n.s - R.lock.s1) < 30) return 'At Millbridge lock';
  if (n.s < R.weir.s) return 'Above the weir';
  return 'Below the weir';
}

// ───────────────────────── animals ─────────────────────────
function moodOf(state: string, kind: string): string {
  const s = state.toLowerCase();
  if (/scare|flee|bolt|startl|panic|scatter/.test(s)) return 'Startled!';
  if (/graz|feed|peck|forag|dabbl/.test(s)) return 'Content, feeding';
  if (/sleep|rest|roost|lie|doze/.test(s)) return 'Dozing';
  if (/herd|driv|follow|walk|flock/.test(s)) return 'On the move';
  if (/fish|stalk|hunt/.test(s)) return 'Intent on its quarry';
  if (/fly|soar|circl/.test(s)) return 'On the wing';
  if (/swim|paddl/.test(s)) return 'Paddling about';
  if (/bark|guard|work/.test(s)) return kind === 'dog' ? 'Keenly at work' : 'Busy';
  return 'Placid';
}

export function animalCard(ctx: Ctx, id: string): LiveCard | null {
  const a0 = safe(() => ctx.reg.nature.get(id), undefined);
  if (!a0) return null;
  let groupSig = '', groupN = 0, lastCount = 0;
  return {
    followable: true,
    gone: 'Wandered out of sight',
    html: `<button class="x" data-act="close" title="Close">×</button>
      <div class="plate p" data-k="name"></div>
      <dl class="kv">
        <dt>Kind</dt><dd data-k="kind"></dd>
        <dt>Company</dt><dd data-k="flock"></dd>
        <dt>Mood</dt><dd data-k="mood"></dd>
        <dt>Doing</dt><dd data-k="state"></dd>
        <dt>Where</dt><dd data-k="where"></dd>
      </dl>${BTNS(true)}`,
    update(r) {
      const a = safe(() => ctx.reg.nature.get(id), undefined as CritterInfo | undefined);
      if (!a) return false;
      set(r.name, esc(a.label || CRITTER_NAME[a.kind] || humanize(a.kind)));
      set(r.kind, esc(CRITTER_NAME[a.kind] ?? humanize(a.kind)));
      const now = performance.now();
      if (a.group !== groupSig || now - lastCount > 2000) {
        groupSig = a.group ?? ''; lastCount = now;
        groupN = a.group ? safe(() => ctx.reg.nature.list(a.kind).filter((x) => x.group === a.group).length, 0) : 0;
      }
      const noun = FLOCK_NOUN[a.kind] ?? 'group';
      set(r.flock, a.group && groupN > 1 ? `One of a ${noun} of ${groupN}${/^[A-Z]/.test(a.group) ? ` (${esc(a.group)})` : ''}` : '<span class="muted">On its own</span>');
      set(r.mood, esc(moodOf(a.state ?? '', a.kind)));
      set(r.state, esc(humanize(a.state ?? 'idle')));
      const field = ctx.layout.fields.find((f) => Math.hypot(f.center.x - a.pos.x, f.center.z - a.pos.z) < 60);
      const town = nearTown(ctx, a.pos.x, a.pos.z);
      const river = safe(() => ctx.layout.terrain.riverDist(a.pos.x, a.pos.z), 99) < 4;
      set(r.where, esc(river ? `On the Ashbourne${town ? `, by ${town}` : ''}` : field ? `${field.name}` : town ? `About ${town}` : 'In the open country'));
      return true;
    },
  };
}

// ───────────────────────── buildings ─────────────────────────
export function buildingCard(ctx: Ctx, id: string): LiveCard | null {
  const b = ctx.layout.buildings.find((x) => x.id === id);
  if (!b) return null;
  const town = ctx.layout.towns.find((t) => t.id === b.town);
  const townName = town && town.id !== 'river' && town.id !== 'lc1' ? town.name : '';
  const doorIds = b.doors.map((_, k) => `door:${b.id}:${k}`);
  return {
    followable: false,
    gone: '',
    html: `<button class="x" data-act="close" title="Close">×</button>
      <div class="plate" data-k="name"></div>
      <div class="muted sub">${esc(BUILDING_KIND[b.kind] ?? humanize(b.kind))}${townName ? ` · ${esc(townName)}` : ''} · ${esc(cap(b.walls === 'whitewash' ? 'whitewashed' : b.walls === 'brickDark' ? 'blue brick' : b.walls))}, ${esc(b.roof)} roof</div>
      <dl class="kv">
        <dt>Indoors</dt><dd data-k="inside"></dd>
        <dt>Out &amp; about</dt><dd data-k="out"></dd>
        <dt>Hearth</dt><dd data-k="hearth"></dd>
        ${townName ? '<dt>In town</dt><dd data-k="town"></dd>' : ''}
      </dl>${BTNS(false)}`,
    update(r) {
      set(r.name, esc(b.name));
      const inside = safe(() => ctx.origins.pools.count(b.id), b.residents);
      set(r.inside, b.residents > 0 || inside > 0 ? `${inside}${b.residents ? ` <span class="muted">of ${b.residents} residents</span>` : ''}` : '<span class="muted">nobody lives here</span>');
      const out = safe(() => ctx.reg.people.list().filter((p) => p.home === b.id), [] as PersonInfo[]);
      if (out.length) {
        const byWhat = new Map<string, number>();
        for (const p of out) {
          const k = p.riding ? 'riding abroad' : p.role === 'passenger' ? 'gone for a train' : p.idle ? IDLE_NAME[p.idle].toLowerCase() : doingPhrase(p.role, p.state).toLowerCase();
          byWhat.set(k, (byWhat.get(k) ?? 0) + 1);
        }
        set(r.out, [...byWhat].slice(0, 4).map(([k, n]) => `${n} ${esc(k)}`).join('; '));
      } else set(r.out, '<span class="muted">none</span>');
      const h = ctx.clock.hour;
      const temp = safe(() => ctx.reg.atmosphere.temperatureC, 12);
      const occupied = inside > 0 || b.kind === 'pub' || b.kind === 'inn' || b.kind === 'bakery' || b.kind === 'smithy';
      const fire = b.chimneys.length === 0 ? 'No chimney'
        : b.kind === 'smithy' && h >= 6.5 && h < 18.5 ? 'Forge fire roaring'
        : b.kind === 'bakery' && h >= 4 && h < 11 ? 'Ovens hot, bread baking'
        : occupied && (temp < 13 || h < 8 || h > 17) ? 'A fire in the grate' : 'Cold';
      set(r.hearth, esc(fire));
      if (r.town && town) set(r.town, esc(townActivity(ctx, town.id)));
      return true;
    },
  };
}
