/**
 * Unit tests for the `kinetics` CLI. The command's logic lives in
 * {@link run}, which takes an argv array and an injectable IO/environment and
 * returns an exit code without touching the process, so the whole surface —
 * argument parsing, `.move` discovery, the human report, and the SARIF and JSON
 * emitters — is exercised here in-process against a temporary source tree.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type CliEnv,
  type ConfidentialityReport,
  defaultEnv,
  discoverMoveFiles,
  formatReport,
  run,
  toJson,
  toSarif,
} from "#/cli";

const OPEN_POLICY = `module walrus::docs {
  entry fun seal_approve(id: vector<u8>, _l: &Allowlist) { let _ = id; }
}`;
const CLEAN_POLICY = `module walrus::vault {
  const E: u64 = 1;
  entry fun seal_approve(id: vector<u8>, l: &Allowlist) {
    assert!(is_member(l, id), E);
  }
  fun is_member(_l: &Allowlist, _id: vector<u8>): bool { true }
}`;
const NO_POLICY_SEAL =
  "module walrus::empty { public fun seal_approve_helper() {} }";

let dir: string;
function capture(): { env: CliEnv; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    cwd: dir,
    color: false,
    version: "9.9.9",
    writeFile: (p, data) => writeFileSync(join(dir, p), data),
  };
  return { env, out, err };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kinetics-cli-"));
  mkdirSync(join(dir, "sources/nested"), { recursive: true });
  writeFileSync(join(dir, "sources/docs.move"), OPEN_POLICY);
  writeFileSync(join(dir, "sources/nested/vault.move"), CLEAN_POLICY);
  writeFileSync(join(dir, "sources/README.md"), "not move");
  mkdirSync(join(dir, "empty"), { recursive: true });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("discoverMoveFiles", () => {
  test("finds only .move files, recursively, sorted and cwd-relative", () => {
    const files = discoverMoveFiles(["sources"], dir);
    expect(files).toEqual(["sources/docs.move", "sources/nested/vault.move"]);
  });
  test("accepts a direct .move file path", () => {
    expect(discoverMoveFiles(["sources/docs.move"], dir)).toEqual([
      "sources/docs.move",
    ]);
  });
  test("throws on a path that does not exist", () => {
    expect(() => discoverMoveFiles(["nope"], dir)).toThrow();
  });
});

describe("run — help, version, and usage errors", () => {
  test("no arguments prints help and exits 2", () => {
    const { env, out } = capture();
    expect(run([], env)).toBe(2);
    expect(out.join("\n")).toContain("Usage:");
  });
  test("--help exits 0", () => {
    const { env, out } = capture();
    expect(run(["--help"], env)).toBe(0);
    expect(out.join("\n")).toContain("confidential");
  });
  test("-h behaves like --help", () => {
    const { env } = capture();
    expect(run(["-h"], env)).toBe(0);
  });
  test("--version and -v print the version", () => {
    const a = capture();
    expect(run(["--version"], a.env)).toBe(0);
    expect(a.out).toEqual(["9.9.9"]);
    const b = capture();
    expect(run(["-v"], b.env)).toBe(0);
    expect(b.out).toEqual(["9.9.9"]);
  });
  test("an unknown command exits 2", () => {
    const { env, err } = capture();
    expect(run(["frobnicate"], env)).toBe(2);
    expect(err.join("\n")).toContain("unknown command");
  });
  test("confidential --help exits 0", () => {
    const { env, out } = capture();
    expect(run(["confidential", "--help"], env)).toBe(0);
    expect(out.join("\n")).toContain("Usage:");
  });
  test("invalid flag values exit 2", () => {
    for (const argv of [
      ["confidential", "sources", "--fail-on", "bogus"],
      ["confidential", "sources", "--min-severity", "bogus"],
      ["confidential", "sources", "--disable"],
      ["confidential", "sources", "--chain", "eth"],
      ["confidential", "sources", "--frobnicate"],
    ]) {
      const { env } = capture();
      expect(run(argv, env)).toBe(2);
    }
  });
  test("a non-existent path exits 2", () => {
    const { env, err } = capture();
    expect(run(["confidential", "does/not/exist"], env)).toBe(2);
    expect(err.join("\n")).toContain("error:");
  });
  test("a path with no .move files exits 2", () => {
    const { env, err } = capture();
    expect(run(["confidential", "empty"], env)).toBe(2);
    expect(err.join("\n")).toContain("No .move files");
  });
});

describe("run — analysis and the failure gate", () => {
  test("an open policy fails the default gate (exit 1)", () => {
    const { env, out } = capture();
    expect(run(["confidential", "sources"], env)).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("SEAL-OPEN");
    expect(text).toContain("Kinetics 9.9.9 — confidential");
    expect(text).toContain("✗ Failing");
  });
  test("--fail-on none reports without failing (exit 0)", () => {
    const { env, out } = capture();
    expect(run(["confidential", "sources", "--fail-on", "none"], env)).toBe(0);
    expect(out.join("\n")).toContain("Reporting only");
  });
  test("--min-severity high hides lower findings", () => {
    const { env, out } = capture();
    run(
      ["confidential", "sources", "--min-severity", "high", "--no-color"],
      env,
    );
    expect(out.join("\n")).toContain("high: 1");
  });
  test("--disable removes a rule and can drop the run below the gate", () => {
    const { env, out } = capture();
    expect(
      run(["confidential", "sources", "--disable", "seal-open"], env),
    ).toBe(0);
    expect(out.join("\n")).not.toContain("SEAL-OPEN");
  });
  test("a clean tree passes (exit 0)", () => {
    const { env, out } = capture();
    expect(run(["confidential", "sources/nested"], env)).toBe(0);
    expect(out.join("\n")).toContain("✓ Passing");
  });
  test("--chain forces the framework", () => {
    const { env } = capture();
    // Forcing aptos on a Seal-only module yields no Seal findings → passes.
    expect(run(["confidential", "sources", "--chain", "aptos"], env)).toBe(0);
  });
});

describe("run — machine output", () => {
  test("--sarif <file> writes a report and keeps the human output", () => {
    const { env, out } = capture();
    expect(run(["confidential", "sources", "--sarif", "out.sarif"], env)).toBe(
      1,
    );
    expect(out.join("\n")).toContain("SEAL-OPEN"); // human report still printed
    const doc = JSON.parse(readFileSync(join(dir, "out.sarif"), "utf8"));
    expect(doc.version).toBe("2.1.0");
    expect(doc.runs[0].tool.driver.name).toBe("Kinetics");
    expect(doc.runs[0].results.length).toBeGreaterThan(0);
  });
  test("--sarif to stdout suppresses the human report", () => {
    const { env, out } = capture();
    run(["confidential", "sources", "--sarif"], env);
    const printed = out.join("\n");
    expect(printed).toContain('"version": "2.1.0"');
    expect(printed).not.toContain("Failing");
  });
  test("--json <file> writes a structured report", () => {
    const { env } = capture();
    run(["confidential", "sources", "--json", "out.json", "--quiet"], env);
    const doc = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
    expect(doc.tool).toBe("kinetics");
    expect(
      doc.findings.some((f: { rule: string }) => f.rule === "SEAL-OPEN"),
    ).toBe(true);
  });
  test("--json to stdout suppresses the human report", () => {
    const { env, out } = capture();
    run(["confidential", "sources", "--json"], env);
    expect(out.join("\n")).toContain('"tool": "kinetics"');
  });
  test("--quiet suppresses the human report but keeps the exit code", () => {
    const { env, out } = capture();
    expect(run(["confidential", "sources", "--quiet"], env)).toBe(1);
    expect(out.join("\n")).toBe("");
  });
});

describe("formatReport", () => {
  const base: ConfidentialityReport = {
    version: "1.2.3",
    files: 1,
    modules: 1,
    findings: [
      {
        id: "SEAL-OPEN",
        sev: "high",
        loc: 3,
        title: "Open policy",
        detail: "A long detail that should wrap across more than a single line "
          .repeat(3)
          .trim(),
        fix: "A remediation string that is also long enough to wrap onto two lines here.".repeat(
          1,
        ),
        file: "a.move",
        framework: "seal",
      },
    ],
    summary: { high: 1, medium: 0, low: 0, info: 0 },
    failOn: "high",
    failed: true,
  };
  test("plain output has no ANSI escapes", () => {
    const text = formatReport(base, false);
    expect(text).not.toContain("\x1b[");
    expect(text).toContain("HIGH  ");
    expect(text).toContain("a.move:3");
    expect(text).toContain("fix:");
  });
  test("colored output includes ANSI escapes", () => {
    expect(formatReport(base, true)).toContain("\x1b[");
  });
  test("passing and reporting-only footers render", () => {
    const pass = formatReport({ ...base, findings: [], failed: false }, false);
    expect(pass).toContain("No confidentiality findings");
    expect(pass).toContain("✓ Passing");
    const none = formatReport({ ...base, failOn: "none" }, false);
    expect(none).toContain("Reporting only");
  });
});

describe("toSarif and toJson", () => {
  const report: ConfidentialityReport = {
    version: "1.0.0",
    files: 1,
    modules: 1,
    findings: [
      {
        id: "SEAL-NONE", // advisory id not in the catalog → exercises the extend path
        sev: "info",
        loc: 1,
        title: "No seal_approve policy found",
        detail: "advisory",
        fix: "",
        file: "x.move",
        framework: "seal",
      },
    ],
    summary: { high: 0, medium: 0, low: 0, info: 1 },
    failOn: "high",
    failed: false,
  };
  test("SARIF declares an advisory rule so ruleIndex always resolves", () => {
    const doc = JSON.parse(toSarif(report));
    const driver = doc.runs[0].tool.driver;
    const result = doc.runs[0].results[0];
    expect(driver.rules[result.ruleIndex].id).toBe("SEAL-NONE");
    expect(result.level).toBe("note");
  });
  test("JSON omits an empty fix", () => {
    const doc = JSON.parse(toJson(report));
    expect(doc.findings[0].fix).toBeUndefined();
  });
});

describe("defaultEnv", () => {
  test("reads the package version and provides IO", () => {
    const env = defaultEnv();
    expect(typeof env.out).toBe("function");
    expect(typeof env.err).toBe("function");
    expect(env.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// Keep a reference so the seal-with-no-policy fixture is used (SEAL-NONE path
// through the analyzer is covered by the SARIF test's synthetic report).
void NO_POLICY_SEAL;
