import type { OutgoingElement, OutgoingPayload, Region, Snapshot } from "../shared/types";
import { MIN_SECRET_LEN, type Secrets } from "../vault";
import type { RedactionMap } from "./redactionMap";

const MAX_TEXTS = 200;

function scannable(secrets: Secrets): string[] {
  return Object.values(secrets).filter((v) => v.length >= MIN_SECRET_LEN);
}

/** Replaces every vault value found in free text with a placeholder. */
export function sanitiseText(text: string, secrets: Secrets): string {
  let out = text;
  for (const v of scannable(secrets)) out = out.split(v).join("[REDACTED_SECRET]");
  return out;
}

const ML_CATEGORIES = new Set(["NAME", "LOCATION", "ORG"]);

/** Regions to paint: DOM-rule fields, PII spans, PII-valued fields, vault values shown in page text, plus `extra` (faces, video). */
export function regionsFor(s: Snapshot, secrets: Secrets, extra: Region[] = []): Region[] {
  const regions: Region[] = [];
  for (const e of s.elements) {
    if (e.redaction) {
      regions.push({ bbox: e.bbox, category: e.redaction, source: "dom", confidence: 1, placeholder: `[REDACTED_${e.redaction}]` });
    } else if (e.piiValue) {
      // Text inside an <input> cannot be addressed per character, so the whole field is painted.
      const category = e.piiValue.spans[0].category;
      regions.push({ bbox: e.bbox, category, source: ML_CATEGORIES.has(category) ? "ner" : "regex", confidence: 1, placeholder: `[${category}]` });
    }
  }
  const vals = scannable(secrets);
  for (const t of s.textNodes) {
    for (const span of t.spans ?? []) {
      for (const bbox of span.boxes) {
        regions.push({ bbox, category: span.category, source: ML_CATEGORIES.has(span.category) ? "ner" : "regex", confidence: 1, placeholder: `[${span.category}]` });
      }
    }
    if (vals.some((v) => t.text.includes(v))) {
      regions.push({ bbox: t.bbox, category: "SECRET", source: "vault", confidence: 1, placeholder: "[REDACTED_SECRET]" });
    }
  }
  return [...regions, ...extra];
}

/** Builds the only JSON that may leave the device (besides the redacted screenshot). */
export function buildOutgoing(s: Snapshot, secrets: Secrets, regions: Region[], map: RedactionMap): OutgoingPayload {
  const clean = (t: string) => map.sanitise(sanitiseText(t, secrets));
  const cleanOrNull = (t: string | null) => (t === null ? null : clean(t));

  // Spans first (their offsets refer to the original text), vault values after.
  const texts = [
    ...new Set(s.textNodes.map((t) => sanitiseText(map.applySpans(t.text, t.spans ?? []), secrets))),
  ].slice(0, MAX_TEXTS);

  const elements: OutgoingElement[] = s.elements.map((e) => {
    const base: OutgoingElement = {
      id: e.id,
      tag: e.tag,
      type: e.type,
      label: cleanOrNull(e.label),
      text: "",
      placeholder: null,
      bbox: e.bbox,
    };
    if (e.redaction) {
      // Keep the label so the model knows a field exists; drop everything else.
      return { ...base, redacted: true, category: e.redaction };
    }
    const out: OutgoingElement = { ...base, text: clean(e.text), placeholder: cleanOrNull(e.placeholder) };
    if (e.piiValue) {
      out.value = sanitiseText(map.applySpans(e.piiValue.text, e.piiValue.spans), secrets);
      out.redacted = true;
    }
    return out;
  });

  const summary: Record<string, number> = {};
  for (const r of regions) summary[r.category] = (summary[r.category] ?? 0) + 1;
  return {
    url: clean(s.url),
    title: clean(s.title),
    // Rounded: long float digits would look like numbers to the leak guard.
    viewport: { width: s.viewport.width, height: s.viewport.height, scale: Math.round(s.viewport.dpr * 100) / 100 },
    elements,
    texts,
    available_secrets: Object.keys(secrets),
    redaction_summary: summary,
  };
}
