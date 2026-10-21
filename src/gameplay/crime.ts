// Crime's rules (docs/gameplay.md, "Crime and factions"): what each crime costs (UESP
// "Skyrim:Crime"; the Creation Kit's Faction Crime tab, its CRVA values or with "Crime Gold: Use
// Defaults" the game settings iCrimeGold*), who learns of it (its witnesses, which detection
// names: a crime is reported unless every witness dies first), the pickpocket chance (the
// fPickPocket* settings), jail (a day per iCrimeDaysInPrisonMod gold of bounty, a skill's
// progress lost each day: UESP "Skyrim:Jail"), what a guard does about a bounty (arrest or
// attack: the CRVA arrest and attack on sight flags, DialogueCrimeGuards' thresholds) and the
// trespass warnings (iGuardWarnings, fAITrespassWarningTimer). Platform-independent.

/** Crime types (CommonLibSSE PackageNS::CRIME_TYPE; OnStoryCrimeGold's aiCrime). */
export const CrimeType = {
  none: -1,
  steal: 0,
  pickpocket: 1,
  trespass: 2,
  attack: 3,
  murder: 4,
  escape: 5,
  werewolf: 6,
} as const;
export type CrimeType = (typeof CrimeType)[keyof typeof CrimeType];

/** The game setting naming each crime type (the HUD and the journal: sCrimeType*). */
export const CRIME_TYPE_SETTINGS: Readonly<Record<number, string>> = {
  [CrimeType.steal]: 'sCrimeTypeSteal',
  [CrimeType.pickpocket]: 'sCrimeTypePickpocket',
  [CrimeType.trespass]: 'sCrimeTypeTrespass',
  [CrimeType.attack]: 'sCrimeTypeAttack',
  [CrimeType.murder]: 'sCrimeTypeMurder',
  [CrimeType.escape]: 'sCrimeTypeEscape',
  [CrimeType.werewolf]: 'sCrimeTypeWerewolf',
};

/** FACT DATA flags of crime (xEdit's TES5 FACT). */
export const CrimeFlag = {
  hiddenFromPlayer: 0x1,
  specialCombat: 0x2,
  trackCrime: 0x40,
  ignoreMurder: 0x80,
  ignoreAssault: 0x100,
  ignoreStealing: 0x200,
  ignoreTrespass: 0x400,
  doNotReportAgainstMembers: 0x800,
  useDefaults: 0x1000,
  ignorePickpocket: 0x2000,
  canBeOwner: 0x8000,
  ignoreWerewolf: 0x10000,
} as const;

/** A crime faction's values: CRVA, or the game settings with "Crime Gold: Use Defaults". */
export interface CrimeValues {
  /** Its guards arrest (else they leave the criminal alone, or attack on sight). */
  readonly arrest: boolean;
  /** Its members attack a criminal on sight (where they do not arrest, or one who resists). */
  readonly attackOnSight: boolean;
  readonly murder: number;
  readonly assault: number;
  readonly trespass: number;
  readonly pickpocket: number;
  /** A theft's bounty: the item's value times this. */
  readonly stealMult: number;
  readonly escape: number;
  readonly werewolf: number;
  /** DATA flags (CrimeFlag): the crimes it ignores, members not reported against. */
  readonly flags: number;
}

/** The game settings crime reads. */
export interface CrimeSettings {
  readonly murder: number;
  readonly attack: number;
  readonly trespass: number;
  readonly pickpocket: number;
  readonly escape: number;
  readonly werewolf: number;
  readonly stealHorse: number;
  readonly daysInPrisonMod: number;
  readonly guardWarnings: number;
  readonly trespassWarningTimer: number;
  readonly pickpocketActorSkillBase: number;
  readonly pickpocketActorSkillMult: number;
  readonly pickpocketTargetSkillBase: number;
  readonly pickpocketTargetSkillMult: number;
  readonly pickpocketWeightMult: number;
  readonly pickpocketAmountMult: number;
  readonly pickpocketMinChance: number;
  readonly pickpocketMaxChance: number;
  readonly pickpocketSkillUsesCurve: number;
  readonly bribeCostCurve: number;
  readonly bribeScale: number;
  readonly bribeSpeechcraftMult: number;
  readonly favorFriend: number;
  readonly favorConfidant: number;
  readonly favorAlly: number;
  readonly favorLover: number;
}

