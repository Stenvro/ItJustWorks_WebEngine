// The QA runner's scenarios (tools/qa-run.ts, docs/qa.md): where a game starts, what is set up,
// how long the monitors watch, and what is driven meanwhile (the opening's race menu and a
// bot that follows the quest's marker once the player is theirs again).

import type { Page } from './qa-cdp.ts';

export interface ScenarioContext {
  readonly page: Page;
  /** A line in the report's notes (and the monitors' timeline). */
  readonly note: (text: string) => void;
  /** Runs a console line in the game. */
  readonly console: (line: string) => Promise<string[]>;
  /** The scenario's own state between ticks. */
  readonly state: Record<string, unknown>;
}

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly start: { readonly kind: 'new' } | { readonly kind: 'coc'; readonly cell: string };
  /** The game hour set once in the world. */
  readonly hour?: number;
  /** A weather forced once in the world (WTHR form id). */
  readonly weather?: number;
  /** Seconds the game may take to start (the shell, the main menu, the cell). */
  readonly bootSeconds: number;
  /** Seconds the monitors watch. */
  readonly seconds: number;
  /** Quests whose stage must move (form id → seconds). */
  readonly watchQuests?: Readonly<Record<string, number>>;
  /** Once in the world, before the monitors start. */
  readonly setup?: (ctx: ScenarioContext) => Promise<void>;
  /** Every second while the monitors watch; true ends the scenario early. */
  readonly tick?: (ctx: ScenarioContext) => Promise<boolean>;
  /** Before the snapshot (the bot let go). */
  readonly finish?: (ctx: ScenarioContext) => Promise<void>;
}

const MQ101 = 0x3372b;

/**
 * Bandits and Imperial guards (NPC_ form ids of Skyrim.esm): a melee tank, a berserker and an
 * archer against three guards.
 */
const BANDITS = [0x3de91, 0x3dea5, 0x9a549];
const GUARDS = [0xaa8fc, 0xaa8fd, 0xaa901];

/**
 * The follow bot (in the page): it walks the player to the nearest target of the active quests'
 * shown objectives (the compass's quest marker: "Follow Ralof", "Follow Hadvar", the keep's
 * door), along the navmesh (src/ai/pathfinding.ts), through the load door on the way when the
 * target is in another space; a guide near enough is waited for. Stuck, it jumps and searches
 * again; without a path it goes straight (the tower's jump into the inn). Runs as a console
 * line (replMode): the world viewer's navmeshes are a private field.
 */
