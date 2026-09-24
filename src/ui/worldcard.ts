import type { Ctx } from '../core/types';
import type { LampInfo } from '../core/apis';
import { beaufort, esc, windFrom } from './names';

/**
 * The small "World" card: wind (Beaufort), the river's state, what the towns are about (market day, church,
 * wash day, the pub filling…), the lamplighter's progress at dusk and a count of life abroad.
 * Everything is derived from shared state (ctx.wind, atmosphere, world.lamps, nature/traffic stats, the clock and
 * 'town:day' / 'town:bell' bus hooks), so it keeps working while other systems are still stubs.
 */
const safe = <T,>(f: () => T, d: T): T => { try { return f() ?? d; } catch { return d; } };
const STORE = 'vj.ui.worldOpen';

type DayKind = 'washday' | 'dray' | 'drover' | 'market' | 'regatta' | 'sunday' | 'ordinary';
let heardDay: { day: number; kind: DayKind } | null = null;
let bellUntil = 0;

function dayKind(ctx: Ctx): DayKind {
  const c = ctx.clock;
  if (heardDay && heardDay.day === c.day) return heardDay.kind;
  return (['washday', 'dray', 'drover', 'market', 'dray', 'regatta', 'sunday'] as DayKind[])[c.weekday] ?? 'ordinary';
}

/** one short line about what a town is doing right now */
export function townActivity(ctx: Ctx, town: string): string {
  const h = ctx.clock.hour, wd = ctx.clock.weekday, kind = dayKind(ctx);
  const pub = town === 'ashcombe' ? 'The Crown' : town === 'millbridge' ? "The Miller's Arms" : town === 'wyke' ? 'The Plough' : town === 'station' ? 'The Railway Arms' : '';
  const church = town === 'ashcombe' ? "St Mary's" : town === 'wyke' ? "St Peter's" : town === 'millbridge' ? 'Bethel Chapel' : '';
  if (h >= 23 || h < 4.5) return pub && h < 23.5 ? `${pub} calls time` : 'All abed; the lamps burn on';
  if (h < 6) return town === 'ashcombe' ? "Hobbs' ovens are lit" : 'Cockcrow; first chimneys smoke';
  if (performance.now() < bellUntil && church) return `The bells of ${church} are ringing`;
  if (wd === 6) {
    if (church && h >= 10.25 && h < 10.5) return `Bells ring for service at ${church}`;
    if (church && h >= 10.5 && h < 11.75) return `Morning service at ${church}`;
    if (church && h >= 18 && h < 19) return `Evensong at ${church}`;
    return h < 13 ? 'A quiet Sunday morning' : 'Sunday strollers about';
  }
  if (town === 'ashcombe' && kind === 'market' && h >= 7.5 && h < 16) return 'Market day: stalls crowd the square';
  if (kind === 'washday' && h >= 7 && h < 14 && (town === 'millbridge' || town === 'wyke' || town === 'station' || town === 'ashcombe')) return 'Wash day: the lines are full';
  if (kind === 'dray' && h >= 10 && h < 13 && pub) return `The brewer's dray calls at ${pub}`;
  if (kind === 'drover' && (town === 'glenmoor' || town === 'wyke') && h >= 7 && h < 15) return 'Drovers bring flocks down the drove';
  if (kind === 'regatta' && (town === 'millbridge' || town === 'river' || town === 'ashcombe') && h >= 13.5 && h < 18) return 'Regatta on the Ashbourne';
  if (pub && h >= 18) return `${pub} is filling up`;
  if (town === 'ashcombe' && h >= 10.5 && h < 10.75 && wd < 5) return 'Playtime in the schoolyard';
  if (town === 'ashcombe' && h >= 9 && h < 16 && wd < 5) return 'School in; shops open, carts about';
  if ((town === 'coldharbour' || town === 'eastcote' || town === 'glenmoor') && h >= 6.5 && h < 17.5) return h >= 12 && h < 13 ? "Farmhands at their lunch" : 'Hands at work in the fields';
  if (town === 'wyke' && h >= 6 && h < 19) return 'The post mill turns; the smithy rings';
  if (town === 'millbridge' && h >= 6 && h < 18) return 'The mill wheel turns; the dairy busy';
  return h < 9 ? 'The day begins' : h < 18 ? 'Folk about their business' : 'Lamps lit, suppers on';
}

function riverState(ctx: Ctx): { text: string; tone: string } {
  const atm = safe(() => ctx.reg.atmosphere, null);
  const ice = Math.max(safe(() => ctx.reg.nature.river.ice, 0), atm?.iceAmount ?? 0);
  const mist = Math.max(atm?.dawnMist ?? 0, (atm?.fog ?? 0) * 0.8);
  const rain = atm?.rain ?? 0, wet = atm?.wetness ?? 0;
  if (ice >= 0.9) return { text: 'Frozen hard: skating on the reach', tone: 'ice' };
  if (ice >= 0.25) return { text: 'Ice creeping from the margins', tone: 'ice' };
  if (mist > 0.35) return { text: 'Mist lies on the water', tone: 'mist' };
  if (rain > 0.6 && wet > 0.6) return { text: 'Running high and brown', tone: 'spate' };
  if (rain > 0.1) return { text: 'Rain rings on the water', tone: '' };
  return { text: 'Flowing gently to the weir', tone: '' };
}

const arrow = (deg: number) => `<svg viewBox="-8 -8 16 16" width="15" height="15" aria-hidden="true" style="transform:rotate(${deg.toFixed(0)}deg);vertical-align:-3px"><path d="M0 -6.5 L3.6 3.5 L0 1.4 L-3.6 3.5 Z" fill="#7a2230" stroke="#2a211a" stroke-width=".6"/></svg>`;

