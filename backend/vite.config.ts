import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const entryName = mode === "map-data-helpers" ? "map-data-helpers" : "api-client";
  const entry = entryName === "map-data-helpers"
    ? resolve(import.meta.dirname, "../frontend/src/entries/map-data-helpers.ts")
    : resolve(import.meta.dirname, "../frontend/src/entries/api-client.ts");
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
