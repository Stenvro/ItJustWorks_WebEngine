// What a placed actor looks like: its base (NPC_) resolved through templates and leveled
// lists, its race (skeleton, behavior project, size), the armor it wears with the addons that
// fit its race and the skin under it, which biped slots each piece owns, its FaceGen head and
// its colours. Platform-independent. Notes: docs/formats/esm.md ("Actors").

import { normalizePath } from '../formats/paths.ts';
import {
  type AddonModel,
  type ArmorAddonRecord,
  BipedSlot,
  HeadPartFile,
  type HeadPartRecord,
  HeadPartType,
  LeveledFlag,
  NpcFlag,
  parseArmor,
  parseArmorAddon,
  parseColor,
  parseLeveledList,
  parseNpc,
  parseHeadPart,
  parseOutfit,
  parseRace,
  type NpcRecord,
  type RaceRecord,
  RaceFlag,
  TemplateFlag,
} from './actor-records.ts';
import { resolveActorTemplates } from './actor-templates.ts';
import { pickLeveled, seededRandom } from './leveled.ts';
import type { RecordDatabase } from './record-db.ts';

export { pickLeveled, seededRandom } from './leveled.ts';

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
  /** ARMA DNAM: how far it pushes sheathed weapons out. */
  readonly weaponAdjust: number;
  /** ARMA SNDD: the footstep set (FSTS) of what it covers. */
  readonly footstepSet: number | undefined;
}

/** A head part an actor's head is made of (where no FaceGen head was baked for it). */
export interface HeadPartLook {
  readonly editorId: string;
  /** HDPT PNAM (HeadPartType). */
  readonly type: number;
  /** Its model (meshes\ path). */
  readonly model: string;
  /** The texture set on its shapes (the face's: the NPC's FTST, else the race's default). */
  readonly textureSet: number | undefined;
  /** Its expression TRI (meshes\ path). */
  readonly expressions: string | undefined;
  /** Its race morph and chargen morph TRIs (meshes\ paths), which shape a head made at run time. */
  readonly raceMorph: string | undefined;
  readonly chargenMorph: string | undefined;
}

/**
 * What an actor's base says of its look, put another way (the player's: what the race menu
 * chose, GameState.playerAppearance; an actor's race changed by Actor.SetRace).
 */
export interface LookOverrides {
  readonly race?: number;
  readonly female?: boolean;
  /** 0..100. */
  readonly weight?: number;
  /** Its own head parts (PNAM): the race's defaults fill the other types. */
  readonly headParts?: readonly number[];
  /** HCLF: a colour form (CLFM). */
  readonly hairColor?: number;
  /** QNAM: 0..1 RGB. */
  readonly skinTone?: readonly [number, number, number];
  /** FTST: the face's texture set. */
  readonly faceTexture?: number;
  /**
   * The outfit worn instead of the record's (Actor.SetOutfit); null: none (the player, who
   * wears what is equipped).
   */
  readonly outfit?: number | null;
  /** Armor equipped in the game (EquipItem, the inventory): it takes its slots first. */
  readonly equipped?: readonly number[];
}

export interface ActorLook {
  /** The NPC_ placed (the reference's base). */
  readonly base: number;
  /** The NPC_ whose traits it shows (after templates and leveled lists). */
  readonly npc: number;
  readonly editorId: string;
  /** Its name (FULL of the NPC_ its base data comes from). */
  readonly name: string;
  /** Its voice type's editor id (the folder of its lines under sound\voice\<plugin>\). */
  readonly voiceType: string | undefined;
  readonly female: boolean;
  readonly race: number;
  readonly raceEditorId: string;
  /** Its race's DATA flags (RaceFlag): whether it walks, swims, flies, tilts with the ground. */
  readonly raceFlags: number;
  /** Skeleton model and behavior project (meshes\ paths). */
  readonly skeleton: string | undefined;
  readonly behavior: string | undefined;
  /** Race height times the actor's height multiplier. */
  readonly scale: number;
  /** 0..100: the blend of _0 and _1 models. */
  readonly weight: number;
  readonly skinTone: readonly [number, number, number] | undefined;
  readonly hairColor: readonly [number, number, number] | undefined;
  /**
   * The FaceGen head (meshes\ and textures\ paths), for races with one; `expressions`: the
   * expression TRI file of each head part by its shape's lower-case name (the head part's
   * editor id), for phonemes, blinks and moods.
   */
  readonly faceGen:
    | {
        readonly geometry: string;
        readonly tint: string;
        readonly expressions: ReadonlyMap<string, string>;
      }
    | undefined;
  /**
   * The head parts its head is made of: race defaults, replaced by its own of the same type,
   * and the parts they bring along. The engine builds the head from them where no FaceGen
   * head was baked (the player's, made at run time).
   */
  readonly headParts: readonly HeadPartLook[];
  /** What it wears, armor first, then the skin under it. */
  readonly worn: readonly WornAddon[];
  /** The biped slots armor owns: slot → the addon that owns it. */
  readonly owners: ReadonlyMap<number, number>;
  /**
   * The behavior variable weapAdj: the weapon adjust of what covers its body (slot 32). Only
   * body pieces vary it in the data (0.1 to 0.65; helmets and the rest are 0 or 1), so the
   * engine is taken to read the cuirass's (TODO(M13): not documented).
   */
  readonly weaponAdjust: number;
  /**
   * Its footsteps (FSTS): those of what it wears on its feet (slot 37), else of any piece it
   * wears with a footstep set (creatures' skins cover their whole body). TODO(M13): the
   * engine's choice is not documented.
   */
  readonly footstepSet: number | undefined;
  /** Its AI packages (PACK), of the NPC_ its templates give them from. */
  readonly packages: readonly number[];
  /** Its factions and ranks, of the NPC_ its templates give them from. */
  readonly factions: ReadonlyMap<number, number>;
}

