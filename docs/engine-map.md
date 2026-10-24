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
  which 30 still do less than the original); every condition function the data uses is valued.
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
     still not sent (2026-10-24): OnPlayerLoadGame, OnAnimationEventUnregistered (OnReset and OnTrapHit* are now);
     before the hub about 20 script events were never sent (OnCombatStateChanged, OnReset, OnTrigger, OnEnterBleedout,
     OnOpen/OnClose, OnTrapHit, OnSpellCast, OnGrab/OnRelease, OnAttachedToCell, …; about 400 vanilla
     scripts wait for them);
   - story manager events: Change Location (258 quest entries: favors, bounties, town scenes,
     Daedric starts, bards), Cast Magic, Add/Remove Item, Dead Body, Arrest, Actor Hello, New Voice
     Power and Player Activate Actor are raised now; Bribe, Flatter, Intimidate, Cure, Infection,
     Player Gets Favor and Quest Start are not (vanilla has no quests on them);
   - of the 93 graph event handler classes of the response files 80 are answered, 2 do not exist in the
     executable, and 11 are read but not answered (2026-10-24: BeginCast, the camera override, the bow
     zoom, JumpBegin, MTState, three flight ends); graph event payloads reach the handlers.
2. **Guessed numbers where the engine has a setting.** Every area has constants we chose (touch reach,
   dual-cast window, sandbox stays, search radii, block times, debris, decal cap, …) while a game setting
   with a built-in default exists. Those defaults are now known.
3. **Time and budget.** The original updates actors by process level on a per-frame time budget,
   re-evaluates packages every 15 s or on the hour, runs sandboxes on the game clock, and lets most
   Papyrus natives wait for the main thread. Ours runs every actor every frame (the budget's rule is
   read: src/ai/process-levels.ts) and runs natives at once; packages are re-evaluated every 15 s and
   on the hour, sandbox stays are in game hours (2026-10-24).
4. **Persistence.** Cells reset and respawn by the engine's rule, and moved objects keep their places
   (2026-10-24); animated objects and corpses still return to their editor places when a cell reloads;
   there are no buffered cells; state the saves need is
   spread outside GameState, and Papyrus threads cannot be saved yet.
5. **Decision structures.** Combat is a behaviour tree in the original (actions per equipment slot in
   parallel with a movement priority list); ours is one fixed path. The sandbox has a daily plan and
   weighted activities; ours picks at random.

## Areas

### Scripting, events, world state, audio

| System                      | Status    | Main gaps                                                                                                                                                                           |
| --------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Form types                  | complete  | VOLI, LENS (render)                                                                                                                                                                 |
| Per-reference state         | partial   | animated state lost on unload, partial souls, alias display names (activate children: done, 158 of 6,527 pairs lie beyond the cells searched; MoveTo on a moving object: done)      |
| Cell loading                | partial   | no buffered cells, OnAttached/DetachedFromCell not checked, grid follows the camera (detach hours: done)                                                                            |
| Respawn, cell reset         | partial   | enable state on reset, the actors' own respawn clock, dropped items (reset rule, zones, OnReset, corpses, zone levels: done; vendor restock: done)                                  |
| Papyrus VM                  | different | natives not frame-synced; threads cannot be saved                                                                                                                                   |
| Script events               | partial   | not produced: OnPlayerLoadGame (M12), OnAnimationEventUnregistered; 52 of 68 not yet checked in the simulation                                                                      |
| Event sources               | partial   | hub kinds without a producer: active effects, perk entries, quest init, scenes, topic infos, loading; 7 sources without a kind; the stats' sources besides kills; resets/traps done |
| Story manager               | partial   | not raised: Bribe, Flatter, Intimidate, Cure, Infection, Player Gets Favor, Quest Start; most raised types not yet checked in the simulation                                        |
| Save and load               | missing   | M12                                                                                                                                                                                 |
| Stats, skills, actor values | complete  | tracked-stats event                                                                                                                                                                 |
| Audio                       | partial   | pause categories by DOBJ (menu fades, ducking and highlighting done), sounds held in menus, Slow Time only for its category, combat music rules                                     |
| Load order, settings        | partial   | plugins.txt and the user's INI files (M12)                                                                                                                                          |

### AI

