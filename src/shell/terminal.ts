// Shell system log: timestamped lines that are quickly "typed out". The engine logs through the
// Terminal interface; the page's list is one of its logs.

export type LogTone = 'info' | 'ok' | 'warn' | 'error';

/** Characters per frame while typing out; high enough to never slow things down. */
const CHARS_PER_FRAME = 7;
const MAX_LINES = 400;
/** Warning and error lines kept for the QA harness (docs/qa.md): the latest so many. */
const MAX_PROBLEMS = 5000;

/** A warning or error line as it was logged (`at`: performance.now()). */
export interface LoggedProblem {
  readonly at: number;
  readonly tag: string;
  readonly text: string;
  readonly tone: 'warn' | 'error';
}

interface PendingLine {
  readonly element: HTMLElement;
  readonly text: string;
  shown: number;
}

/**
 * Where the engine logs what it does: a tag (the system), the text and its tone. The page's log
 * (DomTerminal) is one; the headless simulation keeps its lines (src/sim/sim-log.ts).
 */
export interface Terminal {
  log(tag: string, text: string, tone?: LogTone): void;
  /**
   * The warning and error lines logged so far (the latest MAX_PROBLEMS): the QA harness reports
   * those of the boot (a new game's or a coc's quest starts) too.
   */
  readonly problems: readonly LoggedProblem[];
}

/** Keeps a logged line in `problems` if it is a warning or an error (the latest MAX_PROBLEMS). */
export function keepProblem(
  problems: LoggedProblem[],
  tag: string,
  text: string,
  tone: LogTone,
): void {
  if (tone !== 'warn' && tone !== 'error') return;
  problems.push({ at: performance.now(), tag, text, tone });
  if (problems.length > MAX_PROBLEMS) problems.shift();
}

/** The page's log: its lines typed out into a list element. */
export class DomTerminal implements Terminal {
  readonly #list: HTMLElement;
  readonly #start = performance.now();
  readonly #queue: PendingLine[] = [];
  readonly #instant: boolean;
  #animating = false;
  readonly problems: LoggedProblem[] = [];

  constructor(list: HTMLElement) {
    this.#list = list;
    this.#instant = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  log(tag: string, text: string, tone: LogTone = 'info'): void {
    keepProblem(this.problems, tag, text, tone);
    const seconds = ((performance.now() - this.#start) / 1000).toFixed(3).padStart(8, ' ');
    const line = document.createElement('li');
    line.className = `log-line tone-${tone}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = `[${seconds}]`;
    const label = document.createElement('span');
    label.className = 'log-tag';
    label.textContent = tag;
    const body = document.createElement('span');
    body.className = 'log-text';
    line.append(time, label, body);
    this.#list.append(line);
    while (this.#list.childElementCount > MAX_LINES) this.#list.firstElementChild?.remove();

    if (this.#instant || document.visibilityState === 'hidden') {
      body.textContent = text;
    } else {
      this.#queue.push({ element: body, text, shown: 0 });
      this.#animate();
    }
    this.#list.scrollTop = this.#list.scrollHeight;
  }

  #animate(): void {
    if (this.#animating) return;
    this.#animating = true;
    const step = (): void => {
      let budget = CHARS_PER_FRAME * Math.max(1, Math.ceil(this.#queue.length / 4));
      while (budget > 0 && this.#queue.length > 0) {
        const line = this.#queue[0];
        if (!line) break;
        const take = Math.min(budget, line.text.length - line.shown);
        line.shown += take;
        budget -= take;
        line.element.textContent = line.text.slice(0, line.shown);
        if (line.shown >= line.text.length) this.#queue.shift();
      }
      this.#list.scrollTop = this.#list.scrollHeight;
      if (this.#queue.length > 0) {
        requestAnimationFrame(step);
      } else {
        this.#animating = false;
      }
    };
    requestAnimationFrame(step);
  }
}
