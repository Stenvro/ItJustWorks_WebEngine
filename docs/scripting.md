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
  bases, factions, locations, cells, inventories, created references, leveled list additions,
  active magic effects.
- **Natives** (`natives/`): all 686 the game's scripts declare, by script. What they change is
  game state; what the engine shows goes through the **WorldBridge** (`runtime.ts`): enable
  state, moves, animation events, sounds, weather, menus, combat, packages. Without a world (in
  Node) the bridge does nothing and the state alone answers.
- Work that goes on by itself (events, waits, story events) is detached: a fault in it is
  reported, never left to stop the app.

## A new game

As the game starts one (`ScriptRuntime.newGame`): the clock at the plugins' date and hour
(GameDaysPassed and GameHour), every quest's and alias's scripts started (OnInit) and every
persistent reference's with scripts, then the quests that start with the game, by priority
(TODO(M13): the engine's order), their aliases allowed to take reserved references (Creation
Kit). A start resets a quest that does not run once, so its OnInit runs again. Then the
opening: no record or script starts **Unbound** (MQ101); the game does as a new game begins
(UESP). On the vanilla data with the DLCs and Creation Club items all 443 start (the update
and DLC set-up quests stop themselves at once) and MQ101 runs; no native is missing.

## Quests

`quests.ts` and `alias-fill.ts`, after the Creation Kit's Quest pages:

- **Start** fills the aliases in order; one that must be filled and stays empty keeps the
  quest from starting. A quest with an event type starts only from that story manager event.
  The start-up stage is set as it starts; its fragment runs on a thread of its own.
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
  it if it reserves, disables it if "initially disabled", and gives it its inventory.

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
  reach OnAnimationEvent.
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
data for its conditions.

## Actors

`actor-engine.ts`: a reference's base resolved as for its look (leveled lists picked once,
templates per part), its level (fixed, or the player's times its multiplier within its calc
min and max), its actor values (the record's base: skills and offsets from DNAM, health,
magicka and stamina as the Creation Kit calculated them, AI values from AIDT, carry weight,
mass and regeneration from its race; then scripts' permanent modifiers and damage), factions
(GetFactionRank: −2 not a member, −1 listed but not yet one), relationships (RELA, and those
scripts set), spells and perks (its own, its race's, scripts'), being essential or protected
(its base, scripts' ActorBase changes, or an alias), dead (killed, or placed dead) and dying
(OnDying, then OnDeath). Auto-calculated stats follow the level (docs/gameplay.md). TODO(M11): bleedout,
the magic system's effects; TODO(M10): combat (detection: [ai.md](ai.md#detection)).

The player's race, sex and name are the race menu's choices (`GameState.playerAppearance`,
`playerName`): ActorBase.GetRace and GetSex of the Player base (0x7), Actor.GetRace and the
conditions GetIsRace, GetIsSex, GetPCIsRace and GetPCIsSex read them, and `<Alias=...>` text
filled by the player shows the chosen name. Actor.SetRace sets the actor's own race (its base
keeps its own: MQ101's AddRaceSpells reads the base's) and the world makes the actor again in
it (`WorldBridge.raceChanged`): the player's body keeps the chosen face (a werewolf and back),
an NPC of a loaded cell is placed again where it stands. The race menu gives up the actor's own
race for the race chosen. TODO(M12): both in the save.
