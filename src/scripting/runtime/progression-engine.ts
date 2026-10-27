// The player's progression and every actor's values over time in the running game, on the
// rules of src/gameplay/progression.ts (skills and levels), actor-leveling.ts (encounter zones,
// leveled and auto-calculated actors) and vitals.ts (regeneration, stamina costs):
//
// - Skills: useSkill(actor, skill, use) is what every system calls when the player uses a skill
//   (combat: hits, blocks, armor hit; magic: a spell's base cost; sneaking; lockpicking;
//   speech: bartering, persuading; crafting), in the game's units of use (docs/gameplay.md);
//   incrementSkill raises a skill as books, trainers and Game.IncrementSkill do. Only the
//   player's skills rise (NPCs' follow their class and level). A skill rising tells the HUD
//   (sSkillIncreased, UISkillIncreaseSD, the level meter) and the story manager (SKIL).
// - The player's level: experience from skill levels; a level-up waits (GameState.levelUps,
//   sLevelUpAvailable) until the level-up menu's choice (levelUp), which sends the story
//   manager's LEVL. Perks: perkAvailability / takePerk (a perk point, the perk's playable flag,
//   its previous rank, its place in its skill's tree, its level and conditions).
// - Levels: an actor's encounter zone (its own XEZN, its cell's, its cell's location's or a parent
//   location's ECZN, its worldspace's), the zone's level set as first met, the level its
//   leveled lists are picked at (kept per reference: its look and its scripts agree), the level
//   of actors following the player's (the player's for its teammates, the zone's else), and
//   auto-calculated stats (the actor engine's record values).
// - Vitals: update() regenerates every actor's health, magicka and stamina, drains the player's
//   stamina while sprinting; spend() is what costs (power attacks, bashes, blocking, spells)
//   take, canSprint / canPowerAttack what 0 stamina forbids, refused() blinks the HUD's meter.
//
// Platform-independent. Notes: docs/gameplay.md ("Skills, levels and actor values").

import { RaceAiFlag } from '../../ai/race-combat-records.ts';
import { EntryPoint } from '../../gameplay/perk-entry-points.ts';
import {
  actorLevel,
  autoCalcStats,
  leveledPickLevel,
  levelingSettings,
  SKILL_CAP,
  zoneLevel,
  type AutoCalcStats,
  type LevelingSettings,
} from '../../gameplay/actor-leveling.ts';
import {
  advanceSkill,
  characterExperience,
  levelFraction,
  levelThreshold,
  levelUpsWaiting,
  progressionSettings,
  skillFraction,
  skillThreshold,
  skillUseExperience,
  type ProgressionSettings,
  type SkillCurve,
} from '../../gameplay/progression.ts';
import {
  bashCost,
  blockCost,
  powerAttackCost,
  regenPerSecond,
  spendDelay,
  sprintDrain,
  vitalSettings,
  type Vital,
  type VitalSettings,
} from '../../gameplay/vitals.ts';
import { NpcFlag } from '../../world/actor-records.ts';
import {
  ActorValue,
  actorValueIndex,
  actorValueName,
  SKILL_COUNT,
} from '../../world/actor-values.ts';
import { parseItem } from '../../world/item-records.ts';
import {
  levelModifier,
  parseClassStats,
  parseEncounterZone,
  type ClassStats,
} from '../../world/leveling-records.ts';
import { parsePerk, type PerkRecord } from '../../world/perk-records.ts';
import { parseSkill } from '../../world/perk-trees.ts';
import type { ActorInfo } from './actor-engine.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

/** A skill of the player rose: what the HUD announces. */
export interface SkillIncrease {
  readonly skill: number;
  /** Its name (the AVIF's FULL) and the message (sSkillIncreased: "%s Increased to %i"). */
  readonly name: string;
  readonly text: string;
  readonly level: number;
  /** The player's level and its progress before and after (0..1; 1: a level-up waits). */
  readonly playerLevel: number;
  readonly from: number;
  readonly to: number;
}

/** What the engine tells the HUD (src/shell/hud-controller.ts). */
export interface ProgressionListener {
  skillIncreased?(increase: SkillIncrease): void;
  /** The player lacked magicka or stamina for what it tried: that meter blinks. */
  meterBlink?(meter: 'magicka' | 'stamina'): void;
}

/** Why a perk can or cannot be taken now. */
export type PerkAvailability =
  | 'available'
  | 'owned'
  | 'notPlayable'
  | 'previousRank'
  | 'locked'
  | 'requirements'
  | 'noPoints'
  | 'unknown';

interface PerkPlace {
  /** The skill (actor value) whose tree it is in. */
  readonly skill: number;
  /** The rank before it (NNAM leads here), if it is a later rank. */
  readonly previous: number | undefined;
  /** The first ranks of the perks its tree node follows (none: it starts the tree). */
  readonly parents: readonly number[];
}

