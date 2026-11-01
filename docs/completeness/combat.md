# Combat: completeness

What "100" means here: everything the load order (Skyrim.esm, Update, the three DLCs and the
Creation Club files of the install) gives combat is read and run as the original does: every
combat style field (CSTY), every attack (ATKD / ATKE on races and NPCs), the races' combat fields
and flags, the combat behaviour tree's every action, every combat game setting; and the
mechanics: attacks, power attacks, bashes, blocks, staggers, recoils, knockdowns, ragdolls,
ranged and magic combat, the dragons' fight, flee and surrender, kill moves, sneak attacks, dual
wielding and mounted combat. The AI outside combat has its own list (docs/completeness/ai.md).

The data part comes from the sweep `node tools/ai-combat-completeness.ts` (`--all` for every
item with where it is read); docs/completeness/ai.md says when an item counts as done. The
mechanics part is kept by hand against docs/ai.md ("Combat", "Combat AI", "Flying") and the
conformance suites (tests/conformance/combat/).

## Count (2026-11-01, round 2)

| Part                     | Items | Done | Open |
| ------------------------ | ----: | ---: | ---: |
| Combat style (CSTY)      |    35 |   35 |    0 |
| Attack data (ATKD, ATKE) |    16 |   16 |    0 |
| Race combat (DATA, ATKR) |    15 |   11 |    4 |
| Behaviour tree actions   |    63 |   63 |    0 |
| Game settings            |   406 |  385 |   21 |
| Mechanics (by hand)      |    22 |   14 |    8 |
| Total                    |   557 |  524 |   33 |

Round 1 wrote the sweep and this list, and built down:

- Dual wielding: a race with Can Dual Wield (39 races) whose style allows it (the DATA flag or
  the record flag) takes a second one-handed weapon into its free left hand
  (combat-tactics.ts leftHandWeapon); the left attacks then run (leftAttack).
- Exit Water's second test: the race's No Combat In Water flag (162 races: all but the
  mudcrabs, slaughterfish and horkers, at home in water).
- A shout is aimed: released once its shouter has faced its target within
  fAIShoutToleranceDegrees (5) for fAIShoutMinAimSeconds (2) (shoutAim; the settings' use read
  from their names: TODO(M13)).
- A dying actor's weapons fall from its hands by iDeathDropWeaponChance (100)
  (actor-combat.ts dropWeaponsOnDeath; tests/conformance/combat/death-weapons.test.ts).
- ATKD Override Data: set on every NPC's attack (124) and on no race's (2155): it marks the
  NPC's own attack, which replaces its race's for that event (as AttackSet does).

Round 2 built down:

- Mounted combat: a mount fights while ridden by its race's Allow Mounted Combat (DATA Flags 2:
  the three dragon races; src/ai/mounts.ts fightsRidden): a ridden dragon's combat runs (it flies
  the attack on the target its rider locks), a ridden horse's waits; an actor riding a mount that
  fights stays on it, one on a horse gets off to fight. The player's view from a mount looks no
  more than fMountedMaxLookingDown (Update.esm 30°) down (player.ts). TODO(M13): a rider staying
  on attacks from the saddle only with what it casts and shouts.
- Rotating Attack (38 attacks): while such an attack plays, its attacker's controller keeps
  turning it to its target, as the graph's bAllowRotation does (attacks.ts rotatesThrough,
  movement-drive.ts driveOf). TODO(M13): the plain reading of the flag.
- Non-Hostile (13 races: deer, elk, foxes, goats, cows, chickens, hares, the pets): one fighting
  or fleeing the player is no threat to them: it keeps no one from waiting, plays no combat
  music, shows as no enemy on the compass (combat-reactions.ts threatensPlayer).
- Dueling (169 styles): the style's choice between dueling and flanking (169 duel, 19 flank,
  none both, 9 neither); the tree as observed in the original decides by Flanking alone, so
  Dueling counts as not Flanking (done, explained by the sweep).

