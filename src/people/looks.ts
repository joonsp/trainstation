import type { PersonRole } from '../core/apis';
import type { Rng } from '../core/rng';
import { BRASS, CLOTHING, HAIR, SKIN } from '../core/palette';
import type { AccKind, BodyKind, HatKind } from './geometry';

export type Gender = 'm' | 'f';

export interface Look {
  gender: Gender;
  child: boolean;
  scale: number;
  body: BodyKind;
  /** A primary, B secondary, C trim, D skin */
  colors: [number, number, number, number];
  hat: HatKind | null;
  hatColors: [number, number, number];
  /** permanent accessories (suitcase, trolley, flag, instrument, bouquet) */
  accs: AccKind[];
  accColors: Partial<Record<AccKind, [number, number, number]>>;
  umbrellaColor: number;
}

const SHIRT = 0xe8e0cc;
const WHITE = 0xf2eee6;
const SILVER = 0xc8c8c4;
const NAVY = 0x1b2233;
const BLACK = 0x1c1c20;
const STATION_GREEN = 0x23402e;
const LEATHER = [0x6a4028, 0x4e3222, 0x7a5a3a, 0x3a2a20, 0x5a2a22];
const TRUNK = [0x5a3a24, 0x2f3a4a, 0x6a2a2a, 0x4a4a3a];
const UMBRELLA = [0x1c1c20, 0x1c1c20, 0x1c1c20, 0x23402e, 0x4a2028, 0x2b2b3a, 0x3a3228];
const TROUSERS = [0x2a2a2e, 0x3a3a3e, 0x4a4238, 0x2e3440, 0x5a5448, 0x3a3228];
const STRAW = 0xd8c08a;
const PASTEL = [0x8a9aa8, 0xa89080, 0x9aa088, 0xb09aa4, 0xa8a088, 0x8aa0a0];
const DRESS_EXTRA = [0x6b3a4a, 0x3a4a6b, 0x5a6b4a, 0x7a5a3a, 0x4a3a5a, 0x8a6a5a];

const skin = (r: Rng) => r.weighted([{ w: 5, v: SKIN[0] }, { w: 4, v: SKIN[1] }, { w: 2, v: SKIN[2] }, { w: 1, v: SKIN[3] }, { w: 0.6, v: SKIN[4] }, { w: 0.4, v: SKIN[5] }]);
const hair = (r: Rng, old = false) => (old && r.chance(0.5) ? HAIR[4] : r.pick(HAIR));

function base(gender: Gender, body: BodyKind, r: Rng): Look {
  return {
    gender, child: false, scale: r.range(0.95, 1.05), body,
    colors: [r.pick(CLOTHING), r.pick(TROUSERS), SHIRT, skin(r)],
    hat: null, hatColors: [BLACK, BLACK, hair(r)], accs: [], accColors: {},
    umbrellaColor: r.pick(UMBRELLA),
  };
}

