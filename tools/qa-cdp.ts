// A small Chrome DevTools Protocol client for the QA scenario runner (tools/qa-run.ts): one
// browser connection, pages attached as flat sessions, calls with timeouts (a hung page must
// not hang the runner), and the Chrome and Vite processes it starts and stops.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message: string };
}

export class CdpTimeout extends Error {}

/** One browser-level CDP connection. */
export class Cdp {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<
    string,
    Set<(params: Record<string, unknown>, sessionId?: string) => void>
  >();
  #next = 0;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (message.method) {
        for (const listener of this.#listeners.get(message.method) ?? [])
          listener(message.params ?? {}, message.sessionId);
      }
    });
    socket.addEventListener('close', () => {
      this.#closed = true;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('the browser connection closed'));
      }
      this.#pending.clear();
    });
  }

  static async connect(port: number): Promise<Cdp> {
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('cannot connect to the browser'));
      });
    });
    return new Cdp(socket);
  }

  get closed(): boolean {
    return this.#closed;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30000,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('the browser connection is closed'));
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpTimeout(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.#socket.send(
        JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
      );
    });
  }

  on(
    method: string,
    listener: (params: Record<string, unknown>, sessionId?: string) => void,
  ): () => void {
    let set = this.#listeners.get(method);
    if (!set) {
      set = new Set();
      this.#listeners.set(method, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  close(): void {
    this.#socket.close();
  }
}

/** A page (tab) attached as a flat session. */
export class Page {
  readonly cdp: Cdp;
  readonly targetId: string;
  readonly sessionId: string;

  private constructor(cdp: Cdp, targetId: string, sessionId: string) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  /** A new tab at about:blank, sized, focused and never throttled as hidden. */
  static async open(cdp: Cdp, width: number, height: number): Promise<Page> {
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
      width,
      height,
    });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = new Page(cdp, targetId, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // A focused page: rAF at full rate, the game's keys, no background throttling. Emulated only
    // (no Page.bringToFront): the desktop's own focus stays with whoever uses it.
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // A game running asks before the page goes (beforeunload): accepted.
    cdp.on('Page.javascriptDialogOpening', (_params, session) => {
      if (session === sessionId)
        void page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
    });
    return page;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30000,
  ): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId, timeoutMs);
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    return this.cdp.on(method, (params, session) => {
      if (session === this.sessionId) listener(params);
    });
  }

  /**
   * Evaluates an expression in the page (awaited, returned by value). `repl`: as a console line
   * (private fields of the engine's classes are readable in top-level statements).
   */
  async eval<T = unknown>(expression: string, timeoutMs = 30000, repl = false): Promise<T> {
    const result = await this.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      'Runtime.evaluate',
      repl
        ? { expression, awaitPromise: true, returnByValue: true, replMode: true }
        : {
            expression: `(async () => (${expression}))()`,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description ?? details.text ?? 'evaluation failed');
    }
    return result.result?.value as T;
  }

  async navigate(url: string): Promise<void> {
    await Promise.race([
      this.send('Page.navigate', { url }),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }

  async click(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await sleep(60);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  /** A key down (and up unless `hold`): `code` like KeyW, Enter, Escape, Backquote. */
  async key(code: string, type: 'press' | 'down' | 'up' = 'press'): Promise<void> {
    const info = keyInfo(code);
    if (type !== 'up')
      await this.send('Input.dispatchKeyEvent', {
        type: info.text ? 'keyDown' : 'rawKeyDown',
        key: info.key,
        code,
        windowsVirtualKeyCode: info.keyCode,
        ...(info.text ? { text: info.text } : {}),
      });
    if (type === 'press') await sleep(60);
    if (type !== 'down')
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: info.key,
        code,
        windowsVirtualKeyCode: info.keyCode,
      });
  }

  /** A screenshot of the viewport (JPEG). */
  async screenshot(file: string, quality = 70): Promise<void> {
    const shot = await this.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality },
      15000,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  }

  async close(): Promise<void> {
    await this.cdp
      .send('Target.closeTarget', { targetId: this.targetId }, undefined, 5000)
      .catch(() => undefined);
  }
}

const NAMED_KEYS: Record<string, { key: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', keyCode: 9 },
  Backquote: { key: '`', keyCode: 192, text: '`' },
  Space: { key: ' ', keyCode: 32, text: ' ' },
  ShiftLeft: { key: 'Shift', keyCode: 16 },
  ArrowUp: { key: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', keyCode: 39 },
};

function keyInfo(code: string): { key: string; keyCode: number; text?: string } {
  const named = NAMED_KEYS[code];
  if (named) return named;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter)
    return { key: letter.toLowerCase(), keyCode: letter.charCodeAt(0), text: letter.toLowerCase() };
  const digit = /^Digit(\d)$/.exec(code)?.[1];
  if (digit) return { key: digit, keyCode: digit.charCodeAt(0), text: digit };
  return { key: code, keyCode: 0 };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Waits until a check returns something other than undefined, or the time is up. */
export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 1000,
): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await sleep(everyMs);
  }
  return undefined;
}

/** Where Chrome is: CHROME_PATH, else the usual install places. */
export function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  throw new Error('Chrome not found: set CHROME_PATH');
}

/**
 * Starts a headless Chrome for the runner: muted (the game's voices must not play on the
 * speakers), WebGPU on, never throttled in the background.
 */
export async function startChrome(options: {
  readonly port: number;
  readonly profile: string;
  readonly width: number;
  readonly height: number;
}): Promise<ChildProcess> {
  fs.mkdirSync(options.profile, { recursive: true });
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      // navigator.webdriver: the page keeps its pointer lock to itself (automation-pointer-lock.ts).
      '--enable-automation',
      '--mute-audio',
      `--remote-debugging-port=${options.port}`,
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${options.width},${options.height}`,
      `--user-data-dir=${options.profile}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    // windowsHide: on Windows a child of a process without a console gets a window of its own.
    { stdio: 'ignore', windowsHide: true },
  );
  const ready = await waitFor(
    async () =>
      (await fetch(`http://127.0.0.1:${options.port}/json/version`)).ok ? true : undefined,
    30000,
    300,
  );
  if (!ready) {
    chrome.kill();
    throw new Error(`Chrome did not open its debugging port ${options.port}`);
  }
  return chrome;
}

/** Starts the repository's Vite dev server on a port and waits until it answers. */
export async function startVite(root: string, port: number): Promise<ChildProcess> {
  const vite = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: root, stdio: 'ignore', windowsHide: true },
  );
  const ready = await waitFor(
    async () => ((await fetch(`http://localhost:${port}/`)).ok ? true : undefined),
    60000,
    500,
  );
  if (!ready) {
    vite.kill();
    throw new Error(`Vite did not answer on port ${port}`);
  }
  return vite;
}

/** Ends a process and its children (Windows keeps the children of a killed process). */
export function stopProcess(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGTERM');
  }
}
