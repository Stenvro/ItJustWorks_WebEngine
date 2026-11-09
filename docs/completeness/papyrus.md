# Papyrus: completeness

What "100" means here: every script the load order uses (Skyrim.esm, Update, the three DLCs and
the Creation Club files of the install) runs as in the original: the VM's rules, every native
the vanilla scripts declare, and every event the engine sends to scripts.

The natives and events parts come from the sweep `node tools/papyrus-completeness.ts` (`--all`
for every item); the VM part is kept by hand against `src/scripting/papyrus-vm.ts` and
docs/scripting.md ("Threads", "Properties", "The log").

## Count (2026-10-31, round 8)

| Part    | Items | Done | Open |
| ------- | ----: | ---: | ---: |
| Natives |   687 |  687 |    0 |
| Events  |    99 |   99 |    0 |
| VM      |    30 |   30 |    0 |
| Total   |   816 |  816 |    0 |

Round 8 read the natives' last inferred rules from the original: KeepOffsetFromActor's speeds
between its radii and what PlayTerrainEffect takes of the ground (its place on the land; no
look). Left to the renderer: setting a terrain effect's pieces on the land one by one.

Round 4 counts the None-argument sweep as a natives item and the simulation's share of the
events as an events item (both were listed, not counted). The sweep reports the simulation's
share separately: all 98 events are checked in the headless simulation (93 after round 6, 55
after round 5, 38 after round 4, 27 before).

## Natives

