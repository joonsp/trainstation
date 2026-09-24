import * as THREE from 'three';

export const SERIF = `Georgia, 'Times New Roman', 'Noto Serif', 'DejaVu Serif', 'Liberation Serif', serif`;

/** UV rect [u0, v0, u1, v1] (v up, three convention) */
export type UV = [number, number, number, number];

export interface SignAtlas {
  texture: THREE.CanvasTexture;
  nameBoard: UV;
  num1: UV;
  num2: UV;
  posters: UV[];
  facade: UV;
  booking: UV;
  shed: UV;
  signalBox: UV;
  toCoast: UV;
  toHighland: UV;
  timetable: UV;
}

const ATLAS = 1024;

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  return [c, g];
}

/** canvas px rect → UV (canvas y is down) */
function uvOf(x: number, y: number, w: number, h: number): UV {
  // inset 1.5 px so mipmaps / filtering never bleed a neighbouring cell into the board edge
  const p = 1.5;
  return [(x + p) / ATLAS, 1 - (y + h - p) / ATLAS, (x + w - p) / ATLAS, 1 - (y + p) / ATLAS];
}

function board(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, bg: string, border: string, text: string, fg: string, size: number, opts: { italic?: boolean; spacing?: number; sub?: string } = {}) {
  g.fillStyle = border;
  g.fillRect(x, y, w, h);
  const b = Math.max(4, Math.round(h * 0.08));
  g.fillStyle = bg;
  g.fillRect(x + b, y + b, w - 2 * b, h - 2 * b);
  // fine inner lining
  g.strokeStyle = fg; g.globalAlpha = 0.5; g.lineWidth = Math.max(1, b * 0.3);
  g.strokeRect(x + b * 1.8, y + b * 1.8, w - b * 3.6, h - b * 3.6);
  g.globalAlpha = 1;
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${opts.italic ? 'italic ' : ''}bold ${size}px ${SERIF}`;
  const cy = opts.sub ? y + h * 0.42 : y + h / 2 + size * 0.04;
  if (opts.spacing) {
    // manual letter spacing
    const chars = [...text];
    const widths = chars.map((c) => g.measureText(c).width);
    const total = widths.reduce((a, b2) => a + b2, 0) + opts.spacing * (chars.length - 1);
    const scale = Math.min(1, (w - 9 * b) / total); // (clear of the frame the 3D board adds over the edge)
    let cx = x + w / 2 - (total * scale) / 2;
    g.save();
    g.translate(cx, cy); g.scale(scale, 1); g.translate(-cx, -cy);
    for (let i = 0; i < chars.length; i++) { g.textAlign = 'left'; g.fillText(chars[i], cx, cy); cx += widths[i] + opts.spacing; }
    g.restore();
  } else {
    const tw = g.measureText(text).width;
    const scale = Math.min(1, (w - 9 * b) / tw);
    g.save(); g.translate(x + w / 2, cy); g.scale(scale, 1); g.fillText(text, 0, 0); g.restore();
  }
  if (opts.sub) {
    g.font = `italic ${Math.round(size * 0.45)}px ${SERIF}`;
    g.fillText(opts.sub, x + w / 2, y + h * 0.76);
  }
}

function poster(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, i: number) {
  const designs = [
    { bg: '#d9c9a0', band: '#2f5d3a', title: 'BRIGHTMOUTH', mid: 'ON-SEA', foot: 'Bracing Air · Golden Sands', art: 'sea' },
    { bg: '#e6d8b8', band: '#7a2230', title: 'GLENMOOR', mid: 'HIGHLANDS', foot: 'By the Highland Line', art: 'hills' },
    { bg: '#2f3e46', band: '#c9a24a', title: "PEMBERTON'S", mid: 'Tonic Elixir', foot: 'Cures Fatigue & Gloom', art: 'bottle' },
    { bg: '#efe6cf', band: '#3a3f4f', title: 'KINGSPORT', mid: 'EXHIBITION', foot: 'Excursion Fares Daily', art: 'tower' },
    { bg: '#7a2230', band: '#e8dcc0', title: 'FOGG & SONS', mid: 'Umbrellas', foot: 'For Every Weather', art: 'umbrella' },
    { bg: '#e8dcc0', band: '#1f2e27', title: 'ASHBY VALE', mid: 'Cheese Fair', foot: 'Saturdays in Summer', art: 'hills' },
  ];
  const d = designs[i % designs.length];
  g.fillStyle = '#1f2e27'; g.fillRect(x, y, w, h);
  g.fillStyle = d.bg; g.fillRect(x + 6, y + 6, w - 12, h - 12);
  g.fillStyle = d.band; g.fillRect(x + 6, y + 6, w - 12, h * 0.2);
  const light = d.bg === '#2f3e46' || d.bg === '#7a2230';
  g.fillStyle = light ? '#e8dcc0' : d.band === '#e8dcc0' ? '#7a2230' : '#e8dcc0';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold ${Math.round(w * 0.13)}px ${SERIF}`;
  g.fillStyle = d.band === '#e8dcc0' || d.band === '#c9a24a' ? '#1f2e27' : '#e8dcc0';
  g.fillText(d.title, x + w / 2, y + h * 0.11, w - 20);
  // art
  const ax = x + w / 2, ay = y + h * 0.5;
  g.save();
  if (d.art === 'sea') {
    g.fillStyle = '#9ec3d6'; g.fillRect(x + 14, y + h * 0.25, w - 28, h * 0.22);
    g.fillStyle = '#e0936a'; g.beginPath(); g.arc(ax, y + h * 0.42, w * 0.12, Math.PI, 0); g.fill();
    g.fillStyle = '#3d5a6c'; g.fillRect(x + 14, y + h * 0.47, w - 28, h * 0.1);
    g.fillStyle = '#e9d9a0'; g.fillRect(x + 14, y + h * 0.57, w - 28, h * 0.08);
  } else if (d.art === 'hills') {
    g.fillStyle = '#9ec3d6'; g.fillRect(x + 14, y + h * 0.25, w - 28, h * 0.4);
    g.fillStyle = '#56733c'; g.beginPath(); g.moveTo(x + 14, y + h * 0.65); g.lineTo(x + w * 0.35, y + h * 0.33); g.lineTo(x + w * 0.6, y + h * 0.55); g.lineTo(x + w * 0.8, y + h * 0.38); g.lineTo(x + w - 14, y + h * 0.5); g.lineTo(x + w - 14, y + h * 0.65); g.fill();
    g.fillStyle = '#f2f4f7'; g.beginPath(); g.moveTo(x + w * 0.3, y + h * 0.37); g.lineTo(x + w * 0.35, y + h * 0.33); g.lineTo(x + w * 0.4, y + h * 0.37); g.fill();
  } else if (d.art === 'bottle') {
    g.fillStyle = '#c9a24a'; g.fillRect(ax - w * 0.1, ay - h * 0.12, w * 0.2, h * 0.22); g.fillRect(ax - w * 0.04, ay - h * 0.22, w * 0.08, h * 0.1);
    g.fillStyle = '#7a2230'; g.fillRect(ax - w * 0.1, ay - h * 0.04, w * 0.2, h * 0.07);
  } else if (d.art === 'tower') {
    g.fillStyle = '#9fb8c8'; g.beginPath(); g.moveTo(ax - w * 0.3, ay + h * 0.12); g.lineTo(ax - w * 0.2, ay - h * 0.08); g.lineTo(ax + w * 0.2, ay - h * 0.08); g.lineTo(ax + w * 0.3, ay + h * 0.12); g.fill();
    g.beginPath(); g.arc(ax, ay - h * 0.08, w * 0.2, Math.PI, 0); g.fill();
    g.fillStyle = '#7a2230'; g.fillRect(ax - 2, ay - h * 0.3, 4, h * 0.08);
  } else {
    g.fillStyle = '#1f2e27'; g.beginPath(); g.arc(ax, ay, w * 0.25, Math.PI, 0); g.fill();
    g.fillRect(ax - 2, ay, 4, h * 0.15);
  }
  g.restore();
  g.fillStyle = light ? '#e8dcc0' : '#1f2e27';
  g.font = `italic bold ${Math.round(w * 0.11)}px ${SERIF}`;
  g.fillText(d.mid, x + w / 2, y + h * 0.75, w - 20);
  g.font = `italic ${Math.round(w * 0.065)}px ${SERIF}`;
  g.fillText(d.foot, x + w / 2, y + h * 0.88, w - 20);
}

