// The pointer lock in a browser driven by automation (the QA runner, headless test browsers:
// navigator.webdriver, or HeadlessChrome in the user agent, which plain --headless=new reports
// without setting webdriver). Headless Chrome is a Chrome with hidden windows, and a real pointer
// lock there clips the cursor of whoever uses the desktop to an invisible window. Such a page
// gets a lock of its own instead: pointerLockElement and pointerlockchange behave as with the
// real one, so the game cannot tell them apart.

/** Replaces the pointer lock with a page-only one when the browser is driven by automation. */
export function keepPointerLockInPage(): void {
  if (!navigator.webdriver && !navigator.userAgent.includes('HeadlessChrome')) return;
  let locked: Element | null = null;
  const lock = (element: Element | null): void => {
    if (locked === element) return;
    locked = element;
    queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange')));
  };
  Object.defineProperty(Document.prototype, 'pointerLockElement', {
    configurable: true,
    get: () => locked,
  });
  Element.prototype.requestPointerLock = function (this: Element): Promise<void> {
    lock(this);
    return Promise.resolve();
  };
  Document.prototype.exitPointerLock = function (): void {
    lock(null);
  };
}
