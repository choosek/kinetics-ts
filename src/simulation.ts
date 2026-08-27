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
//   - Sui: the transfer is built locally into BCS TransactionData bytes and
//     simulated through GraphQL `simulateTransaction` (which selects the gas
//     coin itself), returning status, balance changes, gas, and object
//     changes. Sui retired JSON-RPC on public fullnodes; this is the
//     supported replacement.
//   - Aptos/Movement (shared REST surface): `POST /transactions/simulate` with
//     a `no_account_signature`, which skips the sender's auth-key check so any
//     account simulates — even one with no transaction history; the returned
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
import type { Analysis } from "./analysis/suiptb";

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
  /** Sui GraphQL call (query + variables). */
  graphql?: { query: string; variables?: Record<string, unknown> };
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
 * Sui GraphQL call that is the `{ data, errors }` envelope; for a REST call it
 * is the response body. Implementations supply the transport (endpoint, auth,
 * CORS handling); this module supplies the requests.
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
// Sui: build the transfer locally (BCS TransactionData) -> simulateTransaction
// ---------------------------------------------------------------------------

const SUI_TYPE = "0x2::sui::SUI";

// --- BCS + Base64 helpers (enough to encode a transfer's TransactionData) ----

/** Little-endian hex (16 chars) for a u64 value. */
function u64ToHexLE(value: bigint): string {
  let hex = "";
  let v = value;
  for (let i = 0; i < 8; i++) {
    hex += (Number(v & 0xffn)).toString(16).padStart(2, "0");
    v >>= 8n;
  }
  return hex;
}

/** A `0x…` address as 64 lowercase hex chars (32 bytes, left-padded). */
function addressToHex(addr: string): string {
  const hex = (addr.startsWith("0x") ? addr.slice(2) : addr).toLowerCase();
  if (!/^[0-9a-f]*$/.test(hex) || hex.length > 64) {
    throw new SimulationError(`invalid address: ${addr}`);
  }
  return hex.padStart(64, "0");
}

/** Standard Base64 of a hex string. */
export function hexToBase64(hex: string): string {
  const table =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const n =
      (bytes[i] << 16) |
      ((has1 ? bytes[i + 1] : 0) << 8) |
      (has2 ? bytes[i + 2] : 0);
    out += table[(n >> 18) & 63];
    out += table[(n >> 12) & 63];
    out += has1 ? table[(n >> 6) & 63] : "=";
    out += has2 ? table[n & 63] : "=";
  }
  return out;
}

/**
 * Build the BCS `TransactionData` for a native SUI transfer, Base64 encoded and
 * ready to wrap for `simulateTransaction`. The programmable block is
 * `SplitCoins(GasCoin, [amount])` then `TransferObjects([split], recipient)`.
 * Gas payment is left empty and resolved by the node (`doGasSelection`); the
 * price/budget are conservative hints it may re-estimate.
 */
export function buildSuiTransferData(intent: TransferIntent): string {
  const amount = u64ToHexLE(BigInt(toSubunits(intent.amount, intent.decimals)));
  const recipient = addressToHex(intent.recipient);
  const sender = addressToHex(intent.sender);
  // TransactionKind::ProgrammableTransaction, inputs then commands (every
  // length and index prefix is a single BCS byte at this size).
  const kind =
    "00" + // ProgrammableTransaction
    "02" + // inputs: 2
    `0008${amount}` + // [0] Pure(u64 amount)
    `0020${recipient}` + // [1] Pure(address)
    "02" + // commands: 2
    "020001010000" + // SplitCoins(GasCoin, [Input(0)])
    "01010300000000010100"; // TransferObjects([NestedResult(0,0)], Input(1))
  // gas_data { payment: [] (node selects), owner: sender, price, budget }.
  const gasData = `00${sender}${u64ToHexLE(1000n)}${u64ToHexLE(50000000n)}`;
  // TransactionData::V1 { kind, sender, gas_data, expiration: None }.
  return hexToBase64(`00${kind}${sender}${gasData}00`);
}

// --- Sui transaction simulation (GraphQL) ------------------------------------

const SUI_SIMULATE_QUERY = `query Simulate($tx: JSON!) {
  simulateTransaction(
    transaction: $tx
    checksEnabled: false
    doGasSelection: true
  ) {
    effects {
      status
      gasEffects {
        gasSummary {
          computationCost
          storageCost
          storageRebate
          nonRefundableStorageFee
        }
      }
      balanceChanges {
        nodes {
          owner {
            address
          }
          amount
          coinType {
            repr
          }
        }
      }
      objectChanges {
        nodes {
          address
        }
      }
    }
  }
}`;

