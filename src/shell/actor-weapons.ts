// The weapons an actor holds, drawn on its body (docs/ai.md, "Combat"): each weapon's world
// model (WEAP MODL) hangs on its sheath node while sheathed (its "Prn": WeaponSword,
// WeaponDagger, WeaponAxe, WeaponMace, WeaponBack, WeaponBow; the equip system's weaponNodes)
// and on its drawn node while drawn (WEAPON in the right hand, SHIELD in the left; a bow in
// SHIELD, the hand that holds it), moved across at the graph's weaponDraw and weaponSheathe
// annotations; its scabbard (the model's "Scb" shape) stays at the sheath. A left-hand weapon is
// not shown sheathed (vanilla's skeleton has no left-hand sheaths). The ammunition hangs in the
// quiver (QUIVER: the AMMO model's quiver and arrows, its single "Arrow:0" left out); from
// arrowAttach to arrowRelease an arrow is on the bow (the AMMO model's "Arrow:0" on WEAPON, which
// the bow animations carry to where the nocked arrow lies, pointing along the shot).
// Shields are worn armour (their addon hangs on SHIELD with the actor's look). A torch (a LIGH
// that can be carried) is held on SHIELD whether the weapons are drawn or not, an instance of
// its own placed there every frame (its fire's particles and billboards follow it as a placed
// light's do); its light shines from its model's AttachLight node (torchLight). The player's
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
import type { GraphEvent } from '../animation/graph-events.ts';
import { ActorPose as Pose, ActorSkeleton, wearOnRig } from '../animation/skeleton.ts';
import { WeaponGraph } from '../animation/weapon-graph.ts';
import type { ModelNode, ModelPart } from '../render/model-data.ts';
import { multiply, transformPoint, type Mat4 } from '../render/math.ts';
import type { RenderPort } from '../render/render-port.ts';
import type {
  GpuModel,
  GpuScene,
  InstanceFade,
  InstanceMotion,
  InstanceVisibility,
  ModelInstance,
  WeaponBloodLevel,
} from '../render/scene-renderer.ts';
import { meshPath, seededRandom } from '../world/actors.ts';
import type { GameSession } from './game-session.ts';

/** What an actor holds, as its models show it. */
export interface HeldModels {
  /** The right hand's weapon: its model and nodes (sheathed undefined: not shown sheathed). */
  readonly right?:
    | { readonly model: string; readonly sheathed: string | undefined; readonly drawn: string }
    | undefined;
  /** The left hand's one-handed weapon (drawn only). */
  readonly left?: { readonly model: string } | undefined;
  /** The ammunition's model (the quiver). */
  readonly ammo?: string | undefined;
  /**
   * The node a nocked shot is held on: an arrow's WEAPON, a bolt's right magic node; none for a
   * non-playable ammunition (without ammunition data: WEAPON).
   */
  readonly ammoNode?: string | null | undefined;
  /** A torch's model (LIGH MODL), held in the left hand whether weapons are drawn or not. */
  readonly torch?: string | undefined;
}

/** Where the models hang: the body's pose and placement. */
export interface HeldBody {
  readonly pose: ActorPose;
  readonly world: Float32Array;
  readonly motion: InstanceMotion;
  readonly visibility: InstanceVisibility;
  /** The body's distance fade: what it holds fades with it (ModelInstance.fade). */
  readonly fade?: InstanceFade;
  /** The first-person arms: the models are drawn in first person's view (ModelInstance). */
  readonly firstPerson?: boolean;
}

/** The weapons' blood (shared by the third- and first-person models of the same weapons). */
export interface HeldBlood {
  readonly right?: WeaponBloodLevel;
  readonly left?: WeaponBloodLevel;
}

/** Slots of the models' own pose: each copies a node of the body. */
const Slot = { right: 0, scabbard: 1, left: 2, quiver: 3, arrow: 4 } as const;
const SLOT_NAMES = ['right', 'scabbard', 'left', 'quiver', 'arrow'];

