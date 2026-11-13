import type { Category } from "../shared/types";
import { hasOrgWord, isUiVocabulary, orgLooksLikePerson, promoteWholeNode } from "./align";

export interface NerEntity {
  start: number;
  end: number;
  category: Category;
  value: string;
  score: number;
  tag?: string;
}

const CATEGORY: Record<string, Category | undefined> = { PER: "NAME", LOC: "LOCATION", ORG: "ORG" };
// Per-type confidence floors. Organisations are not redacted ("DemoBank", "City Hospital" would be
// blacked out and hurt task success) unless they look like a person (see orgLooksLikePerson).
const MIN_SCORE: Record<string, number> = { PER: 0.6, LOC: 0.75, ORG: 0.6 };
const BATCH = 16; // sequences per model call
const CACHE_LIMIT = 3000;

/** Tuning/debug knobs set from the request config. */
export const tuning: { minScore?: Partial<Record<string, number>>; debugAll?: boolean } = {};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
export let nerDevice: "webgpu" | "wasm" | "none" = "none";
/** Which NER model the worker loaded (the fine-tuned one, or the Phase 5 fallback). */
export let nerModel = "";
const cache = new Map<string, NerEntity[]>(); // text -> entities, so unchanged text is never re-scored

export function initNer(base: string, device: "webgpu" | "wasm"): Promise<void> {
  worker = new Worker(new URL("./ner.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker!.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") {
        nerDevice = m.device;
        nerModel = m.model ?? "";
        worker!.onmessage = onMessage;
        resolve();
      } else if (m.type === "error") reject(new Error(m.error));
    };
    worker!.onerror = (e) => reject(new Error(e.message));
    worker!.postMessage({ type: "init", base, device });
  });
}

function onMessage(e: MessageEvent): void {
  const m = e.data;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.type === "error") p.reject(new Error(m.error));
  else p.resolve(m);
}

function call(texts: string[]): Promise<{ entities: import("./align").RawEntity[][]; ms: number }> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ type: "run", id, texts });
  });
}

// Names are capitalised; generic UI labels and text the regex layer already covers need no model call.
const worthScoring = (t: string) => /\p{L}{2,}/u.test(t) && /\p{Lu}/u.test(t) && !isUiVocabulary(t);

export interface NerResult {
  byId: Map<number, NerEntity[]>;
  stats: { nodes: number; cacheHits: number; chunks: number; modelMs: number };
}

/** Entities per text id. Uncached texts are scored in length-sorted batches. */
export async function recognise(texts: { id: number; text: string; skip?: boolean }[]): Promise<NerResult> {
  if (tuning.debugAll) cache.clear();
  const byId = new Map<number, NerEntity[]>();
  const stats = { nodes: 0, cacheHits: 0, chunks: 0, modelMs: 0 };
  const todo: { id: number; text: string; skip?: boolean }[] = [];
  for (const t of texts) {
    if (t.skip || !worthScoring(t.text)) continue;
    stats.nodes++;
    const hit = cache.get(t.text);
    if (hit) {
      stats.cacheHits++;
      byId.set(t.id, hit);
    } else todo.push(t);
  }

  // One sequence per text node: sharing a sequence lets neighbouring page text (table headers, lists)
  // change the labels, and short isolated texts score far better. Sorting by length keeps batch padding small.
  todo.sort((x, y) => x.text.length - y.text.length);
  const chunks = todo.map((t) => ({ text: t.text, members: [{ ...t, offset: 0 }] }));
  stats.chunks = chunks.length;
  if (chunks.length) {
    const entities: import("./align").RawEntity[][] = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      const r = await call(chunks.slice(i, i + BATCH).map((c) => c.text));
      entities.push(...r.entities);
      stats.modelMs += r.ms;
    }
    chunks.forEach((c, ci) => {
      for (const m of c.members) {
        const mine: NerEntity[] = [];
        const local = entities[ci]
          .map((e) => ({ ...e, start: e.start - m.offset, end: Math.min(e.end - m.offset, m.text.length) }))
          .filter((e) => e.start >= 0 && e.end > e.start); // the rest belongs to a neighbouring text
        for (const e of local) {
          const value = m.text.slice(e.start, e.end);
          let category = CATEGORY[e.tag];
          if (e.tag === "ORG" && orgLooksLikePerson(value)) category = "NAME";
          if (tuning.debugAll) {
            mine.push({ start: e.start, end: e.end, category: category ?? "NAME", value, score: e.score, tag: e.tag });
            continue;
          }
          if (!category || category === "ORG" || e.score < (tuning.minScore?.[e.tag] ?? MIN_SCORE[e.tag] ?? 1)) continue;
          if (value.length < 3 || isUiVocabulary(value) || hasOrgWord(value)) continue;
          mine.push({ start: e.start, end: e.end, category, value, score: e.score, tag: e.tag });
        }
        // Table cells etc.: a node that is just a short Title-case name where the model saw part of it.
        const whole = tuning.debugAll ? null : promoteWholeNode(m.text, local);
        if (whole && !mine.some((x) => x.start <= whole.start && x.end >= whole.end)) {
          mine.length = 0;
          mine.push({ ...whole, category: "NAME", value: m.text.slice(whole.start, whole.end), score: 0.5, tag: "PER" });
        }
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        cache.set(m.text, mine);
        byId.set(m.id, mine);
      }
    });
  }
  return { byId, stats };
}
