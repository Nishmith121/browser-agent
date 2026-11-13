import type { Category } from "../shared/types";

/** Layer A: DOM rules (no ML). Pure so they can be tested against fixture HTML. */

export interface FieldAttrs {
  type?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  ariaLabel?: string | null;
  placeholder?: string | null;
  label?: string | null;
}

const AUTOCOMPLETE: Record<string, Category> = {
  "cc-number": "CARD",
  "cc-csc": "CVV",
  "cc-exp": "CARD",
  "one-time-code": "OTP",
  "current-password": "PASSWORD",
  "new-password": "PASSWORD",
};

const KEYWORDS: Record<string, Category> = {
  otp: "OTP",
  cvv: "CVV",
  cvc: "CVV",
  pin: "PIN",
  aadhaar: "AADHAAR",
  aadhar: "AADHAAR",
  pan: "PAN",
  account: "ACCOUNT",
  ifsc: "IFSC",
  card: "CARD",
  ssn: "SSN",
  dob: "DOB",
};

const PHRASES: Array<[string, Category]> = [["security answer", "SECURITY_ANSWER"]];

function tokens(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase -> words
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function classifyField(a: FieldAttrs): Category | null {
  if ((a.type ?? "").toLowerCase() === "password") return "PASSWORD";
  for (const t of (a.autocomplete ?? "").toLowerCase().split(/\s+/)) {
    if (AUTOCOMPLETE[t]) return AUTOCOMPLETE[t];
  }
  const words = tokens([a.name, a.id, a.ariaLabel, a.placeholder, a.label].filter(Boolean).join(" "));
  for (const w of words) {
    if (KEYWORDS[w]) return KEYWORDS[w];
  }
  const joined = ` ${words.join(" ")} `;
  for (const [phrase, cat] of PHRASES) {
    if (joined.includes(` ${phrase} `)) return cat;
  }
  return null;
}
