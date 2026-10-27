// The player's casting (docs/gameplay.md, "Casting and shouts"): with magic drawn (the combat
// mechanics' draw state: Ready Weapon, or an attack button with it away: src/shell/
// player-combat.ts), an attack button whose hand holds a spell, a staff or a scroll is this
// casting's (player-combat hands it over: CastingButtons) — held to charge and released to fire,
// held for a concentration spell — and both pressed at once with one spell in both hands dual
// cast it. The voice key (Shout, Z) tapped shouts a shout's first word, held its others
// (fShoutTime1 / 2), or casts the power in the voice. The casts go to the actors' casting
// (src/shell/actor-casting.ts), aimed from the hand along the view and turned by the aim
// assistance toward what the crosshair is on (src/shell/projectile-aim.ts).

import {
  TELEKINESIS_DEFAULTS,
  TELEKINESIS_SETTING_NAMES,
  telekinesisDamage,
  telekinesisDamageMult,
  telekinesisReach,
  type TelekinesisSettings,
} from '../gameplay/magic/telekinesis.ts';
import { pathHitsActor } from '../gameplay/magic/projectile-flight.ts';
import { EntryPoint } from '../gameplay/perk-entry-points.ts';
import type { Vec3 } from '../render/math.ts';
import { CastingSource } from '../scripting/runtime/casting-engine.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ActorValue } from '../world/actor-values.ts';
import { EffectArchetype } from '../world/magic-effects.ts';
import type { ActorCasting } from './actor-casting.ts';
import type { GameSession } from './game-session.ts';
import type { CastingButtons } from './player-combat.ts';
import type { PlayerView } from './race-menu.ts';

export interface PlayerCastingOptions {
  readonly session: GameSession;
  readonly casting: ActorCasting;
  readonly player: () => PlayerView | undefined;
  /** An object Telekinesis threw struck an actor (it is attacked by the player). */
  readonly struck?: (target: number) => void;
}

/** The attack buttons by casting source. */
const BUTTONS: Readonly<Record<number, string>> = {
  [CastingSource.left]: 'Left Attack/Block',
  [CastingSource.right]: 'Right Attack/Block',
};

/** How wide a thrown object meets an actor (units; TODO(M13): its own collision's size). */
const THROWN_RADIUS = 16;

export class PlayerCasting implements CastingButtons {
  readonly #options: PlayerCastingOptions;
  /** Each button pressed for casting: when it went down (the clock), and whether it casts. */
  readonly #held = new Map<number, { since: number; casting: boolean }>();
  /** What the hands hold to cast, as last read (the equip system answers asynchronously). */
  readonly #castable = new Set<number>();
  #reading = false;
  /** The voice key went down then, if held. */
  #voiceSince: number | undefined;
  #clock = 0;

  constructor(options: PlayerCastingOptions) {
    this.#options = options;
  }

  /** Whether a hand holds something to cast (a spell, a staff, a scroll). */
  casts(source: number): boolean {
    return this.#castable.has(source);
  }

