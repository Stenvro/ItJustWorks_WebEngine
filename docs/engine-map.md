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
     still not sent (2026-10-24): OnReset, OnTrapHit*, OnPlayerLoadGame, OnAnimationEventUnregistered;
     before the hub about 20 script events were never sent (OnCombatStateChanged, OnReset, OnTrigger, OnEnterBleedout,
     OnOpen/OnClose, OnTrapHit, OnSpellCast, OnGrab/OnRelease, OnAttachedToCell, …; about 400 vanilla
     scripts wait for them);
   - story manager events: Change Location (258 quest entries: favors, bounties, town scenes,
     Daedric starts, bards), Cast Magic, Add/Remove Item, Dead Body, Arrest, Actor Hello, New Voice
     Power and Player Activate Actor are raised now; Bribe, Flatter, Intimidate, Cure, Infection,
     Player Gets Favor and Quest Start are not (vanilla has no quests on them);
   - about 65 of the 95 graph event handlers of the response files are not answered (ambient idles,
     animation objects, ragdoll on death, camera shake, animated cameras, voice fire, …), and graph event
     payloads are dropped.
2. **Guessed numbers where the engine has a setting.** Every area has constants we chose (touch reach,
   dual-cast window, sandbox stays, search radii, block times, debris, decal cap, …) while a game setting
   with a built-in default exists. Those defaults are now known.
3. **Time and budget.** The original updates actors by process level on a per-frame time budget,
   re-evaluates packages every 15 s or on the hour, runs sandboxes on the game clock, and lets most
   Papyrus natives wait for the main thread. Ours runs every actor every frame (the budget's rule is
   read: src/ai/process-levels.ts) and runs natives at once; packages are re-evaluated every 15 s and
   on the hour, sandbox stays are in game hours (2026-10-24).
4. **Persistence.** Cells never reset or respawn; objects moved by physics, animated objects and corpses
   return to their editor places when a cell reloads; there are no buffered cells; state the saves need is
   spread outside GameState, and Papyrus threads cannot be saved yet.
5. **Decision structures.** Combat is a behaviour tree in the original (actions per equipment slot in
   parallel with a movement priority list); ours is one fixed path. The sandbox has a daily plan and
   weighted activities; ours picks at random.

## Areas

### Scripting, events, world state, audio

| System                      | Status    | Main gaps                                                                                                                                                                           |
| --------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Form types                  | complete  | VOLI, LENS (render)                                                                                                                                                                 |
| Per-reference state         | partial   | physics-moved and animated state lost on unload, partial souls, alias display names (activate children: done, 158 of 6,527 pairs lie beyond the cells searched)                     |
| Cell loading                | partial   | no buffered cells, OnAttached/DetachedFromCell, grid follows the camera                                                                                                             |
| Respawn, cell reset         | missing   | no reset or respawn, no OnReset, corpses stay, encounter zone levels frozen (vendor restock: iDaysToRespawnVendor, done)                                                            |
| Papyrus VM                  | different | natives not frame-synced; threads cannot be saved                                                                                                                                   |
| Script events               | partial   | not produced: OnReset (cell reset), OnTrapHit* (traps), OnPlayerLoadGame (M12), OnAnimationEventUnregistered; 52 of 68 not yet checked in the simulation                            |
| Event sources               | partial   | hub kinds without a producer: active effects, perk entries, quest init, scenes, topic infos, resets, trap hits, loading; 7 sources without a kind; the stats' sources besides kills |
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
| Crime                        | partial | NPC crimes                                                                                                                   |
| Dialogue                     | partial | Invisible Continue (1,534 responses close the menu), Reset Hours (6,999), walk-away                                          |
| Scenes                       | partial | lines do not wait for facing; repeat pause                                                                                   |
| Actors away                  | partial | only one door away, hour steps                                                                                               |
| Followers, horses, furniture | partial | walk zone; mount from the right; enter by graph event; the horse's turn to the camera                                        |
| Head tracking                | partial | candidates' scores, look along the path, package target's look                                                               |

