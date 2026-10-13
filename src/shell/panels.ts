// Collapsible shell panels: remembers which panels are open (per browser) and lets the
// H key hide the whole shell for an unobstructed view of the scene.

const STORAGE_KEY = 'itjustworks.panels';

function loadState(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveState(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage may be unavailable (private mode); panels then simply start open.
  }
}

/** Restores and tracks the open state of every `<details data-panel>` in `root`. */
export function setupPanels(root: ParentNode): void {
  const state = loadState();
  for (const panel of root.querySelectorAll<HTMLDetailsElement>('details[data-panel]')) {
    const key = panel.dataset.panel ?? '';
    const saved = state[key];
    if (saved !== undefined) panel.open = saved;
    panel.addEventListener('toggle', () => {
      state[key] = panel.open;
      saveState(state);
    });
  }
}

/** Forgets which panels were open (a first visit again). */
export function forgetPanels(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored then.
  }
}

/** H toggles the shell's panels (not while typing in a field). */
export function setupHideShortcut(panels: readonly HTMLElement[]): void {
  window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'h' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    for (const panel of panels) panel.classList.toggle('shell-hidden');
  });
}
