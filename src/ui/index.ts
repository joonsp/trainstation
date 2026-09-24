import type { Ctx, System, Weather } from '../core/types';
import { WEATHERS } from '../core/types';
import type { CarType, Departure, EventMeta, PersonInfo, SelectKind, ShedStatus, TrainInfo, TrainState, UIAPI } from '../core/apis';
import { setQualityAndReload, type Tier } from '../core/quality';
import { formatSimTime } from '../core/clock';
import { CSS } from './style';
import { SplitFlapBoard, COLS, type BoardRow } from './board';
import { CAR_LABEL, PAUSE_GLYPH, carIcon, faceGlyph, rotateGlyph, speakerGlyph, weatherGlyph } from './icons';
import { IDLE_NAME, doingPhrase, roleName, placeName, nearTown } from './names';
import { animalCard, boatCard, buildingCard, vehicleCard, type LiveCard } from './cards';
import { createWorldCard } from './worldcard';
import { createMapLabels } from './maplabels';

/*
 * UI overlay — plain DOM in ctx.ui styled as Victorian railway ephemera.
 * Refreshes at ~4 Hz (clock hands a little more often). No frameworks.
 */

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** sim day 0 is Monday 6 June 1887 */
const EPOCH = Date.UTC(1887, 5, 6);
const WX_NAME: Record<Weather, string> = { clear: 'Fair', overcast: 'Overcast', rain: 'Rain', storm: 'Storm', fog: 'Fog', snow: 'Snow' };
const STATE_NAME: Record<TrainState, string> = {
  approaching: 'Approaching', waitingSignal: 'Held at signal', braking: 'Braking', dwelling: 'At the platform',
  departing: 'Departing', running: 'Running', toShed: 'Bound for the shed', inShed: 'In the engine shed',
  fromShed: 'Leaving the shed', broken: 'Broken down!', rescued: 'Under tow',
};
const LINE_NAME = { coast: 'Coast Line', highland: 'Highland Line' } as const;
const LINE_COLOR = { coast: '#7a2230', highland: '#2f5d3a' } as const;
const COND_KEYS = ['boiler', 'brakes', 'wheels', 'coal', 'water'] as const;

const ordinal = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
const FOLLOWABLE = new Set<SelectKind>(['train', 'person', 'vehicle', 'boat', 'animal']);
const TIER_NAME: Record<Tier, string> = { low: 'Low', med: 'Medium', high: 'High' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const condColor = (v: number) => (v > 0.6 ? '#4f7d3a' : v > 0.3 ? '#c08a2a' : '#9a2a2a');

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html) el.innerHTML = html;
  return el;
}