/**
 * Each setting's GMST and the engine's built-in value (used where the load order stores none:
 * BeermotorWB's "All Skyrim Game Settings"; Skyrim.esm stores iCrimeGoldWerewolf,
 * iCrimeGoldStealHorse, iGuardWarnings, fAITrespassWarningTimer, the fPickPocket*, fBribe* and
 * iFavor* settings).
 */
const SETTINGS: readonly (readonly [keyof CrimeSettings, string, number])[] = [
  ['murder', 'iCrimeGoldMurder', 1000],
  ['attack', 'iCrimeGoldAttack', 40],
  ['trespass', 'iCrimeGoldTrespass', 5],
  ['pickpocket', 'iCrimeGoldPickpocket', 25],
  ['escape', 'iCrimeGoldEscape', 100],
  ['werewolf', 'iCrimeGoldWerewolf', 1000],
  ['stealHorse', 'iCrimeGoldStealHorse', 100],
  ['daysInPrisonMod', 'iCrimeDaysInPrisonMod', 100],
  ['guardWarnings', 'iGuardWarnings', 2],
  ['trespassWarningTimer', 'fAITrespassWarningTimer', 5],
  ['pickpocketActorSkillBase', 'fPickPocketActorSkillBase', 20],
  ['pickpocketActorSkillMult', 'fPickPocketActorSkillMult', 1],
  ['pickpocketTargetSkillBase', 'fPickPocketTargetSkillBase', 20],
  ['pickpocketTargetSkillMult', 'fPickPocketTargetSkillMult', -0.25],
  ['pickpocketWeightMult', 'fPickPocketWeightMult', -4],
  ['pickpocketAmountMult', 'fPickPocketAmountMult', -0.1],
  ['pickpocketMinChance', 'fPickPocketMinChance', 0],
  ['pickpocketMaxChance', 'fPickPocketMaxChance', 90],
  ['pickpocketSkillUsesCurve', 'fPickpocketSkillUsesCurve', 0.8],
  ['bribeCostCurve', 'fBribeCostCurve', 1.4],
  ['bribeScale', 'fBribeScale', 0.5],
  ['bribeSpeechcraftMult', 'fBribeSpeechcraftMult', 0.1],
  ['favorFriend', 'iFavorFriendValue', 25],
  ['favorConfidant', 'iFavorConfidantValue', 50],
  ['favorAlly', 'iFavorAllyValue', 100],
  ['favorLover', 'iFavorLoverValue', 500],
];

/** The game settings crime reads, with their GMSTs and built-in values (tools). */
export function crimeSettingNames(): readonly (readonly [string, number])[] {
  return SETTINGS.map(([, gmst, value]) => [gmst, value] as const);
}

/** Crime's settings: the load order's values, else the engine's built-in ones. */
export function readCrimeSettings(settings?: {
  number(editorId: string): number | undefined;
}): CrimeSettings {
  return Object.fromEntries(
    SETTINGS.map(([key, gmst, value]) => [key, settings?.number(gmst) ?? value]),
  ) as unknown as CrimeSettings;
}

/**
 * A theft's multiplier where a faction uses the defaults: half the item's value (UESP
 * "Skyrim:Crime": theft costs half the stolen item's value; every hold's CRVA stores 0.5).
 */
export const DEFAULT_STEAL_MULT = 0.5;

/** The CRVA fields of a crime faction (FactionCrime) as crime reads them. */
export interface CrimeRecordValues {
  readonly arrest: boolean;
  readonly attackOnSight: boolean;
  readonly murder: number;
  readonly assault: number;
  readonly trespass: number;
  readonly pickpocket: number;
  readonly stealMult: number;
  readonly escape: number;
  readonly werewolf: number;
}

