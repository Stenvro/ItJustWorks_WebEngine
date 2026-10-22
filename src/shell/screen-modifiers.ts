// The session's image-space modifiers (IMAD): what scripts (ImageSpaceModifier.Apply, ...)
// and the shell (the menus' ISMTween, low health) put on the screen by form id, loaded from
// the records, running in real time and laid over the viewers' imagespace each frame (the
// weather's in exteriors, the cell's indoors). The modifiers themselves:
// src/world/image-space-modifiers.ts.

import { NEUTRAL_IMAGE_SPACE, type ImageSpace } from '../world/image-space.ts';
import { parseImageSpaceModifier, type ImageSpaceModifier } from '../world/image-space-modifier.ts';
import {
  ImageSpaceModifiers,
  type ActiveModifier,
  type ApplyOptions,
  type ModifierView,
} from '../world/image-space-modifiers.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import type { Terminal } from './terminal.ts';

/** The longest step the timelines take at once (a frame after the tab was hidden). */
const MAX_STEP_SECONDS = 0.25;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ScreenModifiers {
  readonly #db: Promise<RecordDatabase>;
  readonly #terminal: Terminal;
  readonly #stack = new ImageSpaceModifiers();
  readonly #records = new Map<number, Promise<ImageSpaceModifier | undefined>>();
  /** Requests run in order (a Remove after an Apply waits for the Apply's record). */
  #queue: Promise<void> = Promise.resolve();
  #last: number | undefined;

  constructor(db: Promise<RecordDatabase>, terminal: Terminal) {
    this.#db = db;
    this.#terminal = terminal;
  }

  /** The view the screen is seen from (modifiers that aim at their target: an explosion). */
  view: (() => ModifierView | undefined) | undefined;

  /** Shows a modifier at a strength (ImageSpaceModifier.Apply). */
  apply(formId: number, strength = 1, options: ApplyOptions = {}): Promise<void> {
    return this.#run(formId, (modifier) => {
      this.#stack.apply(modifier, strength, options);
    });
  }

  /** Takes a modifier off at once (ImageSpaceModifier.Remove). */
  remove(formId: number): Promise<void> {
    return this.#enqueue(() => {
      this.#stack.remove(formId);
    });
  }

  /** Cross-fades to a modifier over `seconds` (ImageSpaceModifier.ApplyCrossFade). */
  crossFade(formId: number, seconds = 1): Promise<void> {
    return this.#run(formId, (modifier) => {
      this.#stack.applyCrossFade(modifier, seconds);
    });
  }

  /** Fades the cross-fade chain's last modifier out (ImageSpaceModifier.RemoveCrossFade). */
  removeCrossFade(seconds = 1): Promise<void> {
    return this.#enqueue(() => {
      this.#stack.removeCrossFade(seconds);
    });
  }

  /** Takes `from` off and shows `to` at once (ImageSpaceModifier.PopTo). */
  popTo(from: number, to: number, strength = 1): Promise<void> {
    return this.#run(to, (modifier) => {
      this.#stack.popTo(from, modifier, strength);
    });
  }

  /** Takes every modifier off (a new game, another world). */
  clear(): Promise<void> {
    return this.#enqueue(() => {
      this.#stack.clear();
    });
  }

  isActive(formId: number): boolean {
    return this.#stack.isActive(formId);
  }

  get active(): readonly ActiveModifier[] {
    return this.#stack.active;
  }

  /**
   * The imagespace with the modifiers laid over it; advances their timelines to `now`
   * (milliseconds). Without modifiers the imagespace itself.
   */
  imageSpace(base: ImageSpace | undefined, now = performance.now()): ImageSpace | undefined {
    const seconds = this.#last === undefined ? 0 : Math.max(0, (now - this.#last) / 1000);
    this.#last = now;
    this.#stack.advance(Math.min(MAX_STEP_SECONDS, seconds));
    if (this.#stack.empty) return base;
    return this.#stack.modify(base ?? NEUTRAL_IMAGE_SPACE, this.view?.());
  }

  #enqueue(work: () => void | Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(work).catch((error: unknown) => {
      this.#terminal.log('imagespace', describe(error), 'warn');
    });
    return this.#queue;
  }

  /** Runs `work` with the modifier once its record is loaded (logged if it is not one). */
  #run(formId: number, work: (modifier: ImageSpaceModifier) => void): Promise<void> {
    return this.#enqueue(async () => {
      const modifier = await this.#load(formId);
      if (modifier) work(modifier);
      else
        this.#terminal.log(
          'imagespace',
          `${formId.toString(16).padStart(8, '0')} is not an image-space modifier`,
          'warn',
        );
    });
  }

  #load(formId: number): Promise<ImageSpaceModifier | undefined> {
    let pending = this.#records.get(formId);
    if (!pending) {
      pending = this.#db
        .then((db) => db.get(formId))
        .then((record) =>
          record?.type === 'IMAD' && !record.deleted ? parseImageSpaceModifier(record) : undefined,
        );
      this.#records.set(formId, pending);
    }
    return pending;
  }
}
