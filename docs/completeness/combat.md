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

## Count (2026-11-01, round 1)

| Part                     | Items | Done | Open |
| ------------------------ | ----: | ---: | ---: |
| Combat style (CSTY)      |    35 |   34 |    1 |
| Attack data (ATKD, ATKE) |    16 |   15 |    1 |
| Race combat (DATA, ATKR) |    15 |    9 |    6 |
| Behaviour tree actions   |    63 |   63 |    0 |
| Game settings            |   406 |  384 |   22 |
| Mechanics (by hand)      |    22 |   13 |    9 |
| Total                    |   557 |  518 |   39 |

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

## Combat style (CSTY)

- [x] CSGD: offensive, defensive and group offensive mults, the six equipment score mults,
      avoid threat chance (src/ai/combat-tactics.ts, combat-subtrees.ts).
- [x] CSME: attack and power attack staggered mults, power attack blocking mult, bash, bash
      recoil, bash attack, bash power attack mults, special attack mult.
- [x] CSCR: circle, fallback mults, flank distance, stalk time. CSLR: strafe mult.
- [x] CSFL: hover, dive bomb, ground attack, perch attack, flying attack chances; hover, ground
      attack and perch attack times (src/ai/flight.ts).
- [x] DATA Flanking (Flanking Movement), Allow Dual Wielding and the record flag of that name.
- [ ] DATA Dueling (169 styles): not read. The tree as observed in the original runs Close
      Movement for every style without Flanking; where the dueling flag counts is not
      identified. TODO(M13).

## Attack data (ATKD, ATKE)

- [x] Event, damage mult, attack chance, spell (a disease bite: contractDisease), attack and
      strike angles, stagger, knockdown, recovery time, stamina mult, attack type keyword.
- [x] Flags: bash, power, left attacks; Override Data (see above).
- [ ] Rotating Attack (38 attacks: the bears', sabre cats', mammoths', mudcrabs', chaurus' and
      dwarven spiders' side and spin attacks): not read. Next: whether the attacker keeps
      turning to its target through the attack.
- [x] The attack race (ATKR) of races and NPCs (actor-combat.ts).

## Race combat (DATA)

- [x] No Knockdowns, Regen HP In Combat, No Combat In Water, Can Dual Wield; angular
      acceleration, aim angle tolerance, flight radius.
- [ ] Allow Mounted Combat (the dragon races: the rider fights from its back) and
      fMountedMaxLookingDown: an NPC gets off its horse to fight (actor-combat-ai.ts).
- [ ] Use Advanced Avoidance (90 races), Non-Hostile (13): not read.
- [ ] Acceleration and deceleration rates, angular tolerance (171 races): declared for the
      movers (movement-types.ts RaceMovement), not read.

## Behaviour tree

- [x] All 63 actions of the tree (src/ai/combat-tree.ts COMBAT_ACTIONS) have their action in the
      stage's registry (src/shell/actor-combat-ai.ts; typed: one missing does not compile).

## Game settings

The load order's combat settings (120: fCombat*, stagger, block, bash, power attacks, knockback,
kill camera, bleedout, confidence, flee, sneak damage, death force, bows, projectiles, mounted)
and 286 built-in ones the readers ask for by name.

- [x] 98 of 120 plugin settings (7 of them inert: never read, or an earlier game's grenades and
      mines) and all 286 built-in ones.
- [ ] fPowerAttackCoolDownTime (0), fPowerAttackDefaultBonus (1): not read.
- [ ] iStaggerAttackChance (50): not read.
- [ ] fKnockbackTime, fKnockbackDamageMult, fKnockbackForceMax, fConcussionTimer: not read.
- [ ] fKillCamBaseOdds (1): not read (the kill moves' odds are the INI's and the perks').
- [ ] fBlockSkillMult, fBlockAmountWeaponMult, fBlockMax (0.7): not read (the block's cap is
      UESP's 85%: combat-settings.ts TODO(M13)).
- [ ] fCombatSneakAttackBonusMult (100), fCombatDamageBonusSneakingMult (2): not read.
- [ ] iCombatDismemberPartChance, iCombatExplodePartChance: the limb roll keeps its defaults
      (dismemberment.ts), the load order's values are not read.
- [ ] fCombatPlayerLimbDamageMult, fCombatFollowRadiusMult, fAIUseWeaponDistance (15000),
      fCombatThreatProximityExplosionAvoidTime, fDeathForceSpellImpactMult,
      fBowZoomStaminaDrainMult, fMountedMaxLookingDown: not read.

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
- [ ] Mounted combat (above).
- [x] Combat dialogue and combat music (combat-dialogue.ts, combat-music.ts).
- [x] A dying actor's weapons (round 1, above).

## Next biggest

1. Mounted combat (Allow Mounted Combat; fMountedMaxLookingDown).
2. The knockback and block settings (fKnockback\*, fBlockSkillMult, fBlockAmountWeaponMult,
   fBlockMax) and iStaggerAttackChance.
3. Rotating attacks (38) and the Dueling flag (169 styles).
4. The race's acceleration rates and Use Advanced Avoidance (171, 90 races).
