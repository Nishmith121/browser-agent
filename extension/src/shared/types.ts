export type Category =
  | "PASSWORD"
  | "OTP"
  | "CARD"
  | "CVV"
  | "PIN"
  | "AADHAAR"
  | "PAN"
  | "ACCOUNT"
  | "IFSC"
  | "SSN"
  | "DOB"
  | "SECURITY_ANSWER"
  | "PHONE"
  | "EMAIL"
  | "AMOUNT"
  | "NAME"
  | "ADDRESS"
  | "LOCATION"
  | "ORG"
  | "FACE"
  | "VIDEO"
  | "SECRET";

export type Box = [number, number, number, number];

export interface InteractiveElement {
  id: number;
  tag: string;
  role: string | null;
  type: string | null;
  name: string | null;
  label: string | null;
  placeholder: string | null;
  text: string;
  /** [x, y, w, h] in CSS pixels, viewport-relative. */
  bbox: Box;
  visible: boolean;
  /** Set by Layer A DOM rules; the field's value is never read regardless. */
  redaction: Category | null;
  /** Raw value of a NON-sensitive text field (never for sensitive/password fields). Local only; it is turned
   * into `piiValue` when a detector finds PII in it, and is never sent as-is. */
  value?: string;
  /** Set (locally) when the value contains PII; the whole field is then painted and only placeholders are sent. */
  piiValue?: PiiValue;
}

/** A detected value inside a string (offsets into that string). */
export interface Detected {
  start: number;
  end: number;
  category: Category;
  value: string;
}

export interface PiiValue {
  text: string;
  spans: Detected[];
}

/** Structured PII found in a text node; offsets are into the trimmed node text. */
export interface PiiSpan {
  start: number;
  end: number;
  category: Category;
  value: string;
  /** On-screen boxes (CSS px) covering exactly these characters. */
  boxes: Box[];
}

export interface TextNodeBox {
  nodeId: number;
  text: string;
  bbox: Box;
  spans?: PiiSpan[];
}

/** Visual content that may hold faces or text: <img>, <video>, <canvas>. */
export interface MediaBox {
  kind: "img" | "video" | "canvas";
  bbox: Box;
}

export interface Snapshot {
  url: string;
  title: string;
  viewport: { width: number; height: number; dpr: number };
  elements: InteractiveElement[];
  textNodes: TextNodeBox[];
  media: MediaBox[];
}

/** One area to paint over. Every region carries its provenance (Section 5). */
export interface Region {
  bbox: Box;
  category: Category;
  source: "dom" | "vault" | "regex" | "ner" | "face" | "ocr";
  confidence: number;
  placeholder: string;
}

export interface OutgoingElement {
  id: number;
  tag: string;
  type: string | null;
  label: string | null;
  text: string;
  placeholder: string | null;
  /** Placeholder-only value of a field whose content was PII, e.g. "[PHONE_1]". */
  value?: string;
  bbox: Box;
  redacted?: true;
  category?: Category;
}

/** Everything (besides the redacted screenshot) that may leave the device. */
export interface OutgoingPayload {
  url: string;
  title: string;
  viewport: { width: number; height: number; scale: number };
  elements: OutgoingElement[];
  texts: string[];
  /** Names only, never values. */
  available_secrets: string[];
  redaction_summary: Record<string, number>;
}

export type Msg =
  | { type: "snapshot" }
  | { type: "capture"; tabId?: number }
  | { type: "boxes"; items: { nodeId: number; start: number; end: number }[] };

export interface ObserveResult {
  /** Redacted screenshot with Set-of-Marks overlay (PNG data URL). The raw screenshot never leaves the background worker. */
  image: string;
  /** null when the leak guard blocked the send. */
  payload: OutgoingPayload | null;
  regions: Region[];
  guard: { blocked: boolean; hits: string[] };
  timingMs: Record<string, number>;
  /** Which on-device backends ran this step and how much of the NER work was served from cache. */
  ml?: { backend: { ner: string; face: string; nerModel?: string }; nerStats: { nodes: number; cacheHits: number; chunks: number } };
}
