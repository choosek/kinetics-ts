/**
 * Unit tests for the transaction simulation module.
 *
 * Simulation performs network I/O through an injected transport, so these
 * tests drive `simulate` with mock transports that return realistic RPC
 * payloads — exercising the request construction, the multi-step orchestration
 * per chain, and the normalization of results into the uniform shape, all
 * without a network. The pure helpers and request builders are asserted
 * directly, together with the failure and malformed-response paths.
 */

import { describe, expect, test } from "vitest";
import * as kinetics from "#/lib";

const {
  simulate,
  toSubunits,
  extractPublicKey,
  suiGetCoinsRequest,
  suiPaySuiRequest,
  suiDryRunRequest,
  aptosSimulateRequest,
  parseSuiDryRun,
  parseAptosSimulation,
  SimulationError,
} = kinetics;

const suiIntent = {
  kind: "transfer" as const,
  chain: "sui" as const,
  network: "mainnet" as const,
  sender: "0xSENDER",
  recipient: "0xREC",
  amount: "2",
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
    expect(toSubunits("1.5", 8)).toBe("150000000");
    expect(toSubunits("0.00000001", 8)).toBe("1");
    expect(toSubunits("10", 9)).toBe("10000000000");
    expect(toSubunits("0", 9)).toBe("0");
  });
  test("rejects malformed amounts and excess precision", () => {
    expect(() => toSubunits("1.2345678901", 9)).toThrow(SimulationError);
    expect(() => toSubunits("abc", 9)).toThrow(SimulationError);
    expect(() => toSubunits("-1", 9)).toThrow(SimulationError);
  });
});

describe("extractPublicKey", () => {
  test("reads ed25519, fee-payer, and absent keys", () => {
    expect(
      extractPublicKey([
        { signature: { type: "ed25519_signature", public_key: "0xPUB" } },
      ]),
    ).toBe("0xPUB");
    expect(
      extractPublicKey([{ signature: { sender: { public_key: "0xFEE" } } }]),
    ).toBe("0xFEE");
    expect(extractPublicKey([])).toBeNull();
    expect(extractPublicKey([{ nope: true }])).toBeNull();
  });

  test("returns null when no signature carries a usable key", () => {
    expect(
      extractPublicKey([
        "not-an-object",
        { signature: { foo: 1 } },
        { signature: { sender: { foo: 1 } } },
      ]),
    ).toBeNull();
    expect(extractPublicKey("not-an-array")).toBeNull();
  });
});

describe("request builders", () => {
  test("Sui getCoins / paySui / dryRun", () => {
    expect(suiGetCoinsRequest("0xS").jsonrpc?.method).toBe("suix_getCoins");
    const pay = suiPaySuiRequest(suiIntent, ["0xc1", "0xc2"]);
    expect(pay.jsonrpc?.method).toBe("unsafe_paySui");
    expect(pay.jsonrpc?.params).toEqual([
      "0xSENDER",
      ["0xc1", "0xc2"],
      ["0xREC"],
      ["2000000000"],
      "50000000",
    ]);
    expect(suiDryRunRequest("BYTES").jsonrpc?.params).toEqual(["BYTES"]);
  });

  test("Aptos simulate body carries the transfer payload and estimate flags", () => {
    const req = aptosSimulateRequest(aptosIntent, "7", "0xPUB");
    expect(req.rest?.path).toBe("/transactions/simulate");
    const body = req.rest?.body as {
      sequence_number: string;
      payload: { function: string; arguments: unknown[] };
      signature: { public_key: string };
    };
    expect(body.sequence_number).toBe("7");
    expect(body.payload.function).toBe("0x1::aptos_account::transfer");
    expect(body.payload.arguments).toEqual(["0xB", "125000000"]);
    expect(body.signature.public_key).toBe("0xPUB");
    expect(req.rest?.query?.estimate_max_gas_amount).toBe(true);
  });
});

