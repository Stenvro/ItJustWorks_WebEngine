// Runs the game's scripts in Node against the real files: a new game (every quest's and
// persistent reference's OnInit, the quests that start with the game), then game time passing
// at the game's pace. Reports the quests that run, the Papyrus log and every warning
// (unimplemented natives, conditions not valued yet, script errors) by how often it came.
//
//   node tools/papyrus-run.ts --new-game                 a new game, then 30 s of play
//   node tools/papyrus-run.ts --new-game --seconds 300   ... then 5 minutes
//   node tools/papyrus-run.ts --new-game --log           ... and print the Papyrus log
//   node tools/papyrus-run.ts --new-game --talk RalofREF ... and what an actor says to the
//                                                        player: its greeting and its topics
//   node tools/papyrus-run.ts --new-game --console "5:player.cast WerewolfChange player"
//       --activate 40:1a2b3   console lines (src/shell/console-commands.ts) and the player's
//                             activations (the perks' Activate choices first) at a time of the
//                             play (s), repeatable; the report ends with the player's race and
//                             forms (beast form, first-person geometry, eyes)

import { parseArgs } from 'node:util';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ConsoleCommands } from '../src/shell/console-commands.ts';
import { DialogueEngine } from '../src/scripting/runtime/dialogue-engine.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { readTimeScale } from '../src/world/game-time.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values } = parseArgs({
  options: {
    'new-game': { type: 'boolean', default: false },
    seconds: { type: 'string', default: '30' },
    log: { type: 'boolean', default: false },
    top: { type: 'string', default: '60' },
    talk: { type: 'string' },
    console: { type: 'string', multiple: true, default: [] },
    activate: { type: 'string', multiple: true, default: [] },
  },
});
if (!values['new-game']) {
  console.log('usage: node tools/papyrus-run.ts --new-game [--seconds N] [--log] [--top N]');
  process.exit(1);
}

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const library = new ScriptLibrary(async (name) => {
  const path = `scripts\\${name}.pex`;
  return vfs.has(path) ? vfs.read(path) : undefined;
});
const warnings = new Map<string, number>();
const log: string[] = [];
const runtime = new ScriptRuntime(db, library, {
  warn: (message) => warnings.set(message, (warnings.get(message) ?? 0) + 1),
  log: (line) => {
    log.push(line);
    if (values.log) console.log(`  [log] ${line}`);
  },
});
const hex = (id: number): string => id.toString(16).padStart(8, '0');

const start = performance.now();
await runtime.newGame((what) => {
  console.log(`${((performance.now() - start) / 1000).toFixed(1)} s: ${what}`);
});
console.log(`new game started in ${((performance.now() - start) / 1000).toFixed(1)} s`);
// What the block caches saved (src/formats/block-cache.ts): reads of the files, and small reads
// served from a block already read.
console.log(
  `reads: plugins ${String(db.blocks.reads)} (+${String(db.blocks.hits)} from blocks), ` +
    `archives ${String(vfs.blocks.reads)} (+${String(vfs.blocks.hits)} from blocks)`,
);

// Play: real seconds pass in frames, game time at the TimeScale (the load order's, as scripts
// and the console set it).
runtime.timeScale = await readTimeScale(db);
const frame = 1 / 30;
const seconds = Number(values.seconds);
// What the player does meanwhile: console lines and activations at their times ("s:what").
const timed = (entries: readonly string[]): { at: number; what: string }[] =>
  entries.map((entry) => {
    const colon = entry.indexOf(':');
    return { at: Number(entry.slice(0, colon)), what: entry.slice(colon + 1) };
  });
const lines = timed(values.console);
const activations = timed(values.activate);
const commands = new ConsoleCommands({
  runtime,
  db,
  travel: () => Promise.resolve(),
  toggleMenus: () => undefined,
  forceWeather: () => undefined,
  showRaceMenu: () => undefined,
  controlsChanged: () => undefined,
  quit: () => undefined,
});
const played = performance.now();
for (let t = 0; t < seconds; t += frame) {
  for (const line of lines.filter((entry) => entry.at <= t)) {
    lines.splice(lines.indexOf(line), 1);
    const printed = await commands.run(line.what);
    console.log(
      `${t.toFixed(1)} s: > ${line.what}${printed
        .map(
          (p) => `
  ${p}`,
        )
        .join('')}`,
    );
  }
  for (const activation of activations.filter((entry) => entry.at <= t)) {
    activations.splice(activations.indexOf(activation), 1);
    const reference = Number.parseInt(activation.what, 16);
    // The perks' choices first (the werewolf's Feed); then the default activation.
    const goesOn = await runtime.perks.activate(PLAYER_REF, reference, 'Activate');
    if (goesOn) runtime.playerActivated(reference);
    console.log(
      `${t.toFixed(1)} s: activated ${activation.what}${goesOn ? '' : ' (a perk took it)'}`,
    );
  }
  runtime.update(frame, (frame * runtime.timeScale) / 86400);
  await runtime.vm.idle();
}
console.log(
  `${String(seconds)} s of play in ${((performance.now() - played) / 1000).toFixed(1)} s`,
);

