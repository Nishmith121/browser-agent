"""Python port of the extension's redaction rules (extension/src/redaction/*.ts), used to redact the
fine-tuning data exactly like the browser does at run time: DOM rules, structured-PII regex detectors with
validators, and the session placeholder map. The rules and the test inputs mirror the TypeScript ones.

NER and face detection are optional here (see mind2web_builder.py): they need heavy packages.
"""
from __future__ import annotations

from dataclasses import dataclass

import regex as re  # `regex` supports \\p{L} and the variable-width lookbehinds the TS detectors use

# ---- checksums --------------------------------------------------------------------------------
_VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
       [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]]
_VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
       [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]]


def verhoeff_valid(num: str) -> bool:
    c = 0
    for i, ch in enumerate(reversed(num)):
        c = _VD[c][_VP[i % 8][int(ch)]]
    return c == 0


def luhn_valid(num: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(num)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s)


# ---- detectors (same patterns as regex.ts) ----------------------------------------------------
NB = r"(?<!\d)(?<!\d[ -])"
NA = r"(?!\d)(?![ -]\d)"
AADHAAR = re.compile(rf"{NB}[2-9]\d{{3}}[ -]?\d{{4}}[ -]?\d{{4}}{NA}")
PAN = re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")
PHONE = re.compile(rf"{NB}(?:(?:\+91|\b91|\b0)[ -]?)?[6-9]\d{{4}}[ -]?\d{{5}}{NA}")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
CARD = re.compile(rf"{NB}\d(?:[ -]?\d){{12,18}}{NA}")
IFSC = re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")
LONG_DIGITS = re.compile(rf"{NB}\d{{9,18}}{NA}")
MONTHS = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*"
DATES = [
    re.compile(r"\b(?:0?[1-9]|[12]\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-](?:19|20)\d{2}\b"),
    re.compile(rf"\b\d{{1,2}}(?:st|nd|rd|th)?\s{MONTHS}\.?,?\s(?:19|20)\d{{2}}\b", re.I),
    re.compile(r"\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b"),
]
CURRENCY = re.compile(r"(?:₹|\bRs\.?|\bINR)\s?\d[\d,]*(?:\.\d+)?")
ADDRESS_PIN = re.compile(
    r"(?:\b(?:H\.?\s?No\.?|Flat|Plot|House|Door)\s*[A-Za-z0-9/-]+|(?<![\w/])\d{1,4}(?:/\d{1,4})?[A-Za-z]?)\s*,\s*"
    r"(?:[^,;\n]{2,40}?\s*,\s*){0,3}\p{Lu}[\p{L}.'& –—-]{1,40}?[ –—-]\d{5,6}\b")
_STREET = r"(?:Road|Rd|Street|St|Marg|Nagar|Lane|Colony|Chowk|Path|Circle|Ganj|Avenue|Sector|Block|Apartments?)"
ADDRESS_STREET = re.compile(
    rf"(?<![\w/])\d{{1,4}}[A-Za-z]?(?:/\d{{1,4}})?,?\s+(?:[A-Z][\w.'-]*\s+){{1,3}}{_STREET}\b(?:\s*,\s*[A-Z][A-Za-z .'-]{{2,30}}){{0,2}}")
ACCOUNT_KW = re.compile(r"\b(?:account|acct|a/c)\b", re.I)
DOB_KW = re.compile(r"\b(?:dob|date of birth|birth|born)\b", re.I)
PRIORITY = ["CARD", "ADDRESS", "AADHAAR", "PAN", "EMAIL", "IFSC", "PHONE", "ACCOUNT", "DOB", "AMOUNT"]


@dataclass
class Span:
    start: int
    end: int
    category: str
    value: str


def _scan(text, rx, category, ok=lambda m: True):
    return [Span(m.start(), m.end(), category, m.group(0)) for m in rx.finditer(text) if ok(m.group(0))]


