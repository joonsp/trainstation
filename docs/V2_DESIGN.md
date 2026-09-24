# Victoria Junction v2: "a living thingy"

This is the reference for the seven v2 builders. It reconciles three analyses (sim issues, living-world design and tech/performance architecture) into one plan. The **contracts are in code** under `src/core/**`; this document explains them and says who builds what.

Before you start, read `CONTRACTS.md` (the v2 section first), then `src/core/apis.ts`, `src/core/countryside.ts` (types at the top) and `src/core/layout.ts`. To see every coordinate, run `node scripts/check-layout.mjs`. To see the whole map, run `node scripts/shot.mjs --port <yours> "debug=layout,top&zoom=470&noui=1"`.

---

## 0. What the user asked for (verbatim ideas) and the two hard rules

> no people should appear out of nowhere but should have an origin point from outside the map via a carriage, or vintage car. no stationary people or animals/carriages. maybe add texture to roofs etc where possible. countryside could use some wind based animation? maybe a river running through it, add a bridge, boats, fishermen, etc.? roads leading in to the towns and maybe some minor activity there too? make this a living thingy! get creative!

**Rule 1: no pop-in.** No person, animal, vehicle or boat may appear or vanish anywhere in the visible playfield. Things may only spawn or despawn at a legitimate origin:

- a map-edge **portal**: road, path and river portals sit on the skirt at `max(|x|,|z|) ≈ 450`, and the rail tunnels count too;
- a building **door**: fade through the doorway, about 0.4–0.6 s while stepping about 0.8 m inside;
- a **stopped vehicle**;
- a **moored boat**;
- a **train door** while the train dwells.

Every spawn and despawn calls `ctx.origins.audit(...)`. Visible violations are counted in `__station.stats().popIns`, which **must stay 0**. Placement before the first rendered frame (warm start) is exempt. Use `?debug=popins` to log each violation to the console.

**Rule 2: no stationary life.** Every living thing is always subtly animated: breathing, weight shifts, head turns, gestures, fidgeting children, horses that stamp, swish their tails and nod, grazing sheep and a stalking heron. A person may "hold" (queue, wait) for at most about 12 s before a gesture clip plays.

- No vehicle is parked forever. Each one has a dwell limit and then leaves.
- Static props must never be living things. **Remove the two static hansom cabs and horses from `world/garden.ts`**; traffic fills the cab rank instead. The horse trough stays.

**Time scale.** This is unchanged and deliberate: `MOTION_SECONDS_PER_SIM_MINUTE = 1`. At 1× speed, one sim minute equals one second of real motion. At a walking pace of 1.35 m/s, 100 m costs about 74 sim minutes, so:

- Plan anything with a deadline from measured motion time, not from sim-minute labels.
- Nearby origins (Station Terrace, the Railway Arms, the omnibus and cabs) feed the trains.
- Far origins such as Millbridge and Wyke start 2–5 sim hours ahead.
- Background life (fields, the river, towns) runs on its own loops and never has to meet a deadline.
- Inside `update`, `clock.dtMotion` is always ≤ 0.5 s, because of sub-stepping.

---

## 1. The map (all in `ctx.layout`, built by `src/core/countryside.ts`)

Axes: x is east, z is south (north is −z), y is up, units are metres. **Lateral convention everywhere** (roads, river, paths, rail): `+lateral` means the right of travel in the `+s` direction. The side vector is `tangent × up = (−tz, 0, tx)`. Yaw convention: `rotation.y = yaw` maps local +x to `(cos yaw, 0, −sin yaw)`. The people system uses its own `atan2(dx, dz)` facing convention; fishing-peg `yaw` values use the people convention.

### 1.1 Ground and terrain

- The ground mesh spans ±420 (`terrain.half`). Beyond it, a flat skirt sits at y = 2. The camera keeps its footprint inside ±400 (`terrain.playHalf`), and portals sit at about 450 (`terrain.portalR`).
- **`layout.heightAt(x, z)` is the single source of ground height.** The world builder must build the ground mesh from it, and anything placed on the ground uses it. It is a bilinear 2 m grid that includes:
  - v1 terrain: flat within 14 m of tracks, the main road, the station area and the shed yard;
  - the tunnel hills, including the new shed tunnel;
  - the edge ramp;
  - cross-flattened roads with baked ramps and cuttings;
  - building and area pads;
  - the windmill mound;
  - the river valley.
- Other queries on `layout.terrain`:
  - distance fields `trackDist`, `roadDist` (to the road **edge**) and `riverDist` (to the **water edge**);
  - `isWater(x, z)`;
  - `featureDist` (v1 flatness);
  - `clear(x, z, margin)`: true if the point is clear of tracks, roads, river, buildings and station;
  - `buildingAt(x, z)`.
- `layout.trees` (150 hand-placed trees) already avoid roads, river, buildings and fields.
- World's own random fillers (copses, hedges, random fields and hamlets) **must** use `terrain.clear` and must not overlap `layout.fields` or `layout.towns[].areas`.

### 1.2 The River Ashbourne (`layout.river`)

- **Course.** The river flows north to south, about 1011 m long. `s` runs downstream from the upstream portal at (118, −449) to the downstream portal at (25, 449). Along the way:
  - it runs under the Highland line at (154, −147);
  - it runs under Kingsport Road at (143, −46), visible at the right edge of the default view;
  - it passes the Ashcombe Rowing Club boathouse at (157, −17), on the east bank;
  - it runs under the coast line at (158, 24);
  - it then bends south-west past Millbridge Mill and the weir at (116, 125);
  - Coldharbour Track fords it at (88, 179).
- **Levels.**
  - Water is at y = −3.0 above the weir and −3.5 below it (`waterYAt(s)`). The weir is at s ≈ 641.
  - The bed is about 0.8 m below the water surface.
  - Width is 11 m by default, 14 m in the regatta reach (girder bridge to boathouse) and 16 m in the mill pool (`widthAt(s)`).
- **Towpath.** It follows the right (west) bank, with its centre at lateral `towpath.lateral(s)` (width/2 + 2.1 m).
  - It is 3 m wide at y −2.2 (−2.7 below the weir). It dips to −2.8 under the bridges, so a horse has headroom.
  - `towpath.poly` gives it ready-made with y baked in, and it runs portal to portal under all three bridges.
- **Banks.** The terrain grid carves the valley: an edge, the towpath terrace, then a 1:1.6 bank rising to the ground. Near tracks and roads the banks become near-vertical, and **world adds brick wing walls there**. For clean banks, world builds a dedicated bank ribbon at 2 m spacing from `river.poly`, `widthAt` and `towpath.*`. The grid is only 2 m.
- **Structures.** All positions are in `layout.river`:
  - `weir`: position, yaw and a 0.5 m drop.
  - `lock`: a chamber inside the channel on the towpath side of the weir, from s = weir−14 to weir+14, lateral `lock.lateral`, 5 m wide, with 4 gate points and levels −3.0 and −3.5.
  - `mill`: a brick mill on the east bank. Its wheel centre is at y −2.0 with radius 2.6 (undershot), and the door faces the village.
  - `boathouse`: centre, door on the land side, and a slip point in the water at `slipS`.
  - `jetty` at y −2.3.
  - 4 `moorings`.
  - 8 `fishing` pegs, F1–F8. F5 is the best spot (mill pool) and F3/F4 are on the east bank. **World flattens a 2×2 m pad at each peg's y.**
  - `ford`: the Coldharbour Track dips to a gravel bed 0.28 m under the water, with 11 stepping stones 4.5 m upstream.
  - 6 reed beds, 2 heron spots, and 3 named reaches: regatta, millpool and skating.
