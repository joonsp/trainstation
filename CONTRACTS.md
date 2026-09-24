# Victorian Junction: contracts for builders

> **v2 ("a living thingy") is in progress.** Read the **v2 section at the end of this file first**, then `docs/V2_DESIGN.md` (the plan and your scope list). Where v2 conflicts with anything above it, v2 wins.

Vite, TypeScript (strict), three 0.186, pnpm 10 (pinned via `mise.toml`), TypeScript 7 (`tsc`). Import addons from `three/addons/...`.
The authoritative types are in `src/core/*.ts`. Read `src/core/apis.ts` and `src/core/layout.ts` before writing code.

## Directory ownership (edit ONLY your own directories)

| Path | Owner (v2) |
|---|---|
| `src/core/**`, `src/main.ts`, `vite.config.ts`, `tsconfig.json`, `package.json`, `scripts/**`, `docs/**`, `CONTRACTS.md` | Integrator |
| `src/world/**` | world builder |
| `src/nature/**` (new) | nature builder |
| `src/traffic/**` (new) | traffic builder |
| `src/people/**` | people builder |
| `src/trains/**`, `src/maintenance/**` | trains + maintenance builder |
| `src/events/**`, `src/atmosphere/**` | events + atmosphere builder |
| `src/camera/**`, `src/ui/**`, `src/audio/**`, `index.html` | camera + ui + audio builder |

Each entry point is `src/<dir>/index.ts` and exports `create<Name>(ctx: Ctx): System`. It must assign its API to `ctx.reg.<slot>` **during** create. Every current entry file is a `STUB`. Replace it completely and keep the export name. You can add as many other files in your directory as you like. Don't add npm dependencies. If you need something from core, ask the Integrator instead of editing core.

## Lifecycle

- **Creation order (v2):** atmosphere, world, **nature**, trains, **traffic**, people, maintenance, events, camera, ui, audio.
  - Inside `create` you may only use the APIs of systems created **before** yours.
  - All systems exist before the first `update` and before bus `'ready'` fires. From then on, any API can be used from `update()`, bus handlers and promises.
  - Subscribe to `ctx.bus.on('ready', ...)` for work that needs later systems.
- **`update(dt, clock)`:**
  - `dt` is the real time in seconds, clamped to 0.1 or less. Use it for **visual** animation only: smoke, rain particles, limb swing, lamp flicker, camera easing.
  - `clock.dtSim` is the sim minutes elapsed this tick. Use it for **simulation** logic: schedules, wear, patience, event timers. It is 0 while paused.
  - `clock.dtMotion` is the seconds of physical motion to integrate (`dtSim × MOTION_SECONDS_PER_SIM_MINUTE`, which is 1). **Train and people movement must integrate `dtMotion`**, not `dt`. That way, pause, 10×/60× and `__station.advance()` all stay consistent. At timeScale 1 (the default: 1 sim minute per real second, so a day lasts 24 real minutes), motion runs in real time.
  - main.ts **sub-steps**, so `clock.dtSim` is at most 0.5 inside `update` (`MAX_SIM_STEP`). At 60×, one frame means about 12 `update` calls, each with `dt/12`. Keep `update` cheap and tolerant of 0.5-min steps (a train at 20 m/s moves 10 m per step, so clamp at stop points).
  - `__station.advance(min)` runs `update(1/60, clock)` repeatedly in 0.5-sim-min steps with no rendering. Don't rely on rendering or `requestAnimationFrame` for sim state.
- Every `update` is wrapped in try/catch, and errors are logged once per system and message. The loop continues even if your system throws.
- **Clock:**
  - `clock.minutes` is the total number of sim minutes.
  - `hour` is 0–24 (float), plus `day`, `weekday` (0 = Mon) and `format()`, which returns `HH:MM`.
  - `formatSimTime(min)` is exported from `core/clock`.
  - `'time:hour'` fires on each integer hour.

## Shared objects on `ctx`

- **`ctx.bus`:** typed events (see the `Events` map in `core/bus.ts`).
  - `on` returns an unsubscribe function; `once`, `off` and `emit` are also available.
  - Handlers run synchronously, and exceptions are caught.
  - Sound: emit `'audio:cue'` with `{cue, pos?, volume?}`. The audio system listens. Don't call audio directly unless you need to.
- **`ctx.reg`:** the API registry: `ctx.reg.trains.list()` and so on. Interfaces are in `core/apis.ts`.
- **`ctx.rng`:** seeded `Rng` (from `?seed=`). Use `rng.fork(salt)` for an independent stream per system, which keeps things deterministic.
- **`ctx.mats`:** shared flat-shaded `MeshStandardMaterial`s.
  - Available: brick, brickDark, stone, cream, slate, iron, bottleGreen, oxblood, brass, wood, sleeper, rail, ballast, platform, gravel, grass, glass, windowLit, lampGlow, snow.
  - **Reuse them.** Don't clone them per object, so that weather and night stay global.
  - **Only atmosphere** calls `setWetness(w)`, `setSnow(s)` and `setNight(n)`. These are idempotent and cache base colours. `setNight` drives the emissive intensity of `windowLit` and `lampGlow`.
  - If you need a different colour, create your own material from `core/palette.ts` and follow atmosphere's `nightFactor` yourself.
