/** Pure helpers for turning token-classification output into character spans (unit-tested). */

export interface RawEntity {
  start: number;
  end: number;
  tag: "PER" | "LOC" | "ORG" | "MISC";
  score: number;
}

export interface Token {
  entity: string; // "B-PER", "I-LOC", ...
  score: number;
  word: string;
}

/**
 * Transformers.js does not return character offsets, so tokens are aligned back to the text in order.
 * Merging rules (the English CoNLL model tags every word-piece of an unfamiliar name as "B-PER"):
 *  - tokens that touch in the text are pieces of one word and always merge;
 *  - tokens one space apart merge when the tag matches and it is a continuation (I-) or a person (names have 2-3 words);
 *  - a newline gap (the separator between page text nodes) never merges.
 */
export function align(text: string, tokens: Token[]): RawEntity[] {
  const out: (RawEntity & { n: number })[] = [];
  let cursor = 0;
  let cur: (RawEntity & { n: number }) | null = null;
  for (const t of tokens) {
    const piece = t.word.replace(/^##/, "");
    if (!piece) continue;
    const at = text.indexOf(piece, cursor);
    if (at < 0) continue; // [UNK] or normalised away
    const tag = t.entity.slice(2) as RawEntity["tag"];
    const begins = t.entity.startsWith("B-");
    const gap = cur ? text.slice(cur.end, at) : "";
    cursor = at + piece.length;
    const touching = cur !== null && gap === "" ;
    const spaced = cur !== null && gap === " " && cur.tag === tag && (!begins || tag === "PER");
    if (cur && (touching || spaced)) {
      cur.end = cursor;
      cur.score = Math.max(cur.score, t.score); // judged by its most confident piece (later pieces of a name are often weak)
      cur.n++;
      if (touching && t.entity.startsWith("B-") && cur.tag !== tag) cur.tag = tag; // a later piece may carry the better tag
    } else {
      cur = { start: at, end: cursor, tag, score: t.score, n: 1 };
      out.push(cur);
    }
  }
  return mergePersons(text, out.map(({ n: _n, ...e }) => e));
}

/**
 * In page context the model often tags only the first word-pieces of a name ("Chandre" of "Chandresh",
 * "Day" of "Dayal"). Entities are widened to whole words, then neighbouring person words are joined.
 */
function mergePersons(text: string, ents: RawEntity[]): RawEntity[] {
  const widened = ents.map((e) => {
    let { start, end } = e;
    while (end < text.length && /[\p{L}\p{M}]/u.test(text[end])) end++;
    while (start > 0 && /[\p{L}\p{M}]/u.test(text[start - 1])) start--;
    return { ...e, start, end };
  });
  const out: RawEntity[] = [];
  for (const e of widened) {
    const prev = out[out.length - 1];
    const gap = prev ? text.slice(prev.end, e.start) : "";
    if (prev && prev.tag === "PER" && e.tag === "PER" && (gap === "" || gap === " ")) {
      prev.end = Math.max(prev.end, e.end);
      prev.score = Math.max(prev.score, e.score);
    } else if (prev && e.start < prev.end) {
      prev.end = Math.max(prev.end, e.end);
    } else out.push({ ...e });
  }
  return out;
}

// Words that mark an organisation, not a person ("City Hospital", "HR Portal").
const ORG_WORDS = /\b(?:hospital|clinic|bank|portal|mart|mail|mailbox|meet|inc|ltd|llp|pvt|limited|corp|company|university|college|school|institute|department|services|solutions|technologies|systems|store|shop|online|group)\b/i;

/** Indian names are often tagged ORG by an English-trained model. A 2-3 word, Title-case, letters-only
 * "organisation" without an organisation word is treated as a person. Heuristic until the Phase 8 fine-tune. */
export function orgLooksLikePerson(value: string): boolean {
  const words = value.trim().split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  if (ORG_WORDS.test(value)) return false;
  return words.every((w) => /^\p{Lu}[\p{Ll}'.-]{1,}$/u.test(w));
}

export const hasOrgWord = (value: string): boolean => ORG_WORDS.test(value);

// Generic web-UI vocabulary the English NER model confidently mistakes for people/places ("Aadhaar" -> PER).
const UI_WORDS = new Set(
  ("aadhaar pan apply leave profile dashboard transfer inbox compose search cart checkout appointments records meeting login logout log out sign in " +
    "home settings help account balance email mobile phone address name submit save send reply cancel next back menu view edit delete add new ifsc dob otp cvv " +
    "card payee amount order book date from to subject message password username employee patient customer shipping delivery ship saved registered contact " +
    "emergency leave type reason casual sick earned department preferred upcoming appointment medical record notes note chat weekly sync my your the a an of and or for on at by with").split(" "),
);

/** True when every word is generic UI vocabulary (so the entity is a label, not a person or place). */
export function isUiVocabulary(value: string): boolean {
  const words = value.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => UI_WORDS.has(w));
}

/**
 * A text node that is only 2-3 Title-case words (a table cell, a "Name" value) and where the model recognised
 * part of it as a person/organisation/location is a name: widen to the whole node. Returns null otherwise.
 */
export function promoteWholeNode(text: string, ents: { start: number; end: number; tag: string }[]): { start: number; end: number } | null {
  const t = text.trim();
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 3 || !ents.length) return null;
  if (hasOrgWord(t) || isUiVocabulary(t)) return null;
  if (!words.every((w) => /^\p{Lu}[\p{Ll}'.-]+$/u.test(w))) return null;
  const start = text.indexOf(t);
  return { start, end: start + t.length };
}
