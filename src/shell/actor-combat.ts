// Combat on the stage (docs/ai.md, "Combat"; docs/m10-plan.md 5.1): the player and the actors
// of the high process draw and sheathe, attack, block and bash through the idle tree (ActionDraw,
// ActionRightAttack, ActionRightPowerAttack, ActionLeftAttack, ActionRightRelease, ...: the
// first idle whose conditions hold sends its event to the actor's graph), and their graphs'
// annotations move them on (src/gameplay/combat/combat-state.ts): the weapon to the hand at
// weaponDraw, the strike at HitFrame, the arrow at arrowRelease. A strike hits the nearest actor
// within reach and inside the attack's strike angle (hit-test.ts); its damage is the equip
// system's weapon damage times the attack's, through sneak attacks, armour, blocks and the
// difficulty (damage.ts); it staggers or recoils (stagger.ts), sounds and bleeds (combat-
// impacts.ts), tells the target's scripts (OnHit) and uses the skills (the skill progression's
// useSkill). Health run out kills, or makes an essential or protected actor bleed out
// (bleedout.ts). A killing blow may be a killmove: a paired idle the two actors play together,
// the one it is done to placed before the attacker (killmove-camera.ts shows it). Arrows fly
// (combat-projectiles.ts). The enemy the player fights shows on the HUD, and combat music plays
// while anyone fights the player.
//
// Who fights whom, and how, is the combat AI's (src/shell/actor-combat-ai.ts: aggression,
// assistance, target choice, the combat style's movement and attacks, fleeing, searching): it
// sets each fighter's target and asks for its draws, attacks, blocks and releases here.

