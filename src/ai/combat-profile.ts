// What the combat AI reads of an actor (docs/ai.md, "Combat AI"): its AI values as they are now
// (Aggression, Confidence, Assistance: the NPC_ AIDT and what scripts set), its aggro radius
// (AIDT), its combat style (its combat override package's PACK CNAM, else its NPC_ ZNAM from
// the template that gives its AI data, else the engine's DefaultCombatstyle), whether its class
// is a guard's, whether it is the player's teammate, and what it may fight with: the weapons it
// carries (a bow or crossbow only with ammunition for it) and its fists. Its spells, staffs and
// shouts are the casting's options (src/shell/combat-casting.ts). Platform-independent.
//
// A commanded actor (a summon, a raised corpse, a commanded creature: the magic system's
// commander) fights on its commander's side, not by its base's AI data: the aggression of one
// (fightingAggression: its commander's enemies on sight, never the neutral), no aggro radius
// (the familiar's wolf template would warn and attack whoever comes within 500 units), helping
// its allies at least (its commander is one), and one the player commands is their teammate.

import { Fields } from '../formats/esm/fields.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ActorValue } from '../world/actor-values.ts';
import { WeaponFlag2, WeaponType } from '../world/item-records.ts';
import { Assistance, fightingAggression } from './combat-ai.ts';
import { parseCombatStyle, type CombatStyle } from './combat-style-records.ts';
import { bestAmmo, type CarriedAmmo, type EquipOption } from './combat-tactics.ts';

/** The default combat style (DefaultCombatstyle: a form of the engine's, 0x3D). */
export const DEFAULT_COMBAT_STYLE = 0x3d;

/** A style for actors whose own does not load: the Creation Kit's defaults (UESP CSTY). */
export const NO_STYLE = parseCombatStyle({
  formId: 0,
  editorId: '',
  flags: 0,
  fields: new Fields([]),
});

/** Fists' reach before the race's is known (RACE DATA unarmed reach, humans'). */
const UNARMED_RANGE = 96;

export interface CombatProfile {
  readonly aggression: number;
  readonly confidence: number;
  readonly assistance: number;
  /** AIDT aggro radius behaviour: warn, warn or attack, attack radii (undefined: off). */
  readonly aggroRadius: readonly [number, number, number] | undefined;
  readonly style: CombatStyle;
  readonly guard: boolean;
  readonly teammate: boolean;
  /** A child (its race's flag): it flees any fight, and teammates pass it over as a target. */
  readonly child: boolean;
  readonly options: readonly EquipOption[];
}

/** What it holds now, as combat has it (the ranges of what is in hand are known). */
export interface HeldNow {
  readonly weapon: number | undefined;
  /** A shot's range from the bow in hand; its melee reach. */
  readonly range: number;
  readonly reach: number;
}

/**
 * Whom a commanded actor fights for: the head of its chain of commanders (a summoner's raised
 * corpse's raised corpse: the summoner), as reactions follow it (src/ai/combat-reactions.ts:
 * two links). Undefined: no one commands it.
 */
export function commanderOf(runtime: ScriptRuntime, actor: number): number | undefined {
  let head = runtime.magic.commander(actor);
  if (head === actor) return undefined;
  for (let link = 0; link < 2 && head !== undefined; link++) {
    const next = runtime.magic.commander(head);
    if (next === undefined || next === head) break;
    head = next;
  }
  return head;
}

/** Reads actors' combat profiles, keeping the combat styles read. */
export class CombatProfiles {
  readonly #styles = new Map<number, Promise<CombatStyle | undefined>>();

  async read(
    runtime: ScriptRuntime,
    actor: number,
    packageStyle?: number,
    held?: HeldNow,
  ): Promise<CombatProfile> {
    const actors = runtime.actors;
    const info = await actors.info(actor);
    const value = async (index: number): Promise<number> =>
      (await actors.value(actor, index)).current;
    const [aggression, confidence, assistance] = await Promise.all([
      value(ActorValue.aggression),
      value(ActorValue.confidence),
      value(ActorValue.assistance),
    ]);
    const commander = commanderOf(runtime, actor);
    const commanded = commander !== undefined;
    const style =
      (await this.style(runtime, packageStyle ?? info?.ai.combatStyle ?? DEFAULT_COMBAT_STYLE)) ??
      (await this.style(runtime, DEFAULT_COMBAT_STYLE)) ??
      NO_STYLE;
    return {
      aggression: fightingAggression(aggression, commanded),
      confidence,
      assistance: commanded ? Math.max(assistance, Assistance.helpsAllies) : assistance,
      aggroRadius: commanded ? undefined : info?.ai.aiData.aggroRadius,
      style,
      // A guard as crime has it: its class's guard flag, or IsGuardFaction (vanilla's town guards
      // are in the faction; their classes are fighters').
      guard: await runtime.crime.isGuard(actor),
      teammate:
        runtime.state.actors.get(actor)?.playerTeammate === true || commander === PLAYER_REF,
      child: await runtime.actors.isChild(actor),
      options: await weaponOptions(runtime, actor, held),
    };
  }

