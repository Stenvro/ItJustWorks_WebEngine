// Shell system log: timestamped lines that are quickly "typed out".

export type LogTone = 'info' | 'ok' | 'warn' | 'error';

/** Characters per frame while typing out; high enough to never slow things down. */
const CHARS_PER_FRAME = 7;
const MAX_LINES = 400;

interface PendingLine {
  readonly element: HTMLElement;
  readonly text: string;
  shown: number;
}

export class Terminal {
  readonly #list: HTMLElement;
  readonly #start = performance.now();
  readonly #queue: PendingLine[] = [];
  readonly #instant: boolean;
  #animating = false;

  constructor(list: HTMLElement) {
    this.#list = list;
    this.#instant = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  log(tag: string, text: string, tone: LogTone = 'info'): void {
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
