/**
 * Functional tests for the confidentiality analyzer, run through the public
 * library surface (`#/lib`). The corpus is the eight example modules the
 * project ships — three Sui Seal policies and three Aptos Confidential-Asset
 * modules, plus a delegated-gate policy and a hashed-amount module — with the
 * verdict each is expected to receive. Two of them (`seal-helper`, `ca-commit`)
 * are the cases the AST front-end gets right and the lexical fallback does not,
 * and are asserted directly against both engines.
 */
import { describe, expect, test } from "vitest";
import * as kinetics from "#/lib";

type Verdict = "high" | "med" | "clean";
function verdict(r: kinetics.ConfidentialityAnalysis): Verdict | "ERR" {
  if (!r.ok) return "ERR";
  if (r.summary.high > 0) return "high";
  if (r.summary.medium > 0) return "med";
  return "clean";
}
function ids(r: kinetics.ConfidentialityAnalysis): string[] {
  return r.ok ? r.findings.map((f) => f.id) : [];
}

const SOURCES: Record<string, string> = {
  "seal-open":
    "module walrus_demo::sealed_docs {\n    use sui::tx_context::{Self, TxContext};\n    use std::vector;\n\n    /// A document sealed to an allowlist. The Seal key servers call\n    /// seal_approve to decide who may decrypt: it returns to grant, aborts\n    /// to deny.\n    struct Allowlist has key { id: UID, members: vector<address> }\n\n    const E_NO_ACCESS: u64 = 1;\n\n    /// BUG: the membership check was stubbed out during testing and never\n    /// restored, so the policy simply returns for every caller.\n    entry fun seal_approve(id: vector<u8>, _list: &Allowlist, ctx: &TxContext) {\n        let _who = tx_context::sender(ctx);\n        let _ = id;\n        // assert!(is_member(_list, _who), E_NO_ACCESS);   // <-- removed\n    }\n\n    fun is_member(list: &Allowlist, who: address): bool {\n        vector::contains(&list.members, &who)\n    }\n}",
  "seal-helper":
    "module allowlist::sealed_delegated {\n    use sui::tx_context::{Self, TxContext};\n    use std::vector;\n\n    struct Allowlist has key { id: UID, ns: vector<u8>, members: vector<address> }\n\n    const E_NO_ACCESS: u64 = 1;\n    const E_WRONG_ID: u64 = 2;\n\n    /// The policy delegates its allowlist and identity check to a private\n    /// helper. A purely lexical scan sees no `assert!` inside seal_approve\n    /// and would call it Open — following the call shows the real gate.\n    entry fun seal_approve(id: vector<u8>, list: &Allowlist, ctx: &TxContext) {\n        enforce(list, &id, tx_context::sender(ctx));\n    }\n\n    fun enforce(list: &Allowlist, id: &vector<u8>, who: address) {\n        assert!(is_prefix(&list.ns, id), E_WRONG_ID);\n        assert!(vector::contains(&list.members, &who), E_NO_ACCESS);\n    }\n\n    fun is_prefix(pre: &vector<u8>, full: &vector<u8>): bool {\n        vector::length(pre) <= vector::length(full)\n    }\n}",
  "seal-sfx":
    "module vault::sealed_report {\n    use sui::event;\n    use sui::tx_context::{Self, TxContext};\n\n    struct Registry has key { id: UID, reads: u64 }\n    struct Accessed has copy, drop { who: address }\n\n    const E_NO_ACCESS: u64 = 1;\n\n    /// Two convention breaks: it is declared `public`, not `entry`, so the\n    /// key servers cannot invoke it as a policy; and it mutates state and\n    /// emits an event, but a policy is dry-run and must be side-effect free.\n    public fun seal_approve(id: vector<u8>, reg: &mut Registry, ctx: &TxContext) {\n        let who = tx_context::sender(ctx);\n        assert!(reg.reads < 100, E_NO_ACCESS);\n        let _ = id;\n        reg.reads = reg.reads + 1;\n        event::emit(Accessed { who });\n    }\n}",
  "seal-clean":
    "module allowlist::sealed_key {\n    use sui::tx_context::{Self, TxContext};\n    use std::vector;\n\n    struct Allowlist has key { id: UID, ns: vector<u8>, members: vector<address> }\n\n    const E_NO_ACCESS: u64 = 1;\n    const E_WRONG_ID: u64 = 2;\n\n    /// A correct Seal policy: entry, id first, side-effect free, bound to the\n    /// requested identity (the id must sit under this allowlist's namespace),\n    /// and gated on allowlist membership.\n    entry fun seal_approve(id: vector<u8>, list: &Allowlist, ctx: &TxContext) {\n        assert!(is_prefix(&list.ns, &id), E_WRONG_ID);\n        assert!(vector::contains(&list.members, &tx_context::sender(ctx)), E_NO_ACCESS);\n    }\n\n    /// read-only helper: is `pre` a prefix of `full`\n    fun is_prefix(pre: &vector<u8>, full: &vector<u8>): bool {\n        vector::length(pre) <= vector::length(full)\n    }\n}",
  "ca-event":
    "module treasury::confidential_pay {\n    use aptos_framework::confidential_asset;\n    use aptos_framework::event;\n\n    /// The receipt the app keeps for its own UI — but it carries the amount.\n    struct PaidEvent has store, drop { to: address, amount: u64 }\n\n    /// Pay a salary confidentially. The transfer amount is encrypted on-chain,\n    /// but the receipt event emits the cleartext `amount`, which puts the\n    /// value back in the open for everyone who can read the transaction.\n    public entry fun pay(sender: &signer, to: address, amount: u64, proof: vector<u8>) {\n        confidential_asset::confidential_transfer(sender, to, amount, proof);\n        event::emit(PaidEvent { to, amount });\n    }\n}",
  "ca-commit":
    "module receipts::confidential_receipt {\n    use aptos_framework::confidential_asset;\n    use aptos_framework::event;\n    use std::bcs;\n    use std::hash;\n\n    /// The receipt commits to the amount via a hash, not the amount itself.\n    struct Committed has store, drop { to: address, commitment: vector<u8> }\n\n    /// A confidential payment that emits only a COMMITMENT to the amount — a\n    /// hash, not the value. A lexical scan sees `emit` near `amount` and\n    /// would flag it; following the data shows the field is a commitment.\n    public entry fun pay(sender: &signer, to: address, amount: u64, proof: vector<u8>) {\n        confidential_asset::confidential_transfer(sender, to, amount, proof);\n        let commitment = hash::sha3_256(bcs::to_bytes(&amount));\n        event::emit(Committed { to, commitment });\n    }\n}",
  "ca-auth":
    "module bridge::confidential_sweep {\n    use aptos_framework::confidential_asset;\n\n    /// Sweep a confidential balance to a collector address.\n    /// BUG: no `&signer`. The function moves someone's confidential balance\n    /// without proving the caller is the account that owns it.\n    public entry fun sweep(from: address, to: address, amount_ct: vector<u8>, proof: vector<u8>) {\n        confidential_asset::confidential_transfer_from(from, to, amount_ct, proof);\n    }\n}",
  "ca-clean":
    "module usd::confidential_usd {\n    use aptos_framework::confidential_asset;\n    use aptos_framework::event;\n\n    struct Transferred has store, drop { to: address }   // no amount — fine\n\n    /// A correct confidential transfer: authorized by the sender's signer, the\n    /// amount stays encrypted (ciphertext + range proof), and the receipt\n    /// event carries only the recipient address.\n    public entry fun transfer(\n        sender: &signer,\n        to: address,\n        amount_ct: vector<u8>,\n        range_proof: vector<u8>,\n    ) {\n        confidential_asset::confidential_transfer(sender, to, amount_ct, range_proof);\n        event::emit(Transferred { to });\n    }\n}",
};

