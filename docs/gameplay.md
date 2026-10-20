# Gameplay

The gameplay systems of milestone M11: their rules (platform-independent, `src/gameplay/`), what
the running game keeps of them (`src/scripting/runtime/`) and their sources.

## Equipment

What every actor (the player and each NPC) holds and wears: its **loadout** (`Loadout`,
`src/gameplay/equipment.ts`), kept in the game state (`ActorState.equipment`; `ActorState.equipped`
mirrors it as a set) by the equip system (`ScriptRuntime.equipment`,
`src/scripting/runtime/equipment-engine.ts`). `node tools/equipment-info.ts` prints an actor's
from the real data (`--player`, `--base <editor id>`, `--audit` for every placed actor).

### Places

- **Equip slots** (EQUP; xEdit "Equip Type", CommonLibSSE `BGSEquipSlot`,
  `src/world/equip-slots.ts`): a slot without parents is one of an actor's own places, which the
  default objects name: LHEQ the left hand, RHEQ the right hand, VOEQ the voice, POEQ the potion
  slot (EHEQ is EitherHand). A slot with parents (PNAM) takes all of them when its DATA has "use
  all parents" (BothHands: both hands; Shield: the left hand), else one (EitherHand).
- An item's slot is its ETYP. Without one: weapons the right hand, carried lights (torches) the
  left hand (CommonLibSSE: `TESObjectLIGH`'s own equip slot), spells and scrolls either hand (the
  Creation Kit's default), shouts the voice, potions, food and ingredients the potion slot (they
  are used up), ammunition its own slot. Armor and clothing take their **biped slots** (BOD2 /
  BODT); a shield (ETYP Shield) takes the left hand and its biped slot 39.
- Vanilla's one-handed weapons and staves mostly name RightHand, yet the menus put them in the
  hand asked for (the player dual-wields); a hand item asked for a hand the race lacks goes in
  the other.
- A race has only the places its slots give (RACE QNAM: a wolf has its right hand, a dragon its
  right hand and voice) and uses only the equipment its VNAM flags allow (weapon types, spells,
  shields, torches).

### Equipping

- Armor comes off where a new piece covers any of its biped slots.
- A hand's item comes off when another goes there; a two-handed item (BothHands: greatswords,
  battleaxes, bows, crossbows, two-handed spells) empties both hands, and a shield or torch
  takes it off again. An item the actor has one of moves to the other hand rather than being in
  both; spells are not counted (one spell can be in both hands).
- `EquipItem` gives the actor one first if it has none (Creation Kit); `abPreventRemoval` keeps
  it on against the player and the AI; `UnequipItem`'s `abPreventEquip` keeps the AI from
  equipping it again. `UnequipAll` takes off every item (not spells or shouts),
  `UnequipItemSlot(aiSlot)` what covers a biped slot (30..61).
- Items that leave the inventory (dropped, sold, stored, `RemoveItem`, `RemoveAllItems`) come
  off when the actor no longer has enough of them.
- The actor's scripts hear `OnObjectUnequipped`, then `OnObjectEquipped` (the base object,
  reference None); the item's own scripts `OnUnequipped` / `OnEquipped` with the actor (one
  script instance per base: TODO(M13), the game has one per item). Using a potion and reading a
  book from the inventory are heard as equipping it. What the actor wears changing makes its
  look again (`WorldBridge.equipmentChanged`); listeners (`EquipmentEngine.listeners`) hear
  every change.

### Outfits and what NPCs take up

- An actor is dressed as its inventory is first read (`ScriptRuntime.inventory`, whose base
  items for an actor are those of the NPC\_ its templates take the inventory from): the pieces of
  its outfit (its own from `Actor.SetOutfit`, else its base's from `ActorBase.SetOutfit`, else its
  record's DOFT; leveled items picked at the actor's level) join its items as the outfit's and
  are worn. A new outfit takes the old one's items away and is worn (Creation Kit: SetOutfit);
  the sleep outfit (SOFT) is worn while it sleeps (`EquipmentEngine.sleep`, for the AI).
- The player gets the Player record's outfit too: the iron armor of a game started without the
  opening; the opening's scripts (MQ101) strip it (`RemoveAllItems`) and dress the prisoner.
