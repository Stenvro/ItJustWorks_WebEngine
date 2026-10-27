# Engine map: the original's systems against ours

A map of every system of the original engine and how far ours matches it, made on 2026-10-23 to plan the
work after M11. The aim is an engine whose systems behave as the original's in every situation, so that
quests, places and actors work without fixes of their own.

How it was made: the original game's behaviour was studied: its class names, its strings, its settings with their
built-in defaults, and how it acts where names and data did not tell enough. The game data was counted with our own tools, and
CommonLibSSE named structures. Each area was then compared with our code. Nothing of the original game is
in this repository: the behaviour is described in our own words, the numbers are game settings by name.
The per-area detail lives in the docs of each area as the work is done; this page is the overview and the
plan.

Status words: **complete** (as the original, for what the game's data uses), **partial**, **different**
(works, but by other rules than the original's), **missing**.

## What is already complete

- Every record type the game uses is read; every Papyrus native the game's scripts declare exists (686, of
  which 21 still do less than the original); every condition function the data uses is valued.
- Every behaviour graph generator and modifier the vanilla graphs use runs; every particle modifier,
  emitter and collider; every effect shader flag; terrain, grass, distant trees.
- Every menu a PC player reaches plays from its original movie, driven through its own calls.
- Magic: every archetype that does more than run its scripts; all 68 perk entry points vanilla perks use.

So the gaps are rarely "something is not there". They are rules that differ, events nobody sends, numbers
we guessed where the engine has a setting, and state that does not persist.

## Cross-cutting findings

These run through every area and explain most of what breaks in play.

1. **Events nobody sends.** The original routes its happenings through about 50 event sources that feed
   the scripts, the story manager, the stats and the HUD at once. Ours calls each consumer from each
   producer, so many are never reached:
   - the hub (src/scripting/runtime/event-hub.ts) is in, and one activation path for every activator;
     still not sent (2026-10-27): OnAnimationEventUnregistered (OnPlayerLoadGame is now, after a load) (OnReset and OnTrapHit* are now);
     before the hub about 20 script events were never sent (OnCombatStateChanged, OnReset, OnTrigger, OnEnterBleedout,
     OnOpen/OnClose, OnTrapHit, OnSpellCast, OnGrab/OnRelease, OnAttachedToCell, …; about 400 vanilla
     scripts wait for them);
   - story manager events: Change Location (258 quest entries: favors, bounties, town scenes,
     Daedric starts, bards), Cast Magic, Add/Remove Item, Dead Body, Arrest, Actor Hello, New Voice
     Power and Player Activate Actor are raised now; Bribe, Flatter, Intimidate, Cure, Infection,
     Player Gets Favor and Quest Start are not (vanilla has no quests on them);
   - of the 93 graph event handler classes of the response files 91 are answered and 2 do not exist in
     the executable (2026-10-27); the camera override's and MTState's flags are kept but nothing reads
     them yet (their use is unread); graph event payloads reach the handlers.
2. **Guessed numbers where the engine has a setting.** Every area has constants we chose (touch reach,
   dual-cast window, sandbox stays, search radii, block times, debris, decal cap, …) while a game setting
   with a built-in default exists. Those defaults are now known.
3. **Time and budget.** The original updates actors by process level on a per-frame time budget,
   re-evaluates packages every 15 s or on the hour, runs sandboxes on the game clock, and lets most
   Papyrus natives wait for the main thread. Ours does too: natives wait for the frame by their
   registration, the calls handed to the main thread begin within the VM update's share of the
   budget, and a loaded game's VM runs on its own first (2026-10-27); packages are re-evaluated
   every 15 s and on the hour, sandbox stays are in game hours (2026-10-24); the actors beyond the
   high process take turns within the frame's budget (src/ai/process-levels.ts, 2026-10-27).
4. **Persistence.** Cells reset and respawn by the engine's rule, and moved objects keep their places
   (2026-10-24); animated objects keep their graph state and cells are buffered (2026-10-27);
   corpses still return to their editor places when a cell reloads.
5. **Decision structures.** Combat is a behaviour tree in the original (actions per equipment slot in
   parallel with a movement priority list); ours runs that tree (src/ai/combat-tree.ts), some subtrees still TODO(M13). The sandbox has a daily plan and
   weighted activities; ours picks at random.

## Areas

### Scripting, events, world state, audio

| System                      | Status   | Main gaps                                                                                                                                                                               |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Form types                  | complete |                                                                                                                                                                                         |
| Per-reference state         | partial  | partial souls listed one entry per gem base; corpses' poses on reload (animated state kept across unload, partial souls, alias display names: done 2026-10-27; activate children: done) |
| Cell loading                | partial  | a buffered cell keeps its data, not its 3D; OnAttached/DetachedFromCell no sim case (cell buffers, grid on the player, detach hours: done)                                              |
| Respawn, cell reset         | partial  | whether reset sets the initial enable state; what else sets an actor's respawn clock (enable state, the actor's clock from its death, dropped items: done 2026-10-27)                   |
| Papyrus VM                  | partial  | its own scheduling of stacks (inferred), latent calls' render-safe / post-render queues, stack memory (iMaxAllocatedMemoryBytes) (frame sync, budgets, post-load run: done 2026-10-27)  |
| Script events               | partial  | 52 of 68 not yet checked in the simulation (OnAnimationEventUnregistered, OnMenuOpen/Close: done)                                                                                       |
| Event sources               | partial  | 7 sources without a kind; the stats' sources besides kills (every hub kind has a producer: 2026-10-27; resets/traps done)                                                               |
| Story manager               | partial  | most raised types not yet checked in the simulation; the engine's own raise sites of Bribe/Flatter/Intimidate (the counts), Player Gets Favor (SetDoingFavor) and Quest Start's members |
| Save and load               | partial  | own format (docs/formats/save.md); whether a native in flight is called again on load; .ess import (M12) (threads in a native's promise, translations, hazards, projectiles: done)      |
| Stats, skills, actor values | complete | tracked-stats event                                                                                                                                                                     |
| Audio                       | partial  | (the skills menu's SMSC mute, pause categories by DOBJ, sounds held in menus and on the loading screen, Slow Time by DOBJ TSSC: done)                                                   |
| Load order, settings        | partial  | a master loading after its dependent is only reported; the launcher's detail presets (plugin screen, Plugins.txt import, missing masters, plugin archives, layered INI files: done)     |

### AI

| System                       | Status  | Main gaps                                                                                                                                                                                                                                   |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process levels, budget       | partial | the high-process distance is ours (no setting names it); how the engine shares the budget between its lists                                                                                                                                 |
| Package evaluation           | partial | ours: Continue If PC Near's reach, the fallout's radius and options (all PKDT flags honoured, the fallout saved: src/ai/package-flags.test.ts)                                                                                              |
| Procedures                   | partial | what makes Get Up and Surface; Wear Sleep Outfit has no sim case (engine packages: avoid player, steal warning, react to destroyed object, movement blocked, asking the player to move: done; pickpocket warning never made, as the engine) |
| Sandbox                      | partial | which places the engine gives no radius; extra dialogue range; delay on arrival; its pick with nothing open (rescan, search radius, hysteresis, eating at its chair, on its idle marker: done)                                              |
| Movement, paths              | partial | navmesh obstacles cut approximately (no re-triangulation: M13), no path idles                                                                                                                                                               |
| Avoidance                    | partial | the engine's way round (who is avoided and re-planning are its)                                                                                                                                                                             |
| Detection                    | partial | the light's sum ours (walls keep lights off: done); an Ambush package's own target (Ambush packages: done)                                                                                                                                  |
| Crime                        | partial | NPC crimes beyond assault; guards that only hear an NPC's alarm; fCrimeAlarmRespMult (NPC assault alarms, guards fight: done)                                                                                                               |
| Dialogue                     | partial | Say Once with Reset Hours (61 infos: comes back after them, TODO(M13)); walking off a greeting outside the menu                                                                                                                             |
| Scenes                       | partial | repeat pause (Repeat Conditions While True restarts at once); facing wait limit (3 s ours)                                                                                                                                                  |
| Actors away                  | partial | who keeps a schedule away (ours: persistent actors and those near) and its pace are ours; the place between doors                                                                                                                           |
| Followers, horses, furniture | partial | follow offset and walk zone's built-in value ours; mount from the right; enter by graph event; horse turns to camera                                                                                                                        |
| Head tracking                | partial | candidates' scores and look-ahead ours (player, speaker, mover; along the path: done); package target's look                                                                                                                                |

### Combat

| System            | Status   | Main gaps                                                                                                                                                                                                                                                                                  |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Controller, state | partial  | per-behaviour timers (the per-fight confidence roll: drawn as a fight begins, a shift of the confidence level, TODO(M13) the engine's use)                                                                                                                                                 |
| Target selection  | partial  | the score weights are ours (additive scores, re-selection and switch timing, crowding, an unreachable target weighed down: done)                                                                                                                                                           |
| Flee              | partial  | past a load door; the hide after Flee To Cover is a hold (strength ratio, Flee To Ally, Flee Through Door, Flee To Cover: done)                                                                                                                                                            |
| Behaviour tree    | partial  | Low Combat runs only off the high process and its blow swings; the search's priority points and doors; the Find Attack Location leaf (a left spell beside a one-handed weapon, the Movement order, Exit Water, Acquire Weapon, Use Cover, Search, Low Combat: done, src/ai/combat-tree.ts) |
| Style values      | complete | (on the engine's scale; the special attack, block attack and offensive bash run in the tree)                                                                                                                                                                                               |
| Inventory         | partial  | hand pairs, continuous weighing after the minimum equip times, torches, ammunition                                                                                                                                                                                                         |
| Melee choice      | partial  | attacks from attack data while closing in; the special attack's own attack data (per-attack angle and cooldown, special attack chance: done)                                                                                                                                               |
| Block, bash       | partial  | the block attack's timing against the swing is ours (sustained block, block attack, offensive bash: done)                                                                                                                                                                                  |
| Close movement    | partial  | the selector's range split (inferred); Find Attack Location (the ranged tree's Strafe Selector: strafe, circle, idle; flanking tree, Fallback To Ranged, Ranged Movement by fCombatRangedDistance: done)                                                                                   |
| Ranged            | partial  | line of fire; the cover score is ours (hold and release, firing arc, maximum hold, Use Cover: done)                                                                                                                                                                                        |
| Combat magic      | partial  | the casters' order is ours (casters by purpose wired: ward, held restore to its stop threshold, summons, reanimation, buff; dual cast chance, the Prepare Dual Cast hold: done)                                                                                                            |
| Potions           | partial  | the stop-cast threshold of a held healing spell (holdsRestore) not wired (the slots' order, Potion before Magic: done)                                                                                                                                                                     |
| Damage, stagger   | partial  | sneak attacks by the player only, attack damage mult, the blocked hit's stagger terms (stagger by the Mass actor value and the critical chance actor value: done)                                                                                                                          |
| Combat dialogue   | partial  | the range the distance mults scale is ours; Bleedout, Death, AllyKilled, GroupStrategy lines (per-subtype cooldowns, distance gates, speak chances: done)                                                                                                                                  |
| Combat music      | partial  | the near-combat radius and the stop delay are our values (no plugin names them); the odds use our actorStrength (threat-ratio gate, boss music, stop delay: done)                                                                                                                          |
| Kill moves        | partial  | the magic kill cam (rules read: docs/gameplay.md), the kill camera's radial blur between shots                                                                                                                                                                                             |

### Magic, effects, perks

| System                  | Status  | Main gaps                                                                                                           |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| Casting                 | partial | MQ101's storm rate in the sim; NPC ward past its minimum (concentration refusal, fail sound, Touch reach: done)     |
| Magicka cost            | partial | an NPC's cast in the sim                                                                                            |
| Active effects          | partial | displacement rules, the conditions' interval (concentration effects a frame at a time: done)                        |
| Archetypes              | partial | invisibility's refraction shimmer (dithered now), a summon's other place when the way is blocked, Magelight's limit |
| Skill use               | partial | staffs with perks, a lasting effect by its first frame                                                              |
| Enchanting              | partial | the charge without EAMT; worn armour shows no glow (TODO(M13): unchecked); dropped and made items glow: done        |
| Projectiles, explosions | partial | a cone's push as its front passes, a lobber's slide on a slope; cone waves and stuck Magelights not saved           |
| Visual effects          | partial | RFCT flags (face target, attach to camera); art on held weapons at the hand node                                    |
| Perks                   | partial | 16 entry points unused by vanilla (mods)                                                                            |

### Animation and bodies

| System               | Status  | Main gaps                                                                                                                                       |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph runtime        | partial | bDisableInterp's setter; an event no node takes reported as not handled                                                                         |
| Clips                | partial | mirrored additive clips by our own rule                                                                                                         |
| Engine handlers      | partial | all 91 classes answered; what reads the camera override's and MTState's flags (unread); NPCs' JumpBegin (their controllers do not jump)         |
| Weapons and aim      | partial | the player's casting pitch (PitchOverride), a crossbow's launch node (the bow zoom by the graph's BowZoomStart / Stop: done)                    |
| Ambient idles        | partial | which specific idles skip the next PickNewIdle; the complex scene's wait; the frame's budget; the meal gate                                     |
| Animation objects    | partial | the female hands' scale; the POV switch while the player holds one; saves                                                                       |
| Paired animations    | partial | the support's mark from the clip (engine's, set once), its side kept to the clip's end, death limp at the end: done; events not routed per side |
| Ragdolls, death      | partial | no powered ragdoll motors; objects' placed ragdoll poses; the cone limit; a still death in a lean comes to rest standing (joint friction)       |
| Dismemberment        | partial | re-dressing a reloaded corpse from its recorded worn objects                                                                                    |
| Actor build          | partial | first-person render pass, bone LOD                                                                                                              |
| Faces                | partial | expression change rate                                                                                                                          |
| Graph state in saves | partial | objects' graphs (sequences, skeletal machines) saved; actors' rebuilt from furniture and packages; behavior references                          |

### Physics

| System               | Status  | Main gaps                                                                       |
| -------------------- | ------- | ------------------------------------------------------------------------------- |
| World, time step     | partial | objects placed into what they lie on fall through it                            |
| Triggers             | partial | projectiles in flight do not enter triggers (rays, no reference yet)            |
| Constraints          | partial | script-made joints across a cell reload; a census of types                      |
| Character controller | partial | leaving a moving platform keeps no velocity; Havok's proxy push response        |
| Falling, swimming    | partial | the drowning sound and gasp (NPCs swim where their package allows: done)        |
| Water physics        | partial | the splash model; Havok's own buoyancy and drag rule (ours from the data)       |
| Physics damage       | partial | the listener's damage to destructibles (no vanilla impact reaches it)           |
| Traps                | partial | hits on actors: done; material, initial flag, cloud traps unchecked             |
| Gameplay impulses    | partial | the rules from settings, not read from the engine (TODO(M13)); ragdoll hit time |
| Persistence          | partial | animated objects and corpses; pushes without a script unchecked                 |

### Rendering and camera

| System                                  | Status    | Main gaps                                                                            |
| --------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| Object shader                           | partial   | character light luminance source, eye reflection centres, sparkle snow (type 14)     |
| Lights                                  | different | per-object light lists (moving actors take their room each frame: done)              |
| Shadows                                 | partial   | shadow lights (all cells), focus shadows done; focus maps draw every caster          |
| Fade, LOD                               | partial   | fade rule estimated (radius × fade setting, TODO(M13)); no fLODFadeOutMultSkyCell    |
| Rooms, portals, occlusion               | partial   | LOD not culled by them (rooms' lighting templates and image spaces: done)            |
| Image space                             | partial   | god rays are a screen-space blur, not the froxel volume; TAA without motion vectors  |
| Water                                   | partial   | underwater fog, ripple rings, edge reflections done; engine displacement sim, colour |
| Decals                                  | partial   | skinned decals, screen blood (impact effect models: done)                            |
| First person                            | partial   | own view and depth band done; engine near plane, first-person particles              |
| Cameras                                 | partial   | states, shake, vanity, kill cams done; explosion shake, dragon lock-on, iron sights  |
| Sky, weather, particles, terrain, grass | complete  | small calibrations                                                                   |

### UI

| System                         | Status  | Main gaps                                                                                                                                                                                               |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menu manager                   | partial | named stack with IMenu flags, saving permission, UI.IsMenuOpen and mod menus: done; SKSE's other UI natives, menu events to scripts (RegisterForMenu)                                                   |
| HUD                            | partial | modes per menu, held notices, word/soul/cleared notices, floating marker, meter keep, arrow count: done; the marker's bound height, lockpicking's notices (TODO M13)                                    |
| Locations cleared, misc stats  | partial | about 20 stats never counted (Gold Found, Chests Looted, Barters, the quest counts, beast forms); kills, crimes, crafts, books, shouts, words, sleep, food, skills, spells, harvests, discoveries: done |
| Input                          | partial | gamepad (Gamepad API, contexts, GFx gamepad keys, remap) done; analog walk speed, rumble, live SetPlatform for open menus                                                                               |
| Console                        | partial | about 115 commands; tfc 1 (no world freeze hook), tdetect variants, near trees under tt                                                                                                                 |
| Tutorials, loading, map, stats | partial | low-stat tutorials, map relief overlay, beast perk trees, Survival HUD                                                                                                                                  |

## Order of work

Systems that everything uses come first; each phase makes the next cheaper.

1. **Events.** A typed event hub that feeds the scripts, the story manager, stats and the HUD; then every
   missing script event and story manager event (Change Location first: 258 quests), and the graph event
   handlers with their payloads.
2. **Engine settings sweep.** Replace every guessed constant that has a game setting by the setting, area
   by area (the defaults are known).
3. **World rules.** Activate parents and children, triggers for objects and projectiles, trap hits,
   location clearing, cell reset and respawn, keeping moved and animated state.
4. **Living actors.** Ambient idles, animation objects, the sandbox's daily plan, package flags and
   overrides, evaluation timing, process levels and the AI budget, head tracking, actor
   conversations.
5. **Combat and magic rules.** Style values on the engine's scale, flee by strength, target selection,
   combat dialogue and music, blocking, potions, damage and stagger rules; taper, NPC magicka cost, skill
   use, line of sight and wards for areas and explosions, enchantment glow and value.
6. **Bodies and physics.** Death into ragdoll and powered
   ragdolls, physics damage, swimming and drowning for all, water physics, moving platforms.
7. **Rendering.** Per-object lights with rooms and portals, interior shadows, distance fade, the
   first-person pass, underwater, camera states and shake.
8. **Saves (M12)** on top: GameState for all state, a resumable Papyrus frame stack, our save format, then
   `.ess` import.
