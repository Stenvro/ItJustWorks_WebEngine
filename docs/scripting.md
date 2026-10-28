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
- **One thread runs at a time** (the VM's run token, `#runner`), as the game's VM runs one
  stack at a time: a thread keeps running until it waits (a latent call, a lock another thread
  holds, another script's OnInit, the frame's budget) or ends, and the threads waiting to run
  take turns in the order they came (inferred from the wiki's threading notes, which name
  these as the points where another thread gets in; TODO(M13): the VM's own scheduling of its
  stacks was not read from the engine). The awaits JavaScript needs inside a step (a property of
  another object, an engine native that reads records) are no switch points: the game's
  natives return at once. An engine native that is still not done after 1000 microtask turns (it
  reads files, or waits for another thread, which no native of the game does) lets the next
  thread run meanwhile, so nothing deadlocks (counted in turns: the same in every run).
  Without the token every await was a switch point and two
  threads ran a check and its set side by side: CompanionsHousekeepingScript.SetUpCompanions
  cycles the radiant quests twice, so each questgiver gets a current and a next quest; each
  quest registers itself twice at once (its OnStoryScript and its start-up stage's Setup), both
  found it unregistered, the second registration made it its questgiver's next quest too, and
  the next quest to register stopped the one before (CR06) and then itself (CR07, whose
  start-up then set a stage of a stopped quest: "attempting to start event scoped quest outside
  of story manager").
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
- **The frame's budget** (`scheduler.ts`; observed in the original): each frame the
  game's main loop runs the VM's update for 0.9 of [Papyrus] **fUpdateBudgetMS** and then the
  scripts' tasklets for **fExtraTaskletBudgetMS** more (1.2 ms each by default, so threads get
  2.28 ms a frame); a thread past it goes on in the next frame, keeping its lock. Once a saved
  game has loaded, the VM runs on its own, update after update, for
  **fPostLoadUpdateTimeMS** (Skyrim_Default.ini: 500 ms) before the game goes on: no budget,
  and its frame waits go on at once. The engine also runs two queues of latent calls' work
  (render-safe and post-render) for 0.05 of fUpdateBudgetMS each; ours runs latent natives
  through their own systems (TODO(M13): those queues' timing). Without frames (Node tools)
  threads run straight through, and one that runs two million instructions without ever
  waiting is stopped as an endless loop; the headless sim runs so, deterministically.
- **Natives wait for the frame** (`native-timing.ts`; observed in the original): the game
  registers each native with two marks, latent and callable from the script's thread. Only the
  68 of its 669 natives that are callable there and not latent run at once (the Math functions,
  Debug's traces, GlobalVariable Get / SetValue, Game.GetForm and GetFormFromFile, the aliases'
  fills and registrations, the inventory event filters, Enable / DisableNoWait, the profiling
  switches); every other call is handed to the main thread, and its thread waits for the next
  frame (keeping its own object's lock), so a loop of object natives runs a frame a call. The
  handed calls begin in that frame's VM update in the order they came. TODO(M13): the engine begins them only while the update's share (0.9 of fUpdateBudgetMS) lasts; our natives cost far more time than its own, so a share of wall time would starve the scripts and make the headless sim depend on the machine: all begin in the next frame. Latent natives (Wait, AddItem,
  Disable, Cast, ...) then wait for what they started. Without frames (Node tools) nothing
  waits. MQ101's dunCGDragonVoiceStormCall
  (magicProjectileStormScript: an OnUpdate with some ten such natives, then fRecast) sent a
  meteor every 0.12 s while every native returned at once, about two and a half times the
  game's rate.
- A script error (a runaway thread, too deep a call stack) stops its thread and is reported,
  never thrown at the engine, as the game logs it.

TODO(M12): save the threads, variables and registrations.

## Properties

How a script instance gets the plugin's values (VMAD), observed in the original: each
value is bound by the property's name, looked up in the script and its parents. An auto
property's variable takes the value; a full property's Set function runs with it, on the
instance's first thread, before its OnInit, in the plugin's order (`Instance.bound`; vanilla
gives values to full properties: TrapTriggerBase's TriggerType and TriggerCount on every trap,
NorPortcullisSCRIPT's isAlreadyOpen, whose Set sets the variable the script reads). A value
for a name the script has no property for is not bound, and the game logs it ("Property X on
script Y attached to Z cannot be initialized because the script no longer contains that
property"): the plugin's fault, kept as the game's (below). TODO(M13): what the engine does
with a value for a full property without a Set function (none in the vanilla data's runs).

## The log

Problems are logged as the game's Papyrus log has them, with where they happened: the calling
functions, innermost first, each with its object (`Script.Function [object] < ...`, at most
three; `NativeCall.where` gives a native the same). Two kinds of lines:

- **Ours** (warnings): something this engine did not do as the original, or a fault that
  follows from one (a None our natives gave back, a condition function not valued, an
  unknown run-on). Vanilla play logs none; the QA harness counts them (docs/qa.md, with the
  boot's: a new game's or a coc's quest starts).
- **The game's own** (`game data:` lines, `PapyrusVm.gameLog`, not warnings): the plugins' and
  scripts' own faults, which the original logs the same way and which stay in the data:
  - a plugin's value for a property its script no longer has (35 in vanilla with the DLCs:
    DLC1SeranaLevelingScript's 14 perks, DLC2HirelingQuestScript's 8, the Toldar's Tomb plates'
    PlatePosition, ...);
  - a call on None through an auto property that neither the plugin nor the script ever set
    (DLC1VampireCastleControllerScript.SetGateClosed calls pMainGate, which the plugin leaves
    empty: it fills pDLC1VCMainGateRef);
  - a call on the None a failed cast gave, the object not having the script by the plugins'
    attachments (its own, its base's or template's, as the engine reads them): a Fort Neugrad
    bandit runs PF_CarryFirewood, whose fragment casts it to CarryActorScript, which bandits
    do not have;
  - a call on a None the engine gave (an event's argument, passed on or assigned without a
    check): dragonActorSCRIPT.OnLocationChange hands the new location to
    WIFunctionsScript.RegisterDragonAttack, which calls HasKeyword on it, and a dragon flying
    into the wilderness has none (`Frame.engineNones` follows such a None from the event's
    parameters through calls and assignments);
  - the engine calling a fragment by the plugin's name for it that the compiled script does
    not have ("Method Fragment_0 not found on TIF__000D0835. Aborting call and returning
    None": the bard's lute topic, MQ101's PF_MQ101HadvarUseIdleMarker5);
  - Enable or Disable of a reference with an enable parent (The world, below).

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
  each; the integration test holds each to a milestone): 21, 3 of them called by the vanilla
  scripts (arrows stuck in bodies, ragdolls a script adds, the seated player's camera turn),
  the rest never (the movement controller's overrides, synced animations, the terrain's
  effects at a node, the camera's target, actors under player controls; all M13).
  RequestSave / RequestAutoSave queue a save (a new one, the next autosave) that Play makes
  once the game may save (`src/shell/save-manager.ts` requested); ShakeController rumbles
  the gamepad (the Gamepad API's dual-rumble, [Controls] bGamePadRumble); ClearTempEffects
  clears the hits' decals (TODO(M13): the other temporary effects); the sun gaze
  (`src/gameplay/sun-gaze.ts`, observed in the original: the camera within
  fPlayerSunGazeDelta of a fully shown sun for fPlayerSunGazeStartTimer applies the modifier
  SetSunGazeImageSpaceModifier set, once a gaze) answers IsPlayerSunGazing. Natives that rightly do
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

**Subject, target and the other** (observed in the original). Conditions are asked of a
subject and its target (an idle's actor and the action's target, a speaker and the one spoken
to, an effect's target and its caster). Each condition runs on one reference, by its run-on,
and has an other: run on the subject, the other is the target; on the target, the subject; on
a reference, the target; on the subject's combat target, the subject; on a linked reference, a
quest alias, package data or event data, none. Swap Subject and Target exchanges the two when
both are there. A reference parameter left empty (no form, neither Use aliases nor Use packdata)
is the other: the killmove idles' ShouldAttackKill(), GetRelativeAngle(, Z) and
GetTargetHeight(), dialogue's IsHostileToActor() ask about the target that way. A condition
whose run-on has nothing to run on fails, whatever its comparison (a target run-on asked without
a target: an idle tree asked of no target, RipHeartOut's GetIsID(DLC2Ildari) on it); only a
function no evaluator values holds. A quest alias run-on reads the quest the conditions belong
to, which every caller gives: a dialogue's quest, a scene's, a package's owner quest (PACK
QNAM), an objective target's quest (the compass). Without one the condition is reported ("not valued here") and holds.

**Subjects of every kind** (observed in the original). The engine's condition functions
all take a reference and answer 0 when what they are asked of is not of their kind: an actor's
function of an object (GetRelationshipRank of a chest), a reference parameter left empty with
no other to stand in, a reference's function with nothing to run on. The comparison then goes
on with 0 (`== 0` holds), with no warning: the game logs nothing there either. Conditions run
on a location (a location alias's candidates, a location alias run-on, an event's L1 or L2) run
on a stand-in reference that has the location both as where it is and where it was placed (the
engine's current-location and editor-location lookups fall back to the same extra data on a
reference without a cell): LocationHasKeyword, LocationHasRefType, GetInCurrentLoc and
GetKeywordDataForCurrentLocation read the location, GetIsEditorLocation(Alias) and
HasSameEditorLocAsRef(Alias) the location as its editor location (FreeformShipsDawnstar's Cave
is a cave in the Pale or Hjaalmarch by GetIsEditorLocation(PaleHoldLocation) or
GetIsEditorLocation(HjaalmarchHoldLocation)), and the actor's and object's
functions are 0. Run on a reference, LocationHasRefType asks about the location the reference
is in (CR01's beast victim). Of the location's references of the type it counts those not
deleted, not disabled and, for an actor, alive. An actor's keywords are its base's, then its race's
(HasKeyword(ActorTypeNPC): a race's keyword). GetRelativeAngle(reference, axis) is the subject's
rotation on the axis less the reference's, 0..360 degrees (not where the reference stands:
GetHeadingAngle says that); GetTargetHeight(reference) how far above the subject's feet the
reference's are.

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
Kit). A start resets a quest that does not run once, so its OnInit runs again. Their start-up
stages' fragments run once all of them have started (`QuestEngine.holdStartUps`): the engine
starts them in one pass of its main loop and the Papyrus VM runs the fragment calls queued
meanwhile after it (inferred from the engine's queued fragment calls), so a fragment finds
every other such quest's aliases filled: BYOHHouseBuilding's start-up asks the jarls of the
town dialogue quests (DialogueFalkreath's Siddgeir) for their relationship with the player,
and found their aliases empty when it ran as its own quest started. Then the
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
  Observed in the original: Papyrus's Start on such a quest, and SetStage on one that does
  not run, do nothing and return false, and the game logs "attempting to start event scoped
  quest outside of story manager" as an error of the calling script (SetStage on one the story
  manager started and that runs works as on any other).
  The start-up stage is set as it starts; its fragment runs on a thread of its own. Its scenes
  that begin on quest start start, and they end as it stops ([ai.md](ai.md#scenes)).
- **SetStage** starts the quest if needed; without "allow repeated stages" a stage is set once;
  every log entry whose conditions hold happens, in order (completes or fails the quest, adds
  its journal text, runs its fragment); the caller waits for them. Observed in the original:
  setting a stage walks all of the stage's items and runs each whose conditions hold (not only
  the first). MQ101's keep stages rely on it: an entry without conditions for both routes and
  one per FactionPath (1 Hadvar, 2 Ralof) that starts the route's scene and enables its actors. **Stop** sets the shut-down stage
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
  included, without loading the cell again; enable parents follow. Observed in the
  original: a reference with an enable parent (its XESP naming a reference that exists) only
  follows its parent; Papyrus's Enable and Disable leave it as it is and the game logs "cannot
  enable (disable) an object with an enable state parent" as an error of the calling script,
  logged here as the game's own, with the stack. The engine's own disabling (an alias's
  "initially disabled") leaves it without a line.
- **Activation** is one path for every activator (`ScriptRuntime.activateRef`, the engine's
  TESObjectREFR::ActivateRef): the player's crosshair on an object or an actor (talk, search,
  pickpocket, ride: `talkTargets` wraps them all), an actor's AI (furniture it uses, a door it
  opens on its way: `actor-doors.ts`), a script's Activate and an activate parent. It tells
  TESActivateEvent (OnActivate, blocked or not; not for Activate's abDefaultProcessingOnly,
  which also ignores the block), then, unless a script blocks the activation, does the default
  processing: what activating it does (doors, containers, items), then its activate children.
  A blocked reference passes nothing on (inferred from the scripts: TrapTriggerBase unblocks
  itself, activates itself and blocks again to set off its children), and a door whose
  activation a script blocks is shut to actors. Before, the player's activation never reached
  the children and actors opened doors without OnActivate. The OnActivate it sends is queued,
  not waited for (Papyrus events run on
  threads of their own): a trigger's OnTriggerEnter that activates itself (defaultActivateSelf)
  waited for its own OnActivate, which waited for that OnTriggerEnter to end, and nothing it
  should set off ever was. **Activate children**: a reference activated activates in turn,
  each after its delay, the references whose Activate Parents (XAPR) name it, with itself as
  their activator (inferred from the data and the scripts: masterAmbushScript's OnActivate
  takes an activator that is not the player as its trigger with ambushOnTrigger); a door swung
  so tells its parent as the one who opened it (OnOpen). **Parent Activate Only** (XAPD, 1,037
  vanilla children): only its parents activate such a child; the crosshair offers it nothing and
  it is shut to actors walking by (Blind Cliff Cave's lever gate stayed open to every bandit
  before). TODO(M13): whether the engine refuses a script's Activate on one too. The load
  order has 6,527 such pairs (5,691 children of 2,782 parents: 1,625 ambushes, 2,000-odd traps,
  default2StateActivator's doors and gates; `node tools/activate-children-audit.ts`); the
  runtime finds a parent's children in its own cell, its worldspace's persistent cell and the
  exterior cells round its place (6,369 of the 6,527; the other 158 lie farther off).
  Bleak Falls Barrow's frostbite spider drops from its ceiling hole so as the player walks into
  the trigger by Arvel the Swift. **Another activator's default** (an actor a script's
  Activate names, an activate parent) is only what activating does to the object itself (a
  door swings); the player's menus, seat, inventory and load screen are the player's alone
  (`objectActivation`). Before, any activator's default was the player's: MQ101's stage 275
  has its Imperial activate the keep's outer lever (KeepLever1.Activate(soldier)), which walked
  the player off to sit in it, through the shut inner gate and into MQ101SetStage270RalofMarker,
  so the scene skipped its gate phases. **An actor activator's defaults** (an actor other than
  the player: a script's Activate naming it, a package's Activate procedure;
  `src/scripting/runtime/actor-activation.ts`), observed in the original, each base type's
  own activation: an item (and a book that can be taken) is picked up into the actor's
  inventory; flora is harvested into it (as the player's harvest, without message or sound;
  TREE inferred to do as FLOR); furniture does nothing (only the player's activation seats:
  KeepLever1.Activate(soldier) is its OnActivate alone, the lever pulled by the Imperial's own
  package); a container does nothing of its own (the engine moves an item into the actor only
  when the activation names one, which a script's Activate never does). A door checks its lock
  against an actor activator only: it opens for one that may unlock it (its key, an owner:
  `mayUnlock`), else for one carrying a lockpick below a key-only lock (picked: crime-engine's
  lockPicked), and stays shut to any other; an activate parent swings a locked door. A load door
  then takes the actor to its other side (the XTEL marker, in the cell of the door it leads to;
  the door's open sound plays). TODO(M13): the engine refuses a load door to an actor in some
  states (in furniture; a further check not read) and hands a near actor's passage to its AI
  process (the door's use played first); whether a picked lock stays locked and the pick is
  used is not read. `tests/sim-actor-activation.int.test.ts`.
- **Triggers**: trigger volumes (activators' primitives and trigger-layer collision) tell
  their scripts when the player enters and leaves (OnTriggerEnter, OnTriggerLeave,
  GetTriggerObjectCount). Moving objects enter them too, but not the clutter a cell places
  inside one as it loads: the game's placed clutter lies inactive until disturbed (an object
  left floating in the editor floats until touched), and its trigger volumes (hkpTriggerVolume,
  by the RTTI) hear of a body only from the contacts an active one's simulation makes; ours
  settle at load (the warm start), and a body settling is not looked at
  (`PhysicsWorld.movingInTriggers`). Disturbed later, it enters as it moves. Before, Whiterun's
  clutter entered CWDisableHoldPositionMarkerTrigger at every load, whose script took each for
  an actor and failed on None.
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
- **Doors and gates**: ObjectReference.SetOpen swings a door that is no load door with its open
  or close sequence and sound, and it stays as the script left it (`src/shell/actor-doors.ts`
  setOpen); one not loaded comes in as scripts left it (GetOpenState), else as placed (ONAM).
  Its leaves' bodies are keyframed on the nodes the sequences move and follow them
  (`PlaySession`), so an open gate lets through and a shut one does not. A gate that is an
  activator (a portcullis's default2StateActivator) is swung by its own script's SetOpen,
  through PlayAnimation on its graph, whose bodies follow its pose. `node tools/door-audit.ts`
  lists every reference the load order's scripts swing (SetOpen, PlayAnimation,
  PlayAnimationAndWait, PlayGamebryoAnimation on a property, on the script's own reference, on
  a forced alias): 7,858 references (6,761 activators and 475 furniture with graphs, 66 doors
  with graphs: trap hinges, wayshrine doors); the 80 doors scripts SetOpen all swing on open
  and close sequences, the collision of 43 following them (MQ101's two Helgen gates among
  them) and the 37 wall shackles having no body on a moving node. 3,253 of the references
  (3,144 activators, 60 furniture, 9 doors: Labyrinthian's shaft trap doors, Rannveig's Fast's
  cage door, the Dawnguard tutorial's castle door, Bthalft's Dwemer doors) were not in the
  world at all before the BSX editor-marker bit stopped hiding whole models
  (docs/formats/nif.md): their scripts swung nothing. The QA monitor
  `door-passed` watches actors and carts going through shut doors.
- **Furniture follows its user**: observed in the original, as an actor's sit or sleep
  state becomes "wants to sit" or "wants to sleep" in a furniture reference (its AI process
  takes the furniture), the furniture's animation graph manager joins the actor's
  sub-managers (the list AddDependentAnimatedObjectReference adds to); inferred from the data,
  the events the actor's graph raises reach the furniture's graph (`ActorGraphEvents`). A
  dragon on a perch counts: Alduin's tower smash-bite raises Open at 0.4 s, which opens the
  tower wall (DragonTowerHole01's OpenClose graph), whose opening raises Begin, the event its
  dragonTowerWallScript sets MQ101DragonAttack's stage 103 on (the tower door opened, the inn's
  guiding collision enabled). Before, the wall was not in the world at all (its mesh's BSX
  editor-marker bit hid the whole model: docs/formats/nif.md) and nothing reached a
  furniture's graph, so stage 103 never came and the opening's player fell from the tower into
  a room the rubble shuts.
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
| furniture                              | OnSit (in it) / OnGetUp (up from it) to the actor, the player too (the furniture)                                                                               |
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
- **Furniture** (`actor-furniture.ts`): TESFurnitureEvent as an actor (or the player) is in its
  furniture and as it stands again.
- **Kills, for the stats** (`stat-events.ts`, observed in the original: the ActorKill sink
  of the stats): an actor the player killed counts in each combat stat its race's keywords name
  by the default objects (NPCK People, ANML Animals, UNDK Undead, DAED Daedra, BEEP Automatons
  Killed), Creatures Killed if none; they are tracked stats (OnTrackedStatsEvent). TODO(M13): two
  more counts of that sink are not identified.
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
- Trap hits come from the traps' contacts with actors ("Traps" below), resets from the cells
  that reset as they come back ("Cell reset and cleared locations").
- Loading a game (`game-session.ts`: OnPlayerLoadGame as the loaded game's scripts are up).
- Scenes (`scene-runtime.ts` through `scene-host.ts`): a scene's begin and end, each phase's
  begin and end, each action as it starts. Topic infos (`dialogue-engine.ts` runFragment):
  each said line's begin and end, however it is said (menu, scene, world). Quest init
  (`quests.ts`): as a quest's and its aliases' OnInit are set going. Perk entries
  (`perk-engine.ts`): an Activate entry's choice as it runs, with its fragment. Active
  effects (`magic-engine.ts`): an effect starting and stopping to act on its target.
- Animation event registrations end with the graph: as a reference's 3D unloads, the
  registrations for its animation events are dropped and each script that registered hears
  OnAnimationEventUnregistered (the source and the event's name, lowercase), as the Creation
  Kit describes it (it may register again on OnLoad).
- Menus (SKSE's RegisterForMenu, UnregisterForMenu, UnregisterForAllMenus on Form, Alias and
  ActiveMagicEffect): the menu stack's open and close (MenuOpenCloseEvent) reach the scripts
  registered for that menu as OnMenuOpen and OnMenuClose with its name.

`tools/script-events.ts` lists each event's declarations in the base scripts and the scripts
of the load order that handle it. `PapyrusVm.handled` (debugging) hears every handler that
runs.

### Cell reset and cleared locations

Observed in the original (`src/scripting/runtime/cell-reset.ts`, `location-clearing.ts`;
times are whole game hours, 0 for never):

- A cell notes the hour it leaves the loaded area (`GameState.cellDetached`). As it comes back,
  one that never left is as the plugins made it; one that left resets once more than
  iHoursToRespawnCell hours have passed (iHoursToRespawnCellCleared where its location is
  cleared: 72 and 144 built in, 240 and 720 in Skyrim.esm). Its location for that: its encounter
  zone's, else its own XLCN, else its worldspace's.
- A cell with an encounter zone (its XEZN; outside, else its worldspace's) resets by the zone:
  a zone that Never Resets keeps its cells (91 of the 356 zones, 144 interiors); else the zone
  resets as one of its cells comes in once its cells have been away long enough, and a cell
  that left before the zone's last reset resets as it comes back. A reset zone is levelled anew.
- What may reset: a reference not flagged No Respawn (REFR 0x40000000); a container only if its
  base Respawns (CONT DATA 0x02), an actor only if its base Respawns (ACBS 0x08); a leveled
  actor unless No Respawn. What a reset does: the reference's lock, open state, destruction and
  harvest go, a container's inventory is picked anew, an object that is not persistent goes
  back to its editor place, an actor comes back as its records make it, and the reset is told
  (TESResetEvent: OnReset, after OnCellAttach). The engine also sets the reference's enable
  state again: ours sets the one the plugins give it (TODO(M13): whether the engine sets the
  initial one is not read), and the animated state it kept (`GameState.graphs`) goes. It keeps
  a clock of its own on each actor that its respawn waits from: ours is the actor's death, so a
  dead actor respawns only once the wait has passed since it died, also where its zone reset
  sooner (what else sets the clock is not read, TODO(M13)).
- What the game made in the cell goes with its reset: references created there (dropped items,
  PlaceAtMe) lying in the world, unless a quest's alias holds them (TODO(M13): which created
  references the engine keeps besides).
- Corpses: as a cell that left comes back, an actor that does not respawn, did not start dead
  and died more than iHoursToClearCorpses (24) hours ago is removed (disabled); two further
  checks of the engine's are not identified (a corpse a quest's alias holds is kept here).
- A location is cleared once each of its bosses (its LCSR/ACSR references of the default
  object LocRefType - Boss, LRTB) is dead; disabled bosses do not count, a boss dead longer than
  the respawn wait counts as alive. The engine counts as an actor dies where the player is (the
  location of the actor's editor cell, unless cleared already), as one respawns, and as a
  quest's location alias asks (once a game hour). A location that becomes cleared is shown
  "Cleared" (sCleared) on the maps from then on if it has the default object Keyword -
  ClearableLocation (KWDO), which also plays Music - Dungeon Cleared (DCMS) and tells
  LocationCleared (the hub's `locationCleared`): the misc stat Dungeons Cleared counts it.
  sDungeonCleared ("Dungeon Cleared!") is read by no code: the engine shows no notice.
- Animated state (`ScriptRuntime.cellDetached`, `src/sim/placed-objects.ts`): as a cell
  detaches, each loaded object whose graph moved from its start (a chest's lid open, a lever
  pulled, a gate raised) keeps that state (`GameState.graphs`, saved with the game state) and
  is placed in it as its cell loads again; its cell's reset drops it.
- Alias display names (`ScriptRuntime.aliasDisplayName`): while an alias with a display name
  (ALDN: a message whose title names it) holds a reference, the reference is so named: the
  crosshair, the menus and the scripts' text replacement show it, until the alias lets go.
- Cell buffers (`src/world/cell-buffer.ts`, `GameSession.cellData`): the cells used most
  recently keep their data as the plugins make it, interiors and exteriors in buffers of their
  own ([General] uInterior Cell Buffer 3, uExterior Cell Buffer 36: UESP's defaults), so going
  back into a cell just left does not read its records again; the least recently used leaves
  as a buffer fills. A buffered cell is detached like any other (OnCellDetach as it left, its
  reset clock running); the game's changes to it live in GameState either way.
- Moved objects (`src/shell/moved-objects.ts`): a cell leaving the loaded area notes where its
  moving objects are; a cell loading places its objects where the game left them, until its
  reset puts the non-persistent ones back.

`node tools/world-rules-census.ts` counts the zones and their flags, the locations with bosses
and those the player can clear, the references that never respawn and the traps.

### Traps

Observed in the original (`src/scripting/runtime/trap-hits.ts`): every physics world has a
trap listener; bodies on L_TRAP and L_CLOUDTRAP are traps, and a character controller's contact
with one is a hit. The engine keeps an entry per trap and target: a new contact tells the start
(TESTrapHitEvent, OnTrapHitStart), a lasting one a hit once more than [Havok]
fTrapHitEventDelayMS (500 ms) has passed since the entry last told (OnTrapHit), and its end the
stop (OnTrapHitStop), with the trap body's velocity, the contact's place and the body's motion
type; the initial-hit flag is false for these contacts. The scripts hear them only on living
actors. The player's and the actors' controllers are checked each physics step
(`PhysicsWorld.trapsTouching`). Of the 28 bases with a trap-hit script (TrapHitBase, HazardBase
and the scripts extending them), 1,797 references.

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
| AFAV  | The player activates an actor (talks to it, searches it, rides it).                                                                                                                                                                             | L1 the actor's location, R1 the actor                                        | the hub's `activate` (TODO(M13): every one?)                                                                                                           |
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
templates per part; its scripts too: an actor runs the scripts of the NPC_ it takes them from,
its leveled list's pick and that one's template while it uses the template's scripts, Template
Data "Use Script", with its reference's own VMAD over them: a placed or created leveled actor
runs its pick's scripts, not none), its level (fixed, or the player's times its multiplier within its calc
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
