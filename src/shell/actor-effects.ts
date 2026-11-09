// What magic shows on actors (docs/gameplay.md, "Magic effects"): a magic effect's hit shader
// (EFSH) and hit art (ARTO) on its target as it takes hold, while it lasts with FX Persist (else
// their own time once), its light (a Light effect's LIGH: Candlelight's ball over the shoulder);
// Detect Life's shader on the living within its area in feet that its conditions pick
// (friends and enemies: the Detect Life spells' variants), seen through walls (its particles'
// z test); scripts' EffectShader.Play and VisualEffect.Play (RFCT: art and shader).
// They show on any reference, not only actors: a script's shader or visual effect on an object
// covers its model's shapes (its particles off its rigid shapes, its art at its origin), and an
// enchanted item glows (src/gameplay/magic/enchantment-glow.ts): a held weapon's model while it
// is equipped, an item lying in the world.
//
// An effect shader is its membrane (the actor's shapes again with the fill texture in its
// colour keys, and its edge: a second cover whose opacity grows towards the silhouette), each
// with its alpha timeline (fade in, full, fade out to a persistent share, pulsing), the fill
// texture scrolling; and its particles off the actor's skin (src/shell/surface-particles.ts).
// Art objects hang on the actor's skeleton: their nodes and skinned shapes follow its bones by
// name; on a held weapon at the weapon's root, where its hand (or sheath) node holds it
// (src/gameplay/magic/effect-placement.ts). A visual effect's (RFCT) art with Face Target turns
// towards the reference VisualEffect.Play names to face, one with Attach To Camera hangs at the
// camera (turning with it with Inherit Rotation). The fill follows its colour keys over the
// shader's age, the keys' times taken as seconds as its alpha timeline's are (TODO(M13): inferred,
// no document says what the times count). A shader with a holes texture (NAM7) cuts its target
// away by its holes threshold over its holes times (holesShare: dithered as a distance fade is,
// TODO(M13): the texture's own pattern and edge); its addon models (DEBR) hang on the target's
// bones while it plays, fading and scaling by its addon times (addonLook).

import { ActorPose, ActorSkeleton, wearOnRig } from '../animation/skeleton.ts';
import type { Vec3 } from '../render/math.ts';
import type { ModelAnimation } from '../render/animation.ts';
import { identity, multiply, type Mat4 } from '../render/math.ts';
import type { EffectMaterial, ModelPart } from '../render/model-data.ts';
import type { RenderPort } from '../render/render-port.ts';
import type {
  GpuModel,
  GpuScene,
  InstanceFade,
  InstanceMotion,
  InstanceVisibility,
  ModelInstance,
} from '../render/scene-renderer.ts';
import {
  cameraWorld,
  facingWorld,
  heldAnchor,
  spreadOver,
} from '../gameplay/magic/effect-placement.ts';
import { parseDebris } from '../world/destruction-records.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { MagicEffectShown } from '../scripting/runtime/magic-engine.ts';
import { meshPath, seededRandom } from '../world/actors.ts';
import type { CellLight } from '../world/cell-loader.ts';
import { parseLight, type LightRecord } from '../world/cell-records.ts';
import {
  addonLook,
  EffectShaderFlag,
  fillColor,
  holesShare,
  parseEffectShader,
  timelineAlpha,
  type EffectShaderRecord,
} from '../world/effect-shader-records.ts';
import type { EnchantmentGlow } from '../gameplay/magic/enchantment-glow.ts';
import { EffectArchetype, parseVisualEffect, VisualEffectFlag } from '../world/magic-effects.ts';
import { parseArtObject } from '../world/magic-records.ts';
import type { GameSession } from './game-session.ts';
import { alphaFlags, SurfaceParticles, texturePath, Z_TEST_ALWAYS } from './surface-particles.ts';
import type { Terminal } from './terminal.ts';

/**
 * What effects cover: an actor's body (its instances and pose), an object's model (no pose), a
 * held weapon's model (the weapons' own pose).
 */
export interface EffectShape {
  readonly instances: readonly ModelInstance[];
  readonly pose?: ActorPose | undefined;
}

/** A reference as the effects see it: its shapes and whether it is shown. */
export interface EffectBody {
  readonly placed: EffectShape;
  readonly visibility?: InstanceVisibility;
}

