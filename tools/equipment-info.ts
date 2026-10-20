// What actors hold and wear in the game, as the equip system dresses them from the real data
// (src/scripting/runtime/equipment-engine.ts): an actor's outfit, hands, voice, ammo, the armor
// it wears, its inventory, and its stats (armor rating and the damage it takes off, its
// weapons' damage, what it carries). With --audit, dresses every placed actor and counts what
// they took up.
//
//   node tools/equipment-info.ts HousecarlWhiterun        a unique actor by its base's editor id
//   node tools/equipment-info.ts 000A2C94                 an actor by its reference (hex)
//   node tools/equipment-info.ts --base EncBandit01Melee1HNordM   the first actor placed with it
//   node tools/equipment-info.ts --player                 the player (the Player record's defaults)
//   node tools/equipment-info.ts --player --opening       the player after a new game's opening
//   node tools/equipment-info.ts --audit [--limit N]      every placed actor (or the first N)

import { parseArgs } from 'node:util';
import { RecordFlag } from '../src/formats/esm/record.ts';
import { EquippedItemType, MenuEquipState } from '../src/gameplay/equipment.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { firstSlot } from '../src/world/actors.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string' },
    player: { type: 'boolean', default: false },
    opening: { type: 'boolean', default: false },
    audit: { type: 'boolean', default: false },
    limit: { type: 'string' },
  },
});

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const library = new ScriptLibrary(async (name) => {
  const path = `scripts\\${name}.pex`;
  return vfs.has(path) ? vfs.read(path) : undefined;
});
const warnings = new Map<string, number>();
const runtime = new ScriptRuntime(db, library, {
  warn: (message) => warnings.set(message, (warnings.get(message) ?? 0) + 1),
});
const equipment = runtime.equipment;
const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');
const named = async (formId: number | undefined): Promise<string> => {
  if (formId === undefined) return '-';
  const record = await runtime.forms.record(formId);
  return `${record?.editorId ?? '?'} [${hex(formId)}]`;
};
const ITEM_TYPES = new Map<number, string>(
  Object.entries(EquippedItemType).map(([name, code]): [number, string] => [code, name]),
);
const STATES = new Map<number, string>(
  Object.entries(MenuEquipState).map(([name, code]): [number, string] => [code, name]),
);

/** Every placed actor (ACHR) by its base. */
async function placedActors(): Promise<Map<number, number[]>> {
  const byBase = new Map<number, number[]>();
  await db.scan(
    ['ACHR'],
    (flags) => (flags & RecordFlag.deleted) === 0,
    (record) => {
      const base = record.formIdField('NAME');
      if (base === undefined) return;
      const refs = byBase.get(base) ?? [];
      refs.push(record.formId);
      byBase.set(base, refs);
    },
  );
  return byBase;
}

async function byEditorId(editorId: string, types: readonly string[]): Promise<number | undefined> {
  for (const type of types) {
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      if (record?.editorId?.toLowerCase() === editorId.toLowerCase()) return formId;
    }
  }
  return undefined;
}

async function show(actor: number): Promise<void> {
  const info = await runtime.actors.info(actor);
  if (!info) {
    console.log(`${hex(actor)} is not an actor`);
    return;
  }
  const state = await equipment.of(actor);
  const race = await runtime.actors.raceOf(actor);
  console.log(
    `${await named(actor)}: base ${await named(info.base)}, leveled ${await named(info.leveled)}, ` +
      `${await named(race)}, level ${String(await runtime.actors.level(actor))}`,
  );
  console.log(`  outfit ${await named(state.outfit)}`);
  for (const hand of ['right', 'left'] as const) {
    const held = state[hand];
    const type = ITEM_TYPES.get(await equipment.itemType(actor, hand)) ?? '?';
    let line = `  ${hand} hand: ${await named(held)} (${type})`;
    if (held !== undefined && (await equipment.weapon(actor, hand)) !== undefined) {
      const stats = await equipment.weaponStats(actor, hand);
      line +=
        ` damage ${String(stats.damage)} (base ${String(stats.baseDamage)}), ` +
        `${stats.model ?? 'no model'}, sheathed ${stats.nodes.sheathed ?? '-'}, drawn ${stats.nodes.drawn}`;
      if (stats.ammo !== undefined) line += `, shot ${String(stats.shotDamage)}`;
    }
    console.log(line);
  }
  console.log(`  voice ${await named(state.voice)}, ammo ${await named(state.ammo)}`);
  for (const form of state.worn) {
    const item = await equipment.item(form);
    const slots = item?.armor?.slots ?? 0;
    const list: number[] = [];
    for (let slot = 30; slot < 62; slot++) if ((slots & (2 ** (slot - 30))) !== 0) list.push(slot);
    console.log(
      `  wears ${await named(form)} slots ${list.join(',')} (first ${String(firstSlot(slots))}), ` +
        `rating ${String(await equipment.pieceRating(actor, form))} (base ${String(item?.armor?.rating ?? 0)})`,
    );
  }
  const armor = await equipment.armorRating(actor);
  console.log(
    `  armor rating ${armor.rating.toFixed(1)}, ${String(armor.pieces)} pieces: takes off ` +
      `${(armor.reduction * 100).toFixed(1)}% of physical damage`,
  );
  const [carried, limit] = await Promise.all([
    equipment.carried(actor),
    equipment.carryWeight(actor),
  ]);
  console.log(
    `  carries ${carried.toFixed(1)} of ${limit.toFixed(0)}` +
      `${(await equipment.overEncumbered(actor)) ? ' (over-encumbered)' : ''}; shown damage ` +
      String(await equipment.shownDamage(actor)),
  );
  const items = await runtime.inventory(actor);
  for (const [form, count] of items) {
    if (count <= 0) continue;
    const item = await equipment.item(form);
    const equipped = STATES.get(await equipment.menuState(actor, form)) ?? '?';
    const outfit = state.outfitItems.has(form) ? ' (outfit)' : '';
    console.log(
      `    ${String(count).padStart(4)} × ${await named(form)} ${item?.type ?? ''}${outfit}` +
        (equipped === 'none' ? '' : `  [${equipped}]`),
    );
  }
}

