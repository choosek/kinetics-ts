/**
 * Confidentiality analyzer — Move AST front-end.
 *
 * This is the default confidentiality engine: it parses Move source to an
 * abstract syntax tree with a hand-written recursive-descent parser, then
 * analyzes the tree. Over the lexical fallback (`./lexical`) it gains three
 * things a regular expression cannot do:
 *
 *   • Interprocedural Seal reachability — a `seal_approve` policy whose check
 *     lives in a private helper is followed into that helper, so a delegated
 *     gate is seen as Restricted rather than mis-reported Open.
 *   • Type-aware information flow — a confidential value is traced through
 *     `let` bindings, borrows, and hashes to the sinks that disclose it, and a
 *     plaintext integer amount emitted in an event is distinguished from an
 *     already-encrypted `vector<u8>` ciphertext (which is safe to emit).
 *   • Commitment recognition — a value disclosed only as a hash of a
 *     confidential amount is a commitment, not a leak.
 *
 * The parser targets the practical Move subset these analyses need and is
 * deliberately conservative: on any construct it cannot parse it throws, and
 * the umbrella analyzer (`./index`) falls back to the lexical engine, so no
 * input is ever rejected outright. The result shape is identical to the lexical
 * engine, and `engine` is set to `"ast"`.
 */
import type {
  ConfidentialityAnalysis,
  ConfidentialityExposure,
  ConfidentialityFinding,
  ConfidentialityOptions,
  ConfidentialityResult,
} from "./types";

/* =============================== tokenizer =============================== */

const KW = new Set([
  "module",
  "use",
  "friend",
  "public",
  "entry",
  "native",
  "fun",
  "struct",
  "enum",
  "const",
  "let",
  "mut",
  "if",
  "else",
  "while",
  "loop",
  "return",
  "abort",
  "break",
  "continue",
  "copy",
  "move",
  "as",
  "has",
  "acquires",
  "address",
  "spec",
  "phantom",
  "true",
  "false",
]);

// multi-char punctuation (longest first). We deliberately do NOT form "<<" or
// ">>" so that "<" and ">" stay single tokens and generic argument lists close
// cleanly (nested generics end in consecutive single ">" tokens).
const OPS = [
  "::",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "=>",
  "..",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "&",
  "|",
  "^",
  "!",
  "=",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ",",
  ";",
  ":",
  ".",
  "@",
  "~",
];

interface Tok {
  type: string;
  value: string;
  start: number;
  end: number;
  line: number;
}

// AST nodes are structurally varied and read dynamically by the analyzer; a
// single loose alias keeps the parser readable without a large node union.
// biome-ignore lint/suspicious/noExplicitAny: recursive AST nodes are dynamically shaped
type AstNode = any;

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  const make = (type: string, value: string, start: number): void => {
    toks.push({ type, value, start, end: i, line });
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    // strings, incl. b"..." / x"..." byte/hex string prefixes
    if (c === '"' || ((c === "b" || c === "x") && src[i + 1] === '"')) {
      const start = i;
      const ln = line;
      if (c !== '"') i++; // consume prefix
      i++; // opening quote
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\") i++;
        if (src[i] === "\n") line++;
        i++;
      }
      i++; // closing quote
      toks.push({
        type: "str",
        value: src.slice(start, i),
        start,
        end: i,
        line: ln,
      });
      continue;
    }
    // numbers (hex or decimal, optional integer-type suffix)
    if (c >= "0" && c <= "9") {
      const s0 = i;
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        i += 2;
        while (i < n && /[0-9a-fA-F_]/.test(src[i])) i++;
      } else {
        while (i < n && /[0-9_]/.test(src[i])) i++;
      }
      if (/[ui]/.test(src[i] || "")) {
        let j = i;
        while (j < n && /[a-z0-9]/.test(src[j])) j++;
        i = j;
      }
      make("num", src.slice(s0, i), s0);
      continue;
    }
    // identifiers / keywords
    if (/[A-Za-z_]/.test(c)) {
      const s1 = i;
      i++;
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++;
      const v = src.slice(s1, i);
      toks.push({
        type: KW.has(v) ? "kw" : "ident",
        value: v,
        start: s1,
        end: i,
        line,
      });
      continue;
    }
    // punctuation / operators
    let matched: string | null = null;
    for (const op of OPS) {
      if (src.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      const sp = i;
      i += matched.length;
      make("punct", matched, sp);
      continue;
    }
    throw new Error(`unexpected character '${c}' at line ${line}`);
  }
  toks.push({ type: "eof", value: "", start: n, end: n, line });
  return toks;
}

/* ================================ parser ================================ */

const BINOPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "==",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "&&",
  "||",
  "&",
  "|",
  "^",
  "=",
  "<<",
  ">>",
]);

