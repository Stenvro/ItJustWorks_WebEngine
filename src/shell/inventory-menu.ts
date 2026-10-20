// The player's inventory (interface\inventorymenu.swf), as a model of the item menus
// (item-menu.ts): the player's items with their counts, what is equipped (in which hand) and
// what is a favorite, each item's card (its type's fields: damage and armor with the player's
// skills, effects, a book's description, a soul gem's soul), and the player's carried weight,
// gold, armor rating, damage and meters. Selecting equips or takes off (the equip system:
// armor, weapons and spells to the hand asked for, ammunition, torches), uses potions, food and
// ingredients (their effects: the magic system), puts poisons on the weapon, reads books
// (`read`: the book menu, or a spell tome's spell learned); dropping removes the items.
// Notes: docs/ui.md ("The item menus"), docs/gameplay.md ("Equipment", "Magic effects").

import {
  armorSkill,
  CardType,
  EquipState,
  INVENTORY_CATEGORIES,
  ItemCategory,
  itemCardType,
  itemCategory,
  SOUL_LEVEL_SETTINGS,
} from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { GameSettings } from '../world/game-settings.ts';
import {
  parseEffects,
  parseItem,
  type ItemEffect,
  type ItemRecord,
} from '../world/item-records.ts';
import { effectText, EffectFlag, parseMagicEffect } from '../world/magic-effects.ts';
import type { GameSession } from './game-session.ts';
import { slotHand, type ItemEntry, type ItemMenuModel, type ItemMenuView } from './item-menu.ts';
import type { Terminal } from './terminal.ts';

/** Gold (Gold001): its count is the player's gold. */
export const GOLD = 0xf;

/** An item row of the menu. */
export interface Row {
  readonly formId: number;
  readonly item: ItemRecord;
  readonly count: number;
  /** Equipped (worn, held, the ammo). */
  readonly worn: boolean;
  /** How it is equipped: the menus' equip state (worn, a hand, both); else by `worn`. */
  readonly equipState?: number;
  readonly favorite: boolean;
}

export function inventoryModel(
  session: GameSession,
  terminal: Terminal,
  read: (book: number) => Promise<void>,
): ItemMenuModel {
  const items = new Map<number, ItemRecord | undefined>();
  const runtime = (): ScriptRuntime => {
    const ready = session.scriptsReady;
    if (!ready) throw new Error('the game is not running');
    return ready;
  };
  const item = async (formId: number): Promise<ItemRecord | undefined> => {
    if (!items.has(formId)) {
      const record = await runtime().forms.record(formId);
      items.set(formId, record ? parseItem(record) : undefined);
    }
    return items.get(formId);
  };
  return {
    movie: 'inventorymenu.swf',
    depth: 6,
    categories: async () => {
      const settings = await session.settings();
      return INVENTORY_CATEGORIES.flatMap((category) => [
        settings.string(category.setting) ?? category.setting,
        category.flag,
        category.alwaysShown,
      ]);
    },
    view: async (): Promise<ItemMenuView> => {
      const game = runtime();
      const settings = await session.settings();
      const inventory = await game.inventory(PLAYER_REF);
      const rows = await itemRows(game, PLAYER_REF, inventory, item);
      const cards: Record<string, unknown>[] = [];
      for (const row of rows) cards.push(await itemCard(game, settings, row));
      return {
        entries: rows.map((row) => itemEntry(row)),
        cards,
        player: [await playerInfo(game, rows, inventory.get(GOLD) ?? 0)],
      };
    },
    select: async ({ formId }, slot) => {
      const game = runtime();
      const record = await item(formId);
      if (!record) return;
      const equipment = game.equipment;
      if (record.type === 'BOOK') {
        // A book read from the inventory is equipped as far as scripts hear (its OnEquipped).
        await equipment.used(PLAYER_REF, formId);
        await read(formId);
        return;
      }
      // A poison goes on the weapon (the magic system asks first).
      if (record.type === 'ALCH' && (await game.magic.item(formId))?.kind === 'poison') {
        await game.magic.applyPoison(PLAYER_REF, formId);
        return;
      }
      const sounds = session.soundSystem;
      if (record.type === 'ALCH' || record.type === 'INGR') {
        if (!(await equipment.use(PLAYER_REF, formId))) return;
        const sound = await equipment.consumeSound(formId);
        if (sound !== undefined) void sounds?.play(sound);
        return;
      }
      const wasEquipped = await equipment.isEquipped(PLAYER_REF, formId);
      if (!(await equipment.toggle(PLAYER_REF, formId, slotHand(slot)))) {
        if ((await equipment.describe(formId)) === undefined)
          terminal.log('ui', `${record.name} cannot be equipped`, 'info');
        return;
      }
      const on = !wasEquipped || (await equipment.isEquipped(PLAYER_REF, formId));
      const sound = sounds && (await equipment.equipSound(formId, on, sounds.defaults));
      if (sound !== undefined) void sounds?.play(sound);
    },
    // TODO(M11): the dropped items placed in the world at the player's feet.
    drop: async ({ formId }, amount) => {
      const game = runtime();
      await game.removeItem(PLAYER_REF, game.formHandle(formId), amount, false, undefined);
    },
    favorite: ({ formId }) => {
      const favorites = runtime().state.favorites;
      if (favorites.has(formId)) favorites.delete(formId);
      else favorites.add(formId);
    },
  };
}

