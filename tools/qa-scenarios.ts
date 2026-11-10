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
 * Actor bases of every kind of skeleton (NPC_ form ids of Skyrim.esm): a bandit, a guard, a
 * draugr, a skeleton, wolf, bear, horse, dog, cow, deer, skeever, troll, sabre cat, spriggan,
 * falmer, chaurus, Dwemer spider and sphere, giant, mammoth, hagraven, ice wraith, flame
 * atronach, werewolf, horker, chicken, fox, elk.
 */
const DEATH_ACTORS = [
  0x3de91, 0xaa8fc, 0xe989e, 0x2d1de, 0x23abe, 0x23a8a, 0x68d5b, 0x23a92, 0x23a90, 0xcf89d, 0x23ab7,
  0x23aba, 0x23ab5, 0x23ab9, 0x23a99, 0xa5600, 0x10ec86, 0x10ec89, 0x23aae, 0x101580, 0x23ab0,
  0x23ab3, 0x23aa6, 0x23abc, 0x23ab1, 0xa91a0, 0x829b3, 0x23a91,
];

/**
 * The fight's setup: god mode, the six placed at the player (bandits 400 units to one side,
 * guards to the other), each bandit set on a guard and back. `meleeOnly`: their ammunition is
 * taken first (a bow without arrows is no option), so all six close in.
 */
