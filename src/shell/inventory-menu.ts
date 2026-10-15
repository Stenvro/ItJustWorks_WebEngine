// The player's inventory (interface\inventorymenu.swf), as a model of the item menus
// (item-menu.ts): the player's items with their counts, what is worn and what is a favorite,
// each item's card (its type's fields: damage, armor, effects, a book's description, a soul
// gem's soul), and the player's carried weight, gold and meters. Selecting wears or takes off
// armor and weapons (OnObjectEquipped / OnObjectUnequipped; TODO(M11): using, eating, reading,
// equipping to a hand), dropping removes the items. Notes: docs/ui.md ("The item menus").

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
import type { ItemEntry, ItemMenuModel, ItemMenuView } from './item-menu.ts';
import type { Terminal } from './terminal.ts';

/** Gold (Gold001): its count is the player's gold. */
export const GOLD = 0xf;

/** An item row of the menu. */
export interface Row {
  readonly formId: number;
  readonly item: ItemRecord;
  readonly count: number;
  readonly worn: boolean;
  readonly favorite: boolean;
}

export function inventoryModel(session: GameSession, terminal: Terminal): ItemMenuModel {
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
    select: async ({ formId }) => {
      const game = runtime();
      const record = await item(formId);
      if (!record) return;
      if (record.type !== 'ARMO' && record.type !== 'WEAP' && record.type !== 'AMMO') {
        terminal.log('ui', `using ${record.name} is not built yet`, 'warn');
        return;
      }
      const actor = game.state.actor(PLAYER_REF);
      const worn = new Set([...(await game.actors.worn(PLAYER_REF)), ...actor.equipped]);
      const handle = game.formHandle(formId);
      if (worn.has(formId)) {
        actor.equipped.delete(formId);
        game.world.equipmentChanged?.(PLAYER_REF);
        await game.sendEvent(PLAYER_REF, 'OnObjectUnequipped', [handle, null]);
      } else {
        actor.equipped.add(formId);
        game.world.equipmentChanged?.(PLAYER_REF);
        await game.sendEvent(PLAYER_REF, 'OnObjectEquipped', [handle, null]);
      }
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
  const worn = new Set([
    ...(await runtime.actors.worn(container)),
    ...(runtime.state.actors.get(container)?.equipped ?? []),
  ]);
  const rows: Row[] = [];
  for (const [formId, count] of inventory) {
    if (count <= 0 || (formId === GOLD && container === PLAYER_REF)) continue;
    const record = await item(formId);
    if (!record || record.nonPlayable || record.name === '') continue;
    rows.push({
      formId,
      item: record,
      count,
      worn: worn.has(formId),
      favorite: container === PLAYER_REF && runtime.state.favorites.has(formId),
    });
  }
  return rows;
}

/** A row's entry: name, count, worn, favorite, its category's bits. */
export function itemEntry(row: Row): ItemEntry {
  return {
    text: row.item.name,
    count: row.count,
    equipState: row.worn ? EquipState.equipped : EquipState.none,
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
  switch (type) {
    case CardType.armor: {
      card.armor = Math.floor(item.armor?.rating ?? 0);
      card.effects = await effectsText(runtime, enchantment);
      const skill = armorSkill(item);
      card.skillText =
        skill === undefined
          ? ''
          : ((await runtime.forms.actorValueForm(skill))?.text('FULL') ?? '');
      break;
    }
    case CardType.weapon:
      card.damage = Math.floor(item.weapon?.damage ?? item.ammoDamage ?? 0);
      card.effects = await effectsText(runtime, enchantment);
      card.poisoned = false;
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
    case CardType.ingredient:
      // TODO(M11): the effects the player has found out (by eating, by alchemy).
      card.numItemEffects = item.effects.length;
      break;
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

/** UpdatePlayerInfo: carried weight and its limit, gold, armor, damage, the meters. */
export async function playerInfo(
  runtime: ScriptRuntime,
  rows: readonly Row[],
  gold: number,
): Promise<Record<string, unknown>> {
  let encumbrance = 0;
  let armor = 0;
  let damage = 0;
  for (const row of rows) {
    encumbrance += row.item.weight * row.count;
    if (row.worn && row.item.armor) armor += row.item.armor.rating;
    if (row.worn && row.item.weapon) damage = Math.max(damage, row.item.weapon.damage);
  }
  // TODO(M11): armor and damage with the player's skills and perks.
  return {
    ...(await playerMeters(runtime)),
    encumbrance,
    maxEncumbrance: (await runtime.actors.value(PLAYER_REF, ActorValue.carryWeight)).current,
    gold,
    armor: Math.floor(armor),
    damage: Math.floor(damage),
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