### Combat

| System            | Status    | Main gaps                                                                                                                                                            |
| ----------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller, state | different | per-behaviour timers; per-fight confidence roll                                                                                                                      |
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
| Damage, stagger   | partial   | sneak attacks by the player only, critical chance actor value, attack damage mult, stagger by the Mass actor value                                                   |
| Combat dialogue   | partial   | per-subtype cooldowns and distance gates                                                                                                                             |
| Combat music      | different | threat-ratio gate, near-combat radius, stop delay                                                                                                                    |
| Kill moves        | partial   | the magic kill cam (rules read: docs/gameplay.md), the kill camera's radial blur between shots                                                                       |

### Magic, effects, perks

| System                  | Status    | Main gaps                                                                                                 |
| ----------------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| Casting                 | partial   | dual-cast window, lesser power cooldown, NPC magicka regeneration while casting                           |
| Magicka cost            | different | the NPC formula (NPCs pay 2–4× too much)                                                                  |
| Active effects          | partial   | taper (all fire spells and fire enchantments linger in the original), displacement rules                  |
| Archetypes              | partial   | Magelight, invisibility look, summon placement, telekinesis damage, ward growth, cloak pulse              |
| Skill use               | different | the effect's skill usage multiplier; skill use by what the effect did                                     |
| Enchanting              | partial   | no glow on enchanted items; enchanted item value                                                          |
| Projectiles, explosions | partial   | impact force, cone sweep, lobber bounce, line of sight for areas and explosions, wards against explosions |
| Visual effects          | partial   | effect shaders and art only on actors                                                                     |
| Perks                   | complete  | 16 entry points unused by vanilla (mods)                                                                  |

### Animation and bodies

| System               | Status   | Main gaps                                                                                                                                       |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph runtime        | partial  | event payloads                                                                                                                                  |
| Clips                | complete | mirrored additive clips by our own rule                                                                                                         |
| Engine handlers      | partial  | about 65 of 95 unanswered                                                                                                                       |
| Weapons and aim      | partial  | the player's casting pitch (PitchOverride), a crossbow's launch node                                                                            |
| Ambient idles        | missing  | no idle picking (PickNewIdle)                                                                                                                   |
| Animation objects    | missing  | no tankards, hammers, brooms, lutes                                                                                                             |
| Paired animations    | partial  | the support's mark from the clip (engine's, set once), its side kept to the clip's end, death limp at the end: done; events not routed per side |
| Ragdolls, death      | partial  | no powered ragdoll motors; objects' placed ragdoll poses; the cone limit                                                                        |
| Dismemberment        | complete | re-dressing a reloaded corpse from its recorded worn objects                                                                                    |
| Actor build          | complete | first-person render pass, bone LOD                                                                                                              |
| Faces                | complete | expression change rate                                                                                                                          |
| Graph state in saves | missing  | M12                                                                                                                                             |

### Physics

| System               | Status    | Main gaps                                                                |
| -------------------- | --------- | ------------------------------------------------------------------------ |
| World, time step     | partial   | steps per frame, velocity clamps, continuous collision for fast clutter  |
| Triggers             | partial   | only actors enter triggers; the layer matrix is not checked for triggers |
| Constraints          | partial   | joint friction; script-made constraints (hanged corpses, hanging keys)   |
| Character controller | different | moving platforms do not carry actors; moving bodies do not push them     |
| Falling, swimming    | partial   | only the player takes fall damage or swims; no breath or drowning        |
| Water physics        | missing   | buoyancy, currents, splashes                                             |
| Physics damage       | missing   | heavy moving objects never hurt                                          |
| Traps                | missing   | the trap hit events are never raised: traps never hit                    |
| Gameplay impulses    | partial   | arrows, spells, blows and shouts do not move clutter                     |
| Persistence          | partial   | moved objects reset on unload                                            |

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
| Locations cleared, misc stats  | missing | no rule clears a location; about 35 stats never counted                                                                                                                 |
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
