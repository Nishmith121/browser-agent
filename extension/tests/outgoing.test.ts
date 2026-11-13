import { describe, expect, it } from "vitest";
import { leakGuard } from "../src/redaction/leakGuard";
import { RedactionMap } from "../src/redaction/redactionMap";
import { buildOutgoing, regionsFor, sanitiseText } from "../src/redaction/regions";
import type { Snapshot } from "../src/shared/types";
import { substitute } from "../src/vault";

const secrets = { PASSWORD: "Pw!421141x", OTP: "482915", "payee-card": "4111 1111 1111 1111" };

const snap = (): Snapshot => ({
  url: "http://localhost:8080/demobank/login",
  title: "DemoBank - Login",
  viewport: { width: 1280, height: 800, dpr: 1 },
  elements: [
    { id: 1, tag: "input", role: null, type: "text", name: "username", label: "Username", placeholder: null, text: "", bbox: [10, 10, 200, 30], visible: true, redaction: null },
    { id: 2, tag: "input", role: null, type: "password", name: "password", label: "Password", placeholder: "Pw!421141x", text: "", bbox: [10, 60, 200, 30], visible: true, redaction: "PASSWORD" },
    { id: 3, tag: "button", role: null, type: "submit", name: null, label: null, placeholder: null, text: "Sign in", bbox: [10, 110, 80, 30], visible: true, redaction: null },
  ],
  textNodes: [
    { nodeId: 0, text: "Sign in", bbox: [10, 0, 50, 10] },
    { nodeId: 1, text: "Your code is 482915", bbox: [10, 150, 150, 14] },
  ],
});

describe("outgoing payload", () => {
  it("never contains vault values and keeps redacted labels", () => {
    const regions = regionsFor(snap(), secrets);
    const payload = buildOutgoing(snap(), secrets, regions, new RedactionMap());
    const json = JSON.stringify(payload);
    expect(json).not.toContain("Pw!421141x");
    expect(json).not.toContain("482915");
    expect(leakGuard(json, secrets)).toEqual([]);
    const pw = payload.elements.find((e) => e.id === 2)!;
    expect(pw).toMatchObject({ label: "Password", redacted: true, category: "PASSWORD", text: "", placeholder: null });
    expect(payload.texts).toContain("Your code is [REDACTED_SECRET]");
    expect(payload.available_secrets).toEqual(["PASSWORD", "OTP", "payee-card"]);
  });

  it("paints dom-rule fields and vault text, with provenance", () => {
    const regions = regionsFor(snap(), secrets);
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({ category: "PASSWORD", source: "dom", bbox: [10, 60, 200, 30] });
    expect(regions[1]).toMatchObject({ category: "SECRET", source: "vault", bbox: [10, 150, 150, 14] });
    expect(buildOutgoing(snap(), secrets, regions, new RedactionMap()).redaction_summary).toEqual({ PASSWORD: 1, SECRET: 1 });
  });
});

describe("leak guard", () => {
  it("blocks exact and normalised vault values, reporting names only", () => {
    expect(leakGuard('{"a":"x Pw!421141x y"}', secrets)).toEqual(["PASSWORD"]);
    expect(leakGuard('{"a":"4111-1111-1111-1111"}', secrets)).toEqual(["payee-card", "PII:CARD"]); // vault hit + regex hit
    expect(leakGuard('{"a":"4111111111111111"}', secrets)).toEqual(["payee-card", "PII:CARD"]);
  });
  it("passes clean JSON and ignores too-short secrets", () => {
    expect(leakGuard('{"a":"hello"}', secrets)).toEqual([]);
    expect(leakGuard('{"a":"12"}', { X: "12" })).toEqual([]);
  });
});

describe("text sanitiser and vault substitution", () => {
  it("sanitiseText replaces every occurrence", () => {
    expect(sanitiseText("Pw!421141x and Pw!421141x", secrets)).toBe("[REDACTED_SECRET] and [REDACTED_SECRET]");
  });
  it("substitutes placeholders at execution time and reports missing ones", () => {
    expect(substitute("{PASSWORD}", secrets)).toEqual({ text: "Pw!421141x", missing: [] });
    expect(substitute("{SECRET:payee-card}", secrets).text).toBe("4111 1111 1111 1111");
    expect(substitute("a {OTP} b {SECRET:nope}", { OTP: "1" })).toEqual({ text: "a 1 b {SECRET:nope}", missing: ["nope"] });
  });
});


