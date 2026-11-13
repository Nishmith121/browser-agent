import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: "es2022",
    // The offscreen ML page is created at runtime (not in the manifest), so it needs its own entry.
    rollupOptions: { input: { offscreen: "src/offscreen/index.html" } },
  },
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
});