interface Settings {
  readonly progression: ProgressionSettings;
  readonly leveling: LevelingSettings;
  readonly vitals: VitalSettings;
}

/** Regeneration runs this often (s). */
const TICK_SECONDS = 0.1;
/** The worn weight is read again after this long (s). */
const WEIGHT_SECONDS = 1;
/** The regenerating values and their rates' actor values. */
const VITALS: readonly { av: number; rate: number; mult: number; vital: Vital }[] = [
  { av: ActorValue.health, rate: ActorValue.healRate, mult: ActorValue.healRateMult, vital: 0 },
  {
    av: ActorValue.magicka,
    rate: ActorValue.magickaRate,
    mult: ActorValue.magickaRateMult,
    vital: 1,
  },
  {
    av: ActorValue.stamina,
    rate: ActorValue.staminaRate,
    mult: ActorValue.staminaRateMult,
    vital: 2,
  },
];
/** CombatHealthRegenMult (UESP "Actor Value Indices"). */
const COMBAT_HEALTH_REGEN_MULT = 134;

const isSkill = (index: number): boolean =>
  index >= ActorValue.firstSkill && index < ActorValue.firstSkill + SKILL_COUNT;

/** A skill's SkillAdvance actor value (% more experience): "OneHandedSkillAdvance", ... */
const advanceValue = (skill: number): number | undefined =>
  actorValueIndex(`${actorValueName(skill)}SkillAdvance`);

/** Reads the settings a rule asks for from the game's (GMSTs), once. */
async function readSettings<T>(
  runtime: ScriptRuntime,
  make: (number: (editorId: string) => number | undefined) => T,
): Promise<T> {
  const names: string[] = [];
  make((name) => {
    names.push(name);
    return undefined;
  });
  const values = new Map<string, number>();
  for (const name of names) {
    const value = await runtime.gameSetting(name);
    if (typeof value === 'number') values.set(name, value);
  }
  return make((name) => values.get(name));
}

export class ProgressionEngine {
  readonly #runtime: ScriptRuntime;
  /** Who hears of skill increases and blinking meters (the HUD in Play). */
  listener: ProgressionListener | undefined;
  /**
   * Whether an actor is in combat now (the combat system's state: src/shell/actor-combat.ts,
   * WorldBridge.combat): its regeneration slows.
   */
  inCombat: (actor: number) => boolean = (actor) =>
    this.#runtime.world.combat?.(actor)?.inCombat === true;
  #settings: Promise<Settings> | undefined;
  readonly #curves = new Map<number, Promise<SkillCurve | undefined>>();
  readonly #classes = new Map<number, Promise<ClassStats | undefined>>();
  readonly #perks = new Map<number, Promise<PerkRecord | undefined>>();
  #perkPlaces: Promise<Map<number, PerkPlace>> | undefined;
  #zonesByLocation: Promise<Map<number, number>> | undefined;
  readonly #autoCalc = new Map<number, { key: string; stats: AutoCalcStats }>();
  /** Seconds before a value regenerates again ("reference:vital"), and its damage last seen. */
  readonly #delays = new Map<string, number>();
  readonly #seen = new Map<string, number>();
  /** The player's stamina now, as last read (canSprint answers at once). */
  #stamina: number | undefined;
  #pending = 0;
  #busy = false;
  #weight = { at: -Infinity, weight: 0 };

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  /** The game settings the rules read (GMSTs), once. */
  settings(): Promise<Settings> {
    this.#settings ??= (async () => ({
      progression: await readSettings(this.#runtime, progressionSettings),
      leveling: await readSettings(this.#runtime, levelingSettings),
      vitals: await readSettings(this.#runtime, vitalSettings),
    }))();
    return this.#settings;
  }

  // --- Skills ----------------------------------------------------------------------------------

  /** A skill by actor value index or name ("OneHanded", "Speechcraft", "Marksman"). */
  skillIndex(skill: number | string): number | undefined {
    const index = typeof skill === 'number' ? skill : actorValueIndex(skill);
    return index !== undefined && isSkill(index) ? index : undefined;
  }

  /** A skill's use and improvement (its AVIF AVSK). */
  curve(skill: number): Promise<SkillCurve | undefined> {
    let pending = this.#curves.get(skill);
    if (!pending) {
      pending = this.#runtime.forms
        .actorValueForm(skill)
        .then((record) => (record ? parseSkill(record).use : undefined));
      this.#curves.set(skill, pending);
    }
    return pending;
  }