export function createWorldCard(ctx: Ctx) {
  const el = document.createElement('div');
  el.className = 'card vj-world';
  // starts collapsed (it sits over the station's west end at 1024-1280 px); remembered once the user opens it
  let open = false;
  try { open = localStorage.getItem(STORE) === '1'; } catch { /* storage blocked */ }
  el.classList.toggle('closed', !open);
  el.innerHTML = `<h4 data-act="toggle" title="Show / hide"><span>The Country</span><span class="muted" data-k="sum"></span></h4>
    <dl class="wk">
      <dt>Wind</dt><dd data-k="wind"></dd>
      <dt>River</dt><dd data-k="river"></dd>
      <dt>Towns</dt><dd data-k="towns"></dd>
      <dt>Lamps</dt><dd data-k="lamps"></dd>
      <dt>Abroad</dt><dd data-k="life"></dd>
    </dl>`;
  const r: Record<string, HTMLElement> = {};
  el.querySelectorAll<HTMLElement>('[data-k]').forEach((x) => { r[x.dataset.k!] = x; });
  el.querySelector('[data-act="toggle"]')!.addEventListener('click', () => {
    open = !open;
    el.classList.toggle('closed', !open);
    try { localStorage.setItem(STORE, open ? '1' : '0'); } catch { /* ignore */ }
  });
  const set = (k: string, html: string) => { const e = r[k]; if (e && e.innerHTML !== html) e.innerHTML = html; };

  ctx.bus.on('town:day', (e) => { heardDay = { day: ctx.clock.day, kind: e.kind }; });
  ctx.bus.on('town:bell', (e) => { if (e.kind !== 'hour') bellUntil = performance.now() + 20000; });

  function update() {
    // wind
    const ms = ctx.wind.speed;
    const bf = beaufort(ms);
    const w = safe(() => ctx.reg.atmosphere.wind, null);
    const from = w ? windFrom(w.x, w.y) : '';
    const deg = w && Math.hypot(w.x, w.y) > 1e-3 ? (Math.atan2(w.x, -w.y) * 180) / Math.PI : 0; // arrow points where the wind blows (north up)
    const gusty = ctx.wind.uniforms.uGustAmt.value > 0.6 && bf.force >= 3;
    set('wind', `${bf.force > 0 && from ? arrow(deg) : ''} ${esc(bf.name)}${from && bf.force > 0 ? `, ${from}` : ''} <span class="muted">· F${bf.force}${gusty ? ', gusty' : ''}</span>`);
    set('sum', `F${bf.force}`);
    // river
    const rs = riverState(ctx);
    set('river', `<span class="tone ${rs.tone}">${esc(rs.text)}</span>`);
    // towns: Ashcombe always, plus the liveliest village
    const a = townActivity(ctx, 'ashcombe');
    const others = ['millbridge', 'wyke', 'coldharbour'].map((t) => [t, townActivity(ctx, t)] as const).filter(([, s]) => s !== a);
    const special = others.find(([, s]) => /Regatta|Wash|dray|Drovers|service|Bells|Evensong|filling/.test(s)) ?? others[0] ?? ['millbridge', townActivity(ctx, 'millbridge')] as const;
    const tn = special[0] === 'millbridge' ? 'Millbridge' : special[0] === 'wyke' ? 'Wyke' : 'Coldharbour';
    set('towns', `<b class="sc">Ashcombe</b> ${esc(a)}<br><b class="sc">${tn}</b> ${esc(special[1])}`);
    // lamps / lamplighter
    const lamps = safe(() => ctx.reg.world.lamps(), [] as LampInfo[]);
    const lit = lamps.reduce((n, l) => n + ((l.lit ?? 0) > 0.5 ? 1 : 0), 0);
    const gloom = safe(() => ctx.reg.atmosphere.gloom, safe(() => ctx.reg.atmosphere.nightFactor, 0));
    const lighter = safe(() => ctx.reg.people.stats().byRole.lamplighter ?? 0, 0);
    if (!lamps.length) set('lamps', '<span class="muted">—</span>');
    else if (lit === 0 && gloom < 0.3) set('lamps', '<span class="muted">Out for the day</span>');
    else {
      const f = lit / lamps.length;
      const who = lit < lamps.length && (lighter > 0 || gloom > 0.3) ? (lighter > 0 ? 'The lamplighter is on his round' : 'Dusk: lamps being lit') : lit === lamps.length ? 'All lamps lit' : 'Being put out';
      set('lamps', `${esc(who)} <span class="muted">${lit}/${lamps.length}</span><div class="bar" style="margin-top:2px"><i style="width:${(f * 100).toFixed(0)}%;background:#c08a2a"></i></div>`);
    }
    // life abroad
    const tv = safe(() => ctx.reg.traffic.stats(), { vehicles: 0, horses: 0, byKind: {} });
    const nv = safe(() => ctx.reg.nature.stats(), { animals: 0, birds: 0, boats: 0, byKind: {} });
    const folk = safe(() => ctx.reg.people.count(), 0);
    const bits = [`${folk} folk`, `${tv.vehicles} carriage${tv.vehicles === 1 ? '' : 's'}`, `${nv.boats} boat${nv.boats === 1 ? '' : 's'}`, `${nv.animals + nv.birds} beasts &amp; birds`];
    if (tv.byKind?.motorwagen) bits.push('<b style="color:#7a2230">a motorwagen!</b>');
    set('life', bits.join(' · '));
  }
  return { el, update };
}