Looked for and not found (left open): fBlockSkillMult (2), fBlockAmountWeaponMult (1) and
fBlockMax (0.7) are in none of UESP's measured block formulas (shield 45 + 0.2 × rating, weapon
30 + 0.2 × the attacker's base damage, each × (1 + skill × 1.5 / 100), cap 85 %), so 0.7 is not
the cap of the blocked share; fKnockback* (Time 0.3, DamageMult 5, ForceMax 128; the engine's
built-in fKnockbackAgilBase / AgilMult beside them are Oblivion's agility knockdown) and
fConcussionTimer (40; Fallout's crippled-head concussion) have no documented use in this game,
though Skyrim.esm sets values of its own for the first three; iStaggerAttackChance (50) is
undocumented. These need the original's code read for them.

## Combat style (CSTY)

- [x] CSGD: offensive, defensive and group offensive mults, the six equipment score mults,
      avoid threat chance (src/ai/combat-tactics.ts, combat-subtrees.ts).
- [x] CSME: attack and power attack staggered mults, power attack blocking mult, bash, bash
      recoil, bash attack, bash power attack mults, special attack mult.
- [x] CSCR: circle, fallback mults, flank distance, stalk time. CSLR: strafe mult.
- [x] CSFL: hover, dive bomb, ground attack, perch attack, flying attack chances; hover, ground
      attack and perch attack times (src/ai/flight.ts).
- [x] DATA Flanking (Flanking Movement), Allow Dual Wielding and the record flag of that name.
- [x] DATA Dueling (169 styles): the complement of Flanking (round 2, above).

## Attack data (ATKD, ATKE)

- [x] Event, damage mult, attack chance, spell (a disease bite: contractDisease), attack and
      strike angles, stagger, knockdown, recovery time, stamina mult, attack type keyword.
- [x] Flags: bash, power, left attacks; Override Data (see above).
- [x] Rotating Attack (38 attacks: the bears', sabre cats', mammoths', mudcrabs', chaurus' and
      dwarven spiders' side and spin attacks): the attacker keeps turning to its target through
      the attack (round 2, above).
- [x] The attack race (ATKR) of races and NPCs (actor-combat.ts).

## Race combat (DATA)

- [x] No Knockdowns, Regen HP In Combat, No Combat In Water, Can Dual Wield; angular
      acceleration, aim angle tolerance, flight radius.
- [x] Allow Mounted Combat (the three dragon races) and fMountedMaxLookingDown (round 2, above).
- [x] Non-Hostile (13 races): no threat to the player (round 2, above).
- [ ] Use Advanced Avoidance (90 races: the people, the undead, trolls, giants, atronachs, the
      dwarven machines, mudcrabs, frostbite spiders; not the wolves, bears, deer, horses): not
      read. What "advanced" avoidance is beside the plain one (src/ai/avoidance.ts) is not
      documented.
- [ ] Acceleration and deceleration rates, angular tolerance (171 races): declared for the
      movers (movement-types.ts RaceMovement), not read. The values (people 1 and 1, wolves 0.6
      and 2, dragons 0.01) read as seconds to full speed and to a stop, by analogy with the
      angular rate (1 / rate, observed in the original), but that is not confirmed.

## Behaviour tree

- [x] All 63 actions of the tree (src/ai/combat-tree.ts COMBAT_ACTIONS) have their action in the
      stage's registry (src/shell/actor-combat-ai.ts; typed: one missing does not compile).

## Game settings

The load order's combat settings (120: fCombat*, stagger, block, bash, power attacks, knockback,
kill camera, bleedout, confidence, flee, sneak damage, death force, bows, projectiles, mounted)
and 286 built-in ones the readers ask for by name.

- [x] 99 of 120 plugin settings (7 of them inert: never read, or an earlier game's grenades and
      mines) and all 286 built-in ones; round 2: fMountedMaxLookingDown.
- [ ] fPowerAttackCoolDownTime (0), fPowerAttackDefaultBonus (1): not read.
- [ ] iStaggerAttackChance (50): not read; undocumented (round 2, above).
- [ ] fKnockbackTime, fKnockbackDamageMult, fKnockbackForceMax, fConcussionTimer: not read; no
      documented use in this game (round 2, above).
- [ ] fKillCamBaseOdds (1): not read (the kill moves' odds are the INI's and the perks').
- [ ] fBlockSkillMult, fBlockAmountWeaponMult, fBlockMax (0.7): not read; in none of UESP's
      measured block formulas (round 2, above; combat-settings.ts TODO(M13)).
- [ ] fCombatSneakAttackBonusMult (100), fCombatDamageBonusSneakingMult (2): not read.
- [ ] iCombatDismemberPartChance, iCombatExplodePartChance: the limb roll keeps its defaults
      (dismemberment.ts), the load order's values are not read.
- [ ] fCombatPlayerLimbDamageMult, fCombatFollowRadiusMult, fAIUseWeaponDistance (15000),
      fCombatThreatProximityExplosionAvoidTime, fDeathForceSpellImpactMult,
      fBowZoomStaminaDrainMult: not read.

## Mechanics (by hand)

- [x] Controller and state, target selection, combat groups (combat-ai.ts, combat-groups.ts).
- [ ] The per-fight confidence roll's use; target selection's score weights are ours.
- [x] Attacks from attack data; power attacks; the special attack; left attacks (attacks.ts,
      combat-tactics.ts chooseAttack).
- [ ] Attacks while closing in; the special attack's own attack data.
- [x] Blocks, sustained block, block attack, bashes, offensive bash (block-bash.test.ts).
- [ ] The block attack's timing against the swing is ours.
- [x] Staggers, recoils, knockdowns, ragdolls on death (stagger.ts, actor-knockdowns.ts).
- [ ] The blocked hit's stagger terms; knockback (its settings, above).
- [x] Ranged combat: draw, hold, release, strafe, cover (ranged.test.ts).
- [ ] Line of fire; the cover score is ours.
- [x] Magic in combat: casters by purpose, dual casting, concentration, potions.
- [ ] The casters' order is ours.
- [x] The dragons' fight: the Flight subtree, perches, breath, landing (flight.ts,
      actor-flight.ts).
- [x] Flee: the strength ratio, to an ally, through a door, to cover; yield and surrender.
- [ ] Flee past a load door; the hide after Flee To Cover is a hold.
- [x] Kill moves and the kill cameras (kill-moves.test.ts, kill-camera-shots.test.ts).
- [ ] The magic kill camera.
- [x] Sneak attacks by the player and by NPCs (sneaking, undetected: actor-combat.ts).
- [x] Dual wielding (round 1, above).
- [x] Mounted combat (round 2, above; the rider's own attacks from the saddle TODO(M13)).
- [x] Combat dialogue and combat music (combat-dialogue.ts, combat-music.ts).
- [x] A dying actor's weapons (round 1, above).

## Next biggest

1. The race's acceleration and deceleration rates and angular tolerance (171 races) and Use
   Advanced Avoidance (90 races): the movers' rules.
2. The block and knockback settings (fBlockSkillMult, fBlockAmountWeaponMult, fBlockMax,
   fKnockback\*, fConcussionTimer) and iStaggerAttackChance: no document has their use; the
   original's code must be read for them.
3. iCombatDismemberPartChance and iCombatExplodePartChance (dismemberment.ts).
4. The sneak attack settings (fCombatSneakAttackBonusMult, fCombatDamageBonusSneakingMult) and
   the power attack ones (fPowerAttackCoolDownTime, fPowerAttackDefaultBonus).