| System                       | Status  | Main gaps                                                                                                                    |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Process levels, budget       | partial | the budget rule is read, not applied: no time slicing, no middle-low tier, the high process by distance                      |
| Package evaluation           | partial | flags Offers Services 85, Maintain Speed At Goal 62, Continue If PC Near 4, Skip Fallout Behavior 189, Allow Swimming 85     |
| Procedures                   | partial | engine-only packages (avoid player, react to destroyed object, warnings, get up, surface); Wear Sleep Outfit has no sim case |
| Sandbox                      | partial | rescan every 3–6 s, the search radius for a place without one, radius hysteresis, eating at the chair it sits on             |
| Movement, paths              | partial | navmesh obstacles not cut (cases written), doors not obstacles, no path idles                                                |
| Avoidance                    | partial | the engine's way round (who is avoided and re-planning are its)                                                              |
| Detection                    | partial | formula, reach, lines of sight, light and events the engine's; no one in ambush; the light's sum ours                        |
| Crime                        | partial | NPC crimes, the report rule, alarm reach (actor crimes go to the victim's or its owner's crime faction: done)                |
| Dialogue                     | partial | Invisible Continue (1,534 responses close the menu), Reset Hours (6,999), walk-away                                          |
| Scenes                       | partial | lines do not wait for facing; repeat pause                                                                                   |
| Actors away                  | partial | only one door away, hour steps                                                                                               |
| Followers, horses, furniture | partial | walk zone; mount from the right; enter by graph event; the horse's turn to the camera                                        |
| Head tracking                | partial | candidates' scores, look along the path, package target's look                                                               |

### Combat

| System            | Status    | Main gaps                                                                                                                                                            |
| ----------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller, state | different | per-behaviour timers; the per-fight confidence roll (read: fCombatConfidenceModifierMin .. Max, drawn as a fight begins; not applied)                                |
| Target selection  | different | additive scores, re-selection timing, crowding, reachability (the group's target knowledge and stealth points are the engine's: ai.md Combat detection)              |
| Flee              | different | strength ratio (damage per second × health against armour) instead of health share                                                                                   |
| Behaviour tree    | partial   | per-slot actions (left and dual attacks, shield and weapon, spell and weapon), cover, find attack location, hide, low combat (close movement: ai.md Combat movement) |
| Style values      | complete  | (on the engine's scale; the special attack, block attack and offensive bash behaviours wait for the tree)                                                            |
| Inventory         | partial   | hand pairs, continuous weighing after the minimum equip times, torches, ammunition                                                                                   |
| Melee choice      | partial   | attacks from attack data while closing in, per-attack angle and cooldown, special attack                                                                             |
| Block, bash       | different | sustained block, block attack, offensive bash                                                                                                                        |
| Close movement    | partial   | the selector's range split and Fallback To Ranged's condition (inferred); the flanking and ranged movement trees                                                     |
| Ranged            | partial   | line of fire (hold and release, firing arc, maximum hold: done), cover                                                                                               |
| Combat magic      | partial   | casters by purpose, dual casting, reanimate a corpse                                                                                                                 |
| Potions           | partial   | the casters' order in the tree; the stop-cast threshold of a held healing spell                                                                                      |
| Damage, stagger   | partial   | sneak attacks by the player only, attack damage mult, the blocked hit's stagger terms (stagger by the Mass actor value and the critical chance actor value: done)    |
| Combat dialogue   | partial   | per-subtype cooldowns and distance gates                                                                                                                             |
| Combat music      | different | threat-ratio gate, near-combat radius, stop delay                                                                                                                    |
| Kill moves        | partial   | the magic kill cam (rules read: docs/gameplay.md), the kill camera's radial blur between shots                                                                       |

### Magic, effects, perks

| System                  | Status  | Main gaps                                                                                   |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------- |
| Casting                 | partial | MQ101's storm rate in the sim; concentration refusal, NPC ward hold, Touch reach (unread)   |
| Magicka cost            | partial | an NPC's cast in the sim; the costliest effect that picks the school                        |
| Active effects          | partial | displacement rules, the conditions' interval, concentration effects a frame at a time       |
| Archetypes              | partial | Magelight, invisibility look, summon navmesh placement, telekinesis damage, cloak pulse     |
| Skill use               | partial | staffs with perks, a lasting effect by its first frame                                      |
| Enchanting              | partial | no glow on enchanted items; the charge without EAMT                                         |
| Projectiles, explosions | partial | impact force, cone sweep, lobber bounce, line of sight for areas, an explosion's own damage |
| Visual effects          | partial | effect shaders and art only on actors; RFCT visuals unread                                  |
| Perks                   | partial | 16 entry points unused by vanilla (mods)                                                    |

### Animation and bodies

| System               | Status  | Main gaps                                                                                                                                       |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph runtime        | partial | bDisableInterp's setter; an event no node takes reported as not handled                                                                         |
| Clips                | partial | mirrored additive clips by our own rule                                                                                                         |
| Engine handlers      | partial | 11 of 93 classes read but not answered (BeginCast, camera override, bow zoom, JumpBegin, MTState, three flight ends)                            |
| Weapons and aim      | partial | the player's casting pitch (PitchOverride), a crossbow's launch node, the bow zoom                                                              |
| Ambient idles        | partial | which specific idles skip the next PickNewIdle; the complex scene's wait; the frame's budget; the meal gate                                     |
| Animation objects    | partial | the female hands' scale; the POV switch while the player holds one; saves                                                                       |
| Paired animations    | partial | the support's mark from the clip (engine's, set once), its side kept to the clip's end, death limp at the end: done; events not routed per side |
| Ragdolls, death      | partial | no powered ragdoll motors; objects' placed ragdoll poses; the cone limit; a still death in a lean comes to rest standing (joint friction)       |
| Dismemberment        | partial | re-dressing a reloaded corpse from its recorded worn objects                                                                                    |
| Actor build          | partial | first-person render pass, bone LOD                                                                                                              |
| Faces                | partial | expression change rate                                                                                                                          |
| Graph state in saves | missing | M12                                                                                                                                             |

