// What a placed actor looks like: its base (NPC_) resolved through templates and leveled
// lists, its race (skeleton, behavior project, size), the armor it wears with the addons that
// fit its race and the skin under it, which biped slots each piece owns, its FaceGen head and
// its colours. Platform-independent. Notes: docs/formats/esm.md ("Actors").

import { normalizePath } from '../formats/paths.ts';
import {
  type AddonModel,
  type ArmorAddonRecord,
  LeveledFlag,
  type LeveledList,
  NpcFlag,
  parseArmor,
  parseArmorAddon,
  parseColor,
  parseLeveledList,
  parseNpc,
  parseOutfit,
  parseRace,
  type NpcRecord,
  type RaceRecord,
  RaceFlag,
  TemplateFlag,
} from './actor-records.ts';
import type { RecordDatabase } from './record-db.ts';

/** An armor addon an actor wears. */
export interface WornAddon {
  readonly addon: number;
  /** The armor (ARMO) it comes with: an item of the outfit, or the skin. */
  readonly armor: number;
  readonly editorId: string;
  readonly model: AddonModel;
  /** _0 and _1 models blended by the actor's weight. */
  readonly weighted: boolean;
  /** The biped slots it covers (BOD2 flags). */
  readonly slots: number;
  readonly priority: number;
  /** The skin texture set for its skin shapes (TXST). */
  readonly skinTexture: number | undefined;
  /** Part of the actor's skin (the body under its armor). */
  readonly skin: boolean;
}

export interface ActorLook {
  /** The NPC_ placed (the reference's base). */
  readonly base: number;
  /** The NPC_ whose traits it shows (after templates and leveled lists). */
  readonly npc: number;
  readonly editorId: string;
  readonly female: boolean;
  readonly race: number;
  readonly raceEditorId: string;
  /** Skeleton model and behavior project (meshes\ paths). */
  readonly skeleton: string | undefined;
  readonly behavior: string | undefined;
  /** Race height times the actor's height multiplier. */
  readonly scale: number;
  /** 0..100: the blend of _0 and _1 models. */
  readonly weight: number;
  readonly skinTone: readonly [number, number, number] | undefined;
  readonly hairColor: readonly [number, number, number] | undefined;
  /** The FaceGen head (meshes\ and textures\ paths), for races with one. */
  readonly faceGen: { readonly geometry: string; readonly tint: string } | undefined;
  /** What it wears, armor first, then the skin under it. */
  readonly worn: readonly WornAddon[];
  /** The biped slots armor owns: slot → the addon that owns it. */
  readonly owners: ReadonlyMap<number, number>;
}

/** Templates and leveled lists nest; vanilla chains are a few levels deep. */
const MAX_DEPTH = 16;

/** A small deterministic generator (mulberry32): the same reference always looks the same. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks one entry of a leveled list for an actor or item of `level`: among the entries up to
 * that level, the highest level's (or, with "calculate from all levels", any of them), at
 * random; nothing for its chance of none. TODO(M13): the engine's exact draw (it is
 * documented only as "random among the eligible entries").
 */
export function pickLeveled(
  list: LeveledList,
  level: number,
  random: () => number,
): number | undefined {
  if (list.chanceNone > 0 && random() * 100 < list.chanceNone) return undefined;
  const eligible = list.entries.filter((entry) => entry.level <= level);
  if (eligible.length === 0) return undefined;
  const top = Math.max(...eligible.map((entry) => entry.level));
  const choices =
    (list.flags & LeveledFlag.allLevels) !== 0
      ? eligible
      : eligible.filter((entry) => entry.level === top);
  return choices[Math.floor(random() * choices.length)]?.formId;
}

/** The addons of an armor that fit a race (falling back to the race's armor race). */
export function addonsForRace(
  addons: readonly ArmorAddonRecord[],
  race: number,
  armorRace: number | undefined,
): ArmorAddonRecord[] {
  const fits = (addon: ArmorAddonRecord, id: number): boolean =>
    addon.race === id || addon.races.includes(id);
  const own = addons.filter((addon) => fits(addon, race));
  if (own.length > 0 || armorRace === undefined) return own;
  return addons.filter((addon) => fits(addon, armorRace));
}

/**
 * Which addon owns each biped slot: armor before skin, then the higher priority, then the
 * later piece. Returns slot → addon.
 */
