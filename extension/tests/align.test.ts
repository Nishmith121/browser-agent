import { describe, expect, it } from "vitest";
import { align, orgLooksLikePerson } from "../src/offscreen/align";

const tok = (entity: string, word: string, score = 0.95) => ({ entity, word, score });

describe("align (token classification -> character spans)", () => {
  it("merges word-pieces that touch, even when each is tagged B-PER (real model output for 'Chandresh Dayal')", () => {
    const text = "Chandresh Dayal";
    const spans = align(text, [tok("B-PER", "Chan", 1), tok("B-PER", "dre", 0.99), tok("B-PER", "sh", 0.68), tok("B-PER", "Dayal", 0.93)]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Chandresh Dayal"]);
    expect(spans[0].tag).toBe("PER");
  });

  it("keeps two different words of a person together, but not across a newline (text-node separator)", () => {
    const text = "Oscar Iyer\nMason Viswanathan";
    const spans = align(text, [tok("B-PER", "Oscar"), tok("I-PER", "Iyer"), tok("B-PER", "Mason"), tok("I-PER", "Viswanathan")]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Oscar Iyer", "Mason Viswanathan"]);
  });

  it("does not merge different entity types or a new location after a location", () => {
    const text = "Oscar lives in Delhi Mumbai";
    const spans = align(text, [tok("B-PER", "Oscar"), tok("B-LOC", "Delhi"), tok("B-LOC", "Mumbai")]);
    expect(spans.map((s) => [s.tag, text.slice(s.start, s.end)])).toEqual([["PER", "Oscar"], ["LOC", "Delhi"], ["LOC", "Mumbai"]]);
  });

  it("skips tokens it cannot find (unknown pieces) without losing the cursor", () => {
    const text = "Hi Anita Rao";
    const spans = align(text, [tok("B-PER", "[UNK]"), tok("B-PER", "Anita"), tok("I-PER", "Rao")]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Anita Rao"]);
  });
});

describe("align in page context (real model output)", () => {
  it("widens partially tagged names to whole words and joins them: 'Chandre'+'Day' -> 'Chandresh Dayal'", () => {
    const text = "Welcome,\nChandresh Dayal\nAccount number";
    // "##sh" and "##al" came back as 'O' in a full-page chunk, leaving only these tokens:
    const spans = align(text, [tok("B-PER", "Chan", 0.91), tok("B-PER", "##dre", 0.39), tok("I-PER", "Day", 0.68)]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Chandresh Dayal"]);
  });

  it("never joins names across a newline (separate page text nodes)", () => {
    const text = "Oscar Iyer\nMason Viswanathan";
    const spans = align(text, [tok("B-PER", "Oscar"), tok("I-PER", "I"), tok("I-PER", "##yer"), tok("I-PER", "Mason"), tok("I-PER", "V")]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Oscar Iyer", "Mason Viswanathan"]);
  });

  it("does not swallow punctuation or the next word", () => {
    const text = "Dear Anita, thanks";
    const spans = align(text, [tok("B-PER", "An"), tok("I-PER", "##ita")]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Anita"]);
  });
});

describe("orgLooksLikePerson", () => {
  it("treats 2-3 Title-case words as a person unless an organisation word is present", () => {
    expect(orgLooksLikePerson("Ojas Memon")).toBe(true);
    expect(orgLooksLikePerson("Mason Viswanathan")).toBe(true);
    expect(orgLooksLikePerson("City Hospital")).toBe(false);
    expect(orgLooksLikePerson("HR Portal")).toBe(false);
    expect(orgLooksLikePerson("DemoBank")).toBe(false);
    expect(orgLooksLikePerson("Weekly sync")).toBe(false);
    expect(orgLooksLikePerson("A B C D")).toBe(false);
  });
});

import { hasOrgWord, isUiVocabulary, promoteWholeNode } from "../src/offscreen/align";

describe("node-level name rules", () => {
  it("promotes a short Title-case text to a whole-node name when the model saw part of it", () => {
    expect(promoteWholeNode("Ojas Memon", [{ start: 0, end: 4, tag: "ORG" }])).toEqual({ start: 0, end: 10 });
    expect(promoteWholeNode("Oscar Iyer", [{ start: 0, end: 10, tag: "ORG" }])).toEqual({ start: 0, end: 10 });
    expect(promoteWholeNode("Ojas Memon", [])).toBeNull(); // model saw nothing
    expect(promoteWholeNode("Project kickoff", [{ start: 0, end: 7, tag: "ORG" }])).toBeNull(); // not all Title-case
    expect(promoteWholeNode("City Hospital", [{ start: 0, end: 13, tag: "LOC" }])).toBeNull(); // organisation word
    expect(promoteWholeNode("Apply Leave", [{ start: 0, end: 5, tag: "LOC" }])).toBeNull(); // UI vocabulary
  });

  it("recognises UI vocabulary and organisation words", () => {
    for (const w of ["Aadhaar", "Apply leave", "My profile", "Sign in", "Registered mobile"]) expect(isUiVocabulary(w), w).toBe(true);
    for (const w of ["Chandresh Dayal", "Mason Viswanathan", "Delhi"]) expect(isUiVocabulary(w), w).toBe(false);
    expect(hasOrgWord("City Hospital")).toBe(true);
    expect(hasOrgWord("Oscar Iyer")).toBe(false);
  });
});
