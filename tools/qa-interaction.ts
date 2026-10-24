// The QA runner's interaction scenarios (docs/qa.md): what the player does with the world, checked
// in the running game, each failure an `interaction` anomaly. Run by name (a run without names
// skips them), or all as "interaction".
//
// - interaction-prompts (POIPineForest23: the Khajiit caravan's corpses, a dead horse, its cart,
//   sacks): every loaded object's and actor's crosshair prompt against the engine's rule (no
//   statics, unnamed objects or creatures prompt; the dead are searched).
// - interaction-hotkeys (Riverwood): Flames and a sword made favorites with hotkeys 1 and 2; the
//   hotkeys equip as the engine's favorites handler does (a spell left, again right; a sword where
//   it goes, never taken off).
// - interaction-web (BleakFallsBarrow01): Flames cast from the left hand at Arvel's web from 150,
//   250 and 350 units, at its middle and above: the web burns (its destruction stages) each time.

import type { Scenario, ScenarioContext } from './qa-scenarios.ts';

/** Reports a failed check as an anomaly (the runner's report) and notes it. */
async function fail(ctx: ScenarioContext, detail: string): Promise<void> {
  ctx.note(`FAILED: ${detail}`);
  await ctx.page.eval(
    `(engineDev.qa?.report({ kind: 'interaction', time: 0, detail: ${JSON.stringify(detail)}, severity: 1 }), true)`,
    10000,
  );
}