  /** A combat style by form id (undefined: not a CSTY). */
  style(runtime: ScriptRuntime, formId: number): Promise<CombatStyle | undefined> {
    let style = this.#styles.get(formId);
    if (!style) {
      style = runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'CSTY' ? parseCombatStyle(record) : undefined))
        .catch(() => undefined);
      this.#styles.set(formId, style);
    }
    return style;
  }
}

/** An AMMO item as its bow's choice weighs it (bestAmmo). */
function ammoOf(
  id: number,
  count: number,
  item: { readonly ammoFlags?: number; readonly ammoDamage?: number },
): CarriedAmmo {
  return { id, count, damage: item.ammoDamage ?? 0, flags: item.ammoFlags ?? 0 };
}

/** The ammunition an actor carries (count above 0), for its bow's choice (bestAmmo). */
export async function carriedAmmo(runtime: ScriptRuntime, actor: number): Promise<CarriedAmmo[]> {
  const carried: CarriedAmmo[] = [];
  for (const [form, count] of await runtime.inventory(actor)) {
    if (count <= 0) continue;
    const item = await runtime.equipment.item(form);
    if (item?.type === 'AMMO') carried.push(ammoOf(form, count, item));
  }
  return carried;
}

/**
 * The weapons an actor carries as equipment options (melee by its reach, a bow or crossbow with
 * ammunition for it by its range), and its fists (its unarmed damage). Staffs, spells and shouts
 * are the casting's options (src/shell/combat-casting.ts: CombatCasting.options).
 */
export async function weaponOptions(
  runtime: ScriptRuntime,
  actor: number,
  held?: HeldNow,
): Promise<EquipOption[]> {
  const equipment = runtime.equipment;
  const options: EquipOption[] = [];
  const setting = async (name: string, fallback: number): Promise<number> => {
    const value = await runtime.gameSetting(name);
    return typeof value === 'number' ? value : fallback;
  };
  // A melee weapon's reach at reach 1; a shot's range before the bow's arrows are known (the
  // farthest a shot counts: the engine caps a projectile's reach there).
  const combatDistance = await setting('fCombatDistance', 141);
  const shotRange = await setting('fCombatMaximumProjectileRange', 4096);
  const ammo: CarriedAmmo[] = [];
  const ranged: { id: number; crossbow: boolean }[] = [];
  for (const [form, count] of await runtime.inventory(actor)) {
    if (count <= 0) continue;
    const item = await equipment.item(form);
    if (!item) continue;
    if (item.type === 'AMMO') {
      ammo.push(ammoOf(form, count, item));
      continue;
    }
    const weapon = item.weapon;
    if (item.type !== 'WEAP' || !weapon) continue;
    // Not for a fight (WEAP Flags2): it scores nothing in the original.
    if ((weapon.flags2 & WeaponFlag2.notUsedInNormalCombat) !== 0) continue;
    if (weapon.weaponType === WeaponType.bow || weapon.weaponType === WeaponType.crossbow) {
      ranged.push({ id: form, crossbow: weapon.weaponType === WeaponType.crossbow });
      continue;
    }
    if (weapon.weaponType > WeaponType.twoHandAxe) continue;
    options.push({
      kind: 'melee',
      id: form,
      damage: await equipment.weaponDamage(actor, form),
      bound: (weapon.flags2 & WeaponFlag2.boundWeapon) !== 0,
      range: combatDistance * Math.max(0.1, weapon.reach),
      equipped: false,
      weaponType: weapon.weaponType,
      count,
    });
  }
  for (const { id, crossbow } of ranged) {
    // Only with ammunition for it (bestAmmo: what it takes up with it). Weighed by the bow's own
    // damage, its arrows' left out: the score's mults and range curves are tuned on that, and
    // with the arrows added an archer kept its bow well inside a sword's reach (docs/ai.md).
    // TODO(M13): phase 5, whether the engine's score counts the ammunition.
    if (!bestAmmo(ammo, crossbow)) continue;
    options.push({
      kind: 'ranged',
      id,
      damage: await equipment.weaponDamage(actor, id),
      range: held?.weapon === id && held.range > 0 ? held.range : shotRange,
      equipped: false,
    });
  }
  options.push({
    kind: 'unarmed',
    id: undefined,
    damage: (await runtime.actors.value(actor, ActorValue.unarmedDamage)).current,
    range: held && held.weapon === undefined ? held.reach : UNARMED_RANGE,
    equipped: false,
  });
  return options;
}
