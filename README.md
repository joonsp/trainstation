# Victoria Junction

A small, living Victorian railway junction and its countryside in three.js, 1887. It is shown in an isometric view by default, with a flat-shaded, low-poly look in a restrained period palette (brick red, cream stone, slate, bottle green and crimson lake).

Two single-track lines split at the station and run off in different directions:

- the **Coast Line** (Brightmouth – Kingsport, Platform 1);
- the **Highland Line** (Ashby Vale – Glenmoor, Platform 2).

Around the station lies a working valley: the River Ashbourne with its weir, lock, mill, boathouse and bridges, the market town of Ashcombe, the villages of Millbridge, Wyke, Coldharbour, Glenmoor and Eastcote, farms and fields, lanes, a level crossing and an engine shed.

Everything runs on its own, and **nothing pops in or out of existence**. Every person, horse, vehicle, boat and animal enters the map at a legitimate origin: a road, footpath or river leaving the edge of the map, a rail tunnel, a building door, a train door, a stopped vehicle or a moored boat. **Nothing alive stands still**: people shift their weight, check pocket watches, read newspapers and chat, horses stamp and swish their tails, and parked vehicles come and go.

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
| Click | Inspect anything: a train, person, vehicle, boat, animal, town building or station building |
| F / double-click | Follow the selection (Esc stops) |
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
- **Departures board** (top right): a split-flap board with the next six departures, platforms, and remarks such as delays, *Boarding*, *Approaching*, *Not in service* and *Cancelled*.
- **Map labels:** town, river and landmark names float over the countryside when zoomed out.
- **Control bar** (bottom left):
  - **Time:** pause, 1×, 10× and 60×.
  - **Weather:** Auto or a fixed weather.
  - **Events menu:** every event with its conditions. Trigger any event, or press "View" on a running one to fly the camera to it.
  - **View:** rotate, iso/perspective, follow and mute.
  - **Graphics:** Auto, Low, Medium or High detail (changing it reloads the page). If the frame rate stays low, a toast offers a lower tier.
- **Inspector card** (right, when something is selected):
  - **Train:** service, timetable, status, speed, punctuality, load, a condition bar for each part (boiler, brakes, wheels, coal, water), a consist strip, and **Follow** and **Send to shed** buttons (with the ETA to the bay).
  - **Person:** name, role, home, destination, what they are doing, mood and patience.
  - **Vehicle, boat, animal:** what it is, who drives or rides it, where it is going.
  - **Building:** town buildings (residents, trade, who is in) and station buildings (shed bay, trains at each platform, signal states).
- **The Junction Gazette** (bottom ticker): period headlines for arrivals, delays, weather, events and complaints.

## What happens

### The railway

- **Timetable:** each line runs roughly one train an hour in each direction by day: expresses, stopping trains and goods. At night there is a mail train and a goods train. The lines are single track, so trains wait at the home signals for the block. Specials (the circus, the Royal Train) are fitted into gaps in the timetable.
- **Trains:** engines come from a pool of named locomotives (tank engines, express engines with tenders) with coaches, mail vans, dining cars, goods wagons and guard's vans. Smoke and steam puffs, sparks at night, headlamps and hissing cylinder cocks. Crimson lake for the Coast Line, bottle green for the Highland Line. Westbound Highland trains stop far enough east that the engine is never hidden behind the station building.
- **Boarding:** doors stay open at least 3 minutes at every stop, and a train holds its doors while its committed boarders reach them. Passengers who cannot make it let the train go and rebook instead of sprinting for a closing door.
- **Maintenance:** boiler, brakes and wheels wear with every run, faster in bad weather; coal and water burn. A worn engine finishes its duty, comes back along the shed road as a light engine, is repaired in the single bay (fitters, welding sparks, a task list), and takes on coal and water. An engine run into the ground breaks down and is rescued by a tank engine.
- **Send to shed** (Inspector): the train is taken out of service at once (its passengers rebook), diverts at the switch or returns along the shed road as a light engine, and the shed gang hurries the job in the bay. The ETA shown includes any repair in progress and engines queued ahead. Typical latency is 6–40 sim minutes.
- **Level crossing:** at Millbridge Gates a keeper swings the gates across the road for each train; carts queue at the stop line. At night the gates stay shut to the road and the keeper opens them by lantern for each cart.

