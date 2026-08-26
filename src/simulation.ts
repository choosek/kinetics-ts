// Pre-submission transaction simulation for Sui, Aptos, and Movement.
//
// Unlike the analyzers in this package (which read an *already-formed*
// transaction and are pure, offline functions), simulation asks a chain what a
// transaction *would* do against current state. That requires the network, so
// every byte of I/O is delegated to an injected `Transport`; this module
// contains only the logic — building the RPC requests and interpreting the
// results — and no `fetch`, SDK, or endpoint of its own. The same core can
// therefore run in the browser (transport = the app's RPC proxy) or behind a
// public API (transport = a server-side fetch) without change.
//
// How each chain is simulated (all against live mainnet/testnet state):
//   - Sui: the fullnode builds the transfer with `unsafe_paySui`, then
//     `sui_dryRunTransactionBlock` executes it and returns effects, balance
//     changes, and object changes. The effects feed `analyzePtb`.
//   - Aptos/Movement (shared REST surface): `POST /transactions/simulate`
//     runs the transaction with signature verification disabled; the returned
//     `UserTransaction` feeds `analyzeMoveTransaction` directly.
//
// This module models a native-coin transfer — the most common transaction and
// the clearest simulation to reason about — behind an extensible `Intent`.

import {
  analyzeMoveTransaction,
  BalanceDirection,
  type MoveAnalysis,
  subunitsToCoin,
} from "./analysis/movevm";
import { type Analysis, analyzePtb } from "./analysis/suiptb";

/** A chain Kinetics can simulate against. */
export type SimulationChain = "sui" | "aptos" | "movement";

/**
 * A transaction to simulate, described at the level a wallet would: who is
 * sending, to whom, and how much of the native coin. `amount` is a decimal
 * string in whole coins (e.g. `"1.5"`); `symbol`/`decimals` describe the native
 * coin so amounts and gas can be denominated. This is a discriminated union so
 * further transaction kinds (contract calls, multi-recipient) can be added
 * without breaking callers.
 */
export interface TransferIntent {
  kind: "transfer";
  chain: SimulationChain;
  network: "mainnet" | "testnet";
  sender: string;
  recipient: string;
  amount: string;
  symbol: string;
  decimals: number;
}

export type SimulationIntent = TransferIntent;

/** A single RPC request for the transport to perform. */
export interface TransportRequest {
  chain: SimulationChain;
  /** Sui JSON-RPC call. */
  jsonrpc?: { method: string; params: unknown[] };
  /** Aptos/Movement REST call. */
  rest?: {
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string | number | boolean>;
    body?: unknown;
  };
}

/**
 * Performs one RPC request and resolves with the parsed upstream JSON. For a
 * Sui JSON-RPC call that is the `{ jsonrpc, result, error }` envelope; for a
 * REST call it is the response body. Implementations supply the transport
 * (endpoint, auth, CORS handling); this module supplies the requests.
 */
export type Transport = (req: TransportRequest) => Promise<unknown>;

/** One asset movement the simulation predicts. */
export interface SimulatedBalanceChange {
  address: string;
  asset: string;
  symbol: string;
  amount: string;
  direction: BalanceDirection;
  decimals: number;
}

/** The uniform, wallet-facing outcome of a simulation. */
export interface SimulationResult {
  chain: SimulationChain;
  network: "mainnet" | "testnet";
  /** Whether the transaction would succeed if submitted now. */
  success: boolean;
  /** VM status string; `"success"` on success, otherwise the failure reason. */
  status: string;
  /** Failure detail when `success` is false, else `null`. */
  error: string | null;
  gas: {
    /** Total gas cost in the coin's smallest unit (MIST/octas). */
    amountSubunits: string;
    /** Human-readable cost, e.g. `"0.00241200"`. */
    formatted: string;
    symbol: string;
  };
  /** Predicted asset movements, most relevant first. */
  balanceChanges: SimulatedBalanceChange[];
  /** Count of state entries the transaction would create/modify/delete. */
  changeCount: number;
  /** Full Sui PTB analysis of the simulated effects, when applicable. */
  suiAnalysis?: Analysis;
  /** Full Move analysis of the simulated transaction, when applicable. */
  moveAnalysis?: MoveAnalysis;
  /** The raw simulation response, for debugging or richer display. */
  raw: unknown;
}

