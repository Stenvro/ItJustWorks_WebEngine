// Crime on the stage (docs/gameplay.md, "Crime and factions"; the rules and the bookkeeping:
// src/gameplay/crime.ts, src/scripting/runtime/crime-engine.ts): a crime's witnesses are those
// that detect the criminal (detection's witness hook); each says its line (Steal, Assault,
// Murder, Trespass and their NC lines for those that do not fight, PickpocketCombat,
// WereTransformCrime) and raises an alarm that those near hear (src/shell/actor-senses.ts
// alarm). Guards that learn of a crime, or see a wanted player, are given the engine's Alarm
// package (src/ai/engine-packages.ts alarmPackage) aimed at the criminal: they run up to it,
// calling after it (PursueIdleTopic), and arrest the player, force-greeting with
// DialogueCrimeGuards' lines, whose scripts take the fine, send the player to jail or have them
// resist; or they attack (the combat AI, docs/m10-plan.md 5.2, takes them from
// world.startCombat and the crime engine's reaction). A trespasser is warned by those who
// see them (the Trespass lines, iGuardWarnings), then reported. Leaving the jail unserved is an
// escape.

import { aiSettingsOf } from '../ai/ai-settings.ts';
import { alarmPackage, fleeFrom, StealWarnings, warnThief } from '../ai/engine-packages.ts';
import type { EngineRunner } from '../ai/package-runtime.ts';
import {
  CrimeType,
  guardAnswers,
  TrespassWarnings,
  type CrimeSettings,
} from '../gameplay/crime.ts';
import type { CrimeAct, CrimeEvent } from '../scripting/runtime/crime-engine.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Vec3 } from '../render/math.ts';
import type { ActorAi } from './actor-ai.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { ActorSenses } from './actor-senses.ts';
import type { StagedActor } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';

export interface ActorCrimeOptions {
  readonly session: GameSession;
  readonly senses: ActorSenses;
  readonly movers: ActorMovers;
  readonly ai: ActorAi;
  readonly actors: () => Iterable<StagedActor>;
  readonly get: (reference: number) => StagedActor | undefined;
  /** An actor says a line of a topic subtype (src/shell/actor-talk.ts bark). */
  readonly bark: (actor: number, subtype: string, target: number | undefined) => Promise<boolean>;
  /** Whether an actor fights now (one in combat warns no thief). */
  readonly engaged?: (actor: number) => boolean;
}

/** Guards look for the wanted player this often (seconds). */
const GUARD_SECONDS = 1;
/** A guard asked again what to do about the player after this long (seconds). */
const RESPONSE_SECONDS = 2;
/** A guard gives up arresting (the player away or the talk refused) and may try again after. */
const ARREST_AGAIN_SECONDS = 15;
/** A guard force-greets from this near (units) where fAIMinGreetingDistance is not read. */
const ARREST_REACH = 150;
/** A guard gives up a chase farther than this (units). TODO(M13): the engine's distance. */
const ARREST_GIVE_UP = 4096;
/** Crimes are checked for reports this often (real seconds). */
const REPORT_SECONDS = 10;
/** The player's crimes are pursued this long after a guard last pursued them (seconds). */
const PURSUIT_SECONDS = 30;

/** A witness's line for an act: guards' and fighters', and the non-combatants' (NC). */
const LINES: Readonly<Record<CrimeAct, readonly [string, string]>> = {
  steal: ['Steal', 'StealFromNC'],
  pickpocket: ['PickpocketCombat', 'PickpocketNC'],
  trespass: ['Trespass', 'TrespassAgainstNC'],
  lockpick: ['Trespass', 'TrespassAgainstNC'],
  attack: ['Assault', 'AssaultNC'],
  murder: ['Murder', 'MurderNC'],
};

/** The alarm an act raises (src/shell/actor-senses.ts alarm). */
const ALARMS: Readonly<Record<CrimeAct, 'attack' | 'trespass' | 'steal'>> = {
  steal: 'steal',
  pickpocket: 'steal',
  trespass: 'trespass',
  lockpick: 'trespass',
  attack: 'attack',
  murder: 'attack',
};

const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** An arrest under way (ActorCrime). */
interface Arrest {
  readonly guard: number;
  readonly since: number;
  talking: boolean;
  /** Ends the guard's Alarm package's wait for the arrest's conversation. */
  over?: () => void;
}

