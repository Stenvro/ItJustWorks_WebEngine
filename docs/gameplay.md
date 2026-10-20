# Gameplay systems

## Skills, levels and actor values

The rules are platform-free in `src/gameplay/progression.ts` (skills and the player's level),
`src/gameplay/actor-leveling.ts` (encounter zones, leveled and auto-calculated actors) and
`src/gameplay/vitals.ts` (regeneration and stamina costs); the running game applies them in
`src/scripting/runtime/progression-engine.ts` (`ScriptRuntime.progression`). The records are
read by `src/world/leveling-records.ts` (CLAS, ECZN, XLCM) and `src/world/perk-trees.ts` (AVIF
AVSK). `node tools/progression-info.ts` prints the curves, a level-up computed by the engine, an
NPC's level and stats, and audits the auto-calculation against every NPC\_ record.

### Skill experience

Sources: UESP "Skyrim:Leveling", "Skyrim:Skills", the AVIF records.

- A use gives `(use mult × use + use offset) × (1 + <Skill>SkillAdvance / 100)` experience. The
  use mult and offset are the skill's AVIF AVSK (with improve mult and offset):
  One-handed 6.3/0/2/0, Lockpicking 45/10/0.25/300, Smithing 1/0/0.25/300, Enchanting
  900/0/1/170, Speech 0.36/0/2/0, ... The SkillAdvance actor values are the Warrior, Mage and
  Thief Stones' and the rested bonuses (magic effects).
- A skill at level n needs `improve mult × n ^ fSkillUseCurve + improve offset` for n + 1
  (fSkillUseCurve 1.95: Lockpicking 15 → 16 needs 349.13). One use can raise several levels;
  the rest is kept. Skills rise by experience only up to 100 (the base value: fortified skills
  rise as their base).
- `useSkill(actor, skill, uses)` is the API every system calls; only the player gains (NPCs'
  skills follow their class and level). The units of use:

| Source                                                       | Uses                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| a lock opened / a pick broken (`lockpicking-menu.ts`)        | fSkillUsageLockPickVeryEasy .. VeryHard (2, 3, 5, 8, 13) / fSkillUsageLockPickBroken 0.25 |
| a trade (`barter-menu.ts`)                                   | the item's value, once a trade (UESP "Speech")                                            |
| persuade, intimidate, bribe, gifts                           | the game's FavorDialogueScript: `Game.AdvanceSkill("Speechcraft", ...)`                   |
| forging (`crafting-menu.ts`)                                 | fConstructibleSkillUseMult × value ^ fConstructibleSkilluseExp + ...Const (3, 0.65, 25)   |
| tempering                                                    | 3.8 × √(value gained × quality levels gained) (UESP's fit)                                |
| disenchanting                                                | fDisenchantSkillUse (0.0025) a gold of the enchantment                                    |
| sneaking (detection), casting (magic), hits, blocks (combat) | fSkillUsageSneakPerSecond a second; a spell's base cost; the systems that come            |

- Books, trainers and `Game.IncrementSkill(By)` (`incrementSkill`) give the experience the skill
  lacks to its next level, more by its SkillAdvance (UESP "Skill Books": "sufficient experience
  to raise the skill to the next level"); a book teaches once. `Game.AdvanceSkill(skill, n)` is
  n uses. The console's `AdvSkill <skill> <uses>`, `IncPCS <skill>` and `player.AdvLevel`.
- Each level a skill reaches tells the HUD (`ShowNotification` with SKILL_LEVEL_UPDATE:
  sSkillIncreased "%s Increased to %i", UISkillIncreaseSD, the player's level and the level
  meter from and to its progress; the movie announces the level-up once the meter fills) and
  the story manager (SKIL: OnStoryIncreaseSkill(asSkill), the WISkillIncrease quests).
- A skill at 100 can be made Legendary (`makeLegendary`, the skills menu's Space): back to
  fLegendarySkillResetValue (15), its experience gone, the perks of its tree removed and given
  back as perk points; the character keeps its level and experience.

### The player's level

- A skill reaching level n gives n × fXPPerSkillRank (1) character experience. The character
  at level L needs fXPLevelUpBase + fXPLevelUpMult × L (75 + 25 L: 100 at level 1), in all
  12.5 L² + 62.5 L − 75 from level 1.
- Experience past the threshold waits as level-ups (`GameState.levelUps`, the HUD's
  sLevelUpAvailable as one becomes available); the tween menu's LEVEL UP, the level-up menu
  before the skills menu. The meters (tween, journal, loading screen, skills menu) show
  `levelProgress` (full while one waits).
- The level-up menu's choice (`levelUp`): health, magicka or stamina + iAVDhmsLevelUp (10),
  stamina also carry weight + fLevelUpCarryWeightMod (5); the level + 1, the threshold taken
  from the experience, a perk point, health, magicka and stamina restored; the story manager's
  LEVL (OnStoryIncreaseLevel(aiNewLevel)): the Daedric quests start on it.
- Perks (`perkAvailability`, `takePerk`): a perk point, the perk playable (PERK DATA), its
  previous rank owned (NNAM leads to it), a perk it follows in its skill's tree owned (or it
  starts the tree), the player's level at least the perk's (DATA), its conditions holding on the
  player. Perk effects are the perk system's.

### Levels of actors

Sources: the Creation Kit's NPC Stats tab and Encounter Zone form (as UESP and xEdit lay them
out), UESP "Mod File Format/CLAS", "Leveled Lists".

- **Encounter zone** of a reference: its own XEZN, its cell's XEZN, the ECZN whose location is
  its cell's location or the nearest parent location with one, its worldspace's XEZN. Its level
  is set as first met: the player's level within min and max (0: none); with "Match PC Below
  Minimum Level" (0x2) below the minimum the player's own; kept (`GameState.zoneLevels`;
  zones without "Never Resets", 0x1, are set again when their cells reset: M12).
- **Leveled picks**: a reference's leveled lists (its LVLN templates, its containers' LVLI)
  are picked at its encounter's level × its level modifier (ACHR XLCM: easy
  fLeveledActorMultEasy 0.33, medium 0.67, hard 1, very hard 1.25), kept for the reference
  (`GameState.leveledLevels`) so its look (`src/shell/actors.ts`) and its scripts pick alike.
  Containers' items use the container's encounter level, an actor's items its own level.
