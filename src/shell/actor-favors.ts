// The followers' favor commands (UESP "Skyrim:Followers", Commands), played through the vanilla
// scripts: "Wait here" and "Follow me" are DialogueFollower's (WaitingForPlayer and its alias
// packages), "Let's trade" its OpenInventory (the container menu in NPC mode); "I need you to do
// something" is its info fragment's Actor.SetDoingFavor(true), after which the engine's command
// mode runs here. As the conversation ends the follower stands and waits for the player's
// command: the HUD shows its command crosshair (SetCrosshairTarget's abFavorMode), which reaches
// fFavorRequestPickDistance; Activate commands the follower at what it rests on:
// - an enemy (or anyone, for a follower without morality): it attacks (StartCombat);
// - an item: it takes it; a container or a corpse: it takes what is in it; a locked door or
//   container: it picks the lock (not one that needs its key); a door: it opens it;
// - furniture: it uses it (sits, sleeps, works at it); an activator, a plant: it activates it;
// - anything else: it goes there and waits (fFavorRequestWaitTimer: TODO(M13) how long the
//   engine keeps it there; here until the player is fFavorRequestRadius away, or comes back).
// It agrees (its Agree line) or refuses: a crime its morality forbids (its MoralRefusal line:
// Morality 3 commits none, 1 only violence against enemies, 2 property crimes too, 0 any), what
// it cannot do (Refuse: a lock that needs its key, no way there). A reference a script
// marked (SetNoFavorAllowed) cannot be commanded. Tab leaves command mode (its ExitFavorState
// line), as do fFavorRequestWaitTimer seconds without a command, its death and the player going
// farther than fFavorRequestRadius from it. Doing the favor clears its favor state
// (IsInFavorState). Notes: docs/ai.md ("Followers, mounts and vehicles").

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { Vec3 } from '../render/math.ts';
import type { ActorAi } from './actor-ai.ts';
import type { ActorFurniture, FurnitureUser } from './actor-furniture.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { StagedActor } from './actor-stage.ts';
import type { ActorTalk } from './actor-talk.ts';
import type { GameSession } from './game-session.ts';
import type { Activatable, FavorPicker } from './play-session.ts';
import type { PlayerView } from './race-menu.ts';
import type { Terminal } from './terminal.ts';

/** The engine's settings (Skyrim.esm's values when the load order has none). */
const DEFAULTS = { pick: 2100, radius: 4000, wait: 40 };

/** Morality (the actor value): 0 any crime, 1 violence against enemies, 2 property crime only, 3 none. */
const Morality = { anyCrime: 0, enemiesOnly: 1, propertyCrime: 2, noCrime: 3 } as const;

/** Lock levels beyond this need their key (XLOC 255). */
const KEY_ONLY = 100;
/** A follower stands this near what it takes or opens (units). */
const REACH = 96;
/** ... and this near a place it is sent to. */
const ARRIVE = 48;

/** The base types a follower takes. */
const ITEMS = new Set([
  'WEAP',
  'ARMO',
  'MISC',
  'ALCH',
  'BOOK',
  'INGR',
  'AMMO',
  'KEYM',
  'SLGM',
  'SCRL',
  'LIGH',
]);

/** What a command is. */
export type FavorKind = 'attack' | 'take' | 'loot' | 'open' | 'use' | 'activate' | 'move';

/** The command a base type and an actor's state make. */
export function favorKind(
  baseType: string | undefined,
  options: { readonly actor: boolean; readonly dead: boolean },
): FavorKind {
  if (options.actor) return options.dead ? 'loot' : 'attack';
  if (baseType === undefined) return 'move';
  if (ITEMS.has(baseType)) return 'take';
  if (baseType === 'CONT') return 'loot';
  if (baseType === 'DOOR') return 'open';
  if (baseType === 'FURN') return 'use';
  if (baseType === 'ACTI' || baseType === 'FLOR' || baseType === 'TREE') return 'activate';
  return 'move';
}