def detect_pii(text: str, before: str = "", after: str = "", contextual: bool = True, currency: bool = False) -> list[Span]:
    c: list[Span] = []
    c += _scan(text, CARD, "CARD", lambda m: 13 <= len(_digits(m)) <= 19 and luhn_valid(_digits(m)))
    c += _scan(text, AADHAAR, "AADHAAR", lambda m: verhoeff_valid(_digits(m)))
    c += _scan(text, PAN, "PAN", lambda m: m[3] in "PCHFATBLJG")
    c += _scan(text, EMAIL, "EMAIL")
    c += _scan(text, IFSC, "IFSC")
    c += _scan(text, PHONE, "PHONE")
    c += _scan(text, ADDRESS_PIN, "ADDRESS")
    c += _scan(text, ADDRESS_STREET, "ADDRESS")
    if currency:
        c += _scan(text, CURRENCY, "AMOUNT")
    if contextual:
        def ctx(s: Span) -> str:
            return before[-40:] + text[max(0, s.start - 40):s.start] + " " + text[s.end:s.end + 40] + after[:40]
        c += [s for s in _scan(text, LONG_DIGITS, "ACCOUNT") if ACCOUNT_KW.search(ctx(s))]
        for rx in DATES:
            c += [s for s in _scan(text, rx, "DOB") if DOB_KW.search(ctx(s))]
    # overlaps: longest wins, ties by validator strength
    c.sort(key=lambda s: (-(s.end - s.start), PRIORITY.index(s.category)))
    kept: list[Span] = []
    for s in c:
        if not any(s.start < k.end and k.start < s.end for k in kept):
            kept.append(s)
    return sorted(kept, key=lambda s: s.start)


# ---- DOM rules (rules.ts) ---------------------------------------------------------------------
_AUTOCOMPLETE = {"cc-number": "CARD", "cc-csc": "CVV", "cc-exp": "CARD", "one-time-code": "OTP",
                 "current-password": "PASSWORD", "new-password": "PASSWORD"}
_KEYWORDS = {"otp": "OTP", "cvv": "CVV", "cvc": "CVV", "pin": "PIN", "aadhaar": "AADHAAR", "aadhar": "AADHAAR", "pan": "PAN",
             "account": "ACCOUNT", "ifsc": "IFSC", "card": "CARD", "ssn": "SSN", "dob": "DOB"}


def classify_field(type_=None, autocomplete=None, name=None, id_=None, aria_label=None, placeholder=None, label=None):
    if (type_ or "").lower() == "password":
        return "PASSWORD"
    for t in (autocomplete or "").lower().split():
        if t in _AUTOCOMPLETE:
            return _AUTOCOMPLETE[t]
    joined = " ".join(x for x in (name, id_, aria_label, placeholder, label) if x)
    words = [w for w in re.split(r"[^a-z0-9]+", re.sub(r"([a-z])([A-Z])", r"\1 \2", joined).lower()) if w]
    for w in words:
        if w in _KEYWORDS:
            return _KEYWORDS[w]
    if " security answer " in f" {' '.join(words)} ":
        return "SECURITY_ANSWER"
    return None


# ---- session placeholder map (redactionMap.ts) ------------------------------------------------
_NORM_DIGITS = {"AADHAAR", "CARD", "ACCOUNT"}


def _normalise(category: str, value: str) -> str:
    if category in _NORM_DIGITS:
        return _digits(value)
    if category == "PHONE":
        return _digits(value)[-10:]
    if category in ("EMAIL", "NAME", "LOCATION", "ORG"):
        return re.sub(r"\s+", " ", value.lower()).strip()
    if category in ("PAN", "IFSC"):
        return value.upper()
    return value.strip()


class RedactionMap:
    """The same value always gets the same placeholder within one task; restored only at execution time."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self._keys: dict[str, str] = {}
        self._counters: dict[str, int] = {}

    def assign(self, category: str, value: str) -> str:
        key = f"{category}|{_normalise(category, value)}"
        if key not in self._keys:
            n = self._counters[category] = self._counters.get(category, 0) + 1
            ph = f"[{category}_{n}]"
            self._keys[key] = ph
            self.values[ph] = value
        return self._keys[key]

    def apply_spans(self, text: str, spans: list[Span]) -> str:
        out, at = "", 0
        for s in sorted(spans, key=lambda s: s.start):
            if s.start < at:
                continue
            out += text[at:s.start] + self.assign(s.category, text[s.start:s.end])
            at = s.end
        return out + text[at:]

    def sanitise(self, text: str, **kw) -> str:
        return self.apply_spans(text, detect_pii(text, **kw))

    def restore(self, text: str) -> tuple[str, list[str]]:
        missing: list[str] = []

        def sub(m):
            v = self.values.get(m.group(0))
            if v is None:
                missing.append(m.group(0))
                return m.group(0)
            return v

        return re.sub(r"\[[A-Z_]+_\d+\]", sub, text), missing
