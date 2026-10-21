// Which condition functions (CTDA) the load order's records use, and whether the evaluators
// value them: every record of every type that has conditions, per function the records (by
// type) that use it and samples of its conditions. The running game's evaluator
// (src/scripting/runtime/condition-values.ts with magic-conditions.ts and crime-conditions.ts)
// is asked with the samples on the player: a function it leaves to the "not valued yet"
// fallback is unvalued. The ambient sounds' and the music tracks' conditions (region and
// weather sounds, MUST) are checked synchronously by src/audio/sound-conditions.ts: their
// functions must be among those it values. For tools/condition-audit.ts and its integration
// test (tests/condition-audit.int.test.ts).

import { SOUND_CONDITION_FUNCTIONS } from '../src/audio/sound-conditions.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { conditionAt, NOT_VALUED, type Condition } from '../src/scripting/conditions.ts';
import { conditionFunctionValue } from '../src/scripting/runtime/condition-values.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ObjectHandle } from '../src/scripting/values.ts';
import { parseRegionAudio } from '../src/world/sound-records.ts';
import type { GameRecord, RecordDatabase } from '../src/world/record-db.ts';

/**
 * Record types without conditions (xEdit wbDefinitionsTES5) that are many or large: skipped
 * so a scan reads the rest of the load order quickly.
 */
const WITHOUT_CONDITIONS = new Set([
  'REFR',
  'ACHR',
  'PGRE',
  'PHZD',
  'NAVM',
  'NAVI',
  'LAND',
  'CELL',
  'WRLD',
  'STAT',
  'TES4',
  'GRUP',
]);

/**
 * Functions the data uses that cannot be valued yet, each with the milestone that brings what
 * they ask about. The perk entry points' functions ask about the entry point's own subject (the
 * spell cast, the attack, the potion made, the skill used): the perk system's (M11).
 */
export const NOT_YET: ReadonlyMap<number, string> = new Map([
  [500, 'TODO(M11): perk entry points (the potion being made: Alchemy perks)'],
  [501, 'TODO(M11): perk entry points (the potion being made: Alchemy perks)'],
  [681, 'TODO(M11): perk entry points (the skill being used)'],
  [693, 'TODO(M11): perk entry points (the spell being cast)'],
  [696, 'TODO(M11): perk entry points (the spell being cast)'],
  [697, 'TODO(M11): perk entry points (the attack being made)'],
  [721, 'TODO(M11): perk entry points (the poison being applied)'],
]);

export interface FunctionUsage {
  readonly function: number;
  /** Records that use it, by record type ("INFO", "PACK", ...). */
  readonly records: Map<string, number>;
  /** A few records that use it (type and editor id or form id), for reports. */
  readonly examples: string[];
  /** Its conditions as the records have them (a few per record type). */
  readonly samples: Condition[];
  /** Records of the sound evaluator's (ambient sounds, music tracks) that use it. */
  sound: number;
}

/** How many samples a function keeps per record type. */
const SAMPLES_PER_TYPE = 4;

/** Every condition function the load order's records use (by function index). */
export async function conditionUsage(db: RecordDatabase): Promise<Map<number, FunctionUsage>> {
  const types = new Set<string>();
  for (const plugin of db.plugins) {
    for (const code of new Set(plugin.index.types)) {
      const type = String.fromCharCode(
        code & 0xff,
        (code >>> 8) & 0xff,
        (code >>> 16) & 0xff,
        code >>> 24,
      );
      if (!WITHOUT_CONDITIONS.has(type)) types.add(type);
    }
  }
  const ambient = await ambientSounds(db);
  const usage = new Map<number, FunctionUsage>();
  const visit = (record: GameRecord): void => {
    const fields = record.fields.list;
    const seen = new Set<number>();
    const sound = record.type === 'MUST' || ambient.has(record.formId);
    for (let i = 0; i < fields.length; i++) {
      if (fields[i]?.type !== 'CTDA') continue;
      const condition = conditionAt(fields, i, record);
      if (!condition) continue;
      let entry = usage.get(condition.function);
      if (!entry) {
        entry = {
          function: condition.function,
          records: new Map(),
          examples: [],
          samples: [],
          sound: 0,
        };
        usage.set(condition.function, entry);
      }
      if ((entry.records.get(record.type) ?? 0) < SAMPLES_PER_TYPE) entry.samples.push(condition);
      if (seen.has(condition.function)) continue;
      seen.add(condition.function);
      entry.records.set(record.type, (entry.records.get(record.type) ?? 0) + 1);
      if (sound) entry.sound++;
      if (entry.examples.length < 3) {
        entry.examples.push(
          `${record.type} ${record.editorId ?? record.formId.toString(16).padStart(8, '0')}`,
        );
      }
    }
  };
  await db.scan([...types], () => true, visit);
  return usage;
}