/** The footstep set of what an actor wears: on its feet first, else any with one. */
function footstepSetOf(worn: readonly WornAddon[]): number | undefined {
  const feet = 2 ** (BipedSlot.feet - 30);
  return (
    worn.find((addon) => (addon.slots & feet) !== 0 && addon.footstepSet !== undefined)
      ?.footstepSet ?? worn.find((addon) => addon.footstepSet !== undefined)?.footstepSet
  );
}

/** Templates and leveled lists nest; vanilla chains are a few levels deep. */
const MAX_DEPTH = 16;

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
  readonly #headParts = new Map<number, HeadPartRecord | undefined>();

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

  async #headPart(formId: number): Promise<HeadPartRecord | undefined> {
    if (!this.#headParts.has(formId)) {
      const record = await this.#db.get(formId);
      this.#headParts.set(formId, record?.type === 'HDPT' ? parseHeadPart(record) : undefined);
    }
    return this.#headParts.get(formId);
  }

  /**
   * The expression TRI files of an NPC's head parts (its own, its race's and the parts they
   * bring along) by lower-case editor id: the FaceGen head's shapes are named after them.
   */
  async #expressions(parts: readonly number[]): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const queue = [...parts];
    const seen = new Set<number>();
    for (let formId = queue.shift(); formId !== undefined; formId = queue.shift()) {
      if (seen.has(formId)) continue;
      seen.add(formId);
      const part = await this.#headPart(formId);
      if (!part) continue;
      queue.push(...part.extraParts);
      const tri = part.files.find((file) => file.type === HeadPartFile.tri);
      if (tri) files.set(part.editorId.toLowerCase(), meshPath(tri.path));
    }
    return files;
  }

  /**
   * The head parts of an NPC: its race's defaults with those of a type it has its own of
   * replaced, then the extra parts each brings (HNAM), each once.
   */
  async #headPartLooks(
    own: readonly number[],
    defaults: readonly number[],
    faceTexture: number | undefined,
  ): Promise<HeadPartLook[]> {
    const parts = (ids: readonly number[]) => Promise.all(ids.map((id) => this.#headPart(id)));
    const mine = (await parts(own)).filter((part) => part !== undefined);
    const types = new Set(mine.map((part) => part.type));
    const base = (await parts(defaults)).filter(
      (part) => part !== undefined && !types.has(part.type),
    );
    const looks: HeadPartLook[] = [];
    const seen = new Set<number>();
    const queue = [...base, ...mine].filter((part) => part !== undefined);
    for (let part = queue.shift(); part; part = queue.shift()) {
      if (seen.has(part.formId)) continue;
      seen.add(part.formId);
      for (const extra of await parts(part.extraParts)) if (extra) queue.push(extra);
      if (!part.model) continue;
      const file = (type: number): string | undefined => {
        const found = part.files.find((entry) => entry.type === type);
        return found && meshPath(found.path);
      };
      looks.push({
        editorId: part.editorId,
        type: part.type,
        model: meshPath(part.model),
        textureSet:
          part.type === HeadPartType.face ? (faceTexture ?? part.textureSet) : part.textureSet,
        expressions: file(HeadPartFile.tri),
        raceMorph: file(HeadPartFile.raceMorph),
        chargenMorph: file(HeadPartFile.chargenMorph),
      });
    }
    return looks;
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
          weaponAdjust: addon.weaponAdjust,
          footstepSet: addon.footstepSet,
        },
      ];
    });
  }

  /**
   * The look of an actor placed with `base` (NPC_ or LVLN) by `reference` (whose form id
   * seeds the leveled choices), at `level` (the encounter's level; TODO(M11): encounter
   * zones and the player's level), with `overrides` over its base's traits.
   */
  async resolve(
    base: number,
    reference: number,
    level = 1,
    overrides: LookOverrides = {},
  ): Promise<ActorLook | undefined> {
    const templates = await resolveActorTemplates((id) => this.#db.get(id), base, reference, level);
    if (!templates) return undefined;
    const npc = async (formId: number): Promise<NpcRecord | undefined> => {
      const record = await this.#db.get(formId);
      return record?.type === 'NPC_' ? parseNpc(record) : undefined;
    };
    const own = await npc(templates.part(TemplateFlag.traits));
    const inventory = await npc(templates.part(TemplateFlag.inventory));
    if (!own || !inventory) return undefined;
    const traits = withOverrides(own, overrides);
    // Outfits' leveled items: the actor's own draws, after its templates'.
    const random = seededRandom(reference ^ 0x5bd1e995);
    const race = traits.race === undefined ? undefined : await this.#race(traits.race);
    if (!race) return undefined;
    const female = (traits.flags & NpcFlag.female) !== 0;
    const sex = female ? 1 : 0;

    // Armor equipped in the game, the outfit's, then the skin (the actor's own, or its race's).
    const outfit =
      overrides.outfit === undefined ? inventory.outfit : (overrides.outfit ?? undefined);
    const items = [
      ...new Set([
        ...(overrides.equipped ?? []),
        ...(outfit === undefined ? [] : await this.#outfit(outfit, level, random)),
      ]),
    ];
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
          expressions: await this.#expressions([...traits.headParts, ...race.headParts[sex]]),
        };
      }
    }
    const skeleton = race.skeleton[sex];
    const behavior = race.behavior[sex];
    const name = (await this.#db.get(templates.part(TemplateFlag.baseData)))?.text('FULL') ?? '';
    const voice = traits.voiceType === undefined ? undefined : await this.#db.get(traits.voiceType);
    const ai = await npc(templates.part(TemplateFlag.aiPackages));
    const factions = await npc(templates.part(TemplateFlag.factions));
    return {
      base,
      npc: traits.formId,
      editorId: (await this.#db.get(templates.placed))?.editorId ?? '',
      name,
      voiceType: voice?.type === 'VTYP' ? voice.editorId : undefined,
      female,
      race: race.formId,
      raceEditorId: race.editorId,
      raceFlags: race.flags,
      skeleton: skeleton === undefined ? undefined : meshPath(skeleton),
      behavior: behavior === undefined ? undefined : meshPath(behavior),
      scale: race.height[sex] * traits.height,
      weight: traits.weight,
      skinTone: traits.skinTone,
      hairColor: hairRecord?.type === 'CLFM' ? parseColor(hairRecord) : undefined,
      faceGen,
      headParts: await this.#headPartLooks(
        traits.headParts,
        race.headParts[sex],
        traits.faceTexture ?? race.faceTexture[sex],
      ),
      worn: [...shown, ...bare],
      owners,
      weaponAdjust:
        [...shown, ...bare].find((addon) => firstSlot(addon.slots) === BipedSlot.body)
          ?.weaponAdjust ?? 0,
      footstepSet: footstepSetOf([...shown, ...bare]),
      packages: ai?.packages ?? [],
      factions: factions?.factions ?? new Map<number, number>(),
    };
  }
}

/** An NPC_'s traits with a look's overrides put in. */
export function withOverrides(traits: NpcRecord, overrides: LookOverrides): NpcRecord {
  const { female } = overrides;
  return {
    ...traits,
    flags:
      female === undefined
        ? traits.flags
        : female
          ? traits.flags | NpcFlag.female
          : traits.flags & ~NpcFlag.female,
    race: overrides.race ?? traits.race,
    weight: overrides.weight ?? traits.weight,
    headParts: overrides.headParts ?? traits.headParts,
    hairColor: overrides.hairColor ?? traits.hairColor,
    skinTone: overrides.skinTone ?? traits.skinTone,
    faceTexture: overrides.faceTexture ?? traits.faceTexture,
  };
}

/** A model path from a record (relative to meshes\) as a VFS path. */
export function meshPath(path: string): string {
  const normalized = normalizePath(path);
  return normalized.startsWith('meshes\\') ? normalized : `meshes\\${normalized}`;
}
