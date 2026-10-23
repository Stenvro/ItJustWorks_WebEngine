// The animation objects actors hold (docs/animation.md, "Animation objects"): the props an
// actor's behavior graph puts in its hands as an idle or a furniture animation plays, the
// smith's hammer and hot iron at the anvil, the woodcutter's axe, the drinker's tankard, the
// bard's lute, the broom, the pickaxe, the alchemist's pestle. The graph names each by the
// editor id of its ANIO record (src/world/anim-object-records.ts) in the payload of an
// AnimObjLoad event (its model is loaded and hung, hidden, on the node its "Prn" names:
// AnimObjectR/L/A/B, which the clips move, or a hand) and an AnimObjDraw event (it is shown);
// the record's unload event (AnimObjectUnequip), raised by the same graph, takes it away
// again, and so does the actor's 3D going. The list follows the engine's
// (src/animation/anim-objects.ts). The player holds theirs on the skeleton shown as the model
// comes in (the first-person arms in first person) and cannot switch the camera while they do.
//
// The graph event dispatch calls animObject() for AnimObjLoad and AnimObjDraw with their
// payloads (the engine's AnimationObjectLoadHandler and AnimationObjectDrawHandler), and
// graphEvents() hears every event an actor's graph raises (the unload events).

import { AnimObjectList, type HeldAnimObject } from '../animation/anim-objects.ts';
import type { ActorPose } from '../animation/skeleton.ts';
import type { ModelTextureSwaps } from '../render/actor-model.ts';
import { multiply } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type {
  GpuModel,
  GpuScene,
  InstanceMotion,
  InstanceVisibility,
} from '../render/scene-renderer.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { meshPath } from '../world/actors.ts';
import { readAnimObjects, type AnimObjectRecord } from '../world/anim-object-records.ts';
import { parseTextureSet } from '../world/decal.ts';
import type { StagedActor } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';
import type { PlayerView } from './race-menu.ts';

/** What the graph event dispatch asks of the animation objects. */
export type AnimObjectRequest = 'load' | 'draw' | 'unequip';

/** The unload event of every vanilla animation object but two. */
const UNEQUIP_EVENT = 'AnimObjectUnequip';

/** The skeleton an object hangs on: the actor's body, or the player's first-person arms. */
type Side = 'body' | 'first';

/** An actor's 3D as an object hangs on it. */
interface HolderBody {
  /** Which 3D it is (made again, another object: what hung on the old one goes). */
  readonly key: object;
  readonly pose: ActorPose;
  /** Its placement in the world. */
  readonly world: Float32Array;
  /** Not drawn now (disabled, the other person's view). */
  readonly hidden: boolean;
}

/** An object's model hung on its holder. */
interface Attached {
  readonly side: Side;
  readonly key: object;
  /** The node its "Prn" names (lower case; undefined: none, it shows nowhere). */
  readonly node: string | undefined;
  readonly scene: GpuScene;
  readonly world: Float32Array;
  readonly motion: InstanceMotion;
  readonly visibility: InstanceVisibility;
}

type Entry = HeldAnimObject<AnimObjectRecord, Attached>;

