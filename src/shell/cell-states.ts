// The quest and scene states of a cell in the dev panel (its enable-parent markers that quests
// and scenes switch: "Cicero Moves In", a dragon attack's aftermath), the same for interiors
// and for the exterior cell the player is in.

import type { CellToggle } from '../world/cell-upgrades.ts';

/** A checkbox row of the panel's lists. */
export function checkboxRow(
  text: string,
  checked: boolean,
  onChange: (on: boolean) => void,
  title = '',
): HTMLLIElement {
  const item = document.createElement('li');
  const label = document.createElement('label');
  label.className = 'toggle';
  label.title = title;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => {
    onChange(input.checked);
  });
  label.append(input, text);
  item.append(label);
  return item;
}

/**
 * The folded list of a cell's states: `selection` is which are on, `onChange` gets the new
 * selection; `open` and `onToggle` keep the fold as the user left it.
 */
export function cellStatesElement(
  toggles: readonly CellToggle[],
  selection: ReadonlySet<number>,
  onChange: (selection: Set<number>) => void,
  open: boolean,
  onToggle: (open: boolean) => void,
  heading = 'quest & scene states',
): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'cell-states';
  details.open = open;
  details.addEventListener('toggle', () => {
    onToggle(details.open);
  });
  const summary = document.createElement('summary');
  summary.textContent = `${heading} (${String(toggles.length)})`;
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = 'Set by quests and scenes, not by the player. Shown as a new game has them.';
  const list = document.createElement('ul');
  list.className = 'upgrade-list';
  for (const toggle of toggles) {
    list.append(
      checkboxRow(
        toggle.label,
        selection.has(toggle.formId),
        (on) => {
          const next = new Set(selection);
          if (on) next.add(toggle.formId);
          else next.delete(toggle.formId);
          onChange(next);
        },
        toggle.editorId,
      ),
    );
  }
  details.append(summary, note, list);
  return details;
}
