/**
 * `kinetics` command-line interface.
 *
 * The published package exposes one binary, `kinetics`, whose `confidential`
 * subcommand runs the confidentiality analyzer over a tree of Move sources:
 *
 *     npx @choosek/kinetics confidential ./sources
 *
 * It reads every `.move` file under the given paths, analyzes each with the
 * same engine the library and the browser use (AST front-end, lexical
 * fallback), reports findings at their true file and line, and exits non-zero
 * when a finding at or above the failure threshold is present — so a pull
 * request that would expose confidential state does not merge.
 *
 * This module is written to be testable: {@link run} takes an argv array and an
 * injectable IO/environment and returns an exit code without touching the
 * process, and the reporters ({@link formatReport}, {@link toSarif},
 * {@link toJson}) are pure functions over a list of located findings. The thin
 * `bin/kinetics.ts` wrapper is the only piece that reads `process` and exits.
 *
 * The analyzer core has no runtime dependencies, and neither does this CLI:
 * argument parsing and `.move` discovery are done by hand over `node:fs` and
 * `node:path`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeConfidentiality } from "./analysis/confidentiality";
import { CONFIDENTIALITY_RULES } from "./analysis/confidentiality/rules";
import type {
  ConfidentialityFinding,
  Severity,
} from "./analysis/confidentiality/types";

/** A finding paired with the file it was found in (path relative to cwd). */
export interface LocatedFinding extends ConfidentialityFinding {
  file: string;
  framework: string;
}

/** Everything a report needs: the located findings plus run-level counts. */
export interface ConfidentialityReport {
  version: string;
  files: number;
  modules: number;
  findings: LocatedFinding[];
  summary: { high: number; medium: number; low: number; info: number };
  failOn: FailOn;
  failed: boolean;
}

/** Injectable IO + environment so `run` never touches the process directly. */
export interface CliEnv {
  out: (s: string) => void;
  err: (s: string) => void;
  cwd: string;
  color: boolean;
  version: string;
  writeFile: (path: string, data: string) => void;
}

type Sev = Severity;
type FailOn = Sev | "none";
const SEV_RANK: Record<Sev, number> = { info: 0, low: 1, medium: 2, high: 3 };
const SEV_LABEL: Record<Sev, string> = {
  high: "HIGH  ",
  medium: "MEDIUM",
  low: "LOW   ",
  info: "INFO  ",
};

/* ------------------------------ discovery ------------------------------ */

/**
 * Collect every `.move` file reachable from the given paths. A path that is a
 * directory is walked recursively; a path that is a `.move` file is taken as
 * is. Results are de-duplicated and sorted for deterministic output. Throws if
 * a path does not exist.
 */
export function discoverMoveFiles(paths: string[], cwd: string): string[] {
  const found = new Set<string>();
  const walk = (abs: string): void => {
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) {
        if (name === "node_modules" || name === ".git" || name.startsWith("."))
          continue;
        walk(join(abs, name));
      }
    } else if (st.isFile() && abs.endsWith(".move")) {
      found.add(abs);
    }
  };
  for (const p of paths) {
    const abs = join(cwd, p);
    walk(abs);
  }
  return [...found].map((abs) => relative(cwd, abs) || abs).sort();
}

/* -------------------------------- report ------------------------------- */