/**
 * Whether a follower's morality lets it do a command: violence on one not hostile is any crime
 * (Morality 0 only), taking what is owned a property crime (Morality 0 and 2).
 */
export function moralityAllows(
  morality: number,
  crime: 'violence' | 'property' | undefined,
): boolean {
  if (crime === undefined) return true;
  if (crime === 'violence') return morality <= Morality.anyCrime;
  return morality === Morality.anyCrime || morality === Morality.propertyCrime;
}

export interface ActorFavorsOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  readonly ai: ActorAi;
  readonly movers: ActorMovers;
  readonly furniture: ActorFurniture;
  readonly talk: ActorTalk;
  readonly actors: () => Iterable<StagedActor>;
  readonly get: (reference: number) => StagedActor | undefined;
  readonly userOf: (staged: StagedActor) => FurnitureUser;
  readonly player?: () => PlayerView | undefined;
}

/** The follower waiting for a command, since when (seconds of play). */
interface Commanding {
  readonly actor: number;
  waited: number;
}

/** A follower doing a command: where it waits after a move. */
interface Doing {
  readonly actor: number;
  /** Sent somewhere to wait: until the player is far from there. */
  waitAt?: Vec3;
}

export class ActorFavors {
  readonly #options: ActorFavorsOptions;
  #commanding: Commanding | undefined;
  readonly #doing = new Map<number, Doing>();
  #settings = DEFAULTS;
  /** The prompts' verbs (sAttack, sTake, ...), once the settings are read. */
  #texts: ((name: string) => string) | undefined;

