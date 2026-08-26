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
  buildSuiTransferKind,
  suiDryRunRequest,
  parseSuiDryRun,
  buildSenderSignature,
  aptosSimulateRequest,
  parseAptosSimulation,
  SimulationError,
} = kinetics;

const suiIntent = {
  kind: "transfer" as const,
  chain: "sui" as const,
  network: "mainnet" as const,
  sender: "0xSENDER",
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

describe("buildSuiTransferKind", () => {
  test("encodes the transfer PTB to exact BCS transaction-kind bytes", () => {
    // 0.001 SUI = 1_000_000 MIST; recipient 0x00..0002.
    const hex = Buffer.from(buildSuiTransferKind(suiIntent), "base64").toString(
      "hex",
    );
    const amount = Buffer.alloc(8);
    amount.writeBigUInt64LE(1_000_000n);
    const expected =
      "00" + //                 TransactionKind::ProgrammableTransaction
      "02" + //                 inputs: 2
      "0008" +
      amount.toString("hex") + //     Pure(u64 amount)
      "0020" +
      `${"00".repeat(31)}02` + //     Pure(address)
      "02" + //                 commands: 2
      "020001010000" + //       SplitCoins(GasCoin, [Input(0)])
      "01010300000000010100"; //TransferObjects([NestedResult(0,0)], Input(1))
    expect(hex).toBe(expected);
    // 63 bytes total => a whole number of base64 groups (no padding).
    expect(hex.length / 2).toBe(63);
  });

  test("left-pads short addresses and accepts a bare (non-0x) address", () => {
    const withPrefix = buildSuiTransferKind({ ...suiIntent, recipient: "0x2" });
    const without = buildSuiTransferKind({ ...suiIntent, recipient: "2" });
    expect(withPrefix).toBe(without);
    const hex = Buffer.from(withPrefix, "base64").toString("hex");
    expect(hex).toContain(`0020${"00".repeat(31)}02`);
  });

  test("rejects malformed recipient addresses", () => {
    expect(() =>
      buildSuiTransferKind({ ...suiIntent, recipient: "0xZZ" }),
    ).toThrow(/invalid address/);
    expect(() =>
      buildSuiTransferKind({ ...suiIntent, recipient: `0x${"a".repeat(66)}` }),
    ).toThrow(/invalid address/);
  });
});

describe("suiDryRunRequest", () => {
  test("is a GraphQL dry-run carrying the kind bytes and sender", () => {
    const req = suiDryRunRequest("KIND_B64", "0xSENDER");
    expect(req.chain).toBe("sui");
    expect(req.jsonrpc).toBeUndefined(); // no deprecated JSON-RPC
    expect(req.graphql?.query).toContain("dryRunTransactionBlock");
    expect(req.graphql?.query).toContain("balanceChanges");
    expect(req.graphql?.query).toContain("gasSummary");
    expect(req.graphql?.variables).toEqual({
      tx: "KIND_B64",
      sender: "0xSENDER",
    });
  });
});

describe("buildSenderSignature", () => {
  const allZero = (h: unknown) => typeof h === "string" && /^0x0+$/.test(h);
  const sig64 = `0x${"ab".repeat(64)}`;

  test("mirrors a legacy ed25519 signature, blanking only the bytes", () => {
    const s = buildSenderSignature([
      {
        signature: {
          type: "ed25519_signature",
          public_key: "0xPUB",
          signature: sig64,
        },
      },
    ]) as Record<string, unknown>;
    expect(s.type).toBe("ed25519_signature");
    expect(s.public_key).toBe("0xPUB"); // preserved
    expect(allZero(s.signature)).toBe(true); // blanked
    expect((s.signature as string).length).toBe(sig64.length); // same length
  });

  test("mirrors a single_sender / single_key authenticator (object key)", () => {
    const s = buildSenderSignature([
      {
        signature: {
          type: "single_sender",
          sender: {
            type: "single_key_signature",
            public_key: { type: "ed25519", value: "0xSK" },
            signature: { type: "ed25519", value: sig64 },
          },
        },
      },
    ]) as { type: string; sender: Record<string, unknown> };
    expect(s.type).toBe("single_sender");
    expect(s.sender.type).toBe("single_key_signature");
    expect((s.sender.public_key as Record<string, unknown>).value).toBe("0xSK");
    const inner = s.sender.signature as Record<string, unknown>;
    expect(inner.type).toBe("ed25519"); // signature type preserved
    expect(allZero(inner.value)).toBe(true); // signature value blanked
  });

  test("unwraps a fee-payer single_key sender into single_sender", () => {
    const s = buildSenderSignature([
      {
        signature: {
          type: "fee_payer_signature",
          sender: {
            type: "single_key_signature",
            public_key: { type: "secp256k1_ecdsa", value: "0xSECP" },
            signature: { type: "secp256k1_ecdsa", value: sig64 },
          },
          fee_payer_address: "0xFP",
          fee_payer_signer: {
            type: "ed25519_signature",
            public_key: "0xE",
            signature: sig64,
          },
        },
      },
    ]) as { type: string; sender: Record<string, unknown> };
    expect(s.type).toBe("single_sender");
    expect((s.sender.public_key as Record<string, unknown>).value).toBe(
      "0xSECP",
    );
    expect((s as Record<string, unknown>).fee_payer_address).toBeUndefined();
  });

  test("uses a fee-payer / multi-agent ed25519 sender directly", () => {
    const feePayer = buildSenderSignature([
      {
        signature: {
          type: "fee_payer_signature",
          sender: {
            type: "ed25519_signature",
            public_key: "0xED",
            signature: sig64,
          },
          fee_payer_address: "0xX",
        },
      },
    ]) as Record<string, unknown>;
    expect(feePayer.type).toBe("ed25519_signature");
    expect(feePayer.public_key).toBe("0xED");

    const multiAgent = buildSenderSignature([
      {
        signature: {
          type: "multi_agent_signature",
          sender: {
            type: "ed25519_signature",
            public_key: "0xMA",
            signature: sig64,
          },
          secondary_signer_addresses: ["0xS"],
          secondary_signers: [
            { type: "ed25519_signature", public_key: "0xS2", signature: sig64 },
          ],
        },
      },
    ]) as Record<string, unknown>;
    expect(multiAgent.type).toBe("ed25519_signature");
    expect(multiAgent.public_key).toBe("0xMA");
  });

  test("mirrors multi_ed25519 and a bare account authenticator", () => {
    const multi = buildSenderSignature([
      {
        signature: {
          type: "multi_ed25519_signature",
          public_keys: ["0xk1", "0xk2"],
          signatures: [sig64, sig64],
          threshold: 1,
          bitmap: "0x40000000",
        },
      },
    ]) as { signatures: string[] };
    expect(multi.signatures.every(allZero)).toBe(true);

    // A bare account authenticator at the top level (no `sender`, not a known
    // transaction-signature type) is wrapped in single_sender.
    const bare = buildSenderSignature([
      {
        signature: {
          type: "single_key_signature",
          public_key: { type: "ed25519", value: "0xBARE" },
          signature: { type: "ed25519", value: sig64 },
        },
      },
    ]) as { type: string; sender: Record<string, unknown> };
    expect(bare.type).toBe("single_sender");
    expect((bare.sender.public_key as Record<string, unknown>).value).toBe(
      "0xBARE",
    );
  });

  test("wraps a typeless nested sender and tolerates odd fields", () => {
    const noType = buildSenderSignature([
      { signature: { sender: { public_key: "0xN", signature: sig64 } } },
    ]) as { type: string };
    expect(noType.type).toBe("single_sender");

    // Non-hex string and null signature fields pass through untouched.
    const odd = buildSenderSignature([
      {
        signature: {
          type: "ed25519_signature",
          public_key: "0xP",
          signature: "not-hex",
        },
      },
    ]) as Record<string, unknown>;
    expect(odd.signature).toBe("not-hex");

    const nullSig = buildSenderSignature([
      {
        signature: {
          type: "ed25519_signature",
          public_key: "0xP",
          signature: null,
        },
      },
    ]) as Record<string, unknown>;
    expect(nullSig.signature).toBeNull();

    // An object signature whose `value` is not a string is left as-is.
    const numValue = buildSenderSignature([
      {
        signature: {
          type: "ed25519_signature",
          public_key: "0xP",
          signature: { type: "x", value: 5 },
        },
      },
    ]) as { signature: Record<string, unknown> };
    expect(numValue.signature.value).toBe(5);
  });

  test("returns null when no usable authenticator is present", () => {
    expect(buildSenderSignature([])).toBeNull();
    expect(buildSenderSignature([{ nope: true }, "x"])).toBeNull();
    expect(buildSenderSignature([{ signature: { foo: 1 } }])).toBeNull();
    expect(buildSenderSignature("not-an-array")).toBeNull();
  });
});

describe("aptosSimulateRequest", () => {
  test("carries the payload, estimate flags, and mirrored signature", () => {
    const signature = {
      type: "single_sender",
      sender: { type: "single_key_signature" },
    };
    const req = aptosSimulateRequest(aptosIntent, "7", signature);
    expect(req.rest?.method).toBe("POST");
    expect(req.rest?.path).toBe("/transactions/simulate");
    const body = req.rest?.body as Record<string, unknown>;
    expect(body.sequence_number).toBe("7");
    expect(body.signature).toEqual(signature);
    const payload = body.payload as Record<string, unknown>;
    expect(payload.function).toBe("0x1::aptos_account::transfer");
    expect(payload.arguments).toEqual(["0xB", "125000000"]);
    expect(req.rest?.query).toMatchObject({
      estimate_gas_unit_price: true,
      estimate_max_gas_amount: true,
    });
  });
});

// A representative GraphQL dryRunTransactionBlock response.
const suiDryRunResponse = {
  data: {
    dryRunTransactionBlock: {
      error: null,
      transaction: {
        effects: {
          status: "SUCCESS",
          errors: null,
          gasEffects: {
            gasSummary: {
              computationCost: "1000000",
              storageCost: "2588000",
              storageRebate: "978120",
              nonRefundableStorageFee: "9880",
            },
          },
          balanceChanges: {
            nodes: [
              {
                owner: { address: "0xSENDER" },
                amount: "-1002609880",
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
  },
};

describe("parseSuiDryRun", () => {
  test("normalizes gas, balance changes, and status", () => {
    const r = parseSuiDryRun(suiIntent, suiDryRunResponse);
    expect(r.success).toBe(true);
    expect(r.status).toBe("success");
    expect(r.error).toBeNull();
    // 1_000_000 + 2_588_000 - 978_120
    expect(r.gas.amountSubunits).toBe("2609880");
    expect(r.gas.formatted).toBe("0.002609880");
    expect(r.balanceChanges).toHaveLength(2);
    expect(r.balanceChanges[0]).toMatchObject({
      address: "0xSENDER",
      direction: "out",
      amount: "1002609880",
      symbol: "SUI",
      decimals: 9,
    });
    expect(r.balanceChanges[1].direction).toBe("in");
    expect(r.changeCount).toBe(2);
  });

  test("reports a failed dry-run with its abort reason", () => {
    const r = parseSuiDryRun(suiIntent, {
      data: {
        dryRunTransactionBlock: {
          transaction: {
            effects: { status: "FAILURE", errors: "MoveAbort(code 1)" },
          },
        },
      },
    });
    expect(r.success).toBe(false);
    expect(r.status).toBe("MoveAbort(code 1)");
    expect(r.error).toBe("MoveAbort(code 1)");
  });

  test("falls back to a generic failure when no error string is present", () => {
    const r = parseSuiDryRun(suiIntent, {
      data: {
        dryRunTransactionBlock: {
          transaction: { effects: { status: "FAILURE", errors: "" } },
        },
      },
    });
    expect(r.success).toBe(false);
    expect(r.status).toBe("failure");
    expect(r.error).toBe("failure");
  });

  test("surfaces GraphQL transport errors", () => {
    expect(() =>
      parseSuiDryRun(suiIntent, { errors: [{ message: "bad query" }] }),
    ).toThrow(/Sui GraphQL error: bad query/);
    // A non-object error entry is stringified.
    expect(() => parseSuiDryRun(suiIntent, { errors: ["boom"] })).toThrow(
      /Sui GraphQL error/,
    );
  });

  test("surfaces a dry-run-level error", () => {
    expect(() =>
      parseSuiDryRun(suiIntent, {
        data: { dryRunTransactionBlock: { error: "InsufficientGas" } },
      }),
    ).toThrow(/Sui dry-run error: InsufficientGas/);
  });

  test("tolerates empty errors, missing data, and odd balance nodes", () => {
    // Empty errors array + entirely missing data => defaults, read as failure.
    const empty = parseSuiDryRun(suiIntent, { errors: [] });
    expect(empty.success).toBe(false);
    expect(empty.status).toBe("failure");
    expect(empty.gas.amountSubunits).toBe("0");
    expect(empty.gas.formatted).toBe("0.000000000");
    expect(empty.balanceChanges).toEqual([]);
    expect(empty.changeCount).toBe(0);

    // Missing owner/coinType, a non-object node, and a non-numeric gas value.
    const odd = parseSuiDryRun(suiIntent, {
      data: {
        dryRunTransactionBlock: {
          error: "",
          transaction: {
            effects: {
              status: "SUCCESS",
              gasEffects: { gasSummary: { computationCost: "oops" } },
              balanceChanges: {
                nodes: [
                  null, // skipped (not an object)
                  { amount: "5" }, // no owner, no coinType
                  { coinType: { repr: 42 } }, // no amount -> "0"; repr not a string
                  { amount: "7", coinType: { repr: "0x5::usdc::USDC" } }, // non-SUI
                ],
              },
            },
          },
        },
      },
    });
    expect(odd.gas.amountSubunits).toBe("0"); // "oops" -> 0n
    expect(odd.balanceChanges).toHaveLength(3);
    expect(odd.balanceChanges[0].address).toBe("shared/immutable");
    expect(odd.balanceChanges[0].asset).toBe("0x2::sui::SUI");
    expect(odd.balanceChanges[0].amount).toBe("5");
    expect(odd.balanceChanges[1].amount).toBe("0"); // missing amount
    expect(odd.balanceChanges[1].asset).toBe("0x2::sui::SUI"); // repr ignored
    // non-SUI coin -> decimals come from the intent, not the SUI default
    expect(odd.balanceChanges[2].asset).toBe("0x5::usdc::USDC");
    expect(odd.balanceChanges[2].symbol).toBe("USDC");
    expect(odd.balanceChanges[2].decimals).toBe(9);
  });

  test("formats a negative net gas (storage rebate exceeds cost)", () => {
    const r = parseSuiDryRun(suiIntent, {
      data: {
        dryRunTransactionBlock: {
          transaction: {
            effects: {
              status: "SUCCESS",
              gasEffects: {
                gasSummary: { computationCost: "1000", storageRebate: "5000" },
              },
            },
          },
        },
      },
    });
    expect(r.gas.amountSubunits).toBe("-4000");
    expect(r.gas.formatted).toBe("-0.000004000");
  });

  test("throws on a non-object dry-run response", () => {
    expect(() => parseSuiDryRun(suiIntent, "nope")).toThrow(SimulationError);
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
  test("builds the kind, dry-runs over GraphQL, and parses", async () => {
    let sawGraphql = false;
    const transport: kinetics.Transport = async (req) => {
      sawGraphql = Boolean(req.graphql);
      expect(req.jsonrpc).toBeUndefined();
      expect(typeof req.graphql?.variables?.tx).toBe("string");
      return suiDryRunResponse;
    };
    const r = await simulate(suiIntent, transport);
    expect(sawGraphql).toBe(true);
    expect(r.chain).toBe("sui");
    expect(r.success).toBe(true);
    expect(r.gas.symbol).toBe("SUI");
    expect(r.balanceChanges[0].direction).toBe("out");
  });

  test("propagates a GraphQL error from the dry run", async () => {
    const transport: kinetics.Transport = async () => ({
      errors: [{ message: "unauthorized" }],
    });
    await expect(simulate(suiIntent, transport)).rejects.toThrow(
      /Sui GraphQL error: unauthorized/,
    );
  });
});

describe("simulate() — Aptos / Movement", () => {
  const transport: kinetics.Transport = async (req) => {
    const p = req.rest?.path;
    if (p === "/accounts/0xA")
      return { sequence_number: "7", authentication_key: "0xauth" };
    if (p === "/accounts/0xA/transactions")
      return [
        {
          signature: {
            type: "single_sender",
            sender: {
              type: "single_key_signature",
              public_key: { type: "ed25519", value: "0xREAL" },
              signature: { type: "ed25519", value: `0x${"ff".repeat(64)}` },
            },
          },
        },
      ];
    if (p === "/transactions/simulate") {
      // the node receives a mirrored single_sender authenticator, sig blanked
      const body = req.rest?.body as Record<string, unknown>;
      const s = body.signature as {
        type: string;
        sender: Record<string, unknown>;
      };
      expect(s.type).toBe("single_sender");
      const sv = (s.sender.signature as Record<string, unknown>)
        .value as string;
      expect(/^0x0+$/.test(sv)).toBe(true);
      return aptosSimResponse;
    }
    throw new Error(`unexpected ${p}`);
  };

  test("runs account -> mirror signature -> simulate and parses", async () => {
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

  test("errors when the sender's key cannot be recovered", async () => {
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
