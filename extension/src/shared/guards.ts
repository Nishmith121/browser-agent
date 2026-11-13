import type { Action, HistoryItem } from "./protocol";

/** Interrupted-step marker kept in the history so the model re-checks the screen instead of repeating the action blindly. */
export const INTERRUPTED = "interrupted: the browser restarted the agent while this ran; look at the screen to see whether it took effect";

/**
 * True when the last `n` steps are the same action. Scroll and wait are excluded because repeating them is normal.
 * The caller then asks the user instead of burning the rest of the step limit.
 */
export function isStuck(history: readonly HistoryItem[], n = 3): boolean {
  if (history.length < n) return false;
  const tail = history.slice(-n);
  const key = (a: Action) => JSON.stringify(a);
  if (tail[0].action.type === "scroll" || tail[0].action.type === "wait") return false;
  return tail.every((h) => key(h.action) === key(tail[0].action));
}

/** A state is only resumed if it is recent; chrome.storage.session is already cleared when the browser closes. */
export function isFresh(updatedAt: number, now: number, maxAgeMs = 10 * 60_000): boolean {
  return now - updatedAt >= 0 && now - updatedAt <= maxAgeMs;
}
