// When combat music plays (observed in the original: its combat manager weighs the fights
// every fCombatMusicUpdateTime). The music type is the default object BTMS (MUSCombat), or the
// boss music against a boss: an actor whose reference has the location reference type Boss
// (DOBJ LRTB). Which tracks of it play is the music system's (their conditions ask the combat
// target's keywords: the dragon pieces of MUSCombat).
//
// - **Strength** (the engine's measure for the odds, also GetThreatRatio's: actorStrength in
//   src/ai/combat-ai.ts): an actor's damage × its health / (1 − its armour's reduction).
// - **Start**, a fight against the player: the strength of its fighters the player detects,
//   against the player's own: the player's strength over theirs below
//   fCombatMusicPlayerTargetedThreatRatio. A mudcrab or a lone wolf does not start it for a
//   player much stronger. A fight not against the player (a follower's, a dragon over the town)
//   with a fighter within fCombatMusicNearCombatInnerRadius: when the player detects one of
//   them and their strength is above the player's × fCombatMusicPlayerNearStrengthMult.
// - **Even fights:** a fight not against the player counts for neither only once it is even
//   (observed in the original: each combat group decides it once, fCombatMusicGroupThreatRatioTimer
//   seconds after it forms: the strength of its targets over its own between
//   fCombatMusicGroupThreatRatioMin and Max). Guards cutting down a mudcrab start nothing.
// - **On:** once it plays, a fight against the player keeps it, as does an even one with a
//   fighter within fCombatMusicNearCombatOuterRadius (the odds are not weighed again).
// - **Stop:** once no fight keeps it, it plays on for fCombatMusicStopTime, then ends (with its
//   finale: music.ts); a fight in the meantime keeps it.
//
// fCombatMusicPlayerCombatStrengthCap is a game setting the original never reads.
//
// The engine weighs each combat group; ours takes the fighters hostile to the player as one
// group for each side of the rule (TODO(M13): a second group's fight near the player counted
// apart, and a check of the group the engine makes before the odds, not identified). Pure:
// src/shell/actor-combat.ts feeds it.

export interface CombatMusicSettings {
  /** fCombatMusicPlayerTargetedThreatRatio: the player's strength over the fight's, below it starts. */
  readonly playerTargetedThreatRatio: number;
  /** fCombatMusicNearCombatInnerRadius: a fight not against the player starts it within this. */
  readonly nearCombatInnerRadius: number;
  /** fCombatMusicNearCombatOuterRadius: it keeps playing while such a fight is within this. */
  readonly nearCombatOuterRadius: number;
  /** fCombatMusicPlayerNearStrengthMult: the player's strength a near fight must pass. */
  readonly playerNearStrengthMult: number;
  /** fCombatMusicStopTime: seconds it plays on once no fight keeps it. */
  readonly stopTime: number;
  /** fCombatMusicUpdateTime: the fights are weighed this often (seconds). */
  readonly updateTime: number;
  /** fCombatMusicGroupThreatRatioTimer: seconds after a fight forms that its evenness is decided. */
  readonly groupThreatRatioTimer: number;
  /** fCombatMusicGroupThreatRatioMin / Max: the targets' strength over the group's, exclusive. */
  readonly groupThreatRatioMin: number;
  readonly groupThreatRatioMax: number;
}

const SETTINGS: readonly (readonly [keyof CombatMusicSettings, string, number])[] = [
  ['playerTargetedThreatRatio', 'fCombatMusicPlayerTargetedThreatRatio', 2],
  ['nearCombatInnerRadius', 'fCombatMusicNearCombatInnerRadius', 2500],
  ['nearCombatOuterRadius', 'fCombatMusicNearCombatOuterRadius', 3500],
  ['playerNearStrengthMult', 'fCombatMusicPlayerNearStrengthMult', 1],
  ['stopTime', 'fCombatMusicStopTime', 5],
  ['updateTime', 'fCombatMusicUpdateTime', 1],
  ['groupThreatRatioTimer', 'fCombatMusicGroupThreatRatioTimer', 1],
  ['groupThreatRatioMin', 'fCombatMusicGroupThreatRatioMin', 0.5],
  ['groupThreatRatioMax', 'fCombatMusicGroupThreatRatioMax', 2],
];

export function readCombatMusicSettings(
  number: (editorId: string) => number | undefined = () => undefined,
): CombatMusicSettings {
  return Object.fromEntries(
    SETTINGS.map(([key, name, fallback]) => [key, number(name) ?? fallback]),
  ) as unknown as CombatMusicSettings;
}

export const COMBAT_MUSIC_DEFAULTS = readCombatMusicSettings();

/** An actor alive in combat that is hostile to the player. */
export interface CombatMusicThreat {
  /** Its combat target is the player. */
  readonly targetsPlayer: boolean;
  /** Its distance from the player (game units). */
  readonly distance: number;
  /** How strong it is (actorStrength). */
  readonly strength: number;
  /** The player detects it. */
  readonly detected: boolean;
  /** Its reference has the location reference type Boss. */
  readonly boss: boolean;
}

