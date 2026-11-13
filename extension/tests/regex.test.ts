import { describe, expect, it } from "vitest";
import { RedactionMap } from "../src/redaction/redactionMap";
import { detectPII, luhnValid, verhoeffValid } from "../src/redaction/regex";

const AADHAAR = "726018159082"; // Verhoeff-valid, synthetic
const BAD_AADHAAR = "523194875749"; // fails Verhoeff
const CARD = "4111112462819484"; // Luhn-valid, test BIN
const BAD_CARD = "1186252760189555"; // fails Luhn

const cats = (t: string, o = {}) => detectPII(t, o).map((s) => `${s.category}:${s.value}`);

describe("checksums", () => {
  it("validates", () => {
    expect(verhoeffValid(AADHAAR)).toBe(true);
    expect(verhoeffValid(BAD_AADHAAR)).toBe(false);
    expect(luhnValid(CARD)).toBe(true);
    expect(luhnValid(BAD_CARD)).toBe(false);
  });
});

describe("structured detectors", () => {
  it("aadhaar: plain and grouped, Verhoeff-checked", () => {
    expect(cats(AADHAAR)).toEqual([`AADHAAR:${AADHAAR}`]);
    const g = `${AADHAAR.slice(0, 4)} ${AADHAAR.slice(4, 8)} ${AADHAAR.slice(8)}`;
    expect(cats(`Aadhaar: ${g}`)).toEqual([`AADHAAR:${g}`]);
    expect(cats(BAD_AADHAAR)).toEqual([]);
  });

  it("pan: format and 4th-letter validator", () => {
    expect(cats("PAN ABCPE1234F")).toEqual(["PAN:ABCPE1234F"]);
    expect(cats("ABCXE1234F")).toEqual([]); // X is not a holder type
    expect(cats("ABCPE12345")).toEqual([]);
  });

  it("indian phone: prefixes and grouping, not inside longer numbers", () => {
    expect(cats("call 9876543210 now")).toEqual(["PHONE:9876543210"]);
    expect(cats("+91 98765 43210")).toEqual(["PHONE:+91 98765 43210"]);
    expect(cats("+919876543210")).toEqual(["PHONE:+919876543210"]);
    expect(cats("09876543210")).toEqual(["PHONE:09876543210"]);
    expect(cats("5876543210")).toEqual([]); // must start 6-9
    expect(cats("98765432101")).toEqual([]); // 11 digits
  });

  it("email", () => {
    expect(cats("mail a.b+c@example.co.in please")).toEqual(["EMAIL:a.b+c@example.co.in"]);
    expect(cats("not an email@")).toEqual([]);
  });

  it("card: spaced/dashed, Luhn-checked, wins over aadhaar-lookalike prefix", () => {
    const spaced = `${CARD.slice(0, 4)} ${CARD.slice(4, 8)} ${CARD.slice(8, 12)} ${CARD.slice(12)}`;
    expect(cats(spaced)).toEqual([`CARD:${spaced}`]);
    expect(cats(CARD.replace(/(.{4})/g, "$1-").slice(0, -1))).toHaveLength(1);
    expect(cats(BAD_CARD)).toEqual([]);
  });

  it("ifsc", () => {
    expect(cats("IFSC HDFC0123456")).toEqual(["IFSC:HDFC0123456"]);
    expect(cats("HDFC1123456")).toEqual([]);
  });
});

describe("context detectors", () => {
  it("account number needs a keyword within 40 chars (own text or sibling label)", () => {
    expect(cats("Account number: 123456789012")).toEqual(["ACCOUNT:123456789012"]);
    expect(cats("98765432101234", { before: "A/C no " })).toEqual(["ACCOUNT:98765432101234"]);
    expect(cats("order id 123456789012")).toEqual([]);
    expect(cats("Account number: 123456789012", { contextual: false })).toEqual([]);
  });

  it("date of birth needs a birth keyword", () => {
    expect(cats("DOB: 05/03/1990")).toEqual(["DOB:05/03/1990"]);
    expect(cats("12 Jan 1990", { before: "Date of birth " })).toEqual(["DOB:12 Jan 1990"]);
    expect(cats("1990-03-05", { before: "Born " })).toEqual(["DOB:1990-03-05"]);
    expect(cats("Appointment on 05/03/2026")).toEqual([]);
  });

  it("currency only when enabled", () => {
    expect(cats("Balance Rs 1,25,000.50")).toEqual([]);
    expect(cats("Balance Rs 1,25,000.50 and ₹500", { currency: true })).toEqual(["AMOUNT:Rs 1,25,000.50", "AMOUNT:₹500"]);
  });
});

describe("RedactionMap", () => {
  it("same value -> same placeholder, formatting-insensitive, restorable", () => {
    const m = new RedactionMap();
    const a = m.sanitise("Call 98765 43210 or 9876543210, mail a@b.com; PAN ABCPE1234F");
    expect(a).toBe("Call [PHONE_1] or [PHONE_1], mail [EMAIL_1]; PAN [PAN_1]");
    expect(m.sanitise("9123456780")).toBe("[PHONE_2]");
    expect(m.restore("type [PHONE_2] then [PHONE_1]")).toEqual({ text: "type 9123456780 then 98765 43210", missing: [] });
    expect(m.restore("[PHONE_9]").missing).toEqual(["[PHONE_9]"]);
  });

  it("survives serialisation and keeps numbering", () => {
    const m = new RedactionMap();
    m.sanitise("9876543210");
    const m2 = new RedactionMap(m.toJSON());
    expect(m2.sanitise("9876543210")).toBe("[PHONE_1]");
    expect(m2.sanitise("9123456780")).toBe("[PHONE_2]");
  });

  it("sanitised output contains no detectable PII (the leak-guard invariant)", () => {
    const m = new RedactionMap();
    const text = `${AADHAAR} ${CARD} 9876543210 x@y.com ABCPE1234F HDFC0123456`;
    expect(detectPII(m.sanitise(text), { contextual: false })).toEqual([]);
  });
});

describe("address detector", () => {
  it("detects every synthetic persona address as one full-length span", async () => {
    const { readFileSync } = await import("node:fs");
    const personas = JSON.parse(readFileSync("../testsites/personas.json", "utf8")) as { address: string; new_address: string }[];
    for (const p of personas) {
      for (const a of [p.address, p.new_address]) {
        const spans = detectPII(a).filter((s) => s.category === "ADDRESS");
        expect(spans.map((s) => s.value), a).toEqual([a]);
      }
    }
  });

  it("finds an address inside a sentence, and street-word addresses without a PIN", () => {
    expect(cats("Ship to 455, Apte Zila, Kakinada 498341 today")).toEqual(["ADDRESS:455, Apte Zila, Kakinada 498341"]);
    expect(cats("Flat 4B, Sunrise Apartments, MG Road, Bengaluru 560001")).toEqual(["ADDRESS:Flat 4B, Sunrise Apartments, MG Road, Bengaluru 560001"]);
    expect(cats("Visit 221 Baker Street, London")).toEqual(["ADDRESS:221 Baker Street, London"]);
  });

  it("leaves ordinary text and numbers alone", () => {
    for (const t of ["Order 3, Item, 123456 shipped", "Rs 5,000", "Sign in", "Balance: 12,345", "Wireless mouse Rs 799"]) {
      expect(detectPII(t).filter((s) => s.category === "ADDRESS"), t).toEqual([]);
    }
  });
});