const suiDryRunResponse = {
  effects: {
    status: { status: "success" },
    gasUsed: {
      computationCost: "1000000",
      storageCost: "2000000",
      storageRebate: "1500000",
    },
    created: [],
    mutated: [{ reference: { objectId: "0xg" } }],
    deleted: [],
  },
  balanceChanges: [
    {
      owner: { AddressOwner: "0xSENDER" },
      coinType: "0x2::sui::SUI",
      amount: "-2001500000",
    },
    {
      owner: { AddressOwner: "0xREC" },
      coinType: "0x2::sui::SUI",
      amount: "2000000000",
    },
  ],
  objectChanges: [{ type: "mutated" }, { type: "mutated" }],
  events: [],
  input: { transaction: { inputs: [], transactions: [] } },
};

describe("parseSuiDryRun", () => {
  test("normalizes gas, balance changes, and status", () => {
    const r = parseSuiDryRun(suiIntent, suiDryRunResponse);
    expect(r.success).toBe(true);
    expect(r.gas.amountSubunits).toBe("1500000");
    expect(r.gas.formatted).toBe("0.001500000");
    expect(r.balanceChanges).toHaveLength(2);
    const out = r.balanceChanges.find((b) => b.direction === "out");
    const inc = r.balanceChanges.find((b) => b.direction === "in");
    expect(out?.address).toBe("0xSENDER");
    expect(out?.amount).toBe("2001500000");
    expect(inc?.amount).toBe("2000000000");
    expect(r.changeCount).toBe(2);
    expect(r.suiAnalysis).toBeTruthy();
  });

  test("reports a failed dry-run with its abort reason", () => {
    const r = parseSuiDryRun(suiIntent, {
      effects: { status: { status: "failure", error: "MoveAbort(1)" } },
      balanceChanges: "not-an-array",
      objectChanges: "not-an-array",
      input: "not-an-object",
    });
    expect(r.success).toBe(false);
    expect(r.status).toBe("failure");
    expect(r.error).toBe("MoveAbort(1)");
    expect(r.balanceChanges).toHaveLength(0);
    expect(r.changeCount).toBe(0);
    expect(r.gas.amountSubunits).toBe("0");
    expect(r.suiAnalysis).toBeTruthy();
  });

  test("tolerates malformed effects, owners, and unrecoverable analysis", () => {
    const r = parseSuiDryRun(suiIntent, {
      effects: "not-an-object",
      balanceChanges: [
        "not-an-object",
        { owner: "0xDIRECT", coinType: "0xpkg::coin::USDC", amount: "-5" },
        { owner: { Shared: {} } },
      ],
      input: { transaction: new Date() },
    });
    expect(r.status).toBe("unknown");
    expect(r.success).toBe(false);
    expect(r.error).toBeNull();
    expect(r.balanceChanges).toHaveLength(2);
    expect(r.balanceChanges[0].address).toBe("0xDIRECT");
    expect(r.balanceChanges[0].symbol).toBe("USDC");
    expect(r.balanceChanges[0].amount).toBe("5");
    expect(r.balanceChanges[0].direction).toBe("out");
    expect(r.balanceChanges[0].decimals).toBe(9);
    expect(r.balanceChanges[1].address).toBe("shared/immutable");
    expect(r.balanceChanges[1].symbol).toBe("SUI");
    expect(r.balanceChanges[1].amount).toBe("0");
    expect(r.balanceChanges[1].direction).toBe("in");
    expect(r.suiAnalysis).toBeUndefined();
  });

  test("throws on a non-object dry-run response", () => {
    expect(() => parseSuiDryRun(suiIntent, "nope")).toThrow(SimulationError);
  });
});