- **Palette:** `core/palette.ts` has the hex constants, `LIVERIES.{coast,highland,freight,royal,circus,ghost,teak}`, `CLOTHING`, `SKIN` and `HAIR`.
- **Post-processing:**
  - `ctx.bloom` is an UnrealBloomPass with strength 0. Atmosphere drives `bloom.strength` (for example, about 0.6 at night).
  - `ctx.renderer.toneMappingExposure` belongs to atmosphere.
- **`ctx.camera.current`:** the camera system sets it; main renders with it every frame.
- **`ctx.ui`:** the `#ui` overlay root. `pointer-events: none` is set on the root and `auto` on its direct children.
- **`ctx.params`:** URL parameters (see below). `ctx.params.raw` holds the raw `URLSearchParams` for ad-hoc flags.

## Layout (`ctx.layout`, `src/core/layout.ts`)

Axes: **x = east, z = south (north = −z), y = up**. 1 unit = 1 m. The ground is 520 × 520 centred at the origin (`layout.bounds = 260`).

- **Curve parameter `t`** means the arc-length fraction from 0 to 1. Always use `curve.getPointAt(t)` / `getTangentAt(t)`, or the helpers `line.pointAt`, `tangentAt`, `offsetPoint(t, lateral, y?)`, `nearestT(pos)` and `yawAt(t)`.
  - Metres to t: `dt = metres / line.length`.
  - Curves lie at **y = RAIL_TOP = 0.35**, the rail head. Put wheels on the curve point. Ballast runs from y 0 to ~0.2, sleepers to ~0.28, rails to 0.35.
- **Lateral / side convention:** the "side" vector is `tangent × up = (−tz, 0, tx)`. For an eastbound tangent it points to the right of travel. `offsetPoint(t, +d)` moves along it.
- **yaw convention:** `object.rotation.y = yaw` maps local +x to `(cos yaw, 0, −sin yaw)`.
  - `line.yawAt(t)` makes a model whose length runs along local +x face "east" (increasing t). Add π for westbound.
  - `platform.yaw` and `station.yaw` follow the same rule (local +x points east / along the platform).
- **Coast Line** (`lines.coast`, platform 1):
  - Straight along **z = 24** from x −300 to +300, length 600 m.
  - Ends: west `Brightmouth`, east `Kingsport`.
  - `platformSide = −1`: **P1 is on the NORTH side**.
- **Highland Line** (`lines.highland`, platform 2):
  - Runs along z = 19 (5 m north of coast) from x −300 to −80.
  - Then an R = 100 m curve turns 40° north. After that it runs straight NE (heading 40° north of east) to (306, −274). Length 709.8 m.
  - Ends: west `Ashby Vale`, east `Glenmoor`.
  - `platformSide = +1`: **P2 is on the SOUTH-EAST side**.
  - The tracks never cross: minimum separation is 5 m in the west parallel section. **The V opens to the east.**
- **Platforms:**
  - Both are 110 m long, 7 m wide, with the top at **y = 1.0** (`PLATFORM_TOP`) and the edge (coping) **1.7 m** from the track centreline (`PLATFORM_EDGE_OFFSET`). Both lie on straight track, so each is an exact rectangle (`center`, `yaw`, `length`, `width`).
  - **P1:** x −15 → 95, centre (40, 1, 18.8), yaw 0.
  - **P2:** from (−15.7, −4.4) to (68.5, −75.1) along the track, centre (29.8, 1, −35.8), yaw 40°.
  - `platform.inward` is the unit xz vector from the track toward the platform back (wedge).
  - Canopies cover the middle `CANOPY_LENGTH = 70` m of each platform.
  - `benches` holds 8 benches per platform under the canopy. Each bench's local +z (front) faces the track.
  - `edgePointAt(t)` is the boarding point, 0.5 m in from the coping.
  - `randomPoint(rng)` returns a waiting spot.
- **Wedge:** the distance between track centrelines is 57.6 m at the middle of P1 and 63.7 m at the middle of P2.
- **Station building:**
  - `station.center` (17.6, 0, −0.4), yaw 20° (the wedge bisector), size 32 × 9 × 14.
  - Local +x points ENE toward the forecourt. The local +z facade faces P1 and the local −z facade faces P2.
  - The floor/plinth is at y = 1.0. There are steps down to the forecourt at the east door.
  - There are about 2–4 m of clear ground between the building and each platform's back edge.
  - `world.clockTowerTop` is decided by world.
- **Forecourt:** centre (49.5, 0, −12.1), size 28 × 32, yaw 20°, at ground level y = 0.
  - `entrance` (64.6, 0, −17.5) is at the forecourt's east edge; passengers spawn and leave here.
  - The approach road runs from the entrance to the east ground edge: `layout.road` `{a, b, width: 10}`.
  - `bookingOffice` (34.0, 1.0, −6.4) is the queue point outside the east door, at the top of the steps.