- NPCs then take up what they carry that suits them (TODO(M13): the engine's choice is not
  documented; UESP's followers wear what has a higher rating than what covers its slots): armor
  rated above what covers the same slots, or for free slots; a melee weapon (one-handed beside a
  shield it has), else a bow or crossbow, else a staff, the one that does the most damage with
  its skill; a shield beside a one-handed weapon; the best arrows (non-bolts) or bolts for its
  bow or crossbow. Items given to an NPC are weighed the same way. Combat chooses its weapons by
  its combat style (TODO(M10) 5.2).

### The menus

- Inventory, magic and favorites: the left mouse button equips to the right hand, the right
  button to the left hand (the control map's item menu context: RightEquip and LeftEquip are
  the attack buttons). The engine calls the movie's `AttemptEquip(slot)` (it checks the mouse is
  over the list, then asks `ItemSelect(slot)`); the 3D item's quick click asks
  `CheckForMouseEquip(button)`, answered with the slot. Slots are 0 left and 1 right (the
  game's order); E or Enter (`ItemSelect()` without one) uses the item's own place, the right
  hand for either hand.
- Choosing what is equipped where asked takes it off; potions, food and ingredients are used
  (one gone, their effects cast on the player: `WorldBridge.castSpell`; an ingredient eaten shows
  its first effect), books read. Equipping plays a weapon's NAM9 / NAM8 sound, else the item's
  pick-up or put-down sound (TODO(M13): what the engine plays for armor); potions their ENIT
  consume sound.
- The rows' equip state (InventoryDefines): 1 worn or equipped, 2 the left hand, 3 the right, 4
  both hands (a two-handed item, a spell in each hand).

### Stats

- **Armor rating** of a piece (UESP "Skyrim:Armor"): ceiling((base + item quality) × skill
  multiplier) × perks. The base is DNAM / 100; the item quality what improving added
  (`temperingIncrease`, src/gameplay/crafting.ts: (3.6 × level − 1.6), half for all but chest
  armor; the player's by `GameState.itemHealth`). The skill multiplier is fArmorRatingBase (1) at
  skill 0 up to fArmorRatingPCMax (1.4: 1 + 0.4 × skill / 100) for the player, fArmorRatingMax
  (2.5: 1 + 1.5 × skill / 100) for NPCs, at 100; the skill is Light or Heavy Armor with its
  fortifications (the LightArmorMod / HeavyArmorMod and PowerMod actor values). Clothing has none.
  Perks (unison, matching set, Agile Defender / Juggernaut): `EquipmentEngine.modifiers`,
  TODO(M11) for the perk system.
- The **total** the inventory shows: the worn pieces' plus the armor effects (the DamageResist
  actor value: Oakflesh, ...). **Damage taken off**: rating × fArmorScalingFactor (0.12) percent
  plus fArmorBaseFactor (3%) per piece of armor worn (shields too, not clothing), at most
  fMaxArmorRating (80%).
- **Weapon damage** (UESP "Skyrim:Weapons"): round((base + smithing increase) × skill
  multiplier × (1 + perk effects) × (1 + item effects) × (1 + potion effect)). The skill
  multiplier is fDamagePCSkillMin (1) at skill 0 up to fDamagePCSkillMax (1.5) at 100: 1 + skill
  / 200; NPCs' fDamageSkillMin and fDamageSkillMax are built into the engine and undocumented
  (TODO(M13): taken as the player's). Item and potion effects are the skill's Mod and PowerMod
  actor values (percent). A bow's or crossbow's shot adds its ammunition's damage before the
  multipliers (`WeaponStats.shotDamage`); the inventory shows the weapon's damage plus the
  arrows' base damage (UESP "Skyrim:Archery": the menu does not multiply the arrows'). Unarmed:
  the UnarmedDamage actor value.
- **Carry weight**: the items' weights times their counts against the CarryWeight actor value.
  More is over-encumbered (`Actor.IsOverEncumbered`): the player walks (no running or
  sprinting) and the HUD says sOverEncumbered; fast travel is refused
  (sNoFastTravelOverencumbered, src/gameplay/fast-travel.ts).

### For combat, magic and perks

`EquipmentEngine` answers what an actor holds in each hand (`inHand`, `weapon`, `shield`,
`torch`, `spell(source)`, `shout`, `ammo`), wears (`worn`, `armorInSlot`), the stats
(`armorRating`, `pieceRating`, `weaponDamage`, `weaponStats(hand)`: damage, shot damage, speed,
reach, stagger, critical damage, skill, ammunition, the world and first-person models, and the
skeleton nodes it hangs on: sheathed by its type as the weapon models' "Prn" name them —
WeaponSword, WeaponDagger, WeaponAxe, WeaponMace, WeaponBack, WeaponBow; vanilla's skeleton has
no WeaponStaff or left-hand sheath nodes — drawn WEAPON in the right hand and SHIELD in the
left; arrows on QUIVER), and equips (`equip`, `unequip`, `equipSpell`, `equipShout`, `use`).

### Conditions

GetEquipped (a form list: any of its forms), GetEquippedItemType (by casting source: 0 left, 1
right; the codes of `Actor.GetEquippedItemType`: 0 hand to hand .. 8 staff, 9 a spell, 10 a
shield, 11 a torch, 12 a crossbow), GetEquippedShout, HasEquippedSpell, WornHasKeyword,
WornApparelHasKeywordCount, GetClothingValue (the worn items' value), IsTorchOut and
IsActorUsingATorch (a torch in the left hand), and of the right hand's weapon GetWeaponAnimType,
IsWeaponSkillType, IsWeaponInList, HasTwoHandedWeaponEquipped; HasBoundWeaponEquipped by hand.
IsShieldOut and IsWeaponOut need the weapon drawn (TODO(M10) 5.1).

TODO(M11): warmth (Survival Mode); TODO(M12): the loadout in the save.

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
combine. Casting spends magicka and holds its regeneration while it lasts ("Casting and
shouts"). TODO(M11): combat sets `inCombat` and spends stamina, the magic system gives
SkillAdvance effects, detection gives Sneak's uses, the perk system the perks' effects.

## Magic effects

The magic system (`src/scripting/runtime/magic-engine.ts`, the rules in
`src/gameplay/magic/effect-rules.ts`, the records in `src/world/magic-records.ts` and
`src/world/magic-effects.ts`; `node tools/magic-info.ts <item>` prints an item and applies it to
the player in a runtime on the game data, `--audit` reads every record).

### Records

- Magic items: SPEL (spell, disease, power, lesser power, ability, poison, addiction, voice by
  SPIT's type), SCRL, ENCH (ENIT: cost, flags, cast type, charge, delivery, enchant type 0x06
  or 0x0C staff, charge time, base enchantment, worn restrictions), ALCH (ENIT: value, flags
  0x2 food / 0x20000 poison, addiction and its chance, use sound), INGR. Each has effect items:
  EFID, EFIT (magnitude, area in feet, duration in seconds), CTDA.
- MGEF DATA (152 bytes, xEdit; CommonLibSSE EffectSettingData): flags (hostile, recover,
  detrimental, dispel with keywords, no duration / magnitude / area, FX persist, hidden in the
  interface, no recast, power affects magnitude / duration, painless, no hit effect, no death
  dispel), base cost, associated form @8 (a summon's NPC_, a bound weapon, a cloak's SPEL, a
  light, a hazard), magic skill @12, resist value @16, light @24, hit and enchant shaders @32,
  @36, minimum skill @40, taper @28/@52/@56, second value weight @60, archetype @64, actor value
  @68, projectile @72, explosion @76, casting type @80, delivery @84, second actor value @88,
  casting / hit / enchant art @92/@96/@116, impact data @100, dual cast art and scale
  @108/@112, hit and enchant visuals (RFCT) @120/@124, equip ability @128, image-space
  modifier @132, perk @136; KWDA, ESCE (counter effects), SNDD (sound type: 0 draw, 1 charge,
  2 ready, 3 release, 4 concentration loop, 5 on hit; SNDR), its own CTDA, VMAD.
- SLGM: SOUL, SLCP, NAM0 the filled version, record flag 0x20000 holds NPC souls.

### Applying an effect

- Strength: the effect item's magnitude and duration; dual casting's power
  (fMagicDualCastingEffectivenessBase, 2.2) scales what Power Affects Magnitude / Duration say
  (unless the spell's 0x800000 flag); No Magnitude / No Duration effects have none (UESP
  "Skyrim:Dual Casting"). TODO(M11): perks' entry points.
- Targets: objects get OnMagicEffectApply, and Open / Lock work on their locks (a lock up to the
  magnitude's level). The dead take nothing but Reanimate. The ethereal take no hostile effect.
- Level caps: Calm, Fear, Frenzy, Rally, Turn Undead, Banish, Reanimate, Command and Disarm
  reach actors up to the magnitude's level; above it the player's spell tells
  sMagicEffectResisted.
- Resistances (hostile or detrimental effects, not abilities and diseases): × (1 − resist / 100)
  of the effect's resist value (FireResist, FrostResist, ElectricResist, PoisonResist,
  MagicResist, ...), and of Magic Resistance on spells, shouts, scrolls and enchantments
  (not potions, poisons, food, ingredients; not spells that ignore resistance); the player's
  capped at fPlayerMaxResistance (85); negative resistance is a weakness. An effect without a
  magnitude is resisted whole by chance (UESP "Skyrim:Resistances", "Skyrim:Magic
  Resistance"). A disease is caught unless Disease Resistance's percentage resists it, and
  only by its effects' chance (their GetRandomPercent conditions).
- Stacking: the same effect item of the same item from the same caster and source replaces
  the one there (No Recast: it is not applied again); different items stack, but of a Peak
  Value Modifier only the strongest instance of one magic effect counts. An effect dispels
  those it counters (ESCE) and, with Dispel with Keywords, those sharing a keyword.
- Conditions: the effect item's and the magic effect's, on the target ("target" runs on the
  caster), evaluated as it is applied and about each second (TODO(M13): the engine's interval):
  while they fail the effect is inactive (it does nothing, its scripts finished; again active,
  they start anew). An effect at once whose conditions fail does nothing. A disease's
  GetRandomPercent conditions are its chance of being caught, not checked while it lasts.
- Scripts: a magic effect with scripts runs them as an ActiveMagicEffect (OnInit,
  OnEffectStart, OnEffectFinish; its natives read it until OnEffectFinish has run); the target
  gets OnMagicEffectApply; a hostile spell that reaches another (its projectile's impact, a
  script's cast delivered at once) gets OnHit ("Casting and shouts").

### What effects do

- Value effects (Value Modifier, Peak Value Modifier, Dual Value Modifier, Absorb, Accumulate
  Magnitude, Value and Parts, Enhance Weapon, Invisibility, Night Eye, Darkness, Paralysis,
  Grab Actor): Recover effects (and Peak Value Modifiers, whose class undoes them as they are
  removed) are temporary modifiers (`ActorValueState.temporary`) while they act; others damage
  or restore at once (no duration, No Duration, or lasting) or by their magnitude each second
  of their duration (Creation Kit "Magic Effect"). Detrimental effects take away. Dual Value
  Modifier changes its second actor value by the weight's share; Absorb's caster gains what
  its target loses; damage to Health names the caster the killer; the invulnerable take none.
  Effects without a magnitude set their value as a flag (1): Paralysis, Invisibility.
- Calm, Frenzy, Demoralize, Rally, Turn Undead, Banish move Aggression or Confidence to a
  target value (0 unaggressive, 3 frenzied; 0 cowardly, 4 foolhardy: TODO(M13) inferred) while
  they last; `MagicEngine.aiState` is what the combat AI reads (TODO(M10) 5.2).
- Cure Disease / Poison / Paralysis / Addiction end those effects (a disease leaves the
  actor's spells). Dispel ends spells' effects up to its magnitude (TODO(M13): Oblivion's rule).
- Summon Creature places its NPC_ before the summoner (one at a time: TODO(M11) Twin Souls),
  gone as the effect ends or the summoner dies; Reanimate raises a corpse (it falls again as it
  ends); Banish ends a summoning; Bound Weapon puts its weapon in the hand; Spawn Hazard and
  Spawn Scripted Ref place their form; Disarm takes the weapons out of the hands
  (sPlayerDisarmedMessage); Soul Trap and Actor.TrapSoul put a dead actor's soul (by level:
  iLesserSoulActorLevel 4 .. iGrandSoulActorLevel 38; NPCs black) into the smallest empty gem
  that holds it (its NAM0 form), with the Soul Captured sound (DOBJ SCSD).
- Cloaks put their spell on actors within the magnitude in feet each second (TODO(M13): the
  radius read as the magnitude). Slow Time's magnitude is the world's time
  (`timeMultiplier`, TODO(M11): the frame's clock). Invisibility ends as its actor activates.
  An actor's effects end as it dies but No Death Dispel ones.
- TODO(M11) (the archetypes) and visuals: staggers, telekinesis, grabs, Clairvoyance's path,
  lights, Detect Life's shader, effect shaders (EFSH) and art (ARTO) on actors; their data goes
  to `WorldBridge.magicEffect`, the image-space modifier is applied while an effect acts on the
  player, the On Hit sound plays at the target.

### Lasting effects and items

- Abilities, diseases and addictions an actor has, the constant enchantments of what it wears
  and their equip abilities last while it has them (`prepare`: actors as they load, the player
  at a new game; re-checked each second and as spells or races change).
- Using items (`useItem`: the inventory and favorites menus, NPCs' Eat procedure): a potion or
  food applies its effects (its use sound, its addiction by chance); an ingredient its first
  effect, which the player then knows; a poison goes on the equipped weapon after the player
  confirms (sPoisonConfirmMessage, sPoisonBowConfirmMessage; sPoisonNoWeaponMessage,
  sPoisonAlreadyPoisonedMessage), one dose for its next hit (`weaponHit`, TODO(M10) 5.1;
  sPoisoned when it hits the player). The equip system uses an item up and tells its scripts
  (EquipmentEngine.use: OnObjectEquipped), then the magic system applies it (`consumed`; the
  world shows the casting through castSpell). Worn enchantments follow the equip system's
  changes at once (its listeners).
- An actor's events (OnObjectEquipped, OnHit, OnDeath, ...) reach the scripts of the active
  magic effects on it too (Creation Kit: ActiveMagicEffect Script).
- Waiting: game time passing counts as the real seconds it stands for (TODO(M13)).
- The magic menu's Active Effects: one entry per magic item (and worn object) on the player,
  named after the object, the item or its effect; its effects' descriptions with the values
  they act with; the longest time left (ICT_ACTIVE_EFFECT's timeRemaining); detrimental or
  hostile ones in red (negativeEffect).

## Casting and shouts

The rules are platform-free in `src/gameplay/magic/casting.ts` (costs, a hand's cast, staffs,
powers), `src/gameplay/magic/shouts.ts` (words, recovery, the shout meter) and
`src/gameplay/magic/projectile-flight.ts` (what flies and what it reaches); the running game
keeps the casts in `src/scripting/runtime/casting-engine.ts` (`ScriptRuntime.casting`), the world
animates them and flies what they send (docs/ai.md, "Magic in combat"). `node
tools/casting-info.ts <spell|scroll|staff|shout>` prints a spell's cost by skill, its sounds, art,
projectile and explosion, a shout's words, spells and recovery; `--audit` reads every PROJ and
EXPL.

### What a source casts

- Casting sources (CommonLibSSE MagicSystem::CastingSource): 0 the left hand, 1 the right, 2 the
  voice, 3 instant. A hand casts its spell (magicka), its staff (a weapon whose EITM is a staff
  enchantment, ENCH 0x0C: its charge) or its scroll (used up as it is read); the voice its power
  (once a day), lesser power (whenever) or shout. Constant effect spells are not cast.
- A cast is refused without the magicka (a fire and forget spell: its cost; a concentration
  spell: any, TODO(M13)), the staff's charge (sMagicCastInsufficientItemCharge), the day's power
  (sMagicCastPowerUsed) or while shouting (sMagicCastCastWhileShouting); a shout while casting
  (sMagicCastShoutWhileCasting) or while the voice recovers (the shout meter flashes). Without
  the magicka the HUD's magicka meter blinks (`progression.refused`). Casting ends invisibility.

### Cost

Sources: UESP "Skyrim:Magic Overview", "Skyrim:Magicka", "Skyrim:Dual Casting", "Mod File
Format/SPEL"; the game settings.

- The base cost is SPIT's own with 0x1 (an enchantment's with ENIT 0x1, no auto calc), else the
  sum of its effects': base cost × (magnitude × duration / 10)^1.1, a magnitude under 1 counted
  as 1, a duration of 0 (and any for concentration spells) as 10, × (1 + fMagicAreaBaseCostMult
  × area) (0: areas cost nothing). Firebolt 41.39, Flames 24.6 a second.
- The player pays base × (1 − (fMagicCasterPCSkillCostBase × skill)^fMagicPCSkillCostScale)
  (0.0025, 0.65: Firebolt 36.5 at 15, 24.6 at 100); NPCs base × (1 − fMagicCasterSkillCostMult
  × (skill / 100)^fMagicSkillCostScale) (0.5, 0.5; TODO(M13): inferred from the settings). The
  skill is the school of the costliest effect (base cost × magnitude), with its
  fortifications; TODO(M11): the perks' cost entry points and Fortify <School>. Dual cast:
  × fMagicDualCastingCostMult (2.8). The magic menu shows this cost.
- A fire and forget spell is paid as it fires (released when ready), a concentration spell for
  the time it is held (its cost a second); regeneration waits while a cast lasts.
- A staff spends its enchantment's cost from its charge (WEAP EAMT at first; Staff of Fireball
  2000, 133 a cast: 15 casts); the charge is kept per staff (TODO(M11): per item). A scroll is
  used up. Neither, nor powers or shouts, trains a skill.

### A hand's cast

- Charging: fire and forget spells are ready after their charge time (SPIT @12, dual cast ×
  fMagicDualCastingTimeMult, 1); released before, they go without effect; released ready, they
  fire. Concentration spells cast from their charge time on until let go or out of magicka.
  NPCs release a ready spell at once and hold a concentration spell 2.5 s (TODO(M10) 5.2: the
  combat AI decides).
- Dual casting: both attack buttons pressed within 0.15 s with one spell in both hands
  (TODO(M13): the window; TODO(M11): the school's Dual Casting perk); its effects are cast with
  fMagicDualCastingEffectivenessBase (2.2: "Magic effects", EffectWasDualCast).
- Skill use: a spell that takes effect on a target gives its school its base cost in uses (dual
  cast × 2.8, TODO(M13)); a concentration spell's hit the share of the time it stands for.

### Delivery

- Self: on the caster at once. Touch: the actor aimed at (TODO(M10) 5.2: the reach). Aimed,
  target actor and target location fly the costliest effect's projectile (docs/ai.md, "Magic in
  combat"); without one they reach the actor aimed at at once.
- What reaches an actor (`deliver`): a hostile spell, scroll or staff's (not a power's or a
  shout's, nor a spell with 0x200000) is absorbed by the target's AbsorbChance percent (Spell
  Absorption: it does nothing, the target gains its magicka cost; TODO(M13): the cap); else a
  ward (WardPower, grown by a ward spell held: Accumulate Magnitude) meets a hostile spell from
  the front: its damage (its hostile effects' magnitudes on Health, Magicka, Stamina) up to the
  ward's strength is absorbed and taken off it (IsWardState 1, ActionWardHit: wardAbsorb), more
  breaks it (IsWardState 2, WardBreak) and the rest passes (UESP "Skyrim:Ward"). Then the magic
  system applies it (resistances, dual casting: "Magic effects"); a hostile spell's target hears
  OnHit (the caster, the spell or staff) and is attacked (detection: it searches for the caster).
- A concentration spell's hit (a spray of Flames, a held Healing): its effects at once act by the
  time the hit stands for (`ApplyOptions.scale`); those that last while it is held (wards,
  Recover effects, Calm, Telekinesis: `hold`) last on with each hit (`extendHeld`) rather than
  anew (a ward keeps what it has grown).
- Areas: an effect with an area (feet) reaches the actors within it of where the spell landed
  (each the effects whose area reaches it; TODO(M13): line of sight and SPIT 0x80000).
  Explosions (the projectile's with its Explosion flag, else the effect's): their enchantment on
  the actors within their radius, their damage on Health less with distance (linear, TODO(M13)),
  their force pushing what is there.
- Target Location: what it makes (summons, hazards, scripted references) stands where it landed
  (`ApplyOptions.at`: the summon facing the summoner); its other effects reach those near by its
  explosion and area.
- Scripts' casts (Spell.Cast, RemoteCast) fly from the source's right hand (an object's place)
  toward the target's chest, or along its facing (WorldBridge.launchSpell); free.
  DoCombatSpellApply delivers at once.

### Shouts and powers

Sources: UESP "Skyrim:Shouts", "Skyrim:Dragon Souls", "Skyrim:Powers"; SHOU and WOOP.

- A shout has up to three words (SNAM: the word, the spell of that many words, the voice's
  recovery). An actor shouts the words it knows in a row from the first: the player those
  learned (Game.TeachWord: word walls' scripts) and unlocked (Game.UnlockWord; the magic menu's
  Unlock, a dragon soul each: the DragonSouls actor value, sConfirmSpendSoul, sFailSpendSoul),
  NPCs all.
- The voice key (Shout, Z) tapped shouts the first word, held from fShoutTime1 (0.2 s) two, from
  fShoutTime2 (0.9 s) three (TODO(M13): the settings read as hold times). The word's spell is
  cast (most are cones: Unrelenting Force; some Self: Whirlwind Sprint), its release sound is the
  thu'um (MGEF release sound); the player's shakes the view as the controller would rumble
  (fShoutRumbleBigMotorFrequencyV<n>, ...DurationV<n>: WorldBridge.shakeCamera, TODO(M13)).
- The voice then recovers for that word's recovery × (1 − ShoutRecoveryMult) (the Blessing of
  Talos's 0.2 is "20 % less"; TODO(M13): inferred from its text): Unrelenting Force 15, 20, 45 s.
  ActorState.voiceRecoveryTime counts down (Get/SetVoiceRecoveryTime); the HUD's shout meter
  shows it (SetShoutMeterPercent) and flashes (FlashShoutMeter) at a shout before it has
  recovered. GetCurrentShoutVariation is the last shout's words less one (the idle tree's
  Whirlwind Sprint variants).
- Powers in the voice are cast as they are ready (the key need not be held), once a game day
  (24 hours since the last use); lesser powers whenever. They share the voice key, not its
  recovery.

### Conditions and natives

IsCasting, IsDualCasting; by casting source GetCurrentCastingType and GetCurrentDeliveryType (what
the source casts now, else what it holds: the idle tree asks before a cast begins), SpellHasKeyword,
IsCurrentSpell; IsWardState; GetCurrentShoutVariation; HasShout; GetEquippedShout (the equip
system). SpellHasCastingPerk is 0 until the perk system (TODO(M11)). Natives: InterruptCast,
DoCombatSpellApply, Get/SetVoiceRecoveryTime (the meter counts down from what it is set to),
Game.TeachWord, UnlockWord, IsWordUnlocked; Spell.Cast and RemoteCast fly.

TODO(M12): the powers used, the staffs' charge, the words learned and the voice in the save.

## Crime and factions

Crime's rules are platform-free in `src/gameplay/crime.ts` (bounties, the pickpocket chance,
jail, guards' responses, trespass warnings, the witness ledger) and `src/gameplay/factions.ts`
(reactions, favor); the running game keeps them in `src/scripting/runtime/crime-engine.ts`
(`ScriptRuntime.crime`), its conditions in `crime-conditions.ts`; the stage (witnesses' lines,
alarms, guards arresting, trespass warnings, jail escapes) is `src/shell/actor-crime.ts`. The
records: FACT's crime fields (`FactionCrime`, `src/world/actor-stats-records.ts`). `node
tools/crime-info.ts` lists the crime factions with their values, jails and chests (`--all`,
`--settings`, `--pickpocket` a chance table, `--fences`, `--guards`).

### Crime factions

- A crime faction (FACT, xEdit; CommonLibSSE `TESFaction::CRIME_DATA`): DATA flags (Track Crime
  0x40, Ignore Murder / Assault / Stealing / Trespass / Pickpocket / Werewolf, Do Not Report
  Crimes Against Members 0x800, Crime Gold: Use Defaults 0x1000), JAIL the exterior jail marker
  (where the player is let out), WAIT the follower wait marker, STOL the stolen goods chest,
  PLCN the evidence chest, CRGR the shared crime factions (CrimeFactionsList: the holds), JOUT
  the jail outfit, CRVA (arrest, attack on sight, murder, assault, trespass, pickpocket, steal
  multiplier, escape, werewolf). With Use Defaults the game settings stand for the values:
  iCrimeGoldMurder 1000, iCrimeGoldAttack 40, iCrimeGoldTrespass 5, iCrimeGoldPickpocket 25,
  iCrimeGoldEscape 100, iCrimeGoldWerewolf 1000 (the engine's built-in values where Skyrim.esm
  stores none; every hold's CRVA stores the same), theft half the value (DEFAULT_STEAL_MULT;
  UESP "Skyrim:Crime"); a stolen horse iCrimeGoldStealHorse (100).
- The faction a crime goes to: the victim's crime faction (`Actor.GetCrimeFaction`, NPC\_ CRIF),
  else an owner's (an NPC\_'s CRIF, an owning faction that tracks crime), else the place's (its
  location's or the nearest parent's LCTN FNAM).
- The interior jail: the prison marker (PrisonMarker, 0x4) in the evidence chest's cell, else in
  an interior the faction owns, else in the jail of a faction of its crime group sharing its
  exterior marker (the Dark Brotherhood's targets), else whose interior's location lies up the
  exterior marker's locations (Winterhold). All 32 crime factions with a jail find one
  (TODO(M13): the engine's way is not documented).

### Crimes and witnesses

- The player's crimes: stealing (taking an item, or from a container, that another owns:
  `ScriptRuntime.mayUse`, the reference's XOWN else its cell's; the crosshair's red sSteal and
  sStealFrom; the container menu's entries red, `isStealing`), pickpocketing, trespassing,
  picking an owned lock in sight (a trespass), assault, murder, a stolen horse ("Do you want to
  steal this horse?", sStealHorse), escaping jail, a werewolf changing
  (SendWereWolfTransformation) and feeding (StartVampireFeed, StartCannibal: an assault,
  TODO(M13)).
- A crime is reported only if seen: its witnesses are detection's (`Detections.witness`: those
  that detect the criminal now), of them the victim and those whose crime faction is the
  crime's or in its crime group; not the player's followers, nor friends of the player
  (relationship friend or better overlooks theft, trespass and pickpocketing; an ally assault
  too; murder no one; `overlooksCrime`). Unseen, there is no bounty (stolen items are marked
  stolen all the same).
- Seen, the bounty goes to the faction at once (violent for assault, murder and the werewolf:
  GetCrimeGoldViolent), its infamy and the stats (Total Lifetime Bounty, Largest Bounty, Items
  Stolen, Assaults, Murders, ...) with it; the story manager's Crime Gold event
  (OnStoryCrimeGold), Assault Actor, Trespass, Pick Lock and Kill Actor (crime status 0 none, 1
  unseen, 2 seen) events. Each witness says its line to the criminal (Steal, Assault, Murder,
  Trespass, PickpocketCombat; the NC lines, StealFromNC, AssaultNC, ..., for those that are no
  guards; WereTransformCrime) and raises an alarm (those within iCrimeAlarmRecDistance).
- Killing the last witness before the crime is reported takes its bounty back
  (sWitnessKilled, "Last witness killed."). A crime is reported once a guard saw it or after
  REPORT_HOURS (a game day; TODO(M13): the engine's report rule). GetCrimeKnown answers from the
  crimes recorded.
- Assaults and murders: an attack on, or the killing of, one that does not regard the attacker
  as hostile (`reaction`). Kills reach crime through `ActorEngine.kill`; combat's hits
  (`src/shell/actor-combat.ts`) and hostile spells call `crime.assault(attacker, victim)`, the
  one hit always among the witnesses (TODO(M10) 5.3: from the projectile's impact).

### Stolen items

- Items taken without the right are stolen, per stack and whose (`CrimeState.stolen`: by
  container, base, the crime faction and whether it was seen: GetStolenItemValue /
  ...NoCrime). Moving items, the ones that are not stolen leave first; the stolen ones stay
  stolen where they go.
- Vendors buy stolen items only as fences (the vendor faction's VENV "buys stolen items": the
  Thieves Guild's ServicesThievesGuild\* factions, which the TGFences quest gives the fences);
  sold, they are no longer stolen. A gift menu without abShowStolenItems does not offer them.
- A fine paid with abRemoveStolenItems, and jail, take them to the faction's stolen goods chest.

### Pickpocketing

- Sneaking, activating a living actor is "Pickpocket" (sPickpocket): the container menu on its
  pockets, each card showing the chance (pickpocketChance: "% TO STEAL", "TO PLACE" on the
  player's side). The chance: (fPickPocketActorSkillBase + fPickPocketActorSkillMult × the
  thief's Pickpocket) + fPickPocketTargetSkillMult × (fPickPocketTargetSkillBase + the
  target's Pickpocket) + fPickPocketWeightMult × weight + fPickPocketAmountMult × value, times
  the perks (TODO(M11)), within fPickPocketMinChance and fPickPocketMaxChance (0, 90). At
  Pickpocket 15 against 15 a coin is 26 %, a 200-gold amulet 2 %; at 100 they are 90 % and 87 %
  (TODO(M13): how the engine combines the terms).
- Each take (or placing) is an attempt: succeeding, the item moves, stolen, with Pickpocket uses
  (value ^ fPickpocketSkillUsesCurve; TODO(M13)), Pockets Picked and Items Pickpocketed;
  failing, the menu closes (sPickpocketFail) and the target reports the pickpocket crime.

### Trespassing

- An interior is off limits to the player once they picked the lock of its load door, or its
  owner locked its doors with them inside (the LockDoors procedure; UnlockDoors and
  UnlockOwnedDoorsInCell open it again). There, in a cell owned by another and not public
  (CELL DATA 0x20), they trespass (IsTrespassing).
- Those who see a trespasser warn them (the senses' guard warning: they come up, their Trespass
  line) every fAITrespassWarningTimer (5 s), iGuardWarnings (2) times (GetTrespassWarningLevel);
  staying, it is the trespass crime. No waiting or sleeping meanwhile (sNoWaitTrespass,
  sNoSleepTrespass); nor sleeping in an owned bed (sNoSleepInOwnedBed).

### Guards, fines and jail

- Guards (IsGuard: a guard class, CLAS DATA flag 0x1, or IsGuardFaction) that see the player
  answer `guardResponse`: an enemy of their faction or one resisting its arrest they attack; a
  bounty they pursue when a crime alarmed them, or on sight at
  CrimeArrestOnSightViolentThreshold (999) / ...NonViolentThreshold (1000): they arrest where
  the faction arrests (CRVA), else attack where it attacks on sight. A guard told to let it go
  (SetLastArrestTime: its Variable03) waits a day.
- An arrest: the guard runs up and force-greets with DialogueCrimeGuards' ForceGreet topic; its
  lines' scripts do the rest: PlayerPayCrimeGold (the gold and stolen items taken; with
  abGoToJail the player is let out at the exterior jail marker; Fines Paid, the Pay Fine
  event), SendPlayerToJail, SetPlayerResistingArrest (its guards attack: `hostileGuards`, the
  combat AI's reaction), the Thieves Guild's bribe, payoff and persuasion (CrimeGuardsScript,
  FavorDialogueScript: GetBribeAmount; StopCombatAlarm on the player ends the pursuit).
  GetCrimeGold, ...Violent, ...Nonviolent, CanPayCrimeGold, GetArrestingActor, GetBribeSuccess
  answer them. TODO(M13): the engine's arrest package and pursuit lines (PursueIdleTopic).
- While guards pursue: no waiting or sleeping (sNoWaitWhileAlarm), fast travel
  (sNoFastTravelAlarm) or lockpicking (sNoLockPickIfCrimeAlert).
- Jail (UESP "Skyrim:Jail"): the stolen items go to the stolen goods chest, with
  abRemoveInventory the rest to the evidence chest and the jail outfit is worn; the bounty is
  set aside for one day per iCrimeDaysInPrisonMod (100) gold, at least one; the player is taken
  to the jail's prison marker (the Jail event, Times Jailed). Serving (Game.ServeTime: the jail
  bed's JailBedScript): the days pass (`WorldBridge.passTime`), each a skill's progress towards
  its next level lost (since patch 1.9 no level is lost; TODO(M13): the engine's choice of
  skills), the items come back, the player is let out at the exterior jail marker (Days Jailed,
  the Served Time event). Leaving the jail's cell unserved is an escape: the bounty comes back
  with iCrimeGoldEscape (Jail Escapes, the Escape Jail event: EscapeJailQuest).
- The journal's stats list each bounty ("Whiterun Bounty", sBountyStatString).

### Factions and reactions

- `reaction(actor, other)` (the combat AI's, 5.2; IsHostileToActor, GetFactionRelation): itself
  a friend; frenzied (Aggression 3), a crime against the player (a faction that made them its
  enemy, SetPlayerEnemy; guards to attack them) or a relationship of enemy or worse: hostile;
  else a friend (a friend combat reaction, a relationship of friend or better), an ally (an
  ally reaction, a shared faction without Special Combat), hostile (an enemy reaction), or
  neutral. The combat reactions are the factions' XNAM, as scripts set them (SetAlly,
  SetEnemy). `attacksOnSight(aggression, reaction)`: aggressive actors attack enemies, very
  aggressive neutrals too, frenzied anyone. TODO(M13): the engine's precedence.
- Relationships (RELA) and their association types (ASTP: HasAssociationType,
  HasFamilyRelationship by ASTP DATA 0x1, HasParentRelationship).
- Favor: a gift's worth (its value; TODO(M13)) is ShowGiftMenu's favor points, which raise the
  actor's relationship with the player at iFavorFriendValue (25), iFavorConfidantValue (50) and
  iFavorAllyValue (100) points, never lowering it (the Relationship Change event).
- The player's memberships are their factions' ranks (scripts join and expel them:
  GetPCExpelled, SetPlayerExpelled, GetPCEnemyofFaction, GetPCInFaction).

TODO(M12): crime's state in the save. TODO(M11): the perks' pickpocket and bribe effects
(Light Fingers, Cutpurse, Bribery's cost), NPCs' Acquire with Allow Pickpocketing.