  /** A hand's button went down with the magic drawn (the combat mechanics hand it over). */
  press(source: number): void {
    if (this.#held.has(source)) return;
    const entry = { since: this.#clock, casting: false };
    this.#held.set(source, entry);
    void this.#press(source, entry);
  }

  /** Every frame: what the hands hold, the buttons let go, and the voice key. */
  frame(seconds: number): void {
    this.#clock += Math.max(0, seconds);
    const { session, casting } = this.#options;
    const view = this.#options.player();
    const runtime = session.scriptsReady;
    if (!view?.avatar || !runtime) return;
    this.#readHands();
    const player = view.play.player;
    // In a menu, with fighting disabled (DisablePlayerControls) or dead, nothing is cast.
    if (session.menuMode || !runtime.controls.fighting || view.play.dead || view.play.knocked) {
      this.clear();
      return;
    }
    // A button let go releases its hand's cast.
    for (const [source, entry] of [...this.#held]) {
      if (player.isHeld(BUTTONS[source] ?? '')) continue;
      this.#held.delete(source);
      if (entry.casting) void casting.letGo(PLAYER_REF, source);
    }
    // The voice: a shout's words by the time the key is held; a power.
    const voice = player.isHeld('Shout');
    if (voice && this.#voiceSince === undefined) {
      this.#voiceSince = this.#clock;
      void casting.voiceDown();
    } else if (!voice && this.#voiceSince !== undefined) {
      const held = this.#clock - this.#voiceSince;
      this.#voiceSince = undefined;
      void casting.voiceUp(held);
    }
    casting.powersFrame();
    // Telekinesis held: the object aimed at is taken hold of and pulled; let go, thrown.
    const telekinetic = this.#telekinetic(runtime);
    if (telekinetic !== undefined) this.#dualTelekinesis = telekinetic.dual;
    if (telekinetic && !this.#wasTelekinetic) this.#readTelekinesis(runtime);
    this.#wasTelekinetic = telekinetic !== undefined;
    view.play.telekinesis(
      telekinetic !== undefined,
      this.#telekinesisReach,
      seconds,
      this.#dualTelekinesis,
      this.#telekinesisSettings,
    );
    const thrown = view.play.telekinesisThrown;
    if (thrown) void this.#strike(runtime, thrown);
  }

  /**
   * An object Telekinesis threw strikes the first living actor its path meets (not the player):
   * it is hurt by telekinesisDamage (the collision's own damage: none at vanilla speeds,
   * src/gameplay/physics-damage.ts), the player's Mod Telekinesis Damage Mult and Mod Telekinesis
   * Damage perks on it, and attacked by the player (OnHit, a hostile's reaction).
   */
  async #strike(
    runtime: ScriptRuntime,
    thrown: {
      readonly from: Vec3;
      readonly to: Vec3;
      readonly dual: boolean;
      readonly strike: () => void;
    },
  ): Promise<void> {
    let best: { reference: number; t: number } | undefined;
    for (const reference of runtime.world.loadedReferences?.() ?? []) {
      if (reference === PLAYER_REF) continue;
      const feet = runtime.world.livePlacement?.(reference)?.position;
      if (!feet) continue;
      const shape = { feet: [feet[0], feet[1], feet[2]] as Vec3, height: 128, radius: 24 };
      const t = pathHitsActor(thrown.from, thrown.to, THROWN_RADIUS, shape);
      if (t !== undefined && (!best || t < best.t)) best = { reference, t };
    }
    if (!best) return;
    const target = best.reference;
    if (!(await runtime.actors.isActor(target)) || (await runtime.actors.isDead(target))) return;
    thrown.strike();
    const settings = this.#telekinesisSettings;
    const mult = await runtime.perks.apply(
      EntryPoint.modTelekinesisDamageMult,
      PLAYER_REF,
      telekinesisDamageMult(thrown.dual, settings),
      [target],
    );
    const damage = await runtime.perks.apply(
      EntryPoint.modTelekinesisDamage,
      PLAYER_REF,
      telekinesisDamage(0, mult, settings),
      [target],
    );
    if (damage > 0) await runtime.actors.damage(target, ActorValue.health, damage, PLAYER_REF);
    this.#options.struck?.(target);
  }

  /** Spells whose costliest effect is Telekinesis, as read (asynchronously). */
  readonly #telekinesis = new Map<number, boolean>();
  /** Telekinesis's settings and reach (units), as last read (as its cast begins). */
  #telekinesisSettings: TelekinesisSettings = TELEKINESIS_DEFAULTS;
  #telekinesisReach = telekinesisReach(TELEKINESIS_DEFAULTS.baseDistance);
  #wasTelekinetic = false;
  /** The last telekinesis cast was dual cast (its throw). */
  #dualTelekinesis = false;

  /** Whether a hand casts Telekinesis now (charged and held): that cast. */
  #telekinetic(runtime: ScriptRuntime): { readonly dual: boolean } | undefined {
    for (const source of [CastingSource.left, CastingSource.right]) {
      const cast = runtime.casting.casting(PLAYER_REF, source);
      if (cast?.hand.phase !== 'casting') continue;
      const item = cast.castable.item;
      const known = this.#telekinesis.get(item.formId);
      if (known === undefined) {
        this.#telekinesis.set(item.formId, false);
        void runtime.casting.mainEffect(item).then((main) => {
          this.#telekinesis.set(item.formId, main?.archetype === EffectArchetype.telekinesis);
        });
      } else if (known) return { dual: cast.dual };
    }
    return undefined;
  }

  /**
   * Telekinesis's settings (GMSTs) and the player's reach: fMagicTelekinesisBaseDistance feet
   * through their perks (Mod Telekinesis Distance) in units.
   */
  #readTelekinesis(runtime: ScriptRuntime): void {
    void (async () => {
      const settings: Record<string, number> = {};
      for (const [key, name] of Object.entries(TELEKINESIS_SETTING_NAMES)) {
        const value = await runtime.gameSetting(name);
        settings[key] =
          typeof value === 'number'
            ? value
            : TELEKINESIS_DEFAULTS[key as keyof TelekinesisSettings];
      }
      const read = { ...TELEKINESIS_DEFAULTS, ...settings };
      const feet = await runtime.perks.apply(
        EntryPoint.modTelekinesisDistance,
        PLAYER_REF,
        read.baseDistance,
      );
      this.#telekinesisSettings = read;
      this.#telekinesisReach = telekinesisReach(feet, read);
    })();
  }

  /** What the hands hold to cast, read again (once at a time). */
  #readHands(): void {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime || this.#reading) return;
    this.#reading = true;
    void Promise.all(
      [CastingSource.left, CastingSource.right].map(async (source) => {
        const castable = await runtime.casting.castable(PLAYER_REF, source);
        if (castable) this.#castable.add(source);
        else this.#castable.delete(source);
      }),
    ).finally(() => {
      this.#reading = false;
    });
  }

