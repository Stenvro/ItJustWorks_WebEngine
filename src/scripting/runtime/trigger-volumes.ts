// Who is inside which trigger volume, and the engine's repeated trigger event (docs/scripting.md,
// "Events"). Observed in the original: a trigger volume tells each reference inside it
// (TESTriggerEvent, the scripts' OnTrigger) as it finds it there, then again once
// fTriggerEventDelayMS ([Havok], 500 ms by default) has passed since it last told any: every
// half second for as long as something stays inside. Entering and leaving are told apart
// (TESTriggerEnterEvent, TESTriggerLeaveEvent: ScriptRuntime.triggered). Platform-independent.

/** [Havok] fTriggerEventDelayMS's built-in default (ms). */
export const TRIGGER_EVENT_DELAY_MS = 500;

interface Volume {
  readonly inside: Set<number>;
  /** Milliseconds since it last told those inside (Infinity: never yet). */
  since: number;
}

export class TriggerVolumes {
  /** fTriggerEventDelayMS: the least time between two tellings of a volume (ms). */
  delayMs = TRIGGER_EVENT_DELAY_MS;
  readonly #volumes = new Map<number, Volume>();

  /** A reference came into a trigger volume. */
  enter(trigger: number, reference: number): void {
    let volume = this.#volumes.get(trigger);
    if (!volume) {
      volume = { inside: new Set(), since: Infinity };
      this.#volumes.set(trigger, volume);
    }
    volume.inside.add(reference);
  }

  /** A reference left a trigger volume. */
  leave(trigger: number, reference: number): void {
    const volume = this.#volumes.get(trigger);
    volume?.inside.delete(reference);
    if (volume?.inside.size === 0) this.#volumes.delete(trigger);
  }

  /** A reference is gone (its cell unloaded): as a volume and as one inside any. */
  forget(reference: number): void {
    this.#volumes.delete(reference);
    for (const [trigger, volume] of this.#volumes) {
      volume.inside.delete(reference);
      if (volume.inside.size === 0) this.#volumes.delete(trigger);
    }
  }

  /** Who is inside a volume now. */
  inside(trigger: number): ReadonlySet<number> {
    return this.#volumes.get(trigger)?.inside ?? new Set();
  }

  /**
   * Real seconds pass: each volume whose delay is over tells everyone inside it (`tell`, one
   * call per reference), and its delay starts again.
   */
  update(seconds: number, tell: (trigger: number, reference: number) => void): void {
    for (const [trigger, volume] of this.#volumes) {
      volume.since += seconds * 1000;
      if (volume.since < this.delayMs) continue;
      volume.since = 0;
      for (const reference of [...volume.inside]) tell(trigger, reference);
    }
  }

  clear(): void {
    this.#volumes.clear();
  }
}
