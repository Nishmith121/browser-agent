// User settings (chrome.storage.local). The validation is pure so it can be unit-tested without a browser.
export interface Settings {
  serverUrl: string;
  maxSteps: number;
  stepTimeoutMs: number;
  /** Extra origins the agent may act on, besides the built-in test-site origin. Exact origins only, no wildcards. */
  extraOrigins: string[];
}

export const DEFAULT_ORIGIN = "http://localhost:8080";
export const DEFAULTS: Settings = { serverUrl: "http://localhost:8000", maxSteps: 15, stepTimeoutMs: 180_000, extraOrigins: [] };
export const LIMITS = { maxSteps: [1, 30], stepTimeoutMs: [5_000, 600_000] } as const;
const KEY = "settings";

/** "https://Example.com/path?x" -> "https://example.com"; null when it is not a plain http(s) origin. */
export function normaliseOrigin(input: string): string | null {
  const s = input.trim();
  if (!s || s.includes("*")) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function validateSettings(raw: Partial<Record<keyof Settings, unknown>>): { settings: Settings; errors: string[] } {
  const errors: string[] = [];
  const s: Settings = { ...DEFAULTS };

  if (raw.serverUrl !== undefined) {
    const o = typeof raw.serverUrl === "string" ? normaliseOrigin(raw.serverUrl) : null;
    if (o) s.serverUrl = o;
    else errors.push("Server URL must be an http(s) address such as http://localhost:8000");
  }
  for (const k of ["maxSteps", "stepTimeoutMs"] as const) {
    if (raw[k] === undefined) continue;
    const n = Number(raw[k]);
    const [lo, hi] = LIMITS[k];
    if (Number.isInteger(n) && n >= lo && n <= hi) s[k] = n;
    else errors.push(`${k === "maxSteps" ? "Step limit" : "Step timeout (ms)"} must be a whole number from ${lo} to ${hi}`);
  }
  if (raw.extraOrigins !== undefined) {
    const list = Array.isArray(raw.extraOrigins) ? raw.extraOrigins : [];
    const out = new Set<string>();
    for (const item of list) {
      const o = typeof item === "string" ? normaliseOrigin(item) : null;
      if (!o) errors.push(`Not a valid origin (use https://example.com, no wildcards): ${String(item)}`);
      else if (o !== DEFAULT_ORIGIN) out.add(o);
    }
    s.extraOrigins = [...out];
  }
  return { settings: s, errors };
}

export function isAllowedUrl(url: string | undefined, extraOrigins: readonly string[] = []): boolean {
  if (!url) return false;
  try {
    const origin = new URL(url).origin;
    return origin === DEFAULT_ORIGIN || extraOrigins.includes(origin);
  } catch {
    return false;
  }
}

export async function getSettings(): Promise<Settings> {
  const raw = (await chrome.storage.local.get(KEY))[KEY] ?? {};
  return validateSettings(raw).settings; // a corrupted stored value falls back to the defaults field by field
}

export async function saveSettings(raw: Partial<Record<keyof Settings, unknown>>): Promise<{ settings: Settings; errors: string[] }> {
  const res = validateSettings(raw);
  if (!res.errors.length) await chrome.storage.local.set({ [KEY]: res.settings });
  return res;
}
