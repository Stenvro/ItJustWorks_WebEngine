// When combat music plays (observed in the original: its combat manager weighs the combat groups
// every fCombatMusicUpdateTime). The music type is the default object BTMS (MUSCombat), or the
// boss music against a boss: an actor whose reference has the location reference type Boss
// (DOBJ LRTB). Which tracks of it play is the music system's (their conditions ask the combat
// target's keywords: the dragon pieces of MUSCombat).
//
// - **Strength** (the engine's measure for the odds, also GetThreatRatio's: actorStrength in
//   src/ai/combat-ai.ts): an actor's damage × its health / (1 − its armour's reduction).
// - **Which groups count:** a group that searches (all its targets lost), that has no target, or
//   whose members all flee is passed over.
// - **A group against the player** (the player is one of its targets and not lost to it) starts
//   the music by its own members the player detects: the player's strength over theirs below
//   fCombatMusicPlayerTargetedThreatRatio (a mudcrab or a lone wolf does not start it for a
//   player much stronger). Each such group is weighed alone; once the music plays, any of them
//   keeps it.
// - **A group fighting near the player** (not against them) counts only once its fight is even:
//   each group decides it once, fCombatMusicGroupThreatRatioTimer seconds after it forms (the
//   time runs only while it is not searching): its own strength (its members not fleeing) over
//   its targets' between fCombatMusicGroupThreatRatioMin and Max. An even group with a member
//   within fCombatMusicNearCombatInnerRadius of the player adds its strength to those of the
//   others so near; the music starts once the player detects a member of one of them and their
//   sum passes the player's × fCombatMusicPlayerNearStrengthMult. Once it plays, an even group
//   with a member within fCombatMusicNearCombatOuterRadius keeps it. Guards cutting down a
//   mudcrab start nothing.
// - **Stop:** once no group keeps it, it plays on for fCombatMusicStopTime, then ends (with its
//   finale: music.ts); a fight in the meantime keeps it.
//
// fCombatMusicPlayerCombatStrengthCap is a game setting the original never reads. Pure:
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
  /** fCombatMusicGroupThreatRatioMin / Max: the group's strength over its targets', exclusive. */
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

/** A living member of a combat group (the player left out). */
export interface CombatMusicMember {
  /** Its distance from the player (game units). */
  readonly distance: number;
  /** How strong it is (actorStrength). */
  readonly strength: number;
  /** The player detects it. */
  readonly detected: boolean;
  /** Its reference has the location reference type Boss. */
  readonly boss: boolean;
  /** It flees. */
  readonly fleeing: boolean;
}

/** A combat group as the music weighs it. */
export interface CombatMusicGroup {
  readonly id: number;
  readonly members: readonly CombatMusicMember[];
  /** The player is one of its targets. */
  readonly targetsPlayer: boolean;
  /** ...and is lost to it. */
  readonly playerLost: boolean;
  /** It searches (all its targets lost). */
  readonly searching: boolean;
  /** How many targets it has. */
  readonly targets: number;
  /** Its targets' strength (each once; the player's own too). */
  readonly targetStrength: number;
}

export interface CombatMusicInput {
  readonly groups: readonly CombatMusicGroup[];
  /** The player's strength (actorStrength). */
  readonly player: number;
}

export type CombatMusicChoice = 'none' | 'combat' | 'boss';

/** A group's own strength: its members that do not flee. */
export function groupStrength(group: Pick<CombatMusicGroup, 'members'>): number {
  let sum = 0;
  for (const member of group.members) if (!member.fleeing) sum += member.strength;
  return sum;
}

/** Whether the music passes a group over: searching, without targets, or all fleeing. */
function passedOver(group: CombatMusicGroup): boolean {
  if (group.searching || group.targets === 0) return true;
  return group.members.length > 0 && group.members.every((member) => member.fleeing);
}

function choice(groups: readonly CombatMusicGroup[]): CombatMusicChoice {
  return groups.some((group) => group.members.some((member) => member.boss)) ? 'boss' : 'combat';
}

/**
 * Which music the groups call for, before the stop time: none, combat, or the boss music.
 * `even`: whether a group's fight not against the player counts (decided once: CombatMusic).
 */
export function combatMusicWanted(
  input: CombatMusicInput,
  settings: CombatMusicSettings,
  playing: boolean,
  even: (group: number) => boolean = () => true,
): CombatMusicChoice {
  let nearSum = 0;
  let nearDetected = false;
  const near: CombatMusicGroup[] = [];
  const within = (group: CombatMusicGroup, radius: number): boolean =>
    group.members.some((member) => member.distance < radius);
  for (const group of input.groups) {
    if (passedOver(group)) continue;
    if (group.targetsPlayer) {
      if (group.playerLost) continue;
      if (playing) return choice([group]);
      let detected = 0;
      for (const member of group.members) if (member.detected) detected += member.strength;
      if (detected > 0 && input.player / detected < settings.playerTargetedThreatRatio)
        return choice([group]);
      continue;
    }
    if (!even(group.id)) continue;
    if (playing) {
      if (within(group, settings.nearCombatOuterRadius)) return choice([group]);
      continue;
    }
    if (!within(group, settings.nearCombatInnerRadius)) continue;
    if (!nearDetected) nearDetected = group.members.some((member) => member.detected);
    nearSum += groupStrength(group);
    near.push(group);
    if (nearDetected && settings.playerNearStrengthMult * input.player < nearSum)
      return choice(near);
  }
  return 'none';
}

/**
 * Whether a group's fight is even (observed in the original): its own strength over its targets'
 * between fCombatMusicGroupThreatRatioMin and Max, both exclusive; never without targets' strength.
 */
export function evenFight(
  ownStrength: number,
  targetStrength: number,
  settings: CombatMusicSettings,
): boolean {
  if (!(targetStrength > 0)) return false;
  const ratio = ownStrength / targetStrength;
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
   * Each group's evenness: when its timer started (this music's clock; undefined: not yet, it
   * searched), and whether it is even once decided (it is decided once, as the engine's combat
   * groups do).
   */
  readonly #groups = new Map<number, { since: number | undefined; even: boolean | undefined }>();
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
      (group) => this.#groups.get(group)?.even === true,
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
   * Each group's evenness: its timer starts once it does not search; once more than
   * fCombatMusicGroupThreatRatioTimer has passed it is decided, once, by its own strength
   * against its targets'. A group gone forms anew.
   */
  #weighGroups(input: CombatMusicInput): void {
    const present = new Set(input.groups.map((group) => group.id));
    for (const id of this.#groups.keys()) if (!present.has(id)) this.#groups.delete(id);
    for (const group of input.groups) {
      let fight = this.#groups.get(group.id);
      if (!fight) {
        fight = { since: undefined, even: undefined };
        this.#groups.set(group.id, fight);
      }
      if (fight.even !== undefined) continue;
      if (fight.since === undefined) {
        if (group.searching) continue;
        // It began after the last weighing, which did not find it yet.
        fight.since = this.#weighedAt;
      }
      if (this.#clock - fight.since <= this.settings.groupThreatRatioTimer) continue;
      fight.even = evenFight(groupStrength(group), group.targetStrength, this.settings);
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
    this.#groups.clear();
    this.#weighedAt = this.#clock;
  }
}
