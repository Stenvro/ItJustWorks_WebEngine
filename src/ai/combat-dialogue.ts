// Combat dialogue's gates (engine map: Combat > Combat dialogue): which combat line an actor may
// say now. Observed in the original (docs/ai.md, "Combat dialogue"):
//
// - [Combat] bDisableCombatDialogue silences them all.
// - **Cooldowns.** Some subtypes wait a time drawn in fCombatDialogue{stem}{Min, Max}ElapsedTime
//   after the last line of theirs; a line comes again only once more than that time has passed.
//   Attack, PowerAttack, Bash and Block share one timer (the Attack span); Taunt, Bleedout and
//   Flee have their own, each actor apart; AllyKilled and AvoidThreat are timed per combat group
//   (one member's line holds back the others'). Hit, Death and GroupStrategy have none. The timer
//   starts only when a line was found and said.
// - **Distance.** A line is said only with the sound listener (where the camera hears) within
//   fCombatDialogue{subtype}DistanceMult × the range of the 3D dialogue output model (the default
//   object DOP2's attenuation max distance: SOMDialogue3DDefault's 3000 in Skyrim.esm; without
//   one, no limit), measured in 3D from the speaker.
// - **Hit lines** (the hit's own rule, before the gates): a blow of more than
//   fCombatSpeakHitThreshold of the struck one's health always calls for one; a smaller blow only
//   by fCombatSpeakHitChance.
// - fCombatSpeakAttackChance, fCombatSpeakPowerAttackChance and fCombatSpeakTauntChance are
//   registered and never read (inert): attack lines come by their cooldown alone, taunts by the
//   combat controller's taunt timer.
//
// Values: the engine's built-in settings unless the load order sets them (Skyrim.esm sets the
// taunt's 10 .. 30 s). Platform-independent.

import { DefaultObjectUse, type DefaultObjects } from '../world/default-objects.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import { parseSoundOutputModel } from '../world/sound-records.ts';

/**
 * The range combat lines' distance mults scale (observed in the original): the attenuation max
 * distance of the 3D dialogue output model (DOBJ DOP2: Skyrim.esm's SOMDialogue3DDefault, 3000);
 * without one, no limit.
 */
export async function dialogueLineRange(
  db: Pick<RecordDatabase, 'get'>,
  defaults: Pick<DefaultObjects, 'get'>,
): Promise<number> {
  const form = defaults.get(DefaultObjectUse.dialogueOutput3d);
  const record = form === undefined ? undefined : await db.get(form);
  if (record?.type !== 'SOPM' || record.deleted) return Number.POSITIVE_INFINITY;
  return parseSoundOutputModel(record).attenuation?.maxDistance ?? Number.POSITIVE_INFINITY;
}

/** The combat subtypes the gates know (DIAL subtype names, xEdit). */
export type CombatLine =
  | 'Attack'
  | 'PowerAttack'
  | 'Bash'
  | 'Hit'
  | 'Flee'
  | 'Bleedout'
  | 'AvoidThreat'
  | 'Death'
  | 'GroupStrategy'
  | 'Block'
  | 'Taunt'
  | 'AllyKilled';

/** The timers the cooldowns run on (the first four each actor's, the last two its group's). */
type Timer = 'attack' | 'taunt' | 'bleedout' | 'flee' | 'allyKilled' | 'avoidThreat';

const GROUP_TIMERS: ReadonlySet<Timer> = new Set<Timer>(['allyKilled', 'avoidThreat']);

interface LineRule {
  /** Its timer, the setting-name stem of its span and the span's built-in values (seconds). */
  readonly cooldown?: readonly [Timer, string, number, number];
  /** fCombatDialogue<stem>DistanceMult and its built-in value. */
  readonly distance: readonly [string, number];
}

const ATTACK_TIMER = ['attack', 'Attack', 1, 5] as const;

