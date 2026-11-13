// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { snapshot } from "../src/content/snapshot";
import { classifyField } from "../src/redaction/rules";

describe("classifyField", () => {
  it("redacts password inputs", () => {
    expect(classifyField({ type: "password" })).toBe("PASSWORD");
  });

  it.each([
    ["cc-number", "CARD"],
    ["cc-csc", "CVV"],
    ["cc-exp", "CARD"],
    ["one-time-code", "OTP"],
    ["current-password", "PASSWORD"],
    ["new-password", "PASSWORD"],
  ])("autocomplete %s -> %s", (ac, cat) => {
    expect(classifyField({ type: "text", autocomplete: ac })).toBe(cat);
  });

  it.each([
    [{ name: "otp" }, "OTP"],
    [{ id: "cvv" }, "CVV"],
    [{ placeholder: "Enter CVC" }, "CVV"],
    [{ ariaLabel: "ATM PIN" }, "PIN"],
    [{ name: "aadhaar_no" }, "AADHAAR"],
    [{ name: "aadharNumber" }, "AADHAAR"],
    [{ label: "PAN" }, "PAN"],
    [{ label: "Payee account number" }, "ACCOUNT"],
    [{ id: "ifscCode" }, "IFSC"],
    [{ label: "Card number" }, "CARD"],
    [{ name: "ssn" }, "SSN"],
    [{ name: "dob" }, "DOB"],
    [{ label: "Security Answer" }, "SECURITY_ANSWER"],
  ])("keyword match %j -> %s", (attrs, cat) => {
    expect(classifyField({ type: "text", ...attrs })).toBe(cat);
  });

  it.each([
    [{ label: "Username" }],
    [{ label: "Mobile number" }],
    [{ label: "Shipping address" }],
    [{ label: "Panel width" }],
    [{ name: "spinner" }],
    [{ label: "Amount (Rs)" }],
  ])("leaves %j alone (no substring false positives)", (attrs) => {
    expect(classifyField({ type: "text", ...attrs })).toBeNull();
  });
});

describe("snapshot on fixture HTML", () => {
  function load(html: string) {
    document.body.innerHTML = html;
    // jsdom has no layout engine: give every element and text range a box.
    const box = { x: 10, y: 10, width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30 } as DOMRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(box);
    (Range.prototype as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => box;
  }

  it("flags sensitive fields, keeps labels and never reads values", () => {
    load(`
      <label for="u">Username</label><input id="u" name="username" value="alice">
      <label for="p">Password</label><input id="p" name="password" type="password" value="Hunter2-secret">
      <label for="c">Card number</label><input id="c" name="card" value="4111111111111111">
      <select id="s" name="pin"><option>1234</option></select>
      <button>Pay</button>`);
    const s = snapshot();
    const byLabel = Object.fromEntries(s.elements.map((e) => [e.label ?? e.text, e]));
    expect(byLabel["Username"].redaction).toBeNull();
    expect(byLabel["Password"].redaction).toBe("PASSWORD");
    expect(byLabel["Card number"].redaction).toBe("CARD");
    expect(s.elements.find((e) => e.tag === "select")?.redaction).toBe("PIN");
    expect(byLabel["Pay"].redaction).toBeNull();
    // Sensitive fields (and select options) are never read; ordinary text fields are read locally for PII checks.
    const json = JSON.stringify(s);
    for (const secret of ["Hunter2-secret", "4111111111111111", "1234"]) expect(json).not.toContain(secret);
    expect(byLabel["Username"].value).toBe("alice");
    for (const e of s.elements.filter((x) => x.redaction)) expect(e.value).toBeUndefined();
  });
});
