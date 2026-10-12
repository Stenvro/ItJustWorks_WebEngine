// VMAD: the Papyrus scripts attached to a record and their property values, plus the
// fragment section of dialogue (INFO) and quest (QUST) records. Layout: docs/formats/esm.md

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { decodeGameText } from '../text.ts';

/** An object property value: a form (or quest alias) as stored in this plugin. */
export interface ObjectValue {
  /** Form id as stored in the plugin (high byte = master index); 0 = none. */
  readonly formId: number;
  /** Quest alias id, or -1. */
  readonly alias: number;
}

export type PropertyValue =
  | { readonly type: 'object'; readonly value: ObjectValue }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'int'; readonly value: number }
  | { readonly type: 'float'; readonly value: number }
  | { readonly type: 'bool'; readonly value: boolean }
  | { readonly type: 'object[]'; readonly value: readonly ObjectValue[] }
  | { readonly type: 'string[]'; readonly value: readonly string[] }
  | { readonly type: 'int[]'; readonly value: readonly number[] }
  | { readonly type: 'float[]'; readonly value: readonly number[] }
  | { readonly type: 'bool[]'; readonly value: readonly boolean[] };

export interface ScriptProperty {
  readonly name: string;
  readonly value: PropertyValue;
}

export interface AttachedScript {
  readonly name: string;
  readonly properties: readonly ScriptProperty[];
}

export interface QuestAliasScripts {
  /** The alias (its object value's alias id). */
  readonly alias: number;
  readonly scripts: readonly AttachedScript[];
}

export interface ScriptAttachments {
  readonly version: number;
  readonly scripts: readonly AttachedScript[];
  /**
   * Script holding the record's fragments (TIF__… for dialogue, QF_… for quest stages), if
   * the record has a fragment section. Its properties are in `scripts`.
   */
  readonly fragmentScript: string | undefined;
  /**
   * The fragments: for dialogue, `begin`/`end` (run when the response starts / ends); for
   * quests, one per stage log entry.
   */
  readonly fragments: readonly Fragment[];
  /** Scripts on quest aliases (QUST only). */
  readonly aliases: readonly QuestAliasScripts[];
}

export interface Fragment {
  /** Dialogue: 'begin' or 'end'. Quest: the stage index. */
  readonly stage: number | 'begin' | 'end';
  /** Quest: the stage's log entry index; 0 for dialogue. */
  readonly logEntry: number;
  readonly script: string;
  /** Function in the script, e.g. "Fragment_0". */
  readonly function: string;
}

const PropertyType = {
  object: 1,
  string: 2,
  int: 3,
  float: 4,
  bool: 5,
  objectArray: 11,
  stringArray: 12,
  intArray: 13,
  floatArray: 14,
  boolArray: 15,
} as const;

class VmadReader {
  readonly reader: BinaryReader;
  readonly version: number;
  readonly objectFormat: number;

  constructor(reader: BinaryReader, version: number, objectFormat: number) {
    this.reader = reader;
    this.version = version;
    this.objectFormat = objectFormat;
  }

  wstring(): string {
    const length = this.reader.u16();
    return decodeGameText(this.reader.bytes(length));
  }

  object(): ObjectValue {
    const r = this.reader;
    if (this.objectFormat === 1) {
      const formId = r.u32();
      const alias = r.i16();
      r.skip(2);
      return { formId, alias };
    }
    r.skip(2);
    const alias = r.i16();
    return { formId: r.u32(), alias };
  }

  array<T>(item: () => T): T[] {
    const count = this.reader.u32();
    if (count > this.reader.remaining) {
      throw new FormatError(`VMAD array of ${count} items`, this.reader.offset);
    }
    return Array.from({ length: count }, item);
  }

