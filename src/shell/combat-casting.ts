// What the combat AI may cast (src/shell/actor-combat-ai.ts, CombatCasting) through the casting
// of 5.3 (src/shell/actor-casting.ts), as equipment options its combat style weighs against its
// weapons (src/ai/combat-tactics.ts: CSGD's magic, staff and shout score mults): the attack
// spell the casting engine chooses against the target (the one worth most through the
// target's resistances and weaknesses: CastingEngine.spellWorth), each staff it carries with
// charge left (its enchantment's worth against the target), and the shout in its voice (its
// known words' spell). An option's damage is that worth; its reach its projectile's range.
// Its other casting (healing, potions, summons, wards, buffs) is the combat AI's support
// (CombatCasting.support). Notes: docs/ai.md, "Combat AI".

import type { CombatCasting, CombatSupport } from './actor-combat-ai.ts';
import type { ActorCasting } from './actor-casting.ts';
import type { EquipOption } from '../ai/combat-tactics.ts';
import type { GameSession } from './game-session.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { MagicItemRecord } from '../world/magic-records.ts';
import { WeaponType } from '../world/item-records.ts';

/**
 * The reach of a spell or shout whose projectile names none (Touch spells, projectiles with
 * range 0). TODO(M13): the engine's value is not documented; fCombatMagic* settings do not
 * name one.
 */
const DEFAULT_MAGIC_RANGE = 2048;

/** The NPCs' casting as the combat AI asks for it. */
export function combatCasting(
  session: GameSession,
  casting: () => ActorCasting | undefined,
): CombatCasting {
  return {
    options: async (actor, target) => {
      const runtime = session.scriptsReady;
      if (!runtime) return [];
      const options: EquipOption[] = [];
      const spell = await runtime.casting.chooseSpell(actor, 'attack', target);
      if (spell) options.push(await option(runtime, actor, 'magic', spell.formId, spell, target));
      options.push(...(await staffOptions(runtime, actor, target)));
      const voice = (await runtime.equipment.of(actor)).voice;
      const shout = voice === undefined ? undefined : await runtime.casting.shout(voice);
      const words = shout ? runtime.casting.wordsKnown(actor, shout) : 0;
      const word = shout?.words[Math.max(0, Math.min(words, shout.words.length) - 1)];
      const wordSpell = word ? await runtime.magic.item(word.spell) : undefined;
      if (shout && words > 0 && wordSpell) {
        options.push(await option(runtime, actor, 'shout', shout.formId, wordSpell, target));
      }
      return options.filter((one) => one.damage > 0);
    },
    castAt: async (actor, hand, target, chosen, hold) => {
      const stage = casting();
      if (!stage) return false;
      if (hand === 'voice') return stage.shoutAt(actor, target);
      // A staff casts from the hand that holds it (the combat AI took it up).
      return stage.castAt(actor, hand, target, {
        ...(chosen.kind === 'magic' && chosen.id !== undefined && { spell: chosen.id }),
        ...(hold && { hold }),
      });
    },
    support: async (actor, purpose, target) => support(session, casting, actor, purpose, target),
  };
}

/** One of the combat AI's support casts or potions (CombatSupport): whether it began. */
async function support(
  session: GameSession,
  casting: () => ActorCasting | undefined,
  actor: number,
  purpose: CombatSupport,
  target: number | undefined,
): Promise<boolean> {
  const stage = casting();
  const runtime = session.scriptsReady;
  if (!stage || !runtime) return false;
  switch (purpose.kind) {
    case 'potion':
      return stage.drinkPotion(actor, purpose.value);
    case 'heal':
      return stage.healSelf(actor);
    case 'summon':
      return stage.summon(actor, target);
    case 'ward':
    case 'buff': {
      const spell = await runtime.casting.chooseSpell(actor, purpose.kind);
      return (
        spell !== undefined &&
        stage.castAt(actor, 'left', purpose.kind === 'ward' ? target : actor, {
          spell: spell.formId,
          ...(purpose.hold && { hold: purpose.hold }),
        })
      );
    }
  }
}

/** The staffs an actor carries with charge left, as options (their enchantments' worth). */
async function staffOptions(
  runtime: ScriptRuntime,
  actor: number,
  target: number | undefined,
): Promise<EquipOption[]> {
  const options: EquipOption[] = [];
  for (const [form, count] of await runtime.inventory(actor)) {
    if (count <= 0) continue;
    const item = await runtime.equipment.item(form);
    if (item?.weapon?.weaponType !== WeaponType.staff || item.enchantment === undefined) continue;
    const enchantment = await runtime.magic.item(item.enchantment);
    if (!enchantment) continue;
    const castable = { item: enchantment, via: 'staff' as const, object: form };
    const left = await runtime.casting.charge(actor, castable);
    const cost = (await runtime.casting.cost(actor, castable)).charge;
    if (left < cost) continue;
    options.push(await option(runtime, actor, 'staff', form, enchantment, target));
  }
  return options;
}

/** An equipment option of a spell, a staff's enchantment or a shout's word's spell. */
async function option(
  runtime: ScriptRuntime,
  actor: number,
  kind: 'magic' | 'staff' | 'shout',
  id: number,
  item: MagicItemRecord,
  target: number | undefined,
): Promise<EquipOption> {
  const effect = await runtime.casting.mainEffect(item);
  const projectile =
    effect?.projectile === undefined
      ? undefined
      : await runtime.casting.projectile(effect.projectile);
  const damage = await runtime.casting.spellWorth(actor, item, 'attack', target);
  const range = projectile && projectile.range > 0 ? projectile.range : DEFAULT_MAGIC_RANGE;
  return { kind, id, damage, range, equipped: false };
}
