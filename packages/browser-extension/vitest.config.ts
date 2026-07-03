import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The unit-tested logic (webln-mapping, permission-store, bolt11-amount) is pure — no chrome,
    // no LDK/WASM, no DOM — so the fast node environment is enough.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
