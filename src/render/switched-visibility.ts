// A switch over a kind of instance (docs/ui.md, "The console"): the console's tt (ToggleTrees)
// hides every tree, the near ones (TREE references, with their shadows and harvested looks) as
// well as the distant tree LOD; their collision and their place in the game stay. Each tree's
// instance keeps its own visibility (a disabled reference stays hidden whatever the switch) and is
// drawn while neither hides it. Platform-independent.

/** Whether an instance is drawn (scene-renderer.ts InstanceVisibility). */
export interface InstanceVisibility {
  hidden: boolean;
}

/**
 * An instance's visibility under a switch: hidden while its own visibility is (none: shown) or the
 * switch is; setting it sets its own, so whoever enables and disables the reference goes on as
 * before.
 */
export function switchedVisibility(
  own: InstanceVisibility | undefined,
  off: InstanceVisibility,
): InstanceVisibility {
  const self = own ?? { hidden: false };
  return {
    get hidden(): boolean {
      return self.hidden || off.hidden;
    },
    set hidden(hidden: boolean) {
      self.hidden = hidden;
    },
  };
}