### People

- **Passengers** come from somewhere: by cab, omnibus, carrier's cart, gig or the rare horseless carriage, on foot along the roads, footpaths and towpath from the map edge, or from the houses of Ashcombe and the villages. Station-side houses supply only a few, limited by their residents. Travellers plan their trip from the timetable, queue at the booking office, wait (benches in the rain, under the canopies), board and alight. Arrivals leave by cab, omnibus or on foot.
- **Station staff:** porters with barrows, the stationmaster, a booking clerk, a newsboy, lamp men, signalmen, the shed gang.
- **Town and country:** lamplighters light the gas lamps at dusk (each on a short round from their own door), the postman does his round, the baker pushes his handcart, the milkman does his float round, the Monday washerwoman hangs out the washing, drinkers go to the pub, children go to school and play, farmhands, shepherds and dairymaids work the farms, anglers fish from their pegs, the vicar visits.
- **Lifecycles:** people leave through the door, vehicle or portal they belong to. Waiting and working figures are always animated, and nobody is left standing about indefinitely (a backstop sends forgotten actors home).

### Traffic

The Crown Mews depot sends out hansoms and growlers to the cab rank, an omnibus that meets the trains, carriers, drays, coal carts, farm carts, haywains, the milk float, the mail cart, gigs, bicycles and penny-farthings. Vehicles drive on the left along the road network, queue behind one another, give way when pulling out, stop at the crossing gates, and pick up and set down their riders at the kerb. Horses trot, nod, stamp and swish their tails.

### The river and the country

- **River Ashbourne:** flowing water with ripples, rain rings, lamp reflections at night, mist on cold mornings and fog, ice creeping in from the banks in hard frost (the whole river freezes for the Frost Fair).
- **Boats:** the steam launch *Kingfisher* runs short pleasure trips from its mooring, rowing boats and punts go out from the boathouse, and the narrowboat *Perseverance* comes down from Glenmoor behind her tow horse, lies at the mill-pool mooring, or works through Millbridge Lock with the lock-keeper.
- **Wildlife and livestock:** ducks, swans, a heron, geese and hens, sheep and cows grazing and moved between fields by drovers and dogs, flocks of rooks and starlings, swallows in summer.
- **Wind:** trees, hedges, crops (with travelling gust bands), washing lines, flags and bunting, smoke and the windmill sails move with the wind, which rises with the weather.
- **Towns:** textured slate, tile and thatch roofs, brick coursing, setts; chimneys smoke when the fire is lit, windows light up in the evening, shops put out awnings, St Mary's strikes the hours and rings for weddings and alarms.

### Weather and day/night

Clear, overcast, rain, storm (with lightning), fog and snow. Each changes the sky, fog, light, wetness (darker, glossier materials and rain splashes), snow cover on roofs and ground, particles, wind, sound and people's behaviour (umbrellas, hurrying, sheltering). The sun and moon move, dusk and dawn have their own colour keys with a warm golden-hour fill, and at night the gas lamps, lit windows, signal lamps and bloom come on.

## Random events

Events fire by themselves when their conditions hold (time of day, weekday, weather, season, cooldowns). You can also trigger them from the **Events** menu.