export const FOLLOW_BOT = `
var QA_NAV = engineDev.world.#navmeshes;
(async () => {
  if (window.__qaBot) return 'running';
  const compass = await import('/src/shell/compass.ts');
  const paths = await import('/src/ai/pathfinding.ts');
  const W = engineDev.world;
  const nav = QA_NAV;
  const bot = { goal: undefined, door: undefined, guide: undefined, path: [], planning: false, lastPlan: 0, last: undefined, still: 0, held: new Set(), log: [], steps: 0 };
  window.__qaBot = bot;
  // The targets of the running quests' shown objectives (as the compass's questTargets, also
  // for a quest the journal has not made the active one: MQ101 is not).
  const objectiveTargets = async (rt) => {
    const found = [];
    for (const [formId, quest] of rt.state.quests) {
      if (!quest.running || quest.completed || quest.failed) continue;
      const record = await rt.forms.quest(formId);
      for (const objective of record?.objectives ?? []) {
        const state = quest.objectives.get(objective.index);
        if (!state?.displayed || state.completed || state.failed) continue;
        for (const target of objective.targets) {
          const reference = quest.aliases.get(target.alias);
          if (reference === undefined) continue;
          if (target.conditions.length > 0 && !(await rt.conditionsHold(target.conditions, rt.referenceHandle(reference), undefined, { quest: formId }))) continue;
          const placement = await rt.placement(reference);
          if (placement) found.push({ quest: formId, objective: objective.index, reference, placement });
        }
      }
    }
    return found;
  };
  const say = (text) => { bot.log.push(Math.round(performance.now() / 1000) + ' ' + text); if (bot.log.length > 50) bot.log.shift(); };
  const events = (code) => W.player?.eventsOfKey(code) ?? [];
  const hold = (code, down) => {
    const player = W.player; if (!player) return;
    if (down === bot.held.has(code)) return;
    for (const name of events(code)) player.press(name, down);
    if (down) bot.held.add(code); else bot.held.delete(code);
  };
  const tap = (code) => { const player = W.player; if (!player) return; for (const name of events(code)) player.press(name, true); setTimeout(() => { for (const name of events(code)) player.press(name, false); }, 120); };
  bot.release = () => { for (const code of [...bot.held]) hold(code, false); };
  const plan = async () => {
    const play = engineDev.play(); const rt = play.session.scriptsReady; const player = W.player;
    if (!rt || !player) return;
    const at = await rt.placement(0x14);
    if (!at) return;
    const targets = await objectiveTargets(rt);
    const here = (p) => at.world !== undefined ? p.world === at.world : p.cell !== undefined && p.cell === at.cell;
    let best;
    for (const t of targets) {
      const same = here(t.placement);
      const d = same ? Math.hypot(t.placement.position[0] - at.position[0], t.placement.position[1] - at.position[1]) : 1e9;
      if (!best || d < best.d) best = { t, d, same };
    }
    if (!best) { bot.goal = undefined; bot.path = []; return; }
    let goal = [...best.t.placement.position];
    bot.door = undefined;
    bot.guide = W.actorStage?.get(best.t.reference) ? best.t.reference : undefined;
    if (!best.same) {
      const door = compass.firstDoorToward(await play.session.routeMap(), at, best.t.placement);
      if (!door) { bot.goal = undefined; bot.path = []; return; }
      bot.door = door.door; goal = [...door.position];
    }
    const feet = [...player.feet];
    const found = nav && paths.findPath(nav, feet, goal, { radius: 24 });
    const changed = !bot.goal || Math.hypot(goal[0] - bot.goal[0], goal[1] - bot.goal[1]) > 64;
    bot.goal = goal;
    bot.path = found && found.points.length > 1 ? found.points.slice(1).map((p) => [...p]) : [goal];
    if (changed) say('goal ' + goal.map(Math.round).join(',') + (bot.door ? ' (door ' + bot.door.toString(16) + ')' : '') + (bot.guide ? ' (guide ' + bot.guide.toString(16) + ')' : '') + ' path ' + (found ? found.points.length + (found.complete ? '' : ' partial') : 'none'));
  };
  bot.timer = setInterval(() => {
    const play = engineDev.play(); const player = W.player;
    const rt = play?.session.scriptsReady;
    if (!player || !rt || rt.controls.aiDriven || play.session.menuMode || W.loading !== undefined) { bot.release(); return; }
    const now = performance.now();
    if (!bot.planning && now - bot.lastPlan > 1500) {
      bot.planning = true; bot.lastPlan = now;
      plan().catch((e) => say('plan failed: ' + e.message)).finally(() => { bot.planning = false; });
    }
    const feet = player.feet;
    const goal = bot.goal;
    if (!goal) { bot.release(); return; }
    const guide = bot.guide !== undefined ? W.actorStage?.get(bot.guide) : undefined;
    const toGoal = Math.hypot(goal[0] - feet[0], goal[1] - feet[1]);
    // A guide near: wait for them to lead on (after a while closer still: a trigger by them).
    const near = bot.waitSince !== undefined && now - bot.waitSince > 8000 ? 90 : 220;
    if (guide && toGoal < near && Math.abs(goal[2] - feet[2]) < 150) { bot.release(); bot.still = 0; bot.waitSince ??= now; return; }
    if (!guide || toGoal > 300) bot.waitSince = undefined;
    // At the door: face it and use it.
    if (bot.door !== undefined && toGoal < 110) {
      bot.release();
      const dz = goal[2] + 70 - (feet[2] + 120);
      player.yaw = Math.atan2(goal[0] - feet[0], goal[1] - feet[1]);
      player.pitch = Math.atan2(dz, Math.max(1, toGoal));
      if (now - (bot.usedDoor ?? 0) > 2500) { bot.usedDoor = now; tap('KeyE'); say('use door ' + bot.door.toString(16)); }
      return;
    }
    while (bot.path.length > 1 && Math.hypot(bot.path[0][0] - feet[0], bot.path[0][1] - feet[1]) < 56) bot.path.shift();
    const next = bot.path[0] ?? goal;
    player.yaw = Math.atan2(next[0] - feet[0], next[1] - feet[1]);
    player.pitch = 0;
    // Sidestepping or backing off (a door frame, a corner) for a moment.
    const dodging = bot.dodge && now < bot.dodge.until;
    hold('KeyW', !(dodging && bot.dodge.key === 'KeyS'));
    for (const key of ['KeyA', 'KeyD', 'KeyS']) hold(key, dodging && bot.dodge.key === key);
    // Stuck: a step aside (each side in turn), every other time a jump; then search again.
    const last = bot.last;
    bot.last = [...feet];
    if (last && Math.hypot(feet[0] - last[0], feet[1] - last[1]) < 1.5) bot.still += 0.1; else bot.still = Math.max(0, bot.still - 0.05);
    if (bot.still > 1.2) {
      bot.still = 0; bot.stuckCount = (bot.stuckCount ?? 0) + 1; bot.lastPlan = 0;
      const move = ['KeyA', 'KeyD', 'KeyS'][bot.stuckCount % 3];
      bot.dodge = { key: move, until: now + 500 + 200 * (bot.stuckCount % 4) };
      if (bot.stuckCount % 2 === 0) tap('Space');
      say('stuck at ' + feet.map(Math.round).join(',') + ': ' + { KeyA: 'step left', KeyD: 'step right', KeyS: 'back off' }[move] + (bot.stuckCount % 2 === 0 ? ', jump' : ''));
    }
  }, 100);
  return 'started';
})()`;