export function slotOwners(worn: readonly WornAddon[]): Map<number, number> {
  const owners = new Map<number, WornAddon>();
  for (const addon of worn) {
    if (addon.skin) continue;
    for (let slot = 30; slot < 62; slot++) {
      if ((addon.slots & (2 ** (slot - 30))) === 0) continue;
      const current = owners.get(slot);
      if (!current || addon.priority >= current.priority) owners.set(slot, addon);
    }
  }
  return new Map([...owners].map(([slot, addon]) => [slot, addon.addon]));
}

/**
 * Whether a model's partition of `bodyPart` (BSDismemberSkinInstance) is drawn: hidden when its
 * slot (30-61; head parts 130-161 and 230-261 name the same slots) is owned by another piece.
 * `addon` is the piece the model belongs to (undefined: a head part).
 */
export function partitionVisible(
  bodyPart: number,
  owners: ReadonlyMap<number, number>,
  addon: number | undefined,
): boolean {
  const slot =
    bodyPart >= 230 && bodyPart < 262
      ? bodyPart - 200
      : bodyPart >= 130 && bodyPart < 162
        ? bodyPart - 100
        : bodyPart;
  const owner = owners.get(slot);
  return owner === undefined || owner === addon;
}

/** The lowest biped slot of a set of slot flags (61 for none). */
export function firstSlot(slots: number): number {
  for (let slot = 30; slot < 62; slot++) if ((slots & (2 ** (slot - 30))) !== 0) return slot;
  return 61;
}

/** Hex form id as FaceGen file names write it (8 digits). */
const faceGenId = (objectId: number): string =>
  objectId.toString(16).toUpperCase().padStart(8, '0');

/** Reads the records of an actor's look. */
export class ActorResolver {
  readonly #db: RecordDatabase;
  readonly #races = new Map<number, RaceRecord | undefined>();
  readonly #addons = new Map<number, ArmorAddonRecord | undefined>();

  constructor(db: RecordDatabase) {
    this.#db = db;
  }

