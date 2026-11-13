/** Task secrets live in chrome.storage.session (memory only) and are substituted at execution time only. */

export type Secrets = Record<string, string>;

/** Shorter values are too ambiguous to scan for (would block everything). */
export const MIN_SECRET_LEN = 4;

const KEY = "vault";

export async function loadSecrets(): Promise<Secrets> {
  const r = await chrome.storage.session.get(KEY);
  return (r[KEY] as Secrets | undefined) ?? {};
}

export async function saveSecrets(secrets: Secrets): Promise<void> {
  const clean = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== ""));
  await chrome.storage.session.set({ [KEY]: clean });
}

export async function clearSecrets(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}

export function secretValues(secrets: Secrets): string[] {
  return Object.values(secrets).filter((v) => v.length >= MIN_SECRET_LEN);
}

/** {PASSWORD}, {OTP}, {SECRET:<name>} -> vault values. Unknown names are reported, never guessed. */
export function substitute(text: string, secrets: Secrets): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(/\{(PASSWORD|OTP|SECRET:([A-Za-z0-9_-]+))\}/g, (m, whole: string, name?: string) => {
    const key = name ?? whole;
    const v = secrets[key];
    if (v === undefined) {
      missing.push(key);
      return m;
    }
    return v;
  });
  return { text: out, missing };
}
