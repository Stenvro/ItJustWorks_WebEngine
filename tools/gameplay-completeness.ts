// The gameplay area's completeness sweep (docs/completeness/gameplay.md): what the load order's
// records use of the gameplay systems (skills, perks, magic, shouts, crafting, crime, factions,
// inventory and equipment, stats), each against the engine code that reads it.
//
// Perks: every entry point and entry function the perks use, the entry types, the condition
// tabs, the perk data. Magic: every magic effect archetype, flag and field (MGEF), the spells',
// scrolls', enchantments', potions' and ingredients' fields and flags. Shouts and words (SHOU,
// WOOP). Skills (AVIF): skill use and its multiplier and offset, the perk trees. Crafting: the
// workbench types and the recipes' benches (COBJ BNAM). Factions (FACT): flags, ranks,
// reactions, crime values, jail, vendors. Equipment: equip slots (EQUP), armor and weapon data
// and flags gameplay reads. The gameplay game settings (level-up, stats, skills, magic,
// crafting, crime, barter, equipment, beast forms).
//
// An item is done when the engine reads it: a field or flag is referenced by name outside the
// file that parses it, an entry point or archetype is named by the code that runs it, a game
// setting is named in the code (also through a name built at run time: `fLow${stat}...`), or
// EXPLAINED says why nothing more reads it. The counts are the records (entries, effects) using
// the item.
//
//   node tools/gameplay-completeness.ts           the counts and every open item
//   node tools/gameplay-completeness.ts --all     every item with its status
//   node tools/gameplay-completeness.ts --markdown   the docs' lists (done items by reader)

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CrimeFlag } from '../src/gameplay/crime.ts';
import { ENTRY_POINTS, EntryFunction, EntryPoint } from '../src/gameplay/perk-entry-points.ts';
import { WeaponFlag, WeaponFlag2 } from '../src/gameplay/combat/combat-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { parseFaction } from '../src/world/actor-stats-records.ts';
import { parseRecipe, parseWorkbench, WorkbenchType } from '../src/world/crafting-records.ts';
import { EquipSlotFlag, parseEquipSlot } from '../src/world/equip-slots.ts';
import { AmmoFlag, parseItem, PotionFlag } from '../src/world/item-records.ts';
import { EffectArchetype, EffectFlag, parseMagicEffect } from '../src/world/magic-effects.ts';
import {
  EnchantmentFlag,
  MAGIC_ITEM_TYPES,
  MagicSpellFlag,
  parseMagicItem,
} from '../src/world/magic-records.ts';
import { parsePerk, PerkEntryType } from '../src/world/perk-records.ts';
import { parseSkill } from '../src/world/perk-trees.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { parseShout, parseWord } from '../src/world/spell-records.ts';
import { openGameFolder } from './gamedata-path.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

export interface GameplayItem {
  /** The checklist's section ("Perk entry points", "Magic effect archetypes", ...). */
  readonly part: string;
  readonly name: string;
  /** Records (entries, effects) of the load order using it. */
  readonly uses: number;
  readonly done: boolean;
  /** Where the engine reads it (a source file), or why it is open. */
  readonly where: string;
}

/**
 * The gameplay game settings by part (the load order's GMSTs matching them). The AI's and
 * combat's own settings are on their lists (tools/ai-combat-completeness.ts); crime's are
 * counted on both (the AI's list holds the guards' side).
 */
const SETTING_PARTS: readonly (readonly [string, RegExp])[] = [
  ['Settings: skills and level-up', /^[fiub](Skill|XP|Level|AVD|PerkPoint|Legendary|Train|Book)/],
  [
    'Settings: stats',
    /^[fiub](Health|Magicka|Stamina|CarryWeight|Encumb|Fatigue|ActorValue|AV(?!D)|Base|Rest)/,
  ],
  [
    'Settings: magic and shouts',
    /^[fiub](Magic|Spell|Enchant|Soul|Shout|Dragon|Staff|Scroll|Absorb|Reflect|Ward|Dual|Telekinesis|Bound|Summon|Reanimate|Paralysis|Invisib|Disease|Detect|Cloak|Rune|Concentration|Cast)/,
  ],
  [
    'Settings: alchemy and crafting',
    /^[fiub](Alch|Ingredient|Potion|Poison|Smith|Temper|Craft|Cook|Smelt|Tann|Food)/,
  ],
  [
    'Settings: crime, theft and locks',
    /^[fiub](Crime|Bounty|Jail|Arrest|Steal|Stolen|Pick[Pp]ocket|Lockpick|Lock|Trespass|Murder|Assault|Fence|Prison)/,
  ],
  [
    'Settings: barter and speech',
    /^[fiub](Barter|Gold|Vendor|Merchant|Price|Speech|Persuade|Persuasion|Bribe|Intimidat|Gift)/,
  ],
  ['Settings: armor and weapons', /^[fiub](Armor|Weapon|Equip|Item|Weight|Inventory|Ammo)/],
  ['Settings: beast forms', /^[fiub](Werewolf|Vampire|Lycanthropy|Beast)/],
];

