// What a running package's flags do to an actor's gear (docs/ai.md, "Packages"): Weapon Drawn
// keeps its weapon out while the package runs, Weapons Unequipped takes the weapons from its
// hands (sleeping, eating guards) and does not give them back as the flag goes: the actor's
// combat takes a weapon up when it fights. Observed in the original: Helgen's first prisoner,
// whose cart package (MQ101StayInCart) has the flag, keeps the battleaxe he carries in his pack
// from the cart to the block, under packages without it. Wear Sleep Outfit dresses it in its
// sleep outfit (NPC_ SOFT). The flags are the package's as its running procedure's override
// leaves them (src/ai/package-runtime.ts packageFlags: a Wait, a Guard, a Patrol, a Sandbox that
// draws). Creation Kit and CommonLibSSE (PACKAGE_DATA::GeneralFlag) name them; what each does is
// the flag's name. TODO(M13): the engine's own timing (when in the package's start it draws or
// undresses) is not read yet, nor whether a reload of the actor's 3D takes its weapons up again.

import { PackageFlag } from '../ai/package-records.ts';
import { WeaponState } from '../gameplay/combat/combat-state.ts';
import type { Hand } from '../gameplay/equipment.ts';
import type { ActorAi } from './actor-ai.ts';
import type { ActorCombat } from './actor-combat.ts';
import type { GameSession } from './game-session.ts';

/** A draw its graph did not take is asked again this often (seconds). */
const DRAW_AGAIN = 1;
const HANDS: readonly Hand[] = ['right', 'left'];

export interface PackageGearOptions {
  readonly session: GameSession;
  readonly ai: () => ActorAi;
  readonly combat: () => ActorCombat;
}

interface Gear {
  /** Its package drew its weapon (Weapon Drawn): sheathed again as the flag goes. */
  drawn: boolean;
  /** The next time a draw is asked for (seconds of the gear's clock). */
  drawAt: number;
  /** Weapons Unequipped took the weapons from its hands for the package running now. */
  unarmed: boolean;
  /** Its sleep outfit is on (Wear Sleep Outfit). */
  asleep: boolean;
  /** A change of its equipment is under way (no other begins meanwhile). */
  busy: boolean;
}

export class ActorPackageGear {
  readonly #options: PackageGearOptions;
  readonly #gear = new Map<number, Gear>();
  #clock = 0;

  constructor(options: PackageGearOptions) {
    this.#options = options;
  }

  /** Every frame (real seconds), for the actors whose AI runs. */
  frame(actors: Iterable<number>, seconds: number): void {
    this.#clock += seconds;
    const ai = this.#options.ai();
    const combat = this.#options.combat();
    const seen = new Set<number>();
    for (const actor of actors) {
      seen.add(actor);
      // Fighting, its combat has its weapons (it takes them up from its inventory).
      const engaged = combat.engaged(actor);
      const flags = engaged ? 0 : (ai.current(actor)?.flags ?? 0);
      let gear = this.#gear.get(actor);
      if (!gear) {
        if (flags === 0) continue;
        gear = { drawn: false, drawAt: 0, unarmed: false, asleep: false, busy: false };
        this.#gear.set(actor, gear);
      }
      this.#weaponDrawn(actor, gear, (flags & PackageFlag.weaponDrawn) !== 0, engaged, combat);
      if (gear.busy) continue;
      const unequipped = (flags & PackageFlag.weaponsUnequipped) !== 0;
      if (unequipped !== gear.unarmed) {
        // Its weapons are taken off as the flag comes; as it goes, nothing is given back.
        gear.unarmed = unequipped;
        if (unequipped) this.#change(gear, this.#unarm(actor));
      } else if (((flags & PackageFlag.wearSleepOutfit) !== 0) !== gear.asleep) {
        gear.asleep = !gear.asleep;
        const runtime = this.#options.session.scriptsReady;
        if (runtime) this.#change(gear, runtime.equipment.sleep(actor, gear.asleep));
      }
    }
    for (const [actor, gear] of this.#gear) {
      if (!seen.has(actor) && !gear.busy) this.#gear.delete(actor);
    }
  }

  /** Weapon Drawn: drawn while the flag holds (asked again if its graph did not take it). */
  #weaponDrawn(
    actor: number,
    gear: Gear,
    wanted: boolean,
    engaged: boolean,
    combat: ActorCombat,
  ): void {
    if (engaged) return;
    const state = combat.weaponState(actor);
    if (wanted) {
      gear.drawn = true;
      if (state === WeaponState.sheathed && this.#clock >= gear.drawAt) {
        gear.drawAt = this.#clock + DRAW_AGAIN;
        void combat.draw(actor);
      }
    } else if (gear.drawn) {
      gear.drawn = false;
      void combat.sheathe(actor);
    }
  }

  #change(gear: Gear, work: Promise<unknown>): void {
    gear.busy = true;
    void work
      .catch(() => undefined)
      .finally(() => {
        gear.busy = false;
      });
  }

  /** Weapons Unequipped: the weapons in its hands taken off (they stay in its inventory). */
  async #unarm(actor: number): Promise<void> {
    const equipment = this.#options.session.scriptsReady?.equipment;
    if (!equipment) return;
    for (const hand of HANDS) {
      const weapon = await equipment.weapon(actor, hand);
      if (weapon !== undefined) await equipment.unequip(actor, weapon, { hand });
    }
  }
}
