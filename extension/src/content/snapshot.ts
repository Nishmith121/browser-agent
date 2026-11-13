import { detectPII } from "../redaction/regex";
import { classifyField } from "../redaction/rules";
import type { Box, InteractiveElement, MediaBox, PiiSpan, Snapshot, TextNodeBox } from "../shared/types";

const INTERACTIVE =
  "a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[onclick]";

function rectOf(r: DOMRect): Box {
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
}

function inViewport(r: DOMRect): boolean {
  return (
    r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
    r.top < window.innerHeight && r.left < window.innerWidth
  );
}

function isHidden(el: Element): boolean {
  const s = getComputedStyle(el);
  return s.visibility === "hidden" || s.display === "none" || s.opacity === "0";
}

function labelFor(el: Element): string | null {
  const id = el.getAttribute("id");
  if (id) {
    const l = document.querySelector(`label[for="${(typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id)}"]`);
    if (l?.textContent) return l.textContent.trim();
  }
  return el.closest("label")?.textContent?.trim() || el.getAttribute("aria-label");
}

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "image", "hidden", "range", "color"]);

/** Raw value of a non-sensitive text field. Stays on the device: the background turns it into a placeholder or drops it. */
function rawValue(el: HTMLInputElement): { value?: string } {
  if (el.tagName === "SELECT" || NON_TEXT_INPUTS.has(el.type) || !el.value) return {};
  return { value: el.value.slice(0, 300) };
}

/** Assigns stable numeric ids through data-ps-id and returns the interactive elements in the viewport. */
export function markElements(): InteractiveElement[] {
  const out: InteractiveElement[] = [];
  let next = 1;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-ps-id]"))) {
    next = Math.max(next, Number(el.dataset.psId) + 1);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE))) {
    const r = el.getBoundingClientRect();
    if (isHidden(el) || !inViewport(r)) continue;
    if (!el.dataset.psId) el.dataset.psId = String(next++);
    const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    const label = labelFor(el);
    const redaction = isField
      ? classifyField({
          type: (el as HTMLInputElement).type,
          autocomplete: el.getAttribute("autocomplete"),
          name: el.getAttribute("name"),
          id: el.getAttribute("id"),
          ariaLabel: el.getAttribute("aria-label"),
          placeholder: el.getAttribute("placeholder"),
          label,
        })
      : null;
    out.push({
      id: Number(el.dataset.psId),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      type: (el as HTMLInputElement).type ?? null,
      name: el.getAttribute("name"),
      label,
      placeholder: el.getAttribute("placeholder"),
      // Values of sensitive fields are never read. Others are read only to look for PII locally.
      ...(isField && !redaction ? rawValue(el as HTMLInputElement) : {}),
      text: isField ? "" : (el.textContent ?? "").trim().slice(0, 120),
      bbox: rectOf(r),
      visible: true,
      redaction,
    });
  }
  return out;
}

const BLOCK = "div,p,li,tr,td,th,dd,dt,section,form,label,article,header,main";

function boxesFor(n: Text, from: number, to: number): Box[] {
  const range = document.createRange();
  range.setStart(n, from);
  range.setEnd(n, to);
  const rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
  const list = rects.length ? rects : [range.getBoundingClientRect()];
  return list.filter(inViewport).map(rectOf);
}

/** Text nodes of the last snapshot, so the background can ask for on-screen boxes of detected character ranges. */
let registry: { node: Text; lead: number }[] = [];

export function textNodes(): TextNodeBox[] {
  const out: TextNodeBox[] = [];
  registry = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let id = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const raw = n.textContent ?? "";
    const text = raw.trim();
    const parent = n.parentElement;
    if (!text || !parent || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName) || isHidden(parent)) continue;
    // Option/textarea text is field content (could be a sensitive value), not page text.
    if (parent.closest("select,textarea")) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (!inViewport(r)) continue;

    // Labels live in sibling nodes ("Account number" next to its value), so give the detectors the block text.
    const block = (parent.closest(BLOCK)?.textContent ?? "").replace(/\s+/g, " ");
    const flat = text.replace(/\s+/g, " ");
    const at = block.indexOf(flat);
    const found = detectPII(text, {
      before: at >= 0 ? block.slice(Math.max(0, at - 40), at) : "",
      after: at >= 0 ? block.slice(at + flat.length, at + flat.length + 40) : "",
    });
    const lead = raw.length - raw.trimStart().length;
    const spans: PiiSpan[] = found.map((f) => ({ ...f, boxes: boxesFor(n, lead + f.start, lead + f.end) }));
    registry[id] = { node: n, lead };
    out.push({ nodeId: id++, text, bbox: rectOf(r), ...(spans.length ? { spans } : {}) });
  }
  return out;
}

/** On-screen boxes for character ranges [start,end) of snapshot text nodes (offsets into the trimmed text). */
export function boxesForRanges(items: { nodeId: number; start: number; end: number }[]): Box[][] {
  return items.map(({ nodeId, start, end }) => {
    const e = registry[nodeId];
    return e && e.node.isConnected ? boxesFor(e.node, e.lead + start, e.lead + end) : [];
  });
}

export function media(): MediaBox[] {
  const out: MediaBox[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("img,video,canvas"))) {
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24 || isHidden(el) || !inViewport(r)) continue;
    out.push({ kind: el.tagName.toLowerCase() as MediaBox["kind"], bbox: rectOf(r) });
  }
  return out;
}

export function snapshot(): Snapshot {
  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    elements: markElements(),
    textNodes: textNodes(),
    media: media(),
  };
}