describe("simulate() — Sui", () => {
  test("runs getCoins -> paySui -> dryRun and parses the result", async () => {
    const transport: kinetics.Transport = async (req) => {
      const m = req.jsonrpc?.method;
      if (m === "suix_getCoins")
        return { result: { data: [{ coinObjectId: "0xcoin1" }] } };
      if (m === "unsafe_paySui") return { result: { txBytes: "AAA=" } };
      if (m === "sui_dryRunTransactionBlock")
        return { result: suiDryRunResponse };
      throw new Error(`unexpected ${m}`);
    };
    const r = await simulate(suiIntent, transport);
    expect(r.chain).toBe("sui");
    expect(r.success).toBe(true);
    expect(r.balanceChanges).toHaveLength(2);
  });

  test("surfaces a missing-coins condition as SimulationError", async () => {
    const transport: kinetics.Transport = async (req) =>
      req.jsonrpc?.method === "suix_getCoins"
        ? { result: { data: [] } }
        : { result: {} };
    await expect(simulate(suiIntent, transport)).rejects.toThrow(
      SimulationError,
    );
  });

  test("surfaces an RPC error envelope with a string message", async () => {
    const transport = async () => ({
      error: { code: -32000, message: "boom" },
    });
    await expect(simulate(suiIntent, transport)).rejects.toThrow(/boom/);
  });

  test("rejects a non-object RPC response", async () => {
    await expect(simulate(suiIntent, async () => "not-json")).rejects.toThrow(
      /malformed Sui RPC response/,
    );
  });

  test("stringifies a non-string RPC error", async () => {
    await expect(
      simulate(suiIntent, async () => ({ error: { code: -1 } })),
    ).rejects.toThrow(/Sui RPC error/);
  });

  test("errors when the builder returns no transaction bytes", async () => {
    const transport: kinetics.Transport = async (req) => {
      if (req.jsonrpc?.method === "suix_getCoins")
        return { result: { data: [{ coinObjectId: "0xc" }] } };
      return { result: {} };
    };
    await expect(simulate(suiIntent, transport)).rejects.toThrow(
      /did not return transaction bytes/,
    );
  });

  test("treats an unusable coin list as no coins", async () => {
    await expect(
      simulate(suiIntent, async () => ({ result: "not-an-object" })),
    ).rejects.toThrow(SimulationError);
    await expect(
      simulate(suiIntent, async () => ({ result: {} })),
    ).rejects.toThrow(SimulationError);
  });

  test("skips coin entries that are not valid object references", async () => {
    const transport: kinetics.Transport = async (req) => {
      const m = req.jsonrpc?.method;
      if (m === "suix_getCoins")
        return {
          result: {
            data: ["not-an-object", { notId: 1 }, { coinObjectId: "0xc" }],
          },
        };
      if (m === "unsafe_paySui") return { result: { txBytes: "AAA=" } };
      if (m === "sui_dryRunTransactionBlock")
        return { result: suiDryRunResponse };
      throw new Error(`unexpected ${m}`);
    };
    const r = await simulate(suiIntent, transport);
    expect(r.success).toBe(true);
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

describe("simulate() — Aptos / Movement", () => {
  const transport: kinetics.Transport = async (req) => {
    const p = req.rest?.path;
    if (p === "/accounts/0xA")
      return { sequence_number: "7", authentication_key: "0xauth" };
    if (p === "/accounts/0xA/transactions")
      return [
        { signature: { type: "ed25519_signature", public_key: "0xPUB" } },
      ];
    if (p === "/transactions/simulate") return aptosSimResponse;
    throw new Error(`unexpected ${p}`);
  };

  test("runs account -> pubkey -> simulate and parses the result", async () => {
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

  test("missing account raises SimulationError", async () => {
    const empty = async () => ({});
    await expect(simulate(aptosIntent, empty)).rejects.toThrow(SimulationError);
  });

  test("errors when the sender's public key cannot be recovered", async () => {
    const noKey: kinetics.Transport = async (req) => {
      if (req.rest?.path === "/accounts/0xA")
        return { sequence_number: "1", authentication_key: "0x0" };
      if (req.rest?.path === "/accounts/0xA/transactions") return [];
      return {};
    };
    await expect(simulate(aptosIntent, noKey)).rejects.toThrow(/public key/);
  });

  test("rejects an unsupported chain", async () => {
    const bad = { ...suiIntent, chain: "solana" };
    await expect(
      simulate(bad as unknown as kinetics.SimulationIntent, async () => ({})),
    ).rejects.toThrow(/unsupported chain/);
  });
});