- **Footbridge:** `a` (−6, 1, 18.8) on P1 and `b` (−4.7, 1, −6.8) on P2 are the stair feet on the platform centrelines. The span is 25.7 m across the wedge tip, just west of the building. Deck height is up to world (suggested 6.5–7).
- **Signals:** `signalT.east` is at the platform's WEST end − 6 m and protects **eastbound** trains; `signalT.west` is at the EAST end + 6 m. The suggested post position (used by the world stub) is `offsetPoint(signalT[end], −platformSide × 2.5, 0)`, on the side away from the platform.
- **Shed:**
  - `shed.curve` starts at the coast switch (x −45, `switchT = 0.425`) **heading WEST**; its t increases westward.
  - It runs through an S-curve 24 m south to a buffer at (−156.9, 0.35, 47.9). Length 116.4 m.
  - A westbound coast train at `switchT` can continue onto `shed.curve` at t = 0. An eastbound train must reverse.
  - `bayT` (0.9656) is where the loco head stops, 4 m before the buffer.
  - Shed building: centre (−142.9, 0, 47.9), 38 × 9 × 13, yaw 0. The siding enters through its east wall.
  - `waterTower` (−81.5, 0, 40.9) is on the south side of the siding straight (`waterT` is the siding t beside it).
  - `coalStage` (−115.6, 0, 42.4) is on the north side.
  - `turntable` (−144.9, 0, 69.9), a decorative ~12 m pit, is south of the shed.
  - `workerSpot` (−148.9, 0, 50.9) is inside, beside the bay.
- **Staff crossing:** a barrow crossing over the coast track at x = −30 (`layout.crossing.north/south`), between the switch (−45) and the P1 west signal (−21).
- **Nav graph:** `layout.nav.nodes` / `edges`, with node y at walking height (0 = ground, 1 = platform or building).
  - Passenger route: `entrance → forecourt → steps → booking → hall → p1Door | p2Door → p1_0..8 | p2_0..8` (platform centrelines, west → east).
  - The footbridge edge is `fbA—fbB`.
  - Staff route: `p1_0 → p1Ramp → xingN → xingS → yardA → water | yard → shedDoor → worker | turntable` (`layout.staffNodes`).
  - `layout.path(from, to)` snaps both ends to their nearest nodes, runs Dijkstra and returns `[from, ...nodes, to]`. Passenger routes never use staff nodes.
- **Other placement data:**
  - `lampPositions` has 21 entries: 7 per platform along the back edge, 4 at the forecourt corners and 3 along the road.
  - `trees` has 150 entries, already clear of tracks, platforms, buildings, the road and nav edges.
- **Place nothing on tracks.** `layout.validate()` runs at startup and `console.error`s any issue. `node scripts/check-layout.mjs` prints every key coordinate and validates.

## Debug / URL parameters

`time` (hour float), `weather` (clear|overcast|rain|storm|fog|snow), `speed` (timeScale), `seed` (int, default 1), `event` (id, triggered about 2 s after start), `cam` (iso|persp), `advance` (sim minutes fast-forwarded at start), `mute=1`, `noui=1` (hides `#ui`), `select` (train|person, emits `select` for the first one at about 2.5 s), `debug`:

- `debug=layout` draws curves (coast blue, highland red, shed yellow), platform and canopy rects, station (orange), forecourt (cyan), shed (purple), signals (red = east, orange = west), stop points (cyan), nav graph (green; staff routes pink), lamps, benches and trees.
- `debug=layout,top&zoom=75&cx=20&cz=-15` adds a top-down orthographic view with north up (zoom is the half-height in metres).

`window.__station` = `{ ctx, setHour(h), setWeather(w), setSpeed(s), trigger(id), advance(simMin) → {steps, ms, time}, stats() → {hour, day, time, weather, trains[{id,name,line,state,platform,passengers,condition}], people, activeEvents, shed, fps, drawCalls, triangles, layoutIssues}, layoutIssues }`.

## Screenshot harness

```
node scripts/shot.mjs --port <YOUR_PORT> --out shots/<you> [--wait 3500] [--advance 30] [--size 1280x800] \
     [--eval "__station.setWeather('storm')"] "time=12" "time=22&weather=rain" ...
```

- The harness starts its own Vite server on that port (always use **your assigned port**) and loads headless Chromium with SwiftShader WebGL. Each querystring gives one PNG: `<out>/<n>-<qs>.png`.
- Each shot prints one JSON line: `{file, qs, consoleErrors, pageErrors, stats, evalResult?}`.
- **Look at the PNGs with the Read tool.** SwiftShader is slow (about 15–20 fps with the stubs), so keep scenes efficient: merge geometry, use InstancedMesh, and keep shadow-casting lights to a minimum.
- A good self-check: `pnpm exec tsc --noEmit`, then the shots show no `pageErrors` and no `consoleErrors`.

## Style reminders

- Low-poly and flat-shaded (`flatShading: true`) with chunky silhouettes that read in an orthographic isometric view. Use the restrained Victorian palette from `palette.ts`.
- Everything must work by day, at night (warm lamps, lit windows, bloom) and in every weather.
- Cast and receive shadows on the big meshes only.

## Integration amendments (Integrator)

These supersede anything above where they conflict.