/** A check that throws is a failed check, not a silent one (the runner swallows finish errors). */
function checked(
  run: (ctx: ScenarioContext) => Promise<void>,
): (ctx: ScenarioContext) => Promise<void> {
  return async (ctx) => {
    try {
      await run(ctx);
    } catch (error) {
      await fail(ctx, `the check broke: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

// The page scripts run in repl mode at the top level (private fields are read only there),
// with `var`s: a scenario may run one twice in the same page.

/** In the page (repl mode): every loaded object's and shown actor's prompt, the odd ones listed. */
const PROMPTS = `
var w = engineDev.world;
var act = w.#activatable.bind(w);
var actorAt = w.#play.#actorAt;
var r = engineDev.play().session.scriptsReady;
var counts = {};
var wrong = [];
var cells = [...w.#cells.values()];
for (const cell of cells) {
  for (const object of cell.objects.values()) {
    const a = act(object.reference);
    const key = object.baseType + ' ' + (a ? a.verb : '-');
    counts[key] = (counts[key] ?? 0) + 1;
    if (a && (object.baseType === 'STAT' || object.baseType === 'SCOL' || object.name === ''))
      wrong.push(object.editorId + ' (' + object.baseType + ') shows ' + a.verb);
  }
}
for (const placed of w.readyActors()) {
  const q = placed.actor.position;
  const t = actorAt([q[0], q[1], q[2] + 300], [0, 0, -1], 400, 30, { reference: placed.actor.reference, distance: 10 });
  const dead = r.state.actors.get(placed.actor.reference)?.dead ?? placed.actor.startsDead;
  const key = 'actor ' + (dead ? 'dead ' : '') + (t ? t.target.verb : '-');
  counts[key] = (counts[key] ?? 0) + 1;
  if (dead && t && t.target.verb !== r.settings?.string?.('sSearch') && !/search/i.test(t.target.verb))
    wrong.push(placed.look.editorId + ' (dead) shows ' + t.target.verb);
  if (!dead && t && /talk/i.test(t.target.verb) && placed.look.name === '')
    wrong.push(placed.look.editorId + ' (unnamed) shows Talk');
}
({ counts, wrong });
`;

/** In the page (repl mode): the hotkeys of a spell and a sword, pressed and checked. */
const HOTKEYS = `
var s = engineDev.play().session;
var r = s.scriptsReady;
var FLAMES = 0x12fcd;
var SWORD = 0x12eb7;
await r.addItem(0x14, r.formHandle(SWORD), 1, true);
await r.equipment.unequip(0x14, FLAMES);
r.state.favorites.add(FLAMES);
r.state.favorites.add(SWORD);
r.state.hotkeys.set(FLAMES, 0);
r.state.hotkeys.set(SWORD, 1);
var press = async (event) => {
  s.hud.userEvent(event);
  await new Promise((done) => setTimeout(done, 600));
  const e = await r.equipment.of(0x14);
  return [e.left?.toString(16), e.right?.toString(16)].join('/');
};
var steps = {
  swords: String(await r.itemCount(0x14, SWORD)),
  flames1: await press('Hotkey1'),
  flames2: await press('Hotkey1'),
  flames3: await press('Hotkey1'),
  sword: await press('Hotkey2'),
  sword2: await press('Hotkey2'),
};
steps;
`;

/** In the page (repl mode): Flames at Arvel's web from several places; whether it burnt. */
const WEB = `
var v = engineDev.viewer;
var play = v.#play;
var physics = play.physics;
var p = play.player;
var r = engineDev.play().session.scriptsReady;
var WEB = 0x1fc43;
var web = v.#cell.data.objects.find((o) => o.reference === WEB);
var wait = (s) => new Promise((done) => setTimeout(done, s * 1000));
var m = web.world;
var at = [m[12], m[13], m[14]];
var len = Math.hypot(m[4], m[5], m[6]);
var ny = [m[4] / len, m[5] / len, m[6] / len];
// The Survival Mode box a new game asks comes some seconds in: answered No first (in a menu
// nothing is cast).
for (let i = 0; i < 20; i++) {
  const box = [...engineDev.play().host.menus].find((x) => x.movie === 'messagebox.swf');
  if (box) {
    box.received('buttonPress', [0, 1]);
    break;
  }
  await wait(0.5);
}
await wait(1);
await r.equipment.equip(0x14, 0x12fcd, { hand: 'left' });
// Drawn once the equip has settled (a hand changed while drawing puts the weapon away again).
await wait(1);
p.press('Ready Weapon', true);
await wait(0.1);
p.press('Ready Weapon', false);
// Magic drawn (its draw animation played).
await wait(3);
var results = {};
for (const dist of [150, 250, 350]) {
  // Above Arvel, who hangs in its lower middle (a spray that meets him burns him, not the web).
  for (const height of [150, 200]) {
    r.destruction.clear(WEB);
    const above = [at[0] - ny[0] * dist, at[1] - ny[1] * dist, at[2] + 200];
    const floor = physics.raycast(above, [0, 0, -1], 800, 41);
    if (!floor) { results[dist + '/' + height] = 'no floor'; continue; }
    const spot = [floor.point[0], floor.point[1], floor.point[2] + 2];
    const target = [at[0], at[1], at[2] + height];
    p.teleport(spot, Math.atan2(target[0] - spot[0], target[1] - spot[1]));
    await wait(0.5);
    const eye = play.view.position;
    p.pitch = Math.atan2(target[2] - eye[2], Math.hypot(target[0] - eye[0], target[1] - eye[1]));
    await wait(0.3);
    p.press('Left Attack/Block', true);
    await wait(1);
    const phase = r.casting.casting(0x14, 0)?.hand.phase ?? 'none';
    await wait(1);
    p.press('Left Attack/Block', false);
    await wait(1);
    results[dist + '/' + height] = (r.destruction.stage(WEB) > 0 ? 'burnt' : 'whole') + ' (cast ' + phase + ')';
  }
}
results;
`;

export const INTERACTION: readonly Scenario[] = [
  {
    name: 'interaction-prompts',
    description:
      'POIPineForest23 (a caravan killed: corpses, a dead horse, carts, sacks): every prompt against the engine’s rule.',
    start: { kind: 'coc', cell: 'POIPineForest23' },
    hour: 10,
    bootSeconds: 240,
    seconds: 20,
    finish: checked(async (ctx) => {
      // Two passes: the prompt's facts (race flags, ownership) are read on the first.
      await ctx.page.eval(PROMPTS, 30000, true);
      await new Promise((done) => setTimeout(done, 1000));
      const { counts, wrong } = await ctx.page.eval<{
        counts: Record<string, number>;
        wrong: string[];
      }>(PROMPTS, 30000, true);
      ctx.note(`prompts: ${JSON.stringify(counts)}`);
      for (const line of wrong) await fail(ctx, `prompt: ${line}`);
    }),
  },
  {
    name: 'interaction-hotkeys',
    description: 'Riverwood: Flames and a sword on hotkeys 1 and 2, pressed as the engine does.',
    start: { kind: 'coc', cell: 'Riverwood' },
    hour: 12,
    bootSeconds: 240,
    seconds: 20,
    finish: checked(async (ctx) => {
      const steps = await ctx.page.eval<Record<string, string>>(HOTKEYS, 30000, true);
      ctx.note(`hotkeys (left/right): ${JSON.stringify(steps)}`);
      // A spell to the left hand, again to the right too, a third time nothing more; the sword
      // to the right hand, again nothing (a hotkey takes nothing off).
      const checks: [string, boolean][] = [
        ['flames1', steps.flames1?.startsWith('12fcd/') === true],
        ['flames2', steps.flames2 === '12fcd/12fcd'],
        ['flames3', steps.flames3 === '12fcd/12fcd'],
        ['sword', steps.sword?.endsWith('/12eb7') === true],
        // A second sword (the player has two) goes to the left hand.
        ['sword2', steps.sword2 === (Number(steps.swords) > 1 ? '12eb7/12eb7' : steps.sword)],
      ];
      for (const [step, ok] of checks) {
        if (!ok) await fail(ctx, `hotkey ${step}: left/right ${steps[step] ?? '?'}`);
      }
    }),
  },
  {
    name: 'interaction-web',
    description: "BleakFallsBarrow01: Flames at Arvel's web from 150-350 units: it burns.",
    start: { kind: 'coc', cell: 'BleakFallsBarrow01' },
    hour: 10,
    bootSeconds: 240,
    seconds: 5,
    setup: async (ctx) => {
      await ctx.console('tgm');
    },
    finish: checked(async (ctx) => {
      const results = await ctx.page.eval<Record<string, string>>(WEB, 120000, true);
      ctx.note(`web: ${JSON.stringify(results)}`);
      for (const [where, result] of Object.entries(results)) {
        if (!result.startsWith('burnt')) await fail(ctx, `web from ${where}: ${result}`);
      }
    }),
  },
];
