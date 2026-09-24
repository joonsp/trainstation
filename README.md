# Victoria Junction

A small, living Victorian railway junction in three.js. It is shown in an isometric view by default, with a flat-shaded, low-poly look in a restrained period palette (brick red, cream stone, slate, bottle green and crimson lake).

Two single-track lines split at the station and run off in different directions:

- the **Coast Line** (Brightmouth – Kingsport, Platform 1);
- the **Highland Line** (Ashby Vale – Glenmoor, Platform 2).

The station runs on its own:

- **Trains:** timetabled steam trains stop, dwell and depart under semaphore signals, and engines wear out and go to the shed.
- **People:** passengers queue for tickets, wait, board and alight, while porters, a stationmaster, a clerk and a newsboy go about their work.
- **Weather and day/night:** the weather changes by itself, and a day/night cycle brings gas lamps, lit windows and bloom.
- **Events:** random events interrupt the routine.

## Getting started

```sh
pnpm install      # pnpm 10 (pinned in mise.toml), Node 20+
pnpm dev          # Vite dev server, open the printed URL
pnpm build        # tsc --noEmit + production build into dist/
pnpm preview      # serve dist/
pnpm typecheck    # tsc only
```

The only runtime dependency is three.js. Fonts load from Google Fonts. Sound uses WebAudio and starts after the first click, because browsers block autoplay.

## Controls

| Input | Action |
|---|---|
| Left / middle drag | Pan (in perspective mode, left drag orbits) |
| W A S D / arrow keys | Pan |
| Mouse wheel / pinch | Zoom toward the cursor |
| Q / E | Rotate the view 90° |
| R | Reset the view |
| P | Switch between isometric and perspective |
| Click | Inspect a train, a person or a station building (station building, platforms, canopies, footbridge, engine shed, signal box) |
| F | Follow the selected train (Esc stops) |
| Space | Pause / resume |
| 1 / 2 / 3 | 1× / 10× / 60× speed (1× means one sim minute per real second, so a day lasts 24 minutes) |
| M | Sound on / off |
| U | Hide / show all panels |
| ? or H | Help card |
| Esc | Close the help or the events menu, then clear the selection |

## The UI

- **Clock card** (top left): a working station clock, day and date (the calendar starts in June 1887), temperature and weather.
- **Stats strip:** passengers served today, the share of trains on time (within 2 minutes), engines in the shed and running events.
- **Engine Shed card:** the engine in the repair bay, the current task with a progress bar, and the queue of waiting engines.
- **Departures board** (top right): a split-flap board with the next six departures, platforms, and remarks such as delays, *Boarding*, *Approaching* and *Cancelled*.
- **Control bar** (bottom left):
  - **Time:** pause, 1×, 10× and 60×.
  - **Weather:** Auto or a fixed weather.
  - **Events menu:** every event with its conditions. Trigger any event, or press "View" on a running one to fly the camera to it.
  - **View:** rotate, iso/perspective, follow and mute.
- **Inspector card** (right, when something is selected):
  - **Train:** service, timetable, status, speed, punctuality, load, a condition bar for each part (boiler, brakes, wheels, coal, water), a consist strip, and **Follow** and **Send to shed** buttons.
  - **Person:** name, role, destination, what they are doing, mood and patience.
  - **Station building:** live facts such as the shed bay, trains at each platform and signal states.
- **The Junction Gazette** (bottom ticker): period headlines for arrivals, delays, weather, events and complaints.

## What happens

- **Timetable:** each line runs roughly one train an hour in each direction by day: expresses, stopping trains and goods. At night there is a mail train and a goods train. The lines are single track, so trains wait at the home signals for the block. Delays spread, and trains that end up badly late are cancelled.
- **Trains:** engines come from a pool of named locomotives (tank engines, express engines with tenders). They have coaches, mail vans, dining cars, goods wagons and guard's vans. Smoke and steam puffs come from the chimney, sparks fly at night, headlamps light the track, and the cylinder cocks hiss. Each line has its own livery: crimson lake for the Coast Line and bottle green for the Highland Line.
- **Maintenance:**
  - Boiler, brakes and wheels wear with every run, faster in bad weather. Coal and water burn and are partly topped up at platforms.
  - A worn engine is sent to the shed after its duty. It comes back as a light engine, is repaired in the single bay (fitters, welding sparks, a task list) and takes on coal and water before it returns.
  - An engine run into the ground breaks down on the line, and a tank engine is sent to haul it away.
  - To send an engine yourself, select a train and press **Send to shed**.
- **Passengers:**
  - Passengers arrive at the forecourt timed to departures. Some queue at the booking office, then find a waiting spot (benches when it rains, shelter under the canopies).
  - When their train arrives they walk to the doors. Trains hold their doors while people are still boarding.
  - Passengers lose patience with delays, rain and cancellations, and eventually give up and leave.
  - Arriving passengers alight and head for the exit, and families travel together.
