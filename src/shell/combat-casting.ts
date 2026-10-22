// What the combat AI may cast (src/shell/actor-combat-ai.ts, CombatCasting) through the casting
// of 5.3 (src/shell/actor-casting.ts): the attack spell the casting engine chooses for it (the
// costliest hostile one sent at a target that it has the magicka for) and the shout in its
// voice, as equipment options the combat style weighs against its weapons
// (src/ai/combat-tactics.ts). An option's damage is the sum of its effects' magnitudes; its
// reach is its projectile's range. Notes: docs/ai.md, "Combat AI".

import type { CombatCasting } from './actor-combat-ai.ts';
import type { ActorCasting } from './actor-casting.ts';
import type { EquipOption } from '../ai/combat-tactics.ts';
import type { GameSession } from './game-session.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { MagicItemRecord } from '../world/magic-records.ts';

/**
 * The reach of a spell or shout whose projectile names none (Touch spells, projectiles with
 * range 0). TODO(M13): the engine's value is not documented; fCombatMagic* settings do not
 * name one.
 */
const DEFAULT_MAGIC_RANGE = 2048;

/** Health (an actor value): healed by a spell before a potion. */
const HEALTH = 24;

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
      if (spell) options.push(await option(runtime, 'magic', spell.formId, spell));
      // Its staffs with charge (their enchantment's spell; hostile ones only: a fight's).
      for (const { staff, item } of await runtime.casting.staffs(actor)) {
        if (await runtime.magic.hostile(item))
          options.push(await option(runtime, 'staff', staff, item));
      }
      const voice = (await runtime.equipment.of(actor)).voice;
      const shout = voice === undefined ? undefined : await runtime.casting.shout(voice);
      const words = shout ? runtime.casting.wordsKnown(actor, shout) : 0;
      const word = shout?.words[Math.max(0, Math.min(words, shout.words.length) - 1)];
      const wordSpell = word ? await runtime.magic.item(word.spell) : undefined;
      if (shout && words > 0 && wordSpell) {
        options.push(await option(runtime, 'shout', shout.formId, wordSpell));
      }
      return options;
    },
    // Health: its healing spell, else a potion; Magicka: a potion.
    restore: async (actor, value) => {
      const stage = casting();
      if (!stage) return false;
      if (value === HEALTH && (await stage.healSelf(actor))) return true;
      return stage.drinkPotion(actor, value);
    },
    summon: async (actor, target) => (await casting()?.summon(actor, target)) === true,
    castAt: async (actor, hand, target, chosen) => {
      const stage = casting();
      if (!stage) return false;
      if (hand === 'voice') return stage.shoutAt(actor, target);
      // A staff is taken in the hand first (the equip system), then cast from it.
      if (chosen.kind === 'staff') {
        const runtime = session.scriptsReady;
        if (!runtime || chosen.id === undefined) return false;
        if ((await runtime.equipment.weapon(actor, 'right')) !== chosen.id)
          await runtime.equipment.equip(actor, chosen.id, { hand: 'right' });
        return stage.castAt(actor, 'right', target);
      }
      return stage.castAt(actor, hand, target, {
        ...(chosen.id !== undefined && { spell: chosen.id }),
      });
    },
  };
}

/** An equipment option of a spell (a staff's enchantment, a shout's word's spell). */
async function option(
  runtime: ScriptRuntime,
  kind: 'magic' | 'staff' | 'shout',
  id: number,
  item: MagicItemRecord,
): Promise<EquipOption> {
  const effect = await runtime.casting.mainEffect(item);
  const projectile =
    effect?.projectile === undefined
      ? undefined
      : await runtime.casting.projectile(effect.projectile);
  const damage = item.effects.reduce((sum, entry) => sum + Math.max(0, entry.magnitude), 0);
  const range = projectile && projectile.range > 0 ? projectile.range : DEFAULT_MAGIC_RANGE;
  return { kind, id, damage, range, equipped: false };
}
