import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const entryName = mode === "map-data-helpers" || mode === "offline-data" ? mode : "api-client";
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