- **Liveries:** Coast Line = crimson lake (`OXBLOOD`), Highland Line = bottle green. `LIVERIES` in `palette.ts`, `trains/cars.ts` and the UI line pills all agree.
- **Footbridge:** `layout.footbridge` now carries `deck` (6.6), `stairRun` (7.5), `landing` (1.4) and `route` = `[a, stairTopA, landingA, landingB, stairTopB, b]`. World builds the stairs and deck from these numbers and people walk `route`. `WorldAPI.footbridgePath` (optional) exposes the same polyline.
- **Forecourt nav node** sits 4.5 m off the station axis, so the entrance → steps walk skirts the central flower-bed island.
- **New optional/extra API members:** `AtmosphereAPI.debugStrike?(dist?, hold?)`, `WorldAPI.flickerLamps?(amount)` (ghost train guttering), `TrainsAPI.releaseHold(line)` (clears a hold at once; `holdAtSignal` still only extends), `EventsAPI.focusOf(id)` (world position of an active event, used by the UI "View" button).
- **PersonRole** gains `clerk`, `newsboy`, `farmer` and `ringmaster`.
- **`select` bus event:** `kind` may be `'station'`, with `id` taken from `userData.pick.id` of a `stationPickables` hit (`building`, `platforms`, `canopies`, `footbridge`, `shed` or `signalbox`). The UI shows a station card with live facts.
- **Shed flow (trains):**
  1. After its duty, a shed-bound train leaves the map and comes back as a light engine (loco plus tender). It enters from the coast east end, so its `TrainInfo.line` becomes `'coast'` and `cars` and `length` shrink. It diverges at the switch and stops at `bayT`, and then `train:inShed` is emitted.
  2. A rescued train returns with a pilot tank engine at the rear. The pilot is removed about 1.5 sim min after `train:inShed`.
  3. `requestShed` on a train that is not yet on the map converts it at once and cancels its service.
  4. If more than 2 engines wait to enter the shed, the oldest is sent "to the works" and despawned.
- **Condition / repairs:** each named loco owns one `Condition` object, which is shared by every `TrainInfo` that uses that loco over time. Maintenance writes it. **Maintenance** emits `train:repaired`; trains never does.
- **Timetable headway:** because each line is single track, services run about every 58–72 sim min per line by day, not every 20–35.
- **Failed signals:** trains never overwrite `'failed'`. Whoever sets it (the signal-strike event) must restore `'stop'`, including in its cleanup.
- **Key ownership:** camera uses WASD, arrows, Q, E, R, P, F and Esc. UI uses ?, H, U, Space, 1, 2, 3, M and Esc. Other systems must not bind keys.

## Polish amendments (QA & polish)

- **Default camera azimuth** is 60° (camera sits ESE of the station, `?az=<deg>` overrides for testing). From the old 45° the whole of Platform 2 sat behind the station building. Q/E still rotate in 90° steps from the base azimuth.
- **Highland stop point:** `LineLayout.stopTFor` draws Highland trains up toward the **east** end of Platform 2 (train centre at `platformEnd − (L/2 + 5 m)` when that is east of the platform centre). Coast trains stay centred.
- **Smoke** ages in `max(dt, clock.dtMotion)`, so it follows motion time at 10×/60× and during `advance()`. Old puffs fade out through per-instance alpha.
- **Renderer:** the canvas has no MSAA. The composer target is multisampled instead (4× by default, 0 on software GL such as headless SwiftShader; `?aa=0..8` overrides). The bloom pass is skipped while `bloom.strength ≤ 0.01`, and atmosphere now uses 0 by day.
- **`stats()`:** `fps` is frames per second over a 1 s window (the old EMA of 1/dt overstated it about 3× on uneven frames). The new `updateMs` and `renderMs` fields are CPU milliseconds per frame.
- **People warm start:** on the first update, people seeds up to 48 ticketed travellers already waiting on the platforms.

---

## v2 contracts (Integrator, living-world phase)

These supersede everything above where they conflict. The plan, geography, per-builder scope and budgets are in **`docs/V2_DESIGN.md`**.

### Hard rules

- **NO POP-IN.** A person, animal, vehicle or boat may spawn or despawn ONLY at a legitimate origin:
  - a road, path or river portal on the skirt at about ±450;
  - a rail tunnel;
  - a building door (fade through the doorway);
  - a stopped vehicle;
  - a moored boat;
  - a train door while dwelling.

  **Every** spawn and despawn calls `ctx.origins.audit(system, 'spawn'|'despawn', 'people'|'vehicles'|'boats'|'animals', pos, label)`. Register moving origins with `ctx.origins.add(...)`.
  - `__station.stats().popIns` counts VISIBLE violations and must be 0.
  - `?debug=popins` logs each violation.
  - Warm-start placement before the first rendered frame is exempt.
- **NO STATIONARY LIFE.** Everything alive always has subtle idle animation. Vehicles never park forever. Static props are never living things (the v1 static cabs in `world/garden.ts` must go).
- **Time:** `MOTION_SECONDS_PER_SIM_MINUTE` stays 1 (1 sim min = 1 s of motion at 1×). Plan deadlines from motion time; 100 m of walking takes about 74 sim min. `clock.dtMotion` ≤ 0.5 s inside `update`.
- **Lights:** never create `THREE.PointLight` yourself. Call `ctx.lights.claim(key, pos, color, intensity, distance, priority)` every frame, and pair it with an emissive mesh.
- **Shaders:** never assign `onBeforeCompile` on a material someone else may patch. Use `chain(mat, key, injector)` from `core/shaderMods.ts`. Never `.clone()` a shared core material; use `ctx.mats.derive(base, tag)` or `cloneWithChain`.
- **Quality:** read `ctx.quality.knobs` in `create()`. Caps and budgets are in V2_DESIGN §6. Shader-affecting choices are fixed for the session.
- **Name your root Group after your system** (for example `'nature'`) so `__station.perf()` attributes draw calls to you.

