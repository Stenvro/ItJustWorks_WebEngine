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
 * target is in another space; a guide near enough is waited for, and walked past once they
 * stand still a while. A target that is a place, reached with nothing moving on for 6 s, leads
 * on to the objective's next target (the way a player goes on: the burning inn's marker, then
 * Hadvar in the street). Stuck, it jumps and searches again; without a path, or with one far
 * longer than the straight line down, it goes straight (the tower's jump into the inn); off the
 * navmesh above it, it finds a drop onto navmesh that leads on (docs/qa.md). Runs as a console
 * line (replMode): the world viewer's navmeshes and play session are private fields.
 */
export const FOLLOW_BOT = `
var QA_NAV = engineDev.world.#navmeshes;
var QA_PLAY = engineDev.world.#play;
(async () => {
  if (window.__qaBot) return 'running';
  const compass = await import('/src/shell/compass.ts');
  const paths = await import('/src/ai/pathfinding.ts');
  const { Layer } = await import('/src/physics/collision-layers.ts');
  const W = engineDev.world;
  const nav = QA_NAV;
  // A way to where the floor gives way (150 units or more down), found on a grid of 32 units
  // round the player (physics rays: the floor under each cell, steps of up to 32, nothing at
  // chest height between neighbours): of the drops, the first (nearest by the way, then most
  // towards the goal) that lands on navmesh with a way on to the goal (the inn's upper floor
  // has holes down into rooms that rubble shuts), else the first.
  const findDrop = (feet, goal) => {
    const physics = QA_PLAY?.physics;
    if (!physics) return undefined;
    const ray = (from, dir, length) => physics.raycast(from, dir, length, Layer.charController, undefined, 0x14);
    const CELL = 32; const SPAN = 28;
    const floor = new Map();
    const floorAt = (i, j) => {
      const key = i + ',' + j;
      if (!floor.has(key)) {
        const hit = ray([feet[0] + i * CELL, feet[1] + j * CELL, feet[2] + 100], [0, 0, -1], 600);
        floor.set(key, hit ? hit.point[2] : -Infinity);
      }
      return floor.get(key);
    };
    const toward = [goal[0] - feet[0], goal[1] - feet[1]];
    const tl = Math.hypot(toward[0], toward[1]) || 1;
    const seen = new Map([['0,0', undefined]]);
    const queue = [[0, 0, feet[2]]];
    const drops = [];
    for (let head = 0; head < queue.length; head++) {
      const [i, j, z] = queue[head];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const ni = i + di; const nj = j + dj;
        const key = ni + ',' + nj;
        if (seen.has(key) || Math.abs(ni) > SPAN || Math.abs(nj) > SPAN) continue;
        const from = [feet[0] + i * CELL, feet[1] + j * CELL, z + 50];
        const length = CELL * Math.hypot(di, dj);
        if (ray(from, [di, dj, 0], length)) continue;
        const h = floorAt(ni, nj);
        if (h > z + 32) continue;
        seen.set(key, [i, j]);
        if (h < z - 150) {
          const score = head + 1 - ((ni * toward[0] + nj * toward[1]) / tl) * 0.5;
          drops.push({ score, key, landing: [feet[0] + ni * CELL, feet[1] + nj * CELL, h] });
          continue;
        }
        queue.push([ni, nj, h]);
      }
    }
    drops.sort((a, b) => a.score - b.score);
    const onward = drops.slice(0, 16).find((drop) => Number.isFinite(drop.landing[2]) && nav?.locate(drop.landing) && paths.findPath(nav, drop.landing, goal, { radius: 24 })?.complete);
    const best = onward ?? drops[0];
    if (!best) return undefined;
    const way = [];
    for (let key = best.key; key !== '0,0'; ) {
      const [i, j] = key.split(',').map(Number);
      way.unshift([feet[0] + i * CELL, feet[1] + j * CELL, feet[2]]);
      const parent = seen.get(key);
      key = parent[0] + ',' + parent[1];
    }
    return way;
  };
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
        for (const [order, target] of objective.targets.entries()) {
          const reference = quest.aliases.get(target.alias);
          if (reference === undefined) continue;
          const holds = target.conditions.length === 0 || (await rt.conditionsHold(target.conditions, rt.referenceHandle(reference)));
          const placement = await rt.placement(reference);
          if (placement) found.push({ quest: formId, objective: objective.index, order, holds, reference, placement });
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
    const measure = (t) => {
      const same = here(t.placement);
      const d = same ? Math.hypot(t.placement.position[0] - at.position[0], t.placement.position[1] - at.position[1]) : 1e9;
      return { t, d, same };
    };
    let best;
    for (const t of targets) {
      if (!t.holds) continue;
      const m = measure(t);
      if (!best || m.d < best.d) best = m;
    }
    if (!best) { bot.goal = undefined; bot.path = []; return; }
    // A place reached (no guide) where nothing moves on for a while: a player goes on the way
    // the objective leads, to its next target (MQ101's inn marker, then Hadvar in the street).
    // It holds while that target is the one shown.
    const now = performance.now();
    const guideHere = W.actorStage?.get(best.t.reference) !== undefined;
    if (bot.reached?.reference !== best.t.reference) bot.reached = undefined;
    if (!guideHere && best.d < 128) bot.reached ??= { reference: best.t.reference, since: now };
    if (bot.reached && now - bot.reached.since > 6000) {
      const next = targets.find((t) => !t.holds && t.quest === best.t.quest && t.objective === best.t.objective && t.order > best.t.order);
      if (next) {
        if (bot.ahead !== next.reference) say('target reached, on to the next: ' + next.reference.toString(16));
        bot.ahead = next.reference;
        best = measure(next);
      }
    }
    let goal = [...best.t.placement.position];
    bot.door = undefined;
    bot.guide = W.actorStage?.get(best.t.reference) ? best.t.reference : undefined;
    // A guide waited by for 15 s who stays where they are: a player walks on past them, into
    // the room they lead to (Ralof in Helgen's tower, the stage the player's step sets beyond
    // him), 160 units on the far side; the place holds while the guide stays.
    const g = best.t.placement.position;
    if (bot.pass && (bot.pass.guide !== bot.guide || Math.hypot(g[0] - bot.pass.from[0], g[1] - bot.pass.from[1]) > 64)) bot.pass = undefined;
    if (!bot.pass && best.same && bot.guide !== undefined && bot.waitSince !== undefined && now - bot.waitSince > 15000) {
      const dx = g[0] - at.position[0]; const dy = g[1] - at.position[1]; const l = Math.hypot(dx, dy) || 1;
      const point = nav?.nearest?.([g[0] + (dx / l) * 160, g[1] + (dy / l) * 160, g[2]], 96);
      if (point) {
        bot.pass = { guide: bot.guide, from: [...g], point: [...point] };
        say('the guide waits: on past it to ' + point.map(Math.round).join(','));
      }
    }
    if (bot.pass) goal = [...bot.pass.point];
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
    // A way over the navmesh far longer than the straight line to a goal not above: a player
    // jumps down (Helgen's tower: the hole Alduin broke, onto the inn's roof, while the navmesh
    // leads down the stairs to the door the quest has shut).
    if (found && !bot.door && goal[2] <= feet[2] + 50) {
      let length = 0;
      for (let i = 1; i < found.points.length; i++) length += Math.hypot(found.points[i][0] - found.points[i - 1][0], found.points[i][1] - found.points[i - 1][1]);
      const straight = Math.hypot(goal[0] - feet[0], goal[1] - feet[1]);
      if (length > straight * 2 + 300) {
        if (!bot.straight) say('the way round is ' + Math.round(length) + ' for ' + Math.round(straight) + ' straight: straight on');
        bot.straight = true;
        bot.path = [goal];
      } else bot.straight = false;
    }
    // Off the navmesh with the navmesh below (the burning inn's upper floor): a player drops
    // down where the floor gives way, the drop nearest the way to the goal.
    if (!found && nav && !nav.locate(feet) && nav.nearest?.([feet[0], feet[1], feet[2] - 300], 600)) {
      const way = findDrop(feet, goal);
      const drop = way?.at(-1);
      if (drop) {
        bot.path = way;
        if (Math.hypot(drop[0] - (bot.drop?.[0] ?? 0), drop[1] - (bot.drop?.[1] ?? 0)) > 32) say('drop down at ' + drop.map(Math.round).join(',') + ' (' + way.length + ' steps)');
        bot.drop = drop;
      }
    }
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
    name: 'opening',
    description:
      'New game: the cart ride to Helgen, the execution, Alduin, AI-driven until MQ101 stage 160, then a bot (god mode) following the quest marker into the keep and on while MQ101 moves.',
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
        escaped?: number;
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
        // The bot does not fight (the keep's soldiers, its bear and spiders): god mode.
        await ctx.console('tgm');
        await ctx.page.eval(FOLLOW_BOT, 30000, true);
        ctx.note('the player is free: the follow bot takes over (god mode)');
      }
      // In the keep (an interior after the bot took over): on through it while MQ101 moves.
      if (state.bot === true && now.interior && !now.loading && state.inside === undefined) {
        state.inside = Date.now();
        ctx.note('in the keep');
      }
      // Escaped (MQ101 stage 900: out of Helgen's keep): a minute more, then done.
      if (now.stage >= 900) {
        state.escaped ??= Date.now();
        if (Date.now() - state.escaped > 60000) return true;
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