- **Actor level**: fixed, or (ACBS PC Level Mult) ⌊mult × the followed level⌋ within calc min
  and max: the player's level for teammates (followers), the encounter's for others. Without a
  calc min it can be 0, as the Creation Kit computes it.
- **Auto calc stats** (ACBS 0x10): each level past the first brings iAVDhmsLevelUp (10)
  attribute and iAVDSkillsLevelUp (8) skill points, shared by the class's weights (CLAS DATA:
  18 skill weights at 6, health/magicka/stamina weights at 32): whole rounds of the weights,
  then the rest one point at a time in turn (higher weights first; ties the later actor value
  first: skills by index, attributes stamina, magicka, health), none past its weight. Health
  also gains fNPCHealthLevelBonus (5) a level (level 0: 5 less). Skills start at 15 + the
  race's bonus, attributes at the race's starting value + the ACBS offset; skills stop at 100.
  This reproduces every one of the 1713 auto-calculated NPC\_ records' stored health, magicka and
  stamina, and 1672 of their skills (`progression-info.ts --audit`; the others have skills at
  100, where the records show only part of the excess going to other skills). Fixed-level NPCs
  of their record's race keep their stored skills. The player is auto-calculated at level 1
  (its race's skills; its later values come from levelling up). Lydia following a level-20
  player: level 20, health 321, magicka 50, stamina 114, One-handed 61.

### Health, magicka and stamina over time

Sources: UESP "Skyrim:Health", "Skyrim:Magicka", "Skyrim:Stamina", the game settings.

- Ten times a second every living actor regenerates `max × Rate % × RateMult %` a second
  (HealRate, MagickaRate, StaminaRate: the race's 0.7, 3, 5 for the playable races;
  HealRateMult etc. 100). In combat (set by the combat system): × fCombatHealthRegenRateMult
  (0; a race with "Regen HP In Combat", RACE DATA 0x80000, keeps its rate; CombatHealthRegenMult
  raises it), × fCombatMagickaRegenRateMult (0.33: 0.99 %), × fCombatStaminaRegenRateMult
  (0.35: 1.75 %).
- Damage holds a value back fDamagedHealthRegenDelay / ...Magicka... / ...Stamina... (0.5 s).
  `spend(actor, value, amount)` (power attacks, bashes, blocking, spells) waits, when more was
  spent than there was, the deficit's regeneration time, at most fStaminaRegenDelayMax /
  fMagickaRegenDelayMax (engine values 5 s; UESP's 80-stamina power attack at 10 stamina waits
  5 s, not 7).
- Waiting and sleeping regenerate as over the real seconds the hours stand for (game hours ×
  3600 / timescale).
- Sprinting drains fSprintStaminaDrainMult × (fSprintStaminaWeightBase + fSprintStaminaWeightMult
  × worn armor's weight) a second (7 + 2 % a pound), stamina not regenerating meanwhile; at 0
  stamina the player cannot sprint (`canSprint`) and the HUD's stamina meter blinks
  (`StartStaminaMeterBlinking`; magicka's `StartMagickaMeterBlinking` for the magic system;
  health blinks of itself when low).
- Costs for combat: a power attack fPowerAttackStaminaPenalty × (fStaminaAttackWeaponBase +
  fStaminaAttackWeaponMult × weight) = 40 + 2 × weight, times its attack data's stamina mult,
  1.5 times dual-wielding (UESP); a bash fStaminaBashBase (35), a power bash
  fStaminaPowerBashBase (55); blocking fStaminaBlockBase + fStaminaBlockDmgMult × damage.
  Jumping costs nothing (UESP).

TODO(M13): the zones of parent locations, the very hard modifier's "at least the next entry
up", how much of a capped skill's excess goes on, the rounding of PC level mult and level
modifiers, the dual-wield factor, how fCombatHealthRegenRateMult and CombatHealthRegenMult
combine. TODO(M11): combat sets `inCombat` and spends stamina, the magic system gives
SkillAdvance effects, magicka costs and holds magicka regeneration while casting, detection
gives Sneak's uses, the perk system the perks' effects.