| id | Event |
|---|---|
| `goose` | **Runaway Goose:** a market goose escapes onto a platform, pursued by a porter. |
| `cat` | **Cat on the Line:** the stationmaster's cat naps on the track; trains are held until a porter carries it off. |
| `cow` | **Cow on the Line:** a cow wanders out of Shed Meadow onto the Coast Line until the farmer shoos her home. |
| `circus` | **The Circus Comes to Town:** a circus special calls; Duchess the elephant parades along the platform. |
| `royal` | **Royal Visit:** the Royal Train calls, with bunting, a red carpet, cheering crowds and a fanfare. |
| `wedding` | **Wedding Party:** wedding bells at St Mary's; the newly-weds arrive by landau in a flurry of confetti to catch the train. |
| `bandConcert` | **Brass Band Concert:** the Railwaymen's band marches out of the Railway Arms to play on the forecourt, mostly on Sundays. |
| `signalStrike` | **Lightning Strike:** lightning disables a signal in a storm; a fitter repairs it. |
| `ghost` | **The Phantom Mail:** in the small hours and thick fog, a spectral train glides through without stopping and the gas lamps gutter (it passes the platforms 12–24 min after the event starts). |
| `snowdrift` | **Snowdrift:** a drift blocks a line and a gang of platelayers digs it out. |
| `balloon` | **Balloon Landing:** a striped balloon drifts in and lands in Shed Meadow; its aeronauts go home by train. |
| `pickpocket` | **Stop, Thief!:** a pickpocket works the forecourt crowd; a constable gives chase. |
| `lostLuggage` | **Lost Luggage:** a trunk is left behind on a platform; its owner returns for it by cab. |
| `lostDog` | **Lost Dog:** a terrier slips its lead and bolts through the station; the newsboy saves the day. |
| `motorwagen` | **The Horseless Carriage:** Herr and Frau Benz motor in from Kingsport; horses shy, a crowd gathers, and the machine backfires. |
| `runaway` | **Runaway Horse!:** an express whistle startles the apple-cart horse on the forecourt; the constable catches the bridle. |
| `sheep` | **Sheep at the Gates:** a drover's flock fills Millbridge level crossing; the trains wait while the collie clears it. |
| `rickFire` | **Rick Fire:** a hay rick catches at Coldharbour Farm: the alarm bell, a bucket chain from the pond and the steam fire engine from Ashcombe. |
| `kite` | **Kite Day:** on a blowy afternoon the children fly kites on Eastcote Down, and one gets away. |
| `market` | **Market Day:** Thursday market on Ashcombe square: traders carry in and put up their stalls, carts deliver, the auctioneer rings. |
| `fete` | **Village Fete:** Millbridge fete on the green: maypole dancing, the tea table, a coconut shy and a tug-of-war. |
| `regatta` | **Ashbourne Regatta:** bunting, crowds on both banks and two fours racing down the Kingsmead reach (summer Saturdays). |
| `angling` | **Angling Match:** the Piscatorial Society fish from their pegs; splashes, catches and a weigh-in. |
| `swan` | **Swan Chases Angler:** a cob swan takes exception to an angler, who beats a hasty retreat up the bank. |
| `frostFair` | **Frost Fair:** the river has frozen hard: skaters, sliding children and a chestnut brazier on the ice. |

## Quality tiers

The graphics tier is detected once at startup: `?q=low|med|high` overrides, then a tier saved from the UI (localStorage `vj.quality`), then software GL (SwiftShader, llvmpipe) gets **low**, then ≤ 4 CPU cores, ≤ 4 GB device memory or a mobile browser gets **med**, and everything else gets **high**. The knobs live in `src/core/quality.ts`.

| | low | med | high |
|---|---|---|---|
| render path | direct, no bloom | composer, MSAA 2, bloom at night | composer, MSAA 4, bloom at night |
| pixel ratio cap | 1 | 1.25 | 2 |
| shadows | 1024 PCF, buildings/trains/vehicles | 2048 PCF, + trees and animals near the focus | 2048 soft PCF, everything |
| point-light pool | 3 | 6 | 8 |
| detail textures (slate, brick, setts, planks, thatch, furrows) | off | on | on |
| water | flat with flow tint | ripples, rain rings, lamp streaks, mist | two ripple layers, more streaks |
| crops | painted rows with wind gust bands | 3D rows swaying in the wind | denser rows |
| caps: people / vehicles / boats / birds | 240 / 11 / 3 / 40 | 360 / 14 / 6 / 120 | 440 / 20 / 9 / 250 |

On med and high, main.ts lowers only the pixel ratio if the frame rate stays under 24 fps after 8 s.

## Performance

Real GPU (`node scripts/shot.mjs --gpu --size 1920x1080`, headless Chromium, ANGLE on EGL, AMD Radeon 8060S, populated view 30 sim minutes after start):

| view | tier | fps | draw calls | triangles | update / render CPU ms |
|---|---|---|---|---|---|
| default view, noon | low | 60 | 139 | 280k | 0.9 / 1.8 |
| default view, noon | med | 60 | 160 | 421k | 1.3 / 2.5 |
| default view, noon | high (auto) | 60 | 160 | 438k | 1.3 / 2.6 |
| storm at night | high | 60 | 182 | 454k | 0.9 / 2.9 |
| whole map (zoomed out) | low | 60 | 344 | 567k | 1.3 / 3.2 |
| whole map (zoomed out) | high | 60 | 428 | 1.09M | 1.8 / 4.2 |

