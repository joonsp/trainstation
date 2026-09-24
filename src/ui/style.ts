/** Victorian railway ephemera: cream paper cards, thin double rules, serif type, brass & oxblood accents. */
export const CSS = /* css */ `
#ui {
  --paper: #f0e6cc; --paper2: #e6d9b8; --paper3: #d9c9a2;
  --ink: #2a211a; --ink2: #5b4a3a; --rule: #4a3a2a;
  --ox: #7a2230; --ox2: #5e1824; --green: #2f5d3a; --brass: #c9a24a; --brass2: #8d6c2c; --brass3: #e9cf85;
  --board: #16140f; --amber: #f3cf7c; --flapfg: #f3e8c8;
  --serif: 'IM Fell English', Georgia, 'Times New Roman', serif;
  --sc: 'IM Fell English SC', 'IM Fell English', Georgia, serif;
  --display: 'Playfair Display', Georgia, serif;
  font-family: var(--serif); color: var(--ink); font-size: 14px; line-height: 1.25;
  -webkit-font-smoothing: antialiased; user-select: none;
}
#ui * { box-sizing: border-box; }
#ui.vj-hidden > * { display: none !important; }
#ui .card {
  position: absolute;
  background:
    radial-gradient(120% 90% at 20% 10%, rgba(255,250,235,.55), rgba(255,250,235,0) 60%),
    radial-gradient(90% 120% at 90% 100%, rgba(150,120,70,.16), rgba(150,120,70,0) 60%),
    var(--paper);
  border: 3px double var(--rule);
  outline: 1px solid rgba(74,58,42,.35); outline-offset: 2px;
  box-shadow: 0 1px 0 rgba(255,255,255,.4) inset, 0 3px 6px rgba(20,12,4,.28), 0 10px 26px rgba(20,12,4,.25);
  border-radius: 2px;
  padding: 8px 10px;
}
#ui .sc { font-family: var(--sc); letter-spacing: .06em; }
#ui .muted { color: var(--ink2); }
#ui .rule { height: 0; border-top: 3px double rgba(74,58,42,.55); margin: 6px 0; }
#ui .fleuron { color: var(--ox); }

/* ── buttons ── */
#ui button, #ui select {
  font-family: var(--sc); font-size: 12.5px; letter-spacing: .04em; color: var(--ink);
  background: linear-gradient(#f6eed8, #e2d3ae); border: 1px solid var(--rule); border-radius: 2px;
  padding: 3px 7px; cursor: pointer; box-shadow: 0 1px 0 rgba(255,255,255,.6) inset, 0 1px 2px rgba(0,0,0,.2);
  line-height: 1.2; min-height: 24px;
}
#ui button:hover:not(:disabled), #ui select:hover { background: linear-gradient(#fbf4e2, #eadcb8); }
#ui button:active:not(:disabled) { transform: translateY(1px); box-shadow: none; }
#ui button.on { background: linear-gradient(#8a2a38, var(--ox2)); color: #f6e8c8; border-color: #3b1016; }
#ui button.brass { background: linear-gradient(var(--brass3), var(--brass) 55%, var(--brass2)); border-color: #5a4418; color: #2a1c08; }
#ui button:disabled { opacity: .45; cursor: default; }
#ui button svg { vertical-align: -2px; }
#ui button:focus-visible, #ui select:focus-visible { outline: 2px solid var(--ox); outline-offset: 1px; }

/* ── clock card (top-left) ── */
#ui .vj-clock { left: 12px; top: 12px; min-width: 262px; display: flex; align-items: center; gap: 10px; padding: 7px 12px 7px 8px; }
#ui .vj-dial { width: 62px; height: 62px; flex: none; filter: drop-shadow(0 1px 1px rgba(0,0,0,.35)); }
#ui .vj-time { font-family: var(--display); font-weight: 700; font-size: 27px; line-height: 1; font-variant-numeric: lining-nums tabular-nums; letter-spacing: .01em; }
#ui .vj-time small { font-size: 14px; font-weight: 500; color: var(--ink2); margin-left: 2px; }
#ui .vj-day { font-family: var(--sc); font-size: 14px; letter-spacing: .08em; margin-top: 3px; color: var(--ox); }
#ui .vj-date { font-style: italic; font-size: 13px; color: var(--ink2); }
#ui .vj-wx { display: flex; flex-direction: column; align-items: center; margin-left: 4px; padding-left: 10px; border-left: 3px double rgba(74,58,42,.45); min-width: 58px; }
#ui .vj-wx .t { font-family: var(--display); font-size: 16px; font-weight: 700; }
#ui .vj-wx .n { font-family: var(--sc); font-size: 11.5px; color: var(--ink2); letter-spacing: .05em; }

/* ── stats ticket strip ── */
#ui .vj-stats { left: 12px; top: 106px; min-width: 262px; justify-content: space-between; display: grid; grid-template-columns: repeat(4, auto); gap: 0; padding: 4px 2px; }
#ui .vj-stats > div { padding: 0 9px; text-align: center; border-right: 1px dotted rgba(74,58,42,.55); }
#ui .vj-stats > div:last-child { border-right: 0; }
#ui .vj-stats b { display: block; font-family: var(--display); font-size: 17px; font-weight: 700; line-height: 1.1; font-variant-numeric: lining-nums; }
#ui .vj-stats span { font-family: var(--sc); font-size: 10.5px; color: var(--ink2); letter-spacing: .05em; white-space: nowrap; }

/* ── yard card ── */
#ui .vj-yard { left: 12px; top: 164px; width: 262px; padding: 6px 10px 8px; }
#ui .vj-yard h4 { margin: 0 0 3px; font-family: var(--sc); font-weight: normal; font-size: 13px; letter-spacing: .08em; color: var(--ox); display: flex; justify-content: space-between; }
#ui .vj-yard .task { font-size: 13px; }
#ui .vj-yard .q { font-size: 12px; color: var(--ink2); font-style: italic; margin-top: 2px; }

/* ── world card ── */
#ui .vj-maplabels { position: absolute; inset: 0; pointer-events: none; transition: opacity .4s; z-index: 0; }
#ui .vj-maplabels .ml { position: absolute; left: 0; top: 0; pointer-events: auto; cursor: pointer; white-space: nowrap; color: #2a211a;
  text-shadow: 0 0 3px rgba(246,238,216,.95), 0 0 6px rgba(246,238,216,.8), 0 0 1px #f6eed8; user-select: none; }
#ui .vj-maplabels .ml:hover { color: var(--ox); }
#ui .vj-maplabels .town { font-family: 'Playfair Display', Georgia, serif; font-weight: 700; font-size: 17px; letter-spacing: .22em; text-transform: uppercase; }
#ui .vj-maplabels .station { font-family: 'Playfair Display', Georgia, serif; font-weight: 900; font-size: 14px; letter-spacing: .12em; text-transform: uppercase; color: #7a2230; }
#ui .vj-maplabels .hamlet { font-family: var(--sc); font-size: 14px; letter-spacing: .12em; }
#ui .vj-maplabels .small { font-family: var(--serif); font-style: italic; font-size: 12.5px; }
#ui .vj-maplabels .field { font-family: var(--serif); font-style: italic; font-size: 11.5px; color: #3d4a26; letter-spacing: .06em; }
#ui .vj-maplabels .water { font-family: var(--serif); font-style: italic; font-size: 15px; letter-spacing: .3em; color: #23465e; }
#ui .vj-world { left: 12px; top: 250px; width: 262px; padding: 5px 10px 7px; }
#ui .vj-world h4 { margin: 0 0 3px; font-family: var(--sc); font-weight: normal; font-size: 13px; letter-spacing: .08em; color: var(--ox); display: flex; justify-content: space-between; cursor: pointer; }
#ui .vj-world h4::after { content: '▾'; font-size: 11px; margin-left: 6px; color: var(--ink2); }
#ui .vj-world h4 span:first-child { flex: 1; }
#ui .vj-world.closed h4 { margin: 0; }
#ui .vj-world.closed h4::after { content: '▸'; }
#ui .vj-world.closed .wk { display: none; }
#ui .vj-world h4 .muted { font-family: var(--serif); letter-spacing: 0; font-size: 12px; display: none; }
#ui .vj-world.closed h4 .muted { display: inline; }
#ui .wk { display: grid; grid-template-columns: 50px 1fr; gap: 2px 6px; margin: 0; font-size: 12.5px; line-height: 1.2; }
#ui .wk dt { font-family: var(--sc); font-size: 11px; color: var(--ink2); letter-spacing: .04em; padding-top: 1px; }
#ui .wk dd { margin: 0; }
#ui .wk dd b.sc { font-weight: normal; font-size: 11.5px; color: var(--green); margin-right: 3px; }
#ui .wk .tone.ice { color: #3c6a86; font-style: italic; }
#ui .wk .tone.mist { color: #6a6a78; font-style: italic; }
#ui .wk .tone.spate { color: #7a4a22; }
#ui .vj-inspect .sub { font-style: italic; font-size: 12.5px; margin: -2px 0 5px; }
#ui .vj-ctrl .tierinfo { font-size: 11.5px; font-style: italic; }
#ui .toast.offer { pointer-events: auto; font-style: normal; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; }
#ui .toast.offer::before, #ui .toast.offer::after { display: none; }
#ui .toast.offer button { min-height: 22px; padding: 2px 8px; }

/* bars */
#ui .bar { height: 7px; background: rgba(74,58,42,.18); border: 1px solid rgba(74,58,42,.55); border-radius: 1px; overflow: hidden; }
#ui .bar > i { display: block; height: 100%; width: 0; background: var(--green); transition: width .4s ease, background-color .4s; }

/* ── departures board (top-right) ── */
#ui .vj-board {
  position: absolute; right: 12px; top: 12px; padding: 0 0 8px; border-radius: 3px;
  background: linear-gradient(#1e1b16, var(--board)); color: var(--flapfg);
  border: 2px solid #0a0907; box-shadow: 0 0 0 3px #5a4418, 0 0 0 4px #2a1c08, 0 10px 26px rgba(0,0,0,.45);
}
#ui .vj-board header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  background: linear-gradient(var(--brass3), var(--brass) 45%, var(--brass2)); color: #24170a;
  padding: 3px 12px 2px; border-bottom: 2px solid #0a0907; margin-bottom: 5px;
}
#ui .vj-board header h2 { margin: 0; font-family: var(--display); font-weight: 900; font-size: 17px; letter-spacing: .32em; }
#ui .vj-board header span { font-family: var(--sc); font-size: 12px; letter-spacing: .08em; }
#ui .fl-head, #ui .fl-row { display: flex; gap: 9px; padding: 0 10px; }
#ui .fl-head { font-family: var(--sc); font-size: 10.5px; letter-spacing: .12em; color: #b9a67a; margin-bottom: 2px; }
#ui .fl-head span { display: inline-block; }
#ui .fl-row { margin-bottom: 3px; }
#ui .fl-grp { display: inline-flex; gap: 1px; }
#ui .fl {
  position: relative; display: inline-block; width: 12px; height: 19px; line-height: 19px; text-align: center;
  font-family: var(--display); font-weight: 700; font-size: 13.5px; color: var(--flapfg);
  background: linear-gradient(#2e2a24 0, #26231e 49%, #141210 51%, #1d1a16 100%);
  border-radius: 2px; box-shadow: 0 1px 0 rgba(0,0,0,.6);
  transform-origin: 50% 50%;
}
#ui .fl::after { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: rgba(0,0,0,.75); }
#ui .fl.fa { animation: flapA 70ms linear; }
#ui .fl.fb { animation: flapB 70ms linear; }
@keyframes flapA { 0% { transform: scaleY(1); } 50% { transform: scaleY(.15); filter: brightness(.55); } 100% { transform: scaleY(1); } }
@keyframes flapB { 0% { transform: scaleY(1); } 50% { transform: scaleY(.15); filter: brightness(.55); } 100% { transform: scaleY(1); } }
#ui .fl-time .fl, #ui .fl-plat .fl { color: var(--amber); }
#ui .fl-row[data-tone="late"] .fl-status .fl { color: #f0a070; }
#ui .fl-row[data-tone="bad"] .fl-status .fl { color: #ff7a6a; }
#ui .fl-row[data-tone="board"] .fl-status .fl { color: #a8e0a0; }
#ui .fl-row[data-tone="gone"] .fl { color: #8a8068; }
#ui .fl-row[data-tone="special"] .fl-dest .fl { color: #e9cf85; }
#ui .vj-board .empty { font-style: italic; color: #b9a67a; padding: 2px 12px; font-size: 13px; }

/* ── controls (bottom-left) ── */
#ui .vj-ctrl { left: 12px; bottom: 44px; padding: 7px 9px; display: flex; flex-direction: column; gap: 5px; }
#ui .vj-ctrl .row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
#ui .vj-ctrl label { font-family: var(--sc); font-size: 11.5px; letter-spacing: .06em; color: var(--ink2); width: 54px; }
#ui .vj-ctrl select { padding: 2px 4px; }

/* events menu */
#ui .vj-events { left: 12px; bottom: 202px; width: 300px; max-height: min(60vh, 440px); overflow: auto; padding: 8px 10px; display: none; }
#ui .vj-events.open { display: block; }
#ui .vj-events h3 { margin: 0 0 2px; font-family: var(--display); font-size: 16px; letter-spacing: .12em; text-align: center; }
#ui .vj-events .hint { text-align: center; font-size: 11.5px; font-style: italic; color: var(--ink2); }
#ui .ev { display: flex; gap: 8px; align-items: center; padding: 5px 0; border-top: 1px dotted rgba(74,58,42,.5); }
#ui .ev .tx { flex: 1; min-width: 0; }
#ui .ev .tt { font-family: var(--sc); font-size: 13.5px; letter-spacing: .03em; }
#ui .ev .bl { font-size: 12px; color: var(--ink2); font-style: italic; line-height: 1.15; }
#ui .ev.na .tx { opacity: .5; }
#ui .ev.act .tt::after { content: ' — in progress'; font-family: var(--serif); font-style: italic; font-size: 11.5px; color: var(--green); }

/* ── gazette ticker (bottom) ── */
#ui .vj-gazette {
  position: absolute; left: 0; right: 0; bottom: 0; height: 32px; display: flex; align-items: stretch;
  background: var(--paper); border-top: 3px double var(--rule); box-shadow: 0 -4px 14px rgba(20,12,4,.25);
}
#ui .vj-gazette .mast {
  flex: none; display: flex; align-items: center; padding: 0 12px; background: var(--ox); color: #f6e8c8;
  font-family: var(--display); font-weight: 900; font-size: 13px; letter-spacing: .14em; white-space: nowrap;
  border-right: 3px double #f0e6cc;
}
#ui .vj-gazette .mast i { font-family: var(--serif); font-weight: normal; font-size: 11px; letter-spacing: .02em; margin-left: 8px; opacity: .85; }
#ui .vj-gazette .win { position: relative; flex: 1; overflow: hidden; }
#ui .gz-track {
  position: absolute; top: 0; left: 0; height: 100%; display: flex; align-items: center; white-space: nowrap;
  padding-left: 100%; font-size: 15px; will-change: transform;
  animation: gzScroll var(--dur, 40s) linear infinite;
}
@keyframes gzScroll { from { transform: translateX(0); } to { transform: translateX(-100%); } }
#ui .gz-track .h { margin-right: 28px; }
#ui .gz-track .h b { font-family: var(--sc); font-weight: normal; font-size: 12px; color: var(--ink2); margin-right: 6px; }
#ui .gz-track .h.warn { color: var(--ox); }
#ui .gz-track .h.event { color: var(--green); font-style: italic; }
#ui .gz-track .fleuron { margin-right: 28px; }

/* ── inspect panel ── */
#ui .vj-inspect { right: 12px; top: 214px; width: 300px; max-height: calc(100vh - 214px - 88px); overflow: auto; display: none; padding: 9px 11px 10px; }
/* the help button would sit on an open card: tuck it away while one is open */
#ui .vj-inspect.open ~ .vj-helpbtn { display: none; }
#ui .vj-inspect.open { display: block; animation: slideIn .22s ease-out; }
@keyframes slideIn { from { transform: translateX(16px); opacity: 0; } to { transform: none; opacity: 1; } }
#ui .vj-inspect .x { position: absolute; top: 4px; right: 4px; min-height: 0; width: 22px; height: 22px; padding: 0; font-size: 15px; line-height: 18px; }
#ui .plate {
  margin: 2px 22px 6px 0; padding: 4px 8px; text-align: center; border-radius: 3px;
  background: linear-gradient(var(--brass3), var(--brass) 50%, var(--brass2)); border: 1px solid #4a3812;
  box-shadow: 0 0 0 2px #2a1c08 inset, 0 2px 3px rgba(0,0,0,.35);
  font-family: var(--sc); font-size: 16px; letter-spacing: .08em; color: #24170a; text-shadow: 0 1px 0 rgba(255,240,200,.6);
}
#ui .plate.p { background: linear-gradient(#3a4a3e, #1f2e27); color: #efe2bf; text-shadow: none; border-color: #0d1410; }
#ui .kv { display: grid; grid-template-columns: 92px 1fr; gap: 1px 8px; font-size: 13.5px; }
#ui .kv dt { font-family: var(--sc); font-size: 12px; color: var(--ink2); letter-spacing: .04em; padding-top: 1px; }
#ui .kv dd { margin: 0; }
#ui .pill { display: inline-block; padding: 0 6px; border-radius: 8px; font-family: var(--sc); font-size: 11.5px; color: #f6e8c8; letter-spacing: .05em; }
#ui .pill.coast { background: var(--ox); }
#ui .pill.highland { background: var(--green); }
#ui .cond { display: grid; grid-template-columns: 56px 1fr 32px; gap: 3px 6px; align-items: center; font-size: 12.5px; margin-top: 2px; }
#ui .cond span { font-family: var(--sc); font-size: 11.5px; color: var(--ink2); }
#ui .cond em { font-style: normal; font-size: 11.5px; text-align: right; font-variant-numeric: tabular-nums; }
#ui .consist { display: flex; flex-wrap: wrap; gap: 0 1px; margin-top: 3px; padding: 3px 2px 1px; background: rgba(74,58,42,.08); border-radius: 2px; }
#ui .btns { display: flex; gap: 6px; margin-top: 8px; }
#ui .btns button { flex: 1; }
#ui .face { display: flex; align-items: center; gap: 8px; }
#ui h5 { margin: 6px 0 2px; font-family: var(--sc); font-weight: normal; font-size: 12px; letter-spacing: .1em; color: var(--ox); }

/* ── toasts ── */
#ui .vj-toasts { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none !important; }
#ui .toast {
  position: relative; padding: 5px 16px; font-size: 14.5px; font-style: italic; max-width: min(460px, 70vw); text-align: center;
  background: var(--paper); border: 3px double var(--rule); box-shadow: 0 4px 14px rgba(20,12,4,.35);
  animation: toastIn .25s ease-out; transition: opacity .5s, transform .5s;
}
#ui .toast::before, #ui .toast::after { content: '❧'; font-style: normal; color: var(--ox); margin: 0 6px; }
#ui .toast::before { display: inline-block; transform: scaleX(-1); }
#ui .toast.out { opacity: 0; transform: translateY(-8px); }
@keyframes toastIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: none; } }

/* ── help overlay ── */
#ui .vj-help { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(520px, 92vw); padding: 14px 20px 12px; display: none; }
#ui .vj-help.open { display: block; }
#ui .vj-help h2 { margin: 0; text-align: center; font-family: var(--display); font-weight: 900; font-size: 22px; letter-spacing: .18em; }
#ui .vj-help .sub { text-align: center; font-style: italic; color: var(--ink2); margin-bottom: 4px; }
#ui .vj-help .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 22px; }
#ui .vj-help .k { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; border-bottom: 1px dotted rgba(74,58,42,.4); font-size: 13.5px; }
#ui kbd { font-family: var(--sc); font-size: 12px; background: var(--paper2); border: 1px solid var(--rule); border-bottom-width: 2px; border-radius: 3px; padding: 0 5px; white-space: nowrap; }
#ui .vj-help .foot { text-align: center; margin-top: 8px; font-size: 12px; font-style: italic; color: var(--ink2); }
#ui .vj-helpbtn { position: absolute; right: 12px; bottom: 44px; min-height: 0; width: 28px; height: 28px; padding: 0; border-radius: 50% !important; font-family: var(--display) !important; font-weight: 700; font-size: 15px !important; }

/* ── small screens ── */
@media (max-width: 1100px) {
  #ui .vj-board { transform: scale(.84); transform-origin: 100% 0; }
  #ui .vj-inspect { top: 186px; max-height: calc(100vh - 186px - 88px); }
}
@media (max-width: 900px) {
  #ui .vj-yard { display: none; }
  #ui .vj-world { top: 164px; }
  #ui .vj-inspect { top: auto; bottom: 44px; right: 8px; left: auto; width: min(300px, calc(100vw - 16px)); max-height: 46vh; }
}
@media (max-width: 700px) {
  #ui { font-size: 13px; }
  #ui .vj-clock { left: 8px; top: 8px; gap: 6px; padding: 5px 8px 5px 5px; }
  #ui .vj-dial { width: 44px; height: 44px; }
  #ui .vj-time { font-size: 21px; }
  #ui .vj-date, #ui .vj-stats, #ui .vj-world { display: none; }
  #ui .vj-wx { min-width: 44px; padding-left: 6px; }
  #ui .vj-clock { min-width: 0; }
  /* below the clock + weather panel (never over it) */
  #ui .vj-board { right: 8px; top: 112px; transform: scale(.76); transform-origin: 100% 0; }
  #ui .vj-toasts { top: 290px; width: calc(100vw - 24px); }
  #ui .fl-row:nth-child(n+5) { display: none; }
  #ui .vj-ctrl { left: 8px; bottom: 40px; padding: 5px 6px; }
  #ui .vj-ctrl label { display: none; }
  #ui .vj-gazette .mast i { display: none; }
  #ui .vj-gazette .mast { font-size: 11px; padding: 0 8px; }
  #ui .vj-events { left: 8px; bottom: 150px; width: calc(100vw - 16px); }
  #ui .vj-inspect { left: 8px; right: 8px; width: auto; bottom: 150px; max-height: 40vh; }
  #ui .vj-helpbtn { display: none; }
  #ui .vj-help .cols { grid-template-columns: 1fr; }
}
@media (max-height: 700px) {
  #ui .vj-world .wk { display: none; }
  #ui .vj-world h4 .muted { display: inline; }
}
@media (max-height: 560px) {
  #ui .vj-yard, #ui .vj-stats, #ui .vj-world { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  #ui .fl.fa, #ui .fl.fb, #ui .toast, #ui .vj-inspect.open { animation: none; }
}
`;
