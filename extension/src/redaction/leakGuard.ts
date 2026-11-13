import { MIN_SECRET_LEN, type Secrets } from "../vault";
import { tokenRegex } from "./redactionMap";
import { detectPII } from "./regex";

const strip = (s: string) => s.replace(/[\s-]+/g, "");

/**
 * Final check on the outgoing JSON string. Returns what was found: the NAMES of vault secrets
 * (exact, or with spaces/dashes removed), "PII:<CATEGORY>" for structured PII the regex detectors still
 * see, and "PII:ENTITY" if a value that was replaced by a placeholder this session is still present. Never the values themselves.
 * Context detectors (account number, DOB) are off here: bare digit runs would false-positive.
 */
export function leakGuard(json: string, secrets: Secrets, known: string[] = []): string[] {
  const flat = strip(json);
  const hits: string[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length < MIN_SECRET_LEN) continue;
    if (json.includes(value) || flat.includes(strip(value))) hits.push(name);
  }
  // Every real value this session replaced with a placeholder (names and locations found by the NER model
  // included) must be gone from what is about to be sent.
  if (known.some((v) => v.length >= 3 && tokenRegex(v).test(json))) hits.push("PII:ENTITY");
  for (const span of detectPII(json, { contextual: false })) {
    const tag = `PII:${span.category}`;
    if (!hits.includes(tag)) hits.push(tag);
  }
  return hits;
}
