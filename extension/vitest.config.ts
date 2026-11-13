import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so the crx plugin is not loaded for tests.
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
