import * as THREE from 'three';

/** One art-directed lighting keyframe, by hour of day. Colours are sRGB hex. */
interface KeyDef {
  h: number;
  zenith: number;
  horizon: number;
  fog: number;
  sun: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
  ambI: number;
  exposure: number;
}

// Night must stay readable: a deep moonlit blue with a fairly strong hemisphere, so lamps pop without the
// scene going black.
const NIGHT: Omit<KeyDef, 'h'> = {
  zenith: 0x0b1433, horizon: 0x223257, fog: 0x1e2b4a, sun: 0xa9bde8,
  hemiSky: 0x5a72b8, hemiGround: 0x1e2130, hemiI: 1.05, ambI: 0.34, exposure: 1.12,
};

const DEFS: KeyDef[] = [
  { h: 0, ...NIGHT },
  { h: 4.2, ...NIGHT },
  // blue hours (before sunrise, after sunset) a touch brighter than moonlit midnight: the light fades monotonically
  { h: 4.9, ...NIGHT, hemiSky: 0x6070b4, hemiI: 1.2, ambI: 0.36, exposure: 1.2 },
  { h: 5.35, zenith: 0x1b2754, horizon: 0x57557f, fog: 0x4a4a70, sun: 0xb0a0c8, hemiSky: 0x6a74b0, hemiGround: 0x2a2836, hemiI: 1.25, ambI: 0.36, exposure: 1.2 },
  { h: 6.05, zenith: 0x4a66a0, horizon: 0xf2a283, fog: 0xd8a08e, sun: 0xffc49a, hemiSky: 0xc8b8dc, hemiGround: 0x6a5a58, hemiI: 1.5, ambI: 0.34, exposure: 1.14 },
  { h: 7.1, zenith: 0x6a98c8, horizon: 0xf4d2ac, fog: 0xdccbb2, sun: 0xffdcac, hemiSky: 0xccd6e4, hemiGround: 0x6a604e, hemiI: 1.35, ambI: 0.3, exposure: 1.06 },
  { h: 9.5, zenith: 0x5690c8, horizon: 0xcfe2ec, fog: 0xc6d9e2, sun: 0xfff2dc, hemiSky: 0xcfe0f2, hemiGround: 0x5f5846, hemiI: 1.15, ambI: 0.26, exposure: 1.0 },
  { h: 13, zenith: 0x4c8ac8, horizon: 0xd2e5ee, fog: 0xc9dce6, sun: 0xfff8ee, hemiSky: 0xd2e3f4, hemiGround: 0x625a48, hemiI: 1.15, ambI: 0.26, exposure: 1.0 },
  { h: 16.6, zenith: 0x5a8ec4, horizon: 0xe0e2d6, fog: 0xd2d8d2, sun: 0xffeac8, hemiSky: 0xd0dcea, hemiGround: 0x605644, hemiI: 1.12, ambI: 0.26, exposure: 1.0 },
  // v2 golden-hour fix: brighter sky fill + ~8 % exposure so the camera-facing (shaded) facades still glow
  { h: 18.8, zenith: 0x6a88b6, horizon: 0xf6c688, fog: 0xe6c298, sun: 0xffd6a4, hemiSky: 0xcac8de, hemiGround: 0x7c6a52, hemiI: 1.55, ambI: 0.31, exposure: 1.19 },
  { h: 19.85, zenith: 0x48568e, horizon: 0xf08858, fog: 0xc88470, sun: 0xffb884, hemiSky: 0xbaa8d0, hemiGround: 0x64504a, hemiI: 1.55, ambI: 0.33, exposure: 1.23 },
  { h: 20.6, zenith: 0x1d2c62, horizon: 0x5a6aa2, fog: 0x4a5888, sun: 0x9a90c0, hemiSky: 0x5e72b4, hemiGround: 0x262838, hemiI: 1.3, ambI: 0.38, exposure: 1.24 },
  { h: 21.5, ...NIGHT, hemiI: 1.22, ambI: 0.37, exposure: 1.2 },
  { h: 22.6, ...NIGHT },
  { h: 24, ...NIGHT },
];

export interface SkyKey {
  zenith: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  sun: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiI: number;
  ambI: number;
  exposure: number;
}

const toKey = (d: KeyDef): SkyKey & { h: number } => ({
  h: d.h,
  zenith: new THREE.Color(d.zenith), horizon: new THREE.Color(d.horizon), fog: new THREE.Color(d.fog),
  sun: new THREE.Color(d.sun), hemiSky: new THREE.Color(d.hemiSky), hemiGround: new THREE.Color(d.hemiGround),
  hemiI: d.hemiI, ambI: d.ambI, exposure: d.exposure,
});
const KEYS = DEFS.map(toKey);

export function createSkyKey(): SkyKey {
  return toKey({ h: 0, ...NIGHT });
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Interpolate the keyframes at hour h (0..24) into `out` (no allocation). */
export function sampleSky(h: number, out: SkyKey): SkyKey {
  const hh = ((h % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= hh) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = smooth(THREE.MathUtils.clamp((hh - a.h) / Math.max(1e-6, b.h - a.h), 0, 1));
  out.zenith.copy(a.zenith).lerp(b.zenith, t);
  out.horizon.copy(a.horizon).lerp(b.horizon, t);
  out.fog.copy(a.fog).lerp(b.fog, t);
  out.sun.copy(a.sun).lerp(b.sun, t);
  out.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, t);
  out.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, t);
  out.hemiI = a.hemiI + (b.hemiI - a.hemiI) * t;
  out.ambI = a.ambI + (b.ambI - a.ambI) * t;
  out.exposure = a.exposure + (b.exposure - a.exposure) * t;
  return out;
}