- **Weather:** clear, overcast, rain, storm (with lightning), fog and snow. Each changes the sky, fog, light, wetness (darker, glossier materials and rain splashes on the platforms), snow cover, particles, wind-blown smoke, sound and passenger behaviour.
- **Day/night:** the sun and moon move, dusk and dawn have their own colour keys, and at night the gas lamps, lit windows, signal lamps and bloom come on.

## Random events

Events fire by themselves when their conditions hold (time of day, weather, cooldowns). You can also trigger them from the **Events** menu.

| id | Event |
|---|---|
| `goose` | **Runaway Goose:** a bad-tempered goose loose on a platform, chased by a porter. |
| `cat` | **Cat on the Line:** the stationmaster's cat naps on the track, and trains are held until a porter carries it off. |
| `cow` | **Cow on the Line:** a cow blocks the Highland Line until the farmer shoos her home. |
| `circus` | **The Circus Comes to Town:** a circus special calls at Platform 2, and Duchess the elephant parades along the platform. |
| `royal` | **Royal Visit:** the Royal Train calls, with bunting, a red carpet, cheering crowds and a fanfare. |
| `wedding` | **Wedding Party:** newly-weds and their guests catch a train in a flurry of confetti (most often on Saturdays). |
| `bandConcert` | **Brass Band Concert:** the town band plays on the forecourt on fine afternoons, mostly on Sundays. |
| `signalStrike` | **Lightning Strike:** in a storm, lightning disables a signal and a fitter repairs it. |
| `ghost` | **The Phantom Mail:** in the small hours and thick fog, a spectral train passes through slowly and the gas lamps gutter. |
| `snowdrift` | **Snowdrift:** a drift blocks a line and a gang of platelayers digs it out. |
| `balloon` | **Hot-Air Balloon:** a striped balloon drifts over the station. |
| `pickpocket` | **Stop, Thief!:** a pickpocket bolts through the forecourt with a constable in pursuit. |
| `lostLuggage` | **Lost Luggage:** a mysterious trunk is left on a platform. |

## Debug URL parameters

For example: `http://localhost:5173/?time=21.5&weather=rain&event=ghost&mute=1`

| Param | Meaning |
|---|---|
| `time=<hour>` | Start hour (float, e.g. `19.5`) |
| `weather=clear\|overcast\|rain\|storm\|fog\|snow` | Start weather (set instantly) |
| `speed=<n>` | Time scale (1 = 1 sim min per real second) |
| `seed=<int>` | RNG seed (default 1); runs are deterministic per seed |
| `event=<id>` | Trigger an event about 2 s after start |
| `noevents=1` | Turn off automatic random events |
| `cam=iso\|persp` | Start camera mode |
| `az=<deg>` | Base azimuth of the iso camera (default 60) |
| `advance=<min>` | Fast-forward that many sim minutes at start |
| `select=train\|person` | Select the first train or person after about 2.5 s |
| `mute=1` | Start muted |
| `noui=1` | Hide the UI overlay |
| `aa=<0..8>` | MSAA samples for the scene target (default 4, or 0 on software GL) |
| `debug=layout` | Draw the layout: curves, platforms, nav graph, signals, lamps, trees |
| `debug=layout,top&zoom=75&cx=20&cz=-15` | The same plus a top-down orthographic camera |
| `tcam=x,z,halfH[,az,el]` / `tcam=T2,halfH` | Dev close-up camera (fixed point or following a train) |
| `tgallery=1` | Dev: every car type laid out on test tracks |

### `window.__station`

```js
__station.setHour(18.5)
__station.setWeather('storm')
__station.setSpeed(10)
__station.trigger('circus')           // → true if it started
__station.advance(60)                 // simulate 60 sim minutes without rendering → {steps, ms, time, day}
__station.stats()                     // {hour, day, time, weather, trains[], people, activeEvents, shed,
                                      //  fps, updateMs, renderMs, drawCalls, triangles, layoutIssues}
__station.ctx                         // the shared context: scene, renderer, clock, bus, reg (all system APIs), layout…
__station.ctx.reg.maintenance.sendToShed(__station.ctx.reg.trains.list()[0].id)
```

### Screenshot harness

```sh
node scripts/shot.mjs --port 5208 --out shots/mine [--wait 3500] [--advance 30] [--size 1280x800] \
     [--eval "__station.trigger('royal')"] "time=12" "time=22&weather=rain"
```

The harness starts its own Vite server and headless Chromium (SwiftShader). It writes one PNG per query string and prints one JSON line per shot, with the console and page errors and `stats()`. `node scripts/check-layout.mjs` prints and validates the layout.

## Architecture

The stack is TypeScript (strict), Vite and three.js 0.186. Everything is built in code: there are no model or texture files, and the textures are drawn on canvases.

