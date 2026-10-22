// The player's keyboard and mouse: keys and buttons by the control map's bindings, mouse
// look and the wheel, while the canvas holds the pointer (a click takes it, Esc lets go). In
// the game the keys work without it as well (`keysUnlocked`): the browser lets go of the
// pointer on Esc and takes it back only after a click, and the game's keys (Tab, the map,
// moving) must not wait for that click.
//
// A menu's keys are never the player's: nothing is pressed while a menu takes the keys (its
// player focused or not: `menuTakesKeys`), and a key whose press the player did not take (a
// menu's E, held on as the menu closed) does not press by its repeats. A release is always the
// player's (heard first, before the menus' layer takes the event): a key held as a menu opened
// and let go in it (walking forward into a message box) would else stay held, and the player
// walk on by themselves once the menu has closed.

import { MouseInput } from '../formats/controlmap/controlmap.ts';
import type { Player } from './player.ts';

/** Listens to keyboard and mouse for the player; returns a function that detaches. */
export function attachPlayerInput(
  player: Player,
  element: HTMLElement,
  keysUnlocked: () => boolean = () => false,
  menuTakesKeys: () => boolean = () => false,
): () => void {
  const typing = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof Element && target.closest('ruffle-player') !== null);
  const press = (events: readonly string[] | undefined, down: boolean): void => {
    for (const name of events ?? []) player.press(name, down);
  };
  const locked = (): boolean => document.pointerLockElement === element;
  /** The keys (KeyboardEvent.code) whose press the player took, until their release. */
  const down = new Set<string>();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat && !down.has(event.code)) return;
    if (typing(event.target) || menuTakesKeys() || (!locked() && !keysUnlocked())) return;
    const events = player.eventsOfKey(event.code);
    if (events) {
      event.preventDefault();
      down.add(event.code);
      press(events, true);
    }
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    down.delete(event.code);
    const events = player.eventsOfKey(event.code);
    // A game key's release is the game's too: Alt (Sprint) let go would focus the browser's
    // menu button.
    if (events && !typing(event.target)) event.preventDefault();
    press(events, false);
  };
  const onMouseDown = (event: MouseEvent): void => {
    if (menuTakesKeys()) return;
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
    if (!locked() || menuTakesKeys()) return;
    event.preventDefault();
    const zoomIn = event.deltaY < 0;
    const events = player.eventsOfMouse(zoomIn ? MouseInput.wheelUp : MouseInput.wheelDown);
    press(events, true);
    press(events, false);
    player.zoom(zoomIn);
  };
  const onBlur = (): void => {
    down.clear();
    player.releaseAll();
  };
  window.addEventListener('keydown', onKeyDown);
  // Releases in the capture phase: the menus' layer takes the keys it handles from the page.
  window.addEventListener('keyup', onKeyUp, { capture: true });
  element.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp, { capture: true });
  document.addEventListener('mousemove', onMove);
  element.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp, { capture: true });
    element.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp, { capture: true });
    document.removeEventListener('mousemove', onMove);
    element.removeEventListener('wheel', onWheel);
    window.removeEventListener('blur', onBlur);
    player.releaseAll();
  };
}