const EXPECTED: Record<string, Verdict> = {
  "seal-open": "high",
  "seal-helper": "clean",
  "seal-sfx": "med",
  "seal-clean": "clean",
  "ca-event": "med",
  "ca-commit": "clean",
  "ca-auth": "high",
  "ca-clean": "clean",
};

describe("confidentiality scenarios (default engine: AST with lexical fallback)", () => {
  for (const key of Object.keys(SOURCES)) {
    test(`${key} \u2192 ${EXPECTED[key]}`, () => {
      const r = kinetics.analyzeConfidentiality(SOURCES[key]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.engine).toBe("ast");
      expect(verdict(r)).toBe(EXPECTED[key]);
    });
  }
});

describe("the AST front-end is more precise than the lexical fallback", () => {
  test("seal-helper: a delegated gate reads as Restricted (AST), Open (lexical)", () => {
    const src = SOURCES["seal-helper"];
    expect(verdict(kinetics.analyzeConfidentialityAst(src))).toBe("clean");
    expect(verdict(kinetics.analyzeConfidentialityLexical(src))).toBe("high");
  });

  test("ca-commit: a hashed amount is a commitment (AST), a leak (lexical)", () => {
    const src = SOURCES["ca-commit"];
    const ast = kinetics.analyzeConfidentialityAst(src);
    const lex = kinetics.analyzeConfidentialityLexical(src);
    expect(verdict(ast)).toBe("clean");
    expect(ids(ast)).not.toContain("CA-EVENT");
    expect(ids(lex)).toContain("CA-EVENT");
  });
});

describe("parser and fallback", () => {
  test("parseMove resolves a well-formed module", () => {
    const p = kinetics.parseMove(SOURCES["seal-clean"]);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.modules?.length ?? 0).toBeGreaterThan(0);
  });

  test("a source the parser cannot handle falls back to the lexical engine", () => {
    const weird = [
      "module w::s {",
      "  public fun apply(f: |u64|u64, x: u64): u64 { f(x) }",
      "  entry fun seal_approve(id: vector<u8>, _l: &Allow) { let _ = id; }",
      "}",
    ].join("\n");
    expect(kinetics.parseMove(weird).ok).toBe(false);
    const r = kinetics.analyzeConfidentiality(weird);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.engine).toBe("lexical");
      expect(r.framework).toBe("seal");
    }
  });
});

describe("rule catalog", () => {
  test("is the full set and includes CA-RETURN", () => {
    expect(kinetics.CONFIDENTIALITY_RULES.length).toBe(12);
    expect(
      kinetics.CONFIDENTIALITY_RULES.some((r) => r.id === "CA-RETURN"),
    ).toBe(true);
    for (const r of kinetics.CONFIDENTIALITY_RULES) {
      expect(r.id).toBeTruthy();
      expect(["high", "medium", "low", "info"]).toContain(r.sev);
      expect(["Seal", "Aptos"]).toContain(r.fw);
    }
  });
});