export function createSignAtlas(): SignAtlas {
  const [c, g] = makeCanvas(ATLAS, ATLAS);
  g.fillStyle = '#1f2e27'; g.fillRect(0, 0, ATLAS, ATLAS);

  const NB = { x: 0, y: 0, w: 1024, h: 128 };
  board(g, NB.x, NB.y, NB.w, NB.h, '#1f3b2a', '#e8dcc0', 'VICTORIA JUNCTION', '#f1e6c8', 80, { spacing: 8 });
  const FAC = { x: 0, y: 128, w: 1024, h: 112 };
  board(g, FAC.x, FAC.y, FAC.w, FAC.h, '#e8dcc0', '#6e3326', 'VICTORIA JUNCTION', '#6e3326', 70, { spacing: 10 });

  // platform numbers (roundels)
  const num = (x: number, y: number, s: number, t: string) => {
    g.fillStyle = '#e8dcc0'; g.fillRect(x, y, s, s);
    g.fillStyle = '#1f3b2a'; g.fillRect(x + 8, y + 8, s - 16, s - 16);
    g.fillStyle = '#f1e6c8'; g.font = `bold ${Math.round(s * 0.7)}px ${SERIF}`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, x + s / 2, y + s / 2 + s * 0.04);
  };
  num(0, 240, 128, '1');
  num(128, 240, 128, '2');
  board(g, 256, 240, 384, 64, '#1f3b2a', '#e8dcc0', 'BOOKING HALL', '#f1e6c8', 38, { spacing: 4 });
  board(g, 640, 240, 384, 64, '#6e3326', '#e8dcc0', 'ENGINE SHED', '#f1e6c8', 38, { spacing: 4 });
  board(g, 256, 304, 384, 64, '#e8dcc0', '#1f2e27', 'SIGNAL BOX', '#1f2e27', 38, { spacing: 4 });
  board(g, 640, 304, 384, 64, '#1f3b2a', '#e8dcc0', 'TIMETABLE', '#f1e6c8', 38, { spacing: 4 });
  board(g, 0, 368, 512, 96, '#1f3b2a', '#e8dcc0', 'COAST LINE', '#f1e6c8', 44, { sub: 'Brightmouth · Kingsport' });
  board(g, 512, 368, 512, 96, '#5a1a24', '#e8dcc0', 'HIGHLAND LINE', '#f1e6c8', 44, { sub: 'Ashby Vale · Glenmoor' });

  // posters 6 × (170 × 250) in a row of 6 at y 470
  const posters: UV[] = [];
  const PW = 170, PH = 250;
  for (let i = 0; i < 6; i++) {
    const x = 2 + i * PW, y = 470;
    poster(g, x, y, PW - 4, PH, i);
    posters.push(uvOf(x, y, PW - 4, PH));
  }
  // timetable sheet
  g.fillStyle = '#efe6cf'; g.fillRect(0, 730, 256, 290);
  g.fillStyle = '#1f2e27'; g.font = `bold 26px ${SERIF}`; g.textAlign = 'center';
  g.fillText('DEPARTURES', 128, 760);
  g.font = `16px ${SERIF}`; g.textAlign = 'left';
  for (let i = 0; i < 12; i++) { g.fillRect(16, 790 + i * 18, 224, 1); g.fillText(`${String(6 + i).padStart(2, '0')}.${i % 2 ? '15' : '40'}  ${['Kingsport', 'Glenmoor', 'Brightmouth', 'Ashby Vale'][i % 4]}`, 18, 786 + i * 18); }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return {
    texture: tex,
    nameBoard: uvOf(NB.x, NB.y, NB.w, NB.h),
    facade: uvOf(FAC.x, FAC.y, FAC.w, FAC.h),
    num1: uvOf(0, 240, 128, 128),
    num2: uvOf(128, 240, 128, 128),
    booking: uvOf(256, 240, 384, 64),
    shed: uvOf(640, 240, 384, 64),
    signalBox: uvOf(256, 304, 384, 64),
    timetable: uvOf(0, 730, 256, 290),
    toCoast: uvOf(0, 368, 512, 96),
    toHighland: uvOf(512, 368, 512, 96),
    posters,
  };
}

