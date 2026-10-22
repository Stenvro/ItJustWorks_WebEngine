// The weapons an actor holds, drawn on its body (docs/ai.md, "Combat"): each weapon's world
// model (WEAP MODL) hangs on its sheath node while sheathed (its "Prn": WeaponSword,
// WeaponDagger, WeaponAxe, WeaponMace, WeaponBack, WeaponBow; the equip system's weaponNodes)
// and on the hand's node while drawn (WEAPON in the right hand, SHIELD in the left), moved
// across at the graph's weaponDraw and weaponSheathe annotations; its scabbard (the model's
// "Scb" shape) stays at the sheath. A left-hand weapon is not shown sheathed (vanilla's skeleton
// has no left-hand sheaths). The ammunition hangs in the quiver (QUIVER: the AMMO model's
// quiver and arrows, its single "Arrow:0" left out); from arrowAttach to arrowRelease an arrow is
// on the bow (the AMMO model's "Arrow:0" on WEAPON, where the bow animations hold the bow).
// Shields are worn armour (their addon hangs on SHIELD with the actor's look). The player's
// first-person weapons are these on the first-person arms (src/shell/first-person-body.ts),
// each weapon's first-person model (WEAP WNAM).
//
// A weapon with a behavior graph of its own (BSBehaviorGraphExtraData: every vanilla bow and
// crossbow, BowProject.hkx and its kin) runs it on the model's nodes, as the engine adds it to
// its wielder's graph manager: every event the wielder's graph raises goes to it (BowDraw,
// bowDrawStart, BowRelease, bowReset; Reload and BowReleaseFast for crossbows) and so do the
// variables the engine sets on the wielder (weaponSpeedMult, the perks' bPerkQuickDraw), so the
// string and limbs draw, hold and spring back with the wielder's arms (docs/animation.md,
// "Held weapons"). A weapon that struck flesh shows its blood (src/gameplay/combat/
// weapon-blood.ts: the model's hidden blood shapes, docs/rendering.md, "Weapon blood").

import type { ActorPose } from '../animation/skeleton.ts';
import { ActorPose as Pose, ActorSkeleton, wearOnRig } from '../animation/skeleton.ts';
import { WeaponGraph } from '../animation/weapon-graph.ts';
import type { ModelPart } from '../render/model-data.ts';
import type { Renderer } from '../render/renderer.ts';
import type {
  GpuModel,
  GpuScene,
  InstanceMotion,
  InstanceVisibility,
  ModelInstance,
  WeaponBloodLevel,
} from '../render/scene-renderer.ts';
import { meshPath, seededRandom } from '../world/actors.ts';
import type { GameSession } from './game-session.ts';

/** What an actor holds, as its models show it. */
export interface HeldModels {
  /** The right hand's weapon: its model and nodes. */
  readonly right?: { readonly model: string; readonly sheathed: string | undefined } | undefined;
  /** The left hand's one-handed weapon (drawn only). */
  readonly left?: { readonly model: string } | undefined;
  /** The ammunition's model (the quiver). */
  readonly ammo?: string | undefined;
}

/** Where the models hang: the body's pose and placement. */
export interface HeldBody {
  readonly pose: ActorPose;
  readonly world: Float32Array;
  readonly motion: InstanceMotion;
  readonly visibility: InstanceVisibility;
}

/** The weapons' blood (shared by the third- and first-person models of the same weapons). */
export interface HeldBlood {
  readonly right?: WeaponBloodLevel;
  readonly left?: WeaponBloodLevel;
}

