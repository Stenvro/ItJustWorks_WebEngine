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

## Count (2026-11-04, round 5)

| Part                     | Items | Done | Open |
| ------------------------ | ----: | ---: | ---: |
| Combat style (CSTY)      |    35 |   35 |    0 |
| Attack data (ATKD, ATKE) |    16 |   16 |    0 |
| Race combat (DATA, ATKR) |    15 |   15 |    0 |
| Behaviour tree actions   |    63 |   63 |    0 |
| Game settings            |   410 |  410 |    0 |
| Mechanics (by hand)      |    24 |   24 |    0 |
| Total                    |   563 |  563 |    0 |

Round 1 wrote the sweep and this list, and built down:

- Dual wielding: a race with Can Dual Wield (39 races) whose style allows it (the DATA flag or
  the record flag) takes a second one-handed weapon into its free left hand
  (combat-tactics.ts leftHandWeapon); the left attacks then run (leftAttack).
- Exit Water's second test: the race's No Combat In Water flag (162 races: all but the
  mudcrabs, slaughterfish and horkers, at home in water).
- A shout is aimed: released once its shouter has faced its target within
  fAIShoutToleranceDegrees (5) for fAIShoutMinAimSeconds (2) (shoutAim; the settings' use read
  from their names: TODO(M13)).
- A dying actor's weapons fall from its hands by iDeathDropWeaponChance (100); sheathed ones
  stay with the body (actor-combat.ts dropWeaponsOnDeath;
  tests/conformance/combat/death-weapons.test.ts).
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
undocumented. These needed the original's code read for them (settled in round 4, below).

Round 3 built down:

