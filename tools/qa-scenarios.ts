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
 * Animals (NPC_ form ids of Skyrim.esm) and where they are put around the player (x, y in units):
 * the tame ones and the game's that flee (EncChicken, EncCow, EncGoatDomestic, EncDog,
 * EncHorseBrown, EncDeer, EncElk, EncHare).
 */
const TAME_ANIMALS: readonly (readonly [number, number, number])[] = [
  [0xa91a0, 260, 120],
  [0xa91a0, 320, -80],
  [0x23a90, -420, 260],
  [0x4359c, -300, -340],
  [0x23a92, 200, 420],
  [0x68d5b, -600, -60],
  [0xcf89d, 900, 500],
  [0x23a91, -900, 600],
  [0x6dc9d, 700, -700],
];
/** The predators (EncWolf ×2, EncSabreCat, EncBear, EncMudcrabMedium, EncSkeever). */
const PREDATORS: readonly (readonly [number, number, number])[] = [
  [0x23abe, 1100, 200],
  [0x23abe, 1150, 380],
  [0x23ab5, -1100, 300],
  [0x23a8a, 300, 1200],
  [0xe4010, 500, -500],
  [0x23ab7, -500, -600],
];
/** EncHorseSaddledBrown: the horse the player rides in the `creatures` scenario. */
const SADDLED_HORSE = 0x23ab2;

/** Places animals around the player (page side): their references, as hex. */
const placeAnimals = (
  animals: readonly (readonly [number, number, number])[],
): string => `(async () => {
  const rt = engineDev.play().session.scriptsReady;
  const at = await rt.placement(0x14);
  const placed = [];
  for (const [base, dx, dy] of ${JSON.stringify(animals)}) {
    const reference = await rt.placeAt(base, 0x14, 1);
    const [x, y, z] = at.position;
    rt.move(reference, [x + dx, y + dy, z + 40], [0, 0, Math.atan2(-dx, -dy)], at.cell, at.world);
    rt.world.moved?.(reference);
    placed.push(reference);
  }
  return placed;
})()`;

/**
 * The ride (page side): the player on a saddled horse goes through its gaits on a minute's loop
 * (a walk, a trot, a gallop, a sprint, a stop, a turn on the spot), steering by its yaw as the
 * controls do: along navmesh paths to random points round where it started (as a player rides
 * round rocks and fences), the view turning smoothly every frame as a mouse does; a new way when
 * it gets nowhere. Runs as a console line (replMode): the world viewer's navmeshes are a private
 * field.
 */
