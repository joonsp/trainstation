#!/usr/bin/env node
// Screenshot harness.
// node scripts/shot.mjs --port <PORT> --out <dir> [--wait ms=3500] [--advance simMinutes] [--size 1280x800]
//                       [--eval "<js run in page before capture>"] [--gpu] [--dpr 2] "<querystring1>" "<querystring2>" ...
//   --gpu   use the real GPU (ANGLE on EGL) instead of SwiftShader — auto tier then resolves to high on a desktop GPU
//   --dpr   deviceScaleFactor (e.g. 2 to measure the high tier's pixel-ratio cap)
// Prints one JSON line per shot: {file, qs, consoleErrors, pageErrors, stats, evalResult}
// Exit code is non-zero only on harness failure (server/browser could not start).
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { port: 5173, out: 'shots', wait: 3500, advance: 0, size: '1280x800', eval: null, gpu: false, dpr: 1, qs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gpu') { o.gpu = true; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      if (k === 'port' || k === 'wait' || k === 'advance' || k === 'dpr') o[k] = Number(v);
      else if (k === 'out' || k === 'size' || k === 'eval') o[k] = v;
      else throw new Error(`unknown option ${a}`);
    } else o.qs.push(a);
  }
  if (!o.qs.length) o.qs.push('');
  return o;
}

function findChromium() {
  if (fs.existsSync('/usr/bin/chromium')) return '/usr/bin/chromium';
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort((a, b) => {
      const na = Number(a.split('-')[1]) || 0, nb = Number(b.split('-')[1]) || 0;
      return nb - na;
    });
    for (const d of dirs) {
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        const p = path.join(base, d, sub, 'chrome');
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error('no chromium found');
}

const sanitize = (s) => (s || 'default').replace(/[^a-zA-Z0-9=._-]+/g, '_').replace(/=/g, '-').slice(0, 80);

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const [w, h] = opt.size.split('x').map(Number);
  const outDir = path.resolve(root, opt.out);
  fs.mkdirSync(outDir, { recursive: true });

  let server, browser;
  try {
    server = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      logLevel: 'error',
      server: { port: opt.port, strictPort: true, host: '127.0.0.1', hmr: false },
      clearScreen: false,
    });
    await server.listen();
    browser = await chromium.launch({
      executablePath: findChromium(),
      headless: true,
      args: opt.gpu
        ? ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox'],
    });
  } catch (e) {
    console.error('[shot] harness failure:', e);
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    process.exit(2);
  }

  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: opt.dpr || 1 });
  let idx = 0;
  for (const qs of opt.qs) {
    idx++;
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 2000)); });
    page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e).slice(0, 2000)));
    const url = `http://127.0.0.1:${opt.port}/?${qs}`;
    const file = path.join(outDir, `${idx}-${sanitize(qs)}.png`);
    let stats = null, evalResult = undefined;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => !!window.__station, null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(opt.wait);
      if (opt.advance) {
        await page.evaluate((m) => window.__station?.advance(m), opt.advance);
        await page.waitForTimeout(1300); // let the split-flap board settle
      }
      if (opt.eval) {
        evalResult = await page.evaluate(async (src) => {
          // eslint-disable-next-line no-new-func
          const r = await new Function(`return (async () => { ${src.includes('return') ? src : 'return ' + src} })()`)();
          try { return JSON.parse(JSON.stringify(r ?? null)); } catch { return String(r); }
        }, opt.eval).catch((e) => ({ evalError: String(e) }));
        await page.waitForTimeout(700);
      }
      stats = await page.evaluate(() => (window.__station ? window.__station.stats() : null)).catch((e) => ({ statsError: String(e) }));
      await page.screenshot({ path: file });
    } catch (e) {
      pageErrors.push('[harness] ' + String(e));
    }
    console.log(JSON.stringify({ file: path.relative(root, file), qs, consoleErrors, pageErrors, stats, ...(evalResult !== undefined ? { evalResult } : {}) }));
    await page.close();
  }
  await browser.close();
  await server.close();
}

main().catch((e) => { console.error('[shot] harness failure:', e); process.exit(2); });
