// A world being played: the physics world with the collision of the loaded cells (placed a
// few per frame so loading does not stutter), the player standing in it, the free camera
// (tfc), and the simulated objects whose drawn models follow their bodies. Shared by the
// exterior and interior viewers.

import type RAPIER from '@dimforge/rapier3d-compat';
import { ActorPose } from '../animation/skeleton.ts';
import { Articulation } from '../physics/articulation.ts';
import { HAVOK_SCALE, settlesWhenPlaced, type CollisionData } from '../physics/collision-data.ts';
import { GrabSpring, TelekinesisHold } from '../physics/grab.ts';
import { Layer } from '../physics/collision-layers.ts';
import { landscapeMesh } from '../physics/landscape.ts';
import type {
  PhysicsImpact,
  PhysicsWorld,
  PickHit,
  PlacedBody,
  PlacedCollision,
} from '../physics/physics-world.ts';
import { objectWorld, playSequence, type Playback } from '../render/animation.ts';
import type { FlyCamera } from '../render/fly-camera.ts';
import { invert } from '../render/frustum.ts';
import { multiply, type Mat4, type Vec3 } from '../render/math.ts';
import type { Camera } from '../render/view-camera.ts';
import type { InstanceMotion, ModelInstance, PointLight } from '../render/scene-renderer.ts';
import type { CellObject, CellPrimitive, ObjectLock, Teleport } from '../world/cell-loader.ts';
import { lockDifficulty, lockLevelSetting } from '../gameplay/lockpicking.ts';
import type { LandData } from '../world/land.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorMotion, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Player } from './player.ts';
import { attachPlayerInput } from './player-input.ts';
import type { HudSignals } from './hud-signals.ts';
import type { ActorTarget } from './actors.ts';

/**
 * How long the sandbox's notice stays (it has no HUD); also how long a notification repeated
 * without a pause stays one (the HUD queues each it is given).
 */
const NOTICE_MS = 3000;

/** Milliseconds per frame spent placing collision of loaded cells. */
const COLLISION_BUDGET_MS = 3;
/**
 * Waiting this long for the ground's collision, the player is placed anyway (seconds): only a
 * safety net, the ground's cells always finish loading. A shorter wait placed players on slow
 * frames (a heavy city, a hidden tab) before their floor was there: under it.
 */
const GROUND_WAIT_SECONDS = 60;

/** Seconds on the renderer's clock (sequences and their collision run on it). */
const clock = (): number => performance.now() / 1000;

/** How long ago a door that comes in open opened (seconds): past any open sequence's end. */
const OPENED_LONG_AGO = 1e6;

/** An object the player holds (the Z key's or Telekinesis's grab). */
interface HeldObject {
  readonly spring: GrabSpring;
  readonly distance: number;
  /** A telekinetic hold: its pull, its throw, and whether it is dual cast. */
  readonly telekinesis?: { readonly hold: TelekinesisHold; dual: boolean };
  /** Its reference (told as grabbed and released). */
  readonly reference: number | undefined;
}

/** The reference a pick met (an object's or an actor's), if it has one (not the landscape). */
const ownReference = (hit: PickHit): number | undefined =>
  hit.owner && hit.owner.kind !== 'landscape' && hit.owner.reference !== 0
    ? hit.owner.reference
    : undefined;

/**
 * A door that is not a load door, or a container, whose model has an open sequence: its
 * sequence state (doors open and close as they are activated, containers while their menu is
 * open). A door comes in open as the scripts left it (`openState`, GetOpenState's 1 open .. 4
 * closing), else as placed (ONAM): its open sequence played long ago, held at its end.
 */
export function openable(
  object: CellObject,
  hasOpen: boolean,
  openState?: number,
): Playback | undefined {
  if (!(
    ((object.baseType === 'DOOR' && !object.teleport) || object.baseType === 'CONT') &&
    hasOpen
  )) {
    return undefined;
  }
  const open =
    object.baseType === 'DOOR' &&
    (openState === undefined ? object.openByDefault === true : openState === 1 || openState === 2);
  return open ? { sequence: 'open', start: -OPENED_LONG_AGO } : { sequence: undefined, start: 0 };
}

/** What activating containers and items does in a running game (Play). */
export interface ObjectUses {
  /** A game setting's text (the prompts' verbs: sOpen, sTake, ...). */
  text(setting: string): string;
  /** Opens a container's menu; `closed` once the player has closed it. */
  openContainer(reference: number, closed: () => void): void;
  /** The player takes an item lying in the world. */
  take(object: CellObject): void;
  /** The player reads a book lying in the world (the book menu; it can be taken from there). */
  read(object: CellObject): void;
  /** The player sleeps in a bed (the sleep menu; as in the game they do not lie down). */
  sleep(object: CellObject): void;
  /** The player uses a workbench (the crafting menu); `closed` once its menu is closed. */
  craft(object: CellObject, closed?: () => void): void;
  /** A load door was opened: its prompt stays while its place loads. */
  loadDoor(text: string): void;
  /** Its lock now, if it is locked (scripts lock and unlock: the state, else as placed). */
  lockOf(object: CellObject): ObjectLock | undefined;
  /**
   * Opens a lock: with its key (sOpenWithKey), else by picking it (the lockpicking menu);
   * `then` once it is open by its key (activating it goes on).
   */
  unlock(object: CellObject, then: () => void): void;
  /**
   * Whether taking the object (an item, a container's contents) is stealing: another owns it
   * (crime-engine.ts mayTake; false until known).
   */
  owned?(object: CellObject): boolean;
  /** The player sneaks: activating an actor picks its pockets. */
  sneaking?(): boolean;
  /** Opens an actor's pockets (the container menu in pickpocket mode). */
  pickpocket?(actor: number): void;
  /** The player harvests flora (its ingredient, src/scripting/runtime/harvest-engine.ts). */
  harvest?(object: CellObject): void;
  /** Whether flora has been harvested (it has not grown again). */
  harvested?(object: CellObject): boolean;
  /** The player set a door or container swinging (its playback's new sequence: OnOpen, OnClose). */
  swung?(object: CellObject, instance: ModelInstance): void;
}

/**
 * What activating a placed object does: load doors take the player to their destination;
 * other doors open and close. In a running game (`uses`) containers open their menu (their
 * lid opening meanwhile), books read, other items taken, beds slept in; owned ones are stolen
 * (sSteal, sStealFrom: their red verbs) and locked ones picked (the lockpicking menu).
 * Flora is harvested (FLOR / TREE PFIG; as many as the perks give: Mod Ingredients Harvested,
 * Green Thumb). Furniture is sat in (sSit) and workbenches open the crafting menu.
 */
