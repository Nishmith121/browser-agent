import { defineConfig } from "vite";

// A self-contained (IIFE) copy of the content script. The manifest one is a loader that imports web-accessible assets,
// which only works on the manifest's own origin; this file is injected by the background worker on origins the user
// added in Settings. It is never listed as web-accessible, so ordinary pages cannot see or fetch it.
export default defineConfig({
  build: {
    target: "es2022",
    emptyOutDir: false,
    lib: { entry: "src/content/index.ts", formats: ["iife"], name: "PrivaSightContent", fileName: () => "content-standalone.js" },
  },
});