/** Finishes the race menu as a player does: R (done), yes, a name, Enter, yes. */
async function finishRaceMenu(ctx: ScenarioContext): Promise<void> {
  const { page } = ctx;
  await page.key('KeyR');
  await sleepMs(2000);
  await page.key('Enter');
  await sleepMs(2000);
  for (const code of ['KeyT', 'KeyE', 'KeyS', 'KeyT', 'KeyE', 'KeyR']) await page.key(code);
  await sleepMs(1000);
  await page.key('Enter');
  await sleepMs(2000);
  await page.key('Enter');
  await sleepMs(3000);
}

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface OpeningNow {
  readonly stage: number;
  readonly driven: boolean;
  readonly menus: string;
  readonly interior: boolean;
  readonly loading: boolean;
}

const OPENING_NOW = `(async () => {
  const p = engineDev.play(); const rt = p.session.scriptsReady;
  const at = rt && await rt.placement(0x14);
  return {
    stage: rt?.state.quests.get(${MQ101})?.stage ?? -1,
    driven: rt?.controls.aiDriven === true,
    menus: [...p.host.menus].map((x) => x.movie.replace('.swf', '')).join('/'),
    interior: at !== undefined && at.world === undefined,
    loading: (engineDev.world.loading ?? engineDev.viewer.loading) !== undefined,
  };
})()`;

/**
 * The places of the sweep (cells by editor id): the holds' cities inside and out, their keeps
 * and inns, the College, a dungeon. Each is a game of its own from the main menu's coc (one
 * game's in-game coc chain through them crashed the physics: Rapier "unreachable" as a
 * Solitude exterior loaded), run by name or all together as "places".
 */
const PLACE_CELLS = [
  'WhiterunDragonsreach',
  'SolitudeBluePalace',
  'SolitudeWinkingSkeever',
  'SolitudeExterior01',
  'MarkarthUnderStoneKeep',
  'MarkarthSilverBloodInn',
  'MarkarthExterior01',
  'RiftenMistveilKeep',
  'RiftenBeeandBarb',
  'RiftenCityNorth',
  'WindhelmPalaceoftheKings',
  'FalkreathExterior01',
  'FalkreathDeadMansDrink',
  'DawnstarExterior01',
  'DawnstarWindpeakInn',
  'MorthalExterior01',
  'MorthalHighmoonHall',
  'WinterholdExterior01',
  'WinterholdCollegeHallofTheElements',
  'BleakFallsBarrow01',
];

/** One scenario per place: in the world at 10:00, watched for 45 s (a run without names skips them). */
export const PLACES: readonly Scenario[] = PLACE_CELLS.map((cell) => ({
  name: `at-${cell}`,
  description: `coc ${cell} at 10:00, watched 45 s.`,
  start: { kind: 'coc', cell },
  hour: 10,
  bootSeconds: 240,
  seconds: 45,
}));