export function createUI(ctx: Ctx): System {
  const { bus, clock, reg } = ctx;
  const root = ctx.ui;
  const safe = <T,>(f: () => T, d: T): T => { try { return f() ?? d; } catch { return d; } };

  const style = document.createElement('style');
  style.id = 'vj-ui-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  // ───────── clock card ─────────
  const clockCard = h('div', 'card vj-clock');
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const q = i % 5 === 0;
    return `<line x1="0" y1="${q ? -19.5 : -21.5}" x2="0" y2="-23.5" stroke="#2a211a" stroke-width="${q ? 1.6 : 0.5}" transform="rotate(${i * 6})"/>`;
  }).join('');
  const numerals = ['XII', 'III', 'VI', 'IX'].map((n, i) => {
    const a = (i * Math.PI) / 2, r = 14.5;
    return `<text x="${(Math.sin(a) * r).toFixed(1)}" y="${(-Math.cos(a) * r + 2.3).toFixed(1)}" text-anchor="middle" font-size="6.2" font-family="IM Fell English SC, serif" fill="#2a211a">${n}</text>`;
  }).join('');
  clockCard.innerHTML = `
    <svg class="vj-dial" viewBox="-32 -32 64 64" aria-hidden="true">
      <defs>
        <radialGradient id="vjBrass" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#f3dc98"/><stop offset=".5" stop-color="#c9a24a"/><stop offset="1" stop-color="#6e531f"/></radialGradient>
        <radialGradient id="vjFace" cx="45%" cy="40%" r="70%"><stop offset="0" stop-color="#fbf5e4"/><stop offset="1" stop-color="#e5d7b4"/></radialGradient>
      </defs>
      <circle r="31" fill="url(#vjBrass)" stroke="#4a3812" stroke-width="1"/>
      <circle r="26.5" fill="none" stroke="#6e531f" stroke-width="1.2"/>
      <circle r="25" fill="url(#vjFace)" stroke="#2a211a" stroke-width=".7"/>
      ${ticks}${numerals}
      <g data-k="hh"><path d="M-1.6 3 L0 -13 L1.6 3 Z" fill="#1f1a14"/></g>
      <g data-k="mh"><path d="M-1.1 4 L0 -21 L1.1 4 Z" fill="#1f1a14"/></g>
      <g data-k="sh"><line y1="5" y2="-21" stroke="#7a2230" stroke-width=".6"/></g>
      <circle r="2" fill="url(#vjBrass)" stroke="#1f1a14" stroke-width=".5"/>
    </svg>
    <div>
      <div class="vj-time" data-k="time">08:00</div>
      <div class="vj-day" data-k="day">Monday</div>
      <div class="vj-date" data-k="date">6th June 1887</div>
    </div>
    <div class="vj-wx" title="Weather">
      <div data-k="wxg"></div>
      <div class="t" data-k="temp">--°</div>
      <div class="n" data-k="wxn">Fair</div>
    </div>`;
  const q = <T extends Element = HTMLElement>(el: Element, k: string) => el.querySelector(`[data-k="${k}"]`) as unknown as T;
  const hourHand = q<SVGGElement>(clockCard, 'hh'), minHand = q<SVGGElement>(clockCard, 'mh'), secHand = q<SVGGElement>(clockCard, 'sh');
  const elTime = q(clockCard, 'time'), elDay = q(clockCard, 'day'), elDate = q(clockCard, 'date');
  const elWxG = q(clockCard, 'wxg'), elTemp = q(clockCard, 'temp'), elWxN = q(clockCard, 'wxn');

  // ───────── stats + yard ─────────
  const statsCard = h('div', 'card vj-stats', `
    <div title="Passengers boarded or alighted today"><b data-k="served">0</b><span>Served today</span></div>
    <div title="Arrivals within a minute of the timetable"><b data-k="ontime">—</b><span>On time</span></div>
    <div title="Engines in or bound for the shed"><b data-k="shed">0</b><span>In shed</span></div>
    <div title="Happenings in progress"><b data-k="events">0</b><span>Events</span></div>`);
  const yardCard = h('div', 'card vj-yard', `
    <h4><span>Engine Shed</span><span class="muted" data-k="pct"></span></h4>
    <div class="task" data-k="task">The shed stands idle.</div>
    <div class="bar" style="margin-top:4px"><i data-k="bar"></i></div>
    <div class="q" data-k="queue"></div>`);

  // ───────── departures board ─────────
  const ROWS = 6;
  const boardEl = h('div', 'vj-board');
  const cw = (n: number) => n * 13 - 1;
  boardEl.innerHTML = `<header><h2>DEPARTURES</h2><span>Victoria Junction</span></header>
    <div class="fl-head"><span style="width:${cw(COLS.time)}px">Time</span><span style="width:${cw(COLS.dest)}px">Destination</span><span style="width:${cw(COLS.plat)}px;text-align:center">P</span><span style="width:${cw(COLS.status)}px">Remarks</span></div>`;
  const board = new SplitFlapBoard(ROWS);
  boardEl.appendChild(board.el);

  // ───────── controls ─────────
  const ctrl = h('div', 'card vj-ctrl');
  ctrl.innerHTML = `
    <div class="row"><label>Time</label>
      <button data-speed="0" title="Pause (Space)">${PAUSE_GLYPH}</button><button data-speed="1" title="1× (1)">1×</button><button data-speed="10" title="10× (2)">10×</button><button data-speed="60" title="60× (3)">60×</button>
    </div>
    <div class="row"><label>Weather</label>
      <select data-k="wx" title="Weather"><option value="auto">Auto (changeable)</option>${WEATHERS.map((w) => `<option value="${w}">${WX_NAME[w]}</option>`).join('')}</select>
      <button data-k="evbtn" title="Happenings & special events">Events ▾</button>
    </div>
    <div class="row"><label>View</label>
      <button data-cam="rotL" title="Rotate left (Q)">${rotateGlyph(-1)}</button><button data-cam="rotR" title="Rotate right (E)">${rotateGlyph(1)}</button>
      <button data-cam="mode" data-k="cammode" title="Toggle isometric / perspective (P)">Persp.</button>
      <button data-cam="follow" data-k="follow" title="Follow selected train (F)">Follow</button>
      <button data-k="mute" title="Sound on/off (M)"></button>
    </div>
    <div class="row"><label>Detail</label>
      <select data-k="tier" title="Graphics detail (reloads the page)">
        <option value="auto">Auto</option><option value="low">Low</option><option value="med">Medium</option><option value="high">High</option>
      </select><span class="tierinfo muted" data-k="tierinfo"></span>
    </div>`;
  const speedBtns = [...ctrl.querySelectorAll<HTMLButtonElement>('[data-speed]')];
  const wxSel = q<HTMLSelectElement>(ctrl, 'wx');
  const evBtn = q<HTMLButtonElement>(ctrl, 'evbtn');
  const camModeBtn = q<HTMLButtonElement>(ctrl, 'cammode');
  const followBtn = q<HTMLButtonElement>(ctrl, 'follow');
  const muteBtn = q<HTMLButtonElement>(ctrl, 'mute');
  const tierSel = q<HTMLSelectElement>(ctrl, 'tier');
  const tierInfo = q(ctrl, 'tierinfo');
  let savedTier: string | null = null;
  try { savedTier = localStorage.getItem('vj.quality'); } catch { /* storage blocked */ }
  const tierForced = ctx.params.raw.get('q') || savedTier;
  tierSel.value = tierForced ? ctx.quality.tier : 'auto';
  tierInfo.textContent = tierForced ? '' : `(${TIER_NAME[ctx.quality.tier]})`;
  tierSel.title = `Graphics detail: ${TIER_NAME[ctx.quality.tier]} (${ctx.quality.reason}). Changing it reloads the page.`;
  tierSel.addEventListener('change', () => {
    const v = tierSel.value;
    if (v === 'auto') {
      try { localStorage.removeItem('vj.quality'); } catch { /* ignore */ }
      const u = new URL(location.href); u.searchParams.delete('q'); location.href = u.toString();
    } else setQualityAndReload(v as Tier);
  });

  const setSpeed = (s: number) => {
    if (s === 0) clock.paused = !clock.paused;
    else { clock.paused = false; clock.timeScale = s; }
    refreshSpeed();
  };
  speedBtns.forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
  wxSel.addEventListener('change', () => {
    const v = wxSel.value;
    try {
      if (v === 'auto') { reg.atmosphere.auto = true; api.toast('The weather is left to Providence.'); }
      else { reg.atmosphere.auto = false; reg.atmosphere.setWeather(v as Weather); }
    } catch (e) { console.warn(e); }
    wxSel.blur();
  });
  ctrl.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) => b.addEventListener('click', () => {
    const cam = reg.camera;
    if (!cam) return;
    switch (b.dataset.cam) {
      case 'rotL': cam.rotateQuarter(-1); break;
      case 'rotR': cam.rotateQuarter(1); break;
      case 'mode': cam.setMode(cam.mode === 'persp' || (cam.mode === 'follow' && camView === 'persp') ? 'iso' : 'persp'); break;
      case 'follow': toggleFollow(); break;
    }
    refreshControls();
  }));
  muteBtn.addEventListener('click', () => toggleMute());

  function toggleMute() {
    const a = reg.audio;
    if (!a) return;
    a.setMuted(!a.muted);
    refreshControls();
  }
  let camView: 'iso' | 'persp' = 'iso';
  function toggleFollow() {
    const cam = reg.camera;
    if (!cam) return;
    if (cam.mode === 'follow') cam.followAny(null, null);
    else if (sel.kind && sel.id && FOLLOWABLE.has(sel.kind)) cam.followAny(sel.kind, sel.id);
    else api.toast('Select a train, traveller, carriage, boat or beast first, then follow it.');
    refreshControls();
  }

  // ───────── events menu ─────────
  const evMenu = h('div', 'card vj-events');
  let evSig = '';
  evBtn.addEventListener('click', () => {
    evMenu.classList.toggle('open');
    evBtn.classList.toggle('on', evMenu.classList.contains('open'));
    if (evMenu.classList.contains('open')) { evSig = ''; refreshEvents(); }
  });
  evMenu.addEventListener('click', (e) => {
    const vb = (e.target as HTMLElement).closest('button[data-view]') as HTMLButtonElement | null;
    if (vb) {
      const pos = safe(() => reg.events.focusOf(vb.dataset.view!), null);
      if (pos) { safe(() => reg.camera.follow(null), undefined); safe(() => reg.camera.focus(pos), undefined); }
      else api.toast('Nothing to see there just yet.');
      return;
    }
    const b = (e.target as HTMLElement).closest('button[data-ev]') as HTMLButtonElement | null;
    if (!b) return;
    const id = b.dataset.ev!;
    const meta = safe(() => reg.events.catalog(), [] as EventMeta[]).find((m) => m.id === id);
    if (meta && !meta.available && !(e as MouseEvent).shiftKey) {
      api.toast(`“${meta.title}” is not possible just now — shift-click to insist.`);
      return;
    }
    const ok = safe(() => reg.events.trigger(id), false);
    api.toast(ok ? `${meta?.title ?? id}: set in motion.` : `${meta?.title ?? id} could not be arranged.`);
    evSig = '';
    refreshEvents();
  });
  function refreshEvents() {
    if (!evMenu.classList.contains('open')) return;
    const cat = safe(() => reg.events.catalog(), [] as EventMeta[]);
    const active = new Set(safe(() => reg.events.active(), [] as { id: string }[]).map((a) => a.id));
    const sig = cat.map((c) => c.id + (c.available ? 1 : 0) + (active.has(c.id) ? 'a' : '')).join('|');
    if (sig === evSig) return;
    evSig = sig;
    evMenu.innerHTML = `<h3>HAPPENINGS</h3><div class="hint">Greyed items await the right conditions — shift-click to insist.</div>` +
      (cat.length ? cat.map((c) => `<div class="ev ${c.available ? '' : 'na'} ${active.has(c.id) ? 'act' : ''}">
        <div class="tx"><div class="tt">${esc(c.title)}</div><div class="bl">${esc(c.blurb)}</div></div>
        ${active.has(c.id) ? `<button data-view="${esc(c.id)}" class="brass" title="Look at it">View</button>` : `<button data-ev="${esc(c.id)}" class="${c.available ? 'brass' : ''}" title="${c.available ? 'Trigger' : 'Shift-click to force'}">Go</button>`}</div>`).join('')
        : `<div class="ev"><div class="tx bl">No happenings are listed today.</div></div>`);
  }

  // ───────── gazette ─────────
  const gazette = h('div', 'vj-gazette', `<div class="mast">THE JUNCTION GAZETTE<i>one penny</i></div><div class="win"><div class="gz-track"></div></div>`);
  const gzTrack = gazette.querySelector('.gz-track') as HTMLDivElement;
  type Headline = { time: string; headline: string; kind: string };
  const headlines: Headline[] = [];
  const seen = new Set<string>();
  let gzDirty = true;
  let showingPlaceholder = false;
  function addHeadline(hl: Headline) {
    if (!hl.headline || seen.has(hl.headline)) return;
    seen.add(hl.headline);
    headlines.push(hl);
    while (headlines.length > 10) { const o = headlines.shift()!; seen.delete(o.headline); }
    gzDirty = true;
    if (!gzTrack.childElementCount || showingPlaceholder) rebuildTicker();
  }
  function rebuildTicker() {
    gzDirty = false;
    showingPlaceholder = !headlines.length;
    const list = headlines.length ? headlines.slice(-8).reverse() : [{ time: clock.format(), headline: 'Victoria Junction opens for the day’s traffic — passengers are requested not to cross the line.', kind: 'info' }];
    gzTrack.innerHTML = list.map((hl) => `<span class="h ${esc(hl.kind)}"><b>${esc(hl.time)}</b>${esc(hl.headline)}</span><span class="fleuron">❦</span>`).join('');
    // restart animation with a duration proportional to width (~70 px/s)
    gzTrack.style.animation = 'none';
    void gzTrack.offsetWidth;
    const w = gzTrack.scrollWidth;
    gzTrack.style.setProperty('--dur', `${Math.max(18, w / 70).toFixed(1)}s`);
    gzTrack.style.animation = '';
  }
  gzTrack.addEventListener('animationiteration', () => { if (gzDirty) rebuildTicker(); });
  bus.on('gazette', (g) => addHeadline({ time: clock.format(), headline: g.headline, kind: g.kind }));
  function pollGazette() {
    const list = safe(() => reg.events.gazette(), [] as Headline[]);
    for (const g of list.slice(-10)) addHeadline(g);
  }

  // ───────── inspect ─────────
  const inspect = h('div', 'card vj-inspect');
  let sel: { kind: SelectKind | null; id: string | null } = { kind: null, id: null };
  let live: LiveCard | null = null;
  let insRefs: Record<string, HTMLElement> = {};
  let selectedPosCache: { x: number; z: number } | null = null;
  let consistSig = '';
  let goneAt = 0;

  function closeInspect() {
    inspect.classList.remove('open');
    sel = { kind: null, id: null };
    insRefs = {};
    live = null;
  }
  function buildTrainPanel(t: TrainInfo) {
    consistSig = '';
    inspect.innerHTML = `<button class="x" data-act="close" title="Close">×</button>
      <div class="plate" data-k="name"></div>
      <dl class="kv">
        <dt>Line</dt><dd data-k="line"></dd>
        <dt>Service</dt><dd data-k="svc"></dd>
        <dt>Timetable</dt><dd data-k="tt"></dd>
        <dt>Status</dt><dd data-k="state"></dd>
        <dt>Speed</dt><dd data-k="speed"></dd>
        <dt>Punctuality</dt><dd data-k="delay"></dd>
        <dt>Passengers</dt><dd><span data-k="pax"></span><div class="bar" style="margin-top:2px"><i data-k="paxbar"></i></div></dd>
      </dl>
      <h5>Condition</h5>
      <div class="cond">${COND_KEYS.map((k) => `<span>${cap(k)}</span><div class="bar"><i data-k="c_${k}"></i></div><em data-k="v_${k}"></em>`).join('')}</div>
      <h5>Consist <span class="muted" style="font-family:var(--serif);letter-spacing:0;font-size:11.5px" data-k="clen"></span></h5>
      <div class="consist" data-k="consist"></div>
      <div class="btns"><button class="brass" data-act="follow" data-k="fbtn">Follow</button><button data-act="shed" data-k="sbtn">Send to shed</button></div>`;
    collectRefs();
    updateTrainPanel(t);
  }
  function updateTrainPanel(t: TrainInfo) {
    const r = insRefs;
    r.name.textContent = t.name;
    r.line.innerHTML = `<span class="pill ${t.line}">${LINE_NAME[t.line]}</span> <span class="muted">${cap(t.kind)}${t.special ? ` · ${esc(cap(t.special))}` : ''}${t.ghost ? ' · spectral' : ''}</span>`;
    r.svc.textContent = `${t.origin} → ${t.destination}`;
    r.tt.textContent = `arr ${formatSimTime(t.scheduledArr)} · dep ${formatSimTime(t.scheduledDep)}`;
    r.state.textContent = STATE_NAME[t.state] ?? t.state;
    if (t.state === 'dwelling') r.state.textContent += t.doorsOpen ? ` (P${t.platform}, doors open)` : ` (P${t.platform})`;
    r.speed.textContent = `${Math.round(t.speed * 2.237)} mph`;
    r.delay.textContent = t.delayMin > 0.5 ? `${Math.round(t.delayMin)} min late` : 'On time';
    r.delay.style.color = t.delayMin > 5 ? '#7a2230' : '';
    r.pax.textContent = `${Math.round(t.passengers)} / ${t.capacity}`;
    const pf = t.capacity > 0 ? t.passengers / t.capacity : 0;
    r.paxbar.style.width = `${Math.min(100, pf * 100)}%`;
    r.paxbar.style.backgroundColor = pf > 0.9 ? '#9a2a2a' : '#2f5d3a';
    for (const k of COND_KEYS) {
      const v = Math.max(0, Math.min(1, t.condition?.[k] ?? 0));
      r['c_' + k].style.width = `${v * 100}%`;
      r['c_' + k].style.backgroundColor = condColor(v);
      r['v_' + k].textContent = `${Math.round(v * 100)}%`;
    }
    const cs = t.cars.join(',') + t.line;
    if (cs !== consistSig) {
      consistSig = cs;
      const body = t.ghost ? '#9ab0b8' : t.special === 'royal' ? '#3a2a5a' : t.kind === 'freight' ? '#5a5048' : LINE_COLOR[t.line];
      r.consist.innerHTML = t.cars.map((c: CarType) => `<span title="${CAR_LABEL[c] ?? c}">${carIcon(c, body)}</span>`).join('');
      r.clen.textContent = `· ${t.cars.length} vehicles, ${Math.round(t.length)} m`;
    }
    const following = reg.camera?.mode === 'follow';
    r.fbtn.textContent = following ? 'Stop following' : 'Follow';
    const shedBound = t.state === 'toShed' || t.state === 'inShed' || t.state === 'fromShed' || t.state === 'rescued';
    const queued = safe(() => { const s = reg.maintenance.status(); return s.bay === t.id || s.queue.includes(t.id); }, false);
    (r.sbtn as HTMLButtonElement).disabled = shedBound || queued || !!t.ghost;
    r.sbtn.textContent = t.state === 'inShed' || safe(() => reg.maintenance.status().bay === t.id, false) ? 'In the shed' : shedBound || queued ? 'Shed booked' : 'Send to shed';
  }
  function buildPersonPanel(p: PersonInfo) {
    inspect.innerHTML = `<button class="x" data-act="close" title="Close">×</button>
      <div class="plate p" data-k="name"></div>
      <div class="face"><span data-k="face"></span><div><div class="sc" data-k="role"></div><div class="muted" data-k="moodtx" style="font-style:italic;font-size:12.5px"></div></div></div>
      <dl class="kv" style="margin-top:4px">
        <dt>Bound for</dt><dd data-k="dest"></dd>
        <dt>Doing</dt><dd data-k="state"></dd>
        <dt data-k="homel">Lives at</dt><dd data-k="home"></dd>
        <dt>Patience</dt><dd><div class="bar" style="margin-top:4px"><i data-k="pat"></i></div></dd>
        <dt>Umbrella</dt><dd data-k="umb"></dd>
      </dl>
      <div class="btns"><button class="brass" data-act="follow" data-k="fbtn">Follow</button><button data-act="focus">Look closer</button></div>`;
    collectRefs();
    updatePersonPanel(p);
  }
  const STATION_INFO: Record<string, [string, string]> = {
    building: ['Victoria Junction', 'Booking hall, waiting rooms and the stationmaster\'s office, beneath the clock tower. Erected 1861 in the Italianate manner.'],
    platforms: ['The Platforms', 'Platform 1 serves the Coast Line (Brightmouth – Kingsport); Platform 2 the Highland Line (Ashby Vale – Glenmoor).'],
    canopies: ['Platform Canopies', 'Ridge-and-furrow glazing on cast-iron columns, with dagger-board valances.'],
    footbridge: ['The Footbridge', 'A lattice-girder bridge joining the two platforms across the wedge.'],
    shed: ['Engine Shed', 'Locomotives are coaled, watered and repaired here.'],
    signalbox: ['Junction Signal Box', 'Controls the home signals on both lines.'],
  };
  function buildStationPanel(id: string) {
    const [title, blurb] = STATION_INFO[id] ?? [cap(id), ''];
    inspect.innerHTML = `<button class="x" data-act="close" title="Close">×</button>
      <div class="plate" data-k="name"></div>
      <div class="muted" style="font-style:italic;font-size:12.5px;margin:4px 0 6px">${esc(blurb)}</div>
      <dl class="kv" data-k="facts"></dl>`;
    collectRefs();
    insRefs.name.textContent = title;
    updateStationPanel(id);
  }
  function updateStationPanel(id: string) {
    const r = insRefs;
    if (!r.facts) return;
    const rows: [string, string][] = [];
    const trains = safe(() => reg.trains.list(), [] as TrainInfo[]);
    if (id === 'building' || id === 'platforms' || id === 'canopies' || id === 'footbridge') {
      rows.push(['Folk about', String(safe(() => reg.people.count(), 0))]);
      if (id === 'building' || id === 'platforms') {
        rows.push(['Mean lateness', svc.arrivals ? `${(svc.lateSum / svc.arrivals).toFixed(1)} min over ${svc.arrivals} arrivals` : 'No arrivals yet']);
        const tot = svc.boarded + svc.gaveUp;
        rows.push(['Gave up', tot ? `${((svc.gaveUp / tot) * 100).toFixed(1)}% (${svc.gaveUp} of ${tot})` : 'Nobody yet']);
      }
      for (const pl of [1, 2] as const) {
        const t = trains.find((x) => x.platform === pl && x.state === 'dwelling');
        rows.push([`Platform ${pl}`, t ? `${t.name} to ${t.destination}` : 'Clear']);
      }
    }
    if (id === 'shed') {
      const st = safe(() => reg.maintenance.status(), { bay: null, queue: [], progress: 0, task: '' } as ShedStatus);
      const nm = (tid: string | null) => (tid ? safe(() => reg.trains.get(tid)?.name, undefined) ?? tid : '—');
      rows.push(['In the bay', nm(st.bay)]);
      if (st.bay) rows.push(['Task', `${st.task} (${Math.round(st.progress * 100)}%)`]);
      rows.push(['Queue', st.queue.length ? st.queue.map(nm).join(', ') : 'None']);
    }
    if (id === 'signalbox' || id === 'platforms') {
      for (const line of ['coast', 'highland'] as const) {
        const a = (end: 'east' | 'west') => safe(() => reg.world.getSignal(line, end), 'stop');
        rows.push([`${LINE_NAME[line]} signals`, `E ${a('east')} · W ${a('west')}`]);
      }
    }
    const html = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    if (r.facts.innerHTML !== html) r.facts.innerHTML = html;
  }
  let lastMoodBand = -1;
  function updatePersonPanel(p: PersonInfo) {
    const r = insRefs;
    r.name.textContent = p.name;
    const band = Math.round(p.mood * 8);
    if (band !== lastMoodBand) { lastMoodBand = band; r.face.innerHTML = faceGlyph(p.mood); }
    r.role.textContent = roleName(p.role);
    r.moodtx.textContent = p.mood > 0.8 ? 'Delighted' : p.mood > 0.6 ? 'Content' : p.mood > 0.4 ? 'Composed' : p.mood > 0.2 ? 'Vexed' : 'Thoroughly cross';
    r.dest.innerHTML = p.destination ? `${esc(p.destination)}${p.line ? ` <span class="pill ${p.line}">${LINE_NAME[p.line]}</span>` : ''}` : '<span class="muted">—</span>';
    let doing = doingPhrase(p.role, String(p.state ?? ''));
    if (p.riding) doing = `Riding ${ridingName(p.riding)}`;
    else if (p.idle && IDLE_NAME[p.idle] && !/walk|board|run/i.test(p.state)) doing = IDLE_NAME[p.idle];
    r.state.textContent = doing;
    const homeB = p.home ? ctx.layout.buildings.find((b) => b.id === p.home) : undefined;
    r.home.textContent = homeB ? placeName(ctx, `door:${homeB.id}:0`) : p.role === 'passenger' ? 'A traveller' : '—';
    const following = reg.camera?.mode === 'follow';
    if (r.fbtn) r.fbtn.textContent = following ? 'Stop following' : 'Follow';
    const pat = p.patience > 1 ? Math.min(1, p.patience / 60) : Math.max(0, p.patience);
    r.pat.style.width = `${pat * 100}%`;
    r.pat.style.backgroundColor = condColor(pat);
    r.umb.textContent = p.umbrella ? 'Yes, unfurled' : 'No';
  }
  function ridingName(anchor: string): string {
    const v = safe(() => reg.traffic.get(anchor), undefined);
    if (v) return `the ${v.label || v.kind}`;
    const b = safe(() => reg.nature.boat(anchor), undefined);
    if (b) return `the boat ${b.name}`;
    const t = safe(() => reg.trains.get(anchor), undefined);
    if (t) return t.name;
    return 'a conveyance';
  }
  function collectRefs() {
    insRefs = {};
    inspect.querySelectorAll<HTMLElement>('[data-k]').forEach((el) => { insRefs[el.dataset.k!] = el; });
  }
  inspect.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!b) return;
    switch (b.dataset.act) {
      case 'close': bus.emit('select', { kind: null, id: null }); break;
      case 'follow': toggleFollow(); refreshInspect(); break;
      case 'shed':
        if (sel.id) {
          try { reg.maintenance.sendToShed(sel.id); api.toast(`${reg.trains.get(sel.id)?.name ?? 'The train'} is booked into the engine shed.`); } catch (err) { console.warn(err); }
          refreshInspect();
        }
        break;
      case 'focus': {
        const cam = reg.camera as typeof reg.camera | undefined;
        const pos = selectedPos();
        if (cam && pos) {
          const z = sel.kind === 'person' || sel.kind === 'animal' ? 4 : sel.kind === 'building' ? 2.6 : 3;
          if (cam.lookAt) cam.lookAt(pos, Math.max(cam.zoom ?? 1, z)); else cam.focus(pos);
        }
        break;
      }
    }
  });
  function selectedPos() {
    const id = sel.id;
    if (!id) return null;
    switch (sel.kind) {
      case 'person': return safe(() => reg.people.get(id)?.position, null);
      case 'train': return safe(() => reg.trains.get(id)?.position, null);
      case 'vehicle': return safe(() => reg.traffic.get(id)?.pos, null);
      case 'boat': return safe(() => reg.nature.boat(id)?.pos, null);
      case 'animal': return safe(() => reg.nature.get(id)?.pos, null);
      case 'building': return ctx.layout.buildings.find((b) => b.id === id)?.center ?? null;
      default: return null;
    }
  }
  bus.on('select', (s) => {
    if (!s.kind || !s.id) { closeInspect(); return; }
    sel = { kind: s.kind, id: s.id };
    live = null;
    goneAt = 0;
    lastMoodBand = -1;
    if (s.kind === 'vehicle' || s.kind === 'boat' || s.kind === 'animal' || s.kind === 'building') {
      const mk = s.kind === 'vehicle' ? vehicleCard : s.kind === 'boat' ? boatCard : s.kind === 'animal' ? animalCard : buildingCard;
      live = safe(() => mk(ctx, s.id!), null);
      if (!live) { closeInspect(); return; }
      inspect.innerHTML = live.html;
      collectRefs();
      safe(() => live!.update(insRefs), false);
      updateFollowBtn();
    } else if (s.kind === 'train') {
      const t = safe(() => reg.trains.get(s.id!), undefined);
      if (!t) { closeInspect(); return; }
      buildTrainPanel(t);
    } else if (s.kind === 'station') {
      buildStationPanel(s.id);
    } else {
      const p = safe(() => reg.people.get(s.id!), undefined);
      if (!p) { closeInspect(); return; }
      buildPersonPanel(p);
    }
    inspect.classList.remove('open');
    void inspect.offsetWidth;
    inspect.classList.add('open');
    refreshControls();
  });
  function updateFollowBtn() {
    if (!insRefs.fbtn) return;
    insRefs.fbtn.textContent = reg.camera?.mode === 'follow' ? 'Stop following' : 'Follow';
  }
  function refreshInspect() {
    if (!sel.id || !inspect.classList.contains('open')) return;
    if (sel.kind === 'station') { updateStationPanel(sel.id); return; }
    if (live) {
      if (safe(() => live!.update(insRefs), false)) { updateFollowBtn(); return; }
      if (!goneAt) {
        goneAt = performance.now();
        if (insRefs.state) insRefs.state.textContent = live.gone || 'Gone';
      } else if (performance.now() - goneAt > 2500) bus.emit('select', { kind: null, id: null });
      return;
    }
    if (sel.kind === 'train') {
      const t = safe(() => reg.trains.get(sel.id!), undefined);
      if (t) { updateTrainPanel(t); return; }
    } else {
      const p = safe(() => reg.people.get(sel.id!), undefined);
      if (p) { selectedPosCache = p.position.clone(); updatePersonPanel(p); return; }
    }
    // selection vanished
    if (!goneAt) {
      goneAt = performance.now();
      if (insRefs.state) insRefs.state.textContent = sel.kind === 'train' ? 'Gone beyond the district' : (() => { const p = selectedPosCache; const t = p ? nearTown(ctx, p.x, p.z) : ''; return t ? `Gone indoors, ${t}` : 'Gone on their way'; })();
    } else if (performance.now() - goneAt > 2500) bus.emit('select', { kind: null, id: null });
  }

  // ───────── toasts ─────────
  const toasts = h('div', 'vj-toasts');
  let lastToast = '', lastToastAt = 0;
  const api: UIAPI = {
    toast(msg: string) {
      const now = performance.now();
      if (msg === lastToast && now - lastToastAt < 1500) return;
      lastToast = msg; lastToastAt = now;
      const t = h('div', 'toast');
      t.textContent = msg;
      toasts.appendChild(t);
      while (toasts.childElementCount > 4) toasts.firstElementChild?.remove();
      setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 520); }, 3800);
    },
  };
  ctx.reg.ui = api;

  // ───────── help ─────────
  const help = h('div', 'card vj-help');
  const k = (keys: string, what: string) => `<div class="k"><span>${what}</span><span>${keys.split(' ').map((x) => `<kbd>${x}</kbd>`).join(' ')}</span></div>`;
  help.innerHTML = `<h2>VICTORIA JUNCTION</h2><div class="sub">Regulations for the Conduct of Visitors</div><div class="rule"></div>
    <div class="cols"><div>
      ${k('Drag', 'Pan the view')}${k('W A S D', 'Pan (or arrows)')}${k('Wheel', 'Zoom toward cursor')}${k('Q E', 'Rotate 90°')}${k('R', 'Reset view')}${k('P', 'Iso / perspective')}
    </div><div>
      ${k('Click', 'Inspect anything')}${k('F', 'Follow selected')}${k('Dbl-click', 'Follow it at once')}${k('Esc', 'Stop following / close')}${k('Space', 'Pause / resume')}${k('1 2 3', '1× · 10× · 60×')}${k('M', 'Sound on / off')}${k('U', 'Hide all panels')}${k('? H', 'This card')}
    </div></div>
    <div class="foot">By Order of the Directors · a steam whistle sounds after your first click</div>`;
  const helpBtn = h('button', 'vj-helpbtn', '?');
  helpBtn.title = 'Help (?)';
  helpBtn.addEventListener('click', () => help.classList.toggle('open'));
  help.addEventListener('click', () => help.classList.remove('open'));

  const worldCard = createWorldCard(ctx);
  const mapLabels = createMapLabels(ctx);
  root.append(mapLabels.el, clockCard, statsCard, yardCard, worldCard.el, boardEl, ctrl, evMenu, gazette, inspect, toasts, help, helpBtn);
  if (ctx.params.noui) root.classList.add('vj-hidden');

  // ───────── keyboard ─────────
  let lastCamMode = 'iso';
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    switch (e.key) {
      case '?': case 'h': case 'H': help.classList.toggle('open'); break;
      case 'u': case 'U': root.style.display = ''; root.classList.toggle('vj-hidden'); break;
      case ' ': e.preventDefault(); setSpeed(0); break;
      case '1': setSpeed(1); break;
      case '2': setSpeed(10); break;
      case '3': setSpeed(60); break;
      case 'm': case 'M': toggleMute(); break;
      case 'Escape':
        if (help.classList.contains('open')) help.classList.remove('open');
        else if (evMenu.classList.contains('open')) { evMenu.classList.remove('open'); evBtn.classList.remove('on'); }
        else if (lastCamMode !== 'follow' && sel.id) bus.emit('select', { kind: null, id: null });
        break;
    }
  });

  // ───────── stats tracking ─────────
  let served = 0, arrivals = 0, onTime = 0, statDay = clock.day;
  /** session service figures for the station card (same definitions as __station.stats().service) */
  const svc = { arrivals: 0, lateSum: 0, boarded: 0, gaveUp: 0 };
  bus.on('train:arrived', (e) => { svc.arrivals++; svc.lateSum += Math.max(0, e.lateMin); });
  bus.on('passenger:boarded', () => { svc.boarded++; });
  bus.on('passenger:gaveUp', () => { svc.gaveUp++; });
  bus.on('passenger:boarded', () => { served++; });
  bus.on('passenger:alighted', () => { served++; });
  bus.on('train:arrived', (e) => { arrivals++; if (e.lateMin <= 2) onTime++; });
  bus.on('event:started', (e) => api.toast(e.title));
  bus.on('train:breakdown', (e) => {
    const t = safe(() => reg.trains.get(e.trainId), undefined);
    api.toast(`${t?.name ?? 'A train'} has broken down!`);
  });
  bus.on('ready', () => { pollGazette(); rebuildTicker(); refreshAll(); });

  // ───────── refresh ─────────
  function refreshSpeed() {
    for (const b of speedBtns) {
      const s = Number(b.dataset.speed);
      b.classList.toggle('on', s === 0 ? clock.paused : !clock.paused && clock.timeScale === s);
    }
  }
  function refreshControls() {
    refreshSpeed();
    const cam = reg.camera;
    if (cam) {
      if (cam.mode !== 'follow') camView = cam.mode;
      camModeBtn.textContent = camView === 'persp' ? 'Isometric' : 'Persp.';
      followBtn.classList.toggle('on', cam.mode === 'follow');
      followBtn.disabled = !(sel.kind && sel.id && FOLLOWABLE.has(sel.kind)) && cam.mode !== 'follow';
      followBtn.title = cam.mode === 'follow' ? 'Stop following (F)' : 'Follow the selected train, traveller, carriage, boat or beast (F)';
      lastCamMode = cam.mode;
    }
    const muted = safe(() => reg.audio.muted, false);
    muteBtn.innerHTML = speakerGlyph(muted);
    muteBtn.classList.toggle('on', muted);
    muteBtn.title = muted ? 'Sound is off (M)' : 'Sound is on (M)';
    if (document.activeElement !== wxSel) {
      const atm = reg.atmosphere;
      wxSel.value = atm ? (atm.auto ? 'auto' : atm.target ?? atm.weather) : 'auto';
    }
  }

  let lastMin = -1, lastSec = -1;
  function refreshClock() {
    const mins = clock.minutes;
    const sec = Math.floor((mins % 1) * 60);
    const mTot = Math.floor(mins % 1440);
    if (mTot !== lastMin) {
      lastMin = mTot;
      const hh = Math.floor(mTot / 60), mm = mTot % 60;
      elTime.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      hourHand.setAttribute('transform', `rotate(${((hh % 12) + mm / 60) * 30})`);
      minHand.setAttribute('transform', `rotate(${mm * 6})`);
      const d = new Date(EPOCH + clock.day * 86400000);
      elDay.textContent = DAYS[clock.weekday] ?? '';
      elDate.textContent = `${ordinal(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }
    if (sec !== lastSec) { lastSec = sec; secHand.setAttribute('transform', `rotate(${sec * 6})`); }
  }

  let wxSig = '';
  function refreshWeather() {
    const atm = reg.atmosphere;
    if (!atm) return;
    const night = (atm.nightFactor ?? 0) > 0.5;
    const s = atm.weather + night;
    if (s !== wxSig) { wxSig = s; elWxG.innerHTML = weatherGlyph(atm.weather, night); elWxN.textContent = WX_NAME[atm.weather] ?? atm.weather; }
    elTemp.textContent = `${Math.round(atm.temperatureC ?? 12)}°C`;
  }

  function refreshBoard() {
    const tt = safe(() => reg.trains.timetable(ROWS), [] as Departure[]);
    const rows: (BoardRow | null)[] = [];
    for (let i = 0; i < ROWS; i++) {
      const d = tt[i];
      if (!d) { rows.push(null); continue; }
      const st = d.status ?? '';
      const m = /Delayed\s+(\d+)/i.exec(st);
      const status = m ? `Late ${m[1]} min` : st;
      const tone = /Cancel/i.test(st) ? 'bad' : m ? 'late' : /Board/i.test(st) ? 'board' : /Depart/i.test(st) ? 'gone'
        : d.trainId && safe(() => reg.trains.get(d.trainId!)?.kind === 'special', false) ? 'special' : '';
      rows.push({ time: formatSimTime(d.time), dest: d.destination, plat: String(d.platform), status, tone, title: `${d.name} — ${LINE_NAME[d.line]}` });
    }
    board.setRows(rows);
    boardEmpty.style.display = tt.length ? 'none' : 'block';
  }
  const boardEmpty = h('div', 'empty', 'No departures posted.');
  boardEl.appendChild(boardEmpty);

  function refreshStats() {
    if (clock.day !== statDay) { statDay = clock.day; served = 0; arrivals = 0; onTime = 0; }
    q(statsCard, 'served').textContent = String(served);
    q(statsCard, 'ontime').textContent = arrivals ? `${Math.round((onTime / arrivals) * 100)}%` : '—';
    const st = safe(() => reg.maintenance.status(), { bay: null, queue: [], progress: 0, task: '' });
    const trains = safe(() => reg.trains.list(), [] as TrainInfo[]);
    const inShed = new Set<string>([...(st.bay ? [st.bay] : []), ...st.queue]);
    for (const t of trains) if (t.state === 'toShed' || t.state === 'inShed' || t.state === 'rescued') inShed.add(t.id);
    q(statsCard, 'shed').textContent = String(inShed.size);
    q(statsCard, 'events').textContent = String(safe(() => reg.events.active().length, 0));
    // yard
    const bayName = st.bay ? safe(() => reg.trains.get(st.bay!)?.name, undefined) ?? st.bay : null;
    q(yardCard, 'task').innerHTML = bayName ? `<b class="sc">${esc(bayName)}</b> — ${esc(st.task || 'in the bay')}` : esc(st.task && st.task !== 'idle' ? st.task : 'The shed stands idle; fitters take tea.');
    const pr = Math.max(0, Math.min(1, st.progress || 0));
    const bar = q(yardCard, 'bar');
    bar.style.width = `${bayName ? pr * 100 : 0}%`;
    bar.style.backgroundColor = '#8d6c2c';
    q(yardCard, 'pct').textContent = bayName ? `${Math.round(pr * 100)}%` : '';
    q(yardCard, 'queue').textContent = st.queue.length
      ? `Waiting: ${st.queue.map((id) => safe(() => reg.trains.get(id)?.name, undefined) ?? id).join(', ')}`
      : 'No engines waiting.';
  }

  function refreshAll() {
    refreshClock();
    refreshWeather();
    refreshBoard();
    refreshStats();
    refreshControls();
    refreshInspect();
    refreshEvents();
    pollGazette();
    worldCard.update();
    checkFps();
  }

  // ───────── low-fps offer ─────────
  let frames = 0, fpsT0 = performance.now(), slowSince = 0, offered = false;
  const countFrame = () => { frames++; requestAnimationFrame(countFrame); };
  requestAnimationFrame(countFrame);
  function checkFps() {
    const now = performance.now();
    if (now - fpsT0 < 2000) return;
    const fps = (frames * 1000) / (now - fpsT0);
    frames = 0; fpsT0 = now;
    if (offered || ctx.quality.tier === 'low' || document.hidden) return;
    if (fps < 24) { if (!slowSince) slowSince = now; } else slowSince = 0;
    if (slowSince && now - slowSince > 8000) {
      offered = true;
      const lower: Tier = ctx.quality.tier === 'high' ? 'med' : 'low';
      offerToast(`The engine labours at ${Math.round(fps)} frames a second.`, `Lower detail (${TIER_NAME[lower]})`, () => setQualityAndReload(lower));
    }
  }
  function offerToast(msg: string, label: string, act: () => void) {
    const t = h('div', 'toast offer');
    t.textContent = msg + ' ';
    const b = h('button', 'brass', esc(label));
    b.addEventListener('click', act);
    const x = h('button', '', 'No thanks');
    x.addEventListener('click', () => t.remove());
    t.append(b, x);
    toasts.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 520); }, 15000);
  }

  let lastRefresh = 0, lastClock = 0, lastLab = 0;
  return {
    name: 'ui',
    update() {
      const now = performance.now();
      if (now - lastClock > 60) { lastClock = now; refreshClock(); }
      if (now - lastLab > 30) { lastLab = now; mapLabels.update(); }
      if (now - lastRefresh > 250) {
        lastRefresh = now;
        refreshAll();
      }
    },
    dispose() { style.remove(); },
  };
}
