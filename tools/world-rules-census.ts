// The world rules' data counted (docs/scripting.md, "Cell reset and cleared locations"): the
// encounter zones and their flags, the cells that reset by a zone, the locations with bosses and
// those the player can clear, the references that never respawn, the containers and actor bases
// that respawn, and the traps (the references whose scripts hear trap hits). The conformance
// suites sweep the classes with it (tests/conformance/scripting/, physics/, ui/).
//
//   node tools/world-rules-census.ts

import { parsePex } from '../src/formats/pex/pex.ts';
import { parseVmad } from '../src/formats/esm/vmad.ts';
import { RecordFlag } from '../src/formats/esm/record.ts';
import { NpcFlag } from '../src/world/actor-records.ts';
import { parseLocation } from '../src/world/actor-stats-records.ts';
import { DefaultObjects, DefaultObjectUse } from '../src/world/default-objects.ts';
import { EncounterZoneFlag, parseEncounterZone } from '../src/world/leveling-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { openGameFolder } from './gamedata-path.ts';

/** The scripts that handle a trap's hits (OnTrapHit, OnTrapHitStart) and those extending them. */
export const TRAP_HIT_SCRIPTS = ['traphitbase', 'hazardbase'] as const;

export interface WorldRulesCensus {
  /** Encounter zones (ECZN), and those setting each flag. */
  readonly zones: number;
  readonly zoneFlags: {
    readonly neverResets: number;
    readonly matchPcBelowMinimum: number;
    readonly disableCombatBoundary: number;
  };
  /** Zones naming a location. */
  readonly zonesWithLocation: number;
  /** Interior cells with a zone, and of them those whose zone Never Resets. */
  readonly interiorsWithZone: number;
  readonly interiorsNeverReset: number;
  /** Locations (LCTN), those with bosses (LRTB references), those the player can clear (KWDO). */
  readonly locations: number;
  readonly locationsWithBosses: number;
  readonly clearable: number;
  readonly clearableWithBosses: number;
  /** Boss references in all. */
  readonly bosses: number;
  /** Placed references (REFR, ACHR) flagged No Respawn. */
  readonly noRespawn: number;
  /** Container bases (CONT) that respawn; actor bases (NPC_) that respawn. */
  readonly containersRespawning: number;
  readonly containers: number;
  readonly npcsRespawning: number;
  /** Scripts that are trap-hit scripts (TRAP_HIT_SCRIPTS and every script extending one). */
  readonly trapHitScripts: ReadonlySet<string>;
  /** Base objects carrying a trap-hit script, and references of them. */
  readonly trapBases: number;
  readonly trapReferences: number;
}

/** The scripts that extend a script (lower case), the script itself included. */
async function descendants(vfs: Vfs, roots: readonly string[]): Promise<Set<string>> {
  const parents = new Map<string, string>();
  for (const path of vfs.list('scripts').filter((p) => p.endsWith('.pex'))) {
    try {
      const object = parsePex(await vfs.read(path)).objects[0];
      if (object?.parent) parents.set(object.name.toLowerCase(), object.parent.toLowerCase());
    } catch {
      // An unreadable script extends nothing here.
    }
  }
  const found = new Set<string>(roots);
  for (const name of parents.keys()) {
    const chain: string[] = [];
    for (
      let at: string | undefined = name;
      at !== undefined && chain.length < 16;
      at = parents.get(at)
    ) {
      chain.push(at);
      if (found.has(at)) {
        for (const member of chain) found.add(member);
        break;
      }
    }
  }
  return found;
}