async function audit(limit: number | undefined): Promise<void> {
  const actors = [...(await placedActors()).values()].flat().slice(0, limit);
  const counts = new Map<string, number>();
  const count = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const failed: string[] = [];
  const examples: string[] = [];
  const started = performance.now();
  for (const actor of actors) {
    try {
      if (!(await runtime.actors.isActor(actor))) {
        count('not resolved');
        continue;
      }
      const state = await equipment.of(actor);
      count('actors');
      if (state.outfit !== undefined) count('with an outfit');
      if (state.right !== undefined)
        count(`right: ${ITEM_TYPES.get(await equipment.itemType(actor, 'right')) ?? '?'}`);
      if (state.left !== undefined)
        count(`left: ${ITEM_TYPES.get(await equipment.itemType(actor, 'left')) ?? '?'}`);
      if (state.ammo !== undefined) count('with ammunition');
      const outfitWorn = state.worn.filter((form) => state.outfitItems.has(form)).length;
      if (state.worn.length > outfitWorn) {
        count('wearing armor it carried besides its outfit');
        if (examples.length < 8) {
          const extra = state.worn.filter((form) => !state.outfitItems.has(form));
          examples.push(
            `${await named(actor)}: ${(await Promise.all(extra.map(named))).join(', ')}`,
          );
        }
      }
      if (state.worn.length === 0) count('wearing nothing (its skin)');
    } catch (error) {
      failed.push(`${hex(actor)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(
    `${String(actors.length)} placed actors dressed in ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
  for (const [key, value] of [...counts].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(value).padStart(6)}  ${key}`);
  console.log('wearing armor carried besides the outfit, e.g.:');
  for (const line of examples) console.log(`  ${line}`);
  console.log(`${String(failed.length)} failed`);
  for (const line of failed.slice(0, 20)) console.log(`  ${line}`);
}

if (values.audit) {
  await audit(values.limit === undefined ? undefined : Number(values.limit));
} else if (values.player) {
  if (values.opening) {
    console.log(
      'starting a new game, then 30 s of play (its opening strips and dresses the player)...',
    );
    await runtime.newGame();
    // TimeScale 20: game days pass with real seconds.
    for (let t = 0; t < 30; t += 0.1) {
      runtime.update(0.1, (0.1 * 20) / 86400);
      await runtime.vm.idle();
    }
  }
  await show(PLAYER_REF);
} else if (values.base !== undefined) {
  const base = await byEditorId(values.base, ['NPC_', 'LVLN']);
  const reference = base === undefined ? undefined : (await placedActors()).get(base)?.[0];
  if (reference === undefined) console.log(`no actor placed with base ${values.base}`);
  else await show(reference);
} else {
  const query = positionals[0] ?? '';
  let reference = /^[0-9a-f]{1,8}$/i.test(query) ? parseInt(query, 16) : undefined;
  if (reference === undefined) {
    const base = await byEditorId(query, ['NPC_']);
    reference = base === undefined ? undefined : await runtime.forms.uniqueReference(base);
  }
  if (reference === undefined) console.log(`no unique actor ${query}`);
  else await show(reference);
}
if (warnings.size > 0) {
  console.log(`${String(warnings.size)} warnings:`);
  for (const [message, times] of [...warnings].slice(0, 20))
    console.log(`  ${String(times).padStart(5)}× ${message}`);
}
await db.close();
await vfs.close();
