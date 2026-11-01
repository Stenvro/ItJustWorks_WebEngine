# Gameplay: completeness

What "100" means here: everything the load order (Skyrim.esm, Update, the three DLCs and the
Creation Club files of the install) gives the gameplay systems is read and run as the original
does: every perk entry point and function the perks use, every magic effect archetype and its
data, the spells', scrolls', enchantments', potions' and ingredients' fields, shouts and words,
the skills (AVIF: skill use, the perk trees), level-up and the stats settings, crafting (the
workbenches and their recipes: smithing, tempering, enchanting, alchemy, cooking, smelting,
tanning), crime (its settings, the factions' crime data, jail, bounty, pickpocketing,
lockpicking), factions (flags, ranks, reactions, vendors), inventory and equipment (equip slots,
armor and weapon data gameplay reads) and the gameplay game settings. The combat side of weapons
and the guards' side of crime have their own lists (docs/completeness/combat.md, ai.md).

The data part comes from the sweep `node tools/gameplay-completeness.ts` (`--all` for every item
with where it is read, `--markdown` for the lists below). An item is done when the engine reads
it: a field or flag referenced by name outside the file that parses it, an entry point or
archetype named by the code that runs it, a game setting named in the code (or built by name at
run time), a recipe keyword some workbench has; or the sweep's INERT and EXPLAINED tables say
why the original reads nothing more there. The counts are the records (entries, effects) using
the item. Items no record uses are open but counted apart: only mods need them. The mechanics
part is kept by hand against docs/gameplay.md and the conformance suites.

## Count (2026-11-01, round 1)

| Part                               | Items | Done | Open | Open, unused |
| ---------------------------------- | ----: | ---: | ---: | -----------: |
| Perks (entry points, functions)    |   116 |  103 |   13 |           12 |
| Magic effects (archetypes, flags)  |   104 |   96 |    8 |            3 |
| Spells, enchantments, potions      |    43 |   40 |    3 |            1 |
| Shouts, skills (SHOU, WOOP, AVIF)  |    16 |   16 |    0 |            0 |
| Crafting (FURN, COBJ)              |    26 |   23 |    3 |            1 |
| Factions (FACT)                    |    40 |   37 |    3 |            0 |
| Equipment (EQUP, ARMO, WEAP, AMMO) |    43 |   30 |   13 |            5 |
| Game settings                      |   172 |  149 |   23 |            0 |
| Mechanics (by hand)                |    20 |   16 |    4 |            0 |
| Total                              |   580 |  510 |   70 |           22 |

Round 1 wrote the sweep and this list, and built down:

- Weapons Unequipped (MQ101's cart, the sleep and meal packages): the package takes the weapons
  from the actor's hands and does not give them back as the flag goes; the actor's combat takes
  one up when it fights (src/shell/actor-package-gear.ts). Observed in the original: Helgen's
  first prisoner keeps the Iron Battleaxe he carries in his pack from the cart to the block. The
  battleaxe came back to his hands as the riders got off (a fresh game; a save then kept it), not
  on a load: tests/sim-opening-ride.int.test.ts checks his empty hands before the save and after
  the load.
- No Area (MGEF DATA 0x800, 1,062 effects): an effect with it takes none of its item's area
  (16 vanilla effect items give one an area: Blizzard, the werewolf's howl, Mora's Grasp ...)
  (casting-engine.ts area; tests/conformance/magic/projectiles-explosions.test.ts).
- No Hit Event (MGEF DATA 0x10, 162 effects): a spell whose every delivered effect has it tells
  no hit (OnHit) (casting-engine.ts deliver; the same suite).
- Sneaking trains Sneak: fSkillUsageSneakPerSecond (0.625) uses a second while the player sneaks
  within detection's reach of an actor unaware of them (src/shell/actor-senses.ts;
  tests/conformance/magic/skill-use.test.ts). TODO(M13): which actors count in the engine.
