import { describe, expect, it } from 'vitest';
import { switchedVisibility, type InstanceVisibility } from './switched-visibility.ts';

describe('switched visibility (the console’s tt)', () => {
  it('hides a tree while the switch is off, and shows it again as it was', () => {
    const trees: InstanceVisibility = { hidden: false };
    const own: InstanceVisibility = { hidden: false };
    const tree = switchedVisibility(own, trees);
    expect(tree.hidden).toBe(false);
    trees.hidden = true;
    expect(tree.hidden).toBe(true);
    trees.hidden = false;
    expect(tree.hidden).toBe(false);
  });

  it('keeps a disabled tree hidden whatever the switch, and passes enabling through', () => {
    const trees: InstanceVisibility = { hidden: false };
    const own: InstanceVisibility = { hidden: true };
    const tree = switchedVisibility(own, trees);
    expect(tree.hidden).toBe(true);
    // The scripts enable the reference: its own entry, through either object.
    own.hidden = false;
    expect(tree.hidden).toBe(false);
    tree.hidden = true;
    expect(own.hidden).toBe(true);
    tree.hidden = false;
    trees.hidden = true;
    expect(own.hidden).toBe(false);
    expect(tree.hidden).toBe(true);
    // One placed without a visibility of its own is shown but for the switch.
    const bare = switchedVisibility(undefined, trees);
    expect(bare.hidden).toBe(true);
    trees.hidden = false;
    expect(bare.hidden).toBe(false);
  });
});