const RIDE_BOT = `
var QA_RIDE_NAV = engineDev.world.#navmeshes;
(async () => {
  if (window.__qaRide) return 'running';
  const paths = await import('/src/ai/pathfinding.ts');
  const W = engineDev.world;
  const nav = QA_RIDE_NAV;
  const ride = { start: performance.now(), held: new Set(), home: undefined, last: undefined, slow: 0, backing: 0, path: [], planned: 0, log: [] };
  window.__qaRide = ride;
  const press = (name, down) => {
    const player = W.player; if (!player) return;
    if (down === ride.held.has(name)) return;
    player.press(name, down);
    if (down) ride.held.add(name); else ride.held.delete(name);
  };
  ride.release = () => { for (const name of [...ride.held]) press(name, false); };
  // A way to a random point of the navmesh within 1200 of home, at least 600 on.
  // From the ground under the rider (the saddle is a horse's height above it).
  const plan = (feet) => {
    const now = performance.now();
    if (now - ride.planned < 500) return;
    ride.planned = now;
    // Off the navmesh (a rock it climbed): back onto its nearest point first, else home.
    const ground = nav && (paths.onNavmeshColumn(nav, feet) ?? nav.nearest?.(feet, 512));
    const goal = ground && paths.randomReachablePoint(nav, ground, ride.home, 1200, 600, Math.random, { large: true });
    const found = goal && paths.findPath(nav, ground, goal, { radius: 128, large: true });
    ride.path = found && found.points.length > 1 ? found.points.slice(1).map((p) => [...p]) : [];
    if (ground && Math.hypot(ground[0] - feet[0], ground[1] - feet[1]) > 100) ride.path.unshift([...ground]);
    if (ride.path.length === 0) ride.path = [[...ride.home]];
    ride.log.push(Math.round(performance.now() / 1000) + ' way ' + (goal ? goal.map(Math.round).join(',') : 'none') + ' ' + ride.path.length);
    if (ride.log.length > 40) ride.log.shift();
  };
  // Phases: [until, forward, walk (run toggled off), sprint, turn on the spot rad/s].
  const phases = [
    [8, true, true, false, 0], [16, true, false, false, 0], [22, true, false, true, 0],
    [26, false, false, false, 0], [34, true, true, false, 0], [44, true, false, false, 0],
    [48, false, false, false, 1.2], [56, true, false, true, 0], [60, false, false, false, 0],
  ];
  let before = performance.now();
  const frame = (now) => {
    if (window.__qaRide !== ride) return;
    const dt = Math.min(0.1, (now - before) / 1000);
    before = now;
    const player = W.player;
    if (player) {
      const feet = player.feet;
      ride.home ??= [...feet];
      const t = ((now - ride.start) / 1000) % 60;
      const [, forward, walk, sprint, spin] = phases.find((p) => t < p[0]) ?? phases[phases.length - 1];
      // The horse's place, its speed and its way from there (the rider's feet sway with the saddle
      // as the horse's walk plays: steered from them, the rider's view wavered with the stride).
      const horse = W.actorStage?.get(W.actorStage.mounts.horseOf(0x14) ?? -1);
      const at = horse ? horse.position : feet;
      const speed = ride.last ? Math.hypot(at[0] - ride.last[0], at[1] - ride.last[1]) / Math.max(dt, 1e-3) : 0;
      ride.last = [...at];
      ride.slow = forward && !(ride.backing > 0) && speed < 30 ? ride.slow + dt : 0;
      // Stuck (a wall, another horse): it backs out a moment, as a rider does, and takes a new way.
      if (ride.slow > 1.5) { ride.slow = 0; ride.path = []; ride.backing = 1.2; ride.log.push(Math.round(now / 1000) + ' stuck: backing out'); }
      if (ride.backing > 0) ride.backing -= dt;
      const backing = ride.backing > 0;
      // A point is passed nearer the faster it goes (a galloping horse circled one it could not turn into).
      const pass = 150 + speed * 0.5;
      while (ride.path.length > 0 && Math.hypot(ride.path[0][0] - at[0], ride.path[0][1] - at[1]) < pass) ride.path.shift();
      if (ride.path.length === 0) plan(at);
      let rate = spin;
      const next = ride.path[0];
      if (!spin && next) {
        const want = Math.atan2(next[0] - at[0], next[1] - at[1]);
        const off = Math.atan2(Math.sin(want - player.yaw), Math.cos(want - player.yaw));
        rate = Math.max(-1.5, Math.min(1.5, off * 3));
      }
      player.yaw += rate * dt;
      press('Forward', forward && !backing);
      press('Back', backing);
      press('Run', walk === player.alwaysRun);
      press('Sprint', sprint);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return 'started';
})()`;

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
          if (target.conditions.length > 0 && !(await rt.conditionsHold(target.conditions, rt.referenceHandle(reference)))) continue;
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
    name: 'creatures',
    description:
      'The Whiterun stables at 10:00: chickens, a cow, a goat, a dog, a horse, a deer, an elk and a hare put around the player (idles, wandering, fleeing), the stables’ own horses; the player rides a saddled horse through its gaits and turns.',
    start: { kind: 'coc', cell: 'WhiterunExterior01' },
    hour: 10,
    bootSeconds: 240,
    seconds: 180,
    setup: async (ctx) => {
      await ctx.console('tgm');
      const placed = await ctx.page.eval<number[]>(placeAnimals(TAME_ANIMALS), 60000);
      const horse = await ctx.page.eval<number[]>(placeAnimals([[SADDLED_HORSE, 0, 160]]), 30000);
      ctx.note(
        `placed ${placed
          .concat(horse)
          .map((r) => r.toString(16))
          .join(',')}`,
      );
      await sleepMs(5000);
      const mounted = await ctx.page.eval<boolean>(
        `engineDev.world.actorStage.mounts.mountPlayer(${String(horse[0] ?? 0)}, true)`,
        30000,
      );
      ctx.note(mounted ? 'the player rides the saddled horse' : 'the player could not mount');
      await sleepMs(2000);
      await ctx.page.eval(RIDE_BOT, 30000, true);
    },
    finish: async (ctx) => {
      const log = await ctx.page
        .eval<string[] | undefined>(
          `(() => { const r = window.__qaRide; if (!r) return undefined; window.__qaRide = undefined; r.release(); return r.log; })()`,
          10000,
        )
        .catch(() => undefined);
      for (const line of log ?? []) ctx.note(`ride: ${line}`);
    },
  },
  {
    name: 'creature-combat',
    description:
      'The Whiterun stables at 10:00, the player in god mode: two wolves, a sabre cat, a bear, a mudcrab and a skeever put around them attack; a deer and an elk near flee.',
    start: { kind: 'coc', cell: 'WhiterunExterior01' },
    hour: 10,
    bootSeconds: 240,
    seconds: 150,
    setup: async (ctx) => {
      await ctx.console('tgm');
      const placed = await ctx.page.eval<number[]>(
        placeAnimals([...PREDATORS, [0xcf89d, 600, 300], [0x23a91, -600, 400]]),
        60000,
      );
      ctx.note(`placed ${placed.map((r) => r.toString(16)).join(',')}`);
      await sleepMs(3000);
      // Set on the player (the wild ones may not have noticed them yet).
      await ctx.page.eval(
        `(() => { const sw = engineDev.play().session.scriptWorld; for (const r of ${JSON.stringify(placed.slice(0, PREDATORS.length))}) sw.startCombat(r, 0x14); return true; })()`,
        20000,
      );
      ctx.note('the predators are set on the player');
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