export function passengerLook(r: Rng): Look {
  const child = r.chance(0.1);
  const gender: Gender = r.chance(0.5) ? 'm' : 'f';
  let L: Look;
  if (gender === 'm') {
    const working = r.chance(child ? 0.7 : 0.22);
    L = base('m', working ? 'jacket' : 'coat', r);
    if (working) {
      L.colors[0] = r.pick([0x4a3b32, 0x5b4a3a, 0x3a3f4f, 0x4f5a3a, 0x5a5a5e]);
      L.colors[2] = r.chance(0.5) ? SHIRT : L.colors[0];
      L.hat = r.chance(0.85) ? 'flatCap' : 'hairShort';
      L.hatColors = [r.pick([0x3a3228, 0x4a4238, 0x2a2a2e, 0x5a5040]), BLACK, hair(r)];
    } else {
      L.hat = r.weighted<HatKind>([{ w: 3, v: 'topHat' }, { w: 4.5, v: 'bowler' }, { w: 1, v: 'boater' }, { w: 1, v: 'hairShort' }]);
      if (L.hat === 'boater') L.hatColors = [STRAW, r.pick([0x2a2a4a, 0x6a2020, BLACK]), hair(r)];
      else if (L.hat === 'hairShort') L.hatColors = [hair(r, true), BLACK, BLACK];
      else L.hatColors = [r.chance(0.8) ? BLACK : r.pick([0x3a3228, 0x4a4a4e]), r.chance(0.7) ? 0x101010 : 0x3a2a20, hair(r)];
    }
  } else {
    L = base('f', 'dress', r);
    const c = r.pick([...CLOTHING, ...DRESS_EXTRA]);
    L.colors[0] = c;
    L.colors[1] = r.chance(0.55) ? c : r.pick([...CLOTHING, ...DRESS_EXTRA]);
    L.colors[2] = r.chance(0.7) ? WHITE : 0xd8c8a8;
    L.hat = r.weighted<HatKind>([{ w: 5, v: 'bonnet' }, { w: 1.2, v: 'boater' }, { w: 1.5, v: 'hairBun' }]);
    if (L.hat === 'bonnet') L.hatColors = [r.pick([0x3a2a3a, 0x2a2a2e, 0x6a5a48, 0xd8c8a8, 0x4a3a5a, c]), r.pick([0x7a2230, 0x2f5d3a, 0xc9a24a, WHITE, 0x3a4a6b]), hair(r)];
    else if (L.hat === 'boater') L.hatColors = [STRAW, r.pick([0x7a2230, 0x2f5d3a, 0x3a4a6b]), hair(r)];
    else L.hatColors = [hair(r), BLACK, BLACK];
  }
  if (child) {
    L.child = true;
    L.scale = r.range(0.58, 0.7);
  } else if (r.chance(0.38)) {
    L.accs.push('suitcase');
    L.accColors.suitcase = [r.pick(LEATHER), 0, 0];
  }
  return L;
}