export interface CombatMusicInput {
  readonly threats: readonly CombatMusicThreat[];
  /** The player's strength (actorStrength). */
  readonly player: number;
  /**
   * The strength of what the fighters not targeting the player fight (their targets, each
   * once); without it their fight counts as even.
   */
  readonly nearTargets?: number;
}

export type CombatMusicChoice = 'none' | 'combat' | 'boss';

function total(threats: readonly CombatMusicThreat[]): number {
  return threats.reduce((sum, threat) => sum + threat.strength, 0);
}

/** Which music the fights call for, before the stop time: none, combat, or the boss music. */
export function combatMusicWanted(
  input: CombatMusicInput,
  settings: CombatMusicSettings,
  playing: boolean,
  nearEven = true,
): CombatMusicChoice {
  const targeting = input.threats.filter((threat) => threat.targetsPlayer);
  const near = nearEven
    ? input.threats.filter(
        (threat) => !threat.targetsPlayer && threat.distance <= settings.nearCombatOuterRadius,
      )
    : [];
  let counted: CombatMusicThreat[] = [];
  if (playing) {
    counted = [...targeting, ...near];
  } else {
    const detected = total(targeting.filter((threat) => threat.detected));
    if (detected > 0 && input.player / detected < settings.playerTargetedThreatRatio)
      counted = targeting;
    const inner = near.filter((threat) => threat.distance <= settings.nearCombatInnerRadius);
    if (
      inner.some((threat) => threat.detected) &&
      total(inner) > settings.playerNearStrengthMult * input.player
    )
      counted = [...counted, ...inner];
  }
  if (counted.length === 0) return 'none';
  return counted.some((threat) => threat.boss) ? 'boss' : 'combat';
}

/**
 * Whether a fight not against the player is even (observed in the original): its targets'
 * strength over its own between fCombatMusicGroupThreatRatioMin and Max, both exclusive.
 */
export function evenFight(
  ownStrength: number,
  targetStrength: number,
  settings: CombatMusicSettings,
): boolean {
  if (ownStrength <= 0) return false;
  const ratio = targetStrength / ownStrength;
  return ratio > settings.groupThreatRatioMin && ratio < settings.groupThreatRatioMax;
}

/** The combat music's state from frame to frame. */
export class CombatMusic {
  /** What plays now. */
  playing: CombatMusicChoice = 'none';
  /** Seconds since no fight kept it (while it still plays). */
  #quiet = 0;
  /** Seconds until the fights are weighed again. */
  #due = 0;
  /**
   * The fight not against the player: seconds since it formed, and whether it is even once
   * decided (it is decided once, as the engine's combat groups do).
   */
  #nearFor = 0;
  #nearEven: boolean | undefined;

  settings: CombatMusicSettings;

  constructor(settings: CombatMusicSettings = COMBAT_MUSIC_DEFAULTS) {
    this.settings = settings;
  }

  /** One frame (`seconds` of the world's time): what should play now. */
  update(seconds: number, input: CombatMusicInput | (() => CombatMusicInput)): CombatMusicChoice {
    if (this.playing !== 'none' && this.#quiet > 0) this.#quiet += seconds;
    this.#due -= seconds;
    this.#nearFor += seconds;
    if (this.#due > 0) return this.#stopping();
    this.#due = this.settings.updateTime;
    const fights = typeof input === 'function' ? input() : input;
    const wanted = combatMusicWanted(
      fights,
      this.settings,
      this.playing !== 'none',
      this.#even(fights),
    );
    if (wanted !== 'none') {
      this.#quiet = 0;
      this.playing = wanted;
    } else if (this.playing !== 'none' && this.#quiet === 0) {
      // The stop time starts (the smallest step so it counts as begun).
      this.#quiet = Number.MIN_VALUE;
    }
    return this.#stopping();
  }

  /**
   * Whether the fight not against the player counts: undecided until
   * fCombatMusicGroupThreatRatioTimer after it formed, then decided once; it forms anew once
   * it has ended.
   */
  #even(input: CombatMusicInput): boolean {
    const near = input.threats.filter((threat) => !threat.targetsPlayer);
    if (near.length === 0) {
      this.#nearFor = 0;
      this.#nearEven = undefined;
      return false;
    }
    if (this.#nearEven !== undefined) return this.#nearEven;
    if (this.#nearFor <= this.settings.groupThreatRatioTimer) return false;
    this.#nearEven =
      input.nearTargets === undefined || evenFight(total(near), input.nearTargets, this.settings);
    return this.#nearEven;
  }

  /** It ends once the stop time has passed. */
  #stopping(): CombatMusicChoice {
    if (this.playing !== 'none' && this.#quiet > this.settings.stopTime) {
      this.playing = 'none';
      this.#quiet = 0;
    }
    return this.playing;
  }

  /** The fight is over at once (the player died, the world was left). */
  reset(): void {
    this.playing = 'none';
    this.#quiet = 0;
    this.#due = 0;
    this.#nearFor = 0;
    this.#nearEven = undefined;
  }
}