/** The node of a light's model its light shines from (torch.nif's flame). */
const ATTACH_LIGHT = 'attachlight';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The scabbard of a weapon model (SSE's "Scb" shape). */
const scabbard = (part: ModelPart): boolean => part.name.toLowerCase() === 'scb';
/** The single arrow of an ammunition model (beside the quiver). */
const singleArrow = (part: ModelPart): boolean => part.name.toLowerCase() === 'arrow:0';

/** A node's place in its model (by name, its parents' locals multiplied in; else the origin). */
function nodeWorld(nodes: readonly ModelNode[], name: string): Mat4 {
  let index = nodes.findIndex((node) => node.name.toLowerCase() === name);
  let world: Mat4 = new Float32Array(IDENTITY);
  while (index >= 0) {
    const node = nodes[index];
    if (!node) break;
    world = multiply(node.local, world);
    index = node.parent;
  }
  return world;
}

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
  /**
   * Its torch: an instance of its own placed on the hand every frame (so its fire's particles
   * and billboards follow it as a placed object's do), and where its light shines from in the
   * model (AttachLight, else its origin).
   */
  #torch:
    | {
        readonly world: Float32Array;
        readonly motion: InstanceMotion;
        readonly light: Mat4;
      }
    | undefined;
  #destroyed = false;
  /** Each hand's weapon instance (an enchanted one's glow covers it: actor-effects.ts). */
  readonly #hands = new Map<'right' | 'left', ModelInstance>();

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
    renderer: RenderPort,
    body: HeldBody,
    held: HeldModels,
    blood: HeldBlood = {},
    seed = 0,
  ): Promise<HeldWeapons | undefined> {
    const load = (path: string | undefined): Promise<GpuModel | undefined> =>
      path === undefined || !session.vfs.has(meshPath(path))
        ? Promise.resolve(undefined)
        : session.model(meshPath(path));
    const [right, left, ammo, torch] = await Promise.all([
      load(held.right?.model),
      load(held.left?.model),
      load(held.ammo),
      load(held.torch),
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
    if (hung.length === 0 && !torch) return undefined;
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
      ...(body.fade && { fade: body.fade }),
      ...(body.firstPerson && { firstPerson: true }),
      pose,
      ...(dressed.nodeMaps[i] && { poseNodes: dressed.nodeMaps[i] }),
      partShown,
      ...(level && { weaponBlood: level }),
    }));
    hung.forEach(({ slot }, i) => {
      const instance = instances[i];
      if (!instance) return;
      if (slot === Slot.right) weapons.#hands.set('right', instance);
      else if (slot === Slot.left) weapons.#hands.set('left', instance);
    });
    if (torch) {
      const world = new Float32Array(16);
      const motion: InstanceMotion = { version: 0 };
      weapons.#torch = { world, motion, light: nodeWorld(torch.nodes ?? [], ATTACH_LIGHT) };
      instances.push({
        model: torch,
        world,
        motion,
        visibility: body.visibility,
        ...(body.fade && { fade: body.fade }),
        ...(body.firstPerson && { firstPerson: true }),
      });
    }
    weapons.#scene = renderer.scene.createScene(instances);
    return weapons;
  }

  /** A hand's weapon as drawn (undefined: none, or the models are gone). */
  hand(hand: 'right' | 'left'): ModelInstance | undefined {
    return this.#destroyed ? undefined : this.#hands.get(hand);
  }

  /** Whether the models are shown (their body's visibility). */
  get visibility(): InstanceVisibility {
    return this.#body.visibility;
  }

  /** The scene that draws them. */
  get scene(): GpuScene | undefined {
    return this.#destroyed ? undefined : this.#scene;
  }

  /** The events the wielder's graph raised: its weapon's graph hears them too. */
  hear(events: readonly GraphEvent[]): void {
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
   * weapon in its drawn node while `inHand`, the left drawn only, the arrow while nocked); the right
   * weapon's graph runs on by `seconds` and moves its nodes.
   */
  update(inHand: boolean, arrowNocked: boolean, seconds = 0): void {
    const held = this.#held;
    const places: (string | undefined)[] = [
      inHand ? held.right?.drawn : held.right?.sheathed,
      held.right?.sheathed,
      inHand ? 'SHIELD' : undefined,
      'QUIVER',
      arrowNocked && held.ammoNode !== null ? (held.ammoNode ?? 'WEAPON') : undefined,
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
    // The torch in the left hand (SHIELD), drawn or not.
    const torch = this.#torch;
    const hand = this.#node('SHIELD');
    if (torch && hand !== undefined) {
      multiply(this.#body.world, body.subarray(hand * 16, hand * 16 + 16), torch.world);
      torch.motion.version++;
    }
  }

  /** Where its torch's light is in the world (undefined: no torch held, or not shown). */
  torchLight(): [number, number, number] | undefined {
    const torch = this.#torch;
    if (!torch || this.#destroyed || this.#body.visibility.hidden || torch.motion.version === 0) {
      return undefined;
    }
    return transformPoint(multiply(torch.world, torch.light), [0, 0, 0]);
  }

  destroy(): void {
    this.#destroyed = true;
    this.#scene?.destroy();
    this.#scene = undefined;
  }
}
