# Scripting

The game's Papyrus scripts run in our own virtual machine (`src/scripting/`): the compiled
scripts (PEX, [formats/pex.md](formats/pex.md)) from the game data, attached to forms, quests,
aliases and dialogue by the plugins (VMAD, [formats/esm.md](formats/esm.md)). Milestone M8.

## The game's scripts

`node tools/pex-dump.ts --verify` parses every script of the load order. Vanilla (with the
three DLCs and the free Creation Club items) holds 14302 compiled scripts, fragment scripts
included. 44 of them declare the 686 native functions the engine provides, all of them in the
runtime (Actor 184,
ObjectReference 121, Game 80, Debug 29, ActiveMagicEffect 25, Faction 24, Quest 24, Utility
24, Form 22, Alias 19, ...); 540 of those are called somewhere. The events the scripts handle
most: OnActivate, OnTriggerEnter, OnDeath, OnLoad, OnUpdate, OnEffectStart, OnHit, OnInit,
OnContainerChanged, OnCellAttach.

## Threads

As the Creation Kit wiki's "Threading Notes (Papyrus)" describe them (`papyrus-vm.ts`):

- Every event an object gets runs on a thread of its own, one per script attached to it,
  in the handler of the state the script is in when the event comes.
- A script instance is locked while a thread runs in it. Any **external call** unlocks it until
  the call returns: a function on another object, a global function, another object's native,
  a latent function (Utility.Wait). Calls on self keep the lock. Threads waiting for the lock
  get in in the order they came (the game's order is not guaranteed).
- Until a script's **OnInit** has finished, its other events and other scripts' calls and
  property access wait for it (calls from inside another OnInit do not).
- **Latent** natives suspend their thread (`NativeCall.latent`), unlocking its script also
  for natives on self, until what they wait for has happened. Quest.SetStage waits so for the
  stage's fragments, each on a thread of its own (the wiki warns that setting a stage in
  OnInit can deadlock: the fragment waits for the OnInit that waits for it); the scheduler (`scheduler.ts`) resumes waits on its clocks: real seconds outside
  menus (Utility.Wait) and game time (WaitGameTime).
- Each frame, threads run for the [Papyrus] **fUpdateBudgetMS** budget (1.2 ms); a thread
  past it goes on in the next frame, keeping its lock. Without frames (Node tools) threads
  run straight through, and one that runs two million instructions without ever waiting is
  stopped as an endless loop.
- A script error (a runaway thread, too deep a call stack) stops its thread and is reported,
  never thrown at the engine, as the game logs it.

TODO(M12): save the threads, variables and registrations.

## The runtime

`src/scripting/runtime/` runs the game's scripts on the game data, in Node as in the browser
(`node tools/papyrus-run.ts --new-game` plays a new game's scripts and reports what they
called that is missing; `node tools/papyrus-natives.ts` lists the natives done per script).

- **Forms** (`forms.ts`): records, their scripts (a reference's own VMAD over its base's,
  its properties winning), parsed quests and aliases, every version of a record.
- **Game state** (`game-state.ts`): what the running game changed on top of the plugins,
  plain data to be saved (TODO(M12)): clocks, globals, quests, references, actors, actor
  bases, factions, locations, cells, inventories (with the item stacks that carry data of
  their own: improved items), created references, the forms the game made (created forms:
  potions, enchantments, enchanted items; docs/gameplay.md "Crafting"), leveled list
  additions, active magic effects.
