import { RedactionMap } from "../redaction/redactionMap";

// The placeholder <-> value map lives for one task. It is mirrored to chrome.storage.session
// (memory only) so an MV3 worker restart does not lose it, and cleared when the task ends.
const KEY = "redactionMap";
let cache: RedactionMap | null = null;

export async function getMap(): Promise<RedactionMap> {
  if (!cache) cache = new RedactionMap(((await chrome.storage.session.get(KEY))[KEY] as Record<string, string>) ?? {});
  return cache;
}

export async function saveMap(): Promise<void> {
  if (cache) await chrome.storage.session.set({ [KEY]: cache.toJSON() });
}

export async function resetMap(): Promise<void> {
  cache = new RedactionMap();
  await chrome.storage.session.remove(KEY);
}
