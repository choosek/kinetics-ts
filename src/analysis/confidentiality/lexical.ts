/**
 * Confidentiality analyzer — lexical engine.
 *
 * A static reader for the confidentiality surface of a Move contract that works
 * by scanning the source: comments and string literals are blanked (preserving
 * length and newlines so line numbers still map back), functions and their
 * bodies are found by matching `fun` and balancing brackets, and each finding
 * is a regular-expression heuristic over the function body.
 *
 * It is the fallback engine. The AST front-end (`./ast`) is preferred and is
 * more precise — it follows calls between functions and reasons about types —
 * but it only parses a practical subset of Move; when it cannot parse a source,
 * the umbrella analyzer (`./index`) falls back here so no input is ever
 * rejected. Both engines produce the identical result shape.
 *
 * Covers Sui Seal (a `seal_approve*` policy placed Open / Restricted / Locked,
 * plus the Seal conventions) and Aptos Confidential Assets (separating moving
 * an encrypted amount from disclosing it). Findings are advisory static
 * heuristics, not a proof.
 */
import type {
  ConfidentialityAnalysis,
  ConfidentialityExposure,
  ConfidentialityFinding,
  ConfidentialityOptions,
  ConfidentialityResult,
} from "./types";

interface LexMods {
  entry: boolean;
  pub: boolean;
  pubKind: string | null;
  native: boolean;
}
interface LexParam {
  name: string;
  type: string;
}
interface LexFn {
  name: string;
  mods: LexMods;
  paramsRaw: string;
  params: LexParam[];
  body: string;
  start: number;
  line: number;
}

/* ---------------------------------------------------------------- lexing */

// Blank out comments and string/byte-string literals while preserving length
// and newlines, so keyword/paren scanning is clean and line numbers still map
// back onto the original source.
function scrub(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b && k < n; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let j2 = i + 2;
      while (j2 < n && !(src[j2] === "*" && src[j2 + 1] === "/")) j2++;
      j2 = Math.min(n, j2 + 2);
      blank(i, j2);
      i = j2;
      continue;
    }
    if (c === '"') {
      let j3 = i + 1;
      while (j3 < n && src[j3] !== '"') {
        if (src[j3] === "\\") j3++;
        j3++;
      }
      j3 = Math.min(n, j3 + 1);
      blank(i, j3);
      i = j3;
      continue;
    }
    i++;
  }
  return out.join("");
}

function lineAt(src: string, idx: number): number {
  let l = 1;
  for (let k = 0; k < idx && k < src.length; k++) {
    if (src[k] === "\n") l++;
  }
  return l;
}

// Match a bracket group starting at `open` (index of the opening char).
function matchGroup(s: string, open: number, oc: string, cc: string): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === oc) depth++;
    else if (s[i] === cc) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "<" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === ">" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Find every function: modifiers, name, parameter list, body.
