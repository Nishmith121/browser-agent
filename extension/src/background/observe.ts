import type { MlResult } from "../offscreen/main";
import { leakGuard } from "../redaction/leakGuard";
import { detectPII } from "../redaction/regex";
import { buildOutgoing, regionsFor } from "../redaction/regions";
import type { Box, Detected, Msg, ObserveResult, PiiSpan, Region, Snapshot } from "../shared/types";
import { loadSecrets } from "../vault";
import { observeClean } from "./evalClean";
import { runMl } from "./ml";
import { paintRedacted } from "./painter";
import { captureWithBackoff, resolveTab, snapshotWithRetry } from "./capture";
import { getMap, saveMap } from "./session";

const VALUE_ID = 1_000_000; // text id offset for input values sent to the NER model

/** One perception step: capture, snapshot, on-device detection, redact, mark, leak-guard.
 * The raw screenshot never leaves this function (the offscreen ML document is part of this extension). */
export async function observe(tabId?: number): Promise<ObserveResult> {
  // Evaluation-only build (VITE_EVAL_CLEAN=1): the unsafe "clean screens" baseline. Dead code in the shipped build.
  if (import.meta.env.VITE_EVAL_CLEAN === "1") return observeClean(tabId);
  const t: Record<string, number> = {};
  const lap = (k: string, from: number) => (t[k] = Math.round(performance.now() - from));
  let t0 = performance.now();

  const tab = await resolveTab(tabId);
  const snapshot = await snapshotWithRetry(tab.id);
  const raw = await captureWithBackoff(tab.windowId);
  lap("capture", t0);

  // Faces, names and locations (offscreen document: WebGPU with WASM fallback).
  t0 = performance.now();
  const ml = await runMl({
    raw,
    viewportWidth: snapshot.viewport.width,
    media: snapshot.media,
    texts: [
      ...snapshot.textNodes.map((n) => ({ id: n.nodeId, text: n.text, skip: mostlyCovered(n.text, n.spans) })),
      ...snapshot.elements.filter((e) => e.value).map((e) => ({ id: VALUE_ID + e.id, text: e.value! })),
    ],
  });
  lap("ml", t0);
  Object.assign(t, Object.fromEntries(Object.entries(ml.timingMs).map(([k, v]) => [`ml_${k}`, v])));

  t0 = performance.now();
  const extra = await applyDetections(tab.id, snapshot, ml);
  lap("map", t0);

  t0 = performance.now();
  const secrets = await loadSecrets();
  const regions = regionsFor(snapshot, secrets, extra);
  lap("rules", t0);

  t0 = performance.now();
  const image = await paintRedacted(raw, regions, snapshot.elements, snapshot.viewport.width);
  lap("paint", t0);

  const map = await getMap();
  const payload = buildOutgoing(snapshot, secrets, regions, map);
  await saveMap();
  const hits = leakGuard(JSON.stringify(payload), secrets, map.originals());
  if (hits.length) console.warn("[leak-guard] blocked send; found:", hits);
  return {
    image,
    payload: hits.length ? null : payload,
    regions,
    guard: { blocked: hits.length > 0, hits },
    timingMs: t,
    ml: { backend: ml.backend, nerStats: ml.nerStats },
  };
}

/** True when regex spans already account for (nearly) all of the text. */
function mostlyCovered(text: string, spans: PiiSpan[] | undefined): boolean {
  if (!spans?.length) return false;
  const letters = text.replace(/\s+/g, "").length;
  const covered = spans.reduce((n, s) => n + (s.end - s.start), 0);
  return covered >= 0.9 * letters;
}

/** Merges NER entities into the snapshot (spans with on-screen boxes, PII input values) and returns face/video regions. */
async function applyDetections(tabId: number, snapshot: Snapshot, ml: MlResult): Promise<Region[]> {
  const byId = new Map(ml.ner.map((n) => [n.id, n.entities]));

  // 1. Text nodes: ask the page for the boxes of each entity's characters.
  const items: { nodeId: number; start: number; end: number; category: Detected["category"]; value: string }[] = [];
  for (const n of snapshot.textNodes) {
    for (const e of byId.get(n.nodeId) ?? []) {
      if (n.spans?.some((s) => e.start < s.end && s.start < e.end)) continue; // regex already covers it
      items.push({ nodeId: n.nodeId, start: e.start, end: e.end, category: e.category, value: e.value });
    }
  }
  if (items.length) {
    const query = items.map(({ nodeId, start, end }) => ({ nodeId, start, end }));
    const boxes = (await chrome.tabs.sendMessage(tabId, { type: "boxes", items: query } satisfies Msg)) as Box[][];
    items.forEach((it, i) => {
      const node = snapshot.textNodes.find((n) => n.nodeId === it.nodeId)!;
      const span: PiiSpan = { start: it.start, end: it.end, category: it.category, value: it.value, boxes: boxes[i] ?? [] };
      node.spans = [...(node.spans ?? []), span].sort((a, b) => a.start - b.start);
    });
  }

  // 2. Input values: regex + NER; a field holding PII is painted whole and only its placeholder is sent.
  for (const e of snapshot.elements) {
    if (!e.value || e.redaction) continue;
    const spans: Detected[] = [...detectPII(e.value, { before: e.label ?? "" })];
    for (const ent of byId.get(VALUE_ID + e.id) ?? []) {
      if (!spans.some((s) => ent.start < s.end && s.start < ent.end)) {
        spans.push({ start: ent.start, end: ent.end, category: ent.category, value: ent.value });
      }
    }
    if (spans.length) e.piiValue = { text: e.value, spans: spans.sort((a, b) => a.start - b.start) };
  }

  // 3. Faces (blurred) and every <video> (blurred by default; video calls).
  const regions: Region[] = ml.faces.map((bbox) => ({ bbox, category: "FACE", source: "face", confidence: 1, placeholder: "[FACE]" }));
  for (const o of ml.ocr) regions.push({ bbox: o.bbox, category: o.category, source: "ocr", confidence: 0.8, placeholder: `[${o.category}]` });
  for (const m of snapshot.media) {
    if (m.kind === "video") regions.push({ bbox: m.bbox, category: "VIDEO", source: "dom", confidence: 1, placeholder: "[VIDEO]" });
  }
  return regions;
}