/**
 * A crime faction's values: its CRVA, or with "Crime Gold: Use Defaults" (DATA 0x1000) the game
 * settings (the arrest and attack on sight flags stay its own). A faction without crime data
 * neither arrests nor attacks and charges the defaults.
 */
export function crimeValues(
  flags: number,
  record: CrimeRecordValues | undefined,
  settings: CrimeSettings,
): CrimeValues {
  const defaults = !record || (flags & CrimeFlag.useDefaults) !== 0;
  return {
    arrest: record?.arrest ?? false,
    attackOnSight: record?.attackOnSight ?? false,
    murder: defaults ? settings.murder : record.murder,
    assault: defaults ? settings.attack : record.assault,
    trespass: defaults ? settings.trespass : record.trespass,
    pickpocket: defaults ? settings.pickpocket : record.pickpocket,
    stealMult: defaults ? DEFAULT_STEAL_MULT : record.stealMult,
    escape: defaults ? settings.escape : record.escape,
    werewolf: defaults ? settings.werewolf : record.werewolf,
    flags,
  };
}

/** Whether a crime faction ignores a crime type (its DATA flags). */
export function ignoresCrime(values: Pick<CrimeValues, 'flags'>, type: CrimeType): boolean {
  const flag =
    type === CrimeType.murder
      ? CrimeFlag.ignoreMurder
      : type === CrimeType.attack
        ? CrimeFlag.ignoreAssault
        : type === CrimeType.steal
          ? CrimeFlag.ignoreStealing
          : type === CrimeType.trespass
            ? CrimeFlag.ignoreTrespass
            : type === CrimeType.pickpocket
              ? CrimeFlag.ignorePickpocket
              : type === CrimeType.werewolf
                ? CrimeFlag.ignoreWerewolf
                : 0;
  return (values.flags & flag) !== 0;
}

/**
 * Violent crimes go to the violent crime gold (GetCrimeGoldViolent): assault and murder, and a
 * werewolf seen changing. TODO(M13): whether the engine counts the werewolf as violent.
 */
export function isViolent(type: CrimeType): boolean {
  return type === CrimeType.attack || type === CrimeType.murder || type === CrimeType.werewolf;
}

/**
 * A crime's bounty: its faction's value for the type; a theft its multiplier times the stolen
 * items' value (rounded down, at least 1 for anything of value), a horse iCrimeGoldStealHorse.
 * 0 where the faction ignores it. TODO(M13): the engine's rounding.
 */
export function crimeBounty(
  type: CrimeType,
  values: CrimeValues,
  options: {
    readonly value?: number;
    readonly horse?: boolean;
    readonly settings?: CrimeSettings;
  } = {},
): number {
  if (ignoresCrime(values, type)) return 0;
  switch (type) {
    case CrimeType.steal: {
      if (options.horse) return options.settings?.stealHorse ?? 100;
      const value = Math.max(0, options.value ?? 0);
      return value > 0 ? Math.max(1, Math.floor(value * values.stealMult)) : 0;
    }
    case CrimeType.pickpocket:
      return values.pickpocket;
    case CrimeType.trespass:
      return values.trespass;
    case CrimeType.attack:
      return values.assault;
    case CrimeType.murder:
      return values.murder;
    case CrimeType.escape:
      return values.escape;
    case CrimeType.werewolf:
      return values.werewolf;
    default:
      return 0;
  }
}

// --- Pickpocketing ------------------------------------------------------------------------

