// The player's attacks and blocks (docs/ai.md, "Combat"), by the control map's user events:
// Ready Weapon draws or sheathes; Right Attack/Block attacks with the right hand, Left
// Attack/Block with the left (a one-handed weapon there) or blocks (a shield, nothing, or a
// two-handed weapon: held, it blocks; with Right Attack meanwhile a bash). An attack button let
// go before [Controls] fInitialPowerAttackDelay (0.3 s) is a plain attack; held that long, a
// power attack (fInitialPowerBashDelay for a power bash; both buttons: the dual attacks). A bow
// draws while Right Attack is held and looses when it is let go. Through the same actions as the
// NPCs' (src/shell/actor-combat.ts). A drawn hand holding something to cast (a spell, a staff, a
// scroll) casts instead: its button goes to the player's casting (src/shell/player-casting.ts).

import { POWER_ATTACK_TIMING } from '../gameplay/combat/combat-settings.ts';
import {
  AttackState,
  attacking,
  WeaponState,
  type CombatState,
} from '../gameplay/combat/combat-state.ts';
import { WeaponType } from '../world/item-records.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorCombat } from './actor-combat.ts';
import type { Player } from './player.ts';

const RIGHT = 'Right Attack/Block';
const LEFT = 'Left Attack/Block';
const READY = 'Ready Weapon';

/**
 * How long a block held and refused waits before it is asked again although nothing it watches
 * (blockState) changed: what refused it may lie beyond what it watches (the combat not ready yet,
 * a graph variable a condition reads). TODO(M13): inferred; a low rate, not every frame.
 */
export const BLOCK_RETRY_SECONDS = 0.5;

/** The player's casting: the hands holding magic take their buttons (0 left, 1 right). */
export interface CastingButtons {
  /** Whether a hand holds something to cast now (a spell, a staff, a scroll). */
  casts(source: number): boolean;
  /** Its button went down (with the magic drawn); its casting watches it let go. */
  press(source: number): void;
}

/** A button held: since when, and whether its power attack went. */
interface Hold {
  since: number;
  power: boolean;
}

export class PlayerCombat {
  readonly #combat: ActorCombat;
  readonly #player: Player;
  /** Whether the player may fight now (not in furniture, not in a menu). */
  readonly #free: () => boolean;
  #clock = 0;
  #right: Hold | undefined;
  #left: Hold | undefined;
  #blocking = false;
  /** A block asked of the graph and not answered yet. */
  #raising = false;
  /** The state (blockState) a block held was refused in: asked again once it changes. */
  #refused: string | undefined;
  /** When (#clock) that refused block was asked. */
  #refusedAt = 0;

  /** The player's casting, if any. */
  readonly #casting: () => CastingButtons | undefined;
  /** A bow's zoom wanted (block held, an arrow drawn): the view's factor (1: none). */
  readonly #zoom: (wanted: boolean, weapon: number | undefined) => number;

  constructor(
    combat: ActorCombat,
    player: Player,
    free: () => boolean,
    casting: () => CastingButtons | undefined = () => undefined,
    zoom: (wanted: boolean, weapon: number | undefined) => number = () => 1,
  ) {
    this.#zoom = zoom;
    this.#combat = combat;
    this.#player = player;
    this.#free = free;
    this.#casting = casting;
  }

