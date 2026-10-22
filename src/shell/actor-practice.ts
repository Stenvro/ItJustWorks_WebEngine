// The packages' weapon and magic practice on the stage (docs/ai.md, "Packages": UseWeapon,
// UseMagic, Shout; src/ai/procedure-runs.ts): an actor whose package has it shoot at an archery
// butt, swing at a training dummy, cast at a target or shout as the Greybeards do. It goes
// through combat's mechanics (src/shell/actor-combat.ts: the draw, the attack actions, the
// bow's draw and release, the hit with the practice's Do No Damage and Allow Combat Start On
// Hit) and 5.3's casting (src/shell/actor-casting.ts: castAt, shoutAt), not through the combat
// AI: it is no fight.

import { attacking, AttackState, WeaponState } from '../gameplay/combat/combat-state.ts';
import type { MagicCast, WeaponBarrage } from '../ai/package-runtime.ts';
import { TargetType, type PackageTarget } from '../ai/package-records.ts';
import { CastingSource } from '../scripting/runtime/casting-engine.ts';
import type { Vec3 } from '../render/math.ts';
import { AmmoFlag, WeaponType } from '../world/item-records.ts';
import type { ActorCasting } from './actor-casting.ts';
import type { ActorCombat } from './actor-combat.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { GameSession } from './game-session.ts';

/** How long a step of a practice waits for the graph at most (seconds). */
const STEP_LIMIT = 4;
/** A drawn bow is held this long before it looses (seconds). TODO(M13): the engine's. */
const BOW_HOLD = 0.6;
/**
 * A practice's shot at a target that is no actor goes this high over its placement (units).
 * TODO(M13): the engine aims at the target's bounds; the vanilla archery butts stand on their
 * origin.
 */
const AIM_HEIGHT = 48;

export interface ActorPracticeOptions {
  readonly session: GameSession;
  readonly movers: ActorMovers;
  readonly combat: () => ActorCombat;
  readonly casting: () => ActorCasting;
  /** An item an actor carries that a criterion names (src/shell/actor-ai.ts). */
  readonly carried: (actor: number, criteria: PackageTarget) => Promise<number | undefined>;
}

export class ActorPractice {
  readonly #options: ActorPracticeOptions;

  constructor(options: ActorPracticeOptions) {
    this.#options = options;
  }

