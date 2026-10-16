// The player's body: the Player actor (NPC_ 0x7, reference 0x14) on its race's skeleton,
// drawn in third person, and its first-person skeleton, whose animated Camera1st node the
// first-person camera rides. Both run their behavior graphs, which the player's movement
// drives as the engine drives them: Speed and Direction, moveStart / moveStop, sprinting,
// sneaking, swimming, and jumps (the graph's JumpUp pushes off; JumpFall and JumpLand frame
// the flight). Its look is the player's appearance (src/shell/player-look.ts: the race menu's
// choices), made again whenever that changes or a script changes the player's race.
// Notes: docs/animation.md ("The player").

import { Locomotion, type LocomotionGraph } from '../ai/locomotion.ts';
import { animateSkeletons, type AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import { ActorPose, ActorSkeleton } from '../animation/skeleton.ts';
import type { Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuScene, InstanceMotion, ModelInstance } from '../render/scene-renderer.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { seededRandom } from '../world/actors.ts';
import { FIRST_PERSON_SKELETON, PLAYER_ACTOR } from '../world/player-body.ts';
import type { PlacedActor } from './actors.ts';
import { actorSounds, type SoundingWorld } from './actor-sounds.ts';
import type { GameSession } from './game-session.ts';
import type { Player } from './player.ts';

/** The Player reference (PlayerRef). */
const PLAYER_REFERENCE = 0x14;
/** The first-person behavior project (the engine's own path). */
const FIRST_PERSON_PROJECT = 'meshes\\actors\\character\\_1stperson\\firstperson.hkx';
const CAMERA_NODE = 'Camera1st [Cam1]';
/** A frame longer than this (a hitch, a hidden tab) moves the avatar by this much (s). */
const MAX_STEP = 0.1;

/** A body made for the player: the placed actor and the scene that draws it. */
interface Made {
  readonly body: PlacedActor;
  readonly scene: GpuScene;
  /** The player look's build it was made from (undefined: the Player record's as it is). */
  readonly build: number | undefined;
}

/** The head models of a body made from a player look: the look's others can go. */
function keepHeads(session: GameSession, made: Made): void {
  if (made.build === undefined) return;
  const models = made.body.instances.map((instance) => instance.model);
  session.playerLook.keep(models, made.build);
}

export class PlayerAvatar {
  readonly #session: GameSession;
  readonly #renderer: Renderer;
  readonly #player: Player;
  readonly #soundWorld: SoundingWorld;
  #made: Made;
  #firstPerson: AnimatedSkeleton | undefined;
  #female: boolean;
  /** One placement matrix the body's instances share, moved every frame. */
  readonly #motion: InstanceMotion;
  readonly #world: Float32Array;
  #bodyYaw: number;
  /** The avatar's own clock (s): the game's, and real time while it animates in a menu. */
  #clock = 0;
  #last: { readonly seconds: number; readonly real: number } | undefined;
  /** Its movement, as the graphs' variables and events (shared with the NPCs). */
  readonly #locomotion = new Locomotion();
  /** A jump's animation started: the graph's JumpUp pushes off. */
  #jumping = false;
  /** An idle the body holds (the race menu's pose): sent again to a body made again. */
  #pose: string | undefined;
  /** Builds asked for and done (a rebuild makes the latest look, once at a time). */
  #wanted = 0;
  #built = 0;
  #rebuilding: Promise<void> | undefined;
  #destroyed = false;
  /**
   * Whether the body animates while the game is in menu mode (the race menu shows the player
   * standing, breathing and blinking, the world still).
   */
  animatesInMenus = false;

  private constructor(
    session: GameSession,
    renderer: Renderer,
    player: Player,
    soundWorld: SoundingWorld,
    made: Made,
    placement: { world: Float32Array; motion: InstanceMotion },
    firstPerson: AnimatedSkeleton | undefined,
  ) {
    this.#session = session;
    this.#renderer = renderer;
    this.#player = player;
    this.#soundWorld = soundWorld;
    this.#made = made;
    this.#world = placement.world;
    this.#motion = placement.motion;
    this.#firstPerson = firstPerson;
    this.#female = made.body.look.female;
    this.#bodyYaw = player.yaw;
    player.jumpTrigger = (moving) => {
      this.#jumping = true;
      this.send(moving ? 'JumpDirectionalStart' : 'JumpStandingStart');
    };
    player.cameraOffset = () => this.#cameraOffset();
    this.#listen(made.body);
  }

  /** The third-person body, drawn in third person. */
  get body(): PlacedActor {
    return this.#made.body;
  }

  get scene(): GpuScene {
    return this.#made.scene;
  }

  /** The first-person skeleton and its graph (its Camera1st node is the camera). */
  get firstPerson(): AnimatedSkeleton | undefined {
    return this.#firstPerson;
  }

  /** Furniture holds the player: its graphs are moved by the furniture's idles, not its walk. */
  seated = false;
  /** The seconds its graphs moved in the last update (the furniture's root motion). */
  stepped = 0;

  /** Which way the body faces (radians, compass heading); the race menu turns it. */
  get bodyYaw(): number {
    return this.#bodyYaw;
  }

  set bodyYaw(yaw: number) {
    this.#bodyYaw = yaw;
  }

  /** The player's avatar, or undefined if its body cannot be made. */
  static async create(
    session: GameSession,
    renderer: Renderer,
    player: Player,
    soundWorld: SoundingWorld,
  ): Promise<PlayerAvatar | undefined> {
    const world = new Float32Array(16);
    const motion: InstanceMotion = { version: 0 };
    const made = await PlayerAvatar.#make(session, renderer, player, { world, motion });
    if (!made) return undefined;
    const firstPerson = await PlayerAvatar.#firstPersonSkeleton(session, made.body.look.female);
    keepHeads(session, made);
    return new PlayerAvatar(
      session,
      renderer,
      player,
      soundWorld,
      made,
      { world, motion },
      firstPerson,
    );
  }

  /**
   * The player's body in their look now (the race, sex and face of the appearance; the race
   * Actor.SetRace gave them), on the shared placement; the player's cameras follow its race's
   * height.
   */
  static async #make(
    session: GameSession,
    renderer: Renderer,
    player: Player,
    placement: { world: Float32Array; motion: InstanceMotion },
  ): Promise<Made | undefined> {
    const placer = await session.actors();
    const made = await session.playerLook.made().catch(() => undefined);
    const race = session.scriptsReady?.state.actors.get(PLAYER_REF)?.race;
    const feet = player.feet;
    const body = await placer.place(
      {
        reference: PLAYER_REFERENCE,
        editorId: 'Player',
        base: PLAYER_ACTOR,
        position: [feet[0], feet[1], feet[2]],
        rotation: [0, 0, player.yaw],
        scale: 1,
        links: new Map(),
        startsDead: false,
      },
      made,
      made ? undefined : race,
    );
    if (!body) return undefined;
    const { look } = body;
    const playerBody = await session.playerLook.body(look.race, look.female).catch(() => undefined);
    if (playerBody) player.setBody(playerBody);
    if (placement.motion.version === 0) placement.world.set(body.instances[0]?.world ?? []);
    const instances = body.instances.map((instance): ModelInstance => ({
      ...instance,
      ...placement,
    }));
    return { body, scene: renderer.scene.createScene(instances), build: made?.build };
  }

  /** The first-person skeleton running the first-person graph (nothing of it is drawn yet). */
  static async #firstPersonSkeleton(
    session: GameSession,
    female: boolean,
  ): Promise<AnimatedSkeleton | undefined> {
    const animation = session.animation;
    const behaviors = await animation.behaviors(FIRST_PERSON_PROJECT);
    const rigPath = behaviors?.character.rig;
    if (!behaviors || !rigPath) return undefined;
    const [rig, havok] = await Promise.all([
      session.loader.loadRig(FIRST_PERSON_SKELETON).catch(() => undefined),
      animation.havokSkeleton(rigPath),
    ]);
    if (!rig || !havok) return undefined;
    const host = animation.host(behaviors, female);
    const behavior = new BehaviorRuntime({
      root: behaviors.root,
      host,
      skeleton: havok,
      random: seededRandom(PLAYER_REFERENCE),
      properties: { IsFemale: female ? 1 : 0, IsMale: female ? 0 : 1, IsPlayer: 1 },
    });
    behavior.update(0);
    await host.loaded();
    behavior.update(0);
    const pose = new ActorPose(new ActorSkeleton(rig, havok));
    pose.update(behavior.pose);
    return { pose, behavior, time: undefined };
  }

  /**
   * Makes the body again in the player's look now (the race menu's choices, a race a script
   * set); resolves once the latest look asked for is drawn. The old body goes as the new one
   * takes its place.
   */
  rebuild(): Promise<void> {
    this.#wanted++;
    this.#rebuilding ??= this.#rebuildAll();
    return this.#rebuilding;
  }

  async #rebuildAll(): Promise<void> {
    try {
      while (this.#built < this.#wanted && !this.#destroyed) await this.#rebuildOnce();
    } finally {
      this.#rebuilding = undefined;
    }
  }

  /** Makes the latest look asked for and puts it in the old body's place. */
  async #rebuildOnce(): Promise<void> {
    const target = this.#wanted;
    const made = await PlayerAvatar.#make(this.#session, this.#renderer, this.#player, {
      world: this.#world,
      motion: this.#motion,
    });
    this.#built = target;
    if (!made) return;
    if (this.#destroyed) {
      made.scene.destroy();
      return;
    }
    // The first-person graph is the sex's (IsFemale).
    const female = made.body.look.female;
    if (female !== this.#female) {
      this.#female = female;
      this.#firstPerson = await PlayerAvatar.#firstPersonSkeleton(this.#session, female);
    }
    const old = this.#made;
    this.#made = made;
    this.#listen(made.body);
    this.#locomotion.reset();
    if (this.#pose !== undefined) made.body.behavior?.sendEvent(this.#pose);
    old.body.onEvents = undefined;
    old.scene.destroy();
    keepHeads(this.#session, made);
  }

  /** Holds an idle (a behavior event: the race menu's pose) until `hold(undefined)`. */
  hold(pose: string | undefined): void {
    this.#pose = pose;
    if (pose !== undefined) this.#made.body.behavior?.sendEvent(pose);
  }

  /** Its footsteps and the sounds its animations play, by its gait; the jump's push-off. */
  #listen(body: PlacedActor): void {
    const player = this.#player;
    const sound = actorSounds(
      {
        look: body.look,
        feet: () => player.feet,
        gait: () =>
          player.sneaking
            ? 'sneak'
            : player.motion.sprinting
              ? 'sprint'
              : player.motion.running
                ? 'run'
                : 'walk',
        player: true,
        collider: player.character.collider,
      },
      this.#soundWorld,
    );
    body.onEvents = (events) => {
      sound(events);
      // The jump's animation pushes off.
      if (this.#jumping && events.some((event) => event.toLowerCase() === 'jumpup')) {
        this.#jumping = false;
        player.launchJump();
      }
    };
  }

  /** Moves the avatar with the player: its graphs, its place and its facing. */
  update(seconds: number): void {
    const player = this.#player;
    const real = performance.now() / 1000;
    const last = this.#last;
    this.#last = { seconds, real };
    // The game's clock stands still in menus; a menu that shows the player animates them on
    // real time.
    const step = !last ? 0 : this.animatesInMenus ? real - last.real : seconds - last.seconds;
    const dt = Math.min(MAX_STEP, Math.max(0, step));
    this.#clock += dt;
    this.stepped = dt;
    if (!this.seated) this.#drive(dt);
    const body = this.#made.body;
    const skeletons: AnimatedSkeleton[] = [body];
    if (this.#firstPerson) skeletons.push(this.#firstPerson);
    animateSkeletons(skeletons, this.#clock);
    // The body stands on the player's feet, facing its own way: where the camera has them
    // between physics steps (the last step's feet put the body up to a step off the camera).
    const feet = player.drawnFeet;
    // The race's height times its own (as placed actors are).
    const scale = body.look.scale * body.actor.scale;
    const sin = Math.sin(this.#bodyYaw);
    const cos = Math.cos(this.#bodyYaw);
    // Turned about z (compass heading: 0 faces +Y), scaled by the race's height.
    this.#world.set([
      cos * scale,
      -sin * scale,
      0,
      0,
      sin * scale,
      cos * scale,
      0,
      0,
      0,
      0,
      scale,
      0,
      feet[0],
      feet[1],
      feet[2],
      1,
    ]);
    this.#motion.version++;
  }

  /** What the player does, as the graphs' variables and events; the body's facing. */
  #drive(dt: number): void {
    const player = this.#player;
    const character = player.character;
    // Third person: the body turns to the way it moves (weapons sheathed); first person it
    // faces where the camera looks. A menu that shows the player turns it itself (bodyYaw).
    if (!this.animatesInMenus) this.#face(dt);
    const landed = this.#locomotion.drive(this.#graphs(), {
      velocity: character.velocity,
      heading: this.#bodyYaw,
      seconds: dt,
      grounded: character.grounded,
      swimming: character.swimming,
      verticalSpeed: character.verticalSpeed,
      sprinting: player.motion.sprinting,
      sneaking: player.sneaking,
    });
    if (landed) this.#jumping = false;
  }

  /** The graphs the player's movement drives: the body's and the first-person one. */
  *#graphs(): Iterable<LocomotionGraph> {
    const body = this.#made.body.behavior;
    if (body) yield body;
    const first = this.#firstPerson?.behavior;
    if (first) yield first;
  }

  /** The body's facing: the camera's in first person, the way it moves in third. */
  #face(dt: number): void {
    const player = this.#player;
    const motion = player.motion;
    if (player.pov === 'first') {
      this.#bodyYaw = player.yaw;
    } else if (motion.moving) {
      const heading = player.yaw + Math.atan2(motion.inputX, motion.inputY);
      const rate = player.movement.normal.rotateWhileMoving || Math.PI;
      let delta = heading - this.#bodyYaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      const step = rate * dt;
      this.#bodyYaw += Math.abs(delta) <= step ? delta : Math.sign(delta) * step;
    }
  }

  /** Sends an animation event to its graphs (the body's and the first-person one). */
  send(event: string): boolean {
    let taken = false;
    for (const graph of this.#graphs()) taken = graph.sendEvent(event) || taken;
    return taken;
  }

  /** The animated Camera1st node in the player's frame (x right, y forward), scaled. */
  #cameraOffset(): Vec3 | undefined {
    const node = this.#firstPerson?.pose.world(CAMERA_NODE);
    if (!node) return undefined;
    const scale = this.#player.height;
    return [(node[12] ?? 0) * scale, (node[13] ?? 0) * scale, (node[14] ?? 0) * scale];
  }

  destroy(): void {
    this.#destroyed = true;
    this.#player.jumpTrigger = undefined;
    this.#player.cameraOffset = undefined;
    this.#made.scene.destroy();
  }
}
