// The tween menu's camera (CommonLibSSE-NG TweenMenuCameraState: the rotation and field of view
// it started from, an added rotation and an added field of view, each eased toward a target,
// and whether it is ending). The view stays the one the menu opened over (first or third
// person: mods that track the state keep the state before it, SmoothCam,
// TrueDirectionalMovement); it zooms in by [Camera] fTweenCamZoomFOVMod degrees at
// fTweenCamZoomSpeed degrees a second, and leans fTweenCamRotAngle radians toward the
// highlighted choice (Skills up, Magic left, Items right, Map down) at fTweenCamRotSpeed;
// closing, both go back at fTweenCamRotClosingSpeed. The easing (exponential toward the
// target, linear for the zoom), the zoom's sign and the directions' signs are inferred from the
// settings' names: TODO(M13): check against the game. Real time: the game stands still in the
// menu. Platform-independent. Notes: docs/ui.md ("The game's menus in play").

export interface TweenCameraSettings {
  /** fTweenCamRotAngle: radians the view leans toward the highlighted choice. */
  readonly rotAngle: number;
  /** fTweenCamRotSpeed: how fast it leans (per second). */
  readonly rotSpeed: number;
  /** fTweenCamRotClosingSpeed: how fast it comes back as the menu closes (per second). */
  readonly closingSpeed: number;
  /** fTweenCamZoomFOVMod: degrees the field of view narrows. */
  readonly fovMod: number;
  /** fTweenCamZoomSpeed: degrees a second. */
  readonly zoomSpeed: number;
}

/** The tween menu's choices (its OpenHighlightedMenu indices): 1 up .. 4 down. */
const LEAN: Readonly<Record<number, readonly [yaw: number, pitch: number]>> = {
  1: [0, 1],
  2: [-1, 0],
  3: [1, 0],
  4: [0, -1],
};

/** What the camera adds to the player's view now. */
export interface TweenOffset {
  /** Radians added to the yaw (positive: to the right) and to the pitch (positive: up). */
  readonly yaw: number;
  readonly pitch: number;
  /** Degrees added to the field of view (negative: zoomed in). */
  readonly fov: number;
}

export class TweenCamera {
  readonly #settings: TweenCameraSettings;
  #yaw = 0;
  #pitch = 0;
  #fov = 0;
  #targetYaw = 0;
  #targetPitch = 0;
  #targetFov = 0;
  #ending = true;
  #last: number | undefined;

  constructor(settings: TweenCameraSettings) {
    this.#settings = settings;
  }

  /** The menu opened: the view zooms in. */
  open(): void {
    this.#ending = false;
    this.#targetFov = -this.#settings.fovMod;
    this.#targetYaw = 0;
    this.#targetPitch = 0;
  }

  /** A choice highlighted (1 Skills, 2 Magic, 3 Items, 4 Map; else none). */
  highlight(choice: number): void {
    if (this.#ending) return;
    const [yaw, pitch] = LEAN[choice] ?? [0, 0];
    this.#targetYaw = yaw * this.#settings.rotAngle;
    this.#targetPitch = pitch * this.#settings.rotAngle;
  }

  /** The menu closes: the view goes back to where it was. */
  close(): void {
    this.#ending = true;
    this.#targetYaw = 0;
    this.#targetPitch = 0;
    this.#targetFov = 0;
  }

  /** Whether it changes the view (open, or still going back). */
  get active(): boolean {
    return !this.#ending || this.#yaw !== 0 || this.#pitch !== 0 || this.#fov !== 0;
  }

  /** Advances to `now` (milliseconds) and returns what it adds to the view. */
  sample(now: number): TweenOffset {
    const seconds = this.#last === undefined ? 0 : Math.min(0.1, (now - this.#last) / 1000);
    this.#last = this.active ? now : undefined;
    const { rotSpeed, closingSpeed, zoomSpeed } = this.#settings;
    const rate = this.#ending ? closingSpeed : rotSpeed;
    const ease = 1 - Math.exp(-rate * seconds);
    this.#yaw = settle(this.#yaw + (this.#targetYaw - this.#yaw) * ease, this.#targetYaw);
    this.#pitch = settle(this.#pitch + (this.#targetPitch - this.#pitch) * ease, this.#targetPitch);
    const step = zoomSpeed * seconds;
    const gap = this.#targetFov - this.#fov;
    this.#fov = Math.abs(gap) <= step ? this.#targetFov : this.#fov + Math.sign(gap) * step;
    return { yaw: this.#yaw, pitch: this.#pitch, fov: this.#fov };
  }
}

/** Snaps to the target once the rest is too small to see. */
function settle(value: number, target: number): number {
  return Math.abs(value - target) < 1e-5 ? target : value;
}
