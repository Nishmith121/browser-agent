# Firefox port: assessment (not done)

The plan says "Firefox port if time allows". It was **not attempted**: Firefox is not installed on the development machine and
Playwright cannot load extensions into Firefox, so nothing here could be tested. This file lists what a port would involve,
taken from the Chrome-specific APIs the code actually calls. Statements about Firefox are from general knowledge of its
WebExtensions support, **not verified in this project**; check each against current MDN before starting.

## Chrome-only pieces in the code, and what each needs

| Where | Chrome feature | Firefox work (to verify) |
|---|---|---|
| `manifest.config.ts` | `background.service_worker` | Firefox MV3 uses an event page: `background.scripts`. The worker-lifetime logic (keep-alive timer, alarm watchdog, `resumeInterrupted`) still applies and is harmless on an event page. |
| `background/index.ts` | `chrome.sidePanel` | No side panel API; the same page can be a `sidebar_action` (or a popup). |
| `background/ml.ts` | `chrome.offscreen` and `chrome.runtime.getContexts` | No offscreen API. An event page has a DOM, so the ML code (`src/offscreen/main.ts`, workers for NER and OCR, MediaPipe) could run in the background page itself; `ml.ts` would call it directly instead of messaging an offscreen document. This is the largest change. |
| `manifest.config.ts` | `cross_origin_embedder_policy` / `cross_origin_opener_policy` (for multi-threaded WASM) | Probably unsupported for extension pages; NER would fall back to one WASM thread (the code already handles `crossOriginIsolated === false`). Latency would need re-measuring (Phase 5 median 78 ms with threads). |
| `manifest.config.ts` | `host_permissions: ["<all_urls>"]` | In Firefox MV3 host permissions are optional for the user; the first-run flow must ask for them. |
| `content-standalone.js`, `chrome.scripting.registerContentScripts` | scripting API | Supported in Firefox MV3 (believed); the manifest's own content script needs no loader there. |
| everything | `chrome.*` callbacks/promises | Firefox accepts `chrome.*`; `browser.*` is the promise-based form. A polyfill (`webextension-polyfill`) is the usual route. |
| `chrome.tabs.captureVisibleTab`, `chrome.storage.session`, `chrome.alarms` | | Believed available. `captureVisibleTab` needs re-testing for the "frame not painted yet" failure fixed in Phase 9. |
| ML backends | WebGPU for NER and face detection | Firefox's WebGPU support is more limited; WASM is already the default NER backend, but MediaPipe's GPU delegate would fall back to CPU (Phase 5: 97.2% face recall on CPU vs 100% on GPU). |
| build | `@crxjs/vite-plugin` | Chrome-oriented. Firefox needs its own manifest (with `browser_specific_settings.gecko.id`) and a second build target. |

## Suggested order, if someone does it

1. Install Firefox (Developer Edition) and `web-ext`; load the unmodified build to see what breaks first.
2. Move the ML call from the offscreen document to the background page behind a small interface (`ml.ts`), keeping Chrome on offscreen.
3. Add a Firefox manifest and build target; sidebar instead of side panel.
4. Re-run the Phase 5 evaluation and the Phase 9 checks (`eval/run_all.py`) against Firefox; the Playwright harness would have to be replaced by `web-ext run` plus a Marionette/WebDriver BiDi driver.

Estimate: a few days, dominated by step 2 and by replacing the test harness. Until then PrivaSight is Chromium-only.
