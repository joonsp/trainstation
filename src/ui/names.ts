import type { Ctx } from '../core/types';
import type { BoatKind, CritterKind, IdleStyle, PersonRole, VehicleKind } from '../core/apis';
import type { BuildingKind } from '../core/countryside';

/** Display names and small lookups for the inspect / world cards. Pure data + tiny helpers, no DOM. */

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const humanize = (s: string) => cap(String(s ?? '').replace(/[_:-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim());

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const pick = <T,>(list: readonly T[], key: string, salt = 0): T => list[(hash(key) + salt * 7919) % list.length]!;

export const ROLE_NAME: Partial<Record<PersonRole, string>> = {
  passenger: 'Passenger', porter: 'Railway porter', stationmaster: 'Stationmaster', guard: 'Guard', mechanic: 'Fitter',
  constable: 'Police constable', pickpocket: 'Suspicious character', bride: 'Bride', groom: 'Bridegroom', guest: 'Wedding guest',
  bandsman: 'Bandsman', vip: 'Distinguished personage', crew: 'Footplate crew', clerk: 'Booking clerk', newsboy: 'Newsboy',
  farmer: 'Farmer', ringmaster: 'Ringmaster', signalman: 'Signalman', platelayer: 'Platelayer', lamplighter: 'Lamplighter',
  gatekeeper: 'Crossing keeper', lockkeeper: 'Lock-keeper', cabman: 'Cabman', coachman: 'Coachman', conductor: 'Omnibus conductor',
  drayman: 'Drayman', carter: 'Carter', milkman: 'Milkman', postman: 'Postman', motorist: 'Motorist (a novelty!)',
  townsfolk: 'Townsperson', child: 'Child', schoolchild: 'Schoolchild', vendor: 'Street vendor', publican: 'Publican',
  drinker: 'Regular at the bar', vicar: 'Vicar', washerwoman: 'Washerwoman', baker: 'Baker', blacksmith: 'Blacksmith',
  miller: 'Miller', angler: 'Angler', rower: 'Oarsman', bargee: 'Bargee', punter: 'Punter', skater: 'Skater',
  farmhand: 'Farmhand', shepherd: 'Shepherd', drover: 'Drover', ploughman: 'Ploughman', dairymaid: 'Dairymaid',
  huntsman: 'Huntsman', firefighter: 'Fireman', aeronaut: 'Aeronaut',
};
export const roleName = (r: PersonRole | string) => ROLE_NAME[r as PersonRole] ?? humanize(r);

export const IDLE_NAME: Record<IdleStyle, string> = {
  wait: 'Waiting, consulting a pocket watch', chat: 'In conversation', read: 'Reading the newspaper', watch: 'Watching the world go by',
  fidget: 'Fidgeting', work: 'Hard at work', fish: 'Fishing patiently', smoke: 'Enjoying a pipe', sweep: 'Sweeping',
  shelter: 'Sheltering from the weather', drink: 'Taking a drink', garden: 'Tending the garden', sell: 'Crying their wares',
};

export const VEHICLE_NAME: Record<VehicleKind, string> = {
  hansom: 'Hansom cab', growler: 'Four-wheeler (growler)', omnibus: 'Horse omnibus', landau: 'Landau', gig: 'Gig', mailcart: 'Royal Mail cart',
  dray: "Brewer's dray", coalcart: 'Coal cart', farmcart: 'Farm cart', haywain: 'Hay wain', milkfloat: 'Milk float', handcart: 'Handcart',
  bicycle: 'Safety bicycle', pennyfarthing: 'Penny-farthing', motorwagen: 'Benz Motorwagen', fireengine: 'Steam fire engine',
  carriage4: 'Coach and four', circuswagon: 'Circus wagon',
};
export const HORSELESS = new Set<VehicleKind>(['motorwagen', 'handcart', 'bicycle', 'pennyfarthing']);
export const HORSE_NAMES = ['Dobbin', 'Captain', 'Bess', 'Duke', 'Nell', 'Samson', 'Blossom', 'Prince', 'Hector', 'Molly', 'Punch', 'Violet',
  'Boxer', 'Clover', 'Jasper', 'Daisy', 'Major', 'Ginger', 'Bonnie', 'Rufus', 'Nutmeg', 'Old Tom', 'Sultan', 'Bramble'];
export function horseNames(id: string, n: number): string {
  if (n <= 0) return '';
  const out: string[] = [];
  for (let i = 0; out.length < Math.min(n, 4) && i < 12; i++) { const nm = pick(HORSE_NAMES, id, i); if (!out.includes(nm)) out.push(nm); }
  return out.length <= 2 ? out.join(' & ') : `${out.slice(0, -1).join(', ')} & ${out[out.length - 1]}`;
}

export const BOAT_NAME: Record<BoatKind, string> = { rowing: 'Rowing skiff', gig4: 'Coxed four', launch: 'Steam launch', narrowboat: 'Narrowboat', punt: 'Punt' };

export const CRITTER_NAME: Record<CritterKind, string> = {
  sheep: 'Sheep', cow: 'Shorthorn cow', horse: 'Horse', dog: 'Dog', hen: 'Hen', goose: 'Goose', duck: 'Mallard', swan: 'Mute swan',
  heron: 'Grey heron', crow: 'Carrion crow', starling: 'Starling', rook: 'Rook', swallow: 'Swallow', cat: 'Cat',
};
export const FLOCK_NOUN: Partial<Record<CritterKind, string>> = {
  sheep: 'flock', cow: 'herd', horse: 'string', hen: 'brood', goose: 'gaggle', duck: 'paddling', swan: 'bevy', crow: 'murder',
  starling: 'murmuration', rook: 'parliament', swallow: 'flight', dog: 'pack',
};

export const BUILDING_KIND: Record<BuildingKind, string> = {
  cottage: 'Cottage', terrace: 'Terraced cottage', house: 'House', pub: 'Public house', inn: 'Coaching inn', church: 'Parish church',
  chapel: 'Nonconformist chapel', smithy: 'Smithy', bakery: 'Bakery', post: 'Post office', shop: 'Shop', school: 'Board school',
  police: 'Police house', engineHouse: 'Fire engine house', mews: 'Livery stables', dairy: 'Dairy', farmhouse: 'Farmhouse', barn: 'Barn',
  stable: 'Stables', mill: 'Water mill', windmill: 'Post mill', lodge: "Crossing keeper's lodge", boathouse: 'Boathouse', hut: 'Hut', office: 'Office',
};

/** Beaufort force from m/s */
const BEAUFORT: [number, string][] = [
  [0.5, 'Calm'], [1.6, 'Light air'], [3.4, 'Light breeze'], [5.5, 'Gentle breeze'], [8, 'Moderate breeze'], [10.8, 'Fresh breeze'],
  [13.9, 'Strong breeze'], [17.2, 'Near gale'], [20.8, 'Gale'], [24.5, 'Strong gale'], [28.5, 'Storm'], [32.7, 'Violent storm'],
];
export function beaufort(ms: number): { force: number; name: string } {
  for (let i = 0; i < BEAUFORT.length; i++) if (ms < BEAUFORT[i]![0]) return { force: i, name: BEAUFORT[i]![1] };
  return { force: 12, name: 'Hurricane' };
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** compass point the wind blows FROM, given the world-xz vector it blows TOWARD (north = −z) */
export function windFrom(x: number, z: number): string {
  if (Math.hypot(x, z) < 1e-3) return '';
  const deg = (Math.atan2(-x, z) * 180) / Math.PI; // bearing of (−x, −z) measured from north (−z) toward east (+x)
  return COMPASS[Math.round(((deg + 360) % 360) / 22.5) % 16]!;
}

/** human place name for a stop / origin / road-node id */
export function placeName(ctx: Ctx, id: string | undefined | null): string {
  if (!id) return '';
  const L = ctx.layout;
  if (id === 'forecourt:drop') return 'the station steps';
  if (id.startsWith('forecourt:rank')) return 'the cab rank';
  if (id === 'forecourt:omnibus') return 'the omnibus stand';
  if (id === 'mews' || id.startsWith('door:crownMews') || id.includes('mews')) return 'Crown Mews';
  try {
    if (id.startsWith('door:')) {
      const bid = ctx.origins.get(id)?.building ?? id.slice(5).replace(/:\d+$/, '');
      const b = L.buildings.find((x) => x.id === bid) ?? L.buildings.find((x) => x.id.endsWith(':' + bid));
      if (b) {
        const town = L.towns.find((t) => t.id === b.town);
        return town && town.id !== 'river' && town.id !== 'lc1' && !b.name.includes(town.name) ? `${b.name}, ${town.name}` : b.name;
      }
    }
    const pid = id.startsWith('portal:') ? id.slice(7) : id;
    const portal = L.portals.find((p) => p.id === pid);
    if (portal) return portal.kind === 'river' ? `the river, ${portal.towards}` : `the road to ${portal.towards}`;
    const town = L.towns.find((t) => t.id === id);
    if (town) return town.name;
    const node = L.roads.nodes[id];
    if (node) {
      for (const e of Object.values(L.roads.edges)) if (e.a === id || e.b === id) return `${e.name} (${humanize(id)})`;
    }
    const b = L.buildings.find((x) => x.id === id);
    if (b) return b.name;
  } catch { /* layout variations */ }
  return humanize(id);
}

/** nearest town name to a point (for "near Ashcombe") */
export function nearTown(ctx: Ctx, x: number, z: number): string {
  let best = '', bd = Infinity;
  for (const t of ctx.layout.towns) {
    if (t.id === 'river' || t.id === 'lc1') continue;
    const d = Math.hypot(t.center.x - x, t.center.z - z);
    if (d < bd) { bd = d; best = t.name; }
  }
  return bd < 120 ? best : '';
}

export function roadName(ctx: Ctx, edge: string | undefined): string {
  if (!edge) return '';
  return ctx.layout.roads.edges[edge]?.name ?? humanize(edge);
}

/** friendly phrases for PersonInfo.state (free-form strings from people; unknown ones are humanized) */
const STATE_PHRASE: Record<string, string> = {
  idle: 'Passing the time', waiting: 'Waiting on the platform', actor: 'About their business', toPlatform: 'Making for the platform',
  patrolling: 'On the beat', ready: 'Standing ready', following: 'Following along', crowd: 'Among the onlookers',
  waitingRoom: 'In the waiting room', toWaitingRoom: 'Going to the waiting room', toStation: 'Setting out for the station',
  summoned: 'Called to duty', seated: 'Seated on a bench', riding: 'Riding', returning: 'Returning home', queueing: 'Queueing for a ticket',
  meeting: 'Meeting a train', inside: 'Indoors', gaveUp: 'Given up and going home', embarking: 'Climbing aboard', buying: 'Buying a ticket',
  boarding: 'Boarding the train', alighting: 'Alighting', walking: 'Walking', leaving: 'Leaving', dismissed: 'Heading off',
};
/** role-specific wording for the generic 'actor' / 'idle' states */
const ROLE_DOING: Partial<Record<PersonRole, string>> = {
  gatekeeper: 'Minding the crossing gates', lockkeeper: 'Tending the lock', lamplighter: 'On the lamp round', signalman: 'At the levers',
  porter: 'Seeing to luggage', constable: 'On the beat', angler: 'Fishing', farmhand: 'Working the fields', ploughman: 'At the plough',
  shepherd: 'Minding the flock', drover: 'Driving the flock', washerwoman: 'At the washing', blacksmith: 'At the anvil', baker: 'At the ovens',
  vicar: 'About the parish', newsboy: 'Crying the papers', cabman: 'Waiting for a fare', coachman: 'On the box', platelayer: 'Walking the permanent way',
  milkman: 'On the milk round', postman: 'On the post round', schoolchild: 'At play', child: 'At play', drinker: 'At the bar', publican: 'Behind the bar',
};
export function doingPhrase(role: PersonRole | string, state: string): string {
  if ((state === 'actor' || state === 'idle' || state === 'summoned') && ROLE_DOING[role as PersonRole]) return ROLE_DOING[role as PersonRole]!;
  return STATE_PHRASE[state] ?? humanize(state || 'idle');
}

/** one-line flavour under a vehicle's name plate */
export const VEHICLE_FLAVOUR: Partial<Record<VehicleKind, string>> = {
  hansom: 'Two wheels, one horse, the gondola of the streets', growler: 'Growls over the setts with luggage on the roof',
  omnibus: 'Knifeboard seats on top, a penny a stage', landau: 'A gentleman\'s carriage, hood folded back in fair weather',
  gig: 'A light two-wheeler, smartly driven', mailcart: 'By Royal Appointment: the mails wait for no one',
  dray: 'Barrels for the public houses', coalcart: 'Sacks of best Welsh steam coal', farmcart: 'A sturdy tumbril from the farms',
  haywain: 'Piled high with hay', milkfloat: 'Churns rattling, fresh from Millbridge Dairy', handcart: 'Pushed by hand, and grumbled over',
  bicycle: 'A safety bicycle, the latest craze', pennyfarthing: 'A perilous high-wheeler', motorwagen: 'Horseless! The talk of the county',
  fireengine: 'Brass bell, steam pump and galloping greys', carriage4: 'A coach and four, in full livery', circuswagon: 'Painted and gilded, with a menagerie aboard',
};