function functions(s: string): LexFn[] {
  const fns: LexFn[] = [];
  const re = /\bfun\s+([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null = re.exec(s);
  while (m) {
    const nameStart = m.index;
    const name = m[1];
    // preceding modifiers (look back to the last statement boundary)
    const back = s.slice(Math.max(0, nameStart - 60), nameStart);
    const bcut = Math.max(
      back.lastIndexOf(";"),
      back.lastIndexOf("{"),
      back.lastIndexOf("}"),
    );
    const pre = bcut >= 0 ? back.slice(bcut + 1) : back;
    const mods: LexMods = {
      entry: /\bentry\b/.test(pre),
      pub: /\bpublic\b/.test(pre),
      pubKind: (pre.match(/\bpublic\s*\(\s*([a-z]+)\s*\)/) || [])[1] || null,
      native: /\bnative\b/.test(pre),
    };
    // after the name: optional <...> generics, then (params)
    let p = re.lastIndex;
    while (p < s.length && /\s/.test(s[p])) p++;
    if (s[p] === "<") {
      const ge = matchGroup(s, p, "<", ">");
      if (ge < 0) {
        m = re.exec(s);
        continue;
      }
      p = ge + 1;
    }
    while (p < s.length && /\s/.test(s[p])) p++;
    if (s[p] !== "(") {
      m = re.exec(s);
      continue;
    }
    const pe = matchGroup(s, p, "(", ")");
    if (pe < 0) {
      m = re.exec(s);
      continue;
    }
    const params = s.slice(p + 1, pe);
    // after params: skip return type / acquires until `{` or `;`
    let q = pe + 1;
    let bodyOpen = -1;
    while (q < s.length) {
      if (s[q] === "{") {
        bodyOpen = q;
        break;
      }
      if (s[q] === ";") break; // native / declaration, no body
      q++;
    }
    let body = "";
    if (bodyOpen >= 0) {
      const be = matchGroup(s, bodyOpen, "{", "}");
      body = be >= 0 ? s.slice(bodyOpen + 1, be) : s.slice(bodyOpen + 1);
    }
    fns.push({
      name,
      mods,
      paramsRaw: params.trim(),
      params: splitTop(params)
        .map((x): LexParam => {
          const t = x.trim();
          const ci = t.indexOf(":");
          return ci >= 0
            ? { name: t.slice(0, ci).trim(), type: t.slice(ci + 1).trim() }
            : { name: t, type: "" };
        })
        .filter((x) => x.name),
      body,
      start: nameStart,
      line: lineAt(s, nameStart),
    });
    m = re.exec(s);
  }
  return fns;
}

const norm = (t: string): string => (t || "").replace(/\s+/g, "");
function vis(mods: LexMods): string {
  return mods.entry
    ? "entry"
    : mods.pub
      ? mods.pubKind
        ? `public(${mods.pubKind})`
        : "public"
      : "private";
}

function tally(findings: ConfidentialityFinding[]): {
  high: number;
  medium: number;
  low: number;
  info: number;
} {
  return {
    high: findings.filter((x) => x.sev === "high").length,
    medium: findings.filter((x) => x.sev === "medium").length,
    low: findings.filter((x) => x.sev === "low").length,
    info: findings.filter((x) => x.sev === "info").length,
  };
}

/* --------------------------------------------------------------- SEAL */

const MUTATORS =
  /borrow_global_mut|borrow_mut\b|\bevent::emit\b|::emit\b|transfer::(public_transfer|transfer|share_object|public_share_object|freeze_object|public_freeze_object)|vector::(push_back|pop_back|swap_remove|append)|table::(add|remove|borrow_mut)|object_table::|dynamic_field::(add|remove|borrow_mut)|object::delete\b|\+=|-=|\*=/;

function analyzeSeal(_s: string, fns: LexFn[]): ConfidentialityResult {
  const findings: ConfidentialityFinding[] = [];
  const surface: ConfidentialityExposure[] = [];
  const policies = fns.filter((f) => /^seal_approve/.test(f.name));
  let openCount = 0;
  let sfx = false;

  for (const f of policies) {
    const b = f.body;
    const hasAssert = /\bassert!\s*\(/.test(b);
    const hasAbort = /\babort\b/.test(b);
    const locked =
      /assert!\s*\(\s*false\b/.test(b) || /^\s*abort\b/.test(b.trim());
    let policy: string;
    let reach: string;
    if (locked) {
      policy = "locked";
      reach = "nobody";
    } else if (!hasAssert && !hasAbort) {
      policy = "open";
      reach = "anyone";
      openCount++;
    } else {
      policy = "restricted";
      reach = "grantees";
    }

    if (!f.mods.entry)
      findings.push({
        id: "SEAL-VIS",
        sev: "medium",
        loc: f.line,
        title: "Policy is not an entry function",
        detail: `\`${f.name}\` is ${f.mods.pub ? "`public`" : "not `entry`"}. Seal key servers invoke a policy as an \`entry\` function; a \`public fun\` cannot serve as a policy and a non-\`entry\` function is not dry-run as one.`,
        fix: `Declare it \`entry fun ${f.name}(...)\`. A non-\`public entry\` function is preferred so it is reachable only as a policy.`,
      });
    const p0 = f.params[0];
    if (!p0 || !/vector<u8>/.test(norm(p0.type)))
      findings.push({
        id: "SEAL-ID",
        sev: "medium",
        loc: f.line,
        title: "Identity parameter missing or misplaced",
        detail: `A \`seal_approve\` policy must take the requested identity, \`id: vector<u8>\`, as its first parameter${p0 ? ` — here the first parameter is \`${p0.name}: ${p0.type}\`.` : "."}`,
        fix: "Make the first parameter `id: vector<u8>` and derive access from it.",
      });
    const mm = b.match(MUTATORS);
    if (mm) {
      sfx = true;
      findings.push({
        id: "SEAL-SFX",
        sev: "medium",
        loc: f.line,
        title: "Policy is not side-effect free",
        detail: `A policy is dry-run by the key servers and must not change state. \`${f.name}\` performs \`${mm[0].replace(/\\b/g, "")}\`, which mutates state, emits, or transfers.`,
        fix: `A policy only reads and asserts — remove all state changes from \`${f.name}\`.`,
      });
    }
    if (policy === "open")
      findings.push({
        id: "SEAL-OPEN",
        sev: "high",
        loc: f.line,
        title: "Open policy — any caller can decrypt",
        detail: `\`${f.name}\` never calls \`assert!\` or \`abort\`, so it completes for every caller. Seal reads a completed policy as “access granted”: any address can obtain the decryption key for data sealed to this identity, so the ciphertext is effectively public.`,
        fix: "Gate the policy — `assert!(<allowlist / owner / time-lock condition>, E_NO_ACCESS)` — and let it `abort` for everyone else.",
      });
    else if (policy === "locked")
      findings.push({
        id: "SEAL-LOCK",
        sev: "info",
        loc: f.line,
        title: "Locked policy — no caller can decrypt",
        detail: `\`${f.name}\` always aborts, so no one is ever granted the key. That is safe; surfaced in case the policy was meant to be reachable.`,
        fix: "",
      });
    const objParam = f.params
      .slice(1)
      .some((p) => /^&/.test(p.type.trim()) || /^0x|::/.test(p.type));
    if (policy !== "open" && objParam && !/\bid\b/.test(b))
      findings.push({
        id: "SEAL-BIND",
        sev: "low",
        loc: f.line,
        title: "Policy may not be bound to the requested identity",
        detail: `\`${f.name}\` gates on its object arguments but never references \`id\`. If the object passed is not tied to \`id\`, a caller could satisfy the policy for one identity while requesting the key for another.`,
        fix: "Check `id` against the sealed object — e.g. require `id` to equal the object's namespace/key.",
      });

    surface.push({
      fn: `${f.name}(id, …)`,
      vis: vis(f.mods),
      policy,
      reach,
      reveals:
        policy === "open"
          ? "decryption key — to any caller"
          : policy === "locked"
            ? "nothing — always denied"
            : "decryption key — to approved callers",
    });
  }

  // other externally-callable functions (context, not policies)
  for (const f of fns.filter(
    (f) => !/^seal_approve/.test(f.name) && (f.mods.entry || f.mods.pub),
  )) {
    surface.push({
      fn: `${f.name}()`,
      vis: vis(f.mods),
      policy: "n/a",
      reach: "callers",
      reveals: "not a policy",
    });
  }

  const leaked: string[] = [];
  if (openCount)
    leaked.push(
      "The decryption key — to ANY caller. Data sealed to this identity is effectively public.",
    );
  if (sfx)
    leaked.push(
      "A policy with side effects can be replayed by the key servers; its state changes are attacker-triggerable.",
    );

  if (!policies.length)
    findings.unshift({
      id: "SEAL-NONE",
      sev: "info",
      loc: 1,
      title: "No seal_approve policy found",
      detail:
        "Seal signals were detected but no `seal_approve*` function is defined here. A Seal-gated package exposes its access rule as `entry fun seal_approve(id: vector<u8>, …)`.",
      fix: "",
    });

  const sev = tally(findings);
  return {
    ok: true,
    framework: "seal",
    engine: "lexical",
    module: "",
    summary: {
      functions: fns.length,
      entryFns: fns.filter((f) => f.mods.entry).length,
      high: sev.high,
      medium: sev.medium,
      low: sev.low,
      info: sev.info,
      exposedFns: policies.length,
      confItems: policies.length,
    },
    findings,
    surface,
    observers: {
      public: [
        "The sealed ciphertext and its object id (on Walrus / on-chain)",
        "The policy program itself — public Move source",
        "That a key was requested (the policy dry-run)",
      ],
      authorized: [
        "The plaintext — to any caller the policy's `assert!`s admit",
      ],
      leaked,
    },
    assumptions: [
      "Fallback engine: source is read lexically (comments and strings blanked). The AST front-end is preferred and more precise; this ran because it could not parse the source.",
      "Models the Seal access-control model: a `seal_approve` policy grants the key when it completes and denies when it aborts. It must be `entry`, take `id: vector<u8>` first, and be side-effect free.",
      "Reachability also depends on package upgradeability — an upgradeable package's authority can replace this policy. Confirm the package is immutable or that upgrades are controlled.",
      "Decryption is client-side; Seal plaintext never touches the chain. This engine reasons about who the policy admits, not off-chain key handling.",
    ],
  };
}

/* ------------------------------------------------------------ APTOS-CA */

const CA_TRANSFER =
  /confidential_transfer|confidential_asset::transfer\b|::confidential_transfer\b/;
const CA_WITHDRAW = /confidential_asset::withdraw|withdraw_to\b|::withdraw\b/;
const CA_DEPOSIT = /confidential_asset::deposit|::deposit\b/;
const CA_ROLLOVER = /rollover_pending_balance|::rollover\b/;
const CA_ANY =
  /confidential_(asset|balance|transfer|coin)\b|confidential_asset::|rollover_pending_balance/;

function analyzeCA(s: string, fns: LexFn[]): ConfidentialityResult {
  const findings: ConfidentialityFinding[] = [];
  const surface: ConfidentialityExposure[] = [];
  const usesDeposit = CA_DEPOSIT.test(s);
  const usesWithdraw = CA_WITHDRAW.test(s);
  const auditor = /auditor|set_auditor|auditor_ek|global_auditor/i.test(s);
  let leakedEvt = false;
  let dkLeak = false;

  const caFns = fns.filter((f) => CA_ANY.test(f.body));

  for (const f of caFns) {
    const b = f.body;
    const reveals: string[] = [];
    const stateChange =
      CA_TRANSFER.test(b) ||
      CA_WITHDRAW.test(b) ||
      CA_DEPOSIT.test(b) ||
      CA_ROLLOVER.test(b);
    const hasSigner =
      f.params.some((p) => /signer/.test(p.type)) ||
      /signer::address_of/.test(b);

    if (
      /event::emit\s*\(|::emit\s*\(/.test(b) &&
      /\b(amount|amt|value|balance)\b/.test(b)
    ) {
      leakedEvt = true;
      reveals.push("amount — LEAKED via event");
      findings.push({
        id: "CA-EVENT",
        sev: "medium",
        loc: f.line,
        title: "Confidential amount emitted in an event",
        detail: `\`${f.name}\` performs a confidential-asset operation and emits an event that carries an amount. Confidential Assets keep the amount encrypted on-chain, but an event field is plaintext to everyone who can read the transaction — putting the amount back in the open.`,
        fix: "Emit only non-amount metadata (addresses, an opaque id). Never place a confidential amount in an event.",
      });
    }
    if (
      f.params
        .concat([{ name: "", type: "" }])
        .some((p) => /\b(dk|decryption_key|secret_key|sk)\b/.test(p.name)) ||
      /\breturn\b[\s\S]{0,40}\b(dk|decryption_key)\b/.test(b)
    ) {
      if (f.mods.pub || f.mods.entry) {
        dkLeak = true;
        reveals.push("decryption key");
        findings.push({
          id: "CA-DK",
          sev: "high",
          loc: f.line,
          title: "Decryption key exposed",
          detail: `\`${f.name}\` exposes a decryption key (\`dk\`). Anyone holding the decryption key can read every amount encrypted to that account — it must never be returned, emitted, stored on-chain, or handed to untrusted code.`,
          fix: "Keep decryption keys client-side; only ciphertexts and zero-knowledge proofs belong on-chain.",
        });
      }
    }
    if (stateChange && !hasSigner)
      findings.push({
        id: "CA-AUTH",
        sev: "high",
        loc: f.line,
        title: "Confidential operation without an authorizing signer",
        detail: `\`${f.name}\` moves a confidential balance but takes no \`&signer\` and checks no caller. A confidential-asset transfer or withdraw must be authorized by the account that owns the balance.`,
        fix: "Take `sender: &signer` and bind the operation to `signer::address_of(sender)`; assert any additional policy.",
      });

    if (CA_TRANSFER.test(b) && !reveals.length)
      reveals.push("amount — encrypted to recipient + auditor");
    if (
      (usesDeposit && CA_DEPOSIT.test(b)) ||
      (usesWithdraw && CA_WITHDRAW.test(b))
    )
      reveals.push("amount — public at boundary");

    surface.push({
      fn: `${f.name}()`,
      vis: vis(f.mods),
      policy: hasSigner ? "restricted" : "unset",
      reach: hasSigner ? "account owner" : "any caller",
      reveals: reveals.length ? reveals.join("; ") : "encrypted amount",
    });
  }

  if (usesDeposit || usesWithdraw)
    findings.push({
      id: "CA-BOUNDARY",
      sev: "info",
      loc: (caFns[0] || { line: 1 }).line,
      title: "Amounts are public at deposit / withdraw",
      detail:
        "Confidential Assets hide the amount for in-domain `confidential_transfer`s, but `deposit` and `withdraw` cross between the public balance and the confidential balance — those amounts are visible on-chain. This is by design; surfaced so the entry/exit amounts are reviewed.",
      fix: "",
    });
  if (auditor)
    findings.push({
      id: "CA-AUDITOR",
      sev: "info",
      loc: (caFns[0] || { line: 1 }).line,
      title: "An auditor can decrypt every amount",
      detail:
        "This module installs or relies on an auditor viewing key. Each transfer amount is encrypted to the recipient AND to the auditor, so a configured auditor can decrypt every amount. Confirm the auditor is a known, trusted party — and that it cannot be silently swapped per transfer.",
      fix: "",
    });

  const leaked: string[] = [];
  if (leakedEvt)
    leaked.push(
      "The amount — via an event, to everyone who can read the transaction.",
    );
  if (dkLeak)
    leaked.push(
      "A decryption key — whoever holds it can read every amount on the account.",
    );

  const sev = tally(findings);
  const pub = [
    "Sender and recipient addresses",
    "That a confidential transfer occurred",
    "Gas paid",
  ];
  if (usesDeposit || usesWithdraw)
    pub.push(
      "Amounts at deposit / withdraw (the public↔confidential boundary)",
    );

  return {
    ok: true,
    framework: "aptos-ca",
    engine: "lexical",
    module: "",
    summary: {
      functions: fns.length,
      entryFns: fns.filter((f) => f.mods.entry).length,
      high: sev.high,
      medium: sev.medium,
      low: sev.low,
      info: sev.info,
      exposedFns: caFns.length,
      confItems: caFns.length,
    },
    findings,
    surface,
    observers: {
      public: pub,
      authorized: [
        "The transfer amount — to the recipient, and to the configured auditor (if any)",
      ],
      leaked,
    },
    assumptions: [
      "Fallback engine: source is read lexically; the AST front-end is preferred and ran here only because it could not parse the source.",
      "Models Aptos Confidential Assets: balances and transfer amounts are encrypted (Twisted ElGamal + ZK); addresses and the fact of a transfer are public — confidentiality, not anonymity.",
      "`deposit` and `withdraw` reveal amounts by design (the public↔confidential boundary); an in-domain `confidential_transfer` hides the amount.",
      "Every transfer amount is also encrypted to the account's configured auditor viewing key, when one is set.",
    ],
  };
}

/* ------------------------------------------------------------ generic */

function analyzeGeneric(_s: string, fns: LexFn[]): ConfidentialityResult {
  return {
    ok: true,
    framework: "move",
    engine: "lexical",
    module: "",
    summary: {
      functions: fns.length,
      entryFns: fns.filter((f) => f.mods.entry).length,
      high: 0,
      medium: 0,
      low: 0,
      info: 1,
      exposedFns: 0,
      confItems: 0,
    },
    findings: [
      {
        id: "NO-CONF",
        sev: "info",
        loc: 1,
        title: "No confidentiality surface detected",
        detail:
          "This source references neither a Seal `seal_approve` policy nor Aptos Confidential Assets, so there is no confidential state for this engine to trace. Paste a Seal policy module or a Confidential-Assets module — or load an example scenario below.",
        fix: "",
      },
    ],
    surface: fns
      .filter((f) => f.mods.entry || f.mods.pub)
      .map((f) => ({
        fn: `${f.name}()`,
        vis: vis(f.mods),
        policy: "n/a",
        reach: "callers",
        reveals: "—",
      })),
    observers: {
      public: ["Everything this module writes to global storage or emits"],
      authorized: [],
      leaked: [],
    },
    assumptions: [
      "Fallback engine: source is read lexically; the AST front-end is preferred.",
      "No confidential framework (Seal or Aptos Confidential Assets) was detected in this source.",
    ],
  };
}

/* ------------------------------------------------------------- public */

/**
 * Analyze a Move source string with the lexical engine. Returns a
 * {@link ConfidentialityAnalysis}. Pass `options.chain` to force the framework
 * instead of classifying the source automatically.
 */
export function analyzeConfidentialityLexical(
  srcRaw: string,
  options: ConfidentialityOptions = {},
): ConfidentialityAnalysis {
  const src = String(srcRaw || "");
  if (!src.trim())
    return {
      ok: false,
      error: "Paste some Move source, or load an example scenario below.",
    };
  const s = scrub(src);
  const fns = functions(s);
  const forced = options.chain;
  const isSeal =
    forced === "sui" ||
    (!forced &&
      (fns.some((f) => /^seal_approve/.test(f.name)) ||
        /\bseal_approve\b/.test(s)));
  const isCA = forced === "aptos" || (!forced && CA_ANY.test(s));
  const res = isSeal
    ? analyzeSeal(s, fns)
    : isCA
      ? analyzeCA(s, fns)
      : analyzeGeneric(s, fns);
  res.module = (src.match(/\bmodule\s+([A-Za-z0-9_:]+)/) || [])[1] || "";
  return res;
}