### New shared services on `ctx` (created by main before any system)

| field | file | summary |
|---|---|---|
| `ctx.quality` | `core/quality.ts` | `{tier: 'low'\|'med'\|'high', knobs, reason, softwareGL, renderer}`. Detection: `?q=`, then localStorage `vj.quality`, then software GL = low, then ≤ 4 cores, mobile or ≤ 4 GB = med, else high. `setQualityAndReload(t)`. |
| `ctx.view` | `core/view.ts` | `focus, zoom, ortho, footprint[4], bounds, pxPerMetre, frustum, camera, isVisible(p, margin), distToFocus(x, z)`. Main updates it each rendered frame from the rendered camera. |
| `ctx.wind` | `core/wind.ts` | `uniforms {uWindTime, uWindDir, uWindStr, uGustPhase, uGustAmt}`, `speed`, `sample(x, z)`, `set(ms, gust)`. Main runs `follow(atmosphere)` + `tick(realDt)`. `applyWind(ctx, mat, {mode, weight: 'localY'\|'attr'\|'uvX', height, amp, pivot, freq})` returns a depth material or null. |
| `ctx.tex` | `core/tex.ts` | `detailA`/`detailB` DataTextures, `withDetail(ctx.tex, mat, {pattern: 'slate'\|'brick'\|'setts'\|'planks'\|'thatch'\|'furrows'\|'ripple'\|'grime', scale?, strength?})`, `get(key, draw)`. Off on the low tier. |
| `ctx.lights` | `core/lights.ts` | `claim(...)`, `size`, `lastClaims`. Main resolves after systems update. |
| `ctx.origins` | `core/origins.ts` | `add, remove, get, list, nearest, bestFor, legit, audit, popIns, offscreen, log, pools {count, enter, take}`. Pre-filled from `layout.origins` plus the rail tunnels. |

**Other core modules:**

- `core/shaderMods.ts`: `chain`, `hasChain`, `cloneWithChain`, `inject`, `addUpVarying`, `withSnowCap`, `withDitherFade`.
- `core/movers.ts`: `Mover`, `Flow`, `StopLine` for road agents.
- `core/rig.ts`: `InstancedRig`, `buildRigGeometry`, `RIG_GLSL_HELPERS`.
- `core/rigs/horse.ts`: `horseGeometry`, `HORSE_POSE_GLSL`, `HORSE_PART`, `HORSE_STRIDE`.
- `core/poly.ts`: `Poly`, `localToWorld`, `worldToLocal`, `pointInPoly`, `noise2`.

**Materials:**

- `ctx.mats.uniforms.{uSnow, uWet, uNight}` (kept in sync by the setters) and `ctx.mats.derive(base, tag)`, which gives weather-tracked private copies (for occluder fades).
- The shared core materials already carry **detail textures** on slate, brick, brickDark, wood, platform and gravel (med/high tiers only), and **snow caps** on stone, cream, wood, brick, brickDark, iron, bottleGreen and oxblood.

### Layout v2 (`ctx.layout`, see `core/countryside.ts` for the types; `node scripts/check-layout.mjs` prints everything)

- **Terrain.**
  - `layout.heightAt(x, z)` is **the** ground height; world builds the ground from it.
  - `layout.terrain.{half 420, skirtY 2, playHalf 400, portalR 450, heightAt, trackDist, roadDist, riverDist, isWater, featureDist, clear(x, z, margin), buildingAt}`.
- **River.** `layout.river` has `poly` (water y), `widthAt`, `waterYAt` (−3.0, then −3.5 below the weir), `towpath {lateral, yAt, poly}`, `pointAt`, `nearest`, `weir`, `lock`, `mill`, `boathouse`, `jetty`, `moorings`, `fishing` (F1–F8), `ford`, `reeds`, `heron`, `portals`, `reaches`. `+lateral` is the right, west bank, where the towpath runs.
- **Bridges.** `layout.bridges` holds glenmoor (girder, Highland), kingsmead (arches, coast), ashbourne (road humpback, K) and wykeArch (Highland over Wyke Lane in a cutting).
- **Roads.**
  - `layout.roads.{nodes, edges}`. Edges K, W, M, S, F, N, D, MW (mews drive) and FC (forecourt one-way loop). `edge.poly` carries the **road-surface y**.
  - `lanes: 2` means keep left (lateral −width/4); footway at `footSide·(width/2 + 0.6)`.
  - `layout.roadPath(from, to)` returns a `RoadRoute` with `sample`/`locate`. `layout.nearestRoad(p)`.
  - `layout.forecourtTraffic` has `{loop, dropOff, rank[4], omnibus, trough, cabQueue, omnibusQueue}`. `layout.mews` has `{door, yard, yaw, road}`.
