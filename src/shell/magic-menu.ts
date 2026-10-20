// The player's magic (interface\magicmenu.swf), as a model of the item menus (item-menu.ts):
// the spells by their school, the powers, the shouts with their words (equipped to a hand or
// the voice by the equip system, their entries showing where), and the active effects (the
// magic system's: ICT_ACTIVE_EFFECT cards with their time left). Its categories (the settings
// sFavorites, sAllItems, sAlteration, ...) are Favorites first (its bit is the favorite
// button's), then All and the
// schools, Shouts, Powers and Active Effects, whose entries show no buttons (the menu's
// hideButtonFlag). A spell's card: its level (its effects' minimum skill: sNoviceDisplayName
// .. sMasterDisplayName), its effects, its cost (the casting engine's: the base cost × 1 −
// (skill / 400)^0.65, UESP "Magic Overview"; TODO(M11): perks and enchantments), a per-second
// cost for concentration spells (castTime 0). A shout's card offers Unlock (R) while a learned
// word is locked: a dragon soul spent on it. Notes: docs/ui.md ("The item menus").

import { CardType, EquipState } from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { ActiveEffectState } from '../scripting/runtime/game-state.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import {
  EffectFlag,
  effectText,
  parseMagicEffect,
  type MagicEffectRecord,
} from '../world/magic-effects.ts';
import {
  CastType,
  parseShout,
  parseSpell,
  parseWord,
  SpellType,
  type ShoutRecord,
  type SpellRecord,
} from '../world/spell-records.ts';
import type { GameSession } from './game-session.ts';
import { effectsText, playerMeters } from './inventory-menu.ts';
import { slotHand, type ItemEntry, type ItemMenuModel } from './item-menu.ts';
import type { Terminal } from './terminal.ts';

/** The magic menu's category bits (the movie only tests them). */
const MagicCategory = {
  favorites: 0x1,
  alteration: 0x2,
  illusion: 0x4,
  destruction: 0x8,
  conjuration: 0x10,
  restoration: 0x20,
  shouts: 0x40,
  powers: 0x80,
  activeEffects: 0x100,
} as const;
const ALL_MAGIC = 0xff;

const CATEGORIES: readonly [string, number, boolean][] = [
  ['sFavorites', MagicCategory.favorites, true],
  ['sAllItems', ALL_MAGIC, true],
  ['sAlteration', MagicCategory.alteration, false],
  ['sIllusion', MagicCategory.illusion, false],
  ['sDestruction', MagicCategory.destruction, false],
  ['sConjuration', MagicCategory.conjuration, false],
  ['sRestoration', MagicCategory.restoration, false],
  ['sShouts', MagicCategory.shouts, false],
  ['sPowers', MagicCategory.powers, false],
  ['sActiveEffects', MagicCategory.activeEffects, false],
];

/** The schools' skills (actor value indices) and their bits. */
const SCHOOLS: ReadonlyMap<number, number> = new Map([
  [18, MagicCategory.alteration],
  [19, MagicCategory.conjuration],
  [20, MagicCategory.destruction],
  [21, MagicCategory.illusion],
  [22, MagicCategory.restoration],
]);

/** The spell levels by minimum skill. */
const LEVELS: readonly [number, string][] = [
  [100, 'sMasterDisplayName'],
  [75, 'sExpertDisplayName'],
  [50, 'sJourneymanDisplayName'],
  [25, 'sApprenticeDisplayName'],
  [0, 'sNoviceDisplayName'],
];

