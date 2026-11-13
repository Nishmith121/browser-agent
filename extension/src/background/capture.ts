import { isAllowedUrl } from "../shared/origins";
import { getSettings } from "../shared/settings";
import type { Msg, Snapshot } from "../shared/types";

/** The tab to observe, refusing anything outside the allowed origins. */
export async function resolveTab(tabId?: number): Promise<chrome.tabs.Tab & { id: number }> {
  const tab = tabId ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab?.id) throw new Error("No active tab");
  if (!isAllowedUrl(tab.url, (await getSettings()).extraOrigins)) {
    throw new Error(`Origin not allowed: ${tab.url ? new URL(tab.url).origin : "unknown"}. Add it under Settings > Allowed origins, or go back to an allowed page.`);
  }
  return tab as chrome.tabs.Tab & { id: number };
}

/**
 * Make sure the content script is in the tab: pages opened before the extension was (re)loaded, and origins added in Settings,
 * do not have it yet. The tab is checked against the allowed origins first.
 */
export async function ensureContent(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return;
  } catch {
    // not there yet
  }
  const tab = await chrome.tabs.get(tabId);
  if (!isAllowedUrl(tab.url, (await getSettings()).extraOrigins)) throw new Error(`Origin not allowed: ${tab.url ?? "unknown"}`);
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content-standalone.js"] });
}

/** Origins added in Settings get the content script on every page load, not just once. */
export async function syncContentScripts(): Promise<void> {
  const id = "privasight-extra-origins";
  const { extraOrigins } = await getSettings();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
  if (extraOrigins.length) {
    await chrome.scripting.registerContentScripts([{ id, matches: extraOrigins.map((o) => `${o}/*`), js: ["content-standalone.js"], runAt: "document_idle", persistAcrossSessions: true }]);
  }
}

/** The content script may not be ready right after a navigation. */
export async function snapshotWithRetry(tabId: number): Promise<Snapshot> {
  let last: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      return (await chrome.tabs.sendMessage(tabId, { type: "snapshot" } satisfies Msg)) as Snapshot;
    } catch (e) {
      last = e;
      if (i === 2) await ensureContent(tabId).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw last;
}

/**
 * Chrome allows ~2 captureVisibleTab calls per second, and a tab that has just navigated may not have painted a frame yet
 * ("image readback failed"). Both are transient: wait and try again instead of failing the step.
 */
const TRANSIENT_CAPTURE = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|image readback failed/;
export async function captureWithBackoff(windowId: number): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (e) {
      if (i >= 5 || !TRANSIENT_CAPTURE.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 400 + 200 * i));
    }
  }
}