export function objectActivation(
  object: CellObject,
  instance: ModelInstance | undefined,
  travel: {
    readonly name: (teleport: Teleport) => string;
    readonly go: (teleport: Teleport) => void;
  },
  /** Plays a sound (SNDR) at the object. */
  sound?: (descriptor: number, at: Vec3) => void,
  uses?: ObjectUses,
  /** The player gets into furniture (src/shell/player-furniture.ts). */
  seat?: {
    use(object: CellObject, then?: (leave: () => void) => void): Promise<boolean>;
  },
): Activatable | undefined {
  const at: Vec3 = [object.world[12] ?? 0, object.world[13] ?? 0, object.world[14] ?? 0];
  const play = (descriptor: number | undefined): void => {
    if (descriptor !== undefined) sound?.(descriptor, at);
  };
  const verb = (setting: string, english: string): string => uses?.text(setting) ?? english;
  const teleport = object.teleport;
  // A locked door or container: "Unlock", its name with its lock's level (UESP, "Lockpicking").
  const lock = (object.baseType === 'DOOR' || object.baseType === 'CONT') && uses?.lockOf(object);
  if (uses && lock) {
    const name = teleport ? travel.name(teleport) : object.name;
    return {
      verb: verb('sUnlock', 'Unlock'),
      name: `${name} (${uses.text(lockLevelSetting(lockDifficulty(lock.level)))})`,
      activate: () => {
        uses.unlock(object, () => {
          objectActivation(object, instance, travel, sound, uses, seat)?.activate();
        });
      },
    };
  }
  if (teleport) {
    const name = travel.name(teleport);
    return {
      verb: verb('sOpen', 'Open'),
      name,
      activate: () => {
        play(object.sounds?.open);
        uses?.loadDoor(`${verb('sOpen', 'Open')}
${name}`);
        travel.go(teleport);
      },
    };
  }
  const playback = instance?.playback;
  const sequence = (name: 'open' | 'close'): void => {
    if (!playback) return;
    playback.sequence = name;
    playback.start = clock();
    uses?.swung?.(object, instance);
  };
  if (uses && object.baseType === 'CONT') {
    return {
      verb:
        uses.owned?.(object) === true ? verb('sStealFrom', 'Steal from') : verb('sOpen', 'Open'),
      name: object.name,
      activate: () => {
        play(object.sounds?.open);
        sequence('open');
        uses.openContainer(object.reference, () => {
          play(object.sounds?.close);
          sequence('close');
        });
      },
    };
  }
  // Flora with an ingredient is harvested ("Harvest", its RNAM: "Catch", "Pick"); harvested,
  // it offers nothing until it grows again.
  if (uses?.harvest && object.harvestable) {
    if (uses.harvested?.(object) === true) return undefined;
    return {
      verb: object.activateText ?? verb('sHarvest', 'Harvest'),
      name: object.name,
      activate: () => {
        uses.harvest?.(object);
      },
    };
  }
  if (uses && object.item && object.readable) {
    return {
      verb: verb('sRead', 'Read'),
      name: object.name,
      item: object.item,
      activate: () => {
        uses.read(object);
      },
    };
  }
  if (uses && object.item) {
    return {
      verb: uses.owned?.(object) === true ? verb('sSteal', 'Steal') : verb('sTake', 'Take'),
      name: object.name,
      item: object.item,
      activate: () => {
        uses.take(object);
      },
    };
  }
  if (uses && object.furniture && object.furniture.workbench !== 0) {
    return {
      verb: verb('sCraft', 'Craft'),
      name: object.name,
      activate: () => {
        // At the workbench first (its idle), its menu then; closing it gets the player up.
        if (!seat || !object.furniture?.sit) {
          uses.craft(object);
          return;
        }
        void seat.use(object, (leave) => {
          uses.craft(object, leave);
        });
      },
    };
  }
  if (uses && object.furniture?.sleep) {
    return {
      verb: verb('sFurnitureSleep', 'Sleep'),
      name: object.name,
      activate: () => {
        uses.sleep(object);
      },
    };
  }
  if (seat && object.furniture?.sit) {
    return {
      verb: verb('sSit', 'Sit'),
      name: object.name,
      activate: () => {
        void seat.use(object);
      },
    };
  }
  if (playback && object.baseType === 'DOOR') {
    const open = playback.sequence === 'open';
    return {
      verb: open ? verb('sClose', 'Close') : verb('sOpen', 'Open'),
      name: object.name,
      activate: () => {
        play(open ? object.sounds?.close : object.sounds?.open);
        sequence(open ? 'close' : 'open');
      },
    };
  }
  return undefined;
}

/** Something the player can activate: what the prompt says, and what activating does. */
export interface Activatable {
  /** "Open", "Take", ... */
  readonly verb: string;
  /** What it is (a door's destination, an item's name). */
  readonly name: string;
  /** An item's weight and value (the crosshair shows them under its name). */
  readonly item?: { readonly weight: number; readonly value: number };
  /** The reference activated (the perks may keep the player from it: Filter Activation). */
  readonly reference?: number;
  activate(): void;
}

/** What a follower's command mode commands (src/shell/actor-favors.ts). */
export interface FavorPicker {
  /** How far the crosshair reaches (fFavorRequestPickDistance). */
  readonly reach: number;
  /**
   * What activating commands: at a reference (an actor or an object the crosshair rests on),
   * else at a point (the ground, a wall); undefined: nothing.
   */
  target(reference: number | undefined, point: Vec3 | undefined): Activatable | undefined;
}

/** The player's perks on activating a reference (src/scripting/runtime/perk-engine.ts). */
export interface PerkActivation {
  /** Filter Activation: whether the player may activate it (a werewolf opens no doors). */
  allowed(reference: number): Promise<boolean>;
  /** Set Activate Label: the verb the perks give it, if any. */
  label(reference: number): Promise<string | undefined>;
  /**
   * Activate: the perks' choices run (or are offered beside the default activation, `verb`,
   * in a message box); resolves whether the default activation goes on.
   */
  choose(reference: number, verb: string, name: string): Promise<boolean>;
}

/** The player's perk activation on a running game's perk system. */
export function perkActivation(runtime: () => ScriptRuntime | undefined): PerkActivation {
  return {
    allowed: async (reference) => {
      const perks = runtime()?.perks;
      return !perks || !(await perks.activationFiltered(PLAYER_REF, reference));
    },
    label: async (reference) => runtime()?.perks.activateLabel(PLAYER_REF, reference),
    choose: async (reference, verb, name) => {
      const perks = runtime()?.perks;
      return !perks || perks.activate(PLAYER_REF, reference, verb, name);
    },
  };
}

