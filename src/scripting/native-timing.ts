// When a Papyrus native runs (observed in the original; docs/scripting.md, "Threads"): the
// game registers each native with two marks, whether it is latent (it returns when what it
// started is done: Wait, AddItem, Disable, Cast) and whether it may be called from the script's
// own thread ("callable from tasklets"). Only the natives that may and are not latent run there
// at once: the Math functions, Debug's traces, GlobalVariable Get / SetValue, Game.GetForm and
// GetFormFromFile, the aliases' fills and registrations, the inventory event filters, Enable /
// DisableNoWait, the profiling switches. Every other native (669 registered, 68 of them so) is
// handed to the game's main thread, and the script waits for it there: it runs in the next
// frame (the Creation Kit wiki's threading notes: a call that must sync with the game takes a
// frame). So a loop of object natives runs a frame a call, as in the game. The handed calls
// begin in the next frame's VM update, in order, while its share of the budget lasts
// (scheduler.ts mainThread).
// Platform-independent.

/** The natives that run on the script's thread at once, by "script.function" in lower case. */
export const AT_ONCE_NATIVES: ReadonlySet<string> = new Set(
  [
    'ActiveMagicEffect.AddInventoryEventFilter',
    'ActiveMagicEffect.RemoveAllInventoryEventFilters',
    'ActiveMagicEffect.RemoveInventoryEventFilter',
    'ActiveMagicEffect.StartObjectProfiling',
    'ActiveMagicEffect.StopObjectProfiling',
    'Alias.GetOwningQuest',
    'Alias.RegisterForAnimationEvent',
    'Alias.RegisterForLOS',
    'Alias.RegisterForSingleLOSGain',
    'Alias.RegisterForSingleLOSLost',
    'Alias.RegisterForSingleUpdate',
    'Alias.RegisterForSingleUpdateGameTime',
    'Alias.RegisterForSleep',
    'Alias.RegisterForTrackedStatsEvent',
    'Alias.RegisterForUpdate',
    'Alias.RegisterForUpdateGameTime',
    'Alias.StartObjectProfiling',
    'Alias.StopObjectProfiling',
    'Alias.UnregisterForAnimationEvent',
    'Alias.UnregisterForLOS',
    'Alias.UnregisterForSleep',
    'Alias.UnregisterForTrackedStatsEvent',
    'Alias.UnregisterForUpdate',
    'Alias.UnregisterForUpdateGameTime',
    'Debug.CloseUserLog',
    'Debug.DumpAliasData',
    'Debug.OpenUserLog',
    'Debug.StartScriptProfiling',
    'Debug.StartStackProfiling',
    'Debug.StopScriptProfiling',
    'Debug.StopStackProfiling',
    'Debug.Trace',
    'Debug.TraceStack',
    'Debug.TraceUser',
    'Form.StartObjectProfiling',
    'Form.StopObjectProfiling',
    'Game.GetForm',
    'Game.GetFormFromFile',
    'GlobalVariable.GetValue',
    'GlobalVariable.SetValue',
    'LocationAlias.Clear',
    'LocationAlias.ForceLocationTo',
    'LocationAlias.GetLocation',
    'Math.Ceiling',
    'Math.DegreesToRadians',
    'Math.Floor',
    'Math.RadiansToDegrees',
    'Math.abs',
    'Math.acos',
    'Math.asin',
    'Math.atan',
    'Math.cos',
    'Math.pow',
    'Math.sin',
    'Math.sqrt',
    'Math.tan',
    'ObjectReference.AddInventoryEventFilter',
    'ObjectReference.DisableNoWait',
    'ObjectReference.EnableNoWait',
    'ObjectReference.RemoveAllInventoryEventFilters',
    'ObjectReference.RemoveInventoryEventFilter',
    'ObjectReference.SetContainerAllowStolenItems',
    'ReferenceAlias.AddInventoryEventFilter',
    'ReferenceAlias.Clear',
    'ReferenceAlias.ForceRefTo',
    'ReferenceAlias.GetReference',
    'ReferenceAlias.RemoveAllInventoryEventFilters',
    'ReferenceAlias.RemoveInventoryEventFilter',
  ].map((name) => name.toLowerCase()),
);

/**
 * Whether a call of a native waits for the next frame before it runs (handed to the main
 * thread): all but AT_ONCE_NATIVES. `script` and `name` in any case.
 */
export function nativeWaitsForFrame(script: string, name: string): boolean {
  return !AT_ONCE_NATIVES.has(`${script}.${name}`.toLowerCase());
}
