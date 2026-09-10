#!/usr/bin/env node
// Headless driver for bench.html. Self-contained in this repo:
//   npm install && npm run build:dev && node bench/animation/run.mjs
// puppeteer-core arrives through glcheck (a devDependency); Chrome is found in the usual
// places or via CHROME=/path/to/chrome.
//
// Serves the repo root on a throwaway localhost port so the page's relative paths resolve
// (../../build/3Dmol.js, ../../tests/auto/data/*), then drives the page's bench steps one at a
// time and wraps EACH timed pass in what a page cannot see about itself: a GC trace
// (disabled-by-default-v8.gc over the DevTools protocol) and renderer-process CPU counters
// (ScriptDuration/TaskDuration). That is what makes GC time attributable per path.
//
// Options:
//   --pdb <file>        add a local single-model PDB to the size ladder (repeatable)
//   --fetch <id>        add AF-<UNIPROT>-F1 (AlphaFold DB) or a 4-char RCSB id (network; repeatable)
//   --frames-file <f>   a local multi-model PDB to run through setFrame (repeatable)
//   --style ballstick|sphere|stick    (default ballstick: both imposter kinds)
//   --frames N --warmup N --repeats N --alloc-frames N
//   --no-strict         still time a workload whose output hashes differ (flagged in results)
//   --no-trace          skip the GC trace
//   --out <file.json>   (default bench/animation/results-<timestamp>.json)
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = { pdb: [], fetch: [], framesFile: [], style: 'ballstick', frames: 100, warmup: 10, repeats: 3, allocFrames: 20, strict: true, trace: true, out: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--pdb') opt.pdb.push(argv[++i]);
  else if (a === '--fetch') opt.fetch.push(argv[++i]);
  else if (a === '--frames-file') opt.framesFile.push(argv[++i]);
  else if (a === '--style') opt.style = argv[++i];
  else if (a === '--frames') opt.frames = +argv[++i];
  else if (a === '--warmup') opt.warmup = +argv[++i];
  else if (a === '--repeats') opt.repeats = +argv[++i];
  else if (a === '--alloc-frames') opt.allocFrames = +argv[++i];
  else if (a === '--bundle') opt.bundle = argv[++i];
  else if (a === '--no-strict') opt.strict = false;
  else if (a === '--no-trace') opt.trace = false;
  else if (a === '--serve') { /* handled after the server starts */ }
  else if (a === '--out') opt.out = argv[++i];
  else { console.error('unknown option ' + a); process.exit(2); }
}
if (!fs.existsSync(path.join(ROOT, 'build', '3Dmol.js'))) { console.error('build/3Dmol.js missing: run `npm run build:dev` first'); process.exit(1); }

// ── sources ─────────────────────────────────────────────────────────────────
// Defaults are the repo's own fixtures, so the benchmark runs with no network and no extra data:
// two single-model files as a small size ladder, and the 29-frame trajectory for setFrame.
const DATA = path.join(ROOT, 'tests', 'auto', 'data');
const sources = [
  { name: '1lo6 (synthetic frames)', text: fs.readFileSync(path.join(DATA, '1lo6.pdb'), 'utf8'), format: 'pdb', frames: 30 },
  { name: '4csv (synthetic frames)', text: fs.readFileSync(path.join(DATA, '4csv.pdb'), 'utf8'), format: 'pdb', frames: 30 },
  { name: 'temp_1_2_28 (29 real frames)', text: fs.readFileSync(path.join(DATA, 'temp_1_2_28.pdb'), 'utf8'), format: 'pdb' },
];
for (const f of opt.pdb) sources.push({ name: path.basename(f) + ' (synthetic frames)', text: fs.readFileSync(f, 'utf8'), format: 'pdb', frames: 30 });
for (const f of opt.framesFile) sources.push({ name: path.basename(f) + ' (file frames)', text: fs.readFileSync(f, 'utf8'), format: 'pdb' });
for (const id of opt.fetch) {
  const url = /^AF-/i.test(id) ? `https://alphafold.ebi.ac.uk/files/${id}-model_v4.pdb` : `https://files.rcsb.org/download/${id}.pdb`;
  process.stdout.write('fetching ' + url + ' ... ');
  const r = await fetch(url); if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1); }
  sources.push({ name: id + ' (synthetic frames)', text: await r.text(), format: 'pdb', frames: 30 });
  console.log('ok');
}