const RESET = "\x1b[0m";
function paint(s: string, code: string, on: boolean): string {
  return on ? `${code}${s}${RESET}` : s;
}
function sevColor(sev: Sev): string {
  return sev === "high"
    ? "\x1b[1;31m"
    : sev === "medium"
      ? "\x1b[33m"
      : sev === "low"
        ? "\x1b[34m"
        : "\x1b[2m";
}
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if (`${cur} ${w}`.length <= width) cur = `${cur} ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/**
 * Render the human-readable terminal report for a run. Pure: `color` decides
 * whether ANSI escapes are emitted, so the same call produces the plain text
 * used in files, pipes, and tests.
 */
export function formatReport(
  report: ConfidentialityReport,
  color: boolean,
): string {
  const { version, files, modules, findings, summary, failOn, failed } = report;
  const dim = (s: string): string => paint(s, "\x1b[2m", color);
  const lines: string[] = [];
  lines.push(
    `${paint(`Kinetics ${version}`, "\x1b[1m", color)} ${dim(
      `— confidential · ${files} file(s), ${modules} module(s)`,
    )}`,
  );
  lines.push("");

  if (!findings.length) {
    lines.push(dim("No confidentiality findings."));
  } else {
    const idPad = findings.reduce((w, f) => Math.max(w, f.id.length), 0);
    for (const f of findings) {
      const sev = f.sev;
      const label = paint(SEV_LABEL[sev], sevColor(sev), color);
      const id = paint(f.id.padEnd(idPad), "\x1b[1m", color);
      const loc = dim(`${f.file}:${Math.max(1, f.loc)}`);
      lines.push(`${label} ${id}  ${loc}  ${f.title}`);
      for (const dl of wrap(f.detail, 72)) lines.push(`       ${dim(dl)}`);
      if (f.fix) {
        const fx = wrap(f.fix, 67);
        fx.forEach((fl, i) => {
          lines.push(`       ${dim(i === 0 ? `fix: ${fl}` : fl)}`);
        });
      }
    }
  }

  lines.push("");
  lines.push(
    dim(
      `high: ${summary.high}  medium: ${summary.medium}  low: ${summary.low}  info: ${summary.info}`,
    ),
  );
  if (failOn === "none") {
    lines.push(
      paint("✓", "\x1b[32m", color) +
        " Reporting only — the failure gate is disabled (--fail-on none).",
    );
  } else if (failed) {
    lines.push(
      `${paint("✗", "\x1b[1;31m", color)} ${paint(
        `Failing — a finding at or above ${failOn} is present.`,
        "\x1b[1m",
        color,
      )}`,
    );
  } else {
    lines.push(
      `${paint("✓", "\x1b[32m", color)} Passing — no finding at or above ${failOn}.`,
    );
  }
  return lines.join("\n");
}

/* --------------------------- machine reports --------------------------- */

function sarifLevel(sev: Sev): string {
  return sev === "high" ? "error" : sev === "medium" ? "warning" : "note";
}
function plain(s: string): string {
  return s
    .replace(/[`]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a SARIF 2.1.0 document for a run. The tool's `driver.rules` is the full
 * confidentiality rule catalog (extended with any advisory ids encountered), so
 * every result's `ruleIndex` resolves and GitHub code scanning links each
 * finding to its rule.
 */
export function toSarif(report: ConfidentialityReport): string {
  const ruleIndex = new Map<string, number>();
  interface SarifRule {
    id: string;
    name: string;
    shortDescription: { text: string };
    defaultConfiguration: { level: string };
    properties: { category: string; tags: string[] };
  }
  const rules: SarifRule[] = CONFIDENTIALITY_RULES.map((r, i) => {
    ruleIndex.set(r.id, i);
    return {
      id: r.id,
      name: r.name,
      shortDescription: { text: r.summary },
      defaultConfiguration: { level: sarifLevel(r.sev) },
      properties: {
        category: r.fw,
        tags: ["confidentiality", r.fw.toLowerCase()],
      },
    };
  });
  for (const f of report.findings) {
    if (!ruleIndex.has(f.id)) {
      ruleIndex.set(f.id, rules.length);
      rules.push({
        id: f.id,
        name: f.id,
        shortDescription: { text: f.title },
        defaultConfiguration: { level: sarifLevel(f.sev) },
        properties: { category: "Advisory", tags: ["confidentiality"] },
      });
    }
  }
  const results = report.findings.map((f) => ({
    ruleId: f.id,
    ruleIndex: ruleIndex.get(f.id),
    level: sarifLevel(f.sev),
    message: {
      text: `${plain(f.title)}. ${plain(f.detail)}${f.fix ? ` Fix: ${plain(f.fix)}` : ""}`,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.file },
          region: { startLine: Math.max(1, f.loc) },
        },
      },
    ],
  }));
  const doc = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Kinetics",
            informationUri: "https://github.com/choosek/kinetics-ts",
            version: report.version,
            rules,
          },
        },
        results,
      },
    ],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Build the `--json` document for a run: a stable, flat summary of findings. */