- **Buildings.** The mill, the lock-keeper's cottage and the boathouse are in `layout.towns` under id `'river'`.

### 1.3 Bridges (`layout.bridges`)

| id | what | where | notes |
|---|---|---|---|
| `glenmoor` | Warren-truss wrought-iron **girder** bridge carrying the Highland line over the river | (154.2, −147.0), highland t 0.7208, 22 m span, 87° | soffit −0.5; towpath passes under the west end |
| `kingsmead` | three segmental **brick arches** carrying the coast line | (158, 24), coast t 0.7633, 19 m | soffit −0.6; towpath through the west arch |
| `ashbourne` | stone **humpback** carrying Kingsport Road over the river | (143.0, −46.1), road K s = 83.5 | 2-lane 11 m deck, crown +1.4 (road y already baked, ±20 m ramps); soffit −0.4 |
| `wykeArch` | skew-free brick **underbridge**: the Highland line crosses OVER Wyke Lane | (83.9, −88.0), highland t 0.5914, road W s = 66 | Wyke Lane dips to −4.3 in a cutting (±46 m); world builds the cutting walls and the arch |

Rails stay at y 0.35 everywhere; only the ground is carved. The trains simulation is unaffected.

### 1.4 Roads (`layout.roads`), the forecourt loop and the mews

- **Data.** `roads.edges[id].poly` is a 2 m-resampled centreline with the **road-surface y** baked in (humpback, cutting, ford, level-crossing planking).
- **Lanes.** Traffic keeps **left** on two-lane edges (`lanes: 2`, lateral −width/4 in the travel direction). `lanes: 1` edges (the forecourt loop and the mews drive) use lateral 0.
- **Footway.** `footSide·(width/2 + 0.6)` gives a verge footway (walkers).
- **Routing.** `layout.roadPath(from, to)` runs A* over the road graph and returns a `RoadRoute` with `sample(d, lateral)` and `locate(d)`.

| id | name | kind | from → to | notes |
|---|---|---|---|---|
| K | Kingsport Road | main 10 m | `entrance` (64.6, −17.5) → E1 portal (449, −118) | v1 straight extended; humpback at s 83.5; Ashcombe High Street s ≈ 110–225 |
| W | Wyke Lane | lane 6 | `jW` (K s 33) → NW1 (−449, −180) | underbridge at s 66; Wyke St Mary around x −170…−225 |
| M | Millbridge Lane | lane 6 | `jM` (K s 186) → `jMB` (136, 168) | leaves K square; level crossing LC1 at (220, 24); Millbridge at the end |
| S | Hollowford Road | lane 6 | `jMB` → S1 (118, 449) | |
| F | Coldharbour Track | track 5 | `jMB` → W1 (−449, 205) | ford at (88, 179); Coldharbour Farm at (−170, 176) |
| N | Glenmoor Drove | track 5 | `jN` on W (10, −156) → N1 (4, −449) | drovers' flocks; Glenmoor hamlet (15, −250) |
| D | Eastcote Lane | lane 5 | `jD` on M (216, 50) → E2 (449, 77) | Eastcote (330, 92) |
| MW | Crown Mews drive | drive 4 | `jMW` (K s 190) → `mews` yard (234, −107) | **vehicle depot**: stable doors = vehicle origin/sink |
| FC | Station forecourt loop | loop, one way | K inbound lane → round the island clockwise → K outbound | stops below |

**Forecourt stops** (`layout.forecourtTraffic`, each a loop `s` plus `pos` and `yaw`):

- `dropOff` at the station steps (40.4, −8.7);
- 4 cab-rank bays on the north side, `rank[0..3]`;
- the `omnibus` stand on the south side (52.0, −2.3);
- `trough` (50.6, −26.7), where cab horses drink;
- pedestrian `cabQueue` and `omnibusQueue` spots.

**Mews.** `layout.mews = { door, yard, yaw, road: 'MW' }`.

### 1.5 The level crossing: LC1 "Millbridge Gates" (`layout.crossings[0]`)

- **Position.** Millbridge Lane crosses the coast line square to it at x = 220 (coast t 0.8667, road M s 114.9).
  - This is 52 m west of the coast east tunnel mouth (x 272). The west home signal at x 101 is far enough away that a 97 m train held there (tail ≤ 198) never blocks the road.
- **Gates.** 4 leaves are hinged at the road edges (`gates[i].hinge`). Each leaf is `HR = 3.6` m long and swings between `closedRoadDir` (across the road) and `closedRailDir` (across the track).
- **Stops.**
  - Road vehicles stop at `roadStop` (±8 m).
  - Trains may not pass `trainStopT` (east 0.8133 = x 188, west 0.9200 = x 252) unless the crossing is clear.
  - Gate-signal posts are at `gateSignal`.