  constructor(options: ActorFavorsOptions) {
    this.#options = options;
    void options.session.settings().then((settings) => {
      this.#settings = {
        pick: settings.number('fFavorRequestPickDistance') ?? DEFAULTS.pick,
        radius: settings.number('fFavorRequestRadius') ?? DEFAULTS.radius,
        wait: settings.number('fFavorRequestWaitTimer') ?? DEFAULTS.wait,
      };
      this.#texts = (name) => settings.string(name) ?? '';
    });
  }

  /** The follower waiting for a command, if any. */
  get commanding(): number | undefined {
    return this.#commanding?.actor;
  }

  /** Every frame (real seconds). */
  frame(seconds: number): void {
    const runtime = this.#options.session.scriptsReady;
    const view = this.#options.player?.();
    if (!runtime || !view) {
      this.#end(false);
      return;
    }
    const commanding = this.#commanding;
    if (commanding) {
      const staged = this.#options.get(commanding.actor);
      const state = runtime.state.actors.get(commanding.actor);
      commanding.waited += seconds;
      const far =
        staged !== undefined &&
        distance(staged.position, view.play.player.feet) > this.#settings.radius;
      // A script took its favor state, it died or left, the player went far or waited too long.
      if (
        !staged ||
        staged.dead ||
        state?.doingFavor !== true ||
        far ||
        commanding.waited > this.#settings.wait
      ) {
        this.#end(staged !== undefined && !staged.dead && state?.doingFavor === true);
      }
    } else if (runtime.dialogueSpeaker === undefined && !runtime.inMenuMode) {
      // The conversation that asked for a favor has ended: the follower waits for the command.
      for (const staged of this.#options.actors()) {
        if (staged.dead || runtime.state.actors.get(staged.reference)?.doingFavor !== true)
          continue;
        if (this.#doing.has(staged.reference)) continue;
        this.#begin(staged, view);
        break;
      }
    }
    // Followers sent somewhere wait there until the player is far from them.
    for (const doing of this.#doing.values()) {
      if (!doing.waitAt) continue;
      const staged = this.#options.get(doing.actor);
      if (
        !staged ||
        staged.dead ||
        runtime.dialogueSpeaker === doing.actor ||
        distance(staged.position, view.play.player.feet) > this.#settings.radius
      ) {
        this.#release(doing.actor);
      }
    }
  }

  /** Command mode begins: the follower stands, the crosshair commands. */
  #begin(staged: StagedActor, view: PlayerView): void {
    const { ai, movers, session } = this.#options;
    this.#commanding = { actor: staged.reference, waited: 0 };
    ai.hold(staged.reference, true);
    movers.stop(staged.reference);
    const picker: FavorPicker = {
      reach: this.#settings.pick,
      target: (reference, point) => this.#target(staged.reference, reference, point),
    };
    view.play.favorMode = picker;
    // The first time: its tutorial (Help - Teammate Favor).
    session.hud.menus?.tutorial?.('HBFT');
    session.hud.favors = {
      cancel: () => {
        if (!this.#commanding) return false;
        this.#end(true);
        return true;
      },
    };
  }

  /**
   * Command mode ends without a command (`said`: the follower says its ExitFavorState line):
   * its favor state goes and it follows again.
   */
  #end(said: boolean): void {
    const commanding = this.#commanding;
    if (!commanding) return;
    this.#commanding = undefined;
    const { session, ai, talk } = this.#options;
    const view = this.#options.player?.();
    if (view) view.play.favorMode = undefined;
    session.hud.favors = undefined;
    const runtime = session.scriptsReady;
    const state = runtime?.state.actors.get(commanding.actor);
    if (state) state.doingFavor = false;
    if (said) void talk.say(commanding.actor, 'FEXT');
    if (!this.#doing.has(commanding.actor)) ai.hold(commanding.actor, false);
  }

  /** The follower is its packages' again. */
  #release(actor: number): void {
    this.#doing.delete(actor);
    if (this.#commanding?.actor !== actor) this.#options.ai.hold(actor, false);
  }

  /** What the crosshair commands at a reference or a point (undefined: nothing). */
  #target(
    follower: number,
    reference: number | undefined,
    point: Vec3 | undefined,
  ): Activatable | undefined {
    const runtime = this.#options.session.scriptsReady;
    const text = this.#texts ?? ((name: string) => name);
    if (!runtime) return undefined;
    if (reference === follower || reference === PLAYER_REF) return undefined;
    if (reference !== undefined && runtime.state.references.get(reference)?.noFavor === true)
      return undefined;
    const staged = reference === undefined ? undefined : this.#options.get(reference);
    const kind = favorKind(reference === undefined ? undefined : this.#baseType(reference), {
      actor: staged !== undefined,
      dead: staged?.dead === true,
    });
    if (kind === 'move') {
      if (!point) return undefined;
      return {
        verb: '',
        name: '',
        activate: () => {
          this.#command(follower, 'move', undefined, point);
        },
      };
    }
    if (reference === undefined) return undefined;
    const name = staged ? staged.placed.look.name : this.#name(reference);
    const verbs: Record<Exclude<FavorKind, 'move'>, string> = {
      attack: text('sAttack'),
      take: text('sTake'),
      loot: text(staged ? 'sSearch' : 'sOpen'),
      open: text('sOpen'),
      use: text('sUse'),
      activate: text('sActivate'),
    };
    return {
      verb: verbs[kind],
      name,
      reference,
      activate: () => {
        this.#command(follower, kind, reference, point);
      },
    };
  }

  /**
   * A reference's base type, as far as it is known now: read once (for the next frames'
   * prompts), undefined until then.
   */
  #baseType(reference: number): string | undefined {
    if (!this.#types.has(reference)) this.#readType(reference);
    return this.#types.get(reference);
  }

  readonly #types = new Map<number, string | undefined>();
  readonly #names = new Map<number, string>();

  /** Reads a reference's base type and name. */
  #readType(reference: number): void {
    this.#types.set(reference, undefined);
    const runtime = this.#options.session.scriptsReady;
    void (async () => {
      const base = runtime ? await runtime.baseOf(reference) : undefined;
      const record = base === undefined ? undefined : await runtime?.forms.record(base);
      this.#types.set(reference, record?.type ?? 'NONE');
      this.#names.set(reference, record?.text('FULL') ?? '');
    })();
  }

  #name(reference: number): string {
    return this.#names.get(reference) ?? '';
  }

  /** The player commanded: command mode ends and the follower does it (or refuses). */
  #command(
    follower: number,
    kind: FavorKind,
    target: number | undefined,
    point: Vec3 | undefined,
  ): void {
    if (this.#commanding?.actor !== follower) return;
    this.#doing.set(follower, { actor: follower });
    this.#end(false);
    // It stays held while it does the favor.
    this.#options.ai.hold(follower, true);
    void this.#do(follower, kind, target, point)
      .catch((error: unknown) => {
        this.#options.terminal.log(
          'ai',
          `a favor: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
        return false;
      })
      .then((waiting) => {
        if (!waiting) this.#release(follower);
      });
  }

  /** Does a command; true if the follower now waits where it was sent. */
  async #do(
    follower: number,
    kind: FavorKind,
    target: number | undefined,
    point: Vec3 | undefined,
  ): Promise<boolean> {
    const { session, movers, talk, furniture } = this.#options;
    const runtime = session.scriptsReady;
    const staged = this.#options.get(follower);
    if (!runtime || !staged) return false;
    const morality = (await runtime.actors.value(follower, ActorValue.morality)).current;
    // Its crime, if the command is one: violence on one not hostile to it, what is owned.
    let crime: 'violence' | 'property' | undefined;
    if (kind === 'attack' && target !== undefined) {
      const enemy =
        runtime.world.hostile?.(follower, target) === true ||
        runtime.world.hostile?.(target, PLAYER_REF) === true ||
        (await runtime.crime.reaction(target, PLAYER_REF)) === 'hostile';
      if (!enemy) crime = 'violence';
    } else if ((kind === 'take' || kind === 'loot') && target !== undefined) {
      if (!(await runtime.mayUse(PLAYER_REF, target))) crime = 'property';
    }
    if (!moralityAllows(morality, crime)) {
      void talk.say(follower, 'MREF');
      return false;
    }
    const lock = target === undefined ? undefined : await runtime.lock(target);
    if ((kind === 'open' || kind === 'loot') && lock?.locked && lock.level > KEY_ONLY) {
      void talk.say(follower, 'REFU');
      return false;
    }
    void talk.say(follower, 'AGRE');
    if (kind === 'attack' && target !== undefined) {
      runtime.world.startCombat?.(follower, target);
      return false;
    }
    if (kind === 'use' && target !== undefined) {
      const user = this.#options.userOf(staged);
      await furniture.use(
        user,
        target,
        (to, arrive) => movers.travel(follower, to, 'run', arrive),
        (heading) => {
          movers.request(
            follower,
            heading === undefined ? undefined : { gait: 'walk', face: heading },
          );
        },
        { activates: true },
      );
      return false;
    }
    const at =
      target === undefined ? point : ((await runtime.placement(target))?.position ?? point);
    if (!at) return false;
    const arrived = await movers.travel(follower, [...at], 'run', kind === 'move' ? ARRIVE : REACH);
    if (!arrived) {
      void talk.say(follower, 'REFU');
      return false;
    }
    if (kind === 'move') {
      const doing = this.#doing.get(follower);
      if (doing) doing.waitAt = [...at];
      return doing !== undefined;
    }
    if (target === undefined) return false;
    // A lock in its way is picked (an owned one where it is seen is the player's trespass).
    if (lock?.locked && (kind === 'open' || kind === 'loot')) {
      await runtime.setLocked(target, false);
      if (!(await runtime.mayUse(PLAYER_REF, target)))
        await runtime.crime.lockPicked(follower, target);
    }
    if (kind === 'take') await runtime.pickUp(target, follower);
    else if (kind === 'loot') await runtime.removeAllItems(target, follower);
    else await runtime.activate(target, follower, false);
    return false;
  }
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(
    (a[0] ?? 0) - (b[0] ?? 0),
    (a[1] ?? 0) - (b[1] ?? 0),
    (a[2] ?? 0) - (b[2] ?? 0),
  );
}
