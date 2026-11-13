import { describe, expect, it } from "vitest";
import { INTERRUPTED, isFresh, isStuck } from "../src/shared/guards";
import type { HistoryItem } from "../src/shared/protocol";
import { DEFAULTS, isAllowedUrl, normaliseOrigin, validateSettings } from "../src/shared/settings";

describe("normaliseOrigin", () => {
  it("keeps only the origin", () => {
    expect(normaliseOrigin("https://Example.com/a/b?x=1#y")).toBe("https://example.com");
    expect(normaliseOrigin(" http://127.0.0.1:8080/ ")).toBe("http://127.0.0.1:8080");
  });
  it("rejects wildcards, other schemes and junk", () => {
    for (const bad of ["*", "https://*.example.com", "ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "example.com", ""]) {
      expect(normaliseOrigin(bad), bad).toBeNull();
    }
  });
});

describe("isAllowedUrl", () => {
  it("allows the built-in origin and only listed extras", () => {
    expect(isAllowedUrl("http://localhost:8080/bank/login")).toBe(true);
    expect(isAllowedUrl("http://127.0.0.1:8080/")).toBe(false);
    expect(isAllowedUrl("http://127.0.0.1:8080/", ["http://127.0.0.1:8080"])).toBe(true);
  });
  it("does not confuse look-alike hosts or ports", () => {
    expect(isAllowedUrl("http://localhost:8080.evil.com/")).toBe(false);
    expect(isAllowedUrl("http://localhost:8081/")).toBe(false);
    expect(isAllowedUrl("https://localhost:8080/")).toBe(false);
    expect(isAllowedUrl("http://localhost:8080@evil.com/")).toBe(false);
    expect(isAllowedUrl(undefined)).toBe(false);
    expect(isAllowedUrl("not a url")).toBe(false);
  });
});

describe("validateSettings", () => {
  it("returns the defaults for empty input", () => {
    expect(validateSettings({})).toEqual({ settings: DEFAULTS, errors: [] });
  });
  it("accepts good values and normalises origins, dropping duplicates and the built-in one", () => {
    const { settings, errors } = validateSettings({
      serverUrl: "http://gpu-host:8001/v1/",
      maxSteps: 20,
      stepTimeoutMs: 60_000,
      extraOrigins: ["https://a.com/x", "https://a.com", "http://localhost:8080", "https://b.org"],
    });
    expect(errors).toEqual([]);
    expect(settings).toEqual({ serverUrl: "http://gpu-host:8001", maxSteps: 20, stepTimeoutMs: 60_000, extraOrigins: ["https://a.com", "https://b.org"] });
  });
  it("reports each bad field and falls back to its default", () => {
    const { settings, errors } = validateSettings({ serverUrl: "nope", maxSteps: 0, stepTimeoutMs: 1, extraOrigins: ["*", "https://ok.com"] });
    expect(errors).toHaveLength(4);
    expect(settings.serverUrl).toBe(DEFAULTS.serverUrl);
    expect(settings.maxSteps).toBe(DEFAULTS.maxSteps);
    expect(settings.stepTimeoutMs).toBe(DEFAULTS.stepTimeoutMs);
    expect(settings.extraOrigins).toEqual(["https://ok.com"]);
  });
  it("rejects fractions and numbers out of range", () => {
    expect(validateSettings({ maxSteps: 3.5 }).errors).toHaveLength(1);
    expect(validateSettings({ maxSteps: 31 }).errors).toHaveLength(1);
    expect(validateSettings({ stepTimeoutMs: 700_000 }).errors).toHaveLength(1);
  });
});

const h = (step: number, action: HistoryItem["action"]): HistoryItem => ({ step, action, result: "ok" });
describe("isStuck", () => {
  const click = { type: "click", element_id: 4 } as const;
  it("detects the same action three times in a row", () => {
    expect(isStuck([h(1, click), h(2, click), h(3, click)])).toBe(true);
  });
  it("needs three, identical, consecutive", () => {
    expect(isStuck([h(1, click), h(2, click)])).toBe(false);
    expect(isStuck([h(1, click), h(2, { type: "click", element_id: 5 }), h(3, click)])).toBe(false);
    expect(isStuck([h(1, { type: "type", element_id: 2, text: "a" }), h(2, { type: "type", element_id: 2, text: "b" }), h(3, { type: "type", element_id: 2, text: "a" })])).toBe(false);
  });
  it("does not treat scrolling or waiting as stuck", () => {
    const scroll = { type: "scroll", direction: "down" } as const;
    expect(isStuck([h(1, scroll), h(2, scroll), h(3, scroll)])).toBe(false);
    expect(isStuck([h(1, { type: "wait" }), h(2, { type: "wait" }), h(3, { type: "wait" })])).toBe(false);
  });
});

describe("isFresh", () => {
  it("resumes recent state only", () => {
    expect(isFresh(1_000, 1_000 + 60_000)).toBe(true);
    expect(isFresh(1_000, 1_000 + 11 * 60_000)).toBe(false);
    expect(isFresh(5_000, 1_000)).toBe(false); // clock went backwards
  });
  it("has an interrupted marker that tells the model to look", () => {
    expect(INTERRUPTED).toMatch(/interrupted/);
    expect(INTERRUPTED).toMatch(/screen/);
  });
});
