# Papyrus: completeness

What "100" means here: every script the load order uses (Skyrim.esm, Update, the three DLCs and
the Creation Club files of the install) runs as in the original: the VM's rules, every native
the vanilla scripts declare, and every event the engine sends to scripts.

The natives and events parts come from the sweep `node tools/papyrus-completeness.ts` (`--all`
for every item); the VM part is kept by hand against `src/scripting/papyrus-vm.ts` and
docs/scripting.md ("Threads", "Properties", "The log").

## Count (2026-10-29, round 2)

| Part    | Items | Done | Open |
| ------- | ----: | ---: | ---: |
| Natives |   686 |  666 |   20 |
| Events  |    98 |   98 |    0 |
| VM      |    30 |   24 |    6 |
| Total   |   814 |  788 |   26 |

## Natives

A native is done when it is registered, is not in `natives/placeholders.ts` PLACEHOLDER_NATIVES
and is not registered as a bare constant, unless INERT_NATIVES gives the reason the game does
nothing there either (profiling, the console's helpers, preloading, achievements, Topic.Add).
The calls are the vanilla scripts' calls of a function by that name.

Done this round: Quest.UpdateCurrentInstanceGlobal (77 calls; the quest's run holds its text
globals' values), ObjectReference.CalculateEncounterLevel (19 calls; the encounter zone's level
by the difficulty's fLeveledActorMult). Round 2: Game.UsingGamepad (the device last used, as
the shell switches the menus' platform), ObjectReference.GetItemHealthPercent (the reference's
XHLT; a tempered stack dropped into the world: TODO(M13)), Quest.IsStarting and IsStopping (a
quest's start, its aliases filling and its start-up stage, and its stop are in progress over
awaits; a Stop inside the stop's own shut-down is not run twice).

Not yet swept: each native's answer to None and to arguments of the wrong type. Read from the
original: there is no one rule. A call on a None object is the VM's ("Cannot call X() on a
None object, aborting function call", the function's default returned); a None argument is
each native's own check, many with their own line ("Cannot play a visual effect on a None
object", "Cannot cast a None form", "Cannot cast a spell from a None source"). Arguments of a
wrong type cannot reach a native (the compiler types them; a failed cast gives None).

Open (none of them called by more than one vanilla script):

- [ ] actor.forcemovementdirection, ...directionramp, ...rotationspeed, ...rotationspeedramp,
      ...speed, ...speedramp, forcetargetangle, forcetargetdirection, forcetargetspeed,
      clearforcedmovement (11; 0 calls): the movement controller's forced movement (M13).
- [ ] actor.keepoffsetfromactor, clearkeepoffsetfromactor (2; 0 calls): the movement
      controller's offsets (M13).
- [ ] actor.setplayercontrols (0 calls): actors other than the player under player controls.
- [ ] game.setcameratarget (0 calls): the camera's target other than the player.
- [ ] objectreference.forceremoveragdollfromworld (0 calls): ragdolls a script removes.
- [ ] objectreference.playterraineffect (0 calls): the terrain's effects at a node.
- [ ] objectreference.playsyncedanimationss, playsyncedanimationandwaitss (2; 0 calls): synced
      animations of two references.
- [ ] objectreference.islockbroken (1 call): the original's rule is the lock's failed tries
      against one or two (a perk entry point allows the second); the lockpicking menu (another
      area) counts no tries yet.
- [ ] objectreference.setcontainerallowstolenitems (0 calls): the container's flag that it
      takes stolen items; what reads the flag is not read.

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

- [ ] In the simulation: the 71 events with an engine-level test only (the conformance list's
      TO_WRITE).

## VM

- [x] One thread runs at a time; a thread yields only where it waits (latent call, lock,
      another script's OnInit, the frame's budget).
- [ ] The order in which waiting threads take turns: inferred (first come, first served), the
      VM's own scheduling of its stacks not read (TODO(M13)).
- [x] A script instance is locked while a thread runs in it; external calls unlock it.
- [x] Until a script's OnInit has finished, its other events and calls into it wait.
- [x] Latent natives suspend their thread and unlock its script.
- [x] Natives wait for the frame by their registration (latent, callable on the script's
      thread: native-timing.ts).
- [x] The frame's budget: 0.9 of fUpdateBudgetMS for the update, fExtraTaskletBudgetMS more.
- [ ] The handed calls' share of the update budget (all begin in the next frame: TODO(M13)).
- [ ] The latent calls' render-safe and post-render queues (0.05 of fUpdateBudgetMS each).
- [x] A loaded game's VM runs on its own for fPostLoadUpdateTimeMS.
- [x] No call-depth limit and no error for it (observed in the original: a stack grows page by
      page while memory lasts). Ours keeps a guard of 4096 calls for the browser's memory.
- [ ] Stack memory (iMaxAllocatedMemoryBytes, 153600): read from the original, there is no
      error; a page (iMinMemoryPageSize to iMaxMemoryPageSize) that would take the VM's stacks
      over the limit is refused and the stack waits for memory, unless the VM is overstressed
      (then the limit is ignored). Not built: the frames' sizes in bytes are not read.
- [x] Properties: plugin values bound by name, full properties through Set before OnInit, the
      original's line for a property the script no longer has.
- [ ] A plugin value for a full property without a Set function (TODO(M13)).
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
- [ ] On load, whether a native in flight is called again (the original's rule not read).
