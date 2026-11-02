// Streaming work spread over frames. What a newly loaded cell costs the main thread (its scene's
// uniforms and bind groups, its models' buffers, its textures' uploads, its terrain, navmesh and
// decals) comes in steps between `await`s; before each heavy step the work awaits frameTurn(),
// and turns are given out between frames, one step at a time, until the frame's share
// (BUDGET_MS) is spent; the rest waits for the next frame. The original streams cells the same
// way, over several frames, instead of holding one frame until a cell is attached.
//
// A step's time is measured from its turn to the next turn given (the macrotask after it: its
// continuation runs in the microtasks before), so whatever else ran meanwhile counts too. Without
// a render loop (the headless simulation, a tool) or with no frame for STALE_MS (a hidden tab),
// turns are given at once, and while the world is behind a loading screen (setFrameWorkRush)
// there is no frame to keep smooth: the work runs as fast as it comes.
// Notes: docs/rendering.md ("Frame budget").

/** Milliseconds a frame gives streaming work. */
export const FRAME_WORK_BUDGET_MS = 4;
/** Without a frame for this long, turns are given at once (ms). */
const STALE_MS = 250;

let frameEnd: number | undefined;
let spent = 0;
let rush = false;
/** When the last turn was given (its step runs until the next pump). */
let granted: number | undefined;
let scheduled = false;
const waiting: (() => void)[] = [];
let channel: MessageChannel | undefined;

function open(now: number): boolean {
  return (
    rush || frameEnd === undefined || now - frameEnd > STALE_MS || spent < FRAME_WORK_BUDGET_MS
  );
}

function pump(): void {
  scheduled = false;
  const now = performance.now();
  if (granted !== undefined) {
    spent += now - granted;
    granted = undefined;
  }
  if (waiting.length === 0 || !open(now)) return;
  const next = waiting.shift();
  granted = now;
  next?.();
  post();
}

/** Runs the pump as a task of its own (after the microtasks of the step just given its turn). */
function post(): void {
  if (scheduled) return;
  scheduled = true;
  if (typeof MessageChannel !== 'function') {
    setTimeout(pump, 0);
    return;
  }
  // Made on first use: a port listening keeps a Node process alive.
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = pump;
  }
  channel.port2.postMessage(0);
}

/** Resolves when this frame has time left for a step of streaming work (at once without frames). */
export function frameTurn(): Promise<void> {
  if (frameEnd === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    waiting.push(resolve);
    post();
  });
}

/** The render loop drew a frame: the work until the next one gets its share. */
export function frameWorkFrameEnded(): void {
  frameEnd = performance.now();
  spent = 0;
  if (waiting.length > 0) post();
}

/** Behind a loading screen (true) the work is not held back: no frame needs to stay smooth. */
export function setFrameWorkRush(on: boolean): void {
  rush = on;
  if (on && waiting.length > 0) post();
}

/** Steps waiting for a turn (the streaming's backlog, for the debug overlay and tests). */
export function frameWorkWaiting(): number {
  return waiting.length;
}
