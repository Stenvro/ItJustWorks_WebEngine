// The player's attacks and blocks (docs/ai.md, "Combat"), by the control map's user events:
// Ready Weapon draws or sheathes; Right Attack/Block attacks with the right hand, Left
// Attack/Block with the left (a one-handed weapon there) or blocks (a shield, nothing, or a
// two-handed weapon: held, it blocks; with Right Attack meanwhile a bash). An attack button let
// go before [Controls] fInitialPowerAttackDelay (0.3 s) is a plain attack; held that long, a
// power attack (fInitialPowerBashDelay for a power bash; both buttons: the dual attacks). A bow
// draws while Right Attack is held and looses when it is let go. Through the same actions as the
// NPCs' (src/shell/actor-combat.ts).

import { POWER_ATTACK_TIMING } from '../gameplay/combat/combat-settings.ts';
import { AttackState, WeaponState } from '../gameplay/combat/combat-state.ts';
import { WeaponType } from '../world/item-records.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorCombat } from './actor-combat.ts';
import type { Player } from './player.ts';

const RIGHT = 'Right Attack/Block';
const LEFT = 'Left Attack/Block';
const READY = 'Ready Weapon';

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

  constructor(combat: ActorCombat, player: Player, free: () => boolean) {
    this.#combat = combat;
    this.#player = player;
    this.#free = free;
  }

  /** Every frame: the buttons pressed, held and let go. */
  frame(seconds: number): void {
    this.#clock += seconds;
    const player = this.#player;
    const combat = this.#combat;
    const ready = player.takePressed(READY);
    const rightPressed = player.takePressed(RIGHT);
    const leftPressed = player.takePressed(LEFT);
    if (!this.#free()) {
      this.#right = undefined;
      this.#left = undefined;
      return;
    }
    const state = combat.combatState(PLAYER_REF);
    const hands = combat.hands(PLAYER_REF);
    if (!state || !hands) return;
    if (ready) {
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
    const bow = hands.right === WeaponType.bow || hands.right === WeaponType.crossbow;
    const leftAttacks = hands.left !== undefined && hands.left <= WeaponType.oneHandMace;
    const fistsOnly = hands.right === undefined && hands.left === undefined && !hands.shield;
    const blocks = !leftAttacks && !fistsOnly;
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