/** What a pickpocket attempt weighs. */
export interface PickpocketAttempt {
  /** The thief's Pickpocket skill. */
  readonly skill: number;
  /** The target's Pickpocket skill (how well it guards its pockets). */
  readonly targetSkill: number;
  /** The items taken (or placed): their weight and value, all of them. */
  readonly weight: number;
  readonly value: number;
  /**
   * A factor on the chance (1: none). The running game gives the chance itself to the perks'
   * Mod Pickpocket Chance entry point (Light Fingers, Night Thief, Cutpurse, Keymaster; the
   * crime engine: pickpocketBaseChance, then boundedPickpocketChance).
   */
  readonly perkMult?: number;
}

/**
 * The chance (percent) a pickpocket attempt succeeds. The terms are the fPickPocket* settings'
 * (UESP "Skyrim:Pickpocket": the thief's skill raises it, the target's skill, the weight and the
 * value lower it): (ActorSkillBase + ActorSkillMult × skill) + TargetSkillMult × (TargetSkillBase
 * + target's skill) + WeightMult × weight + AmountMult × value, times the perks, within
 * fPickPocketMinChance and fPickPocketMaxChance. TODO(M13): the engine's exact combination of
 * the terms is not documented; this reads them as sums of their base and multiplier.
 */
export function pickpocketChance(attempt: PickpocketAttempt, settings: CrimeSettings): number {
  return boundedPickpocketChance(
    pickpocketBaseChance(attempt, settings) * (attempt.perkMult ?? 1),
    settings,
  );
}

/** The chance (percent) before the perks and the limits (see pickpocketChance). */
export function pickpocketBaseChance(attempt: PickpocketAttempt, settings: CrimeSettings): number {
  const thief =
    settings.pickpocketActorSkillBase + settings.pickpocketActorSkillMult * attempt.skill;
  const target =
    settings.pickpocketTargetSkillMult * (settings.pickpocketTargetSkillBase + attempt.targetSkill);
  const load =
    settings.pickpocketWeightMult * Math.max(0, attempt.weight) +
    settings.pickpocketAmountMult * Math.max(0, attempt.value);
  return thief + target + load;
}

/** A chance (percent) within fPickPocketMinChance and fPickPocketMaxChance, rounded. */
export function boundedPickpocketChance(chance: number, settings: CrimeSettings): number {
  return Math.round(
    Math.min(settings.pickpocketMaxChance, Math.max(settings.pickpocketMinChance, chance)),
  );
}

/**
 * Pickpocket uses of a successful theft: the value taken to fPickpocketSkillUsesCurve, at least
 * one. TODO(M13): the engine's use of the curve is not documented.
 */
export function pickpocketUses(value: number, settings: CrimeSettings): number {
  return Math.max(1, Math.max(0, value) ** settings.pickpocketSkillUsesCurve);
}

// --- Jail ---------------------------------------------------------------------------------

/** Days in jail for a bounty: one per iCrimeDaysInPrisonMod gold, at least one (UESP "Jail"). */
export function jailDays(bounty: number, settings: Pick<CrimeSettings, 'daysInPrisonMod'>): number {
  return Math.max(1, Math.floor(Math.max(0, bounty) / Math.max(1, settings.daysInPrisonMod)));
}

/**
 * The skills that lose their progress towards their next level for a stay in jail (UESP
 * "Skyrim:Jail": since patch 1.9 a skill's progress is lost for each day, its level kept): one
 * skill a day, picked at random among those with progress (each once). TODO(M13): the engine's
 * choice of skills.
 */
export function jailSkillLosses(
  days: number,
  progressed: readonly number[],
  random: () => number,
): number[] {
  const left = [...progressed];
  const lost: number[] = [];
  for (let day = 0; day < days && left.length > 0; day++) {
    const index = Math.min(left.length - 1, Math.floor(random() * left.length));
    const [skill] = left.splice(index, 1);
    if (skill !== undefined) lost.push(skill);
  }
  return lost;
}

// --- Guards -------------------------------------------------------------------------------

/** What a guard does about a criminal: nothing, arrest them (a force greet), or attack. */
export type GuardResponse = 'none' | 'arrest' | 'attack';

