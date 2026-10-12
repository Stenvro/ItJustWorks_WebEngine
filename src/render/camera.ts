// Orbit camera for the model viewer: drag to rotate, right-drag or shift-drag to pan,
// wheel to zoom. Idles with a slow turn until the user takes over.

import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from './math.ts';

export interface OrbitView {
  /** World up axis. Skyrim is Z-up; some interface meshes are authored Y-up. */
  readonly up?: 'z' | 'y';
  readonly yaw?: number;
  readonly pitch?: number;
  /** Degrees per second while idle; 0 disables. */
  readonly idleSpin?: number;
  /** Instead of spinning: sway the yaw this many degrees either way while idle. */
  readonly idleSway?: number;
  /**
   * Limits how far the user may orbit away from the initial yaw/pitch, in degrees. For
   * meshes that are only meant to be seen from the front (the main menu logo is a shell).
   */
  readonly yawLimit?: number;
  readonly pitchLimit?: number;
}

const MIN_PITCH = -1.5;
const MAX_PITCH = 1.5;

export class OrbitCamera {
  fovY = (55 * Math.PI) / 180;
  yaw = 0;
  pitch = 0.25;
  distance = 200;
  target: [number, number, number] = [0, 0, 0];
  /**
   * Horizontal shift of the image in normalized device coordinates (−1..1), to centre the
   * subject in the part of the screen not covered by UI.
   */
  lensShift = 0;
  #up: 'z' | 'y' = 'z';
  #idleSpin = 0;
  #idleSway = 0;
  #baseYaw = 0;
  #basePitch = 0;
  #yawLimit = Infinity;
  #pitchLimit = Infinity;
  #idleTime = 0;
  #interacted = false;
  #near = 1;

  /** Sets the viewing direction and idle behaviour; the user regains a fresh idle state. */
  setView(view: OrbitView): void {
    const radians = (degrees: number | undefined, fallback: number): number =>
      degrees === undefined ? fallback : (degrees * Math.PI) / 180;
    this.#up = view.up ?? 'z';
    this.yaw = this.#baseYaw = view.yaw ?? 0;
    this.pitch = this.#basePitch = view.pitch ?? 0.25;
    this.#idleSpin = view.idleSpin ?? 0;
    this.#idleSway = radians(view.idleSway, 0);
    this.#yawLimit = radians(view.yawLimit, Infinity);
    this.#pitchLimit = radians(view.pitchLimit, Infinity);
    this.#idleTime = 0;
    this.#interacted = false;
  }

  /** Rotates by the given amounts, respecting the view's limits. */
  #rotate(deltaYaw: number, deltaPitch: number): void {
    const clamp = (value: number, min: number, max: number): number =>
      Math.min(max, Math.max(min, value));
    this.yaw = clamp(
      this.yaw + deltaYaw,
      this.#baseYaw - this.#yawLimit,
      this.#baseYaw + this.#yawLimit,
    );
    this.pitch = clamp(
      this.pitch + deltaPitch,
      Math.max(MIN_PITCH, this.#basePitch - this.#pitchLimit),
      Math.min(MAX_PITCH, this.#basePitch + this.#pitchLimit),
    );
  }

  /** Frames a bounding sphere. */
  fit(center: readonly [number, number, number], radius: number): void {
    this.target = [center[0], center[1], center[2]];
    const safeRadius = Math.max(radius, 1);
    this.distance = (safeRadius / Math.sin(this.fovY / 2)) * 1.1;
    this.#near = Math.max(0.5, safeRadius / 200);
  }

  /** Near plane: scaled with the model, so small and huge models both fit. */
  get near(): number {
    return this.#near;
  }

  get upVector(): Vec3 {
    return this.#up === 'z' ? [0, 0, 1] : [0, 1, 0];
  }

  get position(): Vec3 {
    const c = Math.cos(this.pitch);
    const [x, y, z] = this.target;
    const d = this.distance;
    return this.#up === 'z'
      ? [
          x + d * c * Math.sin(this.yaw),
          y + d * c * Math.cos(this.yaw),
          z + d * Math.sin(this.pitch),
        ]
      : [
          x + d * c * Math.sin(this.yaw),
          y + d * Math.sin(this.pitch),
          z + d * c * Math.cos(this.yaw),
        ];
  }

  update(deltaSeconds: number): void {
    if (this.#interacted) return;
    this.#idleTime += deltaSeconds;
    if (this.#idleSway !== 0) {
      this.yaw = this.#baseYaw + this.#idleSway * Math.sin(this.#idleTime * 0.35);
    } else if (this.#idleSpin !== 0) {
      this.yaw += ((this.#idleSpin * Math.PI) / 180) * deltaSeconds;
    }
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const up: Vec3 = this.#up === 'z' ? [0, 0, 1] : [0, 1, 0];
    const view = lookAt(this.position, this.target, up);
    const projection = perspectiveReversedZ(this.fovY, aspect, this.#near);
    // x_clip gains shift·z_view; dividing by w = −z_view moves the image by −shift.
    projection[8] = -this.lensShift;
    return multiply(projection, view, out);
  }

  /** Listens to pointer and wheel input on `element`. Returns a function that detaches. */
  attach(element: HTMLElement): () => void {
    let dragging: { x: number; y: number; pan: boolean } | undefined;

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0 && event.button !== 2) return;
      this.#interacted = true;
      dragging = { x: event.clientX, y: event.clientY, pan: event.button === 2 || event.shiftKey };
      element.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent): void => {
      if (!dragging) return;
      const dx = event.clientX - dragging.x;
      const dy = event.clientY - dragging.y;
      dragging.x = event.clientX;
      dragging.y = event.clientY;
      if (dragging.pan) {
        this.#pan(dx, dy, element.clientHeight);
      } else {
        this.#rotate(-dx * 0.006, dy * 0.006);
      }
    };
    const onUp = (event: PointerEvent): void => {
      dragging = undefined;
      if (element.hasPointerCapture(event.pointerId))
        element.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      this.#interacted = true;
      this.distance = Math.max(1, this.distance * Math.exp(event.deltaY * 0.001));
    };
    const onContextMenu = (event: Event): void => {
      event.preventDefault();
    };

    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('contextmenu', onContextMenu);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('contextmenu', onContextMenu);
    };
  }

  /** Moves the target in the camera's screen plane. */
  #pan(dx: number, dy: number, viewportHeight: number): void {
    const scale = (2 * this.distance * Math.tan(this.fovY / 2)) / Math.max(1, viewportHeight);
    const eye = this.position;
    const forward = [this.target[0] - eye[0], this.target[1] - eye[1], this.target[2] - eye[2]];
    const up = this.#up === 'z' ? [0, 0, 1] : [0, 1, 0];
    const right = [
      (forward[1] ?? 0) * (up[2] ?? 0) - (forward[2] ?? 0) * (up[1] ?? 0),
      (forward[2] ?? 0) * (up[0] ?? 0) - (forward[0] ?? 0) * (up[2] ?? 0),
      (forward[0] ?? 0) * (up[1] ?? 0) - (forward[1] ?? 0) * (up[0] ?? 0),
    ];
    const length = Math.hypot(right[0] ?? 0, right[1] ?? 0, right[2] ?? 0) || 1;
    for (let k = 0; k < 3; k++) {
      this.target[k] =
        (this.target[k] ?? 0) - ((right[k] ?? 0) / length) * dx * scale + (up[k] ?? 0) * dy * scale;
    }
  }
}