/** The scenarios, in the order a run without names plays them (the long opening last). */
export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'whiterun-day',
    description:
      "Whiterun's Plains District by day: the market at 9:00 (stalls, guards, children).",
    start: { kind: 'coc', cell: 'WhiterunPlainsDistrict03' },
    hour: 9,
    bootSeconds: 240,
    seconds: 180,
  },
  {
    name: 'bannered-mare',
    description: 'The Bannered Mare at 20:00: the inn full (bard, furniture, sitting, eating).',
    start: { kind: 'coc', cell: 'WhiterunBanneredMare' },
    hour: 20,
    bootSeconds: 240,
    seconds: 180,
  },
  {
    name: 'riverwood',
    description: 'Riverwood at 13:00: the mill, the smithy, the river, animals.',
    start: { kind: 'coc', cell: 'Riverwood' },
    hour: 13,
    bootSeconds: 240,
    seconds: 180,
  },
  {
    name: 'windhelm-snow',
    description: "Windhelm's marketplace at 11:00 in falling snow (SkyrimOvercastSnow).",
    start: { kind: 'coc', cell: 'WindhelmMarketplaceExterior' },
    hour: 11,
    weather: 0x4d7fb,
    bootSeconds: 240,
    seconds: 180,
  },
  {
    name: 'combat',
    description:
      'A fight in Riverwood at 12:00: three bandits (tank, berserker, archer) against three Imperial guards, the player in god mode among them, the villagers around.',
    start: { kind: 'coc', cell: 'Riverwood' },
    hour: 12,
    bootSeconds: 240,
    seconds: 150,
    setup: async (ctx) => {
      await ctx.console('tgm');
      const placed = await ctx.page.eval<string>(
        `(async () => {
          const rt = engineDev.play().session.scriptsReady;
          const at = await rt.placement(0x14);
          // Not on top of one another: bandits 400 units to one side, guards to the other.
          const place = async (base, side, i) => {
            const reference = await rt.placeAt(base, 0x14, 1);
            const [x, y, z] = at.position;
            rt.move(reference, [x + side * 400, y + (i - 1) * 160, z + 20], [...at.rotation], at.cell, at.world);
            rt.world.moved?.(reference);
            return reference;
          };
          const bandits = []; const guards = [];
          for (const [i, base] of ${JSON.stringify(BANDITS)}.entries()) bandits.push(await place(base, 1, i));
          for (const [i, base] of ${JSON.stringify(GUARDS)}.entries()) guards.push(await place(base, -1, i));
          window.__qaFight = { bandits, guards };
          return bandits.concat(guards).map((r) => r.toString(16)).join(',');
        })()`,
        60000,
      );
      ctx.note(`placed ${placed}`);
      await sleepMs(4000);
      await ctx.page.eval(
        `(() => { const sw = engineDev.play().session.scriptWorld; const f = window.__qaFight; f.bandits.forEach((b, i) => { const g = f.guards[i]; sw.startCombat(b, g); sw.startCombat(g, b); }); return true; })()`,
        20000,
      );
      ctx.note('combat started: each bandit against a guard');
    },
  },
  {
    name: 'whiterun-long-day',
    description:
      "A Whiterun day in fast time (timescale 120: an hour in 30 s) from 6:00: the town's schedules, shops opening and closing, the evening's inn.",
    start: { kind: 'coc', cell: 'WhiterunPlainsDistrict03' },
    hour: 6,
    bootSeconds: 240,
    seconds: 600,
    setup: async (ctx) => {
      await ctx.console('set timescale to 120');
    },
  },
  {
    name: 'opening',
    description:
      'New game: the cart ride to Helgen, the execution, Alduin, AI-driven until MQ101 stage 160, then a bot following the quest marker into the keep.',
    start: { kind: 'new' },
    bootSeconds: 300,
    seconds: 2400,
    watchQuests: { [MQ101]: 240 },
    tick: async (ctx) => {
      const now = await ctx.page.eval<OpeningNow>(OPENING_NOW, 20000);
      const state = ctx.state as {
        raced?: boolean;
        stage?: number;
        bot?: boolean;
        inside?: number;
        since?: number;
      };
      if (now.stage !== state.stage) {
        state.stage = now.stage;
        state.since = Date.now();
        ctx.note(`MQ101 stage ${now.stage}`);
      }
      if (now.menus.includes('racesex_menu') && state.raced !== true) {
        state.raced = true;
        await sleepMs(3000);
        ctx.note('race menu: finished as a player would');
        await finishRaceMenu(ctx);
      }
      if (now.stage >= 160 && !now.driven && state.bot !== true) {
        state.bot = true;
        await ctx.page.eval(FOLLOW_BOT, 30000, true);
        ctx.note('the player is free: the follow bot takes over');
      }
      // In the keep (an interior after the bot took over): a minute more there, then done.
      if (state.bot === true && now.interior && !now.loading) {
        state.inside ??= Date.now();
        if (Date.now() - state.inside > 60000) return true;
      }
      // MQ101 stands for 8 minutes (the opening stalled, or the bot got nowhere): it ends there.
      if (Date.now() - (state.since ?? Date.now()) > 480000) {
        ctx.note(`MQ101 stands at stage ${String(now.stage)} for 8 minutes: stopped`);
        return true;
      }
      return false;
    },
    finish: async (ctx) => {
      const log = await ctx.page
        .eval<string[] | undefined>(
          `(() => { const b = window.__qaBot; if (!b) return undefined; clearInterval(b.timer); b.release(); return b.log; })()`,
          10000,
        )
        .catch(() => undefined);
      for (const line of log ?? []) ctx.note(`bot: ${line}`);
    },
  },
];
