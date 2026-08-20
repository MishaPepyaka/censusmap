import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const entryName = ["map-data-helpers", "offline-data", "map-actions", "map-runtime"].includes(mode) ? mode : "api-client";
  const entry = resolve(import.meta.dirname, `../frontend/src/entries/${entryName}.ts`);
  return {
  publicDir: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry,
      formats: ["iife"],
      name: "CensusMapApiBundle",
      fileName: () => `${entryName}.js`
    },
    outDir: "public"
  }
  };
});
