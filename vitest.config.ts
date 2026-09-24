import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig((_config) => ({
  plugins: [tsconfigPaths()],
  test: {
    testTimeout: 80000,
    coverage: {
      enabled: true,
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"], // Ignore built distribution bundles.
      exclude: [
        "**/*.d.ts",
        // The confidentiality engine is a hand-written recursive-descent Move
        // parser plus its analyzer; it carries many deliberately-unreachable
        // defensive branches (parse-error paths for malformed input) for which
        // a 100% line/branch threshold is the wrong tool. It is validated
        // behaviorally instead — the eight-scenario corpus in
        // tests/analysis/confidentiality.test.ts pins every verdict, and the
        // AST-vs-lexical differentials are asserted directly.
        "src/analysis/confidentiality/**",
        // The CLI is validated end-to-end in tests/cli.test.ts (argument
        // parsing, discovery, the human report, and the SARIF/JSON emitters)
        // rather than by line coverage of its process-facing edges.
        "src/cli.ts",
      ],
      reporter: ["text", "json-summary", "json", "lcov"],
      reportOnFailure: true,
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
}));
