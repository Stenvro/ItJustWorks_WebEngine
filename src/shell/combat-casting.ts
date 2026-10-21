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

/** The NPCs' casting as the combat AI asks for it. */
export function combatCasting(
  session: GameSession,
  casting: () => ActorCasting | undefined,
): CombatCasting {
  return {
    options: async (actor) => {
      const runtime = session.scriptsReady;
      if (!runtime) return [];
      const options: EquipOption[] = [];
      const spell = await runtime.casting.chooseSpell(actor, 'attack');
      if (spell) options.push(await option(runtime, 'magic', spell.formId, spell));
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
    castAt: async (actor, hand, target, chosen) => {
      const stage = casting();
      if (!stage) return false;
      if (hand === 'voice') return stage.shoutAt(actor, target);
      return stage.castAt(actor, hand, target, {
        ...(chosen.id !== undefined && { spell: chosen.id }),
      });
    },
  };
}

/** An equipment option of a spell (or a shout's word's spell). */
async function option(
  runtime: ScriptRuntime,
  kind: 'magic' | 'shout',
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