/** Look for a given role (passengers get the random civilian look). */
export function roleLook(role: PersonRole, r: Rng): Look {
  switch (role) {
    case 'passenger': return passengerLook(r);
    case 'stationmaster': {
      const L = base('m', 'uniform', r);
      L.scale = 1.04;
      L.colors = [0x151a26, 0x151a26, BRASS, skin(r)];
      L.hat = 'peakedCap'; L.hatColors = [0x151a26, BRASS, hair(r, true)];
      return L;
    }
    case 'guard': {
      const L = base('m', 'uniform', r);
      L.colors = [NAVY, NAVY, BRASS, skin(r)];
      L.hat = 'peakedCap'; L.hatColors = [NAVY, 0x7a2230, BLACK];
      L.accs.push('flag'); L.accColors.flag = [0x2f7a3a, 0, 0];
      return L;
    }
    case 'porter': {
      const L = base('m', 'jacket', r);
      L.colors = [STATION_GREEN, 0x2a2a2e, SHIRT, skin(r)];
      L.hat = 'peakedCap'; L.hatColors = [STATION_GREEN, BRASS, BLACK];
      L.accs.push('trolley'); L.accColors.trolley = [r.pick(TRUNK), r.pick(LEATHER), 0x8a6a4a];
      return L;
    }
    case 'mechanic': {
      const L = base('m', 'jacket', r);
      const o = r.pick([0x3d4a5c, 0x34404e, 0x4a4032, 0x3a4a44]);
      L.colors = [o, o, o, skin(r)];
      L.hat = r.chance(0.7) ? 'flatCap' : 'hairShort';
      L.hatColors = L.hat === 'flatCap' ? [0x2a2a2a, BLACK, BLACK] : [hair(r), BLACK, BLACK];
      return L;
    }
    case 'crew': {
      const L = base('m', 'jacket', r);
      L.colors = [0x2e3a50, 0x2e3a50, 0x3a4660, skin(r)];
      L.hat = 'peakedCap'; L.hatColors = [0x2a2e36, 0x2a2e36, BLACK];
      return L;
    }
    case 'constable': {
      const L = base('m', 'uniform', r);
      L.scale = 1.07;
      L.colors = [NAVY, NAVY, SILVER, skin(r)];
      L.hat = 'helmet'; L.hatColors = [NAVY, SILVER, BLACK];
      return L;
    }
    case 'pickpocket': {
      const L = base('m', 'jacket', r);
      L.scale = 0.93;
      L.colors = [0x4a3a2a, 0x3a3228, 0x5a4a3a, skin(r)];
      L.hat = 'flatCap'; L.hatColors = [0x2a2420, BLACK, BLACK];
      return L;
    }
    case 'bride': {
      const L = base('f', 'dress', r);
      L.colors = [WHITE, WHITE, 0xfff8ec, skin(r)];
      L.hat = 'veil'; L.hatColors = [0xf6f2ea, 0xd9c070, hair(r)];
      L.accs.push('bouquet'); L.accColors.bouquet = [0xe8a0a8, 0x3a6a3a, 0xf4e8f0];
      return L;
    }
    case 'groom': {
      const L = base('m', 'coat', r);
      L.colors = [BLACK, 0x2a2a30, WHITE, skin(r)];
      L.hat = 'topHat'; L.hatColors = [BLACK, 0x2a2a30, hair(r)];
      return L;
    }
    case 'guest': {
      const L = r.chance(0.5) ? base('m', 'coat', r) : base('f', 'dress', r);
      const c = r.pick(PASTEL);
      L.colors[0] = c;
      if (L.gender === 'f') {
        L.colors[1] = r.chance(0.5) ? c : r.pick(PASTEL);
        L.colors[2] = WHITE;
        L.hat = r.chance(0.7) ? 'bonnet' : 'boater';
        L.hatColors = [r.pick([WHITE, 0xd8c8a8, c]), r.pick([0xe8a0a8, 0x7a2230, 0xc9a24a]), hair(r)];
      } else {
        L.colors[0] = r.pick([BLACK, 0x2b2b33, 0x3a3f4f]);
        L.colors[2] = WHITE;
        L.hat = r.chance(0.6) ? 'topHat' : 'bowler';
        L.hatColors = [BLACK, r.pick([0xe8a0a8, 0x101010]), hair(r)];
      }
      return L;
    }
    case 'bandsman': {
      const L = base('m', 'uniform', r);
      L.colors = [0x8a2a2a, 0x1c1c24, BRASS, skin(r)];
      L.hat = 'shako'; L.hatColors = [0x1c1c24, BRASS, BLACK];
      L.accs.push('instrument'); L.accColors.instrument = [BRASS, 0, 0];
      return L;
    }
    case 'clerk': {
      const L = base('m', 'coat', r);
      L.colors = [0x2a2a30, 0x2a2a30, 0xe8e0cc, skin(r)];
      L.hat = 'hairShort'; L.hatColors = [hair(r), 0, 0];
      return L;
    }
    case 'newsboy': {
      const L = base('m', 'jacket', r);
      L.scale = 0.72; L.child = true;
      L.colors = [0x4a3b32, 0x3a3228, 0xe8e0cc, skin(r)];
      L.hat = 'flatCap'; L.hatColors = [0x3a3228, BLACK, BLACK];
      return L;
    }
    case 'farmer': {
      const L = base('m', 'jacket', r);
      L.scale = 1.05;
      L.colors = [0x8a7a5a, 0x4a3a2a, 0xd8ccb0, skin(r)];
      L.hat = 'flatCap'; L.hatColors = [0x4a3a2a, BLACK, BLACK];
      return L;
    }
    case 'ringmaster': {
      const L = base('m', 'coat', r);
      L.scale = 1.06;
      L.colors = [0x9a2a2a, 0xe8e0cc, BRASS, skin(r)];
      L.hat = 'topHat'; L.hatColors = [BLACK, 0x9a2a2a, hair(r)];
      return L;
    }
    case 'vip': {
      const L = base('m', 'coat', r);
      L.scale = 1.06;
      L.colors = [0x2a1a3a, 0x1c1c24, WHITE, skin(r)];
      L.hat = 'topHat'; L.hatColors = [BLACK, 0x5a2a6a, hair(r, true)];
      return L;
    }
    // ───── v2 roles ─────
    case 'signalman': {
      const L = base('m', 'jacket', r);
      L.colors = [0x2a2e2a, 0x2a2a2e, SHIRT, skin(r)];
      L.hat = 'peakedCap'; L.hatColors = [STATION_GREEN, BRASS, BLACK];
      return L;
    }
    case 'platelayer': {
      const L = base('m', 'jacket', r);
      L.colors = [r.pick([0x5a4a32, 0x4a3f30, 0x5b5040]), 0x3a3228, r.pick([SHIRT, 0xc8b89a]), skin(r)];
      L.hat = 'flatCap'; L.hatColors = [0x3a3228, BLACK, BLACK];
      return L;
    }
    case 'lamplighter': {
      const L = base('m', 'coat', r);
      L.colors = [0x3a3a2a, 0x2a2a2a, 0x8a7a5a, skin(r)];
      L.hat = 'peakedCap'; L.hatColors = [0x2a2a22, 0x3a3a2a, BLACK];
      L.accs.push('ladder');
      return L;
    }
    case 'gatekeeper': {
      const L = base('m', 'uniform', r);
      L.colors = [STATION_GREEN, 0x2a2a2e, BRASS, skin(r)];
      L.hat = 'peakedCap'; L.hatColors = [STATION_GREEN, BRASS, hair(r, true)];
      return L;
    }
    case 'lockkeeper': {
      const L = base('m', 'jacket', r);
      L.colors = [0x2e3a50, 0x3a3228, 0xd8ccb0, skin(r)];
      L.hat = 'flatCap'; L.hatColors = [0x2e3440, BLACK, BLACK];
      return L;
    }
    case 'cabman': {
      const L = base('m', 'coat', r);
      L.colors = [r.pick([0x4a3a28, 0x3a3228, 0x2e3440]), 0x2a2a2e, 0x6a5a40, skin(r)];
      L.hat = r.chance(0.6) ? 'topHat' : 'bowler'; L.hatColors = [0x2a2420, 0x1a1a1a, hair(r, true)];
      return L;
    }
    case 'coachman': {
      const L = base('m', 'coat', r);
      L.colors = [r.pick([0x5a1e28, 0x23402e, 0x2a2a3a]), 0xd8ccb0, BRASS, skin(r)];
      L.hat = 'topHat'; L.hatColors = [BLACK, BRASS, hair(r)];
      return L;
    }
    case 'conductor': {
      const L = base('m', 'jacket', r);
      L.colors = [0x3a3a44, 0x2a2a2e, SHIRT, skin(r)];
      L.hat = 'bowler'; L.hatColors = [BLACK, BLACK, hair(r)];
      L.accs.push('satchel'); L.accColors.satchel = [0x4a3222, 0, 0];
      return L;
    }
    case 'drayman': {
      const L = base('m', 'jacket', r);
      L.scale = 1.08;
      L.colors = [0x5a4a3a, 0x3a3228, 0xd8ccb0, skin(r)];
      L.hat = 'flatCap'; L.hatColors = [0x3a3228, BLACK, BLACK];
      L.accs.push('apron'); L.accColors.apron = [0x6a4a2a, 0, 0];
      return L;
    }
    case 'carter': case 'ploughman': case 'farmhand': {
      const L = base('m', 'coat', r); // the smock
      L.colors = [r.pick([0xd8ccb0, 0xc8bc9a, 0xb8b08a, 0x8a8a6a]), r.pick([0x4a3a2a, 0x5a4a32, 0x3a3228]), 0xe8e0cc, skin(r)];
      if (r.chance(0.6)) { L.hat = 'straw'; L.hatColors = [STRAW, 0x5a3a20, hair(r)]; } else { L.hat = 'flatCap'; L.hatColors = [0x4a3a2a, BLACK, BLACK]; }
      return L;
    }
    case 'milkman': case 'dairymaid': {
      const L = role === 'dairymaid' || r.chance(0.3) ? base('f', 'dress', r) : base('m', 'jacket', r);
      if (L.gender === 'f') {
        L.colors = [r.pick([0x6a7a9a, 0x8a6a5a, 0x5a6a4a]), r.pick([0x4a5a7a, 0x6a5a48]), WHITE, skin(r)];
        L.hat = 'bonnet'; L.hatColors = [WHITE, WHITE, hair(r)];
      } else {
        L.colors = [0x3a4a6a, 0x2a2a2e, 0xe8e0cc, skin(r)];
        L.hat = 'straw'; L.hatColors = [STRAW, 0x2a3a6a, hair(r)];
      }
      L.accs.push('apron'); L.accColors.apron = [WHITE, 0, 0];
      return L;
    }
    case 'postman': {
      const L = base('m', 'uniform', r);
      L.colors = [0x1e2a44, 0x1e2a44, 0xa02a2a, skin(r)];
      L.hat = 'shako'; L.hatColors = [0x1e2a44, 0xa02a2a, BLACK];
      L.accs.push('satchel'); L.accColors.satchel = [0x3a2a1c, 0, 0];
      return L;
    }
    case 'motorist': {
      const L = base('m', 'coat', r);
      L.colors = [0xb8a888, 0x3a3228, 0x5a4a3a, skin(r)];
      L.hat = 'flatCap'; L.hatColors = [0x8a7a5a, BLACK, BLACK];
      return L;
    }
    case 'townsfolk': case 'drinker': case 'skater': {
      const L = passengerLook(r);
      L.accs = [];
      if (L.gender === 'm' && r.chance(0.45)) { L.body = 'jacket'; L.colors[0] = r.pick([0x4a3b32, 0x5b4a3a, 0x3a3f4f, 0x4f5a3a]); L.hat = r.chance(0.8) ? 'flatCap' : 'bowler'; L.hatColors = [r.pick([0x3a3228, 0x4a4238, 0x2a2a2e]), BLACK, hair(r)]; }
      if (L.child) { L.child = false; L.scale = r.range(0.95, 1.05); }
      return L;
    }
    case 'child': case 'schoolchild': {
      const L = passengerLook(r);
      L.accs = [];
      L.child = true; L.scale = r.range(0.56, 0.7);
      if (L.gender === 'm') { L.body = 'jacket'; L.colors[0] = r.pick([0x4a3b32, 0x3a3f4f, 0x5a4a3a, 0x6a2a2a]); L.hat = r.chance(0.6) ? 'flatCap' : 'hairShort'; if (L.hat === 'hairShort') L.hatColors = [hair(r), 0, 0]; }
      else { L.colors[2] = WHITE; L.hat = r.chance(0.5) ? 'bonnet' : 'hairBun'; if (L.hat === 'hairBun') L.hatColors = [hair(r), 0, 0]; }
      return L;
    }
    case 'vendor': case 'washerwoman': {
      const f = role === 'washerwoman' || r.chance(0.6);
      const L = f ? base('f', 'dress', r) : base('m', 'jacket', r);
      if (f) {
        L.colors = [r.pick([0x5a4a5a, 0x6a5a48, 0x4a5a6a, 0x7a4a3a]), r.pick([0x3a3a44, 0x5a4a3a, 0x4a3a3a]), WHITE, skin(r)];
        L.hat = 'bonnet'; L.hatColors = [r.pick([WHITE, 0xd8c8a8, 0x6a5a48]), r.pick([0x7a2230, 0x3a4a6b, WHITE]), hair(r)];
      } else { L.hat = 'flatCap'; L.hatColors = [0x3a3228, BLACK, BLACK]; }
      L.accs.push('apron'); L.accColors.apron = [r.pick([WHITE, 0xd8d0c0, 0xc8c0b0]), 0, 0];
      return L;
    }
    case 'publican': case 'baker': case 'miller': {
      const L = base('m', 'jacket', r);
      L.scale = r.range(1.0, 1.1);
      if (role === 'miller') { L.colors = [0xd8d0c0, 0xb8b0a0, 0xe8e0cc, skin(r)]; L.hat = 'flatCap'; L.hatColors = [0xd0c8b8, BLACK, BLACK]; }
      else if (role === 'baker') { L.colors = [0xe8e4dc, 0x4a4238, WHITE, skin(r)]; L.hat = 'hairShort'; L.hatColors = [hair(r), 0, 0]; }
      else { L.colors = [r.pick([0x5a1e28, 0x3a3228, 0x2a3a2a]), 0x2a2a2e, WHITE, skin(r)]; L.hat = 'hairShort'; L.hatColors = [hair(r, true), 0, 0]; }
      if (role !== 'miller') { L.accs.push('apron'); L.accColors.apron = [WHITE, 0, 0]; }
      return L;
    }
    case 'blacksmith': {
      const L = base('m', 'jacket', r);
      L.scale = 1.1;
      L.colors = [0x3a3228, 0x2a2a2e, 0xc8b8a0, skin(r)];
      L.hat = r.chance(0.5) ? 'hairShort' : 'flatCap'; L.hatColors = L.hat === 'hairShort' ? [hair(r), 0, 0] : [0x2a2420, BLACK, BLACK];
      L.accs.push('apron'); L.accColors.apron = [0x4a3020, 0, 0];
      return L;
    }
    case 'vicar': {
      const L = base('m', 'coat', r);
      L.colors = [BLACK, BLACK, WHITE, skin(r)];
      L.hat = 'straw'; L.hatColors = [0x1c1c20, 0x1c1c20, hair(r, true)];
      return L;
    }
    case 'angler': {
      const L = base('m', r.chance(0.5) ? 'jacket' : 'coat', r);
      L.colors = [r.pick([0x5a5a3a, 0x4a4a32, 0x6a5a40, 0x3a4a3a]), r.pick([0x4a4238, 0x3a3228]), 0xd8ccb0, skin(r)];
      if (r.chance(0.5)) { L.hat = 'straw'; L.hatColors = [STRAW, 0x3a4a2a, hair(r)]; } else { L.hat = 'flatCap'; L.hatColors = [0x5a5040, BLACK, BLACK]; }
      return L;
    }
    case 'rower': case 'punter': {
      const L = base('m', 'jacket', r);
      L.colors = [r.pick([0xe8e4dc, 0x2a3a6a, 0x6a2020, 0xe8e4dc]), 0xe8e4dc, WHITE, skin(r)];
      L.hat = 'boater'; L.hatColors = [STRAW, r.pick([0x2a2a6a, 0x6a2020, 0x2f5d3a]), hair(r)];
      return L;
    }
    case 'bargee': {
      const L = base('m', 'jacket', r);
      L.colors = [0x3a3a4a, 0x2a2a2e, 0xa04a2a, skin(r)];
      L.hat = 'bowler'; L.hatColors = [0x2a2420, BLACK, hair(r)];
      L.accs.push('pipe');
      return L;
    }
    case 'shepherd': case 'drover': {
      const L = base('m', role === 'shepherd' ? 'coat' : 'jacket', r);
      L.colors = [role === 'shepherd' ? 0xc8bc9a : 0x5a4a32, 0x4a3a2a, 0xd8ccb0, skin(r)];
      L.hat = 'straw'; L.hatColors = [role === 'shepherd' ? 0x5a4a32 : STRAW, 0x3a2a1c, hair(r, true)];
      L.accs.push(role === 'shepherd' ? 'crook' : 'stick');
      return L;
    }
    case 'huntsman': {
      const L = base('m', 'coat', r);
      L.colors = [0xa02020, 0xe8e0cc, WHITE, skin(r)];
      L.hat = 'peakedCap'; L.hatColors = [BLACK, BLACK, hair(r)];
      return L;
    }
    case 'firefighter': {
      const L = base('m', 'uniform', r);
      L.colors = [0x1e2440, 0x1e2440, BRASS, skin(r)];
      L.hat = 'helmet'; L.hatColors = [BRASS, 0xe0c060, BLACK];
      return L;
    }
    case 'aeronaut': {
      const L = base('m', 'coat', r);
      L.colors = [0x6a4a2a, 0x3a3228, 0xd8ccb0, skin(r)];
      L.hat = 'flatCap'; L.hatColors = [0x4a3a2a, BLACK, BLACK];
      return L;
    }
  }
  return passengerLook(r);
}