export class ActorCrime {
  readonly #options: ActorCrimeOptions;
  #runtime: ScriptRuntime | undefined;
  #stopListening: (() => void) | undefined;
  #clock = 0;
  #guardsDue = 0;
  #reportsDue = 0;
  #settings: CrimeSettings | undefined;
  #settingsAsked = false;
  /** Guards (and not), read once per actor. */
  readonly #guards = new Map<number, boolean>();
  /** When each guard was last asked what to do, and its answer. */
  readonly #responses = new Map<number, { at: number; response: 'none' | 'arrest' | 'attack' }>();
  /** Guards that attack the player now (told to the combat AI once). */
  readonly #attacking = new Set<number>();
  /** fAIMinGreetingDistance: how near its Alarm takes a guard before it force-greets. */
  #greetReach = ARREST_REACH;
  /**
   * The arrest under way: the guard, since when, whether it talks with the player now, and what
   * ends its Alarm package's wait for the conversation; when each guard may try again after
   * giving up.
   */
  #arrest: Arrest | undefined;
  readonly #arrestAgain = new Map<number, number>();
  /** When a guard last pursued the player (the HUD's and menus' "guards pursuing"). */
  #pursuedAt = -Infinity;
  /** Trespass: the cell, whether the player trespasses there, its warnings, who warned. */
  #trespass: { cell: number | undefined; trespassing: boolean; checking: boolean } = {
    cell: undefined,
    trespassing: false,
    checking: false,
  };
  readonly #warnings = new TrespassWarnings();
  readonly #warners = new Set<number>();
  /** The player's steal warnings (iStealWarnings, fWarningTimer). */
  readonly #stealWarnings = new StealWarnings();
  /** The guards answering each NPC criminal's crimes (iNumberGuardsCrimeResponse at most). */
  readonly #answering = new Map<number, Set<number>>();
  /** The player has been inside the jail's cell (leaving it unserved is an escape). */
  #inJail = false;

  constructor(options: ActorCrimeOptions) {
    this.#options = options;
  }

  /** Every frame (real seconds), after the senses. */
  frame(seconds: number): void {
    const runtime = this.#options.session.scriptsReady;
    if (runtime !== this.#runtime) this.#attach(runtime);
    this.#options.session.crimeWatch = runtime ? this : undefined;
    if (!runtime || this.#options.session.loading) return;
    this.#clock += seconds;
    if (!this.#settingsAsked) {
      this.#settingsAsked = true;
      void runtime.crime.settings().then((settings) => {
        this.#settings = settings;
      });
      void runtime.gameSetting('fAIMinGreetingDistance').then((reach) => {
        if (typeof reach === 'number' && reach > 0) this.#greetReach = reach;
      });
    }
    if (this.#clock >= this.#reportsDue) {
      this.#reportsDue = this.#clock + REPORT_SECONDS;
      void runtime.crime.update();
    }
    this.#jailFrame(runtime);
    if (this.#clock < this.#guardsDue) return;
    this.#guardsDue = this.#clock + GUARD_SECONDS;
    this.#guardsFrame(runtime);
    this.#trespassFrame(runtime);
  }

  /** Whether guards pursue the player now (sNoWaitWhileAlarm, sNoLockPickIfCrimeAlert, ...). */
  get pursued(): boolean {
    return this.#arrest !== undefined || this.#clock - this.#pursuedAt < PURSUIT_SECONDS;
  }

  /** Whether the player trespasses where they are (sNoWaitTrespass, sNoSleepTrespass). */
  get trespassing(): boolean {
    return this.#trespass.trespassing;
  }

  /** An actor left the stage. */
  remove(reference: number): void {
    this.#responses.delete(reference);
    this.#attacking.delete(reference);
    this.#answering.delete(reference);
    this.#warners.delete(reference);
    if (this.#arrest?.guard === reference) this.#endArrest(false);
  }

  #attach(runtime: ScriptRuntime | undefined): void {
    this.#stopListening?.();
    this.#stopListening = undefined;
    this.#runtime = runtime;
    if (!runtime) return;
    const { senses } = this.#options;
    runtime.crime.world = {
      witnesses: (actor, act, victim) => senses.detections.witness(actor, act, victim),
      stealWarning: (owner) => this.#stealWarning(owner),
    };
    this.#stopListening = runtime.crime.listen((event) => {
      this.#heard(runtime, event);
    });
  }

  /** What crime told: witnesses say their lines and raise alarms; the HUD's messages. */
  #heard(runtime: ScriptRuntime, event: CrimeEvent): void {
    const { session, senses, bark } = this.#options;
    switch (event.kind) {
      case 'crime': {
        const { crime, act } = event;
        for (const witness of crime.witnesses) {
          void this.#isGuard(runtime, witness).then((guard) => {
            const lines = LINES[act];
            const subtype =
              crime.type === CrimeType.werewolf
                ? 'WereTransformCrime'
                : guard
                  ? lines[0]
                  : lines[1];
            void bark(witness, subtype, crime.criminal);
          });
          senses.alarm(witness, crime.criminal, ALARMS[act]);
        }
        return;
      }
      case 'npcCrime': {
        void this.#npcCrime(runtime, event);
        return;
      }
      case 'forgiven':
        // Observed in the original: "Last witness killed. <gold> crimegold removed from <faction>".
        void session.settings().then((settings) => {
          const gold = event.crimes.reduce((sum, crime) => sum + crime.gold, 0);
          const faction = event.crimes[event.crimes.length - 1]?.faction;
          const name = faction === undefined ? undefined : runtime.crime.name(faction);
          const parts = [
            settings.string('sWitnessKilled') ?? '',
            ...(gold > 0
              ? [String(gold), settings.string('sRemoveCrimeGold') ?? '', name ?? '']
              : []),
          ];
          session.hud.notification(parts.join(' ').trim());
        });
        return;
      case 'caught':
        void session.settings().then((settings) => {
          session.hud.notification(settings.string('sPickpocketFail') ?? '');
        });
        return;
      case 'jailed':
        this.#inJail = false;
        this.#endArrest(true);
        return;
      default:
        this.#endArrest(true);
    }
  }

  /**
   * An NPC's crime: its witnesses raise the alarm. Observed in the original: the guards among
   * those who hear it (within the alarm's reach, of the crime's faction or its crime group, not
   * fighting) need not see the crime, but only the first of them answers it; a guard who
   * witnessed it answers too, and no more than iNumberGuardsCrimeResponse answer one criminal.
   * Each guard that answers is given the engine's Alarm package aimed at the criminal (#pursue:
   * it runs to it and fights it once it detects it); the criminal, fighting no one, flees the
   * first of them (observed in the original; the engine's Flee package,
   * src/ai/engine-packages.ts).
   */
  async #npcCrime(
    runtime: ScriptRuntime,
    event: Extract<CrimeEvent, { readonly kind: 'npcCrime' }>,
  ): Promise<void> {
    const { senses, engaged, ai } = this.#options;
    const { criminal } = event;
    let hearers: readonly number[] = [];
    for (const witness of event.witnesses) {
      hearers = senses.alarm(witness, criminal, ALARMS[event.act]);
    }
    const guards: number[] = [];
    for (const witness of event.witnesses) {
      if (await this.#isGuard(runtime, witness)) guards.push(witness);
    }
    if (guards.length === 0) {
      for (const hearer of hearers) {
        if (hearer === criminal || engaged?.(hearer) === true) continue;
        if (!(await this.#isGuard(runtime, hearer))) continue;
        const faction = await runtime.actors.crimeFaction(hearer);
        if (faction === undefined || !event.group.includes(faction)) continue;
        guards.push(hearer);
        break;
      }
    }
    const answering = this.#answering.get(criminal) ?? new Set<number>();
    this.#answering.set(criminal, answering);
    // Those that answered before and are neither after it nor fighting any more are done.
    for (const guard of answering) {
      if (engaged?.(guard) !== true && ai.engineOf(guard) !== 'alarm') answering.delete(guard);
    }
    const limit = aiSettingsOf(this.#options.session).guardsCrimeResponse;
    let first: number | undefined;
    for (const guard of guards) {
      if (answering.has(guard)) {
        first ??= guard;
        continue;
      }
      if (!guardAnswers(answering.size, limit)) break;
      answering.add(guard);
      first ??= guard;
      this.#pursue(runtime, guard, criminal);
    }
    // The criminal, fighting no one, flees the guard that answers.
    const staged = this.#options.get(criminal);
    if (
      first !== undefined &&
      criminal !== PLAYER_REF &&
      staged !== undefined &&
      !staged.dead &&
      engaged?.(criminal) !== true
    ) {
      ai.pushEngine(criminal, 'flee', fleeFrom, first);
    }
  }

  /**
   * A guard goes after a criminal it is to fight (an NPC's crime; the player where its faction
   * attacks): the engine's Alarm package takes it to the criminal, and it fights it once it
   * detects it. One with no packages running here (or on another engine package) fights at once:
   * the combat AI's search takes it there.
   */
  #pursue(runtime: ScriptRuntime, guard: number, criminal: number): void {
    const { ai, senses } = this.#options;
    const fight = (actor: number, other: number): void => {
      runtime.world.startCombat?.(actor, other);
    };
    const alarm = alarmPackage({
      detects: (actor, other) => senses.detects(actor, other),
      confront: fight,
    });
    if (!ai.pushEngine(guard, 'alarm', alarm, criminal)) fight(guard, criminal);
  }

  /**
   * The player's theft its owner sees (src/ai/engine-packages.ts, Steal Warning): the owner on
   * the stage, alive, detecting them and fighting no one, while their warnings are not used up
   * (iStealWarnings), comes up and warns them; the theft is no crime yet.
   */
  #stealWarning(owner: number): boolean {
    const { senses, ai, session } = this.#options;
    const staged = this.#options.get(owner);
    if (!staged || staged.dead || staged.visibility.hidden) return false;
    if (!senses.detections.detects(owner, PLAYER_REF)) return false;
    if (this.#options.engaged?.(owner) === true) return false;
    const settings = aiSettingsOf(session);
    if (!this.#stealWarnings.due(this.#clock, settings)) return false;
    const line = LINES.steal[this.#guards.get(owner) === true ? 0 : 1];
    if (!ai.pushEngine(owner, 'stealWarning', warnThief(line), PLAYER_REF)) return false;
    this.#stealWarnings.give(this.#clock, settings);
    return true;
  }

  #isGuard(runtime: ScriptRuntime, actor: number): Promise<boolean> {
    const known = this.#guards.get(actor);
    if (known !== undefined) return Promise.resolve(known);
    return runtime.crime.isGuard(actor).then((guard) => {
      this.#guards.set(actor, guard);
      return guard;
    });
  }

  // --- Guards ---------------------------------------------------------------------------------

  /**
   * Each guard that sees the player, or heard the alarm of a crime of theirs, and whose crime
   * faction has a bounty on them answers what it does (the crime engine's guardResponse): one
   * arrests at a time, on its Alarm package; those that attack are given to the combat AI, one
   * that does not see them yet by its Alarm package too.
   */
  #guardsFrame(runtime: ScriptRuntime): void {
    const { senses, actors } = this.#options;
    if (runtime.state.crime.jail !== undefined) return;
    // The conversation ended without a fine or jail (the player walked off, talked their way
    // out), or the arrest took too long: it is given up for now.
    const arrest = this.#arrest;
    const chaser = arrest && this.#options.get(arrest.guard)?.position;
    const player = this.#options.session.scriptWorld.livePlacement(PLAYER_REF)?.position;
    if (
      arrest &&
      ((arrest.talking && runtime.dialogueSpeaker !== arrest.guard) ||
        (!arrest.talking && this.#clock - arrest.since > ARREST_AGAIN_SECONDS * 4) ||
        (chaser && player && flat(chaser, player) > ARREST_GIVE_UP))
    ) {
      this.#endArrest(false);
    }
    for (const staged of actors()) {
      const guard = staged.reference;
      if (staged.dead || staged.visibility.hidden) continue;
      const known = this.#guards.get(guard);
      if (known === undefined) {
        void this.#isGuard(runtime, guard);
        continue;
      }
      if (!known) continue;
      // One that only heard the alarm of the player's crime goes after them as well (its Alarm
      // package takes it there); else a guard answers the player it sees.
      const sees = senses.detections.detects(guard, PLAYER_REF);
      if (!sees && senses.detections.alarmedBy(guard) !== PLAYER_REF) continue;
      const kept = this.#responses.get(guard);
      if (!kept || this.#clock - kept.at >= RESPONSE_SECONDS) {
        this.#responses.set(guard, { at: this.#clock, response: kept?.response ?? 'none' });
        void runtime.crime.guardResponse(guard, senses.alarmed(guard)).then((response) => {
          this.#responses.set(guard, { at: this.#clock, response });
        });
      }
      const response = this.#responses.get(guard)?.response ?? 'none';
      if (response === 'attack') {
        this.#pursuedAt = this.#clock;
        if (this.#arrest?.guard === guard) this.#endArrest(true);
        if (!this.#attacking.has(guard)) {
          // At most iNumberGuardsCrimeResponse guards go after the player at once (observed in the
          // original); the others leave it to them.
          if (this.#attacking.size >= aiSettingsOf(this.#options.session).guardsCrimeResponse) {
            continue;
          }
          this.#attacking.add(guard);
          if (sees) runtime.world.startCombat?.(guard, PLAYER_REF);
          else this.#pursue(runtime, guard, PLAYER_REF);
        }
      } else if (response === 'arrest') {
        this.#pursuedAt = this.#clock;
        // No arrest mid-fight: guards that fight the player (one struck, those who help it)
        // fight on until the player yields (the combat AI's AcceptYield ends their fight); the
        // arrest's conversation comes after. The dialogue menu does not pause the game, so a
        // conversation opened mid-fight left the player struck while it was open.
        if (this.#fighting()) {
          if (this.#arrest && !this.#arrest.talking) this.#endArrest(false);
          continue;
        }
        if (!this.#arrest && (this.#arrestAgain.get(guard) ?? 0) <= this.#clock)
          this.#startArrest(runtime, staged);
      } else if (this.#attacking.delete(guard)) {
        this.#options.ai.leaveEngine(guard, 'alarm');
        runtime.world.stopCombat?.(guard);
      }
    }
  }

  /**
   * A guard arrests the player: the engine's Alarm package aimed at them takes it up to them
   * (within fAIMinGreetingDistance, detecting them), calling after them as it pursues
   * (PursueIdleTopic: "Stop, in the name of the Jarl!"); there it opens the conversation with
   * its crime force greet (DialogueCrimeGuards' ForceGreet topic: "By order of the Jarl, stop
   * right there!"), whose lines ask that it is alarmed (GetAlarmed: it is, on its Alarm
   * package), and stays on the package until the arrest is over. Inferred, TODO(M13): that the
   * force greet is the Alarm package's own step, and that the guard is the arresting actor
   * (GetArrestingActor) from its force greet on, not while it pursues.
   */
  #startArrest(runtime: ScriptRuntime, staged: StagedActor): void {
    const { ai, senses } = this.#options;
    const guard = staged.reference;
    const arrest: Arrest = { guard, since: this.#clock, talking: false };
    const alarm = alarmPackage({
      detects: (actor, other) => senses.detects(actor, other),
      reach: () => this.#greetReach,
      confront: () => this.#forceGreet(runtime, staged, arrest),
    });
    // Given up on its way (the player gone, not reached in its time), the arrest is over too.
    const runner: EngineRunner = async (run) => {
      try {
        await alarm(run);
      } finally {
        if (this.#arrest === arrest && !arrest.talking) this.#endArrest(false);
      }
    };
    if (!ai.pushEngine(guard, 'alarm', runner, PLAYER_REF)) {
      this.#arrestAgain.set(guard, this.#clock + ARREST_AGAIN_SECONDS);
      return;
    }
    this.#arrest = arrest;
  }

  /**
   * The arresting guard has the player before it: its force greet opens the conversation.
   * Resolves once the arrest is over (settled or given up).
   */
  async #forceGreet(runtime: ScriptRuntime, staged: StagedActor, arrest: Arrest): Promise<void> {
    const guard = staged.reference;
    if (this.#arrest !== arrest) return;
    const line = await runtime.dialogue.subtypeLine(guard, 'PFGT', PLAYER_REF);
    if (this.#arrest !== arrest) return;
    const menus = this.#options.session.hud.menus;
    if (!line || !menus || runtime.dialogueSpeaker !== undefined || this.#fighting()) {
      this.#endArrest(false);
      return;
    }
    arrest.talking = true;
    runtime.state.crime.arrestingGuard = guard;
    // The story manager's Arrest (TG00ArrestMonitor, DGArrestQuest): the engine raises it as
    // the arresting guard reaches the criminal, before it speaks.
    runtime.detach(runtime.storyEvents.guardArrests(guard, PLAYER_REF));
    menus.talk(staged.placed, line.topic.formId);
    await new Promise<void>((resolve) => {
      arrest.over = resolve;
    });
  }

  /**
   * Whether someone fights the player now. TODO(M13): inferred that the engine's arrest waits
   * for the whole fight (its force greet is a package, and packages give way to combat); whether
   * it waits for other factions' fighters too is not known.
   */
  #fighting(): boolean {
    return this.#options.session.combatWatch?.fightingPlayer === true;
  }

  /** The arrest ends: settled (paid, jailed, resisted) or given up for a while. */
  #endArrest(settled: boolean): void {
    const arrest = this.#arrest;
    if (!arrest) return;
    this.#arrest = undefined;
    // Its Alarm package ends: its wait for the conversation, or the pursuit still under way.
    if (arrest.over) arrest.over();
    else this.#options.ai.leaveEngine(arrest.guard, 'alarm');
    if (!settled) this.#arrestAgain.set(arrest.guard, this.#clock + ARREST_AGAIN_SECONDS);
    const runtime = this.#runtime;
    if (runtime?.state.crime.arrestingGuard === arrest.guard)
      delete runtime.state.crime.arrestingGuard;
  }

  // --- Trespassing ----------------------------------------------------------------------------

  /**
   * The player in an interior off limits to them (crime engine's trespassing): those who see
   * them and are not their friends warn them (the senses' guard warning: they come up, their
   * Trespass line) every fAITrespassWarningTimer, iGuardWarnings times; staying, it is the crime.
   */
  #trespassFrame(runtime: ScriptRuntime): void {
    const { session, senses, actors } = this.#options;
    const cell = session.scriptWorld.livePlacement(PLAYER_REF)?.cell;
    const trespass = this.#trespass;
    if (cell !== trespass.cell) {
      trespass.cell = cell;
      trespass.trespassing = false;
      this.#stopWarnings(runtime);
    }
    if (!trespass.checking) {
      trespass.checking = true;
      void runtime.crime
        .trespassing(cell)
        .then((trespassing) => {
          if (trespass.cell === cell) trespass.trespassing = trespassing;
          if (!trespassing) this.#stopWarnings(runtime);
        })
        .finally(() => {
          trespass.checking = false;
        });
    }
    const settings = this.#settings;
    if (!trespass.trespassing || !settings) return;
    const seeing: number[] = [];
    for (const staged of actors()) {
      if (staged.dead || staged.visibility.hidden) continue;
      if (runtime.state.actors.get(staged.reference)?.playerTeammate === true) continue;
      if (senses.detections.detects(staged.reference, PLAYER_REF)) seeing.push(staged.reference);
    }
    if (seeing.length === 0) return;
    switch (this.#warnings.seen(this.#clock, settings)) {
      case 'warn':
        runtime.state.crime.trespassWarnings = this.#warnings.level;
        for (const actor of seeing) {
          this.#warners.add(actor);
          senses.warn(actor, PLAYER_REF);
        }
        return;
      case 'crime': {
        const place = seeing[0] ?? PLAYER_REF;
        void runtime.crime.trespass(PLAYER_REF, place, seeing);
        this.#stopWarnings(runtime, false);
        return;
      }
      default:
        return;
    }
  }

  #stopWarnings(runtime: ScriptRuntime, reset = true): void {
    for (const actor of this.#warners) this.#options.senses.warn(actor, undefined);
    this.#warners.clear();
    if (!reset) return;
    this.#warnings.reset();
    runtime.state.crime.trespassWarnings = 0;
  }

  // --- Jail -------------------------------------------------------------------------------------

  /** The player in jail who leaves its cell without serving their time has escaped. */
  #jailFrame(runtime: ScriptRuntime): void {
    const jail = runtime.state.crime.jail;
    if (jail?.cell === undefined) {
      this.#inJail = false;
      return;
    }
    const cell = this.#options.session.scriptWorld.livePlacement(PLAYER_REF)?.cell;
    if (cell === jail.cell) {
      this.#inJail = true;
      return;
    }
    if (this.#inJail && cell !== undefined) {
      this.#inJail = false;
      void runtime.crime.escape();
    }
  }
}