export function magicModel(session: GameSession, terminal: Terminal): ItemMenuModel {
  const runtime = (): ScriptRuntime => {
    const ready = session.scriptsReady;
    if (!ready) throw new Error('the game is not running');
    return ready;
  };
  const effects = new Map<number, MagicEffectRecord | undefined>();
  const effect = async (formId: number): Promise<MagicEffectRecord | undefined> => {
    if (!effects.has(formId)) {
      const record = await runtime().forms.record(formId);
      effects.set(formId, record?.type === 'MGEF' ? parseMagicEffect(record) : undefined);
    }
    return effects.get(formId);
  };
  return {
    movie: 'magicmenu.swf',
    side: 'magic',
    depth: 6,
    menuProperties: { hideButtonFlag: MagicCategory.activeEffects },
    categories: async () => {
      const settings = await session.settings();
      return CATEGORIES.flatMap(([setting, flag, shown]) => [
        settings.string(setting) ?? setting,
        flag,
        shown,
      ]);
    },
    view: async () => {
      const game = runtime();
      const settings = await session.settings();
      const entries: ItemEntry[] = [];
      const cards: Record<string, unknown>[] = [];
      for (const formId of await game.actors.spells(PLAYER_REF)) {
        const record = await game.forms.record(formId);
        const favorite = game.state.favorites.has(formId);
        const favoriteBit = favorite ? MagicCategory.favorites : 0;
        if (record?.type === 'SHOU') {
          const shout = parseShout(record);
          entries.push({
            text: shout.name,
            formId,
            filterFlag: MagicCategory.shouts | favoriteBit,
            favorite,
            enabled: true,
            equipState: await game.equipment.menuState(PLAYER_REF, formId),
          });
          cards.push(await shoutCard(game, shout));
          continue;
        }
        if (record?.type !== 'SPEL') continue;
        const spell = parseSpell(record);
        const power =
          spell.spellType === SpellType.power || spell.spellType === SpellType.lesserPower;
        if (spell.spellType !== SpellType.spell && !power) continue;
        const main = await mainEffect(spell, effect);
        const school = main ? (SCHOOLS.get(main.skill) ?? 0) : 0;
        entries.push({
          text: spell.name,
          formId,
          filterFlag: (power ? MagicCategory.powers : school) | favoriteBit,
          favorite,
          enabled: true,
          equipState: await game.equipment.menuState(PLAYER_REF, formId),
        });
        const text = await effectsText(game, spell.effects);
        if (power) {
          cards.push({
            type: CardType.spellDefault,
            name: spell.name,
            effects: text,
            spellCost: 0,
          });
          continue;
        }
        const level = LEVELS.find(([minimum]) => (main?.minimumSkill ?? 0) >= minimum)?.[1];
        cards.push({
          type: CardType.spell,
          name: spell.name,
          effects: text,
          castLevel: level ? (settings.string(level) ?? '') : '',
          castTime: spell.castType === CastType.concentration ? 0 : spell.chargeTime,
          // The casting engine's cost by the school's skill (casting.ts magickaCost).
          spellCost: await game.casting.menuCost(formId),
        });
      }
      for (const active of await activeEffects(game)) {
        entries.push({
          text: active.name,
          formId: active.formId,
          filterFlag: MagicCategory.activeEffects,
          favorite: false,
          enabled: true,
          equipState: EquipState.none,
          negativeEffect: active.negative,
        });
        cards.push({
          type: CardType.activeEffect,
          name: active.name,
          effects: active.text,
          timeRemaining: active.timeRemaining,
          negativeEffect: active.negative,
        });
      }
      return { entries, cards, player: [await playerMeters(game)] };
    },
    // A spell to the hand asked for (a two-handed spell to both), a power or a shout to the
    // voice (the equip system); chosen again where it is, it comes off.
    select: async ({ formId }, slot) => {
      if (!(await runtime().equipment.toggle(PLAYER_REF, formId, slotHand(slot))))
        terminal.log('ui', `${formId.toString(16)} cannot be equipped`, 'info');
    },
    // Unlock (R): a dragon soul on the shout's first learned and locked word, once the player
    // confirms (sConfirmSpendSoul); without one, sFailSpendSoul.
    unlock: async ({ formId }) => {
      const game = runtime();
      if ((await game.forms.record(formId))?.type !== 'SHOU') return false;
      const settings = await session.settings();
      const menus = session.hud.menus;
      if ((await game.actors.value(PLAYER_REF, ActorValue.dragonSouls)).current < 1) {
        const fail = settings.string('sFailSpendSoul');
        if (fail && (await game.casting.unlockWord(formId, { dryRun: true })) === 'noSoul')
          session.hud.notification(fail);
        return false;
      }
      if ((await game.casting.unlockWord(formId, { dryRun: true })) !== 'unlocked') return false;
      if (menus) {
        const chosen = await menus.messageBox(settings.string('sConfirmSpendSoul') ?? '', [
          settings.string('sYes') ?? 'Yes',
          settings.string('sNo') ?? 'No',
        ]);
        if (chosen !== 0) return false;
      }
      return (await game.casting.unlockWord(formId)) === 'unlocked';
    },
    favorite: ({ formId }) => {
      const favorites = runtime().state.favorites;
      if (favorites.has(formId)) favorites.delete(formId);
      else favorites.add(formId);
    },
  };
}

