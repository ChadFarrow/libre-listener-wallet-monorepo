import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    // jsdom ships no <dialog> implementation at any version — see src/test-setup.ts.
    setupFiles: ["./src/test-setup.ts"],
  },
});