  value(type: number): PropertyValue {
    const r = this.reader;
    switch (type) {
      case PropertyType.object:
        return { type: 'object', value: this.object() };
      case PropertyType.string:
        return { type: 'string', value: this.wstring() };
      case PropertyType.int:
        return { type: 'int', value: r.i32() };
      case PropertyType.float:
        return { type: 'float', value: r.f32() };
      case PropertyType.bool:
        return { type: 'bool', value: r.u8() !== 0 };
      case PropertyType.objectArray:
        return { type: 'object[]', value: this.array(() => this.object()) };
      case PropertyType.stringArray:
        return { type: 'string[]', value: this.array(() => this.wstring()) };
      case PropertyType.intArray:
        return { type: 'int[]', value: this.array(() => r.i32()) };
      case PropertyType.floatArray:
        return { type: 'float[]', value: this.array(() => r.f32()) };
      case PropertyType.boolArray:
        return { type: 'bool[]', value: this.array(() => r.u8() !== 0) };
      default:
        throw new FormatError(`VMAD property type ${type}`, r.offset);
    }
  }

  scripts(): AttachedScript[] {
    const count = this.reader.u16();
    return Array.from({ length: count }, () => {
      const name = this.wstring();
      if (this.version >= 4) this.reader.skip(1); // status
      const propertyCount = this.reader.u16();
      const properties = Array.from({ length: propertyCount }, () => {
        const propertyName = this.wstring();
        const type = this.reader.u8();
        if (this.version >= 4) this.reader.skip(1); // status
        return { name: propertyName, value: this.value(type) };
      });
      return { name, properties };
    });
  }
}

/**
 * Parses a VMAD field. `recordType` selects the fragment section that follows the scripts
 * (INFO and QUST; other records' fragments are not read).
 */
export function parseVmad(data: Uint8Array, recordType: string): ScriptAttachments {
  const reader = new BinaryReader(data);
  const version = reader.i16();
  const objectFormat = reader.i16();
  if (version < 2 || version > 5 || (objectFormat !== 1 && objectFormat !== 2)) {
    throw new FormatError(`VMAD version ${version} object format ${objectFormat}`, 0);
  }
  const vmad = new VmadReader(reader, version, objectFormat);
  const scripts = vmad.scripts();
  let fragmentScript: string | undefined;
  const fragments: Fragment[] = [];
  const aliases: QuestAliasScripts[] = [];

  if (reader.remaining > 0 && recordType === 'INFO') {
    reader.skip(1); // unknown, always 2
    const flags = reader.u8();
    fragmentScript = vmad.wstring();
    for (let bit = 0; bit < 2; bit++) {
      if ((flags & (1 << bit)) === 0) continue;
      reader.skip(1);
      const script = vmad.wstring();
      const fn = vmad.wstring();
      fragments.push({ stage: bit === 0 ? 'begin' : 'end', logEntry: 0, script, function: fn });
    }
  } else if (reader.remaining > 0 && recordType === 'QUST') {
    reader.skip(1); // unknown, always 2
    const fragmentCount = reader.u16();
    fragmentScript = vmad.wstring();
    for (let i = 0; i < fragmentCount; i++) {
      const stage = reader.u16();
      reader.skip(2); // unknown
      const logEntry = reader.i32();
      reader.skip(1); // unknown
      const script = vmad.wstring();
      const fn = vmad.wstring();
      fragments.push({ stage, logEntry, script, function: fn });
    }
    const aliasCount = reader.u16();
    for (let i = 0; i < aliasCount; i++) {
      const { alias } = vmad.object();
      const aliasVersion = reader.i16();
      const aliasFormat = reader.i16();
      const aliasReader = new VmadReader(reader, aliasVersion, aliasFormat);
      aliases.push({ alias, scripts: aliasReader.scripts() });
    }
  }
  if (fragmentScript === '') fragmentScript = undefined;
  return { version, scripts, fragmentScript, fragments, aliases };
}

/** Every form id (as stored in the plugin) that a script's properties refer to. */
export function referencedForms(script: AttachedScript): number[] {
  const forms: number[] = [];
  for (const { value } of script.properties) {
    if (value.type === 'object' && value.value.formId !== 0) forms.push(value.value.formId);
    if (value.type === 'object[]') {
      for (const item of value.value) if (item.formId !== 0) forms.push(item.formId);
    }
  }
  return forms;
}
