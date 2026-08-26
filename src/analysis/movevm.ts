/**
 * TypeScript library for static analysis of Move VM transactions on
 * account-model chains — Aptos and Movement.
 *
 * Aptos and Movement share the Move VM and an Aptos-compatible REST API, so a
 * single analyzer serves both; only presentational parameters (the native coin
 * symbol and its decimal precision) differ, and those are supplied by the
 * caller. Unlike Sui, these chains follow the original Move account/global
 * storage model: a transaction carries one payload — most commonly a single
 * entry-function call, sometimes a Move script (the multi-call analog of a
 * Sui PTB), or a multisig wrapper — rather than a chained sequence of commands
 * whose results feed one another. There is therefore no result-to-result
 * dataflow DAG to reconstruct; forcing one would misrepresent the model.
 *
 * What this analyzer surfaces instead are the facts that the account model does
 * expose and that a reader needs in order to see "what a transaction actually
 * does": the decoded payload, the gas profile, the emitted events, the
 * balance movements those events imply, and the write-set (which resources and
 * modules changed, under which accounts). Each analysis is derived from a
 * single transaction object exactly as returned by the Aptos REST API
 * (`GET /transactions/by_hash/{hash}`) or its simulation endpoint
 * (`POST /transactions/simulate`, whose result is one such object).
 *
 * As with the PTB analyzer, every function here is deterministic,
 * dependency-free, and side-effect-free: it accepts a plain transaction object
 * and returns a plain data structure. No network access or signing is
 * performed.
 */

import {
  getField as _get,
  isSimpleObject as _isObject,
  toNumber as _toNumber,
  toStringOrNull as _toStringOrNull,
} from "../common";

/**
 * Enumeration of the payload categories an Aptos/Movement user transaction can
 * carry. Entry-function payloads name a single `module::function` to invoke;
 * script payloads carry compiled Move bytecode that may perform several calls;
 * multisig payloads wrap an inner entry-function payload approved by a multisig
 * account. Any payload whose category cannot be determined is represented as
 * `Unknown` so that analysis can proceed without loss.
 */
export enum MovePayloadKind {
  EntryFunction = "entry_function",
  Script = "script",
  Multisig = "multisig",
  ModuleBundle = "module_bundle",
  Unknown = "unknown",
}

/**
 * Enumeration of the write-set change categories recognized by the analyzer.
 * These correspond to the `type` discriminant of the entries in a
 * transaction's `changes` array.
 */
export enum MoveChangeKind {
  WriteResource = "write_resource",
  DeleteResource = "delete_resource",
  WriteModule = "write_module",
  DeleteModule = "delete_module",
  WriteTableItem = "write_table_item",
  DeleteTableItem = "delete_table_item",
  Unknown = "unknown",
}

/**
 * The direction of a balance movement relative to an account: `Out` for a
 * withdrawal (value leaving the account) and `In` for a deposit (value
 * arriving).
 */
export enum BalanceDirection {
  In = "in",
  Out = "out",
}

/**
 * A fully-qualified Move function identifier, split into its constituent parts
 * for display and grouping. `full` is the canonical `address::module::name`
 * rendering.
 */
export interface MoveFunctionId {
  address: string;
  module: string;
  name: string;
  full: string;
}

/**
 * The decoded detail of a transaction's payload. Which fields are populated
 * depends on the payload kind: `function` and `arguments` for entry-function
 * and multisig payloads; `multisigAddress` for multisig payloads; and
 * `scriptByteSize` for script payloads. `arguments` echoes the transaction's
 * argument values (truncated to a bounded number so the structure stays small);
 * `argumentCount` always reflects the true count.
 */
export interface MovePayloadDetail {
  kind: MovePayloadKind;
  function: MoveFunctionId | null;
  typeArguments: string[];
  argumentCount: number;
  arguments: unknown[];
  multisigAddress?: string;
  scriptByteSize?: number | null;
}

/**
 * A single kind of emitted event together with the number of occurrences of
 * that kind. `module` is the `address::module` the event type belongs to, or
 * `null` when the type string cannot be parsed.
 */
export interface MoveEventSummary {
  type: string;
  module: string | null;
  count: number;
}

