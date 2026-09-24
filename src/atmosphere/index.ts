// Atmosphere: sky, sun/moon, day-night lighting, weather state machine and weather effects.
import * as THREE from 'three';
import type { Ctx, System, Weather } from '../core/types';
import type { AtmosphereAPI } from '../core/apis';
import { createViewInfo, updateViewInfo } from './view';
import { createSkyKey, sampleSky } from './skyKeys';
import { WeatherMachine, headlineFor } from './weather';
import { Sky } from './sky';
import { Clouds } from './clouds';
import { Precipitation } from './precip';
import { Mist, CloudShadows } from './mist';
import { LightningBolt } from './lightning';
import { RiverMist, EdgeHaze } from './valley';

const DEG = Math.PI / 180;
const MOON_COLOR = new THREE.Color(0xb4c6ee);

const smoothstep = (a: number, b: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = THREE.MathUtils.lerp;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const wrapPi = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
/** soft azimuth clamp: identity up to 60°, then eases asymptotically toward 75° (C1-continuous) */
const softAz = (d: number) => {
  const x = Math.abs(d), K = 60 * DEG, M = 15 * DEG;
  return Math.sign(d) * (x <= K ? x : K + M * (1 - Math.exp(-(x - K) / M)));
};

export function createAtmosphere(ctx: Ctx): System {
  const { scene, renderer, bloom, mats, bus, clock } = ctx;
  const SHADOW_MAP = ctx.quality?.knobs.shadowMapSize ?? 2048;
  const rng = ctx.rng.fork(0xa7305);
  const fxRng = rng.fork(17);

  // ── lights ──
  const hemi = new THREE.HemisphereLight(0xcfe0f2, 0x5f5846, 1.15);
  const amb = new THREE.AmbientLight(0xffffff, 0.26);
  const key = new THREE.DirectionalLight(0xfff4e0, 2.6);
  key.name = 'sunMoon';
  key.castShadow = true;
  key.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  key.shadow.bias = -0.00035;
  key.shadow.normalBias = 0.06;
  key.shadow.intensity = 0.88;
  if (ctx.quality.knobs.shadowType === 'pcfsoft') key.shadow.radius = 2.5; // softer PCF edges on the high tier
  const sc = key.shadow.camera;
  sc.near = 20; sc.far = 1300;
  // v2 golden-hour fill: a warm, non-shadowed light from the camera side so the facades the default view sees
  // (which face away from an evening sun) still glow. Always in the scene (constant light count → no recompiles).
  const fill = new THREE.DirectionalLight(0xffc896, 0);
  fill.name = 'goldenFill';
  fill.castShadow = false;
  scene.add(hemi, amb, key, key.target, fill, fill.target);

  // ── scene background / fog ──
  scene.background = null;
  const fog = new THREE.Fog(0xc9dce6, 800, 2000);
  scene.fog = fog;

  // ── effects ──
  const sky = new Sky(rng.fork(1));
  const clouds = new Clouds(rng.fork(2));
  const precip = new Precipitation(rng.fork(3), ctx.layout);
  const mist = new Mist();
  const bolt = new LightningBolt();
  const cloudShadows = new CloudShadows();
  const riverMist = new RiverMist(ctx.layout);
  const natureMist = !!(ctx.quality?.knobs as { water?: { mist?: boolean } } | undefined)?.water?.mist;
  const edgeHaze = new EdgeHaze(ctx.layout.terrain?.half ? ctx.layout.terrain.half - 8 : 412, (ctx.layout.terrain?.half ?? 420) + 50);
  scene.add(sky.group, clouds.group, precip.group, mist.group, bolt.mesh, cloudShadows.mesh, riverMist.mesh, edgeHaze.mesh);


  // ── state ──
  const view = createViewInfo();
  const keyCol = createSkyKey();
  const skyK = createSkyKey();
  let wetness = 0;
  let snowCover = 0;
  let temperature = 12;
  let flashT = 99;
  let flashI = 0;
  let strikeTimer = 4;
  let fxTime = 0;
  const thunders: { t: number; pos: THREE.Vector3; volume: number }[] = [];
  let shadowExtent = 0;
  let holdFlash = false;
  // v2 state
  let iceAmount = ctx.params.raw.get('ice') ? clamp01(Number(ctx.params.raw.get('ice'))) : 0;
  let keyAz = NaN; // eased azimuth of the art-directed key light
  let squall = 0, squallT = 20;
  let smoothWind = 2;

  const machine = new WeatherMachine(rng.fork(4), (from, to) => {
    bus.emit('weather:changed', { from, to });
    const { headline, kind } = headlineFor(to, rng, api.nightFactor > 0.5);
    bus.emit('gazette', { headline, kind });
  });

  const api: AtmosphereAPI = {
    get weather() { return machine.weather; },
    set weather(_w: Weather) { /* read-only: use setWeather */ },
    get target() { return machine.target; },
    set target(_w: Weather) { /* read-only: use setWeather */ },
    setWeather(w: Weather, instant = false) {
      machine.set(w, instant);
      if (instant) {
        const m = machine.mix;
        wetness = m.rain > 0.05 ? 1 : 0;
        snowCover = m.snow > 0.05 ? 1 : 0;
        if (m.snow > 0.05) iceAmount = Math.max(iceAmount, 0.3); // a hard frost has already rimed the margins
        temperature = baseTemp(clock.hour) + m.temp;
        applyWeatherNow();
      }
    },
    get auto() { return machine.auto; },
    set auto(v: boolean) { machine.auto = v; },
    nightFactor: 0,
    sunDir: new THREE.Vector3(0.3, 0.8, 0.5).normalize(),
    rain: 0,
    snow: 0,
    fog: 0,
    wind: new THREE.Vector2(1.8, 0.6),
    temperatureC: 12,
    lightningFlash: 0,
    // v2 live values (written every update)
    skyColor: new THREE.Color(0x9ec3d6),
    sunColor: new THREE.Color(0xfff1d8),
    keyLightDir: new THREE.Vector3(0.3, 0.8, 0.5).normalize(),
    dawnMist: 0,
    iceAmount: 0,
    gloom: 0,
    snowCover: 0,
    wetness: 0,
  };
  ctx.reg.atmosphere = api;
  // AtmosphereAPI.debugStrike (optional in the contract): force a strike, optionally freezing the flash
  Object.assign(api, { debugStrike: (dist?: number, hold = false) => { strike(dist); holdFlash = hold; } });
  // AtmosphereAPI.setIce (optional in the contract): frost-fair trigger and debugging
  api.setIce = (v: number) => { iceAmount = clamp01(v); api.iceAmount = iceAmount; };

  function baseTemp(h: number) { return 11 + 6 * Math.sin((Math.PI * (h - 9)) / 12); }

  function applyWeatherNow() {
    const m = machine.mix;
    api.rain = m.rain; api.snow = m.snow; api.fog = m.fog; api.temperatureC = temperature;
    mats.setWetness(wetness);
    mats.setSnow(snowCover * 0.92);
    api.wetness = wetness; api.snowCover = snowCover; api.iceAmount = iceAmount;
  }

  // scratch objects (no per-frame allocation)
  const sunTrue = new THREE.Vector3();
  const moonTrue = new THREE.Vector3();
  const keyDir = new THREE.Vector3();
  const grey = new THREE.Color();
  const fogWhite = new THREE.Color();
  const tmpC = new THREE.Color();
  const rainLight = new THREE.Color();
  const mistCol = new THREE.Color();
  const snapFocus = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const bufSize = new THREE.Vector2();
  const C_OVERCAST = new THREE.Color(0xa9b1b8);
  const C_STORM = new THREE.Color(0x485058);
  const C_FOG = new THREE.Color(0xd2d6d4);
  const C_HEMI_GREY = new THREE.Color(0xc4ccd4);
  const hemiGrey = new THREE.Color();
  const C_SNOWGROUND = new THREE.Color(0xc4ccd8);
  const C_FLASH = new THREE.Color(0xe4ecff);
  const C_RAIN_DAY = new THREE.Color(0xd4dee8);
  const C_RAIN_NIGHT = new THREE.Color(0x7d8cb8);

  function dirFrom(phi: number, elev: number, out: THREE.Vector3) {
    const ce = Math.cos(elev);
    return out.set(Math.cos(phi) * ce, Math.sin(elev), Math.sin(phi) * ce).normalize();
  }

  function strike(forceDist?: number) {
    const dist = forceDist ?? fxRng.range(25, 260);
    const a = fxRng.range(0, Math.PI * 2);
    const pos = new THREE.Vector3(view.focus.x + Math.cos(a) * dist, 0, view.focus.z + Math.sin(a) * dist);
    const intensity = fxRng.range(0.6, 1) * (dist < 120 ? 1 : 0.8);
    flashT = 0;
    flashI = intensity;
    bolt.strike(pos, view.forward, fxRng);
    bus.emit('weather:lightning', { pos, intensity });
    thunders.push({ t: 0.35 + dist / 110, pos, volume: THREE.MathUtils.clamp(1.25 - dist / 280, 0.35, 1) });
    if (dist < 110) {
      try { ctx.reg.camera?.shake(0.25 + 0.6 * intensity * (1 - dist / 110)); } catch { /* camera not ready */ }
    }
  }

  function flashEnvelope(t: number) {
    if (t < 0.07) return 1;
    if (t < 0.13) return 0.3;
    if (t < 0.22) return 0.85;
    return Math.exp(-(t - 0.22) * 9);
  }

  return {
    name: 'atmosphere',
    update(dt, clk) {
      const dtSim = clk.dtSim;
      const h = clk.hour;
      fxTime += dt;

      updateViewInfo(view, ctx.camera.current, renderer);

      // ── weather state ──
      machine.update(dtSim, h, temperature);
      const m = machine.mix;

      // temperature (sim time)
      const tTarget = baseTemp(h) + m.temp;
      temperature += (tTarget - temperature) * Math.min(1, dtSim / 45);

      // ── sun & moon ──
      let phi: number, elev: number, nightF: number;
      if (h >= 6 && h <= 20) { const f = (h - 6) / 14; phi = f * Math.PI; elev = 58 * DEG * Math.sin(f * Math.PI); nightF = 0; }
      else { const f = (((h - 20) % 24) + 24) % 24 / 10; phi = Math.PI + f * Math.PI; elev = -34 * DEG * Math.sin(f * Math.PI); nightF = f; }
      const elevDeg = elev / DEG;
      dirFrom(phi, elev, sunTrue);
      const moonElev = nightF > 0 ? 55 * DEG * Math.sin(nightF * Math.PI) : -elev;
      dirFrom(phi + Math.PI + 0.35, moonElev, moonTrue);

      const sunK = smoothstep(-3, 8, elevDeg);
      // (the moon/twilight key overlaps the sunset: blue hour is never darker than midnight)
      const moonK = smoothstep(-1, -6, elevDeg);
      const astroNight = smoothstep(5, -9, elevDeg);
      const gloomNight = m.gloom * 0.32 + m.fog * 0.12;
      const nf = clamp01(astroNight + (1 - astroNight) * gloomNight);
      api.nightFactor = nf;

      // ── wetness & snow cover (sim time) ──
      if (m.rain > 0.05) wetness = Math.min(1, wetness + dtSim * m.rain / 9);
      else wetness = Math.max(0, wetness - dtSim * (0.004 + 0.01 * sunK * m.sun));
      if (m.snow > 0.05 && temperature < 3) snowCover = Math.min(1, snowCover + dtSim * m.snow / 40);
      else if (snowCover > 0) {
        const melt = dtSim * (temperature > 3 ? 1 / 70 : 1 / 400);
        snowCover = Math.max(0, snowCover - melt);
        if (temperature > 3) wetness = Math.max(wetness, Math.min(0.7, snowCover * 1.5));
      }

      // ── wind: slowly veering direction; calm mornings, breezy afternoons, gales (with squalls) in storms ──
      const tm = clk.minutes;
      const wAng = 0.5 + 0.9 * Math.sin(tm * 0.0021) + 0.35 * Math.sin(tm * 0.0093 + 1.7);
      // diurnal cycle (fair weather): still at dawn, freshening to a breeze mid-afternoon, easing at night
      const diurnal = 0.42 + 0.78 * smoothstep(7, 14.5, h) * (1 - smoothstep(17.5, 22, h));
      // some days are simply breezier than others (seeded per day, blended across midnight): a fresh fair-weather
      // afternoon can reach kite-flying strength (~4-5 m/s) while others stay still
      const dayHash = (d: number) => { const x = Math.sin((d + 1) * 127.1 + ctx.params.seed * 311.7) * 43758.5453; return x - Math.floor(x); };
      const dayF = clk.minutes / 1440;
      const d0 = Math.floor(dayF), fr = smoothstep(0.9, 1, dayF - d0);
      const breeze = 0.7 + 1.2 * lerp(dayHash(d0), dayHash(d0 + 1), fr);
      const stormy = clamp01(m.lightning + m.rain * 0.4);
      const meanWind = m.wind * lerp(diurnal * breeze, 1, stormy);
      // storm squalls: every 15-40 s of real time a 6-12 s surge
      squallT -= dt;
      if (squallT <= 0) { squallT = fxRng.range(15, 40); squall = m.lightning > 0.3 ? fxRng.range(6, 12) : 0; }
      if (squall > 0) squall -= dt;
      const surge = squall > 0 ? 1 + 0.45 * m.lightning * Math.sin(Math.min(1, squall / 6) * Math.PI) : 1;
      const gust = 1 + 0.12 * Math.sin(fxTime * 0.63) + 0.08 * Math.sin(fxTime * 1.9 + 0.5);
      smoothWind += (meanWind - smoothWind) * Math.min(1, dtSim / 20 + dt * 0.02);
      const wSpd = smoothWind * gust * surge;
      api.wind.set(Math.cos(wAng) * wSpd, Math.sin(wAng) * wSpd);
      // gustiness for the shared wind uniforms (core adds the travelling gust waves); overrides the weather-name guess
      const gustiness = clamp01(0.22 + 0.2 * m.cloud + 0.3 * m.rain + 0.45 * m.lightning + 0.15 * m.snow - 0.35 * m.fog + (squall > 0 ? 0.25 : 0));
      try { ctx.wind?.set(api.wind, gustiness); } catch { /* core wind not present */ }

      // ── river ice: freezes after ~6 sim hours below −3 °C (margins first), thaws above +2 °C ──
      if (temperature < -3) iceAmount = Math.min(1, iceAmount + dtSim / 360);
      else if (temperature > 2) iceAmount = Math.max(0, iceAmount - dtSim / 150);

      // ── lightning (visual, real time; paused sim = no strikes) ──
      if (m.lightning > 0.3 && !clk.paused && clk.timeScale > 0) {
        strikeTimer -= dt;
        if (strikeTimer <= 0) { strike(); strikeTimer = fxRng.range(3, 11) / m.lightning; }
      }
      if (!holdFlash) flashT += dt;
      api.lightningFlash = flashT < 1.5 ? flashI * flashEnvelope(flashT) : 0;
      const flash = api.lightningFlash;
      for (let i = thunders.length - 1; i >= 0; i--) {
        const th = thunders[i];
        th.t -= dt;
        if (th.t <= 0) {
          bus.emit('audio:cue', { cue: 'thunder', pos: th.pos, volume: th.volume });
          thunders.splice(i, 1);
        }
      }
      bolt.update(holdFlash ? 0 : dt);

      // ── palette ──
      sampleSky(h, skyK);
      const dayB = 1 - nf * 0.84;
      grey.copy(C_OVERCAST).lerp(C_STORM, m.gloom).multiplyScalar(dayB);
      fogWhite.copy(C_FOG).multiplyScalar(lerp(1, 0.2, astroNight));
      // tint the fog with a touch of the sky key so fog at dawn/dusk is warm
      fogWhite.lerp(skyK.fog, 0.25);

      const cloud = m.cloud;
      const heavy = smoothstep(0.3, 0.95, cloud); // clear-sky puffs should not grey the sky
      keyCol.zenith.copy(skyK.zenith).lerp(tmpC.copy(grey).multiplyScalar(0.88), heavy * 0.92);
      keyCol.horizon.copy(skyK.horizon).lerp(grey, heavy * 0.8);
      keyCol.fog.copy(skyK.fog).lerp(grey, heavy * 0.75);
      const fogAmt = m.fog;
      keyCol.fog.lerp(fogWhite, fogAmt * 0.9);
      keyCol.horizon.lerp(keyCol.fog, Math.max(fogAmt, m.snow * 0.5));
      keyCol.zenith.lerp(keyCol.fog, fogAmt * 0.7);

      // ── lights ──
      const sunI = 2.75 * sunK * m.sun * (1 + 0.75 * (1 - smoothstep(10, 40, elevDeg)));
      const moonI = 0.7 * moonK * (1 - heavy * 0.55) * (1 - fogAmt * 0.4);
      const useSun = sunK > 0.001 && sunI >= moonI;
      // art direction (issue 4): keep the key light's azimuth within ~75° of the camera's, so the faces the
      // camera sees are lit at golden hour instead of silhouetted. The true sun (sky glow) is untouched.
      const camAz = Math.atan2(view.camPos.z - view.focus.z, view.camPos.x - view.focus.x);
      const trueAz = useSun ? phi : phi + Math.PI + 0.35;
      const wantAz = camAz + softAz(wrapPi(trueAz - camAz));
      if (Number.isNaN(keyAz)) keyAz = wantAz;
      else keyAz += wrapPi(wantAz - keyAz) * Math.min(1, dt * 2.2 + dtSim * 0.5);
      if (useSun) {
        // keep the light a little higher than the true sun so low sun doesn't turn the diorama to mud,
        // and compensate grazing irradiance at dawn/dusk
        const e = Math.max(elev, 24 * DEG);
        dirFrom(keyAz, e, keyDir);
        key.color.copy(skyK.sun).lerp(grey, heavy * 0.4);
        key.intensity = sunI;
      } else {
        const e = Math.max(moonElev, 44 * DEG); // (a steady high moon key: no mid-evening dip as the true moon climbs)
        dirFrom(keyAz, e, keyDir);
        key.color.copy(MOON_COLOR);
        key.intensity = moonI;
      }
      api.sunDir.copy(useSun || moonK < 0.01 ? sunTrue : moonTrue);
      api.keyLightDir.copy(keyDir);
      api.sunColor.copy(key.color);

      // warm golden-hour fill from the camera side (no shadows); a softer touch at sunrise
      const golden = smoothstep(17.6, 18.5, h) * (1 - smoothstep(20.05, 20.55, h)) + 0.45 * smoothstep(5.3, 5.9, h) * (1 - smoothstep(7.0, 7.8, h));
      const fillI = 0.38 * golden * m.sun * (1 - heavy * 0.7) * (1 - fogAmt * 0.6);
      fill.intensity = fillI;
      fill.visible = true;
      if (fillI > 0.001) {
        fill.color.copy(skyK.sun).lerp(tmpC.set(0xffc896), 0.5);
        dirFrom(camAz, 32 * DEG, tmpV);
        fill.target.position.copy(view.focus);
        fill.position.copy(view.focus).addScaledVector(tmpV, 300);
        fill.target.updateMatrixWorld();
      }

      // soft overcast light: a light grey sky by day; at night keep the moonlit blue so it stays readable
      hemiGrey.copy(C_HEMI_GREY).lerp(C_STORM, m.gloom * 0.45);
      hemi.color.copy(skyK.hemiSky).lerp(hemiGrey, heavy * 0.65 * (1 - astroNight * 0.75)).lerp(fogWhite, fogAmt * 0.4 * (1 - astroNight * 0.6));
      hemi.groundColor.copy(skyK.hemiGround).lerp(tmpC.copy(C_SNOWGROUND).multiplyScalar(dayB), snowCover * 0.55);
      hemi.intensity = skyK.hemiI * (1 + 0.3 * heavy * (1 - astroNight)) * (1 - 0.12 * m.gloom) + flash * 2.6;
      if (flash > 0) hemi.color.lerp(C_FLASH, Math.min(1, flash));
      amb.color.copy(hemi.color).lerp(hemi.groundColor, 0.4);
      amb.intensity = skyK.ambI;

      // shadow frustum follows the view, snapped to texels to limit shimmer
      const E = Math.round(THREE.MathUtils.clamp(view.extent * 1.05, 70, 240) / 10) * 10;
      if (E !== shadowExtent) {
        shadowExtent = E;
        sc.left = -E; sc.right = E; sc.top = E; sc.bottom = -E;
        sc.updateProjectionMatrix();
      }
      const texel = (2 * E) / SHADOW_MAP * 2;
      snapFocus.set(Math.round(view.focus.x / texel) * texel, 0, Math.round(view.focus.z / texel) * texel);
      key.target.position.copy(snapFocus);
      key.position.copy(snapFocus).addScaledVector(keyDir, 650);
      key.target.updateMatrixWorld();
      // keep castShadow fixed (toggling it changes the lighting hash and recompiles EVERY material at dusk/dawn);
      // instead stop re-rendering the shadow map while the key light is too dim for its shadows to show
      const shadowsLive = key.intensity > 0.05;
      if (ctx.renderer.shadowMap.autoUpdate !== shadowsLive) {
        ctx.renderer.shadowMap.autoUpdate = shadowsLive;
        if (shadowsLive) ctx.renderer.shadowMap.needsUpdate = true;
      }

      // ── fog distances relative to the camera (works for ortho & perspective) ──
      const fogF = clamp01(Math.max(fogAmt, m.rain * 0.4, m.snow * 0.5));
      fog.color.copy(keyCol.fog);
      if (flash > 0) fog.color.lerp(C_FLASH, flash * 0.3);
      fog.near = view.dist + lerp(230, -110, fogF);
      fog.far = view.dist + lerp(1300, 190, Math.pow(fogF, 0.8));

      // ── sky dome ──
      const u = sky.uniforms;
      u.uZenith.value.copy(keyCol.zenith);
      u.uHorizon.value.copy(keyCol.horizon);
      u.uGround.value.copy(keyCol.fog);
      u.uSunDir.value.copy(sunTrue);
      u.uSunColor.value.copy(skyK.sun);
      u.uSunVis.value = smoothstep(-6, 2, elevDeg) * (1 - heavy * 0.9) * (1 - fogAmt * 0.8);
      u.uMoonDir.value.copy(moonTrue);
      u.uMoonVis.value = smoothstep(-2, 8, moonElev / DEG) * (0.35 + 0.65 * astroNight);
      u.uMoonPhase.value = ((clk.minutes / 1440 + 9) / 29.5) * Math.PI * 2;
      u.uCloud.value = heavy;
      u.uFlash.value = flash;
      const starOp = astroNight * astroNight * (1 - heavy) * (1 - fogAmt);
      sky.update(view.camPos, fxTime, starOp, renderer.getPixelRatio(), clk.minutes * 0.0007);

      // ── clouds ──
      const cu = clouds.uniforms;
      cu.uSunDir.value.copy(keyDir);
      cu.uSunCol.value.copy(key.color).multiplyScalar(Math.min(1.2, key.intensity / 2.2));
      cu.uLit.value.copy(tmpC.setRGB(1, 1, 1)).lerp(grey, 0.15 + heavy * 0.3 + m.gloom * 0.5).multiplyScalar(lerp(1.05, 0.2, astroNight));
      cu.uLit.value.lerp(skyK.horizon, 0.18 * (1 - astroNight));
      cu.uShade.value.copy(grey).multiplyScalar(0.75).lerp(keyCol.zenith, 0.3);
      cu.uOpacity.value = lerp(0.85, 0.95, heavy) * (1 - fogAmt * 0.6);
      cu.uCentreFade.value = 0.4;
      renderer.getDrawingBufferSize(bufSize);
      cu.uRes.value.copy(bufSize);
      cu.uFlash.value = flash;
      // visible puffs only make sense where there is sky to see them against (perspective views); in the
      // isometric view they would sit between camera and diorama, so there only their shadows drift by
      clouds.update(dt, view.focus, api.wind, cloud, !view.ortho && (view.camPos.y < 55 || view.forward.y > -0.45));
      // patchy sky -> distinct shadows; a full overcast is uniform, so they fade out as cover closes in
      const patchy = cloud < 0.02 ? 0 : 1 - smoothstep(0.5, 0.85, cloud);
      const csStrength = useSun ? 0.36 * patchy * smoothstep(0.3, 1.6, key.intensity) * (1 - fogAmt) : 0;
      cloudShadows.update(dt, view.focus, view.forward, view.camPos.y, view.extent, api.wind, THREE.MathUtils.clamp(0.2 + cloud * 1.2, 0.2, 0.75), csStrength);

      // ── precipitation ──
      rainLight.copy(C_RAIN_DAY).lerp(C_RAIN_NIGHT, astroNight).multiplyScalar(1 - m.gloom * 0.25);
      if (flash > 0) rainLight.lerp(C_FLASH, flash * 0.7);
      const pxPerDepth = view.ortho ? 0 : (2 * Math.tan(((ctx.camera.current as THREE.PerspectiveCamera).fov ?? 50) * DEG / 2)) / view.heightPx;
      precip.update({
        time: fxTime, focus: view.focus, extent: view.extent, pxWorld: view.pxWorld, ortho: view.ortho, pxPerDepth,
        pixelRatio: renderer.getPixelRatio(), wind: api.wind, rain: m.rain, snow: m.snow, light: rainLight,
      });

      // ── ground mist (weather fog + early-morning mist in calm weather) ──
      const calm = clamp01(1 - api.wind.length() / 5);
      const cool = 1 - smoothstep(9, 16, temperature);
      const dawn = smoothstep(3.8, 5.2, h) * (1 - smoothstep(7.6, 9.0, h));
      const dawnMist = dawn * 0.3 * calm * (1 - m.rain);
      const mistAmt = clamp01(fogAmt * 0.95 + dawnMist + m.rain * 0.12 + m.snow * 0.1);
      mistCol.copy(keyCol.fog).lerp(fogWhite, 0.5).multiplyScalar(1.04);
      mist.update(dt, view.focus, view.extent, api.wind, mistAmt, mistCol);
      // v2: low mist over water & meadows (dawn in calm, cool weather; any fog; a breath of it on autumnal evenings)
      const dusk = smoothstep(19.6, 21, h) * (1 - smoothstep(23, 24, h)) * 0.35;
      api.dawnMist = clamp01((dawn + dusk) * calm * (0.35 + 0.65 * cool) * (1 - m.rain * 0.8) * (1 - m.lightning) + fogAmt * 0.85 + m.snow * 0.1);
      // nature draws its own mist cards over the water where the tier allows (knobs.water.mist); the valley ribbon
      // only fills in on tiers without them, so the river is never double-misted
      riverMist.update(dt, natureMist ? 0 : clamp01(api.dawnMist * 1.1), mistCol, api.wind);

      // ── edge haze: only when the view can reach beyond the playfield ──
      const vb = ctx.view?.bounds;
      edgeHaze.mesh.visible = !view.ortho || !vb || Math.max(Math.abs(vb.minX), Math.abs(vb.maxX), Math.abs(vb.minZ), Math.abs(vb.maxZ)) > 395;
      if (edgeHaze.mesh.visible) edgeHaze.update(fog.color);

      // ── publish + global material/post state ──
      api.rain = m.rain; api.snow = m.snow; api.fog = m.fog;
      api.skyColor.copy(keyCol.horizon).lerp(keyCol.zenith, 0.35);
      api.wetness = wetness; api.snowCover = snowCover; api.iceAmount = iceAmount;
      // "dark enough for lamps": night, storm gloom and fog
      api.gloom = clamp01(nf * 1.05 + m.gloom * 0.35 * (1 - astroNight) + fogAmt * 0.25 + (1 - sunK) * 0.1);
      api.temperatureC = Math.round(temperature * 10) / 10;
      mats.setNight(nf);
      mats.setWetness(Math.round(wetness * 100) / 100);
      mats.setSnow(Math.round(snowCover * 0.92 * 100) / 100);

      bloom.strength = lerp(0.0, 0.72, nf) + fogAmt * 0.18 * nf + flash * 0.5;
      bloom.threshold = lerp(1.0, 0.62, nf);
      bloom.radius = 0.55;
      renderer.toneMappingExposure = skyK.exposure * (1 + 0.1 * heavy * (1 - nf)) * (1 - 0.12 * snowCover * (1 - nf)) + flash * 0.25;
    },
    dispose() {
      sky.dispose(); clouds.dispose(); cloudShadows.dispose(); precip.dispose(); mist.dispose(); bolt.dispose(); riverMist.dispose(); edgeHaze.dispose();
      scene.remove(cloudShadows.mesh, sky.group, clouds.group, precip.group, mist.group, bolt.mesh, riverMist.mesh, edgeHaze.mesh, hemi, amb, key, key.target, fill, fill.target);
      key.dispose(); hemi.dispose(); amb.dispose(); fill.dispose();
    },
  };
}