A native is done when it is registered, is not in `natives/placeholders.ts` PLACEHOLDER_NATIVES
and is not registered as a bare constant, unless INERT_NATIVES gives the reason the game does
nothing there either (profiling, the console's helpers, preloading, achievements, Topic.Add).
The calls are the vanilla scripts' calls of a function by that name.

All 686 are done; PLACEHOLDER_NATIVES is empty. Round 3 (none of them called by a vanilla
script):

- [x] actor.forcemovementdirection, ...directionramp, ...rotationspeed, ...rotationspeedramp,
      ...speed, ...speedramp, forcetargetangle, forcetargetdirection, forcetargetspeed,
      clearforcedmovement (10): observed in the original, no native of these names is bound;
      a call is the VM's 'error: Unbound native function "<name>" called' on the calling
      stack and returns None (placeholders.ts UNBOUND_NATIVES).
- [x] actor.keepoffsetfromactor, clearkeepoffsetfromactor: the offset (the angles turned to
      radians, the two radii) kept in the game state; the movers steer the actor to it each
      step at the original's keep-offset planner's speed: from 0 at the follow radius to 3
      (the normalized scale's) at the catch-up radius, linear between, by the distance in three
      dimensions (src/ai/movement-overrides.ts, round 8).
- [x] actor.setplayercontrols, getplayercontrols: the actor's AI off as EnableAI(false), its
      movement controller driven by the player's controls (the movers' script steering).
- [x] game.setcameratarget: the third-person camera hangs on that actor (None: the player).
- [x] objectreference.forceremoveragdollfromworld: latent; the ragdoll leaves the physics world.
- [x] objectreference.playterraineffect: as the original, the effect stands on the land under
      the reference (the land's height there, turned as the reference) and takes nothing of
      the ground's look (no texture, no material); no land under it (an interior) is the
      original's error (src/world/terrain-effect.ts, round 8). Its pieces set on the land one
      by one and the effect model's own attach node are the renderer's (TODO(M13)).
- [x] objectreference.playsyncedanimationss, playsyncedanimationandwaitss: both references'
      events in one call, true when either took; the original's three errors (a None second
      object, an actor on either side); the waiting one waits for the events of those whose
      animation took.
- [x] objectreference.islockbroken (menus round 3: the lock's failed tries).
- [x] objectreference.setcontainerallowstolenitems: observed in the original, a flag of the
      base's container (NPC_ or CONT, so every reference of the base), read only by the
      container menu, which then lists no stolen stacks on either side.

Round 1 and 2: Quest.UpdateCurrentInstanceGlobal (77 calls), ObjectReference.
CalculateEncounterLevel (19 calls), Game.UsingGamepad, ObjectReference.GetItemHealthPercent (round
7: an improved stack dropped into the world keeps its health on the reference, observed in the
original: the item's data goes with it; taken again, its stack has it), Quest.IsStarting and
IsStopping.

- [x] Each native's answer to a None argument (round 4). Read from the original: there is no
      one rule. A call on a None object is the VM's ("Cannot call X() on a None object, aborting
      function call", the function's default returned); a None argument is each native's own
      check with its own line. The original's lines naming a None (105) were each tied to the
      natives logging them, with what those return after the line: 85 are checks of an
      argument, made by 107 natives (natives/none-arguments.ts, wrapped around every
      registration; the sweep checks each is declared and registered). They return their type's
      default except FormList.Find (-1) and GetDistance (the largest float). The other lines
      are checks of the native's own object (a None self, which the VM's own line catches
      first) or of a value that is no argument (SetActorValue's name). Arguments of a wrong type
      cannot reach a native (the compiler types them; a failed cast gives None).

## Events

An event is sent when an engine source names it (a story event: raises its type). It is
checked when a test that runs the engine (the simulation, the runtime, the hub's relay, the
VM, the story manager) names it in a string, not a comment: a case's title or the event it
expects sent with its arguments. The conformance list of events still to write in the
simulation (tests/conformance/scripting/script-events.test.ts TO_WRITE) does not count, only
its COVERED list. The four story events the original never raises (Bribe, Flatter, Intimidate,
Player Gets Favor) count as sent; the story manager's test sends each type's event to the
quest it starts.

All 98 are sent and checked by an engine-level test, and all 98 in the headless simulation (the
sweep's count).

Round 2 (each with the moment and the arguments of the base scripts' declarations and the
Creation Kit's pages): OnEffectFinish (the effect's end, akTarget and akCaster, on the data),
OnAnimationEvent, OnUpdate, OnUpdateGameTime, OnGainLOS/OnLostLOS (a single registration
ends with its event), OnLockStateChanged (only when the lock's state changes),
OnRaceSwitchComplete (once SetRace's new 3D stands), OnPackageChange/OnPackageEnd (the
package left), the vampirism, lycanthropy and feeding events, onBeginState/onEndState (the
compiled GotoState), OnUnequipped, and the story manager's 30 events. Fixed: OnRead reaches a
book read from an inventory when its base carries scripts (it reached only book references).

- [x] In the simulation: all 98. Round 7 added the last 5
      (tests/conformance/scripting/story-events-world.test.ts, three simulations, each raised
      by the engine path that raises it): Craft Item (an iron dagger made at Warmaiden's forge,
      an iron helmet improved at its armor workbench, through the crafting menu's model),
      Arrest (a Whiterun guard seeing the wanted player comes up, the event as it reaches them,
      then its force greet opens the conversation; submitting sends the player to jail), Pick
      Lock (Belethor's strongbox picked through the lockpicking menu's engine side), Trespass
      (the player staying in Belethor's shop, locked by its owner, past his warnings) and
      Player Infected (a skeever's bite passing on Ataxia). Fixed in the engine on the way: the
      crafting menu's engine side (src/shell/crafting-models.ts: what a bench lists, what
      choosing and crafting do) and the lockpicking menu's (src/shell/lock-picking.ts: whether
      a lock may be picked, its shape, the pick's sweep and turn, what opening a lock and
      breaking a pick do) are split from their movies, so Play and the simulation share them
      (its helpers craft and pick locks through them); Craft Item is raised by the story events
      (its location L1 was left out) and for an improvement too (the tutorials'
      TutorialBlacksmithingDaggerSharpen and ArmorTemper start on it at the improving benches:
      the improved item as the created one); an improved item dropped keeps its improvement on
      its reference and again once taken. Trespass's victim (R1) for a place a faction owns is
      the first witness of that faction (none if none of them belongs; inferred, TODO(M13):
      which actor the original takes; crime-engine.test.ts). Round 6 added
      38, in two simulations in the Bannered Mare,
      each raised by the engine path that raises it.
      tests/conformance/scripting/script-events-actions.test.ts: OnInit (a scripted urn
      placed: the VM now tells OnInit as it tells the other events), OnRead (a skill book read
      as the book menu opens it), OnSell (an apple sold through the barter menu's model),
      OnSleepStart / OnSleepStop (the sleep menu's passing of the hours), OnClose (a strongbox
      searched), OnGrab / OnRelease (Activate held on a bowl), OnSpellCast and OnWardHit (a ward
      cast by the player's hand, met by Hulda's firebolt), OnPlayerBowShot, OnTranslationFailed
      (a reference not loaded asked to move), OnPackageChange (Carlotta's inn package left at
      22:00 by the AI's own evaluation; round 5's note that no package changes in a short
      simulation was wrong), OnPlayerFastTravelEnd (fast travel's journey).
      tests/conformance/scripting/story-events.test.ts: 24 story event types, each event's data
      checked and every quest a node starts told its OnStory event: Script (CR01 started),
      Increase Skill (WISkillIncrease01, 02), Increase Level, Player Add Item (a purchase),
      Player Remove Item (a drop from the inventory menu), Relationship Change (a gift:
      FavorJarlsMakeFriendsTrackEvent), Cast Magic, New Voice Power (WINewVoicePower01), Player
      Cured, Player Activate Actor, Actor Hello, Actor Dialogue, Assault Actor
      (WIAssaultRemember), Kill Actor, Crime Gold, Dead Body, Jail (JailQuest), Served Time,
      Escape Jail (EscapeJailQuest and its achievement's quest), Pay Fine; Bribe, Flatter,
      Intimidate and Player Gets Favor checked as never raised (a bribe, an intimidation and a
      favor raise none). Fixed in the engine on the way: the engine sides of the book menu
      (src/shell/book-reading.ts), the sleep and wait menu (passHours) and fast travel's
      journey (src/shell/fast-travel-journey.ts: the hours, the sky, the arrival told; the
      simulation's fast travel had told the end itself) are split from their movies and Play,
      so the simulation runs the same code; its helpers read, sell, buy, drop, give, rest, grab
      and attack through them (tests/helpers/sim.ts).
      Round 5 added 17 (tests/conformance/scripting/script-events-items.test.ts, one
      simulation in the Bannered Mare, each raised by the engine path that raises it: a potion
      drunk, a sword equipped and unequipped, a treasure map taken, natives called through the
      VM, the player walking; save-load.test.ts for the load):
      OnEffectStart, OnEffectFinish, OnEquipped, OnUnequipped, OnContainerChanged,
      onEndState / onBeginState (the compiled GotoState's calls, now told as events),
      OnLockStateChanged, OnDestructionStageChanged, OnEnterBleedout, OnAnimationEvent,
      OnAnimationEventUnregistered, OnRaceSwitchComplete, OnVampireFeed,
      OnVampirismStateChanged, OnLycanthropyStateChanged, OnPlayerLoadGame.
      Fixed in the engine on the way: a reference disabled lets go of its graph's animation
      event registrations and tells them (OnAnimationEventUnregistered: only a cell detaching
      did); a created object disabled or enabled is told as a cell's own (OnUnload / OnLoad);
      OnPlayerLoadGame is sent once the loaded world is up (the first frame the game runs), as
      the original sends it, not as the scripts are. (Round 6 covered what it left.) Round 4 added 11 (tests/conformance/scripting/script-events-registered.test.ts, one
      simulation): OnUpdate, OnUpdateGameTime, OnGainLOS, OnLostLOS, OnTranslationAlmostComplete,
      OnTranslationComplete, OnObjectUnequipped, OnItemRemoved, OnCombatStateChanged,
      OnPackageEnd, OnTrackedStatsEvent. Left: those whose trigger needs data of their own (a
      scripted item, book or magic effect, a bed, a destructible) and the story manager's (each
      needs a quest node of its type), and OnAnimationEvent (a wolf's attack came too late to be
      reliable in one simulation).

## VM

- [x] One thread runs at a time; a thread yields only where it waits (latent call, lock,
      another script's OnInit, the frame's budget).
- [x] The order in which waiting threads take turns (round 4, observed in the original): the
      VM suspends a stack whose call it hands to the main thread (a retried call) or which
      waits for memory, and resumes them in its update: from a fixed queue of 128 in the order
      they came, then the overflow newest first (oldest first while overstressed). The queues
      are two, swapped at each update: those an update leaves over wait for the update after
      next, behind the ones suspended meanwhile (scheduler.ts suspend). The original runs its
      stacks side by side on tasklets; ours runs one at a time, its run token passed in the
      order the threads got back in line.
- [x] A script instance is locked while a thread runs in it; external calls unlock it.
- [x] Until a script's OnInit has finished, its other events and calls into it wait.
- [x] Latent natives suspend their thread and unlock its script.
- [x] Natives wait for the frame by their registration (latent, callable on the script's
      thread: native-timing.ts).
- [x] The frame's budget: 0.9 of fUpdateBudgetMS for the update, fExtraTaskletBudgetMS more.
- [x] The handed calls' share of the update budget (round 4, observed in the original): the
      suspended stacks resume one after another while 0.9 of fUpdateBudgetMS lasts (at least
      one), the time counted being the main thread's work of each (ours: the native's own run,
      not what it started); while overstressed all of the fixed queue resumes, the budget
      starting again after each.
- [x] The latent calls' render-safe and post-render queues (round 5, observed in the
      original; src/scripting/latent-queues.ts, docs/scripting.md "Threads"). The render-safe
      queue takes Spell.Cast and RemoteCast, Scroll.Cast and TetherToHorse; the post-render
      queue 27 (AddItem, RemoveItem, DropObject, the five MoveTo natives, SetPosition, SetAngle,
      SetScale, SetMotionType, ApplyHavokImpulse, DamageObject, Delete, Reset, Enable, Disable,
      EnableNoWait and DisableNoWait (not latent: they return at once), Resurrect,
      AttachAshPile, SendPlayerToJail, the two ragdoll natives, the two Havok constraint
      natives). The post-render queue runs after the frame is drawn, the render-safe one at a
      point of the frame before; each run swaps the queue's two lists and runs the work queued
      before it in order while its budget lasts (the budget given, else 0.05 of
      fUpdateBudgetMS), at least one; what a run leaves waits for the run after next. Only a
      fading Enable / Disable goes back for the next run (until the fade is over or 5 s; ours:
      its work waits for the fade). Ours runs both as a frame begins (the render-safe point
      against the VM's update inferred); a latent native's thread waits for its
      work, its script unlocked. Wired to the natives (natives/index.ts); the opening, MQ102 to MQ104 and the saves run with it in the simulation (a test awaiting a native itself must step the world: the sim helper native()).
- [x] A loaded game's VM runs on its own for fPostLoadUpdateTimeMS.
- [x] No call-depth limit and no error for it (observed in the original: a stack grows page by
      page while memory lasts). Ours keeps a guard of 4096 calls for the browser's memory.
- [x] Stack memory (round 4, src/scripting/stack-memory.ts): there is no error. The page
      policy as round 3 read it (iMinMemoryPageSize, iMaxMemoryPageSize,
      iMaxAllocatedMemoryBytes). A frame is 64 bytes and 16 per variable (its parameters and
      locals); it goes after the frame below it in the last page if its 64 bytes fit there,
      else in a new page of its whole size; its variables fill what is left and go on in new
      pages. A page refused is replaced by the largest page still to be had if the part fits
      (64 bytes, one variable); else everything taken for the frame is given back and the
      thread waits for memory, asking again at its turn in the next update. A popped frame
      gives back the pages it began. The limit is ignored for a stack loaded from a save and
      while the VM is overstressed. Overstressed (observed in the original): more than 100
      stacks suspended at an update; set at each update; it lets pages past the limit, resumes
      all of the fixed queue regardless of the budget, takes the overflow oldest first, and
      after 5 s overstressed dumps the stacks to the log (at most once a minute). Ours, without
      frames (Node tools) and while a loaded game's VM runs on its own, gives pages past the
      limit (no update would come).
- [x] Properties: plugin values bound by name, full properties through Set before OnInit, the
      original's line for a property the script no longer has.
- [x] A plugin value for a full property without a Set function (read-only): observed in the
      original, its binding skips it with the warning "Property X on object Y is read-only,
      property skipped." (round 3).
- [x] A script starts in its auto state, or its nearest parent's.
- [x] Object casts by the plugins' attachments; a failed cast gives None (logged on use).
- [x] The original's casts: to String and Bool from anything; to Int from a String (strtol),
      a Float (truncated) or a Bool; to Float from a String, an Int or a Bool; to an object from
      None or an object; an array only to its own type. Any other is "Cannot cast from X to Y"
      and gives the type's default.
- [x] Arrays of 1 to 128 elements; any other size is the original's error and makes none.
- [x] Array access out of range or on None: the original's errors, the thread goes on.
- [x] Array Find/RFind: a start index out of range is "Array start index N is out of range
      (0-last)" (RFind: -1-last; -1 is its last element) and finds nothing; on None "Variable
      isn't an array and cannot be searched".
- [x] Division and modulo by zero: the original's error, the result left as it was.
- [x] Floats as strings with six decimals ("1.500000"); ints, bools ("True"), None.
- [x] Objects as strings: "[<script> <<what>>]": a form's editor ID where the original keeps
      one at run time (actions, ANIO, cells, topics, globals, head parts, idles, imagespace
      modifiers, keywords, location ref types, movable statics, music, quests, races, voice
      types, worldspaces; references and other forms none) and its id ("[Actor < (00000014)>]"),
      an alias "alias <name> on quest <quest> (<id>)", an active effect "Active effect <n> on
      <actor's shown name> (<id>)" (round 5, observed in the original: n is the 16 bits of the
      effect's handle that tell it apart; round 7, read from the original: numbered per actor,
      an effect whose base carries scripts taking the lowest number from 1 that none of that
      actor's other effects has, the others none. The actor's name was missing).
- [x] Float arithmetic, negation and casts to Float in single precision.
- [x] A call on None: "Cannot call X() on a None object, aborting function call"; a property on
      None: 'Cannot get/set property "X" on a None object.'
- [x] A missing function: "Method X not found on Y. Aborting call and returning None".
- [x] Strings compare without case; bools and ints compare by value.
- [x] Saves: threads with their frames, latent waits, OnInit waits and threads in a native's
      promise resume on load (docs/formats/save.md).
- [x] Saves: every registration (updates, game time, LOS, sleep, tracked stats, animation
      events, menus).
- [x] On load, whether a native in flight is called again (round 4, observed in the
      original): a call handed to the main thread and not yet made is a suspended stack with a
      retried call; the suspended stacks are saved and the call is made on load, as ours does
      (the thread is saved at its call). A latent native's queued work is saved with the game
      and finishes after the load, its result going to the waiting stack, without calling the
      native again: ours keeps a clock wait as data the same way and calls the other latent
      natives again: ours saves the thread at its call, so its work is queued again on load
      (the latent queues' item; only a None line shows twice).