const RULES: Readonly<Record<CombatLine, LineRule>> = {
  Attack: { cooldown: ATTACK_TIMER, distance: ['Attack', 0.33] },
  PowerAttack: { cooldown: ATTACK_TIMER, distance: ['PowerAttack', 0.5] },
  Bash: { cooldown: ATTACK_TIMER, distance: ['Bash', 0.33] },
  Hit: { distance: ['Hit', 0.5] },
  Flee: { cooldown: ['flee', 'Flee', 3, 5], distance: ['Flee', 1] },
  Bleedout: { cooldown: ['bleedout', 'BleedOut', 1, 5], distance: ['Bleedout', 0.75] },
  AvoidThreat: { cooldown: ['avoidThreat', 'AvoidThreat', 3, 5], distance: ['AvoidThreat', 1] },
  Death: { distance: ['Death', 1] },
  GroupStrategy: { distance: ['GroupStrategy', 1] },
  Block: { cooldown: ATTACK_TIMER, distance: ['Block', 0.33] },
  Taunt: { cooldown: ['taunt', 'Taunt', 10, 30], distance: ['Taunt', 0.75] },
  AllyKilled: { cooldown: ['allyKilled', 'AllyKilled', 3, 5], distance: ['AllyKilled', 0.75] },
};

export function isCombatLine(subtype: string): subtype is CombatLine {
  return Object.hasOwn(RULES, subtype);
}

/** A subtype's gates as the load order sets them. */
export interface CombatLineSettings {
  /** The timer its cooldown runs on (none: no cooldown). */
  readonly timer: Timer | undefined;
  readonly cooldownMin: number;
  readonly cooldownMax: number;
  readonly distanceMult: number;
}

export interface CombatDialogueSettings {
  readonly lines: Readonly<Record<CombatLine, CombatLineSettings>>;
  /** fCombatSpeakHitThreshold: a blow above this share of its health always calls a Hit line. */
  readonly hitThreshold: number;
  /** fCombatSpeakHitChance: the chance a smaller blow calls one. */
  readonly hitChance: number;
  /**
   * The range the distance mults scale (units): the 3D dialogue output model's attenuation max
   * distance (DOBJ DOP2, SOPM ANAM); Infinity without one.
   */
  readonly range: number;
  /** [Combat] bDisableCombatDialogue. */
  readonly disabled: boolean;
  /**
   * fAISocialchanceForConversation, ...Interior (percent; 10 and 10 in Skyrim.esm): the chance
   * a spectator who begins watching a fight says its ObserveCombat line (outside, inside).
   */
  readonly spectatorChance: number;
  readonly spectatorChanceInterior: number;
}

/** Skyrim.esm's 3D dialogue output model's range (SOMDialogue3DDefault, ANAM max distance). */
export const COMBAT_LINE_RANGE = 3000;

export function readCombatDialogueSettings(
  number: (editorId: string) => number | undefined = () => undefined,
  disabled = false,
  range = Number.POSITIVE_INFINITY,
): CombatDialogueSettings {
  const lines = {} as Record<CombatLine, CombatLineSettings>;
  for (const [line, rule] of Object.entries(RULES) as [CombatLine, LineRule][]) {
    const [timer, stem, min, max] = rule.cooldown ?? [undefined, '', 0, 0];
    lines[line] = {
      timer,
      cooldownMin: timer ? (number(`fCombatDialogue${stem}MinElapsedTime`) ?? min) : 0,
      cooldownMax: timer ? (number(`fCombatDialogue${stem}MaxElapsedTime`) ?? max) : 0,
      distanceMult: number(`fCombatDialogue${rule.distance[0]}DistanceMult`) ?? rule.distance[1],
    };
  }
  return {
    lines,
    hitThreshold: number('fCombatSpeakHitThreshold') ?? 0.1,
    hitChance: number('fCombatSpeakHitChance') ?? 0.35,
    range,
    disabled,
    spectatorChance: number('fAISocialchanceForConversation') ?? 10,
    spectatorChanceInterior: number('fAISocialchanceForConversationInterior') ?? 10,
  };
}

/**
 * Whether a spectator says its ObserveCombat line as it begins watching a fight: by
 * fAISocialchanceForConversation (inside, its Interior twin), which the original reads for
 * the spectators' comments (docs/ai.md, "Talking"), not for the conversations its name tells.
 * TODO(M13): that it is one roll as the watch begins (not one per check) is this file's own.
 */