/**
 * The items of a container (an actor's: what it wears, the player's: their favorites) that
 * the menus list: playable and named (the player's gold is their info, not an item; another
 * container's is one of its items).
 */
export async function itemRows(
  runtime: ScriptRuntime,
  container: number,
  inventory: ReadonlyMap<number, number>,
  item: (formId: number) => Promise<ItemRecord | undefined>,
): Promise<Row[]> {
  // An actor's (the equip system's); a container's items are not equipped.
  const actor = await runtime.actors.isActor(container);
  const rows: Row[] = [];
  for (const [formId, count] of inventory) {
    if (count <= 0 || (formId === GOLD && container === PLAYER_REF)) continue;
    const record = await item(formId);
    if (!record || record.nonPlayable || record.name === '') continue;
    const equipState = actor
      ? await runtime.equipment.menuState(container, formId)
      : EquipState.none;
    rows.push({
      formId,
      item: record,
      count,
      worn: equipState !== EquipState.none,
      equipState,
      favorite: container === PLAYER_REF && runtime.state.favorites.has(formId),
    });
  }
  return rows;
}

/** A row's entry: name, count, how it is equipped, favorite, its category's bits. */
export function itemEntry(row: Row): ItemEntry {
  return {
    text: row.item.name,
    count: row.count,
    equipState: row.equipState ?? (row.worn ? EquipState.equipped : EquipState.none),
    favorite: row.favorite,
    filterFlag: itemCategory(row.item) | (row.favorite ? ItemCategory.favorites : 0),
    enabled: true,
    formId: row.formId,
  };
}

