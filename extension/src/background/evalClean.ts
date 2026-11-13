// EVALUATION ONLY. Compiled in only by `VITE_EVAL_CLEAN=1 vite build` (see npm run build:clean).
// The "clean screens" baseline: no redaction at all, so the model sees what an unprotected agent would see.
// This must never ship: the normal build contains none of this code (checked by npm run check:no-clean).
import type { OutgoingElement, OutgoingPayload, ObserveResult } from "../shared/types";
import { loadSecrets } from "../vault";
import { captureWithBackoff, resolveTab, snapshotWithRetry } from "./capture";
import { paintRedacted } from "./painter";

export async function observeClean(tabId?: number): Promise<ObserveResult> {
  const t0 = performance.now();
  const tab = await resolveTab(tabId);
  const snapshot = await snapshotWithRetry(tab.id);
  const raw = await captureWithBackoff(tab.windowId);
  const image = await paintRedacted(raw, [], snapshot.elements, snapshot.viewport.width); // marks only
  const elements: OutgoingElement[] = snapshot.elements.map((e) => ({
    id: e.id, tag: e.tag, type: e.type, label: e.label, text: e.text, placeholder: e.placeholder,
    ...(e.value ? { value: e.value } : {}), bbox: e.bbox,
  }));
  const payload: OutgoingPayload = {
    url: snapshot.url,
    title: snapshot.title,
    viewport: { width: snapshot.viewport.width, height: snapshot.viewport.height, scale: Math.round(snapshot.viewport.dpr * 100) / 100 },
    elements,
    texts: [...new Set(snapshot.textNodes.map((n) => n.text))].slice(0, 200),
    available_secrets: Object.keys(await loadSecrets()),
    redaction_summary: {},
  };
  return { image, payload, regions: [], guard: { blocked: false, hits: [] }, timingMs: { clean: Math.round(performance.now() - t0) } };
}
