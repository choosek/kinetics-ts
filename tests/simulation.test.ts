/**
 * Unit tests for the transaction simulation module.
 *
 * Simulation performs network I/O through an injected transport, so these
 * tests drive `simulate` with mock transports that return realistic RPC
 * payloads — exercising request construction, the multi-step orchestration per
 * chain, and normalization into the uniform result shape, all without a
 * network. The Sui path builds a BCS transaction kind locally and dry-runs it
 * over GraphQL; the Aptos path mirrors the sender's own authenticator. The pure
 * helpers, the failure paths, and the malformed-response paths are asserted
 * directly.
 */

import { describe, expect, test } from "vitest";
import * as kinetics from "#/lib";

const {
  simulate,
  toSubunits,
  buildSuiTransferData,
  hexToBase64,
  suiSimulateRequest,
  parseSuiSimulation,
  aptosSimulateRequest,
  parseAptosSimulation,
  SimulationError,
} = kinetics;

const suiIntent = {
  kind: "transfer" as const,
  chain: "sui" as const,
  network: "mainnet" as const,
  sender: `0x${"00".repeat(31)}01`,
  recipient: `0x${"00".repeat(31)}02`,
  amount: "0.001",
  symbol: "SUI",
  decimals: 9,
};

const aptosIntent = {
  kind: "transfer" as const,
  chain: "aptos" as const,
  network: "mainnet" as const,
  sender: "0xA",
  recipient: "0xB",
  amount: "1.25",
  symbol: "APT",
  decimals: 8,
};

describe("toSubunits", () => {
  test("converts decimal amounts without floating point", () => {
    expect(toSubunits("1.5", 9)).toBe("1500000000");
    expect(toSubunits("0.001", 9)).toBe("1000000");
    expect(toSubunits("2", 8)).toBe("200000000");
    expect(toSubunits("0", 8)).toBe("0");
  });

  test("rejects malformed amounts and excess precision", () => {
    expect(() => toSubunits("1.2.3", 9)).toThrow(SimulationError);
    expect(() => toSubunits("abc", 9)).toThrow(SimulationError);
    expect(() => toSubunits("1.1234567890", 9)).toThrow(/decimal places/);
  });
});

describe("buildSuiTransferData", () => {
  const u64 = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b.toString("hex");
  };

  test("encodes the transfer to exact BCS TransactionData bytes", () => {
    const hex = Buffer.from(buildSuiTransferData(suiIntent), "base64").toString(
      "hex",
    );
    const sender = `${"00".repeat(31)}01`;
    const recipient = `${"00".repeat(31)}02`;
    const kind =
      "00" + // ProgrammableTransaction
      "02" + // inputs: 2
      `0008${u64(1_000_000n)}` + // Pure(u64 amount)
      `0020${recipient}` + // Pure(address)
      "02" + // commands: 2
      "020001010000" + // SplitCoins(GasCoin, [Input(0)])
      "01010300000000010100"; // TransferObjects([NestedResult(0,0)], Input(1))
    const gasData = `00${sender}${u64(1000n)}${u64(50_000_000n)}`;
    expect(hex).toBe(`00${kind}${sender}${gasData}00`);
    // V1 + kind + sender + gas_data + expiration = 146 bytes.
    expect(hex.length / 2).toBe(146);
  });

  test("left-pads short addresses and accepts a bare (non-0x) address", () => {
    const a = buildSuiTransferData({ ...suiIntent, recipient: "0x2" });
    const b = buildSuiTransferData({ ...suiIntent, recipient: "2" });
    expect(a).toBe(b);
    expect(Buffer.from(a, "base64").toString("hex")).toContain(
      `0020${"00".repeat(31)}02`,
    );
  });

  test("rejects malformed addresses", () => {
    expect(() =>
      buildSuiTransferData({ ...suiIntent, recipient: "0xZZ" }),
    ).toThrow(/invalid address/);
    expect(() =>
      buildSuiTransferData({ ...suiIntent, sender: `0x${"a".repeat(66)}` }),
    ).toThrow(/invalid address/);
  });
});

