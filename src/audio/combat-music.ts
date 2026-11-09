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
// The engine weighs each combat group. The fighters against the player are the targets of the
// player's own group, weighed together; each group fighting near the player whose fight is not
// against the player is weighed apart: its own evenness, decided once after it forms, and its
// own strength against the player's (two small fights near the player do not add up to one
// worth music; inferred from the per-group settings, TODO(M13): a check of the group the
// engine makes before the odds is not identified). Pure: src/shell/actor-combat.ts feeds it.

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
  /**
   * Its combat group (fights not against the player are weighed per group); without one, all
   * such fighters count as one group.
   */
  readonly group?: number | undefined;
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
  /**
   * Per combat group fighting near the player (not against them), the strength of what it
   * fights (its targets, each once); a group missing here weighs by nearTargets.
   */
  readonly groupTargets?: ReadonlyMap<number, number>;
}

/** The group a fighter not against the player is weighed in (0: none given). */
const groupOf = (threat: CombatMusicThreat): number => threat.group ?? 0;

/** Fighters by their group. */
function byGroup(threats: Iterable<CombatMusicThreat>): Map<number, CombatMusicThreat[]> {
  const groups = new Map<number, CombatMusicThreat[]>();
  for (const threat of threats) {
    const group = groups.get(groupOf(threat));
    if (group) group.push(threat);
    else groups.set(groupOf(threat), [threat]);
  }
  return groups;
}

export type CombatMusicChoice = 'none' | 'combat' | 'boss';

function total(threats: readonly CombatMusicThreat[]): number {
  return threats.reduce((sum, threat) => sum + threat.strength, 0);
}

/**
 * Which music the fights call for, before the stop time: none, combat, or the boss music.
 * `nearEven`: whether a group's fight not against the player counts (decided once: CombatMusic).
 */
export function combatMusicWanted(
  input: CombatMusicInput,
  settings: CombatMusicSettings,
  playing: boolean,
  nearEven: boolean | ((group: number) => boolean) = true,
): CombatMusicChoice {
  const even = typeof nearEven === 'function' ? nearEven : () => nearEven;
  const targeting = input.threats.filter((threat) => threat.targetsPlayer);
  const near = input.threats.filter(
    (threat) =>
      !threat.targetsPlayer &&
      threat.distance <= settings.nearCombatOuterRadius &&
      even(groupOf(threat)),
  );
  let counted: CombatMusicThreat[] = [];
  if (playing) {
    counted = [...targeting, ...near];
  } else {
    const detected = total(targeting.filter((threat) => threat.detected));
    if (detected > 0 && input.player / detected < settings.playerTargetedThreatRatio)
      counted = targeting;
    // Each group near the player apart: one of its fighters within the inner radius that the
    // player detects, and its strength there above the player's.
    const inner = near.filter((threat) => threat.distance <= settings.nearCombatInnerRadius);
    for (const group of byGroup(inner).values()) {
      if (
        group.some((threat) => threat.detected) &&
        total(group) > settings.playerNearStrengthMult * input.player
      )
        counted = [...counted, ...group];
    }
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
   * Each group's fight not against the player: when it formed (this music's clock), and whether
   * it is even once decided (it is decided once, as the engine's combat groups do).
   */
  readonly #near = new Map<number, { since: number; even: boolean | undefined }>();
  /** Seconds of the world's time this music has run. */
  #clock = 0;
  /** When the fights were last weighed (its clock). */
  #weighedAt = 0;

  settings: CombatMusicSettings;

  constructor(settings: CombatMusicSettings = COMBAT_MUSIC_DEFAULTS) {
    this.settings = settings;
  }

  /** One frame (`seconds` of the world's time): what should play now. */
  update(seconds: number, input: CombatMusicInput | (() => CombatMusicInput)): CombatMusicChoice {
    if (this.playing !== 'none' && this.#quiet > 0) this.#quiet += seconds;
    this.#due -= seconds;
    this.#clock += seconds;
    if (this.#due > 0) return this.#stopping();
    this.#due = this.settings.updateTime;
    const fights = typeof input === 'function' ? input() : input;
    this.#weighGroups(fights);
    const wanted = combatMusicWanted(
      fights,
      this.settings,
      this.playing !== 'none',
      (group) => this.#near.get(group)?.even === true,
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
   * Whether each group's fight not against the player counts: undecided until
   * fCombatMusicGroupThreatRatioTimer after it formed, then decided once by its own strength
   * against its own targets'; a group whose fight ended forms anew.
   */
  #weighGroups(input: CombatMusicInput): void {
    const groups = byGroup(input.threats.filter((threat) => !threat.targetsPlayer));
    for (const group of this.#near.keys()) if (!groups.has(group)) this.#near.delete(group);
    for (const [group, members] of groups) {
      let fight = this.#near.get(group);
      if (!fight) {
        // It formed after the last weighing, which did not find it yet.
        fight = { since: this.#weighedAt, even: undefined };
        this.#near.set(group, fight);
      }
      if (fight.even !== undefined) continue;
      if (this.#clock - fight.since <= this.settings.groupThreatRatioTimer) continue;
      const targets = input.groupTargets?.get(group) ?? input.nearTargets;
      fight.even = targets === undefined || evenFight(total(members), targets, this.settings);
    }
    this.#weighedAt = this.#clock;
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
    this.#near.clear();
    this.#weighedAt = this.#clock;
  }
}
