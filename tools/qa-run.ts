// The automated QA scenario runner (docs/qa.md): drives its own headless, muted Chrome over
// CDP through scenarios (the new-game opening, towns by day and night, a fight), with the
// page's QA monitors (src/shell/qa/) on, and writes a JSON and Markdown report per scenario,
// with screenshots of each first anomaly per actor, and a summary, to a folder OUTSIDE the
// repository (screenshots show the game's content).
//
//   node tools/qa-run.ts --out <folder> [scenario ...] [--seconds N] [--url http://localhost:5202]
//                        [--vite-port 5202] [--chrome-port 9362] [--list]
//
// Without --url it starts the repository's Vite on --vite-port and stops it at the end.

import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  buildScenarioReport,
  scenarioMarkdown,
  summaryMarkdown,
  type QaOutcome,
  type QaScenarioReport,
} from '../src/shell/qa/report.ts';
import type { QaAnomaly, QaSnapshot } from '../src/shell/qa/types.ts';
import { Cdp, Page, sleep, startChrome, startVite, stopProcess, waitFor } from './qa-cdp.ts';
import { PLACES, SCENARIOS, type Scenario, type ScenarioContext } from './qa-scenarios.ts';

const root = path.resolve(import.meta.dirname, '..');
const WIDTH = 1280;
const HEIGHT = 720;
/** Screenshots per scenario at most (the first anomaly of a kind per subject each). */
const MAX_SHOTS = 80;
/** A page that does not answer within this is hung (ms). */
const PING_MS = 15000;

interface Options {
  readonly out: string;
  readonly scenarios: readonly Scenario[];
  readonly seconds: number | undefined;
  readonly url: string | undefined;
  readonly vitePort: number;
  readonly chromePort: number;
}

function parseOptions(argv: readonly string[]): Options | undefined {
  let out: string | undefined;
  let seconds: number | undefined;
  let url: string | undefined;
  let vitePort = 5202;
  let chromePort = 9362;
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const value = (): string => argv[++i] ?? '';
    if (arg === '--out') out = value();
    else if (arg === '--seconds') seconds = Number(value());
    else if (arg === '--url') url = value();
    else if (arg === '--vite-port') vitePort = Number(value());
    else if (arg === '--chrome-port') chromePort = Number(value());
    else if (arg === '--list') {
      for (const scenario of [...SCENARIOS, ...PLACES])
        console.log(`${scenario.name.padEnd(16)} ${scenario.description}`);
      console.log(`${'places'.padEnd(16)} every at-… scenario, one after the other`);
      return undefined;
    } else names.push(arg);
  }
  if (!out) throw new Error('--out <folder> is required (outside the repository)');
  const resolved = path.resolve(out);
  if (resolved.toLowerCase().startsWith(root.toLowerCase()))
    throw new Error(
      `--out must lie outside the repository (screenshots show game content): ${resolved}`,
    );
  const scenarios =
    names.length === 0
      ? SCENARIOS
      : names.flatMap((name) => {
          // "places": every place of the sweep (PLACES), each a game of its own.
          if (name === 'places') return PLACES;
          const scenario = [...SCENARIOS, ...PLACES].find((s) => s.name === name);
          if (!scenario) throw new Error(`no scenario '${name}' (--list shows them)`);
          return [scenario];
        });
  return { out: resolved, scenarios, seconds, url, vitePort, chromePort };
}

/** The in-page hook: each first anomaly of a subject asks the runner for a screenshot. */
const SHOT_HOOK = `(() => {
  const qa = window.engineDev?.qa;
  if (!qa) return false;
  const skip = new Set(['log-error', 'log-warning', 'console-error', 'long-frame', 'quest-stall', 'hang']);
  qa.onAnomaly = (anomaly) => {
    if (!anomaly.first || skip.has(anomaly.kind) || typeof window.qaShot !== 'function') return;
    window.qaShot(JSON.stringify({ id: anomaly.id, kind: anomaly.kind }));
  };
  return true;
})()`;