interface Source {
  readonly file: string;
  readonly text: string;
}

/** The engine's sources (src/, without the tests), their comments left out. */
function readSources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
        out.push({
          file: path.relative(ROOT, full).replaceAll('\\', '/'),
          text: readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, ''),
        });
    }
  };
  walk(path.join(ROOT, 'src'));
  const rank = (file: string): number =>
    ['src/gameplay/', 'src/scripting/runtime/', 'src/shell/', 'src/world/'].findIndex((dir) =>
      file.startsWith(dir),
    ) >>> 0;
  return out.sort((a, b) => rank(a.file) - rank(b.file));
}

/**
 * Items done without a reader of their own, by "part|name": why nothing more reads them.
 */
const EXPLAINED: ReadonlyMap<string, string> = new Map([
  [
    'Magic effect archetypes|script',
    'src/scripting/runtime/magic-engine.ts: a Script effect does nothing but run its scripts (OnEffectStart, OnEffectFinish) and its actor value, as every effect does',
  ],
  [
    'Magic effect archetypes|valueModifier',
    'src/scripting/runtime/magic-engine.ts: the default archetype: its actor value changed by the magnitude',
  ],
  [
    'Perk entry functions|none',
    'src/gameplay/perk-entry-points.ts: an entry without a function changes nothing',
  ],
  [
    'Recipes by bench keyword (COBJ BNAM)|BYOHBuilding* (208 keywords)',
    "src/shell/crafting-models.ts (RecipeIndex.forWorkbench): 4 parts' keywords (a bench, a desk, a weapon plaque, a fireplace's slaughterfish) are on no workbench of the load order, so the original offers those 4 recipes nowhere either",
  ],
  [
    'Recipes by bench keyword (COBJ BNAM)|Camping_CampfireCookingShared',
    "src/shell/crafting-models.ts (RecipeIndex.forWorkbench): Update.esm's keyword for the Camping Creation's campfire (the fishing recipes' cooking there), which the install does not have: no workbench has it in the original either; one that has it lists them",
  ],
  [
    'Perk entries|ranks (DATA: above 1)',
    "src/scripting/runtime/perk-engine.ts: no vanilla entry belongs to a rank past the first (PRKE rank 0 in all), and a tree's ranks are its NNAM chain (Novice Locks: DATA 5, one record; the original's menu shows one rank); the count is the Creation Kit's",
  ],
  ['Magic effect flags|goryVisuals', 'not used by the game (Creation Kit "Magic Effect")'],
  [
    'Faction flags (FACT DATA)|canBeOwner',
    'the editor\'s filter of the factions it offers as owners (Creation Kit "Faction"); the game takes the owner a cell or reference names (every faction owning a cell has the flag)',
  ],
  [
    'Faction flags (FACT DATA)|hiddenFromPlayer',
    'keeps a faction off the player\'s faction list (Creation Kit "Faction"), which Skyrim\'s menus do not have',
  ],
  [
    'Weapon flags (DNAM)|embeddedWeapon',
    "unused (CommonLibSSE TESObjectWEAP): its actor value is an earlier game's limb condition, which Skyrim has none of",
  ],
  [
    'Weapon flags (DNAM)|ignoresNormalWeaponResistance',
    "an earlier game's resistance to normal weapons: Skyrim has no such actor value (CommonLibSSE ActorValue: damage, poison, fire, shock, frost, magic, disease)",
  ],
  [
    'Ammunition flags (DATA)|ignoresNormalResistance',
    "an earlier game's resistance to normal weapons: Skyrim has no such actor value (CommonLibSSE ActorValue: damage, poison, fire, shock, frost, magic, disease)",
  ],
]);

