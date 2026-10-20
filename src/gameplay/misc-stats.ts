// The game's statistics (its "misc stats": Game.QueryStat, Game.IncrementStat), as the journal's
// stats page lists them, by its categories and in its order (UESP, "Skyrim:Statistics").
// Their names are the stats' names in scripts and, with "$" before them, the interface's
// translation keys. Platform-independent.

/** The journal's stat categories (its CategoryList order). */
export const StatCategory = {
  general: 0,
  quest: 1,
  combat: 2,
  magic: 3,
  crafting: 4,
  crime: 5,
} as const;
export type StatCategory = (typeof StatCategory)[keyof typeof StatCategory];

export interface MiscStat {
  readonly name: string;
  readonly category: StatCategory;
}

const group = (category: StatCategory, names: readonly string[]): MiscStat[] =>
  names.map((name) => ({ name, category }));

/**
 * Every stat the journal lists. A hold's bounty ("<Hold> Bounty", "Tribal Orcs Bounty") shows
 * in the crime category only once there is one (the crime engine's bounties, named by
 * sBountyStatString: src/shell/journal-menu.ts).
 */
export const MISC_STATS: readonly MiscStat[] = [
  ...group(StatCategory.general, [
    'Mauls',
    'Werewolf Transformations',
    'Days as a Werewolf',
    'Necks Bitten',
    'Days as a Vampire',
    'Locations Discovered',
    'Dungeons Cleared',
    'Days Passed',
    'Hours Slept',
    'Hours Waiting',
    'Standing Stones Found',
    'Gold Found',
    'Most Gold Carried',
    'Chests Looted',
    'Skill Increases',
    'Skill Books Read',
    'Food Eaten',
    'Training Sessions',
    'Books Read',
    'Horses Owned',
    'Houses Owned',
    'Stores Invested In',
    'Barters',
    'Persuasions',
    'Bribes',
    'Intimidations',
    'Diseases Contracted',
  ]),
  ...group(StatCategory.quest, [
    'Dragonborn Quests Completed',
    'Dawnguard Quests Completed',
    'Quests Completed',
    'Misc Objectives Completed',
    'Main Quests Completed',
    'Side Quests Completed',
    'The Companions Quests Completed',
    'College of Winterhold Quests Completed',
    "Thieves' Guild Quests Completed",
    'The Dark Brotherhood Quests Completed',
    'Civil War Quests Completed',
    'Daedric Quests Completed',
    'Questlines Completed',
  ]),
  ...group(StatCategory.combat, [
    'People Killed',
    'Animals Killed',
    'Creatures Killed',
    'Undead Killed',
    'Daedra Killed',
    'Automatons Killed',
    'Favorite Weapon',
    'Critical Strikes',
    'Sneak Attacks',
    'Backstabs',
    'Weapons Disarmed',
    'Brawls Won',
    'Bunnies Slaughtered',
  ]),
  ...group(StatCategory.magic, [
    'Spells Learned',
    'Favorite Spell',
    'Favorite School',
    'Dragon Souls Collected',
    'Words of Power Learned',
    'Words of Power Unlocked',
    'Shouts Learned',
    'Shouts Mastered',
    'Times Shouted',
    'Favorite Shout',
  ]),
  ...group(StatCategory.crafting, [
    'Soul Gems Used',
    'Souls Trapped',
    'Magic Items Made',
    'Weapons Improved',
    'Weapons Made',
    'Armor Improved',
    'Armor Made',
    'Potions Mixed',
    'Potions Used',
    'Poisons Mixed',
    'Poisons Used',
    'Ingredients Harvested',
    'Ingredients Eaten',
    'Nirnroots Found',
    'Wings Plucked',
  ]),
  ...group(StatCategory.crime, [
    'Total Lifetime Bounty',
    'Largest Bounty',
    'Locks Picked',
    'Pockets Picked',
    'Items Pickpocketed',
    'Times Jailed',
    'Days Jailed',
    'Fines Paid',
    'Jail Escapes',
    'Items Stolen',
    'Assaults',
    'Murders',
    'Horses Stolen',
    'Trespasses',
  ]),
];