SwiftShader (software WebGL, 1280×800, auto tier = low): 12–15 fps in the default view at 140–145 draw calls and 290–315k triangles. Forcing `?q=high` on SwiftShader drops to about 3 fps. `__station.advance()` simulates a sim day in a few seconds.

The main savings are: static scenery merged per material and chunked for culling; instanced people, horses, vehicles, animals, birds and reeds with shader-driven limb, wind and idle animation; a small pooled set of point lights (`ctx.lights.claim`) with emissive meshes elsewhere; one shadow-casting sun; distance and zoom based dithered culling of small life; coarse 2 Hz simulation far from the view focus.

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
| `q=low\|med\|high` | Force a quality tier |
| `cam=iso\|persp` | Start camera mode |
| `az=<deg>` | Base azimuth of the iso camera (default 60) |
| `cx=<x>&cz=<z>[&zoom=<z>]` | Frame an iso close-up on a ground point |
| `advance=<min>` | Fast-forward that many sim minutes at start |
| `select=train\|person` | Select the first train or person after about 2.5 s |
| `ice=<0..1>` | Force the river ice level |
| `mute=1` | Start muted |
| `noui=1` | Hide the UI overlay |
| `aa=<0..8>` | MSAA samples for the composer target (med/high) |
| `debug=layout` | Draw the layout: curves, platforms, nav graph, signals, lamps, trees |
| `debug=layout,top&zoom=75&cx=20&cz=-15` | The same plus a top-down orthographic camera |
| `debug=popins` | Log every visible spawn/despawn that is not at a legitimate origin |
| `tcam=x,z,halfH[,az,el]` / `tcam=T2,halfH` | Dev close-up camera (fixed point or following a train) |
| `tgallery=1` | Dev: every car type laid out on test tracks |

### `window.__station`

```js
__station.setHour(18.5)
__station.setWeather('storm')
__station.setSpeed(10)
__station.trigger('market')           // → true if it started
__station.advance(60)                 // simulate 60 sim minutes without rendering → {steps, ms, time, day}
__station.stats()                     // {hour, day, time, weather, trains[], people, vehicles, horses, boats, animals,
                                      //  birds, activeEvents, shed, fps, updateMs, renderMs, drawCalls, triangles,
                                      //  tier, tierReason, pixelRatio, popIns, popInsOffscreen, lightClaims,
                                      //  service {arrivals, meanLateMin, maxLateMin, boarded, gaveUp, giveUpRate}}
__station.perf()                      // draw calls / triangles / shadow casters per top-level scene group
__station.ctx                         // the shared context: scene, renderer, clock, bus, reg (all system APIs), layout…
__station.ctx.reg.maintenance.sendToShed(__station.ctx.reg.trains.list()[0].id)
```

### Screenshot harness

```sh
node scripts/shot.mjs --port 5208 --out shots/mine [--wait 3500] [--advance 30] [--size 1280x800] [--gpu] [--dpr 2] \
     [--eval "__station.trigger('royal')"] "time=12" "time=22&weather=rain"
```

The harness starts its own Vite server and headless Chromium (SwiftShader, or the real GPU with `--gpu`). It writes one PNG per query string and prints one JSON line per shot, with the console and page errors and `stats()`. `node scripts/check-layout.mjs` prints and validates the layout; `scripts/core-selftest.js` checks the core services.

## Architecture

The stack is TypeScript (strict), Vite and three.js 0.186. Everything is built in code: there are no model or texture files, and the textures are drawn on canvases or generated as data textures.