- The earlier games' leftover settings (Fallout 3's experience rewards, computers, weapon
  condition, speech challenges: 58 settings) recorded as read by nothing (the sweep's INERT).

## Next biggest open items

1. Painless (MGEF 0x4000000, 228 effects): the hit reaction a painless effect does not cause
   (no flinch, no pain sound) is not honoured.
2. Faction flags Can Be Owner (441) and Hidden From PC (412): not read; where the original uses
   them (ownership by a faction without the flag, the hidden factions' lists) is to be found.
3. Snap To Navmesh (92 effects: summons, Magelight-like placements) and Gory Visuals (19).
4. Weapons: Can't Drop (131: the item stays in the inventory), Embedded Weapon (4), Not Used In
   Normal Combat (3), Player Only, Non-Hostile, Ignores Normal Weapon Resistance (1 each).
5. The magic settings no code names: fMagicLight{Forward,Height,Side}Offset (where a Light
   spell's light stands), fMagicAreaScale{Min,Max}, fMagicRangeTargetCostMult,
   fInvisibilityMaxRefraction, fSummonedCreature{Min,Max}FollowDist and FadeOutSeconds; the
   ingredient settings iIngredient{AlchemyUses,WortcraftUses,UseEffectThreshold};
   fEnchantingSkillFactor; fLevelScalingMult; iLockLevelMaxVeryEasy.
6. Perks of more than one rank in DATA (27): ranks are read from the NNAM chain; the DATA count
   not read.
7. The jail's follower wait marker (WAIT, 35 crime factions): followers do not go there while
   the player serves time.
8. Extend Duration On Recast (16 enchantments), PC Start Spell (1 spell), the werewolf and
   vampire lord archetypes (their scripts do the change; the archetypes' own engine part not
   identified), Camping's campfire cooking (Camping_CampfireCookingShared on no workbench) and 4
   Hearthfire building keywords on no workbench.

## Mechanics (by hand)

- [x] Skill use and its multiplier and offset (AVSK), skill levels, level-up with its choice,
      perk points, legendary skills (src/gameplay/progression.ts,
      src/scripting/runtime/progression-engine.ts).
- [x] Sneaking trains Sneak (src/shell/actor-senses.ts sneakTraining).
- [x] Skill books, trainers (src/gameplay/training.ts, src/shell/book-reading.ts).
- [x] Perk trees and their requirements (src/shell/skills-menu.ts, progression-engine.ts
      perkAvailability).
- [x] Smithing and tempering (src/gameplay/crafting.ts, src/scripting/runtime/crafting-engine.ts).
- [x] Enchanting: learning, enchanting, recharging; alchemy: effects learned, potions, poisons.
- [x] Cooking, smelting, tanning: create-object benches by their keywords
      (src/shell/crafting-models.ts).
- [x] Crime: bounty, witnesses, arrest, paying the fine, jail, serving time, escape
      (src/gameplay/crime.ts, src/scripting/runtime/crime-engine.ts).
- [x] Pickpocketing, lockpicking, stolen goods and fences (crime-engine.ts, src/shell/lock-picking.ts).
- [x] Factions: ranks, reactions, vendors (their hours, places, buy lists), barter prices
      (src/gameplay/factions.ts, barter.ts, src/scripting/runtime/actor-engine.ts).
- [x] Outfits, sleep outfits and an NPC's default equipment; Weapons Unequipped (round 1)
      (src/scripting/runtime/equipment-engine.ts, src/shell/actor-package-gear.ts).
- [x] Armor rating, weapon damage, carry weight and encumbrance (src/gameplay/equipment.ts).
- [x] Hotkeys and favorites, inventory weight and value (src/gameplay/hotkeys.ts, inventory.ts).
- [x] Shouts: words learned and unlocked, cooldowns (src/gameplay/magic/shouts.ts).
- [x] Waiting, sleeping and fast travel's time (src/gameplay/waiting.ts, fast-travel.ts).
- [x] Beast forms' perk trees (src/gameplay/beast-perk-trees.ts).
- [ ] NPCs' improved items (the leveled lists' and merchants' tempered goods): TODO(M13), not
      documented.
- [ ] Enchanting: an item's charge without EAMT (docs/engine-map.md, Enchanting).
- [ ] Followers at the jail's wait marker (the sweep's crime.followerWaitMarker).
- [ ] NPCs' crimes beyond assault (docs/completeness/ai.md holds the guards' side).

## Lists (from the sweep)

### Perk entry points (81 of 92)

- [x] calculateWeaponDamage (12), calculateMyCriticalHitChance (14), calculateMyCriticalHitDamage (8), modRecoveredHealth (0), modEnemyCriticalHitChance (0), modRecoverArrowChance (2), modBashingDamage (2), modPowerAttackStamina (4), modPowerAttackDamage (2), modIncomingStagger (2), modTargetStagger (1), modIncomingDamage (23), modTargetDamageResistance (7), modPercentBlocked (8), modShieldDeflectArrowChance (1), setSweepAttack (1), applyCombatHitSpell (58), applyBashingSpell (5), setBooleanGraphVariable (3), applyWeaponSwingSpell (1), modSoulPctCapturedToWeapon (1): src/shell/actor-combat.ts
- [x] adjustBookSkillPoints (1): src/shell/book-reading.ts
- [x] modBuyPrices (15), activate (19), modSellPrices (15), filterActivation (13), setActivateLabel (3), allowMountActor (1): src/scripting/runtime/perk-engine.ts
- [x] addLeveledListOnDeath (0): src/scripting/runtime/actor-engine.ts
- [x] getMaxCarryWeight (0): src/scripting/runtime/equipment-engine.ts
- [x] ignoreRunningDuringDetection (0), modDetectionLight (1), modDetectionMovement (1), modDetectionSneakSkill (10), applySneakingSpell (2): src/shell/actor-senses.ts
- [x] ignoreBrokenLock (0): src/scripting/runtime/natives/reference.ts
- [x] modSneakAttackMult (4): src/scripting/runtime/stat-events.ts
- [x] modBowZoom (1), modFallingDamage (2): src/shell/time-flow.ts
- [x] modSkillUse (8): src/scripting/runtime/progression-engine.ts
- [x] modTelekinesisDistance (0), modTelekinesisDamageMult (0), modTelekinesisDamage (0): src/shell/player-casting.ts
- [x] modSpellMagnitude (61), modSpellDuration (17), modIncomingSpellMagnitude (8), modIncomingSpellDuration (0), applyReanimateSpell (2), modCommandedActorLimit (4), modPlayerMagicSlowdown (1), modPoisonDoseCount (1): src/scripting/runtime/magic-engine.ts
- [x] modArmorWeight (10), modAttackDamage (81), modSoulGemRecharge (1), modAlchemyEffectiveness (11), modInitialIngredientEffectsLearned (3), purifyAlchemyIngredients (1), modTemperingHealth (21), modEnchantmentPower (13), modSoulGemEnchanting (0), modNumberAppliedEnchantmentsAllowed (1), modArmorRating (31), modPotionsCreated (1): src/scripting/runtime/perk-hooks.ts
- [x] modSpellCost (43), modWardMagickaAbsorptionPct (3), canDualCastSpell (5), modShoutOk (3): src/scripting/runtime/casting-engine.ts
- [x] modPlayerIntimidation (1), modFavorPoints (0), modBribeAmount (0), modPickpocketChance (13), shouldApplyPlacedItem (2), modLockpickingCrimeChance (1): src/scripting/runtime/crime-engine.ts
- [x] modSpellCastingSoundEvent (1): src/shell/actor-casting.ts
- [x] modLockpickSweetSpot (13), setLockpickStartingArc (1), makeLockpicksUnbreakable (2), modLockpickingKeyRewardChance (1): src/shell/lock-picking.ts
- [x] canPickpocketEquippedItem (2): src/shell/container-menu.ts
- [x] modIngredientsHarvested (1): src/scripting/runtime/harvest-engine.ts
- [x] modSpellRangeTargetLoc (11): src/shell/hud-controller.ts
- [ ] calculateMineExplodeChance (0): unused by the load order (mods only)
- [ ] adjustLimbDamage (0): unused by the load order (mods only)
- [ ] getShouldAttack (0): unused by the load order (mods only)
- [ ] modAddictionChance (0): unused by the load order (mods only)
- [ ] modAddictionDuration (0): unused by the load order (mods only)
- [ ] modPositiveChemDuration (0): unused by the load order (mods only)
- [ ] modMaxPlaceableMines (0): unused by the load order (mods only)
- [ ] modSecondaryValueWeight (0): unused by the load order (mods only)
- [ ] modPlayerReputation (0): unused by the load order (mods only)
- [ ] modLockpickLevelAllowed (0): unused by the load order (mods only)
- [ ] setProgressionPicking (0): unused by the load order (mods only)

### Perk entry functions (16 of 16)

- [x] none (0): src/gameplay/perk-entry-points.ts: an entry without a function changes nothing
- [x] setValue (65), addValue (58), multiplyValue (367), addRangeToValue (0), addActorValueMult (0), absoluteValue (0), negativeAbsoluteValue (0), setToActorValueMult (3), multiplyActorValueMult (0), multiplyOnePlusActorValueMult (36): src/gameplay/perk-entry-points.ts
- [x] addLeveledList (0), addActivateChoice (19), selectSpell (68), selectText (3), setText (3): src/scripting/runtime/perk-engine.ts

### Perk entries (6 of 8)

- [x] quest stage entries (PRKE type 0) (28): src/scripting/runtime/perk-engine.ts
- [x] ability entries (PRKE type 1) (32): src/gameplay/magic/effect-rules.ts
- [x] condition tabs (PRKC) within the entry point (0): src/gameplay/perk-entry-points.ts (every tab a subject)
- [x] conditions (the perk requirements) (279), next (NNAM: the next rank) (85): src/scripting/runtime/progression-engine.ts
- [x] hidden (67): src/scripting/runtime/dialogue-engine.ts
- [ ] trait (0): unused by the load order (mods only)
- [ ] ranks (DATA: above 1) (27): not read

### Magic effect archetypes (43 of 47)

- [x] valueModifier (446), absorb (58), dualValueModifier (134), calm (22), demoralize (27), frenzy (13), disarm (6), commandSummoned (1), invisibility (13), darkness (0), nightEye (0), boundWeapon (9), summonCreature (81), detectLife (19), telekinesis (1), paralysis (29), reanimate (14), turnUndead (13), valueAndParts (0), accumulateMagnitude (3), peakValueModifier (332), rally (8), enhanceWeapon (4), banish (4), grabActor (1): src/gameplay/magic/effect-rules.ts
- [x] script (351): src/scripting/runtime/magic-engine.ts: a Script effect does nothing but run its scripts (OnEffectStart, OnEffectFinish) and its actor value, as every effect does
- [x] dispel (0), cureDisease (3), lock (0), open (0), soulTrap (4), werewolfFeed (1), cureParalysis (0), cureAddiction (0), curePoison (1), stagger (52), cloak (46), slowTime (5), spawnHazard (13), etherealize (4), spawnScriptedRef (1): src/scripting/runtime/magic-engine.ts
- [x] light (8): src/gameplay/magic/projectile-flight.ts
- [x] guide (1): src/shell/actor-stage.ts
- [ ] concussion (0): unused by the load order (mods only)
- [ ] werewolf (2): not read
- [ ] disguise (0): unused by the load order (mods only)
- [ ] vampireLord (1): not read

### Magic effect flags (15 of 18)

- [x] hostile (549), recover (778), detrimental (579), noDuration (366), noMagnitude (291), powerAffectsMagnitude (964), powerAffectsDuration (424): src/gameplay/magic/effect-rules.ts
- [x] noHitEvent (162), noArea (1062): src/scripting/runtime/casting-engine.ts
- [x] dispelWithKeywords (162), fxPersist (927), noRecast (352), noHitEffect (119), noDeathDispel (415): src/scripting/runtime/magic-engine.ts
- [x] hideInUi (340): src/shell/inventory-menu.ts
- [ ] snapToNavmesh (92): not read
- [ ] goryVisuals (19): not read
- [ ] painless (228): not read

### Magic effect fields (38 of 39)

- [x] description (949): src/gameplay/chargen-catalog.ts
- [x] baseCost (958), skill (829), perk (47): src/gameplay/crafting.ts
- [x] associatedItem (221), hitShader (765), secondValueWeight (117), secondActorValue (134), hitEffectArt (359), hitVisuals (0), equipAbility (58), imageSpaceModifier (260), counterEffects (0), scripted (576): src/scripting/runtime/magic-engine.ts
- [x] resistValue (351), taperWeight (548), taperCurve (214), taperDuration (193), skillUsageMult (555): src/gameplay/magic/effect-rules.ts
- [x] light (535): src/gameplay/inventory.ts
- [x] enchantShader (191), enchantArt (21): src/gameplay/magic/enchantment-glow.ts
- [x] minimumSkill (337): src/shell/magic-menu.ts
- [x] actorValue (1072): src/gameplay/actor-leveling.ts
- [x] projectile (527), explosion (161), aiScore (8), aiDelay (12): src/scripting/runtime/casting-engine.ts
- [x] castingType (1154): src/scripting/runtime/condition-values.ts
- [x] delivery (751): src/gameplay/magic/casting.ts
- [x] castingArt (731), dualCastArt (11), dualCastScale (1729), castingSoundLevel (424), sounds (1075): src/shell/actor-casting.ts
- [x] impactData (556): src/shell/actor-combat.ts
- [x] keywords (773): src/gameplay/barter.ts
- [x] conditions (563): src/scripting/runtime/actor-engine.ts
- [ ] enchantVisuals (0): unused by the load order (mods only)

### Spells, scrolls, enchantments, potions, ingredients (31 of 31)

- [x] SPEL castType (1451), SPEL delivery (1451), SPEL effects (1451), SCRL castType (104), SCRL delivery (104), SCRL effects (104), ENCH castType (757), ENCH delivery (757), ENCH effects (757), ALCH castType (0), ALCH delivery (0), ALCH effects (472), INGR castType (0), INGR delivery (0), INGR effects (180): src/gameplay/magic/casting.ts
- [x] SPEL cost (794), SCRL cost (103), ENCH cost (614), ALCH cost (0), INGR cost (0): src/gameplay/crafting.ts
- [x] SPEL chargeTime (552), SCRL chargeTime (38), ENCH enchantment.amount (613): src/scripting/runtime/casting-engine.ts
- [x] SPEL castingPerk (196), SCRL castingPerk (0): src/scripting/runtime/perk-engine.ts
- [x] ENCH enchantment.baseEnchantment (360), ENCH enchantment.wornRestrictions (80), ALCH potion.value (466), INGR potion.value (0): src/scripting/runtime/crafting-engine.ts
- [x] ALCH potion.addiction (0), ALCH potion.useSound (470): src/scripting/runtime/magic-engine.ts

### Spell and scroll flags (SPIT) (5 of 6)

- [x] manualCost (332), ignoreResistance (44), noDualCastModification (91): src/scripting/runtime/magic-engine.ts
- [x] areaIgnoresLineOfSight (84), disallowAbsorbReflect (98): src/scripting/runtime/casting-engine.ts
- [ ] pcStartSpell (1): not read

### Enchantment flags (ENIT) (1 of 2)

- [x] noAutoCalc (57): src/scripting/runtime/crafting-engine.ts
- [ ] extendDurationOnRecast (16): not read

### Potion and ingredient flags (ENIT) (3 of 4)

- [x] noAutoCalc (176), poison (83): src/scripting/runtime/crafting-engine.ts
- [x] food (177): src/gameplay/inventory.ts
- [ ] medicine (0): unused by the load order (mods only)

### Shouts and words (6 of 6)

- [x] SHOU words (SNAM word) (351): src/scripting/runtime/casting-engine.ts
- [x] SHOU words (SNAM spell) (351): src/gameplay/equipment.ts
- [x] SHOU words (SNAM recovery) (351): src/gameplay/magic/shouts.ts
- [x] SHOU description (DESC) (117): src/shell/magic-menu.ts
- [x] SHOU menu display object (MDOB) (114): src/shell/item-3d.ts
- [x] WOOP translation (TNAM) (88): src/scripting/runtime/runtime.ts

### Skills (AVIF) (10 of 10)

- [x] AVSK useMult (20), AVSK useOffset (20), AVSK improveMult (20), AVSK improveOffset (20): src/gameplay/progression.ts
- [x] perk tree node perk (219): src/gameplay/crafting.ts
- [x] perk tree node column (219), perk tree node row (219), perk tree node offsetX (219), perk tree node offsetY (219): src/gameplay/skills-ring.ts
- [x] perk tree node children (219): src/scripting/runtime/progression-engine.ts

### Workbenches (FURN WBDT) (7 of 8)

- [x] createObject (39), smithingWeapon (1), enchanting (4), enchantingExperiment (0), alchemy (2), alchemyExperiment (0), smithingArmor (1): src/gameplay/crafting.ts
- [ ] none (0): unused by the load order (mods only)

### Recipes by bench keyword (COBJ BNAM) (13 of 15)

- [x] CraftingSmithingArmorTable (339), CraftingSmithingForge (309), CraftingSmithingSharpeningWheel (251), CraftingCookpot (70), DLC2StaffEnchanter (43), CraftingSmelter (18), CraftingTanningRack (17), BYOHCraftingOven (13), CraftingSmithingSkyforge (12), DLC1CraftingDawnguard (10), DLC1LD_CraftingForgeAetherium (3), isGrainMill (1), testPhilCraftingBreakItDowner (1): src/shell/crafting-models.ts
- [ ] BYOHBuilding* (208 keywords) (503): open: 4 of its keywords on no workbench (FURN)
- [ ] Camping_CampfireCookingShared (24): open: 1 of its keywords on no workbench (FURN)

### Recipes (COBJ) (3 of 3)

- [x] conditions (1453): src/shell/crafting-models.ts
- [x] components (1614), createdCount (1614): src/gameplay/crafting.ts

### Faction flags (FACT DATA) (11 of 13)

- [x] specialCombat (13), trackCrime (74), doNotReportAgainstMembers (33): src/scripting/runtime/crime-engine.ts
- [x] ignoreMurder (43), ignoreAssault (43), ignoreStealing (43), ignoreTrespass (42), useDefaults (14), ignorePickpocket (40), ignoreWerewolf (27): src/gameplay/crime.ts
- [x] vendor (286): src/scripting/runtime/actor-engine.ts
- [ ] hiddenFromPlayer (412): not read
- [ ] canBeOwner (441): not read

### Faction data (FACT) (26 of 27)

- [x] reactions (477), ranks (29), vendor.conditions (154), vendor.startHour (66), vendor.endHour (285), vendor.location (286): src/scripting/runtime/actor-engine.ts
- [x] crime.exteriorJailMarker (32), crime.stolenGoodsContainer (13), crime.playerInventoryContainer (13), crime.sharedCrimeFactions (56), crime.jailOutfit (34): src/scripting/runtime/crime-engine.ts
- [x] crime.arrest (1380), crime.attackOnSight (1405), crime.murder (15), crime.assault (15), crime.trespass (16), crime.pickpocket (17), crime.stealMult (17), crime.escape (14), crime.werewolf (14): src/gameplay/crime.ts
- [x] vendor.radius (80): src/gameplay/combat/hit-test.ts
- [x] vendor.onlyStolen (9): src/shell/barter-menu.ts
- [x] vendor.notInList (69): src/gameplay/barter.ts
- [x] vendor.list (285): src/gameplay/combat/combat-records.ts
- [x] vendor.chest (183): src/shell/actor-senses.ts
- [x] rank titles (MNAM, FNAM) (14): src/world/actor-records.ts
- [ ] crime.followerWaitMarker (35): not read

### Equip slots (EQUP) (0 of 3)

- [ ] useAllParents (2): not read
- [ ] parentsOptional (0): unused by the load order (mods only)
- [ ] itemSlot (0): unused by the load order (mods only)

### Armor and weapon data (26 of 26)

- [x] WEAP damage (3217): src/gameplay/breath.ts
- [x] WEAP weaponType (3309), ARMO slots (3755): src/gameplay/equipment.ts
- [x] WEAP speed (3328): src/gameplay/magic/projectile-flight.ts
- [x] WEAP reach (3328): src/gameplay/combat/hit-test.ts
- [x] WEAP skill (3328): src/gameplay/crafting.ts
- [x] WEAP critDamage (3031), WEAP stagger (2456), WEAP critMult (3233), WEAP firstPersonModel (3300), WEAP equipSound (3307), WEAP unequipSound (3307), WEAP equipType (ETYP) (3323), ARMO rating (2639), ARMO equipType (ETYP) (316), AMMO equipType (ETYP) (0): src/scripting/runtime/equipment-engine.ts
- [x] WEAP value (3275), ARMO value (3433), AMMO value (46): src/gameplay/chargen.ts
- [x] WEAP weight (3267), ARMO weight (3423), AMMO weight (65): src/gameplay/actor-leveling.ts
- [x] WEAP enchantment (EITM) (3018), ARMO enchantment (EITM) (2847), AMMO enchantment (EITM) (0): src/scripting/runtime/casting-engine.ts
- [x] ARMO armorType (2554): src/gameplay/inventory.ts

### Weapon flags (DNAM) (1 of 4)

- [x] nonPlayable (117): src/scripting/runtime/crafting-engine.ts
- [ ] ignoresNormalWeaponResistance (1): not read
- [ ] cantDrop (131): not read
- [ ] embeddedWeapon (4): not read

### Weapon flags 2 (DNAM) (1 of 7)

- [x] boundWeapon (9): src/scripting/runtime/equipment-engine.ts
- [ ] playerOnly (1): not read
- [ ] npcsUseAmmo (0): unused by the load order (mods only)
- [ ] minorCrime (0): unused by the load order (mods only)
- [ ] rangeFixed (0): unused by the load order (mods only)
- [ ] notUsedInNormalCombat (3): not read
- [ ] nonHostile (1): not read

### Ammunition flags (DATA) (2 of 3)

- [x] nonPlayable (23): src/shell/actor-combat.ts
- [x] nonBolt (52): src/scripting/runtime/equipment-engine.ts
- [ ] ignoresNormalResistance (1): not read

### Settings: barter and speech (11 of 11)

- [x] fBribeSpeechcraftMult (1), fBribeScale (1), fBribeCostCurve (1): src/gameplay/crime.ts
- [x] fBarterMin (1), fBarterMax (1): src/gameplay/barter.ts
- [x] iSpeechChallengeDifficultyVeryHard (1), iSpeechChallengeDifficultyVeryEasy (1), iSpeechChallengeDifficultyHard (1), iSpeechChallengeDifficultyEasy (1), iSpeechChallengeDifficultyAverage (1): inert: an earlier game's speech challenges: a speech check is a dialogue condition on the skill
- [x] fSpeechDelay (1): src/shell/actors.ts

### Settings: crime, theft and locks (15 of 16)

- [x] fPickpocketSkillUsesCurve (1), fPickPocketWeightMult (1), iCrimeGoldWerewolf (1), fPickPocketMinChance (1), fPickPocketTargetSkillBase (1), iCrimeGoldStealHorse (1), fPickPocketTargetSkillMult (1), fPickPocketMaxChance (1), fPickPocketAmountMult (1), fPickPocketActorSkillMult (1), fPickPocketActorSkillBase (1): src/gameplay/crime.ts
- [x] fLockpickSkillSweetSpotMult (1), fLockpickBrokenPicksMult (1), fLockpickSkillPartialPickMult (1), fLockpickSkillPartialPickBase (1): src/gameplay/lockpicking.ts
- [ ] iLockLevelMaxVeryEasy (1): not read

### Settings: magic and shouts (29 of 46)

- [x] fEnchantmentPointsMult (1), fEnchantmentEffectPointsMult (1): src/shell/inventory-menu.ts
- [x] fMagicPCSkillCostScale (1), fMagicCasterSkillCostMult (1), fMagicAbsorbVisualTimer (1), fMagicCasterPCSkillCostBase (1), fMagicSkillCostScale (1), fMagicAreaBaseCostMult (1), fMagicDualCastingTimeMult (1), fMagicDualCastingCostMult (1): src/gameplay/magic/casting.ts
- [x] fShoutRumbleBigMotorFrequencyV3 (1), fShoutRumbleBigMotorDurationV3 (1), fShoutRumbleBigMotorDurationV2 (1), fShoutRumbleBigMotorFrequencyV2 (1), fShoutRumbleBigMotorFrequencyV1 (1), fShoutRumbleBigMotorDurationV1 (1): a name built at run time
- [x] iMagicGuideWaypoints (1), fMagicGuideSpacing (1), fMagicWardPowerMaxMult (1), fMagicWardPowerMaxBase (1): src/gameplay/magic/effect-rules.ts
- [x] fMagicTelekinesisBaseDistance (1), fMagicTelekinesiDistanceMult (1), fMagicTelekinesisDistanceMin (1): src/gameplay/magic/telekinesis.ts
- [x] fDetectionSneakLightMod (1): src/ai/detection.ts
- [x] fMagicDualCastingEffectivenessBase (1): src/scripting/runtime/magic-engine.ts
- [x] fShoutTime2 (1), fShoutTime1 (1): src/scripting/runtime/casting-engine.ts
- [x] fMagicGrabActorMinDistance (1), fMagicGrabActorThrowForce (1): src/shell/actor-combat.ts
- [ ] fEnchantingSkillFactor (1): not read
- [ ] fShoutRumbleSmallMotorFrequencyV3 (1): not read
- [ ] fShoutRumbleSmallMotorDurationV3 (1): not read
- [ ] fShoutRumbleSmallMotorFrequencyV2 (1): not read
- [ ] fShoutRumbleSmallMotorDurationV2 (1): not read
- [ ] fShoutRumbleSmallMotorFrequencyV1 (1): not read
- [ ] fShoutRumbleSmallMotorDurationV1 (1): not read
- [ ] fSummonedCreatureFadeOutSeconds (1): not read
- [ ] fSummonedCreatureMaxFollowDist (1): not read
- [ ] fSummonedCreatureMinFollowDist (1): not read
- [ ] fMagicRangeTargetCostMult (1): not read
- [ ] fInvisibilityMaxRefraction (1): not read
- [ ] fMagicLightSideOffset (1): not read
- [ ] fMagicLightHeightOffset (1): not read
- [ ] fMagicLightForwardOffset (1): not read
- [ ] fMagicAreaScaleMin (1): not read
- [ ] fMagicAreaScaleMax (1): not read

### Settings: stats (6 of 7)

- [x] fStaminaBlockBase (1), fStaminaBlockDmgMult (1), fStaminaPowerBashBase (1), fStaminaBashBase (1), fStaminaAttackWeaponBase (1), fStaminaAttackWeaponMult (1): src/gameplay/vitals.ts
- [ ] fHealthDataValue1 (1): not read

### Settings: alchemy and crafting (5 of 8)

- [x] fTemperingSkillUseMult (1), fTemperingSkillUseItemValConst (1), fTemperingSkillUseItemValExp (1), fTemperingSkillUseItemValMult (1): src/gameplay/crafting.ts
- [x] fAlchemySkillFactor (1): src/scripting/runtime/crafting-engine.ts
- [ ] iIngredientWortcraftUses (1): not read
- [ ] iIngredientUseEffectThreshold (1): not read
- [ ] iIngredientAlchemyUses (1): not read

### Settings: skills and level-up (52 of 53)

- [x] fSkillUsageRechargeMult (1): src/gameplay/crafting.ts
- [x] fTrainingMultCost (1), iTrainingMasterCost (1), iTrainingExpertCost (1): src/shell/training-menu.ts
- [x] fSkillUsageSneakPerSecond (1): src/shell/actor-senses.ts
- [x] fSkillUsageLockPickHard (1), fSkillUsageLockPickVeryHard (1), fSkillUsageLockPickAverage (1), fSkillUsageLockPickEasy (1), fSkillUsageLockPickVeryEasy (1), fLeveledActorMultVeryHard (1), fLeveledActorMultMedium (1), fLeveledActorMultHard (1), fLeveledActorMultEasy (1): a name built at run time
- [x] fSkillUsageLockPickBroken (1): src/shell/lock-picking.ts
- [x] fLevelUpCarryWeightMod (1), fXPLevelUpMult (1), fXPLevelUpBase (1), fSkillUseCurve (1): src/gameplay/progression.ts
- [x] iAVDSkillsLevelUp (1), iAVDhmsLevelUp (1): src/gameplay/actor-leveling.ts
- [x] iXPRewardSpeechChallengeVeryEasy (1), iXPRewardPickLockVeryHard (1), iXPRewardPickLockVeryEasy (1), iXPRewardPickLockHard (1), iXPRewardPickLockEasy (1), iXPRewardPickLockAverage (1), iXPRewardPickLock (1), iXPRewardKillOpponentVeryHard (1), iXPRewardKillOpponentVeryEasy (1), iXPRewardKillOpponentHard (1), iXPRewardKillOpponentEasy (1), iXPRewardKillOpponentAverage (1), iXPRewardHackComputerVeryHard (1), iXPRewardHackComputerVeryEasy (1), iXPRewardHackComputerHard (1), iXPRewardHackComputerEasy (1), iXPRewardHackComputerAverage (1), iXPRewardHackComputer (1), iXPRewardDiscoverMapMarker (1), iXPLevelKillNPCVeryHard (1), iXPLevelKillNPCVeryEasy (1), iXPLevelKillNPCHard (1), iXPLevelKillNPCEasy (1), iXPLevelKillNPCAverage (1), iXPLevelKillCreatureVeryHard (1), iXPLevelKillCreatureVeryEasy (1), iXPLevelKillCreatureHard (1), iXPLevelKillCreatureEasy (1), iXPLevelKillCreatureAverage (1), iXPDeathRewardHealthThreshold (1), iXPBumpBase (1): inert: an earlier game's experience points: nothing here gives any (the level comes from skills)
- [ ] fLevelScalingMult (1): not read

### Settings: armor and weapons (31 of 31)

- [x] fWeaponBashMax (1), fWeaponBloodLifetime (1), fWeaponBloodFalloffThreshold (1), fWeaponBloodFadeDuration (1): src/gameplay/combat/combat-settings.ts
- [x] fArmorRatingPCMax (1), fArmorScalingFactor (1), fArmorBaseFactor (1), fArmorRatingMax (1), fArmorRatingBase (1): src/gameplay/equipment.ts
- [x] fWeaponConditionSpread9 (1), fWeaponConditionSpread8 (1), fWeaponConditionSpread7 (1), fWeaponConditionSpread6 (1), fWeaponConditionSpread5 (1), fWeaponConditionSpread4 (1), fWeaponConditionSpread3 (1), fWeaponConditionSpread2 (1), fWeaponConditionSpread1 (1), fWeaponConditionRateOfFire9 (1), fWeaponConditionRateOfFire8 (1), fWeaponConditionRateOfFire7 (1), fWeaponConditionRateOfFire6 (1), fWeaponConditionRateOfFire5 (1), fWeaponConditionRateOfFire4 (1), fWeaponConditionRateOfFire3 (1), fWeaponConditionRateOfFire2 (1), fWeaponConditionRateOfFire1 (1), fWeaponConditionJam4 (1), fWeaponConditionJam3 (1), fWeaponConditionJam2 (1), fWeaponConditionJam1 (1): inert: an earlier game's weapon condition: weapons do not wear here