describe("structured PII (Layer B) in the payload", () => {
  const withPii = (): Snapshot => ({
    ...snap(),
    url: "http://localhost:8080/hr/profile?p=3",
    elements: [
      { id: 1, tag: "input", role: null, type: "tel", name: "phone", label: "Mobile number", placeholder: null, text: "", bbox: [10, 10, 200, 30], visible: true, redaction: null, piiValue: { text: "9876543210", spans: [{ start: 0, end: 10, category: "PHONE", value: "9876543210" }] } },
      { id: 2, tag: "a", role: null, type: null, name: null, label: null, placeholder: null, text: "mail a@b.com", bbox: [10, 50, 80, 20], visible: true, redaction: null },
    ],
    textNodes: [
      { nodeId: 0, text: "PAN ABCPE1234F, Aadhaar 726018159082", bbox: [10, 80, 300, 16], spans: [
        { start: 4, end: 14, category: "PAN", value: "ABCPE1234F", boxes: [[50, 80, 80, 16]] },
        { start: 24, end: 36, category: "AADHAAR", value: "726018159082", boxes: [[200, 80, 110, 16]] },
      ] },
    ],
  });

  it("turns PII into placeholders everywhere, paints each span, and passes the guard", () => {
    const map = new RedactionMap();
    const regions = regionsFor(withPii(), {});
    const payload = buildOutgoing(withPii(), {}, regions, map);
    const json = JSON.stringify(payload);
    for (const v of ["9876543210", "ABCPE1234F", "726018159082", "a@b.com"]) expect(json).not.toContain(v);
    expect(payload.texts).toEqual(["PAN [PAN_1], Aadhaar [AADHAAR_1]"]);
    expect(payload.elements[0]).toMatchObject({ value: "[PHONE_1]", redacted: true });
    expect(payload.elements[1].text).toBe("mail [EMAIL_1]");
    expect(regions.map((r) => [r.category, r.source])).toEqual([["PHONE", "regex"], ["PAN", "regex"], ["AADHAAR", "regex"]]);
    expect(regions[0].bbox).toEqual([10, 10, 200, 30]); // whole input is painted
    expect(leakGuard(json, {})).toEqual([]);
    expect(map.restore("[PHONE_1]").text).toBe("9876543210");
  });

  it("leak guard blocks PII that slipped through, naming only the category", () => {
    expect(leakGuard('{"texts":["call 9876543210"]}', {})).toEqual(["PII:PHONE"]);
    expect(leakGuard('{"a":"ABCPE1234F 726018159082"}', {}).sort()).toEqual(["PII:AADHAAR", "PII:PAN"]);
  });

  it("guard does not trip on ordinary payload numbers", () => {
    const p = buildOutgoing(snap(), secrets, [], new RedactionMap());
    expect(leakGuard(JSON.stringify(p), {})).toEqual([]);
  });
});


describe("entities found by the NER model", () => {
  const nameSnap = (): Snapshot => ({
    ...snap(),
    elements: [
      { id: 1, tag: "a", role: null, type: null, name: null, label: "Oscar Iyer", placeholder: null, text: "Oscar Iyer", bbox: [10, 10, 80, 20], visible: true, redaction: null },
      { id: 2, tag: "input", role: null, type: "text", name: "n", label: "Full name", placeholder: null, text: "", bbox: [10, 40, 200, 30], visible: true, redaction: null,
        piiValue: { text: "Oscar Iyer", spans: [{ start: 0, end: 10, category: "NAME", value: "Oscar Iyer" }] } },
    ],
    title: "Profile of Oscar Iyer",
    textNodes: [{ nodeId: 0, text: "Hello Oscar Iyer, welcome back", bbox: [10, 80, 200, 16], spans: [
      { start: 6, end: 16, category: "NAME", value: "Oscar Iyer", boxes: [[50, 80, 70, 16]] },
    ] }],
  });

  it("a name found in one text is replaced in labels, titles and element text too", () => {
    const map = new RedactionMap();
    const payload = buildOutgoing(nameSnap(), {}, regionsFor(nameSnap(), {}), map);
    const json = JSON.stringify(payload);
    expect(json).not.toContain("Oscar");
    expect(payload.texts).toEqual(["Hello [NAME_1], welcome back"]);
    expect(payload.title).toBe("Profile of [NAME_1]");
    expect(payload.elements[0]).toMatchObject({ label: "[NAME_1]", text: "[NAME_1]" });
    expect(payload.elements[1].value).toBe("[NAME_1]");
    expect(map.restore("[NAME_1]").text).toBe("Oscar Iyer");
  });

  it("does not replace the name inside a longer word, and survives a map round trip", () => {
    const map = new RedactionMap();
    map.sanitise("x");
    map.assign("NAME", "Ram");
    expect(map.sanitise("Ram and Ramesh and Programme")).toBe("[NAME_1] and Ramesh and Programme");
    const again = new RedactionMap(map.toJSON());
    expect(again.sanitise("hi Ram")).toBe("hi [NAME_1]");
  });

  it("paints names as ner-sourced regions and the leak guard catches a name that slipped through", () => {
    const regions = regionsFor(nameSnap(), {});
    expect(regions.map((r) => [r.category, r.source])).toEqual([["NAME", "ner"], ["NAME", "ner"]]);
    expect(leakGuard('{"texts":["Hello Oscar Iyer"]}', {}, ["Oscar Iyer"])).toEqual(["PII:ENTITY"]);
    expect(leakGuard('{"texts":["Hello [NAME_1]"]}', {}, ["Oscar Iyer"])).toEqual([]);
    expect(leakGuard('{"texts":["Oscar Iyerson"]}', {}, ["Oscar Iyer"])).toEqual([]); // token boundary
  });
});