  async #race(formId: number): Promise<RaceRecord | undefined> {
    if (!this.#races.has(formId)) {
      const record = await this.#db.get(formId);
      this.#races.set(formId, record?.type === 'RACE' ? parseRace(record) : undefined);
    }
    return this.#races.get(formId);
  }

  async #addon(formId: number): Promise<ArmorAddonRecord | undefined> {
    if (!this.#addons.has(formId)) {
      const record = await this.#db.get(formId);
      this.#addons.set(formId, record?.type === 'ARMA' ? parseArmorAddon(record) : undefined);
    }
    return this.#addons.get(formId);
  }

  /** An NPC_ (or a leveled list of them) down to one NPC_. */
  async #npc(
    formId: number,
    level: number,
    random: () => number,
    depth = 0,
  ): Promise<NpcRecord | undefined> {
    if (depth > MAX_DEPTH) return undefined;
    const record = await this.#db.get(formId);
    if (record?.type === 'NPC_') return parseNpc(record);
    if (record?.type === 'LVLN') {
      const picked = pickLeveled(parseLeveledList(record), level, random);
      return picked === undefined ? undefined : this.#npc(picked, level, random, depth + 1);
    }
    return undefined;
  }

  /** Follows the template chain while `flag` says to take that part from the template. */
  async #templated(
    npc: NpcRecord,
    flag: number,
    level: number,
    random: () => number,
  ): Promise<NpcRecord> {
    let current = npc;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if ((current.templateFlags & flag) === 0 || current.template === undefined) break;
      const next = await this.#npc(current.template, level, random);
      if (!next) break;
      current = next;
    }
    return current;
  }

  /** The armor items of an outfit (leveled items picked), in order. */
  async #outfit(formId: number, level: number, random: () => number): Promise<number[]> {
    const record = await this.#db.get(formId);
    if (record?.type !== 'OTFT') return [];
    const items: number[] = [];
    const add = async (item: number, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return;
      const entry = await this.#db.get(item);
      if (entry?.type === 'ARMO') {
        items.push(item);
      } else if (entry?.type === 'LVLI') {
        const list = parseLeveledList(entry);
        if ((list.flags & LeveledFlag.useAll) !== 0) {
          for (const e of list.entries) if (e.level <= level) await add(e.formId, depth + 1);
        } else {
          const picked = pickLeveled(list, level, random);
          if (picked !== undefined) await add(picked, depth + 1);
        }
      }
    };
    for (const item of parseOutfit(record)) await add(item, 0);
    return items;
  }

  /** The addons of an armor that fit the race, worn as `skin` or not. */
  async #wear(
    armorId: number,
    race: RaceRecord,
    female: boolean,
    skin: boolean,
  ): Promise<WornAddon[]> {
    let record = await this.#db.get(armorId);
    let armor = record?.type === 'ARMO' ? parseArmor(record) : undefined;
    // An armor without addons of its own takes its template's.
    for (
      let depth = 0;
      armor?.addons.length === 0 && armor.template !== undefined && depth < MAX_DEPTH;
      depth++
    ) {
      record = await this.#db.get(armor.template);
      armor = record?.type === 'ARMO' ? parseArmor(record) : undefined;
    }
    if (!armor) return [];
    const addons = (await Promise.all(armor.addons.map((id) => this.#addon(id)))).filter(
      (addon): addon is ArmorAddonRecord => addon !== undefined,
    );
    const sex = female ? 1 : 0;
    return addonsForRace(addons, race.formId, race.armorRace).flatMap((addon): WornAddon[] => {
      const model = addon.models[sex];
      if (!model) return [];
      return [
        {
          addon: addon.formId,
          armor: armorId,
          editorId: addon.editorId,
          model,
          weighted: addon.weighted[sex],
          slots: addon.slots,
          priority: addon.priority[sex],
          skinTexture: addon.skinTexture[sex],
          skin,
        },
      ];
    });
  }

  /**
   * The look of an actor placed with `base` (NPC_ or LVLN) by `reference` (whose form id
   * seeds the leveled choices), at `level` (the encounter's level; TODO(M11): encounter
   * zones and the player's level).
   */
  async resolve(base: number, reference: number, level = 1): Promise<ActorLook | undefined> {
    const random = seededRandom(reference ^ 0x9e3779b9);
    const placed = await this.#npc(base, level, random);
    if (!placed) return undefined;
    const traits = await this.#templated(placed, TemplateFlag.traits, level, random);
    const inventory = await this.#templated(placed, TemplateFlag.inventory, level, random);
    const race = traits.race === undefined ? undefined : await this.#race(traits.race);
    if (!race) return undefined;
    const female = (traits.flags & NpcFlag.female) !== 0;
    const sex = female ? 1 : 0;

    // Armor of the outfit, then the skin (the actor's own, or its race's).
    const items =
      inventory.outfit === undefined ? [] : await this.#outfit(inventory.outfit, level, random);
    const armor: WornAddon[] = [];
    for (const item of items) armor.push(...(await this.#wear(item, race, female, false)));
    const owners = slotOwners(armor);
    const skinId = traits.skin ?? race.skin;
    const skin = skinId === undefined ? [] : await this.#wear(skinId, race, female, true);
    // A piece hangs on its first slot: skin shows where armor leaves that slot free, armor
    // where no other piece took it (TODO(M13): the engine's biped slot assignment is not
    // documented; this matches every vanilla outfit's look).
    const bare = skin.filter((addon) => !owners.has(firstSlot(addon.slots)));
    const shown = armor.filter((addon) => owners.get(firstSlot(addon.slots)) === addon.addon);

    const hairColorId = traits.hairColor ?? race.hairColor[sex];
    const hairRecord = hairColorId === undefined ? undefined : await this.#db.get(hairColorId);
    let faceGen: ActorLook['faceGen'];
    if ((race.flags & RaceFlag.faceGenHead) !== 0) {
      const origin = this.#db.origin(traits.formId);
      if (origin) {
        const file = `${origin.plugin.entry.name.toLowerCase()}\\${faceGenId(origin.objectId)}`;
        faceGen = {
          geometry: `meshes\\actors\\character\\facegendata\\facegeom\\${file}.nif`,
          tint: `textures\\actors\\character\\facegendata\\facetint\\${file}.dds`,
        };
      }
    }
    const skeleton = race.skeleton[sex];
    const behavior = race.behavior[sex];
    return {
      base,
      npc: traits.formId,
      editorId: placed.editorId,
      female,
      race: race.formId,
      raceEditorId: race.editorId,
      skeleton: skeleton === undefined ? undefined : meshPath(skeleton),
      behavior: behavior === undefined ? undefined : meshPath(behavior),
      scale: race.height[sex] * traits.height,
      weight: traits.weight,
      skinTone: traits.skinTone,
      hairColor: hairRecord?.type === 'CLFM' ? parseColor(hairRecord) : undefined,
      faceGen,
      worn: [...shown, ...bare],
      owners,
    };
  }
}

/** A model path from a record (relative to meshes\) as a VFS path. */
export function meshPath(path: string): string {
  const normalized = normalizePath(path);
  return normalized.startsWith('meshes\\') ? normalized : `meshes\\${normalized}`;
}