/** Raised when the transport or the chain reports the simulation cannot run. */
export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationError";
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Convert a decimal coin amount (`"1.5"`) to an integer string in the coin's
 * smallest unit, without floating point. Throws on malformed input.
 */
export function toSubunits(amount: string, decimals: number): string {
  const trimmed = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new SimulationError(`invalid amount: ${amount}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new SimulationError(
      `amount has more than ${decimals} decimal places`,
    );
  }
  const padded = frac.padEnd(decimals, "0");
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return combined;
}

/** Short asset symbol from a Move coin type, e.g. `0x2::sui::SUI` -> `SUI`. */
function symbolOfType(coinType: string): string {
  const parts = coinType.split("::");
  return parts[parts.length - 1];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Sui: unsafe_paySui (fullnode builds) -> sui_dryRunTransactionBlock
// ---------------------------------------------------------------------------

const SUI_TYPE = "0x2::sui::SUI";
const SUI_GAS_BUDGET = "50000000"; // 0.05 SUI ceiling for the dry run

/** JSON-RPC request to list a sender's SUI coins. */
export function suiGetCoinsRequest(sender: string): TransportRequest {
  return {
    chain: "sui",
    jsonrpc: { method: "suix_getCoins", params: [sender, SUI_TYPE, null, 50] },
  };
}

/** JSON-RPC request that asks the fullnode to build the transfer transaction. */
export function suiPaySuiRequest(
  intent: TransferIntent,
  coinIds: string[],
): TransportRequest {
  const amount = toSubunits(intent.amount, intent.decimals);
  return {
    chain: "sui",
    jsonrpc: {
      method: "unsafe_paySui",
      params: [
        intent.sender,
        coinIds,
        [intent.recipient],
        [amount],
        SUI_GAS_BUDGET,
      ],
    },
  };
}

/** JSON-RPC request to dry-run built transaction bytes. */
export function suiDryRunRequest(txBytes: string): TransportRequest {
  return {
    chain: "sui",
    jsonrpc: { method: "sui_dryRunTransactionBlock", params: [txBytes] },
  };
}

/** Unwrap a Sui JSON-RPC envelope, surfacing errors as SimulationError. */
function suiResult(envelope: unknown): unknown {
  if (!isObject(envelope)) {
    throw new SimulationError("malformed Sui RPC response");
  }
  if (isObject(envelope.error)) {
    const message = envelope.error.message;
    throw new SimulationError(
      `Sui RPC error: ${typeof message === "string" ? message : JSON.stringify(envelope.error)}`,
    );
  }
  return envelope.result;
}

function suiOwnerAddress(owner: unknown): string {
  if (isObject(owner) && typeof owner.AddressOwner === "string") {
    return owner.AddressOwner;
  }
  if (typeof owner === "string") return owner;
  return "shared/immutable";
}

/** Turn a dry-run response into the uniform result. */
export function parseSuiDryRun(
  intent: TransferIntent,
  dryRun: unknown,
): SimulationResult {
  if (!isObject(dryRun)) {
    throw new SimulationError("malformed Sui dry-run response");
  }
  const effects = isObject(dryRun.effects) ? dryRun.effects : {};
  const statusObj = isObject(effects.status) ? effects.status : {};
  const status =
    typeof statusObj.status === "string" ? statusObj.status : "unknown";
  const success = status === "success";
  const error =
    !success && typeof statusObj.error === "string" ? statusObj.error : null;

  // Gas: computation + storage - rebate, in MIST.
  const gasUsed = isObject(effects.gasUsed) ? effects.gasUsed : {};
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const gasSubunits =
    num(gasUsed.computationCost) +
    num(gasUsed.storageCost) -
    num(gasUsed.storageRebate);

  const balanceChanges: SimulatedBalanceChange[] = [];
  const rawBalances = Array.isArray(dryRun.balanceChanges)
    ? dryRun.balanceChanges
    : [];
  for (const change of rawBalances) {
    if (!isObject(change)) continue;
    const amountStr = typeof change.amount === "string" ? change.amount : "0";
    const negative = amountStr.startsWith("-");
    const coinType =
      typeof change.coinType === "string" ? change.coinType : SUI_TYPE;
    balanceChanges.push({
      address: suiOwnerAddress(change.owner),
      asset: coinType,
      symbol: symbolOfType(coinType),
      amount: negative ? amountStr.slice(1) : amountStr,
      direction: negative ? BalanceDirection.Out : BalanceDirection.In,
      decimals: coinType === SUI_TYPE ? 9 : intent.decimals,
    });
  }

  const objectChanges = Array.isArray(dryRun.objectChanges)
    ? dryRun.objectChanges
    : [];

  // Best-effort rich analysis of the PTB from the dry-run's own input + effects.
  let suiAnalysis: Analysis | undefined;
  try {
    const input = isObject(dryRun.input) ? dryRun.input : {};
    const transaction = isObject(input.transaction) ? input.transaction : input;
    suiAnalysis = analyzePtb(
      transaction as Parameters<typeof analyzePtb>[0],
      effects as Parameters<typeof analyzePtb>[1],
    );
  } catch {
    suiAnalysis = undefined;
  }

  return {
    chain: intent.chain,
    network: intent.network,
    success,
    status,
    error,
    gas: {
      amountSubunits: String(gasSubunits),
      formatted: (gasSubunits / 10 ** 9).toFixed(9),
      symbol: intent.symbol,
    },
    balanceChanges,
    changeCount: objectChanges.length,
    suiAnalysis,
    raw: dryRun,
  };
}

async function simulateSui(
  intent: TransferIntent,
  transport: Transport,
): Promise<SimulationResult> {
  const coins = suiResult(await transport(suiGetCoinsRequest(intent.sender)));
  const coinList =
    isObject(coins) && Array.isArray(coins.data) ? coins.data : [];
  const coinIds = coinList
    .map((c) =>
      isObject(c) && typeof c.coinObjectId === "string" ? c.coinObjectId : null,
    )
    .filter((id): id is string => id !== null);
  if (coinIds.length === 0) {
    throw new SimulationError(
      `sender holds no ${intent.symbol} coins on ${intent.network} to transfer`,
    );
  }

  const built = suiResult(await transport(suiPaySuiRequest(intent, coinIds)));
  if (!isObject(built) || typeof built.txBytes !== "string") {
    throw new SimulationError(
      "Sui fullnode did not return transaction bytes (does this endpoint enable unsafe_* builder methods?)",
    );
  }

  const dryRun = suiResult(await transport(suiDryRunRequest(built.txBytes)));
  return parseSuiDryRun(intent, dryRun);
}

// ---------------------------------------------------------------------------
// Aptos/Movement: POST /transactions/simulate (JSON, no SDK, no BCS)
// ---------------------------------------------------------------------------

/** REST request for a sender's account (sequence number, auth key). */
export function aptosAccountRequest(
  chain: SimulationChain,
  sender: string,
): TransportRequest {
  return { chain, rest: { method: "GET", path: `/accounts/${sender}` } };
}

/** REST request for the sender's most recent transaction (to recover its key). */
export function aptosRecentTxRequest(
  chain: SimulationChain,
  sender: string,
): TransportRequest {
  return {
    chain,
    rest: {
      method: "GET",
      path: `/accounts/${sender}/transactions`,
      query: { limit: 1 },
    },
  };
}

/**
 * Build the JSON `SignedTransaction` body for `/transactions/simulate`. The
 * signature is a placeholder — the simulate endpoint runs with signature
 * verification disabled — but the sender's real public key is required so the
 * account's auth-key check passes.
 */
export function aptosSimulateRequest(
  intent: TransferIntent,
  sequenceNumber: string,
  publicKey: string,
): TransportRequest {
  const amount = toSubunits(intent.amount, intent.decimals);
  const body = {
    sender: intent.sender,
    sequence_number: sequenceNumber,
    max_gas_amount: "200000",
    gas_unit_price: "100",
    expiration_timestamp_secs: String(Math.floor(Date.now() / 1000) + 600),
    payload: {
      type: "entry_function_payload",
      function: "0x1::aptos_account::transfer",
      type_arguments: [],
      arguments: [intent.recipient, amount],
    },
    signature: {
      type: "ed25519_signature",
      public_key: publicKey,
      signature: `0x${"0".repeat(128)}`,
    },
  };
  return {
    chain: intent.chain,
    rest: {
      method: "POST",
      path: "/transactions/simulate",
      query: {
        estimate_gas_unit_price: true,
        estimate_max_gas_amount: true,
        estimate_prioritized_gas_unit_price: true,
      },
      body,
    },
  };
}

/** Extract the sender's ed25519 public key from a recent-transactions response. */
export function extractPublicKey(recentTxns: unknown): string | null {
  const list = Array.isArray(recentTxns) ? recentTxns : [];
  for (const txn of list) {
    if (!isObject(txn) || !isObject(txn.signature)) continue;
    const sig = txn.signature;
    if (typeof sig.public_key === "string") return sig.public_key;
    // fee-payer/multi-agent wrap the sender's signature one level down
    if (isObject(sig.sender) && typeof sig.sender.public_key === "string") {
      return sig.sender.public_key;
    }
  }
  return null;
}

/** Turn a `/transactions/simulate` response into the uniform result. */
export function parseAptosSimulation(
  intent: TransferIntent,
  simulation: unknown,
): SimulationResult {
  const userTxn = Array.isArray(simulation) ? simulation[0] : simulation;
  if (!isObject(userTxn)) {
    throw new SimulationError("malformed simulate response");
  }
  const analysis = analyzeMoveTransaction(
    userTxn as Parameters<typeof analyzeMoveTransaction>[0],
    { chain: intent.chain, symbol: intent.symbol, decimals: intent.decimals },
  );
  const success = userTxn.success === true;
  const vmStatus =
    typeof userTxn.vm_status === "string" ? userTxn.vm_status : "unknown";

  const balanceChanges: SimulatedBalanceChange[] = analysis.balanceChanges.map(
    (b) => ({
      address: b.account,
      asset: b.asset,
      symbol: b.symbol ?? symbolOfType(b.asset),
      amount: b.amount,
      direction: b.direction,
      decimals: intent.decimals,
    }),
  );

  return {
    chain: intent.chain,
    network: intent.network,
    success,
    status: success ? "success" : vmStatus,
    error: success ? null : vmStatus,
    gas: {
      amountSubunits: String(analysis.gas.totalSubunits),
      formatted: subunitsToCoin(analysis.gas.totalSubunits, intent.decimals),
      symbol: intent.symbol,
    },
    balanceChanges,
    changeCount: analysis.summary.changeCount,
    moveAnalysis: analysis,
    raw: userTxn,
  };
}

async function simulateMove(
  intent: TransferIntent,
  transport: Transport,
): Promise<SimulationResult> {
  const account = await transport(
    aptosAccountRequest(intent.chain, intent.sender),
  );
  if (!isObject(account) || typeof account.sequence_number !== "string") {
    throw new SimulationError(
      `account ${intent.sender} not found on ${intent.chain} ${intent.network}`,
    );
  }
  const sequenceNumber = account.sequence_number;

  const publicKey = extractPublicKey(
    await transport(aptosRecentTxRequest(intent.chain, intent.sender)),
  );
  if (publicKey === null) {
    throw new SimulationError(
      "could not determine the sender's public key (the account has no prior transactions to recover it from)",
    );
  }

  const simulation = await transport(
    aptosSimulateRequest(intent, sequenceNumber, publicKey),
  );
  return parseAptosSimulation(intent, simulation);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Simulate a transaction against live chain state and return its predicted
 * outcome. All network I/O is delegated to `transport`; this function chooses
 * the right RPC sequence per chain, interprets the result through the existing
 * analyzers, and returns a uniform {@link SimulationResult}.
 *
 * @throws {SimulationError} if the transaction cannot be built or simulated.
 */
export async function simulate(
  intent: SimulationIntent,
  transport: Transport,
): Promise<SimulationResult> {
  switch (intent.chain) {
    case "sui":
      return simulateSui(intent, transport);
    case "aptos":
    case "movement":
      return simulateMove(intent, transport);
    default:
      throw new SimulationError(`unsupported chain: ${String(intent.chain)}`);
  }
}