import { parseNpcCombat, parseRaceCombat } from '../ai/race-combat-records.ts';
import { behaviorGraphKey, readIdleTree, type IdleTree } from '../ai/idle-records.ts';
import type { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import { ActorValue } from '../world/actor-values.ts';
import { DefaultObjectUse } from '../world/default-objects.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorCombatState, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ObjectHandle } from '../scripting/values.ts';
import { EquippedItemType } from '../gameplay/equipment.ts';
import { WeaponType } from '../world/item-records.ts';
import type { WeaponStats } from '../scripting/runtime/equipment-engine.ts';
import {
  AttackSet,
  attackEventKind,
  DEFAULT_ATTACK,
  POWER_ATTACK_DEFAULT,
} from '../gameplay/combat/attacks.ts';
import type { AttackData } from '../ai/race-combat-records.ts';
import { bleedoutRecovered, bleedoutRegain } from '../gameplay/combat/bleedout.ts';
import { combatHooks, type AttackKind } from '../gameplay/combat/combat-hooks.ts';
import {
  parseAmmo,
  parseProjectile,
  parseRaceHits,
  parseWeaponCombat,
  type ProjectileCombat,
  type RaceHits,
  type WeaponCombat,
} from '../gameplay/combat/combat-records.ts';
import {
  readCombatSettings,
  COMBAT_DEFAULTS,
  type CombatSettings,
} from '../gameplay/combat/combat-settings.ts';
import {
  AttackState,
  KnockState,
  LifeState,
  WeaponState,
  attacking,
  bleedingOut,
  canAct,
  graphEvent,
  newCombatState,
  startAttack,
  weaponOut,
  type CombatEffect,
  type CombatState,
} from '../gameplay/combat/combat-state.ts';
import {
  bashFactor,
  blockedShare,
  bowDrawPower,
  hitDamage,
  sneakAttackMult,
} from '../gameplay/combat/damage.ts';
import {
  blockCovers,
  headingTo,
  hitDirection,
  meleeReach,
  strikeTargets,
  turnBetween,
  type StrikeTarget,
} from '../gameplay/combat/hit-test.ts';
import { ARROW_TILT, tiltUp } from '../gameplay/combat/projectile.ts';
import { blockStagger, recoilOf, staggerMagnitude } from '../gameplay/combat/stagger.ts';
import { Layer } from '../physics/collision-layers.ts';
import { transformPoint, type Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuDecals } from '../render/decals.ts';
import type { GpuScene, InstanceVisibility } from '../render/scene-renderer.ts';
import type { StagedActor } from './actor-stage.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { ActorBodies } from './actor-bodies.ts';
import type { PlacedActor } from './actors.ts';
import { HeldWeapons, type HeldModels } from './actor-weapons.ts';
import { CombatImpacts } from './combat-impacts.ts';
import { CombatProjectiles } from './combat-projectiles.ts';
import type { GameSession } from './game-session.ts';
import type { PlaySession } from './play-session.ts';
import type { PlayerAvatar } from './player-avatar.ts';
import type { CombatBridge } from './script-world.ts';
import type { Terminal } from './terminal.ts';
import { KillmoveCamera } from './killmove-camera.ts';
import { PlayerCombat } from './player-combat.ts';
import type { ActorTalk } from './actor-talk.ts';
import type { ActorSenses } from './actor-senses.ts';
import type { ActorAi } from './actor-ai.ts';
import {
  ActorCombatAi,
  type CombatAiHost,
  type CombatCasting,
  type FighterView,
} from './actor-combat-ai.ts';
import type { Threat } from '../ai/combat-tactics.ts';

/** A human's shape for hits (its controller's radius and height at scale 1; game units). */
const BODY_RADIUS = 20;
const BODY_HEIGHT = 128;
/** The chest a strike or shot comes from and aims at (of the height). */
const CHEST = 0.75;
/** Fighters this far from the player are left alone (the high process's reach). */
const FIGHT_REACH = 4096;
/** The enemy bar stays this long after the last hit (seconds). TODO(M13): the engine's time. */
const ENEMY_BAR_SECONDS = 4;
/** A paired killmove's victim stands this far before the leader (Paired_1HMKillMoveB's "2_"
 * root at its start: 72.8 units ahead, turned to face it). TODO(M13): each clip's own offset. */
const PAIRED_DISTANCE = 72.8;
/** A paired animation lasts no longer than this (seconds; the longest vanilla ones: 10). */
const PAIRED_LIMIT = 12;
/** How wide a flying arrow is to those it may hit and who dodge it (units). */
const SHOT_RADIUS = 8;

/** One who fights: an actor of the stage or the player. */
interface Fighter {
  readonly reference: number;
  readonly player: boolean;
  readonly state: CombatState;
  /** Its body now, and the one its models and events were made for. */
  body: PlacedActor | undefined;
  hooked: PlacedActor | undefined;
  held: HeldWeapons | undefined;
  heldFor: string | undefined;
  /** What its hands hold (the equip system's) and its attack data, once read. */
  gear: Gear | undefined;
  gearVersion: number;
  gearLoading: boolean;
  /** Its combat target (the combat AI's; the player's: the one they strike at). */
  target: number | undefined;
  /** When its current attack's power began to be held (the player's power attacks). */
  heldSince: number | undefined;
  /** The weapon state it was in when its drawn models last followed it. */
  inHand: boolean;
  /** Bleeding out: seconds down; in a paired animation: seconds in it. */
  down: number;
  pairedFor: number;
  /** Estimated: its next attack kills its target (ShouldAttackKill), valued now and then. */
  killing: boolean;
  /** The last hit it dealt was critical. */
  lastCritical: boolean;
}

/** What a fighter's hands hold, for combat. */
interface Gear {
  readonly right: WeaponStats;
  readonly left: WeaponStats;
  readonly rightRecord: WeaponCombat | undefined;
  readonly leftRecord: WeaponCombat | undefined;
  readonly shield: number | undefined;
  readonly shieldRating: number;
  readonly projectile: ProjectileCombat | undefined;
  readonly ammoModel: string | undefined;
  readonly attacks: AttackSet;
  readonly race: RaceHits | undefined;
}

export interface ActorCombatOptions {
  readonly session: GameSession;
  readonly renderer: Renderer;
  readonly terminal: Terminal;
  readonly movers: ActorMovers;
  readonly bodies: ActorBodies;
  readonly actors: () => Iterable<StagedActor>;
  readonly get: (reference: number) => StagedActor | undefined;
  /** What the actors say (their combat lines: Attack, Hit, Block, BleedOut, Death, ...). */
  readonly talk?: () => ActorTalk | undefined;
  /** What they notice (an attack heard, the attacked searching, sneak attacks' awareness). */
  readonly senses?: () => ActorSenses | undefined;
  /** Their packages (the combat override packages' places; evaluated as combat ends). */
  readonly ai?: () => ActorAi | undefined;
  /** Inside a cell (how far the fleeing run). */
  readonly interior?: () => boolean;
  /** An actor gets off its horse to fight; a horse ridden is its rider's to move. */
  readonly dismount?: (actor: number) => Promise<void>;
  readonly ridden?: (actor: number) => boolean;
  /** Spells, staffs and shouts in combat (M10 5.3). */
  readonly casting?: () => CombatCasting | undefined;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ActorCombat implements CombatBridge {
  readonly #options: ActorCombatOptions;
  readonly #fighters = new Map<number, Fighter>();
  readonly #impacts: CombatImpacts;
  readonly #projectiles: CombatProjectiles;
  #settings: CombatSettings = COMBAT_DEFAULTS;
  #settingsRead = false;
  #tree: Promise<IdleTree> | undefined;
  readonly #graphKeys = new Map<string, Promise<string | undefined>>();
  #play: PlaySession | undefined;
  #avatar: PlayerAvatar | undefined;
  readonly #playerVisibility: InstanceVisibility = { hidden: false };
  #clock = 0;
  #enemy: { reference: number; until: number } | undefined;
  #music: number | undefined;
  #musicOn = false;
  #equipListening: ScriptRuntime | undefined;
  #camera: KillmoveCamera | undefined;
  #input: PlayerCombat | undefined;
  /** Who fights whom and how (src/shell/actor-combat-ai.ts). */
  readonly #brain: ActorCombatAi;

  constructor(options: ActorCombatOptions) {
    this.#options = options;
    this.#brain = new ActorCombatAi({
      session: options.session,
      terminal: options.terminal,
      movers: options.movers,
      host: this.#host(),
      ...(options.senses && { senses: options.senses }),
      ...(options.talk && { talk: options.talk }),
      ...(options.ai && { ai: options.ai }),
      ...(options.interior && { interior: options.interior }),
      ...(options.dismount && { dismount: options.dismount }),
      ...(options.ridden && { ridden: options.ridden }),
      ...(options.casting && { casting: options.casting }),
    });
    this.#impacts = new CombatImpacts(options.session, options.renderer);
    this.#projectiles = new CombatProjectiles({
      session: options.session,
      renderer: options.renderer,
      stickDepth: () => this.#settings.missileStickDepth,
      shapes: () => this.#playerShape(),
      onActorHit: (shot) => {
        const payload = shot.payload as ShotPayload;
        void this.#hit(payload.attacker, shot.target, {
          ...payload.kind,
          point: shot.point,
          direction: shot.direction,
          shot: payload,
        }).catch((error: unknown) => {
          this.#warn(`a shot's hit: ${describe(error)}`);
        });
      },
      onWorldHit: (point, direction, material) => {
        void this.#impacts.hit(
          {
            impactDataSet: undefined,
            materialId: material,
            position: point,
            direction,
            heavy: false,
          },
          this.#play?.physics,
        );
      },
    });
  }

  // --- The player ------------------------------------------------------------------------------

  /** The player plays (their avatar and session); undefined: the play ended. */
  attachPlayer(play: PlaySession | undefined, avatar: PlayerAvatar | undefined): void {
    this.#play = play;
    this.#avatar = avatar;
    const fighter = this.#fighters.get(PLAYER_REF);
    if (fighter) this.#drop(fighter);
    this.#input = undefined;
    if (play && avatar) {
      this.#fighters.set(PLAYER_REF, newFighter(PLAYER_REF, true));
      // In furniture or a menu the buttons are not the fight's.
      this.#input = new PlayerCombat(
        this,
        play.player,
        () => !play.seated && !this.#options.session.menuMode,
      );
    }
    if (!play) {
      this.#projectiles.clear();
      this.#camera = undefined;
      this.#setMusic(false);
    }
  }

  /** The killmove camera the player looks through now (undefined: theirs). */
  get camera(): KillmoveCamera | undefined {
    return this.#camera;
  }

  // --- What is drawn ---------------------------------------------------------------------------

  /** The weapons' and shots' scenes. */
  *scenes(): Iterable<GpuScene> {
    for (const fighter of this.#fighters.values()) {
      const scene = fighter.held?.scene;
      if (scene) yield scene;
    }
    yield* this.#projectiles.scenes();
  }

  /** The hits' decals (blood). */
  decals(): Iterable<GpuDecals> {
    return this.#impacts.decals();
  }

  // --- CombatBridge (what scripts ask and tell) ------------------------------------------------

  state(actor: number): ActorCombatState | undefined {
    const fighter = this.#fighters.get(actor);
    if (!fighter) return undefined;
    const state = fighter.state;
    const target = fighter.target === undefined ? undefined : this.#fighters.get(fighter.target);
    const feet = this.#feet(fighter);
    const targetFeet = target && this.#feet(target);
    return {
      weaponState: state.weapon,
      attackState: state.attack,
      attacking: attacking(state),
      powerAttacking: state.current?.power === true,
      wantBlocking: state.wantBlocking,
      blocking: state.blocking,
      staggered: state.staggered,
      recoiling: state.recoiling,
      bleedingOut: bleedingOut(state),
      knockState: state.knock,
      paired: state.paired !== undefined,
      killMove: state.paired !== undefined,
      movementDirection: this.#movementDirection(fighter),
      lastHitCritical: fighter.lastCritical,
      // The player is in combat while an actor fights them.
      inCombat: fighter.player ? this.#fightingPlayer() : this.#brain.combatState(actor) !== 0,
      combatState: fighter.player
        ? this.#fightingPlayer()
          ? 1
          : 0
        : this.#brain.combatState(actor),
      fleeing: this.#brain.fleeing(actor) || this.#options.ai?.()?.fleeing(actor) === true,
      observingCombat: this.#options.senses?.()?.reacting(actor) === 'spectator',
      friendHits: this.#brain.friendHits(actor),
      groupSize: this.#brain.groupSize(actor),
      combatTarget: fighter.target,
      shouldAttackKill: fighter.killing,
      targetHeight: feet && targetFeet ? targetFeet[2] - feet[2] : 0,
      lastHostile: fighter.target !== undefined && this.#lastHostile(fighter),
    };
  }

  startCombat(actor: number, target: number): void {
    if (actor === target || !this.#fighters.has(actor)) return;
    this.#brain.startCombat(actor, target);
  }

  stopCombat(actor: number): void {
    const fighter = this.#fighters.get(actor);
    if (!fighter) return;
    if (fighter.player) fighter.target = undefined;
    else this.#brain.stopCombat(actor);
  }

  /** Whether an actor fights another, or would attack it on sight (IsHostileToActor). */
  hostile(actor: number, target: number): boolean {
    const fighter = this.#fighters.get(actor);
    return fighter?.target === target || this.#brain.hostile(actor, target);
  }

  drawWeapon(actor: number, draw: boolean): void {
    const fighter = this.#fighters.get(actor);
    if (!fighter) return;
    if (draw) void this.draw(fighter.reference);
    else void this.sheathe(fighter.reference);
  }

  bleedout(actor: number, source: number | undefined): void {
    const fighter = this.#fighters.get(actor);
    if (!fighter || bleedingOut(fighter.state)) return;
    fighter.state.life = LifeState.bleedout;
    fighter.state.current = undefined;
    fighter.state.attack = AttackState.none;
    fighter.down = 0;
    // Its enemies leave it alone (UESP "Protected NPCs").
    for (const other of this.#fighters.values()) {
      if (other.target === actor) other.target = undefined;
    }
    if (fighter.target === source) fighter.target = undefined;
    void this.#act(fighter, 'ActionBleedoutStart');
    this.#bark(fighter.reference, 'BleedOut', source);
  }

  firstPerson(): boolean {
    return this.#play?.player.pov === 'first';
  }

  // --- Actions ---------------------------------------------------------------------------------

  /** Draws its weapon (ActionDraw); whether it began. */
  async draw(reference: number): Promise<boolean> {
    const fighter = this.#fighters.get(reference);
    if (!fighter || !canAct(fighter.state) || fighter.state.weapon !== WeaponState.sheathed) {
      return false;
    }
    fighter.state.weapon = WeaponState.wantToDraw;
    const event = await this.#act(fighter, 'ActionDraw');
    if (event === undefined) {
      fighter.state.weapon = WeaponState.sheathed;
      return false;
    }
    fighter.state.weapon = WeaponState.drawing;
    this.#setVariable(fighter, 'IsEquipping', 1);
    return true;
  }

  /** Sheathes its weapon (ActionSheath); whether it began. */
  async sheathe(reference: number): Promise<boolean> {
    const fighter = this.#fighters.get(reference);
    if (fighter?.state.weapon !== WeaponState.drawn || attacking(fighter.state)) {
      return false;
    }
    fighter.state.weapon = WeaponState.wantToSheathe;
    const event = await this.#act(fighter, 'ActionSheath');
    if (event === undefined) {
      fighter.state.weapon = WeaponState.drawn;
      return false;
    }
    fighter.state.weapon = WeaponState.sheathing;
    this.#setVariable(fighter, 'IsUnequipping', 1);
    return true;
  }

  /**
   * An attack action (ActionRightAttack, ActionLeftAttack, ActionRightPowerAttack, ...) on its
   * target: its idle's event starts the attack (or draws, if the weapon is sheathed: the tree's
   * DrawWeapon idles). Power attacks and bashes cost stamina (the skill progression's costs);
   * without stamina a power attack is a plain one. Whether something played.
   */
  async attack(reference: number, action: string): Promise<boolean> {
    const fighter = this.#fighters.get(reference);
    const runtime = this.#options.session.scriptsReady;
    if (!fighter || !runtime || !canAct(fighter.state)) return false;
    const state = fighter.state;
    // In the attack's window the next one chains; otherwise one at a time.
    if (
      attacking(state) &&
      state.attack !== AttackState.nextAttack &&
      state.attack !== AttackState.followThrough &&
      state.attack !== AttackState.bash
    ) {
      return false;
    }
    if (fighter.player) fighter.target = this.#aimedAt(fighter);
    const target = fighter.target;
    // Power attacks need stamina (UESP "Damage": without it, a plain attack).
    if (action.includes('Power') && !(await runtime.progression.canPowerAttack(reference))) {
      runtime.progression.refused(reference, 'stamina');
      action = action.replace('PowerAttack', 'Attack');
    }
    const event = await this.#act(fighter, action, target);
    if (event === undefined) return false;
    const lower = event.toLowerCase();
    if (lower === 'weapequip') {
      state.weapon = WeaponState.drawing;
      this.#setVariable(fighter, 'IsEquipping', 1);
      return true;
    }
    if (lower === 'blockstart') {
      state.wantBlocking = true;
      this.#setVariable(fighter, 'iWantBlock', 1);
      this.#setVariable(fighter, 'IsBlocking', 1);
      state.blocking = true;
      return true;
    }
    const data = fighter.gear?.attacks.of(event);
    const kind = attackEventKind(event, data);
    if (!kind) return true;
    const left = kind.left || action.includes('Left');
    const dual = action.includes('Dual');
    startAttack(state, {
      event,
      hand: dual ? 'dual' : left ? 'left' : 'right',
      power: kind.power,
      bash: kind.bash,
    });
    this.#setVariable(fighter, 'IsAttacking', 1);
    if (kind.bash) this.#setVariable(fighter, 'IsBashing', 1);
    void this.#spendFor(fighter, data ?? DEFAULT_ATTACK, kind.power, kind.bash, dual);
    // Attacking ends its invisibility (the magic system); its combat line (an NPC's).
    runtime.magic.acted(reference);
    if (!fighter.player) {
      this.#bark(reference, kind.bash ? 'Bash' : kind.power ? 'PowerAttack' : 'Attack', target);
    }
    // A paired killmove: the one it is done to plays its part.
    if (lower.startsWith('pa_') && target !== undefined) this.#pair(fighter, target, event);
    return true;
  }

  /** The attack button let go (ActionRightRelease / ActionLeftRelease): a bow loosed, a block or bash ended. */
  async release(reference: number, action: string): Promise<void> {
    const fighter = this.#fighters.get(reference);
    if (!fighter) return;
    const event = await this.#act(fighter, action);
    if (event?.toLowerCase() === 'blockstop' || action === 'ActionLeftRelease') {
      fighter.state.wantBlocking = false;
      fighter.state.blocking = false;
      this.#setVariable(fighter, 'iWantBlock', 0);
      this.#setVariable(fighter, 'IsBlocking', 0);
    }
  }

  /** Blocks (true) or stops (false): the left hand's attack when it holds a shield or nothing. */
  async block(reference: number, on: boolean): Promise<void> {
    if (on) await this.attack(reference, 'ActionLeftAttack');
    else await this.release(reference, 'ActionLeftRelease');
  }

  /** Whether an actor fights (its target), for its AI (its packages wait meanwhile). */
  engaged(reference: number): boolean {
    const fighter = this.#fighters.get(reference);
    return (
      fighter !== undefined &&
      !fighter.player &&
      (this.#brain.engaged(reference) ||
        fighter.state.paired !== undefined ||
        bleedingOut(fighter.state))
    );
  }

  /**
   * What a fighter's hands hold (WeaponType; undefined: nothing) and whether its left holds a
   * shield: what the player's attack buttons do.
   */
  hands(reference: number):
    | {
        readonly right: number | undefined;
        readonly left: number | undefined;
        readonly shield: boolean;
      }
    | undefined {
    const gear = this.#fighters.get(reference)?.gear;
    if (!gear) return undefined;
    return {
      right: gear.right.weapon === undefined ? undefined : gear.right.weaponType,
      left: gear.left.weapon === undefined ? undefined : gear.left.weaponType,
      shield: gear.shield !== undefined,
    };
  }

  /** A fighter's combat state (the player's input reads it). */
  combatState(reference: number): CombatState | undefined {
    return this.#fighters.get(reference)?.state;
  }

  /** What an actor's weapon state is (sheathed, drawing, drawn, ...). */
  weaponState(reference: number): number {
    return this.#fighters.get(reference)?.state.weapon ?? WeaponState.sheathed;
  }

  // --- The frame -------------------------------------------------------------------------------

  /**
   * Every frame (real seconds since the last), after the actors' AI and before their skeletons
   * animate: fighters near the player join, their gear and models follow their equipment, the
   * AI fights, bleeding out heals, shots fly, the music and the enemy bar follow.
   */
  frame(seconds: number, focus: Vec3 | undefined): void {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    this.#clock += seconds;
    this.#readSettings();
    this.#listenToEquipment(runtime);
    const seen = new Set<number>();
    for (const staged of this.#options.actors()) {
      if (staged.dead || staged.visibility.hidden) continue;
      const near =
        !focus ||
        Math.hypot(staged.position[0] - focus[0], staged.position[1] - focus[1]) < FIGHT_REACH;
      if (!near) continue;
      seen.add(staged.reference);
      let fighter = this.#fighters.get(staged.reference);
      if (!fighter) {
        fighter = newFighter(staged.reference, false);
        this.#fighters.set(staged.reference, fighter);
      }
      this.#follow(fighter, staged.placed, runtime);
    }
    const player = this.#fighters.get(PLAYER_REF);
    const avatar = this.#avatar;
    if (player && avatar) {
      seen.add(PLAYER_REF);
      this.#follow(player, avatar.body, runtime);
      avatar.facesAim = weaponOut(player.state);
      this.#input?.frame(seconds);
      this.#playerVisibility.hidden = this.#play?.bodyShown !== true;
    }
    for (const fighter of [...this.#fighters.values()]) {
      if (!seen.has(fighter.reference)) {
        this.#drop(fighter);
        continue;
      }
      this.#update(fighter, seconds, runtime);
    }
    // Who fights whom, and how.
    this.#brain.frame(seconds);
    this.#projectiles.frame(seconds, this.#play?.physics);
    this.#camera?.update(seconds);
    // The killmove camera is the player's while it plays.
    const play = this.#play;
    if (this.#camera?.done === true) this.#camera = undefined;
    if (play) {
      if (this.#camera && play.cameraOverride === undefined) play.cameraOverride = this.#camera;
      else if (!this.#camera && play.cameraOverride instanceof KillmoveCamera) {
        play.cameraOverride = undefined;
      }
    }
    this.#enemyBar();
    this.#setMusic(this.#fightingPlayer());
  }

  /** A fighter's body: its events heard, its models made for what it holds. */
  #follow(fighter: Fighter, body: PlacedActor, runtime: ScriptRuntime): void {
    fighter.body = body;
    if (fighter.hooked !== body) {
      fighter.hooked = body;
      const previous = body.onEvents;
      body.onEvents = (events) => {
        previous?.(events);
        this.#events(fighter, events);
      };
      // The first-person graph's events: the player's strikes in first person.
      if (fighter.player) {
        const first = this.#avatar?.firstPerson;
        if (first) {
          const before = first.onEvents;
          first.onEvents = (events) => {
            before?.(events);
            if (this.#play?.player.pov === 'first') this.#events(fighter, events, true);
          };
        }
      }
      fighter.gear = undefined;
      fighter.heldFor = undefined;
    }
    if (!fighter.gear && !fighter.gearLoading) void this.#loadGear(fighter, runtime);
  }

  /** What a fighter holds, read from the equip system (again when it changes). */
  async #loadGear(fighter: Fighter, runtime: ScriptRuntime): Promise<void> {
    fighter.gearLoading = true;
    const version = fighter.gearVersion;
    try {
      const gear = await this.#readGear(fighter, runtime);
      if (version !== fighter.gearVersion) return;
      fighter.gear = gear;
      this.#graphVariables(fighter, gear);
      await this.#makeModels(fighter, gear);
    } catch (error) {
      this.#warn(`${fighter.reference.toString(16)}: ${describe(error)}`);
    } finally {
      fighter.gearLoading = false;
    }
  }

  async #readGear(fighter: Fighter, runtime: ScriptRuntime): Promise<Gear> {
    const reference = fighter.reference;
    const equipment = runtime.equipment;
    const [right, left, shield] = await Promise.all([
      equipment.weaponStats(reference, 'right'),
      equipment.weaponStats(reference, 'left'),
      equipment.shield(reference),
    ]);
    const forms = runtime.forms;
    const weapon = async (form: number | undefined): Promise<WeaponCombat | undefined> => {
      const record = form === undefined ? undefined : await forms.record(form);
      return record?.type === 'WEAP' ? parseWeaponCombat(record) : undefined;
    };
    const [rightRecord, leftRecord] = await Promise.all([
      weapon(right.weapon),
      weapon(left.weapon),
    ]);
    const shieldItem = shield === undefined ? undefined : await equipment.item(shield);
    const ammoRecord = right.ammo === undefined ? undefined : await forms.record(right.ammo);
    const ammo = ammoRecord?.type === 'AMMO' ? parseAmmo(ammoRecord) : undefined;
    const projectileRecord =
      ammo?.projectile === undefined ? undefined : await forms.record(ammo.projectile);
    // The attack data: its race's (or the race ATKR names) under its own (NPC_ ATKD).
    const raceId = await runtime.actors.raceOf(reference);
    const raceRecord = raceId === undefined ? undefined : await forms.record(raceId);
    const race = raceRecord?.type === 'RACE' ? parseRaceCombat(raceRecord) : undefined;
    const attackRaceRecord =
      race?.attackRace === undefined ? undefined : await forms.record(race.attackRace);
    const raceAttacks =
      attackRaceRecord?.type === 'RACE'
        ? parseRaceCombat(attackRaceRecord).attacks
        : (race?.attacks ?? []);
    const info = fighter.player ? undefined : await runtime.actors.info(reference);
    const npcRecord = info === undefined ? undefined : await forms.record(info.leveled);
    const own = npcRecord?.type === 'NPC_' ? parseNpcCombat(npcRecord).attacks : [];
    return {
      right,
      left,
      rightRecord,
      leftRecord,
      shield,
      shieldRating: shieldItem?.armor?.rating ?? 0,
      projectile: projectileRecord?.type === 'PROJ' ? parseProjectile(projectileRecord) : undefined,
      ammoModel: right.ammo === undefined ? undefined : ammo?.model,
      attacks: new AttackSet(raceAttacks, own),
      race: raceRecord?.type === 'RACE' ? parseRaceHits(raceRecord) : undefined,
    };
  }

  /**
   * The variables the engine sets on an actor's graphs for what it holds (CommonLibSSE's
   * graph channels): iRightHandType, iLeftHandType (GetEquippedItemType's codes),
   * iRightHandEquipped, iLeftHandEquipped, weaponSpeedMult, leftWeaponSpeedMult.
   */
  #graphVariables(fighter: Fighter, gear: Gear): void {
    const type = (stats: WeaponStats, shield: boolean): number =>
      stats.weapon !== undefined
        ? stats.weaponType === WeaponType.crossbow
          ? EquippedItemType.crossbow
          : stats.weaponType
        : shield
          ? EquippedItemType.shield
          : EquippedItemType.handToHand;
    const right = type(gear.right, false);
    const twoHanded =
      gear.right.weaponType >= WeaponType.twoHandSword &&
      gear.right.weaponType !== WeaponType.staff;
    const left = twoHanded ? right : type(gear.left, gear.shield !== undefined);
    this.#setVariable(fighter, 'iRightHandType', right);
    this.#setVariable(fighter, 'iLeftHandType', left);
    this.#setVariable(fighter, 'iRightHandEquipped', gear.right.weapon !== undefined ? 1 : 0);
    this.#setVariable(fighter, 'iLeftHandEquipped', left !== EquippedItemType.handToHand ? 1 : 0);
    this.#setVariable(fighter, 'weaponSpeedMult', gear.right.speed);
    this.#setVariable(fighter, 'leftWeaponSpeedMult', gear.left.speed);
  }

  /** Its weapons' models on its body (made again for another body or other weapons). */
  async #makeModels(fighter: Fighter, gear: Gear): Promise<void> {
    const body = fighter.body;
    if (!body) return;
    const held: HeldModels = {
      ...(gear.right.model !== undefined && {
        right: { model: gear.right.model, sheathed: gear.right.nodes.sheathed },
      }),
      ...(gear.left.model !== undefined && { left: { model: gear.left.model } }),
      ...(gear.ammoModel !== undefined && { ammo: gear.ammoModel }),
    };
    const key = `${String(gear.right.weapon)}:${String(gear.left.weapon)}:${String(gear.ammoModel)}`;
    if (fighter.heldFor === key && fighter.held) return;
    const placement = fighter.player ? this.#avatar?.placement : body.instances[0];
    const visibility = fighter.player
      ? this.#playerVisibility
      : this.#options.get(fighter.reference)?.visibility;
    if (!placement?.motion || !visibility) return;
    const made = await HeldWeapons.create(
      this.#options.session,
      this.#options.renderer,
      { pose: body.pose, world: placement.world, motion: placement.motion, visibility },
      held,
    );
    if (fighter.body !== body) {
      made?.destroy();
      return;
    }
    fighter.held?.destroy();
    fighter.held = made;
    fighter.heldFor = key;
  }

  /** One frame of a fighter: its models, its graph's flags, bleeding out, its AI. */
  #update(fighter: Fighter, seconds: number, runtime: ScriptRuntime): void {
    const state = fighter.state;
    fighter.held?.update(fighter.inHand, state.arrowNocked);
    if (state.current?.ranged === true && state.arrowNocked) state.drawnFor += seconds;
    // A paired animation that never says it ended lets go after a while (TODO(M13)).
    fighter.pairedFor = state.paired === undefined ? 0 : fighter.pairedFor + seconds;
    if (fighter.pairedFor > PAIRED_LIMIT) {
      state.paired = undefined;
      for (const graph of this.#graphs(fighter)) graph.pairedSide = undefined;
    }
    if (bleedingOut(state)) {
      fighter.down += seconds;
      void this.#bleed(fighter, seconds, runtime);
    }
    // Its next attack would kill its target (ShouldAttackKill), valued now and then.
    if (fighter.target !== undefined && Math.random() < seconds * 4) {
      void this.#estimateKill(fighter, runtime);
    }
  }

  /** Bleeding out: health regained, up again once recovered (ActionBleedoutStop). */
  async #bleed(fighter: Fighter, seconds: number, runtime: ScriptRuntime): Promise<void> {
    const actors = runtime.actors;
    const value = await actors.value(fighter.reference, ActorValue.health);
    const now = bleedoutRegain(value.current, value.max, seconds, this.#settings);
    if (now > value.current)
      actors.restore(fighter.reference, ActorValue.health, now - value.current);
    const noRecovery = runtime.state.actors.get(fighter.reference)?.noBleedoutRecovery === true;
    if (
      bleedingOut(fighter.state) &&
      bleedoutRecovered(
        { health: now, max: value.max, down: fighter.down, noRecovery },
        this.#settings,
      )
    ) {
      fighter.state.life = LifeState.alive;
      fighter.down = 0;
      await this.#act(fighter, 'ActionBleedoutStop');
    }
  }

  /** Values ShouldAttackKill: the fighter's next strike takes its target's health. */
  async #estimateKill(fighter: Fighter, runtime: ScriptRuntime): Promise<void> {
    const target = fighter.target;
    const gear = fighter.gear;
    if (target === undefined || !gear) return;
    const health = (await runtime.actors.value(target, ActorValue.health)).current;
    const armor = await runtime.equipment.armorRating(target);
    const damage = hitDamage(
      {
        physical: gear.right.damage,
        critical: 0,
        sneakMult: 1,
        armorReduction: armor.reduction,
        blocked: 0,
        difficulty: this.#difficulty(),
        attackerIsPlayer: fighter.player,
        targetIsPlayer: target === PLAYER_REF,
      },
      this.#settings,
    );
    fighter.killing = damage.total >= health;
  }

  // --- Graph events -----------------------------------------------------------------------------

  #events(fighter: Fighter, events: readonly string[], firstPerson = false): void {
    // In first person the player's strikes follow the first-person graph; the body's graph
    // still moves the models.
    const strikes = !fighter.player || (this.#play?.player.pov === 'first') === firstPerson;
    for (const event of events) {
      const effects = graphEvent(fighter.state, event);
      for (const effect of effects) {
        if (!strikes && (effect.kind === 'strike' || effect.kind === 'arrow-release')) continue;
        this.#effect(fighter, effect);
      }
      const lower = event.toLowerCase();
      if (lower === 'weapequip_out') this.#setVariable(fighter, 'IsEquipping', 0);
      if (lower === 'unequip_out') this.#setVariable(fighter, 'IsUnequipping', 0);
      if (lower === 'attackstop' || lower === 'bashstop') {
        this.#setVariable(fighter, 'IsAttacking', 0);
        this.#setVariable(fighter, 'IsBashing', 0);
      }
    }
  }

  #effect(fighter: Fighter, effect: CombatEffect): void {
    const gear = fighter.gear;
    switch (effect.kind) {
      case 'hand':
        fighter.inHand = true;
        this.#playSound(gear?.rightRecord?.sounds.equip, fighter);
        break;
      case 'sheath':
        fighter.inHand = false;
        this.#playSound(gear?.rightRecord?.sounds.unequip, fighter);
        break;
      case 'swing': {
        const record =
          fighter.state.current?.hand === 'left' ? gear?.leftRecord : gear?.rightRecord;
        this.#playSound(record?.sounds.swing, fighter);
        // The swing is heard (its weapon's sound level, VNAM) and, the player's, commented on.
        this.#options.senses?.()?.action(fighter.reference, record?.soundLevel ?? 1);
        if (fighter.player) void this.#options.talk?.()?.playerAction('SWMW');
        break;
      }
      case 'strike':
        void this.#strike(fighter).catch((error: unknown) => {
          this.#warn(`a strike: ${describe(error)}`);
        });
        break;
      case 'arrow-release':
        this.#loose(fighter);
        break;
      case 'kill-actor': {
        const leader = [...this.#fighters.values()].find(
          (other) => other.state.paired === 'lead' && other.target === fighter.reference,
        );
        void this.#options.session.scriptsReady?.actors.kill(fighter.reference, leader?.reference);
        break;
      }
      case 'pair-end':
        for (const graph of this.#graphs(fighter)) graph.pairedSide = undefined;
        if (this.#camera) this.#camera.done = true;
        break;
      default:
        break;
    }
  }

  // --- Strikes and hits -------------------------------------------------------------------------

  /** A melee strike lands (HitFrame): the nearest within reach and angle is hit, or a wall. */
  async #strike(fighter: Fighter): Promise<void> {
    const current = fighter.state.current;
    const feet = this.#feet(fighter);
    if (!current || !feet || current.killMove) return;
    const data = this.#attackData(fighter, current.event);
    const scale = this.#scale(fighter);
    const strike = {
      origin: feet,
      heading: this.#heading(fighter),
      height: BODY_HEIGHT * scale,
      reach: this.#reach(fighter, current.bash),
      attackAngle: data.attackAngle,
      strikeAngle: data.strikeAngle,
    };
    const kind: AttackKind = {
      power: current.power,
      bash: current.bash,
      sneak: false,
      ranged: false,
    };
    const targets: StrikeTarget[] = [];
    for (const other of this.#fighters.values()) {
      if (other === fighter || current.struck.has(other.reference)) continue;
      if (other.state.life === LifeState.dead || other.state.paired === 'support') continue;
      const at = this.#feet(other);
      if (!at) continue;
      const size = this.#scale(other);
      targets.push({
        reference: other.reference,
        feet: at,
        radius: BODY_RADIUS * size,
        height: BODY_HEIGHT * size,
      });
    }
    const contacts = strikeTargets(strike, targets, combatHooks().sweeps(fighter.reference, kind));
    const physics = this.#play?.physics;
    const chest: Vec3 = [feet[0], feet[1], feet[2] + strike.height * CHEST];
    if (contacts.length === 0) {
      // Nothing to hit: a wall in reach before it recoils it.
      const forward: Vec3 = [Math.sin(strike.heading), Math.cos(strike.heading), 0];
      const wall = physics?.queriesCurrent
        ? physics.raycast(chest, forward, strike.reach, Layer.weapon)
        : undefined;
      if (wall && wall.owner?.kind !== 'actor') {
        const recoil = recoilOf(current, 'wall', undefined, this.#settings);
        if (recoil !== 'none')
          void this.#act(fighter, recoil === 'large' ? 'ActionRecoilLarge' : 'ActionRecoil');
        if (recoil !== 'none') fighter.state.recoiling = true;
        const set = current.hand === 'left' ? fighter.gear?.leftRecord : fighter.gear?.rightRecord;
        void this.#impacts.hit(
          {
            impactDataSet: set?.impactDataSet ?? fighter.gear?.race?.impactDataSet,
            materialId: wall.material,
            position: wall.point,
            direction: forward,
            heavy: current.power,
          },
          physics,
        );
      }
      return;
    }
    for (const contact of contacts) {
      current.struck.add(contact.target.reference);
      const at = contact.target.feet;
      const point: Vec3 = [at[0], at[1], at[2] + contact.target.height * CHEST];
      const way: Vec3 = [point[0] - chest[0], point[1] - chest[1], point[2] - chest[2]];
      const length = Math.hypot(...way) || 1;
      await this.#hit(fighter.reference, contact.target.reference, {
        ...kind,
        point,
        direction: [way[0] / length, way[1] / length, way[2] / length],
        shot: undefined,
      });
    }
  }

  /**
   * A hit of an attacker on a target (a strike, a shot): its damage, the block, stagger or
   * recoil, its impact, the target's scripts told, the skills used, its health taken.
   */
  async #hit(
    attackerRef: number,
    targetRef: number,
    hit: AttackKind & {
      readonly point: Vec3;
      readonly direction: Vec3;
      readonly shot: ShotPayload | undefined;
    },
  ): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const attacker = this.#fighters.get(attackerRef);
    const target = this.#fighters.get(targetRef);
    if (!runtime || !attacker || !target) return;
    if (target.state.life === LifeState.dead) return;
    const settings = this.#settings;
    const hooks = combatHooks();
    const gear = attacker.gear;
    const current = attacker.state.current;
    const left = current?.hand === 'left';
    const stats = left ? gear?.left : gear?.right;
    const record = left ? gear?.leftRecord : gear?.rightRecord;
    const data = hit.shot
      ? DEFAULT_ATTACK
      : current
        ? this.#attackData(attacker, current.event)
        : DEFAULT_ATTACK;
    // The physical damage: the weapon's (the equip system's, with skill and perks) × the
    // attack's; a bash by the weapon's base damage or the shield's rating × the Block skill;
    // a shot its bow's and arrow's × its draw.
    const blockSkill = (await runtime.actors.value(attackerRef, ActorValue.firstSkill + 3)).current;
    let physical: number;
    if (hit.shot) {
      physical = hit.shot.damage * hit.shot.power;
    } else if (hit.bash) {
      const shield = gear?.shield !== undefined && (stats?.weapon === undefined || left);
      const base = shield ? gear.shieldRating : (stats?.baseDamage ?? 0);
      physical = base * data.damageMult * bashFactor(blockSkill, shield, attacker.player, settings);
    } else {
      physical = (stats?.damage ?? 0) * data.damageMult;
    }
    // A critical hit: the perks' chance, the weapon's critical damage (fists: × the setting).
    const critical =
      Math.random() < hooks.criticalChance(attackerRef, stats?.weapon, hit)
        ? (stats?.critDamage ?? 0) *
          hooks.criticalDamageMult(attackerRef, stats?.weapon) *
          (stats?.weapon === undefined ? settings.unarmedCritDamageMult : 1)
        : 0;
    attacker.lastCritical = critical > 0;
    // A sneak attack: the attacker sneaks and the target does not detect it (detection:
    // src/shell/actor-senses.ts; without it, one that does not fight the attacker).
    const sneaking = attacker.player
      ? this.#play?.player.sneaking === true
      : this.#options.movers.motion(attackerRef)?.sneaking === true;
    const senses = this.#options.senses?.();
    const aware = senses ? senses.detects(targetRef, attackerRef) : target.target === attackerRef;
    const sneak = sneaking && !aware && !hit.bash;
    const equipped =
      stats?.weaponType === WeaponType.crossbow
        ? EquippedItemType.crossbow
        : (stats?.weaponType ?? EquippedItemType.handToHand);
    const sneakMult = sneak
      ? sneakAttackMult(equipped, settings) * hooks.sneakPerkMult(attackerRef, equipped)
      : 1;
    // The block: the target blocks and faces the blow (fCombatHitConeAngle).
    const targetFeet = this.#feet(target) ?? hit.point;
    const attackerFeet = this.#feet(attacker) ?? hit.point;
    const blocks =
      target.state.blocking &&
      !hit.shot &&
      blockCovers(targetFeet, this.#heading(target), attackerFeet, settings.combatHitConeAngle);
    const targetGear = target.gear;
    const shielded = targetGear?.shield !== undefined;
    const targetBlockSkill = (await runtime.actors.value(targetRef, ActorValue.firstSkill + 3))
      .current;
    const blocked = blocks
      ? blockedShare(
          {
            shieldRating: shielded ? targetGear.shieldRating : undefined,
            attackerWeaponDamage: stats?.baseDamage ?? 0,
            blockSkill: targetBlockSkill,
            blockMult: hooks.blockPerkMult(targetRef, shielded),
            powerAttack: hit.power,
          },
          settings,
        )
      : 0;
    const armor = await runtime.equipment.armorRating(targetRef);
    const result = hitDamage(
      {
        physical,
        critical,
        sneakMult,
        armorReduction: armor.reduction,
        blocked,
        incomingMult: hooks.incomingDamageMult(targetRef, attackerRef),
        difficulty: this.#difficulty(),
        attackerIsPlayer: attacker.player,
        targetIsPlayer: target.player,
      },
      settings,
    );
    // Blocked: a plain attack recoils its attacker, the block takes the hit (ActionBlockHit),
    // a power attack staggers the blocker; the blocker's stamina pays for it.
    if (blocks) {
      void this.#act(target, 'ActionBlockHit');
      this.#bark(targetRef, 'Block', attackerRef);
      const recoil = recoilOf(
        hit,
        'block',
        shielded ? targetGear.shieldRating : undefined,
        settings,
      );
      if (recoil !== 'none') {
        attacker.state.recoiling = true;
        void this.#act(attacker, recoil === 'large' ? 'ActionRecoilLarge' : 'ActionRecoil');
      }
      const stagger = blockStagger(hit.power, result.blockedDamage, settings);
      if (stagger > 0) this.#stagger(target, stagger, attackerFeet);
      void runtime.progression
        .blockCost(result.blockedDamage)
        .then((cost) => runtime.progression.spend(targetRef, ActorValue.stamina, cost));
      // The Block skill: by the damage blocked (a shield's twice: UESP "Block").
      void runtime.progression.useSkill(
        targetRef,
        ActorValue.firstSkill + 3,
        result.blockedDamage * (shielded ? 2 : 1),
      );
    } else {
      const stagger = staggerMagnitude(
        {
          weaponStagger: hit.bash || stats?.weapon === undefined ? 1 : stats.stagger,
          attackStagger: hit.shot ? 0 : data.stagger,
          perkMult: hooks.staggerPerkMult(attackerRef, hit),
          targetMass: targetGear?.race?.mass ?? 1,
          targetIsPlayer: target.player,
        },
        settings,
      );
      if (stagger > 0) this.#stagger(target, stagger, attackerFeet);
    }
    // Its impact: the weapon's impact data set (a bash or block: BIDS; fists: the race's)
    // against the target's flesh (its race's material).
    const impactSet =
      hit.bash || blocks
        ? (record?.blockBashImpactDataSet ?? record?.impactDataSet)
        : hit.shot
          ? hit.shot.impactDataSet
          : (record?.impactDataSet ?? gear?.race?.impactDataSet);
    void this.#impacts.hit(
      {
        impactDataSet: impactSet,
        ...(targetGear?.race?.material !== undefined && { materialForm: targetGear.race.material }),
        position: hit.point,
        direction: hit.direction,
        heavy: hit.power,
      },
      this.#play?.physics,
    );
    // The skills: the weapon's by its base damage (UESP: experience follows the base damage
    // dealt), Sneak for a sneak attack (fSneakAttackSkillUsageMelee).
    const skill = hit.bash ? ActorValue.firstSkill + 3 : (stats?.skill ?? -1);
    if (skill >= 0 && !blocks) {
      void runtime.progression.useSkill(attackerRef, skill, stats?.baseDamage ?? 0);
    }
    if (sneak) void runtime.progression.useSkill(attackerRef, ActorValue.firstSkill + 9, 30);
    // TODO(M11): the armour skills of the one hit (Light/Heavy Armor by the damage taken) are
    // the skill progression's to count.
    // The target's scripts hear of it (OnHit: aggressor, source, projectile, power, sneak,
    // bash, blocked).
    void runtime.sendEvent(targetRef, 'OnHit', [
      runtime.actorHandle(attackerRef),
      stats?.weapon === undefined ? null : runtime.formHandle(stats.weapon),
      hit.shot?.projectile === undefined ? null : runtime.formHandle(hit.shot.projectile),
      hit.power,
      sneak,
      hit.bash,
      blocks,
    ]);
    // It fights back, or lets a friend's blow pass (the combat AI: iFriendHitCombatAllowed).
    this.#brain.hit(attackerRef, targetRef);
    if (attacker.player)
      this.#enemy = { reference: targetRef, until: this.#clock + ENEMY_BAR_SECONDS };
    // Detection: the one attacked searches for its attacker; those near watch the fight.
    senses?.attackedBy(targetRef, attackerRef);
    // The weapon's enchantment and the poison on it (not a bash: the magic system); a diseased
    // creature's attack (its attack data's spell) may pass its disease on.
    if (!hit.bash && !blocks) await runtime.magic.weaponHit(attackerRef, targetRef, stats?.weapon);
    if (!hit.shot && !blocks && data.spell !== undefined) {
      await runtime.magic.contractDisease(targetRef, data.spell);
    }
    // Its health; the killing blow pushes its ragdoll (fDeathForce*). The one hit says its
    // line (Hit), or its death cry.
    if (result.total <= 0) return;
    await runtime.actors.damage(targetRef, ActorValue.health, result.total, attackerRef);
    if (await runtime.actors.isDead(targetRef)) {
      this.#bark(targetRef, 'Death', attackerRef, true);
      this.#deathPush(target, result.total, hit);
    } else if (!target.player) {
      this.#bark(targetRef, 'Hit', attackerRef);
    }
  }

  /** A combat line (src/shell/actor-talk.ts bark): an actor's, by its topic subtype. */
  #bark(actor: number, subtype: string, target?: number, interrupt = false): void {
    if (actor === PLAYER_REF) return;
    const talk = this.#options.talk?.();
    if (!talk) return;
    talk.bark(actor, subtype, target ?? PLAYER_REF, { interrupt }).catch((error: unknown) => {
      this.#warn(`a combat line: ${describe(error)}`);
    });
  }

  /** The blow that killed pushes the ragdoll by its damage (fDeathForce{Ranged}*). */
  #deathPush(
    target: Fighter,
    damage: number,
    hit: { readonly direction: Vec3; readonly shot: ShotPayload | undefined },
  ): void {
    const staged = this.#options.get(target.reference);
    if (!staged) return;
    const s = this.#settings;
    const [dMin, dMax, fMin, fMax] = hit.shot
      ? [
          s.deathForceRangedDamageMin,
          s.deathForceRangedDamageMax,
          s.deathForceRangedForceMin,
          s.deathForceRangedForceMax,
        ]
      : [s.deathForceDamageMin, s.deathForceDamageMax, s.deathForceForceMin, s.deathForceForceMax];
    const t = Math.min(1, Math.max(0, (damage - dMin) / Math.max(1e-6, dMax - dMin)));
    void this.#options.bodies.push(staged, hit.direction, fMin + (fMax - fMin) * t);
  }

  /** Staggers a fighter by a magnitude from where the blow came (ActionStaggerStart). */
  #stagger(fighter: Fighter, magnitude: number, from: Vec3): void {
    const feet = this.#feet(fighter);
    if (!feet || fighter.state.paired !== undefined || bleedingOut(fighter.state)) return;
    this.#setVariable(fighter, 'staggerMagnitude', magnitude);
    this.#setVariable(
      fighter,
      'staggerDirection',
      hitDirection(feet, this.#heading(fighter), from),
    );
    void this.#act(fighter, 'ActionStaggerStart').then((event) => {
      if (event !== undefined && event !== '00NextClip') {
        fighter.state.staggered = true;
        fighter.state.current = undefined;
        fighter.state.attack = AttackState.none;
      }
    });
  }

  // --- Bows ---------------------------------------------------------------------------------------

  /** The arrow leaves the bow (arrowRelease): a shot along the aim, its damage by the draw. */
  #loose(fighter: Fighter): void {
    const gear = fighter.gear;
    const runtime = this.#options.session.scriptsReady;
    const feet = this.#feet(fighter);
    if (!gear?.projectile || gear.right.ammo === undefined || !runtime || !feet) return;
    const scale = this.#scale(fighter);
    const from: Vec3 = [feet[0], feet[1], feet[2] + BODY_HEIGHT * scale * CHEST + 10 * scale];
    let aim: Vec3;
    if (fighter.player && this.#play) {
      const player = this.#play.player;
      aim = tiltUp(
        player.forward,
        player.pov === 'first' ? ARROW_TILT.firstPerson : ARROW_TILT.thirdPerson,
      );
    } else {
      const target = fighter.target === undefined ? undefined : this.#fighters.get(fighter.target);
      const there = target && this.#feet(target);
      if (there) {
        const height = BODY_HEIGHT * this.#scale(target) * CHEST;
        const way: Vec3 = [there[0] - from[0], there[1] - from[1], there[2] + height - from[2]];
        // fBowNPCSpreadAngle: an NPC's aim strays this far (degrees).
        const spread = ((Math.random() - 0.5) * 4 * Math.PI) / 180;
        const heading = Math.atan2(way[0], way[1]) + spread;
        const pitch = Math.atan2(way[2], Math.hypot(way[0], way[1]));
        aim = tiltUp(
          [
            Math.sin(heading) * Math.cos(pitch),
            Math.cos(heading) * Math.cos(pitch),
            Math.sin(pitch),
          ],
          ARROW_TILT.thirdPerson,
        );
      } else {
        const heading = this.#heading(fighter);
        aim = [Math.sin(heading), Math.cos(heading), 0];
      }
    }
    const power = bowDrawPower(fighter.state.drawnFor, gear.right.speed);
    const ammo = gear.right.ammo;
    const payload: ShotPayload = {
      attacker: fighter.reference,
      damage: gear.right.shotDamage,
      power,
      impactDataSet: gear.rightRecord?.impactDataSet,
      projectile: gear.projectile.formId,
      kind: { power: false, bash: false, sneak: false, ranged: true },
    };
    void this.#projectiles.loose({
      shooter: fighter.reference,
      ammo,
      projectile: gear.projectile,
      from,
      aim,
      power: Math.max(0.35, power),
      payload,
    });
    this.#playSound(gear.rightRecord?.sounds.attack, fighter);
    // The shot is heard; the player's commented on (ShootBow).
    this.#options.senses?.()?.action(fighter.reference, gear.rightRecord?.soundLevel ?? 1);
    if (fighter.player) void this.#options.talk?.()?.playerAction('FIWE');
    // An arrow used (the equip system's count; the player's quiver empties).
    void runtime.removeItem(fighter.reference, runtime.formHandle(ammo), 1, true, undefined);
    fighter.state.drawnFor = 0;
  }

  // --- Killmoves -------------------------------------------------------------------------------

  /**
   * A paired killmove: the leader plays "pa_<name>", the one it is done to "<name>" (its
   * graph's VictimBehavior), each its part of the paired clip, the victim placed before the
   * leader facing it; it dies at its clip's KillActor. The player's camera shows it.
   */
  #pair(leader: Fighter, victimRef: number, event: string): void {
    const victim = this.#fighters.get(victimRef);
    const feet = this.#feet(leader);
    if (!victim || !feet) return;
    leader.state.paired = 'lead';
    victim.state.paired = 'support';
    victim.state.current = undefined;
    // The leader plays the clip's first side, the victim its "2_" side (one skeleton both:
    // the side is theirs to set, src/animation/paired-clips.ts).
    for (const graph of this.#graphs(leader)) graph.pairedSide = 'first';
    for (const graph of this.#graphs(victim)) {
      graph.pairedSide = 'second';
      graph.sendEvent(event.slice(3));
    }
    const heading = this.#heading(leader);
    const at: Vec3 = [
      feet[0] + Math.sin(heading) * PAIRED_DISTANCE,
      feet[1] + Math.cos(heading) * PAIRED_DISTANCE,
      feet[2],
    ];
    const staged = this.#options.get(victimRef);
    if (staged) {
      staged.position = at;
      staged.heading = heading + Math.PI;
      this.#options.movers.teleport(staged);
      this.#options.movers.request(victimRef, undefined);
    }
    if ((leader.player || victim.player) && this.#play?.player.pov === 'third') {
      void KillmoveCamera.choose(this.#options.session, {
        attacker: () => this.#feet(leader),
        attackerHeading: () => this.#heading(leader),
        target: () => this.#feet(victim),
        attackerRef: leader.reference,
        targetRef: victimRef,
        physics: this.#play.physics,
      }).then((camera) => {
        if (camera && leader.state.paired === 'lead') this.#camera = camera;
      });
    }
  }

  // --- The combat AI's view --------------------------------------------------------------------

  /** What the combat AI sees of the fighters and asks of them. */
  #host(): CombatAiHost {
    return {
      fighters: () => this.#views(),
      fighter: (reference) => {
        const fighter = this.#fighters.get(reference);
        return fighter && this.#view(fighter);
      },
      setTarget: (reference, target) => {
        const fighter = this.#fighters.get(reference);
        if (fighter && !fighter.player) fighter.target = target;
      },
      draw: (reference) => this.draw(reference),
      sheathe: (reference) => this.sheathe(reference),
      attack: (reference, action) => this.attack(reference, action),
      release: (reference, action) => this.release(reference, action),
      block: (reference, on) => this.block(reference, on),
      act: (reference, action, target) => {
        const fighter = this.#fighters.get(reference);
        return fighter ? this.#act(fighter, action, target) : Promise.resolve(undefined);
      },
      threats: () => this.#threats(),
    };
  }

  *#views(): Iterable<FighterView> {
    for (const fighter of this.#fighters.values()) yield this.#view(fighter);
  }

  #view(fighter: Fighter): FighterView {
    const gear = fighter.gear;
    const scale = this.#scale(fighter);
    const right = gear?.right;
    const bow =
      right !== undefined &&
      (right.weaponType === WeaponType.bow || right.weaponType === WeaponType.crossbow) &&
      gear?.projectile !== undefined &&
      right.ammo !== undefined;
    const twoHanded =
      right?.weapon !== undefined &&
      right.weaponType >= WeaponType.twoHandSword &&
      right.weaponType !== WeaponType.staff;
    let powerChance = 0;
    let canBash = false;
    for (const attack of gear?.attacks.all() ?? []) {
      const kind = attackEventKind(attack.event, attack);
      if (kind?.bash) canBash = true;
      else if (kind?.power) powerChance = Math.max(powerChance, attack.attackChance);
    }
    return {
      reference: fighter.reference,
      player: fighter.player,
      state: fighter.state,
      target: fighter.target,
      feet: this.#feet(fighter),
      heading: this.#heading(fighter),
      reach: this.#reach(fighter, false),
      radius: BODY_RADIUS * scale,
      height: BODY_HEIGHT * scale,
      gear: gear && {
        weapon: gear.right.weapon,
        weaponType: gear.right.weaponType,
        bow,
        shield: gear.shield !== undefined,
        canBlock:
          gear.shield !== undefined ||
          twoHanded ||
          (gear.right.weapon !== undefined && gear.left.weapon === undefined),
        damage: gear.right.damage,
        shotDamage: gear.right.shotDamage,
        range: gear.projectile?.range ?? 0,
        canBash,
        powerChance,
      },
    };
  }

  /** What flies at the actors now: the arrows (TODO(M10) 5.3, 5.4: spells and breath). */
  *#threats(): Iterable<Threat> {
    for (const shot of this.#projectiles.flying()) {
      yield {
        key: shot.key,
        position: shot.position,
        velocity: shot.velocity,
        radius: SHOT_RADIUS,
        source: shot.shooter,
      };
    }
  }

  // --- Helpers ---------------------------------------------------------------------------------

  /** Plays an action's idle on a fighter (its target the conditions' Target); its event. */
  async #act(fighter: Fighter, action: string, target?: number): Promise<string | undefined> {
    const runtime = this.#options.session.scriptsReady;
    const body = fighter.body;
    if (!runtime || !body) return undefined;
    this.#tree ??= this.#options.session.db.then((db) => readIdleTree(db));
    const tree = await this.#tree;
    const parent = tree.action(action);
    const graph = await this.#graphKey(body.look.behavior);
    if (!parent || graph === undefined) return undefined;
    const subject = new ObjectHandle(fighter.reference, 'actor');
    const context = target === undefined ? {} : { target: runtime.referenceHandle(target) };
    const idle = await tree.resolveAsync(parent.formId, graph, (candidate) =>
      runtime.conditionsHold(candidate.conditions, subject, undefined, context),
    );
    const event = idle?.event;
    if (event === undefined) return undefined;
    let taken = false;
    for (const runtimeGraph of this.#graphs(fighter))
      taken = runtimeGraph.sendEvent(event) || taken;
    return taken ? event : undefined;
  }

  #graphKey(project: string | undefined): Promise<string | undefined> {
    if (project === undefined) return Promise.resolve(undefined);
    let entry = this.#graphKeys.get(project);
    if (!entry) {
      entry = this.#options.session.animation
        .behaviors(project)
        .then((behaviors) => {
          const file = behaviors?.character.behavior;
          return file === undefined ? undefined : behaviorGraphKey(file);
        })
        .catch(() => undefined);
      this.#graphKeys.set(project, entry);
    }
    return entry;
  }

  /** A fighter's graphs (the player's body and first-person graphs). */
  #graphs(fighter: Fighter): BehaviorRuntime[] {
    const graphs: BehaviorRuntime[] = [];
    const body = fighter.body?.behavior;
    if (body) graphs.push(body);
    if (fighter.player) {
      const first = this.#avatar?.firstPerson?.behavior;
      if (first) graphs.push(first);
    }
    return graphs;
  }

  #setVariable(fighter: Fighter, name: string, value: number): void {
    for (const graph of this.#graphs(fighter)) graph.setVariable(name, value);
  }

  /** The attack data of an event (killmoves and events without data: a power attack's). */
  #attackData(fighter: Fighter, event: string): AttackData {
    const data = fighter.gear?.attacks.of(event);
    if (data) return data;
    return event.toLowerCase().startsWith('pa_') ? POWER_ATTACK_DEFAULT : DEFAULT_ATTACK;
  }

  /** Stamina for a power attack or bash (the skill progression's costs). */
  async #spendFor(
    fighter: Fighter,
    data: AttackData,
    power: boolean,
    bash: boolean,
    dual: boolean,
  ): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime || (!power && !bash)) return;
    const progression = runtime.progression;
    const weight = fighter.gear?.rightRecord?.weight ?? 0;
    const cost = bash
      ? await progression.bashCost(power)
      : await progression.powerAttackCost(weight, {
          dualWield: dual,
          attackStaminaMult: data.staminaMult,
        });
    await progression.spend(fighter.reference, ActorValue.stamina, cost);
  }

  /** How far it strikes (its weapon's reach, a bash's, its fists' by its race). */
  #reach(fighter: Fighter, bash: boolean): number {
    const gear = fighter.gear;
    return meleeReach(
      {
        weaponReach: gear?.right.weapon === undefined ? undefined : gear.right.reach,
        bash,
        unarmedReach: gear?.race?.unarmedReach ?? 96,
        scale: this.#scale(fighter),
      },
      this.#settings,
    );
  }

  #scale(fighter: Fighter): number {
    const body = fighter.body;
    return body ? body.look.scale * body.actor.scale : 1;
  }

  #feet(fighter: Fighter): Vec3 | undefined {
    if (fighter.player) return this.#play?.player.feet;
    return this.#options.get(fighter.reference)?.position;
  }

  #heading(fighter: Fighter): number {
    if (fighter.player) return this.#avatar?.bodyYaw ?? this.#play?.player.yaw ?? 0;
    return this.#options.get(fighter.reference)?.heading ?? 0;
  }

  /** GetMovementDirection: 0 none, 1 forward, 2 right, 3 back, 4 left. */
  #movementDirection(fighter: Fighter): number {
    let x: number;
    let y: number;
    if (fighter.player) {
      const motion = this.#play?.player.motion;
      if (!motion?.moving) return 0;
      x = motion.inputX;
      y = motion.inputY;
    } else {
      const moved = this.#options.movers.state(fighter.reference);
      if (!moved) return 0;
      const [vx, vy] = moved.velocity;
      if (Math.hypot(vx, vy) < 5) return 0;
      const heading = this.#heading(fighter);
      // Into the actor's frame: x right, y forward.
      x = vx * Math.cos(heading) - vy * Math.sin(heading);
      y = vx * Math.sin(heading) + vy * Math.cos(heading);
    }
    if (Math.abs(y) >= Math.abs(x)) return y >= 0 ? 1 : 3;
    return x >= 0 ? 2 : 4;
  }

  /** The actor the player strikes at: the nearest in front of them within reach. */
  #aimedAt(fighter: Fighter): number | undefined {
    const feet = this.#feet(fighter);
    if (!feet) return undefined;
    const heading = this.#play?.player.yaw ?? this.#heading(fighter);
    let best: { reference: number; distance: number } | undefined;
    const reach = this.#reach(fighter, false) * 2;
    for (const other of this.#fighters.values()) {
      if (other === fighter || other.state.life === LifeState.dead) continue;
      const at = this.#feet(other);
      if (!at) continue;
      const distance = Math.hypot(at[0] - feet[0], at[1] - feet[1]);
      if (distance > reach) continue;
      if (Math.abs(turnBetween(heading, headingTo(feet, at))) > Math.PI / 3) continue;
      if (!best || distance < best.distance) best = { reference: other.reference, distance };
    }
    return best?.reference;
  }

  /** Whether the fighter's target is the last actor that fights it. */
  #lastHostile(fighter: Fighter): boolean {
    let hostile = 0;
    for (const other of this.#fighters.values()) {
      if (other.target === fighter.reference && other.state.life !== LifeState.dead) hostile++;
    }
    return hostile <= 1;
  }

  #fightingPlayer(): boolean {
    for (const fighter of this.#fighters.values()) {
      if (fighter.target === PLAYER_REF && fighter.state.life === LifeState.alive) return true;
    }
    return false;
  }

  /**
   * Combat music (DOBJ BTMS, MUSCombat) while anyone fights the player; it ends with its
   * finale as the fight does (the music system's ducking and cue points).
   */
  #setMusic(on: boolean): void {
    if (on === this.#musicOn) return;
    const sounds = this.#options.session.soundSystem;
    if (!sounds) return;
    this.#musicOn = on;
    if (on) {
      void this.#options.session.defaultObjects().then((objects) => {
        const music = objects.get(DefaultObjectUse.battleMusic);
        if (music === undefined || !this.#musicOn) return;
        this.#music = music;
        sounds.music.add(music);
      });
    } else if (this.#music !== undefined) {
      sounds.music.remove(this.#music);
      this.#music = undefined;
    }
  }

  /** The HUD's enemy bar: the one the player hit last, while the fight lasts. */
  #enemyBar(): void {
    const hud = this.#options.session.hud;
    const enemy = this.#enemy;
    if (!enemy || this.#clock > enemy.until) {
      if (enemy) hud.enemy(undefined);
      this.#enemy = undefined;
      return;
    }
    const fighter = this.#fighters.get(enemy.reference);
    const runtime = this.#options.session.scriptsReady;
    if (!fighter?.body || !runtime) return;
    const name = fighter.body.look.name || fighter.body.look.editorId;
    void runtime.actors.value(enemy.reference, ActorValue.health).then((value) => {
      hud.enemy({ name, health: value.max > 0 ? (value.current / value.max) * 100 : 0 });
    });
  }

  /** The player's shape for shots (they have no bodies on BIPED). */
  *#playerShape(): Iterable<{ reference: number; feet: Vec3; radius: number; height: number }> {
    const player = this.#play?.player;
    if (!player || !this.#fighters.has(PLAYER_REF)) return;
    yield {
      reference: PLAYER_REF,
      feet: player.feet,
      radius: BODY_RADIUS,
      height: BODY_HEIGHT * player.height,
    };
  }

  #playSound(sound: number | undefined, fighter: Fighter): void {
    if (sound === undefined) return;
    const sounds = this.#options.session.soundSystem;
    const feet = this.#feet(fighter);
    if (!sounds || !feet) return;
    const at = fighter.body?.pose.world('WEAPON');
    const world = fighter.player
      ? this.#avatar?.placement.world
      : fighter.body?.instances[0]?.world;
    const place: Vec3 =
      at && world ? transformPoint(world, [at[12] ?? 0, at[13] ?? 0, at[14] ?? 0]) : feet;
    void sounds.play(sound, place);
  }

  #difficulty(): number {
    return this.#options.session.ini.number('GamePlay', 'iDifficulty');
  }

  #readSettings(): void {
    if (this.#settingsRead) return;
    this.#settingsRead = true;
    void this.#options.session.settings().then((settings) => {
      this.#settings = readCombatSettings((name) => settings.number(name));
    });
  }

  /** The equip system's changes: what an actor holds is read again. */
  #listenToEquipment(runtime: ScriptRuntime): void {
    if (this.#equipListening === runtime) return;
    this.#equipListening = runtime;
    runtime.equipment.listeners.add((change) => {
      const fighter = this.#fighters.get(change.actor);
      if (!fighter) return;
      fighter.gearVersion++;
      fighter.gear = undefined;
    });
    // The skill progression's regeneration in combat.
    runtime.progression.inCombat = (actor) =>
      actor === PLAYER_REF ? this.#fightingPlayer() : this.#brain.combatState(actor) !== 0;
  }

  #drop(fighter: Fighter): void {
    fighter.held?.destroy();
    this.#fighters.delete(fighter.reference);
  }

  #warn(message: string): void {
    this.#options.terminal.log('combat', message, 'warn');
  }

  /** An actor left the stage or died: it fights no more. */
  remove(reference: number): void {
    const fighter = this.#fighters.get(reference);
    if (fighter && !fighter.player) this.#drop(fighter);
    for (const other of this.#fighters.values()) {
      if (other.target === reference) other.target = undefined;
    }
    this.#brain.remove(reference);
  }

  clear(): void {
    this.#brain.clear();
    for (const fighter of [...this.#fighters.values()]) this.#drop(fighter);
    this.#projectiles.clear();
    this.#impacts.clear();
    this.#setMusic(false);
  }

  /** Knocked down (a ragdoll that gets up: Unrelenting Force; TODO(M10) 5.3). */
  knockState(reference: number): number {
    return this.#fighters.get(reference)?.state.knock ?? KnockState.normal;
  }
}

/** What a shot carries to its hit. */
interface ShotPayload {
  readonly attacker: number;
  /** The bow's shot damage (bow and arrow, with skill and perks) and its draw. */
  readonly damage: number;
  readonly power: number;
  readonly impactDataSet: number | undefined;
  readonly projectile: number;
  readonly kind: AttackKind;
}

function newFighter(reference: number, player: boolean): Fighter {
  return {
    reference,
    player,
    state: newCombatState(),
    body: undefined,
    hooked: undefined,
    held: undefined,
    heldFor: undefined,
    gear: undefined,
    gearVersion: 0,
    gearLoading: false,
    target: undefined,
    heldSince: undefined,
    inHand: false,
    down: 0,
    pairedFor: 0,
    killing: false,
    lastCritical: false,
  };
}
