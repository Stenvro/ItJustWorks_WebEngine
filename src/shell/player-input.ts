// The player's keyboard and mouse: keys and buttons by the control map's bindings, mouse
// look and the wheel, while the canvas holds the pointer (a click takes it, Esc lets go).

import { MouseInput } from '../formats/controlmap/controlmap.ts';
import type { Player } from './player.ts';

/** Listens to keyboard and mouse for the player; returns a function that detaches. */
export function attachPlayerInput(player: Player, element: HTMLElement): () => void {
  const typing = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  const press = (events: readonly string[] | undefined, down: boolean): void => {
    for (const name of events ?? []) player.press(name, down);
  };
  const locked = (): boolean => document.pointerLockElement === element;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (typing(event.target) || !locked()) return;
    const events = player.eventsOfKey(event.code);
    if (events) {
      event.preventDefault();
      press(events, true);
    }
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    press(player.eventsOfKey(event.code), false);
  };
  const onMouseDown = (event: MouseEvent): void => {
    if (!locked()) {
      if (event.button === 0) element.requestPointerLock().catch(() => undefined);
      return;
    }
    press(player.eventsOfMouse(event.button), true);
  };
  const onMouseUp = (event: MouseEvent): void => {
    press(player.eventsOfMouse(event.button), false);
  };
  const onMove = (event: MouseEvent): void => {
    if (locked()) player.look(event.movementX, event.movementY);
  };
  const onWheel = (event: WheelEvent): void => {
    if (!locked()) return;
    event.preventDefault();
    const zoomIn = event.deltaY < 0;
    const events = player.eventsOfMouse(zoomIn ? MouseInput.wheelUp : MouseInput.wheelDown);
    press(events, true);
    press(events, false);
    player.zoom(zoomIn);
  };
  const onBlur = (): void => {
    player.releaseAll();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  element.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  document.addEventListener('mousemove', onMove);
  element.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    element.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('mousemove', onMove);
    element.removeEventListener('wheel', onWheel);
    window.removeEventListener('blur', onBlur);
    player.releaseAll();
  };
}
