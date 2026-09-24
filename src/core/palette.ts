/** Victorian railway palette. Hex numbers for three.js Color. */
export const BRICK = 0x9c4a36;
export const BRICK_DARK = 0x6e3326;
export const CREAM = 0xe8dcc0;
export const STONE = 0xcfc3a8;
export const SLATE = 0x4d5866;
export const IRON = 0x1f2e27;
export const BOTTLE_GREEN = 0x2f5d3a;
export const OXBLOOD = 0x7a2230;
export const BRASS = 0xc9a24a;
export const WOOD = 0x7a5a3c;
export const SLEEPER = 0x4a3a2c;
export const RAIL = 0x8a8d90;
export const BALLAST = 0x7d746a;
export const PLATFORM = 0xa39a8a;
export const GRAVEL = 0x9b8f7e;
export const GRASS = 0x6f8f4e;
export const GRASS_DARK = 0x56733c;
export const GLASS = 0x9fb8c8;
export const LAMP_GLOW = 0xffcf7a;
export const WINDOW_LIT = 0xffc46b;
export const SNOW = 0xf2f4f7;
export const SMOKE = 0xd8d4cc;
export const STEAM = 0xf4f2ee;
export const SOOT = 0x2a2a2c;
export const WATER = 0x3d5a6c;
export const SKY_DAY = 0x9ec3d6;
export const SKY_DUSK = 0xe0936a;
export const SKY_NIGHT = 0x121a2e;

/** Locomotive / coach livery variants: body, lining, underframe. */
export const LIVERIES = {
  /** Coast Line = crimson lake (matches trains/cars.ts) */
  coast: { body: OXBLOOD, lining: BRASS, frame: IRON },
  /** Highland Line = bottle green */
  highland: { body: BOTTLE_GREEN, lining: BRASS, frame: IRON },
  freight: { body: 0x5a5048, lining: 0x8a7a68, frame: IRON },
  royal: { body: 0x3a2a5a, lining: 0xd9b95a, frame: 0x1a1a22 },
  circus: { body: 0xb5473a, lining: 0xe0b84a, frame: 0x2a2a2a },
  ghost: { body: 0x9ab0b8, lining: 0xd8e8ee, frame: 0x607078 },
  teak: { body: 0x8a5a30, lining: 0xd9b070, frame: IRON },
} as const;

/** Clothing colours for passengers (muted Victorian). */
export const CLOTHING = [
  0x2b2b33, 0x3a3f4f, 0x4a3b32, 0x5b4a3a, 0x6b2e2e, 0x2f4a3a, 0x5a5a5e,
  0x7a6a50, 0x3e2f4a, 0x8a7a64, 0x1f2a3a, 0x6a4a5a, 0x4f5a3a, 0x9a8a7a,
];
export const SKIN = [0xf1d2b8, 0xe0b594, 0xc99a74, 0xa87452, 0x7a5236, 0x5a3a26];
export const HAIR = [0x2a1e16, 0x4a3222, 0x7a5a3a, 0xb09060, 0x9a9a9a, 0x1a1a1a];
