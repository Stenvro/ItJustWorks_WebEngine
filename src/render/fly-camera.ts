// Free-flying camera for cells: click the canvas to capture the mouse (pointer lock), look
// around with the mouse, move with WASD (Q/E or Space/C for down/up), Shift to go faster.
// Esc releases the mouse.

import type { Camera } from './renderer.ts';
import { lookAt, multiply, perspectiveReversedZ, type Mat4, type Vec3 } from './math.ts';

const MAX_PITCH = 1.55;

export class FlyCamera implements Camera {
  fovY = (65 * Math.PI) / 180;
  /** Compass heading in radians: 0 looks along +Y (north), π/2 along +X (east). */
  yaw = 0;
  pitch = 0;
  position: [number, number, number] = [0, 0, 0];
  /** Units per second (Skyrim: 1 unit ≈ 1.43 cm, walking ≈ 100 units/s). */
  speed = 260;
  lensShift = 0;
  /** Near plane (game units). */
  readonly near = 4;
  readonly #keys = new Set<string>();

  get forward(): Vec3 {
    const c = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * c, Math.cos(this.yaw) * c, Math.sin(this.pitch)];
  }

  /** Points the camera at a world position. */
  lookAtPoint(target: Vec3): void {
    const dx = target[0] - this.position[0];
    const dy = target[1] - this.position[1];
    const dz = target[2] - this.position[2];
    this.yaw = Math.atan2(dx, dy);
    this.pitch = Math.atan2(dz, Math.hypot(dx, dy));
  }

  update(deltaSeconds: number): void {
    const fast = this.#keys.has('shift') ? 3 : 1;
    const step = this.speed * fast * deltaSeconds;
    const forward = this.forward;
    const right: Vec3 = [Math.cos(this.yaw), -Math.sin(this.yaw), 0];
    const move = (axis: Vec3, amount: number): void => {
      for (let k = 0; k < 3; k++)
        this.position[k] = (this.position[k] ?? 0) + (axis[k] ?? 0) * amount;
    };
    if (this.#keys.has('w')) move(forward, step);
    if (this.#keys.has('s')) move(forward, -step);
    if (this.#keys.has('d')) move(right, step);
    if (this.#keys.has('a')) move(right, -step);
    if (this.#keys.has('e') || this.#keys.has(' ')) move([0, 0, 1], step);
    if (this.#keys.has('q') || this.#keys.has('c')) move([0, 0, 1], -step);
  }

  viewProjection(aspect: number, out: Mat4 = new Float32Array(16)): Mat4 {
    const forward = this.forward;
    const target: Vec3 = [
      this.position[0] + forward[0],
      this.position[1] + forward[1],
      this.position[2] + forward[2],
    ];
    const view = lookAt(this.position, target, [0, 0, 1]);
    const projection = perspectiveReversedZ(this.fovY, aspect, this.near);
    projection[8] = -this.lensShift;
    return multiply(projection, view, out);
  }

  /** Listens to mouse and keyboard; returns a function that detaches. */
  attach(element: HTMLElement): () => void {
    const typing = (target: EventTarget | null): boolean =>
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    const onDown = (event: MouseEvent): void => {
      if (event.button === 0 && document.pointerLockElement !== element) {
        element.requestPointerLock().catch(() => undefined);
      }
    };
    const onMove = (event: MouseEvent): void => {
      if (document.pointerLockElement !== element) return;
      this.yaw += event.movementX * 0.0025;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch - event.movementY * 0.0025));
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (typing(event.target)) return;
      this.#keys.add(event.key.toLowerCase());
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      this.#keys.delete(event.key.toLowerCase());
    };
    const onBlur = (): void => {
      this.#keys.clear();
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      this.speed = Math.max(20, Math.min(5000, this.speed * Math.exp(-event.deltaY * 0.001)));
    };
    element.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      element.removeEventListener('wheel', onWheel);
      this.#keys.clear();
    };
  }
}
