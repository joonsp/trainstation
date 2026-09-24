import type { CarType } from '../core/apis';
import type { Weather } from '../core/types';

/** Small inline SVG glyphs drawn in an engraved, ink-on-paper style. */

const INK = '#2a211a';

export function weatherGlyph(w: Weather, night: boolean): string {
  const sun = night
    ? `<path d="M19 6a8 8 0 1 0 7 11 6.5 6.5 0 0 1-7-11z" fill="#e8dcc0" stroke="${INK}" stroke-width="1.4"/>`
    : `<g stroke="${INK}" stroke-width="1.4"><circle cx="16" cy="14" r="5.5" fill="#e3b54a"/>${[0, 45, 90, 135, 180, 225, 270, 315]
      .map((a) => `<line x1="16" y1="4.5" x2="16" y2="2" transform="rotate(${a} 16 14)"/>`).join('')}</g>`;
  const cloud = (fill = '#d9d2c2', y = 0) =>
    `<path d="M9 ${24 + y}h15a5 5 0 0 0 0-10 7 7 0 0 0-13-1 5 5 0 0 0-2 11z" fill="${fill}" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>`;
  let inner = '';
  switch (w) {
    case 'clear': inner = sun; break;
    case 'overcast': inner = `<g transform="translate(-3 -4) scale(.8)">${sun}</g>${cloud()}`; break;
    case 'rain': inner = cloud('#b9b7b0', -3) + `<g stroke="#3d5a6c" stroke-width="1.6" stroke-linecap="round"><line x1="11" y1="24" x2="9" y2="29"/><line x1="17" y1="24" x2="15" y2="29"/><line x1="23" y1="24" x2="21" y2="29"/></g>`; break;
    case 'storm': inner = cloud('#8e8c88', -3) + `<path d="M17 21l-4 6h4l-2 5 6-8h-4l2-3z" fill="#e3b54a" stroke="${INK}" stroke-width="1"/>`; break;
    case 'fog': inner = cloud('#d9d2c2', -4) + `<g stroke="${INK}" stroke-width="1.4" stroke-linecap="round" opacity=".8"><line x1="5" y1="25" x2="27" y2="25"/><line x1="8" y1="29" x2="24" y2="29"/></g>`; break;
    case 'snow': inner = cloud('#e8e8ea', -3) + `<g fill="${INK}"><circle cx="10" cy="26" r="1.2"/><circle cx="16" cy="29" r="1.2"/><circle cx="22" cy="26" r="1.2"/><circle cx="13" cy="31" r="1"/><circle cx="20" cy="31" r="1"/></g>`; break;
  }
  return `<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">${inner}</svg>`;
}

