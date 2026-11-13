import type { Category } from "../shared/types";
import { detectPII, type DetectOptions, type Span } from "./regex";

/**
 * Session redaction map (placeholder <-> real value). The same value always gets the same
 * placeholder within a session; the real values never leave the device.
 */
export class RedactionMap {
  /** placeholder -> original value */
  private values: Record<string, string>;
  /** category + normalised value -> placeholder */
  private keys: Record<string, string> = {};
  private counters: Record<string, number> = {};
  /** Values found by the NER model (no regex can find them again), longest first, replaced in every string. */
  private learned: { value: string; ph: string }[] = [];

  constructor(values: Record<string, string> = {}) {
    this.values = { ...values };
    // Rebuild the reverse index so a restored map keeps assigning consistently.
    for (const [ph, v] of Object.entries(this.values)) {
      const m = /^\[([A-Z_]+)_(\d+)\]$/.exec(ph);
      if (!m) continue;
      this.keys[`${m[1]}|${normalise(m[1] as Category, v)}`] = ph;
      this.counters[m[1]] = Math.max(this.counters[m[1]] ?? 0, Number(m[2]));
      if (LEARNED.has(m[1])) this.learn(v, ph);
    }
  }

  private learn(value: string, ph: string): void {
    if (value.length < 3 || this.learned.some((l) => l.ph === ph && l.value === value)) return;
    this.learned.push({ value, ph });
    this.learned.sort((a, b) => b.value.length - a.value.length);
  }

  /** Every original value seen this session (for the leak guard). */
  originals(): string[] {
    return Object.values(this.values);
  }

  toJSON(): Record<string, string> {
    return { ...this.values };
  }

  assign(category: Category, value: string): string {
    const key = `${category}|${normalise(category, value)}`;
    let ph = this.keys[key];
    if (!ph) {
      const n = (this.counters[category] = (this.counters[category] ?? 0) + 1);
      ph = `[${category}_${n}]`;
      this.keys[key] = ph;
      this.values[ph] = value;
    }
    if (LEARNED.has(category)) this.learn(value, ph);
    return ph;
  }

  /** Replaces the given spans (offsets into `text`) with placeholders. */
  applySpans(text: string, spans: Span[]): string {
    let out = "";
    let at = 0;
    for (const s of [...spans].sort((a, b) => a.start - b.start)) {
      if (s.start < at) continue;
      out += text.slice(at, s.start) + this.assign(s.category, text.slice(s.start, s.end));
      at = s.end;
    }
    return out + text.slice(at);
  }

  /** Detects structured PII in free text and replaces it with placeholders. */
  sanitise(text: string, opts: DetectOptions = {}): string {
    return this.replaceLearned(this.applySpans(text, detectPII(text, opts)));
  }

  /** Replaces whole-token occurrences of values the NER model found earlier in this session. */
  replaceLearned(text: string): string {
    let out = text;
    for (const { value, ph } of this.learned) out = out.replace(tokenRegex(value), ph);
    return out;
  }

  /** Placeholder -> real value, at execution time only. Unknown placeholders are reported, never guessed. */
  restore(text: string): { text: string; missing: string[] } {
    const missing: string[] = [];
    const out = text.replace(/\[[A-Z_]+_\d+\]/g, (ph) => {
      const v = this.values[ph];
      if (v === undefined) {
        missing.push(ph);
        return ph;
      }
      return v;
    });
    return { text: out, missing };
  }
}

const LEARNED = new Set(["NAME", "LOCATION", "ORG", "ADDRESS"]);

/** Matches `value` only as a whole token (not inside a longer word or number). */
export function tokenRegex(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu");
}

function normalise(category: Category, value: string): string {
  switch (category) {
    case "AADHAAR":
    case "CARD":
    case "ACCOUNT":
      return value.replace(/\D/g, "");
    case "PHONE":
      return value.replace(/\D/g, "").slice(-10);
    case "EMAIL":
    case "NAME":
    case "LOCATION":
    case "ORG":
      return value.toLowerCase().replace(/\s+/g, " ").trim();
    case "PAN":
    case "IFSC":
      return value.toUpperCase();
    default:
      return value.trim();
  }
}
