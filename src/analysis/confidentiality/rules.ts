/**
 * The confidentiality rule catalog: every rule the analyzer can raise, in the
 * order the documentation lists them (highest severity first). The SARIF
 * emitter declares this catalog as the tool's rule set, and the browser page
 * renders it as the rules table, so this is the single source of truth for
 * rule identity, severity, framework, and one-line summary.
 */
import type { ConfidentialityRule } from "./types";

export const CONFIDENTIALITY_RULES: ConfidentialityRule[] = [
  {
    id: "SEAL-OPEN",
    sev: "high",
    fw: "Seal",
    name: "Open policy",
    summary:
      "A seal_approve that never aborts grants the decryption key to any caller.",
  },
  {
    id: "CA-DK",
    sev: "high",
    fw: "Aptos",
    name: "Decryption key exposed",
    summary:
      "A decryption key returned, emitted, or stored on-chain reveals every amount on the account.",
  },
  {
    id: "CA-AUTH",
    sev: "high",
    fw: "Aptos",
    name: "Unauthorized confidential op",
    summary: "A confidential transfer/withdraw with no authorizing &signer.",
  },
  {
    id: "SEAL-VIS",
    sev: "medium",
    fw: "Seal",
    name: "Policy not entry",
    summary:
      "A seal_approve policy must be an entry function, not public or private.",
  },
  {
    id: "SEAL-ID",
    sev: "medium",
    fw: "Seal",
    name: "Identity parameter",
    summary: "A policy must take id: vector<u8> as its first parameter.",
  },
  {
    id: "SEAL-SFX",
    sev: "medium",
    fw: "Seal",
    name: "Side effects in policy",
    summary:
      "A policy is dry-run and must not mutate state, emit, or transfer.",
  },
  {
    id: "CA-EVENT",
    sev: "medium",
    fw: "Aptos",
    name: "Amount in an event",
    summary:
      "An event argument is plaintext — a confidential amount emitted is disclosed.",
  },
  {
    id: "CA-RETURN",
    sev: "medium",
    fw: "Aptos",
    name: "Amount returned",
    summary:
      "A public function that returns a plaintext confidential amount discloses it to its caller.",
  },
  {
    id: "SEAL-BIND",
    sev: "low",
    fw: "Seal",
    name: "Identity not bound",
    summary: "A policy that never checks id may approve the wrong identity.",
  },
  {
    id: "CA-BOUNDARY",
    sev: "info",
    fw: "Aptos",
    name: "Public at the boundary",
    summary:
      "deposit and withdraw amounts are public by design — surfaced for review.",
  },
  {
    id: "CA-AUDITOR",
    sev: "info",
    fw: "Aptos",
    name: "Auditor can decrypt",
    summary: "A configured auditor viewing key can decrypt every amount.",
  },
  {
    id: "SEAL-LOCK",
    sev: "info",
    fw: "Seal",
    name: "Locked policy",
    summary:
      "A policy that always aborts is safe but never reachable — surfaced in case it was meant to be.",
  },
];