- **Natives** (`natives/`): all 686 the game's scripts declare, by script. What they change is
  game state; what the engine shows goes through the **WorldBridge** (`runtime.ts`): enable
  state, moves, animation events, sounds, weather, menus, combat, packages. Without a world (in
  Node) the bridge does nothing and the state alone answers. Those that do not do all the game
  does yet are listed in `natives/placeholders.ts`, each with the milestone that brings what
  they lack (`node tools/papyrus-natives.ts --placeholders`, with the vanilla scripts' calls of
  each; the integration test holds each to a milestone): 16 of them called by the vanilla
  scripts, for the player's forms and vampirism (M11), saves (M12), effects the
  engine does not show yet, Havok constraints and controllers (M13). Natives that rightly do
  nothing here (profiling, the console's debug helpers, achievements, preloading) are not
  placeholders.
- **Conditions** (`condition-values.ts`): see Conditions below.
- Work that goes on by itself (events, waits, story events) is detached: a fault in it is
  reported, never left to stop the app.

## Conditions

Every condition (CTDA) of the running game is valued by `ScriptRuntime.conditionsHold`
(`condition-values.ts`, with `magic-conditions.ts` and `crime-conditions.ts`): the run-on
(subject, target, a reference, the combat target, the linked reference, a quest alias, a
package data input, the event's data), the CTDA flags (xEdit: Or; Use aliases and Use packdata,
which make a reference parameter an alias of the quest or a data input of the running package;
Use global for the comparand; Swap Subject and Target), the function, the comparison; an
OR-flagged condition joins the next. What follows a failed AND is not valued (it cannot change
the answer): a quest's alias search asks every reference of the loaded area, and most fail on
their first condition. A function no evaluator values holds and is reported
(`NOT_VALUED`): `node tools/condition-audit.ts` scans every record of the load order that has
conditions (258 functions in use) and asks the evaluator for each with samples of its
conditions on the player, and `tests/condition-audit.int.test.ts` fails on any it does not
value. Only the perk entry points' own functions are left to another evaluator (`NOT_YET` in
`tools/condition-usage.ts`: EPMagic_SpellHasKeyword, EPMagic_SpellHasSkill, IsAttackType,
EPModSkillUsage_IsAdvanceSkill, EPAlchemyEffectHasKeyword, EPAlchemyGetMakingPoison, IsPoison:
they ask about the entry point's spell, attack, skill or potion: the perk engine values them in
perk entries, the only records that use them).

What they read: quests, globals and script variables; what a reference is and has (its base,
race, class, keywords, factions, items, gold, keyword items, diseases, lock, being essential,
protected, restrained, eaten); where it is (cells, worldspaces, locations and their keywords,
reference types and keyword data, its position, the angles and distances to another, being in a
container, linked to another, within its package's location, the player's regions, dangerous
water); the weather (the current weather and its classification); its AI and senses through
the WorldBridge (its package and procedure, its movement and its path's target and speeds,
furniture, detection, combat, flight, dialogue); the player's actions (a power attack, a bash, a
lock's outcome); persuasion (GetIntimidateSuccess: UESP's formula, the engine's confidence
multipliers 0, 0.5, 1, 1.5, 100; fIntimidateSpeechcraftCurve 1, TODO(M13)); tempering
(EPTemperingItemIsEnchanted on the item the smithing menu improves); the kill cameras (CPTH:
GetVATSValue's weapon, action, distance, projectile, delivery and casting type of the kill, the
free space beside either of its actors and how far the other is seen from there). DoesNotExist
is 1 for an event member that is not there. GetQuestVariable reads Oblivion's compiled quest
scripts, which no plugin has: 0.

Sounds' conditions (SNDR) run on the reference that sounds them (`SoundSystem.play` with its
source: a draugr's taunt, the player's bow zoom) through the running game's evaluator; ambient
sounds (the regions' and weathers') and music tracks (MUST) are checked synchronously by
`src/audio/sound-conditions.ts`, whose functions (the time, the weather, rain, interiors,
swimming, globals, the player's combat target's keywords) cover all the data uses there (the
audit checks it).

## A new game

