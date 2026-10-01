import { useState } from "react";

/** Rows a long list shows at first, and how many more each tap reveals. */
const FIRST = 10;
const STEP = 40;
/** A list only this much longer than its limit shows whole, rather than hiding a row or two. */
const LEEWAY = 3;

/** Rows revealed in each list, kept while the app is open so that coming back finds a list as it was left. */
const revealed = new Map<string, number>();

/**
 * The rows of a long list to show for now, how many are hidden, and how many the next "show more"
 * reveals (see ShowMore). `id` names the list, so how far it was opened is remembered.
 */
export function usePaged<T>(id: string, items: T[]) {
  const [limit, setLimit] = useState(() => revealed.get(id) ?? FIRST);
  const shown = items.length <= limit + LEEWAY ? items : items.slice(0, limit);
  const hidden = items.length - shown.length;
  const more = () => {
    revealed.set(id, limit + STEP);
    setLimit(limit + STEP);
  };
  return { shown, hidden, next: hidden <= STEP + LEEWAY ? hidden : STEP, more };
}