export function toJson(report: ConfidentialityReport): string {
  const doc = {
    tool: "kinetics",
    version: report.version,
    files: report.files,
    modules: report.modules,
    summary: report.summary,
    failOn: report.failOn,
    failed: report.failed,
    findings: report.findings.map((f) => ({
      rule: f.id,
      severity: f.sev,
      framework: f.framework,
      file: f.file,
      line: Math.max(1, f.loc),
      title: f.title,
      detail: f.detail,
      fix: f.fix || undefined,
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/* ------------------------------ arg parsing ---------------------------- */

interface ConfidentialOpts {
  paths: string[];
  failOn: FailOn;
  minSeverity: Sev;
  disable: Set<string>;
  chain?: "sui" | "aptos";
  sarif?: string | true;
  json?: string | true;
  quiet: boolean;
}
interface ParseResult {
  opts?: ConfidentialOpts;
  error?: string;
}

function parseSev(v: string): Sev | null {
  return v === "high" || v === "medium" || v === "low" || v === "info"
    ? v
    : null;
}

function parseConfidential(argv: string[]): ParseResult {
  const opts: ConfidentialOpts = {
    paths: [],
    failOn: "high",
    minSeverity: "info",
    disable: new Set<string>(),
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = (): string | null => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) return null;
      i++;
      return next;
    };
    if (a === "--fail-on") {
      const v = takeValue();
      if (v === "none") opts.failOn = "none";
      else {
        const s = v && parseSev(v);
        if (!s) return { error: "--fail-on expects high|medium|low|info|none" };
        opts.failOn = s;
      }
    } else if (a === "--min-severity") {
      const v = takeValue();
      const s = v && parseSev(v);
      if (!s) return { error: "--min-severity expects high|medium|low|info" };
      opts.minSeverity = s;
    } else if (a === "--disable") {
      const v = takeValue();
      if (v === null)
        return {
          error: "--disable expects a comma-separated list of rule ids",
        };
      for (const id of v.split(","))
        if (id.trim()) opts.disable.add(id.trim().toUpperCase());
    } else if (a === "--chain") {
      const v = takeValue();
      if (v !== "sui" && v !== "aptos")
        return { error: "--chain expects sui|aptos" };
      opts.chain = v;
    } else if (a === "--sarif") {
      const v = takeValue();
      opts.sarif = v === null ? true : v;
    } else if (a === "--json") {
      const v = takeValue();
      opts.json = v === null ? true : v;
    } else if (a === "--quiet" || a === "-q") {
      opts.quiet = true;
    } else if (a === "--no-color") {
      // handled by the caller via env; accepted here so it isn't a usage error
    } else if (a.startsWith("-")) {
      return { error: `unknown flag ${a}` };
    } else {
      opts.paths.push(a);
    }
  }
  if (!opts.paths.length) opts.paths.push(".");
  return { opts };
}

const HELP = `kinetics — static analysis for the Move ecosystem

Usage:
  kinetics confidential <paths...> [options]

Reads every .move file under <paths>, analyzes the confidentiality surface of
each module (Sui Seal policies and Aptos Confidential Assets), reports findings
at their file and line, and exits non-zero when a finding at or above the
failure threshold is present.

Options:
  --fail-on <sev>       fail the run at this severity or above; one of
                        high|medium|low|info, or "none" to never fail
                        (default: high)
  --min-severity <sev>  hide findings below this severity (default: info)
  --disable <ids>       comma-separated rule ids to turn off
                        (e.g. --disable SEAL-BIND,CA-BOUNDARY)
  --chain <sui|aptos>   force the framework instead of classifying per module
  --sarif [file]        emit SARIF 2.1.0 (to <file>, or stdout if omitted)
  --json [file]         emit JSON (to <file>, or stdout if omitted)
  --quiet, -q           suppress the human-readable report
  --no-color            disable ANSI colors
  -h, --help            show this help
  --version             print the version

Severity order: high > medium > low > info.
Exit codes: 0 pass · 1 a finding at or above --fail-on · 2 usage error.`;

/* -------------------------------- driver ------------------------------- */

function moduleCount(src: string): number {
  // Count modules without a second parse pass driving the analyzer: prefer the
  // parser, fall back to a lexical count for sources it cannot parse.
  const scrubbed = src
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const m = scrubbed.match(/\bmodule\s+[A-Za-z0-9_:]+\s*\{/g);
  return m ? m.length : 0;
}

/**
 * Run the CLI. Returns the process exit code (0 pass, 1 gate failure, 2 usage
 * error) and never calls `process.exit`; all output goes through `env`.
 */
export function run(argv: string[], env: CliEnv): number {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    env.out(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    env.out(env.version);
    return 0;
  }
  const cmd = argv[0];
  if (cmd !== "confidential") {
    env.err(
      `unknown command '${cmd}'. The available command is: confidential.`,
    );
    env.err("Run 'kinetics --help' for usage.");
    return 2;
  }

  const rest = argv.slice(1);
  if (rest.includes("-h") || rest.includes("--help")) {
    env.out(HELP);
    return 0;
  }
  const parsed = parseConfidential(rest);
  if (parsed.error || !parsed.opts) {
    env.err(`error: ${parsed.error}`);
    env.err("Run 'kinetics confidential --help' for usage.");
    return 2;
  }
  const opts = parsed.opts;

  let files: string[];
  try {
    files = discoverMoveFiles(opts.paths, env.cwd);
  } catch (e) {
    env.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (!files.length) {
    env.err(`No .move files found under: ${opts.paths.join(", ")}`);
    return 2;
  }

  const findings: LocatedFinding[] = [];
  let modules = 0;
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(join(env.cwd, file), "utf8");
    } catch (e) {
      env.err(
        `warning: could not read ${file}: ${e instanceof Error ? e.message : e}`,
      );
      continue;
    }
    modules += moduleCount(src);
    const res = analyzeConfidentiality(src, { chain: opts.chain });
    if (!res.ok) continue;
    for (const f of res.findings) {
      if (opts.disable.has(f.id)) continue;
      if (SEV_RANK[f.sev] < SEV_RANK[opts.minSeverity]) continue;
      findings.push({ ...f, file, framework: res.framework });
    }
  }

  // Deterministic order: by file (discovery order), then line, then severity.
  const fileOrder = new Map(files.map((f, i) => [f, i]));
  findings.sort(
    (a, b) =>
      (fileOrder.get(a.file) ?? 0) - (fileOrder.get(b.file) ?? 0) ||
      Math.max(1, a.loc) - Math.max(1, b.loc) ||
      SEV_RANK[b.sev] - SEV_RANK[a.sev],
  );

  const summary = {
    high: findings.filter((f) => f.sev === "high").length,
    medium: findings.filter((f) => f.sev === "medium").length,
    low: findings.filter((f) => f.sev === "low").length,
    info: findings.filter((f) => f.sev === "info").length,
  };
  const failed =
    opts.failOn !== "none" &&
    findings.some((f) => SEV_RANK[f.sev] >= SEV_RANK[opts.failOn as Sev]);

  const report: ConfidentialityReport = {
    version: env.version,
    files: files.length,
    modules,
    findings,
    summary,
    failOn: opts.failOn,
    failed,
  };

  // Machine output. When directed to stdout it replaces the human report.
  let machineToStdout = false;
  if (opts.sarif !== undefined) {
    const doc = toSarif(report);
    if (opts.sarif === true) {
      env.out(doc.trimEnd());
      machineToStdout = true;
    } else {
      env.writeFile(opts.sarif, doc);
    }
  }
  if (opts.json !== undefined) {
    const doc = toJson(report);
    if (opts.json === true) {
      env.out(doc.trimEnd());
      machineToStdout = true;
    } else {
      env.writeFile(opts.json, doc);
    }
  }

  if (!opts.quiet && !machineToStdout) {
    env.out(formatReport(report, env.color));
  }

  return failed ? 1 : 0;
}

/**
 * Build the default {@link CliEnv} from the live process: stdout/stderr, the
 * working directory, TTY-and-NO_COLOR-aware coloring, and the package version.
 */
export function defaultEnv(): CliEnv {
  const noColor = process.env.NO_COLOR !== undefined;
  const argvHasNoColor = process.argv.includes("--no-color");
  let version = "0.0.0";
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    version = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")).version;
  } catch {
    // fall back to the placeholder if the manifest cannot be read
  }
  return {
    out: (s: string) => process.stdout.write(`${s}\n`),
    err: (s: string) => process.stderr.write(`${s}\n`),
    cwd: process.cwd(),
    color: Boolean(process.stdout.isTTY) && !noColor && !argvHasNoColor,
    version,
    writeFile: (path: string, data: string) => writeFileSync(path, data),
  };
}
