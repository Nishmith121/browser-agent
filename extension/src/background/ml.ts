import type { MlConfig, MlRequest, MlResult } from "../offscreen/main";

const OFFSCREEN_URL = "src/offscreen/index.html";

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "Run on-device ML (face detection, NER) for local redaction",
  });
}

const loadConfig = async (): Promise<MlConfig> => ((await chrome.storage.session.get("mlConfig")).mlConfig ?? {}) as MlConfig;

/** Create the document and start loading the models, so the first step does not pay for it. */
export async function warmUp(): Promise<void> {
  await ensureOffscreen();
  void chrome.runtime.sendMessage({ target: "offscreen", type: "ml:init", config: await loadConfig() }).catch(() => {});
}

export async function closeOffscreen(): Promise<void> {
  await chrome.offscreen.closeDocument().catch(() => {});
}

/** Runs the on-device detectors on the raw screenshot and page text. The raw screenshot goes to the
 * offscreen document of this same extension only. */
export async function runMl(req: Omit<MlRequest, "target" | "type">): Promise<MlResult> {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "ml:run", ...req, config: await loadConfig() } satisfies MlRequest);
  if (!res?.ok) throw new Error(res?.error ?? "offscreen ML failed");
  return res.result as MlResult;
}
