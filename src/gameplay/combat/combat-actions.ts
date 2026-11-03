// The moments the engine performs its rarer combat actions (AACT, through the idle tree: docs/
// animation.md, "Idles and actions"), decided from plain combat state:
//
// - ActionForceEquip: what a hand holds changed while the weapon is out (a script's EquipItem,
//   an outfit change, the menus' equip): the tree swaps it in the hand as it stands
//   (WeapOutRightReplaceForceEquip, WeapOutLeftReplaceForceEquip, MagicForceEquip, ...: its
//   conditions read GetEquippedItemType and GetReplacedItemType). Sheathed, the tree's own branch
//   gives only torchEquip and ShdEquip, which the hands' reading sends already.
// - ActionReload: a crossbow out without its bolt on (the shot's release clip reloads it by its
//   arrowAttach; cut short, by a stagger or a recoil, the bolt is not on): the attack asked for
//   reloads instead (the tree's reloadStart, GetWeaponAnimType 12).
// - ActionDualRelease: both attack buttons let go at once (within the dual cast's input chord,
//   [Controls] fDualCastChordTime) while both hands were held: its tree's StaffBashRelease with a
//   staff in the left hand.
// - ActionBlockAnticipate: a blocking actor sees a blow come at it (each blow once): its
//   graph's block raises the shield or weapon to meet it (blockAnticipateStart: the
//   BlockAnticipate state's clip, its BSDirectAtModifier at the attacker's weapon).
// - ActionShieldChange: a shield put on or taken off, not swapped in a drawn hand (no vanilla
//   graph has an idle for it: performed, nothing plays).
//
// TODO(M13): the original's exact moments are not documented; these follow from the trees'
// conditions and the graphs' states. Platform-independent.

/** What a fighter's hands hold, by form (undefined: empty). */
export interface HandForms {
  readonly right: number | undefined;
  readonly left: number | undefined;
  readonly shield: number | undefined;
  readonly torch: boolean;
  /** The spells (or scrolls) in the hands. */
  readonly rightSpell: number | undefined;
  readonly leftSpell: number | undefined;
}

/** Whether two readings of the hands differ (a weapon, a shield, a torch or a spell changed). */
export function handsChanged(before: HandForms, after: HandForms): boolean {
  return (
    before.right !== after.right ||
    before.left !== after.left ||
    before.shield !== after.shield ||
    before.torch !== after.torch ||
    before.rightSpell !== after.rightSpell ||
    before.leftSpell !== after.leftSpell
  );
}

/**
 * Whether a change of the hands is performed as ActionForceEquip: the hands were read before
 * (not a fighter's first reading), they changed, and the weapon was out as they did.
 */
export function forceEquips(
  before: HandForms | undefined,
  after: HandForms,
  weaponOut: boolean,
): boolean {
  return before !== undefined && weaponOut && handsChanged(before, after);
}

/**
 * Whether a change of the hands is performed as ActionShieldChange (observed in the original:
 * as an item is equipped and it is not swapped in a drawn hand, ActionForceEquip, the left
 * hand's graph type is compared before and after; a shield put on or taken off is the shield
 * change; one shield for another keeps the type and is none).
 */
export function changesShield(
  before: HandForms | undefined,
  after: HandForms,
  weaponOut: boolean,
): boolean {
  if (before === undefined || forceEquips(before, after, weaponOut)) return false;
  return (before.shield !== undefined) !== (after.shield !== undefined);
}

/**
 * Whether an attack asked of a fighter is a reload instead (ActionReload): a crossbow in the
 * hand, out, no attack under way, and its bolt not on.
 */
export function wantsReload(state: {
  readonly crossbow: boolean;
  readonly inHand: boolean;
  readonly attacking: boolean;
  readonly boltOn: boolean;
}): boolean {
  return state.crossbow && state.inHand && !state.attacking && !state.boltOn;
}

/**
 * Whether two buttons let go count as let go at once (ActionDualRelease): both were held
 * together (each went down before the other came up), and they came up within `chord` seconds
 * of each other. Times are one clock's seconds.
 */
export function releasedTogether(
  first: { readonly down: number; readonly up: number },
  second: { readonly down: number; readonly up: number },
  chord: number,
): boolean {
  const heldTogether = first.down <= second.up && second.down <= first.up;
  return heldTogether && Math.abs(first.up - second.up) <= chord;
}

/**
 * Whether a blocking actor anticipates a blow (ActionBlockAnticipate): it blocks, a blow comes
 * at it, and that blow is not the one it anticipated last (each blow once).
 */
export function anticipatesBlow(
  blocking: boolean,
  blow: object | undefined,
  anticipated: object | undefined,
): boolean {
  return blocking && blow !== undefined && blow !== anticipated;
}