  /** A button went down: its hand casts (both hands' one spell: dual cast). */
  async #press(source: number, entry: { since: number; casting: boolean }): Promise<void> {
    const { session, casting } = this.#options;
    const runtime = session.scriptsReady;
    if (!runtime) return;
    const castable = await runtime.casting.castable(PLAYER_REF, source);
    if (!castable) return;
    // The other hand's button pressed at the same moment, with the same spell: a dual cast.
    const other = source === CastingSource.left ? CastingSource.right : CastingSource.left;
    const partner = this.#held.get(other);
    // Within [Controls] fDualCastChordTime of each other (the engine's input chord).
    const chord = session.ini.number('Controls', 'fDualCastChordTime');
    if (partner && Math.abs(partner.since - entry.since) <= chord) {
      const theirs = await runtime.casting.castable(PLAYER_REF, other);
      // Only with the Dual Casting perk of the spell's school (Can Dual Cast Spell); without
      // it each hand casts on its own.
      if (
        theirs?.via === 'spell' &&
        theirs.item.formId === castable.item.formId &&
        (await runtime.casting.canDualCast(PLAYER_REF, castable.item.formId))
      ) {
        if (partner.casting) runtime.casting.interrupt(PLAYER_REF, other);
        partner.casting = false;
        const dual = await casting.start(PLAYER_REF, CastingSource.right, { dual: true });
        // The dual cast is the right hand's: the right button let go releases it.
        const right = source === CastingSource.right ? entry : partner;
        right.casting = dual;
        if (source === CastingSource.left) entry.casting = false;
        return;
      }
    }
    entry.casting = await casting.start(PLAYER_REF, source);
    // Let go meanwhile: it goes (or is let go, not ready) at once.
    if (entry.casting && this.#held.get(source) !== entry) void casting.letGo(PLAYER_REF, source);
  }

  /** The play ended, or a menu opened: casts stop. */
  clear(): void {
    const casting = this.#options.casting;
    for (const [source, entry] of this.#held)
      if (entry.casting) void casting.letGo(PLAYER_REF, source);
    this.#held.clear();
    this.#voiceSince = undefined;
  }
}