/** What a guard weighs about the player. */
export interface GuardSituation {
  /** The player's crime gold with the guard's crime faction. */
  readonly violent: number;
  readonly nonviolent: number;
  /** The guard was alarmed by a crime (it pursues: GetAlarmed). */
  readonly alarmed: boolean;
  /** The player resisted arrest by this faction (SetPlayerResistingArrest). */
  readonly resisting: boolean;
  /** The faction made the player its enemy (SetPlayerEnemy). */
  readonly enemy: boolean;
  readonly values: Pick<CrimeValues, 'arrest' | 'attackOnSight'>;
  /**
   * The globals CrimeArrestOnSightViolentThreshold (999) and ...NonViolentThreshold (1000):
   * at these a guard confronts the player on sight, without a fresh crime.
   */
  readonly violentThreshold: number;
  readonly nonviolentThreshold: number;
}

/**
 * A guard's response (UESP "Skyrim:Crime"; DialogueCrimeGuards' conditions read the same
 * thresholds): an enemy or one resisting arrest is attacked; a bounty is pursued when the guard
 * was alarmed by a crime, or on sight at the thresholds: arrested where the faction arrests,
 * else attacked where it attacks on sight. TODO(M13): the engine's own rule.
 */
export function guardResponse(situation: GuardSituation): GuardResponse {
  const { values } = situation;
  if (situation.enemy || situation.resisting) return 'attack';
  const bounty = situation.violent + situation.nonviolent;
  if (bounty <= 0) return 'none';
  const wanted =
    situation.alarmed ||
    situation.violent >= situation.violentThreshold ||
    situation.nonviolent >= situation.nonviolentThreshold;
  if (!wanted) return 'none';
  if (values.arrest) return 'arrest';
  return values.attackOnSight ? 'attack' : 'none';
}

/**
 * The gold a bribe takes (GetBribeAmount): fBribeScale × 10 × level ^ fBribeCostCurve, less
 * fBribeSpeechcraftMult percent per Speech point, plus the bounty a guard is to overlook.
 * TODO(M13): the engine's formula is not documented; this uses its settings' names.
 */
export function bribeAmount(
  level: number,
  speech: number,
  bounty: number,
  settings: Pick<CrimeSettings, 'bribeCostCurve' | 'bribeScale' | 'bribeSpeechcraftMult'>,
): number {
  const base = settings.bribeScale * 10 * Math.max(1, level) ** settings.bribeCostCurve;
  const discount = Math.min(
    0.9,
    (Math.min(100, Math.max(0, speech)) * settings.bribeSpeechcraftMult) / 100,
  );
  return Math.max(1, Math.round(base * (1 - discount) + Math.max(0, bounty)));
}

// --- Trespassing --------------------------------------------------------------------------

/**
 * One trespasser's warnings (GetTrespassWarningLevel): those who notice them warn them (their
 * Trespass lines) every fAITrespassWarningTimer seconds; after iGuardWarnings warnings, still
 * there, it is the crime. Returns per `tick` what happens: a warning, the crime, or nothing.
 */
export class TrespassWarnings {
  #level = 0;
  #last = -Infinity;
  #reported = false;

  /** The warnings given so far (GetTrespassWarningLevel). */
  get level(): number {
    return this.#level;
  }