/** Face glyph: mood 0 (cross) .. 1 (delighted). */
export function faceGlyph(mood: number): string {
  const m = Math.max(0, Math.min(1, mood));
  const curve = (m - 0.5) * 9;
  const brow = m < 0.3 ? `<path d="M8 9.5l3 1.2M20 9.5l-3 1.2" stroke="${INK}" stroke-width="1.3" stroke-linecap="round"/>` : '';
  const fill = m > 0.66 ? '#f1d9a8' : m > 0.33 ? '#eadcc0' : '#e7c3b0';
  return `<svg viewBox="0 0 28 28" width="30" height="30" aria-hidden="true"><circle cx="14" cy="14" r="11.5" fill="${fill}" stroke="${INK}" stroke-width="1.5"/>
  <circle cx="10" cy="12" r="1.4" fill="${INK}"/><circle cx="18" cy="12" r="1.4" fill="${INK}"/>${brow}
  <path d="M8.5 18 Q14 ${18 + curve} 19.5 18" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}

export function speakerGlyph(muted: boolean): string {
  return `<svg viewBox="0 0 20 16" width="16" height="13" aria-hidden="true"><path d="M2 5h3l4-3.5v13L5 11H2z" fill="currentColor"/>${muted
    ? '<path d="M12.5 5l5 6M17.5 5l-5 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
    : '<path d="M12 5.5a3.5 3.5 0 0 1 0 5M14.5 3a7 7 0 0 1 0 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'}</svg>`;
}

/** Side-on consist silhouette, 30×14 units. */
export function carIcon(type: CarType, body: string): string {
  const wheels = (xs: number[]) => xs.map((x) => `<circle cx="${x}" cy="12" r="1.9" fill="${INK}"/>`).join('');
  let g = '';
  switch (type) {
    case 'loco_express':
    case 'loco_tank':
      g = `<rect x="3" y="4.5" width="17" height="6" rx="3" fill="${body}" stroke="${INK}" stroke-width=".8"/>
        <rect x="5.5" y="1" width="2.6" height="4" fill="${INK}"/><rect x="11" y="2.8" width="2.4" height="2" rx="1" fill="#c9a24a"/>
        <rect x="19" y="2" width="8" height="8.5" fill="${body}" stroke="${INK}" stroke-width=".8"/><rect x="21" y="3.5" width="4" height="3" fill="#e8dcc0"/>
        <rect x="18" y="1.2" width="10" height="1.4" fill="${INK}"/>
        ${type === 'loco_express' ? wheels([6, 12, 17.5, 24]) : wheels([7, 13, 19, 24])}`;
      break;
    case 'tender':
      g = `<rect x="4" y="4" width="22" height="6.5" fill="${body}" stroke="${INK}" stroke-width=".8"/><path d="M5 4l3-2.2h14l3 2.2z" fill="#2a2a2c"/>${wheels([8, 15, 22])}`;
      break;
    case 'coach_first': case 'coach_second': case 'coach_third': case 'dining': case 'royal_saloon': case 'guard': case 'mail': {
      const win = type === 'mail' || type === 'guard' ? `<rect x="${type === 'guard' ? 20 : 12}" y="4.4" width="5" height="3" fill="#e8dcc0"/>`
        : [5, 9.5, 14, 18.5, 23].map((x) => `<rect x="${x}" y="4.4" width="2.8" height="3" fill="${type === 'dining' ? '#ffcf7a' : '#e8dcc0'}"/>`).join('');
      g = `<path d="M1.5 3.5Q15 .6 28.5 3.5V10.5H1.5z" fill="${body}" stroke="${INK}" stroke-width=".8"/>${win}
        ${type === 'coach_first' || type === 'royal_saloon' ? `<line x1="2" y1="8.8" x2="28" y2="8.8" stroke="#c9a24a" stroke-width=".8"/>` : ''}${wheels([6, 10, 20, 24])}`;
      break;
    }
    case 'wagon_coal':
      g = `<rect x="3" y="5" width="24" height="5.5" fill="${body}" stroke="${INK}" stroke-width=".8"/><path d="M4 5q5-3 11-1 6-2 11 1z" fill="#2a2a2c"/>${wheels([8, 22])}`;
      break;
    case 'wagon_box':
      g = `<rect x="3" y="2.5" width="24" height="8" fill="${body}" stroke="${INK}" stroke-width=".8"/><path d="M13 3v7M17 3v7M13 3l4 7M17 3l-4 7" stroke="${INK}" stroke-width=".6"/>${wheels([8, 22])}`;
      break;
    case 'wagon_tank':
      g = `<rect x="3" y="3.5" width="24" height="6.5" rx="3.2" fill="${body}" stroke="${INK}" stroke-width=".8"/><rect x="13.5" y="1.8" width="3" height="2" fill="${INK}"/>${wheels([8, 22])}`;
      break;
    case 'wagon_flat':
      g = `<rect x="3" y="8" width="24" height="2.5" fill="${body}" stroke="${INK}" stroke-width=".8"/><rect x="7" y="5" width="9" height="3" fill="#7a5a3c"/>${wheels([8, 22])}`;
      break;
    case 'circus_cage':
      g = `<rect x="3" y="2.5" width="24" height="8" fill="#e0b84a" stroke="${INK}" stroke-width=".8"/>${[6, 9, 12, 15, 18, 21, 24].map((x) => `<line x1="${x}" y1="3" x2="${x}" y2="10" stroke="#7a2230" stroke-width="1"/>`).join('')}${wheels([8, 22])}`;
      break;
  }
  return `<svg viewBox="0 0 30 14" width="36" height="17" aria-hidden="true"><line x1="0" y1="13.9" x2="30" y2="13.9" stroke="${INK}" stroke-width=".5" opacity=".4"/>${g}</svg>`;
}

export const CAR_LABEL: Record<CarType, string> = {
  loco_express: 'Express locomotive', loco_tank: 'Tank engine', tender: 'Tender',
  coach_first: 'First class', coach_second: 'Second class', coach_third: 'Third class', dining: 'Dining car',
  mail: 'Mail van', guard: "Guard's van", wagon_coal: 'Coal wagon', wagon_box: 'Box van', wagon_tank: 'Tank wagon',
  wagon_flat: 'Flat wagon', circus_cage: 'Circus cage', royal_saloon: 'Royal saloon',
};

export const PAUSE_GLYPH = `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><rect x="2" y="1.5" width="2.8" height="9" fill="currentColor"/><rect x="7.2" y="1.5" width="2.8" height="9" fill="currentColor"/></svg>`;

export function rotateGlyph(dir: 1 | -1): string {
  const flip = dir === -1 ? '' : ' transform="translate(16 0) scale(-1 1)"';
  return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><g${flip}><path d="M3.2 9.5A5 5 0 1 0 5 4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M2.2 1.8l.9 4.3 4.1-1.3z" fill="currentColor"/></g></svg>`;
}
