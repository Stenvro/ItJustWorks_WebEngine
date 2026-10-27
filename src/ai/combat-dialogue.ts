// Combat dialogue's gates (engine map: Combat > Combat dialogue): which combat line an actor may
// say now. Each subtype has its cooldown, fCombatDialogue{Attack, Taunt, BleedOut, AvoidThreat,
// Flee, AllyKilled}{Min, Max}ElapsedTime (a new line no sooner than a time drawn in that span
// after the last one of the subtype), and its distance gate, fCombatDialogue*DistanceMult (the
// line is said only with the player within the mult × the combat line's range). Some subtypes
// are also said only by a chance (fCombatSpeak{Attack, PowerAttack, Taunt, Hit}Chance; a hit
// line only for a blow of at least fCombatSpeakHitThreshold of its health).
//
// Values: the engine's built-in settings (the engine's defaults) unless the load order sets them
// (Skyrim.esm sets the taunt's 10 .. 30 s). The range the mults scale is ours: TODO(M13).
// Platform-independent.

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

interface LineRule {
  /** The setting-name stem of its cooldown and its built-in span (seconds); none: no cooldown. */
  readonly cooldown?: readonly [string, number, number];
  /** fCombatDialogue<stem>DistanceMult and its built-in value. */
  readonly distance: readonly [string, number];
  /** fCombatSpeak<stem>Chance and its built-in value. */
  readonly chance?: readonly [string, number];
}

const RULES: Readonly<Record<CombatLine, LineRule>> = {
  Attack: {
    cooldown: ['Attack', 1, 5],
    distance: ['Attack', 0.33],
    chance: ['Attack', 0.1],
  },
  // TODO(M13): the power attack's and bash's cooldowns (no setting names them: the attack's).
  PowerAttack: {
    cooldown: ['Attack', 1, 5],
    distance: ['PowerAttack', 0.5],
    chance: ['PowerAttack', 0.5],
  },
  Bash: { cooldown: ['Attack', 1, 5], distance: ['Bash', 0.33] },
  Hit: { distance: ['Hit', 0.5], chance: ['Hit', 0.35] },
  Flee: { cooldown: ['Flee', 3, 5], distance: ['Flee', 1] },
  Bleedout: { cooldown: ['BleedOut', 1, 5], distance: ['Bleedout', 0.75] },
  AvoidThreat: { cooldown: ['AvoidThreat', 3, 5], distance: ['AvoidThreat', 1] },
  Death: { distance: ['Death', 1] },
  GroupStrategy: { distance: ['GroupStrategy', 1] },
  Block: { cooldown: ['Attack', 1, 5], distance: ['Block', 0.33] },
  // TODO(M13): fCombatSpeakTauntChance (0.01) is the engine's per-check chance; the tree's taunt
  // timer (mayTaunt) stands for it here.
  Taunt: { cooldown: ['Taunt', 10, 30], distance: ['Taunt', 0.75] },
  AllyKilled: { cooldown: ['AllyKilled', 3, 5], distance: ['AllyKilled', 0.75] },
};

export function isCombatLine(subtype: string): subtype is CombatLine {
  return Object.hasOwn(RULES, subtype);
}

/** A subtype's gates as the load order sets them. */
export interface CombatLineSettings {
  readonly cooldownMin: number;
  readonly cooldownMax: number;
  readonly distanceMult: number;
  /** 1: always (no fCombatSpeak*Chance for it). */
  readonly chance: number;
}

export interface CombatDialogueSettings {
  readonly lines: Readonly<Record<CombatLine, CombatLineSettings>>;
  /** fCombatSpeakHitThreshold: a hit line only for a blow of at least this share of its health. */
  readonly hitThreshold: number;
  /** The range the distance mults scale (units). Ours: TODO(M13) the engine's. */
  readonly range: number;
  /** [Combat] bDisableCombatDialogue. */
  readonly disabled: boolean;
}

/** The range the distance mults scale (units; TODO(M13): the engine's). */
export const COMBAT_LINE_RANGE = 2048;

export function readCombatDialogueSettings(
  number: (editorId: string) => number | undefined = () => undefined,
  disabled = false,
): CombatDialogueSettings {
  const lines = {} as Record<CombatLine, CombatLineSettings>;
  for (const [line, rule] of Object.entries(RULES) as [CombatLine, LineRule][]) {
    const [stem, min, max] = rule.cooldown ?? ['', 0, 0];
    lines[line] = {
      cooldownMin: rule.cooldown ? (number(`fCombatDialogue${stem}MinElapsedTime`) ?? min) : 0,
      cooldownMax: rule.cooldown ? (number(`fCombatDialogue${stem}MaxElapsedTime`) ?? max) : 0,
      distanceMult: number(`fCombatDialogue${rule.distance[0]}DistanceMult`) ?? rule.distance[1],
      chance: rule.chance ? (number(`fCombatSpeak${rule.chance[0]}Chance`) ?? rule.chance[1]) : 1,
    };
  }
  return {
    lines,
    hitThreshold: number('fCombatSpeakHitThreshold') ?? 0.1,
    range: COMBAT_LINE_RANGE,
    disabled,
  };
}

export const COMBAT_DIALOGUE_DEFAULTS = readCombatDialogueSettings((name) =>
  // Skyrim.esm's taunt span.
  name === 'fCombatDialogueTauntMinElapsedTime'
    ? 10
    : name === 'fCombatDialogueTauntMaxElapsedTime'
      ? 30
      : undefined,
);

export interface LineAsk {
  /** The speaker's distance to the player (who hears the line). */
  readonly listener: number;
  /** A Hit line: the blow's share of the speaker's health. */
  readonly blow?: number;
  /** The fight's random (a chance, a cooldown drawn). */
  readonly random: () => number;
}

/** Each actor's combat lines: when each subtype may come again. */
export class CombatDialogue {
  settings: CombatDialogueSettings = COMBAT_DIALOGUE_DEFAULTS;
  readonly #next = new Map<number, Map<CombatLine, number>>();

  /**
   * Whether `actor` may say a line of `line` at `now` (seconds): within the distance gate, its
   * cooldown passed, by its chance (a hit line: for a blow over the threshold). When it may, its
   * next cooldown starts (drawn in the subtype's span).
   */
  may(actor: number, line: CombatLine, now: number, ask: LineAsk): boolean {
    const settings = this.settings;
    if (settings.disabled) return false;
    const rule = settings.lines[line];
    if (ask.listener > rule.distanceMult * settings.range) return false;
    const next = this.#next.get(actor)?.get(line) ?? -Infinity;
    if (now < next) return false;
    if (line === 'Hit' && (ask.blow ?? 1) < settings.hitThreshold) return false;
    if (rule.chance < 1 && ask.random() >= rule.chance) return false;
    if (rule.cooldownMax > 0) {
      let lines = this.#next.get(actor);
      if (!lines) this.#next.set(actor, (lines = new Map<CombatLine, number>()));
      lines.set(
        line,
        now + rule.cooldownMin + (rule.cooldownMax - rule.cooldownMin) * ask.random(),
      );
    }
    return true;
  }

  /** Its fight ended: its cooldowns go with it. */
  forget(actor: number): void {
    this.#next.delete(actor);
  }
}
