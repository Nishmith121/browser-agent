import type { Category } from "../shared/types";

/** Layer B (structured PII): regex detectors with validators to cut false positives (Section 5). */

export interface Span {
  start: number;
  end: number;
  category: Category;
  value: string;
}

export interface DetectOptions {
  /** Text of the same block just before / after `text` (labels live in sibling nodes). */
  before?: string;
  after?: string;
  /** Run the keyword-context detectors (account number, date of birth). Off for the leak guard. */
  contextual?: boolean;
  /** Redact currency amounts (only on pages flagged financial; configurable). */
  currency?: boolean;
}

// ---- checksums ---------------------------------------------------------------------------
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
  [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
  [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];

export function verhoeffValid(num: string): boolean {
  let c = 0;
  const d = num.split("").reverse();
  for (let i = 0; i < d.length; i++) c = VD[c][VP[i % 8][Number(d[i])]];
  return c === 0;
}

export function luhnValid(num: string): boolean {
  let sum = 0;
  const d = num.split("").reverse();
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

const digits = (s: string) => s.replace(/\D/g, "");

// ---- detectors ---------------------------------------------------------------------------
type Candidate = Span;

function scan(text: string, rx: RegExp, category: Category, ok: (m: string) => boolean = () => true): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(rx)) {
    if (m.index === undefined || !ok(m[0])) continue;
    out.push({ start: m.index, end: m.index + m[0].length, category, value: m[0] });
  }
  return out;
}

// No digit directly before/after, and not part of a longer space/dash-separated digit group.
const NB = String.raw`(?<!\d)(?<!\d[ -])`;
const NA = String.raw`(?!\d)(?![ -]\d)`;

const AADHAAR = new RegExp(`${NB}[2-9]\\d{3}[ -]?\\d{4}[ -]?\\d{4}${NA}`, "g");
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const PHONE = new RegExp(`${NB}(?:(?:\\+91|\\b91|\\b0)[ -]?)?[6-9]\\d{4}[ -]?\\d{5}${NA}`, "g");
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const CARD = new RegExp(`${NB}\\d(?:[ -]?\\d){12,18}${NA}`, "g");
const IFSC = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
const LONG_DIGITS = new RegExp(`${NB}\\d{9,18}${NA}`, "g");
const MONTHS = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
const DATES = [
  /\b(?:0?[1-9]|[12]\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-](?:19|20)\d{2}\b/g,
  new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s${MONTHS}\.?,?\s(?:19|20)\d{2}\b`, "gi"),
  /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g,
];
const CURRENCY = /(?:₹|\bRs\.?|\bINR)\s?\d[\d,]*(?:\.\d+)?/g;
// Indian-style postal address: "<house>, <locality>[, <area>], <City>[ -]<PIN>" or "<no> <name> <street word>".
const ADDRESS_PIN =
  /(?:\b(?:H\.?\s?No\.?|Flat|Plot|House|Door)\s*[A-Za-z0-9/-]+|(?<![\w/])\d{1,4}(?:\/\d{1,4})?[A-Za-z]?)\s*,\s*(?:[^,;\n]{2,40}?\s*,\s*){0,3}\p{Lu}[\p{L}.'&–— -]{1,40}?[ –—-]\d{5,6}\b/gu;
const STREET = "(?:Road|Rd|Street|St|Marg|Nagar|Lane|Colony|Chowk|Path|Circle|Ganj|Avenue|Sector|Block|Apartments?)";
const ADDRESS_STREET = new RegExp(
  String.raw`(?<![\w/])\d{1,4}[A-Za-z]?(?:/\d{1,4})?,?\s+(?:[A-Z][\w.'-]*\s+){1,3}${STREET}\b(?:\s*,\s*[A-Z][A-Za-z .'-]{2,30}){0,2}`,
  "g",
);
const ACCOUNT_KW = /\b(?:account|acct|a\/c)\b/i;
const DOB_KW = /\b(?:dob|date of birth|birth|born)\b/i;

const PRIORITY: Category[] = ["CARD", "ADDRESS", "AADHAAR", "PAN", "EMAIL", "IFSC", "PHONE", "ACCOUNT", "DOB", "AMOUNT"];

export function detectPII(text: string, opts: DetectOptions = {}): Span[] {
  const c: Candidate[] = [
    ...scan(text, CARD, "CARD", (m) => {
      const d = digits(m);
      return d.length >= 13 && d.length <= 19 && luhnValid(d);
    }),
    ...scan(text, AADHAAR, "AADHAAR", (m) => verhoeffValid(digits(m))),
    ...scan(text, PAN, "PAN", (m) => "PCHFATBLJG".includes(m[3])),
    ...scan(text, EMAIL, "EMAIL"),
    ...scan(text, IFSC, "IFSC"),
    ...scan(text, PHONE, "PHONE"),
    ...scan(text, ADDRESS_PIN, "ADDRESS"),
    ...scan(text, ADDRESS_STREET, "ADDRESS"),
  ];
  if (opts.currency) c.push(...scan(text, CURRENCY, "AMOUNT"));

  if (opts.contextual !== false) {
    const ctx = (s: Span) =>
      (opts.before ?? "").slice(-40) + text.slice(Math.max(0, s.start - 40), s.start) +
      " " + text.slice(s.end, s.end + 40) + (opts.after ?? "").slice(0, 40);
    for (const s of scan(text, LONG_DIGITS, "ACCOUNT")) if (ACCOUNT_KW.test(ctx(s))) c.push(s);
    for (const rx of DATES) {
      for (const s of scan(text, rx, "DOB")) if (DOB_KW.test(ctx(s))) c.push(s);
    }
  }

  // Overlaps: longest span wins, ties go by validator strength.
  c.sort((a, b) => b.end - b.start - (a.end - a.start) || PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category));
  const kept: Span[] = [];
  for (const s of c) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return kept.sort((a, b) => a.start - b.start);
}
