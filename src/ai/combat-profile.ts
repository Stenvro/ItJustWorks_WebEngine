// What the combat AI reads of an actor (docs/ai.md, "Combat AI"): its AI values as they are now
// (Aggression, Confidence, Assistance: the NPC_ AIDT and what scripts set), its aggro radius
// (AIDT), its combat style (its combat override package's PACK CNAM, else its NPC_ ZNAM from
// the template that gives its AI data, else the engine's DefaultCombatstyle), whether its class
// is a guard's, whether it is the player's teammate, and what it may fight with: the weapons it
// carries (a bow or crossbow only with ammunition for it) and its fists. Its spells, staffs and
// shouts are the casting's options (src/shell/combat-casting.ts). Platform-independent.

import { Fields } from '../formats/esm/fields.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ActorValue } from '../world/actor-values.ts';
import { AmmoFlag, WeaponType } from '../world/item-records.ts';
import { isGuardClass } from './combat-reactions.ts';
import { parseCombatStyle, type CombatStyle } from './combat-style-records.ts';
import type { EquipOption } from './combat-tactics.ts';

/** The default combat style (DefaultCombatstyle: a form of the engine's, 0x3D). */
export const DEFAULT_COMBAT_STYLE = 0x3d;

/** A style for actors whose own does not load: the Creation Kit's defaults (UESP CSTY). */
export const NO_STYLE = parseCombatStyle({
  formId: 0,
  editorId: '',
  flags: 0,
  fields: new Fields([]),
});

/** fCombatDistance: a melee weapon's reach at reach 1 (units). */
const COMBAT_DISTANCE = 141;
/** A bow's range before its arrows are known (an iron arrow's PROJ range). TODO(M13). */
const RANGED_RANGE = 4096;
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
  readonly options: readonly EquipOption[];
}

/** What it holds now, as combat has it (the ranges of what is in hand are known). */
export interface HeldNow {
  readonly weapon: number | undefined;
  /** A shot's range from the bow in hand; its melee reach. */
  readonly range: number;
  readonly reach: number;
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
    const style =
      (await this.style(runtime, packageStyle ?? info?.ai.combatStyle ?? DEFAULT_COMBAT_STYLE)) ??
      (await this.style(runtime, DEFAULT_COMBAT_STYLE)) ??
      NO_STYLE;
    const classId = info?.stats.class;
    const classRecord = classId === undefined ? undefined : await runtime.forms.record(classId);
    return {
      aggression,
      confidence,
      assistance,
      aggroRadius: info?.ai.aiData.aggroRadius,
      style,
      guard: classRecord?.type === 'CLAS' && isGuardClass(classRecord.fields.first('DATA')),
      teammate: runtime.state.actors.get(actor)?.playerTeammate === true,
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
  let arrows = false;
  let bolts = false;
  const ranged: { id: number; crossbow: boolean }[] = [];
  for (const [form, count] of await runtime.inventory(actor)) {
    if (count <= 0) continue;
    const item = await equipment.item(form);
    if (!item) continue;
    if (item.type === 'AMMO') {
      if (((item.ammoFlags ?? 0) & AmmoFlag.nonBolt) !== 0) arrows = true;
      else bolts = true;
      continue;
    }
    const weapon = item.weapon;
    if (item.type !== 'WEAP' || !weapon) continue;
    if (weapon.weaponType === WeaponType.bow || weapon.weaponType === WeaponType.crossbow) {
      ranged.push({ id: form, crossbow: weapon.weaponType === WeaponType.crossbow });
      continue;
    }
    if (weapon.weaponType > WeaponType.twoHandAxe) continue;
    options.push({
      kind: 'melee',
      id: form,
      damage: await equipment.weaponDamage(actor, form),
      range: COMBAT_DISTANCE * Math.max(0.1, weapon.reach),
      equipped: false,
    });
  }
  for (const { id, crossbow } of ranged) {
    if (!(crossbow ? bolts : arrows)) continue;
    options.push({
      kind: 'ranged',
      id,
      damage: await equipment.weaponDamage(actor, id),
      range: held?.weapon === id && held.range > 0 ? held.range : RANGED_RANGE,
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
