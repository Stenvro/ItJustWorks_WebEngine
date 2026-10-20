// Combat groups (CommonLibSSE CombatGroup; docs/ai.md, "Combat AI"): the actors that fight
// together, allies on the same side. An actor that enters combat joins the group of an ally
// already fighting (one it would help: its assistance), else starts one; the group shares what
// its members know of their targets (where each was seen last: a target one member sees, all
// know where it is), weighs its strength against its targets' (the threat ratio that moves its
// members' confidence) and counts who fights whom (the style's group offensive mult, and
// GetCombatGroupMemberCount). An actor leaves its group as its combat ends; an empty group goes.
// Platform-independent.

type Vec3 = readonly [number, number, number];

/** What a group knows of a target. */
export interface GroupTarget {
  /** Where a member saw it last, and when (seconds). */
  at: Vec3 | undefined;
  seen: number;
}

export interface CombatGroup {
  readonly id: number;
  readonly members: Set<number>;
  readonly targets: Map<number, GroupTarget>;
}

export class CombatGroups {
  readonly #groups = new Map<number, CombatGroup>();
  readonly #of = new Map<number, CombatGroup>();
  #next = 1;

  /**
   * An actor fights: it joins the group of the first in `allies` already in one (those it
   * fights beside), else a new one. Returns its group.
   */
  join(actor: number, allies: Iterable<number>): CombatGroup {
    const own = this.#of.get(actor);
    if (own) return own;
    for (const ally of allies) {
      const group = this.#of.get(ally);
      if (!group) continue;
      group.members.add(actor);
      this.#of.set(actor, group);
      return group;
    }
    const group: CombatGroup = { id: this.#next++, members: new Set([actor]), targets: new Map() };
    this.#groups.set(group.id, group);
    this.#of.set(actor, group);
    return group;
  }

  /** An actor's combat ended (or it left the loaded area): it leaves its group. */
  leave(actor: number): void {
    const group = this.#of.get(actor);
    if (!group) return;
    this.#of.delete(actor);
    group.members.delete(actor);
    if (group.members.size === 0) this.#groups.delete(group.id);
  }

  /** A target is gone (dead, left): no group fights it any more. */
  forget(target: number): void {
    for (const group of this.#groups.values()) group.targets.delete(target);
  }

  groupOf(actor: number): CombatGroup | undefined {
    return this.#of.get(actor);
  }

  /** The others of an actor's group. */
  *allies(actor: number): Iterable<number> {
    const group = this.#of.get(actor);
    if (!group) return;
    for (const member of group.members) if (member !== actor) yield member;
  }

  /** How many are in an actor's group (GetCombatGroupMemberCount; 0: none). */
  size(actor: number): number {
    return this.#of.get(actor)?.members.size ?? 0;
  }

  /** A member saw a target at a place (now: seconds): its group knows. */
  saw(actor: number, target: number, at: Vec3, now: number): void {
    const group = this.#of.get(actor);
    if (!group) return;
    group.targets.set(target, { at, seen: now });
  }

  /** Where an actor's group last saw a target, and when (undefined: it has not). */
  lastSeen(actor: number, target: number): GroupTarget | undefined {
    return this.#of.get(actor)?.targets.get(target);
  }

  *groups(): Iterable<CombatGroup> {
    yield* this.#groups.values();
  }

  clear(): void {
    this.#groups.clear();
    this.#of.clear();
  }
}