/** Starts a game from the shell: the play card, the launcher, the main menu, then NEW or coc. */
async function bootGame(
  page: Page,
  base: string,
  scenario: Scenario,
  ctx: ScenarioContext,
): Promise<void> {
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
  await page.eval(
    `(() => { document.getElementById('launcher-play')?.click(); return true; })()`,
    10000,
  );
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
  if (scenario.start.kind === 'new') {
    ctx.note('new game');
    await page.eval(`(engineDev.play().startMenu.received('NEW', []), true)`, 10000);
  } else {
    ctx.note(`coc ${scenario.start.cell}`);
    const answer = await page.eval<string[]>(
      `engineDev.play().runConsole(${JSON.stringify(`coc ${scenario.start.cell}`)})`,
      60000,
    );
    if (answer.length > 0) throw new Error(`coc: ${answer.join(' ')}`);
  }
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

/** Answers the boxes a scenario does not care about (Survival Mode: No). */
async function answerBoxes(page: Page): Promise<void> {
  await page.eval(
    `(() => { const p = engineDev.play(); const box = p && [...p.host.menus].find(x => x.movie === 'messagebox.swf'); if (!box) return false; const text = String(box.get('_root.MessageMenu.MessageText.text') ?? ''); if (!/Survival Mode/.test(text)) return false; box.received('buttonPress', [0, 1]); return true; })()`,
    10000,
  );
}

async function runScenario(
  cdp: Cdp,
  base: string,
  scenario: Scenario,
  options: Options,
): Promise<QaScenarioReport> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const folder = path.join(options.out, scenario.name);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(path.join(folder, 'shots'), { recursive: true });
  const notes: string[] = [];
  const extra: QaAnomaly[] = [];
  const shots = new Map<number, string>();
  const watchSeconds = options.seconds ?? scenario.seconds;
  const deadline = started + (scenario.bootSeconds + watchSeconds + 120) * 1000;
  const page = await Page.open(cdp, WIDTH, HEIGHT);
  let outcome: QaOutcome = 'done';
  let snapshot:
    (QaSnapshot & { readonly events?: readonly { time: number; text: string }[] }) | undefined;
  const elapsed = (): number => (Date.now() - started) / 1000;
  const ctx: ScenarioContext = {
    page,
    note: (text) => {
      const line = `${elapsed().toFixed(0)} s: ${text}`;
      notes.push(line);
      console.log(`  [${scenario.name}] ${line}`);
      void page
        .eval(`(engineDev.qa?.running && engineDev.qa.note(${JSON.stringify(text)}), true)`, 5000)
        .catch(() => undefined);
    },
    console: (line) =>
      page.eval<string[]>(`engineDev.play().runConsole(${JSON.stringify(line)})`, 60000),
    state: {},
  };
  // Screenshots, one at a time, as the page asks for them (late ones are skipped).
  let shooting = Promise.resolve();
  const stopShots = page.on('Runtime.bindingCalled', (params) => {
    if (params.name !== 'qaShot' || shots.size >= MAX_SHOTS) return;
    const asked = Date.now();
    const { id, kind } = JSON.parse(String(params.payload)) as { id: number; kind: string };
    shooting = shooting.then(async () => {
      if (Date.now() - asked > 3000) return;
      const file = `${String(id).padStart(5, '0')}-${kind}.jpg`;
      // From a camera of its own pointed at the place (the view given back after).
      await page.eval(`engineDev.qa.frame(${String(id)})`, 5000).catch(() => false);
      await page.screenshot(path.join(folder, 'shots', file)).then(
        () => shots.set(id, file),
        () => undefined,
      );
      await page.eval('(engineDev.qa.unframe(), true)', 5000).catch(() => undefined);
    });
  });
  try {
    await page.send('Runtime.addBinding', { name: 'qaShot' });
    await bootGame(page, base, scenario, ctx);
    ctx.note('in the world');
    await sleep(2000);
    await answerBoxes(page).catch(() => undefined);
    if (scenario.hour !== undefined) await ctx.console(`set gamehour to ${scenario.hour}`);
    if (scenario.weather !== undefined) await ctx.console(`fw ${scenario.weather.toString(16)}`);
    // The actors of the place settle first (their schedules after a jump in time); the opening
    // is watched from its first moment.
    if (scenario.start.kind === 'coc')
      await waitFor(
        () =>
          page.eval<boolean | undefined>(
            `((s) => s?.away.scheduling.busy || s?.placing)(engineDev.world.actorStage ?? engineDev.viewer.actorStage) ? undefined : true`,
            10000,
          ),
        30000,
      );
    await scenario.setup?.(ctx);
    const hooked = await page.eval<boolean>(
      `(engineDev.qa.start(${JSON.stringify({ watchQuests: scenario.watchQuests ?? {}, bootLog: true })}), ${SHOT_HOOK})`,
      10000,
    );
    if (!hooked) notes.push('the QA monitors were not there');
    ctx.note(`monitors on for ${watchSeconds} s`);
    const watchStart = Date.now();
    while (Date.now() - watchStart < watchSeconds * 1000) {
      if (Date.now() > deadline) {
        outcome = 'timeout';
        ctx.note('the scenario ran out of time');
        break;
      }
      try {
        await page.eval('1', PING_MS);
      } catch {
        outcome = 'hang';
        ctx.note(`the page stopped answering (${PING_MS / 1000} s)`);
        extra.push(hangAnomaly((Date.now() - watchStart) / 1000));
        break;
      }
      await answerBoxes(page).catch(() => undefined);
      const done = await scenario.tick?.(ctx).catch((error: unknown) => {
        ctx.note(`step failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      });
      if (done === true) {
        ctx.note('the scenario reached its end');
        break;
      }
      await sleep(1000);
    }
    if (outcome !== 'hang') {
      await scenario.finish?.(ctx).catch(() => undefined);
      snapshot = await page.eval(
        `(() => { const s = engineDev.qa.snapshot(); engineDev.qa.stop(); return s; })()`,
        60000,
      );
    }
  } catch (error: unknown) {
    outcome = outcome === 'done' ? 'error' : outcome;
    ctx.note(`error: ${error instanceof Error ? error.message : String(error)}`);
    snapshot ??= await page
      .eval<QaSnapshot>(
        `(() => { const s = engineDev.qa?.snapshot(); engineDev.qa?.stop(); return s; })()`,
        15000,
      )
      .catch(() => undefined);
  } finally {
    stopShots();
  }
  await Promise.race([shooting, sleep(5000)]);
  await page.close();
  const anomalies = (snapshot?.anomalies ?? []).map((anomaly) => {
    const shot = shots.get(anomaly.id);
    return shot ? { ...anomaly, shot } : anomaly;
  });
  const report = buildScenarioReport({
    scenario: scenario.name,
    description: scenario.description,
    startedAt,
    seconds: elapsed(),
    outcome,
    notes,
    snapshot: snapshot && { ...snapshot, anomalies },
    extra,
  });
  fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(folder, 'report.md'), scenarioMarkdown(report));
  return report;
}

/**
 * The summary over every scenario report in the output folder (this run's and earlier ones':
 * one scenario can be run again and the summary still covers all), in the scenarios' order.
 */
function writeSummary(out: string): void {
  const order = (name: string): number => {
    const at = [...SCENARIOS, ...PLACES].findIndex((scenario) => scenario.name === name);
    return at < 0 ? SCENARIOS.length + PLACES.length : at;
  };
  const reports: QaScenarioReport[] = [];
  for (const entry of fs.readdirSync(out, { withFileTypes: true })) {
    const file = path.join(out, entry.name, 'report.json');
    if (!entry.isDirectory() || !fs.existsSync(file)) continue;
    try {
      reports.push(JSON.parse(fs.readFileSync(file, 'utf8')) as QaScenarioReport);
    } catch {
      // A report half written (a run stopped while writing it): left out.
    }
  }
  reports.sort((a, b) => order(a.scenario) - order(b.scenario));
  fs.writeFileSync(
    path.join(out, 'summary.md'),
    summaryMarkdown(reports, `QA run ${new Date().toISOString()}`),
  );
  fs.writeFileSync(
    path.join(out, 'summary.json'),
    JSON.stringify(
      reports.map((report) => ({ ...report, anomalies: undefined })),
      null,
      1,
    ),
  );
}

function hangAnomaly(time: number): QaAnomaly {
  return {
    id: 0,
    kind: 'hang',
    system: 'shell',
    subject: undefined,
    time,
    gameHour: undefined,
    position: undefined,
    cell: undefined,
    states: undefined,
    clips: undefined,
    context: undefined,
    detail: `the page did not answer within ${PING_MS / 1000} s`,
    values: {},
    severity: 1,
    duration: 0,
    first: true,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) return;
  fs.mkdirSync(options.out, { recursive: true });
  let vite: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  const startChromeAndConnect = async (): Promise<Cdp> => {
    stopProcess(chrome);
    chrome = await startChrome({
      port: options.chromePort,
      profile: path.join(options.out, '.chrome-profile'),
      width: WIDTH,
      height: HEIGHT,
    });
    return Cdp.connect(options.chromePort);
  };
  try {
    const base = options.url ?? `http://localhost:${options.vitePort}`;
    if (!options.url) {
      console.log(`starting Vite on ${options.vitePort}...`);
      vite = await startVite(root, options.vitePort);
    }
    console.log(`starting Chrome on ${options.chromePort}...`);
    cdp = await startChromeAndConnect();
    for (const scenario of options.scenarios) {
      console.log(`scenario ${scenario.name}: ${scenario.description}`);
      if (cdp.closed) cdp = await startChromeAndConnect();
      const report = await runScenario(cdp, base, scenario, options).catch(
        async (error: unknown) => {
          // The browser itself failed: a fresh one for the next scenario.
          console.log(
            `  ${scenario.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          cdp?.close();
          cdp = await startChromeAndConnect();
          return buildScenarioReport({
            scenario: scenario.name,
            description: scenario.description,
            startedAt: new Date().toISOString(),
            seconds: 0,
            outcome: 'error',
            notes: [String(error)],
            snapshot: undefined,
          });
        },
      );
      console.log(
        `  ${scenario.name}: ${report.outcome}, ${report.total} anomalies (${report.systems.map((s) => `${s.system} ${s.count}`).join(', ')})` +
          (report.frames ? `, ${report.frames.fps} fps, p99 ${report.frames.p99} ms` : ''),
      );
      writeSummary(options.out);
    }
    console.log(`reports in ${options.out}`);
  } finally {
    cdp?.close();
    stopProcess(chrome);
    stopProcess(vite);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