export interface ActorAnimObjectsOptions {
  readonly session: GameSession;
  readonly renderer: Renderer;
  /** A staged actor by its reference. */
  readonly staged: (reference: number) => StagedActor | undefined;
  /** The player being played, if they are. */
  readonly player: () => PlayerView | undefined;
  readonly warn?: (message: string) => void;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ActorAnimObjects {
  readonly #options: ActorAnimObjectsOptions;
  readonly #list = new AnimObjectList<AnimObjectRecord, Attached>();
  /** The records by lower-case editor id, read once. */
  #records: Map<string, AnimObjectRecord> | undefined;
  #reading: Promise<void> | undefined;
  /** Requests that came before the records were read, in order. */
  #waiting: (() => void)[] = [];
  readonly #textureSets = new Map<number, Promise<readonly string[] | undefined>>();
  /** Bumped by clear(): models still loading for a cleared list are dropped. */
  #generation = 0;

  constructor(options: ActorAnimObjectsOptions) {
    this.#options = options;
  }

  /**
   * An animation object event of an actor's graph: 'load' (AnimObjLoad) and 'draw'
   * (AnimObjDraw) with their payload, the object's editor id; 'unequip' takes away the
   * object named (undefined: the actor's objects whose unload event is AnimObjectUnequip, as
   * that event raised does). A name no record has does nothing, as in the engine.
   */
  animObject(reference: number, kind: AnimObjectRequest, editorId: string | undefined): void {
    const run = (): void => {
      this.#handle(reference, kind, editorId);
    };
    if (this.#records) {
      run();
      return;
    }
    this.#waiting.push(run);
    this.#read();
  }

  /**
   * Events an actor's graph raised: each that is the unload event of objects the actor holds
   * takes them away (the reference's graph event sink in the engine).
   */
  graphEvents(reference: number, events: readonly string[]): void {
    for (const event of events) this.#unloaded(this.#list.unloadEvent(reference, event));
  }

  /** An actor left the stage (its 3D went): its objects go. */
  remove(reference: number): void {
    this.#unloaded(this.#list.unloadActor(reference));
  }

  /** The play ended or another began: every object goes. */
  clear(): void {
    this.#generation++;
    this.#unloaded(this.#list.clear());
  }

  /** What an actor holds now: each object's editor id, and whether it is shown. */
  held(reference: number): { readonly editorId: string; readonly shown: boolean }[] {
    return this.#list
      .of(reference)
      .map((entry) => ({ editorId: entry.form.editorId, shown: entry.shown }));
  }

  /** Their scenes. */
  *scenes(): Iterable<GpuScene> {
    for (const entry of this.#list.all()) {
      if (entry.attached) yield entry.attached.scene;
    }
  }

  /**
   * Every frame after the poses: each shown object goes where its node is; the objects of a
   * 3D made again go (the engine's 3D unload).
   */
  frame(): void {
    const gone = new Set<number>();
    for (const entry of this.#list.all()) {
      const attached = entry.attached;
      if (!attached) continue;
      const body = this.#body(entry.actor, attached.side);
      if (body?.key !== attached.key) {
        gone.add(entry.actor);
        continue;
      }
      const node =
        attached.node === undefined ? undefined : body.pose.skeleton.nodeByName.get(attached.node);
      attached.visibility.hidden = !entry.shown || body.hidden || node === undefined;
      if (node === undefined || attached.visibility.hidden) continue;
      multiply(body.world, body.pose.worlds.subarray(node * 16, node * 16 + 16), attached.world);
      attached.motion.version++;
    }
    for (const actor of gone) this.remove(actor);
  }

  #read(): void {
    if (this.#reading) return;
    this.#reading = this.#options.session.db
      .then(readAnimObjects)
      .then((records) => {
        this.#records = records;
      })
      .catch((error: unknown) => {
        this.#options.warn?.(`animation objects: ${describe(error)}`);
        this.#records = new Map();
      })
      .finally(() => {
        const waiting = this.#waiting;
        this.#waiting = [];
        for (const run of waiting) run();
      });
  }

  #handle(reference: number, kind: AnimObjectRequest, editorId: string | undefined): void {
    const form = editorId === undefined ? undefined : this.#records?.get(editorId.toLowerCase());
    switch (kind) {
      case 'load': {
        if (!form) return;
        const entry = this.#list.load(reference, form);
        if (entry) void this.#attach(entry);
        return;
      }
      case 'draw':
        if (form) this.#list.draw(reference, form);
        return;
      case 'unequip':
        if (editorId === undefined) this.graphEvents(reference, [UNEQUIP_EVENT]);
        else if (form) this.#unloaded(this.#list.unload(reference, form));
        return;
    }
  }

