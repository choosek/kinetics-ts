/**
 * Confidentiality analysis for Move — public entry point.
 *
 * {@link analyzeConfidentiality} is the analyzer most callers want: it runs the
 * Move AST front-end (`./ast`), and only when that front-end cannot parse a
 * source does it fall back to the lexical engine (`./lexical`). Both engines
 * return the identical {@link ConfidentialityAnalysis} shape, so a result is
 * read the same way regardless of which ran; the `engine` field records which
 * one it was. The individual engines and the rule catalog are re-exported for
 * callers that need to pin one engine or inspect the rules directly.
 */
import { analyzeConfidentialityAst } from "./ast";
import { analyzeConfidentialityLexical } from "./lexical";
import type { ConfidentialityAnalysis, ConfidentialityOptions } from "./types";

/**
 * Analyze a Move source string for confidentiality defects. Prefers the AST
 * front-end and transparently falls back to the lexical engine for sources the
 * parser does not yet cover, so no input is rejected outright.
 */
export function analyzeConfidentiality(
  src: string,
  options: ConfidentialityOptions = {},
): ConfidentialityAnalysis {
  const ast = analyzeConfidentialityAst(src, options);
  if (ast.ok) return ast;
  if (ast.parseFailed) return analyzeConfidentialityLexical(src, options);
  return ast;
}

export { analyzeConfidentialityAst, parseMove } from "./ast";
export { analyzeConfidentialityLexical } from "./lexical";
export { CONFIDENTIALITY_RULES } from "./rules";
export type {
  ConfidentialityAnalysis,
  ConfidentialityEngine,
  ConfidentialityError,
  ConfidentialityExposure,
  ConfidentialityFinding,
  ConfidentialityObservers,
  ConfidentialityOptions,
  ConfidentialityResult,
  ConfidentialityRule,
  ConfidentialitySummary,
  Framework,
  Severity,
} from "./types";
