# Papyrus: completeness

What "100" means here: every script the load order uses (Skyrim.esm, Update, the three DLCs and
the Creation Club files of the install) runs as in the original: the VM's rules, every native
the vanilla scripts declare, and every event the engine sends to scripts.

The natives and events parts come from the sweep `node tools/papyrus-completeness.ts` (`--all`
for every item); the VM part is kept by hand against `src/scripting/papyrus-vm.ts` and
docs/scripting.md ("Threads", "Properties", "The log").

## Count (2026-10-30, round 4)

| Part    | Items | Done | Open |
| ------- | ----: | ---: | ---: |
| Natives |   687 |  687 |    0 |
| Events  |    99 |   98 |    1 |
| VM      |    30 |   29 |    1 |
| Total   |   816 |  814 |    2 |

Round 4 counts the None-argument sweep as a natives item and the simulation's share of the
events as an events item (both were listed, not counted). The sweep reports the simulation's
share separately: 38 of the 98 events are checked in the headless simulation (27 before).

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
      step (src/ai/movement-overrides.ts; the speeds between the radii inferred: TODO(M13)).
- [x] actor.setplayercontrols, getplayercontrols: the actor's AI off as EnableAI(false), its
      movement controller driven by the player's controls (the movers' script steering).
- [x] game.setcameratarget: the third-person camera hangs on that actor (None: the player).
- [x] objectreference.forceremoveragdollfromworld: latent; the ragdoll leaves the physics world.
- [x] objectreference.playterraineffect: the model at the node (none: the root); one not set
      up is the original's error (the ground's own look: TODO(M13)).
- [x] objectreference.playsyncedanimationss, playsyncedanimationandwaitss: both references'
      events in one call, true when either took; the original's three errors (a None second
      object, an actor on either side); the waiting one waits for the events of those whose
      animation took.
- [x] objectreference.islockbroken (menus round 3: the lock's failed tries).
- [x] objectreference.setcontainerallowstolenitems: observed in the original, a flag of the
      base's container (NPC_ or CONT, so every reference of the base), read only by the
      container menu, which then lists no stolen stacks on either side.

Round 1 and 2: Quest.UpdateCurrentInstanceGlobal (77 calls), ObjectReference.
CalculateEncounterLevel (19 calls), Game.UsingGamepad, ObjectReference.GetItemHealthPercent (a
tempered stack dropped into the world: TODO(M13)), Quest.IsStarting and IsStopping.

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

All 98 are sent and checked by an engine-level test. Of them 27 are checked in the headless
simulation (the sweep's count); the other 71 by the runtime's, the relay's, the VM's or the
story manager's tests (src/scripting/runtime/engine-events.test.ts, script-events.test.ts,
story-manager.test.ts, src/scripting/papyrus-vm-errors.test.ts, tests/effect-events.int.test.ts).

Round 2 (each with the moment and the arguments of the base scripts' declarations and the
Creation Kit's pages): OnEffectFinish (the effect's end, akTarget and akCaster, on the data),
OnAnimationEvent, OnUpdate, OnUpdateGameTime, OnGainLOS/OnLostLOS (a single registration
ends with its event), OnLockStateChanged (only when the lock's state changes),
OnRaceSwitchComplete (once SetRace's new 3D stands), OnPackageChange/OnPackageEnd (the
package left), the vampirism, lycanthropy and feeding events, onBeginState/onEndState (the
compiled GotoState), OnUnequipped, and the story manager's 30 events. Fixed: OnRead reaches a
book read from an inventory when its base carries scripts (it reached only book references).

- [ ] In the simulation: 60 events still have an engine-level test only (the sweep lists
      them). Round 4 added 11 (tests/conformance/scripting/script-events-registered.test.ts, one
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
- [ ] The latent calls' render-safe and post-render queues. Read in round 4: a latent native
      queues its main-thread work (a delay functor, saved with the game) in one of the two; each
      frame a queue runs the work queued before it, first come first served, until it is empty
      or its budget is spent (the budget given, else 0.05 of fUpdateBudgetMS; at least one
      each frame); work that waits on (Utility.Wait's) goes back for the next frame, and work
      done returns its result to the waiting stack. Not built: ours starts a latent native's
      work in the call itself; it needs each latent native split into its start and its queued
      work, and which of the two queues each uses read.
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
      <actor> (<id>)" (our n is 0: TODO(M13)).
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
      natives again (their work is not queued apart: the latent queues' item).