// ── static server over the repo root ────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.pdb': 'text/plain' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// --serve: just host the repo for the interactive pages (demo.html, bench.html) and wait.
if (argv.includes('--serve')) {
  console.log(`serving the repo at http://127.0.0.1:${port}/\n  demo:  http://127.0.0.1:${port}/bench/animation/demo.html\n  bench: http://127.0.0.1:${port}/bench/animation/bench.html\nCtrl+C to stop`);
  await new Promise(() => {});
}

// ── browser ─────────────────────────────────────────────────────────────────
function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const c = process.platform === 'win32' ? [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe' ]
    : process.platform === 'darwin' ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium' ]
    : [ '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium' ];
  return c.find(p => p && fs.existsSync(p));
}
const chrome = findChrome();
if (!chrome) { console.error('no Chrome/Chromium found; set CHROME=/path/to/chrome'); process.exit(1); }

const browser = await puppeteer.launch({
  executablePath: chrome, headless: 'new',
  // vsync would clamp every result under 16.7 ms to exactly 16.7 ms.
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--use-gl=angle', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', e => console.log('  [page error] ' + e.message));
// --bundle <repo-relative path> points the page at an alternate build (see bench.html).
const bundleQ = opt.bundle ? '?bundle=' + encodeURIComponent(opt.bundle.replace(/\\/g, '/')) : '';
await page.goto(`http://127.0.0.1:${port}/bench/animation/bench.html${bundleQ}`, { waitUntil: 'load' });

// ── GC tracing over raw DevTools protocol ────────────────────────────────────
// The browser PUSHES events (ReportEvents): both puppeteer's page.tracing.stop() and a manual
// IO.read loop fail on the stream handle with this Chrome/Node pairing. Only the GC category is
// traced -- devtools.timeline emits an event per task and paint, and pushed for a full-length
// run that volume was enough to take the renderer down.
const cdp = await page.createCDPSession();
let traceEvents = [];
cdp.on('Tracing.dataCollected', e => { for (const v of e.value) traceEvents.push(v); });
async function traceStart() {
  traceEvents = [];
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['disabled-by-default-v8.gc'] } });
}
async function traceStop() {
  const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.end');
  await done;
  return traceEvents;
}
// GC wall time as the UNION of every GC event's interval. V8 nests its phases (a mark-compact
// contains marking, sweeping, ...), so summing durations would double count; merging intervals
// gives "time the main thread spent inside any GC work", whatever the phase names are.
function gcSummary(ev) {
  const spans = [], open = new Map();
  for (const e of ev) {
    if (!/v8\.gc/.test(e.cat || '')) continue;
    if (e.ph === 'X' && e.dur > 0) spans.push([e.ts, e.ts + e.dur]);
    else if (e.ph === 'B') open.set(e.tid + ':' + e.name, e.ts);
    else if (e.ph === 'E') { const k = e.tid + ':' + e.name; if (open.has(k)) { spans.push([open.get(k), e.ts]); open.delete(k); } }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0, pauses = 0, s0 = -1, e0 = -1;
  for (const [s, e] of spans) {
    if (s > e0) { if (e0 > s0) { total += e0 - s0; pauses++; } s0 = s; e0 = e; }
    else if (e > e0) e0 = e;
  }
  if (e0 > s0) { total += e0 - s0; pauses++; }
  return { pauses, ms: +(total / 1000).toFixed(1) };
}

// Renderer CPU counters, read directly: the Performance domain only accumulates once enabled
// on the session, and its values are seconds.
await cdp.send('Performance.enable');
async function cpuNow() {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = n => { const m = metrics.find(x => x.name === n); return m ? m.value : 0; };
  return { script: get('ScriptDuration'), task: get('TaskDuration') };
}

// One instrumented pass: trace + CPU counters around the page's timed loop.
async function instrumentedPass(which) {
  if (opt.trace) await traceStart();
  const c0 = await cpuNow();
  const r = await page.evaluate((w, f, u) => window.bench.pass(w, f, u), which, opt.frames, opt.warmup);
  const c1 = await cpuNow();
  r.cpu = { scriptMs: +((c1.script - c0.script) * 1000).toFixed(0), taskMs: +((c1.task - c0.task) * 1000).toFixed(0) };
  if (opt.trace) r.gc = gcSummary(await traceStop());
  return r;
}
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
function summarise(runs, label) {
  const mine = runs.filter(r => r.label === label);
  const frames = mine.reduce((n, r) => n + r.frames + r.warmup, 0);
  const o = { median: +median(mine.map(r => r.median)).toFixed(2), p95: +median(mine.map(r => r.p95)).toFixed(2), refused: mine.reduce((n, r) => n + r.refused, 0) };
  if (mine[0] && mine[0].gc) o.gcMsPerFrame = +(mine.reduce((n, r) => n + r.gc.ms, 0) / frames).toFixed(2);
  // Main-thread task time per frame. Close to wall time means the frame is CPU-bound on the main
  // thread; well under it means the page is waiting (GPU, compositor). ScriptDuration is not
  // used: Chrome does not attribute rAF-driven work to it and it reads ~0 here.
  o.mainThreadMsPerFrame = +(mine.reduce((n, r) => n + r.cpu.taskMs, 0) / frames).toFixed(2);
  return o;
}

console.log(`3Dmol animation-path benchmark  (${sources.length} workloads, style=${opt.style}, ${opt.frames} frames x ${opt.repeats} repeats, warmup ${opt.warmup}${opt.strict ? '' : ', no-strict'})`);
const results = [];
for (const src of sources) {
  process.stdout.write('  ' + src.name.padEnd(36));
  const r = { name: src.name, runs: [] };
  try {
    Object.assign(r, await page.evaluate((s, st) => window.bench.setup(s, st), src, opt.style));
    r.hash = await page.evaluate(() => window.bench.hashCheck());
    if (!r.hash.equal && opt.strict) throw new Error('output hash mismatch (baseline vs fast draw different geometry); rerun with --no-strict to time anyway');
    // Alternate order per repeat so drift lands on both paths evenly.
    for (let rep = 0; rep < opt.repeats; rep++)
      for (const which of (rep % 2 === 0 ? ['baseline', 'fast'] : ['fast', 'baseline']))
        r.runs.push({ repeat: rep, ...(await instrumentedPass(which)) });
    if (opt.allocFrames > 0) {
      r.alloc = { baseline: await page.evaluate(n => window.bench.alloc('baseline', n), opt.allocFrames),
                  fast: await page.evaluate(n => window.bench.alloc('fast', n), opt.allocFrames) };
      if (r.alloc.baseline.bytesPerFrame === 0) r.alloc.note = 'counter saw nothing: bundle may capture constructors at load';
    }
    r.summary = { baseline: summarise(r.runs, 'baseline'), fast: summarise(r.runs, 'fast') };
    r.summary.speedup = +(r.summary.baseline.median / r.summary.fast.median).toFixed(2);
    const b = r.summary.baseline, f = r.summary.fast;
    console.log(`atoms=${String(r.atoms).padStart(6)}  base=${b.median.toFixed(1)}ms` + (b.gcMsPerFrame !== undefined ? ` (gc ${b.gcMsPerFrame})` : '') +
      `  fast=${f.median.toFixed(1)}ms` + (f.gcMsPerFrame !== undefined ? ` (gc ${f.gcMsPerFrame})` : '') +
      `  x${r.summary.speedup}  hash=${r.hash.equal ? 'equal' : 'MISMATCH'}` +
      (r.alloc ? `  alloc=${(r.alloc.baseline.bytesPerFrame / 1e6).toFixed(2)}/${(r.alloc.fast.bytesPerFrame / 1e6).toFixed(2)}MB` : '') +
      (f.refused ? `  REFUSED=${f.refused}` : ''));
  } catch (e) {
    r.error = String(e.message || e);
    console.log('FAILED ' + r.error);
  }
  await page.evaluate(() => window.bench.teardown());
  results.push(r);
}
const renderer = await page.evaluate(() => window.bench.gpu());
await browser.close(); server.close();

const report = {
  when: new Date().toISOString(), options: opt,
  machine: { platform: process.platform, cpu: os.cpus()[0] && os.cpus()[0].model, cores: os.cpus().length, memGB: +(os.totalmem() / 2 ** 30).toFixed(1), renderer, node: process.version, chrome },
  results,
};
const outFile = opt.out || path.join(HERE, 'results-' + report.when.replace(/[:.]/g, '-') + '.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log('\nrenderer: ' + renderer + '\ncpu: ' + report.machine.cpu + '\nwrote ' + path.relative(ROOT, outFile));