  /**
   * An actor used a skill `use` times (in the game's units: docs/gameplay.md): the player gains
   * its experience (others' skills do not rise by use).
   */
  async useSkill(actor: number, skill: number | string, use: number): Promise<void> {
    const index = this.skillIndex(skill);
    if (actor !== PLAYER_REF || index === undefined || !(use > 0)) return;
    const curve = await this.curve(index);
    if (!curve) return;
    // The perks change it (Mod Skill Use: the Rested bonuses, Lover's Comfort).
    const used = await this.#runtime.perks.apply(EntryPoint.modSkillUse, actor, use, [], {
      advanceSkill: index,
    });
    const experience = skillUseExperience(used, curve, await this.#advancePercent(index));
    await this.#addSkillExperience(index, experience, curve);
  }

  /**
   * The player's skill rises `count` levels as a book, a trainer or Game.IncrementSkill raises
   * it: each time the experience it lacks to its next level (more by its SkillAdvance), the rest
   * kept toward the one after.
   */
  async incrementSkill(skill: number | string, count = 1): Promise<void> {
    const index = this.skillIndex(skill);
    if (index === undefined) return;
    const curve = await this.curve(index);
    if (!curve) return;
    const settings = (await this.settings()).progression;
    for (let i = 0; i < count; i++) {
      const level = await this.#skillLevel(index);
      if (level >= SKILL_CAP) return;
      const lacking =
        skillThreshold(level, curve, settings) -
        (this.#runtime.state.skillExperience.get(index) ?? 0);
      const bonus = 1 + (await this.#advancePercent(index)) / 100;
      await this.#addSkillExperience(index, Math.max(0, lacking) * Math.max(1, bonus), curve);
    }
  }

  /** The player's skill level (its base: fortified or damaged skills rise as their base). */
  async #skillLevel(skill: number): Promise<number> {
    return Math.floor((await this.#runtime.actors.value(PLAYER_REF, skill)).base);
  }

  async #advancePercent(skill: number): Promise<number> {
    const advance = advanceValue(skill);
    return advance === undefined
      ? 0
      : (await this.#runtime.actors.value(PLAYER_REF, advance)).current;
  }

  async #addSkillExperience(skill: number, experience: number, curve: SkillCurve): Promise<void> {
    const runtime = this.#runtime;
    const state = runtime.state;
    const settings = (await this.settings()).progression;
    const level = await this.#skillLevel(skill);
    const result = advanceSkill(
      { level, experience: state.skillExperience.get(skill) ?? 0 },
      experience,
      curve,
      settings,
    );
    state.skillExperience.set(skill, result.experience);
    if (result.reached.length === 0) return;
    runtime.actors.setBase(PLAYER_REF, skill, result.level);
    const name = (await runtime.forms.actorValueForm(skill))?.text('FULL') ?? '';
    const format = await runtime.gameSetting('sSkillIncreased');
    const playerLevel = await runtime.actors.playerLevel();
    for (const reached of result.reached) {
      // Each level a skill gains is a Skill Increase (the stats).
      runtime.incrementStat('Skill Increases');
      const from = levelFraction(playerLevel, state.playerExperience, settings);
      state.playerExperience += characterExperience(reached, settings);
      const to = levelFraction(playerLevel, state.playerExperience, settings);
      this.listener?.skillIncreased?.({
        skill,
        name,
        text: (typeof format === 'string' ? format : '%s Increased to %i')
          .replace('%s', name)
          .replace('%i', String(reached)),
        level: reached,
        playerLevel,
        from,
        to,
      });
      // The story manager's Increase Skill (OnStoryIncreaseSkill(asSkill)).
      runtime.detach(
        runtime.storyManager.event({
          type: 'SKIL',
          forms: new Map(),
          values: new Map([['V1', skill]]),
          args: [actorValueName(skill)],
        }),
      );
    }
    await this.#refreshLevelUps(true);
  }

  /** How far the player's skill is toward its next level (0..1). */
  async skillProgress(skill: number): Promise<number> {
    const curve = await this.curve(skill);
    if (!curve) return 0;
    return skillFraction(
      {
        level: await this.#skillLevel(skill),
        experience: this.#runtime.state.skillExperience.get(skill) ?? 0,
      },
      curve,
      (await this.settings()).progression,
    );
  }

  /**
   * Makes the player's skill Legendary (its base at 100 or more): back to
   * fLegendarySkillResetValue, its experience gone, the perks of its tree taken away and given
   * back as points (their count). Undefined: it cannot be made Legendary.
   */
  async makeLegendary(skill: number): Promise<number | undefined> {
    const runtime = this.#runtime;
    if (!isSkill(skill) || (await this.#skillLevel(skill)) < SKILL_CAP) return undefined;
    let returned = 0;
    for (const [perk, place] of await this.#places()) {
      if (place.skill !== skill || !(await runtime.actors.hasPerk(PLAYER_REF, perk))) continue;
      await runtime.perks.remove(PLAYER_REF, perk);
      returned++;
    }
    runtime.perkPoints += returned;
    runtime.actors.setBase(
      PLAYER_REF,
      skill,
      (await this.settings()).progression.legendaryResetValue,
    );
    runtime.state.skillExperience.set(skill, 0);
    runtime.state.legendary.set(skill, (runtime.state.legendary.get(skill) ?? 0) + 1);
    return returned;
  }

  // --- The player's level -------------------------------------------------------------------

  /** How far the player is toward the next level (0..1; 1 while a level-up waits). */
  async levelProgress(): Promise<number> {
    return levelFraction(
      await this.#runtime.actors.playerLevel(),
      this.#runtime.state.playerExperience,
      (await this.settings()).progression,
    );
  }

  /** The level-ups waiting now (and, `announce`d, sLevelUpAvailable for a new one). */
  async #refreshLevelUps(announce: boolean): Promise<void> {
    const runtime = this.#runtime;
    const state = runtime.state;
    const waiting = levelUpsWaiting(
      await runtime.actors.playerLevel(),
      state.playerExperience,
      (await this.settings()).progression,
    );
    if (announce && waiting > state.levelUps) {
      const text = await runtime.gameSetting('sLevelUpAvailable');
      if (typeof text === 'string' && text !== '') runtime.world.notification?.(text);
    }
    state.levelUps = waiting;
  }

  /**
   * The level-up menu's choice: health, magicka or stamina +iAVDhmsLevelUp (stamina also carry
   * weight +fLevelUpCarryWeightMod), the next level, a perk point, health, magicka and stamina
   * restored (UESP "Leveling"), the story manager's Increase Level. False: none waits.
   */
  async levelUp(attribute: number): Promise<boolean> {
    const runtime = this.#runtime;
    const state = runtime.state;
    const actors = runtime.actors;
    await this.#refreshLevelUps(false);
    if (state.levelUps <= 0) return false;
    const settings = (await this.settings()).progression;
    const raise = async (index: number, amount: number): Promise<void> => {
      actors.setBase(PLAYER_REF, index, (await actors.value(PLAYER_REF, index)).base + amount);
    };
    await raise(attribute, settings.attributeLevelUp);
    if (attribute === ActorValue.stamina)
      await raise(ActorValue.carryWeight, settings.carryWeightLevelUp);
    const level = await actors.playerLevel();
    state.playerExperience = Math.max(0, state.playerExperience - levelThreshold(level, settings));
    state.actor(PLAYER_REF).level = level + 1;
    runtime.perkPoints++;
    for (const { av } of VITALS) actors.restore(PLAYER_REF, av, Infinity);
    await this.#refreshLevelUps(false);
    // The story manager's Increase Level (OnStoryIncreaseLevel(aiNewLevel)): the Daedric quests.
    runtime.detach(
      runtime.storyManager.event({
        type: 'LEVL',
        forms: new Map(),
        values: new Map([['V1', level + 1]]),
        args: [level + 1],
      }),
    );
    return true;
  }

  /** The experience to the next level-up given at once (the console's player.advlevel). */
  async advanceLevel(): Promise<void> {
    const state = this.#runtime.state;
    const settings = (await this.settings()).progression;
    let at = await this.#runtime.actors.playerLevel();
    let pool = state.playerExperience;
    while (pool >= levelThreshold(at, settings)) pool -= levelThreshold(at++, settings);
    state.playerExperience += levelThreshold(at, settings) - pool;
    await this.#refreshLevelUps(true);
  }

  // --- Perks ---------------------------------------------------------------------------------

  #perk(formId: number): Promise<PerkRecord | undefined> {
    let pending = this.#perks.get(formId);
    if (!pending) {
      pending = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'PERK' ? parsePerk(record) : undefined));
      this.#perks.set(formId, pending);
    }
    return pending;
  }

  /** Every perk of the skills' trees (each rank) and where it stands. */
  #places(): Promise<Map<number, PerkPlace>> {
    this.#perkPlaces ??= (async () => {
      const places = new Map<number, PerkPlace>();
      for (let skill = ActorValue.firstSkill; isSkill(skill); skill++) {
        const record = await this.#runtime.forms.actorValueForm(skill);
        if (!record) continue;
        const tree = parseSkill(record);
        for (const node of tree.nodes) {
          if (node.perk === undefined) continue;
          const parents = tree.nodes.filter((other) => other.children.includes(node.index));
          // A node under the root (which has no perk) starts the tree.
          const first =
            parents.length === 0 || parents.some((parent) => parent.perk === undefined)
              ? []
              : parents.flatMap((parent) => (parent.perk === undefined ? [] : [parent.perk]));
          let previous: number | undefined;
          for (let rank: number | undefined = node.perk, i = 0; rank !== undefined && i < 10; i++) {
            if (places.has(rank)) break;
            places.set(rank, { skill, previous, parents: first });
            previous = rank;
            rank = (await this.#perk(rank))?.next;
          }
        }
      }
      return places;
    })();
    return this.#perkPlaces;
  }

  /** Whether the player can take a perk now, and if not why. */
  async perkAvailability(perk: number, pointsValue?: number): Promise<PerkAvailability> {
    const runtime = this.#runtime;
    const actors = runtime.actors;
    const record = await this.#perk(perk);
    if (!record) return 'unknown';
    if (await actors.hasPerk(PLAYER_REF, perk)) return 'owned';
    if (!record.playable) return 'notPlayable';
    const place = (await this.#places()).get(perk);
    if (place?.previous !== undefined && !(await actors.hasPerk(PLAYER_REF, place.previous)))
      return 'previousRank';
    if (place && place.parents.length > 0) {
      let linked = false;
      for (const parent of place.parents) {
        if (await actors.hasPerk(PLAYER_REF, parent)) linked = true;
      }
      if (!linked) return 'locked';
    }
    if (record.level > (await actors.playerLevel())) return 'requirements';
    if (!(await runtime.conditionsHold(record.conditions, runtime.referenceHandle(PLAYER_REF))))
      return 'requirements';
    return (await this.perkPointsOf(pointsValue)) > 0 ? 'available' : 'noPoints';
  }

  /**
   * The perk points to spend: the player's, or a beast form's (its actor value: WerewolfPerks,
   * VampirePerks; src/gameplay/beast-perk-trees.ts).
   */
  async perkPointsOf(pointsValue?: number): Promise<number> {
    const runtime = this.#runtime;
    if (pointsValue === undefined) return runtime.perkPoints;
    return Math.max(0, Math.floor((await runtime.actors.value(PLAYER_REF, pointsValue)).current));
  }

  /** Takes a perk for a perk point if it is available (perkAvailability). */
  async takePerk(perk: number, pointsValue?: number): Promise<boolean> {
    if ((await this.perkAvailability(perk, pointsValue)) !== 'available') return false;
    const runtime = this.#runtime;
    if (pointsValue === undefined) runtime.perkPoints = Math.max(0, runtime.perkPoints - 1);
    else {
      const value = await runtime.actors.value(PLAYER_REF, pointsValue);
      runtime.actors.setBase(PLAYER_REF, pointsValue, Math.max(0, value.base - 1));
    }
    await runtime.perks.add(PLAYER_REF, perk);
    return true;
  }

  // --- Levels of actors and encounter zones ---------------------------------------------------

  /** ECZN location → zone, read once. */
  #zones(): Promise<Map<number, number>> {
    this.#zonesByLocation ??= (async () => {
      const zones = new Map<number, number>();
      const forms = this.#runtime.forms;
      for (const formId of forms.db.formIdsOfType('ECZN')) {
        const record = await forms.record(formId);
        const location = record ? parseEncounterZone(record).location : undefined;
        if (location !== undefined && !zones.has(location)) zones.set(location, formId);
      }
      return zones;
    })();
    return this.#zonesByLocation;
  }

  /** The cell a reference was placed in (a worldspace's persistent one: the cell at its place). */
  async #placedCell(reference: number): Promise<number | undefined> {
    const runtime = this.#runtime;
    const db = runtime.forms.db;
    const at = await runtime.placement(reference, false);
    if (!at) return undefined;
    if (
      at.world !== undefined &&
      (at.cell === undefined || at.cell === db.persistentCell(at.world))
    )
      return db.exteriorCell(
        at.world,
        Math.floor(at.position[0] / 4096),
        Math.floor(at.position[1] / 4096),
      );
    return at.cell;
  }

  /**
   * A reference's encounter zone: its own (XEZN), its cell's, the zone of its cell's location or
   * the nearest parent location with one (ECZN's location), its worldspace's. TODO(M13): the
   * parent locations' zones are the Creation Kit's rule as remembered, not documented.
   */
  async encounterZone(reference: number): Promise<number | undefined> {
    const forms = this.#runtime.forms;
    const own = this.#runtime.state.created.has(reference)
      ? undefined
      : (await forms.record(reference))?.formIdField('XEZN');
    if (own !== undefined) return own;
    const cell = await this.#placedCell(reference);
    const record = cell === undefined ? undefined : await forms.record(cell);
    if (!record || cell === undefined) return undefined;
    const zone = record.formIdField('XEZN');
    if (zone !== undefined) return zone;
    const location = record.formIdField('XLCN');
    if (location !== undefined) {
      const zones = await this.#zones();
      for (const at of await this.#runtime.locationParents(location)) {
        const found = zones.get(at);
        if (found !== undefined) return found;
      }
    }
    const world = forms.db.worldOfCell(cell);
    return world === undefined ? undefined : (await forms.record(world))?.formIdField('XEZN');
  }

  /**
   * An encounter zone's level: set as it is first met (the player's level within its range)
   * and kept. TODO(M12): zones that do not "Never Reset" are set again as their cells reset
   * (iHoursToRespawnCell); cells do not reset yet.
   */
  async zoneLevel(zone: number): Promise<number> {
    const state = this.#runtime.state;
    const kept = state.zoneLevels.get(zone);
    if (kept !== undefined) return kept;
    const playerLevel = await this.#runtime.actors.playerLevel();
    const record = await this.#runtime.forms.record(zone);
    if (record?.type !== 'ECZN') return playerLevel;
    const level = zoneLevel(parseEncounterZone(record), playerLevel);
    state.zoneLevels.set(zone, level);
    return level;
  }

  /** The level of what a reference meets with: its encounter zone's, else the player's. */
  async encounterLevel(reference: number): Promise<number> {
    const zone = await this.encounterZone(reference);
    return zone === undefined ? this.#runtime.actors.playerLevel() : this.zoneLevel(zone);
  }

  /**
   * The level a reference's leveled lists are picked at: its encounter's level by its level
   * modifier (XLCM), kept from its first picking on (TODO(M12): until its cell resets).
   * TODO(M13): a very hard actor is at least the list's next entry up (UESP "Leveled Lists").
   */
  async leveledLevel(reference: number): Promise<number> {
    if (reference === PLAYER_REF) return this.#runtime.actors.playerLevel();
    const state = this.#runtime.state;
    const kept = state.leveledLevels.get(reference);
    if (kept !== undefined) return kept;
    const record = state.created.has(reference)
      ? undefined
      : await this.#runtime.forms.record(reference);
    const level = leveledPickLevel(
      await this.encounterLevel(reference),
      record ? levelModifier(record) : undefined,
      (await this.settings()).leveling,
    );
    state.leveledLevels.set(reference, level);
    return level;
  }

  /**
   * The level an actor whose level follows the player's follows: the player's for the player's
   * teammates (followers), its encounter's for others.
   */
  async followedLevel(reference: number): Promise<number> {
    const state = this.#runtime.state;
    if (state.actors.get(reference)?.playerTeammate === true)
      return this.#runtime.actors.playerLevel();
    return this.encounterLevel(reference);
  }

  /** An NPC's level from its stats record (fixed, or following the player's). */
  async levelOf(reference: number, info: ActorInfo): Promise<number> {
    const stats = info.stats;
    const follows = (stats.flags & NpcFlag.pcLevelMult) !== 0;
    return actorLevel(
      {
        level: stats.level,
        followsPlayer: follows,
        calcMinLevel: stats.calcMinLevel,
        calcMaxLevel: stats.calcMaxLevel,
      },
      follows ? await this.followedLevel(reference) : 1,
    );
  }

  #class(formId: number): Promise<ClassStats | undefined> {
    let pending = this.#classes.get(formId);
    if (!pending) {
      pending = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'CLAS' ? parseClassStats(record) : undefined));
      this.#classes.set(formId, pending);
    }
    return pending;
  }

  /**
   * An auto-calculated actor's skills and attributes (ACBS "Auto calc stats"; undefined for
   * others, whose records' values hold): at its level from its class and race, the player's at
   * level 1 (its later ones come from levelling up). A fixed-level NPC of its record's race
   * keeps the skills the Creation Kit stored (they differ only where skills reach 100).
   */
  async autoCalculated(reference: number, info: ActorInfo): Promise<AutoCalcStats | undefined> {
    const stats = info.stats;
    if ((stats.flags & NpcFlag.autoCalcStats) === 0 || stats.class === undefined) return undefined;
    const actors = this.#runtime.actors;
    const raceId = await actors.raceOf(reference);
    const level = reference === PLAYER_REF ? 1 : await actors.level(reference);
    const key = `${String(level)}:${String(raceId)}:${String(stats.formId)}`;
    const cached = this.#autoCalc.get(reference);
    if (cached?.key === key) return cached.stats;
    const [weights, race, settings] = await Promise.all([
      this.#class(stats.class),
      raceId === undefined ? undefined : actors.race(raceId),
      this.settings(),
    ]);
    if (!weights || !race) return undefined;
    const computed = autoCalcStats(
      {
        level,
        weights,
        race,
        healthOffset: stats.healthOffset,
        magickaOffset: stats.magickaOffset,
        staminaOffset: stats.staminaOffset,
      },
      settings.leveling,
    );
    const stored =
      reference !== PLAYER_REF &&
      (stats.flags & NpcFlag.pcLevelMult) === 0 &&
      raceId === stats.race &&
      stats.skills.length === SKILL_COUNT;
    const result = stored ? { ...computed, skills: stats.skills } : computed;
    this.#autoCalc.set(reference, { key, stats: result });
    return result;
  }

  // --- Health, magicka and stamina over time ----------------------------------------------------

  /** Every frame outside menus: regeneration and sprinting, ten times a second. */
  update(realSeconds: number): void {
    this.#pending += Math.max(0, realSeconds);
    if (this.#busy || this.#pending < TICK_SECONDS) return;
    const seconds = Math.min(1, this.#pending);
    this.#pending = 0;
    this.#busy = true;
    this.#runtime.detach(
      this.#tick(seconds).finally(() => {
        this.#busy = false;
      }),
    );
  }

  /**
   * Game time passes at once (waiting, sleeping, fast travel): values regenerate as over the
   * real seconds it stands for (game hours / the timescale); no delays hold.
   */
  async passTime(gameHours: number): Promise<void> {
    if (!(gameHours > 0)) return;
    this.#delays.clear();
    const seconds = (gameHours * 3600) / Math.max(1e-6, this.#runtime.timeScale);
    await this.#regenerate(seconds, false);
  }

  async #tick(seconds: number): Promise<void> {
    const runtime = this.#runtime;
    const sprinting = runtime.world.motion?.(PLAYER_REF)?.sprinting === true;
    if (sprinting) await this.#sprint(seconds);
    await this.#regenerate(seconds, sprinting);
    this.#stamina = (await runtime.actors.value(PLAYER_REF, ActorValue.stamina)).current;
  }

  /** Regenerates every living actor's damaged values; `sprinting`: the player's stamina waits. */
  async #regenerate(seconds: number, sprinting: boolean): Promise<void> {
    const runtime = this.#runtime;
    const settings = (await this.settings()).vitals;
    for (const [reference, actor] of runtime.state.actors) {
      if (actor.dead === true) continue;
      for (const { av, rate, mult, vital } of VITALS) {
        const own = actor.values.get(av);
        const key = `${String(reference)}:${String(vital)}`;
        if (!own || own.damage <= 0) {
          this.#seen.delete(key);
          this.#delays.delete(key);
          continue;
        }
        // Damage taken since the last look holds regeneration back a moment.
        let delay = this.#delays.get(key) ?? 0;
        if (own.damage > (this.#seen.get(key) ?? 0) + 1e-6)
          delay = Math.max(delay, settings.damagedDelay[vital]);
        delay -= seconds;
        const held = delay > 0 || (sprinting && reference === PLAYER_REF && vital === 2);
        if (delay > 0) this.#delays.set(key, delay);
        else this.#delays.delete(key);
        if (!held) {
          const perSecond = await this.#regenPerSecond(reference, av, rate, mult, vital);
          if (perSecond > 0) runtime.actors.restore(reference, av, perSecond * seconds);
        }
        this.#seen.set(key, own.damage);
      }
    }
  }

  async #regenPerSecond(
    reference: number,
    av: number,
    rate: number,
    mult: number,
    vital: Vital,
  ): Promise<number> {
    const actors = this.#runtime.actors;
    const [max, rateValue, multValue] = await Promise.all([
      actors.value(reference, av),
      actors.value(reference, rate),
      actors.value(reference, mult),
    ]);
    const inCombat = this.inCombat(reference);
    let regenInCombat = false;
    let combatHealthMult = 0;
    if (inCombat && vital === 0) {
      const race = await actors.race((await actors.raceOf(reference)) ?? 0);
      regenInCombat = ((race?.flags ?? 0) & RaceAiFlag.regenHpInCombat) !== 0;
      combatHealthMult = (await actors.value(reference, COMBAT_HEALTH_REGEN_MULT)).current;
    }
    return regenPerSecond(
      vital,
      {
        max: max.max,
        rate: rateValue.current,
        rateMult: multValue.current,
        inCombat,
        regenInCombat,
        combatHealthMult,
      },
      (await this.settings()).vitals,
    );
  }

  /** The weight of the armor an actor wears (the player's, read once a second). */
  async #wornWeight(actor: number): Promise<number> {
    const now = this.#runtime.state.realTime;
    if (actor === PLAYER_REF && now - this.#weight.at < WEIGHT_SECONDS) return this.#weight.weight;
    let weight = 0;
    for (const item of await this.#runtime.actors.worn(actor)) {
      const record = await this.#runtime.forms.record(item);
      const own = (record ? parseItem(record)?.weight : undefined) ?? 0;
      // As its perks make it (Mod Armor Weight: Conditioning).
      weight +=
        own > 0
          ? await this.#runtime.perks.apply(EntryPoint.modArmorWeight, actor, own, [item])
          : 0;
    }
    if (actor === PLAYER_REF) this.#weight = { at: now, weight };
    return weight;
  }

  /** `seconds` of an actor sprinting: its stamina drains (NPCs' movers: src/shell/actor-movers.ts). */
  async sprint(actor: number, seconds: number): Promise<void> {
    if (actor === PLAYER_REF) return; // The player's drains as it sprints (update).
    await this.#drain(actor, seconds);
  }

  async #sprint(seconds: number): Promise<void> {
    await this.#drain(PLAYER_REF, seconds);
  }

  async #drain(actor: number, seconds: number): Promise<void> {
    const settings = (await this.settings()).vitals;
    const cost = sprintDrain(await this.#wornWeight(actor), settings) * seconds;
    const now = (await this.#runtime.actors.value(actor, ActorValue.stamina)).current;
    await this.#runtime.actors.damage(actor, ActorValue.stamina, Math.min(Math.max(0, now), cost));
    const own = this.#runtime.state.actors.get(actor)?.values.get(ActorValue.stamina);
    this.#seen.set(`${String(actor)}:2`, own?.damage ?? 0);
  }

  /** Whether an actor can sprint (stamina left; the player's as last read). */
  canSprint(actor: number): boolean {
    return actor !== PLAYER_REF || this.#stamina === undefined || this.#stamina > 0;
  }

  /** Whether an actor can power attack or bash (stamina left). */
  async canPowerAttack(actor: number): Promise<boolean> {
    return (await this.#runtime.actors.value(actor, ActorValue.stamina)).current > 0;
  }

  /** The player tried what its magicka or stamina does not allow: the HUD's meter blinks. */
  refused(actor: number, meter: 'magicka' | 'stamina'): void {
    if (actor === PLAYER_REF) this.listener?.meterBlink?.(meter);
  }

  /**
   * An actor spends magicka or stamina (a spell, a power attack, a bash, blocking): the value is
   * damaged by it (not below 0); spending more than there was waits as long as the deficit
   * takes to regenerate (at most fMagickaRegenDelayMax / fStaminaRegenDelayMax).
   */
  async spend(actor: number, value: number, amount: number): Promise<void> {
    if (!(amount > 0) || (value !== ActorValue.magicka && value !== ActorValue.stamina)) return;
    const actors = this.#runtime.actors;
    const vital = value === ActorValue.magicka ? 1 : 2;
    const entry = VITALS[vital];
    if (!entry) return;
    const settings = (await this.settings()).vitals;
    const current = (await actors.value(actor, value)).current;
    const perSecond = await this.#regenPerSecond(actor, value, entry.rate, entry.mult, vital);
    const delay = spendDelay(
      amount,
      current,
      perSecond,
      vital === 1 ? settings.magickaDelayMax : settings.staminaDelayMax,
    );
    await actors.damage(actor, value, Math.min(Math.max(0, current), amount));
    const key = `${String(actor)}:${String(vital)}`;
    if (delay > 0) this.#delays.set(key, Math.max(delay, this.#delays.get(key) ?? 0));
    this.#seen.set(key, this.#runtime.state.actors.get(actor)?.values.get(value)?.damage ?? 0);
    if (actor === PLAYER_REF && value === ActorValue.stamina)
      this.#stamina = (await actors.value(actor, value)).current;
  }

  /** Holds a value's regeneration for `seconds` (the magic system while a spell is cast). */
  holdRegeneration(actor: number, value: number, seconds: number): void {
    const vital = VITALS.find((entry) => entry.av === value)?.vital;
    if (vital === undefined) return;
    const key = `${String(actor)}:${String(vital)}`;
    this.#delays.set(key, Math.max(seconds, this.#delays.get(key) ?? 0));
  }

  /** Stamina a power attack with a weapon of `weight` costs (combat). */
  async powerAttackCost(
    weight: number,
    options: { readonly dualWield?: boolean; readonly attackStaminaMult?: number } = {},
  ): Promise<number> {
    return powerAttackCost(weight, options, (await this.settings()).vitals);
  }

  /** Stamina a bash (power bash) costs (combat). */
  async bashCost(power: boolean): Promise<number> {
    return bashCost(power, (await this.settings()).vitals);
  }

  /** Stamina blocking `damage` costs (combat). */
  async blockCost(damage: number): Promise<number> {
    return blockCost(damage, (await this.settings()).vitals);
  }
}
