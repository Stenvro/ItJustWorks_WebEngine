// The player's look as the engine makes it (no FaceGen head is baked for the player): the race,
// sex, weight, head parts, hair colour, skin tone and complexion of GameState.playerAppearance
// (made from the Player record, NPC_ 0x7, when first needed), each head part shaped by the
// chargen morphs (its model's own positions plus its race, chargen and SkinnyMorph TRI morphs at
// the appearance's weights: src/gameplay/chargen-morphs.ts) and the face painted with the
// composite of its tint layers (one texture the face's FaceGen shader takes in slot 6, written
// again as the tints change). Made again cheaply while the race menu's sliders move: the
// models, morph files and tint masks are read once, a head part is baked again only when the
// weights of its own morphs change, and a tint change only writes the texture.
// Notes: docs/animation.md ("The player"), docs/ui.md ("Character creation").

import { parseDds } from '../formats/dds/dds.ts';
import { decodeDdsLevel } from '../formats/dds/decode.ts';
import { parseTri, type TriFile } from '../formats/nif/tri.ts';
import { ChargenCatalog, morphTypeCounts } from '../gameplay/chargen-catalog.ts';
import {
  appearanceFromNpc,
  chargenMorphWeights,
  composeFaceTint,
  faceTextureSlots,
  faceTintLayers,
  type ChargenRaceData,
  type PlayerAppearance,
  type TintCompositeLayer,
  type TintMask,
} from '../gameplay/chargen.ts';
import { bakeHeadPart, type HeadPartMorphs } from '../gameplay/chargen-morphs.ts';
import { partPositions, withPositions, type ModelTextureSwaps } from '../render/actor-model.ts';
import { rgbaMipChain } from '../render/mipmaps.ts';
import type { ModelData } from '../render/model-data.ts';
import type { GpuModel } from '../render/scene-renderer.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { HeadPartType } from '../world/actor-records.ts';
import type { ActorLook, HeadPartLook, LookOverrides } from '../world/actors.ts';
import { parseTextureSet } from '../world/decal.ts';
import { PLAYER_ACTOR, readPlayerBody, type PlayerBody } from '../world/player-body.ts';
import type { MadeLook } from './actors.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** The face tint's path among the textures (no file: the engine provides it). */
const FACE_TINT_PATH = 'textures\\engine\\player\\facetint.dds';
/** Its size: that of the baked face tints (facetint\<plugin>\<id>.dds, 512×512). */
const FACE_TINT_SIZE = 512;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The overrides of an appearance over the Player record, in the actor's race now. */
export function appearanceOverrides(
  appearance: PlayerAppearance,
  race: number = appearance.race,
): LookOverrides {
  return {
    race,
    female: appearance.sex === 1,
    weight: appearance.weight,
    headParts: appearance.headParts,
    hairColor: appearance.hairColor,
    skinTone: appearance.skinTone,
    faceTexture: appearance.complexion,
  };
}

export class PlayerLook {
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  #catalog: Promise<ChargenCatalog> | undefined;
  readonly #raceData = new Map<string, Promise<ChargenRaceData>>();
  readonly #bodies = new Map<string, Promise<PlayerBody>>();
  readonly #textureSets = new Map<number, Promise<readonly string[] | undefined>>();
  /** CPU data read for shaping and painting (let go of with `release`). */
  readonly #masks = new Map<string, Promise<TintMask | undefined>>();
  readonly #tris = new Map<string, Promise<TriFile | undefined>>();
  readonly #parts = new Map<string, Promise<ModelData | undefined>>();
  /** Shaped head part models by part, textures and the weights of the part's own morphs. */
  readonly #models = new Map<string, Promise<GpuModel | undefined>>();
  /** The last look (`made`'s build) each model was asked for by. */
  readonly #lastBuild = new Map<string, number>();
  #builds = 0;
  #tint: GPUTexture | undefined;
  /** What the tint shows (its layers), and the paint asked for last. */
  #painted: string | undefined;
  #paintTicket = 0;
  /** The appearance outside a running game (the sandbox before its scripts run). */
  #own: PlayerAppearance | undefined;