```
src/
  main.ts          renderer, quality tier, render path (direct or composer + bloom), fixed sub-stepped sim loop,
                   point-light pool resolve, program pre-compile, __station
  core/            shared contracts: API types, typed event bus, sim clock, seeded RNG, palette, shared materials,
                   layout.ts (station, tracks, platforms, nav) and countryside.ts (terrain, river, bridges, roads,
                   towns, fields, paths, portals, walking graph), quality tiers, view, wind, detail textures,
                   light pool, origins registry (no-pop-in audit), shader chaining, road movers, instanced rigs
  atmosphere/      sky dome & colour keys, sun/moon light + shadows, golden-hour fill, fog, clouds, mist,
                   rain/snow/splashes (GPU), lightning, wetness/snow/night on the shared materials, river ice, bloom
  world/           terrain, track & ballast, platforms, canopies, station building with a working clock, footbridge,
                   gas lamps, signals, signal box, engine shed yard, the river banks, weir, lock and mill, bridges,
                   roads, town buildings with doors, chimneys and washing lines, trees, hedges, the windmill
  nature/          river water shader, boats and the lock, the narrowboat's tow horse, herds and drovers,
                   waterfowl, birds, crops and reeds in the wind, chimney smoke
  traffic/         road vehicles and horses, the Crown Mews depot, the forecourt loop, cab rank and omnibus stand,
                   passenger trip requests, the Millbridge level crossing
  trains/          rolling stock geometry, liveries, timetable & dispatch, block signalling, dwell/boarding,
                   shed road & rescue moves, smoke/steam/sparks, headlamps, train-door origins
  people/          instanced low-poly figures and idle animations, looks & names, passengers (trip planning, tickets,
                   waiting, boarding, patience), station staff, town and country routines, actors for events
  maintenance/     wear, fuel, breakdowns & rescue, the repair bay and its task list
  events/          event runner (conditions, weights, cooldowns), 25 scripted events, props, effects, the gazette
  camera/          iso orthographic camera (pan/zoom/rotate), perspective orbit mode, follow anything, picking,
                   occluder fading (station, canopies, footbridge, shed roof)
  ui/              DOM overlay: clock, stats, shed card, split-flap board, controls, events menu, inspector,
                   world card, map labels, gazette, toasts
  audio/           procedural WebAudio: chuffs, rail clacks, whistles, bells, hooves, wheels, the river, the mill,
                   crowds, birdsong, event cues
```

- **Systems:** each directory exports `create<Name>(ctx): System` (`{ name, update(dt, clock) }`) and registers its API on `ctx.reg` (`reg.trains`, `reg.people`, `reg.traffic`, `reg.nature`…).
- **Creation order:** atmosphere, world, nature, trains, traffic, people, maintenance, events, camera, ui, audio.
- **Communication:** systems talk through those APIs and the typed `ctx.bus` (`train:arrived`, `passenger:boarded`, `vehicle:arrived`, `crossing:state`, `boat:moored`, `event:started`, `audio:cue`…).
- **Clock:** simulation logic runs on `clock.dtSim` (sim minutes) and motion on `clock.dtMotion`. The main loop sub-steps so that one step never exceeds 0.5 sim minutes, which keeps pause, 10×, 60× and `advance()` consistent.
- **No pop-in:** every spawn and despawn calls `ctx.origins.audit(...)`. `stats().popIns` counts visible violations (it is 0), and `?debug=popins` logs them.
- **Reference:** `CONTRACTS.md` is the full contract (coordinate conventions, layout numbers, lifecycle, shared-material rules, the v2 services and all amendments). `docs/V2_DESIGN.md` is the v2 plan (map, budgets, per-system scope). `src/core/apis.ts` holds the API types.

## Service figures

From 3-day soaks (`__station.advance`, seeds 1 and 7, with a manual "Send to shed" every 8 sim hours):

| | |
|---|---|
| mean lateness at the platforms | 2.5–3.1 min (Coast 4–5, Highland ~1; worst 20–25 min) |
| passengers who give up | 0.9–1.8 % (9–15 of 830–1,030 boardings) |
| Send to shed → engine in the bay | 10–43 sim min (median ≈ 20); the ETA shown is usually within 5 min |
| visible pop-ins | 0 |

## Known limitations

- Motion runs at 1 second per sim minute, so walking is slow in sim time: 100 m takes about 74 sim minutes. Countryside journeys (a narrowboat crossing the map, a farmhand walking home, the fire engine coming from Ashcombe) take sim hours. At 1× this is a few real minutes.
- The shed has a single bay and the shed road holds one engine at a time: an engine sent to the shed while another is being repaired waits off the map until the bay is free, so a second "Send to shed" can take the length of the (hurried) repair job.
- In headless screenshots the split-flap board can be caught mid-flip just after the departures change.
- Sound needs a user click first, because of the browser autoplay policy.
