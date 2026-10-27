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
import { AttackState, WeaponState } from '../gameplay/combat/combat-state.ts';
import { WeaponType } from '../world/item-records.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorCombat } from './actor-combat.ts';
import type { Player } from './player.ts';

const RIGHT = 'Right Attack/Block';
const LEFT = 'Left Attack/Block';
const READY = 'Ready Weapon';

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
        void combat.block(PLAYER_REF, true);
      } else {
        this.#left = { since: this.#clock, power: false };
      }
    }
    if (this.#blocking && !player.isHeld(LEFT)) {
      this.#blocking = false;
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