async function fightSetup(ctx: ScenarioContext, meleeOnly: boolean): Promise<void> {
  await ctx.console('tgm');
  const placed = await ctx.page.eval<string>(
    `(async () => {
      const play = engineDev.play();
      const rt = play.session.scriptsReady;
      const db = await play.session.db;
      const at = await rt.placement(0x14);
      // Not on top of one another: bandits 400 units to one side, guards to the other.
      const place = async (base, side, i) => {
        const reference = await rt.placeAt(base, 0x14, 1);
        const [x, y, z] = at.position;
        rt.move(reference, [x + side * 400, y + (i - 1) * 160, z + 20], [...at.rotation], at.cell, at.world);
        rt.world.moved?.(reference);
        if (${String(meleeOnly)}) {
          for (const [item, count] of await rt.inventory(reference)) {
            if ((await db.get(item))?.type === 'AMMO') await rt.removeItem(reference, rt.formHandle(item), count, true, undefined);
          }
        }
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
  ctx.note(`placed ${placed}${meleeOnly ? ' (their ammunition taken)' : ''}`);
  await sleepMs(4000);
  await ctx.page.eval(
    `(() => { const sw = engineDev.play().session.scriptWorld; const f = window.__qaFight; f.bandits.forEach((b, i) => { const g = f.guards[i]; sw.startCombat(b, g); sw.startCombat(g, b); }); return true; })()`,
    20000,
  );
  ctx.note('combat started: each bandit against a guard');
}

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
/**
 * A creature of each fighting race (NPC_ form ids of Skyrim.esm): frostbite spider, skeever,
 * wolf, bear, sabre cat, troll, draugr, skeleton, falmer, chaurus, spriggan, mudcrab, horker,
 * ice wraith, Dwemer spider, sphere and centurion, a giant.
 */
const CREATURE_RACES = [
  0x41fb4, 0x23ab7, 0x23abe, 0x23a8a, 0x23ab5, 0x23aba, 0x5593b, 0x2d1de, 0x52382, 0xa5600, 0x23ab9,
  0xe4010, 0x23ab1, 0x23ab3, 0x10ec86, 0x10ec89, 0x10f9b9, 0x23aae,
];
/** Bleak Falls Barrow's ceiling spider (MS13FrostbiteSpiderREF). */
const BLEAK_FALLS_SPIDER = 0x3a1e1;
/** Bleak Falls Barrow's spider room: into its trigger box, then on toward Arvel's web. */
const SPIDER_WALK: readonly (readonly [number, number, number])[] = [
  [2395, -3003, -1640],
  [2950, -3012, -1760],
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
 * The follow bot (in the page): it walks the player to the current marker of the running quests'
 * shown objectives (of the targets that hold, the nearest of the objective shown last: Ralof,
 * Hadvar, the keep's doors; a guide in a scene who calls the player first), along the navmesh (src/ai/pathfinding.ts), through the load door on the way when the
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
var QA_NAV_INSIDE = engineDev.viewer.#navmeshes;
(async () => {
  if (window.__qaBot) return 'running';
  const compass = await import('/src/shell/compass.ts');
  const actors = await import('/src/shell/actors.ts');
  const paths = await import('/src/ai/pathfinding.ts');
  const { Layer } = await import('/src/physics/collision-layers.ts');
  const { playerTrigger } = await import('/src/scripting/runtime/trigger-gates.ts');
  // Interiors play in the model viewer, the world outside in the world viewer (as the monitors
  // pick it): the player, the stage, the navmeshes and the physics of the one playing now.
  const viewer = () => (engineDev.world.play ? engineDev.world : engineDev.viewer);
  const W = {
    get player() { return viewer().player; },
    get actorStage() { return viewer().actorStage; },
    get loading() { return viewer().loading; },
  };
  const nav = new Proxy({}, {
    get: (_, key) => {
      const set = engineDev.world.play ? QA_NAV : QA_NAV_INSIDE;
      const value = set[key];
      return typeof value === 'function' ? value.bind(set) : value;
    },
  });
  // A way to where the floor gives way (150 units or more down), found on a grid of 32 units
  // round the player (physics rays: the floor under each cell, steps of up to 32, nothing at
  // chest height between neighbours): of the drops, the one landing nearest the goal that lands
  // on navmesh with a way on to it (the inn's upper floor has holes nearer down into a room that
  // rubble shuts), else the one landing nearest.
  const findDrop = (feet, goal) => {
    const physics = viewer().play?.physics;
    if (!physics) return undefined;
    const ray = (from, dir, length) => physics.raycast(from, dir, length, Layer.charController, undefined, 0x14);
    const CELL = 32; const SPAN = 40;
    const floor = new Map();
    const floorAt = (i, j) => {
      const key = i + ',' + j;
      if (!floor.has(key)) {
        const hit = ray([feet[0] + i * CELL, feet[1] + j * CELL, feet[2] + 100], [0, 0, -1], 600);
        floor.set(key, hit ? hit.point[2] : -Infinity);
      }
      return floor.get(key);
    };
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
          const landing = [feet[0] + ni * CELL, feet[1] + nj * CELL, h];
          const score = Math.hypot(goal[0] - landing[0], goal[1] - landing[1]);
          drops.push({ score, key, landing });
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
          const holds = target.conditions.length === 0 || (await rt.conditionsHold(target.conditions, rt.referenceHandle(reference), undefined, { quest: formId }));
          const placement = await rt.placement(reference);
          if (placement) found.push({ quest: formId, objective: objective.index, shown: state.shown ?? 0, order, holds, reference, placement });
        }
      }
    }
    return found;
  };
  const say = (text) => { bot.log.push(Math.round(performance.now() / 1000) + ' ' + text); if (bot.log.length > 800) bot.log.shift(); };
  // Each load door's journey asked for and each interior loaded, with who asked (the page's
  // call stack): a door taken twice, a place loaded twice at once, shows here.
  const caller = () => (new Error().stack ?? '').split('\\n').slice(3, 6).map((l) => l.trim().replace(/^at /, '').replace(/\\(?https?:\\/\\/[^/]+\\//, '').replace(/\\?[^:]*:/, ':').replace(/\\)$/, '')).join(' < ');
  for (const view of [engineDev.world, engineDev.viewer]) {
    if (view.__qaWatched) continue;
    view.__qaWatched = true;
    const travel = view.onTravel;
    if (travel) view.onTravel = (teleport) => { say('door journey asked to ' + teleport.position.map(Math.round).join(',') + ' (' + caller() + ')'); return travel(teleport); };
  }
  if (!engineDev.viewer.__qaShowCell) {
    const viewer = engineDev.viewer; const show = viewer.showCell.bind(viewer);
    viewer.__qaShowCell = true;
    viewer.showCell = (...args) => { say('interior ' + args[0].toString(16) + ' loads (' + caller() + ')'); return show(...args); };
  }
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
    bot.inside = at.world === undefined;
    const here = (p) => at.world !== undefined ? p.world === at.world : p.cell !== undefined && p.cell === at.cell;
    const measure = (t) => {
      const same = here(t.placement);
      const d = same ? Math.hypot(t.placement.position[0] - at.position[0], t.placement.position[1] - at.position[1]) : 1e9;
      return { t, d, same };
    };
    // The current objective's marker, as a player reads the compass: of the targets that hold,
    // those of the objective shown last (MQ101's "Make your way to the Keep" shows one of its
    // four as MQ101DragonAttack's stage stands: Ralof, the inn, Hadvar, the courtyard), the
    // nearest of them (the two keep doors of "Enter the Keep").
    // A side chosen (window.__qaSide 'ralof' or 'hadvar'): of the targets, that guide and the
    // keep door by them ("Enter the Keep with Hadvar or Ralof"), as a player picks the door.
    const side = window.__qaSide === 'ralof' ? new Set([0x2bf9e, 0xe24c7]) : window.__qaSide === 'hadvar' ? new Set([0x2bfa2, 0xe24c8]) : undefined;
    let best;
    const latest = Math.max(-1, ...targets.filter((t) => t.holds && !bot.skip?.has(t.reference)).map((t) => t.shown));
    const current = targets.filter((t) => t.holds && !bot.skip?.has(t.reference) && t.shown === latest);
    const sided = side ? current.filter((t) => side.has(t.reference)) : [];
    for (const t of sided.length > 0 ? sided : current) {
      const m = measure(t);
      if (!best || m.d < best.d) best = m;
    }
    const chosen = best ? best.t.quest.toString(16) + ' objective ' + best.t.objective + ' target ' + best.t.reference.toString(16) : 'none';
    if (chosen !== bot.chosen) {
      bot.chosen = chosen;
      say('marker: ' + chosen + ' (of ' + targets.map((t) => t.objective + ':' + t.reference.toString(16) + (t.holds ? '' : ' off')).join(', ') + ')');
    }
    // No target shown (MQ101DragonAttack's stage 192: Hadvar ran ahead into his trigger and
    // waits by the street's, which the player sets walking in): a player follows the guide
    // they followed last, while it is about.
    if (!best && bot.lastGuide !== undefined && W.actorStage?.get(bot.lastGuide)) {
      const placement = await rt.placement(bot.lastGuide);
      if (placement) best = measure({ quest: 0, objective: -1, order: 0, holds: true, reference: bot.lastGuide, placement });
    }
    // The guide calls the player in a scene ("Come here, let me get those bindings off": MQ101's
    // keep scenes wait for the player within 100 units of Ralof or Hadvar while the marker is on
    // the way out): a player goes to them first, once for each stage of the marker's quest.
    let called = false;
    // Inside only: outside, by the tower's hole, Ralof's scene walked him on as the player came
    // to him, and the two went down the tower together instead of on to the inn's roof. The
    // guide is the one followed last, else whichever of Ralof (2bf9e) and Hadvar (2bfa2) is here
    // in a scene: a bot that followed Hadvar to Ralof's door meets Ralof inside.
    const sceneGuide = at.world === undefined ? [bot.lastGuide, 0x2bf9e, 0x2bfa2].find((g) => g !== undefined && W.actorStage?.get(g) && rt.scenes.sceneOf(g) !== undefined) : undefined;
    if (best && sceneGuide !== undefined && best.t.reference !== sceneGuide) {
      const key = best.t.quest + ':' + (rt.state.quests.get(best.t.quest)?.stage ?? 0);
      const placement = await rt.placement(sceneGuide);
      const m = placement && measure({ quest: best.t.quest, objective: -1, order: 0, holds: true, reference: sceneGuide, placement });
      if (m && m.same && bot.metGuide !== key) {
        // By him, it stays while he talks (25 s: the keep's scenes speak three lines before
        // their phase that waits for the player near).
        if (m.d < 100 && bot.byGuide?.key !== key) { bot.byGuide = { key, since: performance.now(), at: [...placement.position] }; say('by the guide at stage ' + key); }
        // A guide who walks on (MQ101KeepScene2B escorts the player down the stairs) leads:
        // followed while he goes, the marker only once he has stood 25 s.
        if (bot.byGuide?.key === key && Math.hypot(placement.position[0] - bot.byGuide.at[0], placement.position[1] - bot.byGuide.at[1]) > 80) {
          bot.byGuide = { key, since: performance.now(), at: [...placement.position] };
          if (bot.ledBy !== key) { bot.ledBy = key; say('the guide leads on: after him (' + key + ')'); }
        }
        if (bot.byGuide?.key === key && performance.now() - bot.byGuide.since > 25000) { bot.metGuide = key; say('the guide talked: on to the marker'); }
        else {
          if (bot.calledBy !== key) { bot.calledBy = key; say('the guide is in a scene: to him first (' + key + ')'); }
          best = m;
          called = true;
        }
      } else if (m && m.same && bot.metGuide === key) {
        // He has talked and stands, his scene waiting on (MQ101KeepIntroSceneB's "Wait around
        // the corner": MQ101SetStage292 by him): a player walks on round him into the trigger
        // that waits for them, of those within 1,200 units of him whose scripts name the
        // marker's quest, the nearest first.
        bot.gates ??= new Map();
        if (!bot.gates.has(key)) {
          bot.gates.set(key, 'pending');
          const found = [];
          for (const trigger of viewer().play?.physics.triggersNear([...placement.position], 1200) ?? []) {
            const waits = await playerTrigger(rt, trigger);
            const where = waits && waits.names.has(best.t.quest) ? await rt.placement(trigger) : undefined;
            if (where) found.push({ trigger, at: [...where.position] });
          }
          bot.gates.set(key, found);
          say('triggers by the guide that wait for the player: ' + (found.map((g) => g.trigger.toString(16)).join(', ') || 'none'));
        }
        const gates = bot.gates.get(key);
        if (Array.isArray(gates)) {
          bot.walkedInto ??= new Set();
          for (const g of gates) if (rt.triggerVolumes.inside(g.trigger).has(0x14)) bot.walkedInto.add(g.trigger);
          let gate;
          for (const g of gates) {
            if (bot.walkedInto.has(g.trigger)) continue;
            const d = Math.hypot(g.at[0] - at.position[0], g.at[1] - at.position[1], g.at[2] - at.position[2]);
            if (!gate || d < gate.d) gate = { ...g, d };
          }
          if (gate) {
            if (bot.gate !== gate.trigger) { bot.gate = gate.trigger; say('into the trigger ' + gate.trigger.toString(16) + ' at ' + gate.at.map(Math.round).join(',')); }
            best = { ...measure({ quest: best.t.quest, objective: -1, order: 0, holds: true, reference: gate.trigger, placement: { position: gate.at, cell: at.cell, world: at.world } }), gate: true };
            called = true;
          }
        }
      }
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
    // A target to loot (MQ101's "Find some equipment": the warden's chest; "Loot Gunjar's
    // body"): a container, or a dead actor, not looted yet. Walked to and opened as a player
    // does; the scenario takes all in the container menu (R) and closes it, and the player then
    // wears what it took (lootEquip).
    bot.loot = undefined;
    if (best.same && !bot.looted?.has(best.t.reference)) {
      const baseId = await rt.baseOf(best.t.reference);
      const type = baseId !== undefined ? (await rt.forms.record(baseId))?.type : undefined;
      if (type === 'CONT' || ((type === 'NPC_') && (await rt.actors.isDead(best.t.reference)))) {
        bot.loot = best.t.reference;
        bot.guide = undefined;
      }
    }
    if (bot.guide !== undefined) bot.lastGuide = bot.guide;
    // A target that is a load door here (MQ101's "Enter the Keep": the keep's doors) is used
    // as a player uses it: walked to and activated.
    // So is the load door by a place target (the keep's doors stand by MQ101's "Enter the Keep"
    // markers, which the keep's navmesh does not reach).
    if (best.same && !best.gate && bot.guide === undefined && bot.loot === undefined && !bot.looted?.has(best.t.reference)) {
      const record = await (await play.session.db).get(best.t.reference);
      if (record?.fields.has('XTEL')) bot.door = best.t.reference;
      else {
        const space = at.world !== undefined ? { kind: 'world', world: at.world } : { kind: 'interior', cell: at.cell ?? 0 };
        const p = best.t.placement.position;
        let nearest;
        for (const door of (await play.session.routeMap()).doorsInSpace(space)) {
          const d = Math.hypot(door.position[0] - p[0], door.position[1] - p[1]);
          if (d < 400 && (!nearest || d < nearest.d)) nearest = { door, d };
        }
        if (nearest) {
          bot.door = nearest.door.door;
          goal = [...nearest.door.position];
        }
      }
    }
    // A guide waited by for 15 s who stays where they are: a player walks on past them, into
    // the room they lead to (Ralof in Helgen's tower, the stage the player's step sets beyond
    // him), 160 units on the far side; the place holds while the guide stays.
    const g = best.t.placement.position;
    if (bot.pass && (bot.pass.guide !== bot.guide || Math.hypot(g[0] - bot.pass.from[0], g[1] - bot.pass.from[1]) > 64)) bot.pass = undefined;
    if (!bot.pass && !called && best.same && bot.guide !== undefined && bot.waitSince !== undefined && now - bot.waitSince > 15000) {
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
    // On the navmesh: one at its feet' height (the triangle under the inn's upper floor is the
    // ground floor's, 300 units down: a way from there is not the player's).
    const onNav = nav?.nearest?.(feet, 48) !== undefined;
    // Where it got stuck lately (20 s), here: a way the navmesh has but something shuts (the
    // inn's rubble, a collision box the quest enabled) is closed there and searched round,
    // as an actor closes a door it cannot pass.
    bot.stucks = (bot.stucks ?? []).filter((s) => now - s.time < 20000);
    const stuckHere = bot.stucks.filter((s) => Math.hypot(s.at[0] - feet[0], s.at[1] - feet[1]) < 64).length;
    // Stuck again and again on the way to a target that is no guide (shut twice and still stuck: a quest blocker shuts the
    // Stormcloak keep door's street to one who came with Hadvar): another shown target, as a
    // player tries the other marker.
    if (stuckHere >= 3 && bot.blockedFor === best.t.reference && (bot.blocked?.length ?? 0) >= 2 && bot.guide === undefined && targets.some((t) => t.holds && t.reference !== best.t.reference && !bot.skip?.has(t.reference))) {
      (bot.skip ??= new Set()).add(best.t.reference);
      bot.stucks = [];
      say('the way to ' + best.t.reference.toString(16) + ' is shut: another target');
      return;
    }
    if (bot.blockedFor !== best.t.reference) { bot.blocked = []; bot.blockedFor = best.t.reference; }
    if (stuckHere >= 4 && onNav && bot.path?.[0]) {
      const ahead = bot.path[0];
      const dx = ahead[0] - feet[0]; const dy = ahead[1] - feet[1]; const l = Math.hypot(dx, dy) || 1;
      const at = [feet[0] + (dx / l) * 64, feet[1] + (dy / l) * 64, feet[2]];
      if (!bot.blocked.some((b) => Math.hypot(b.at[0] - at[0], b.at[1] - at[1]) < 48)) {
        bot.blocked.push({ at, radius: 64 });
        bot.stucks = [];
        say('the way is shut at ' + at.map(Math.round).join(',') + ': round it');
      }
    }
    // Off the navmesh by a little (it keeps an actor's radius off the walls: by the tower's wall
    // the player stood 60 units off it), the way starts from its nearest point at that height,
    // not straight through the wall.
    // One across a wall is no start (by the tower the nearest point was inside it): of the
    // nearest points round the player, the nearest with nothing at chest height between.
    let snap;
    if (!onNav && nav?.nearest) {
      const physics = viewer().play?.physics;
      const clear = (p) => {
        if (!physics) return true;
        const from = [feet[0], feet[1], feet[2] + 50];
        const d = [p[0] - feet[0], p[1] - feet[1], p[2] + 50 - from[2]];
        const l = Math.hypot(...d);
        return l < 1 || !physics.raycast(from, d.map((v) => v / l), l, Layer.charController, undefined, 0x14);
      };
      const seen = [];
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const p = nav.nearest([feet[0] + dx * 64, feet[1] + dy * 64, feet[2]], 160);
        if (p) seen.push(p);
      }
      seen.sort((a, b) => Math.hypot(a[0] - feet[0], a[1] - feet[1]) - Math.hypot(b[0] - feet[0], b[1] - feet[1]));
      snap = seen.find(clear);
    }
    const start = onNav ? feet : snap;
    const found = start ? paths.findPath(nav, start, goal, { radius: 24, blocked: bot.blocked }) : undefined;
    const changed = !bot.goal || Math.hypot(goal[0] - bot.goal[0], goal[1] - bot.goal[1]) > 64;
    bot.goal = goal;
    bot.path = found && found.points.length > 1 ? (snap ? [[...snap]] : []).concat(found.points.slice(1).map((p) => [...p])) : [goal];
    // How far the way goes (a guide near across a wall is not near: Ralof inside the tower, the
    // player outside it).
    bot.pathLength = undefined;
    if (found?.complete) {
      let length = start ? Math.hypot(found.points[0][0] - start[0], found.points[0][1] - start[1]) : 0;
      for (let i = 1; i < found.points.length; i++) length += Math.hypot(found.points[i][0] - found.points[i - 1][0], found.points[i][1] - found.points[i - 1][1]);
      bot.pathLength = length;
    }
    // A way over the navmesh far longer than the straight line to a goal not above: a player
    // jumps down (Helgen's tower: the hole Alduin broke, onto the inn's roof, while the navmesh
    // leads down the stairs to the door the quest has shut).
    if (found && !bot.door && at.world !== undefined && goal[2] < feet[2] - 150) {
      let length = 0;
      for (let i = 1; i < found.points.length; i++) length += Math.hypot(found.points[i][0] - found.points[i - 1][0], found.points[i][1] - found.points[i - 1][1]);
      const straight = Math.hypot(goal[0] - feet[0], goal[1] - feet[1]);
      if (length > straight * 2 + 300) {
        if (!bot.straight) say('the way round is ' + Math.round(length) + ' for ' + Math.round(straight) + ' straight: straight on');
        bot.straight = true;
        bot.path = [goal];
      } else bot.straight = false;
    }
    // Off the navmesh with the navmesh below (the burning inn's upper floor), its goal below it
    // or stuck going straight: a player drops down where the floor gives way, the drop landing
    // nearest the goal with a way on (straight on, a goal not below: the tower's jump).
    const below = goal[2] < feet[2] - 150;
    if (!found && (below || stuckHere >= 2) && nav && !onNav && nav.nearest?.([feet[0], feet[1], feet[2] - 300], 600)) {
      const way = findDrop(feet, goal);
      const drop = way?.at(-1);
      if (drop) {
        bot.path = way;
        if (Math.hypot(drop[0] - (bot.drop?.[0] ?? 0), drop[1] - (bot.drop?.[1] ?? 0)) > 32) say('drop down at ' + drop.map(Math.round).join(',') + ' (' + way.length + ' steps)');
        bot.drop = drop;
      }
    }
    if (changed) say('goal ' + goal.map(Math.round).join(',') + (bot.door ? ' (door ' + bot.door.toString(16) + ')' : '') + (bot.guide ? ' (guide ' + bot.guide.toString(16) + ')' : '') + (bot.loot ? ' (loot ' + bot.loot.toString(16) + ')' : '') + ' path ' + (found ? found.points.length + (found.complete ? '' : ' partial') : 'none'));
  };
  bot.timer = setInterval(() => {
    const play = engineDev.play(); const player = W.player;
    const rt = play?.session.scriptsReady;
    // The container menu of what it opened to loot: the scenario takes all and closes it.
    if (play?.session.menuMode && bot.loot !== undefined && bot.lootMenu === undefined && [...play.host.menus].some((m) => m.movie.startsWith('containermenu'))) {
      bot.lootMenu = bot.loot;
      say('container menu of ' + bot.loot.toString(16) + ' open');
    }
    if (!player || !rt || rt.controls.aiDriven || play.session.menuMode || W.loading !== undefined) { bot.release(); return; }
    const now = performance.now();
    if (!bot.planning && now - bot.lastPlan > 1500) {
      bot.planning = true; bot.lastPlan = now;
      plan().catch((e) => say('plan failed: ' + e.message)).finally(() => { bot.planning = false; });
    }
    const feet = player.feet;
    // A fight inside (MQ101's keep: "Wait for battle to be over", the Imperials who fight Ralof):
    // as a player does, it draws and goes at the nearest living enemy of the player or of the
    // guide followed last on its floor, and attacks once within reach (god mode keeps it up).
    const stage = W.actorStage;
    if (stage && bot.inside) {
      const ally = bot.lastGuide;
      const enemies = new Set(stage.combat.enemiesOfPlayer());
      for (const s of stage.all()) {
        const target = stage.combat.targetOf(s.reference);
        if (!s.dead && target !== undefined && (target === 0x14 || target === ally) && s.reference !== ally) enemies.add(s.reference);
      }
      let foe;
      for (const ref of enemies) {
        const s = stage.get(ref);
        if (!s || s.dead || Math.abs(s.position[2] - feet[2]) > 160) continue;
        const d = Math.hypot(s.position[0] - feet[0], s.position[1] - feet[1]);
        if (d < 1500 && (!foe || d < foe.d)) foe = { s, d };
      }
      if (foe) {
        if (bot.fighting !== foe.s.reference) { bot.fighting = foe.s.reference; say('fights ' + foe.s.reference.toString(16) + ' at ' + Math.round(foe.d)); }
        if (!bot.drawn) { bot.drawn = true; player.press('Ready Weapon', true); setTimeout(() => player.press('Ready Weapon', false), 120); }
        bot.aim = foe.s.position;
        player.pitch = -0.15;
        if (foe.d > 110) { hold('KeyW', true); for (const key of ['KeyA', 'KeyD', 'KeyS']) hold(key, false); }
        else {
          bot.release();
          if (now - (bot.swung ?? 0) > 900) { bot.swung = now; player.press('Right Attack/Block', true); setTimeout(() => player.press('Right Attack/Block', false), 150); }
        }
        return;
      }
      if (bot.fighting !== undefined) { say('the fight is over'); bot.fighting = undefined; }
    }
    const goal = bot.goal;
    if (!goal) { bot.release(); return; }
    const guide = bot.guide !== undefined ? W.actorStage?.get(bot.guide) : undefined;
    const toGoal = Math.hypot(goal[0] - feet[0], goal[1] - feet[1]);
    // A guide near: wait for them to lead on (after a while closer still: a trigger by them).
    const near = bot.waitSince !== undefined && now - bot.waitSince > 8000 ? 90 : 220;
    const reachable = bot.pathLength === undefined || bot.pathLength < near * 1.6;
    if (guide && toGoal < near && reachable && Math.abs(goal[2] - feet[2]) < 150) { bot.release(); bot.still = 0; bot.waitSince ??= now; return; }
    if (!guide || toGoal > 300) bot.waitSince = undefined;
    // At the door: face it and use it.
    if (bot.door !== undefined && toGoal < 110) {
      bot.release();
      const dz = goal[2] + 70 - (feet[2] + 120);
      bot.aim = goal;
      player.pitch = Math.atan2(dz, Math.max(1, toGoal));
      if (now - (bot.usedDoor ?? 0) > 2500) {
        bot.usedDoor = now;
        // What the crosshair is on as it presses, and whether the door is locked: a door that
        // takes several presses says why.
        const aimed = viewer().play?.crosshairTarget;
        const ref = rt.state.references.get(bot.door); const lock = ref && (ref.locked || ref.activationBlocked) ? { locked: ref.locked, level: ref.lockLevel, blocked: ref.activationBlocked } : undefined;
        tap('KeyE');
        say('use door ' + bot.door.toString(16) + ' (crosshair on ' + (aimed?.reference?.toString(16) ?? 'nothing') + (aimed?.verb ? ' ' + JSON.stringify(aimed.verb) : '') + ', ' + Math.round(toGoal) + ' units off' + (lock ? ', lock ' + JSON.stringify(lock) : '') + ', allows Activate ' + player.allows?.('Activate') + ')');
      }
      return;
    }
    // Someone stood between it and what it loots (Ralof by Gunjar's body, the crosshair on him):
    // a player steps round to the body's other side, then faces it again.
    if (bot.loot !== undefined && bot.lootStand?.loot === bot.loot && !bot.lootStand.reached) {
      const [sx, sy] = bot.lootStand.at;
      if (Math.hypot(sx - feet[0], sy - feet[1]) < 20 || now - bot.lootStand.since > 8000) {
        bot.lootStand.reached = true;
        bot.release();
      } else {
        bot.aim = bot.lootStand.at;
        player.pitch = 0;
        hold('KeyW', true);
        return;
      }
    }
    // At what it loots: face it and open it.
    if (bot.loot !== undefined && toGoal < 100) {
      bot.release();
      const dz = goal[2] + 30 - (feet[2] + 120);
      bot.aim = goal;
      player.pitch = Math.atan2(dz, Math.max(1, toGoal));
      // The crosshair on nothing: a player looks about for it, lower and higher in turn.
      bot.lootTries = bot.lootFor === bot.loot ? (bot.lootTries ?? 0) : 0;
      bot.lootFor = bot.loot;
      player.pitch += [0, -0.25, 0.25, -0.5, 0.5][Math.floor(bot.lootTries / 2) % 5];
      if (now - (bot.usedLoot ?? 0) > 2500) {
        bot.usedLoot = now;
        bot.lootTries++;
        const aimed = viewer().play?.crosshairTarget;
        // What the pick meets (the crosshair's ray: from the camera along the view), and where
        // the target's posed body lies, while the crosshair is on nothing.
        let seen = '';
        if (!aimed) {
          const play = viewer().play;
          const staged = W.actorStage?.get(bot.loot);
          const hit = play?.physics.pick(player.position, player.forward, 250, 5, Layer.itemPicker, player.character.collider);
          const body = staged?.placed ? [actors.actorFeet(staged.placed), actors.headPosition(staged.placed)].map((p) => p.map(Math.round).join(',')).join(' to ') : 'not staged';
          seen = ', pick meets ' + (hit ? (hit.owner?.kind ?? '?') + ' ' + (hit.owner?.reference?.toString(16) ?? '') + ' at ' + Math.round(hit.distance) : 'nothing') + ', body ' + body + (staged ? ', dead ' + staged.dead : '') + ', camera ' + player.position.map(Math.round).join(',') + ' pitch ' + player.pitch.toFixed(2) + ', allows Activate ' + player.allows?.('Activate');
        }
        const blocker = aimed?.reference !== undefined && aimed.reference !== bot.loot ? W.actorStage?.get(aimed.reference) : undefined;
        if (blocker) {
          // To the far side of the target from them, a quarter turn further each time.
          const turns = bot.lootStand?.loot === bot.loot ? bot.lootStand.turns + 1 : 0;
          const away = Math.atan2(goal[1] - blocker.position[1], goal[0] - blocker.position[0]) + turns * (Math.PI / 2);
          const at = [goal[0] + Math.cos(away) * 60, goal[1] + Math.sin(away) * 60, goal[2]];
          bot.lootStand = { loot: bot.loot, at, turns, since: now, reached: false };
          say('open ' + bot.loot.toString(16) + ': ' + aimed.reference.toString(16) + ' stands in the way; round to ' + at.map(Math.round).join(','));
          return;
        }
        tap('KeyE');
        say('open ' + bot.loot.toString(16) + ' (crosshair on ' + (aimed?.reference?.toString(16) ?? 'nothing') + seen + ')');
        // Not on the stage: what the game state has for it (once).
        if (!aimed && !W.actorStage?.get(bot.loot) && bot.lootState !== bot.loot) {
          bot.lootState = bot.loot;
          const ref = bot.loot;
          void rt.placement(ref, false).then((at) => {
            const staged = [...(W.actorStage?.all() ?? [])].filter((s) => s.placed.actor.startsDead || s.dead).map((s) => s.reference.toString(16));
            say('not staged ' + ref.toString(16) + ': reference state ' + JSON.stringify(rt.state.references.get(ref) ?? null) + ', actor dead ' + rt.state.actors.get(ref)?.dead + ', corpse ' + JSON.stringify(rt.state.actors.get(ref)?.corpse ?? null)?.slice(0, 120) + ', placement ' + JSON.stringify(at ?? null) + ', dead on the stage ' + staged.join(' '));
          });
        }
      }
      return;
    }
    while (bot.path.length > 1 && Math.hypot(bot.path[0][0] - feet[0], bot.path[0][1] - feet[1]) < 56) bot.path.shift();
    const next = bot.path[0] ?? goal;
    bot.aim = next;
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
      (bot.stucks ??= []).push({ at: [...feet], time: now });
      const move = ['KeyA', 'KeyD', 'KeyS'][bot.stuckCount % 3];
      bot.dodge = { key: move, until: now + 500 + 200 * (bot.stuckCount % 4) };
      if (bot.stuckCount % 2 === 0) tap('Space');
      // Every tenth time, why it may not move: its controls, the ground and what lies under it.
      let why = '';
      if (bot.stuckCount % 10 === 1) {
        const under = viewer().play?.physics.pick([feet[0], feet[1], feet[2] + 40], [0, 0, -1], 120, 5, Layer.charController, player.character.collider);
        why = ' (allows Forward ' + player.allows?.('Forward') + ', Jump ' + player.allows?.('Jump') + ', disabled controls ' + (player.disabledControls?.() ?? 0) + ', grounded ' + player.character.grounded + ', under ' + (under ? (under.owner?.kind ?? '?') + ' ' + (under.owner?.reference?.toString(16) ?? '') + ' at ' + Math.round(under.distance) : 'nothing') + ', AI driven ' + rt.controls.aiDriven + ')';
      }
      say('stuck at ' + feet.map(Math.round).join(',') + ': ' + { KeyA: 'step left', KeyD: 'step right', KeyS: 'back off' }[move] + (bot.stuckCount % 2 === 0 ? ', jump' : '') + why);
    }
  }, 100);
  // The view turns to the point it heads for as a player turns a mouse: once it is more than 5°
  // off, a turn at a steady rate until it is on it, then held (set at once ten times a second,
  // the body's turn rate came and went: turnLeft and turnStop many times a second).
  let lastFrame = performance.now();
  const turn = (now) => {
    if (window.__qaBot !== bot) return;
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const player = W.player;
    const rt = engineDev.play()?.session.scriptsReady;
    const aim = bot.aim;
    if (player && rt && !rt.controls.aiDriven && aim) {
      const feet = player.feet;
      const want = Math.atan2(aim[0] - feet[0], aim[1] - feet[1]);
      const off = Math.atan2(Math.sin(want - player.yaw), Math.cos(want - player.yaw));
      if (Math.abs(off) > 0.09) bot.turning = true;
      if (bot.turning) {
        const step = Math.min(3, Math.max(0.6, Math.abs(off) * 6)) * dt;
        if (Math.abs(off) <= step || Math.abs(off) < 0.01) {
          player.yaw = want;
          bot.turning = false;
        } else player.yaw += Math.sign(off) * step;
      }
    }
    requestAnimationFrame(turn);
  };
  requestAnimationFrame(turn);
  return 'started';
})()`;

/**
 * The guides' watch (in the page): once a second, for Ralof and Hadvar, the package that runs
 * (editor id), its procedure, whether the AI holds it (a reaction), the reaction and the scene,
 * logged as it changes, and where they stand every 10 s; MQ101's and MQ101DragonAttack's stages
 * as they change; every actor that reacts to a dead body (with how far the body lies); the
 * player's capsule while it is not grounded for more than 2 s. Its lines are `__qaGuides.log`.
 */
export const GUIDE_WATCH = `(async () => {
  if (window.__qaGuides) return 'running';
  const GUIDES = { 0x2bf9e: 'Ralof', 0x2bfa2: 'Hadvar' };
  const QUESTS = { 0x3372b: 'MQ101', 0xd0593: 'DragonAttack' };
  const watch = { log: [], last: new Map(), reacting: new Map(), names: new Map(), stages: new Map(), airSince: undefined, airLogged: 0 };
  window.__qaGuides = watch;
  const say = (text) => { watch.log.push(Math.round(performance.now() / 1000) + ' ' + text); if (watch.log.length > 600) watch.log.shift(); };
  const viewer = () => (engineDev.world.play ? engineDev.world : engineDev.viewer);
  const name = async (rt, id) => {
    if (id === undefined) return '-';
    if (!watch.names.has(id)) watch.names.set(id, (await rt.forms.record(id))?.editorId || id.toString(16));
    return watch.names.get(id);
  };
  const round = (p) => p ? p.map(Math.round).join(',') : '-';
  let ticks = 0;
  watch.timer = setInterval(async () => {
    try {
      const rt = engineDev.play()?.session.scriptsReady;
      const stage = viewer().actorStage;
      if (!rt || !stage) return;
      ticks++;
      for (const [id, label] of Object.entries(QUESTS)) {
        const q = rt.state.quests.get(Number(id));
        const now = q ? q.stage + (q.running ? '' : ' (stopped)') : 'none';
        if (watch.stages.get(id) !== now) { watch.stages.set(id, now); say(label + ' stage ' + now); }
      }
      for (const [id, label] of Object.entries(GUIDES)) {
        const ref = Number(id);
        const staged = stage.get(ref);
        const running = stage.ai.current(ref);
        const line = !staged ? 'not on the stage' : [
          'package ' + (await name(rt, running?.id)),
          'procedure ' + (running?.procedure ?? '-'),
          stage.ai.held(ref) ? 'HELD' : 'not held',
          'reaction ' + (stage.senses.reacting(ref) ?? 'none'),
          'scene ' + (await name(rt, rt.scenes.sceneOf(ref))),
        ].join(', ');
        if (watch.last.get(ref) !== line) { watch.last.set(ref, line); say(label + ': ' + line + ' at ' + round(staged?.position)); }
        else if (staged && ticks % 10 === 0) say(label + ' at ' + round(staged.position));
      }
      // Every actor reacting to a dead body (new ones).
      for (const ref of stage.ai.running()) {
        const kind = stage.senses.reacting(ref);
        const was = watch.reacting.get(ref);
        if (kind === was) continue;
        watch.reacting.set(ref, kind);
        if (kind === 'corpse' || was === 'corpse') say('corpse reaction ' + (kind === 'corpse' ? 'begins' : 'ends') + ': ' + (await name(rt, ref)) + ' [' + ref.toString(16) + '] at ' + round(stage.get(ref)?.position) + ' (package ' + (await name(rt, stage.ai.current(ref)?.id)) + ')');
      }
      const player = viewer().player;
      if (player) {
        const grounded = player.character.grounded;
        const now = performance.now();
        if (grounded) watch.airSince = undefined;
        else {
          watch.airSince ??= now;
          if (now - watch.airSince > 2000 && now - watch.airLogged > 5000) { watch.airLogged = now; say('the player is not grounded for ' + Math.round((now - watch.airSince) / 1000) + ' s at ' + round(player.feet)); }
        }
      }
    } catch (e) { say('watch failed: ' + e.message); }
  }, 1000);
  // The carry watch, each frame: what carried the player (CharacterBody.carriedBy) whenever a
  // simulated body's carry was held to its limit, and whenever the player's feet go faster than
  // 1500 units a second (a load or a teleport, 3000 units or more in the frame, is none): over
  // more than 60 units a fling, with the carrier's reference and base and the simulated bodies
  // near; over 8 to 60, a jump of the feet, with its parts across and up, the bot's keys and what
  // it did last (once a second at most), so that one is told apart from the other.
  let lastFeet; let lastTime = performance.now();
  const describeOwner = async (rt, owner) => {
    if (!owner) return 'none';
    if (owner.kind !== 'object' || !owner.reference) return owner.kind;
    const base = await rt.baseOf(owner.reference);
    return (await name(rt, owner.reference)) + ' [' + owner.reference.toString(16) + '] base ' + (base === undefined ? '?' : (await name(rt, base)) + ' [' + base.toString(16) + ']');
  };
  const carryFrame = async (now) => {
    if (window.__qaGuides !== watch) return;
    try {
      const player = viewer().player;
      const rt = engineDev.play()?.session.scriptsReady;
      const feet = player?.feet;
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      const by = player?.character?.carriedBy;
      if (rt && by?.held && now - (watch.heldLogged ?? 0) > 1000) {
        watch.heldLogged = now;
        say('carry held: ' + (await describeOwner(rt, by.owner)) + ', ' + Math.round(by.mass) + ' kg, at ' + Math.round(by.speed) + ' u/s, player at ' + round(feet));
      }
      if (rt && feet && lastFeet && dt > 0 && viewer().loading === undefined) {
        const d = Math.hypot(feet[0] - lastFeet[0], feet[1] - lastFeet[1], feet[2] - lastFeet[2]);
        if (d / dt > 1500 && d > 8 && d <= 60 && now - (watch.jumpLogged ?? 0) > 1000) {
          watch.jumpLogged = now;
          const bot = window.__qaBot;
          const across = Math.hypot(feet[0] - lastFeet[0], feet[1] - lastFeet[1]);
          say('feet jump ' + Math.round(d) + ' in a frame of ' + Math.round(dt * 1000) + ' ms (across ' + Math.round(across) + ', up ' + Math.round(feet[2] - lastFeet[2]) + ') at ' + round(feet) + ', grounded ' + player.character.grounded + ', carried by ' + (by ? await describeOwner(rt, by.owner) : 'nothing') + ', keys ' + ([...(bot?.held ?? [])].join('+') || 'none') + ', bot last: ' + (bot?.log.at(-1) ?? '-'));
        }
        if (d / dt > 1500 && d > 60 && d < 3000) {
          const physics = viewer().play?.physics;
          const near = [];
          physics?.world.forEachRigidBody((body) => {
            if (!body.isDynamic()) return;
            const t = body.translation(); const v = body.linvel();
            const at = [t.x * 69.99125, t.y * 69.99125, t.z * 69.99125];
            if (Math.hypot(at[0] - feet[0], at[1] - feet[1], at[2] - feet[2]) > 400) return;
            near.push({ body, at, speed: Math.hypot(v.x, v.y, v.z) * 69.99125 });
          });
          near.sort((a, b) => b.speed - a.speed);
          const parts = [];
          for (const n of near.slice(0, 4)) {
            let owner;
            for (let i = 0; i < n.body.numColliders(); i++) owner ??= physics.ownerOf(n.body.collider(i));
            parts.push((await describeOwner(rt, owner)) + ' ' + Math.round(n.body.mass()) + ' kg ' + Math.round(n.speed) + ' u/s at ' + round(n.at));
          }
          say('player flung ' + Math.round(d / dt) + ' u/s (' + Math.round(d) + ' in the frame) at ' + round(feet) + ', grounded ' + player.character.grounded + ', carried by ' + (by ? (await describeOwner(rt, by.owner)) + ' at ' + Math.round(by.speed) + (by.held ? ' (held)' : '') : 'nothing') + '; bodies near: ' + (parts.join('; ') || 'none'));
        }
      }
      lastFeet = feet && [...feet];
    } catch (e) { say('carry watch failed: ' + e.message); }
    requestAnimationFrame(carryFrame);
  };
  requestAnimationFrame(carryFrame);
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
 * After the bot's loot (the container menu taken from and closed): the target is looted, and the
 * player wears what it carries and does not wear yet, armor and then one weapon, each as the
 * inventory menu equips a selected entry (EquipmentEngine.toggle: its OnObjectEquipped is the
 * player alias's MQ101PlayerScript, stages 256 and 258). Answers what was put on.
 */
const LOOT_EQUIP = `(async () => {
  const bot = window.__qaBot; const rt = engineDev.play().session.scriptsReady;
  if (!bot || !rt) return 'no bot';
  (bot.looted ??= new Set()).add(bot.lootMenu);
  bot.lootMenu = undefined; bot.loot = undefined; bot.lastPlan = 0;
  const worn = [];
  let weapon = false;
  for (const [formId, count] of [...(await rt.inventory(0x14))]) {
    if (count <= 0) continue;
    const record = await rt.forms.record(formId);
    if (record?.type !== 'ARMO' && record?.type !== 'WEAP') continue;
    if (record.type === 'WEAP' && weapon) continue;
    if (await rt.equipment.isEquipped(0x14, formId)) { if (record.type === 'WEAP') weapon = true; continue; }
    if (await rt.equipment.toggle(0x14, formId, 'right')) {
      worn.push(record.editorId || formId.toString(16));
      if (record.type === 'WEAP') weapon = true;
    }
  }
  const menus = [...engineDev.play().host.menus].map((m) => m.movie).join('/');
  bot.log.push(Math.round(performance.now() / 1000) + ' wears ' + (worn.join(', ') || 'nothing new') + (menus ? ' (menus open: ' + menus + ')' : ''));
  return (worn.join(', ') || 'nothing new') + (menus ? ' (menus open: ' + menus + ')' : '');
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
  // The ambushed Khajiit caravan by the opening's road: its dead (a Khajiit, a horse) lie as
  // ragdolls placed in their poses.
  'POIPineForest23',
];

/**
 * The streets bot (in the page): it walks the player into every trigger box near them (within
 * STREETS_RADIUS) that waits for the player and whose scripts name a scene or a quest with
 * scenes (src/scripting/runtime/trigger-gates.ts: Riften's north gate, Whiterun's establishing
 * scene, Winterhold's first visit), the nearest first, along the navmesh; in each it stands 8 s
 * (the scene it starts may come to the player), then goes on; one it cannot walk to in 25 s
 * it is put into (at its middle).
 * Runs as a console line (replMode): the world viewer's navmeshes and play session are private.
 */
const STREETS_RADIUS = 6000;
const STREETS_BOT = `
var QA_NAV = engineDev.world.#navmeshes;
var QA_PLAY = engineDev.world.#play;
(async () => {
  if (window.__qaStreets) return 'running';
  const paths = await import('/src/ai/pathfinding.ts');
  const { playerTrigger } = await import('/src/scripting/runtime/trigger-gates.ts');
  const W = engineDev.world;
  const nav = QA_NAV;
  const rt = engineDev.play().session.scriptsReady;
  const feet = [...W.player.feet];
  const goals = [];
  for (const trigger of QA_PLAY.physics.triggersNear(feet, ${String(STREETS_RADIUS)})) {
    const found = await playerTrigger(rt, trigger);
    if (!found) continue;
    const scenes = [];
    for (const form of found.names) {
      const record = await rt.forms.record(form);
      if (record?.type === 'SCEN') scenes.push(record.editorId);
      if (record?.type === 'QUST' && (await rt.sceneHost.scenesOf(form)).length > 0) scenes.push(record.editorId);
    }
    if (scenes.length === 0) continue;
    const placement = await rt.placement(trigger);
    if (!placement) continue;
    const name = (await rt.forms.record(trigger))?.editorId || trigger.toString(16);
    goals.push({ trigger, name, scenes, point: [...placement.position] });
  }
  // The nearest first, then the nearest to that one.
  const ordered = [];
  let from = feet;
  while (goals.length > 0) {
    goals.sort((a, b) => Math.hypot(a.point[0] - from[0], a.point[1] - from[1]) - Math.hypot(b.point[0] - from[0], b.point[1] - from[1]));
    const next = goals.shift();
    ordered.push(next);
    from = next.point;
  }
  const bot = { goals: ordered, index: 0, path: [], log: [], held: new Set(), since: performance.now(), arrived: undefined, last: undefined, still: 0 };
  window.__qaStreets = bot;
  const say = (text) => { bot.log.push(Math.round(performance.now() / 1000) + ' ' + text); };
  say('triggers: ' + (ordered.map((g) => g.name + ' (' + g.scenes.join('/') + ')').join(', ') || 'none'));
  const events = (code) => W.player?.eventsOfKey(code) ?? [];
  const hold = (code, down) => {
    const player = W.player; if (!player) return;
    if (down === bot.held.has(code)) return;
    for (const name of events(code)) player.press(name, down);
    if (down) bot.held.add(code); else bot.held.delete(code);
  };
  bot.release = () => { for (const code of [...bot.held]) hold(code, false); };
  const plan = (goal) => {
    const found = paths.findPath(nav, [...W.player.feet], goal.point, { radius: 24 });
    bot.path = found && found.points.length > 1 ? found.points.slice(1).map((p) => [...p]) : [goal.point];
  };
  if (ordered[0]) plan(ordered[0]);
  bot.timer = setInterval(() => {
    const play = engineDev.play(); const player = W.player;
    if (!player || play.session.menuMode || W.loading !== undefined) { bot.release(); return; }
    const goal = bot.goals[bot.index];
    if (!goal) { bot.release(); return; }
    const now = performance.now();
    const at = player.feet;
    const inside = rt.triggerVolumes.inside(goal.trigger).has(0x14);
    const toGoal = Math.hypot(goal.point[0] - at[0], goal.point[1] - at[1]);
    if (bot.arrived === undefined && (inside || toGoal < 40)) { bot.arrived = now; say('in ' + goal.name + (inside ? '' : ' (at its middle, not told inside)')); }
    // Not there after 25 s (a way the navmesh does not give, a wall in between): put inside,
    // at its middle (the scripts hear the entering all the same).
    if (bot.arrived === undefined && now - bot.since > 25000 && !bot.placed) {
      bot.placed = true;
      bot.release();
      player.teleport([...goal.point]);
      say('could not walk to ' + goal.name + ' (' + Math.round(toGoal) + ' units off): put inside');
      return;
    }
    if (bot.arrived !== undefined || now - bot.since > 40000) {
      bot.release();
      if (bot.arrived === undefined) say('could not reach ' + goal.name + ' (' + Math.round(toGoal) + ' units off)');
      else if (now - bot.arrived < 8000) return;
      bot.index++; bot.arrived = undefined; bot.since = now; bot.placed = false;
      const next = bot.goals[bot.index];
      if (next) { plan(next); say('on to ' + next.name); } else say('all triggers visited');
      return;
    }
    while (bot.path.length > 1 && Math.hypot(bot.path[0][0] - at[0], bot.path[0][1] - at[1]) < 56) bot.path.shift();
    const next = bot.path[0] ?? goal.point;
    player.yaw = Math.atan2(next[0] - at[0], next[1] - at[1]);
    player.pitch = 0;
    // Sidestepping (each side in turn) for a moment when stuck; no jumps (onto a town's rocks
    // and sconces).
    const dodging = bot.dodge && now < bot.dodge.until;
    hold('KeyW', !dodging);
    for (const key of ['KeyA', 'KeyD']) hold(key, dodging && bot.dodge.key === key);
    const last = bot.last; bot.last = [...at];
    if (last && Math.hypot(at[0] - last[0], at[1] - last[1]) < 1.5) bot.still += 0.1; else bot.still = Math.max(0, bot.still - 0.05);
    if (bot.still > 1.2) {
      bot.still = 0; bot.stuck = (bot.stuck ?? 0) + 1;
      bot.dodge = { key: bot.stuck % 2 ? 'KeyA' : 'KeyD', until: now + 600 };
      plan(goal);
      say('stuck at ' + at.map(Math.round).join(',') + ', a step aside');
    }
  }, 100);
  return 'started: ' + ordered.length + ' triggers';
})()`;

/**
 * The towns whose street and gate scenes the streets bot walks into (main-menu coc at 10:00,
 * watched 4 minutes): Riften's north gate (Mjoll and Aerin, Sapphire and Shadr, Maul), Whiterun's
 * Plains District (the establishing scene, Amren's, Braith and Lars'), Winterhold's first visit,
 * Ivarstead's scripted scene, Markarth's market (the Forsworn murder); run as "streets".
 */
const STREET_CELLS = [
  'RiftenCityNorth',
  'WhiterunPlainsDistrict03',
  'WinterholdExterior01',
  'IvarsteadExterior04',
  'MarkarthExterior01',
];

export const STREETS: readonly Scenario[] = STREET_CELLS.map((cell) => ({
  name: `streets-${cell}`,
  description: `coc ${cell} at 10:00; the player walks into the scene triggers near (the streets bot), watched 4 minutes.`,
  start: { kind: 'coc', cell },
  hour: 10,
  bootSeconds: 240,
  seconds: 240,
  setup: async (ctx) => {
    ctx.note(`streets bot: ${JSON.stringify(await ctx.page.eval(STREETS_BOT, 60000, true))}`);
  },
  finish: async (ctx) => {
    const log = await ctx.page
      .eval<string[] | undefined>(
        `(() => { const b = window.__qaStreets; if (!b) return undefined; clearInterval(b.timer); b.release(); window.__qaStreets = undefined; return b.log; })()`,
        10000,
      )
      .catch(() => undefined);
    for (const line of log ?? []) ctx.note(`streets: ${line}`);
  },
}));

/** One scenario per place: in the world at 10:00, watched for 45 s (a run without names skips them). */
export const PLACES: readonly Scenario[] = PLACE_CELLS.map((cell) => ({
  name: `at-${cell}`,
  description: `coc ${cell} at 10:00, watched 45 s.`,
  start: { kind: 'coc', cell },
  hour: 10,
  bootSeconds: 240,
  seconds: 45,
}));

/**
 * The streaming flight: the player, without collision (tcl), carried north from Riverwood at a
 * horse's sprint 600 units above where they stood, the view ahead; a new row of cells loads
 * every few seconds (the frame times while cells load and unload: docs/rendering.md, "Frame
 * time"). The page's own loop moves them, one step a frame.
 */
const STREAM_FLIGHT = `(() => {
  if (window.__qaFlight) return 'running';
  const W = engineDev.world;
  const player = W.player;
  if (!player) return 'no player';
  const start = [...player.feet];
  const flight = { stop: false, start: performance.now(), travelled: 0 };
  window.__qaFlight = flight;
  let before = performance.now();
  const frame = (now) => {
    if (flight.stop || window.__qaFlight !== flight) return;
    const dt = Math.min(0.1, (now - before) / 1000);
    before = now;
    flight.travelled += 750 * dt;
    player.teleport([start[0], start[1] + flight.travelled, start[2] + 600], 0);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return 'flying from ' + start.map(Math.round).join(',');
})()`;

/** Scenarios for frame times (a run without names skips them). */
export const PERFORMANCE: readonly Scenario[] = [
  {
    name: 'streaming',
    description:
      'Riverwood at 13:00, then the player flies north (tcl) at 750 units a second, 600 above the ground they stood on: cells load and unload all the way (the frame times of streaming).',
    start: { kind: 'coc', cell: 'Riverwood' },
    hour: 13,
    bootSeconds: 240,
    seconds: 60,
    setup: async (ctx) => {
      await ctx.console('tgm');
      await ctx.console('tcl');
      ctx.note(`flight: ${JSON.stringify(await ctx.page.eval(STREAM_FLIGHT, 30000))}`);
    },
    finish: async (ctx) => {
      const travelled = await ctx.page
        .eval<number | undefined>(
          `(() => { const f = window.__qaFlight; if (!f) return undefined; f.stop = true; window.__qaFlight = undefined; return Math.round(f.travelled); })()`,
          10000,
        )
        .catch(() => undefined);
      ctx.note(`flew ${String(travelled)} units`);
    },
  },
];

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
    setup: (ctx) => fightSetup(ctx, false),
  },
  {
    name: 'combat-melee',
    description:
      'The same fight in Riverwood at 12:00 with their arrows taken: three bandits and three Imperial guards close in with blades (advancing to places round their targets, circling, falling back, backing off).',
    start: { kind: 'coc', cell: 'Riverwood' },
    hour: 12,
    bootSeconds: 240,
    seconds: 150,
    setup: (ctx) => fightSetup(ctx, true),
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
    name: 'creature-melee',
    description:
      'The Whiterun stables at 10:00, the player in god mode: a creature of each fighting race (frostbite spider, skeever, wolf, bear, sabre cat, troll, draugr, skeleton, falmer, chaurus, spriggan, mudcrab, horker, ice wraith, Dwemer spider, sphere and centurion, a giant) put in a ring around them and set on them: each must close in, attack with its graph’s attacks and hit (the combat monitors).',
    start: { kind: 'coc', cell: 'WhiterunExterior01' },
    hour: 10,
    bootSeconds: 240,
    seconds: 150,
    setup: async (ctx) => {
      await ctx.console('tgm');
      const ring = CREATURE_RACES.map((base, i): readonly [number, number, number] => {
        const a = (i / CREATURE_RACES.length) * Math.PI * 2;
        return [base, Math.cos(a) * 900, Math.sin(a) * 900];
      });
      const placed = await ctx.page.eval<number[]>(placeAnimals(ring), 90000);
      ctx.note(`placed ${placed.map((r) => r.toString(16)).join(',')}`);
      await sleepMs(3000);
      await ctx.page.eval(
        `(() => { const sw = engineDev.play().session.scriptWorld; for (const r of ${JSON.stringify(placed)}) sw.startCombat(r, 0x14); return true; })()`,
        20000,
      );
      ctx.note('each is set on the player');
    },
  },
  {
    name: 'bleak-falls-spider',
    description:
      'Bleak Falls Barrow: the player walks into the trigger by Arvel the Swift’s web (in god mode); the frostbite spider drops from its ceiling hole (its ambush, an activate child of the trigger) and fights them.',
    start: { kind: 'coc', cell: 'BleakFallsBarrow01' },
    hour: 10,
    bootSeconds: 240,
    seconds: 90,
    setup: async (ctx) => {
      await ctx.console('tgm');
      // Into the room's trigger box (defaultActivateSelfTRIG), then on toward the web.
      for (const [x, y, z] of SPIDER_WALK) {
        await ctx.page.eval(
          `var QA_PLAY = engineDev.viewer.#play ?? engineDev.world.#play;
QA_PLAY.player.teleport([${String(x)}, ${String(y)}, ${String(z)}], Math.PI / 2); 'ok'`,
          20000,
          true,
        );
        await sleepMs(3000);
      }
      ctx.note('the player walked through the spider’s trigger');
    },
    // The spider must have come down and fought: one that never attacked (still in its hole,
    // its ambush never sprung) is reported as a passive creature.
    finish: async (ctx) => {
      const line = await ctx.page.eval<string>(
        `(() => {
          const stage = engineDev.viewer?.actorStage ?? engineDev.world?.actorStage;
          const fighter = stage?.combat.qaFighter(${String(BLEAK_FALLS_SPIDER)});
          const spider = stage?.get(${String(BLEAK_FALLS_SPIDER)});
          const at = spider?.position.map(Math.round).join(', ') ?? '?';
          const text = 'the spider: ' + (fighter ? fighter.attacks + ' attacks, ' + fighter.hits + ' hits' : 'no fighter') + ', at ' + at;
          if (!fighter || fighter.attacks === 0)
            engineDev.qa.report({ kind: 'creature-passive', subject: { id: '0003A1E1', name: 'Wounded Frostbite Spider', kind: 'creature' }, time: 0, detail: text + ': its ambush never came down to fight', severity: 1, position: spider?.position });
          return text;
        })()`,
        20000,
      );
      ctx.note(line);
    },
  },
  {
    name: 'deaths',
    description:
      'Riverwood at 12:00: 28 kinds of actors (people, draugr, skeletons, animals, Dwemer machines, giants, a mammoth, atronachs) placed in a ring around the player and killed by script; their deaths and ragdolls watched.',
    start: { kind: 'coc', cell: 'Riverwood' },
    hour: 12,
    bootSeconds: 240,
    seconds: 75,
    setup: async (ctx) => {
      await ctx.console('tgm');
      const placed = await ctx.page.eval<string>(
        `(async () => {
          const rt = engineDev.play().session.scriptsReady;
          const at = await rt.placement(0x14);
          const bases = ${JSON.stringify(DEATH_ACTORS)};
          const placed = [];
          for (const [i, base] of bases.entries()) {
            const a = (i / bases.length) * Math.PI * 2;
            const reference = await rt.placeAt(base, 0x14, 1);
            const [x, y, z] = at.position;
            rt.move(reference, [x + Math.cos(a) * 700, y + Math.sin(a) * 700, z + 40], [...at.rotation], at.cell, at.world);
            rt.world.moved?.(reference);
            placed.push(reference);
          }
          window.__qaDeaths = placed;
          return placed.map((r) => r.toString(16)).join(',');
        })()`,
        120000,
      );
      ctx.note(`placed ${placed}`);
      await sleepMs(10000);
      await ctx.page.eval(
        `(async () => { const rt = engineDev.play().session.scriptsReady; for (const r of window.__qaDeaths) await rt.actors.scriptKill(r, 0x14); return true; })()`,
        60000,
      );
      ctx.note('all killed by script');
    },
  },
  {
    name: 'seated-deaths',
    description:
      'The Bannered Mare at 20:00: everyone in furniture (seated, leaning, at the counter) killed by script 40 s after the start; their deaths watched (from the pose they sat in: no standing up first, corpse-rises).',
    start: { kind: 'coc', cell: 'WhiterunBanneredMare' },
    hour: 20,
    bootSeconds: 240,
    seconds: 60,
    setup: async (ctx) => {
      await ctx.console('tgm');
      // Seated by then (the evening's patrons in their chairs, at the counter).
      await sleepMs(30000);
    },
    // 10 s into the watch, with the monitors on: every actor furniture holds is killed at once
    // (not awaited: a death's script events take their time).
    tick: async (ctx) => {
      ctx.state.ticks = Number(ctx.state.ticks ?? 0) + 1;
      if (ctx.state.killed === true || Number(ctx.state.ticks) < 10) return false;
      ctx.state.killed = true;
      const killed = await ctx.page.eval<string>(
        `(() => {
          const rt = engineDev.play().session.scriptsReady;
          const viewers = [engineDev.viewer, engineDev.world];
          const stage = viewers.find((v) => v.actorStage && [...v.actorStage.all()].length > 0)?.actorStage;
          if (!stage) return '';
          const seated = [...stage.all()].filter((s) => !s.dead && stage.furniture.holds(s.reference));
          for (const s of seated) void rt.actors.scriptKill(s.reference, 0x14);
          return seated.map((s) => s.placed.look.editorId).join(', ');
        })()`,
        30000,
      );
      ctx.note(`killed in furniture: ${killed || 'nobody'}`);
      return false;
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
  openingScenario('opening'),
  openingScenario('opening-ralof', 'ralof'),
  openingScenario('opening-hadvar', 'hadvar'),
  {
    // Found 2026-11-10: a load door used again while its place loaded (the world runs on behind
    // the loading screen: an automatic door come near again, a press) was taken a second time,
    // and a place loaded again while its first load still placed its actors left those actors
    // off the stage for good. Here the keep is loaded twice at once (the second as the first
    // places its actors): the keep's own actors, Gunjar's body among them, are on the stage
    // after both. Then the way out (HelgenKeeptoExterior01REF's journey) is asked twice: one
    // journey is taken.
    name: 'keep-loaded-twice',
    description:
      "Helgen's keep (coc HelgenKeep01): the keep loaded twice at once, Gunjar's body and the keep's dead on the stage after; then its door out used twice, one journey taken.",
    start: { kind: 'coc', cell: 'HelgenKeep01' },
    bootSeconds: 300,
    seconds: 240,
    tick: async (ctx) => {
      const state = ctx.state as { step?: number; since?: number };
      const step = state.step ?? 0;
      const STAGED = `(() => { const s = engineDev.viewer.actorStage; const all = [...(s?.all() ?? [])]; return JSON.stringify({ gunjar: s?.get(0xb1694) !== undefined, actors: all.length, dead: all.filter((a) => a.placed.actor.startsDead).length, placing: s?.placing === true, loading: engineDev.viewer.loading ?? null }); })()`;
      const settled = async (): Promise<string | undefined> => {
        const now = await ctx.page.eval<string>(STAGED, 20000);
        const parsed = JSON.parse(now) as {
          placing: boolean;
          loading: string | null;
          actors: number;
        };
        // Settled: nothing loading or being placed, and the stage filled (or a minute gone).
        const waited = Date.now() - (state.since ?? 0) > 60000;
        return parsed.placing || parsed.loading !== null || (parsed.actors === 0 && !waited)
          ? undefined
          : now;
      };
      if (Date.now() - (state.since ?? 0) < 10000) return false;
      if (step === 0) {
        const now = await settled();
        if (!now) return false;
        ctx.note(`as loaded: ${now}`);
        const second = await ctx.page.eval<boolean>(
          `(async () => { const v = engineDev.viewer; const at = { position: [-300, 4300, 400], heading: 0 }; void v.showCell(0x5de24, at); const until = performance.now() + 60000; while (v.actorStage?.placing !== true && performance.now() < until) await new Promise((r) => setTimeout(r, 5)); const placing = v.actorStage?.placing === true; void v.showCell(0x5de24, at); return placing; })()`,
          70000,
        );
        ctx.note(
          `the keep loaded twice at once (the second ${second ? 'while the first placed its actors' : 'after the first placed none'})`,
        );
        state.step = 1;
        state.since = Date.now();
        return false;
      }
      if (step === 1) {
        const now = await settled();
        if (!now) return false;
        ctx.note(`after the loads: ${now}`);
        const { gunjar } = JSON.parse(now) as { gunjar: boolean };
        ctx.note(gunjar ? "Gunjar's body is on the stage" : "Gunjar's body is NOT on the stage");
        // The door out (HelgenKeeptoExterior01REF: to AutoLoadDoor01 25fae outside), used twice.
        await ctx.page.eval(
          `(() => { let n = 0; for (const v of [engineDev.world, engineDev.viewer]) { const key = v === engineDev.world ? 'open' : 'showCell'; const load = v[key].bind(v); v[key] = (...a) => { n++; return load(...a); }; } window.__qaJourneys = () => n; const t = { door: 0x25fae, position: [15759.7, -77882.9, 8222], rotation: [0, 0, 2.8] }; engineDev.viewer.onTravel(t); engineDev.viewer.onTravel(t); return true; })()`,
          20000,
        );
        ctx.note('the door out used twice');
        state.step = 2;
        state.since = Date.now();
        return false;
      }
      const loading = await ctx.page.eval<boolean>(
        '(engineDev.world.loading ?? engineDev.viewer.loading) !== undefined || engineDev.play().session.loading',
        5000,
      );
      if (loading && Date.now() - (state.since ?? 0) < 120000) return false;
      const journeys = await ctx.page.eval<number>('window.__qaJourneys()', 5000);
      ctx.note(`places loaded for the two uses: ${String(journeys)}`);
      return true;
    },
  },
];

/**
 * The new game's opening; with a side, the bot takes that guide's keep door ("Enter the Keep
 * with Hadvar or Ralof"), as a player picks one (else the nearest).
 */
function openingScenario(name: string, side?: 'ralof' | 'hadvar'): Scenario {
  return {
    name,
    description: `New game: the cart ride to Helgen, the execution, Alduin, AI-driven until MQ101 stage 160, then a bot (god mode) following the quest marker into the keep${side ? ` by ${side === 'ralof' ? "Ralof's" : "Hadvar's"} door` : ''}, looting and wearing what the objectives ask for, and on while MQ101 moves.`,
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
        watching?: boolean;
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
      // The guides watched from the dragon's arrival on (their packages, reactions and scenes;
      // the corpse reactions round them).
      if (now.stage >= 100 && state.watching !== true) {
        state.watching = true;
        await ctx.page.eval(GUIDE_WATCH, 30000);
        ctx.note('the guides are watched');
      }
      if (now.stage >= 160 && !now.driven && state.bot !== true) {
        state.bot = true;
        // The bot does not fight (the keep's soldiers, its bear and spiders): god mode.
        await ctx.console('tgm');
        if (side) await ctx.page.eval(`window.__qaSide = '${side}'`, 5000);
        await ctx.page.eval(FOLLOW_BOT, 30000, true);
        ctx.note(
          `the player is free: the follow bot takes over (god mode)${side ? `, on ${side}'s side` : ''}`,
        );
      }
      // The container menu the bot opened to loot: take all (R) and close it (Tab), as a player
      // does; then the player wears what it took.
      if (state.bot === true) {
        const loot = await ctx.page.eval<number | null>('window.__qaBot?.lootMenu ?? null', 5000);
        if (loot !== null) {
          await sleepMs(1500);
          // The menu opens on its categories; the X button takes all only from the container's
          // items list (the movie's isViewingContainer: a category shown), as a player goes in.
          await ctx.page.key('ArrowRight');
          await sleepMs(1500);
          await ctx.page.key('KeyR');
          await sleepMs(2000);
          await ctx.page.key('Tab');
          await sleepMs(2000);
          const worn = await ctx.page.eval<string>(LOOT_EQUIP, 30000);
          ctx.note(`looted ${loot.toString(16)}: ${worn}`);
          if (worn.includes('containermenu')) await ctx.page.key('Escape');
        }
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
      const guides = await ctx.page
        .eval<string[] | undefined>(
          `(() => { const w = window.__qaGuides; if (!w) return undefined; clearInterval(w.timer); return w.log; })()`,
          10000,
        )
        .catch(() => undefined);
      for (const line of guides ?? []) ctx.note(`guides: ${line}`);
    },
  };
}
