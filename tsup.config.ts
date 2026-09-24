import { defineConfig } from "tsup";

// Two build outputs from one config:
//   • the library entry (src/lib.ts → dist/index.*), shipped as ESM + CJS for
//     Node/bundler consumers and IIFE for a <script> tag (global `Kinetics`),
//     with type declarations; and
//   • the CLI entry (bin/kinetics.ts → dist/kinetics.js), an ESM executable
//     with a Node shebang. It has no declarations of its own and must not clear
//     the library output, so `dts` is off and `clean` is disabled on it.
export default defineConfig([
  {
    entry: { index: "src/lib.ts" },
    format: ["esm", "cjs", "iife"],
    globalName: "Kinetics",
    clean: true,
    dts: true,
  },
  {
    entry: { kinetics: "bin/kinetics.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    clean: false,
    dts: false,
  },
]);