/**
 * One balance movement implied by an emitted event: a magnitude, its direction
 * relative to `account`, and the best available identifier of the asset that
 * moved. `symbol` is populated only when the asset's ticker can be determined
 * from the event; otherwise it is `null` and `asset` carries the raw
 * type or store identifier. `amount` is a decimal string, since token amounts
 * can exceed the range of a double-precision number.
 */
export interface MoveBalanceChange {
  account: string;
  asset: string;
  symbol: string | null;
  amount: string;
  direction: BalanceDirection;
}

/**
 * A single write-set change: its category, the account it applies to, and —
 * where applicable — the resource type or module it concerns.
 */
export interface MoveChangeRecord {
  kind: MoveChangeKind;
  address: string;
  resource: string | null;
  module: string | null;
}

/**
 * The write-set accounting for a transaction: the individual change records,
 * the distinct resource types written, the modules published, per-category
 * counts, and the distinct accounts whose state changed.
 */
export interface MoveWriteset {
  changes: MoveChangeRecord[];
  resourceTypes: string[];
  modulesPublished: string[];
  counts: Partial<Record<MoveChangeKind, number>>;
  accountsWritten: string[];
}

/**
 * Gas attribution for a Move VM transaction. Aptos-model chains price gas as a
 * number of gas units multiplied by a per-unit price quoted in the coin's
 * smallest denomination (Octas on Aptos; the equivalent subunit on Movement).
 * `totalSubunits` is the product `gasUsed * gasUnitPrice`. `symbol` and
 * `decimals` describe the native coin so the figure can be rendered.
 */
export interface MoveGas {
  gasUsed: number;
  gasUnitPrice: number;
  totalSubunits: number;
  maxGasAmount: number | null;
  symbol: string;
  decimals: number;
}

/**
 * A high-level summary of an analyzed transaction, suitable for display as a
 * compact set of headline figures.
 */
export interface MoveSummary {
  chain: string;
  network: string | null;
  txType: string;
  payloadKind: MovePayloadKind;
  functionId: string | null;
  typeArgCount: number;
  argumentCount: number;
  eventCount: number;
  changeCount: number;
  accountsTouched: number;
  packagesTouched: number;
  success: boolean;
  vmStatus: string;
}

/**
 * The complete result of analyzing a Move VM transaction: the headline
 * summary, the decoded payload, the gas attribution, the event and
 * balance-movement digests, the write-set accounting, and the distinct sets of
 * packages and accounts the transaction touches.
 */
export interface MoveAnalysis {
  summary: MoveSummary;
  payload: MovePayloadDetail;
  gas: MoveGas;
  events: MoveEventSummary[];
  balanceChanges: MoveBalanceChange[];
  writeset: MoveWriteset;
  packages: string[];
  accounts: string[];
  sender: string | null;
  hash: string | null;
  timestampMicros: string | null;
}

/**
 * Presentational parameters supplied by the caller. `chain` and `network` are
 * carried through to the summary for display; `symbol` and `decimals` describe
 * the native coin used for gas (defaulting to Aptos's APT at eight decimals,
 * which Movement's MOVE also uses).
 */
export interface MoveAnalyzeOptions {
  chain?: string;
  network?: string | null;
  symbol?: string;
  decimals?: number;
}

/**
 * A Move VM transaction in the shape the analyzer consumes. The fields mirror
 * the Aptos REST representation of a user transaction; every field is optional
 * and typed loosely because the analyzer tolerates the minor shape differences
 * between the by-hash, by-version, and simulation responses.
 */
export interface MoveTransaction {
  type?: string;
  hash?: string;
  sender?: string;
  sequence_number?: string;
  max_gas_amount?: string;
  gas_unit_price?: string;
  gas_used?: string;
  success?: boolean;
  vm_status?: string;
  timestamp?: string;
  payload?: unknown;
  events?: unknown[];
  changes?: unknown[];
  [key: string]: unknown;
}

/** Default number of decimals for the native coin (APT and MOVE both use 8). */
const _DEFAULT_DECIMALS = 8;

/** Maximum number of argument values echoed into a decoded payload. */
const _MAX_ECHOED_ARGS = 16;