- Acceleration and deceleration rates (171 races): an actor gains and loses speed at them, read
  as the seconds from standing to its full run and from it to a stop, as its race's angular
  acceleration rate is the seconds to its full turn rate (observed in the original): a person 1
  and 1, a wolf 0.6 and 2, a deer 0.4 and 0.3, a giant or mammoth 3 and 3, a netch 5 and 5, the
  dragons 0.01 (locomotion.ts rampSpeed). A turn's slowing and a stop stay at once.
  TODO(M13): the unit is unconfirmed: no document gives it, and no locomotion clip of the
  people's or the wolves' projects starts or stops (the clips' root motion is steady), so the
  animations cannot settle it.
- Angular tolerance (171 races: 5° for nearly all, the horkers 45°, one race 50°): standing, the
  actor holds its facing until the heading it keeps is more than this off (with the
  fDefaultAngleTolerance / fCombatAngleTolerance its movement asks; TODO(M13): the plain reading).
- Use Advanced Avoidance (90 races): only these foresee where those moving near them will be
  and keep right of one coming head-on; the others (wolves, bears, deer, horses) go round those
  in their way as they stand now (avoidance.ts; TODO(M13): the plain reading of the name).
- fPowerAttackCoolDownTime (Skyrim.esm 0): no power attack is chosen sooner than this after the
  last (combat-tactics.ts chooseAttack). fPowerAttackDefaultBonus (1): a power attack without
  attack data of its own (a paired kill move's) deals 1 + this times the damage, the 2 the
  default power attack had (attacks.ts powerAttackDefault). Both their names' plain readings
  (TODO(M13)).

Looked for and not found (left open): fCombatSneakAttackBonusMult (100) and
fCombatDamageBonusSneakingMult (2) are in no document; the sneak attack's documented rule is
whole without them (the weapon kind's fCombatSneak*Mult × the perks × fDamageSneakAttackMult:
src/gameplay/combat/damage.ts), so their use needed the original's code (round 4). The block,
knockback and concussion settings and iStaggerAttackChance stayed open for the same reason;
iCombatDismemberPartChance and iCombatExplodePartChance are left to the dismemberment work.

Round 4 (2026-11-02) read them from the original (docs/ai.md, "Blocking", "Staggers",
"Knockback", "Damage"):

- fBlockMax, fBlockSkillMult, fBlockAmountWeaponMult: registered and never read (inert). The
  block's share is capped at fPlayerMaxResistance (85, UESP's measured cap, for every blocker)
  after the perks; its skill term is fArmorRatingBase + (fArmorRatingMax − fArmorRatingBase) ×
  Block / 100, not held to 100 (damage.ts blockedShare).
- iStaggerAttackChance: a plain melee hit (not blocked, not a bash, a melee weapon or the fists)
  staggers on its percent roll; the player always while [Combat] bPlayerAlwaysStaggered; blocked
  hits, bashes and shots always (stagger.ts staggerTaken).
- fKnockbackTime, fKnockbackDamageMult, fKnockbackForceMax: an unblocked hit pushes its target
  (damage × mult + fKnockbackDamageBase) × (fKnockbackAgilBase + fKnockbackAgilMult × 50) units,
  at most the max, over the time; not in a kill move, a Not Pushable race or by a projectile
  (knockback.ts; the controller's push: physics/character.ts knockBack). TODO(M13): whether the
  push fades over the time, and which stage of the damage it reads.
- fConcussionTimer, fCombatSneakAttackBonusMult, fCombatDamageBonusSneakingMult: registered and
  never read (inert).

Round 4b (2026-11-03) read the last nine from the original (docs/ai.md, "The engine's built-in
game settings"): fCombatPlayerLimbDamageMult (the player's limb damage is half), with
iCombatDismemberPartChance and iCombatExplodePartChance now read by name for the limb roll;
fDeathForceSpellImpactMult (an aimed fire-and-forget spell's death push); fBowZoomStaminaDrainMult
and the built-in fBowZoomStaminaRegenDelay (the bow zoom's drain, the hold once it empties
stamina). fCombatFollowRadiusMult, fAIUseWeaponDistance and
fCombatThreatProximityExplosionAvoidTime are registered and never read; fKillCamBaseOdds is read
only by a function nothing calls (all four inert).

Round 5 (2026-11-04) read the mechanics left from the original (docs/ai.md "Use Cover", "Flee",
"The odds", "Targets", "What it fights with"; docs/gameplay.md "The kill camera"):

- The cover has no score: the way search stops at the first triangle with an edge that holds
  (combat-subtrees.ts coverSpots, pickCover; hiding has its own test of an edge).
- The combat inventory's score of a spell (src/gameplay/combat/spell-score.ts): one caster per
  spell by its strongest effect; the casters are weighed in their spells' scores, each with its
  own check (chooseCaster).
- Flee Through Door goes through a load door (actor-stage.ts fleeThrough), not the one it came by,
  none with an enemy at it, none out of its encounter zone; the hide after Flee To Cover
  (#hide, hideFails) ends in Boost Confidence. Round 6 (2026-11-09): the flight goes on in the
  other cell (fled-through-doors.ts: its fight taken up once it and its enemy are there again,
  within fCombatDetectionFleeingLostRemoveTime); the hide is found as its enemy looks its way
  (hideSpottedDistance, fCombatHideCheckViewCone\*); the search takes its group's priority points
  and doors (combat-search.ts SearchArea, combat-subtrees.ts searchPoints); combat music weighs
  each group near the player apart. All four inferred rules, TODO(M13).
- The magic kill camera (actor-combat.ts spellLoosed); its beams, flames, cones and self casts
  by the tree's projectile type, delivery and casting type (2026-11-09; a concentration
  spray's prediction and a self cast's kill inferred).
- The encounter zone bounds a fight (zonesAllow); the odds stand at 100 for a frenzied actor and
  after 120 s unengaged (oddsWeighed); combat music and daresHelp weigh damage per second;
  left-hand attacks have their own attack data (the actor's melee options keep them apart);
  Fallback To Ranged backs to fCombatRangedDistance (fallbackPlace).

Round 5 (2026-11-09) took the last of the conformance list's open cases, each with an inferred
rule (TODO(M13)) where the original's was not found: GroupStrategy (the group's leader calls it as
two or more of the group come to attack one target: combat-groups.ts #strategies), the Fixed
target selector (StartCombat's target is kept while it is there: combat-ai.ts fixedTarget), an
NPC's kill move (a killing strike on its group's last target goes for its Special Attack first:
combat-tactics.ts killMoveFirst), an actor's own yield rule (once a fight, over as the player
holds off: combat-ai.ts yields, yieldOver), torches in a fight (combat-tactics.ts darkForTorch,
torchInFight; fCombatInventoryTorchEquipRange and MinEquipTimeTorch, fTorchLightLevel*), the
Flee package's safety (procedure-runs.ts fleeSafe: fFleeIsSafeTimer beyond fFleeDoneDistance*).

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
- [x] Use Advanced Avoidance (90 races: the people, the undead, trolls, giants, atronachs, the
      dwarven machines, mudcrabs, frostbite spiders; not the wolves, bears, deer, horses): they
      foresee others' movement (round 3, above; the plain reading).
- [x] Acceleration and deceleration rates, angular tolerance (171 races): the movers gain and
      lose speed at them, hold their facing within it (round 3, above; the rates' unit
      TODO(M13)).

## Behaviour tree

- [x] All 63 actions of the tree (src/ai/combat-tree.ts COMBAT_ACTIONS) have their action in the
      stage's registry (src/shell/actor-combat-ai.ts; typed: one missing does not compile).

## Game settings

The load order's combat settings (120: fCombat*, stagger, block, bash, power attacks, knockback,
kill camera, bleedout, confidence, flee, sneak damage, death force, bows, projectiles, mounted)
and 290 built-in ones the readers ask for by name.

- [x] 120 of 120 plugin settings (17 of them inert: never read, read only by code nothing
      calls, or an earlier game's grenades and mines) and all 290 built-in ones; round 2:
      fMountedMaxLookingDown; round 3: fPowerAttackCoolDownTime, fPowerAttackDefaultBonus;
      rounds 4 and 4b (below).
- [x] iStaggerAttackChance (50): a plain melee hit's stagger is taken on its percent roll
      (stagger.ts staggerTaken; round 4).
- [x] fKnockbackTime, fKnockbackDamageMult, fKnockbackForceMax (with the built-in
      fKnockbackDamageBase, AgilBase, AgilMult): an unblocked hit's push back (knockback.ts;
      round 4). fConcussionTimer: registered, never read (inert).
- [x] fKillCamBaseOdds (1): read in the original only by the kill camera's odds by level, which
      nothing calls (inert; round 4b).
- [x] fBlockSkillMult, fBlockAmountWeaponMult, fBlockMax: registered, never read (inert); the
      block's cap is fPlayerMaxResistance, its skill scale fArmorRatingBase / Max (round 4).
- [x] fCombatSneakAttackBonusMult, fCombatDamageBonusSneakingMult: registered, never read
      (inert; round 4).
- [x] iCombatDismemberPartChance, iCombatExplodePartChance, fCombatPlayerLimbDamageMult: read by
      name (combat-settings.ts); the limb roll and the limb damage (dismemberment.ts rollLimb,
      limbDamage, cripplesLimb; round 4b).
- [x] fCombatFollowRadiusMult, fAIUseWeaponDistance (15000),
      fCombatThreatProximityExplosionAvoidTime: registered, never read (inert; round 4b).
- [x] fDeathForceSpellImpactMult: a spell's death push (death-force.ts spellDeathForce,
      magic-projectiles.ts; round 4b).
- [x] fBowZoomStaminaDrainMult, with the built-in fBowZoomStaminaRegenDelay: the bow zoom's
      stamina drain and its emptying (bow-zoom.ts, time-flow.ts; round 4b).

## Mechanics (by hand)

- [x] Controller and state, target selection, combat groups (combat-ai.ts, combat-groups.ts).
- [x] The per-fight confidence roll's use; target selection's score weights (docs/ai.md,
      "Targets", "The odds", "Fleeing"; target-selection.test.ts, flee.test.ts).
- [x] Attacks from attack data; power attacks; the special attack; left attacks (attacks.ts,
      combat-tactics.ts chooseAttack).
- [x] Attacks while closing in (attackReaches: each attack's reach with its clip's move or its
      own speed at its hit frame); the special attack has no attack data: the idle tree's
      ActionRightPowerAttack, an NPC's kill moves (real-fight.test.ts, melee-choice.test.ts).
- [x] Blocks, sustained block, block attack, bashes, offensive bash (block-bash.test.ts).
- [x] The block attack's opening, observed in the original: only while its target draws back the
      swing, inside that swing's strike angle × fCombatBlockAttackStrikeAngleMult and within the
      target's weapon reach × fCombatBlockAttackReachMult plus a radius, now or
      fCombatAnticipateTime ahead (combat-tactics.ts blockAttackOpening). TODO(M13): the original
      adds a value to that reach read here as the actor's radius, and its node's 1 .. 2 s and
      0.25 s timers are not modelled.
- [x] Staggers, recoils, knockdowns, ragdolls on death (stagger.ts, actor-knockdowns.ts).
- [x] The blocked hit's stagger, observed in the original: the hit's own stagger less
      fStaggerBlockAttackShieldMult × rating (a shield's, else fStaggerDaggerAR, 1WeapAR, 2WeapAR,
      BowAR) + fStaggerBlockAttackShieldBase + fStaggerBlockMult × Block + fStaggerBlockBase + the
      mass offset, at least fStaggerMin (stagger.ts blockedStagger), for one blocking whichever
      way it faces. The stamina cost: share × damage before armour × fStaminaBlockDmgMult + stagger
      × fStaminaBlockStaggerMult + fStaminaBlockBase (vitals.ts blockCost). A shot is blocked too,
      by a shield or a weapon. A stagger's start takes the perks last and holds at most
      fStaggerMaxDuration (combat-state.ts tickStagger).
- [x] Knockback: an unblocked hit's push back on the controller (knockback.ts, round 4).
- [x] Ranged combat: draw, hold, release, strafe, cover (ranged.test.ts).
- [x] Line of fire: an actor in the way holds the shot, given up after
      fCombatAimProjectileBlockedTime (ranged.test.ts).
- [x] Line of fire against the world: a wall or the ground between blocks a shot as an actor
      does (a ray on the line-of-sight layer that passes every actor's bodies: whom a shot may
      pass stays the actor rule, so it still shoots past its target's foes); a spell from a hand
      is not cast down a blocked line either, a shout is (combat-tactics.ts lineOfFire,
      castWaitsForLineOfFire; ranged.test.ts, line-of-fire-world.test.ts). TODO(M13): the world
      check is ours; that a shout ignores the line is inferred.
- [x] Find Attack Location: the Ranged Movement's subtree (Find Lateral Attack Location, Find
      Attack Location, Find Ally Attack Location, Set Failed Timestamp, observed in the original),
      run while the line of fire is blocked, by the fCombatFind*AttackLocation* settings
      (combat-subtrees.ts, behaviour-tree.test.ts, ranged.test.ts). TODO(M13): the settings' use
      is inferred from their names (docs/ai.md, "The combat behaviour tree").
- [x] The cover: no score; the first edge that holds as the way search reaches it (round 5).
      TODO(M13): the reservation slots along an edge, an obstacle's move.
- [x] Magic in combat: casters by purpose, dual casting, concentration, potions.
- [x] The casters by their spells' combat inventory scores, each with its own check (round 5).
      TODO(M13): a drain's count only for a target that uses the resource (ours: any).
- [x] The dragons' fight: the Flight subtree, perches, breath, landing (flight.ts,
      actor-flight.ts).
- [x] Flee: the strength ratio, to an ally, through a door, to cover; yield and surrender.
- [x] Flee past a load door; the hide after Flee To Cover (round 5). TODO(M13): how long a hide
      lasts when nothing ends it (the Hide behaviour's own time was not read: ours until then).
- [x] Kill moves and the kill cameras (kill-moves.test.ts, kill-camera-shots.test.ts).
- [x] The magic kill camera (round 5).
- [x] Sneak attacks by the player and by NPCs (sneaking, undetected: actor-combat.ts).
- [x] Dual wielding (round 1, above).
- [x] Mounted combat (round 2, above; the rider's own attacks from the saddle TODO(M13)).
- [x] Combat dialogue and combat music (combat-dialogue.ts, combat-music.ts).
- [x] A dying actor's weapons (round 1, above).

## Next biggest

1. The knockback's fading (held for fKnockbackTime here) and which stage of a hit's damage it
   reads; the timed bash's reaction (TODO(M13), docs/ai.md "Staggers").
2. The rates' unit (acceleration, deceleration) and what the advanced avoidance adds.
3. The cases left in the conformance list (round 5, above).
4. A swing that misses its target falls on whoever stands in its cone (strikeTargets: the
   aimed target first where the strike reaches it, else the nearest). Ralof's dual-wield power
   attacks still fall on the player beside him in Helgen Keep's first fight (8 of his 25 blows
   in `tests/sim-helgen-keep-fight.int.test.ts`, about 15 health each; 2 to 3 in the browser).
   Allies are kept in the strike: the game settings count the blows an ally or a friend deals
   before it turns (iAllyHitCombatAllowed 1000, iFriendHitCombatAllowed 3: src/ai/combat-ai.ts),
   which only means something if a blow lands on the one's allies in a fight; ours counts them
   the same way (src/ai/combat-ai.ts, the hit tolerance). The strike angle's reading (half-width or
   whole) is still to be read from the original (TODO(M13)). (The swings from 190 to 450 units
   seen there before were the stage's bridge dropping the AI's attack choice: fixed, every NPC
   melee attack now goes through attackReaches.)
