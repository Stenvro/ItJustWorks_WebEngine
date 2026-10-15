// Reads what character creation needs from the load order: the playable races and, per race
// and sex, the data of the race menu's sliders (ChargenRaceData). Platform-independent.

import {
  HeadPartFlag,
  parseColor,
  parseHeadPart,
  type HeadPartRecord,
} from '../world/actor-records.ts';
import {
  MorphGroup,
  availableMorphTypes,
  parseNpcFace,
  parseRaceChargen,
  type NpcFace,
  type RaceChargen,
} from '../world/chargen-records.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import type { ChargenColor, ChargenRaceData, ChargenTintLayer, Rgb } from './chargen.ts';

/** How many types each MorphGroup has (GMSTs iNoseMorphCount, iBrowMorphCount, ...). */
export interface MorphTypeCounts {
  readonly nose: number;
  readonly brow: number;
  readonly eyes: number;
  readonly lips: number;
}

/** The vanilla values of iNoseMorphCount, iBrowMorphCount, iEyeMorphCount, iLipMorphCount. */
export const VANILLA_MORPH_COUNTS: MorphTypeCounts = { nose: 31, brow: 20, eyes: 38, lips: 31 };

/** The morph counts from the game settings (vanilla values where one is missing). */
export function morphTypeCounts(
  setting: (editorId: string) => number | undefined,
): MorphTypeCounts {
  return {
    nose: setting('iNoseMorphCount') ?? VANILLA_MORPH_COUNTS.nose,
    brow: setting('iBrowMorphCount') ?? VANILLA_MORPH_COUNTS.brow,
    eyes: setting('iEyeMorphCount') ?? VANILLA_MORPH_COUNTS.eyes,
    lips: setting('iLipMorphCount') ?? VANILLA_MORPH_COUNTS.lips,
  };
}

/** A race of the race menu's list. */
export interface ChargenRaceEntry {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string;
  readonly description: string;
}

export class ChargenCatalog {
  readonly #db: RecordDatabase;
  readonly #counts: MorphTypeCounts;
  /** Every head part (the menu's lists and the types of an appearance's parts). */
  readonly #headParts: readonly HeadPartRecord[];
  readonly #headPartTypes: ReadonlyMap<number, number>;
  readonly #races = new Map<number, RaceChargen | undefined>();
  readonly #formLists = new Map<number, readonly number[]>();
  readonly #colors = new Map<number, Rgb | undefined>();
  /** The playable races (RACE DATA 0x1), by name. */
  readonly races: readonly ChargenRaceEntry[];

  private constructor(
    db: RecordDatabase,
    counts: MorphTypeCounts,
    headParts: readonly HeadPartRecord[],
    races: readonly ChargenRaceEntry[],
  ) {
    this.#db = db;
    this.#counts = counts;
    this.#headParts = headParts;
    this.#headPartTypes = new Map(headParts.map((part) => [part.formId, part.type]));
    this.races = races;
  }

  static async open(
    db: RecordDatabase,
    counts: MorphTypeCounts = VANILLA_MORPH_COUNTS,
  ): Promise<ChargenCatalog> {
    const headParts: HeadPartRecord[] = [];
    for (const formId of db.formIdsOfType('HDPT')) {
      const record = await db.get(formId);
      if (record?.type === 'HDPT' && !record.deleted) headParts.push(parseHeadPart(record));
    }
    const races: ChargenRaceEntry[] = [];
    const parsed = new Map<number, RaceChargen>();
    for (const formId of db.formIdsOfType('RACE')) {
      const record = await db.get(formId);
      if (record?.type !== 'RACE' || record.deleted) continue;
      const race = parseRaceChargen(record);
      parsed.set(formId, race);
      if (race.playable) {
        const { editorId, name, description } = race;
        races.push({ formId, editorId, name: name || editorId, description });
      }
    }
    // TODO(M13): verify the vanilla order (by name and by form id agree for the vanilla races).
    races.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const catalog = new ChargenCatalog(db, counts, headParts, races);
    for (const [formId, race] of parsed) catalog.#races.set(formId, race);
    return catalog;
  }