// ───────────── names ─────────────
const M_FIRST = ['Ambrose', 'Albert', 'Alfred', 'Archibald', 'Arthur', 'Bartholomew', 'Cecil', 'Cornelius', 'Cuthbert', 'Edmund', 'Edwin', 'Ernest', 'Ezekiel', 'Frederick', 'George', 'Gilbert', 'Horace', 'Hubert', 'Ignatius', 'Jasper', 'Josiah', 'Lionel', 'Montague', 'Mortimer', 'Nathaniel', 'Octavius', 'Percival', 'Reginald', 'Rupert', 'Septimus', 'Silas', 'Thaddeus', 'Walter', 'Wilfred', 'William', 'Obadiah', 'Barnaby', 'Humphrey'];
const F_FIRST = ['Clara', 'Ada', 'Adelaide', 'Agatha', 'Beatrice', 'Charlotte', 'Constance', 'Dorothea', 'Edith', 'Eleanor', 'Eliza', 'Emmeline', 'Florence', 'Georgiana', 'Harriet', 'Henrietta', 'Imogen', 'Ivy', 'Louisa', 'Lydia', 'Mabel', 'Margaret', 'Matilda', 'Maud', 'Millicent', 'Minnie', 'Ottilie', 'Philippa', 'Prudence', 'Rosalind', 'Theodora', 'Victoria', 'Winifred', 'Hester', 'Cordelia'];
const SURNAMES = ['Pettigrew', 'Whitlock', 'Ashcombe', 'Babbington', 'Blenkinsop', 'Bramwell', 'Carruthers', 'Cholmondeley', 'Crumb', 'Dunstable', 'Entwistle', 'Fairweather', 'Fotheringham', 'Grimsby', 'Hargreaves', 'Hawthorne', 'Honeysett', 'Jellicoe', 'Kettleby', 'Loxley', 'Marchbanks', 'Nettlefold', 'Ormsby', 'Pembury', 'Quigley', 'Ravensworth', 'Snodgrass', 'Tattersall', 'Thistlewood', 'Underhill', 'Varley', 'Wainwright', 'Wetherby', 'Winterbottom', 'Yarrow', 'Featherstonehaugh', 'Mudge', 'Pocklington', 'Scrope', 'Tolliver'];