- **Level crossing.** `layout.crossings[0]` is LC1 "Millbridge Gates": coast at x 220 on Millbridge Lane, with `gates[4]`, `roadStop`, `trainStopT`, `warnT`, `gateSignal` and `lodge`.
  - Trains call `traffic.requestCrossing('lc1', id)` every update until it returns true, then `releaseCrossing`.
  - Westbound trains request inside the east tunnel; eastbound trains request before departing P1.
- **Towns.** `layout.towns` covers station, ashcombe, millbridge, wyke, coldharbour, glenmoor, eastcote, river and lc1, with `buildings` and `areas` (square, green, yard, churchyard, rickyard, pond, garden, playground).
  - `layout.buildings` is the flat list. Each building has `center, size (x frontage, y eaves, z depth), yaw (+z = front), roofH, roof, walls, doors[], doorsIn[], chimneys[], residents, lit, tower?`.
- **Fields.** `layout.fields` holds FA–FL, each with `poly, kind, rowYaw, gate, livestock?`.
- **Paths.**
  - `layout.paths` holds the towpath, anglersSteps, meadowWalk, kingsmeadPath, headlandPath, churchPath and millPath.
  - `layout.walk` / `layout.footPath(from, to, {staff?})` is the unified walking graph (station nav + footways + paths + doors + portals).
  - The v1 `layout.path` is unchanged. There is a new staff nav node **`sbDoor`** (signal box door).
- **Portals and origins.** `layout.portals` holds roads E1, E2, S1, W1, N1 and NW1, rivers `river:up`/`river:down`, towpath `path:towUp`/`path:towDown`, and rails `rail:*`. `layout.origins` holds every door and non-rail portal. `layout.nearestOrigin(pos, kinds, for)`.
- **Tunnels and the shed road.** `layout.tunnels` is west, coastEast, highlandNE and the **new shedWest**. `layout.shedRoad {curve, length, portalX −268, z 47.9, tAtX}` is the new shed through-road used by light engines (issue 2).
- **Other additions.** `layout.streetLamps` (15 outside the station), `layout.landmarks {windmill, platelayersHut, signalBoxDoor}`, `layout.signalBox {center, size}`.
- **Issue 3.** `LineLayout.stopTFor('west', L)` on the Highland line keeps the loco head ≥ 48 m from P2's west end (clear of the clock tower from the default az-60 camera). Highland stopping consists are ≤ 68 m; only the van may overhang P2's east end.
- **Terrain details.** `heightAt` keeps the track bed level (≤ 0) within 4 m of any track out to 5 m inside each tunnel portal. Pond areas are padded flat with a 0.3 m elliptical bowl; a pond area's `center.y` is the rim height (water ≈ rim − 0.06).

### API v2 (all in `core/apis.ts`, each with doc comments)

- **New registry slots:** `ctx.reg.nature: NatureAPI`, `ctx.reg.traffic: TrafficAPI`. Stubs are in `src/nature/index.ts` and `src/traffic/index.ts`.
- **AtmosphereAPI** adds `skyColor, sunColor, keyLightDir, dawnMist, iceAmount, gloom, snowCover, wetness`.
- **WorldAPI** adds:
  - `lamps(), lampLit(i), lightLamp(i, on), manualLamps`;
  - `occluders(), setOccluderFade(id, a)`;
  - `setChimney(buildingId, on|null), setWashing(buildingId, amount), openDoor(originId), mills(), setLockGate(i, open), setLockLevel(level01)`.
- **TrainsAPI** adds `predictedDoors(id), eta(line, t, horizonS?), occupied(line, t0, t1), nextGap(line, minutes), expectedDeparture(id)`. `Departure` adds `dir?, expected?, trainLength?, stopHeadT?`. `SpecialTrainSpec` adds `arriveBy?`.
- **PeopleAPI** adds `spawnInside(originId, specs), summonActor(role, target, opts), summonCrowd(n, near, role, opts), dismissActor(id, opts), ride(ids, anchor, seats?), embark(ids, anchor), disembark(anchorId, opts), setIdle(id, style), lookAt(id, target), boardingEta(trainId), stats()`.
  - The v1 members stay, but become origin-aware (`spawnActor` at a non-legit point summons; `removeActor` dismisses).
  - `PersonSpec`, `Anchor`, `IdleStyle`, and many new `PersonRole`s and `PersonAnim`s. `PersonInfo` adds `riding?, home?, idle?`.
- **TrafficAPI** (`VehicleKind`, `VehicleInfo`, `TripRequest`, `CrossingState`): `list, get, request, cancel, anchorOf, rank() {waiting, hail}, omnibusAt, crossingState, requestCrossing, releaseCrossing, scare, raycast, stats`.
- **NatureAPI** (`CritterKind`, `CritterInfo`, `BoatKind`, `BoatInfo`): `river {surfaceY, flowAt, ice}, list, get, boats, boat, anchorOf, requestBoat, herd, scare, raycast, stats`.
- **CameraAPI** adds `followAny(kind, id)`. `SelectKind` adds vehicle, boat, animal and building (bus `'select'`).
- **Bus** adds `vehicle:spawned|arrived|departed|despawned`, `crossing:state`, `boat:moored|departed`, `animal:herded`, `animal:scared`, `person:door`, `lamp:lit`, `town:bell`, `town:day`.
- **AudioCue** adds hooves, wheels, horse, motor, gate, crossingBell, townBell, churchPeal, forge, water, oars, splash, boatWhistle, lock, mill, duck, goose, hens, swan, sheep, dog, crow, birdsong, crowd, fire, pistol, hammer and shout. They are stub-mapped in `audio/synth.ts`.