class Parser {
  private t: Tok[];
  private p: number;
  constructor(toks: Tok[]) {
    this.t = toks;
    this.p = 0;
  }
  private peek(o = 0): Tok {
    return this.t[this.p + o];
  }
  private next(): Tok {
    return this.t[this.p++];
  }
  private atEnd(): boolean {
    return this.peek().type === "eof";
  }
  private is(v: string): boolean {
    const k = this.peek();
    return (k.type === "punct" || k.type === "kw") && k.value === v;
  }
  private isKw(v: string): boolean {
    const k = this.peek();
    return k.type === "kw" && k.value === v;
  }
  private eat(v: string): boolean {
    if (this.is(v)) {
      this.next();
      return true;
    }
    return false;
  }
  private expect(v: string): Tok {
    if (!this.is(v)) this.err(`expected '${v}'`);
    return this.next();
  }
  private ident(): string {
    const k = this.peek();
    if (k.type !== "ident" && k.type !== "kw") this.err("expected identifier");
    return this.next().value;
  }
  private err(m: string): never {
    const k = this.peek();
    throw new Error(`${m} (got '${k.value || k.type}' at line ${k.line})`);
  }

  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let d = 1;
    while (d > 0 && !this.atEnd()) {
      if (this.is(open)) d++;
      else if (this.is(close)) d--;
      this.next();
    }
  }
  private skipAttrs(): void {
    while (this.peek().type === "punct" && this.peek().value === "#") {
      this.next();
      if (this.is("[")) this.skipBalanced("[", "]");
    }
  }

  parseFile(): AstNode[] {
    const modules: AstNode[] = [];
    while (!this.atEnd()) {
      this.skipAttrs();
      if (this.isKw("module")) {
        modules.push(this.parseModule());
      } else if (this.isKw("address")) {
        this.next();
        this.ident();
        this.expect("{");
        while (!this.is("}") && !this.atEnd()) {
          this.skipAttrs();
          if (this.isKw("module")) modules.push(this.parseModule());
          else this.err("expected module in address block");
        }
        this.expect("}");
      } else if (
        this.peek().type === "ident" &&
        this.peek().value === "script"
      ) {
        this.next();
        this.skipBalanced("{", "}");
      } else this.err("expected module");
    }
    return modules;
  }

  private parseModule(): AstNode {
    const ln = this.peek().line;
    this.expect("module");
    const a = this.ident();
    let name = a;
    let addr: string | null = null;
    if (this.eat("::")) {
      addr = a;
      name = this.ident();
    }
    this.expect("{");
    const items: AstNode[] = [];
    while (!this.is("}") && !this.atEnd()) {
      this.skipAttrs();
      if (this.is("}")) break;
      if (this.isKw("use") || this.isKw("friend")) {
        while (!this.is(";") && !this.atEnd()) this.next();
        this.eat(";");
        continue;
      }
      if (this.isKw("const")) {
        items.push(this.parseConst());
        continue;
      }
      if (this.isKw("struct")) {
        items.push(this.parseStruct());
        continue;
      }
      if (this.isKw("enum")) {
        this.next();
        this.ident();
        if (this.is("<")) this.skipBalanced("<", ">");
        if (this.isKw("has")) {
          while (!this.is("{") && !this.is(";") && !this.atEnd()) this.next();
        }
        if (this.is("{")) this.skipBalanced("{", "}");
        else this.eat(";");
        continue;
      }
      if (this.isKw("spec")) {
        this.next();
        while (!this.is("{") && !this.is(";") && !this.atEnd()) this.next();
        if (this.is("{")) this.skipBalanced("{", "}");
        else this.eat(";");
        continue;
      }
      if (
        this.isKw("public") ||
        this.isKw("entry") ||
        this.isKw("native") ||
        this.isKw("fun")
      ) {
        items.push(this.parseFun());
        continue;
      }
      this.err("unexpected item");
    }
    this.expect("}");
    return { kind: "Module", addr, name, items, line: ln };
  }

  private parseConst(): AstNode {
    const ln = this.peek().line;
    this.expect("const");
    const name = this.ident();
    this.expect(":");
    const ty = this.parseType();
    this.expect("=");
    this.parseExpr();
    this.expect(";");
    return { kind: "Const", name, type: ty, line: ln };
  }

  private parseStruct(): AstNode {
    const ln = this.peek().line;
    this.expect("struct");
    const name = this.ident();
    if (this.is("<")) this.skipBalanced("<", ">");
    if (this.isKw("has")) {
      this.next();
      this.ident();
      while (this.eat(",")) this.ident();
    }
    const fields: AstNode[] = [];
    if (this.is("{")) {
      this.next();
      while (!this.is("}") && !this.atEnd()) {
        this.skipAttrs();
        const fn = this.ident();
        this.expect(":");
        const ft = this.parseType();
        fields.push({ name: fn, type: ft });
        if (!this.eat(",")) break;
      }
      this.expect("}");
    } else if (this.is("(")) {
      this.skipBalanced("(", ")");
      this.eat(";");
    } else {
      this.eat(";");
    }
    return { kind: "Struct", name, fields, line: ln };
  }

  private parseFun(): AstNode {
    const ln = this.peek().line;
    const mods = {
      entry: false,
      pub: false,
      pubKind: null as string | null,
      native: false,
    };
    while (true) {
      if (this.isKw("public")) {
        this.next();
        mods.pub = true;
        if (this.is("(")) {
          this.next();
          mods.pubKind = this.ident();
          this.expect(")");
        }
      } else if (this.isKw("entry")) {
        this.next();
        mods.entry = true;
      } else if (this.isKw("native")) {
        this.next();
        mods.native = true;
      } else break;
    }
    this.expect("fun");
    const name = this.ident();
    if (this.is("<")) this.skipBalanced("<", ">");
    this.expect("(");
    const params: AstNode[] = [];
    while (!this.is(")") && !this.atEnd()) {
      this.eat("mut");
      const pn = this.ident();
      this.expect(":");
      const pt = this.parseType();
      params.push({ name: pn, type: pt });
      if (!this.eat(",")) break;
    }
    this.expect(")");
    let ret: AstNode = null;
    if (this.eat(":")) ret = this.parseType();
    if (this.isKw("acquires")) {
      this.next();
      this.parseTypePath();
      while (this.eat(",")) this.parseTypePath();
    }
    let body: AstNode = null;
    if (this.is("{")) body = this.parseBlock();
    else this.eat(";");
    return { kind: "Fun", mods, name, params, ret, body, line: ln };
  }

  private parseTypePath(): void {
    this.ident();
    while (this.eat("::")) this.ident();
    if (this.is("<")) this.skipBalanced("<", ">");
  }

  private parseType(): AstNode {
    let ref: string | null = null;
    if (this.is("&")) {
      this.next();
      if (this.isKw("mut")) {
        this.next();
        ref = "&mut";
      } else ref = "&";
    }
    if (this.is("(")) {
      this.next();
      const args: AstNode[] = [];
      if (!this.is(")")) {
        args.push(this.parseType());
        while (this.eat(",")) {
          if (this.is(")")) break;
          args.push(this.parseType());
        }
      }
      this.expect(")");
      return {
        text: `(${args.map((x: AstNode) => x.text).join(", ")})`,
        base: "tuple",
        ref,
        args,
        path: [],
      };
    }
    if (this.isKw("phantom")) this.next();
    const parts = [this.ident()];
    while (this.eat("::")) parts.push(this.ident());
    const gargs: AstNode[] = [];
    if (this.is("<")) {
      this.next();
      if (!this.is(">")) {
        gargs.push(this.parseType());
        while (this.eat(",")) {
          if (this.is(">")) break;
          gargs.push(this.parseType());
        }
      }
      this.expect(">");
    }
    const base = parts[parts.length - 1];
    const text = `${ref ? `${ref} ` : ""}${parts.join("::")}${gargs.length ? `<${gargs.map((x: AstNode) => x.text).join(", ")}>` : ""}`;
    return { text, base, ref, args: gargs, path: parts };
  }

  private parseBlock(): AstNode {
    const ln = this.peek().line;
    this.expect("{");
    const stmts: AstNode[] = [];
    let tail: AstNode = null;
    while (!this.is("}") && !this.atEnd()) {
      if (this.isKw("let")) {
        stmts.push(this.parseLet());
        continue;
      }
      if (this.isKw("return")) {
        const rl = this.peek().line;
        this.next();
        const re = this.is(";") || this.is("}") ? null : this.parseExpr();
        stmts.push({ kind: "Return", expr: re, line: rl });
        this.eat(";");
        continue;
      }
      if (this.isKw("abort")) {
        const al = this.peek().line;
        this.next();
        const ae = this.is(";") || this.is("}") ? null : this.parseExpr();
        stmts.push({ kind: "Abort", expr: ae, line: al });
        this.eat(";");
        continue;
      }
      if (this.isKw("break") || this.isKw("continue")) {
        this.next();
        if (!this.is(";") && !this.is("}")) this.parseExpr();
        this.eat(";");
        continue;
      }
      const e = this.parseExpr();
      if (this.eat(";")) {
        stmts.push({ kind: "ExprStmt", expr: e, line: e.line || ln });
      } else if (this.is("}")) {
        tail = e;
      } else {
        // block-like expr used as a statement, no ";"
        stmts.push({ kind: "ExprStmt", expr: e, line: e.line || ln });
      }
    }
    this.expect("}");
    return { kind: "Block", stmts, tail, line: ln };
  }

  private parseLet(): AstNode {
    const ln = this.peek().line;
    this.expect("let");
    const names = this.parseBindNames();
    let ty: AstNode = null;
    if (this.eat(":")) ty = this.parseType();
    let init: AstNode = null;
    if (this.eat("=")) init = this.parseExpr();
    this.expect(";");
    return { kind: "Let", names, type: ty, init, line: ln };
  }

  private parseBindNames(): string[] {
    if (this.is("(")) {
      this.next();
      const ns: string[] = [];
      while (!this.is(")") && !this.atEnd()) {
        this.eat("mut");
        if (this.is("_")) this.next();
        else ns.push(this.ident());
        if (!this.eat(",")) break;
      }
      this.expect(")");
      return ns;
    }
    const save = this.p;
    if (this.peek().type === "ident") {
      const parts = [this.ident()];
      while (this.eat("::")) parts.push(this.ident());
      if (this.is("{")) {
        this.next();
        const ns2: string[] = [];
        while (!this.is("}") && !this.atEnd()) {
          const fn = this.ident();
          if (this.eat(":")) {
            this.eat("mut");
            if (this.is("_")) this.next();
            else ns2.push(this.ident());
          } else ns2.push(fn);
          if (!this.eat(",")) break;
        }
        this.expect("}");
        return ns2;
      }
      this.p = save; // not a destructure — plain name
    }
    this.eat("mut");
    if (this.is("_")) {
      this.next();
      return [];
    }
    return [this.ident()];
  }

  private parseExpr(): AstNode {
    return this.parseBinary();
  }
  private parseBinary(): AstNode {
    let left = this.parseUnary();
    while (true) {
      const k = this.peek();
      if (k.type === "punct" && BINOPS.has(k.value)) {
        const op = this.next().value;
        const right = this.parseUnary();
        left =
          op === "="
            ? { kind: "Assign", target: left, value: right, line: left.line }
            : { kind: "Binary", op, left, right, line: left.line };
      } else break;
    }
    return left;
  }
  private parseUnary(): AstNode {
    const ln = this.peek().line;
    if (this.is("&")) {
      this.next();
      const mut = this.eat("mut");
      return { kind: "Borrow", mut, expr: this.parseUnary(), line: ln };
    }
    if (this.is("*")) {
      this.next();
      return { kind: "Deref", expr: this.parseUnary(), line: ln };
    }
    if (this.is("!")) {
      this.next();
      return { kind: "Unary", op: "!", expr: this.parseUnary(), line: ln };
    }
    if (this.isKw("copy") || this.isKw("move")) {
      const op = this.next().value;
      return { kind: "CopyMove", op, expr: this.parseUnary(), line: ln };
    }
    return this.parsePostfix();
  }
  private parsePostfix(): AstNode {
    let node = this.parsePrimary();
    while (true) {
      if (this.is(".")) {
        this.next();
        const nm =
          this.peek().type === "num" ? this.next().value : this.ident();
        if (this.is("(")) {
          const args = this.parseArgs();
          node = {
            kind: "Call",
            callee: { kind: "Field", obj: node, name: nm, line: node.line },
            method: nm,
            recv: node,
            args,
            line: node.line,
          };
        } else node = { kind: "Field", obj: node, name: nm, line: node.line };
      } else if (
        this.is("(") &&
        (node.kind === "Path" || node.kind === "Name")
      ) {
        const a2 = this.parseArgs();
        node = { kind: "Call", callee: node, args: a2, line: node.line };
      } else if (
        this.is("<") &&
        (node.kind === "Path" || node.kind === "Name")
      ) {
        // speculative: generic-args of a call?  path<...>(  ...
        const save = this.p;
        try {
          this.skipBalanced("<", ">");
        } catch (_e) {
          this.p = save;
          break;
        }
        if (this.is("(")) {
          const a3 = this.parseArgs();
          node = {
            kind: "Call",
            callee: node,
            generic: true,
            args: a3,
            line: node.line,
          };
        } else {
          this.p = save; // it was a "<" comparison
          break;
        }
      } else if (
        this.is("{") &&
        (node.kind === "Path" || node.kind === "Name") &&
        this.looksLikePack()
      ) {
        node = this.parsePack(node);
      } else break;
    }
    return node;
  }
  private parseArgs(): AstNode[] {
    this.expect("(");
    const args: AstNode[] = [];
    if (!this.is(")")) {
      args.push(this.parseExpr());
      while (this.eat(",")) {
        if (this.is(")")) break;
        args.push(this.parseExpr());
      }
    }
    this.expect(")");
    return args;
  }
  private looksLikePack(): boolean {
    if (!this.is("{")) return false;
    const a = this.peek(1);
    const b = this.peek(2);
    if (a && a.type === "punct" && a.value === "}") return true;
    if (
      a &&
      a.type === "ident" &&
      b &&
      b.type === "punct" &&
      (b.value === ":" || b.value === "," || b.value === "}")
    )
      return true;
    return false;
  }
  private parsePack(path: AstNode): AstNode {
    const ln = path.line;
    this.expect("{");
    const fields: AstNode[] = [];
    while (!this.is("}") && !this.atEnd()) {
      const fn = this.ident();
      let val: AstNode = null;
      if (this.eat(":")) val = this.parseExpr();
      fields.push({ name: fn, value: val });
      if (!this.eat(",")) break;
    }
    this.expect("}");
    return { kind: "Pack", path, fields, line: ln };
  }
  private parsePrimary(): AstNode {
    const k = this.peek();
    const ln = k.line;
    if (k.type === "num") {
      this.next();
      return { kind: "Num", value: k.value, line: ln };
    }
    if (k.type === "str") {
      this.next();
      return { kind: "Str", value: k.value, line: ln };
    }
    if (this.isKw("true") || this.isKw("false")) {
      this.next();
      return { kind: "Bool", value: k.value === "true", line: ln };
    }
    if (this.is("@")) {
      this.next();
      const av = this.peek().value;
      this.next();
      return { kind: "AddressLit", value: av, line: ln };
    }
    if (this.is("(")) {
      this.next();
      if (this.is(")")) {
        this.next();
        return { kind: "Unit", line: ln };
      }
      const e = this.parseExpr();
      if (this.is(",")) {
        const elems = [e];
        while (this.eat(",")) {
          if (this.is(")")) break;
          elems.push(this.parseExpr());
        }
        this.expect(")");
        return { kind: "Tuple", elems, line: ln };
      }
      if (this.isKw("as")) {
        this.next();
        const ty = this.parseType();
        this.expect(")");
        return { kind: "Cast", expr: e, type: ty, line: ln };
      }
      this.expect(")");
      return { kind: "Paren", expr: e, line: ln };
    }
    if (this.is("{")) return this.parseBlock();
    if (this.isKw("if")) {
      this.next();
      let c: AstNode;
      if (this.eat("(")) {
        c = this.parseExpr();
        this.expect(")");
      } else c = this.parseUnary();
      const th = this.parseExpr();
      let el: AstNode = null;
      if (this.isKw("else")) {
        this.next();
        el = this.parseExpr();
      }
      return { kind: "If", cond: c, conseq: th, else: el, line: ln };
    }
    if (this.isKw("while")) {
      this.next();
      let wc: AstNode;
      if (this.eat("(")) {
        wc = this.parseExpr();
        this.expect(")");
      } else wc = this.parseUnary();
      const wb = this.parseExpr();
      return { kind: "While", cond: wc, body: wb, line: ln };
    }
    if (this.isKw("loop")) {
      this.next();
      return { kind: "Loop", body: this.parseExpr(), line: ln };
    }
    if (this.isKw("abort")) {
      this.next();
      const xe =
        this.is(";") || this.is("}") || this.is(")") ? null : this.parseExpr();
      return { kind: "Abort", expr: xe, line: ln };
    }
    if (this.isKw("return")) {
      this.next();
      const rr =
        this.is(";") || this.is("}") || this.is(")") ? null : this.parseExpr();
      return { kind: "Return", expr: rr, line: ln };
    }
    if (this.isKw("break") || this.isKw("continue")) {
      this.next();
      return { kind: "Break", line: ln };
    }
    if (
      k.type === "ident" &&
      k.value === "vector" &&
      this.peek(1) &&
      this.peek(1).type === "punct" &&
      this.peek(1).value === "["
    ) {
      this.next();
      this.next();
      const vs: AstNode[] = [];
      while (!this.is("]") && !this.atEnd()) {
        vs.push(this.parseExpr());
        if (!this.eat(",")) break;
      }
      this.expect("]");
      return { kind: "VectorLit", elems: vs, line: ln };
    }
    if (k.type === "ident" || k.type === "kw") {
      const parts = [this.ident()];
      while (this.eat("::")) parts.push(this.ident());
      if (this.is("!")) {
        this.next();
        let margs: AstNode[] = [];
        if (this.is("(")) margs = this.parseArgs();
        else if (this.is("{")) this.skipBalanced("{", "}");
        else if (this.is("[")) this.skipBalanced("[", "]");
        return { kind: "Macro", name: parts.join("::"), args: margs, line: ln };
      }
      return parts.length === 1
        ? { kind: "Name", name: parts[0], line: ln }
        : { kind: "Path", parts, line: ln };
    }
    this.err("unexpected expression");
  }
}