/** The collision of one loaded cell. */
export interface CollisionGroup {
  readonly collision: PlacedCollision[];
  /** Whether all of it has been placed. */
  ready: boolean;
  /** Simulated objects that settle once all of the cell's collision is in place. */
  readonly settle: PlacedCollision[];
  /** Simulated objects with the drawn instance that follows each. */
  readonly moving: {
    readonly placed: PlacedCollision;
    readonly instance: ModelInstance;
    readonly motion: InstanceMotion;
  }[];
  /**
   * Objects playing sequences (doors): their keyframed bodies follow the animation; `held`: the
   * start of the sequence whose end pose they were put in last.
   */
  readonly animated: {
    readonly placed: PlacedCollision;
    readonly instance: ModelInstance;
    held?: number;
  }[];
  /** Objects whose behavior graph moves their nodes: those nodes' bodies follow the pose. */
  readonly posed: PosedCollision[];
  /** Objects whose bodies move their nodes one by one (ragdolls, hinged signs, chains). */
  readonly articulated: Articulation[];
  /** What waits for all of it to be in place (actors set on the ground). */
  readonly whenComplete: (() => void)[];
}

/** A placed object's bodies on nodes its skeleton moves. */
interface PosedCollision {
  readonly placed: PlacedCollision;
  readonly instance: ModelInstance;
  readonly pose: ActorPose;
  /** Each body with its pose node and its place relative to that node (model space). */
  readonly bodies: readonly {
    readonly body: PlacedBody;
    readonly node: number;
    readonly offset: Mat4;
  }[];
  /** The pose version the bodies were last moved to. */
  version: number;
}

/** The lower-case names of an instance's nodes that its skeleton moves, by pose node. */
function posedNodes(instance: ModelInstance | undefined): Map<string, number> | undefined {
  const nodes = instance?.model.nodes;
  const poseNodes = instance?.poseNodes;
  if (!instance?.pose || !nodes || !poseNodes) return undefined;
  const moved = new Map<string, number>();
  nodes.forEach((node, i) => {
    const poseNode = poseNodes[i] ?? -1;
    if (poseNode >= 0) moved.set(node.name.toLowerCase(), poseNode);
  });
  return moved.size > 0 ? moved : undefined;
}

export function collisionGroup(): CollisionGroup {
  return {
    collision: [],
    ready: false,
    settle: [],
    moving: [],
    animated: [],
    posed: [],
    articulated: [],
    whenComplete: [],
  };
}

/** What a cell contributes to the physics world. */
export interface CellCollision {
  /** Exterior cells: the landscape, with the cell's grid position. */
  readonly land?: { readonly data: LandData; readonly x: number; readonly y: number };
  /** Objects with their collision and, if drawn, their instance. */
  readonly objects: readonly {
    readonly object: CellObject;
    readonly collision: CollisionData | undefined;
    readonly instance: ModelInstance | undefined;
    /** Its pose, where its bodies move its nodes one by one (src/physics/articulation.ts). */
    readonly articulated?: ActorPose;
  }[];
  /** Collision primitives. */
  readonly primitives: readonly CellPrimitive[];
  /** The dead: ragdolls of their skeletons' bodies, which fall as the cell settles. */
  readonly ragdolls?: readonly CellRagdoll[];
  /** Runs once all of it is in place (and queries see it). */
  readonly whenComplete?: () => void;
  /**
   * Whether a reference is enabled now: a disabled one's collision is placed switched off (it
   * comes back when a script enables it). All are enabled without.
   */
  readonly isEnabled?: (reference: number) => boolean;
}

/** A dead actor's ragdoll: its skeleton's bodies (skeleton.nif) moving its pose's nodes. */
export interface CellRagdoll {
  readonly reference: number;
  /** Its placement (its instances share it). */
  readonly world: Mat4;
  readonly collision: CollisionData | undefined;
  readonly pose: ActorPose;
}

export class PlaySession {
  readonly physics: PhysicsWorld;
  readonly player: Player;
  /** The free camera (tfc); also looks while the player waits for the ground to load. */
  readonly camera: FlyCamera;
  /** What the renderer looks through: the player's camera or the free camera. */
  readonly view: Camera;
  readonly #canvas: HTMLElement;
  readonly #groundReady: (feet: Vec3) => boolean;
  readonly #searchAbove: number;
  readonly #queue: { readonly group: CollisionGroup; readonly run: () => void }[] = [];
  /** Callbacks of cells whose collision is complete, run once queries see it. */
  readonly #completed: (() => void)[] = [];
  readonly #groups = new Set<CollisionGroup>();
  #spawnPending = true;
  /** When the player started waiting for the ground (seconds). */
  #spawnSince: number | undefined;
  /** The player arrives through a door: on the floor at its feet. */
  readonly #arrivesOnFloor: boolean;
  #freeCamera = false;
  #detach: (() => void) | undefined;
  /** Called when the free camera is switched on or off (to update a checkbox). */
  onFreeCamera: ((free: boolean) => void) | undefined;
  readonly #activatable: ((reference: number) => Activatable | undefined) | undefined;
  readonly #actorAt:
    | ((
        origin: Vec3,
        direction: Vec3,
        length: number,
        radius: number,
        picked?: { readonly reference: number; readonly distance: number },
      ) => ActorTarget | undefined)
    | undefined;
  readonly #prompt: HTMLElement | undefined;
  readonly #hud: HudSignals | undefined;
  /** The HUD notification last given and when it was last asked for (a repeat is not queued). */
  #notified: { readonly text: string; readonly at: number } | undefined;
  readonly #notice: HTMLElement | undefined;
  readonly #onImpact: ((impact: PhysicsImpact) => void) | undefined;
  #noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the crosshair rests on. */
  #target: Activatable | undefined;
  #favorShown = false;
  readonly #perks: PerkActivation | undefined;
  /** Set Activate Label's verb of the reference the crosshair rests on (null: none). */
  #label: { readonly reference: number; verb: string | null | undefined } | undefined;
  /** Activate went down on a loose object: it is grabbed if still held after fZKeyDelay. */
  #hold:
    | {
        readonly since: number;
        readonly body: RAPIER.RigidBody;
        readonly point: Vec3;
        readonly target: Activatable | undefined;
        readonly reference: number | undefined;
      }
    | undefined;
  /** The object held (its spring), how far in front of the camera, and its reference. */
  #grab: HeldObject | undefined;