As the game starts one (`ScriptRuntime.newGame`): the clock at the plugins' date and hour
(GameDaysPassed and GameHour), every quest's and alias's scripts started (OnInit) and every
persistent reference's with scripts, then the quests that start with the game, by priority
(TODO(M13): the engine's order), their aliases allowed to take reserved references (Creation
Kit). A start resets a quest that does not run once, so its OnInit runs again. Then the
opening: no record or script starts **Unbound** (MQ101); the game does as a new game begins
(UESP). On the vanilla data with the DLCs and Creation Club items all 443 start (the update
and DLC set-up quests stop themselves at once) and MQ101 runs; no native is missing. A matching
location alias takes only a location that has the reference types the quest's later location
reference aliases need: FreeformCaravansA's dungeon could be Dragonborn's Damphall Mine (1 of
its 26 matches), which has no map marker for its MapMarker alias, and the quest then did not
start at random (4 of 40 new games). TODO(M13): whether the engine looks ahead so or tries
another match (UESP lists Damphall Mine among the amulet's places).

What takes the time is reading records, not running scripts: in Node a new game takes about
6 s. In the browser each read waits on a round trip, so the reads are made side by side where
their order does not matter, and plugins and archives are read through block caches
([formats/esm.md](formats/esm.md#reading-records)): the persistent references' bases'
attachments are read at once, and a searched alias checks its candidates 256 at a time (each
check only reads; the matches keep the candidates' order, so the one taken is the same).
DA16's four spectator aliases search all persistent references with HasKeyword and GetInCell
(3.2 s of the 6.2 s the 443 quests take in the browser); DA16, BYOHHouseFalkreath and
C00JorrvaskrFight took 16, 2.7 and 0.7 s when each candidate waited on its reads. Which
threads run first between reads depends on how long each read takes (a read from a block
already read returns at once), as it does in the browser in any case: script-started radiant
quests (the College's MGR quests) may come out differently from one new game to the next.

## Quests

`quests.ts` and `alias-fill.ts`, after the Creation Kit's Quest pages:

- **Start** fills the aliases in order; one that must be filled and stays empty keeps the
  quest from starting. A quest with an event type starts only from that story manager event.
  The start-up stage is set as it starts; its fragment runs on a thread of its own. Its scenes
  that begin on quest start start, and they end as it stops ([ai.md](ai.md#scenes)).
- **SetStage** starts the quest if needed; without "allow repeated stages" a stage is set once;
  the first log entry whose conditions hold happens (completes or fails the quest, starts the
  next) and only its fragment runs; the caller waits for it. **Stop** sets the shut-down stage
  and empties the aliases; completing a quest does not stop it.
- **Alias fills** (Quest Alias Tab): a specific reference or location, a unique actor, another
  quest's alias, a created reference, a location alias's reference of a type, a reference's
  location (the parent with a keyword), a matching reference (persistent references and unique
  actors, or those in the loaded area, the closest or one at random, or those linked to another
  alias's reference) or location (uncleared first), the story manager event's data. A searched
  alias does not take a reference reserved by another quest (unless it allows reserved ones,
  takes another quest's alias, or its quest starts with a new game), one already in this quest
  (unless that alias allows reuse), a dead, disabled or destroyed one (unless allowed), a
  cleared location (unless allowed). Conditions run on the candidate, but for unique actors,
  location alias references and created references on the player. Specific references are not
  held to the dead and disabled checks: 86 aliases of quests that start with the game name
  disabled references without "allow disabled" (Riften's Imperial gate guards), and those
  quests run in the game. A filled alias fills the alias it is forced into, reserves what fills
  it if it reserves, disables it if "initially disabled", and gives it its inventory. While it
  holds an actor, the actor is a member of the alias's factions (ALFC, rank 0 unless it has a
  rank of its own): the town dialogue quests make their merchants members of
  JobMerchantFaction so (in their records they are listed at −1, not members), which their
  "What have you got for sale?" asks for; the follower alias does the same with
  CurrentFollowerFaction.
- **Searches take frames:** a matching-reference or matching-location search checks its
  candidates 64 at a time and, after 4 ms of work, lets the browser draw a frame before it goes
  on (`PapyrusScheduler.giveWay`, the browser's next task); a quest therefore starts over a few
  frames, as the engine's quests start off its main loop (Papyrus waits on Start). In the
  opening's cart the scenes' quests searched the loaded area's ~2,000 references with
  GetInCurrentLocation and GetInFaction conditions: 200,000 conditions in one go held the page
  for up to 8 s. TODO(M13): the engine's own share of a frame for quest start-up. Who an alias
  holds is kept per reference (`aliasesHolding`; the player is in hundreds of aliases), and the
  alias factions read from it once per change (`ActorEngine`).

## The world

The shell (`src/shell/script-world.ts`) is the runtime's WorldBridge for the cells and
worldspaces on screen:

- **Cells**: as a cell's references load, those with scripts get OnInit the first time (a
  non-persistent reference's scripts start with its cell), then OnCellAttach, OnLoad and
  OnCellLoad; leaving, OnUnload and OnCellDetach.
- **Enable state**: what scripts enable and disable shows and hides at once, collision
  included, without loading the cell again; enable parents follow.
- **Activation**: the player's Activate goes to the reference's OnActivate first; what
  activating does by default (doors, containers, items) follows unless a script blocks it.
  A script's Activate does the same, so an object a script moves first is not left waiting
  for the player.
- **Triggers**: trigger volumes (activators' primitives and trigger-layer collision) tell
  their scripts when the player enters and leaves (OnTriggerEnter, OnTriggerLeave,
  GetTriggerObjectCount).
- **Created references** (PlaceAtMe, an alias's Create Reference) are drawn, collide and
  light like placed ones, and go and come back with their cell.
- **Moves**: MoveTo, SetPosition, SetAngle, MoveToNode move what is shown; keyframed
  (SetMotionType) bodies follow. The runtime knows where the player is and the cell they
  walked into. The sandbox is not the game: scripts do not move its player (Play does,
  through a journey as a load door: WorldViewer.followsScripts).
- **Animation**: PlayAnimation and the animation variables reach a reference's behavior
  graph (an object's sequences and skeleton, an actor's), and the events the graph raises
  reach OnAnimationEvent: an object's, an actor's on the stage and the player's body
  (AnimatedSkeleton.onScriptEvents; MQ101's cart riders wait for ExitCartEnd, the headsman's
  Decapitate, the player's PlayImod).
- **Music, sounds, packages**: MusicType.Add / Remove, the globals ambient sounds read, quest
  state and alias packages for the actors' packages come from the runtime.
- What only the game's menus show (notifications, message boxes, help messages) goes to the
  HUD and menus in Play, and to the terminal in the sandbox.

**The sandbox's quests** (`src/shell/quest-panel.ts`): every quest of the running game, one
at a time, as the console shows and drives them: running or not, its stage and the stages
done, the objectives shown with their targets, who fills each alias; start and stop
(StartQuest, StopQuest), set any stage (SetStage), and go to a target or an alias's
reference (MoveTo). "Reset states" in the dev panel throws the running game away and starts
from a new game's state again (the scene on screen loads again). What came of each action is shown in words: a quest that does not start
says why (it runs once and ran, it starts only from its story manager event, or which alias
found nobody to fill it).

## Events

The game's event hub (`event-hub.ts`, `runtime.events`) is the one place a happening is told,
as the original's event sources tell it to the scripts, the story manager, the statistics and
the interface together. A producer emits a kind once, where the engine raises it; relays listen:
the scripts' On\* events, and the story manager's (`story-events.ts`, below).

### Locations

A cell's location, as the engine finds it (observed in the original): the location of its
encounter zone (the cell's own; an exterior cell without one takes its worldspace's), else the
cell's own (XLCN), else for an exterior cell its worldspace's (the worldspace's XLCN, else its
zone's). The plugins rely on the fallbacks: 113 of Whiterun's city cells and 146 of Markarth's
have no location of their own and are in the city's, all of Solstheim's cells are in
DLC2SolstheimLocation through their worldspace, Sovngarde's and the Soul Cairn's likewise. A
reference's location is that of the cell it stands in (in a worldspace, the exterior cell at its
place). GetInCurrentLocation, the aliases and the events all read it so.

### Actor location change

`actor-locations.ts` emits `actorLocationChange` (actor, old location, new; none is the
wilderness). Observed in the original:

- The engine looks at an actor's location whenever the actor is put into another cell, for
  every actor: the player as the world takes them into a cell (a door, a cell border, a
  teleport), an NPC as it walks across an exterior cell's border, is moved by a script or is
  moved by its packages while away from the player. The event goes out when the location differs
  from the one before.
- The engine keeps the player's current location (ours: `GameState.playerLocation`, none at a new
  game, so the first cell with a location the player is put in tells it: a `coc Riverwood` from the
  main menu goes from none to RiverwoodLocation). An NPC's is where it stands.
- Ours: the view tells the player's cell every frame (`GameSession`), the stage each staged
  actor's (the loaded cell it stands in, `ActorStage`); `ScriptRuntime.move` and
  `moveToEditorLocation` tell a moved NPC's, from its placement before the move (or the plugin's,
  for one not seen before). A cell told again is not read again; a new one's location is read
  and compared.
- Heard by: the story manager's Change Location (the player's only, below), the actor's
  OnLocationChange (the scripts' relay), the HUD's location name (the player's).

### The scripts' events

**The relay to the scripts** (`script-events.ts`), observed in the original (one event
sink per source): an event about a reference goes to the reference's scripts, then to the
aliases holding it and, for an actor, to the scripts of the magic effects on it
(`ScriptRuntime.sendEvent`). The player's own events go to the player; sleep and tracked
stats go to every object registered for them. What each kind becomes:

| Kind                                   | Script event, to whom (arguments)                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| activate                               | OnActivate to the reference (who activated it)                                                                                                                  |
| actorLocationChange                    | OnLocationChange to the actor (old, new)                                                                                                                        |
| bookRead                               | OnRead to the book's reference, when it was one                                                                                                                 |
| cellAttachDetach, cellFullyLoaded      | OnCellAttach / OnCellDetach; OnCellLoad to each reference whose 3D is in                                                                                        |
| combat                                 | OnCombatStateChanged to the actor (its target if that is an actor, the state: 0 none, 1 combat, 2 searching)                                                    |
| containerChanged                       | OnContainerChanged to the item's reference (new, old), OnItemRemoved to the old container, OnItemAdded to the new (item, count, reference, the other container) |
| death                                  | OnDying (dying), OnDeath (dead) to the actor (killer)                                                                                                           |
| destructionStageChanged                | OnDestructionStageChanged (old stage, new stage)                                                                                                                |
| enterBleedout                          | OnEnterBleedout to the actor                                                                                                                                    |
| equip                                  | OnObjectEquipped / OnObjectUnequipped to the actor (base, reference), then OnEquipped / OnUnequipped to an item with scripts (the actor)                        |
| fastTravelEnd, playerBowShot, loadGame | OnPlayerFastTravelEnd (game hours), OnPlayerBowShot (bow, arrow, draw, sun gazing), OnPlayerLoadGame: to the player                                             |
| grabRelease                            | OnGrab / OnRelease to the object                                                                                                                                |
| hit                                    | OnHit to the target, actor or object (aggressor, source, projectile, power, sneak, bash, blocked)                                                               |
| lockChanged                            | OnLockStateChanged                                                                                                                                              |
| magicEffectApply, magicWardHit         | OnMagicEffectApply (caster, effect); OnWardHit (caster, spell, status: 0 friendly, 1 absorbed, 2 broken)                                                        |
| moveAttachDetach                       | OnAttachedToCell / OnDetachedFromCell                                                                                                                           |
| objectLoaded                           | OnLoad / OnUnload                                                                                                                                               |
| objectTranslation                      | result 0 OnTranslationFailed, 1 OnTranslationComplete, 2 OnTranslationAlmostComplete                                                                            |
| openClose                              | OnOpen / OnClose (who opened or closed it)                                                                                                                      |
| package                                | OnPackageStart (new), OnPackageChange (old), OnPackageEnd (old)                                                                                                 |
| reset                                  | OnReset, not for a deleted reference                                                                                                                            |
| sell                                   | OnSell to the item sold, when it is a reference of its own (the seller)                                                                                         |
| sleep, trackedStats                    | OnSleepStart (start, desired end) / OnSleepStop (interrupted); OnTrackedStatsEvent (stat, value): to those registered                                           |
| spellCast                              | OnSpellCast to the caster (the spell)                                                                                                                           |
| switchRaceComplete                     | OnRaceSwitchComplete                                                                                                                                            |
| trapHit                                | to the trap, only for a living actor hit: OnTrapHitStart, OnTrapHit (target, velocity, position, material, first hit, motion type), OnTrapHitStop (target)      |
| trigger, triggerEnterLeave             | OnTrigger, OnTriggerEnter / OnTriggerLeave to the trigger (who is inside)                                                                                       |

**The producers**, each where the engine raises its event (observed in the original):

- **Combat** (`src/shell/actor-combat-ai.ts`): an actor's combat state is told each time it
  changes (into combat, its group searching and back, out of it), with its target; out of
  combat with the target it last fought. Only NPCs have a combat controller and are told.
- **Bleedout** (`actor-combat.ts` bleedout): told as an actor's life state turns to bleeding
  out, the player's too.
- **Open and close** (`src/shell/open-close.ts`): the engine tells them when the object's
  animation raises Open or Close, at the end of its swing, with the one who activated it. Ours:
  at the end of the open or close sequence, for the player's doors and containers (the lid
  while the container menu is open), for actors' doors (`actor-doors.ts`) and for a script's
  SetOpen (no one). Objects without an open sequence, and load doors, tell nothing. A swing
  turned back before its end tells only the last one.
- **Triggers** (`trigger-volumes.ts`, `ScriptRuntime.triggered`): entering and leaving are
  told at once; while something stays inside, the volume tells everyone in it as it finds
  them, then again once [Havok] fTriggerEventDelayMS (500 ms) has passed since it last told.
- **Spell casts** (`casting-engine.ts`): told as the cast takes effect with its cost: a fire
  and forget spell, staff, scroll or power as it fires, a concentration spell as it begins to
  cast, a shout as it is let out (the word's spell). A script's Spell.Cast is not told.
- **Grab** (`play-session.ts`): the Z key's hold and Telekinesis tell the object taken and let
  go.
- **Moves across the attached area** (`ScriptRuntime.move`): the engine tells a reference
  whose parent cell changes between an attached cell and a detached one. Ours: a move to
  another cell (MoveTo, an actor walking away or back) between the attached area (the
  player's interior cell, or the uGridsToLoad cells round the player's outside, where the
  player is going if a script just moved them) and the rest. The player is always attached.
  A cell attaching or detaching with its references is OnCellAttach / OnCellDetach instead.
- **Translations** (`ScriptRuntime.translate`): failed at once for a reference without its 3D,
  almost complete as it passes fRefTranslationAlmostDonePercent (0.9) of its way, complete at
  the end.
- **The player's bow shot** (`actor-combat.ts`): a bow's (not a crossbow's) arrow leaving,
  with its draw and whether the player looks into the sun as the sky draws it (TODO(M13): the
  engine's own sun test).
- **Wards** (`casting-engine.ts`): a hostile spell absorbed (1) or breaking the ward (2); a
  spell that is not hostile meeting a ward from the front (0, inferred).
- **Fast travel** (`play-mode.ts`): its end, with the game hours the way took.
- **Sales** (`barter-menu.ts`): each item the player sells, with its reference if it has one.
- **Tracked stats** (`ScriptRuntime.incrementStat`): the engine's own stat counts tell their
  new value; a script's Game.IncrementStat does not.
- **Hits on objects**: a weapon's blow on an object, an arrow, a spell reaching an object (any
  spell; an actor hears only hostile ones that took hold), destructible objects in an
  explosion's radius. TODO(M13): other objects in an explosion's radius.
- The happenings that were sent straight to the scripts before go through the hub now:
  activation, containers, deaths, destruction stages, equipment, magic effects, packages,
  books read, locks (a script's Lock too), race switches, sleep and waits, cells loading. The
  actors' location changes are the story events' (above); the relay is their one sender of
  OnLocationChange.
- Not produced yet: trap hits (traps do not hit yet; the relay is ready), resets (cell reset,
  M12 with respawn), loading a game (M12).

`tools/script-events.ts` lists each event's declarations in the base scripts and the scripts
of the load order that handle it. `PapyrusVm.handled` (debugging) hears every handler that
runs.

## Story manager

`story-manager.ts`, after the Creation Kit's "Story Manager" and "SM Event Node" pages: an
event goes to its event node; a node is processed only if its conditions hold (they run on the
player, GetEventData on the event's data), its children top to bottom (stacked) or at random. A
quest node starts one of its quests (or up to "num quests to run"), in order or at random,
skipping running ones and those within their "hours until reset", with "do all before
repeating" those it started before the others, and not more than "max concurrent quests" of
the node running. A quest starts if it has no other event type, its own story manager
conditions hold and its aliases fill (from the event's data too). Once a quest node starts a
quest the event is consumed, unless the node shares the event; a node that starts nothing
passes the event on. The started quest gets its OnStory event (OnStoryScript for
Keyword.SendStoryEvent: keyword, location, two references, two values) and keeps the event's
data for its conditions. `StoryManager.quests` names the quests an event started. The Actor
Dialogue event (ADIA: the asking actor's location, it and the one it asks) is raised by actors
asking for a scene with each other and by DialogueActivate (src/shell/actor-talk.ts;
[ai.md](ai.md#conversations-between-actors)).

**The queue.** The engine adds every event to a queue; its story teller works through the queue
in order, one event at a time, within a time budget a frame (fStoryTellerQuestFindTime), an
event whose quests take long to start going on the next frame before the next event is looked at.
Ours: `StoryManager.event` queues behind the events raised before it, so the next sees the quests
the one before started (two Change Locations in a row do not both start the same quest).
Keyword.SendStoryEventAndWait waits for its event's turn and processing.

### Story events

What tells the story manager (`story-events.ts`): Change Location from the hub, the others at
their places. Observed in the original: where each is raised, for whom, with which members
(each event type registers its members: R references, L locations, F forms, V numbers):

| Event | Raised (the engine)                                                                                                                                                                                                                             | Members                                                                      | Ours                                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLOC  | The player is put in a cell of another location (the player only; NPCs' location changes are no story event).                                                                                                                                   | R1 actor, L1 old location, L2 new                                            | `actorLocationChange` of the player                                                                                                                    |
| AIPL  | The player picks an item up (owned: a theft, type 1, its owner; else type 4), takes one from a container (5), a pocket (3) or a corpse (6), buys one (2).                                                                                       | R1 owner, R2 container, L1 the player's location, F1 item, V1 how            | play-mode take, the AI-driven player's take, the container menu, the barter menu                                                                       |
| REMP  | The player drops an item (type 4); no other removal raises it in the code read.                                                                                                                                                                 | R1 owner (the player), R2 the item's reference, L1 location, F1 item, V1 how | the inventory's drop                                                                                                                                   |
| CAST  | Any actor's cast begins, unless it is in combat; a shout's word is cast as its spell.                                                                                                                                                           | R1 caster, R2 target, L1 caster's location, F1 spell                         | `CastingEngine.begin`, `releaseShout` (target: TODO(M13))                                                                                              |
| DEAD  | An NPC not in combat reacts to a dead actor it detects, within fDeadReactionDistance (400), once per body, as it starts its walk to the body.                                                                                                   | R1 actor, R2 dead actor, L1 the actor's location                             | the senses' reaction to a seen body (from sight: TODO(M13) the 400)                                                                                    |
| ARRT  | The arresting guard reaches the criminal (within 500 units) and starts the arrest.                                                                                                                                                              | R1 guard, R2 criminal, L1 criminal's location, V1 crime type                 | the guard's arrest as it opens the conversation; the type of the player's latest crime against its crime faction (0 for a bounty alone, as the engine) |
| AHEL  | Every 1 to 1.5 s (INI fUpdateDelaySeconds) an NPC chooses whom it looks at (the player first, else the best actor within fAIMaxHeadTrackDistance and 120° of its facing); turning to another actor than before, neither in a scene, is a hello. | L1 the actor's location, R1 actor, R2 the other                              | `ActorLooks`: the NPC now looks at the actor it chose (`chooseLookActor`: the nearest; TODO(M13) the engine's score and two more conditions)           |
| NVPE  | Game.TeachWord: each shout with the word whose first word the player now knows is added to the player; a new one is the event. Also any actor's AddSpell of a Voice Power spell. Papyrus AddShout does not raise it.                            | R1 actor, F1 shout or spell                                                  | `CastingEngine.teachWord` (which now adds the shout, as the engine), `ActorEngine.addSpell`                                                            |

Kill Actor, Assault, Trespass, Crime Gold, Pick Lock, Craft Item, Skill and Level Increase are
raised by the crime, crafting and progression engines where the engine raises them (Kill Actor
as the actor is killed, with the crime it made: not from the death event, whose data has no
crime). Actor Dialogue (ADIA) is the actors' conversations' own.

Measured on the game data (a new game, a morning; `tests/story-events.int.test.ts`): walking
into Riverwood starts DialogueRiverwoodIntroScene, DialogueRiverwoodKidsScene,
FreeformRiverwood01, DLC1ScrollHandlingChangeLoc and CRHoldExpansion (MS13LucanCamillaScene runs
from the game's start); the Sleeping Giant Inn WIGreeting; Whiterun from Riverwood Favor013 and
Favor017 (Favor253, 110 and 204 find no one for an alias) and DialogueWhiterunHeimskrPreachScene;
the Bannered Mare BardSongStarter (the bard's song; it stops at once), WIGreeting and
DialogueWhiterunArgueScene.

## Actors

`actor-engine.ts`: a reference's base resolved as for its look (leveled lists picked once,
templates per part), its level (fixed, or the player's times its multiplier within its calc
min and max), its actor values (the record's base: skills and offsets from DNAM, health,
magicka and stamina as the Creation Kit calculated them, AI values from AIDT, carry weight,
mass and regeneration from its race; then scripts' permanent modifiers and damage), factions
(GetFactionRank: −2 not a member, −1 listed but not yet one; an alias's factions while it
holds the actor), relationships (RELA, read in one pass, and those scripts set), spells and perks (its own, its race's, scripts'), being essential or protected
(its base, scripts' ActorBase changes, or an alias), dead (killed, or placed dead) and dying
(OnDying, then OnDeath). Auto-calculated stats follow the level (docs/gameplay.md). Bleedout
(essential and protected actors, its recovery), combat, detection and the AI's state are the
stage's ([ai.md](ai.md#combat), [Combat AI](ai.md#combat-ai), [Detection](ai.md#detection);
the natives and conditions read them through the WorldBridge: `combat`, `detects`, ...); the
magic system's effects change the actor values ([gameplay.md](gameplay.md#magic-effects)).

The player's race, sex and name are the race menu's choices (`GameState.playerAppearance`,
`playerName`): ActorBase.GetRace and GetSex of the Player base (0x7), Actor.GetRace and the
conditions GetIsRace, GetIsSex, GetPCIsRace and GetPCIsSex read them, and `<Alias=...>` text
filled by the player shows the chosen name. Actor.SetRace sets the actor's own race (its base
keeps its own: MQ101's AddRaceSpells reads the base's) and the world makes the actor again in
it (`WorldBridge.raceChanged`): the player's body keeps the chosen face (a werewolf and back),
an NPC of a loaded cell is placed again where it stands. The race menu gives up the actor's own
race for the race chosen. TODO(M12): both in the save.
