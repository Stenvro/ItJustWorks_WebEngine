// GPU objects let go of while a frame is being recorded wait for that frame's submit. WebGPU
// refuses a submit (and a queue write) that uses a destroyed buffer or texture, and the frame
// itself calls code that may let go of what it is drawing: a menu's 3D view updates in the
// middle of the frame (src/render/menu-overlay.ts), and a menu closed there (the skills menu's
// outro ending, a menu closed by the engine at once) destroys the scenes the frame has already
// listed. Destroying them after the submit is what the frame needs; outside a frame nothing waits.
// Notes: docs/ui.md ("Menus' 3D").

let recording = 0;
let due: (() => void)[] = [];

/** Records a frame (`record` submits it); what is let go of meanwhile is destroyed after it. */
export function recordFrame(record: () => void): void {
  recording++;
  try {
    record();
  } finally {
    recording--;
    if (recording === 0 && due.length > 0) {
      const now = due;
      due = [];
      for (const release of now) release();
    }
  }
}

/** Destroys GPU objects now, or after the frame being recorded is submitted. */
export function releaseAfterFrame(release: () => void): void {
  if (recording > 0) due.push(release);
  else release();
}

/** Whether a frame is being recorded (what is let go of now waits for its submit). */
export function frameRecording(): boolean {
  return recording > 0;
}
