/**
 * Split-flap departures board. Each character is a <span class="fl">; when a target changes the cell
 * clacks forward through the flap sequence (max ~7 flips) with a short squash animation per flip.
 */
const SEQ = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:.-→\'&';

interface Cell { el: HTMLSpanElement; cur: string; to: string; steps: number; flip: boolean }

export interface BoardRow { time: string; dest: string; plat: string; status: string; tone: string; title: string }

export const COLS = { time: 5, dest: 12, plat: 1, status: 11 } as const;

export class SplitFlapBoard {
  readonly el: HTMLDivElement;
  private rows: { row: HTMLDivElement; cells: Record<keyof typeof COLS, Cell[]> }[] = [];
  private pending = new Set<Cell>();
  private timer: number | null = null;
  private lastTick = 0;

  constructor(rowCount: number) {
    this.el = document.createElement('div');
    this.el.className = 'fl-rows';
    for (let r = 0; r < rowCount; r++) {
      const row = document.createElement('div');
      row.className = 'fl-row';
      const cells = {} as Record<keyof typeof COLS, Cell[]>;
      for (const k of Object.keys(COLS) as (keyof typeof COLS)[]) {
        const grp = document.createElement('span');
        grp.className = 'fl-grp fl-' + k;
        cells[k] = [];
        for (let i = 0; i < COLS[k]; i++) {
          const el = document.createElement('span');
          el.className = 'fl';
          el.textContent = ' ';
          grp.appendChild(el);
          cells[k].push({ el, cur: ' ', to: ' ', steps: 0, flip: false });
        }
        row.appendChild(grp);
      }
      this.el.appendChild(row);
      this.rows.push({ row, cells });
    }
  }

  setRows(data: (BoardRow | null)[]) {
    this.rows.forEach((r, i) => {
      const d = data[i];
      const text: Record<keyof typeof COLS, string> = d
        ? { time: d.time, dest: d.dest, plat: d.plat, status: d.status }
        : { time: '', dest: '', plat: '', status: '' };
      r.row.dataset.tone = d?.tone ?? '';
      r.row.title = d?.title ?? '';
      for (const k of Object.keys(COLS) as (keyof typeof COLS)[]) {
        const s = text[k].toUpperCase().padEnd(COLS[k], ' ').slice(0, COLS[k]);
        r.cells[k].forEach((c, j) => this.setCell(c, s[j]));
      }
    });
    if (this.pending.size && this.timer === null) { this.lastTick = performance.now(); this.timer = window.setInterval(() => this.tick(), 55); }
  }

  private setCell(c: Cell, ch: string) {
    if (c.to === ch) return;
    c.to = ch;
    const a = SEQ.indexOf(c.cur), b = SEQ.indexOf(ch);
    const dist = a >= 0 && b >= 0 ? (b - a + SEQ.length) % SEQ.length : 3;
    c.steps = Math.min(dist, 3 + Math.floor(Math.random() * 5));
    this.pending.add(c);
  }

  private tick() {
    // wall-clock based: if timers are starved (busy main thread) skip flips so the board still settles in ~0.5 s
    const now = performance.now();
    const n = Math.max(1, Math.round((now - this.lastTick) / 55));
    this.lastTick = now;
    for (const c of this.pending) {
      if (c.steps > n) {
        const i = SEQ.indexOf(c.cur);
        c.cur = SEQ[(i + n + SEQ.length) % SEQ.length] ?? ' ';
        c.steps -= n;
      } else {
        c.cur = c.to;
        c.steps = 0;
        this.pending.delete(c);
      }
      c.el.textContent = c.cur === ' ' ? ' ' : c.cur;
      c.flip = !c.flip;
      c.el.classList.toggle('fa', c.flip);
      c.el.classList.toggle('fb', !c.flip);
    }
    if (!this.pending.size && this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }
}