/**
 * Game settings the plugins define that the original reads nothing from: an earlier game's
 * leftovers (Fallout 3's experience points, computers, weapon condition and speech challenges),
 * and those the original registers but never reads, with the reason. Skyrim's level comes from
 * skill increases alone (UESP "Leveling"); a speech check is a dialogue condition on the Speech
 * skill; weapons do not wear.
 */
const INERT: readonly (readonly [RegExp, string])[] = [
  [
    /^iXP(Reward|LevelKill|Bump|DeathReward)/,
    "an earlier game's experience points: nothing here gives any (the level comes from skills)",
  ],
  [/HackComputer/, "an earlier game's computers: there are none here"],
  [/^fWeaponCondition/, "an earlier game's weapon condition: weapons do not wear here"],
  [
    /^iSpeechChallengeDifficulty/,
    "an earlier game's speech challenges: a speech check is a dialogue condition on the skill",
  ],
  [
    /^fMagicLight(Forward|Height|Side)Offset$/,
    'registered by the original and never read (observed in the original): src/shell/actor-effects.ts LIGHT_OFFSET',
  ],
];

/**
 * Items the engine reads under another name than the table's (the parser turns the bit into a
 * field), by "part|name": the pattern that finds the reading code.
 */
const ALIASES: ReadonlyMap<string, RegExp> = new Map([
  ['Perk entry functions|addActivateChoice', /type !?== 'activateChoice'/],
  ['Weapon flags (DNAM)|nonPlayable', /item\w*\.nonPlayable\b/],
  ['Ammunition flags (DATA)|nonPlayable', /item\w*\.nonPlayable\b/],
]);

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function gameplayCompleteness(db: RecordDatabase): Promise<GameplayItem[]> {
  const sources = readSources();
  const items: GameplayItem[] = [];
  /** The first source (not one of `skip`) matching `pattern`. */
  const readIn = (pattern: RegExp, skip: readonly string[]): string | undefined =>
    sources.find((source) => !skip.includes(source.file) && pattern.test(source.text))?.file;
  const push = (part: string, name: string, uses: number, where: string | undefined): void => {
    const explained = EXPLAINED.get(`${part}|${name}`);
    const found = where ?? explained;
    items.push({ part, name, uses, done: found !== undefined, where: found ?? 'not read' });
  };
  /** A table's keys (a flag or id table), each done when `pattern(key)` reads it. */
  const table = (
    part: string,
    keys: Readonly<Record<string, number>>,
    counts: ReadonlyMap<number, number>,
    pattern: (key: string) => RegExp,
    skip: readonly string[],
  ): void => {
    for (const [key, value] of Object.entries(keys)) {
      const alias = ALIASES.get(`${part}|${key}`);
      const where = readIn(pattern(key), skip) ?? (alias && readIn(alias, skip));
      push(part, key, counts.get(value >>> 0) ?? 0, where);
    }
  };
  /** A parsed field read as `.field` outside its parser (or by `pattern`). */
  const field = (
    part: string,
    name: string,
    uses: number,
    skip: readonly string[],
    // `.name`, or the name destructured (`const { name } = vendor`).
    pattern = new RegExp(`\\.${escape(name)}\\b|\\{[^}]*\\b${escape(name)}\\b[^}]*\\}\\s*=`),
  ): void => {
    push(part, name, uses, readIn(pattern, skip));
  };
  const add = <K>(map: Map<K, number>, key: K, by = 1): void => {
    map.set(key, (map.get(key) ?? 0) + by);
  };
  const bits = (value: number, map: Map<number, number>): void => {
    for (let i = 0; i < 32; i++) if ((value & (1 << i)) !== 0) add(map, (1 << i) >>> 0);
  };
  const records = async function* (type: string) {
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      if (record && !record.deleted) yield record;
    }
  };

  // ---- Perks
  const PERK_FILES = ['src/gameplay/perk-entry-points.ts', 'src/world/perk-records.ts'];
  const points = new Map<number, number>();
  const functions = new Map<number, number>();
  const entryTypes = new Map<number, number>();
  let rankedPerks = 0;
  let perkConditions = 0;
  let nextPerks = 0;
  let traits = 0;
  let hiddenPerks = 0;
  let overTabs = 0;
  for await (const record of records('PERK')) {
    const perk = parsePerk(record);
    if (perk.ranks > 1) rankedPerks++;
    if (perk.conditions.length > 0) perkConditions++;
    if (perk.next !== undefined) nextPerks++;
    if (perk.trait) traits++;
    if (perk.hidden) hiddenPerks++;
    for (const entry of perk.entries) {
      if (entry.kind === 'quest') add(entryTypes, PerkEntryType.quest);
      else if (entry.kind === 'ability') add(entryTypes, PerkEntryType.ability);
      else {
        add(entryTypes, PerkEntryType.entryPoint);
        add(points, entry.entryPoint);
        add(functions, entry.function);
        const tabs = ENTRY_POINTS[entry.entryPoint]?.tabs.length ?? 0;
        if (entry.conditions.length > tabs) overTabs++;
      }
    }
  }
  table(
    'Perk entry points',
    EntryPoint,
    points,
    (key) => new RegExp(`\\bEntryPoint\\.${key}\\b`),
    PERK_FILES,
  );
  table(
    'Perk entry functions',
    EntryFunction,
    functions,
    (key) => new RegExp(`\\bEntryFunction\\.${key}\\b`),
    [],
  );
  push(
    'Perk entries',
    'quest stage entries (PRKE type 0)',
    entryTypes.get(PerkEntryType.quest) ?? 0,
    readIn(/kind === 'quest'|PerkEntryType\.quest\b/, PERK_FILES),
  );
  push(
    'Perk entries',
    'ability entries (PRKE type 1)',
    entryTypes.get(PerkEntryType.ability) ?? 0,
    readIn(/kind === 'ability'|PerkEntryType\.ability\b/, PERK_FILES),
  );
  push(
    'Perk entries',
    'condition tabs (PRKC) within the entry point',
    overTabs,
    overTabs === 0 ? 'src/gameplay/perk-entry-points.ts (every tab a subject)' : undefined,
  );
  field(
    'Perk entries',
    'conditions (the perk requirements)',
    perkConditions,
    PERK_FILES,
    /perk\w*\.conditions\b|record\.conditions\b/,
  );
  field('Perk entries', 'next (NNAM: the next rank)', nextPerks, PERK_FILES, /\.next\b/);
  field('Perk entries', 'trait', traits, PERK_FILES, /\.trait\b/);
  field('Perk entries', 'hidden', hiddenPerks, PERK_FILES, /\.hidden\b/);
  field('Perk entries', 'ranks (DATA: above 1)', rankedPerks, PERK_FILES, /perk\w*\.ranks\b/);

  // ---- Magic effects
  const MGEF_FILES = ['src/world/magic-effects.ts'];
  const archetypes = new Map<number, number>();
  const effectFlags = new Map<number, number>();
  const effectFields = new Map<string, number>();
  for await (const record of records('MGEF')) {
    const effect = parseMagicEffect(record);
    add(archetypes, effect.archetype);
    bits(effect.flags, effectFlags);
    for (const [key, value] of Object.entries(effect)) {
      if (['formId', 'editorId', 'name', 'flags', 'archetype'].includes(key)) continue;
      const used =
        value !== undefined &&
        value !== 0 &&
        value !== -1 &&
        value !== '' &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0);
      if (used) add(effectFields, key);
      else if (!effectFields.has(key)) effectFields.set(key, 0);
    }
  }
  table(
    'Magic effect archetypes',
    EffectArchetype,
    archetypes,
    (key) => new RegExp(`\\bEffectArchetype\\.${key}\\b`),
    MGEF_FILES,
  );
  table(
    'Magic effect flags',
    EffectFlag,
    effectFlags,
    (key) => new RegExp(`\\bEffectFlag\\.${key}\\b`),
    MGEF_FILES,
  );
  for (const [name, uses] of effectFields) field('Magic effect fields', name, uses, MGEF_FILES);

  // ---- Spells, scrolls, enchantments, potions, ingredients
  const ITEM_FILES = ['src/world/magic-records.ts', 'src/world/item-records.ts'];
  const spellFlags = new Map<number, number>();
  const enchantFlags = new Map<number, number>();
  const potionFlags = new Map<number, number>();
  const itemFields = new Map<string, number>();
  for (const type of MAGIC_ITEM_TYPES) {
    for await (const record of records(type)) {
      const item = parseMagicItem(record);
      if (!item) continue;
      if (type === 'SPEL' || type === 'SCRL') bits(item.flags, spellFlags);
      if (type === 'ENCH') bits(item.flags, enchantFlags);
      if (type === 'ALCH' || type === 'INGR') bits(item.flags, potionFlags);
      const used = (name: string, value: unknown): void => {
        add(itemFields, `${type} ${name}`, value !== undefined && value !== 0 ? 1 : 0);
      };
      used('castType', type === 'ALCH' || type === 'INGR' ? undefined : item.castType + 1);
      used('delivery', type === 'ALCH' || type === 'INGR' ? undefined : item.delivery + 1);
      used('cost', item.cost);
      used('effects', item.effects.length);
      if (type === 'SPEL' || type === 'SCRL') {
        used('chargeTime', item.chargeTime);
        used('castingPerk', item.castingPerk);
      }
      if (type === 'ENCH') {
        used('enchantment.amount', item.enchantment?.amount);
        used('enchantment.baseEnchantment', item.enchantment?.baseEnchantment);
        used('enchantment.wornRestrictions', item.enchantment?.wornRestrictions);
      }
      if (type === 'ALCH' || type === 'INGR') {
        used('potion.value', item.potion?.value);
        if (type === 'ALCH') {
          used('potion.addiction', item.potion?.addiction);
          used('potion.useSound', item.potion?.useSound);
        }
      }
    }
  }
  const ITEM_PATTERNS: Readonly<Record<string, RegExp>> = {
    castType: /\.castType\b/,
    delivery: /\.delivery\b/,
    cost: /\bitem\w*\.cost\b|spell\w*\.cost\b|\.cost\b/,
    effects: /\.effects\b/,
    chargeTime: /\.chargeTime\b/,
    castingPerk: /\.castingPerk\b/,
    'enchantment.amount': /enchantment\??\.amount\b/,
    'enchantment.baseEnchantment': /\.baseEnchantment\b/,
    'enchantment.wornRestrictions': /\.wornRestrictions\b/,
    'potion.value': /potion\??\.value\b/,
    'potion.addiction': /\.addiction\b/,
    'potion.useSound': /\.useSound\b/,
  };
  for (const [name, uses] of itemFields) {
    const key = name.slice(5);
    field(
      'Spells, scrolls, enchantments, potions, ingredients',
      name,
      uses,
      ITEM_FILES,
      ITEM_PATTERNS[key],
    );
  }
  table(
    'Spell and scroll flags (SPIT)',
    MagicSpellFlag,
    spellFlags,
    (key) => new RegExp(`\\bMagicSpellFlag\\.${key}\\b`),
    ITEM_FILES,
  );
  table(
    'Enchantment flags (ENIT)',
    EnchantmentFlag,
    enchantFlags,
    (key) => new RegExp(`\\bEnchantmentFlag\\.${key}\\b`),
    ITEM_FILES,
  );
  table(
    'Potion and ingredient flags (ENIT)',
    PotionFlag,
    potionFlags,
    (key) => new RegExp(`\\bPotionFlag\\.${key}\\b`),
    ITEM_FILES,
  );

  // ---- Shouts and words
  const SHOUT_FILES = ['src/world/spell-records.ts'];
  let shouts = 0;
  let words = 0;
  let menuObjects = 0;
  let wordRecords = 0;
  for await (const record of records('SHOU')) {
    const shout = parseShout(record);
    shouts++;
    words += shout.words.length;
    if (record.fields.has('MDOB')) menuObjects++;
  }
  for await (const record of records('WOOP')) {
    if (parseWord(record).translation) wordRecords++;
  }
  field('Shouts and words', 'SHOU words (SNAM word)', words, SHOUT_FILES, /\.words\b/);
  field(
    'Shouts and words',
    'SHOU words (SNAM spell)',
    words,
    SHOUT_FILES,
    /word\w*\.spell\b|\.spell\b/,
  );
  field('Shouts and words', 'SHOU words (SNAM recovery)', words, SHOUT_FILES, /\.recovery\b/);
  field(
    'Shouts and words',
    'SHOU description (DESC)',
    shouts,
    SHOUT_FILES,
    /shout\w*\.description\b/,
  );
  field('Shouts and words', 'SHOU menu display object (MDOB)', menuObjects, SHOUT_FILES, /'MDOB'/);
  field('Shouts and words', 'WOOP translation (TNAM)', wordRecords, SHOUT_FILES, /\.translation\b/);

  // ---- Skills (AVIF)
  const SKILL_FILES = ['src/world/perk-trees.ts'];
  let skills = 0;
  let nodes = 0;
  for await (const record of records('AVIF')) {
    const skill = parseSkill(record);
    if (skill.use) skills++;
    nodes += skill.nodes.length;
  }
  for (const name of ['useMult', 'useOffset', 'improveMult', 'improveOffset'])
    field('Skills (AVIF)', `AVSK ${name}`, skills, SKILL_FILES, new RegExp(`\\.${name}\\b`));
  for (const name of ['perk', 'column', 'row', 'offsetX', 'offsetY', 'children'])
    field(
      'Skills (AVIF)',
      `perk tree node ${name}`,
      nodes,
      SKILL_FILES,
      new RegExp(`node\\w*\\.${name}\\b|\\.${name}\\b`),
    );

  // ---- Crafting
  const CRAFT_FILES = ['src/world/crafting-records.ts'];
  const benchTypes = new Map<number, number>();
  /** The keywords some workbench has: a recipe needing one is made at that bench. */
  const benchHas = new Set<number>();
  for await (const record of records('FURN')) {
    const bench = parseWorkbench(record);
    if (!bench) continue;
    add(benchTypes, bench.type);
    for (const keyword of bench.keywords) benchHas.add(keyword);
  }
  const benchKeywords = new Map<number, number>();
  let recipes = 0;
  let conditioned = 0;
  for await (const record of records('COBJ')) {
    const recipe = parseRecipe(record);
    recipes++;
    if (recipe.conditions.length > 0) conditioned++;
    if (recipe.workbench !== undefined) add(benchKeywords, recipe.workbench);
  }
  table(
    'Workbenches (FURN WBDT)',
    WorkbenchType,
    benchTypes,
    (key) => new RegExp(`\\bWorkbenchType\\.${key}\\b`),
    CRAFT_FILES,
  );
  // A bench lists the recipes whose keyword it has (RecipeIndex.forWorkbench): a keyword is done
  // when the engine lists by keyword and some workbench has it. Hearthfire's building parts (one
  // keyword per part of a house, BYOHBuilding*) are counted as one item.
  const benchReader = readIn(/\.forWorkbench\(/, CRAFT_FILES);
  const benchGroups = new Map<string, { uses: number; keywords: number; benched: number }>();
  for (const [keyword, uses] of benchKeywords) {
    let name = (await db.get(keyword))?.editorId ?? keyword.toString(16);
    if (name.startsWith('BYOHBuilding')) name = 'BYOHBuilding*';
    const group = benchGroups.get(name) ?? { uses: 0, keywords: 0, benched: 0 };
    group.uses += uses;
    group.keywords++;
    if (benchHas.has(keyword)) group.benched++;
    benchGroups.set(name, group);
  }
  for (const [name, group] of [...benchGroups].sort((a, b) => b[1].uses - a[1].uses)) {
    const shown = group.keywords > 1 ? `${name} (${String(group.keywords)} keywords)` : name;
    const where =
      group.benched < group.keywords
        ? `open: ${String(group.keywords - group.benched)} of its keywords on no workbench (FURN)`
        : benchReader;
    push(
      'Recipes by bench keyword (COBJ BNAM)',
      shown,
      group.uses,
      where?.startsWith('open') ? undefined : where,
    );
    if (where?.startsWith('open') && items.at(-1)?.done !== true) {
      const last = items.pop();
      if (last) items.push({ ...last, where });
    }
  }
  field('Recipes (COBJ)', 'conditions', conditioned, CRAFT_FILES, /recipe\w*\.conditions\b/);
  field('Recipes (COBJ)', 'components', recipes, CRAFT_FILES, /\.components\b/);
  field('Recipes (COBJ)', 'createdCount', recipes, CRAFT_FILES, /\.createdCount\b/);

  // ---- Factions
  const FACT_FILES = ['src/world/actor-stats-records.ts'];
  const factionFlags = new Map<number, number>();
  const factionFields = new Map<string, number>();
  let rankTitles = 0;
  for await (const record of records('FACT')) {
    const faction = parseFaction(record);
    bits(faction.flags, factionFlags);
    if (record.fields.has('MNAM') || record.fields.has('FNAM')) rankTitles++;
    add(factionFields, 'reactions', faction.reactions.length > 0 ? 1 : 0);
    add(factionFields, 'ranks', faction.ranks.length > 0 ? 1 : 0);
    for (const [key, value] of Object.entries(faction.crime ?? {}))
      add(
        factionFields,
        `crime.${key}`,
        value !== undefined && value !== 0 && value !== false ? 1 : 0,
      );
    for (const [key, value] of Object.entries(faction.vendor ?? {})) {
      if (key === 'conditions') continue;
      add(
        factionFields,
        `vendor.${key}`,
        value !== undefined && value !== 0 && value !== false ? 1 : 0,
      );
    }
    add(factionFields, 'vendor.conditions', (faction.vendor?.conditions.length ?? 0) > 0 ? 1 : 0);
  }
  table(
    'Faction flags (FACT DATA)',
    { ...CrimeFlag, vendor: 0x4000 },
    factionFlags,
    (key) => (key === 'vendor' ? /\.vendor\b/ : new RegExp(`\\bCrimeFlag\\.${key}\\b`)),
    FACT_FILES,
  );
  for (const [name, uses] of factionFields) {
    const leaf = name.split('.').pop() ?? name;
    field(
      'Faction data (FACT)',
      name,
      uses,
      FACT_FILES,
      new RegExp(`\\.${leaf}\\b|\\{[^}]*\\b${leaf}\\b[^}]*\\}\\s*=`),
    );
  }
  field(
    'Faction data (FACT)',
    'rank titles (MNAM, FNAM)',
    rankTitles,
    FACT_FILES,
    /rankTitle|'MNAM'[\s\S]{0,80}'FNAM'/,
  );

  // ---- Equipment
  const EQUIP_FILES = ['src/world/equip-slots.ts'];
  const slotFlags = new Map<number, number>();
  for await (const record of records('EQUP')) bits(parseEquipSlot(record).flags, slotFlags);
  table(
    'Equip slots (EQUP)',
    EquipSlotFlag,
    slotFlags,
    (key) => new RegExp(`\\bEquipSlotFlag\\.${key}\\b`),
    EQUIP_FILES,
  );
  const weaponFlags = new Map<number, number>();
  const weaponFlags2 = new Map<number, number>();
  const ammoFlags = new Map<number, number>();
  const gear = new Map<string, number>();
  for (const type of ['WEAP', 'ARMO', 'AMMO']) {
    for await (const record of records(type)) {
      const item = parseItem(record);
      if (!item) continue;
      if (item.weapon) {
        bits(item.weapon.flags, weaponFlags);
        bits(item.weapon.flags2, weaponFlags2);
        for (const [key, value] of Object.entries(item.weapon))
          if (key !== 'flags' && key !== 'flags2')
            add(gear, `WEAP ${key}`, value !== undefined && value !== 0 ? 1 : 0);
      }
      if (item.armor)
        for (const [key, value] of Object.entries(item.armor))
          add(gear, `ARMO ${key}`, value !== undefined && value !== 0 ? 1 : 0);
      if (type === 'AMMO') bits(item.ammoFlags ?? 0, ammoFlags);
      add(gear, `${type} value`, item.value !== 0 ? 1 : 0);
      add(gear, `${type} weight`, item.weight !== 0 ? 1 : 0);
      add(gear, `${type} enchantment (EITM)`, item.enchantment !== undefined ? 1 : 0);
      add(gear, `${type} equipType (ETYP)`, item.equipType !== undefined ? 1 : 0);
    }
  }
  const GEAR_PATTERNS: Readonly<Record<string, RegExp>> = {
    'enchantment (EITM)': /item\w*\.enchantment\b|record\.enchantment\b/,
    'equipType (ETYP)': /\.equipType\b/,
    firstPersonModel: /\.firstPersonModel\b/,
  };
  for (const [name, uses] of gear) {
    const key = name.slice(5);
    field(
      'Armor and weapon data',
      name,
      uses,
      ['src/world/item-records.ts'],
      GEAR_PATTERNS[key] ?? new RegExp(`\\.${key}\\b`),
    );
  }
  const COMBAT_RECORDS = ['src/gameplay/combat/combat-records.ts', 'src/world/item-records.ts'];
  table(
    'Weapon flags (DNAM)',
    WeaponFlag,
    weaponFlags,
    (key) => new RegExp(`\\bWeaponFlag\\.${key}\\b`),
    COMBAT_RECORDS,
  );
  table(
    'Weapon flags 2 (DNAM)',
    WeaponFlag2,
    weaponFlags2,
    (key) => new RegExp(`\\bWeaponFlag2\\.${key}\\b`),
    COMBAT_RECORDS,
  );
  table(
    'Ammunition flags (DATA)',
    AmmoFlag,
    ammoFlags,
    (key) => new RegExp(`\\bAmmoFlag\\.${key}\\b`),
    COMBAT_RECORDS,
  );

  // ---- Game settings
  // Names built at run time (`fLow${stat}TutorialPercentage`) count for every name they build.
  const built: RegExp[] = [];
  for (const source of sources) {
    for (const match of source.text.matchAll(/`([fiub][A-Z]\w*\$\{[^`]*)`/g)) {
      const parts = (match[1] ?? '').split(/\$\{[^}]*\}/);
      if (!parts.every((part) => /^\w*$/.test(part))) continue;
      built.push(new RegExp(`^${parts.map(escape).join('\\w+')}$`));
    }
  }
  for (const formId of db.formIdsOfType('GMST')) {
    const record = await db.get(formId);
    const name = record?.editorId;
    if (!record || record.deleted || name === undefined) continue;
    const part = SETTING_PARTS.find(([, pattern]) => pattern.test(name))?.[0];
    if (!part) continue;
    const where =
      readIn(new RegExp(`['"\`]${escape(name)}['"\`]`), []) ??
      (built.some((pattern) => pattern.test(name)) ? 'a name built at run time' : undefined) ??
      INERT.find(([pattern]) => pattern.test(name))?.[1].replace(/^/, 'inert: ');
    push(part, name, 1, where);
  }
  return items;
}

/**
 * The checklist's lists as Markdown (docs/completeness/gameplay.md): per part, the done items
 * by the file that reads them, then each open item with its records and reason.
 */
function markdown(items: readonly GameplayItem[]): string {
  const lines: string[] = [];
  for (const part of new Set(items.map((item) => item.part))) {
    const list = items.filter((item) => item.part === part);
    const done = list.filter((item) => item.done).length;
    lines.push('', `### ${part} (${String(done)} of ${String(list.length)})`, '');
    const byFile = new Map<string, string[]>();
    for (const item of list.filter((entry) => entry.done)) {
      const names = byFile.get(item.where) ?? [];
      names.push(`${item.name} (${String(item.uses)})`);
      byFile.set(item.where, names);
    }
    for (const [where, names] of byFile) lines.push(`- [x] ${names.join(', ')}: ${where}`);
    for (const item of list.filter((entry) => !entry.done)) {
      const why = item.uses === 0 ? 'unused by the load order (mods only)' : item.where;
      lines.push(`- [ ] ${item.name} (${String(item.uses)}): ${why}`);
    }
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const all = process.argv.includes('--all');
  const vfs = await Vfs.mount(openGameFolder());
  const db = await RecordDatabase.open(vfs);
  const items = await gameplayCompleteness(db);
  if (process.argv.includes('--markdown')) {
    console.log(markdown(items));
    await db.close();
    await vfs.close();
    process.exit(0);
  }
  // Open items no record uses are kept apart: the load order needs them only for mods.
  const unused = (item: GameplayItem): boolean => !item.done && item.uses === 0;
  console.log(
    `gameplay: ${items.filter((i) => i.done).length} of ${items.length} done, ` +
      `${items.filter(unused).length} of the open unused by the load order`,
  );
  const parts = [...new Set(items.map((item) => item.part))];
  for (const part of parts) {
    const list = items.filter((item) => item.part === part);
    const open = list.filter((item) => !item.done);
    const idle = open.filter(unused).length;
    console.log(
      `  ${part}: ${list.length - open.length}/${list.length}` +
        (idle > 0 ? ` (${idle} open unused)` : ''),
    );
    for (const item of all ? list : open)
      console.log(`    [${item.done ? 'x' : ' '}] ${item.name} (${item.uses}): ${item.where}`);
  }
  await db.close();
  await vfs.close();
}