// --- What an actor says ------------------------------------------------------------------
if (values.talk) {
  const wanted = values.talk.toLowerCase();
  const speaker = [...db.formIdsOfType('ACHR'), ...db.formIdsOfType('REFR')].find(
    (formId) => formId === Number.parseInt(wanted, 16),
  );
  let found = speaker;
  if (found === undefined) {
    for (const formId of db.formIdsOfType('ACHR')) {
      if ((await db.get(formId))?.editorId?.toLowerCase() === wanted) found = formId;
    }
  }
  if (found === undefined) {
    console.log(`no reference ${values.talk}`);
  } else {
    const dialogue = new DialogueEngine(runtime);
    const greeting = await dialogue.greeting(found);
    console.log(`
${values.talk} [${hex(found)}] greets:`);
    if (greeting) {
      const quest = await runtime.forms.quest(greeting.quest);
      console.log(
        `  (${quest?.editorId ?? '?'} / ${greeting.topic.editorId || hex(greeting.topic.formId)} / info ${hex(greeting.info.formId)}: ${greeting.info.conditions.map((c) => conditionFunctionName(c.function)).join(', ')})`,
      );
    }
    for (const response of greeting?.source.info.responses ?? [])
      console.log(`  "${response.text}"`);
    console.log('topics:');
    for (const choice of await dialogue.topics(found)) {
      const quest = await runtime.forms.quest(choice.quest);
      console.log(
        `  ${choice.isNew ? '* ' : '  '}${choice.text} (${quest?.editorId ?? '?'} / ${choice.topic.editorId})`,
      );
      const info = await dialogue.choose(choice, found);
      if (info)
        console.log(
          `      ${info.info.conditions.map((c) => `${conditionFunctionName(c.function)}(${hex(c.form)})`).join(', ')}`,
        );
    }
  }
}

// --- Report ---------------------------------------------------------------------------------
const player = runtime.state.actors.get(PLAYER_REF);
const playerRace = await runtime.actors.raceOf(PLAYER_REF);
console.log(
  `
player: race ${(await runtime.forms.record(playerRace ?? 0))?.editorId ?? '?'}` +
    (runtime.beastForm ? ', beast form' : '') +
    (runtime.firstPersonGeometry ? '' : ', first-person geometry hidden') +
    (player?.eyeTexture === undefined ? '' : `, eyes ${hex(player.eyeTexture)}`),
);
const added = [...(player?.spells ?? [])].filter(([, has]) => has).map(([spell]) => spell);
const addedNames = await Promise.all(
  added.map(async (spell) => (await runtime.forms.record(spell))?.editorId ?? hex(spell)),
);
console.log(`  spells added by scripts: ${addedNames.join(', ') || 'none'}`);
const running = [...runtime.state.quests].filter(([, quest]) => quest.running);
console.log(`\n${String(running.length)} quests running:`);
for (const [formId, quest] of running.sort((a, b) => a[0] - b[0])) {
  const record = await runtime.forms.quest(formId);
  const aliases = [...quest.aliases].length;
  console.log(
    `  ${record?.editorId ?? '?'} [${hex(formId)}] stage ${String(quest.stage)}, ${String(aliases)} aliases${quest.completed ? ', completed' : ''}`,
  );
}
// Quests that should run but do not: those that start with the game, and the opening.
const shouldRun = db.formIdsOfType('QUST').filter((formId) => !runtime.quests.isRunning(formId));
for (const formId of shouldRun) {
  const record = await runtime.forms.quest(formId);
  const startsWithGame = record !== undefined && (record.flags & 0x1) !== 0;
  if (!startsWithGame && record?.editorId !== 'MQ101') continue;
  // Quests that ran and stopped themselves (the update and DLC set-up quests) started.
  if ((runtime.state.quests.get(formId)?.starts ?? 0) > 0) continue;
  const alias = runtime.quests.filler.failures.get(formId);
  const why = alias
    ? `alias ${alias.name || String(alias.id)} (${alias.fill.kind}) stays empty`
    : 'not started';
  console.log(`  not running: ${record.editorId} [${hex(formId)}]: ${why}`);
}
// The scenes playing (src/ai/scene-runtime.ts) and those waiting for their actors.
const playing = [...runtime.scenes.playing()];
console.log(`\n${String(playing.length)} scenes playing:`);
for (const scene of playing) {
  const record = await runtime.sceneHost.scene(scene.scene);
  const done = scene.actions.filter((action) => action.complete).length;
  console.log(
    `  ${record?.editorId ?? hex(scene.scene)} phase ${String(scene.phase)}${scene.paused ? ' (paused)' : ''}, ${String(done)} of ${String(scene.actions.length)} actions done`,
  );
}
for (const scene of runtime.scenes.waiting) {
  console.log(`  waiting: ${(await runtime.sceneHost.scene(scene))?.editorId ?? hex(scene)}`);
}
const threads = runtime.vm.threads;
console.log(`\nthreads: ${String(threads.running)} running, ${String(threads.waiting)} waiting`);
console.log(
  `Papyrus log: ${String(log.length)} lines; messages shown: ${String(runtime.state.messages.length)}`,
);
for (const message of runtime.state.messages.slice(0, 20)) console.log(`  "${message}"`);

const natives = [...warnings].filter(
  ([message]) => message.startsWith('native ') && message.endsWith('is not implemented'),
);
const other = [...warnings].filter(([message]) => !natives.some(([n]) => n === message));
console.log(`\n${String(natives.length)} natives called that are not implemented:`);
for (const [message] of natives.sort())
  console.log(`  ${message.replace(/^native | is not implemented$/g, '')}`);
const top = Number(values.top);
console.log(`\n${String(other.length)} other warnings (first ${String(top)}):`);
for (const [message, count] of other.slice(0, top))
  console.log(`  ${count > 1 ? `${String(count)}× ` : ''}${message}`);
