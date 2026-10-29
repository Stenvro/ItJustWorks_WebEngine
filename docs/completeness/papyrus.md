# Papyrus: completeness

What "100" means here: every script the load order uses (Skyrim.esm, Update, the three DLCs and
the Creation Club files of the install) runs as in the original: the VM's rules, every native
the vanilla scripts declare, and every event the engine sends to scripts.

The natives and events parts come from the sweep `node tools/papyrus-completeness.ts` (`--all`
for every item); the VM part is kept by hand against `src/scripting/papyrus-vm.ts` and
docs/scripting.md ("Threads", "Properties", "The log").

## Count (2026-10-29)

| Part    | Items | Done | Open |
| ------- | ----: | ---: | ---: |
| Natives |   686 |  662 |   24 |
| Events  |    98 |   83 |   15 |
| VM      |    30 |   18 |   12 |
| Total   |   814 |  763 |   51 |

## Natives

A native is done when it is registered, is not in `natives/placeholders.ts` PLACEHOLDER_NATIVES
and is not registered as a bare constant, unless INERT_NATIVES gives the reason the game does
nothing there either (profiling, the console's helpers, preloading, achievements, Topic.Add).
The calls are the vanilla scripts' calls of a function by that name.

Done this round: Quest.UpdateCurrentInstanceGlobal (77 calls; the quest's run holds its text
globals' values), ObjectReference.CalculateEncounterLevel (19 calls; the encounter zone's level
by the difficulty's fLeveledActorMult). Not yet swept: each native's answer to None and to
arguments of the wrong type.

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
      against one or two (a perk entry point allows the second); the lockpicking menu counts no
      tries yet.
- [ ] game.usinggamepad (1 call): the shell does not tell which device gave the last input.
- [ ] objectreference.getitemhealthpercent (0 calls): an item reference's health (tempering).
- [ ] objectreference.setcontainerallowstolenitems (0 calls): the container's flag that it
      takes stolen items.
- [ ] quest.isstarting, quest.isstopping (0 calls): a quest's start and stop are not spread
      over frames, so neither is ever seen in progress.

## Events

An event is sent when an engine source names it (a story event: raises its type); it is
checked when a test names it (a unit test or a simulation case; the conformance list of
events still to write in the simulation, tests/conformance/scripting/script-events.test.ts
TO_WRITE, does not count). The four story events the original never raises (Bribe, Flatter,
Intimidate, Player Gets Favor) count as sent. Every one of the 98 is sent; open are those no
test checks yet (handlers in the load order's scripts in brackets):

- [ ] onBeginState (129): the compiled GotoState calls it; no test runs a state change's event.
- [ ] OnEffectFinish (121): magic-engine.ts, as an effect stops on its target.
- [ ] OnAnimationEvent (76): runtime.ts, to the forms registered for the graph's event.
- [ ] OnUpdateGameTime (61): runtime.ts, the registrations in game hours.
- [ ] OnRead (51): the book menu.
- [ ] OnUnequipped (23): to an item with scripts that an actor unequips.
- [ ] OnGainLOS (7), OnLostLOS (5): runtime.ts, the line of sight registrations.
- [ ] OnRaceSwitchComplete (7): as SetRace's switch ends.
- [ ] OnLockStateChanged (4): a lock locked or unlocked.
- [ ] OnPackageChange (1), OnPackageEnd (0): TESPackageEvent's other two.
- [ ] OnLycanthropyStateChanged (1), OnVampirismStateChanged (1), OnVampireFeed (1): the
      natives that change them.

Done (83): OnActivate, OnTriggerEnter, OnLoad, OnDeath, OnUpdate, OnEffectStart, OnHit,
OnCellAttach, OnContainerChanged, OnTriggerLeave, OnUnload, OnDying, OnCellLoad,
OnCombatStateChanged, OnLocationChange, OnCellDetach, OnReset, OnEquipped, OnItemAdded,
OnMagicEffectApply, OnTrigger, OnItemRemoved, OnEnterBleedout, OnGetUp, onEndState, OnOpen,
OnDestructionStageChanged, OnDetachedFromCell, OnPlayerLoadGame, OnObjectEquipped, OnSpellCast,
OnTrapHit, OnGrab, OnSit, OnTranslationComplete, OnSleepStop, OnTranslationAlmostComplete,
OnTrapHitStart, OnObjectUnequipped, OnSleepStart, OnAnimationEventUnregistered,
OnAttachedToCell, OnClose, OnTranslationFailed, OnPackageStart, OnPlayerBowShot,
OnPlayerFastTravelEnd, OnTrackedStatsEvent, OnWardHit, OnInit, OnRelease, OnSell,
OnTrapHitStop, and the 30 OnStory events (OnStoryScript and the story manager's 29 types).
A unit test that names an event is weaker evidence than a simulation case: of these, the
simulation covers the 16 in the conformance list's COVERED and the story events.

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
- [ ] The call stack's depth limit and its error (ours: 64 calls, our wording).
- [ ] Stack memory (iMaxAllocatedMemoryBytes) and its error.
- [x] Properties: plugin values bound by name, full properties through Set before OnInit, the
      original's line for a property the script no longer has.
- [ ] A plugin value for a full property without a Set function (TODO(M13)).
- [x] A script starts in its auto state, or its nearest parent's.
- [x] Object casts by the plugins' attachments; a failed cast gives None (logged on use).
- [ ] The original's "Cannot cast from X to Y" error for casts between unrelated types.
- [x] Arrays of 1 to 128 elements; any other size is the original's error and makes none.
- [x] Array access out of range or on None: the original's errors, the thread goes on.
- [ ] Array find with a start index out of range ("Array start index ... is out of range").
- [x] Division and modulo by zero: the original's error, the result left as it was.
- [x] Floats as strings with six decimals ("1.500000"); ints, bools ("True"), None.
- [ ] Objects as strings: the original prints "[Actor < (00000014)>]"; ours "[actor 00000014]".
- [ ] Float arithmetic in single precision (ours: doubles; printing rounds to single).
- [ ] A call on None: the original's line ("Cannot call X() on a None object, aborting function
      call"); ours names the call in our words.
- [x] A missing function: "Method X not found on Y. Aborting call and returning None".
- [x] Strings compare without case; bools and ints compare by value.
- [x] Saves: threads with their frames, latent waits, OnInit waits and threads in a native's
      promise resume on load (docs/formats/save.md).
- [x] Saves: every registration (updates, game time, LOS, sleep, tracked stats, animation
      events, menus).
- [ ] On load, whether a native in flight is called again (the original's rule not read).