/**
 * Parse a fully-qualified function identifier of the form
 * `0xADDR::module::name` into its parts. Returns `null` when the string is
 * absent or does not contain the two required separators.
 */
function _parseFunctionId(value: unknown): MoveFunctionId | null {
  if (typeof value !== "string") return null;
  const parts = value.split("::");
  if (parts.length < 3) return null;
  const [address, module, ...rest] = parts;
  const name = rest.join("::");
  return { address, module, name, full: `${address}::${module}::${name}` };
}

/**
 * Extract the leading account address from a fully-qualified type or function
 * string (everything before the first `::`). Returns `null` when the string is
 * absent or carries no `::` separator.
 */
function _addressOf(value: unknown): string | null {
  /* v8 ignore next -- every call site passes an already-stringified type */
  if (typeof value !== "string") return null;
  const i = value.indexOf("::");
  return i > 0 ? value.slice(0, i) : null;
}

/**
 * Extract the `address::module` prefix from a fully-qualified type string.
 * Returns `null` when fewer than two segments are present.
 */
function _moduleOf(value: unknown): string | null {
  /* v8 ignore next -- only ever called with an already-stringified event type */
  if (typeof value !== "string") return null;
  const parts = value.split("::");
  return parts.length >= 2 ? `${parts[0]}::${parts[1]}` : null;
}

/**
 * Normalize the transaction payload into a decoded {@link MovePayloadDetail}.
 * Entry-function and script payloads are read directly; a multisig payload's
 * inner entry-function payload is unwrapped so its target function is reported.
 */
function _normalizePayload(payload: unknown): MovePayloadDetail {
  const kindRaw = _get(payload, "type");
  const typeArguments = _stringArray(_get(payload, "type_arguments"));

  if (kindRaw === "entry_function_payload") {
    const args = _asArray(_get(payload, "arguments"));
    return {
      kind: MovePayloadKind.EntryFunction,
      function: _parseFunctionId(_get(payload, "function")),
      typeArguments,
      argumentCount: args.length,
      arguments: args.slice(0, _MAX_ECHOED_ARGS),
    };
  }

  if (kindRaw === "script_payload") {
    const args = _asArray(_get(payload, "arguments"));
    const bytecode = _get(_get(payload, "code"), "bytecode");
    return {
      kind: MovePayloadKind.Script,
      function: null,
      typeArguments,
      argumentCount: args.length,
      arguments: args.slice(0, _MAX_ECHOED_ARGS),
      scriptByteSize: _byteLength(bytecode),
    };
  }

  if (kindRaw === "multisig_payload") {
    const inner = _get(payload, "transaction_payload");
    const args = _asArray(_get(inner, "arguments"));
    return {
      kind: MovePayloadKind.Multisig,
      function: _parseFunctionId(_get(inner, "function")),
      typeArguments: _stringArray(_get(inner, "type_arguments")),
      argumentCount: args.length,
      arguments: args.slice(0, _MAX_ECHOED_ARGS),
      multisigAddress:
        _toStringOrNull(_get(payload, "multisig_address")) ?? undefined,
    };
  }

  if (kindRaw === "module_bundle_payload") {
    return {
      kind: MovePayloadKind.ModuleBundle,
      function: null,
      typeArguments,
      argumentCount: 0,
      arguments: [],
    };
  }

  return {
    kind: MovePayloadKind.Unknown,
    function: null,
    typeArguments,
    argumentCount: 0,
    arguments: [],
  };
}

/** Coerce an unknown to an array, returning an empty array when not one. */
function _asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Coerce an unknown to an array of strings, dropping non-string entries. */
function _stringArray(value: unknown): string[] {
  return _asArray(value).filter((v): v is string => typeof v === "string");
}

/**
 * Compute the byte length of a `0x`-prefixed hex string (each byte is two hex
 * characters). Returns `null` for non-hex input.
 */
function _byteLength(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (hex.length === 0) return 0;
  return Math.floor(hex.length / 2);
}

/**
 * Aggregate the transaction's events into per-type summaries, ordered by
 * descending count and then by type name for stability.
 */