- **Lodge.** `lodge` is a building with its door facing the road (keeper's door origin), at (209.5, 34). It has a hen run.
- **Protocol (trains ↔ traffic).**
  - Trains call `ctx.reg.traffic.requestCrossing('lc1', trainId)` every update while they want to pass. It returns true once the gates are shut to the road and the crossing is clear.
  - Traffic must honour a request within about 20 motion-s and never block a train indefinitely.
  - Westbound coast trains request **while still inside the east tunnel**, before entering the map, so any wait is invisible. Eastbound trains request **before departing P1**. Call `releaseCrossing` once past.
  - Traffic can also use `trains.eta()` and `trains.occupied()`.
  - At night (22:00–06:00) the gates stay shut to the road and the keeper opens them by lantern for each cart.
  - The current traffic STUB always returns true.

### 1.6 Towns and buildings (`layout.towns`, `layout.buildings`)

**Building fields:**

- `center` (y = pad height) and `size` (x = frontage, y = eaves height, z = depth);
- `yaw`: local **+z = front**, facing its road; doors are on the +z face;
- `roofH`, `roof` (slate, tile or thatch), `walls` (brick, brickDark, stone, whitewash or timber);
- `doors[]` (outside, walkable) and `doorsIn[]` (1 m inside, the fade target);
- `chimneys[]` (smoke origins at the pot tops), `residents`, `lit`, and an optional `tower` for churches.

**Towns:**

- **Station quarter (`station`).** Station Terrace has 4 cottages and 4 doors; railway staff live here. The Railway Arms pub is on the north side of K, facing the default camera, between Wyke Lane and the humpback; the brass band starts in its function room. There is also a coal merchant's office and yard, and the platelayers' hut at (188, 31.5), south of the coast line.
- **Ashcombe (`ashcombe`).** A market town east of the river on K, about 150–250 m from the station.
  - Buildings: the smithy, cottages, the Post Office, Hobbs' Bakery, Pratt the Chemist, **The Crown** coaching inn with the **Crown Mews** stable block behind it, the Police House, the Engine House (fire engine), Forge Row, the Board School, Ashcombe House, and **St Mary's Church** (20 m tower) behind the market square.
  - Areas: `square`, `churchyard`, `schoolyard`, `mewsYard`.
  - 8 street lamps.
- **Millbridge (`millbridge`).** A riverside village on the east bank at the M/S/F junction: The Miller's Arms (thatched), Millbridge Dairy (the cow byre), Bethel Chapel, thatched cottages, and a village green.
- **Wyke St Mary (`wyke`).** On Wyke Lane in the north-west: St Peter's with a spire, The Plough, the wheelwright and smithy, cottages, Wyke Farm and its barn.
  - **Wyke post mill:** `layout.landmarks.windmill`, on a 3 m mound at (−250, −122), hub y 11.5.
- **Coldharbour Farm (`coldharbour`).** Farmhouse, Great Barn, cart shed, stables, duck `pond` and `rickyard`.
- **Glenmoor Road (`glenmoor`)** and **Eastcote (`eastcote`)** are small hamlets.
- **River (`river`)** holds the mill, the lock-keeper's cottage and the boathouse. **LC1 (`lc1`)** holds the keeper's lodge.
- **Street lamps.** `layout.streetLamps` has 15 lamps outside the station, and the station's own 21 remain in `layout.lampPositions`.

### 1.7 Fields (`layout.fields`)

There are 12 authored fields, each with a polygon, `kind`, `rowYaw`, a `gate` (the boundary point nearest a road; field gates are the passage points for animals and farmhands) and optional `livestock`:

- FA Long Acre, wheat (−120, 132)
- FB Wyke Down, sheep (−110, −118)
- FC Coldharbour Ley, plough (−250, 128)
- FD Glenmoor Field, wheat (−62, −236)
- FE Kingsmead, cows: the east-bank water meadow between the river and Millbridge Lane
- FF Millbridge Field, barley (46, 130)
- FG Shed Meadow, hay (−30, 118)
- FH Eastcote Down, sheep (310, −40)
- FI Hollow Field, turnips (190, 260)
- FJ Top Field, wheat (60, −255)
- FK Paddock, horses (−200, −210)
- FL Church Acre, hay (275, 122)

### 1.8 Paths, walk graph and origins

- **Footpaths.** `layout.paths` holds:
  - `towpath`;
  - `anglersSteps`, from the humpback's west ramp down to the towpath;
  - `meadowWalk`, from Ashcombe to the boathouse;
  - `kingsmeadPath`, from Millbridge to the east bank below the arches;
  - `headlandPath`, from Coldharbour to the shed yard (fitters);
  - `churchPath`, from Wyke church to Glenmoor Drove;
  - `millPath`.
- **Walk graph.** `layout.walk` / `layout.footPath(from, to, {staff?})` unify five things: the station nav graph (including the new staff node **`sbDoor`**, the signal box door off the barrow crossing), road footways, footpaths, the towpath, every door and every walker portal. It is connected, and the entrance reaches everything. The v1 `layout.path()` is unchanged and covers the station only.
- **Walkers cross the railway only at LC1**, the footbridge and the staff barrow crossing.
- **Origins.** `layout.origins` lists every static door (73) and road, path and river portal. Rail tunnels are in `layout.portals` (kind `'rail'`).
  - `ctx.origins` is pre-filled with all of them and adds the rail tunnels.
  - `layout.nearestOrigin(pos, kinds, for)` returns the nearest one.

### 1.9 The shed road (issue 2) and tunnels

- **Shed road.** `layout.shedRoad` is a straight through-road at z = 47.9. It runs from x −300 (inside a new **`shedWest` tunnel** whose portal is at x −268) east through the shed's west wall and joins the shed siding's final straight at x −122.9.
- **Tunnels.** `layout.tunnels` lists all four (`west`, `coastEast`, `highlandNE`, `shedWest`). Core's hills already include `shedWest`, and world must build its portal.
- **Buffer.** The old buffer stop at shed t = 1 (x −156.9) goes; the shed becomes a through shed.

---

## 2. Shared core services (on `ctx`, created by main before any system)

| service | file | use |
|---|---|---|
| `ctx.quality` | `core/quality.ts` | `tier` (low/med/high), `knobs` (see §6), `reason`. Detection order: `?q=`, then `localStorage 'vj.quality'`, then software GL = low, then ≤ 4 cores, mobile or ≤ 4 GB = med, else high. Knobs are fixed for the session; the UI picker calls `setQualityAndReload(t)`. |
| `ctx.view` | `core/view.ts` | Written by **main** each frame from the rendered camera: `focus`, `zoom`, `footprint`, `bounds`, `pxPerMetre`, `frustum`, `isVisible(p, margin)`, `distToFocus`. Use it for LOD, detail fades and "is this point on screen". |
| `ctx.wind` | `core/wind.ts` | Global wind uniforms. Main calls `follow(atmosphere)` and `tick(realDt)` once per rendered frame. `applyWind(ctx, material, {mode, weight, height, amp, pivot})` patches a material and returns a depth material for `customDepthMaterial`. `wind.sample(x, z)` gives the same gust field on the CPU (windmill, smoke, kites, boats). |
| `ctx.tex` | `core/tex.ts` | Procedural detail textures. `withDetail(ctx.tex, mat, {pattern})` accepts slate, brick, setts, planks, thatch, furrows, ripple or grime. Object-space UVs, no geometry work, mip-safe. **Already applied** to `mats.slate`, `brick`, `brickDark`, `wood`, `platform` (flags) and `gravel` (grime). It is a no-op on the low tier. `ctx.tex.get(key, draw)` gives cached CanvasTextures. |
| `ctx.lights` | `core/lights.ts` | Point-light pool: 3, 6 or 8 lights by tier, always in the scene. Call `claim(key, pos, color, intensity, distance, priority)` **every frame**; main resolves by priority, then distance to the focus. **World's private lamp pool and events' permanent fx lights must move to claims.** Always pair a claim with an emissive mesh or halo. |
| `ctx.origins` | `core/origins.ts` | Legitimate spawn and despawn points plus the pop-in audit. `add` / `remove` dynamic origins (train doors while dwelling, stopped vehicles, moored boats). `nearest`, `bestFor(target)` (by walking length), `legit(p)`, **`audit(system, 'spawn'\|'despawn', kind, p, label)`** and `pools` (residents inside each building). |
| shader composition | `core/shaderMods.ts` | `chain(mat, key, injector)`: **never assign `onBeforeCompile` directly** on a shared material. Also `withSnowCap(mat, ctx.mats.uniforms.uSnow)` (already on the core stone, cream, wood, brick, iron and livery materials) and `withDitherFade(mat, uniform)` for occluder fades. |
| road movers | `core/movers.ts` | `Mover` and `Flow`: route following with keep-left, car-following gaps, stop lines (gates, junctions, rank slots), corner slow-downs, smooth yaw, `trail(offset)` for a carriage behind its horse, and `fastFactor` (speed-up beyond the ground edge only). |
| instanced rigs | `core/rig.ts`, `core/rigs/horse.ts` | `InstancedRig`: one draw per species or part, vertex-shader animation, 4 colours and 2 anim vec4s per instance, flush once per rendered frame, animated shadows. `horseGeometry()` + `HORSE_POSE_GLSL` is the shared horse: walk, trot, stamp, graze, tail swish and head nod. Traffic and nature both use it. |
| polylines | `core/poly.ts` | `Poly` (arc length, `offset`, `nearest`, `intersections`), `localToWorld`, `worldToLocal`, `pointInPoly`, `noise2`. |
| materials | `core/materials.ts` | `mats.uniforms.{uSnow, uWet, uNight}`, kept in sync by the setters. |

`__station.stats()` gains: `tier`, `tierReason`, `pixelRatio`, **`popIns`**, `popInsOffscreen`, `popInLog`, `vehicles`, `horses`, `boats`, `animals`, `birds`, `lightClaims`, and `service {arrivals, meanLateMin, maxLateMin, boarded, gaveUp, giveUpRate}`. `__station.perf()` gives draw calls and triangles per top-level scene group, plus programs and textures. **Name your root `THREE.Group` after your system** (for example `'nature'`) so `perf()` can attribute it.

**Creation order** (part of the contract): atmosphere, world, **nature**, trains, **traffic**, people, maintenance, events, camera, ui, audio. After `'ready'`, every API is available.

---

## 3. Ownership (next phase, edit ONLY your directories)

| builder | owns |
|---|---|
| world | `src/world/**` |
| nature | `src/nature/**` |
| traffic | `src/traffic/**` |
| people | `src/people/**` |
| trains + maintenance | `src/trains/**`, `src/maintenance/**` |
| events + atmosphere | `src/events/**`, `src/atmosphere/**` |
| camera + ui + audio | `src/camera/**`, `src/ui/**`, `src/audio/**`, `index.html` |
| Integrator only | `src/core/**`, `src/main.ts`, `scripts/**`, `docs/**`, `CONTRACTS.md`, config files |

**Split rules for things that touch several builders:**

- **World** builds everything static on the ground, plus the **animated building fixtures**:
  - windmill sails and yaw, the water wheel, lock gates and the chamber water level;
  - church clocks, swinging pub signs, weir foam, washing lines, chimney smoke;
  - per-lamp lit state, occluder fades, and the level crossing's lodge, posts and planking.
- **Nature** builds the **river water surface** (plus the Coldharbour pond), reeds, crop rows, every animal and bird, boats (including the towpath horse) and herding.
- **Traffic** builds road vehicles and their horses, the depot, rank and omnibus logic, and the **animated crossing gates, gate signals and interlock logic**.
- **People** builds every human, including drivers, rowers, anglers, lamplighters, gatekeepers and townsfolk, **plus the passenger trip planner**. It calls `traffic.request`, `world.lightLamp`, `nature.anchorOf` and so on.
- Anything that needs a person (the gatekeeper, the bargee, a coachman) asks people, via `summonActor`, `spawnInside` + `ride`, or `embark`. Nobody but people draws humans.
- Some existing API members are `V2 STUB — owner replaces` (in `world/index.ts`, `trains/index.ts`, `people/index.ts`, `camera/index.ts`, `ui/index.ts`, `atmosphere/index.ts`, `audio/synth.ts`, `events/actors.ts`, `nature/index.ts` and `traffic/index.ts`). Replace them with real implementations and keep the signatures.
- If you need a core change, ask the Integrator. Do not edit core.

**Ports for `scripts/shot.mjs`:**

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

Put your shots in `shots/v2-<you>/`. Typecheck with `pnpm exec tsc --noEmit`, filtering to your paths while others are mid-edit.

---

## 4. Per-builder scope

Each list is **ordered by priority**. "Done" means: `tsc` is clean, there are no page or console errors in shots, `popIns` = 0, you stayed within your §6 budget, and it looks right by day, at golden hour, at night and in rain, fog and snow.

### 4.1 World (`src/world/**`)

1. **Terrain from core.** Build the ground from `layout.heightAt`: 5 m cells inside ±200 and `knobs.groundCell` outside. Build the skirt beyond 420.
   - Delete the private height logic in `env.ts`/`terrain.ts`, or make it delegate to `layout.heightAt` / `layout.terrain.*`.
   - Rebuild the portals from `layout.tunnels`, including the new **`shedWest`** portal at (−268, 47.9).
2. **River landscape.**
   - The bank ribbon mesh at 2 m, the river bed, the towpath surface (`river.towpath.poly`), and brick wing walls where the banks steepen near tracks and roads.
   - The weir with a foam strip, the lock chamber walls and 4 animated mitre gates (`setLockGate`, `setLockLevel`; the chamber water is a small box nature can read, or world draws it).
   - The mill with its turning undershot wheel (stopped at night and when frozen), the boathouse with its slipway, the jetty, mooring posts, flattened fishing pegs, the ford gravel and the 11 stepping stones.
   - Where the river leaves the ground, carve and extend the channel through the edge ramp and onto the skirt out to about 480, with a wooded belt at 380–420.
3. **Bridges.** Glenmoor Warren truss, Kingsmead arches, the Ashbourne humpback (road y is already baked into `roads.edges.K.poly`) and the Wyke Arch underbridge, with cutting walls along Wyke Lane.
4. **Roads.**
   - Road ribbons from `roads.edges[*].poly`: the main road metalled, lanes gravel, tracks worn earth. Add verges and the forecourt loop markings or kerb.
   - Setts on the Ashcombe square (`withDetail` setts) and footpath strips.
   - LC1: the lodge, the crossing planking at rail top, and fixed posts. The gates are traffic's.
   - Field gates, stiles, and a copse or hedged cutting at each road portal.
5. **Towns.**
   - Build every `layout.buildings` entry from its data: walls and roof by kind, chimneys at `chimneys[]`, doors on the +z face, lit windows, the church tower or spire, the smithy's open front with a forge glow (claim a light), the inn arch into the mews yard, the Post Office pillar box.
   - Detail textures by material: slate, tile, thatch (a new `wm.thatch` with `withDetail` thatch), brick, planks for timber.
   - Town areas: the square (setts, market cross and pump), churchyard (headstones), green, school yard, pond (nature draws its water), rickyard (haystacks).
   - **Remove** the v1 random villages at the old clusters and the static cab stand in `garden.ts`. Keep the trough at `forecourtTraffic.trough`.
   - Keep random fillers only in areas where `terrain.clear` holds.
6. **Fields.**
   - Ground tints per `kind`, with the furrows texture along `rowYaw`.
   - Hedgerows on polygon edges, with a gap at `gate`.
   - The plough field gets a "ploughed fraction" uniform that nature's plough team can drive. Expose it on WorldAPI via the Integrator if needed; for now, keep it world-internal and time-driven.
7. **Wind.**
   - Trees: split the InstancedMeshes **per chunk** so they cull. Apply `applyWind(mode 'tree', weight 'localY')`, with half amplitude for conifers.
   - Hedges: `'foliage'` with baked `aWind`.
   - Also the church flag, pub signs and washing lines (`'cloth'`).
8. **Chimney smoke.** One InstancedMesh of puff billboards with lifetime computed in the vertex shader from per-instance chimney position and phase; zero CPU. Up to `knobs.caps.chimneys` chimneys × about 6–10 puffs, chosen near the view focus.
   - Default on/off: household awake, cold, bakery 04:00–10:00, occupancy from `ctx.origins.pools`.
   - `setChimney` overrides.
9. **Lamps (WorldAPI v2).**
   - Implement `lamps()`, `lampLit(i)`, `lightLamp(i, on)` and `manualLamps` (true).
   - Fallback: any unlit lamp lights by itself when `atmosphere.gloom > 0.85`, and lamps go out at full day.
   - Replace the private light pool with `ctx.lights.claim(...)`: priority 1 for station and forecourt lamps, 0.5 for town lamps.
   - Emissive glass plus a cheap halo sprite, so unclaimed lamps still glow on the low tier (no bloom).
10. **Occluders.** Implement `occluders()` and `setOccluderFade(id, a)` for the station roof, clock tower, P2 canopy, footbridge and shed roof, using `mats.derive`-style clones plus `withDitherFade`. Camera decides when to fade.
11. **Batching.** One global chunked batcher, keyed by material × 140 m chunk. Kit builds once.
    - Shadow casters by `knobs.shadowCasters`: never flowers, fences, rails, sleepers, crops or water.
    - Tiny detail groups hide below `knobs.detailZoom`.
12. Implement the rest of WorldAPI v2: `setWashing`, `openDoor` (cosmetic), and `mills()` (windmill rpm from `ctx.wind.speed`; sails furled at night, on Sundays and in storms).
13. Signal box door at `layout.landmarks.signalBoxDoor` / nav `sbDoor`, and a visible signalman silhouette at the window that pulls a lever on `signal:changed` (a simple animated box).

### 4.2 Nature (`src/nature/**`, new system; stub in place)

1. **Water surface.**
   - One ribbon mesh along `river.poly`: 4 quads across, one segment per 3 m, `uv.x` across and `uv.y` in metres downstream. The step at the weir and the lock chamber follow `world.mills().lockLevel`.
   - `MeshStandardMaterial` plus `chain` injectors, opaque:
     - a deep-to-shallow colour mix;
     - ripple normals from `ctx.tex.detailB` (ripple channel), scrolling with the flow and the wind (count by `knobs.water.ripples`);
     - fresnel sky tint from `atmosphere.skyColor`;
     - rain rings (`knobs.water.rainRings`);
     - ice margins from `atmosphere.iceAmount`, with snow on the ice;
     - lamp-streak glints (`knobs.water.lampStreaks`, taking positions from `world.lamps()`).
   - The Coldharbour duck pond (`towns[coldharbour].areas.pond`) is a small disc with the same material.
   - River mist cards when `atmosphere.dawnMist` or fog is present (`knobs.water.mist`).
2. **Reeds.** Instanced crossed quads along `river.reeds`, with `applyWind('foliage')`.
3. **Crops.** One merged mesh for all wheat and barley fields: corrugated rows at `knobs.cropPitch` with top vertices flagged by `aWind`, using `applyWind('crop')`, which gives both sway and gust sheen. On the low tier (`!knobs.cropGeometry`), use no geometry; world's field tint gets the sheen, or add a flat quad with the crop wind material.
4. **Animals.** Use the `InstancedRig` pattern: one draw per species. Sheep, cows and dogs need their own rig GLSL; horses use `core/rigs/horse`.
   - Sheep in FB and FH, and cows in FE: graze, step, loose flocking at 2 Hz, tail swish, lying down at midday.
   - Cows walk to the dairy byre door (`millbridge:dairy`) at 05:40 and 15:40 and come back about 45 sim min later. That is a door sink.
   - Paddock horses in FK.
   - Hens at the LC1 lodge and Coldharbour; geese on the pond.
   - Ducks: 2 groups, one per reach. Swans in the mill pool from May to August. The heron stalks and strikes between `river.heron` spots.
   - Crow flocks over FA and FD rise at whistles (`audio:cue` whistle within 150 m, and `animal:scared`). A dusk starling murmuration over FG in autumn and winter settles into the Coldharbour copse. Rooks circle St Mary's tower; swallows fly over the river in summer.
   - 2–4 village dogs trotting between doors.
   - **Far animals tick at 2 Hz**. Instances outside the frustum plus margin get a zero matrix.
5. **Boats.** Every boat enters through `river.portals`, the boathouse slip, or a mooring. Never in open water.
   - Rowing boats from the boathouse (daylight, no storm or ice). Rowers are people riding via `anchorOf`, with the `'row'` pose; oars are a separate instanced part.
   - The steam launch *Kingfisher* moored at m1, with smoke (copy the approach of `trains/smoke.ts` into your own dir, or claim a light for its lamp). Its funnel hinges down at bridges.
   - The narrowboat towed by a **horse walking `river.towpath.poly`** (horse rig), with the towline as a sagging beam. It works the lock with the keeper through `world.setLockGate` / `setLockLevel` and `people.summonActor('lockkeeper')`, and moors overnight above the lock with a cabin lamp (claim) and chimney smoke.
   - A punt on summer afternoons.
   - Implement `requestBoat`, `boats()` and `anchorOf`.
6. **Herding** (`herd(kind, from, to)`). Drovers' flocks come from N1 down Glenmoor Drove, following `layout.roadPath` or `walk`. Use `ctx.origins.audit` for animals at portals and doors, `people.summonActor('drover'/'shepherd')`, and a collie that works the flanks. The flock occupies the road, and traffic yields (register a Flow stop line or tell traffic by bus event).
7. Implement `scare(pos, r)` and `raycast`, fill `list`, `get` and `stats`, and use `river.surfaceY` / `flowAt` for others.

### 4.3 Traffic (`src/traffic/**`, new system; stub in place)

1. **Vehicle renderers.** Use `InstancedRig` per body kind plus the shared horse rig and one wheels InstancedMesh (spin from the Mover odometer in the shader):
   - hansom, growler, omnibus (2 horses, visible roof passengers), landau/gig;
   - carts: mail, coal, farm cart, hay wain, milk float, dray, baker's handcart;
   - bicycles, and the rare **Benz motorwagen** (puttering, blue exhaust puffs, at most 1 per sim day on about 20 % of days).
   - Lamps on carriages at night (claims at priority 0 plus emissive).
2. **Movement.** Use `core/movers.ts`: `Flow` plus `Mover` on `layout.roadPath` routes, with trailing carriage and wheels via `trail()`.
   - Spawn **only** at road portals (E1, E2, S1, W1, N1, NW1; spawn when `!ctx.view.isVisible(p, 5)`, otherwise wait off-map) or inside the **Crown Mews** stable doors (`layout.mews.door`). Despawn at the same kinds of place.
   - Call `ctx.origins.audit(...)` for every spawn and despawn, and `ctx.origins.add` for each stopped vehicle, so people may step in and out.
3. **The forecourt.** Loop edge `FC` and the stops in `layout.forecourtTraffic`.
   - Keep 2–4 cabs at the rank. An unhired cab leaves after 25 sim min "to try the Crown".
   - Drop-offs take ≤ 3 sim min. The omnibus meets every scheduled train from 06:30 to 22:30: one bus by day, two in the peaks, standing from T_arr − 8 until 6 min after departure.
   - A waiting driver climbs down, pats the horse, fits a nosebag, and so on (people idle styles).
   - Horses drink at the trough.
   - **No vehicle parks forever.**
4. **Timetabled traffic.**
   - The milk float at 06:10 to the forecourt, then the Ashcombe doorstep round from 07:00 to 09:00.
   - The mail cart meets the last train after 22:30.
   - The brewery dray on Tuesday and Friday at 10:00: E1 → Railway Arms → The Crown → E1.
   - The coal cart on weekdays from 09:00 to 15:00.
   - 4–10 farm carts a day between portals and farms or Ashcombe.
   - Heavy traffic on Thursday market day.
5. **LC1 gates.** Four animated leaves (from the `gates` data), gate lamps (red to the road when shut), gate-signal arms, and bell cues.
   - Implement `crossingState`, `requestCrossing` and `releaseCrossing` (see §1.5): shut the gates when a train requests or when `trains.eta` is under about 60 s.
   - A road stop line on `M` at `roadStop` while the gates are not open.
   - The keeper comes out of the lodge via `people.summonActor('gatekeeper', gatePoint)` and the gates move when the keeper arrives, or after a 12 s timeout so a train is never blocked.
   - Night rule: the gates stay shut to the road from 22:00 to 06:00, and the keeper opens them per cart.
   - Emit `crossing:state`.
6. **Riders.**
   - `request(TripRequest)` spawns the vehicle at its origin and creates riders inside it via `people.spawnInside(vehicleOriginId, specs)`, then `people.ride`.
   - `anchorOf(id)` implements `Anchor`: closed cabs hide their riders, open vehicles show them.
   - Emit `vehicle:*` events.
   - `rank().hail()` reserves or summons a cab.
7. Implement `scare(pos, r)`: horses shy and one may bolt briefly (react to `animal:scared` too). Implement `raycast`, `list`, `get` and `stats`.

### 4.4 People (`src/people/**`)

1. **No pop-in for people.**
   - Replace every spawn at `L.entrance` / `exitPoint()` with origin-based spawns:
     - `spawnInside(originId)`, fading out through a door with `doorsIn` → `doors`;
     - train doors;
     - vehicles via traffic;
     - walkers from portals.
   - Every `spawn` and `remove` calls `ctx.origins.audit`. `removeActor` becomes a dismiss (walk to a sink). The warm start (before the first frame) may place people mid-route.
2. **Passenger trip planner.** Keep the hourly RATE curve × 0.7, drawn in family groups of 1–4. Choose the origin by weight:

   | origin | weight | notes |
   |---|---|---|
   | omnibus | 30 % | |
   | cab / growler | 25 % | `traffic.request({kind:'cab', to:'forecourt:drop', riders})` |
   | Station Terrace or pub door | 20 % | |
   | Ashcombe door | 12 % | |
   | far: Millbridge / Wyke / portals | 5 % | |
   | cart lift | 5 % | |
   | gig | 3 % | |

   - **Honest lead time.** Set out at expected departure − (`layout.walk.length / speed` + queue + 10–25 min slack). Never target a train the passenger cannot reach; pick the next one instead.
   - Patience starts at the entrance.
3. **Boarding (issue 1b).**
   - On `train:approaching`, committed passengers walk to `trains.predictedDoors(id)` zones. Boarding walks at hurry speed.
   - Implement `boardingEta(trainId)`, which trains uses for dwell discipline.
   - Patience only decays after the scheduled departure has passed. When a delay is posted, passengers go into the waiting-room pool (`ctx.origins.pools` 'station') instead of giving up.
   - After a miss or a cancellation, rebook onto the next train. Give up only if the posted wait is over about 150 min.
   - **Target: give-up rate under 5 %** (`stats().service.giveUpRate`).
4. **Arrivals' sinks.**
   - Cab queue (30 %; `traffic.rank().hail()`), omnibus (25 %), walking to a Terrace or pub door (15 %), Ashcombe (15 %), and "met by family" (10 %). A meeter walks from a door at `train:approaching` and they embrace and leave together.
   - Interchange passengers stay (existing behaviour).
5. **Idle layer (no stationary people).** Shader-driven per-instance breathing, weight shifts and head look-arounds (repurpose `iAnim.w` as fade, and add `iAux`), plus gesture clips by role:
   - pocket watch, newspaper, look down the line, pacing, sitting and standing at benches;
   - hat tips, umbrellas, children fidgeting, hopping and pointing;
   - chat gestures, cabmen's pipes, porters sweeping, and so on.
   - A person may hold for at most about 12 s before a clip plays. Implement `setIdle` and `lookAt`.
6. **Riding.** `ride`, `embark`, `disembark` and `spawnInside` with vehicle and boat anchors (`Anchor.seatMatrix` every frame; `hidden` riders not drawn). Poses: sit, drive, row, pole, stand, fish.
7. **Staff from doors.**
   - Porters, clerk and signalmen come out of Station Terrace doors. Shift changes are at 05:30, 14:00 and 22:00. Signalmen walk to nav **`sbDoor`**.
   - The stationmaster uses the station east door.
   - Fitters come from Coldharbour via `headlandPath`, or from the Terrace.
   - The platelayers' gang comes from the hut and does a morning track walk along the coast line, stepping clear of trains.
   - The newsboy collects papers from the first up train. The beat constable patrols K, the forecourt and the pub from 07:00 to 22:00.
8. **Townsfolk scheduler** (cap `knobs.caps.townsfolk`, full-rate only near the view focus).
   - Residents leave and return through their own doors (`ctx.origins.pools`): shopping in Ashcombe, gossip, sweeping doorsteps.
   - Monday wash, with the washerwoman calling `world.setWashing`.
   - Board School playtime at 10:30 and 12:00–13:00.
   - Pub evenings from 18:00 to 23:00, with a closing-time wobble.
   - Sunday church at 10:30.
   - Anglers walk to `river.fishing` pegs (cast, reel, catch every 5–60 sim min). Farmhands work in the fields.
9. **The lamplighter's round.** At sunset − 50 sim min (or when `gloom > 0.4`), the town lamplighter starts from the mews along Ashcombe, then K, then the forecourt, while the lamp boy works the other way. Porters light the platform lamps. They call `world.lightLamp(i, true)`, and do the reverse at dawn.
10. **New roles in `looks.ts`.** Add all the v2 roles in `PersonRole` and the new `PersonAnim` clips, including accessories: newspaper, rod, basket, lantern, pipe and watch.

### 4.5 Trains + maintenance (`src/trains/**`, `src/maintenance/**`)

All of this follows the measured analysis. Plan from motion time: a train holds its single-track line for about 53 min.

1. **Issue 1a: lateness.**
   - **Line ledger timetable.** Space each train using its own approach time, dwell and exit time, plus a 6–8 min margin, adjusted for fog and snow.
   - **Flights.** By day, send 1–2 trains in one direction (the second 15–18 min behind), then switch direction.
   - **Dwell discipline.** Depart at the scheduled time. Hold only for passengers committed to this train (`people.boardingEta` ≤ 3 min), for at most +2 min, and not at all if the train is already more than 3 min late.
   - **Disruptions.**
     - `delayLine` affects only the next train in each direction and takes the larger delay, not the sum.
     - Specials take a free slot (`arriveBy`).
     - Cancel to recover: withdraw a queued train, **including one already waiting off-map**, when its projected delay exceeds about 25 min, move its passengers to the next train, and post a gazette notice.
   - **Target: mean lateness under 5 min, p90 around 12.**
2. **Issue 2: shed.**
   - Use `layout.shedRoad` and the `shedWest` tunnel. Light engines enter and leave at the west portal at about 10 m/s and never touch the coast line.
   - Release the shed-road lock on reaching the bay, and allow one engine to wait behind.
   - Coast westbound trains divert directly through the switch after the call.
   - Target: about 15–18 min from off-map, about 12–15 min for a coast westbound train after its departure.
   - Coaches never vanish in view: they leave through a tunnel.
3. **Issue 3: engine hidden behind the building.** `LineLayout.stopTFor` (core) now stops **westbound Highland trains with the head at least 30 m from P2's west end**. Trains longer than about 75 m overhang P2's east end.
   - Keep Highland consists at 80 m or less (trim the 97 m express to 4–5 coaches, or drop the guard's van), **or** make sure only van or guard vehicles overhang.
   - `getDoors` / `predictedDoors` must drop doors that fall off the platform.
   - Check it with a screenshot.
4. **Issue 6: the Phantom Mail.** It enters from a tunnel (a legitimate portal; no fade-in exception).
   - Speed profile: about 40 m/s until 130 m before the platform, a 7 m/s glide with no fog penalty, then a fast exit.
   - Pick a line and direction with no train on the map and none due within 30 min (`nextGap`).
   - Events cooperates by starting the flicker and apparition when the ghost is about 150 m out, and ending after it has left.
   - Target: at the platform about 15–18 sim min after the event starts.
5. **LC1 interlock.** See §1.5: `traffic.requestCrossing('lc1', id)`, requested in the east tunnel or before departing P1, never passing `crossings[0].trainStopT` unless it returns true. Release afterwards.
6. **Origins.**
   - Register each train door as an origin while dwelling: `ctx.origins.add({kind: 'train', open: () => doorsOpen, ...})`. Remove it on departure.
   - Register the loco footplate for crews.
   - The rescue pilot engine and light engines must enter and leave only through tunnels or the shed.
7. **TrainsAPI v2** (replace the stubs): `predictedDoors`, `eta` (including off-map trains), `occupied`, `nextGap`, `expectedDeparture`, and the `Departure` v2 fields `dir`, `expected`, `trainLength` and `stopHeadT`.
8. **Headlamps.** Use `knobs.spotLights` headlamp spot lights. At 0, use emissive cone meshes.
9. **Maintenance.** Queue logic for the new shed road, UI ETA text, and a whistle scare: emit `animal:scared` at the loco on whistle cues so crows rise and horses shy.

### 4.6 Events + atmosphere (`src/events/**`, `src/atmosphere/**`)

1. **Issue 4: golden hour (atmosphere).**
   - Keep the visible sun and sky, but limit how far the key light swings from the camera. If it is more than about 75° away, blend it back toward camera azimuth + 180° ± 75°, smoothly between 60° and 110°, and ease over about 1.5 s when the camera rotates. Expose the result as `keyLightDir`.
   - Add a warm, non-shadowed fill light from the camera side at about 0.25–0.4 during golden hour.
   - Raise exposure by about 8 % and set the hemisphere light to about 1.55 for the 18.8–19.85 keyframes.
   - Check with a 19:36 shot: lit south facades.
2. **AtmosphereAPI v2** (replace the stubs):
   - `skyColor`, `sunColor`, `keyLightDir`;
   - `dawnMist` (dawn from 05:00 to 08:00, plus fog);
   - `iceAmount`: freezes after about 6 sim hours below −3 °C, thaws above 2 °C;
   - `gloom`, `snowCover`, `wetness`.
   - Shadow map size comes from `knobs.shadowMapSize`.
   - `ctx.wind` already follows `api.wind`. Call `ctx.wind.set()` only to override gusts.
   - An edge haze: fog so the skirt beyond about 430 fades toward the horizon colour.
3. **Events and the no-pop-in rule.**
   - **Delete `LocalFigure` in `events/actors.ts`.** Every actor comes from `people.summonActor` / `summonCrowd` (with a prologue: bells, a carriage setting out), or from `traffic.request` (wedding carriages from the mews, the royal carriage-and-four from E1, circus wagons parading out along K to E1), or from `nature.herd`.
   - Event scripts tolerate assembly time: `await handle.arrived` with a timeout.
   - Replace the two permanent point lights in `fx.ts` with `ctx.lights.claim` at priority 3.
4. **Disruption discipline.**
   - Cap event line-holds at 10 min.
   - Start line-blocking events (cow, snowdrift, signal strike) inside `trains.nextGap(line, …)` windows.
   - Existing events adopt the new origins: the band comes from the Railway Arms door, the pickpocket from an arrival, the cat from the station east door, the goose from the LC1 hen run or Coldharbour, the cow through a field gate.
5. **New events** (priority order; each declares its origins and sinks):
   1. **Motorwagen scare**: Herr and Frau Benz from E1. Horses within 25 m shy (`traffic.scare`). They stop at the Ashcombe chemist for ligroin, draw a crowd at the forecourt, then crank and chug off.
   2. **Runaway horse and cart**: a whistle at LC1 startles a cart horse. Apple props spill. The constable or a porter catches the bridle.
   3. **Sheep on the road / at LC1**: a drover's flock, a train held at the gate signal, the collie clearing it.
   4. **Market day** (Thursday): traders carry and assemble stalls on the square (props built by actors, never popped in), plus extra carts and an auctioneer's bell.
   5. **Regatta** (summer Saturday): bunting, spectators, 4-oar gigs racing from the girder bridge to the jetty.
   6. **Angling match** (Sunday morning).
   7. **Rick fire**: a smoke column, St Mary's alarm bell, the fire engine galloping from the Engine House via K → M → LC1 → F.
   8. **Frost fair and skating**: needs `iceAmount = 1` on the skating reach.
   9. **Balloon landing**: upgrades `balloon`; it drifts in from the sky edge and lands in FG, and the aeronauts leave by train.
   10. **Kite day**, **the hunt crosses**, **swan chases angler**, and **fete / cricket / lost dog / barge stuck** as light ambient events.
6. **Weekly rhythm.** Emit `town:day` at 00:00 (washday, dray, drover, market, regatta, sunday, ordinary) and `town:bell` (the hour, the Sunday peal at 10:30, weddings, the fire alarm). Other systems react.

### 4.7 Camera + UI + audio (`src/camera/**`, `src/ui/**`, `src/audio/**`, `index.html`)

1. **Camera.**
   - Clamp the **ground footprint** (not just the target) inside `layout.terrain.playHalf`, using `ctx.view.bounds` or the camera's own frustum. Allow panning to Ashcombe and Millbridge.
   - `followAny(kind, id)` follows vehicles (`traffic.get`), boats (`nature.boat`), animals (`nature.get`) and people.
   - When the followed or selected thing is behind the station, fade the occluders (`world.occluders` / `setOccluderFade`).
2. **Picking and selection.** The `select` kinds are `'vehicle'`, `'boat'`, `'animal'` and `'building'`. Use `traffic.raycast`, `nature.raycast`, and building hits via `layout.terrain.buildingAt` on a ground ray.
3. **UI.**
   - Inspector cards for vehicles (kind, riders, destination), boats, animals, and buildings (name, kind, residents inside from `ctx.origins.pools`, chimney).
   - Replace the stub in `ui/index.ts`.
   - A **quality picker** (low, med, high, auto) that calls `setQualityAndReload`, plus a small toast offering "Lower detail" when fps stays below 24.
   - Show the service stats (mean lateness, give-up rate) in the station card.
4. **Audio.**
   - Real voices for the new `AudioCue`s (replace the stub mappings in `synth.ts`).
   - An ambience bed from `view.focus` proximity: river water, weir and mill, hooves and wheels near traffic, livestock, rooks and birdsong by day, wind level from `ctx.wind.speed`, church bells, the forge anvil, the pub murmur in the evening, rain on water.

---

## 5. Day and week rhythm (shared expectations)

| time | what happens |
|---|---|
| 04:00 | Bakery chimney |
| 05:00 | Lamps put out |
| 05:30 | Porters, clerk and platelayers leave their doors |
| 05:40 | Cows to the dairy |
| 06:00 | First omnibus, windmill sails turn, bargehorse comes out of the lock stable |
| 06:10 | Milk float |
| 06:20 | Newsboy |
| 07:00–09:30 | Commuter peak, with 2 omnibuses |
| 10:00 | Dray (Tuesday and Friday), coal cart, plough team |
| 10:30 | School playtime |
| 12:00–13:00 | Farmhands' lunch |
| 14:00 | Shift change, rowing boats, angling |
| 15:40 | Cows to the dairy |
| 16:30–19:00 | Evening peak |
| 17:00 | Plough team goes home |
| 18:00 | The Railway Arms fills |
| 18:30 | Starlings (autumn and winter) |
| sunset − 50 min | Lamplighter's round |
| 22:00 | LC1 gates shut to the road |
| 22:45 | Mail cart |
| 23:00 | Pub closes |
| Overnight | Barge moored with its cabin lamp lit |

**Weekly:** Monday wash day, Tuesday and Friday dray, Wednesday drover, Thursday market, Saturday regatta, fete or cricket, Sunday church bells at 10:30 with the windmill stopped.

---

## 6. Performance budget and quality tiers

The knobs live in `KNOBS` in `core/quality.ts`. Summary:

| knob | low (auto on SwiftShader / llvmpipe) | med | high |
|---|---|---|---|
| render path | **direct** `renderer.render`, no bloom | composer, MSAA 2 | composer, MSAA 4 |
| pixel ratio cap | 1 | 1.25 | 2 |
| shadow map | 1024 PCF, major casters | 2048 PCF, near | 2048 PCF soft, all |
| point-light pool | 3 | 6 | 8 |
| headlamp spots | 0 (emissive cones) | 2 | 2 |
| wind modes | tree, crop, cloth, flag, smoke, water | all except grass | all |
| wind in shadows | no | yes | yes |
| detail textures | off | 512 | 512 |
| water | flat, flow tint | 1 ripple layer, rain rings, 4 lamp streaks, mist | 2 ripple layers, 8 streaks |
| people / townsfolk | 240 / 25 | 360 / 50 | 440 / 80 |
| vehicles / horses / boats | 11 / 16 / 3 | 14 / 22 / 6 | 20 / 32 / 9 |
| sheep / cows / birds / waterfowl | 20 / 6 / 40 / 8 | 40 / 10 / 120 / 14 | 60 / 14 / 250 / 20 |
| chimneys × puffs | 10 (60 puffs) | 25 (200) | 40 (400) |
| crops | sheen only | rows 1.6 m | rows 0.8 m |
| outer ground cell | 20 m | 10 m | 10 m |
| full-rate life radius | 160 m | 220 m | 300 m |

**Frame budget (default view, main plus shadow passes).** v1 baseline on low was 284 draws and 432k triangles.

| | low | med | high |
|---|---|---|---|
| draw calls | ≤ 260 | ≤ 360 | ≤ 450 |
| triangles | ≤ 420k | ≤ 650k | ≤ 900k |
| programs | ≤ 90 | ≤ 100 | ≤ 110 |

CPU `updateMs` must stay ≤ 3 ms at 1× and ≤ 10 ms at 60×.

**New draw calls allowed per builder on low, after world's re-batching:**

| builder | allowance |
|---|---|
| world | must come out **net ≤ +0**, since batching and chunking pays for the river, bridges, towns and roads |
| nature | ≤ 10 (water 1, reeds 1, crops 1, animals ≤ 5, birds 1, boats ≤ 2) |
| traffic | ≤ 8 (horses 1, wheels 1, bodies ≤ 5, lamps 1) |
| people | ≤ +2 |
| events | ≤ 6 while active |
| atmosphere | ≤ +1 (fill light has no draw) |

**Techniques.**

- Merge static geometry per material and chunk.
- Use InstancedMesh or InstancedRig for anything that repeats.
- Animate in shaders, and upload instance buffers once per rendered frame via `onBeforeRender`.
- Give off-screen instances a zero matrix, and tick far life at 2 Hz.
- Keep light counts constant through `ctx.lights`, and never change shader-affecting knobs at runtime.
- **Never** call `new THREE.PointLight` outside `core/lights.ts`.

---

## 7. QA checklist (the Integrator runs it after the build phase)

1. `pnpm exec tsc --noEmit`, `pnpm build` and `node scripts/check-layout.mjs` all pass.
2. Shots come back with no page or console errors: default view at 07:30, 12:00, golden hour 19:36, 22:00, rain, storm, fog, and snow with a frozen river. Also `?q=low`, `?q=med` and `?q=high`, and zoomed-out corners (no skirt or portal visible in iso).
3. A 3-day `advance()` soak with seeds 1, 3 and 7 gives:
   - `popIns` = 0 (offscreen violations near 0);
   - `service.meanLateMin` < 5;
   - `giveUpRate` < 0.05;
   - shed "Send to shed" from off-map ≤ 20 min;
   - the Phantom Mail at the platform ≤ 20 min after the event starts.
4. Idle audit: nothing alive stays motionless with no clip for more than 12 s.
5. Budget: the §6 draw-call and triangle limits hold on low in SwiftShader, and fps is within about 10 % of the v1 baseline.

---

## 8. Deviations from the analysts' designs (and why)

- **One level crossing, not two.**
  - LC1 moved from x 118 to **x 220**. At 118, a 97 m westbound train held at the P1 west home signal (x 101) would have blocked the road with its tail. At 220 the crossing is clear of the station throat and sits right by the east tunnel, so trains can wait for the gates invisibly inside the tunnel.
  - Wyke Lane crosses the Highland line by the **Wyke Arch underbridge** in a cutting, with no gates or interlock. At LWD's LC2 position a held train would also block the road, and a second interlock doubles the train/traffic coupling for little gain.
- **The river's southern course.** After the Kingsmead arches, the river bends **south-west** past Millbridge Mill to a ford on Coldharbour Track. Millbridge moved to the **east bank** so that Millbridge Lane (from LC1) reaches it without another bridge. The north half follows the living-world design's verified crossings.
- **The Ashbourne humpback is a 2-lane, 11 m deck** rather than a single-lane token bridge. All station traffic from Ashcombe crosses it, and single-lane alternation would queue the omnibus and cabs.
- **The geography module is `core/countryside.ts`**, exposed on `ctx.layout`, rather than a separate `ctx.geo`. There is one layout object and one validator.
- **`ctx.view` is computed by main**, not written by the camera, so every system gets correct view state even while the camera builder is mid-edit. The camera only has to clamp its footprint.
- **Wind follows atmosphere in main** (`wind.follow`). Atmosphere needs no work for wind to animate.
- **Mills and lock gates belong to world**, where the tech design gave them to nature. They are building fixtures, and a moving part inside one builder's mesh stays with that builder. Nature drives them via `setLockGate` / `setLockLevel` and reads `mills()`.
- **The "life" system is split** into `traffic` (roads), `nature` (animals, boats, water, crops) and `people` (all humans, including the trip planner).
- **dtMotion is ≤ 0.5 s per sub-step** (the tech design assumed 30 s). `MOTION_SECONDS_PER_SIM_MINUTE` stays 1, as the sim analyst recommended.
- **No exception to the no-pop-in rule for the ghost.** The Phantom Mail emerges from a tunnel under its own speed profile.
- **Point-light pool sizes are 3, 6 and 8.** The tech design proposed 2, 4 and 6; the living-world design proposed 4, 8 and 12.
- **The shed road** is the sim analyst's recommended option, and uses the west edge at z 47.9. That does not collide with any v2 road or with the river.