  /**
   * One UseWeapon barrage: the weapon taken up (one it carries of the Weapon Type, its ammunition
   * for a bow) and drawn, the actor facing its target, then its attacks: a bow drawn, held and
   * loosed (Aim Only: never loosed), a melee weapon swung (Always Power Attack: power attacks).
   * Whether it could.
   */
  async useWeapon(actor: number, target: number, barrage: WeaponBarrage): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    const combat = this.#options.combat();
    if (!runtime || !combat.combatState(actor)) return false;
    const weapon = barrage.weapon && (await this.#options.carried(actor, barrage.weapon));
    if (weapon !== undefined && (await runtime.equipment.weapon(actor, 'right')) !== weapon) {
      if (combat.weaponState(actor) !== WeaponState.sheathed) {
        await combat.sheathe(actor);
        await this.#until(() => combat.weaponState(actor) === WeaponState.sheathed);
      }
      await runtime.equipment.equip(actor, weapon, { hand: 'right' });
      await this.#ammo(actor, weapon);
    }
    const aimAt = this.#point(target);
    combat.practice(actor, target, {
      aimAt,
      doNoDamage: barrage.doNoDamage,
      alwaysHit: barrage.alwaysHit,
      combatStartOnHit: barrage.combatStartOnHit,
    });
    if (barrage.headtrack) this.#options.session.scriptWorld.lookAt(actor, target, 'procedure');
    this.#face(actor, target);
    // A sheathing (the last practice's end) finishes first; then it draws.
    await this.#until(() => {
      const now = combat.weaponState(actor);
      return now === WeaponState.sheathed || now === WeaponState.drawn;
    });
    if (combat.weaponState(actor) === WeaponState.sheathed) await combat.draw(actor);
    await this.#until(() => combat.weaponState(actor) === WeaponState.drawn);
    const bow = (
      await runtime.equipment.item(weapon ?? (await runtime.equipment.weapon(actor, 'right')) ?? 0)
    )?.weapon?.weaponType;
    const ranged = bow === WeaponType.bow || bow === WeaponType.crossbow;
    for (let i = 0; i < barrage.attacks; i++) {
      this.#face(actor, target);
      const state = (): ReturnType<ActorCombat['combatState']> => combat.combatState(actor);
      if (ranged) {
        if (!(await combat.attack(actor, 'ActionRightAttack'))) return false;
        await this.#until(() => state()?.attack === AttackState.bowDrawn);
        await this.#sleep(BOW_HOLD);
        if (barrage.aimOnly) continue;
        await combat.release(actor, 'ActionRightRelease');
      } else {
        const action = barrage.powerAttack ? 'ActionRightPowerAttack' : 'ActionRightAttack';
        if (!(await combat.attack(actor, action))) return false;
      }
      await this.#until(() => {
        const now = state();
        return now === undefined || !attacking(now);
      });
    }
    return true;
  }

  /**
   * One UseMagic cast: its Spell (the one named; one it knows of the type named; else what its
   * hand holds) at the target, facing it, a concentration spell held its cast time; resolves
   * once the cast is over. Whether it could.
   */
  async useMagic(actor: number, target: number | undefined, cast: MagicCast): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return false;
    const spell = cast.spell && (await this.#spell(actor, cast.spell));
    if (target !== undefined) this.#face(actor, target);
    const began = await this.#options
      .casting()
      .castAt(actor, cast.dual ? 'both' : 'right', target, {
        ...(spell !== undefined && { spell }),
        ...(cast.castTime > 0 && { hold: cast.castTime }),
      });
    if (!began) return false;
    await this.#until(
      () => runtime.casting.casting(actor, CastingSource.right) === undefined,
      cast.castTime + STEP_LIMIT,
    );
    return true;
  }

  /**
   * One shout: its Shout (the one named, into its voice) at the target, facing it unless only
   * its head turns; resolves once it was let out, or at once while its voice recovers (false
   * only when it has no shout).
   */
  async shout(
    actor: number,
    target: number | undefined,
    shout: PackageTarget | undefined,
    turn: boolean,
  ): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return false;
    if (shout?.type === TargetType.objectId)
      await runtime.equipment.equipSpell(actor, shout.value, CastingSource.voice);
    if ((await runtime.equipment.of(actor)).voice === undefined) return false;
    if (target !== undefined) {
      this.#options.session.scriptWorld.lookAt(actor, target, 'procedure');
      if (turn) this.#face(actor, target);
    }
    if (await this.#options.casting().shoutAt(actor, target)) {
      await this.#until(() => !runtime.casting.isShouting(actor), STEP_LIMIT + 4);
    }
    return true;
  }

  /** The practice is over: its weapon or magic away, its target let go. */
  holster(actor: number): void {
    const combat = this.#options.combat();
    combat.practice(actor, undefined, undefined);
    this.#options.session.scriptWorld.lookAt(actor, undefined, 'procedure');
    this.#options.movers.request(actor, undefined);
    void combat.sheathe(actor);
  }

  /** A spell a Spell selector names: that spell, else the first it knows of the type. */
  async #spell(actor: number, criteria: PackageTarget): Promise<number | undefined> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return undefined;
    if (criteria.type === TargetType.objectId) return criteria.value;
    return (await runtime.casting.chooseSpell(actor, 'attack'))?.formId;
  }

  /** Arrows for a bow, bolts for a crossbow: the best it carries. */
  async #ammo(actor: number, weapon: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const equipment = runtime.equipment;
    const type = (await equipment.item(weapon))?.weapon?.weaponType;
    if (type !== WeaponType.bow && type !== WeaponType.crossbow) return;
    let best: { id: number; damage: number } | undefined;
    for (const [form, count] of await runtime.inventory(actor)) {
      if (count <= 0) continue;
      const item = await equipment.item(form);
      if (item?.type !== 'AMMO') continue;
      if ((((item.ammoFlags ?? 0) & AmmoFlag.nonBolt) !== 0) !== (type === WeaponType.bow))
        continue;
      const damage = item.ammoDamage ?? 0;
      if (!best || damage > best.damage) best = { id: form, damage };
    }
    if (best && (await equipment.ammo(actor)) !== best.id) await equipment.equip(actor, best.id);
  }

  /** A target's point to shoot at (an object's: over its placement). */
  #point(target: number): Vec3 | undefined {
    const at = this.#options.session.scriptWorld.livePlacement(target)?.position;
    return at && [at[0], at[1], at[2] + AIM_HEIGHT];
  }

  /** Turns to face a target (the movers turn it, standing). */
  #face(actor: number, target: number): void {
    const world = this.#options.session.scriptWorld;
    const here = world.livePlacement(actor)?.position;
    const there = world.livePlacement(target)?.position;
    if (!here || !there) return;
    const heading = Math.atan2(there[0] - here[0], there[1] - here[1]);
    this.#options.movers.request(actor, { gait: 'walk', face: heading });
  }

  #sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  /** Resolves once a test holds, or after `limit` seconds. */
  #until(test: () => boolean, limit = STEP_LIMIT): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = (): void => {
        if (test() || Date.now() - started > limit * 1000) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }
}
