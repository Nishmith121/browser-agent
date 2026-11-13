import type { Action, ExecuteResult } from "../shared/protocol";

const find = (id: number): HTMLElement | null => document.querySelector<HTMLElement>(`[data-ps-id="${id}"]`);

function mouse(el: HTMLElement, type: string): void {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }),
  );
}

function click(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus?.();
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) mouse(el, t);
}

/** Sets a value through the native setter so frameworks that track value see the change. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
}

function typeInto(el: HTMLElement, text: string, clearFirst: boolean): string {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return "element is not a text field";
  el.scrollIntoView({ block: "center" });
  el.focus();
  setValue(el, clearFirst ? text : el.value + text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
}

function pressKey(key: string): string {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const init = { key, bubbles: true, cancelable: true };
  const proceed = target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  // Synthetic key events do not trigger default actions, so implement the one that matters.
  if (key === "Enter" && proceed) {
    const form = target.closest("form");
    if (form) form.requestSubmit();
    else if (target instanceof HTMLButtonElement) target.click();
  }
  return "ok";
}

export function execute(action: Action): ExecuteResult {
  const need = (id: number) => {
    const el = find(id);
    if (!el) throw new Error(`element ${id} not found`);
    return el;
  };
  try {
    switch (action.type) {
      case "click":
        click(need(action.element_id));
        return { ok: true, result: "ok" };
      case "type": {
        const r = typeInto(need(action.element_id), action.text, action.clear_first ?? true);
        return { ok: r === "ok", result: r };
      }
      case "select": {
        const el = need(action.element_id);
        if (!(el instanceof HTMLSelectElement)) return { ok: false, result: "element is not a select" };
        const opt = Array.from(el.options).find(
          (o) => o.text.trim().toLowerCase() === action.option.trim().toLowerCase() || o.value === action.option,
        );
        if (!opt) return { ok: false, result: `option "${action.option}" not found` };
        el.value = opt.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, result: "ok" };
      }
      case "scroll":
        window.scrollBy(0, (action.direction === "down" ? 1 : -1) * (action.amount ?? 400));
        return { ok: true, result: "ok" };
      case "press_key":
        return { ok: true, result: pressKey(action.key) };
      case "navigate": {
        const url = new URL(action.url, location.href);
        // The background worker only drives tabs on allowed origins, and this script only runs there; same-origin keeps it so.
        if (url.origin !== location.origin) return { ok: false, result: "navigation blocked (same-origin only)" };
        location.href = url.href;
        return { ok: true, result: "ok" };
      }
      case "wait":
        return { ok: true, result: "ok" }; // the background worker does the waiting
      default:
        return { ok: false, result: `not an executable action: ${action.type}` };
    }
  } catch (e) {
    return { ok: false, result: String(e instanceof Error ? e.message : e) };
  }
}
