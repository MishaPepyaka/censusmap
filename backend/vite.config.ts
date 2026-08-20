import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, "../frontend/src/entries/api-client.ts"),
      formats: ["iife"],
      name: "CensusMapApiBundle",
      fileName: () => "api-client.js"
    },
    outDir: "public"
  }
});