/** Where a body is: its first shape's placement (where it was last while it is not shown). */
function followBody(body: () => EffectBody | undefined): () => Vec3 {
  let last: Vec3 = [0, 0, 0];
  return () => {
    const world = body()?.placed.instances[0]?.world;
    if (world) last = [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
    return last;
  };
}

/** The same body as when built (an actor made again, an object reloaded: not). */
const sameShape = (a: EffectShape, b: EffectShape): boolean =>
  a === b || (a.instances[0] !== undefined && a.instances[0] === b.instances[0]);

export interface ActorEffectsOptions {
  readonly session: GameSession;
  readonly renderer: RenderPort;
  readonly terminal: Terminal;
  /** An actor's body (a staged actor's, the player's avatar's), if it is shown. */
  readonly body: (actor: number) => EffectBody | undefined;
  /** The living actors of the loaded area and where their feet are (the player too). */
  readonly living: () => Iterable<{ readonly reference: number; readonly feet: Vec3 }>;
}

/** An effect shader on a reference. */
interface ShaderShow {
  readonly actor: number;
  /** What it covers now (undefined: not shown). */
  readonly body: () => EffectBody | undefined;
  readonly shader: EffectShaderRecord;
  /** Seconds since it began, and since it was told to stop (undefined: on). */
  age: number;
  stopping: number | undefined;
  /** Seconds it plays (undefined: until told to stop). */
  readonly duration: number | undefined;
  built: BuiltShader | undefined;
  building: boolean;
  /** Its ambient sound (EFSH DATA), looping at the body while it plays. */
  sound: Promise<{ stop(immediately?: boolean): void } | undefined> | undefined;
}

interface BuiltShader {
  readonly placed: EffectShape;
  readonly fill: GpuScene | undefined;
  readonly edge: GpuScene | undefined;
  readonly particles:
    { readonly scene: GpuScene | undefined; readonly source: SurfaceParticles } | undefined;
  readonly models: readonly GpuModel[];
  readonly sources: readonly GpuModel[];
  /** Its addon models (DEBR), each on a bone of the body (-1: at its origin). */
  readonly addons: BuiltAddons | undefined;
}

interface BuiltAddons {
  readonly scene: GpuScene | undefined;
  readonly fade: InstanceFade;
  readonly hung: readonly {
    readonly world: Float32Array;
    readonly motion: InstanceMotion;
    readonly node: number;
  }[];
}

/** How a visual effect's (RFCT) art stands, by its flags. */
interface ArtPlace {
  /** Face Target: turned towards this reference (VisualEffect.Play's facing object). */
  readonly facing: number | undefined;
  /** Attach To Camera, and Inherit Rotation. */
  readonly camera: boolean;
  readonly inheritRotation: boolean;
}

/** An art object on a reference. */
interface ArtShow {
  readonly actor: number;
  readonly body: () => EffectBody | undefined;
  readonly model: string;
  readonly place: ArtPlace | undefined;
  age: number;
  readonly duration: number | undefined;
  stopping: boolean;
  built:
    | {
        readonly placed: EffectShape;
        readonly scene: GpuScene | undefined;
        readonly pose: ActorPose;
        readonly nodes: Int16Array;
        /**
         * Placed by the effects each frame (faced, at the camera, on a held weapon): its own
         * world and motion, and the held weapon's node it hangs at.
         */
        readonly own:
          | {
              readonly world: Float32Array;
              readonly motion: InstanceMotion;
              readonly anchor: number | undefined;
            }
          | undefined;
      }
    | undefined;
  building: boolean;
}

/** A light on an actor (above its head and to the side, as Candlelight's ball floats). */
interface LightShow {
  readonly actor: number;
  readonly light: LightRecord;
}

/** Detect Life on its caster: whom it shows. */
interface DetectShow {
  readonly key: string;
  readonly caster: number;
  /** Its active effect (the magic system's key): its conditions pick whom it shows. */
  readonly effect: string;
  readonly shader: number;
  /** Units. */
  readonly radius: number;
  readonly shown: Set<number>;
  wait: number;
}

/** Seconds an effect shader or art without FX Persist and without a timeline shows at most. */
const ONCE_SECONDS = 2;
/** How often Detect Life looks for the living near (seconds). */
const DETECT_SECONDS = 0.5;
/**
 * Where an effect's light floats from its actor's feet (Candlelight: over the right shoulder).
 * The engine registers fMagicLightForwardOffset, ...SideOffset and ...HeightOffset but never
 * reads them (original). TODO(M13): where the engine's Light effect hangs its light.
 */
const LIGHT_OFFSET: Vec3 = [24, -16, 150];
const UNITS_PER_FOOT = 21.333;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ActorEffects {
  readonly #options: ActorEffectsOptions;
  readonly #shaders = new Map<string, ShaderShow>();
  readonly #arts = new Map<string, ArtShow>();
  readonly #lights = new Map<string, LightShow>();
  readonly #detects = new Map<string, DetectShow>();
  readonly #shaderRecords = new Map<number, Promise<EffectShaderRecord | undefined>>();
  readonly #lightRecords = new Map<number, Promise<LightRecord | undefined>>();
  /** The objects' fades the holes veil now (#holeObjects). */
  #holed = new Set<InstanceFade>();

  constructor(options: ActorEffectsOptions) {
    this.#options = options;
  }

  // --- What starts and stops them ---------------------------------------------------------

  /** A magic effect begins or ends on an actor (the magic system's WorldBridge.magicEffect). */
  effect(shown: MagicEffectShown, body?: () => EffectBody | undefined): void {
    const key = `effect:${shown.key}`;
    if (shown.event === 'stop') {
      this.#stop(key);
      this.#stop(`${key}:visuals`);
      return;
    }
    // Its visuals last while it does with FX Persist, else their own time once.
    const lasting = shown.persist ? undefined : 0;
    if (shown.shader !== undefined && shown.archetype !== EffectArchetype.detectLife)
      void this.#startShader(key, shown.target, shown.shader, lasting, body);
    if (shown.art !== undefined) this.#startArt(key, shown.target, shown.art, lasting, body);
    if (shown.visuals !== undefined)
      this.#startVisuals(`${key}:visuals`, shown.target, shown.visuals, lasting, body);
    if (shown.light !== undefined) void this.#startLight(key, shown.target, shown.light);
    if (shown.archetype === EffectArchetype.detectLife && shown.shader !== undefined) {
      this.#detects.set(key, {
        key,
        caster: shown.target,
        effect: shown.key,
        shader: shown.shader,
        radius: shown.area * UNITS_PER_FOOT,
        shown: new Set(),
        wait: 0,
      });
    }
  }

  /** EffectShader.Play (seconds; −1: until Stop) and Stop on an actor. */
  shader(shader: number, target: number, play: boolean, duration: number): void {
    const key = `script:${String(shader)}:${String(target)}`;
    if (!play) {
      this.#stop(key);
      return;
    }
    void this.#startShader(key, target, shader, duration < 0 ? undefined : duration);
  }

  /** An art object on an actor for `seconds` (WorldBridge.artEffect: Spell Absorption's). */
  art(art: number, target: number, seconds: number): void {
    this.#startArt(`art:${String(art)}:${String(target)}`, target, art, Math.max(0, seconds));
  }

  /**
   * VisualEffect.Play and Stop (RFCT: its art and its shader) on an actor; `facing`: the reference
   * its art faces with Face Target (Play's akFacingObject).
   */
  visual(effect: number, target: number, play: boolean, duration: number, facing?: number): void {
    const key = `visual:${String(effect)}:${String(target)}`;
    if (!play) {
      this.#stop(key);
      return;
    }
    this.#startVisuals(key, target, effect, duration < 0 ? undefined : duration, undefined, facing);
  }

  /** A visual effect's (RFCT) art and shader on what it covers. */
  #startVisuals(
    key: string,
    target: number,
    effect: number,
    seconds: number | undefined,
    body?: () => EffectBody | undefined,
    facing?: number,
  ): void {
    void (async () => {
      const record = await this.#options.session.scriptsReady?.forms.record(effect);
      const visual = record && parseVisualEffect(record);
      if (!visual) return;
      const faces = (visual.flags & VisualEffectFlag.faceTarget) !== 0 && facing !== undefined;
      const camera = (visual.flags & VisualEffectFlag.attachToCamera) !== 0;
      const place: ArtPlace | undefined =
        faces || camera
          ? {
              facing: faces ? facing : undefined,
              camera,
              inheritRotation: (visual.flags & VisualEffectFlag.inheritRotation) !== 0,
            }
          : undefined;
      if (visual.art !== undefined) this.#startArt(key, target, visual.art, seconds, body, place);
      if (visual.shader !== undefined)
        await this.#startShader(key, target, visual.shader, seconds, body);
    })().catch((error: unknown) => {
      this.#options.terminal.log('magic', `visual effect: ${describe(error)}`, 'warn');
    });
  }

  /**
   * An enchanted item's glow (its enchantment's shader and art) on `body`, until unglow: a held
   * weapon's model, an item lying in the world. `owner` is the reference it goes with.
   */
  glow(
    key: string,
    owner: number,
    glow: EnchantmentGlow,
    body: () => EffectBody | undefined,
  ): void {
    const own = `glow:${key}`;
    if (glow.shader !== undefined) void this.#startShader(own, owner, glow.shader, undefined, body);
    if (glow.art !== undefined) this.#startArt(own, owner, glow.art, undefined, body);
    if (glow.visuals !== undefined)
      this.#startVisuals(`${own}:visuals`, owner, glow.visuals, undefined, body);
  }

  /** An item's glow goes (unequipped, picked up, unloaded). */
  unglow(key: string): void {
    this.#stop(`glow:${key}`);
  }

  /** Everything on an actor goes (it unloaded, or died for good). */
  removeActor(actor: number): void {
    for (const [key, show] of this.#shaders) if (show.actor === actor) this.#dropShader(key);
    for (const [key, show] of this.#arts) if (show.actor === actor) this.#dropArt(key);
    for (const [key, show] of this.#lights) if (show.actor === actor) this.#lights.delete(key);
  }

  /** All goes (the play ended). */
  clear(): void {
    for (const key of [...this.#shaders.keys()]) this.#dropShader(key);
    for (const key of [...this.#arts.keys()]) this.#dropArt(key);
    this.#lights.clear();
    this.#detects.clear();
  }

  #stop(key: string): void {
    for (const [own, show] of this.#shaders) {
      if (own === key || own.startsWith(`${key}:`)) show.stopping ??= 0;
    }
    const art = this.#arts.get(key);
    if (art) art.stopping = true;
    this.#lights.delete(key);
    const detect = this.#detects.get(key);
    if (detect) {
      this.#detects.delete(key);
      for (const target of detect.shown) this.#stop(`${key}:${String(target)}`);
    }
  }

  // --- Effect shaders -----------------------------------------------------------------------

  #shaderRecord(formId: number): Promise<EffectShaderRecord | undefined> {
    let pending = this.#shaderRecords.get(formId);
    if (!pending) {
      const runtime = this.#options.session.scriptsReady;
      pending = (runtime?.forms.record(formId) ?? Promise.resolve(undefined)).then((record) =>
        record?.type === 'EFSH' ? parseEffectShader(record) : undefined,
      );
      this.#shaderRecords.set(formId, pending);
    }
    return pending;
  }

  /**
   * A shader on an actor: `duration` seconds (0: its own timeline once; undefined: until
   * stopped).
   */
  async #startShader(
    key: string,
    actor: number,
    formId: number,
    duration: number | undefined,
    body: () => EffectBody | undefined = () => this.#options.body(actor),
  ): Promise<void> {
    const shader = await this.#shaderRecord(formId);
    if (!shader) return;
    this.#dropShader(key);
    const own = shader.membrane;
    const once = Math.max(
      own.fill.fadeIn + own.fill.full + own.fill.fadeOut,
      own.edge.fadeIn + own.edge.full + own.edge.fadeOut,
      shader.particles.birthRampUp +
        shader.particles.fullBirthTime +
        shader.particles.birthRampDown,
      // Its holes burn on to their end time.
      shader.holesTexture === '' ? 0 : shader.holes.endTime,
    );
    this.#shaders.set(key, {
      actor,
      body,
      shader,
      age: 0,
      stopping: undefined,
      duration: duration === 0 ? (once > 0 ? once : ONCE_SECONDS) : duration,
      built: undefined,
      building: false,
      // Its ambient sound (a body on fire, a cloak, an enchanted blade drawn) plays at the
      // body while the shader shows, and stops with it.
      sound:
        shader.ambientSound === undefined
          ? undefined
          : this.#options.session.playSound(shader.ambientSound, followBody(body), 0, actor),
    });
  }

  /** Builds a shader's covers and particles on its actor's body as it is now. */
  async #buildShader(show: ShaderShow, body: EffectBody): Promise<BuiltShader | undefined> {
    const { session, renderer } = this.#options;
    const shader = show.shader;
    const placed = body.placed;
    const flags = shader.flags;
    const sources = placed.instances.map((instance) => instance.model);
    for (const model of sources) model.acquire();
    const models: GpuModel[] = [];
    const cover = async (
      material: EffectMaterial,
      scroll?: readonly [number, number],
    ): Promise<GpuScene | undefined> => {
      const instances: ModelInstance[] = [];
      for (const instance of placed.instances) {
        const overlay = await renderer.scene.createOverlay(
          instance.model,
          material,
          {
            flags: alphaFlags(shader.membrane.sourceBlend, shader.membrane.destBlend),
            threshold: 0,
          },
          session.textures,
          scroll && scrolling(scroll, instance.model),
          (flags & EffectShaderFlag.affectSkinOnly) !== 0 ? isSkin : undefined,
        );
        models.push(overlay);
        instances.push({
          model: overlay,
          world: instance.world,
          ...(instance.motion && { motion: instance.motion }),
          ...(body.visibility && { visibility: body.visibility }),
          ...(instance.pose && { pose: instance.pose }),
          ...(instance.poseNodes && { poseNodes: instance.poseNodes }),
          ...(instance.partitionVisible && { partitionVisible: instance.partitionVisible }),
          ...(instance.partShown && { partShown: instance.partShown }),
          ...(instance.face && { face: instance.face }),
          // A first-person weapon's cover is drawn with the first-person view, as it is.
          ...(instance.firstPerson && { firstPerson: true }),
        });
      }
      return renderer.scene.createScene(instances);
    };
    const membrane = (flags & EffectShaderFlag.noMembraneShader) === 0;
    const always = shader.membrane.zTest === Z_TEST_ALWAYS;
    const greyscale =
      ((flags & EffectShaderFlag.membraneGreyscaleColor) !== 0 ? 0x10 : 0) |
      ((flags & EffectShaderFlag.membraneGreyscaleAlpha) !== 0 ? 0x20 : 0);
    const color = fillColor(shader, 0);
    const fill =
      membrane && shader.fillTexture !== ''
        ? await cover(
            {
              kind: 'effect',
              flags1: greyscale | (always ? 0 : 0x80000000),
              flags2: 0x10,
              uvOffset: [0, 0],
              uvScale: [shader.membrane.scale[0], shader.membrane.scale[1]],
              sourceTexture: texturePath(shader.fillTexture),
              greyscaleTexture: texturePath(shader.membranePalette),
              baseColor: [color[0], color[1], color[2], 1],
              baseColorScale: shader.colorScale,
              falloff: [1, 0, 1, 1],
              lightingInfluence: 0,
              softFalloffDepth: 0,
              textureClampMode: 3,
            },
            shader.membrane.scroll,
          )
        : undefined;
    // The edge: opaque towards the silhouette (inverse: towards the middle). TODO(M13): the
    // edge falloff's curve (taken as linear in the angle's cosine).
    const inverse = (flags & EffectShaderFlag.edgeEffectInverse) !== 0;
    const edgeColor = shader.membrane.edgeColor;
    const edge =
      membrane && edgeColor.some((c) => c > 0)
        ? await cover({
            kind: 'effect',
            flags1: 0x40 | (always ? 0 : 0x80000000),
            flags2: 0x10,
            uvOffset: [0, 0],
            uvScale: [1, 1],
            sourceTexture: '',
            greyscaleTexture: '',
            baseColor: [edgeColor[0], edgeColor[1], edgeColor[2], 1],
            baseColorScale: shader.colorScale,
            falloff: inverse ? [1, 0, 1, 0] : [1, 0, 0, 1],
            lightingInfluence: 0,
            softFalloffDepth: 0,
            textureClampMode: 3,
          })
        : undefined;
    let particles: BuiltShader['particles'];
    if ((flags & EffectShaderFlag.noParticleShader) === 0 && shader.particleTexture !== '') {
      const source = new SurfaceParticles(shader, () => {
        const now = show.body();
        if (!now || !sameShape(now.placed, placed)) return undefined;
        const first = placed.instances[0];
        if (!first) return undefined;
        return {
          parts: placed.instances.flatMap((instance) =>
            instance.model.parts.map((gpu) => gpu.part),
          ),
          pose: placed.pose,
          world: first.world,
          hang: hungOn(placed),
        };
      });
      const model = await renderer.scene.createModel(
        {
          parts: [],
          center: [0, 0, 0],
          radius: 128,
          skipped: [],
          editorMarker: false,
          particles: [source.data],
          addons: [],
        },
        session.textures,
      );
      models.push(model);
      const first = placed.instances[0];
      const scene = renderer.scene.createScene([
        {
          model,
          world: first?.world ?? new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
          ...(body.visibility && { visibility: body.visibility }),
          particleSource: () => source,
        },
      ]);
      particles = { scene, source };
    }
    const addons =
      shader.addonModels === undefined
        ? undefined
        : await this.#buildAddons(show, shader.addonModels, body);
    return { placed, fill, edge, particles, models, sources, addons };
  }

  /**
   * A shader's addon models (its DEBR's models) on its body: each on one of the bones its skin
   * is bound to, spread along them (an object: at its origin), each model shown by its
   * percentage as a chance. TODO(M13): where the engine hangs them (taken: on the skin's bones;
   * the percentage taken as each model's chance, as debris counts it).
   */
  async #buildAddons(
    show: ShaderShow,
    formId: number,
    body: EffectBody,
  ): Promise<BuiltAddons | undefined> {
    const { session, renderer } = this.#options;
    const record = await session.scriptsReady?.forms.record(formId);
    const debris = record?.type === 'DEBR' ? parseDebris(record) : undefined;
    const placed = body.placed;
    const first = placed.instances[0];
    if (!debris || debris.models.length === 0 || !first) return undefined;
    const random = seededRandom((show.actor ^ formId) >>> 0);
    const chosen = debris.models.filter((entry) => random() * 100 < entry.percentage);
    const nodes = spreadOver(skinBones(placed), chosen.length);
    const fade: InstanceFade = { kind: 'object', byDistance: false, veil: 1 };
    const hung: BuiltAddons['hung'][number][] = [];
    const instances: ModelInstance[] = [];
    for (const [i, entry] of chosen.entries()) {
      const model = await session.model(meshPath(entry.model));
      if (!model) continue;
      const world = new Float32Array(first.world);
      const motion: InstanceMotion = { version: 0 };
      hung.push({ world, motion, node: nodes[i] ?? -1 });
      instances.push({
        model,
        world,
        motion,
        fade,
        ...(body.visibility && { visibility: body.visibility }),
        ...(first.firstPerson && { firstPerson: true }),
      });
    }
    if (instances.length === 0) return undefined;
    return { scene: renderer.scene.createScene(instances), fade, hung };
  }

  /** The addon models where their bones are now, at their look's scale and alpha. */
  #placeAddons(show: ShaderShow, built: BuiltShader, body: EffectBody): boolean {
    const addons = built.addons;
    if (!addons) return true;
    const look = addonLook(show.shader.addon, show.age, show.stopping);
    addons.fade.veil = 1 - look.alpha;
    const base = body.placed.instances[0]?.world;
    const pose = built.placed.pose;
    if (base) {
      const scale = new Float32Array([
        look.scale,
        0,
        0,
        0,
        0,
        look.scale,
        0,
        0,
        0,
        0,
        look.scale,
        0,
        0,
        0,
        0,
        1,
      ]);
      for (const hung of addons.hung) {
        const at =
          pose && hung.node >= 0
            ? multiply(base, pose.worlds.subarray(hung.node * 16, hung.node * 16 + 16))
            : base;
        multiply(at, scale, hung.world);
        hung.motion.version++;
      }
    }
    return look.done;
  }

  /** The share of a reference its shaders' holes have cut away now (0: whole, 1: gone). */
  holes(reference: number): number {
    let share = 0;
    for (const show of this.#shaders.values()) {
      if (show.actor === reference) share = Math.max(share, holesShare(show.shader, show.age));
    }
    return share;
  }

  /**
   * Objects (no skeleton) their shaders' holes cut away: their own instances' fade veils them by
   * the share (an actor's veil is the stage's, which takes `holes`); one no longer cut is whole.
   */
  #holeObjects(): void {
    const veils = new Map<InstanceFade, number>();
    for (const show of this.#shaders.values()) {
      if (show.shader.holesTexture === '') continue;
      const placed = show.body()?.placed;
      if (!placed || placed.pose) continue;
      const share = holesShare(show.shader, show.age);
      for (const instance of placed.instances) {
        if (!instance.fade || instance.pose) continue;
        veils.set(instance.fade, Math.max(share, veils.get(instance.fade) ?? 0));
      }
    }
    for (const fade of this.#holed) if (!veils.has(fade)) fade.veil = 0;
    for (const [fade, share] of veils) fade.veil = share;
    this.#holed = new Set(veils.keys());
  }

  #dropShader(key: string): void {
    const show = this.#shaders.get(key);
    this.#shaders.delete(key);
    void show?.sound?.then((playing) => playing?.stop());
    if (show?.built) destroyBuilt(show.built);
    if (show) show.built = undefined;
  }

  // --- Art ---------------------------------------------------------------------------------

  /** An art object (ARTO) on an actor: `duration` seconds (0: once; undefined: until stopped). */
  #startArt(
    key: string,
    actor: number,
    art: number,
    duration: number | undefined,
    body: () => EffectBody | undefined = () => this.#options.body(actor),
    place?: ArtPlace,
  ): void {
    void (async () => {
      const record = await this.#options.session.scriptsReady?.forms.record(art);
      const model = record ? parseArtObject(record)?.model : undefined;
      if (!model) return;
      this.#dropArt(key);
      this.#arts.set(key, {
        actor,
        body,
        model,
        place,
        age: 0,
        duration: duration === 0 ? ONCE_SECONDS : duration,
        stopping: false,
        built: undefined,
        building: false,
      });
    })().catch((error: unknown) => {
      this.#options.terminal.log('magic', `art: ${describe(error)}`, 'warn');
    });
  }

  /** Hangs an art model on its actor's skeleton: its nodes follow the bones of their names. */
  async #buildArt(show: ArtShow, body: EffectBody): Promise<ArtShow['built']> {
    const { session, renderer } = this.#options;
    const model = await session.model(meshPath(show.model));
    if (!model) return undefined;
    const placed = body.placed;
    const first = placed.instances[0];
    if (!first) return undefined;
    // Its own pose: its nodes (those the actor's skeleton has follow them each frame).
    const dressed = wearOnRig(
      { names: ['ArtRoot'], parents: Int16Array.from([-1]), local: new Float32Array(identity()) },
      [{ nodes: model.nodes ?? [], attachTo: model.attachTo, lagBones: model.nodeLagBones }],
    );
    const pose = new ActorPose(new ActorSkeleton(dressed.rig, undefined));
    // Placed each frame by the effects: faced, at the camera, or on a held weapon's root.
    const anchor = heldAnchor(placed);
    const own =
      show.place !== undefined || anchor !== undefined
        ? { world: new Float32Array(first.world), motion: { version: 0 }, anchor }
        : undefined;
    // An object's art stands at its origin (no skeleton to follow); a placed one follows none.
    const nodes = Int16Array.from(dressed.rig.names, (name) =>
      own ? -1 : (placed.pose?.skeleton.nodeByName.get(name.toLowerCase()) ?? -1),
    );
    const motion = own?.motion ?? first.motion;
    // One at the camera is seen whether its target is (the player in first person) or not.
    const visibility = show.place?.camera ? undefined : body.visibility;
    const scene = renderer.scene.createScene([
      {
        model,
        world: own?.world ?? first.world,
        ...(motion && { motion }),
        ...(visibility && { visibility }),
        ...(first.firstPerson && !show.place?.camera && { firstPerson: true }),
        ...(model.nodes && {
          pose,
          ...(dressed.nodeMaps[0] && { poseNodes: dressed.nodeMaps[0] }),
        }),
      },
    ]);
    const built = { placed, scene, pose, nodes, own };
    // Its own nodes at rest under its root (no skeleton drives them).
    if (own) pose.place(new Map());
    this.#placeArt(show, built);
    return built;
  }

  /**
   * A placed art where it stands now: at the camera (turned with it when it inherits its
   * rotation), or where it hangs (its target's origin, a held weapon's root) turned to face its
   * facing reference's origin when it has one.
   */
  #placeArt(show: ArtShow, built: NonNullable<ArtShow['built']>): void {
    const own = built.own;
    if (!own) return;
    const place = show.place;
    if (place?.camera) {
      const camera = this.#options.renderer.view?.camera;
      if (!camera) return;
      cameraWorld(camera.position, camera.forward, place.inheritRotation, own.world);
      own.motion.version++;
      return;
    }
    const first = show.body()?.placed.instances[0];
    if (!first) return;
    const held = own.anchor !== undefined ? first.pose : undefined;
    const at =
      held && own.anchor !== undefined
        ? multiply(first.world, held.worlds.subarray(own.anchor * 16, own.anchor * 16 + 16))
        : first.world;
    const toward =
      place?.facing === undefined
        ? undefined
        : this.#options.body(place.facing)?.placed.instances[0]?.world;
    if (toward) facingWorld(at, [toward[12] ?? 0, toward[13] ?? 0, toward[14] ?? 0], own.world);
    else own.world.set(at);
    own.motion.version++;
  }

  #dropArt(key: string): void {
    const show = this.#arts.get(key);
    this.#arts.delete(key);
    show?.built?.scene?.destroy();
  }

  // --- Lights -------------------------------------------------------------------------------

  #lightRecord(formId: number): Promise<LightRecord | undefined> {
    let pending = this.#lightRecords.get(formId);
    if (!pending) {
      const runtime = this.#options.session.scriptsReady;
      pending = (runtime?.forms.record(formId) ?? Promise.resolve(undefined)).then((record) =>
        record?.type === 'LIGH' ? parseLight(record) : undefined,
      );
      this.#lightRecords.set(formId, pending);
    }
    return pending;
  }

  async #startLight(key: string, actor: number, light: number): Promise<void> {
    const record = await this.#lightRecord(light);
    if (record) this.#lights.set(key, { actor, light: record });
  }

  /** The lights of the effects on the actors shown (CellLights: the viewers light with them). */
  lights(): CellLight[] {
    const lights: CellLight[] = [];
    for (const show of this.#lights.values()) {
      const body = this.#options.body(show.actor);
      const world = body?.placed.instances[0]?.world;
      if (!world || body.visibility?.hidden === true) continue;
      const heading = Math.atan2(world[4] ?? 0, world[0] ?? 1);
      const c = Math.cos(heading);
      const s = Math.sin(heading);
      lights.push({
        reference: show.actor,
        position: [
          (world[12] ?? 0) + LIGHT_OFFSET[0] * c - LIGHT_OFFSET[1] * s,
          (world[13] ?? 0) + LIGHT_OFFSET[0] * s + LIGHT_OFFSET[1] * c,
          (world[14] ?? 0) + LIGHT_OFFSET[2],
        ],
        radius: show.light.radius,
        color: show.light.color,
        fade: show.light.fade,
        flags: show.light.flags,
        period: show.light.period,
        intensityAmplitude: show.light.intensityAmplitude,
        movementAmplitude: show.light.movementAmplitude,
      });
    }
    return lights;
  }

  // --- Every frame ------------------------------------------------------------------------

  /** Every frame: shaders fade by their timelines, art follows its actor, Detect Life looks. */
  frame(seconds: number): void {
    const renderer = this.#options.renderer;
    for (const [key, show] of [...this.#shaders]) {
      show.age += seconds;
      if (show.stopping !== undefined) show.stopping += seconds;
      else if (show.duration !== undefined && show.age >= show.duration) show.stopping = 0;
      const body = show.body();
      // Its actor made again (a new look), its object reloaded or gone: built again on its new
      // body (when it is back).
      if (show.built && (!body || !sameShape(show.built.placed, body.placed))) {
        destroyBuilt(show.built);
        show.built = undefined;
      }
      if (!show.built && body && !show.building && show.stopping === undefined) {
        show.building = true;
        void this.#buildShader(show, body)
          .then((built) => {
            show.building = false;
            if (this.#shaders.get(key) !== show) {
              if (built) destroyBuilt(built);
              return;
            }
            show.built = built;
          })
          .catch((error: unknown) => {
            show.building = false;
            this.#options.terminal.log(
              'magic',
              `${show.shader.editorId}: ${describe(error)}`,
              'warn',
            );
          });
      }
      const built = show.built;
      const fill = timelineAlpha(show.shader.membrane.fill, show.age, show.stopping);
      const edge = timelineAlpha(show.shader.membrane.edge, show.age, show.stopping);
      if (built?.fill) {
        renderer.scene.fadeScene(built.fill, fill);
        if (show.shader.membrane.colors.length > 1)
          renderer.scene.tintScene(built.fill, fillColor(show.shader, show.age));
      }
      if (built?.edge) renderer.scene.fadeScene(built.edge, edge);
      if (show.stopping !== undefined) built?.particles?.source.stop();
      const particlesDone = !built?.particles || built.particles.source.finished;
      const addonsDone = !built || !body || this.#placeAddons(show, built, body);
      if (show.stopping !== undefined && fill <= 0 && edge <= 0 && particlesDone && addonsDone)
        this.#dropShader(key);
      else if (show.stopping !== undefined && show.stopping > 10) this.#dropShader(key);
    }
    this.#holeObjects();
    for (const [key, show] of [...this.#arts]) {
      show.age += seconds;
      if (show.stopping || (show.duration !== undefined && show.age >= show.duration)) {
        this.#dropArt(key);
        continue;
      }
      const body = show.body();
      if (show.built && (!body || !sameShape(show.built.placed, body.placed))) {
        show.built.scene?.destroy();
        show.built = undefined;
      }
      if (!show.built && body && !show.building) {
        show.building = true;
        void this.#buildArt(show, body)
          .then((built) => {
            show.building = false;
            if (this.#arts.get(key) !== show) built?.scene?.destroy();
            else show.built = built;
          })
          .catch((error: unknown) => {
            show.building = false;
            this.#options.terminal.log('magic', `${show.model}: ${describe(error)}`, 'warn');
          });
      }
      const built = show.built;
      if (built?.own) {
        this.#placeArt(show, built);
      } else {
        const follow = built?.placed.pose;
        if (built && follow) followSkeleton(built.pose, built.nodes, follow);
      }
    }
    for (const detect of this.#detects.values()) {
      detect.wait -= seconds;
      if (detect.wait > 0) continue;
      detect.wait = DETECT_SECONDS;
      void this.#detect(detect);
    }
  }

  /**
   * Detect Life: the living within its radius of its caster whom its conditions hold for (the
   * magic system's detects: friends or enemies, the living or the undead) show its shader.
   */
  async #detect(detect: DetectShow): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const caster = this.#options.body(detect.caster)?.placed.instances[0]?.world;
    if (!runtime || !caster) return;
    const found = new Set<number>();
    for (const { reference, feet } of this.#options.living()) {
      if (reference === detect.caster || reference === PLAYER_REF) continue;
      const distance = Math.hypot(
        feet[0] - (caster[12] ?? 0),
        feet[1] - (caster[13] ?? 0),
        feet[2] - (caster[14] ?? 0),
      );
      if (distance > detect.radius) continue;
      if (!(await runtime.magic.detects(detect.effect, reference))) continue;
      found.add(reference);
    }
    if (this.#detects.get(detect.key) !== detect) return;
    for (const target of found) {
      if (detect.shown.has(target)) continue;
      detect.shown.add(target);
      void this.#startShader(`${detect.key}:${String(target)}`, target, detect.shader, undefined);
    }
    for (const target of [...detect.shown]) {
      if (found.has(target)) continue;
      detect.shown.delete(target);
      this.#stop(`${detect.key}:${String(target)}`);
    }
  }

  /**
   * After the skeletons animated and the actors moved: the placed art (faced, at the camera, on
   * a held weapon) and the addon models stand where their bodies are this frame, not the last.
   */
  afterAnimate(): void {
    for (const show of this.#arts.values()) if (show.built?.own) this.#placeArt(show, show.built);
    for (const show of this.#shaders.values()) {
      const body = show.body();
      if (show.built?.addons && body) this.#placeAddons(show, show.built, body);
    }
  }

  *scenes(): Iterable<GpuScene> {
    for (const show of this.#shaders.values()) {
      const built = show.built;
      if (!built) continue;
      if (built.fill) yield built.fill;
      if (built.edge) yield built.edge;
      if (built.particles?.scene) yield built.particles.scene;
      if (built.addons?.scene) yield built.addons.scene;
    }
    for (const show of this.#arts.values()) if (show.built?.scene) yield show.built.scene;
  }
}

/**
 * Where a body's rigid shapes hang now under its first instance's place: a shape on a pose node
 * (a held weapon's on its hand) at that node and its own transform, as the renderer hangs it.
 */
function hungOn(placed: EffectShape): ((part: ModelPart) => Mat4 | undefined) | undefined {
  if (placed.pose) return undefined;
  const owners = new Map<ModelPart, ModelInstance>();
  for (const instance of placed.instances) {
    for (const gpu of instance.model.parts) owners.set(gpu.part, instance);
  }
  return (part) => {
    const instance = owners.get(part);
    const pose = instance?.pose;
    const node = pose && part.node !== undefined ? (instance.poseNodes?.[part.node] ?? -1) : -1;
    if (!pose || node < 0) return undefined;
    const at = pose.worlds.subarray(node * 16, node * 16 + 16);
    return part.local ? multiply(at, part.local) : at;
  };
}

/** The skeleton's bones a body's skinned shapes are bound to, in the skeleton's order. */
function skinBones(placed: EffectShape): number[] {
  const pose = placed.pose;
  if (!pose) return [];
  const bones = new Set<number>();
  for (const instance of placed.instances) {
    for (const gpu of instance.model.parts) {
      for (const name of gpu.part.skin?.names ?? []) {
        const node = pose.skeleton.nodeByName.get(name.toLowerCase());
        if (node !== undefined) bones.add(node);
      }
    }
  }
  return [...bones].sort((a, b) => a - b);
}

/** Skin shapes (Affect Skin Only): the FaceGen and skin-tinted ones. */
function isSkin(part: ModelPart): boolean {
  const material = part.material;
  return material?.kind === 'lighting' && (material.shaderType === 4 || material.shaderType === 5);
}

/** The animation that scrolls a membrane's fill texture (UV per second, looping). */
function scrolling(scroll: readonly [number, number], model: GpuModel): ModelAnimation | undefined {
  if (scroll[0] === 0 && scroll[1] === 0) return undefined;
  // EffectShaderControlledVariable U Offset (6) and V Offset (8) over a second, repeating, on
  // each of the shapes' shaders.
  const track = (
    shader: number,
    variable: number,
    speed: number,
  ): ModelAnimation['tracks'][number] => ({
    kind: 'shader-float',
    shader,
    variable,
    source: {
      constant: 0,
      keys: {
        interpolation: 1,
        keys: [
          { time: 0, value: 0 },
          { time: 1, value: speed },
        ],
      },
    },
    timing: { frequency: 1, phase: 0, start: 0, stop: 1, cycle: 0 },
  });
  return {
    tracks: [...new Set(model.parts.map((gpu) => gpu.part.shader))].flatMap((shader) => [
      track(shader, 6, scroll[0]),
      track(shader, 8, scroll[1]),
    ]),
    parents: new Map(),
    transforms: new Map(),
    roots: [],
  };
}

/** An art's own pose follows the actor's: each node the skeleton has takes its matrix. */
function followSkeleton(pose: ActorPose, nodes: Int16Array, body: ActorPose): void {
  const driven = new Map<number, Float32Array>();
  nodes.forEach((node, i) => {
    if (node >= 0) driven.set(i, body.worlds.subarray(node * 16, node * 16 + 16));
  });
  pose.place(driven);
}

function destroyBuilt(built: BuiltShader): void {
  built.fill?.destroy();
  built.edge?.destroy();
  built.particles?.scene?.destroy();
  built.addons?.scene?.destroy();
  for (const model of built.models) model.destroy();
  for (const model of built.sources) model.release();
}