  constructor(session: GameSession, terminal: Terminal) {
    this.#session = session;
    this.#terminal = terminal;
  }

  /** The playable races and their character creation data, read once. */
  catalog(): Promise<ChargenCatalog> {
    this.#catalog ??= (async () => {
      const [db, settings] = await Promise.all([this.#session.db, this.#session.settings()]);
      return ChargenCatalog.open(
        db,
        morphTypeCounts((id) => settings.number(id)),
      );
    })();
    return this.#catalog;
  }

  /** What the race menu's sliders need for a race and sex, read once. */
  raceData(race: number, sex: 0 | 1): Promise<ChargenRaceData> {
    const key = `${String(race)}:${String(sex)}`;
    let entry = this.#raceData.get(key);
    if (!entry) {
      entry = this.catalog().then((catalog) => catalog.raceData(race, sex));
      entry.catch(() => this.#raceData.delete(key));
      this.#raceData.set(key, entry);
    }
    return entry;
  }

  /** The player's body (its height, its cameras' heights) in a race and sex, read once. */
  body(race: number, female: boolean): Promise<PlayerBody> {
    const key = `${String(race)}:${String(female)}`;
    let entry = this.#bodies.get(key);
    if (!entry) {
      entry = this.#session.db.then((db) =>
        readPlayerBody(db, (path) => this.#session.nif(path), { race, female }),
      );
      entry.catch(() => this.#bodies.delete(key));
      this.#bodies.set(key, entry);
    }
    return entry;
  }

  /**
   * The player's appearance: the running game's (GameState.playerAppearance), made from the
   * Player record the first time; undefined if the Player record has no race.
   */
  async appearance(): Promise<PlayerAppearance | undefined> {
    const runtime = this.#session.scriptsReady;
    const stored = runtime ? runtime.state.playerAppearance : this.#own;
    if (stored) return stored;
    const catalog = await this.catalog();
    const face = await catalog.face(PLAYER_ACTOR);
    if (face?.race === undefined) return undefined;
    const made = appearanceFromNpc(await this.raceData(face.race, face.female ? 1 : 0), face);
    // Made meanwhile (a menu's choice) stays.
    if (runtime) return (runtime.state.playerAppearance ??= made);
    return (this.#own ??= made);
  }

  /** Sets the player's appearance (the race menu's choices). */
  setAppearance(appearance: PlayerAppearance): void {
    const runtime = this.#session.scriptsReady;
    if (runtime) runtime.state.playerAppearance = appearance;
    else this.#own = appearance;
  }

  /** The race the player is in now: Actor.SetRace's, else the appearance's. */
  currentRace(appearance: PlayerAppearance): number {
    return this.#session.scriptsReady?.state.actors.get(PLAYER_REF)?.race ?? appearance.race;
  }

  /**
   * The player's look as the engine makes it, for the actor placer; `build` counts the looks
   * made (`keep` lets go of the models of earlier ones).
   */
  async made(): Promise<(MadeLook & { readonly build: number }) | undefined> {
    const appearance = await this.appearance();
    if (!appearance) return undefined;
    const build = ++this.#builds;
    return {
      overrides: appearanceOverrides(appearance, this.currentRace(appearance)),
      build,
      heads: (look) => this.#heads(look, appearance, build),
    };
  }

  /** The head part models of a look, shaped and painted for the appearance. */
  async #heads(
    look: ActorLook,
    appearance: PlayerAppearance,
    build: number,
  ): Promise<{ readonly model: GpuModel; readonly part: HeadPartLook }[]> {
    // The face tint exists before a face's material names it.
    this.#tintTexture();
    const painting = this.paint(appearance);
    const sex = look.female ? 1 : 0;
    const data = await this.raceData(look.race, sex).catch(() => undefined);
    // The head is shaped by the race's morph race (NAM8: a vampire race takes its race's).
    const weights = chargenMorphWeights(appearance, data?.morphRace ?? look.raceEditorId);
    const parts = await Promise.all(
      look.headParts.map(async (part) => {
        const model = await this.#headPart(part, weights, build);
        return model && { model, part };
      }),
    );
    await painting;
    return parts.filter((entry) => entry !== undefined);
  }

  /** One head part, its shape baked in for the weights of its own morphs (made once each). */
  async #headPart(
    part: HeadPartLook,
    weights: ReadonlyMap<string, number>,
    build: number,
  ): Promise<GpuModel | undefined> {
    const session = this.#session;
    if (!session.vfs.has(part.model)) return undefined;
    const textures =
      part.textureSet === undefined ? undefined : await this.#textureSet(part.textureSet);
    // The face: its complexion in the FaceGen shader's slots, the face tint in slot 6.
    const swaps: ModelTextureSwaps =
      part.type === HeadPartType.face
        ? { all: faceTextureSlots(textures ?? [], FACE_TINT_PATH) }
        : textures
          ? { all: textures }
          : {};
    const [data, race, chargen, expressions] = await Promise.all([
      this.#modelData(part.model, swaps),
      this.#tri(part.raceMorph),
      this.#tri(part.chargenMorph),
      this.#tri(part.expressions),
    ]);
    if (!data) return undefined;
    const morphs: HeadPartMorphs = { race, chargen, expressions };
    const own = new Set(
      [race, chargen, expressions].flatMap((file) =>
        (file?.morphs ?? []).map((morph) => morph.name.toLowerCase()),
      ),
    );
    const shape = [...weights]
      .filter(([name]) => own.has(name))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, weight]) => `${name}=${weight.toFixed(4)}`)
      .join(',');
    const key = `${part.model}|${JSON.stringify(swaps)}|${shape}`;
    this.#lastBuild.set(key, Math.max(build, this.#lastBuild.get(key) ?? 0));
    let entry = this.#models.get(key);
    if (!entry) {
      const parts = data.parts.map((modelPart) => {
        const fits = [race, chargen, expressions].some(
          (file) => file?.vertexCount === modelPart.vertexCount,
        );
        if (!fits) return modelPart;
        const baked = bakeHeadPart(partPositions(modelPart), 3, morphs, weights);
        return withPositions(modelPart, baked);
      });
      entry = session.renderer.scene
        .createModel({ ...data, parts }, session.textures)
        .catch((error: unknown) => {
          this.#terminal.log('actor', `${part.editorId}: ${describe(error)}`, 'warn');
          return undefined;
        });
      this.#models.set(key, entry);
    }
    return entry;
  }

  /**
   * Paints the face tint for an appearance (its tint layers composited over the race's masks):
   * the face already drawn shows it at once.
   */
  async paint(appearance: PlayerAppearance): Promise<void> {
    const ticket = ++this.#paintTicket;
    const data = await this.raceData(appearance.race, appearance.sex);
    const layers = faceTintLayers(data, appearance);
    const key = JSON.stringify(layers);
    if (key === this.#painted) return;
    const masks = await Promise.all(layers.map((layer) => this.#mask(layer.mask)));
    // A later paint asked for meanwhile wins.
    if (ticket !== this.#paintTicket) return;
    const composite: TintCompositeLayer[] = [];
    layers.forEach((layer, i) => {
      const mask = masks[i];
      if (mask) composite.push({ mask, color: layer.color, value: layer.value });
    });
    const pixels = composeFaceTint(composite, FACE_TINT_SIZE, FACE_TINT_SIZE);
    const texture = this.#tintTexture();
    const scene = this.#session.renderer.scene;
    rgbaMipChain(pixels, FACE_TINT_SIZE, FACE_TINT_SIZE).forEach((level, mip) => {
      scene.writePixels(texture, mip, level.width, level.height, level.data);
    });
    this.#painted = key;
  }

  /** The face tint texture, provided to the textures under its path (made once). */
  #tintTexture(): GPUTexture {
    if (!this.#tint) {
      const levels = Math.floor(Math.log2(FACE_TINT_SIZE)) + 1;
      this.#tint = this.#session.renderer.scene.createPixelTexture(
        FACE_TINT_SIZE,
        FACE_TINT_SIZE,
        levels,
        'player face tint',
      );
      this.#session.textures.provide(FACE_TINT_PATH, this.#tint);
      this.#painted = undefined;
    }
    return this.#tint;
  }

  /** A head part's model with its textures, read once. */
  #modelData(path: string, swaps: ModelTextureSwaps): Promise<ModelData | undefined> {
    const key = `${path}|${JSON.stringify(swaps)}`;
    let entry = this.#parts.get(key);
    if (!entry) {
      entry = this.#session.loader.loadActorPart(path, undefined, 100, swaps).then(
        ({ model, problems }) => {
          for (const problem of problems) this.#terminal.log('nif', `${path}: ${problem}`, 'warn');
          return model;
        },
        (error: unknown) => {
          this.#terminal.log('nif', `${path}: ${describe(error)}`, 'warn');
          return undefined;
        },
      );
      this.#parts.set(key, entry);
    }
    return entry;
  }

  /** A TRI file, read once (undefined: none, missing or broken). */
  #tri(path: string | undefined): Promise<TriFile | undefined> {
    if (path === undefined || !this.#session.vfs.has(path)) return Promise.resolve(undefined);
    let entry = this.#tris.get(path);
    if (!entry) {
      entry = this.#session.vfs
        .read(path)
        .then((bytes): TriFile | undefined => parseTri(bytes))
        .catch((error: unknown) => {
          this.#terminal.log('tri', `${path}: ${describe(error)}`, 'warn');
          return undefined;
        });
      this.#tris.set(path, entry);
    }
    return entry;
  }

  /** A tint mask decoded to RGBA8 (its red channel is the coverage), read once. */
  #mask(path: string): Promise<TintMask | undefined> {
    let entry = this.#masks.get(path);
    if (!entry) {
      entry = (async () => {
        if (!this.#session.vfs.has(path)) return undefined;
        const dds = parseDds(await this.#session.vfs.read(path));
        const level = dds.levels[0];
        if (!level) return undefined;
        return { data: decodeDdsLevel(dds, level), width: level.width, height: level.height };
      })().catch((error: unknown) => {
        this.#terminal.log('dds', `${path}: ${describe(error)}`, 'warn');
        return undefined;
      });
      this.#masks.set(path, entry);
    }
    return entry;
  }

  /** A texture set's textures (TX00..TX07), read once. */
  #textureSet(formId: number): Promise<readonly string[] | undefined> {
    let entry = this.#textureSets.get(formId);
    if (!entry) {
      entry = this.#session.db
        .then((db) => db.get(formId))
        .then((record) => (record?.type === 'TXST' ? parseTextureSet(record).textures : undefined));
      this.#textureSets.set(formId, entry);
    }
    return entry;
  }

  /**
   * The head part models in use now (the player's body as drawn, made by look `build`): those
   * made for earlier looks are destroyed once no scene draws them.
   */
  keep(models: Iterable<GpuModel>, build: number): void {
    const used = new Set(models);
    for (const [key, entry] of this.#models) {
      void entry.then((model) => {
        // Kept: drawn by this look, asked for by a later one (being made), drawn by a scene
        // still (another viewer's body until it goes).
        if (!model || used.has(model) || this.#models.get(key) !== entry) return;
        if ((this.#lastBuild.get(key) ?? 0) > build || model.users > 0) return;
        this.#models.delete(key);
        this.#lastBuild.delete(key);
        model.destroy();
      });
    }
  }

  /** Lets go of what shaping and painting read (the race menu closed): read again if needed. */
  release(): void {
    this.#masks.clear();
    this.#tris.clear();
    this.#parts.clear();
  }

  dispose(): void {
    for (const entry of this.#models.values()) void entry.then((model) => model?.destroy());
    this.#models.clear();
    this.release();
    if (this.#tint) {
      this.#session.textures.withdraw(FACE_TINT_PATH);
      this.#tint.destroy();
      this.#tint = undefined;
    }
  }
}
