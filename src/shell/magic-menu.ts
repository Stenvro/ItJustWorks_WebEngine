// The player's magic (interface\magicmenu.swf), as a model of the item menus (item-menu.ts):
// the spells by their school, the powers, the shouts with their words, and (TODO(M11): the
// magic system) the active effects. Its categories (the settings sFavorites, sAllItems,
// sAlteration, ...) are Favorites first (its bit is the favorite button's), then All and the
// schools, Shouts, Powers and Active Effects, whose entries show no buttons (the menu's
// hideButtonFlag). A spell's card: its level (its effects' minimum skill: sNoviceDisplayName
// .. sMasterDisplayName), its effects, its cost (spellBaseCost × 1 − (skill / 400)^0.65, UESP
// "Magic Overview"; TODO(M11): perks and enchantments), a per-second cost for concentration
// spells (castTime 0). Notes: docs/ui.md ("The item menus").

import { CardType, EquipState } from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { parseMagicEffect, type MagicEffectRecord } from '../world/magic-effects.ts';
import {
  CastType,
  parseShout,
  parseSpell,
  parseWord,
  spellBaseCost,
  SpellType,
  type ShoutRecord,
  type SpellRecord,
} from '../world/spell-records.ts';
import type { GameSession } from './game-session.ts';
import { effectsText, playerMeters } from './inventory-menu.ts';
import type { ItemEntry, ItemMenuModel } from './item-menu.ts';
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
            equipState: EquipState.none,
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
          equipState: EquipState.none,
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
        const skill = main ? (await game.actors.value(PLAYER_REF, main.skill)).current : 0;
        const base = spellBaseCost(spell, (id) => effects.get(id)?.baseCost ?? 0);
        const level = LEVELS.find(([minimum]) => (main?.minimumSkill ?? 0) >= minimum)?.[1];
        cards.push({
          type: CardType.spell,
          name: spell.name,
          effects: text,
          castLevel: level ? (settings.string(level) ?? '') : '',
          castTime: spell.castType === CastType.concentration ? 0 : spell.chargeTime,
          spellCost: Math.round(base * (1 - (Math.max(0, skill) / 400) ** 0.65)),
        });
      }
      return { entries, cards, player: [await playerMeters(game)] };
    },
    select: ({ formId }) => {
      // TODO(M11): equipping spells to a hand and shouts to the voice (the magic system).
      terminal.log('ui', `equipping ${formId.toString(16)} is not built yet`, 'warn');
      return Promise.resolve();
    },
    favorite: ({ formId }) => {
      const favorites = runtime().state.favorites;
      if (favorites.has(formId)) favorites.delete(formId);
      else favorites.add(formId);
    },
  };
}

/** The effect that decides a spell's school and level: its costliest (its first with a skill). */
async function mainEffect(
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
  return card;
}