/** An entry of the Active Effects list. */
interface ActiveEntry {
  /** What it shows in 3D: its magic item (else its first effect). */
  readonly formId: number;
  readonly name: string;
  /** Its effects' descriptions, with their values as they act. */
  readonly text: string;
  /** Seconds left (0: lasting, no time shown). */
  readonly timeRemaining: number;
  /** Shown in red (ICT_ACTIVE_EFFECT's negativeEffect): a detrimental or hostile effect. */
  readonly negative: boolean;
}

/**
 * The player's active effects as the Active Effects list shows them: one entry per magic item
 * (and worn object), named after the object an enchantment is on, else the item (a disease's
 * name, a potion's), else its effect; its visible effects' descriptions with the magnitudes,
 * durations and areas they act with (effectText); the time the longest has left. Inactive
 * effects (their conditions fail) and those hidden from the interface are not listed.
 * TODO(M13): the grouping by magic item is inferred from the card (one description, one time).
 */
export async function activeEffects(game: ScriptRuntime): Promise<ActiveEntry[]> {
  const groups = new Map<string, ActiveEffectState[]>();
  for (const [, entry] of game.magic.effectsOn(PLAYER_REF)) {
    if (entry.inactive) continue;
    const effect = await game.magic.effect(entry.effect);
    if (!effect || (effect.flags & EffectFlag.hideInUi) !== 0) continue;
    const key = `${String(entry.item ?? entry.effect)}:${String(entry.source)}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const shown: ActiveEntry[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const texts: string[] = [];
    let negative = false;
    let timeRemaining = 0;
    let effectName = '';
    for (const entry of group) {
      const effect = await game.magic.effect(entry.effect);
      if (!effect) continue;
      effectName ||= effect.name;
      if (effect.description !== '')
        texts.push(effectText(effect, entry.magnitude, entry.duration, entry.area ?? 0));
      negative ||= (effect.flags & (EffectFlag.detrimental | EffectFlag.hostile)) !== 0;
      if (!entry.lasting) timeRemaining = Math.max(timeRemaining, entry.duration - entry.elapsed);
    }
    const named = async (formId: number | undefined): Promise<string> =>
      formId === undefined ? '' : ((await game.forms.record(formId))?.text('FULL') ?? '');
    const name = (await named(first.source)) || (await named(first.item)) || effectName;
    if (name === '') continue;
    shown.push({
      formId: first.item ?? first.effect,
      name,
      text: texts.join(' '),
      timeRemaining: Math.max(0, timeRemaining),
      negative,
    });
  }
  return shown;
}

/** The effect that decides a spell's school and level: its costliest (its first with a skill). */
export async function mainEffect(
  spell: SpellRecord,
  effect: (formId: number) => Promise<MagicEffectRecord | undefined>,
): Promise<MagicEffectRecord | undefined> {
  let best: MagicEffectRecord | undefined;
  let bestCost = -1;
  for (const entry of spell.effects) {
    const record = await effect(entry.effect);
    if (!record) continue;
    const cost = record.baseCost * Math.max(1, entry.magnitude);
    if (cost > bestCost) {
      best = record;
      bestCost = cost;
    }
  }
  return best;
}

/** A shout's card: its words in the dragon tongue and translated, which are unlocked. */
async function shoutCard(
  game: ScriptRuntime,
  shout: ShoutRecord,
): Promise<Record<string, unknown>> {
  const card: Record<string, unknown> = {
    type: CardType.shout,
    name: shout.name,
    effects: shout.description,
  };
  for (const [index, entry] of shout.words.entries()) {
    const record = await game.forms.record(entry.word);
    const word = record?.type === 'WOOP' ? parseWord(record) : undefined;
    const learned = game.wordsLearned.has(entry.word);
    card[`word${String(index)}`] = learned ? (word?.translation ?? '') : '';
    card[`dragonWord${String(index)}`] = learned ? (word?.word ?? '') : '';
    card[`unlocked${String(index)}`] = game.wordsLearned.get(entry.word) === true;
  }
  const unlocked = shout.words.filter((entry) => game.wordsLearned.get(entry.word) === true);
  card.spellCost = String(Math.round(unlocked[unlocked.length - 1]?.recovery ?? 0));
  // The bottom bar's Unlock while a learned word is locked (casting-engine.ts unlockWord).
  card.showUnlocked = (await game.casting.unlockWord(shout.formId, { dryRun: true })) !== 'none';
  return card;
}
