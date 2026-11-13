import { defineManifest } from "@crxjs/vite-plugin";

// Host permissions: test-site origins and the agent server only (Section 4).
// Cross-origin isolation for extension pages enables multi-threaded WASM (SharedArrayBuffer) for the NER model.
// (Not in crxjs's manifest typings yet, hence the spread.)
const isolation = {
  cross_origin_embedder_policy: { value: "require-corp" },
  cross_origin_opener_policy: { value: "same-origin" },
};

export default defineManifest({
  ...(isolation as object),
  manifest_version: 3,
  name: "PrivaSight",
  version: "0.1.0",
  description: "Privacy-preserving browser agent: local redaction before any server call.",
  permissions: ["activeTab", "tabs", "scripting", "storage", "offscreen", "sidePanel", "alarms"],
  // <all_urls> is required by chrome.tabs.captureVisibleTab from a side panel (activeTab is not
  // granted reliably). The agent is restricted to ALLOWED_ORIGINS in code (src/shared/origins.ts).
  host_permissions: ["<all_urls>"],
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  background: { service_worker: "src/background/index.ts", type: "module" },
  content_scripts: [
    { matches: ["http://localhost:8080/*"], js: ["src/content/index.ts"], run_at: "document_idle" },
  ],
  side_panel: { default_path: "src/sidepanel/index.html" },
  action: { default_title: "PrivaSight" },
});