describe("hexToBase64", () => {
  test("encodes with correct padding for every tail length", () => {
    expect(hexToBase64("4d616e")).toBe("TWFu"); // 3 bytes, no padding
    expect(hexToBase64("4d61")).toBe("TWE="); // 2 bytes, one pad char
    expect(hexToBase64("4d")).toBe("TQ=="); // 1 byte, two pad chars
    expect(hexToBase64("")).toBe(""); // empty
  });
});

describe("suiSimulateRequest", () => {
  test("wraps the BCS bytes for simulateTransaction with gas selection", () => {
    const req = suiSimulateRequest("DATA_B64");
    expect(req.chain).toBe("sui");
    expect(req.jsonrpc).toBeUndefined(); // no deprecated JSON-RPC
    expect(req.graphql?.query).toContain("simulateTransaction");
    expect(req.graphql?.query).toContain("doGasSelection");
    expect(req.graphql?.query).toContain("balanceChanges");
    expect(req.graphql?.variables).toEqual({
      tx: { bcs: { value: "DATA_B64" } },
    });
  });
});

describe("aptosSimulateRequest", () => {
  test("carries the payload, estimate flags, and a no-account signature", () => {
    const req = aptosSimulateRequest(aptosIntent, "7");
    expect(req.rest?.method).toBe("POST");
    expect(req.rest?.path).toBe("/transactions/simulate");
    const body = req.rest?.body as Record<string, unknown>;
    expect(body.sequence_number).toBe("7");
    // no-account signature => the node skips the sender's auth-key check
    expect(body.signature).toEqual({ type: "no_account_signature" });
    const payload = body.payload as Record<string, unknown>;
    expect(payload.function).toBe("0x1::aptos_account::transfer");
    expect(payload.arguments).toEqual(["0xB", "125000000"]);
    expect(req.rest?.query).toMatchObject({
      estimate_gas_unit_price: true,
      estimate_max_gas_amount: true,
    });
  });
});

// A representative simulateTransaction response.
const suiSimResponse = {
  data: {
    simulateTransaction: {
      effects: {
        status: "SUCCESS",
        gasEffects: {
          gasSummary: {
            computationCost: 100000,
            storageCost: 2588000,
            storageRebate: 78120,
            nonRefundableStorageFee: 9880,
          },
        },
        balanceChanges: {
          nodes: [
            {
              owner: { address: "0xSENDER" },
              amount: "-2609880",
              coinType: { repr: "0x2::sui::SUI" },
            },
            {
              owner: { address: "0xREC" },
              amount: "1000000",
              coinType: { repr: "0x2::sui::SUI" },
            },
          ],
        },
        objectChanges: { nodes: [{ address: "0xa" }, { address: "0xb" }] },
      },
    },
  },
};