/** An item's card (UpdateItemCardInfo): its type's fields. */
export async function itemCard(
  runtime: ScriptRuntime,
  settings: GameSettings,
  row: Row,
): Promise<Record<string, unknown>> {
  const { item } = row;
  const type = itemCardType(item);
  const card: Record<string, unknown> = {
    type,
    name: item.name,
    count: row.count,
    value: item.value,
    weight: item.weight,
    favorite: row.favorite,
    stolen: false,
  };
  const enchantment =
    item.enchantment === undefined ? [] : await enchantmentEffects(runtime, item.enchantment);
  // Armor and damage as they would be for the player: with their skills, perks and the item's
  // improvement (UESP "Skyrim:Armor", "Skyrim:Weapons").
  switch (type) {
    case CardType.armor: {
      card.armor = Math.floor(await runtime.equipment.pieceRating(PLAYER_REF, row.formId));
      card.effects = await effectsText(runtime, enchantment);
      const skill = armorSkill(item);
      card.skillText =
        skill === undefined
          ? ''
          : ((await runtime.forms.actorValueForm(skill))?.text('FULL') ?? '');
      break;
    }
    case CardType.weapon:
      card.damage = Math.floor(
        item.weapon
          ? await runtime.equipment.weaponDamage(PLAYER_REF, row.formId)
          : (item.ammoDamage ?? 0),
      );
      card.effects = await effectsText(runtime, enchantment);
      card.poisoned = runtime.magic.poisonOf(PLAYER_REF)?.weapon === row.formId;
      break;
    case CardType.book:
      card.description = item.book?.description ?? '';
      break;
    case CardType.potion:
    case CardType.food:
      card.effects = await effectsText(runtime, item.effects);
      card.skillName = '';
      break;
    case CardType.spell:
      card.effects = await effectsText(runtime, item.effects);
      card.spellCost = 0;
      break;
    case CardType.ingredient: {
      // The effects the player has found out (by eating, by alchemy) by name (itemEffect0..3);
      // the others show $UNKNOWN.
      card.numItemEffects = item.effects.length;
      const known = runtime.state.ingredientEffects.get(row.formId);
      for (const [slot, effect] of item.effects.entries()) {
        if (!known?.has(slot)) continue;
        const record = await runtime.forms.record(effect.effect);
        card[`itemEffect${String(slot)}`] =
          record?.type === 'MGEF' ? (record.text('FULL') ?? '') : '';
      }
      break;
    }
    case CardType.soulGem: {
      const soul = SOUL_LEVEL_SETTINGS[item.soul?.current ?? 0];
      card.soulLVL = soul ? (settings.string(soul) ?? '') : '';
      break;
    }
    default:
      break;
  }
  return card;
}

async function enchantmentEffects(runtime: ScriptRuntime, formId: number): Promise<ItemEffect[]> {
  const record = await runtime.forms.record(formId);
  return record?.type === 'ENCH' ? parseEffects(record) : [];
}

/** Effects' descriptions with their values, those hidden from the interface left out. */
export async function effectsText(
  runtime: ScriptRuntime,
  effects: readonly ItemEffect[],
): Promise<string> {
  const texts: string[] = [];
  for (const effect of effects) {
    const record = await runtime.forms.record(effect.effect);
    if (record?.type !== 'MGEF') continue;
    const magic = parseMagicEffect(record);
    if ((magic.flags & EffectFlag.hideInUi) !== 0 || magic.description === '') continue;
    texts.push(effectText(magic, effect.magnitude, effect.duration, effect.area));
  }
  return texts.join(' ');
}

/** What an actor carries, in weight (its items' WEIGHT times their counts). */
export function carriedWeight(runtime: ScriptRuntime, actor: number): Promise<number> {
  return runtime.equipment.carried(actor);
}

/**
 * UpdatePlayerInfo: carried weight and its limit (CarryWeight), gold, the armor rating and the
 * damage of the weapon in hand (the equip system's: with skills, perks and improvements), the
 * meters. `rows`: the player's, as listed.
 */
export async function playerInfo(
  runtime: ScriptRuntime,
  _rows: readonly Row[],
  gold: number,
): Promise<Record<string, unknown>> {
  const equipment = runtime.equipment;
  return {
    ...(await playerMeters(runtime)),
    encumbrance: await equipment.carried(PLAYER_REF),
    maxEncumbrance: await equipment.carryWeight(PLAYER_REF),
    gold,
    armor: Math.floor((await equipment.armorRating(PLAYER_REF)).rating),
    damage: Math.floor(await equipment.shownDamage(PLAYER_REF)),
  };
}

/** The player's health, magicka and stamina, as the item menus' bars show them. */
export async function playerMeters(runtime: ScriptRuntime): Promise<Record<string, number>> {
  const value = (index: number) => runtime.actors.value(PLAYER_REF, index);
  const [health, magicka, stamina] = await Promise.all([
    value(ActorValue.health),
    value(ActorValue.magicka),
    value(ActorValue.stamina),
  ]);
  return {
    health: health.current,
    maxHealth: health.max,
    magicka: magicka.current,
    maxMagicka: magicka.max,
    stamina: stamina.current,
    maxStamina: stamina.max,
  };
}