  /**
   * The trespasser is seen at `now` (seconds) by one who may warn them: 'warn' when a warning
   * is due, 'crime' once the warnings are used up (once), else 'none'.
   */
  seen(
    now: number,
    settings: Pick<CrimeSettings, 'guardWarnings' | 'trespassWarningTimer'>,
  ): 'warn' | 'crime' | 'none' {
    if (this.#reported || now - this.#last < settings.trespassWarningTimer) return 'none';
    this.#last = now;
    if (this.#level < settings.guardWarnings) {
      this.#level++;
      return 'warn';
    }
    this.#reported = true;
    return 'crime';
  }

  /** The trespasser left: the warnings start again next time. */
  reset(): void {
    this.#level = 0;
    this.#last = -Infinity;
    this.#reported = false;
  }
}

// --- Witnesses and reports ----------------------------------------------------------------

/** A crime the ledger keeps until it is reported or forgiven. */
export interface Crime {
  readonly id: number;
  readonly type: CrimeType;
  readonly criminal: number;
  readonly victim: number | undefined;
  /** The crime faction whose bounty it is (undefined: none takes it). */
  readonly faction: number | undefined;
  /** Its bounty, and whether violent. */
  readonly gold: number;
  readonly violent: boolean;
  /** Those who saw it, alive. */
  readonly witnesses: Set<number>;
  /** When it was committed (game hours). */
  readonly at: number;
  /** Reported: it stays on the criminal's bounty whatever becomes of the witnesses. */
  reported: boolean;
}

/**
 * How long a crime waits to be reported (game hours): until then killing its last witness
 * takes its bounty back (UESP "Skyrim:Crime": kill every witness and the bounty is gone; the
 * game's sWitnessKilled, "Last witness killed."). TODO(M13): the engine's report rule.
 */
export const REPORT_HOURS = 24;

/** The crimes committed and not yet reported or forgiven, and the ones known (GetCrimeKnown). */
export class CrimeLedger {
  #next = 1;
  readonly #open = new Map<number, Crime>();
  /** Known crimes by "type:criminal:victim". */
  readonly #known = new Set<string>();

  /** A crime seen by `witnesses` (none: unseen, it is not recorded). */
  commit(
    entry: Omit<Crime, 'id' | 'reported' | 'witnesses'> & { witnesses: Iterable<number> },
  ): Crime | undefined {
    const witnesses = new Set(entry.witnesses);
    witnesses.delete(entry.criminal);
    if (witnesses.size === 0) return undefined;
    const crime: Crime = { ...entry, id: this.#next++, witnesses, reported: false };
    this.#open.set(crime.id, crime);
    this.#known.add(knownKey(crime.type, crime.criminal, crime.victim));
    return crime;
  }

  /** A crime is reported (a guard saw it, or its time passed): it is no longer open. */
  report(id: number): void {
    const crime = this.#open.get(id);
    if (!crime) return;
    crime.reported = true;
    this.#open.delete(id);
  }

  /** Crimes reported now: those older than REPORT_HOURS, and those a guard witnessed. */
  expire(now: number, isGuard: (actor: number) => boolean = () => false): Crime[] {
    const reported: Crime[] = [];
    for (const crime of this.#open.values()) {
      if (now - crime.at < REPORT_HOURS && ![...crime.witnesses].some(isGuard)) continue;
      reported.push(crime);
    }
    for (const crime of reported) this.report(crime.id);
    return reported;
  }

  /**
   * A witness died: the open crimes it was the last witness of are forgiven (returned: their
   * bounties go back).
   */
  witnessDied(actor: number): Crime[] {
    const forgiven: Crime[] = [];
    for (const crime of this.#open.values()) {
      if (!crime.witnesses.delete(actor) || crime.witnesses.size > 0) continue;
      forgiven.push(crime);
    }
    for (const crime of forgiven) {
      this.#open.delete(crime.id);
      this.#known.delete(knownKey(crime.type, crime.criminal, crime.victim));
    }
    return forgiven;
  }

  /** A faction's open crimes are settled (the bounty paid or served): they are closed. */
  settle(faction: number): void {
    for (const crime of [...this.#open.values()])
      if (crime.faction === faction) this.report(crime.id);
  }

  /** The open crimes (not yet reported). */
  open(): Iterable<Crime> {
    return this.#open.values();
  }

  /** GetCrimeKnown: a crime of the type by the criminal against the victim is known. */
  known(type: CrimeType, criminal: number, victim: number | undefined): boolean {
    return this.#known.has(knownKey(type, criminal, victim));
  }
}

const knownKey = (type: number, criminal: number, victim: number | undefined): string =>
  `${String(type)}:${String(criminal)}:${String(victim ?? 0)}`;