export function spectatorComments(
  settings: Pick<CombatDialogueSettings, 'spectatorChance' | 'spectatorChanceInterior'>,
  interior: boolean,
  random: () => number,
): boolean {
  const chance = interior ? settings.spectatorChanceInterior : settings.spectatorChance;
  return random() * 100 < chance;
}

/**
 * Whether a blow calls for the struck one's Hit line (observed in the original): one of more
 * than fCombatSpeakHitThreshold of its health always; a smaller one by fCombatSpeakHitChance.
 */
export function hitCallsLine(
  blow: number,
  settings: Pick<CombatDialogueSettings, 'hitThreshold' | 'hitChance'>,
  random: () => number,
): boolean {
  if (blow > settings.hitThreshold) return true;
  return random() <= settings.hitChance;
}

export const COMBAT_DIALOGUE_DEFAULTS = readCombatDialogueSettings(
  (name) =>
    // Skyrim.esm's taunt span.
    name === 'fCombatDialogueTauntMinElapsedTime'
      ? 10
      : name === 'fCombatDialogueTauntMaxElapsedTime'
        ? 30
        : undefined,
  false,
  COMBAT_LINE_RANGE,
);

export interface LineAsk {
  /** The speaker's distance to the sound listener (3D). */
  readonly listener: number;
  /** The speaker's combat group (the AllyKilled and AvoidThreat timers are its); none: its own. */
  readonly group?: number | undefined;
}

/** A running cooldown: when it began and how long it holds (seconds). */
interface Cooldown {
  readonly start: number;
  readonly span: number;
}

/** Each actor's and each group's combat line timers. */
export class CombatDialogue {
  settings: CombatDialogueSettings = COMBAT_DIALOGUE_DEFAULTS;
  readonly #actors = new Map<number, Map<Timer, Cooldown>>();
  readonly #groups = new Map<number, Map<Timer, Cooldown>>();

  #timers(timer: Timer, group: number | undefined): Map<number, Map<Timer, Cooldown>> {
    return GROUP_TIMERS.has(timer) && group !== undefined ? this.#groups : this.#actors;
  }

  #owner(actor: number, timer: Timer, group: number | undefined): number {
    return GROUP_TIMERS.has(timer) && group !== undefined ? group : actor;
  }

  /**
   * Whether `actor` may say a line of `line` at `now` (seconds): combat dialogue not disabled,
   * its timer run out (more than its span since it began), the listener within its distance.
   * Nothing starts here: `said` starts its timer once a line was said.
   */
  may(actor: number, line: CombatLine, now: number, ask: LineAsk): boolean {
    const settings = this.settings;
    if (settings.disabled) return false;
    const rule = settings.lines[line];
    if (rule.timer) {
      const cooldown = this.#timers(rule.timer, ask.group)
        .get(this.#owner(actor, rule.timer, ask.group))
        ?.get(rule.timer);
      if (cooldown && now - cooldown.start <= cooldown.span) return false;
    }
    const reach = rule.distanceMult * settings.range;
    return !(reach * reach < ask.listener * ask.listener);
  }

  /** A line of `line` was said at `now`: its timer starts, its span drawn in its settings. */
  said(actor: number, line: CombatLine, now: number, random: () => number, group?: number): void {
    const rule = this.settings.lines[line];
    if (!rule.timer) return;
    const timers = this.#timers(rule.timer, group);
    const owner = this.#owner(actor, rule.timer, group);
    let own = timers.get(owner);
    if (!own) timers.set(owner, (own = new Map<Timer, Cooldown>()));
    own.set(rule.timer, {
      start: now,
      span: rule.cooldownMin + (rule.cooldownMax - rule.cooldownMin) * random(),
    });
  }

  /** Its fight ended: its own timers go with it. */
  forget(actor: number): void {
    this.#actors.delete(actor);
  }

  /** A combat group broke up: its timers go with it. */
  forgetGroup(group: number): void {
    this.#groups.delete(group);
  }
}