### Physics

| System               | Status    | Main gaps                                                                      |
| -------------------- | --------- | ------------------------------------------------------------------------------ |
| World, time step     | partial   | the step under Slow Time; objects placed into what they lie on fall through it |
| Triggers             | partial   | only actors enter triggers (L_TRIGGER takes 14 layers): layers unchecked       |
| Constraints          | partial   | script-made constraints (hanged corpses, hanging keys); a census of types      |
| Character controller | different | moving platforms do not carry actors; moving bodies do not push them           |
| Falling, swimming    | partial   | only the player swims; the drowning sound and gasp; NPCs surfacing             |
| Water physics        | missing   | buoyancy, currents (35 of 58 water types), splashes                            |
| Physics damage       | partial   | the listener's damage to destructibles (no vanilla impact reaches it)          |
| Traps                | partial   | hits on actors: done; material, initial flag, cloud traps unchecked            |
| Gameplay impulses    | partial   | arrows, spells, blows and shouts do not move clutter                           |
| Persistence          | partial   | animated objects and corpses; pushes without a script unchecked                |

### Rendering and camera

| System                                  | Status    | Main gaps                                                                              |
| --------------------------------------- | --------- | -------------------------------------------------------------------------------------- |
| Object shader                           | partial   | ambient specular, character light, eye reflections, sparkle snow, distance fades       |
| Lights                                  | different | per-object light lists; portal-strict lights leak through walls                        |
| Shadows                                 | partial   | no interior or point-light shadows, no focus shadows                                   |
| Fade, LOD                               | partial   | no distance fade of objects, items and actors                                          |
| Rooms, portals, occlusion               | missing   | everything is drawn                                                                    |
| Image space                             | partial   | volumetric lighting, lens flare, low-health effect, TAA                                |
| Water                                   | partial   | underwater view, ripples, reflections of what is off screen                            |
| Decals                                  | partial   | skinned decals, impact effect models, screen blood                                     |
| First person                            | different | no pass of its own (own field of view and near plane)                                  |
| Cameras                                 | partial   | camera shake, animated cameras, horse and dragon cameras, vanity, projectile kill cams |
| Sky, weather, particles, terrain, grass | complete  | small calibrations                                                                     |

### UI

| System                         | Status  | Main gaps                                                                                                                                                               |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menu manager                   | partial | named menu stack, saving permission, a UI API for mods                                                                                                                  |
| HUD                            | partial | HUD modes (book, map, crafting hide the HUD and lose notices), word of power and dragon soul notices, dungeon cleared, floating quest markers, meter fades, arrow count |
| Locations cleared, misc stats  | partial | clearing rule, Dungeons Cleared, the maps' Cleared: done; about 34 stats never counted                                                                                  |
| Input                          | partial | menu contexts read the default keys; no gamepad                                                                                                                         |
| Console                        | partial | about 25 of about 330 commands; no selection by click                                                                                                                   |
| Tutorials, loading, map, stats | partial | low-stat tutorials, map relief overlay, beast perk trees, Survival HUD                                                                                                  |

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
   overrides, evaluation timing, process levels and the AI budget, head tracking, dialogue's Invisible
   Continue and Reset Hours, actor conversations.
5. **Combat and magic rules.** Style values on the engine's scale, flee by strength, target selection,
   combat dialogue and music, blocking, potions, damage and stagger rules; taper, NPC magicka cost, skill
   use, line of sight and wards for areas and explosions, enchantment glow and value.
6. **Bodies and physics.** Death into ragdoll and powered
   ragdolls, physics damage, swimming and drowning for all, water physics, moving platforms.
7. **Rendering.** Per-object lights with rooms and portals, interior shadows, distance fade, the
   first-person pass, underwater, camera states and shake.
8. **Saves (M12)** on top: GameState for all state, a resumable Papyrus frame stack, our save format, then
   `.ess` import.
