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
  // chest height between neighbours): of the drops, the one landing nearest the goal that lands
  // on navmesh with a way on to it (the inn's upper floor has holes nearer down into a room that
  // rubble shuts), else the one landing nearest.
  const findDrop = (feet, goal) => {
    const physics = QA_PLAY?.physics;
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
          if (placement) found.push({ quest: formId, objective: objective.index, order, holds, reference, placement });
        }
      }
    }
    return found;
  };
  const say = (text) => { bot.log.push(Math.round(performance.now() / 1000) + ' ' + text); if (bot.log.length > 200) bot.log.shift(); };
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
    // No target shown (MQ101DragonAttack's stage 192: Hadvar ran ahead into his trigger and
    // waits by the street's, which the player sets walking in): a player follows the guide
    // they followed last, while it is about.
    if (!best && bot.lastGuide !== undefined && W.actorStage?.get(bot.lastGuide)) {
      const placement = await rt.placement(bot.lastGuide);
      if (placement) best = measure({ quest: 0, objective: -1, order: 0, holds: true, reference: bot.lastGuide, placement });
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
    if (bot.guide !== undefined) bot.lastGuide = bot.guide;
    // A target that is a load door here (MQ101's "Enter the Keep": the keep's doors) is used
    // as a player uses it: walked to and activated.
    // So is the load door by a place target (the keep's doors stand by MQ101's "Enter the Keep"
    // markers, which the keep's navmesh does not reach).
    if (best.same && bot.guide === undefined) {
      const record = await (await play.session.db).get(best.t.reference);
      if (record?.fields.has('XTEL')) bot.door = best.t.reference;
      else {
        const space = at.world !== undefined ? { kind: 'world', world: at.world } : { kind: 'interior', cell: at.cell ?? 0 };
        const p = best.t.placement.position;
        let nearest;
        for (const door of (await play.session.routeMap()).doorsInSpace(space)) {
          const d = Math.hypot(door.position[0] - p[0], door.position[1] - p[1], door.position[2] - p[2]);
          if (d < 300 && (!nearest || d < nearest.d)) nearest = { door, d };
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
    // On the navmesh: one at its feet' height (the triangle under the inn's upper floor is the
    // ground floor's, 300 units down: a way from there is not the player's).
    const onNav = nav?.nearest?.(feet, 48) !== undefined;
    // Where it got stuck lately (20 s), here: a way the navmesh has but something shuts (the
    // inn's rubble, a collision box the quest enabled) is closed there and searched round,
    // as an actor closes a door it cannot pass.
    bot.stucks = (bot.stucks ?? []).filter((s) => now - s.time < 20000);
    const stuckHere = bot.stucks.filter((s) => Math.hypot(s.at[0] - feet[0], s.at[1] - feet[1]) < 64).length;
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
    const found = onNav ? paths.findPath(nav, feet, goal, { radius: 24, blocked: bot.blocked }) : undefined;
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
      (bot.stucks ??= []).push({ at: [...feet], time: now });
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
