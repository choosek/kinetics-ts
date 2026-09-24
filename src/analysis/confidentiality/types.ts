/**
 * Shared types for the confidentiality analyzer.
 *
 * The analyzer reads the confidentiality surface of a Move contract statically
 * and returns a plain, serializable data structure. Two frameworks are
 * covered: Sui Seal access policies and Aptos Confidential Assets. The same
 * result shape is produced by both the AST front-end and the lexical fallback,
 * so consumers (the CLI, the render layer, tests) never branch on which engine
 * ran — they read `engine` only for reporting.
 */

/** Finding severity, ordered high > medium > low > info. */
export type Severity = "high" | "medium" | "low" | "info";

/** The confidentiality framework a module was classified as. */
export type Framework = "seal" | "aptos-ca" | "move";

/** Which engine produced a result. */
export type ConfidentialityEngine = "ast" | "lexical";

/**
 * A single confidentiality finding, located at a 1-based line in the analyzed
 * source. `fix` is a concrete remediation, or an empty string for advisory
 * (informational) findings that need no fix.
 */
export interface ConfidentialityFinding {
  id: string;
  sev: Severity;
  loc: number;
  title: string;
  detail: string;
  fix: string;
}

/**
 * One row of the exposure surface: an externally-reachable function, how it is
 * reached, and what it reveals to an observer.
 */
export interface ConfidentialityExposure {
  fn: string;
  vis: string;
  policy: string;
  reach: string;
  reveals: string;
}

/**
 * Who ends up holding what once a transaction settles: what the public ledger
 * shows, what an authorized viewer can read, and what leaks to an unintended
 * observer.
 */
export interface ConfidentialityObservers {
  public: string[];
  authorized: string[];
  leaked: string[];
}

/** Aggregate counts for a run. */
export interface ConfidentialitySummary {
  functions: number;
  entryFns: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  exposedFns: number;
  confItems: number;
}

/** A successful analysis result. */
export interface ConfidentialityResult {
  ok: true;
  framework: Framework;
  engine: ConfidentialityEngine;
  module: string;
  summary: ConfidentialitySummary;
  findings: ConfidentialityFinding[];
  surface: ConfidentialityExposure[];
  observers: ConfidentialityObservers;
  assumptions: string[];
}

/**
 * A failed analysis (empty input, or — for the AST engine — a source it could
 * not parse). `parseFailed` marks the parse-failure case so the umbrella
 * analyzer knows to fall back to the lexical engine.
 */
export interface ConfidentialityError {
  ok: false;
  error: string;
  parseFailed?: boolean;
}

/** Either outcome of an analysis. */
export type ConfidentialityAnalysis =
  | ConfidentialityResult
  | ConfidentialityError;

/** Options accepted by every analysis entry point. */
export interface ConfidentialityOptions {
  /**
   * Force the framework instead of classifying each module from its own
   * source. `"sui"` treats the source as a Seal policy module; `"aptos"`
   * treats it as a Confidential-Assets module.
   */
  chain?: "sui" | "aptos";
}

/** A catalog entry describing one rule the analyzer can raise. */
export interface ConfidentialityRule {
  id: string;
  sev: Severity;
  fw: "Seal" | "Aptos";
  name: string;
  summary: string;
}
