// When combat music plays (CommonLibSSE CombatManager: its music start time, stop timer and
// update timer). The music type is the default object BTMS (MUSCombat), or the boss music
// against a boss: an actor whose reference has the location reference type Boss (DOBJ LRTB).
// Which tracks of it play is the music system's (their conditions ask the combat target's
// keywords: the dragon pieces of MUSCombat).
//
// - **Start:** the fights that count are those against the player and those within the near-
//   combat radius of them (a follower's fight, a dragon over the town). Music starts only if
//   they are worth it: their strength against the player's side (the player and their allies,
//   the combat AI's GetThreatRatio) at least fCombatMusicPlayerTargetedThreatRatio (1 in
//   Skyrim.esm). A mudcrab does not start it for a strong player.
// - **On:** once it plays, it plays as long as a fight counts (the odds may turn).
// - **Stop:** once no fight counts, it plays on for the stop delay, then ends (with its finale:
//   music.ts); a fight in the meantime keeps it.
//
// Settings no plugin names (the near-combat radius, the stop delay) keep our values:
// TODO(M13): the engine's built-in names and values. Pure: src/shell/actor-combat.ts feeds it.

import { threatRatio } from '../ai/combat-ai.ts';

export interface CombatMusicSettings {
  /** fCombatMusicPlayerTargetedThreatRatio: the odds a fight must reach to start the music. */
  readonly playerTargetedThreatRatio: number;
  /** A fight not against the player counts within this distance of them (game units). */
  readonly nearCombatRadius: number;
  /** Seconds the music plays on once no fight counts. */
  readonly stopDelay: number;
}

const SETTINGS: readonly (readonly [keyof CombatMusicSettings, string | undefined, number])[] = [
  ['playerTargetedThreatRatio', 'fCombatMusicPlayerTargetedThreatRatio', 1],
  ['nearCombatRadius', undefined, 2048],
  ['stopDelay', undefined, 4],
];

export function readCombatMusicSettings(
  number: (editorId: string) => number | undefined = () => undefined,
): CombatMusicSettings {
  return Object.fromEntries(
    SETTINGS.map(([key, name, fallback]) => [
      key,
      (name === undefined ? undefined : number(name)) ?? fallback,
    ]),
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
  /** Its reference has the location reference type Boss. */
  readonly boss: boolean;
}

export interface CombatMusicInput {
  readonly threats: readonly CombatMusicThreat[];
  /** The strengths of the player and their allies. */
  readonly side: readonly number[];
}

export type CombatMusicChoice = 'none' | 'combat' | 'boss';

/** The fights that count: against the player, or near them. */
function counted(input: CombatMusicInput, settings: CombatMusicSettings): CombatMusicThreat[] {
  return input.threats.filter(
    (threat) => threat.targetsPlayer || threat.distance <= settings.nearCombatRadius,
  );
}

/** Which music the fights call for, before the stop delay: none, combat, or the boss music. */
export function combatMusicWanted(
  input: CombatMusicInput,
  settings: CombatMusicSettings,
  playing: boolean,
): CombatMusicChoice {
  const threats = counted(input, settings);
  if (threats.length === 0) return 'none';
  if (!playing) {
    const ratio = threatRatio(
      threats.map((threat) => threat.strength),
      input.side,
    );
    if (ratio < settings.playerTargetedThreatRatio) return 'none';
  }
  return threats.some((threat) => threat.boss) ? 'boss' : 'combat';
}

/** The combat music's state from frame to frame. */
export class CombatMusic {
  /** What plays now. */
  playing: CombatMusicChoice = 'none';
  /** Seconds since no fight counted (while it still plays). */
  #quiet = 0;

  settings: CombatMusicSettings;

  constructor(settings: CombatMusicSettings = COMBAT_MUSIC_DEFAULTS) {
    this.settings = settings;
  }

  /** One frame (`seconds` of the world's time): what should play now. */
  update(seconds: number, input: CombatMusicInput): CombatMusicChoice {
    const wanted = combatMusicWanted(input, this.settings, this.playing !== 'none');
    if (wanted !== 'none') {
      this.#quiet = 0;
      this.playing = wanted;
    } else if (this.playing !== 'none') {
      this.#quiet += seconds;
      if (this.#quiet >= this.settings.stopDelay) {
        this.playing = 'none';
        this.#quiet = 0;
      }
    }
    return this.playing;
  }

  /** The fight is over at once (the player died, the world was left). */
  reset(): void {
    this.playing = 'none';
    this.#quiet = 0;
  }
}
