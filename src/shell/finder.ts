// The sandbox finders' search: items whose text holds every typed word, listed as buttons.

/** How many matches a finder lists at most. */
export const MAX_RESULTS = 80;

/** The items whose text (lower case) contains every word of the query, the first MAX_RESULTS. */
export function matches<T>(items: readonly T[], text: (item: T) => string, query: string): T[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');
  const found: T[] = [];
  for (const item of items) {
    const haystack = text(item);
    if (terms.every((term) => haystack.includes(term))) {
      found.push(item);
      if (found.length >= MAX_RESULTS) break;
    }
  }
  return found;
}

/** Lists the items as buttons that open them ("no matches" when there are none). */
export function renderResults<T>(
  list: HTMLOListElement,
  items: readonly T[],
  label: (item: T) => string,
  open: (item: T) => void,
): void {
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'no-results';
    empty.textContent = 'no matches';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'result';
      button.textContent = label(item);
      button.title = label(item);
      button.addEventListener('click', () => {
        open(item);
      });
      li.append(button);
      return li;
    }),
  );
}
