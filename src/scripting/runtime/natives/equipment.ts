// Natives of the equip system (signatures: the game's Actor.pex and ActorBase.pex; the SKSE
// additions EquipItemEx, GetEquippedObject and GetWornForm for scripts that call them): what an
// actor equips and takes off (items, spells, shouts, its outfit), what it holds in each hand,
// wears in each biped slot and carries. The rules and stats: src/scripting/runtime/equipment-
// engine.ts. Platform-independent. Notes: docs/gameplay.md ("Equipment").

import type { Hand } from '../../../gameplay/equipment.ts';
import type { NativeCall } from '../../papyrus-vm.ts';
import type { Value } from '../../values.ts';
import type { ScriptRuntime } from '../runtime.ts';
import { bool, formOf, int, object, type Register } from './args.ts';

/** Papyrus' hands: 0 (or false) the left, 1 (or true) the right. */
const handOf = (value: number): Hand => (value === 0 ? 'left' : 'right');

export function registerEquipment(n: Register, runtime: ScriptRuntime): void {
  const { state, equipment } = runtime;
  const self = (call: NativeCall): number | undefined => runtime.reference(call.self);
  const act = (name: string, run: (actor: number, call: NativeCall) => Promise<unknown>): void => {
    n(`actor.${name}`, async (call) => {
      const actor = self(call);
      if (actor !== undefined) await run(actor, call);
      return null;
    });
  };
  const ask = <T extends Value>(
    name: string,
    fallback: T,
    run: (actor: number, call: NativeCall) => T | Promise<T>,
  ): void => {
    n(`actor.${name}`, async (call) => {
      const actor = self(call);
      return actor === undefined ? fallback : run(actor, call);
    });
  };
  /** A form as its script type (Weapon, Armor, Spell, ...: the record's native type). */
  const typed = async (formId: number | undefined, fallback: string): Promise<Value> => {
    if (formId === undefined) return null;
    const type = await runtime.forms.scriptType(runtime.formHandle(formId));
    return object(formId, type ?? fallback);
  };

  // --- Items ------------------------------------------------------------------------------------
  // EquipItem(akItem, abPreventRemoval, abSilent): one it lacks is given to it first.
  act('equipitem', async (actor, call) => {
    const item = formOf(call.args[0]);
    if (item === undefined) return;
    const record = await runtime.forms.record(item);
    if (record?.type === 'SPEL') {
      await equipment.equipSpell(actor, item, 1);
      return;
    }
    if (record?.type === 'SHOU') {
      await equipment.equipShout(actor, item);
      return;
    }
    await equipment.equip(actor, item, {
      preventRemoval: bool(call.args[1]),
      silent: bool(call.args[2]),
    });
  });
  // SKSE: EquipItemEx(akItem, aiEquipSlot (0 default, 1 right hand, 2 left hand), abPreventUnequip, abEquipSound).
  act('equipitemex', async (actor, call) => {
    const item = formOf(call.args[0]);
    if (item === undefined) return;
    const slot = int(call.args[1]);
    await equipment.equip(actor, item, {
      ...(slot === 1 ? { hand: 'right' as const } : slot === 2 ? { hand: 'left' as const } : {}),
      preventRemoval: bool(call.args[2]),
      silent: true,
    });
  });
  // UnequipItem(akItem, abPreventEquip, abSilent).
  act('unequipitem', async (actor, call) => {
    const item = formOf(call.args[0]);
    if (item !== undefined)
      await equipment.unequip(actor, item, { preventEquip: bool(call.args[1]) });
  });
  act('unequipall', (actor) => equipment.unequipAll(actor));
  // UnequipItemSlot(aiSlot): the biped slot (30..61).
  act('unequipitemslot', (actor, call) => equipment.unequipSlot(actor, int(call.args[0])));
  // IsEquipped(akItem): a form list is equipped when any of its forms is.
  ask('isequipped', false, async (actor, call) => {
    const item = formOf(call.args[0]);
    return item !== undefined && equipment.isEquipped(actor, item);
  });
  // GetEquippedWeapon(abLeftHand).
  ask('getequippedweapon', null, async (actor, call) =>
    object(await equipment.weapon(actor, bool(call.args[0]) ? 'left' : 'right'), 'weapon'),
  );
  ask('getequippedshield', null, async (actor) => object(await equipment.shield(actor), 'armor'));
  // GetEquippedArmorInSlot(aiSlot): the biped slot (30..61).
  ask('getequippedarmorinslot', null, async (actor, call) =>
    object(await equipment.armorInSlot(actor, int(call.args[0])), 'armor'),
  );
  // SKSE: GetWornForm(slotMask).
  ask('getwornform', null, async (actor, call) =>
    typed(await equipment.wornInMask(actor, int(call.args[0]) >>> 0), 'armor'),
  );
  // GetEquippedItemType(aiHand): 0 the left hand, 1 the right.
  ask('getequippeditemtype', 0, (actor, call) =>
    equipment.itemType(actor, handOf(int(call.args[0]))),
  );
  // SKSE: GetEquippedObject(aiLocation): 0 the left hand, 1 the right, 2 the voice.
  ask('getequippedobject', null, async (actor, call) => {
    const location = int(call.args[0]);
    const held =
      location === 2
        ? (await equipment.of(actor)).voice
        : await equipment.inHand(actor, handOf(location));
    return typed(held, 'form');
  });
  // WornHasKeyword(akKeyword): any armor it wears has it.
  ask('wornhaskeyword', false, async (actor, call) => {
    const keyword = formOf(call.args[0]);
    if (keyword === undefined) return false;
    for (const item of await equipment.worn(actor)) {
      if (await runtime.hasKeyword(item, keyword)) return true;
    }
    return false;
  });
  ask('isoverencumbered', false, (actor) => equipment.overEncumbered(actor));

  // --- Spells and shouts ----------------------------------------------------------------------
  // EquipSpell(akSpell, aiSource): 0 the left hand, 1 the right, 2 the voice (a power).
  act('equipspell', async (actor, call) => {
    const spell = formOf(call.args[0]);
    if (spell !== undefined) await equipment.equipSpell(actor, spell, int(call.args[1]));
  });
  act('unequipspell', async (actor, call) => {
    const spell = formOf(call.args[0]);
    if (spell !== undefined) await equipment.unequipSpell(actor, spell, int(call.args[1]));
  });
  // GetEquippedSpell(aiSource): 0 the left hand, 1 the right, 2 the voice; 3 (instant: none).
  ask('getequippedspell', null, async (actor, call) =>
    object(await equipment.spell(actor, int(call.args[0])), 'spell'),
  );
  act('equipshout', async (actor, call) => {
    const shout = formOf(call.args[0]);
    if (shout !== undefined) await equipment.equipShout(actor, shout);
  });
  act('unequipshout', async (actor, call) => {
    const shout = formOf(call.args[0]);
    if (shout !== undefined && (await equipment.shout(actor)) === shout)
      await equipment.unequip(actor, shout);
  });
  ask('getequippedshout', null, async (actor) => object(await equipment.shout(actor), 'shout'));

  // --- Outfits ----------------------------------------------------------------------------------
  // SetOutfit(akOutfit, abSleepOutfit): its own; it changes into it (the sleep outfit while it
  // sleeps).
  act('setoutfit', async (actor, call) => {
    const outfit = formOf(call.args[0]);
    if (bool(call.args[1])) state.actor(actor).sleepOutfit = outfit;
    else state.actor(actor).outfit = outfit;
    await equipment.outfitChanged(actor);
  });
  n('actorbase.setoutfit', async (call) => {
    const base = call.self && call.self.alias < 0 ? call.self.formId : undefined;
    if (base === undefined) return null;
    const outfit = formOf(call.args[0]);
    if (bool(call.args[1])) state.actorBase(base).sleepOutfit = outfit;
    else state.actorBase(base).outfit = outfit;
    await equipment.baseOutfitChanged(base);
    return null;
  });
}
