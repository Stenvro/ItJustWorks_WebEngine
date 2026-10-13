// The player's body: the Player actor (NPC_ 0x7, reference 0x14) on its race's skeleton,
// drawn in third person, and its first-person skeleton, whose animated Camera1st node the
// first-person camera rides. Both run their behavior graphs, which the player's movement
// drives as the engine drives them: Speed and Direction, moveStart / moveStop, sprinting,
// sneaking, swimming, and jumps (the graph's JumpUp pushes off; JumpFall and JumpLand frame
// the flight). Notes: docs/animation.md ("The player").

import { animateSkeletons, type AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import { ActorPose, ActorSkeleton } from '../animation/skeleton.ts';
import type { Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuScene, InstanceMotion, ModelInstance } from '../render/scene-renderer.ts';
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

/** The flags the graphs were last told, so events go out when they change. */
interface Told {
  moving: boolean;
  sprinting: boolean;
  sneaking: boolean;
  swimming: boolean;
  airborne: boolean;
  falling: boolean;
}

export class PlayerAvatar {
  /** The third-person body, drawn in third person. */
  readonly body: PlacedActor;
  readonly scene: GpuScene;
  readonly #player: Player;
  readonly #firstPerson: AnimatedSkeleton | undefined;

  /** The first-person skeleton and its graph (its Camera1st node is the camera). */
  get firstPerson(): AnimatedSkeleton | undefined {
    return this.#firstPerson;
  }
  readonly #motion: InstanceMotion;
  readonly #world: Float32Array;
  #bodyYaw: number;
  #time: number | undefined;
  #told: Told = {
    moving: false,
    sprinting: false,
    sneaking: false,
    swimming: false,
    airborne: false,
    falling: false,
  };
  /** A jump's animation started: the graph's JumpUp pushes off. */
  #jumping = false;

  private constructor(
    player: Player,
    body: PlacedActor,
    scene: GpuScene,
    placement: { world: Float32Array; motion: InstanceMotion },
    firstPerson: AnimatedSkeleton | undefined,
    soundWorld: SoundingWorld,
  ) {
    this.#player = player;
    this.body = body;
    this.scene = scene;
    this.#world = placement.world;
    this.#motion = placement.motion;
    this.#firstPerson = firstPerson;
    this.#bodyYaw = player.yaw;
    player.jumpTrigger = (moving) => {
      this.#jumping = true;
      this.#send(moving ? 'JumpDirectionalStart' : 'JumpStandingStart');
    };
    player.cameraOffset = () => this.#cameraOffset();
    // Its footsteps and the sounds its animations play, by its gait.
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
      soundWorld,
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

  /** The player's avatar, or undefined if its body cannot be made. */
  static async create(
    session: GameSession,
    renderer: Renderer,
    player: Player,
    soundWorld: SoundingWorld,
  ): Promise<PlayerAvatar | undefined> {
    const placer = await session.actors();
    const feet = player.feet;
    const body = await placer.place({
      reference: PLAYER_REFERENCE,
      editorId: 'Player',
      base: PLAYER_ACTOR,
      position: [feet[0], feet[1], feet[2]],
      rotation: [0, 0, player.yaw],
      scale: 1,
    });
    if (!body) return undefined;
    // One placement matrix the body's instances share, moved every frame.
    const world = new Float32Array(body.instances[0]?.world ?? new Float32Array(16));
    const motion: InstanceMotion = { version: 0 };
    const instances = body.instances.map((instance): ModelInstance => ({
      ...instance,
      world,
      motion,
    }));
    const scene = renderer.scene.createScene(instances);
    const firstPerson = await PlayerAvatar.#firstPersonSkeleton(session, body.look.female);
    return new PlayerAvatar(player, body, scene, { world, motion }, firstPerson, soundWorld);
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

  /** Moves the avatar with the player: its graphs, its place and its facing. */
  update(seconds: number): void {
    const player = this.#player;
    const dt = this.#time === undefined ? 0 : Math.min(0.1, Math.max(0, seconds - this.#time));
    this.#time = seconds;
    this.#drive(dt);
    const skeletons: AnimatedSkeleton[] = [this.body];
    if (this.#firstPerson) skeletons.push(this.#firstPerson);
    animateSkeletons(skeletons, seconds);
    // The body stands on the player's feet, facing its own way.
    const feet = player.character.feetAt(1);
    // The race's height times its own (as placed actors are).
    const scale = this.body.look.scale * this.body.actor.scale;
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
    const motion = player.motion;
    const character = player.character;
    const [vx, vy] = character.velocity;
    const speed = Math.hypot(vx, vy);
    const swimming = character.swimming;
    const airborne = !character.grounded && !swimming;
    // Third person: the body turns to the way it moves (weapons sheathed); first person it
    // faces where the camera looks.
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
    // The direction of the movement against the facing: 0 ahead, 0.25 right, 0.5 behind.
    const relative = Math.atan2(vx, vy) - this.#bodyYaw;
    const direction = speed > 1 ? (((relative / (2 * Math.PI)) % 1) + 1) % 1 : 0;
    this.#set('Speed', speed);
    this.#set('Direction', direction);
    this.#set('IsSprinting', motion.sprinting ? 1 : 0);
    this.#set('IsSneaking', player.sneaking ? 1 : 0);
    const told = this.#told;
    const moving = speed > 5;
    if (moving !== told.moving) this.#send(moving ? 'moveStart' : 'moveStop');
    if (motion.sprinting !== told.sprinting) {
      this.#send(motion.sprinting ? 'SprintStart' : 'SprintStop');
    }
    if (player.sneaking !== told.sneaking) this.#send(player.sneaking ? 'SneakStart' : 'SneakStop');
    if (swimming !== told.swimming) this.#send(swimming ? 'SwimStart' : 'SwimStop');
    // In the air: falling once it comes down; landing when it stands again.
    const falling = airborne && character.verticalSpeed < 0;
    if (falling && !told.falling) this.#send('JumpFall');
    if (!airborne && told.airborne) {
      this.#jumping = false;
      this.#send(moving ? 'JumpLandDirectional' : 'JumpLand');
    }
    this.#told = {
      moving,
      sprinting: motion.sprinting,
      sneaking: player.sneaking,
      swimming,
      airborne,
      falling,
    };
  }

  #set(name: string, value: number): void {
    this.body.behavior?.setVariable(name, value);
    this.#firstPerson?.behavior?.setVariable(name, value);
  }

  #send(event: string): void {
    this.body.behavior?.sendEvent(event);
    this.#firstPerson?.behavior?.sendEvent(event);
  }

  /** The animated Camera1st node in the player's frame (x right, y forward), scaled. */
  #cameraOffset(): Vec3 | undefined {
    const node = this.#firstPerson?.pose.world(CAMERA_NODE);
    if (!node) return undefined;
    const scale = this.#player.height;
    return [(node[12] ?? 0) * scale, (node[13] ?? 0) * scale, (node[14] ?? 0) * scale];
  }

  destroy(): void {
    this.#player.jumpTrigger = undefined;
    this.#player.cameraOffset = undefined;
    this.scene.destroy();
  }
}