  /**
   * Loads an object's model and hangs it on its holder as shown now: on the node its "Prn"
   * names (a model without one, or a holder without that node, shows nowhere, as the engine
   * leaves it unattached). A holder without 3D keeps the entry without a model.
   */
  async #attach(entry: Entry): Promise<void> {
    const generation = this.#generation;
    const { session, renderer } = this.#options;
    const path = entry.form.model === undefined ? undefined : meshPath(entry.form.model);
    let model: GpuModel | undefined;
    try {
      const swaps = await this.#swaps(entry.form);
      model =
        path === undefined || !session.vfs.has(path)
          ? undefined
          : await session.damagedModel(path, 0, swaps);
    } catch (error) {
      this.#options.warn?.(`animation object ${entry.form.editorId}: ${describe(error)}`);
    }
    if (generation !== this.#generation) return;
    const side: Side =
      entry.actor === PLAYER_REF && this.#options.player()?.play.bodyShown === false
        ? 'first'
        : 'body';
    const body = this.#body(entry.actor, side);
    let attached: Attached | undefined;
    if (model && body) {
      const world = new Float32Array(16);
      const motion: InstanceMotion = { version: 0 };
      const visibility: InstanceVisibility = { hidden: true };
      attached = {
        side,
        key: body.key,
        node: model.attachTo?.toLowerCase(),
        scene: renderer.scene.createScene([{ model, world, motion, visibility }]),
        world,
        motion,
        visibility,
      };
    }
    if (!this.#list.loaded(entry, attached)) {
      attached?.scene.destroy();
      return;
    }
    // The player holding one cannot switch the camera (the engine turns the control off).
    if (attached && entry.actor === PLAYER_REF) this.#cameraSwitch(false);
  }

  /** The texture sets of an object's alternate textures (MODS), by shape. */
  async #swaps(form: AnimObjectRecord): Promise<ModelTextureSwaps | undefined> {
    if (form.alternateTextures.length === 0) return undefined;
    const shapes = await Promise.all(
      form.alternateTextures.map(async (swap) => {
        const textures = await this.#textureSet(swap.textureSet);
        return textures ? [{ shape: swap.shape, textures }] : [];
      }),
    );
    const flat = shapes.flat();
    return flat.length > 0 ? { shapes: flat } : undefined;
  }

  #textureSet(formId: number): Promise<readonly string[] | undefined> {
    let pending = this.#textureSets.get(formId);
    if (!pending) {
      pending = this.#options.session.db
        .then((db) => db.get(formId))
        .then((record) => (record?.type === 'TXST' ? parseTextureSet(record).textures : undefined));
      this.#textureSets.set(formId, pending);
    }
    return pending;
  }

  /** Objects taken away: their models go; the player holding none may switch the camera. */
  #unloaded(entries: readonly Entry[]): void {
    let player = false;
    for (const entry of entries) {
      entry.attached?.scene.destroy();
      if (entry.actor === PLAYER_REF && entry.attached) player = true;
    }
    if (player && this.#list.of(PLAYER_REF).every((entry) => !entry.attached)) {
      this.#cameraSwitch(true);
    }
  }

  /** Game.DisablePlayerControls' camera switch, which the engine turns as the player holds one. */
  #cameraSwitch(enabled: boolean): void {
    const runtime = this.#options.session.scriptsReady;
    if (runtime) runtime.controls.camSwitch = enabled;
  }

  /** An actor's 3D as shown now (the player's body or first-person arms). */
  #body(reference: number, side: Side): HolderBody | undefined {
    if (reference === PLAYER_REF) {
      const view = this.#options.player();
      const avatar = view?.avatar;
      if (!view || !avatar) return undefined;
      if (side === 'first') {
        const arms = avatar.firstPersonBody;
        return (
          arms && {
            key: arms,
            pose: arms.pose,
            world: arms.world,
            hidden: view.play.bodyShown || view.play.dead,
          }
        );
      }
      return {
        key: avatar.body,
        pose: avatar.body.pose,
        world: avatar.placement.world,
        hidden: !view.play.bodyShown,
      };
    }
    const staged = this.#options.staged(reference);
    const world = staged?.placed.instances[0]?.world;
    if (!staged || !world) return undefined;
    return {
      key: staged.placed,
      pose: staged.placed.pose,
      world,
      hidden: staged.visibility.hidden,
    };
  }
}
