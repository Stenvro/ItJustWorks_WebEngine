// Frame-time profile of the new-game opening in the browser: boots a New Game in a headless,
// muted Chrome (as tools/qa-run.ts does, without the QA monitors, which cost frame time of their
// own), drives the opening as the `opening` QA scenario does (the race menu, then the follow bot
// into the keep), and every --every seconds measures a window of --window seconds:
//
// - the page's frame intervals (requestAnimationFrame deltas): fps, percentiles, long frames;
// - the GPU's time per frame (timestamps round every pass, summed);
// - a CPU profile of the main thread (CDP Profiler), summarised as self and inclusive time per
//   function and per source file; written whole as <n>-<stage>.cpuprofile (DevTools opens it);
// - the long animation frames (> 50 ms) with the scripts they ran;
// - a screenshot.
//
//   node tools/qa-perf.ts --out <folder> [--minutes 16] [--every 30] [--window 6]
//                         [--vite-port 5201] [--chrome-port 9401] [--until-stage N]
//                         [--width 1280] [--height 720]
//
// The summary per window and per MQ101 stage goes to <folder>/perf.json and perf.md. The folder
// must lie outside the repository (screenshots show the game's content).

import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Cdp, Page, sleep, startChrome, startVite, stopProcess, waitFor } from './qa-cdp.ts';
import { SCENARIOS, type ScenarioContext } from './qa-scenarios.ts';

const root = path.resolve(import.meta.dirname, '..');
const MQ101 = 0x3372b;

interface Options {
  readonly out: string;
  readonly minutes: number;
  readonly every: number;
  readonly window: number;
  readonly vitePort: number;
  readonly chromePort: number;
  readonly untilStage: number | undefined;
  /** The page's size (CSS pixels at a device pixel ratio of 1). */
  readonly width: number;
  readonly height: number;
}