/** clock dial: cream face, roman numerals, brass bezel */
export function createClockDial(): THREE.CanvasTexture {
  const S = 256;
  const [c, g] = makeCanvas(S, S);
  const cx = S / 2;
  g.fillStyle = '#1f2e27'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#c9a24a'; g.beginPath(); g.arc(cx, cx, cx - 2, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#f6efdc'; g.beginPath(); g.arc(cx, cx, cx - 14, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#1f2e27'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cx, cx - 22, 0, Math.PI * 2); g.stroke();
  const romans = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  g.fillStyle = '#1f2e27'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const r0 = cx - 22, r1 = i % 5 === 0 ? cx - 32 : cx - 27;
    g.lineWidth = i % 5 === 0 ? 3 : 1.5;
    g.beginPath(); g.moveTo(cx + Math.sin(a) * r0, cx - Math.cos(a) * r0); g.lineTo(cx + Math.sin(a) * r1, cx - Math.cos(a) * r1); g.stroke();
  }
  g.font = `bold 22px ${SERIF}`;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = cx - 48;
    g.save(); g.translate(cx + Math.sin(a) * r, cx - Math.cos(a) * r); g.rotate(a); g.fillText(romans[i], 0, 0); g.restore();
  }
  g.fillStyle = '#c9a24a'; g.beginPath(); g.arc(cx, cx, 6, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
