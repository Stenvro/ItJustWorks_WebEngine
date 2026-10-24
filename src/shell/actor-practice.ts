// The packages' weapon and magic practice on the stage (docs/ai.md, "Packages": UseWeapon,
// UseMagic, Shout; src/ai/procedure-runs.ts): an actor whose package has it shoot at an archery
// butt, swing at a training dummy, cast at a target or shout as the Greybeards do. It goes
// through combat's mechanics (src/shell/actor-combat.ts: the draw, the attack actions, the
// bow's draw and release, the hit with the practice's Do No Damage and Allow Combat Start On
// Hit) and 5.3's casting (src/shell/actor-casting.ts: castAt, shoutAt), not through the combat
// AI: it is no fight.

import { attacking, AttackState, WeaponState } from '../gameplay/combat/combat-state.ts';
import type { MagicCast, ShoutResult, WeaponBarrage } from '../ai/package-runtime.ts';
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
/** An attack its graph refused is asked again this often (seconds: the combat tree's attack idle). */
const ATTACK_RETRY = 0.25;
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
      aimOnly: barrage.aimOnly,
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
      const action = ranged
        ? 'ActionRightAttack'
        : barrage.powerAttack
          ? 'ActionRightPowerAttack'
          : 'ActionRightAttack';
      if (!(await this.#begin(actor, action, ranged))) return false;
      if (ranged) {
        await this.#until(() => state()?.attack === AttackState.bowDrawn);
        await this.#sleep(BOW_HOLD);
        if (barrage.aimOnly) continue;
        await combat.release(actor, 'ActionRightRelease');
      }
      await this.#until(() => {
        const now = state();
        return now === undefined || !attacking(now);
      });
    }
    return true;
  }

  /**
   * An attack begun, asked again every ATTACK_RETRY seconds while its graph refuses it (STEP_LIMIT
   * at most), as the engine's attack actions fail and are tried again: a graph just out of its
   * draw, a release or a turn takes no attack for a moment (Helgen's archers drew at Lokir once
   * each, the attack was refused as their draw blended out, and they shot no arrow). Whether it
   * began (a bow: its arrow on the string; a swing: past its wind-up's first answer).
   */
  async #begin(actor: number, action: string, ranged: boolean): Promise<boolean> {
    const combat = this.#options.combat();
    const until = Date.now() + STEP_LIMIT * 1000;
    while (Date.now() < until) {
      if (await combat.attack(actor, action)) {
        // Refused, its attack ends at the next frame (ActorCombat's unanswered attack); taken,
        // it gets on (an arrow nocked, a swing past its wind-up).
        const seen = { got: false };
        await this.#until(() => {
          const now = combat.combatState(actor);
          seen.got ||=
            now !== undefined &&
            (ranged ? now.arrowNocked : attacking(now) && now.attack !== AttackState.draw);
          return seen.got || now === undefined || !attacking(now);
        }, ATTACK_RETRY * 4);
        if (seen.got) return true;
      }
      await this.#sleep(ATTACK_RETRY);
    }
    return false;
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
   * its head turns, whether or not its voice has recovered; 'shouted' once it was let out,
   * 'waiting' at once while it casts, 'none' when it has no shout.
   */
  async shout(
    actor: number,
    target: number | undefined,
    shout: PackageTarget | undefined,
    turn: boolean,
  ): Promise<ShoutResult> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return 'none';
    if (shout?.type === TargetType.objectId)
      await runtime.equipment.equipSpell(actor, shout.value, CastingSource.voice);
    if ((await runtime.equipment.of(actor)).voice === undefined) return 'none';
    if (target !== undefined) {
      this.#options.session.scriptWorld.lookAt(actor, target, 'procedure');
      if (turn) this.#face(actor, target);
    }
    // The engine's Shout procedure lets the voice skip its cast check: it shouts even while
    // its voice recovers from the last shout (MQ101's Alduin: Storm Call, 60 s, then
    // Unrelenting Force from the tower at once); the shout sets the recovery again.
    if (!(await this.#options.casting().shoutAt(actor, target, undefined, true))) return 'waiting';
    await this.#until(() => !runtime.casting.isShouting(actor), STEP_LIMIT + 4);
    return 'shouted';
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