### Integration facts (v2, after the builders)

- **World:** occluder ids `station`, `canopyP1`, `canopyP2`, `footbridge`, `shed` (roof only). `openDoor('door:<buildingId>:<k>')` swings town-building doors; it is a no-op for station, church and signal-box doors. Lamp indices 0–20 are `layout.lampPositions`, 21–35 are `layout.streetLamps`; `manualLamps` is true (people's lamplighters and porters light them; lamplighter rounds are ≤ 4 lamps each; world's backstop lights any lamp still dark 30 min after gloom passes 0.85 (50 min above 0.5), and douses any still lit after 20 min below gloom 0.36 — the lighting threshold is 0.38). World draws a permanently animated signalman inside the signal box. `Kit.fold` merges flat-colour materials inside world only.
- **Nature origins:** `nature:boathouse` (boats + people), `nature:lockStable` (animals, lock-keeper's door), `boat:<boatId>` (people; open while moored or in the boathouse), `nature:dog:<buildingId>` (animals).
- **Trains origins:** `train:<id>:d<k>` door origins serve people and animals and stay open through the ~1.5-min right-away and the first ~4 m of motion (so the guard steps in last); specials add `train:<id>:c<k>` at cage/van cars. Maintenance summons fitters from `door:shed`. `trains.holdDoors(id, until)` keeps a dwelling train's doors open (capped +30 min past booked departure). `trains.shedEta(id)` gives the send-to-shed ETA.
- **Traffic:** stopped vehicles register `veh:<id>` origins. Passenger anchors are `<vehicleId>`, crew anchors `<vehicleId>:crew`. `VehicleInfo.state === 'depot'` means queued / not yet on the road; `VehicleInfo.dest` is the current stop or sink id (town, portal node or door origin). The baker's handcart seat pose is `'push'`.
- **Camera:** `CameraAPI` optional members `zoom`, `zoomTo`, `lookAt`, `followed`, `occluderState`. URL `?cx=&cz=[&zoom=]` frames an iso close-up (screenshots).
- **Atmosphere:** optional `setIce(v)` forces the river ice level.

API members an owner has not implemented yet are **`V2 STUB — owner replaces`** in that owner's files. Replace them, keeping the signatures.

### main.ts (Integrator)

- **Render path by tier.** Low renders **directly** (`renderer.render`, no composer, no bloom). Med and high use the composer with MSAA 2 or 4.
- Pixel ratio cap and shadow type come from the knobs. A runtime-safe auto-downgrade lowers pixel ratio only, on med/high, when fps < 24 after 8 s.
- **Per rendered frame:** `view.update`, then `wind.follow` + `tick`, then systems (sub-stepped), then `lights.resolve(view.focus)`, then render. `origins.armed` is set after the first frame.
- **`__station.stats()`** adds `tier, tierReason, pixelRatio, popIns, popInsOffscreen, popInLog, vehicles, horses, boats, animals, birds, lightClaims` and `service {arrivals, meanLateMin, maxLateMin, boarded, gaveUp, giveUpRate}`.
- **`__station.perf()`** gives draw calls, triangles and casters per top-level scene group, plus programs and textures.
- **URL params:** `q=low|med|high`, and `debug=popins` (can combine with `layout,top`).

### Screenshot ports (v2)

| builder | port |
|---|---|
| world | 5231 |
| nature | 5232 |
| traffic | 5233 |
| people | 5234 |
| trains | 5235 |
| events + atmosphere | 5236 |
| camera + ui + audio | 5237 |
| Integrator | 5224–5230 |

Put your shots in `shots/v2-<you>/`.

### Fixer round 1 (v2 review findings)

- **Passenger origins.** `Passengers.spawnGroup` mix: ~46% omnibus, 18% cab, 5% station-side doors, 20% Ashcombe, rest hamlets/carts/gigs. Buildings emit travellers only while `origins.pools.count(b) > 0` and under an hourly cap (≈0.4 × residents, max 4/h). A vehicle booking that fails because traffic is full is retried every ~2.5 min for 24 min (the traveller stays at home, unseen), then walks from Ashcombe/a hamlet — never from the station-side houses. `trains.timetable(40)` is read so vehicle trips (80–170 min lead) find a departure.
- **Traffic.** Background/farm traffic may not take the last `paxReserve()` vehicle/horse slots (≈25 % of the cap, 06–22 h). `canServe` lets up to 3 passenger trips queue beyond the free slots. Omnibus requests with every bus out join `pendingOmni` (a special run collects them; bookings lapse after 60 min unseen). Omnibus stand ≤ 35 min, rank dwell 18–32 min.
- **Boarding.** Every stopping service keeps doors open ≥ 3 sim min (late or not); `dwellHard` = +4 (on time) / +3 (late) for committed boarders; shed-bound trains stop 1–2 min. Passengers who cannot reach a door before `expectedDeparture` + 3 min let the train go (`data.skipTrain`) and rebook instead of sprinting.
- **`origins.nearest`** skips role-restricted origins unless the caller names a matching role. `people.enter()` re-checks moving origins (train/vehicle/boat) when the fade leg starts and ends; a closed one re-routes to `sinkFor(p)`.
- **People API.** `setIdle`/`lookAt` refresh the forgotten-actor backstop (owners that keep talking to an actor keep it on duty). `remove()`/`dismiss()` settle a pending summon promise with `false`; `summonCrowd` recruits settle `false` if removed. `sinkFor` skips a home that is a > 3× (and > 200 m) walking detour.
- **Shed.** `shedEta` includes the bay job (hurried), the bay engine's run out and every engine queued ahead. Maintenance squeezes the remaining job to 3 min when a user-sent engine waits (6 otherwise) and waits ≤ 8 min for fitters.
- **Phantom Mail.** May follow a same-direction train that has finished its stop (≥ 220 m ahead, speed-capped 160 m behind it); glide lead 45 m at 9 m/s. Platform passage 12–24 min after the trigger (was 35–45).
- **Low tier.** People cast no shadows and use lower-poly heads/hats/limbs; horses cast no shadows; rails use a box section; people are drawn only near the focus when zoomed far out; sleepers and hedges hide below zoom 0.55. Crops (no row geometry) get painted drill rows and travelling gust bands in the fragment shader.
- **Screenshot harness.** `--gpu` uses the real GPU (ANGLE/EGL); `--dpr 2` sets deviceScaleFactor.

### Fixer round 2

- **Shed-bound trains.** `requestShed(id, {urgent})` returns a boolean (false: already leaving the shed, broken, ghost). *Urgent* (user "Send to shed") = `TrainInfo.inService = false`: no boarding, board shows **Not in service**, people treat it as cancelled and rebook; abbreviated stop, may divert at the switch. Non-urgent (maintenance retiring a tired engine) finishes its booked call with normal boarding and goes to the shed after its duty (never diverts with travellers aboard). Maintenance refuses `fromShed` engines with a gazette line; `shedEta` is null for engines leaving the shed. A user-sent engine makes the shed gang hurry from the moment of the click.
- **Goods trains** never open doors and are not listed in `timetable()`; people only board `isPassengerService(t)` trains (no freight, capacity 0, ghosts, not-in-service). `Departure.seats` caps trip planning for small consists (the Night Mail).
- **Sinks.** `PeopleSystem.canAbsorb(building)`: a building takes people back only up to residents + 1 (never a residents-0 office); travellers' fallback sinks exclude the station-side houses. Alighters on foot: ~5 % station-side, then Ashcombe, hamlets and portals.
- **Lamps.** Rounds are 2–3 lamps from distinct nearest doors, start at dusk (gloom > 0.3 or after 19:18) and at first light, end as soon as their lamps are done; two station lamp men light the platform lamps when every porter is busy. World backstop: per-lamp 0–20 min stagger, +25 min for lamps in view near the focus; hand-lit lamps are not doused as "daylight" in the evening.
- **LC1 keeper** goes back into the lodge when the next train is > 20 min off, changes shift at 06:00/18:00, and smokes / watches / waits between trains.
- **People culling** dithers out over zoom and distance bands (no hard cuts); riders are always drawn.
- **Occlusion.** Trains at P2 (engine + first two cars) fade `canopyP2` to 0.42.
- **Programs.** main pre-compiles the scene after the first frame against the real render target (composer buffer on med/high).
- **Traffic.** A vehicle waiting to pull out gets priority after 1.5 min (creeping queue yields), after 4 min over anything that can still brake.

### Final polish (v2)

- **Cab rank.** A cab never stands on the rank for hours: unhired after ~50 min (or booked by a fare that has not boarded after ~75 min) it releases the hire and drives back to the Crown Mews (`Vehicle.rankGaveUp`).
- **Narrowboat.** `bargeArrive` resets `bargeWait` to 0, so *Perseverance* no longer casts off at midnight right after mooring (the negative "leave soon" wait is only for the warm start).
- **Ashbourne Bridge** is `width + 2.4` wide between the parapets, so the Kingsport Road footway (`width/2 + 0.6` off the crown) runs inside the parapet instead of along it.
- **River ice** under snow keeps a blue-grey skating channel mid-river (snow drifts only along the banks), so the frozen river still reads against the snowy meadows.
- **Rick Fire.** The bucket chain is manned from the rick end outward, recruits that settle into the crowd are re-sent to their posts every 4 sim min, the chain starts at 60 % of the hands actually present, and the Brigade takes charge of crew that traffic already set down at the barn.
- **Cab rank, fare aboard.** A hired cab whose fare is aboard pulls out from any rank slot (it no longer waits behind unhired cabs at the head).
- **People backstop.** A person in a leaving state (`going home`, `heading home`, `leaving`, `wandering off`) with `data.entering` set who has not moved for 30 sim min is dismissed again; after two retries through the nearest door.
- **README** documents the v2 features, controls, all 25 events, quality tiers, debug params, per-tier performance and the architecture.
