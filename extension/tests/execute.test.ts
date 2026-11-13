// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../src/content/execute";

beforeEach(() => {
  document.body.innerHTML = `
    <form id="f"><input data-ps-id="1" id="u"><input data-ps-id="2" id="p" type="password">
    <select data-ps-id="3"><option value="a">Savings</option><option value="b">Current</option></select>
    <button data-ps-id="4" type="submit">Go</button></form><a data-ps-id="5" href="#">x</a>`;
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 10, height: 10 }) as DOMRect;
});

describe("execute", () => {
  it("types via the native setter and fires input/change", () => {
    const seen: string[] = [];
    const u = document.getElementById("u") as HTMLInputElement;
    u.addEventListener("input", () => seen.push("input"));
    u.addEventListener("change", () => seen.push("change"));
    expect(execute({ type: "type", element_id: 1, text: "user00" }).ok).toBe(true);
    expect(u.value).toBe("user00");
    expect(seen).toEqual(["input", "change"]);
    execute({ type: "type", element_id: 1, text: "-x", clear_first: false });
    expect(u.value).toBe("user00-x");
  });

  it("clicks, selects, and reports missing elements", () => {
    const clicked = vi.fn();
    document.querySelector('[data-ps-id="4"]')!.addEventListener("click", (e) => (e.preventDefault(), clicked()));
    expect(execute({ type: "click", element_id: 4 }).ok).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();
    expect(execute({ type: "select", element_id: 3, option: "current" }).ok).toBe(true);
    expect((document.querySelector("select") as HTMLSelectElement).value).toBe("b");
    expect(execute({ type: "select", element_id: 3, option: "nope" }).ok).toBe(false);
    expect(execute({ type: "click", element_id: 99 })).toEqual({ ok: false, result: "element 99 not found" });
    expect(execute({ type: "type", element_id: 3, text: "x" }).ok).toBe(false); // not a text field
  });

  it("blocks cross-origin navigation", () => {
    const r = execute({ type: "navigate", url: "http://evil.example/x" });
    expect(r.ok).toBe(false);
    expect(r.result).toContain("blocked");
  });

  it("Enter submits the focused field's form", () => {
    const submit = vi.fn((e: Event) => e.preventDefault());
    document.getElementById("f")!.addEventListener("submit", submit);
    (document.getElementById("u") as HTMLInputElement).focus();
    HTMLFormElement.prototype.requestSubmit = function () {
      this.dispatchEvent(new Event("submit", { cancelable: true }));
    };
    execute({ type: "press_key", key: "Enter" });
    expect(submit).toHaveBeenCalledOnce();
  });
});