  /** Every frame: the buttons pressed, held and let go. */
  frame(seconds: number): void {
    this.#clock += seconds;
    const player = this.#player;
    const combat = this.#combat;
    const ready = player.takePressed(READY);
    let rightPressed = player.takePressed(RIGHT);
    let leftPressed = player.takePressed(LEFT);
    if (!this.#free()) {
      this.#right = undefined;
      this.#left = undefined;
      player.bowZoom = this.#zoom(false, undefined);
      return;
    }
    const state = combat.combatState(PLAYER_REF);
    const hands = combat.hands(PLAYER_REF);
    if (!state || !hands) return;
    if (ready) {
      // A vampire lord goes up or down instead (its magic in the air, its claws below).
      if (combat.toggleLevitation(PLAYER_REF)) return;
      if (state.weapon === WeaponState.sheathed) void combat.draw(PLAYER_REF);
      else void combat.sheathe(PLAYER_REF);
      return;
    }
    // With the weapon away, either button draws it (the tree's DrawWeapon idles).
    if (state.weapon === WeaponState.sheathed) {
      if (rightPressed || leftPressed) void combat.draw(PLAYER_REF);
      return;
    }
    if (state.weapon !== WeaponState.drawn) return;
    // A hand holding magic casts (its button is the casting's, not an attack or a block).
    const casting = this.#casting();
    const castsLeft = casting?.casts(0) === true;
    const castsRight = casting?.casts(1) === true;
    if (castsLeft) {
      if (leftPressed) casting.press(0);
      leftPressed = false;
      this.#left = undefined;
    }
    if (castsRight) {
      if (rightPressed) casting.press(1);
      rightPressed = false;
      this.#right = undefined;
    }
    const bow = hands.right === WeaponType.bow || hands.right === WeaponType.crossbow;
    const leftAttacks = hands.left !== undefined && hands.left <= WeaponType.oneHandMace;
    const fistsOnly = hands.right === undefined && hands.left === undefined && !hands.shield;
    const blocks = !leftAttacks && !fistsOnly && !castsLeft;
    const delay = POWER_ATTACK_TIMING.initialPowerAttackDelay;
    // The left button: a left attack, or a block held (a bow's: its zoom, the tree's).
    if (leftPressed) {
      if (blocks) {
        this.#blocking = true;
        this.#refused = undefined;
        if (bow) void combat.block(PLAYER_REF, true);
      } else {
        this.#left = { since: this.#clock, power: false };
      }
    }
    // A block held goes up once no attack is under way or the attack's window has opened
    // (blockOpen): pressed in the middle of a swing, it waits for the window (the graph takes no
    // block before it, and the press was lost: the player stood with the button held and no
    // guard up). 0_master's attack states take blockStart from AttackWinStart on and then end
    // the attack (blockStartOut, attackStop). A block the graph refused (a stagger, a jump in the
    // air, a sprint, a left hand whose tree has no blockStart) is asked again once what refused
    // it changed (blockState: the combat state, the hands, the ground under the feet, the
    // sprint, the graph's states) or BLOCK_RETRY_SECONDS passed, not every frame.
    if (!bow && this.#blocking && player.isHeld(LEFT) && !state.blocking && blockOpen(state)) {
      const asked = blockState(state, hands, {
        grounded: player.character.grounded,
        sprinting: player.motion.sprinting,
        graph: combat.graphStates(PLAYER_REF),
      });
      const due = asked !== this.#refused || this.#clock - this.#refusedAt >= BLOCK_RETRY_SECONDS;
      if (!this.#raising && due) {
        this.#raising = true;
        const at = this.#clock;
        const refused = (): void => {
          this.#refused = asked;
          this.#refusedAt = at;
        };
        void combat
          .block(PLAYER_REF, true)
          .then((taken) => {
            if (taken) this.#refused = undefined;
            else refused();
          })
          .catch(refused)
          .finally(() => {
            this.#raising = false;
          });
      }
    }
    if (this.#blocking && !player.isHeld(LEFT)) {
      this.#blocking = false;
      this.#refused = undefined;
      void combat.block(PLAYER_REF, false);
    }
    if (rightPressed) {
      if (bow) {
        void combat.attack(PLAYER_REF, 'ActionRightAttack');
      } else {
        // Blocking, the right button bashes (the tree's bashStart; held: bashPowerStart).
        this.#right = { since: this.#clock, power: false };
      }
    }
    // Block held with an arrow drawn zooms the view (Eagle Eye: Mod Bow Zoom; the tree's own
    // block is the bow's zoom), between the graph's BowZoomStart and BowZoomStop once it raises
    // them (the engine's BowZoomStartHandler, BowZoomStopHandler).
    player.bowZoom = this.#zoom(
      bow && this.#blocking && state.current?.ranged === true && player.graphBowZoom !== false,
      combat.weaponOf(PLAYER_REF),
    );
    // A bow looses when the button is let go.
    if (bow) {
      if (
        !player.isHeld(RIGHT) &&
        state.current?.ranged === true &&
        state.attack !== AttackState.bowReleasing
      ) {
        void combat.release(PLAYER_REF, 'ActionRightRelease');
      }
      return;
    }
    const both = this.#right !== undefined && this.#left !== undefined;
    const bashDelay = POWER_ATTACK_TIMING.initialPowerBashDelay;
    this.#button(
      this.#right,
      RIGHT,
      this.#blocking ? bashDelay : delay,
      (power) => {
        if (both) return power ? 'ActionDualPowerAttack' : 'ActionDualAttack';
        return power ? 'ActionRightPowerAttack' : 'ActionRightAttack';
      },
      () => {
        this.#right = undefined;
        if (both) this.#left = undefined;
      },
    );
    this.#button(
      this.#left,
      LEFT,
      delay,
      (power) => (power ? 'ActionLeftPowerAttack' : 'ActionLeftAttack'),
      () => {
        this.#left = undefined;
      },
    );
  }

  /** A held attack button: power once held past the delay, plain if let go before it. */
  #button(
    hold: Hold | undefined,
    name: string,
    delay: number,
    action: (power: boolean) => string,
    done: () => void,
  ): void {
    if (!hold) return;
    const held = this.#player.isHeld(name);
    if (held && !hold.power && this.#clock - hold.since >= delay) {
      hold.power = true;
      void this.#combat.attack(PLAYER_REF, action(true));
      return;
    }
    if (!held) {
      if (!hold.power) void this.#combat.attack(PLAYER_REF, action(false));
      done();
    }
  }
}

/**
 * Whether a block held may be asked of the graph now: no attack under way, or a melee attack's
 * window open (nextAttack from AttackWinStart, then followThrough). 0_master's attack states
 * take blockStart only from AttackWinStart on (behavior-run: an axe's attackStart, blockStart
 * 0.5 s in stays in AttackState; sent after AttackWinStart, BlockState, blockStartOut, then
 * attackStop).
 */
export function blockOpen(state: CombatState): boolean {
  return (
    !attacking(state) ||
    state.attack === AttackState.nextAttack ||
    state.attack === AttackState.followThrough
  );
}

/**
 * What decides whether the graph takes a block held now: the attack under way, a stagger, a
 * recoil, a fall, a paired animation, life, the hands, and of the body: the ground under its feet
 * (a jump in the air), a sprint, and its graph's states (0_master's JumpRoot and a sprint's
 * states take no ActionLeftAttack). A block refused in one state is asked again once this changes
 * (the attack, the stagger or the jump ended, the gear changed).
 */
export function blockState(
  state: CombatState,
  hands: {
    readonly right: number | undefined;
    readonly left: number | undefined;
    readonly shield: boolean;
  },
  body: { readonly grounded: boolean; readonly sprinting: boolean; readonly graph: string },
): string {
  return [
    state.weapon,
    state.attack,
    attacking(state),
    state.staggered,
    state.recoiling,
    state.knock,
    state.paired ?? '',
    state.life,
    hands.right ?? '',
    hands.left ?? '',
    hands.shield,
    body.grounded,
    body.sprinting,
    body.graph,
  ].join(':');
}