export function personName(role: PersonRole, look: Look, r: Rng): string {
  const first = look.gender === 'm' ? r.pick(M_FIRST) : r.pick(F_FIRST);
  const sur = r.pick(SURNAMES);
  switch (role) {
    case 'stationmaster': return `Stationmaster ${first} ${sur}`;
    case 'porter': return `Porter ${sur}`;
    case 'guard': return `Guard ${first} ${sur}`;
    case 'mechanic': return `Fitter ${first} ${sur}`;
    case 'crew': return `Driver ${sur}`;
    case 'constable': return `Constable ${sur}`;
    case 'pickpocket': return r.pick(['"Light-Fingered" ', '"Artful" ', '"Slippery" ', '"Quick" ']) + first;
    case 'bride': return `Miss ${first} ${sur} (the bride)`;
    case 'groom': return `Mr. ${first} ${sur} (the groom)`;
    case 'bandsman': return `Bandsman ${sur}`;
    case 'clerk': return `Booking Clerk ${sur}`;
    case 'newsboy': return `Newsboy ${r.pick(['Alfie', 'Bert', 'Sid', 'Ned', 'Wilf', 'Charlie'])}`;
    case 'farmer': return `Farmer ${sur}`;
    case 'ringmaster': return `Ringmaster ${first} ${sur}`;
    case 'vip': return r.pick(['Lord', 'Sir', 'The Hon.', 'Viscount']) + ` ${first} ${sur}`;
    case 'signalman': return `Signalman ${sur}`;
    case 'platelayer': return `Platelayer ${sur}`;
    case 'lamplighter': return `Lamplighter ${first} ${sur}`;
    case 'gatekeeper': return `Crossing-keeper ${sur}`;
    case 'lockkeeper': return `Lock-keeper ${sur}`;
    case 'cabman': return `Cabby ${sur}`;
    case 'coachman': return `Coachman ${sur}`;
    case 'conductor': return `Conductor ${sur}`;
    case 'drayman': return `Drayman ${sur}`;
    case 'carter': return `Carter ${sur}`;
    case 'milkman': return look.gender === 'f' ? `Milkwoman ${first} ${sur}` : `Milkman ${sur}`;
    case 'postman': return `Postman ${sur}`;
    case 'motorist': return `Herr ${r.pick(['Karl', 'Gottlieb', 'Wilhelm', 'Friedrich'])} ${r.pick(['Benz', 'Daimler', 'Maybach', 'Hertz'])}`;
    case 'publican': return `Mine host ${sur}`;
    case 'vicar': return `The Rev. ${first} ${sur}`;
    case 'washerwoman': return `Mrs. ${sur}, washerwoman`;
    case 'baker': return `Baker ${sur}`;
    case 'blacksmith': return `Smith ${sur}`;
    case 'miller': return `Miller ${sur}`;
    case 'angler': return `Angler ${first} ${sur}`;
    case 'bargee': return `Bargee ${sur}`;
    case 'shepherd': return `Shepherd ${sur}`;
    case 'drover': return `Drover ${sur}`;
    case 'ploughman': return `Ploughman ${sur}`;
    case 'farmhand': return `Farmhand ${first}`;
    case 'dairymaid': return `${first} the dairymaid`;
    case 'huntsman': return `Huntsman ${sur}`;
    case 'firefighter': return `Fireman ${sur}`;
    case 'aeronaut': return `Aeronaut ${first} ${sur}`;
    case 'vendor': return look.gender === 'f' ? `${first} ${sur}, hawker` : `${sur} the costermonger`;
    case 'rower': return `Oarsman ${first} ${sur}`;
    case 'punter': return `${first} ${sur}, punting`;
    default: break;
  }
  if (look.child) return look.gender === 'm' ? `Master ${first} ${sur}` : `Little Miss ${first} ${sur}`;
  if (look.gender === 'm') {
    const t = r.weighted([{ w: 12, v: 'Mr.' }, { w: 1, v: 'Dr.' }, { w: 0.8, v: 'Rev.' }, { w: 0.6, v: 'Col.' }, { w: 0.4, v: 'Prof.' }, { w: 0.3, v: 'Sir' }]);
    return `${t} ${first} ${sur}`;
  }
  const t = r.weighted([{ w: 6, v: 'Mrs.' }, { w: 6, v: 'Miss' }, { w: 0.4, v: 'Lady' }, { w: 0.3, v: 'Dr.' }]);
  return `${t} ${first} ${sur}`;
}