function parseOptions(argv: readonly string[]): Options {
  let out: string | undefined;
  let minutes = 16;
  let every = 30;
  let window = 6;
  let vitePort = 5201;
  let chromePort = 9401;
  let untilStage: number | undefined;
  let width = 1280;
  let height = 720;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg ?? ''} needs a value`);
      return next;
    };
    if (arg === '--out') out = value();
    else if (arg === '--minutes') minutes = Number(value());
    else if (arg === '--every') every = Number(value());
    else if (arg === '--window') window = Number(value());
    else if (arg === '--vite-port') vitePort = Number(value());
    else if (arg === '--chrome-port') chromePort = Number(value());
    else if (arg === '--until-stage') untilStage = Number(value());
    else if (arg === '--width') width = Number(value());
    else if (arg === '--height') height = Number(value());
    else throw new Error(`unknown argument ${arg ?? ''}`);
  }
  if (!out) throw new Error('--out <folder> is required (outside the repository)');
  const resolved = path.resolve(out);
  const relative = path.relative(root, resolved);
  if (!relative.startsWith('..') && !path.isAbsolute(relative))
    throw new Error(`--out must lie outside the repository: ${resolved}`);
  return { out: resolved, minutes, every, window, vitePort, chromePort, untilStage, width, height };
}

// --- The CPU profile's summary -------------------------------------------------------------

interface ProfileNode {
  readonly id: number;
  readonly callFrame: {
    readonly functionName: string;
    readonly url: string;
    readonly lineNumber: number;
  };
  readonly children?: readonly number[];
}

interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

export interface ProfileSummary {
  /** Sampled milliseconds in all. */
  readonly totalMs: number;
  readonly idleMs: number;
  readonly gcMs: number;
  /** Self time by function (ms), the largest first. */
  readonly self: readonly (readonly [string, number])[];
  /** Inclusive time by function (ms). */
  readonly inclusive: readonly (readonly [string, number])[];
  /** Inclusive time by source file (ms). */
  readonly files: readonly (readonly [string, number])[];
}

function shortUrl(url: string): string {
  if (url === '') return '';
  const clean = url.replace(/\?.*$/, '');
  const src = clean.indexOf('/src/');
  if (src >= 0) return clean.slice(src + 5);
  const deps = clean.indexOf('/node_modules/');
  if (deps >= 0) return clean.slice(deps + 14).replace(/^\.vite\/deps\//, 'deps/');
  return clean.replace(/^https?:\/\/[^/]+\//, '');
}

export function summariseProfile(profile: CpuProfile, top = 60): ProfileSummary {
  const byId = new Map<number, ProfileNode>();
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  const fnKey = (node: ProfileNode): string => {
    const file = shortUrl(node.callFrame.url);
    const name = node.callFrame.functionName || '(anonymous)';
    return file === '' ? name : `${name} ${file}:${String(node.callFrame.lineNumber + 1)}`;
  };
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  const files = new Map<string, number>();
  let total = 0;
  let idle = 0;
  let gc = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
    total += dt;
    const node = byId.get(id);
    if (!node) return;
    const name = node.callFrame.functionName;
    if (name === '(idle)') idle += dt;
    if (name === '(garbage collector)') gc += dt;
    const key = fnKey(node);
    self.set(key, (self.get(key) ?? 0) + dt);
    const seenFn = new Set<string>();
    const seenFile = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const n = byId.get(at);
      if (!n) break;
      const k = fnKey(n);
      if (!seenFn.has(k)) {
        seenFn.add(k);
        inclusive.set(k, (inclusive.get(k) ?? 0) + dt);
      }
      const file = shortUrl(n.callFrame.url);
      if (file !== '' && !seenFile.has(file)) {
        seenFile.add(file);
        files.set(file, (files.get(file) ?? 0) + dt);
      }
    }
  });
  const sorted = (map: Map<string, number>): (readonly [string, number])[] =>
    [...map].sort((a, b) => b[1] - a[1]).slice(0, top);
  return {
    totalMs: total,
    idleMs: idle,
    gcMs: gc,
    self: sorted(self),
    inclusive: sorted(inclusive),
    files: sorted(files),
  };
}

// --- The page's frame recorder -------------------------------------------------------------

/** Installed once in the world: rAF deltas, GPU completion times, long animation frames. */
const RECORDER = `(() => {
  if (window.__perf) return true;
  const perf = { deltas: [], gpu: [], loaf: [], last: undefined };
  const tick = (now) => {
    if (perf.last !== undefined) perf.deltas.push(now - perf.last);
    perf.last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const device = engineDev.device;
  const queue = device.queue;
  // The GPU's time per submit: every pass not timed already gets timestamps (begin, end), the
  // submit resolves them, and the sum of the passes' durations is read back.
  if (device.features.has('timestamp-query')) {
    const COUNT = 4096;
    const set = device.createQuerySet({ type: 'timestamp', count: COUNT });
    const resolved = device.createBuffer({ size: COUNT * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const spare = [];
    let used = 0;
    const timed = (begin) => function (descriptor) {
      if (descriptor && !descriptor.timestampWrites && used + 2 <= COUNT) {
        descriptor = { ...descriptor, timestampWrites: { querySet: set, beginningOfPassWriteIndex: used, endOfPassWriteIndex: used + 1 } };
        used += 2;
      }
      return begin.call(this, descriptor);
    };
    const proto = GPUCommandEncoder.prototype;
    proto.beginRenderPass = timed(proto.beginRenderPass);
    proto.beginComputePass = timed(proto.beginComputePass);
    const submit = queue.submit.bind(queue);
    queue.submit = (buffers) => {
      if (used === 0) return submit(buffers);
      const count = used;
      used = 0;
      const readback = spare.pop() ?? device.createBuffer({ size: COUNT * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder({ label: 'perf timestamps' });
      encoder.resolveQuerySet(set, 0, count, resolved, 0);
      encoder.copyBufferToBuffer(resolved, 0, readback, 0, count * 8);
      submit([...buffers, encoder.finish()]);
      void readback.mapAsync(GPUMapMode.READ, 0, count * 8).then(() => {
        const stamps = new BigInt64Array(readback.getMappedRange(0, count * 8));
        let ns = 0n;
        for (let i = 0; i + 1 < count; i += 2) {
          const d = stamps[i + 1] - stamps[i];
          if (d > 0n && d < 1000000000n) ns += d;
        }
        readback.unmap();
        spare.push(readback);
        perf.gpu.push(Number(ns) / 1e6);
      }, () => undefined);
    };
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 50) continue;
        perf.loaf.push({
          start: Math.round(e.startTime),
          duration: Math.round(e.duration),
          scripts: (e.scripts ?? [])
            .filter((s) => s.duration >= 10)
            .slice(0, 6)
            .map((s) => ({ ms: Math.round(s.duration), at: String(s.sourceURL ?? '').replace(/^.*\\/src\\//, '').replace(/\\?.*$/, '') + ' ' + (s.sourceFunctionName ?? ''), invoker: String(s.invoker ?? '').slice(0, 80) })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch {}
  window.__perf = perf;
  return true;
})()`;

const STATE = `(async () => {
  const p = engineDev.play(); const rt = p?.session.scriptsReady;
  const at = rt && await rt.placement(0x14);
  const stage = engineDev.world.actorStage ?? engineDev.viewer.actorStage;
  return {
    stage: rt?.state.quests.get(${MQ101})?.stage ?? -1,
    cell: at ? (at.world === undefined ? 'interior ' + at.cell?.toString(16) : 'exterior') : '?',
    position: at?.position?.map((v) => Math.round(v)),
    actors: stage ? [...(stage.placed?.values?.() ?? [])].length : undefined,
    menus: [...(p?.host.menus ?? [])].map((x) => x.movie.replace('.swf', '')).join('/'),
  };
})()`;

/**
 * Counters on the play's physics: the steps it takes (several a frame when frames are long).
 * Installed again after a load door (a new play).
 */
const COUNTERS = `var ph = (engineDev.world.play ?? engineDev.viewer.play)?.physics;
var perf = window.__perf;
if (ph && perf && perf.countedOn !== ph) {
  perf.countedOn = ph;
  perf.counts = { steps: 0 };
  var step = ph.step.bind(ph);
  ph.step = (seconds, before) => { var n = step(seconds, before); perf.counts.steps += n; return n; };
}
true`;

/** The counters' values now, and the world's bodies and the path searches so far. */
const COUNTS = `(async () => {
  const ph = (engineDev.world.play ?? engineDev.viewer.play)?.physics;
  const paths = (await import('/src/ai/pathfinding.ts')).pathSearchStats;
  const stage = engineDev.world.actorStage ?? engineDev.viewer.actorStage;
  return {
    ...(window.__perf.counts ?? {}),
    searches: paths.searches,
    nodes: paths.nodes,
    reached: paths.reached,
    bodies: ph?.world.bodies.len(),
    colliders: ph?.world.colliders.len(),
    awake: (() => {
      let n = 0;
      ph?.world.bodies.forEach((b) => {
        if (b.isDynamic() && !b.isSleeping()) n++;
      });
      return n;
    })(),
    actors: stage ? [...stage.all()].length : undefined,
  };
})()`;

/** Starts keeping every path search (pathSearchStats.trace). */
const TRACE_START = `import('/src/ai/pathfinding.ts').then((m) => { m.pathSearchStats.trace = []; return true; })`;

/**
 * The searches kept since TRACE_START, by the actor nearest where each began: how many, the
 * nodes they took, how many reached their goal, and where the last one went (the trace ends).
 */
const TRACE_TAKE = `(async () => {
  const stats = (await import('/src/ai/pathfinding.ts')).pathSearchStats;
  const trace = stats.trace ?? [];
  stats.trace = undefined;
  const stage = engineDev.world.actorStage ?? engineDev.viewer.actorStage;
  const actors = stage ? [...stage.all()] : [];
  const by = new Map();
  for (const t of trace) {
    let best; let bestD = Infinity;
    for (const a of actors) {
      const d = Math.hypot(a.position[0] - t.from[0], a.position[1] - t.from[1]);
      if (d < bestD) { bestD = d; best = a; }
    }
    const key = best && bestD < 600 ? (best.placed.actor.editorId || best.reference.toString(16)) : 'player/other';
    const e = by.get(key) ?? { searches: 0, nodes: 0, reached: 0, to: undefined, from: undefined };
    e.searches++; e.nodes += t.nodes; if (t.reached) e.reached++;
    e.to = t.to.map(Math.round); e.from = t.from.map(Math.round);
    by.set(key, e);
  }
  return [...by].sort((a, b) => b[1].nodes - a[1].nodes).slice(0, 12);
})()`;

interface Counts {
  readonly steps?: number;
  readonly searches?: number;
  readonly nodes?: number;
  readonly reached?: number;
  readonly bodies?: number;
  readonly colliders?: number;
  readonly awake?: number;
  readonly actors?: number;
}

/** Per frame over a window: the counters' growth over its frames. */
function perFrame(before: Counts, after: Counts, frames: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ['steps', 'searches', 'nodes', 'reached'] as const) {
    const a = before[key];
    const b = after[key];
    if (a !== undefined && b !== undefined) out[key] = (b - a) / Math.max(1, frames);
  }
  for (const key of ['bodies', 'colliders', 'awake', 'actors'] as const) {
    const b = after[key];
    if (b !== undefined) out[key] = b;
  }
  return out;
}

interface FrameStats {
  readonly frames: number;
  readonly fps: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly over33: number;
  readonly over50: number;
}

function frameStats(deltas: readonly number[]): FrameStats {
  const sorted = [...deltas].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const sum = deltas.reduce((a, b) => a + b, 0);
  return {
    frames: deltas.length,
    fps: sum > 0 ? (deltas.length * 1000) / sum : 0,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    over33: deltas.filter((d) => d > 33.4).length,
    over50: deltas.filter((d) => d > 50).length,
  };
}

interface WindowReport {
  readonly index: number;
  readonly at: number;
  readonly state: { stage: number; cell: string; position?: number[]; menus: string };
  readonly frames: FrameStats;
  /** Frames in the profiled window (the per-frame times of the profile are over these). */
  readonly profiledFrames: number;
  readonly gpu: { readonly p50: number; readonly p95: number; readonly count: number };
  readonly busyShare: number;
  readonly profile: ProfileSummary;
  readonly loaf: readonly unknown[];
  /** Per frame (physics steps, path searches and their nodes) and totals now. */
  readonly counts: Record<string, number>;
  /** The path searches of the plain window by the actor that searched (TRACE_TAKE). */
  readonly searchers: readonly unknown[];
}

async function bootNewGame(page: Page, base: string): Promise<void> {
  await page.navigate(`${base}/?devdata`);
  const card = await waitFor(
    () =>
      page.eval<string>(
        `(() => { const card = document.getElementById('menu-play'); if (!card || card.disabled || !/ready/i.test(document.getElementById('console-status')?.textContent ?? '')) return undefined; card.click(); return 'card'; })()`,
        10000,
      ),
    90000,
  );
  if (!card) throw new Error('the shell never became ready (game data?)');
  await sleep(1500);
  await page.eval(`(document.getElementById('launcher-play')?.click(), true)`, 10000);
  const menu = await waitFor(
    () =>
      page.eval<number | undefined>(
        `(() => { const p = window.engineDev?.play?.(); const m = p && [...p.host.menus].find(x => x.movie === 'startmenu.swf'); const n = m?.get('_root.MenuHolder.Menu_mc.MainList.entryList.length') ?? 0; return n >= 5 ? n : undefined; })()`,
        10000,
      ),
    120000,
  );
  if (!menu) throw new Error('the main menu did not open');
  await sleep(1500);
  await page.eval(`(engineDev.play().startMenu.received('StartNewGame', []), true)`, 10000);
  const inWorld = await waitFor(
    () =>
      page.eval<boolean | undefined>(
        `(() => { const p = engineDev.play(); const hud = [...p.host.menus].some(x => x.movie === 'hudmenu.swf'); return hud && !p.session.loading && engineDev.world.loading === undefined && engineDev.viewer.loading === undefined ? true : undefined; })()`,
        10000,
      ),
    300000,
    2000,
  );
  if (!inWorld) throw new Error('the game never got into the world');
}

const ms = (value: number): string => value.toFixed(1);

function windowMarkdown(w: WindowReport): string {
  const f = w.frames;
  const lines = [
    `## ${String(w.index)}: ${String(w.at)} s, MQ101 stage ${String(w.state.stage)}, ${w.state.cell}`,
    '',
    `fps ${ms(f.fps)} · p50 ${ms(f.p50)} · p95 ${ms(f.p95)} · p99 ${ms(f.p99)} · max ${ms(f.max)} ms · > 33 ms ${String(f.over33)} · > 50 ms ${String(f.over50)} · GPU p50 ${ms(w.gpu.p50)} / p95 ${ms(w.gpu.p95)} ms · main thread busy ${(w.busyShare * 100).toFixed(0)} % · GC ${ms(w.profile.gcMs)} ms`,
    '',
    '| inclusive (function) | ms/frame |',
    '| --- | ---: |',
    ...w.profile.inclusive
      .slice(0, 45)
      .map(([name, t]) => `| ${name} | ${(t / Math.max(1, w.profiledFrames)).toFixed(2)} |`),
    '',
    '| self (function) | ms/frame |',
    '| --- | ---: |',
    ...w.profile.self
      .slice(0, 30)
      .map(([name, t]) => `| ${name} | ${(t / Math.max(1, w.profiledFrames)).toFixed(2)} |`),
    '',
    '| file (inclusive) | ms/frame |',
    '| --- | ---: |',
    ...w.profile.files
      .slice(0, 30)
      .map(([name, t]) => `| ${name} | ${(t / Math.max(1, w.profiledFrames)).toFixed(2)} |`),
    '',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  fs.mkdirSync(options.out, { recursive: true });
  const opening = SCENARIOS.find((s) => s.name === 'opening');
  if (!opening) throw new Error('no opening scenario');
  let vite: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  const started = Date.now();
  const elapsed = (): number => Math.round((Date.now() - started) / 1000);
  const run = { driving: true, ended: false };
  try {
    console.log(`starting Vite on ${String(options.vitePort)}...`);
    vite = await startVite(root, options.vitePort);
    chrome = await startChrome({
      port: options.chromePort,
      profile: path.join(options.out, '.chrome-profile'),
      width: options.width,
      height: options.height,
    });
    cdp = await Cdp.connect(options.chromePort);
    const page = await Page.open(cdp, options.width, options.height);
    const notes: string[] = [];
    const ctx: ScenarioContext = {
      page,
      note: (text) => {
        const line = `${String(elapsed())} s: ${text}`;
        notes.push(line);
        console.log(`  ${line}`);
      },
      console: (line) =>
        page.eval<string[]>(`engineDev.play().runConsole(${JSON.stringify(line)})`, 60000),
      state: {},
    };
    await bootNewGame(page, `http://localhost:${String(options.vitePort)}`);
    ctx.note('in the world');
    const adapter = await page.eval<string>(
      `navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).then((a) => a ? [a.info.vendor, a.info.architecture, a.info.description].join(' ') : 'none')`,
    );
    ctx.note(
      `GPU adapter: ${adapter}, canvas ${await page.eval<string>("(() => { const c = document.querySelector('canvas'); return c ? c.width + 'x' + c.height : '?'; })()")}`,
    );
    await page.eval(RECORDER, 10000);
    await page.send('Profiler.enable');
    await page.send('Profiler.setSamplingInterval', { interval: 500 });
    // The opening's driver (race menu, bot) on its own loop, as the QA runner ticks it.
    const driver = (async () => {
      while (run.driving) {
        // Survival Mode's offer: No.
        await page
          .eval(
            `(() => { const p = engineDev.play(); const box = p && [...p.host.menus].find(x => x.movie === 'messagebox.swf'); if (!box) return false; const text = String(box.get('_root.MessageMenu.MessageText.text') ?? ''); if (!/Survival Mode/.test(text)) return false; box.received('buttonPress', [0, 1]); return true; })()`,
            10000,
          )
          .catch(() => undefined);
        const done = await opening.tick?.(ctx).catch((error: unknown) => {
          ctx.note(`step failed: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        });
        if (done === true) run.ended = true;
        await sleep(1000);
      }
    })();
    const windows: WindowReport[] = [];
    const end = Date.now() + options.minutes * 60000;
    while (Date.now() < end && !run.ended) {
      const state = await page.eval<WindowReport['state']>(STATE, 20000);
      if (options.untilStage !== undefined && state.stage >= options.untilStage) break;
      const reset =
        '(window.__perf.deltas.length = 0, window.__perf.gpu.length = 0, window.__perf.loaf.length = 0, true)';
      const read =
        '({ deltas: [...window.__perf.deltas], gpu: [...window.__perf.gpu], loaf: [...window.__perf.loaf] })';
      // First the frames as they are (the profiler slows the page), then the same time profiled.
      await page.eval(COUNTERS, 10000, true).catch((error: unknown) => {
        if (windows.length < 2)
          ctx.note(`counters: ${error instanceof Error ? error.message : String(error)}`);
      });
      await page.eval(reset);
      const before = await page.eval<Counts>(COUNTS).catch((): Counts => ({}));
      await page.eval(TRACE_START).catch(() => undefined);
      await sleep(options.window * 1000);
      const data = await page.eval<{ deltas: number[]; gpu: number[]; loaf: unknown[] }>(read);
      const after = await page.eval<Counts>(COUNTS).catch((): Counts => ({}));
      const searchers = await page.eval<unknown[]>(TRACE_TAKE).catch(() => []);
      // Starting the profiler holds the page for about 600 ms: its window begins after that.
      await page.send('Profiler.start');
      await sleep(1500);
      await page.eval(reset);
      await sleep(options.window * 1000);
      const { profile } = await page.send<{ profile: CpuProfile }>('Profiler.stop', {}, 60000);
      const profiled = await page.eval<{ deltas: number[] }>(read);
      const index = windows.length;
      const name = `${String(index).padStart(2, '0')}-${String(state.stage)}`;
      fs.writeFileSync(path.join(options.out, `${name}.cpuprofile`), JSON.stringify(profile));
      await page.screenshot(path.join(options.out, `${name}.jpg`)).catch(() => undefined);
      const summary = summariseProfile(profile);
      const gpuSorted = [...data.gpu].sort((a, b) => a - b);
      const report: WindowReport = {
        index,
        at: elapsed(),
        state,
        frames: frameStats(data.deltas),
        profiledFrames: profiled.deltas.length,
        gpu: {
          p50: gpuSorted[Math.floor(gpuSorted.length * 0.5)] ?? 0,
          p95: gpuSorted[Math.floor(gpuSorted.length * 0.95)] ?? 0,
          count: gpuSorted.length,
        },
        busyShare: summary.totalMs > 0 ? 1 - summary.idleMs / summary.totalMs : 0,
        profile: summary,
        loaf: data.loaf,
        counts: perFrame(before, after, data.deltas.length),
        searchers,
      };
      windows.push(report);
      const f = report.frames;
      ctx.note(
        `window ${name}: ${ms(f.fps)} fps, p50 ${ms(f.p50)}, p95 ${ms(f.p95)}, max ${ms(f.max)} ms, GPU p50 ${ms(report.gpu.p50)} ms, busy ${(report.busyShare * 100).toFixed(0)} %, ${JSON.stringify(report.counts)}`,
      );
      fs.writeFileSync(
        path.join(options.out, 'perf.json'),
        JSON.stringify({ notes, windows }, null, 1),
      );
      fs.writeFileSync(
        path.join(options.out, 'perf.md'),
        [
          `# Opening frame profile`,
          '',
          ...notes.map((n) => `- ${n}`),
          '',
          ...windows.map(windowMarkdown),
        ].join('\n'),
      );
      const wait = options.every - 2 * options.window - 1.5;
      if (wait > 0) await sleep(wait * 1000);
    }
    run.driving = false;
    await driver;
    await opening.finish?.(ctx).catch(() => undefined);
    console.log(`written to ${options.out}`);
  } finally {
    run.driving = false;
    cdp?.close();
    stopProcess(chrome);
    stopProcess(vite);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
