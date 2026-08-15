import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/lib.ts" },
  // esm and cjs for Node/bundler consumers; iife for direct use in a browser
  // via a <script> tag, which exposes the library as a `Kinetics` global.
  format: ["esm", "cjs", "iife"],
  globalName: "Kinetics",
  clean: true,
  dts: true,
});