/**
 * The sound descriptors ambience plays by the sound evaluator: the regions' sounds (REGN
 * RDSA) and the weathers' (WTHR SNAM), a SOUN's descriptor (SDSC) for a SOUN.
 */
async function ambientSounds(db: RecordDatabase): Promise<Set<number>> {
  const sounds = new Set<number>();
  await db.scan(
    ['REGN'],
    () => true,
    (record) => {
      for (const entry of parseRegionAudio(record).sounds) sounds.add(entry.sound);
    },
  );
  await db.scan(
    ['WTHR'],
    () => true,
    (record) => {
      for (const data of record.fields.all('SNAM')) sounds.add(record.formIdAt(data));
    },
  );
  const descriptors = new Set<number>();
  for (const sound of sounds) {
    const record = await db.get(sound);
    if (record?.type === 'SOUN') {
      const descriptor = record.formIdField('SDSC');
      if (descriptor !== undefined) descriptors.add(descriptor);
    } else if (record?.type === 'SNDR') descriptors.add(sound);
  }
  return descriptors;
}

/** How many records use a function in all. */
export function recordCount(usage: FunctionUsage): number {
  let count = 0;
  for (const value of usage.records.values()) count += value;
  return count;
}

export interface AuditFinding {
  readonly usage: FunctionUsage;
  readonly name: string;
  /** Why it is not valued (the evaluator that leaves it), or its milestone (NOT_YET). */
  readonly why: string;
}

export interface ConditionAudit {
  readonly usage: Map<number, FunctionUsage>;
  /** Used and not valued: each one an error. */
  readonly unvalued: AuditFinding[];
  /** Used and not valued yet by milestone (NOT_YET). */
  readonly notYet: AuditFinding[];
  /** Samples whose valuing threw (with the error). */
  readonly errors: string[];
}

/**
 * Audits the load order's condition functions against the evaluators: the running game's
 * (each function's samples valued on the player, headless) and, for the ambient sounds and the
 * music tracks, the sound evaluator's functions.
 */
export async function conditionAudit(
  db: RecordDatabase,
  runtime: ScriptRuntime,
): Promise<ConditionAudit> {
  const usage = await conditionUsage(db);
  const unvalued: AuditFinding[] = [];
  const notYet: AuditFinding[] = [];
  const errors: string[] = [];
  const player = new ObjectHandle(PLAYER_REF, 'actor');
  for (const entry of [...usage.values()].sort((a, b) => recordCount(b) - recordCount(a))) {
    const name = conditionFunctionName(entry.function);
    const reasons: string[] = [];
    let missing = false;
    for (const sample of entry.samples) {
      try {
        const value = await conditionFunctionValue(runtime, sample, player, {});
        if (value === NOT_VALUED) missing = true;
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (missing) reasons.push('the running game');
    if (entry.sound > 0 && !SOUND_CONDITION_FUNCTIONS.has(entry.function)) {
      reasons.push(`the sound conditions (${String(entry.sound)} ambient sounds or tracks)`);
    }
    if (reasons.length === 0) continue;
    const later = NOT_YET.get(entry.function);
    if (later !== undefined) notYet.push({ usage: entry, name, why: later });
    else unvalued.push({ usage: entry, name, why: `not valued by ${reasons.join(' and ')}` });
  }
  return { usage, unvalued, notYet, errors };
}