export async function worldRulesCensus(vfs: Vfs, db: RecordDatabase): Promise<WorldRulesCensus> {
  const defaults = await DefaultObjects.read(db);
  const boss = defaults.get(DefaultObjectUse.bossReferenceType);
  const clearableKeyword = defaults.get(DefaultObjectUse.clearableLocation);

  let zones = 0;
  let zonesWithLocation = 0;
  const zoneFlags = { neverResets: 0, matchPcBelowMinimum: 0, disableCombatBoundary: 0 };
  const neverResets = new Set<number>();
  for (const formId of db.formIdsOfType('ECZN')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const zone = parseEncounterZone(record);
    zones++;
    if (zone.location !== undefined) zonesWithLocation++;
    if (zone.flags & EncounterZoneFlag.neverResets) {
      zoneFlags.neverResets++;
      neverResets.add(formId);
    }
    if (zone.flags & EncounterZoneFlag.matchPcBelowMinimum) zoneFlags.matchPcBelowMinimum++;
    if (zone.flags & EncounterZoneFlag.disableCombatBoundary) zoneFlags.disableCombatBoundary++;
  }

  let interiorsWithZone = 0;
  let interiorsNeverReset = 0;
  for (const cell of await db.interiorCells()) {
    const record = await db.get(cell.formId);
    const zone = record?.formIdField('XEZN');
    if (zone === undefined) continue;
    interiorsWithZone++;
    if (neverResets.has(zone)) interiorsNeverReset++;
  }

  let locations = 0;
  let locationsWithBosses = 0;
  let clearable = 0;
  let clearableWithBosses = 0;
  let bosses = 0;
  for (const formId of db.formIdsOfType('LCTN')) {
    const versions = await Promise.all(db.locateAll(formId).map((at) => db.read(at)));
    const location = parseLocation(versions.filter((record) => !record.deleted));
    if (!location) continue;
    locations++;
    const count = location.references.filter((entry) => entry.type === boss).length;
    bosses += count;
    if (count > 0) locationsWithBosses++;
    const canClear = clearableKeyword !== undefined && location.keywords.includes(clearableKeyword);
    if (canClear) clearable++;
    if (canClear && count > 0) clearableWithBosses++;
  }

  let containers = 0;
  let containersRespawning = 0;
  for (const formId of db.formIdsOfType('CONT')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    containers++;
    if (((record.fields.first('DATA')?.[0] ?? 0) & 0x2) !== 0) containersRespawning++;
  }
  let npcsRespawning = 0;
  for (const formId of db.formIdsOfType('NPC_')) {
    const record = await db.get(formId);
    const acbs = record?.fields.first('ACBS');
    if (!record || record.deleted || !acbs || acbs.length < 4) continue;
    const flags = new DataView(acbs.buffer, acbs.byteOffset, acbs.byteLength).getUint32(0, true);
    if (flags & NpcFlag.respawn) npcsRespawning++;
  }

  const trapHitScripts = await descendants(vfs, TRAP_HIT_SCRIPTS);
  const trapBaseIds = new Set<number>();
  for (const type of ['ACTI', 'MSTT', 'STAT', 'MISC', 'HAZD', 'FURN']) {
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      const vmad = record?.fields.first('VMAD');
      if (!record || !vmad) continue;
      try {
        const { scripts } = parseVmad(vmad, record.type);
        if (scripts.some((script) => trapHitScripts.has(script.name.toLowerCase())))
          trapBaseIds.add(formId);
      } catch {
        // An unreadable VMAD carries no trap script here.
      }
    }
  }
  let noRespawn = 0;
  let trapReferences = 0;
  await db.scan(
    ['REFR', 'ACHR'],
    () => true,
    (record) => {
      if (record.deleted) return;
      if (record.flags & RecordFlag.noRespawn) noRespawn++;
      const base = record.formIdField('NAME');
      if (base !== undefined && trapBaseIds.has(base)) trapReferences++;
    },
  );

  return {
    zones,
    zoneFlags,
    zonesWithLocation,
    interiorsWithZone,
    interiorsNeverReset,
    locations,
    locationsWithBosses,
    clearable,
    clearableWithBosses,
    bosses,
    noRespawn,
    containers,
    containersRespawning,
    npcsRespawning,
    trapHitScripts,
    trapBases: trapBaseIds.size,
    trapReferences,
  };
}

if (import.meta.main) {
  const vfs = await Vfs.mount(openGameFolder());
  const db = await RecordDatabase.open(vfs);
  try {
    const census = await worldRulesCensus(vfs, db);
    console.log(
      JSON.stringify(
        { ...census, trapHitScripts: [...census.trapHitScripts].sort() },
        undefined,
        2,
      ),
    );
  } finally {
    await db.close();
    await vfs.close();
  }
}