  /** The race's head data (undefined: not a race). */
  async race(formId: number): Promise<RaceChargen | undefined> {
    if (!this.#races.has(formId)) {
      const record = await this.#db.get(formId);
      this.#races.set(formId, record?.type === 'RACE' ? parseRaceChargen(record) : undefined);
    }
    return this.#races.get(formId);
  }

  async #formList(formId: number): Promise<readonly number[]> {
    let list = this.#formLists.get(formId);
    if (!list) {
      const record = await this.#db.get(formId);
      list =
        record?.type === 'FLST'
          ? record.fields
              .all('LNAM')
              .filter((data) => data.length >= 4)
              .map((data) => record.formIdAt(data))
          : [];
      this.#formLists.set(formId, list);
    }
    return list;
  }

  /** A colour form's RGB bytes. */
  async color(formId: number | undefined): Promise<Rgb | undefined> {
    if (formId === undefined) return undefined;
    if (!this.#colors.has(formId)) {
      const record = await this.#db.get(formId);
      const rgb = record?.type === 'CLFM' ? parseColor(record) : undefined;
      this.#colors.set(
        formId,
        rgb && [Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255)],
      );
    }
    return this.#colors.get(formId);
  }

  /** An actor base's face (a preset, or the Player record to start from). */
  async face(formId: number): Promise<NpcFace | undefined> {
    const record = await this.#db.get(formId);
    return record?.type === 'NPC_' ? parseNpcFace(record) : undefined;
  }

  /**
   * The head parts the menu offers for a race and sex, per HeadPartType in record order:
   * playable, of that sex, not an extra part, the race in its valid races (RNAM).
   * TODO(M13): verify the vanilla order of the lists.
   */
  async headPartLists(race: number, sex: 0 | 1): Promise<Map<number, number[]>> {
    const lists = new Map<number, number[]>();
    const sexFlag = sex === 0 ? HeadPartFlag.male : HeadPartFlag.female;
    for (const part of this.#headParts) {
      const { flags } = part;
      if (!(flags & HeadPartFlag.playable) || !(flags & sexFlag) || flags & HeadPartFlag.extraPart)
        continue;
      if (part.validRaces === undefined) continue;
      if (!(await this.#formList(part.validRaces)).includes(race)) continue;
      let list = lists.get(part.type);
      if (!list) lists.set(part.type, (list = []));
      list.push(part.formId);
    }
    return lists;
  }

  /** Everything the race menu's sliders need for a race and sex. */
  async raceData(raceId: number, sex: 0 | 1): Promise<ChargenRaceData> {
    const race = await this.race(raceId);
    if (!race) throw new Error(`Not a race: ${raceId.toString(16)}`);
    const head = race.sexes[sex];
    const morphRace = race.morphRace === undefined ? undefined : await this.race(race.morphRace);
    const presets: NpcFace[] = [];
    for (const formId of head.presets) {
      const face = await this.face(formId);
      if (face) presets.push(face);
    }
    const hairColors: ChargenColor[] = [];
    for (const formId of head.hairColors) {
      const rgb = await this.color(formId);
      if (rgb) hairColors.push({ formId, rgb });
    }
    const tintLayers: ChargenTintLayer[] = [];
    for (const layer of head.tintLayers) {
      const presetsOfLayer = [];
      for (const preset of layer.presets) {
        presetsOfLayer.push({ ...preset, rgb: (await this.color(preset.color)) ?? [0, 0, 0] });
      }
      tintLayers.push({
        ...layer,
        presets: presetsOfLayer,
        defaultRgb: await this.color(layer.defaultColor),
      });
    }
    const counts = [this.#counts.nose, this.#counts.brow, this.#counts.eyes, this.#counts.lips];
    return {
      race: raceId,
      editorId: race.editorId,
      name: race.name || race.editorId,
      description: race.description,
      sex,
      morphRace: morphRace?.editorId ?? race.editorId,
      defaultHeadParts: head.headParts,
      headPartLists: await this.headPartLists(raceId, sex),
      headPartTypes: this.#headPartTypes,
      presets,
      hairColors,
      defaultHairColor: race.defaultHairColor[sex],
      faceDetails: head.faceDetails,
      defaultFaceTexture: head.defaultFaceTexture,
      morphTypes: Object.values(MorphGroup).map((group) =>
        availableMorphTypes(head.morphTypes[group], counts[group] ?? 0),
      ),
      tintLayers,
    };
  }
}