interface MoveParseResult {
  ok: boolean;
  modules?: AstNode[];
  error?: string;
}

/** Parse a Move source string to an AST, or report why it could not. */
export function parseMove(src: string): MoveParseResult {
  try {
    const toks = tokenize(src);
    const p = new Parser(toks);
    const mods = p.parseFile();
    return { ok: true, modules: mods };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* =============================== analysis =============================== */

const INT = new Set(["u8", "u16", "u32", "u64", "u128", "u256"]);
const AMOUNTY =
  /^(amount|amt|value|val|balance|bal|sum|price|salary|wage|payout|fee)$/i;
const KEYNAME = /^(dk|decryption_key|secret_key|sk|viewing_key)$/i;

function calleeName(call: AstNode): string {
  const c = call.callee;
  if (!c) return call.method || "";
  if (c.kind === "Name") return c.name;
  if (c.kind === "Path") return c.parts.join("::");
  if (c.kind === "Field") return c.name; // method call
  return "";
}
function lastComp(name: string): string {
  const i = name.lastIndexOf("::");
  return i < 0 ? name : name.slice(i + 2);
}

const isEmit = (nm: string): boolean => /(^|::)emit(_event)?$/.test(nm);
const isHash = (nm: string): boolean =>
  /(sha3_256|sha2_256|keccak256|blake2b_256|blake2b|(^|::)hash::)/.test(nm) ||
  /_hash$/.test(nm);
const isBcs = (nm: string): boolean =>
  /(^|::)to_bytes$/.test(nm) || /bcs::/.test(nm);
const caTransfer = (nm: string): boolean =>
  /confidential_transfer(_from)?/.test(nm) ||
  /confidential_asset::transfer$/.test(nm);
const caWithdraw = (nm: string): boolean =>
  /confidential_asset::withdraw/.test(nm) ||
  /^withdraw(_to)?$/.test(lastComp(nm));
const caDeposit = (nm: string): boolean =>
  /confidential_asset::deposit/.test(nm) || /^deposit$/.test(lastComp(nm));
const caRollover = (nm: string): boolean =>
  /rollover(_pending_balance)?/.test(nm);
const isMutator = (nm: string): boolean =>
  /borrow_global_mut|(^|::)emit(_event)?$|transfer::|(^|::)(push_back|pop_back|swap_remove|append)$|(table|object_table)::(add|remove|borrow_mut)|dynamic_field::(add|remove|borrow_mut)|object::delete|_mut$/.test(
    nm,
  );

interface Taint {
  amount: boolean;
  key: boolean;
  id: boolean;
  committed: boolean;
}
function tor(a: Taint | null, b: Taint | null): Taint | null {
  if (!a) return b;
  if (!b) return a;
  return {
    amount: a.amount || b.amount,
    key: a.key || b.key,
    id: a.id || b.id,
    committed: !!a.committed && !!b.committed,
  };
}

function each(node: AstNode, fn: (n: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const kk in node) {
    if (!Object.hasOwn(node, kk)) continue;
    const v = node[kk];
    if (Array.isArray(v)) {
      for (const x of v) each(x, fn);
    } else if (v && typeof v === "object" && v.kind) each(v, fn);
  }
}

function frameworkOf(
  modules: AstNode[],
  chain?: "sui" | "aptos",
): "seal" | "aptos-ca" | "move" {
  if (chain === "sui") return "seal";
  if (chain === "aptos") return "aptos-ca";
  let seal = false;
  let ca = false;
  for (const m of modules) {
    for (const it of m.items) {
      if (it.kind === "Fun" && /^seal_approve/.test(it.name)) seal = true;
    }
    each(m, (nd: AstNode) => {
      if (
        nd.kind === "Path" &&
        /confidential_(asset|balance|transfer|coin)/.test(nd.parts.join("::"))
      )
        ca = true;
      if (nd.kind === "Call") {
        const nm = calleeName(nd);
        if (
          /confidential_(asset|balance|transfer|coin)|rollover_pending_balance/.test(
            nm,
          )
        )
          ca = true;
      }
    });
  }
  return seal ? "seal" : ca ? "aptos-ca" : "move";
}

function vis(mods: AstNode): string {
  return mods.entry
    ? "entry"
    : mods.pub
      ? mods.pubKind
        ? `public(${mods.pubKind})`
        : "public"
      : "private";
}

function dedupe(fs: ConfidentialityFinding[]): ConfidentialityFinding[] {
  const seen: Record<string, number> = {};
  const out: ConfidentialityFinding[] = [];
  for (const f of fs) {
    const k = `${f.id}|${f.loc}|${f.title}`;
    if (!seen[k]) {
      seen[k] = 1;
      out.push(f);
    }
  }
  return out;
}
function tally(fs: ConfidentialityFinding[]): {
  high: number;
  medium: number;
  low: number;
  info: number;
} {
  return {
    high: fs.filter((x) => x.sev === "high").length,
    medium: fs.filter((x) => x.sev === "medium").length,
    low: fs.filter((x) => x.sev === "low").length,
    info: fs.filter((x) => x.sev === "info").length,
  };
}
function astAssume(fw: string): string[] {
  const base = [
    "Parsed to a Move AST with a recursive-descent parser and analyzed over the tree: reachability is interprocedural (calls are followed) and information flow is type-aware. The lexical scan remains as a fallback for sources this parser does not yet cover.",
  ];
  if (fw === "seal")
    base.push(
      "Models the Seal access-control model: a `seal_approve` policy grants the key when it completes and denies when it aborts. It must be `entry`, take `id: vector<u8>` first, and be side-effect free — checks that now follow calls into helpers.",
      "Reachability also depends on package upgradeability — an upgradeable package's authority can replace this policy. Confirm the package is immutable or that upgrades are controlled.",
      "Decryption is client-side; Seal plaintext never touches the chain. This engine reasons about who the policy admits, not off-chain key handling.",
    );
  else if (fw === "aptos-ca")
    base.push(
      "Models Aptos Confidential Assets: balances and transfer amounts are encrypted (Twisted ElGamal + ZK); addresses and the fact of a transfer are public — confidentiality, not anonymity.",
      "A plaintext integer amount reaching an event or a public return is a disclosure; an already-encrypted `vector<u8>` ciphertext, or a hash commitment of the amount, is not.",
      "`deposit` and `withdraw` reveal amounts by design; an in-domain `confidential_transfer` hides the amount, which is also encrypted to the account's configured auditor viewing key when one is set.",
    );
  else
    base.push(
      "No confidential framework (Seal or Aptos Confidential Assets) was detected in this source.",
    );
  return base;
}

/* ----------------------------- CA analysis ----------------------------- */

function analyzeCA(modules: AstNode[], src: string): ConfidentialityResult {
  let findings: ConfidentialityFinding[] = [];
  const surface: ConfidentialityExposure[] = [];
  let usesDeposit = false;
  let usesWithdraw = false;
  const auditor = /auditor|set_auditor|auditor_ek|global_auditor/i.test(src);
  let leakedEvt = false;
  let leakedKey = false;
  let retLeak = false;
  const allFns: AstNode[] = [];
  for (const m of modules)
    for (const it of m.items) if (it.kind === "Fun") allFns.push(it);

  const caFns = allFns.filter((f: AstNode) => {
    let hit = false;
    if (f.body)
      each(f.body, (nd: AstNode) => {
        if (
          nd.kind === "Call" &&
          /confidential_(asset|balance|transfer|coin)|rollover/.test(
            calleeName(nd),
          )
        )
          hit = true;
      });
    return hit;
  });

  for (const f of caFns) {
    const env = new Map<string, Taint>();
    for (const p of f.params) {
      if (
        KEYNAME.test(p.name) ||
        /^(DecryptionKey|SecretKey)$/.test(p.type.base)
      )
        env.set(p.name, {
          amount: false,
          key: true,
          id: false,
          committed: false,
        });
      else if (INT.has(p.type.base) && AMOUNTY.test(p.name))
        env.set(p.name, {
          amount: true,
          key: false,
          id: false,
          committed: false,
        });
    }
    const hasSigner = f.params.some((p: AstNode) => p.type.base === "signer");
    const ctx = { stateChange: false, boundary: false };

    const assignTo = (target: AstNode, t: Taint | null): void => {
      if (target && target.kind === "Name") {
        if (t) env.set(target.name, t);
        else env.delete(target.name);
      }
    };
    const sinkDisclose = (t: Taint | null, line: number): void => {
      if (!t) return;
      if (t.key) {
        leakedKey = true;
        findings.push({
          id: "CA-DK",
          sev: "high",
          loc: line,
          title: "Decryption key exposed",
          detail: `\`${f.name}\` emits a decryption key. Anyone holding the decryption key can read every amount encrypted to that account — it must never be returned, emitted, stored on-chain, or handed to untrusted code.`,
          fix: "Keep decryption keys client-side; only ciphertexts and zero-knowledge proofs belong on-chain.",
        });
      } else if (t.amount && !t.committed) {
        leakedEvt = true;
        findings.push({
          id: "CA-EVENT",
          sev: "medium",
          loc: line,
          title: "Confidential amount emitted in an event",
          detail: `\`${f.name}\` emits an event whose value is derived from a confidential amount. Confidential Assets keep the amount encrypted on-chain, but an event field is plaintext to everyone who can read the transaction — putting the amount back in the open.`,
          fix: "Emit only non-amount metadata (addresses, an opaque id), or a hash commitment. Never place a plaintext confidential amount in an event.",
        });
      }
    };
    const handleReturn = (t: Taint | null, line: number): void => {
      if (!t) return;
      if (t.key) {
        leakedKey = true;
        findings.push({
          id: "CA-DK",
          sev: "high",
          loc: line,
          title: "Decryption key returned",
          detail: `\`${f.name}\` returns a decryption key from a ${vis(f.mods)} function, exposing every amount on the account.`,
          fix: "Never return a decryption key across a public boundary; keep it client-side.",
        });
      } else if (t.amount && !t.committed && (f.mods.pub || f.mods.entry)) {
        retLeak = true;
        findings.push({
          id: "CA-RETURN",
          sev: "medium",
          loc: line,
          title: "Confidential amount returned",
          detail: `\`${f.name}\` returns a plaintext confidential amount to its caller. A ${vis(f.mods)} function that returns the amount discloses it as surely as an event does.`,
          fix: "Return a ciphertext or a commitment, gate the reader, or keep the amount inside the confidential domain.",
        });
      }
    };

    const visit = (e: AstNode): Taint | null => {
      if (!e) return null;
      switch (e.kind) {
        case "Num":
        case "Bool":
        case "Str":
        case "AddressLit":
        case "Unit":
          return null;
        case "Name":
          return env.get(e.name) || null;
        case "Path":
          return null;
        case "Field":
          return visit(e.obj);
        case "Borrow":
          return visit(e.expr);
        case "Deref":
          return visit(e.expr);
        case "CopyMove":
          return visit(e.expr);
        case "Cast":
          return visit(e.expr);
        case "Paren":
          return visit(e.expr);
        case "Unary":
          return visit(e.expr);
        case "Binary":
          return tor(visit(e.left), visit(e.right));
        case "Assign": {
          const tv = visit(e.value);
          assignTo(e.target, tv);
          return null;
        }
        case "Tuple": {
          let r: Taint | null = null;
          for (const x of e.elems) r = tor(r, visit(x));
          return r;
        }
        case "VectorLit": {
          let r2: Taint | null = null;
          for (const x of e.elems) r2 = tor(r2, visit(x));
          return r2;
        }
        case "Pack": {
          let r3: Taint | null = null;
          for (const fld of e.fields)
            r3 = tor(
              r3,
              fld.value ? visit(fld.value) : env.get(fld.name) || null,
            );
          return r3;
        }
        case "Block":
          return visitBlock(e);
        case "If": {
          visit(e.cond);
          return tor(visit(e.conseq), e.else ? visit(e.else) : null);
        }
        case "While": {
          visit(e.cond);
          visit(e.body);
          return null;
        }
        case "Loop": {
          visit(e.body);
          return null;
        }
        case "Return": {
          const rt = visit(e.expr);
          handleReturn(rt, e.line);
          return null;
        }
        case "Abort": {
          visit(e.expr);
          return null;
        }
        case "Macro": {
          for (const a of e.args) visit(a);
          return null;
        }
        case "Call":
          return visitCall(e);
        default:
          return null;
      }
    };
    const visitBlock = (b: AstNode): Taint | null => {
      for (const s of b.stmts) visitStmt(s);
      return b.tail ? visit(b.tail) : null;
    };
    const visitStmt = (s: AstNode): void => {
      if (s.kind === "Let") {
        const t = visit(s.init);
        if (s.names.length === 1) {
          if (t) env.set(s.names[0], t);
          else env.delete(s.names[0]);
        } else for (const nm of s.names) if (t) env.set(nm, t);
      } else if (s.kind === "ExprStmt") visit(s.expr);
      else if (s.kind === "Return") {
        const rt = visit(s.expr);
        handleReturn(rt, s.line);
      } else if (s.kind === "Abort") visit(s.expr);
    };
    const visitCall = (e: AstNode): Taint | null => {
      const nm = calleeName(e);
      if (isHash(nm)) {
        let ta: Taint | null = null;
        for (const a of e.args) ta = tor(ta, visit(a));
        if (ta)
          return { amount: ta.amount, key: ta.key, id: ta.id, committed: true };
        return null;
      }
      if (isBcs(nm)) {
        let tb: Taint | null = null;
        for (const a of e.args) tb = tor(tb, visit(a));
        return tb;
      }
      if (isEmit(nm)) {
        let te: Taint | null = null;
        for (const a of e.args) te = tor(te, visit(a));
        sinkDisclose(te, e.line);
        return null;
      }
      if (caTransfer(nm) || caWithdraw(nm) || caDeposit(nm) || caRollover(nm)) {
        ctx.stateChange = true;
        if (caDeposit(nm)) usesDeposit = true;
        if (caWithdraw(nm)) usesWithdraw = true;
        for (const a of e.args) visit(a);
        return null;
      }
      for (const a of e.args) visit(a);
      if (e.recv) visit(e.recv);
      return null;
    };

    if (f.body) {
      const bodyTail = visitBlock(f.body);
      if (f.body.tail) handleReturn(bodyTail, f.body.tail.line);
    }

    if (ctx.stateChange && !hasSigner)
      findings.push({
        id: "CA-AUTH",
        sev: "high",
        loc: f.line,
        title: "Confidential operation without an authorizing signer",
        detail: `\`${f.name}\` moves a confidential balance but takes no \`&signer\` and checks no caller. A confidential-asset transfer or withdraw must be authorized by the account that owns the balance.`,
        fix: "Take `sender: &signer` and bind the operation to `signer::address_of(sender)`; assert any additional policy.",
      });

    const reveals: string[] = [];
    const emittedAmt = findings.some(
      (x) => x.id === "CA-EVENT" && x.loc >= f.line,
    );
    if (emittedAmt) reveals.push("amount — LEAKED via event");
    if (findings.some((x) => x.id === "CA-RETURN"))
      reveals.push("amount — returned");
    let transfers = false;
    if (f.body)
      each(f.body, (nd: AstNode) => {
        if (nd.kind === "Call" && caTransfer(calleeName(nd))) transfers = true;
      });
    if (transfers && !reveals.length)
      reveals.push("amount — encrypted to recipient + auditor");
    if ((usesDeposit || usesWithdraw) && !reveals.length)
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

  findings = dedupe(findings);
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
  const leaked: string[] = [];
  if (leakedEvt)
    leaked.push(
      "The amount — via an event, to everyone who can read the transaction.",
    );
  if (retLeak)
    leaked.push("The amount — returned to the caller of a public function.");
  if (leakedKey)
    leaked.push(
      "A decryption key — whoever holds it can read every amount on the account.",
    );

  return {
    ok: true,
    framework: "aptos-ca",
    engine: "ast",
    module: "",
    summary: {
      functions: allFns.length,
      entryFns: allFns.filter((f: AstNode) => f.mods.entry).length,
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
    assumptions: astAssume("aptos-ca"),
  };
}

/* ---------------------------- Seal analysis ---------------------------- */

// id-taint seed for a policy: the first parameter is the identity
function idSeed(f: AstNode): Set<string> {
  const s = new Set<string>();
  if (f.params[0]) s.add(f.params[0].name);
  return s;
}

interface SealScan {
  gate: boolean;
  lockedFirst: boolean;
  lockedFalse: boolean;
  idInGate: boolean;
  effect: boolean;
  effectVia: string;
}

// Interprocedural scan of a Seal policy (or a helper it calls).
function sealScan(
  fn: AstNode,
  idNames: Set<string>,
  funMap: Map<string, AstNode>,
  depth: number,
  visited: Set<AstNode>,
): SealScan {
  const out: SealScan = {
    gate: false,
    lockedFirst: false,
    lockedFalse: false,
    idInGate: false,
    effect: false,
    effectVia: "",
  };
  if (!fn.body || depth > 6 || visited.has(fn)) return out;
  visited.add(fn);
  const env = new Map<string, boolean>();
  for (const nm of idNames) env.set(nm, true); // name -> id-tainted

  const idTainted = (e: AstNode): boolean => {
    if (!e) return false;
    switch (e.kind) {
      case "Name":
        return !!env.get(e.name);
      case "Borrow":
      case "Deref":
      case "CopyMove":
      case "Paren":
      case "Cast":
      case "Unary":
        return idTainted(e.expr);
      case "Field":
        return idTainted(e.obj);
      case "Binary":
        return idTainted(e.left) || idTainted(e.right);
      case "Call":
        return e.args.some(idTainted) || (e.recv ? idTainted(e.recv) : false);
      case "Macro":
        return e.args.some(idTainted);
      default:
        return false;
    }
  };

  let first = true;
  const condStack: boolean[] = [];
  const walk = (node: AstNode, inCond: boolean): void => {
    if (!node || typeof node !== "object" || !node.kind) return;
    switch (node.kind) {
      case "Macro":
        if (node.name === "assert" || /(^|::)assert$/.test(node.name)) {
          const a0 = node.args[0];
          const isTrue = a0 && a0.kind === "Bool" && a0.value === true;
          const isFalse = a0 && a0.kind === "Bool" && a0.value === false;
          if (!isTrue) {
            out.gate = true;
            if (isFalse && first) out.lockedFalse = true;
            if (a0 && idTainted(a0)) out.idInGate = true;
          }
        }
        for (const x of node.args) walk(x, inCond);
        return;
      case "Abort":
        out.gate = true;
        if (first && condStack.length === 0) out.lockedFirst = true;
        if (condStack.length && condStack[condStack.length - 1])
          out.idInGate = true;
        if (node.expr) walk(node.expr, inCond);
        return;
      case "Call": {
        const nm = calleeName(node);
        if (isMutator(nm)) {
          out.effect = true;
          if (!out.effectVia) out.effectVia = lastComp(nm);
        }
        const callee =
          node.callee && node.callee.kind === "Name"
            ? funMap.get(node.callee.name)
            : null;
        if (callee && callee !== fn) {
          const seeds = new Set<string>();
          (node.args || []).forEach((arg: AstNode, i: number) => {
            if (idTainted(arg) && callee.params[i])
              seeds.add(callee.params[i].name);
          });
          const sub = sealScan(callee, seeds, funMap, depth + 1, visited);
          if (sub.gate) out.gate = true;
          if (sub.effect) {
            out.effect = true;
            if (!out.effectVia) out.effectVia = sub.effectVia || lastComp(nm);
          }
          if (sub.idInGate) out.idInGate = true;
        }
        for (const x of node.args || []) walk(x, inCond);
        if (node.recv) walk(node.recv, inCond);
        return;
      }
      case "Assign":
        out.effect = true;
        if (!out.effectVia) out.effectVia = "assignment";
        walk(node.value, inCond);
        return;
      case "Let":
        walk(node.init, inCond);
        if (node.names.length === 1)
          env.set(node.names[0], node.init ? idTainted(node.init) : false);
        return;
      case "If":
        walk(node.cond, true);
        condStack.push(idTainted(node.cond));
        walkExprOrBlock(node.conseq);
        if (node.else) walkExprOrBlock(node.else);
        condStack.pop();
        return;
      case "While":
        walk(node.cond, true);
        condStack.push(idTainted(node.cond));
        walkExprOrBlock(node.body);
        condStack.pop();
        return;
      case "Loop":
        walkExprOrBlock(node.body);
        return;
      case "Block":
        walkBlock(node);
        return;
      case "Return":
        if (node.expr) walk(node.expr, inCond);
        return;
      default:
        for (const kk in node) {
          if (!Object.hasOwn(node, kk)) continue;
          const v = node[kk];
          if (Array.isArray(v)) for (const x of v) walk(x, inCond);
          else if (v && typeof v === "object" && v.kind) walk(v, inCond);
        }
        return;
    }
  };
  const walkExprOrBlock = (nd: AstNode): void => {
    if (nd && nd.kind === "Block") walkBlock(nd);
    else walk(nd, false);
  };
  const walkBlock = (b: AstNode): void => {
    for (const s of b.stmts) {
      walk(s, false);
      first = false;
    }
    if (b.tail) {
      walk(b.tail, false);
      first = false;
    }
  };

  walkBlock(fn.body);
  return out;
}

function analyzeSeal(modules: AstNode[], _src: string): ConfidentialityResult {
  let findings: ConfidentialityFinding[] = [];
  const surface: ConfidentialityExposure[] = [];
  let openCount = 0;
  let sfxAny = false;
  const funMap = new Map<string, AstNode>();
  const allFns: AstNode[] = [];
  for (const m of modules)
    for (const it of m.items)
      if (it.kind === "Fun") {
        allFns.push(it);
        funMap.set(it.name, it);
      }
  const policies = allFns.filter((f: AstNode) => /^seal_approve/.test(f.name));

  for (const f of policies) {
    const r = sealScan(f, idSeed(f), funMap, 0, new Set<AstNode>());
    let policy: string;
    let reach: string;
    const locked = r.lockedFirst || r.lockedFalse;
    if (locked) {
      policy = "locked";
      reach = "nobody";
    } else if (!r.gate) {
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
        fix: `Declare it \`entry fun ${f.name}(...)\` — non-\`public entry\` is preferred so it is reachable only as a policy.`,
      });
    const p0 = f.params[0];
    const idOk =
      p0 &&
      p0.type.base === "vector" &&
      p0.type.args[0] &&
      p0.type.args[0].base === "u8";
    if (!idOk)
      findings.push({
        id: "SEAL-ID",
        sev: "medium",
        loc: f.line,
        title: "Identity parameter missing or misplaced",
        detail: `A \`seal_approve\` policy must take the requested identity, \`id: vector<u8>\`, as its first parameter${p0 ? ` — here the first parameter is \`${p0.name}: ${p0.type.text}\`.` : "."}`,
        fix: "Make the first parameter `id: vector<u8>` and derive access from it.",
      });
    if (r.effect) {
      sfxAny = true;
      findings.push({
        id: "SEAL-SFX",
        sev: "medium",
        loc: f.line,
        title: "Policy is not side-effect free",
        detail: `A policy is dry-run by the key servers and must not change state. \`${f.name}\`${r.effectVia ? ` reaches a state change via \`${r.effectVia}\`` : " mutates state, emits, or transfers"}.`,
        fix: "A policy only reads and asserts — remove all state changes (including from any helper it calls).",
      });
    }
    if (policy === "open")
      findings.push({
        id: "SEAL-OPEN",
        sev: "high",
        loc: f.line,
        title: "Open policy — any caller can decrypt",
        detail: `\`${f.name}\` has no reachable \`assert!\` or \`abort\` (following the calls it makes), so it completes for every caller. Seal reads a completed policy as “access granted”: any address can obtain the decryption key for data sealed to this identity, so the ciphertext is effectively public.`,
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
      .some(
        (p: AstNode) =>
          p.type.ref || /[A-Z]/.test(p.type.base) || p.type.path.length > 1,
      );
    if (policy === "restricted" && objParam && !r.idInGate)
      findings.push({
        id: "SEAL-BIND",
        sev: "low",
        loc: f.line,
        title: "Policy may not be bound to the requested identity",
        detail: `\`${f.name}\` gates on its object arguments but \`id\` never reaches the gating condition. If the object passed is not tied to \`id\`, a caller could satisfy the policy for one identity while requesting the key for another.`,
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

  for (const f of allFns.filter(
    (f: AstNode) =>
      !/^seal_approve/.test(f.name) && (f.mods.entry || f.mods.pub),
  )) {
    surface.push({
      fn: `${f.name}()`,
      vis: vis(f.mods),
      policy: "n/a",
      reach: "callers",
      reveals: "not a policy",
    });
  }

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

  findings = dedupe(findings);
  const sev = tally(findings);
  const leaked: string[] = [];
  if (openCount)
    leaked.push(
      "The decryption key — to ANY caller. Data sealed to this identity is effectively public.",
    );
  if (sfxAny)
    leaked.push(
      "A policy with side effects can be replayed by the key servers; its state changes are attacker-triggerable.",
    );

  return {
    ok: true,
    framework: "seal",
    engine: "ast",
    module: "",
    summary: {
      functions: allFns.length,
      entryFns: allFns.filter((f: AstNode) => f.mods.entry).length,
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
    assumptions: astAssume("seal"),
  };
}

/* ------------------------------ generic ------------------------------- */

function analyzeGeneric(modules: AstNode[]): ConfidentialityResult {
  const allFns: AstNode[] = [];
  for (const m of modules)
    for (const it of m.items) if (it.kind === "Fun") allFns.push(it);
  return {
    ok: true,
    framework: "move",
    engine: "ast",
    module: "",
    summary: {
      functions: allFns.length,
      entryFns: allFns.filter((f: AstNode) => f.mods.entry).length,
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
          "This source parses as Move but references neither a Seal `seal_approve` policy nor Aptos Confidential Assets, so there is no confidential state for this engine to trace. Paste a Seal policy module or a Confidential-Assets module — or load an example scenario below.",
        fix: "",
      },
    ],
    surface: allFns
      .filter((f: AstNode) => f.mods.entry || f.mods.pub)
      .map((f: AstNode) => ({
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
    assumptions: astAssume("move"),
  };
}

/**
 * Analyze a Move source string with the AST front-end. Returns a
 * {@link ConfidentialityAnalysis}; on a parse failure the result carries
 * `parseFailed: true` so the umbrella analyzer can fall back to the lexical
 * engine. Pass `options.chain` to force the framework.
 */
export function analyzeConfidentialityAst(
  srcRaw: string,
  options: ConfidentialityOptions = {},
): ConfidentialityAnalysis {
  const src = String(srcRaw || "");
  if (!src.trim())
    return {
      ok: false,
      error: "Paste some Move source, or load an example scenario below.",
    };
  const parsed = parseMove(src);
  if (!parsed.ok || !parsed.modules || !parsed.modules.length)
    return {
      ok: false,
      error: parsed.error || "no module found",
      parseFailed: true,
    };
  const fw = frameworkOf(parsed.modules, options.chain);
  const res =
    fw === "seal"
      ? analyzeSeal(parsed.modules, src)
      : fw === "aptos-ca"
        ? analyzeCA(parsed.modules, src)
        : analyzeGeneric(parsed.modules);
  const m0 = parsed.modules[0];
  res.module = m0 ? `${m0.addr ? `${m0.addr}::` : ""}${m0.name}` : "";
  return res;
}