describe("parseSuiSimulation", () => {
  test("normalizes gas, balance changes, and status", () => {
    const r = parseSuiSimulation(suiIntent, suiSimResponse);
    expect(r.success).toBe(true);
    expect(r.status).toBe("success");
    expect(r.error).toBeNull();
    // 100000 + 2588000 - 78120  (numeric gas values)
    expect(r.gas.amountSubunits).toBe("2609880");
    expect(r.gas.formatted).toBe("0.002609880");
    expect(r.balanceChanges).toHaveLength(2);
    expect(r.balanceChanges[0]).toMatchObject({
      direction: "out",
      amount: "2609880",
      symbol: "SUI",
      decimals: 9,
    });
    expect(r.balanceChanges[1].direction).toBe("in");
    expect(r.changeCount).toBe(2);
  });

  test("reports a failed simulation", () => {
    const r = parseSuiSimulation(suiIntent, {
      data: { simulateTransaction: { effects: { status: "FAILURE" } } },
    });
    expect(r.success).toBe(false);
    expect(r.status).toBe("failure");
    expect(r.error).toBe("failure");
  });

  test("surfaces GraphQL transport errors", () => {
    expect(() =>
      parseSuiSimulation(suiIntent, { errors: [{ message: "bad input" }] }),
    ).toThrow(/Sui GraphQL error: bad input/);
    // a non-object error entry is stringified
    expect(() => parseSuiSimulation(suiIntent, { errors: ["boom"] })).toThrow(
      /Sui GraphQL error/,
    );
  });

  test("tolerates empty errors, missing data, and odd nodes/gas", () => {
    // empty errors + missing data => defaults, read as failure
    const empty = parseSuiSimulation(suiIntent, { errors: [] });
    expect(empty.success).toBe(false);
    expect(empty.gas.amountSubunits).toBe("0");
    expect(empty.balanceChanges).toEqual([]);
    expect(empty.changeCount).toBe(0);

    // string + garbage gas, and odd balance nodes
    const odd = parseSuiSimulation(suiIntent, {
      data: {
        simulateTransaction: {
          effects: {
            status: "SUCCESS",
            gasEffects: {
              gasSummary: { computationCost: "5", storageCost: "x" },
            },
            balanceChanges: {
              nodes: [
                null, // skipped (not an object)
                { amount: "3" }, // no owner, no coinType
                { coinType: { repr: 42 } }, // no amount -> "0"; repr not a string
                { amount: "7", coinType: { repr: "0x5::usdc::USDC" } }, // non-SUI
              ],
            },
          },
        },
      },
    });
    expect(odd.gas.amountSubunits).toBe("5"); // "5" + "x"(->0) - missing(->0)
    expect(odd.balanceChanges).toHaveLength(3);
    expect(odd.balanceChanges[0].address).toBe("shared/immutable");
    expect(odd.balanceChanges[0].asset).toBe("0x2::sui::SUI");
    expect(odd.balanceChanges[1].amount).toBe("0"); // missing amount
    expect(odd.balanceChanges[2].asset).toBe("0x5::usdc::USDC");
    expect(odd.balanceChanges[2].symbol).toBe("USDC");
    expect(odd.balanceChanges[2].decimals).toBe(9); // intent.decimals (non-SUI)
  });

  test("formats a negative net gas (rebate exceeds cost)", () => {
    const r = parseSuiSimulation(suiIntent, {
      data: {
        simulateTransaction: {
          effects: {
            status: "SUCCESS",
            gasEffects: {
              gasSummary: { computationCost: 1000, storageRebate: 5000 },
            },
          },
        },
      },
    });
    expect(r.gas.amountSubunits).toBe("-4000");
    expect(r.gas.formatted).toBe("-0.000004000");
  });

  test("throws on a non-object response", () => {
    expect(() => parseSuiSimulation(suiIntent, "nope")).toThrow(SimulationError);
  });
});

const aptosSimResponse = [
  {
    type: "user_transaction",
    success: true,
    vm_status: "Executed successfully",
    gas_used: "1500",
    gas_unit_price: "100",
    max_gas_amount: "200000",
    payload: {
      type: "entry_function_payload",
      function: "0x1::aptos_account::transfer",
      type_arguments: [],
      arguments: ["0xB", "125000000"],
    },
    events: [
      {
        guid: { account_address: "0xA" },
        type: "0x1::coin::WithdrawEvent",
        data: { amount: "125000000" },
      },
      {
        guid: { account_address: "0xB" },
        type: "0x1::coin::DepositEvent",
        data: { amount: "125000000" },
      },
    ],
    changes: [
      {
        type: "write_resource",
        address: "0xA",
        data: {
          type: "0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>",
          data: { coin: { value: "1000" } },
        },
      },
      {
        type: "write_resource",
        address: "0xB",
        data: {
          type: "0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>",
          data: { coin: { value: "125000000" } },
        },
      },
    ],
  },
];

