// The player's casting (docs/gameplay.md, "Casting and shouts"): with magic drawn (the combat
// mechanics' draw state: Ready Weapon, or an attack button with it away: src/shell/
// player-combat.ts), an attack button whose hand holds a spell, a staff or a scroll is this
// casting's (player-combat hands it over: CastingButtons) — held to charge and released to fire,
// held for a concentration spell — and both pressed at once with one spell in both hands dual
// cast it. The voice key (Shout, Z) tapped shouts a shout's first word, held its others
// (fShoutTime1 / 2), or casts the power in the voice. The casts go to the actors' casting
// (src/shell/actor-casting.ts), aimed along the camera. Telekinesis held takes hold of the
// loose object it is aimed at and throws it as it is let go (PlaySession.telekinesis).

import { CastingSource } from '../scripting/runtime/casting-engine.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { EffectArchetype } from '../world/magic-effects.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorCasting } from './actor-casting.ts';
import type { GameSession } from './game-session.ts';
import type { CastingButtons } from './player-combat.ts';
import type { PlayerView } from './race-menu.ts';

export interface PlayerCastingOptions {
  readonly session: GameSession;
  readonly casting: ActorCasting;
  readonly player: () => PlayerView | undefined;
}

/** Both attack buttons pressed within this dual cast (seconds; TODO(M13): the engine's window). */
const DUAL_WINDOW = 0.15;

/** The attack buttons by casting source. */
const BUTTONS: Readonly<Record<number, string>> = {
  [CastingSource.left]: 'Left Attack/Block',
  [CastingSource.right]: 'Right Attack/Block',
};

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
  /** Each item's Telekinesis magnitude (null: none), as read. */
  readonly #telekinesis = new Map<number, number | null>();
  /** fMagicTelekinesisBaseDistance and fMagicTelekinesisDistanceMin, once read. */
  #telekinesisReach: { base: number; nearest: number } | undefined;

  constructor(options: PlayerCastingOptions) {
    this.#options = options;
    options.casting.playerAim = () => options.player()?.play.forward ?? [0, 1, 0];
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
    // Telekinesis held (its concentration cast past its charge): its reach to the play.
    view.play.telekinesis(this.#telekinesisNow(runtime), this.#telekinesisReach?.nearest ?? 64);
  }

  /**
   * The reach of a Telekinesis cast the player holds now (fMagicTelekinesisBaseDistance × its
   * magnitude), or undefined.
   */
  #telekinesisNow(runtime: ScriptRuntime): number | undefined {
    if (!this.#telekinesisReach) {
      this.#telekinesisReach = { base: 2100, nearest: 64 };
      const reach = this.#telekinesisReach;
      void Promise.all([
        runtime.gameSetting('fMagicTelekinesisBaseDistance'),
        runtime.gameSetting('fMagicTelekinesisDistanceMin'),
      ]).then(([base, nearest]) => {
        if (typeof base === 'number') reach.base = base;
        if (typeof nearest === 'number') reach.nearest = nearest;
      });
    }
    for (const source of [CastingSource.left, CastingSource.right]) {
      const cast = runtime.casting.casting(PLAYER_REF, source);
      if (cast?.hand.phase !== 'casting') continue;
      const item = cast.castable.item;
      const magnitude = this.#telekinesis.get(item.formId);
      if (magnitude === undefined) {
        this.#telekinesis.set(item.formId, null);
        void (async () => {
          for (const entry of item.effects) {
            const effect = await runtime.magic.effect(entry.effect);
            if (effect?.archetype === EffectArchetype.telekinesis) {
              this.#telekinesis.set(item.formId, Math.max(1, entry.magnitude));
              return;
            }
          }
        })();
        continue;
      }
      if (magnitude !== null) return this.#telekinesisReach.base * magnitude;
    }
    return undefined;
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
    if (partner && Math.abs(partner.since - entry.since) <= DUAL_WINDOW) {
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