/** Slots of the models' own pose: each copies a node of the body. */
const Slot = { right: 0, scabbard: 1, left: 2, quiver: 3, arrow: 4 } as const;
const SLOT_NAMES = ['right', 'scabbard', 'left', 'quiver', 'arrow'];

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The scabbard of a weapon model (SSE's "Scb" shape). */
const scabbard = (part: ModelPart): boolean => part.name.toLowerCase() === 'scb';
/** The single arrow of an ammunition model (beside the quiver). */
const singleArrow = (part: ModelPart): boolean => part.name.toLowerCase() === 'arrow:0';

/** The weapons of one actor: their scene, hung on their slots. */
export class HeldWeapons {
  readonly #body: HeldBody;
  readonly #held: HeldModels;
  /**
   * Its own pose: one node per slot, set to its body's node every frame, the models' own nodes
   * under them (a bow's bones, which its skinned string and limbs follow).
   */
  #pose: ActorPose | undefined;
  #scene: GpuScene | undefined;
  #graph: WeaponGraph | undefined;
  readonly #nodes: (number | undefined)[] = [];
  readonly #driven = new Map<number, Float32Array>();
  #destroyed = false;

  private constructor(body: HeldBody, held: HeldModels) {
    this.#body = body;
    this.#held = held;
  }

  /**
   * The models of what an actor holds, on its body (undefined: nothing to show). `seed` (the
   * actor's reference) starts a weapon's graph the same way each time.
   */
  static async create(
    session: GameSession,
    renderer: Renderer,
    body: HeldBody,
    held: HeldModels,
    blood: HeldBlood = {},
    seed = 0,
  ): Promise<HeldWeapons | undefined> {
    const load = (path: string | undefined): Promise<GpuModel | undefined> =>
      path === undefined || !session.vfs.has(meshPath(path))
        ? Promise.resolve(undefined)
        : session.model(meshPath(path));
    const [right, left, ammo] = await Promise.all([
      load(held.right?.model),
      load(held.left?.model),
      load(held.ammo),
    ]);
    const hung: {
      model: GpuModel;
      slot: number;
      partShown: (part: ModelPart) => boolean;
      blood?: WeaponBloodLevel | undefined;
    }[] = [];
    if (right) {
      hung.push({
        model: right,
        slot: Slot.right,
        partShown: (part) => !scabbard(part),
        blood: blood.right,
      });
      if (held.right?.sheathed !== undefined) {
        hung.push({ model: right, slot: Slot.scabbard, partShown: scabbard });
      }
    }
    if (left) {
      hung.push({
        model: left,
        slot: Slot.left,
        partShown: (part) => !scabbard(part),
        blood: blood.left,
      });
    }
    if (ammo) {
      hung.push({ model: ammo, slot: Slot.quiver, partShown: (part) => !singleArrow(part) });
      hung.push({ model: ammo, slot: Slot.arrow, partShown: singleArrow });
    }
    if (hung.length === 0) return undefined;
    // The slots, and each model's nodes merged under its slot (by name, as worn models are).
    const local = new Float32Array(SLOT_NAMES.length * 16);
    for (let i = 0; i < SLOT_NAMES.length; i++) local.set(IDENTITY, i * 16);
    const slots = { names: SLOT_NAMES, parents: Int16Array.from(SLOT_NAMES, () => -1), local };
    const dressed = wearOnRig(
      slots,
      hung.map(({ model, slot }) => ({
        nodes: model.nodes ?? [{ name: '', parent: -1, local: IDENTITY }],
        attachTo: SLOT_NAMES[slot],
      })),
    );
    const weapons = new HeldWeapons(body, held);
    const pose = new Pose(new ActorSkeleton(dressed.rig, undefined));
    weapons.#pose = pose;
    // The right weapon's own graph (a bow's), started in its rest state.
    const rightMap = right ? dressed.nodeMaps[0] : undefined;
    if (right?.skeletal && right.nodes && rightMap) {
      weapons.#graph = WeaponGraph.start(right.nodes, right.skeletal, seededRandom(seed), rightMap);
    }
    const instances: ModelInstance[] = hung.map(({ model, partShown, blood: level }, i) => ({
      model,
      world: body.world,
      motion: body.motion,
      visibility: body.visibility,
      pose,
      ...(dressed.nodeMaps[i] && { poseNodes: dressed.nodeMaps[i] }),
      partShown,
      ...(level && { weaponBlood: level }),
    }));
    weapons.#scene = renderer.scene.createScene(instances);
    return weapons;
  }

  /** The scene that draws them. */
  get scene(): GpuScene | undefined {
    return this.#destroyed ? undefined : this.#scene;
  }

  /** The events the wielder's graph raised: its weapon's graph hears them too. */
  hear(events: readonly string[]): void {
    this.#graph?.hear(events);
  }

  /** A variable the engine sets on the wielder's graphs, set on its weapon's too. */
  setVariable(name: string, value: number): void {
    this.#graph?.setVariable(name, value);
  }

  #node(name: string | undefined): number | undefined {
    if (name === undefined) return undefined;
    return this.#body.pose.skeleton.nodeByName.get(name.toLowerCase());
  }

  /**
   * Every frame after the body's pose: the slots go where the body's nodes are (the right
   * weapon in the hand while `inHand`, the left drawn only, the arrow while nocked); the right
   * weapon's graph runs on by `seconds` and moves its nodes.
   */
  update(inHand: boolean, arrowNocked: boolean, seconds = 0): void {
    const held = this.#held;
    const places: (string | undefined)[] = [
      inHand ? 'WEAPON' : held.right?.sheathed,
      held.right?.sheathed,
      inHand ? 'SHIELD' : undefined,
      'QUIVER',
      arrowNocked ? 'WEAPON' : undefined,
    ];
    const pose = this.#pose;
    if (!pose) return;
    const body = this.#body.pose.worlds;
    places.forEach((name, slot) => {
      const node = this.#node(name);
      this.#nodes[slot] = node;
      let world = this.#driven.get(slot);
      if (!world) {
        world = new Float32Array(16);
        this.#driven.set(slot, world);
      }
      if (node === undefined) {
        // Not shown: shrunk to nothing at the body's origin.
        world.fill(0);
        world[15] = 1;
        return;
      }
      world.set(body.subarray(node * 16, node * 16 + 16));
    });
    // The right weapon's graph runs on; its moved nodes hang under the right slot.
    const hang = this.#driven.get(Slot.right);
    if (hang) this.#graph?.update(seconds, hang, this.#driven);
    pose.place(this.#driven);
  }

  destroy(): void {
    this.#destroyed = true;
    this.#scene?.destroy();
    this.#scene = undefined;
  }
}