/**
 * GraphQL request that simulates a Base64 BCS `TransactionData`. Sui retired
 * JSON-RPC on public fullnodes; `Query.simulateTransaction` is the supported
 * replacement — it accepts pre-built transaction bytes as `{ bcs: { value } }`
 * and selects the gas coin itself.
 */
export function suiSimulateRequest(txDataBase64: string): TransportRequest {
  return {
    chain: "sui",
    graphql: {
      query: SUI_SIMULATE_QUERY,
      variables: { tx: { bcs: { value: txDataBase64 } } },
    },
  };
}

/** Format integer subunits as a fixed-`decimals` string (2588000 -> 0.002588000). */
function formatUnits(subunits: bigint, decimals: number): string {
  const negative = subunits < 0n;
  const digits = (negative ? -subunits : subunits)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Parse a GraphQL BigInt scalar, which may be a JSON number or a string. */
function toBigInt(value: unknown): bigint {
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
}

/** Turn a GraphQL `simulateTransaction` response into the uniform result. */
export function parseSuiSimulation(
  intent: TransferIntent,
  response: unknown,
): SimulationResult {
  if (!isObject(response)) {
    throw new SimulationError("malformed Sui simulation response");
  }
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    const first = response.errors[0];
    const message =
      isObject(first) && typeof first.message === "string"
        ? first.message
        : JSON.stringify(response.errors);
    throw new SimulationError(`Sui GraphQL error: ${message}`);
  }
  const data = isObject(response.data) ? response.data : {};
  const sim = isObject(data.simulateTransaction)
    ? data.simulateTransaction
    : {};
  const effects = isObject(sim.effects) ? sim.effects : {};

  const success = effects.status === "SUCCESS";
  const status = success ? "success" : "failure";

  // Gas: computation + storage - rebate, in MIST.
  const gasEffects = isObject(effects.gasEffects) ? effects.gasEffects : {};
  const gasSummary = isObject(gasEffects.gasSummary)
    ? gasEffects.gasSummary
    : {};
  const gasSubunits =
    toBigInt(gasSummary.computationCost) +
    toBigInt(gasSummary.storageCost) -
    toBigInt(gasSummary.storageRebate);

  const balanceChanges: SimulatedBalanceChange[] = [];
  const bcConn = isObject(effects.balanceChanges) ? effects.balanceChanges : {};
  const bcNodes = Array.isArray(bcConn.nodes) ? bcConn.nodes : [];
  for (const change of bcNodes) {
    if (!isObject(change)) continue;
    const amountStr = typeof change.amount === "string" ? change.amount : "0";
    const negative = amountStr.startsWith("-");
    const coinType =
      isObject(change.coinType) && typeof change.coinType.repr === "string"
        ? change.coinType.repr
        : SUI_TYPE;
    const owner = isObject(change.owner) ? change.owner : {};
    balanceChanges.push({
      address:
        typeof owner.address === "string" ? owner.address : "shared/immutable",
      asset: coinType,
      symbol: symbolOfType(coinType),
      amount: negative ? amountStr.slice(1) : amountStr,
      direction: negative ? BalanceDirection.Out : BalanceDirection.In,
      decimals: coinType === SUI_TYPE ? 9 : intent.decimals,
    });
  }

  const ocConn = isObject(effects.objectChanges) ? effects.objectChanges : {};
  const changeCount = Array.isArray(ocConn.nodes) ? ocConn.nodes.length : 0;

  return {
    chain: intent.chain,
    network: intent.network,
    success,
    status,
    error: success ? null : status,
    gas: {
      amountSubunits: gasSubunits.toString(),
      formatted: formatUnits(gasSubunits, 9),
      symbol: intent.symbol,
    },
    balanceChanges,
    changeCount,
    raw: response,
  };
}

async function simulateSui(
  intent: TransferIntent,
  transport: Transport,
): Promise<SimulationResult> {
  const txData = buildSuiTransferData(intent);
  const response = await transport(suiSimulateRequest(txData));
  return parseSuiSimulation(intent, response);
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

/**
 * Build the JSON `SignedTransaction` body for `/transactions/simulate`. The
 * `no_account_signature` authenticator tells the node to skip the sender's
 * auth-key check, so simulation works for any account — including fresh ones
 * that have never sent a transaction (whose public key is therefore not
 * recoverable from chain history). This is the wire equivalent of omitting
 * `signerPublicKey` in the Aptos SDK's simulate flow.
 */
export function aptosSimulateRequest(
  intent: TransferIntent,
  sequenceNumber: string,
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
    signature: { type: "no_account_signature" },
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
  const simulation = await transport(
    aptosSimulateRequest(intent, account.sequence_number),
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
