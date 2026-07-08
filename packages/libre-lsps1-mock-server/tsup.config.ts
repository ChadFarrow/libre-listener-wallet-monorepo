import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/index.ts", "src/msw.ts"], format: ["cjs"], dts: true, clean: true, sourcemap: true, minify: false });
