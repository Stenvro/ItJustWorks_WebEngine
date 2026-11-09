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

## Count (2026-11-02, round 4)

| Part                               | Items | Done | Open | Open, unused |
| ---------------------------------- | ----: | ---: | ---: | -----------: |
| Perks (entry points, functions)    |   116 |  107 |    9 |            9 |
| Magic effects (archetypes, flags)  |   104 |  103 |    1 |            1 |
| Spells, enchantments, potions      |    43 |   42 |    1 |            1 |
| Shouts, skills (SHOU, WOOP, AVIF)  |    16 |   16 |    0 |            0 |
| Crafting (FURN, COBJ)              |    26 |   25 |    1 |            1 |
| Factions (FACT)                    |    40 |   40 |    0 |            0 |
| Equipment (EQUP, ARMO, WEAP, AMMO) |    43 |   38 |    5 |            5 |
| Game settings                      |   172 |  172 |    0 |            0 |
| Mechanics (by hand)                |    20 |   20 |    0 |            0 |
| Total                              |   580 |  563 |   17 |           17 |

Round 1 wrote the sweep and this list, and built down Weapons Unequipped (the package takes the
weapons from the actor's hands and does not give them back as the flag goes; observed in the
original: Helgen's first prisoner holds nothing from the cart to the block), No Area, No Hit
Event, sneaking training Sneak, and recorded the earlier games' 58 leftover settings as read by
nothing (the sweep's INERT).

Round 2 built down:

- Painless (MGEF 0x4000000, 228 effects): a hostile spell that takes hold makes its target cry
  out (its Hit line) unless every hostile effect of it is Painless (magic-engine.ts painful,
  actor-combat.ts spellHit; tests/conformance/magic/projectiles-explosions.test.ts); on the
  player a painful hit gives the hit blur (Skyrim.esm IMAD 0x00000162 GetHit, a 0.25 s radial
  blur), their Hit line (the generic Hit topic's grunts, the only infos of it the player may
  say) and the pain rumble (src/gameplay/player-pain.ts, actor-combat.ts #hurtPlayer;
  TODO(M13): inferred that every painful hit gives all three, spaced by fPainDelay; the
  player's voice is the chosen race's default voice for the chosen sex, RACE VTCK, after the
  race menu: ScriptRuntime.voiceType); an arrow
  in the player sounds its impact's player sound (WPNImpactArrowVsFleshPLAYER, IPCT NAM1:
  src/audio/impacts.ts blowSound; TODO(M13): inferred from the editor ids).
- Snap To Navmesh (MGEF 0x8, 92: every summon, the frost walls): the summon's place and a wall's
  hazard go onto the navmesh (magic-engine.ts #summon, magic-projectiles.ts #burst). Gory Visuals
  (19): not used by the game (Creation Kit "Magic Effect").
- Faction flags Can Be Owner (441: the editor's filter of the owners it offers; all 224 faction
  owned cells have it) and Hidden From PC (412: the player's faction list, which Skyrim's menus
  do not have): nothing in the game reads them (the sweep's EXPLAINED).
- Weapons: Can't Drop (131) keeps the weapon in its holder's items (the inventory's drop, a
  death's fall, a disarm); Player Only and Not Used In Normal Combat (Keening) are not taken up
  by NPCs; Non-hostile (DA08RealEbonyBlade) blows make no one hostile (equipment-engine.ts,
  actor-combat.ts, magic-engine.ts, inventory-menu.ts). Embedded Weapon (CommonLibSSE: unused)
  and Ignores Normal Weapon Resistance (weapons and ammunition: Skyrim has no such resistance)
  explained.
- Settings: fShoutRumbleSmallMotor{Frequency,Duration}V1-3 (the controller's small motor with a
  shout), fSummonedCreatureFadeOutSeconds (a summon fades out, then leaves),
  fMagicRangeTargetCostMult (TODO(M13): the earlier game's cost rule, 1 in Skyrim.esm),
  iLockLevelMaxVeryEasy (the lock levels' difficulties), fMagicLight{Forward,Height,Side}Offset
  (registered by the original and never read: INERT).
- Extend Duration On Recast (16 enchantments: soul trap weapons, Dwemer flame pillars): a hit
  adds its duration to the effect there. PC Start Spell: a new game gives the player
  PCHealRateCombat (tests/papyrus-runtime.int.test.ts).
- The jail's follower wait marker (WAIT, 35 crime factions): the followers are moved there as the
  player goes to jail (tests/conformance/ai/crime.test.ts).
- Perk DATA ranks (27 perks): no vanilla entry belongs to a later rank and the trees count their
  NNAM chain (Novice Locks: DATA 5, one record): explained. Camping_CampfireCookingShared (the
  Camping Creation's campfire, not in the install) and 4 Hearthfire parts' keywords are on no
  workbench of the load order, so the original offers those recipes nowhere either: explained.
- NPCs' improved items: no leveled list, NPC or container of the load order gives an item a
  condition above 1 (COED item condition: one container's, at 1), so no NPC or merchant carries
  a tempered item from the data. COED's condition itself is not read (mods only).
- Weapons Unequipped, checked again: the Creation Kit says only that the package unequips the
  weapons while it runs; CommonLibSSE names no moment that takes them up; the observed prisoner
  shows the next package does not. Whether a reload of the actor's 3D (a cell change) does is
  unknown: TODO(M13), to check in the original with a Riften guard after his meal
  (GuardRiftenEat*: Weapons Unequipped); ours stay unarmed until they fight. Not changed.

Round 3 built down:

- The werewolf and vampire lord archetypes (WerewolfChangeEffect, DLC1VampireChangeEffect; their
  associated item the beast race): on the player the beast form starts as the effect takes
  hold, before its scripts (WerewolfChangeEffectScript's first-change branch turns it off again,
  which shows the engine turned it on). The rest of the change is the scripts' and runs: the race
  with its skeleton and graph (Actor.SetRace), the controls (DisablePlayerControls, and the
  perks PlayerWerewolfFeed and DLC1VampireActivationBlocker, whose Filter Activation entries
  keep the beasts from items, doors and containers), the feeding (the perk's Activate choice,
  SpecialFeeding), the timer (PlayerWerewolfShiftBackTime, OnUpdate). The vampire lord's magic
  and favorites menus open, listing only the default object VampireSpells (RIVS:
  DLC1VampireSpellsPowers, Revert Form among them); the werewolf's stay shut. The HUD has no
  beast meter: hudmenu.swf names none. src/gameplay/beast-forms.ts, magic-engine.ts;
  tests/conformance/magic/beast-forms.test.ts runs a change in the simulation into the form and
  back at its timer. TODO(M13): whether the werewolf's howls are chosen in a menu.
- Use All Parents (BothHands, Shield): read by EquipSlots.place beside the parser (explained).
- An enchanted item's charge without EAMT (31 weapons: the bound weapons, the Ebony Blade,
  Keening, the Poacher's Axe, ...): its enchantment's, ENIT's charge amount with No Auto Calc,
  else fMagicEnchantmentChargeMult × its cost + fMagicEnchantmentChargeBase (observed in the
  original; crafting-engine.ts fullCharge, for weapons, staffs and the menus' values).
- NPCs' crimes beyond assault: theft and pickpocketing (a package's Acquire taking what it may
  not: crime-engine.ts npcTook; the data allows it in MQ101RalofGetDoorKey alone) and murder (the
  kill that ends its own assault) are alarms its witnesses raise; trespass is the player's alone.
  TODO(M13): whether the original records an NPC's crimes and marks its stolen items.
- fSummonedCreature{Min,Max}FollowDist: a summon or a raised corpse out of combat follows its
  commander (the engine package Follow Commander, src/ai/engine-packages.ts). Seen on the way: the
  conjured familiar (a wolf by its template) picks a fight with the Bannered Mare's people, which
  the original's summons do not (the combat AI's part, open).

Round 4 (2026-11-02) read the settings no document names from the original (docs/gameplay.md):

- fEnchantingSkillFactor: the skill multiplier is 1 + skill / 100 × (factor − 1) × max(0.01,
  (skill − 14) / 85); Skyrim.esm's 1.25 gives UESP's measured one (crafting.ts
  enchantingSkillMultiplier, crafting-engine.ts).
- fHealthDataValue1 (with the built-in ...2 .. 6, fSmithingConditionFactor, fSmithingWeaponMax,
  fSmithingArmorMax): an improvement's health by the Smithing skill, rounded to tenths; the
  quality name by the thresholds; the increase by the health (crafting.ts temperingHealthOf,
  temperQualityTier, temperingIncreaseOfHealth: UESP's levels for every skill 15 .. 200).
  TODO(M13): the item card and the equip system use the engine's values of all but the
  improvement's health.
- fLevelScalingMult: an encounter zone's level is its minimum plus the levels past it × the
  setting, rounded down (actor-leveling.ts zoneLevel; Skyrim.esm 1).
- iIngredientUseEffectThreshold, iIngredientAlchemyUses, iIngredientWortcraftUses: uses towards
  an ingredient's next effect (crafting.ts ingredientUsed); Skyrim.esm's 0 uses keep it still.
  TODO(M12): the count is not saved yet.
- fMagicAreaScaleMin, fMagicAreaScaleMax: registered and never read (inert).

## Next biggest open items

1. Unused by the load order (mods only, 17): 8 perk entry points, trait,
   enchant visuals, medicine, the workbench type None, two EQUP flags, three weapon flags 2.

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
- [x] NPCs' improved items: the load order gives none (no COED item condition above 1 in any
      leveled list, NPC or container); COED's condition is not read (mods only).
- [x] Followers at the jail's wait marker (crime-engine.ts jail; round 2).
- [x] Enchanting: an item's charge without EAMT: its enchantment's (crafting-engine.ts
      fullCharge; round 3).
- [x] NPCs' crimes beyond assault: theft, pickpocketing, murder as alarms (crime-engine.ts
      npcTook, murder; round 3). Trespass is the player's alone.

## Lists (from the sweep)

### Perk entry points (84 of 92)

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
- [x] getShouldAttack (0): src/shell/actor-combat-ai.ts (asked by the original; where, inferred: the other actor off its targets)
- [ ] modAddictionChance (0): unused by the load order (mods only)
- [ ] modAddictionDuration (0): unused by the load order (mods only)
- [ ] modPositiveChemDuration (0): unused by the load order (mods only)
- [x] modMaxPlaceableMines (0): src/shell/magic-projectiles.ts (the player's iMaxPlayerRunes, observed in the original)
- [x] modSecondaryValueWeight (0): src/scripting/runtime/magic-engine.ts (the caster's, as the effect is adjusted for perks: observed in the original)
- [ ] modPlayerReputation (0): unused by the load order (mods only)
- [ ] modLockpickLevelAllowed (0): unused by the load order (mods only)
- [ ] setProgressionPicking (0): unused by the load order (mods only)

### Perk entry functions (16 of 16)

- [x] none (0): src/gameplay/perk-entry-points.ts: an entry without a function changes nothing
- [x] setValue (65), addValue (58), multiplyValue (367), addRangeToValue (0), addActorValueMult (0), absoluteValue (0), negativeAbsoluteValue (0), setToActorValueMult (3), multiplyActorValueMult (0), multiplyOnePlusActorValueMult (36): src/gameplay/perk-entry-points.ts
- [x] addLeveledList (0), addActivateChoice (19), selectSpell (68), selectText (3), setText (3): src/scripting/runtime/perk-engine.ts

### Perk entries (7 of 8)

- [x] quest stage entries (PRKE type 0) (28): src/scripting/runtime/perk-engine.ts
- [x] ability entries (PRKE type 1) (32): src/gameplay/magic/effect-rules.ts
- [x] condition tabs (PRKC) within the entry point (0): src/gameplay/perk-entry-points.ts (every tab a subject)
- [x] conditions (the perk requirements) (279), next (NNAM: the next rank) (85): src/scripting/runtime/progression-engine.ts
- [x] hidden (67): src/scripting/runtime/dialogue-engine.ts
- [x] ranks (DATA: above 1) (27): src/scripting/runtime/perk-engine.ts: no vanilla entry belongs to a rank past the first (PRKE rank 0 in all), and a tree's ranks are its NNAM chain (Novice Locks: DATA 5, one record; the original's menu shows one rank); the count is the Creation Kit's
- [ ] trait (0): unused by the load order (mods only)

### Magic effect archetypes (47 of 47)

- [x] valueModifier (446), absorb (58), dualValueModifier (134), calm (22), demoralize (27), frenzy (13), disarm (6), commandSummoned (1), invisibility (13), darkness (0), nightEye (0), boundWeapon (9), summonCreature (81), detectLife (19), telekinesis (1), paralysis (29), reanimate (14), turnUndead (13), valueAndParts (0), accumulateMagnitude (3), peakValueModifier (332), rally (8), enhanceWeapon (4), banish (4), grabActor (1): src/gameplay/magic/effect-rules.ts
- [x] script (351): src/scripting/runtime/magic-engine.ts: a Script effect does nothing but run its scripts (OnEffectStart, OnEffectFinish) and its actor value, as every effect does
- [x] dispel (0), cureDisease (3), lock (0), open (0), soulTrap (4), werewolfFeed (1), cureParalysis (0), cureAddiction (0), curePoison (1), stagger (52), cloak (46), werewolf (2), slowTime (5), spawnHazard (13), etherealize (4), spawnScriptedRef (1), vampireLord (1): src/scripting/runtime/magic-engine.ts
- [x] light (8): src/gameplay/magic/projectile-flight.ts
- [x] guide (1): src/shell/actor-stage.ts
- [x] concussion (0): src/scripting/runtime/magic-engine.ts: observed in the original, its effect adds nothing to what every effect does (its scripts, visuals and sounds); fConcussionTimer is registered and never read
- [x] disguise (0): src/scripting/runtime/magic-engine.ts, src/gameplay/magic/disguise.ts: its own state (Initiate, Waiting while its actor is detected, Normal: not attacked on sight but by the frenzied, Fail: inactive for good once its conditions fail, tests/conformance/magic/active-effects.test.ts); its start keeps its actor as the player's disguise while it lasts (playerDisguise; in the original); TODO(M13): the states' rule and what the player's disguise does are inferred from CommonLibSSE DisguiseEffect

### Magic effect flags (18 of 18)

- [x] hostile (549), recover (778), detrimental (579), noDuration (366), noMagnitude (291), powerAffectsMagnitude (964), powerAffectsDuration (424): src/gameplay/magic/effect-rules.ts
- [x] snapToNavmesh (92), dispelWithKeywords (162), fxPersist (927), noRecast (352), painless (228), noHitEffect (119), noDeathDispel (415): src/scripting/runtime/magic-engine.ts
- [x] noHitEvent (162), noArea (1062): src/scripting/runtime/casting-engine.ts
- [x] goryVisuals (19): not used by the game (Creation Kit "Magic Effect")
- [x] hideInUi (340): src/shell/inventory-menu.ts

### Magic effect fields (38 of 39)

- [x] description (949): src/gameplay/chargen-catalog.ts
- [x] baseCost (958), skill (829), perk (47): src/gameplay/crafting.ts
- [x] associatedItem (221), hitShader (765), secondValueWeight (117), secondActorValue (134), hitEffectArt (359), hitVisuals (0), equipAbility (58), imageSpaceModifier (260), counterEffects (0), scripted (576): src/scripting/runtime/magic-engine.ts
- [x] resistValue (351), taperWeight (548), taperCurve (214), taperDuration (193), skillUsageMult (555): src/gameplay/magic/effect-rules.ts
- [x] light (535): src/gameplay/inventory.ts
- [x] enchantShader (191), enchantArt (21): src/gameplay/magic/enchantment-glow.ts
- [x] minimumSkill (337): src/shell/magic-menu.ts
- [x] actorValue (1072): src/gameplay/actor-leveling.ts
- [x] projectile (527): src/gameplay/combat/knockback.ts
- [x] explosion (161), aiScore (8), aiDelay (12): src/scripting/runtime/casting-engine.ts
- [x] castingType (1154): src/scripting/runtime/condition-values.ts
- [x] delivery (751): src/gameplay/magic/casting.ts
- [x] castingArt (731), dualCastArt (11), dualCastScale (1729), castingSoundLevel (424), sounds (1075): src/shell/actor-casting.ts
- [x] impactData (556): src/shell/actor-combat.ts
- [x] keywords (773): src/gameplay/barter.ts
- [x] conditions (563): src/scripting/runtime/actor-engine.ts
- [ ] enchantVisuals (0): unused by the load order (mods only)

### Spells, scrolls, enchantments, potions, ingredients (31 of 31)

- [x] SPEL castType (1451), SPEL delivery (1451), SPEL effects (1451), SCRL castType (104), SCRL delivery (104), SCRL effects (104), ENCH castType (757), ENCH delivery (757), ENCH effects (757), ALCH castType (0), ALCH delivery (0), ALCH effects (472), INGR castType (0), INGR delivery (0), INGR effects (180): src/gameplay/magic/casting.ts
- [x] SPEL cost (794), SCRL cost (103), ENCH cost (614), ENCH enchantment.amount (613), ALCH cost (0), INGR cost (0): src/gameplay/crafting.ts
- [x] SPEL chargeTime (552), SCRL chargeTime (38): src/scripting/runtime/casting-engine.ts
- [x] SPEL castingPerk (196), SCRL castingPerk (0): src/scripting/runtime/perk-engine.ts
- [x] ENCH enchantment.baseEnchantment (360), ENCH enchantment.wornRestrictions (80), ALCH potion.value (466), INGR potion.value (0): src/scripting/runtime/crafting-engine.ts
- [x] ALCH potion.addiction (0), ALCH potion.useSound (470): src/scripting/runtime/magic-engine.ts

### Spell and scroll flags (SPIT) (6 of 6)

- [x] manualCost (332), ignoreResistance (44), noDualCastModification (91): src/scripting/runtime/magic-engine.ts
- [x] pcStartSpell (1): src/scripting/runtime/runtime.ts
- [x] areaIgnoresLineOfSight (84), disallowAbsorbReflect (98): src/scripting/runtime/casting-engine.ts

### Enchantment flags (ENIT) (2 of 2)

- [x] noAutoCalc (57): src/scripting/runtime/crafting-engine.ts
- [x] extendDurationOnRecast (16): src/scripting/runtime/magic-engine.ts

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

### Recipes by bench keyword (COBJ BNAM) (15 of 15)

- [x] BYOHBuilding* (208 keywords) (503): src/shell/crafting-models.ts (RecipeIndex.forWorkbench): 4 parts' keywords (a bench, a desk, a weapon plaque, a fireplace's slaughterfish) are on no workbench of the load order, so the original offers those 4 recipes nowhere either
- [x] CraftingSmithingArmorTable (339), CraftingSmithingForge (309), CraftingSmithingSharpeningWheel (251), CraftingCookpot (70), DLC2StaffEnchanter (43), CraftingSmelter (18), CraftingTanningRack (17), BYOHCraftingOven (13), CraftingSmithingSkyforge (12), DLC1CraftingDawnguard (10), DLC1LD_CraftingForgeAetherium (3), isGrainMill (1), testPhilCraftingBreakItDowner (1): src/shell/crafting-models.ts
- [x] Camping_CampfireCookingShared (24): src/shell/crafting-models.ts (RecipeIndex.forWorkbench): Update.esm's keyword for the Camping Creation's campfire (the fishing recipes' cooking there), which the install does not have: no workbench has it in the original either; one that has it lists them

### Recipes (COBJ) (3 of 3)

- [x] conditions (1453): src/shell/crafting-models.ts
- [x] components (1614), createdCount (1614): src/gameplay/crafting.ts

### Faction flags (FACT DATA) (13 of 13)

- [x] hiddenFromPlayer (412): keeps a faction off the player's faction list (Creation Kit "Faction"), which Skyrim's menus do not have
- [x] specialCombat (13), trackCrime (74), doNotReportAgainstMembers (33): src/scripting/runtime/crime-engine.ts
- [x] ignoreMurder (43), ignoreAssault (43), ignoreStealing (43), ignoreTrespass (42), useDefaults (14), ignorePickpocket (40), ignoreWerewolf (27): src/gameplay/crime.ts
- [x] canBeOwner (441): the editor's filter of the factions it offers as owners (Creation Kit "Faction"); the game takes the owner a cell or reference names (every faction owning a cell has the flag)
- [x] vendor (286): src/scripting/runtime/actor-engine.ts

### Faction data (FACT) (27 of 27)

- [x] reactions (477), ranks (29), vendor.conditions (154), vendor.startHour (66), vendor.endHour (285), vendor.location (286): src/scripting/runtime/actor-engine.ts
- [x] crime.exteriorJailMarker (32), crime.followerWaitMarker (35), crime.stolenGoodsContainer (13), crime.playerInventoryContainer (13), crime.sharedCrimeFactions (56), crime.jailOutfit (34): src/scripting/runtime/crime-engine.ts
- [x] crime.arrest (1380), crime.attackOnSight (1405), crime.murder (15), crime.assault (15), crime.trespass (16), crime.pickpocket (17), crime.stealMult (17), crime.escape (14), crime.werewolf (14): src/gameplay/crime.ts
- [x] vendor.radius (80): src/gameplay/combat/hit-test.ts
- [x] vendor.onlyStolen (9): src/shell/barter-menu.ts
- [x] vendor.notInList (69): src/gameplay/barter.ts
- [x] vendor.list (285): src/gameplay/combat/combat-records.ts
- [x] vendor.chest (183): src/shell/actor-senses.ts
- [x] rank titles (MNAM, FNAM) (14): src/world/actor-records.ts

### Equip slots (EQUP) (1 of 3)

- [x] useAllParents (2): src/world/equip-slots.ts (EquipSlots.place, beside the parser): a slot whose parents are both hands takes both (BothHands: a two-handed weapon) with the flag, one of them (EitherHand) without; Shield's one parent is the left hand (src/world/equip-slots.test.ts)
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
- [x] WEAP enchantment (EITM) (3018), ARMO enchantment (EITM) (2847), AMMO enchantment (EITM) (0): src/scripting/runtime/crafting-engine.ts
- [x] ARMO armorType (2554): src/gameplay/inventory.ts

### Weapon flags (DNAM) (4 of 4)

- [x] ignoresNormalWeaponResistance (1): an earlier game's resistance to normal weapons: Skyrim has no such actor value (CommonLibSSE ActorValue: damage, poison, fire, shock, frost, magic, disease)
- [x] cantDrop (131): src/scripting/runtime/equipment-engine.ts
- [x] embeddedWeapon (4): unused (CommonLibSSE TESObjectWEAP): its actor value is an earlier game's limb condition, which Skyrim has none of
- [x] nonPlayable (117): src/scripting/runtime/crafting-engine.ts

### Weapon flags 2 (DNAM) (4 of 7)

- [x] playerOnly (1), notUsedInNormalCombat (3), nonHostile (1), boundWeapon (9): src/scripting/runtime/equipment-engine.ts
- [ ] npcsUseAmmo (0): unused by the load order (mods only)
- [ ] minorCrime (0): unused by the load order (mods only)
- [ ] rangeFixed (0): unused by the load order (mods only)

### Ammunition flags (DATA) (3 of 3)

- [x] ignoresNormalResistance (1): an earlier game's resistance to normal weapons: Skyrim has no such actor value (CommonLibSSE ActorValue: damage, poison, fire, shock, frost, magic, disease)
- [x] nonPlayable (23): src/shell/actor-combat.ts
- [x] nonBolt (52): src/scripting/runtime/equipment-engine.ts

### Settings: barter and speech (11 of 11)

- [x] fBribeSpeechcraftMult (1), fBribeScale (1), fBribeCostCurve (1): src/gameplay/crime.ts
- [x] fBarterMin (1), fBarterMax (1): src/gameplay/barter.ts
- [x] iSpeechChallengeDifficultyVeryHard (1), iSpeechChallengeDifficultyVeryEasy (1), iSpeechChallengeDifficultyHard (1), iSpeechChallengeDifficultyEasy (1), iSpeechChallengeDifficultyAverage (1): inert: an earlier game's speech challenges: a speech check is a dialogue condition on the skill
- [x] fSpeechDelay (1): src/shell/actors.ts

### Settings: crime, theft and locks (16 of 16)

- [x] fPickpocketSkillUsesCurve (1), fPickPocketWeightMult (1), iCrimeGoldWerewolf (1), fPickPocketMinChance (1), fPickPocketTargetSkillBase (1), iCrimeGoldStealHorse (1), fPickPocketTargetSkillMult (1), fPickPocketMaxChance (1), fPickPocketAmountMult (1), fPickPocketActorSkillMult (1), fPickPocketActorSkillBase (1): src/gameplay/crime.ts
- [x] fLockpickSkillSweetSpotMult (1), fLockpickBrokenPicksMult (1), fLockpickSkillPartialPickMult (1), fLockpickSkillPartialPickBase (1): src/gameplay/lockpicking.ts
- [x] iLockLevelMaxVeryEasy (1): a name built at run time

### Settings: magic and shouts (46 of 46)

- [x] fEnchantmentPointsMult (1), fEnchantmentEffectPointsMult (1): src/shell/inventory-menu.ts
- [x] fEnchantingSkillFactor (1): src/gameplay/crafting.ts
- [x] fMagicPCSkillCostScale (1), fMagicCasterSkillCostMult (1), fMagicAbsorbVisualTimer (1), fMagicCasterPCSkillCostBase (1), fMagicSkillCostScale (1), fMagicRangeTargetCostMult (1), fMagicAreaBaseCostMult (1), fMagicDualCastingTimeMult (1), fMagicDualCastingCostMult (1): src/gameplay/magic/casting.ts
- [x] fShoutRumbleSmallMotorFrequencyV3 (1), fShoutRumbleSmallMotorDurationV3 (1), fShoutRumbleBigMotorFrequencyV3 (1), fShoutRumbleBigMotorDurationV3 (1), fShoutRumbleBigMotorDurationV2 (1), fShoutRumbleSmallMotorFrequencyV2 (1), fShoutRumbleSmallMotorDurationV2 (1), fShoutRumbleBigMotorFrequencyV2 (1), fShoutRumbleSmallMotorFrequencyV1 (1), fShoutRumbleSmallMotorDurationV1 (1), fShoutRumbleBigMotorFrequencyV1 (1), fShoutRumbleBigMotorDurationV1 (1): a name built at run time
- [x] fSummonedCreatureFadeOutSeconds (1), iMagicGuideWaypoints (1), fMagicGuideSpacing (1), fMagicWardPowerMaxMult (1), fMagicWardPowerMaxBase (1): src/gameplay/magic/effect-rules.ts
- [x] fMagicTelekinesisBaseDistance (1), fMagicTelekinesiDistanceMult (1), fMagicTelekinesisDistanceMin (1): src/gameplay/magic/telekinesis.ts
- [x] fSummonedCreatureMaxFollowDist (1), fSummonedCreatureMinFollowDist (1): src/ai/ai-settings.ts
- [x] fDetectionSneakLightMod (1): src/ai/detection.ts
- [x] fMagicDualCastingEffectivenessBase (1): src/scripting/runtime/magic-engine.ts
- [x] fMagicLightSideOffset (1), fMagicLightHeightOffset (1), fMagicLightForwardOffset (1): inert: registered by the original and never read (observed in the original): src/shell/actor-effects.ts LIGHT_OFFSET
- [x] fMagicAreaScaleMin (1), fMagicAreaScaleMax (1): inert: registered by the original and never read (observed in the original): an earlier game's area scaling (docs/gameplay.md)
- [x] fShoutTime2 (1), fShoutTime1 (1): src/scripting/runtime/casting-engine.ts
- [x] fMagicGrabActorMinDistance (1), fMagicGrabActorThrowForce (1): src/shell/actor-combat.ts
- [x] fInvisibilityMaxRefraction (1): src/gameplay/magic/invisibility.ts

### Settings: stats (7 of 7)

- [x] fHealthDataValue1 (1): a name built at run time
- [x] fStaminaBlockBase (1), fStaminaBlockDmgMult (1), fStaminaPowerBashBase (1), fStaminaBashBase (1), fStaminaAttackWeaponBase (1), fStaminaAttackWeaponMult (1): src/gameplay/vitals.ts

### Settings: alchemy and crafting (8 of 8)

- [x] fTemperingSkillUseMult (1), iIngredientWortcraftUses (1), iIngredientUseEffectThreshold (1), iIngredientAlchemyUses (1), fTemperingSkillUseItemValConst (1), fTemperingSkillUseItemValExp (1), fTemperingSkillUseItemValMult (1): src/gameplay/crafting.ts
- [x] fAlchemySkillFactor (1): src/scripting/runtime/crafting-engine.ts

### Settings: skills and level-up (53 of 53)

- [x] fSkillUsageRechargeMult (1): src/gameplay/crafting.ts
- [x] fTrainingMultCost (1), iTrainingMasterCost (1), iTrainingExpertCost (1): src/shell/training-menu.ts
- [x] fSkillUsageSneakPerSecond (1): src/shell/actor-senses.ts
- [x] fSkillUsageLockPickHard (1), fSkillUsageLockPickVeryHard (1), fSkillUsageLockPickAverage (1), fSkillUsageLockPickEasy (1), fSkillUsageLockPickVeryEasy (1), fLeveledActorMultVeryHard (1), fLeveledActorMultMedium (1), fLeveledActorMultHard (1), fLeveledActorMultEasy (1): a name built at run time
- [x] fSkillUsageLockPickBroken (1): src/shell/lock-picking.ts
- [x] fLevelUpCarryWeightMod (1), fXPLevelUpMult (1), fXPLevelUpBase (1), fSkillUseCurve (1): src/gameplay/progression.ts
- [x] iAVDSkillsLevelUp (1), iAVDhmsLevelUp (1), fLevelScalingMult (1): src/gameplay/actor-leveling.ts
- [x] iXPRewardSpeechChallengeVeryEasy (1), iXPRewardPickLockVeryHard (1), iXPRewardPickLockVeryEasy (1), iXPRewardPickLockHard (1), iXPRewardPickLockEasy (1), iXPRewardPickLockAverage (1), iXPRewardPickLock (1), iXPRewardKillOpponentVeryHard (1), iXPRewardKillOpponentVeryEasy (1), iXPRewardKillOpponentHard (1), iXPRewardKillOpponentEasy (1), iXPRewardKillOpponentAverage (1), iXPRewardHackComputerVeryHard (1), iXPRewardHackComputerVeryEasy (1), iXPRewardHackComputerHard (1), iXPRewardHackComputerEasy (1), iXPRewardHackComputerAverage (1), iXPRewardHackComputer (1), iXPRewardDiscoverMapMarker (1), iXPLevelKillNPCVeryHard (1), iXPLevelKillNPCVeryEasy (1), iXPLevelKillNPCHard (1), iXPLevelKillNPCEasy (1), iXPLevelKillNPCAverage (1), iXPLevelKillCreatureVeryHard (1), iXPLevelKillCreatureVeryEasy (1), iXPLevelKillCreatureHard (1), iXPLevelKillCreatureEasy (1), iXPLevelKillCreatureAverage (1), iXPDeathRewardHealthThreshold (1), iXPBumpBase (1): inert: an earlier game's experience points: nothing here gives any (the level comes from skills)

### Settings: armor and weapons (31 of 31)

- [x] fWeaponBashMax (1), fArmorRatingMax (1), fArmorRatingBase (1), fWeaponBloodLifetime (1), fWeaponBloodFalloffThreshold (1), fWeaponBloodFadeDuration (1): src/gameplay/combat/combat-settings.ts
- [x] fArmorRatingPCMax (1), fArmorScalingFactor (1), fArmorBaseFactor (1): src/gameplay/equipment.ts
- [x] fWeaponConditionSpread9 (1), fWeaponConditionSpread8 (1), fWeaponConditionSpread7 (1), fWeaponConditionSpread6 (1), fWeaponConditionSpread5 (1), fWeaponConditionSpread4 (1), fWeaponConditionSpread3 (1), fWeaponConditionSpread2 (1), fWeaponConditionSpread1 (1), fWeaponConditionRateOfFire9 (1), fWeaponConditionRateOfFire8 (1), fWeaponConditionRateOfFire7 (1), fWeaponConditionRateOfFire6 (1), fWeaponConditionRateOfFire5 (1), fWeaponConditionRateOfFire4 (1), fWeaponConditionRateOfFire3 (1), fWeaponConditionRateOfFire2 (1), fWeaponConditionRateOfFire1 (1), fWeaponConditionJam4 (1), fWeaponConditionJam3 (1), fWeaponConditionJam2 (1), fWeaponConditionJam1 (1): inert: an earlier game's weapon condition: weapons do not wear here