  /**
   * The player takes hold of an object or lets it go: the engine tells both (TESGrabReleaseEvent:
   * the object's OnGrab, OnRelease; observed in the original), the Z key's hold and Telekinesis's alike.
   */
  onGrab: ((reference: number, grabbed: boolean) => void) | undefined;

  #setGrab(grab: HeldObject | undefined): void {
    const before = this.#grab?.reference;
    this.#grab = grab;
    const after = grab?.reference;
    if (before === after) return;
    if (before !== undefined) this.onGrab?.(before, false);
    if (after !== undefined) this.onGrab?.(after, true);
  }

  /**
   * The player is put on the ground below their feet (searching from `searchAbove` higher)
   * once `groundReady` says the collision there is in place.
   */
  constructor(init: {
    physics: PhysicsWorld;
    player: Player;
    camera: FlyCamera;
    canvas: HTMLElement;
    groundReady: (feet: Vec3) => boolean;
    searchAbove: number;
    /** The player arrives through a door, standing on the floor (which it waits for). */
    arrivesOnFloor?: boolean;
    /** What a placed reference does when activated (undefined: nothing). */
    activatable?: (reference: number) => Activatable | undefined;
    /**
     * The actor the crosshair rests on (a ray: origin, unit direction, length, radius), how far
     * along the ray, and what activating it does.
     */
    actorAt?: (
      origin: Vec3,
      direction: Vec3,
      length: number,
      radius: number,
      /** The actor the physics pick met (its controller, bodies or ragdoll), if it met one. */
      picked?: { readonly reference: number; readonly distance: number },
    ) => ActorTarget | undefined;
    /** The player's perks on activation (Filter Activation, Activate, Set Activate Label). */
    perks?: PerkActivation;
    /** Where the activation prompt is shown. */
    prompt?: HTMLElement;
    /** The HUD's signals: the activation target goes to the game's HUD while one listens. */
    hud?: HudSignals;
    /** Where the game's notifications are shown. */
    notice?: HTMLElement;
    /** Collisions hard enough to be heard (the sound system's impact sounds). */
    onImpact?: (impact: PhysicsImpact) => void;
  }) {
    this.physics = init.physics;
    this.player = init.player;
    // Holding a heavy object the player walks (fZKeyHeavyWeight).
    init.player.holdingHeavy = () => {
      const body = this.#grab?.spring.body;
      return (
        body !== undefined && body.isValid() && body.mass() > init.player.grabLimits.heavyWeight
      );
    };
    this.camera = init.camera;
    this.#canvas = init.canvas;
    this.#groundReady = init.groundReady;
    this.#searchAbove = init.searchAbove;
    this.#arrivesOnFloor = init.arrivesOnFloor ?? false;
    this.#activatable = init.activatable;
    this.#actorAt = init.actorAt;
    this.#perks = init.perks;
    this.#prompt = init.prompt;
    this.#hud = init.hud;
    if (init.hud) {
      const hud = init.hud;
      init.player.onPress = (name) => {
        hud.userEvent(name);
      };
    }
    this.#notice = init.notice;
    this.#onImpact = init.onImpact;
    const active = (): Camera =>
      this.cameraOverride ?? (this.#freeCamera || this.#spawnPending ? this.camera : this.player);
    this.view = {
      get position() {
        return active().position;
      },
      get near() {
        return active().near;
      },
      get forward() {
        return active().forward;
      },
      update: (deltaSeconds) => {
        this.#frame(deltaSeconds);
        this.cameraOverride?.update(deltaSeconds);
      },
      viewProjection: (aspect, out) => active().viewProjection(aspect, out),
    };
  }

  /**
   * A camera a menu looks through in the player's place (the race menu's, on the player's
   * face), while it is set.
   */
  cameraOverride: Camera | undefined;
  /** Furniture holds the player (src/shell/player-furniture.ts): they do not move. */
  seated = false;
  /**
   * A follower's command mode (src/shell/actor-favors.ts): while set, Activate commands the
   * follower at what the crosshair rests on (the HUD's command crosshair) instead of activating.
   */
  favorMode: FavorPicker | undefined;
  /**
   * The player died (src/shell/player-death.ts): they neither move nor activate anything; the
   * world goes on around their body.
   */
  dead = false;
  /**
   * The player lies knocked down or gets up (src/shell/player-knockdown.ts): as the dead, they
   * neither move nor activate anything meanwhile.
   */
  knocked = false;

  /** Lights a menu adds to the world while it is open (the race menu's two). */
  extraLights: readonly PointLight[] = [];

  /** Whether the player's body is drawn: in third person, from the free camera or a menu's. */
  get bodyShown(): boolean {
    return this.cameraOverride !== undefined || this.#freeCamera || this.player.pov === 'third';
  }

  /** The player has been placed on the ground (the loading screen can go). */
  get spawned(): boolean {
    return !this.#spawnPending;
  }

  get freeCamera(): boolean {
    return this.#freeCamera;
  }

  /** How the player moves now (its conditions and natives read it). */
  playerMotion(): ActorMotion {
    const player = this.player;
    const { moving, running, sprinting } = player.motion;
    // Free camera, being placed or dead: the player does not move.
    const free = this.#freeCamera || this.#spawnPending || this.dead || this.knocked;
    const [vx, vy] = player.character.velocity;
    return {
      moving: !free && moving,
      running: !free && moving && running,
      sprinting: !free && sprinting,
      sneaking: player.sneaking,
      swimming: player.character.swimming,
      speed: free ? 0 : Math.hypot(vx, vy),
      pathing: false,
      heading: Math.atan2(this.player.forward[0], this.player.forward[1]),
      velocity: free ? [0, 0, 0] : [vx, vy, player.character.verticalSpeed],
      wish: free ? [0, 0] : [vx, vy],
    };
  }

  /** Where the player (or the free camera) looks along. */
  get forward(): Vec3 {
    return this.#freeCamera || this.#spawnPending ? this.camera.forward : this.player.forward;
  }

  set lensShift(shift: number) {
    this.camera.lensShift = shift;
    this.player.lensShift = shift;
  }

  /**
   * Shows one of the game's notifications: the HUD's in the game, the sandbox's notice (it has no
   * HUD) for a few seconds otherwise. A repeat while it shows only extends it.
   */
  notify(text: string): void {
    if (text === '') return;
    const hud = this.#hud;
    if (hud?.listening) {
      const now = performance.now();
      const last = this.#notified;
      this.#notified = { text, at: now };
      if (last?.text !== text || now - last.at > NOTICE_MS) hud.notification(text);
      return;
    }
    const notice = this.#notice;
    if (!notice) return;
    notice.textContent = text;
    notice.hidden = false;
    if (this.#noticeTimer !== undefined) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = setTimeout(() => {
      notice.hidden = true;
      this.#noticeTimer = undefined;
    }, NOTICE_MS);
  }

  /** Puts the player somewhere new (a door's destination); they wait for its ground. */
  placePlayer(feet: Vec3, yaw: number): void {
    this.player.teleport(feet, yaw);
    this.#spawnPending = true;
    this.#spawnSince = undefined;
  }

  /** Every frame: place pending collision, then move the player (or the free camera). */
  #frame(deltaSeconds: number): void {
    // The player is placed before this frame's collision: ray casts see what was placed until
    // the last physics step.
    if (this.#spawnPending) this.#trySpawn();
    const start = performance.now();
    while (this.#queue.length > 0 && performance.now() - start < COLLISION_BUDGET_MS) {
      const task = this.#queue.shift();
      if (!task) break;
      task.run();
      if (!this.#queue.some((other) => other.group === task.group)) this.#complete(task.group);
    }
    this.#moveKeyframed();
    if (this.#freeCamera || this.#spawnPending) {
      this.camera.update(deltaSeconds);
      this.physics.step(deltaSeconds, (step) => {
        for (const hook of this.stepHooks) hook(step);
      });
      this.#setTarget(undefined);
    } else if (this.dead || this.knocked) {
      // The world steps on; the player's keys do nothing.
      this.#setGrab(undefined);
      this.#hold = undefined;
      this.physics.step(deltaSeconds, (step) => {
        for (const hook of this.stepHooks) hook(step);
      });
      this.#setTarget(undefined);
    } else {
      this.player.onStep = (step) => {
        this.#holdGrabbed(step);
        for (const hook of this.stepHooks) hook(step);
      };
      // Where the ground has not loaded yet (streaming ahead of a fast player), the player
      // waits instead of falling through.
      this.player.update(deltaSeconds, this.seated || !this.#groundReady(this.player.feet));
      // What the player walked into moves from now on (held objects wait for a touch).
      for (const collider of this.player.character.touched) this.physics.touch(collider);
      // An actor nearer than what the physics pick found is the target. The pick meets actors'
      // character controllers, their keyframed BIPED bodies and the ragdolls of the dead
      // (L_ITEMPICKER collides with L_CHARCONTROLLER, L_BIPED and L_DEADBIP): the actor it met
      // is the target (actorAt) and hides what is behind it.
      const pickedAny = this.#pick();
      const pickedActor = pickedAny?.owner?.kind === 'actor' ? pickedAny.owner : undefined;
      const picked = pickedActor ? undefined : pickedAny;
      const ray = this.#pickRay();
      const actor = this.#actorAt?.(
        ray.origin,
        ray.direction,
        ray.length,
        ray.radius,
        pickedActor &&
          pickedAny && { reference: pickedActor.reference, distance: pickedAny.distance },
      );
      const actorFirst = actor !== undefined && (!picked || actor.distance < picked.distance);
      const hit = actorFirst ? undefined : picked;
      const favor = this.favorMode;
      if (favor) {
        // A follower's command mode: what the crosshair rests on is commanded, not activated.
        this.#setGrab(undefined);
        this.#hold = undefined;
        const target = this.#favorTarget(favor);
        this.#setTarget(target, true);
        if (this.player.takePressed('Activate')) target?.activate();
      } else {
        this.#setTarget(
          this.#grab ? undefined : actorFirst ? actor.target : this.#activatableAt(hit),
        );
        // A corpse the pick met (its ragdoll): held, Activate drags it; tapped, it is searched.
        const corpse =
          actorFirst && actor.corpse === true && pickedActor?.reference === actor.target.reference
            ? pickedAny
            : undefined;
        this.#activate(corpse ?? hit);
      }
    }
    for (const impact of this.physics.drainImpacts()) this.#onImpact?.(impact);
    this.#watchTriggers();
    // What waited for cells' collision, once queries see it.
    if (this.#completed.length > 0 && this.physics.queriesCurrent) {
      for (const run of this.#completed.splice(0)) run();
    }
    // Ragdolls and hinged objects: their nodes go where their bodies went.
    for (const group of this.#groups) for (const entry of group.articulated) entry.update();
    // Simulated objects that move take their drawn models along.
    for (const group of this.#groups) {
      for (const link of group.moving) {
        // Held bodies (kinematic until touched) stay where they are.
        const awake = link.placed.bodies.some(
          ({ body, data }) => data.motion === 'dynamic' && body.isDynamic() && !body.isSleeping(),
        );
        if (awake && link.placed.placement(link.instance.world)) link.motion.version++;
      }
    }
  }

  /**
   * What the crosshair rests on: a sphere of fActivatePickRadius cast from the camera along
   * the view for fActivatePickLength (further in third person, by the camera's distance from
   * the eyes), on the item picker layer.
   */
  #pick(): PickHit | undefined {
    const ray = this.#pickRay();
    return this.physics.pick(
      ray.origin,
      ray.direction,
      ray.length,
      ray.radius,
      Layer.itemPicker,
      this.player.character.collider,
    );
  }

  /** The activation pick's ray: from the camera along the view (see #pick). */
  #pickRay(): { origin: Vec3; direction: Vec3; length: number; radius: number } {
    const player = this.player;
    const { ini } = player;
    const camera = player.position;
    const eye = player.eye;
    const back = Math.hypot(camera[0] - eye[0], camera[1] - eye[1], camera[2] - eye[2]);
    return {
      origin: camera,
      direction: player.forward,
      length: ini.number('Interface', 'fActivatePickLength') + back,
      radius: ini.number('Interface', 'fActivatePickRadius'),
    };
  }

  /**
   * What the crosshair commands in a follower's command mode: the actor or object it rests on,
   * else the point of the ground, as far as the favor pick reaches (fFavorRequestPickDistance).
   */
  #favorTarget(favor: FavorPicker): Activatable | undefined {
    const ray = { ...this.#pickRay(), length: favor.reach };
    const picked = this.physics.pick(
      ray.origin,
      ray.direction,
      ray.length,
      ray.radius,
      Layer.itemPicker,
      this.player.character.collider,
    );
    const pickedActor = picked?.owner?.kind === 'actor' ? picked.owner : undefined;
    const actor = this.#actorAt?.(
      ray.origin,
      ray.direction,
      ray.length,
      ray.radius,
      pickedActor && picked && { reference: pickedActor.reference, distance: picked.distance },
    );
    if (actor && (!picked || actor.distance <= picked.distance)) {
      return favor.target(actor.target.reference, undefined);
    }
    const owner = picked?.owner;
    const reference =
      owner?.kind === 'object' && owner.reference !== 0 ? owner.reference : undefined;
    return favor.target(reference, picked?.point);
  }

  /**
   * Activates a target unless the player may not (the perks' Filter Activation); the perks'
   * Activate choices may run instead of (or before) its default activation.
   */
  #activateTarget(target: Activatable | undefined): void {
    if (!target) return;
    const reference = target.reference;
    const perks = this.#perks;
    if (reference === undefined || !perks) {
      target.activate();
      return;
    }
    void (async (): Promise<boolean> => {
      if (!(await perks.allowed(reference))) return false;
      return perks.choose(reference, target.verb, target.name);
    })().then((goOn) => {
      if (goOn) target.activate();
    });
  }

  #activatableAt(hit: PickHit | undefined): Activatable | undefined {
    const owner = hit?.owner;
    if (owner?.kind !== 'object') return undefined;
    const target = this.#activatable?.(owner.reference);
    return target && { ...target, reference: owner.reference };
  }

  /**
   * Activate: on a loose object it waits fZKeyDelay; let go before that it activates, held
   * longer it takes hold of the object (grab) until it is let go. Everything else activates
   * when pressed.
   */
  #activate(hit: PickHit | undefined): void {
    const player = this.player;
    // In furniture the player activates nothing (a movement key gets them up).
    if (this.seated) {
      player.takePressed('Activate');
      return;
    }
    if (player.takePressed('Activate') && !this.#grab) {
      const body = hit && this.physics.grabbable(hit.collider, hit.owner?.kind === 'actor');
      if (hit && body) {
        this.#hold = {
          since: clock(),
          body,
          point: hit.point,
          target: this.#target,
          reference: ownReference(hit),
        };
      } else {
        this.#activateTarget(this.#target);
      }
    }
    const hold = this.#hold;
    if (hold) {
      if (!player.isHeld('Activate')) {
        this.#hold = undefined;
        this.#activateTarget(hold.target);
      } else if (clock() - hold.since >= player.ini.number('Controls', 'fZKeyDelay')) {
        this.#hold = undefined;
        // Heavier than fGrabMaxWeightWalking: it is not taken hold of.
        if (hold.body.mass() > player.grabLimits.maxWeight) return;
        const camera = player.position;
        // Taken hold of: it moves from now on, even if it was placed asleep.
        this.physics.release(hold.body);
        // Those near comment on it (ZKeyObject).
        this.player.onAction?.('ZKEY');
        this.#setGrab({
          spring: new GrabSpring(hold.body, hold.point, player.grab),
          distance: Math.hypot(
            hold.point[0] - camera[0],
            hold.point[1] - camera[1],
            hold.point[2] - camera[2],
          ),
          reference: hold.reference,
        });
      }
    }
    if (this.#grab && !this.#grab.telekinesis && !player.isHeld('Activate'))
      this.#setGrab(undefined);
  }

  /**
   * Every physics step while something is held: its spring pulls towards the point the
   * camera looks at, at the distance it was taken. Dropped when it is left behind by more than
   * fActivatePickLength (the engine's rule is not documented: TODO(M13)) or no longer exists.
   */
  #holdGrabbed(step: number): void {
    const grab = this.#grab;
    if (!grab) return;
    if (!grab.spring.body.isValid()) {
      this.#setGrab(undefined);
      return;
    }
    const camera = this.player.position;
    const forward = this.player.forward;
    // A telekinetic hold pulls the object in, then holds it near (TelekinesisHold).
    grab.telekinesis?.hold.update(step);
    const distance = grab.telekinesis?.hold.distance ?? grab.distance;
    grab.spring.target = [
      camera[0] + forward[0] * distance,
      camera[1] + forward[1] * distance,
      camera[2] + forward[2] * distance,
    ];
    const point = grab.spring.point;
    const gap = Math.hypot(
      point[0] - grab.spring.target[0],
      point[1] - grab.spring.target[1],
      point[2] - grab.spring.target[2],
    );
    // A telekinetic hold pulls from afar; a held object left behind drops.
    if (!grab.telekinesis && gap > this.player.ini.number('Interface', 'fActivatePickLength')) {
      this.#setGrab(undefined);
      return;
    }
    grab.spring.apply(step);
  }

  /**
   * Telekinesis held (src/shell/player-casting.ts; `cast` while a hand casts it): the loose
   * object the crosshair finds within `reach` is taken hold of by the grab spring with
   * Telekinesis's settings (the player's grabSpring, as the Z key's: CommonLibSSE
   * PlayerCharacter GrabbingType kTelekinesis) at its middle, pulled in to
   * fMagicTelekinesisDistanceMin before the camera and held there (TelekinesisHold); let go once
   * held a moment, it flies along the view at the throw's speed, else it drops (the engine's,
   * observed in the original). TODO(M13): the thrown object's damage (fMagicTelekinesisDamage*, Mod
   * Telekinesis Damage Mult) waits for physics damage, which the engine gives thrown objects.
   */
  telekinesis(cast: { readonly dual: boolean } | undefined, reach: number): void {
    const grab = this.#grab;
    if (!cast) {
      if (grab?.telekinesis) {
        this.#setGrab(undefined);
        const body = grab.spring.body;
        const forward = this.player.forward;
        const speed = grab.telekinesis.hold.throwSpeed(grab.telekinesis.dual);
        // Thrown, it stops turning; dropped, it falls from rest.
        if (body.isValid() && speed > 0) body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        if (body.isValid())
          body.setLinvel(
            {
              x: (forward[0] * speed) / HAVOK_SCALE,
              y: (forward[1] * speed) / HAVOK_SCALE,
              z: (forward[2] * speed) / HAVOK_SCALE,
            },
            true,
          );
      }
      return;
    }
    if (grab?.telekinesis) grab.telekinesis.dual = cast.dual;
    if (grab || this.seated || this.dead || this.knocked) return;
    const ray = this.#pickRay();
    const hit = this.physics.pick(
      ray.origin,
      ray.direction,
      reach,
      ray.radius,
      Layer.itemPicker,
      this.player.character.collider,
    );
    const body = hit && this.physics.grabbable(hit.collider);
    if (!hit || !body) return;
    this.physics.release(body);
    // Held at its middle (the engine's: its shapes' middle), from where the camera saw it.
    const middle = body.worldCom();
    const point: Vec3 = [middle.x * HAVOK_SCALE, middle.y * HAVOK_SCALE, middle.z * HAVOK_SCALE];
    const camera = this.player.position;
    const distance = Math.hypot(point[0] - camera[0], point[1] - camera[1], point[2] - camera[2]);
    this.#setGrab({
      spring: new GrabSpring(body, point, this.player.telekinesis.spring),
      distance,
      telekinesis: {
        hold: new TelekinesisHold(this.player.telekinesis, distance),
        dual: cast.dual,
      },
      reference: ownReference(hit),
    });
  }

  /**
   * Shows what activating would do: the game's HUD in Play (`favor`: its command crosshair), the
   * engine's prompt elsewhere.
   */
  #setTarget(shown: Activatable | undefined, favor = false): void {
    const target = this.#labelled(shown);
    if (
      target?.verb === this.#target?.verb &&
      target?.name === this.#target?.name &&
      favor === this.#favorShown
    ) {
      this.#target = target;
      return;
    }
    this.#target = target;
    this.#favorShown = favor;
    if (this.#hud?.listening) {
      this.#hud.target(
        target && {
          verb: target.verb,
          name: target.name,
          ...(target.item && { item: target.item }),
        },
        favor,
      );
      if (this.#prompt) this.#prompt.hidden = true;
      return;
    }
    const prompt = this.#prompt;
    if (!prompt) return;
    prompt.hidden = !target;
    const key = this.player.keyOf('Activate') ?? '';
    prompt.textContent = target ? `${key}  ${target.verb}  ${target.name}` : '';
  }

  /**
   * The target with the verb the player's perks give it (Set Activate Label: a werewolf's
   * Feed), asked once as the crosshair comes to rest on a reference.
   */
  #labelled(target: Activatable | undefined): Activatable | undefined {
    const reference = target?.reference;
    const perks = this.#perks;
    if (!target || reference === undefined || !perks) {
      this.#label = undefined;
      return target;
    }
    let label = this.#label;
    if (label?.reference !== reference) {
      const asked: { readonly reference: number; verb: string | null | undefined } = {
        reference,
        verb: undefined,
      };
      label = asked;
      this.#label = asked;
      void perks.label(reference).then((verb) => {
        asked.verb = verb ?? null;
      });
    }
    return label.verb ? { ...target, verb: label.verb } : target;
  }

  /**
   * Keyframed bodies of objects playing a sequence go where the sequence puts their nodes, and
   * those on nodes a behavior graph moves where its pose puts them.
   */
  #moveKeyframed(): void {
    const now = clock();
    for (const group of this.#groups) {
      for (const entry of group.posed) {
        const { pose, placed, instance } = entry;
        if (entry.version === pose.version) continue;
        entry.version = pose.version;
        for (const { body, node, offset } of entry.bodies) {
          const world = pose.worlds.subarray(node * 16, node * 16 + 16);
          this.physics.moveBody(placed, body, multiply(world, offset), instance.world);
        }
      }
      for (const entry of group.animated) {
        const { placed, instance } = entry;
        const playback = instance.playback;
        const sequences = instance.model.sequences;
        if (!playback?.sequence || !sequences) continue;
        // Past its end the sequence holds its last pose: nothing moves any more, once the
        // bodies are there (a door that came in open: its sequence ended before it loaded).
        const duration = sequences.byName.get(playback.sequence)?.duration ?? 0;
        if (now - playback.start > duration + 0.5) {
          if (entry.held === playback.start) continue;
          entry.held = playback.start;
        }
        const frame = playSequence(sequences, playback, now);
        for (const body of placed.bodies) {
          if (body.data.motion !== 'keyframed') continue;
          const node = sequences.objects.get(body.data.node);
          if (node === undefined) continue;
          const rest = objectWorld(sequences, undefined, node);
          const moved = objectWorld(sequences, frame, node);
          const restInverse = rest && invert(rest);
          if (!moved || !restInverse) continue;
          const pose = multiply(multiply(moved, restInverse), body.data.transform);
          this.physics.moveBody(placed, body, pose, instance.world);
        }
      }
    }
  }

  /**
   * The trigger volumes the player is in: entering and leaving one is told (OnTriggerEnter,
   * OnTriggerLeave). Actors' own come through their movers (src/shell/actor-movers.ts).
   */
  #watchTriggers(): void {
    if (!this.physics.queriesCurrent || this.#spawnPending) return;
    const inside = this.physics.triggersOverlapping(this.player.character.collider);
    for (const reference of inside) {
      if (!this.#inTriggers.has(reference)) this.onTrigger?.(reference, true);
    }
    for (const reference of this.#inTriggers) {
      if (!inside.has(reference)) this.onTrigger?.(reference, false);
    }
    this.#inTriggers = inside;
  }

  /** How many of the tracked (the player) are in a trigger volume now. */
  triggerCount(reference: number): number {
    return this.#inTriggers.has(reference) ? 1 : 0;
  }

  /** The player entered (true) or left a trigger volume of a reference. */
  onTrigger: ((reference: number, entered: boolean) => void) | undefined;
  /**
   * What runs on every physics step, before the world steps, after the player moved: the
   * actors' character controllers (src/shell/actor-stage.ts).
   */
  readonly stepHooks = new Set<(step: number) => void>();
  #inTriggers = new Set<number>();

  /** A cell's collision is complete: the warm start lets its loose objects settle. */
  #complete(group: CollisionGroup): void {
    group.ready = true;
    for (const placed of group.settle.splice(0)) this.physics.settle(placed);
    this.#completed.push(...group.whenComplete.splice(0));
  }

  #trySpawn(): void {
    const [x, y, z] = this.player.feet;
    const now = performance.now() / 1000;
    this.#spawnSince ??= now;
    // The ground's collision is placed, and ray casts see it (after a physics step).
    const ready = this.#groundReady([x, y, z]) && this.physics.queriesCurrent;
    if (!ready && now - this.#spawnSince < GROUND_WAIT_SECONDS) return;
    if (this.#arrivesOnFloor) {
      // Through a door: onto its floor; without a floor there, at the door's own height.
      this.player.teleport([x, y, this.player.arrivalFloor([x, y, z])?.height ?? z]);
    } else {
      // The ray starts inside the player (standing there already): not their own shape.
      const own = this.player.character.collider;
      const hit = this.physics.raycast(
        [x, y, z + this.#searchAbove],
        [0, 0, -1],
        this.#searchAbove + 65536,
        Layer.charController,
        own,
      );
      this.player.teleport([x, y, hit ? hit.point[2] : z]);
    }
    // Out of what the player stands in (an arrival point close to its door).
    this.player.character.recover();
    this.#spawnPending = false;
    this.#spawnSince = undefined;
  }

  /** Queues a cell's collision (placed a few per frame, in the order cells are added). */
  add(group: CollisionGroup, cell: CellCollision): void {
    const physics = this.physics;
    this.#groups.add(group);
    const tasks: (() => void)[] = [];
    if (cell.whenComplete) group.whenComplete.push(cell.whenComplete);
    const land = cell.land;
    if (land) {
      tasks.push(() => {
        const { vertices, indices } = landscapeMesh(land.data, land.x, land.y);
        group.collision.push(
          physics.addMesh(vertices, indices, Layer.ground, { reference: 0, kind: 'landscape' }),
        );
      });
    }
    for (const { object, collision, instance, articulated } of cell.objects) {
      if (!collision || collision.bodies.length === 0) continue;
      tasks.push(() => {
        // Asleep until the cell's collision is complete (nothing to rest on before that).
        const moved = posedNodes(instance);
        const placed = physics.addObject(
          collision,
          object.world,
          { reference: object.reference, kind: 'object' },
          false,
          moved && new Set(moved.keys()),
        );
        group.collision.push(placed);
        if (cell.isEnabled?.(object.reference) === false) physics.setEnabled(placed, false);
        if (settlesWhenPlaced(object) && placed.dynamic) group.settle.push(placed);
        if (instance?.motion) group.moving.push({ placed, instance, motion: instance.motion });
        if (articulated && instance) {
          group.articulated.push(new Articulation(placed, articulated, instance.world));
        }
        if (instance?.playback && placed.bodies.some(({ data }) => data.motion === 'keyframed')) {
          group.animated.push({ placed, instance });
        }
        const pose = instance?.pose;
        if (instance && pose && moved) {
          // Bodies keep their place relative to their node: rest pose to the node's pose.
          const rest = new ActorPose(pose.skeleton).worlds;
          const bodies = placed.bodies.flatMap((body) => {
            const node = moved.get(body.data.node.toLowerCase());
            const restInverse =
              node === undefined ? undefined : invert(rest.subarray(node * 16, node * 16 + 16));
            if (node === undefined || !restInverse || !body.body.isKinematic()) return [];
            return [{ body, node, offset: multiply(restInverse, body.data.transform) }];
          });
          if (bodies.length > 0) group.posed.push({ placed, instance, pose, bodies, version: -1 });
        }
      });
    }
    for (const ragdoll of cell.ragdolls ?? []) {
      const collision = ragdoll.collision;
      if (!collision?.bodies.some((body) => body.motion === 'dynamic' && !body.phantom)) continue;
      tasks.push(() => {
        // Its bodies start in the skeleton's rest pose, as its nodes do.
        ragdoll.pose.update(undefined);
        const placed = physics.addObject(
          collision,
          ragdoll.world,
          { reference: ragdoll.reference, kind: 'actor' },
          false,
        );
        group.collision.push(placed);
        if (cell.isEnabled?.(ragdoll.reference) === false) physics.setEnabled(placed, false);
        if (placed.dynamic) group.settle.push(placed);
        group.articulated.push(new Articulation(placed, ragdoll.pose, ragdoll.world));
      });
    }
    for (const primitive of cell.primitives) {
      tasks.push(() => {
        const placed = physics.addPrimitive(
          primitive.shape,
          primitive.bounds,
          primitive.world,
          primitive.layer,
          {
            reference: primitive.reference,
            kind: 'object',
          },
        );
        group.collision.push(placed);
        if (cell.isEnabled?.(primitive.reference) === false) physics.setEnabled(placed, false);
      });
    }
    if (tasks.length === 0) this.#complete(group);
    for (const run of tasks) this.#queue.push({ group, run });
  }

  /** A reference's collision in every loaded cell (placed so far). */
  placementsOf(reference: number): PlacedCollision[] {
    const found: PlacedCollision[] = [];
    for (const group of this.#groups) {
      for (const placed of group.collision)
        if (placed.owner.reference === reference) found.push(placed);
    }
    return found;
  }

  /** A script enabled or disabled a reference: its collision comes back or leaves. */
  setReferenceEnabled(reference: number, enabled: boolean): void {
    for (const placed of this.placementsOf(reference)) this.physics.setEnabled(placed, enabled);
  }

  /**
   * One placement leaves a cell's collision (a cart its horse now pulls): out of every list of
   * the group (a body moved after it left the world panics the physics), its bodies out of the
   * world.
   */
  removePlacement(group: CollisionGroup, placed: PlacedCollision): void {
    const drop = <T>(list: T[], of: (entry: T) => PlacedCollision): void => {
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i];
        if (entry !== undefined && of(entry) === placed) list.splice(i, 1);
      }
    };
    drop(group.collision, (entry) => entry);
    drop(group.settle, (entry) => entry);
    drop(group.moving, (entry) => entry.placed);
    drop(group.animated, (entry) => entry.placed);
    drop(group.posed, (entry) => entry.placed);
    this.physics.remove(placed);
  }

  /** Takes a cell's collision out of the world (and out of the queue). */
  remove(group: CollisionGroup): void {
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      if (this.#queue[i]?.group === group) this.#queue.splice(i, 1);
    }
    for (const placed of group.collision.splice(0)) this.physics.remove(placed);
    group.moving.length = 0;
    group.animated.length = 0;
    group.posed.length = 0;
    group.articulated.length = 0;
    group.settle.length = 0;
    group.whenComplete.length = 0;
    group.ready = false;
    this.#groups.delete(group);
  }

  setFreeCamera(free: boolean): void {
    this.#freeCamera = free;
    if (free) {
      // The free camera starts where the player looks from.
      this.camera.position = [...this.player.position];
      this.camera.yaw = this.player.yaw;
      this.camera.pitch = this.player.pitch;
    }
    this.attach();
    this.onFreeCamera?.(free);
  }

  /** Takes keyboard and mouse input (the player's, or the free camera's). */
  attach(): void {
    this.#detach?.();
    this.#detach = this.#freeCamera
      ? this.camera.attach(this.#canvas)
      : attachPlayerInput(
          this.player,
          this.#canvas,
          () => this.#hud?.listening === true,
          () => this.#hud?.menus?.takesKeys?.() === true,
        );
  }

  /** Stops taking input. */
  detach(): void {
    this.#detach?.();
    this.#detach = undefined;
  }

  dispose(): void {
    this.#setTarget(undefined);
    this.#detach?.();
    this.#detach = undefined;
    this.#queue.length = 0;
    this.#groups.clear();
    this.player.free();
    this.physics.free();
  }
}
