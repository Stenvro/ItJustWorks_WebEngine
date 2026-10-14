// Which scripts refer to a form: an index over the script properties (VMAD) of dialogue
// responses and quests. Used to tell what drives a cell's enable-parent markers: something
// the player buys in conversation (a room from a steward: the response's script takes
// gold), a house-building script, or a quest stage. Built once per record database by
// reading only INFO and QUST records. (The running game's scripts read the same properties
// through the script runtime.)

import { forEachRecord } from '../formats/esm/plugin-index.ts';
import { fourCCToInt, parseFields } from '../formats/esm/record.ts';
import { parseVmad, referencedForms, type AttachedScript } from '../formats/esm/vmad.ts';
import type { Plugin, RecordDatabase } from './record-db.ts';

/** What kind of script refers to a form. */
export const ScriptUse = {
  /** A dialogue response's fragment script: the player chose it in conversation. */
  dialogue: 1,
  /** A quest's stage fragment script: set by quest progress. */
  questStage: 2,
  /** A quest's own (non-fragment) script or a quest alias script. */
  questScript: 4,
  /** A dialogue response that also takes gold: the player bought it (from a steward). */
  purchase: 8,
} as const;

/** Gold001, the septim (a Skyrim.esm form, the same global id in every load order). */
const GOLD = 0x0000000f;

export interface ScriptReference {
  /** Global form id of the INFO or QUST record. */
  readonly record: number;
  readonly use: number;
  readonly script: string;
  readonly property: string;
  /** Number of forms in the property (1 for a single object; more for arrays). */
  readonly propertySize: number;
}

export class ScriptReferenceIndex {
  readonly #byForm = new Map<number, ScriptReference[]>();
  readonly #records = new Map<number, number>();

  add(formId: number, reference: ScriptReference): void {
    const list = this.#byForm.get(formId);
    if (list) list.push(reference);
    else this.#byForm.set(formId, [reference]);
    this.#records.set(reference.record, (this.#records.get(reference.record) ?? 0) | reference.use);
  }

  /** The INFO and QUST records whose scripts have any of the given ScriptUse bits. */
  recordsWith(use: number): number[] {
    return [...this.#records].filter(([, bits]) => (bits & use) !== 0).map(([record]) => record);
  }

  /** The scripts referring to a form (global form id). */
  references(formId: number): readonly ScriptReference[] {
    return this.#byForm.get(formId) ?? [];
  }

  /** Every ScriptUse bit of the scripts referring to a form. */
  uses(formId: number): number {
    return this.references(formId).reduce((bits, reference) => bits | reference.use, 0);
  }

  get size(): number {
    return this.#byForm.size;
  }
}

const INFO = fourCCToInt('INFO');
const QUST = fourCCToInt('QUST');

function addScripts(
  index: ScriptReferenceIndex,
  db: RecordDatabase,
  plugin: Plugin,
  record: number,
  scripts: readonly AttachedScript[],
  useOf: (script: AttachedScript) => number,
): void {
  for (const script of scripts) {
    const use = useOf(script);
    for (const property of script.properties) {
      const forms = referencedForms({ name: script.name, properties: [property] });
      for (const local of forms) {
        index.add(db.toGlobal(plugin, local), {
          record,
          use,
          script: script.name,
          property: property.name,
          propertySize: forms.length,
        });
      }
    }
  }
}

async function build(
  db: RecordDatabase,
): Promise<{ index: ScriptReferenceIndex; problems: string[] }> {
  const index = new ScriptReferenceIndex();
  const problems: string[] = [];
  const types = new Set([INFO, QUST]);
  for (const plugin of db.plugins) {
    let failed = 0;
    await forEachRecord(
      plugin.source,
      plugin.index,
      (record, loaded) => {
        const formId = db.toGlobal(plugin, loaded.header.formId);
        // Only the winning version of a record counts.
        const winner = db.locate(formId);
        if (winner?.plugin !== plugin || winner.record !== record) return;
        try {
          const vmad = parseFields(loaded.data).find((field) => field.type === 'VMAD')?.data;
          if (!vmad) return;
          const type = loaded.header.type;
          const attachments = parseVmad(vmad, type);
          const fragment = attachments.fragmentScript;
          addScripts(index, db, plugin, formId, attachments.scripts, (script) => {
            if (type === 'INFO') {
              const takesGold = referencedForms(script).some(
                (local) => db.toGlobal(plugin, local) === GOLD,
              );
              return ScriptUse.dialogue | (takesGold ? ScriptUse.purchase : 0);
            }
            return script.name === fragment ? ScriptUse.questStage : ScriptUse.questScript;
          });
          for (const alias of attachments.aliases) {
            addScripts(index, db, plugin, formId, alias.scripts, () => ScriptUse.questScript);
          }
        } catch {
          failed++;
        }
      },
      types,
    );
    if (failed > 0) problems.push(`${plugin.entry.name}: ${failed} unreadable script attachments`);
  }
  return { index, problems };
}

const cache = new WeakMap<
  RecordDatabase,
  Promise<{ index: ScriptReferenceIndex; problems: string[] }>
>();

/** The script reference index of a record database, built on first use. */
export async function scriptReferences(
  db: RecordDatabase,
): Promise<{ index: ScriptReferenceIndex; problems: readonly string[] }> {
  let pending = cache.get(db);
  if (!pending) {
    pending = build(db);
    cache.set(db, pending);
  }
  return pending;
}