describe("parseAptosSimulation", () => {
  test("derives gas and balance movements via the Move analyzer", () => {
    const r = parseAptosSimulation(aptosIntent, aptosSimResponse);
    expect(r.success).toBe(true);
    expect(r.gas.amountSubunits).toBe("150000");
    expect(r.gas.formatted).toBe("0.00150000");
    expect(r.balanceChanges).toHaveLength(2);
    expect(r.moveAnalysis).toBeTruthy();
  });

  test("throws on a non-object simulate response", () => {
    expect(() => parseAptosSimulation(aptosIntent, "nope")).toThrow(
      SimulationError,
    );
  });

  test("reports failures, unknown status, and unresolved assets", () => {
    const failed = parseAptosSimulation(aptosIntent, [
      { success: false, vm_status: "Move abort", events: [], changes: [] },
    ]);
    expect(failed.success).toBe(false);
    expect(failed.status).toBe("Move abort");
    expect(failed.error).toBe("Move abort");

    const unknown = parseAptosSimulation(aptosIntent, [
      { success: false, events: [], changes: [] },
    ]);
    expect(unknown.status).toBe("unknown");

    const unresolved = parseAptosSimulation(aptosIntent, [
      {
        success: true,
        vm_status: "Executed successfully",
        gas_used: "10",
        gas_unit_price: "1",
        events: [
          {
            guid: { account_address: "0xA" },
            type: "0x1::coin::WithdrawEvent",
            data: { amount: "100" },
          },
        ],
        changes: [],
      },
    ]);
    expect(unresolved.balanceChanges[0].symbol).toBe("coin");
  });
});

describe("simulate() — Sui", () => {
  test("builds TransactionData, simulates over GraphQL, and parses", async () => {
    let sawBcs = false;
    const transport: kinetics.Transport = async (req) => {
      const tx = req.graphql?.variables?.tx as
        | { bcs?: { value?: string } }
        | undefined;
      sawBcs = Boolean(tx?.bcs?.value);
      expect(req.jsonrpc).toBeUndefined();
      return suiSimResponse;
    };
    const r = await simulate(suiIntent, transport);
    expect(sawBcs).toBe(true);
    expect(r.chain).toBe("sui");
    expect(r.success).toBe(true);
    expect(r.gas.symbol).toBe("SUI");
    expect(r.balanceChanges[0].direction).toBe("out");
  });

  test("propagates a GraphQL error", async () => {
    const transport: kinetics.Transport = async () => ({
      errors: [{ message: "BAD_USER_INPUT" }],
    });
    await expect(simulate(suiIntent, transport)).rejects.toThrow(
      /Sui GraphQL error: BAD_USER_INPUT/,
    );
  });
});

describe("simulate() — Aptos / Movement", () => {
  const transport: kinetics.Transport = async (req) => {
    const p = req.rest?.path;
    if (p === "/accounts/0xA")
      return { sequence_number: "7", authentication_key: "0xauth" };
    if (p === "/transactions/simulate") {
      // the node receives a no-account signature (skips the auth-key check)
      const body = req.rest?.body as Record<string, unknown>;
      expect(body.signature).toEqual({ type: "no_account_signature" });
      expect(body.sequence_number).toBe("7");
      return aptosSimResponse;
    }
    throw new Error(`unexpected ${p}`);
  };

  test("runs account -> simulate and parses (no key recovery)", async () => {
    const r = await simulate(aptosIntent, transport);
    expect(r.chain).toBe("aptos");
    expect(r.success).toBe(true);
    expect(r.gas.symbol).toBe("APT");
    expect(r.balanceChanges.find((b) => b.direction === "out")?.address).toBe(
      "0xA",
    );
  });

  test("Movement uses the same REST path, MOVE-denominated", async () => {
    const r = await simulate(
      { ...aptosIntent, chain: "movement", symbol: "MOVE" },
      transport,
    );
    expect(r.chain).toBe("movement");
    expect(r.gas.symbol).toBe("MOVE");
  });

  test("simulates a fresh account with no transaction history", async () => {
    // funded account, sequence 0, and no prior transactions to mirror
    const fresh: kinetics.Transport = async (req) => {
      if (req.rest?.path === "/accounts/0xA")
        return { sequence_number: "0", authentication_key: "0x0" };
      if (req.rest?.path === "/transactions/simulate") return aptosSimResponse;
      throw new Error("unexpected");
    };
    const r = await simulate(aptosIntent, fresh);
    expect(r.success).toBe(true);
  });

  test("missing account raises SimulationError", async () => {
    const empty = async () => ({});
    await expect(simulate(aptosIntent, empty)).rejects.toThrow(SimulationError);
  });

  test("rejects an unsupported chain", async () => {
    const bad = { ...suiIntent, chain: "solana" };
    await expect(
      simulate(bad as unknown as kinetics.SimulationIntent, async () => ({})),
    ).rejects.toThrow(/unsupported chain/);
  });
});