function _summarizeEvents(events: unknown[]): MoveEventSummary[] {
  const counts = new Map<string, number>();
  for (const ev of events) {
    const type = _toStringOrNull(_get(ev, "type"));
    if (type === null) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, module: _moduleOf(type), count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/**
 * Event types recognized as coin/asset movements, mapped to the direction they
 * represent. Both the legacy `coin` events and the fungible-asset events are
 * covered, alongside the newer combined coin events that also name the account.
 */
const _WITHDRAW_EVENTS = new Set<string>([
  "0x1::coin::WithdrawEvent",
  "0x1::coin::CoinWithdraw",
  "0x1::fungible_asset::Withdraw",
  "0x1::fungible_asset::WithdrawEvent",
]);
const _DEPOSIT_EVENTS = new Set<string>([
  "0x1::coin::DepositEvent",
  "0x1::coin::CoinDeposit",
  "0x1::fungible_asset::Deposit",
  "0x1::fungible_asset::DepositEvent",
]);

/**
 * Build a lookup from account address to the coin type of any `CoinStore`
 * resource written under that account. The classic `coin::WithdrawEvent` and
 * `coin::DepositEvent` do not name the coin they move — the type lives in the
 * `CoinStore<Coin>` resource the event is emitted against — so this correlation
 * lets {@link _deriveBalanceChanges} recover the real coin type from the
 * write-set. Only accounts with exactly one written `CoinStore` are recorded,
 * to avoid attributing a movement to the wrong coin when several changed.
 */
function _coinStoreIndex(changes: unknown[]): Map<string, string> {
  const seen = new Map<string, string | null>(); // account -> type | null(ambiguous)
  for (const ch of changes) {
    if (_get(ch, "type") !== "write_resource") continue;
    const address = _toStringOrNull(_get(ch, "address"));
    const resType = _toStringOrNull(_get(_get(ch, "data"), "type"));
    if (address === null || resType === null) continue;
    const coin = _coinOfStore(resType);
    if (coin === null) continue;
    if (seen.has(address)) {
      // A second CoinStore under the same account makes attribution ambiguous.
      if (seen.get(address) !== coin) seen.set(address, null);
    } else {
      seen.set(address, coin);
    }
  }
  const out = new Map<string, string>();
  for (const [account, coin] of seen) {
    if (coin !== null) out.set(account, coin);
  }
  return out;
}

/**
 * Extract the coin type parameter from a `0x1::coin::CoinStore<COIN>` resource
 * type string, returning `COIN`. Returns `null` for any other resource type.
 */
function _coinOfStore(resourceType: string): string | null {
  if (!resourceType.startsWith("0x1::coin::CoinStore<")) {
    return null;
  }
  const open = resourceType.indexOf("<");
  const close = resourceType.lastIndexOf(">");
  if (close <= open) {
    return null;
  }
  return resourceType.slice(open + 1, close);
}

/**
 * Derive balance movements from the transaction's events, using the write-set
 * to recover coin types where the event itself does not carry one. Each
 * recognized withdraw/deposit event contributes one {@link MoveBalanceChange}:
 * the account is taken from the event's own fields (falling back to the GUID's
 * emitting account), and the asset is resolved in priority order — an explicit
 * coin type or fungible-asset identifier on the event, then the coin type of
 * the `CoinStore` written under the same account, and finally a generic marker
 * when neither is available. Events that are not recognized asset movements are
 * ignored here (they remain visible in the event digest).
 */
function _deriveBalanceChanges(
  events: unknown[],
  changes: unknown[],
): MoveBalanceChange[] {
  const coinStores = _coinStoreIndex(changes);
  const out: MoveBalanceChange[] = [];
  for (const ev of events) {
    const type = _toStringOrNull(_get(ev, "type"));
    if (type === null) continue;
    const isWithdraw = _WITHDRAW_EVENTS.has(type);
    const isDeposit = _DEPOSIT_EVENTS.has(type);
    if (!isWithdraw && !isDeposit) continue;

    const data = _get(ev, "data");
    const amount = _toStringOrNull(_get(data, "amount"));
    if (amount === null) continue;

    const account =
      _toStringOrNull(_get(data, "account")) ??
      _toStringOrNull(_get(data, "owner")) ??
      _toStringOrNull(_get(data, "store")) ??
      _toStringOrNull(_get(_get(ev, "guid"), "account_address")) ??
      "unknown";

    const explicit =
      _toStringOrNull(_get(data, "coin_type")) ??
      _toStringOrNull(_get(data, "metadata"));
    const correlated =
      account !== "unknown" ? coinStores.get(account) : undefined;
    const store = _toStringOrNull(_get(data, "store"));
    const asset = explicit ?? correlated ?? store ?? "coin";

    out.push({
      account,
      asset,
      symbol: _symbolOf(asset),
      amount,
      direction: isWithdraw ? BalanceDirection.Out : BalanceDirection.In,
    });
  }
  return out;
}

/**
 * Best-effort extraction of a coin ticker from an asset identifier: the final
 * `::`-separated segment of a coin type (for example `AptosCoin` from
 * `0x1::aptos_coin::AptosCoin`). Returns `null` when the identifier is not a
 * fully-qualified coin type (fungible-asset stores, for instance, are opaque
 * addresses and have no ticker here).
 */
function _symbolOf(asset: string): string | null {
  const parts = asset.split("::");
  if (parts.length < 3) return null;
  return parts[parts.length - 1];
}

/** Map a raw change `type` discriminant to a {@link MoveChangeKind}. */
function _changeKind(raw: unknown): MoveChangeKind {
  return (Object.values(MoveChangeKind) as string[]).includes(raw as string)
    ? (raw as MoveChangeKind)
    : MoveChangeKind.Unknown;
}

/**
 * Normalize the transaction's write-set into {@link MoveWriteset} accounting:
 * per-change records, the distinct resource types written, the modules
 * published, per-category counts, and the distinct accounts written.
 */
function _normalizeWriteset(changes: unknown[]): MoveWriteset {
  const records: MoveChangeRecord[] = [];
  const resourceTypes = new Set<string>();
  const modules = new Set<string>();
  const accounts = new Set<string>();
  const counts: Partial<Record<MoveChangeKind, number>> = {};

  for (const ch of changes) {
    const kind = _changeKind(_get(ch, "type"));
    counts[kind] = (counts[kind] ?? 0) + 1;

    const address = _toStringOrNull(_get(ch, "address"));
    if (address) accounts.add(address);

    let resource: string | null = null;
    let moduleName: string | null = null;

    if (
      kind === MoveChangeKind.WriteResource ||
      kind === MoveChangeKind.DeleteResource
    ) {
      resource = _toStringOrNull(_get(_get(ch, "data"), "type"));
      if (resource) resourceTypes.add(resource);
    } else if (
      kind === MoveChangeKind.WriteModule ||
      kind === MoveChangeKind.DeleteModule
    ) {
      const abiName = _toStringOrNull(
        _get(_get(_get(ch, "data"), "abi"), "name"),
      );
      moduleName = abiName;
      if (address) modules.add(abiName ? `${address}::${abiName}` : address);
    }

    records.push({
      kind,
      address: address ?? "unknown",
      resource,
      module: moduleName,
    });
  }

  return {
    changes: records,
    resourceTypes: [...resourceTypes],
    modulesPublished: [...modules],
    counts,
    accountsWritten: [...accounts],
  };
}

/**
 * Analyze a Move VM (Aptos or Movement) transaction.
 *
 * The transaction is read exactly as returned by the Aptos REST API; its
 * payload, gas, events, balance movements, and write-set are each normalized
 * into plain data structures, and the distinct packages and accounts it
 * touches are collected. The return value aggregates a headline summary with
 * the full output of every analysis.
 *
 * @param tx - The transaction to analyze. Must be a plain object; its fields
 * may follow any of the by-hash, by-version, or simulation response shapes.
 * @param options - Presentational parameters (chain and network labels, native
 * coin symbol and decimals). Defaults describe Aptos (`APT`, 8 decimals).
 * @returns The complete {@link MoveAnalysis} of the transaction.
 * @throws TypeError if `tx` is not a plain object.
 */
export function analyzeMoveTransaction(
  tx: MoveTransaction,
  options: MoveAnalyzeOptions = {},
): MoveAnalysis {
  if (!_isObject(tx)) {
    throw new TypeError("move transaction must be a simple object");
  }

  const symbol = options.symbol ?? "APT";
  const decimals = options.decimals ?? _DEFAULT_DECIMALS;

  const payload = _normalizePayload(tx.payload);
  const events = _asArray(tx.events);
  const changes = _asArray(tx.changes);

  const eventSummaries = _summarizeEvents(events);
  const balanceChanges = _deriveBalanceChanges(events, changes);
  const writeset = _normalizeWriteset(changes);

  const gasUsed = _toNumber(tx.gas_used);
  const gasUnitPrice = _toNumber(tx.gas_unit_price);
  const maxGasRaw = tx.max_gas_amount;
  const gas: MoveGas = {
    gasUsed,
    gasUnitPrice,
    totalSubunits: gasUsed * gasUnitPrice,
    maxGasAmount: maxGasRaw === undefined ? null : _toNumber(maxGasRaw),
    symbol,
    decimals,
  };

  // Distinct packages touched: the target function's package, plus the package
  // of every written resource type, published module, and emitted event type.
  const packages = new Set<string>();
  if (payload.function) packages.add(payload.function.address);
  for (const t of writeset.resourceTypes) {
    const a = _addressOf(t);
    if (a) packages.add(a);
  }
  for (const m of writeset.modulesPublished) {
    const a = _addressOf(m);
    if (a) packages.add(a);
  }
  for (const e of eventSummaries) {
    const a = _addressOf(e.type);
    if (a) packages.add(a);
  }

  // Distinct accounts touched: the sender plus every account whose state
  // changed and every account credited or debited by a balance movement.
  const accounts = new Set<string>();
  const sender = _toStringOrNull(tx.sender);
  if (sender) accounts.add(sender);
  for (const a of writeset.accountsWritten) accounts.add(a);
  for (const b of balanceChanges) {
    if (b.account && b.account !== "unknown") accounts.add(b.account);
  }

  const summary: MoveSummary = {
    chain: options.chain ?? "aptos",
    network: options.network ?? null,
    txType: _toStringOrNull(tx.type) ?? "unknown",
    payloadKind: payload.kind,
    functionId: payload.function ? payload.function.full : null,
    typeArgCount: payload.typeArguments.length,
    argumentCount: payload.argumentCount,
    eventCount: events.length,
    changeCount: changes.length,
    accountsTouched: accounts.size,
    packagesTouched: packages.size,
    success: tx.success === true,
    vmStatus: _toStringOrNull(tx.vm_status) ?? "unknown",
  };

  return {
    summary,
    payload,
    gas,
    events: eventSummaries,
    balanceChanges,
    writeset,
    packages: [...packages],
    accounts: [...accounts],
    sender,
    hash: _toStringOrNull(tx.hash),
    timestampMicros: _toStringOrNull(tx.timestamp),
  };
}

/**
 * Convert a quantity expressed in the coin's smallest denomination (Octas for
 * APT/MOVE) to a decimal string expressed in whole coins, using the supplied
 * number of decimals. Provided as a convenience for presenting gas figures.
 */
export function subunitsToCoin(
  subunits: number | bigint,
  decimals: number = _DEFAULT_DECIMALS,
): string {
  const value = typeof subunits === "bigint" ? Number(subunits) : subunits;
  return (value / 10 ** decimals).toFixed(decimals);
}

/**
 * Convenience wrapper over {@link subunitsToCoin} for the common Aptos/Movement
 * case of eight-decimal Octas.
 */
export function octasToApt(octas: number | bigint): string {
  return subunitsToCoin(octas, _DEFAULT_DECIMALS);
}

// The individual normalizers are exported alongside the aggregate entry point
// so that callers may invoke them independently — for example, to summarize
// only the events of an already-fetched transaction.
export {
  _deriveBalanceChanges as deriveBalanceChanges,
  _normalizePayload as normalizeMovePayload,
  _normalizeWriteset as normalizeWriteset,
  _summarizeEvents as summarizeEvents,
};
