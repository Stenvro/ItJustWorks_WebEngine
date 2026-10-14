// The weapons that weapon racks, plaques and display cases hold. Each rack's activator runs
// WeaponRackActivateSCRIPT: when its cell attaches, its starting weapon (the reference it links
// to without a keyword) is put on the rack: HandleStartingWeapon picks by the rack's RackType
// (1: anything but a shield; 2: only a shield; 3: neither a dagger, a shield nor a bow), and
// HandleWeaponPlacement sets the weapon's motion type to keyframed (it no longer falls) and
// moves it to the pivot node of the rack's trigger (linked by the WRackTrigger keyword) for its
// weapon type. Placed in the editor, those weapons float in front of the rack: settled, they
// fell off Warmaiden's and Jorrvaskr's walls.
// TODO(M8): the script itself runs (its OnCellAttach and the natives), with MoveToNode; until
// then the weapons it would hold are held where they were placed.

import { parseVmad, type ObjectValue, type PropertyValue } from '../formats/esm/vmad.ts';
import { linkedReferences } from './cell-records.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

const RACK_SCRIPT = 'weaponrackactivatescript';

/** The rack activators' starting weapons (references) the racks hold, of the given ones. */
export async function weaponRackHolds(
  db: RecordDatabase,
  references: readonly GameRecord[],
): Promise<Set<number>> {
  const held = new Set<number>();
  for (const reference of references) {
    const linked = linkedReferences(reference);
    const starting = linked.get(0);
    if (starting === undefined) continue;
    const base = await db.get(reference.formIdField('NAME') ?? 0);
    if (base?.type !== 'ACTI') continue;
    const properties = rackProperties(base, reference);
    if (!properties) continue;
    // The trigger it is linked to must be there (and enabled at the start of a new game).
    const trigger = [...linked].find(
      ([keyword]) => keyword !== 0 && keyword === objectId(db, properties.get('wracktrigger')),
    );
    if (!trigger) continue;
    const weapon = await db.get(starting);
    const item = weapon && (await db.get(weapon.formIdField('NAME') ?? 0));
    if (!item) continue;
    const keywords = keywordsOf(item);
    const has = (name: string): boolean => {
      const id = objectId(db, properties.get(name));
      return id !== undefined && keywords.has(id);
    };
    // Not set on the rack: the script's own initial value (RackType = 1).
    const rackType = intOf(properties.get('racktype')) ?? (await scriptDefault(db, 'RackType'));
    const shield = has('armorshield');
    const placedOnRack =
      rackType === 1
        ? !shield
        : rackType === 2
          ? shield
          : rackType === 3
            ? !shield && !has('weapontypedagger') && !has('weapontypebow')
            : false;
    if (placedOnRack) held.add(starting);
  }
  return held;
}

/** An auto property's initial value in the rack script (its variable's), if an int. */
async function scriptDefault(db: RecordDatabase, property: string): Promise<number | undefined> {
  const script = await db.script(RACK_SCRIPT);
  for (const object of script?.objects ?? []) {
    const declared = object.properties.find(
      (entry) => entry.name.toLowerCase() === property.toLowerCase(),
    );
    const variable = object.variables.find((entry) => entry.name === declared?.autoVariable);
    if (variable?.initial.kind === 'int') return variable.initial.value;
  }
  return undefined;
}

/** The rack script's properties: the base's, overridden by the reference's own. */
function rackProperties(
  base: GameRecord,
  reference: GameRecord,
): Map<string, { readonly value: PropertyValue; readonly owner: GameRecord }> | undefined {
  const properties = new Map<
    string,
    { readonly value: PropertyValue; readonly owner: GameRecord }
  >();
  let attached = false;
  for (const record of [base, reference]) {
    const vmad = record.fields.first('VMAD');
    if (!vmad) continue;
    let scripts;
    try {
      scripts = parseVmad(vmad, record.type).scripts;
    } catch {
      continue;
    }
    for (const script of scripts) {
      if (script.name.toLowerCase() !== RACK_SCRIPT) continue;
      attached = true;
      for (const property of script.properties) {
        properties.set(property.name.toLowerCase(), { value: property.value, owner: record });
      }
    }
  }
  return attached ? properties : undefined;
}

/** An object property's form, as a load-order form id. */
function objectId(
  db: RecordDatabase,
  property: { readonly value: PropertyValue; readonly owner: GameRecord } | undefined,
): number | undefined {
  if (property?.value.type !== 'object') return undefined;
  const value: ObjectValue = property.value.value;
  return value.formId === 0 ? undefined : db.toGlobal(property.owner.plugin, value.formId);
}

function intOf(
  property: { readonly value: PropertyValue; readonly owner: GameRecord } | undefined,
): number | undefined {
  return property?.value.type === 'int' ? property.value.value : undefined;
}

/** KWDA: a base object's keywords. */
function keywordsOf(record: GameRecord): Set<number> {
  const keywords = new Set<number>();
  const data = record.fields.first('KWDA');
  if (!data) return keywords;
  for (let at = 0; at + 4 <= data.length; at += 4) keywords.add(record.formIdAt(data, at));
  return keywords;
}