```
src/
  main.ts          renderer, EffectComposer (MSAA target → bloom → output), fixed sub-stepped sim loop, __station
  core/            shared contracts: types, typed event bus, sim clock, seeded RNG, palette, shared materials,
                   layout (track curves, platforms, buildings, nav graph, lamp & tree placement), API interfaces
  atmosphere/      sky dome & colour keys, sun/moon light + shadows, fog, clouds, mist, rain/snow/splashes (GPU),
                   lightning, wetness/snow/night on the shared materials, bloom & exposure
  world/           terrain, track & ballast, platforms, canopies, station building with a working clock,
                   footbridge, gas lamps (pooled point lights), semaphore signals, signal box, garden, engine shed yard
  trains/          rolling stock geometry, liveries, timetable & dispatch, block signalling, dwell/boarding,
                   shed & rescue moves, smoke/steam/sparks, headlamps
  people/          instanced low-poly figures, looks & names, passengers (tickets, waiting, boarding, patience),
                   staff routines, crowds and actors for events
  maintenance/     wear, fuel, breakdowns & rescue, the repair bay and its task list
  events/          event runner (conditions, weights, cooldowns), scripted events, props, effects, the gazette
  camera/          iso orthographic camera (pan/zoom/rotate), perspective orbit mode, follow, picking
  ui/              DOM overlay: clock, stats, shed card, split-flap board, controls, events menu, inspector, gazette
  audio/           procedural WebAudio: chuffs, rail clacks, whistles, bells, the clock chime, rain, wind, crowd, birdsong/crickets, event cues
```

- **Systems:** each directory exports `create<Name>(ctx): System` (`{ name, update(dt, clock) }`) and registers its API on `ctx.reg` (`reg.trains`, `reg.people`, `reg.world`…).
- **Creation order:** atmosphere, world, trains, people, maintenance, events, camera, ui, audio.
- **Communication:** systems talk through those APIs and the typed `ctx.bus` (`train:arrived`, `passenger:boarded`, `event:started`, `audio:cue`…).
- **Clock:** simulation logic runs on `clock.dtSim` (sim minutes) and motion on `clock.dtMotion`. The main loop sub-steps so that one step never exceeds 0.5 sim minutes, which keeps pause, 10×, 60× and `advance()` consistent.
- **Reference:** `CONTRACTS.md` is the full contract. It covers the coordinate conventions, layout numbers, lifecycle, shared-material rules and all later amendments. `src/core/apis.ts` holds the API types.

## Performance

Measured in headless Chromium with SwiftShader (software WebGL) at 1280×800, on a busy 32-thread machine:

| | |
|---|---|
| Frame rate | about 7–8 fps (noon) and about 5–6 fps (night or rain) |
| Draw calls | about 300–330 |
| Triangles | about 440–500k, including the shadow pass |
| CPU per frame | about 1 ms of simulation and 3 ms of render submission |

The rest of each frame is software rasterisation, so a real GPU runs at the display refresh rate. `__station.advance()` simulates 3 sim days in about 0.7 s.

The main savings are:

- repeated objects are instanced or merged per material;
- the bloom pass is skipped by day;
- the pool of real point lights for the gas lamps is small (6), so the other lamps are emissive only;
- a single shadow-casting sun;
- MSAA is off on software GL.

## Known limitations

- The lines are single track and trains run close to capacity, so an event hold or a breakdown spreads delays of 30–150 minutes. Trains average about 15–25 minutes late, and about a fifth to a quarter of passengers give up during those spells.
- "Send to shed" is realistic but slow: the engine finishes its duty, leaves the map and returns as a light engine. It reaches the bay in about 1–2 sim hours.
- An express nearly fills Platform 2, so the engine of a westbound one stands behind the station building in the default view. Rotate (Q/E) or follow the train to see it.
- Motion runs at 1 second per sim minute, so dwell times are only a few real seconds at 1×. Watch boarding at 1× and zoomed in.
- In headless screenshots the split-flap board can be caught mid-flip just after the departures change.
- The Phantom Mail runs at walking pace from the end of the line, so it reaches the station about 50 sim minutes after the event starts.
- Sound needs a user click first, because of the browser autoplay policy.

## Performance

Measured with `node scripts/shot.mjs --gpu --size 1920x1080` (headless Chromium, ANGLE on EGL, AMD Radeon 8060S; auto tier = high):

| view | fps | draw calls | triangles | update / render ms |
|---|---|---|---|---|
| default view, noon | 60 | 202 | 459k | 0.9 / 2.5 |
| storm at night | 60 | 223 | 481k | 0.8 / 2.7 |
| fully zoomed out | 60 | 436 | 991k | 1.4 / 3.6 |
| default view, `--dpr 2` (pixel ratio 2) | 60 | 202 | 460k | – / 2.5 |

On SwiftShader (auto tier = low) the populated default view runs 8–12 fps at 150–200 draw calls and 360–440k triangles.
