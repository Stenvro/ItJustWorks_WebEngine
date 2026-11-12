// What the combat AI may cast (src/shell/actor-combat-ai.ts, CombatCasting) through the casting
// of 5.3 (src/shell/actor-casting.ts), as equipment options its combat style weighs against its
// weapons (src/ai/combat-tactics.ts: CSGD's magic, staff and shout score mults): the attack
// spell the casting engine chooses against the target (the one worth most through the
// target's resistances and weaknesses: CastingEngine.spellWorth), each staff it carries with
// charge left (its enchantment's worth against the target), and the shout in its voice (its
// known words' spell, where the combat inventory's score is above nothing and gives it a caster:
// shoutOffered; one with the Script caster while that caster's own check holds). An option's
// damage is that worth; its reach its projectile's range. A cast the combat AI starts here is
// noted for the Script caster's next check where the Script caster cast it (scriptCastBegan).
// Its other casting (healing, potions, summons, wards, buffs) is the combat AI's support
// (CombatCasting.support). Notes: docs/ai.md, "Combat AI".

import type { CombatCasting, CombatSupport } from './actor-combat-ai.ts';
import { MAGIC_REACH, type ActorCasting } from './actor-casting.ts';
import type { EquipOption } from '../ai/combat-tactics.ts';
import { shoutOffered } from '../gameplay/combat/spell-score.ts';
import type { GameSession } from './game-session.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { Delivery, type MagicItemRecord } from '../world/magic-records.ts';
import { CastType } from '../world/spell-records.ts';

/**
 * Whether a shout's word is an option against a target now: its spell scores more than nothing
 * by a caster the fight shouts with (shoutOffered), and a Script caster's own check holds (the
 * AI delay noted with the actor's last Script cast, the spell not on the one it lands on
 * already: scriptCastReady).
 */
async function shouts(
  runtime: ScriptRuntime,
  actor: number,
  wordSpell: MagicItemRecord,
  target: number | undefined,
): Promise<boolean> {
  const score = await runtime.casting.spellScore(actor, wordSpell, 'attack', target);
  if (!shoutOffered(score)) return false;
  return score.caster !== 'script' || runtime.casting.scriptCastReady(actor, wordSpell, target);
}

/** The spell of the last word an actor knows of the shout in its voice, with the shout. */
async function voiceWord(
  runtime: ScriptRuntime,
  actor: number,
): Promise<{ readonly shout: number; readonly spell: MagicItemRecord } | undefined> {
  const voice = (await runtime.equipment.of(actor)).voice;
  const shout = voice === undefined ? undefined : await runtime.casting.shout(voice);
  const words = shout ? runtime.casting.wordsKnown(actor, shout) : 0;
  const word = shout?.words[Math.max(0, Math.min(words, shout.words.length) - 1)];
  const spell = word && words > 0 ? await runtime.magic.item(word.spell) : undefined;
  return shout && spell ? { shout: shout.formId, spell } : undefined;
}

/** What an option casts: its spell, its staff's enchantment or its shout's word's spell. */
async function optionItem(
  runtime: ScriptRuntime,
  actor: number,
  chosen: EquipOption,
): Promise<MagicItemRecord | undefined> {
  if (chosen.kind === 'shout') return (await voiceWord(runtime, actor))?.spell;
  if (chosen.id === undefined) return undefined;
  if (chosen.kind === 'magic') return runtime.magic.item(chosen.id);
  if (chosen.kind !== 'staff') return undefined;
  return (await runtime.casting.staffs(actor)).find((one) => one.staff === chosen.id)?.item;
}

/** What the combat AI's casting asks of the stage's casting (src/shell/actor-casting.ts). */
export type CombatStage = Pick<
  ActorCasting,
  'castAt' | 'shoutAt' | 'drinkPotion' | 'healSelf' | 'summon' | 'reanimate'
>;

/** The NPCs' casting as the combat AI asks for it (of a session: its script runtime). */
export function combatCasting(
  session: Pick<GameSession, 'scriptsReady'>,
  casting: () => CombatStage | undefined,
): CombatCasting {
  return {
    options: async (actor, target) => {
      const runtime = session.scriptsReady;
      if (!runtime) return [];
      const options: EquipOption[] = [];
      const spell = await runtime.casting.chooseSpell(actor, 'attack', target);
      if (spell) options.push(await option(runtime, actor, 'magic', spell.formId, spell, target));
      // Its staffs with charge (their enchantments; hostile ones only: a fight's).
      for (const { staff, item } of await runtime.casting.staffs(actor)) {
        if (await runtime.magic.hostile(item))
          options.push(await option(runtime, actor, 'staff', staff, item, target));
      }
      const voice = await voiceWord(runtime, actor);
      if (voice && (await shouts(runtime, actor, voice.spell, target))) {
        options.push(await option(runtime, actor, 'shout', voice.shout, voice.spell, target));
      }
      return options.filter((one) => one.damage > 0);
    },
    castAt: async (actor, hand, target, chosen) => {
      const stage = casting();
      if (!stage) return false;
      const runtime = session.scriptsReady;
      // What it casts, read before the cast (its voice's shout as it begins).
      const item = runtime ? await optionItem(runtime, actor, chosen) : undefined;
      const began =
        hand === 'voice'
          ? await stage.shoutAt(actor, target)
          : // A staff casts from the hand that holds it (the combat AI took it up).
            await stage.castAt(actor, hand, target, {
              ...(chosen.kind === 'magic' && chosen.id !== undefined && { spell: chosen.id }),
            });
      // The Script caster notes its cast as it starts (its AI delay: scriptCastReady).
      if (began && runtime && item) await runtime.casting.scriptCastBegan(actor, item, target);
      return began;
    },
    support: async (actor, purpose, target) => support(session, casting, actor, purpose, target),
  };
}

/** One of the combat AI's support casts or potions (CombatSupport): whether it began. */
async function support(
  session: Pick<GameSession, 'scriptsReady'>,
  casting: () => CombatStage | undefined,
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
      return stage.healSelf(actor, purpose.holds);
    case 'summon':
      return stage.summon(actor, target);
    case 'reanimate':
      return stage.reanimate(actor, purpose.corpse);
    case 'ward':
    case 'buff': {
      const spell = await runtime.casting.chooseSpell(actor, purpose.kind);
      if (!spell) return false;
      const at = purpose.kind === 'ward' ? target : actor;
      const began = await stage.castAt(actor, 'left', at, { spell: spell.formId });
      // A buff by the Script caster (a spriggan's call): its cast noted as it starts.
      if (began) await runtime.casting.scriptCastBegan(actor, spell, at);
      return began;
    }
  }
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
  const setting = async (name: string, fallback: number): Promise<number> => {
    const value = await runtime.gameSetting(name);
    return typeof value === 'number' ? value : fallback;
  };
  // A Touch spell reaches as far as its caster's race unarmed; others their projectile's range.
  const range =
    item.delivery === Delivery.touch
      ? await runtime.casting.touchReach(actor)
      : projectile && projectile.range > 0
        ? projectile.range
        : MAGIC_REACH;
  return {
    kind,
    id,
    // The combat inventory doubles what reaches past fCombatRangedDistance.
    damage:
      range > (await setting('fCombatRangedDistance', 1024))
        ? damage * (await setting('fCombatInventoryRangedScoreMult', 2))
        : damage,
    range,
    equipped: false,
    concentration: item.castType === CastType.concentration,
  };
}
