/**
 * When does the report form push its draft to the SERVER? (Supervisor's rule, 2026-10-24.)
 * The server draft exists for LARGE texts: losing two or three long sentences hurts, retyping a short note does not. So:
 * the first save waits for ~100 changed characters or ~25 s after typing started; every next save asks for less
 * (70 / 20 s, 45 / 15 s) down to a floor of ~20 characters or ~10 s. Whichever comes first triggers it. Everything else
 * that protects the work is local and costs the server nothing (lib/localDraft.ts); the page also saves when it is hidden.
 */
export interface SaveStep { chars: number; ms: number }

export const SAVE_STEPS: SaveStep[] = [
  { chars: 100, ms: 25_000 },
  { chars: 70, ms: 20_000 },
  { chars: 45, ms: 15_000 },
  { chars: 20, ms: 10_000 },
];

export const stepAt = (savesDone: number): SaveStep => SAVE_STEPS[Math.min(savesDone, SAVE_STEPS.length - 1)];

/** Characters that differ between two texts (common prefix and suffix excluded): inserting, deleting and replacing all count. */
export function changedChars(prev: string, next: string): number {
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) { endPrev--; endNext--; }
  return Math.max(endPrev - start, endNext - start);
}

export function dueForSave(a: { savesDone: number; savedText: string; text: string; dirtySince: number | null; now: number }): boolean {
  if (a.dirtySince === null) return false;
  const step = stepAt(a.savesDone);
  return changedChars(a.savedText, a.text) >= step.chars || a.now - a.dirtySince >= step.ms;
}
