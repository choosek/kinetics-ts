/**
 * Coverage-completing unit tests.
 *
 * These exercise the source encodings, command kinds, effect shapes, and
 * defensive fallbacks that the functional suites in `kinetics.test.ts` and
 * `movevm.test.ts` do not reach: GraphQL argument/input encodings, positional
 * command bodies, the `MakeMoveVec`/`Publish`/`Upgrade` commands, the several
 * gas and object-change effect shapes, and the account-model edge cases
 * (payload kinds, write-set categories, balance-event field variants, and
 * numeric coercion). Each test targets a specific branch or line so that the
 * analyzers are covered in full, not merely on their common paths.
 */

import { describe, expect, test } from "vitest";
import * as kinetics from "#/lib";

/* ======================================================================== */
/* PTB analyzer (lib.ts)                                                     */
/* ======================================================================== */

describe("PTB argument source encodings", () => {
  test("object and GraphQL gas-coin encodings all normalize to Gas", () => {
    const block = {
      inputs: [],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "f",
            arguments: [
              { GasCoin: {} },
              { kind: "GasCoin" },
              { __typename: "GasCoin" },
            ],
          },
        },
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock;
    const a = kinetics.analyzePtb(block);
    expect(a.commands[0].inputs.map((i) => i.kind)).toEqual([
      kinetics.ArgumentKind.Gas,
      kinetics.ArgumentKind.Gas,
      kinetics.ArgumentKind.Gas,
    ]);
  });

  test("GraphQL typed input and result nodes normalize correctly", () => {
    const block = {
      inputs: [{ type: "object", objectId: "0xa" }],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "a",
            arguments: [],
          },
        },
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "b",
            arguments: [
              { __typename: "Input", ix: 0 }, // input via typename
              { ix: 3 }, // input via presence of ix
              { __typename: "TxResult", cmd: 0 }, // result (no component index)
              { __typename: "TxResult", cmd: 0, ix: 2 }, // nested result (component index)
            ],
          },
        },
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock;
    const a = kinetics.analyzePtb(block);
    const args = a.commands[1].inputs;
    expect(args.map((i) => i.kind)).toEqual([
      kinetics.ArgumentKind.Input,
      kinetics.ArgumentKind.Input,
      kinetics.ArgumentKind.Result,
      kinetics.ArgumentKind.NestedResult,
    ]);
    expect(args[1].index).toBe(3);
    expect(args[2].index).toBe(0);
    expect(args[3].index).toBe(0);
    expect((args[3] as { sub?: number }).sub).toBe(2);
  });

  test("unrecognized, malformed, and wrong-arity arguments are dropped", () => {
    const block = {
      inputs: [],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "f",
            arguments: [
              { foo: 1 }, // no recognized key, no ix
              true, // neither object nor number
              { NestedResult: [1] }, // pair not of length two
            ],
          },
        },
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock;
    const a = kinetics.analyzePtb(block);
    expect(a.commands[0].inputs.length).toBe(0);
  });

  test("type arguments accept strings, repr nodes, and stringify anything else", () => {
    const block = {
      inputs: [],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "f",
            typeArguments: ["0x2::sui::SUI", { repr: "0x3::u::U" }, 42],
            arguments: [],
          },
        },
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock;
    const a = kinetics.analyzePtb(block);
    expect(a.commands[0].detail.typeArguments).toEqual([
      "0x2::sui::SUI",
      "0x3::u::U",
      "42",
    ]);
  });

  test("MoveCall function-name aliases are accepted", () => {
    const b1 = kinetics.analyzePtb({
      inputs: [],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            functionName: "f",
            arguments: [],
          },
        },
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock);
    expect(b1.commands[0].detail.function).toBe("f");

    const b2 = kinetics.analyzePtb({
      inputs: [],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function_name: "g",
            arguments: [],
          },
        },
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock);
    expect(b2.commands[0].detail.function).toBe("g");
  });
});

describe("positional command bodies and the remaining command kinds", () => {
  test("split, merge, and transfer accept positional array bodies", () => {
    const block = {
      inputs: [
        { type: "pure", value: "1" },
        { type: "object", objectId: "0xc" },
        { type: "address", value: "0xr" },
      ],
      transactions: [
        { SplitCoins: ["GasCoin", [{ Input: 0 }]] },
        { MergeCoins: [{ Input: 1 }, [{ Result: 0 }]] },
        { TransferObjects: [[{ Result: 0 }], { Input: 2 }] },
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock;
    const a = kinetics.analyzePtb(block);
    expect(a.commands[0].kind).toBe(kinetics.CommandKind.SplitCoins);
    expect(a.commands[0].inputs[0].kind).toBe(kinetics.ArgumentKind.Gas);
    expect(a.commands[0].detail.splitCount).toBe(1);
    expect(a.commands[1].kind).toBe(kinetics.CommandKind.MergeCoins);
    expect(a.commands[1].detail.mergeCount).toBe(1);
    expect(a.commands[2].kind).toBe(kinetics.CommandKind.TransferObjects);
    expect(a.commands[2].detail.objectCount).toBe(1);
  });

  test("MakeMoveVec, Publish, and Upgrade are recognized (named and positional)", () => {
    const block = {
      inputs: [{ type: "object", objectId: "0xo" }],
      transactions: [
        { MakeMoveVec: { type: "0x2::coin::Coin", elements: [{ Input: 0 }] } },
        { MakeMoveVec: ["0x2::coin::Coin", [{ Input: 0 }]] }, // elements positional at index 1
        { Publish: {} },
        { Upgrade: [[], "0xpkg", { Result: 2 }] }, // ticket positional at index 2
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock;
    const a = kinetics.analyzePtb(block);

    expect(a.commands[0].kind).toBe(kinetics.CommandKind.MakeMoveVec);
    expect(a.commands[0].detail.elementCount).toBe(1);
    expect(a.commands[0].detail.elemType).toBe("0x2::coin::Coin");
    expect(a.commands[1].kind).toBe(kinetics.CommandKind.MakeMoveVec);
    expect(a.commands[1].detail.elementCount).toBe(1);
    expect(a.commands[2].kind).toBe(kinetics.CommandKind.Publish);
    expect(a.commands[3].kind).toBe(kinetics.CommandKind.Upgrade);
    expect(a.commands[3].inputs.length).toBe(1); // the upgrade ticket

    // The command labels for these kinds are produced while building the graph.
    const labels = a.graph.nodes
      .filter((n) => n.kind === "command")
      .map((n) => (n as { label?: string }).label ?? "");
    expect(labels.some((l) => l.startsWith("MakeMoveVec"))).toBe(true);
    expect(labels).toContain("Publish");
    expect(labels).toContain("Upgrade");
  });

  test("an upgrade without a ticket has no inputs", () => {
    const a = kinetics.analyzePtb({
      inputs: [],
      transactions: [{ Upgrade: {} }],
    } as unknown as kinetics.ProgrammableTransactionBlock);
    expect(a.commands[0].kind).toBe(kinetics.CommandKind.Upgrade);
    expect(a.commands[0].inputs.length).toBe(0);
  });

  test("unconsumed Publish and Upgrade results are flagged as dangling", () => {
    const a = kinetics.analyzePtb({
      inputs: [{ type: "object", objectId: "0xo" }],
      transactions: [
        { MakeMoveVec: { elements: [{ Input: 0 }] } }, // produces a value, but not a tracked resource
        { Publish: {} }, // upgrade capability / package: a tracked resource
        { Upgrade: {} }, // a tracked resource
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock);
    // Publish and Upgrade produce resources nothing consumes; MakeMoveVec's
    // result is conventionally consumed in-block and is not counted here.
    expect(a.resources.dangling.length).toBe(2);
  });
});

describe("dataflow graph input-node encodings", () => {
  test("object, pure, and GraphQL input shapes are each handled", () => {
    const block = {
      inputs: [
        { __typename: "OwnedOrImmutable" }, // object via GraphQL marker only
        { valueType: "u64", value: "7" }, // valueType fallback (no type)
        { objectId: "0xbare" }, // object via objectId (no type)
        {}, // neither -> pure, value null
      ],
      transactions: [],
    } as unknown as kinetics.ProgrammableTransactionBlock;
    const a = kinetics.analyzePtb(block);
    const nodes = a.graph.nodes.filter((n) => n.kind === "input") as Array<{
      valueType?: string;
      value: unknown;
    }>;
    expect(nodes[0].valueType).toBe("object");
    expect(nodes[0].value).toBeNull();
    expect(nodes[1].valueType).toBe("u64");
    expect(nodes[1].value).toBe("7");
    expect(nodes[2].valueType).toBe("object");
    expect(nodes[2].value).toBe("0xbare");
    expect(nodes[3].valueType).toBe("pure");
    expect(nodes[3].value).toBeNull();
  });
});

describe("gas extraction across effect shapes", () => {
  test("the gasEffects.gasUsed shape is read", () => {
    const g = kinetics.extractGas({
      gasEffects: {
        gasUsed: { computationCost: "3", storageCost: "4", storageRebate: "1" },
      },
    } as unknown as kinetics.Effects);
    expect(g.net).toBe(6);
  });

  test("the top-level gasSummary shape is read", () => {
    const g = kinetics.extractGas({
      gasSummary: {
        computationCost: "10",
        storageCost: "5",
        storageRebate: "2",
      },
    } as unknown as kinetics.Effects);
    expect(g.net).toBe(13);
  });

  test("snake_case fields and the non-refundable fee are read", () => {
    const g = kinetics.extractGas({
      gasUsed: {
        computation_cost: "2",
        storage_cost: "3",
        storage_rebate: "1",
        non_refundable_storage_fee: "5",
      },
    } as unknown as kinetics.Effects);
    expect(g.computation).toBe(2);
    expect(g.storage).toBe(3);
    expect(g.rebate).toBe(1);
    expect(g.nonRefundable).toBe(5);
    expect(g.net).toBe(4);
  });

  test("an effects object without any gas fields yields zero", () => {
    expect(kinetics.extractGas({} as kinetics.Effects).net).toBe(0);
  });

  test("mistToSui accepts a bigint quantity", () => {
    expect(kinetics.mistToSui(1_000_000_000n)).toBe("1.000000000");
  });
});

describe("object-change extraction", () => {
  test("null effects yield empty change sets", () => {
    const c = kinetics.extractObjectChanges(null);
    expect(c.created.length + c.mutated.length + c.deleted.length).toBe(0);
    expect(c.wrapped.length + c.unwrapped.length).toBe(0);
  });

  test("wrapped and unwrapped arrays are carried through", () => {
    const c = kinetics.extractObjectChanges({
      wrapped: [{ objectId: "0xw" }],
      unwrapped: [{ objectId: "0xu" }],
    } as unknown as kinetics.Effects);
    expect(c.wrapped.length).toBe(1);
    expect(c.unwrapped.length).toBe(1);
  });

  test("GraphQL nodes are classified by input/output state", () => {
    const c = kinetics.extractObjectChanges({
      objectChanges: {
        nodes: [
          { outputState: {} }, // created: output without input
          { inputState: {} }, // deleted: input without output
          { inputState: {}, outputState: {} }, // mutated: both
        ],
      },
    } as unknown as kinetics.Effects);
    expect(c.created.length).toBe(1);
    expect(c.deleted.length).toBe(1);
    expect(c.mutated.length).toBe(1);
  });
});

describe("PTB structural fallbacks", () => {
  test("a block with neither transactions nor commands has no commands", () => {
    const a = kinetics.analyzePtb({
      inputs: [],
    } as unknown as kinetics.ProgrammableTransactionBlock);
    expect(a.summary.commandCount).toBe(0);
  });
});

/* ======================================================================== */
/* Move VM analyzer (movevm.ts)                                             */
/* ======================================================================== */

/** Build a minimal entry-function transaction, overriding fields as needed. */
function moveTx(over: Record<string, unknown> = {}): kinetics.MoveTransaction {
  return {
    type: "user_transaction",
    sender: "0xs",
    payload: {
      type: "entry_function_payload",
      function: "0x1::m::f",
      type_arguments: [],
      arguments: [],
    },
    ...over,
  } as unknown as kinetics.MoveTransaction;
}

describe("Move numeric coercion and gas edges", () => {
  test("gas coercion handles bigint, non-finite number, and non-numeric string", () => {
    const a = kinetics.analyzeMoveTransaction(
      moveTx({
        gas_used: 5n,
        gas_unit_price: Number.NaN,
        max_gas_amount: "not-a-number",
      }),
    );
    expect(a.gas.gasUsed).toBe(5); // bigint -> Number
    expect(a.gas.gasUnitPrice).toBe(0); // NaN -> 0
    expect(a.gas.maxGasAmount).toBe(0); // unparseable string -> 0
    expect(a.gas.totalSubunits).toBe(0);
  });

  test("absent gas fields coerce to zero and max gas to null", () => {
    const a = kinetics.analyzeMoveTransaction(moveTx({ gas_used: "" }));
    expect(a.gas.gasUsed).toBe(0); // empty string -> 0
    expect(a.gas.gasUnitPrice).toBe(0); // undefined -> 0
    expect(a.gas.maxGasAmount).toBeNull(); // undefined -> null
  });

  test("coin conversion helpers handle bigint and custom decimals", () => {
    expect(kinetics.subunitsToCoin(100_000_000n)).toBe("1.00000000");
    expect(kinetics.subunitsToCoin(500, 2)).toBe("5.00");
    expect(kinetics.octasToApt(0)).toBe("0.00000000");
  });
});

describe("Move payload kinds and defaults", () => {
  test("a module-bundle payload is categorized as ModuleBundle", () => {
    const a = kinetics.analyzeMoveTransaction(
      moveTx({ payload: { type: "module_bundle_payload" } }),
    );
    expect(a.summary.payloadKind).toBe(kinetics.MovePayloadKind.ModuleBundle);
    expect(a.summary.functionId).toBeNull();
  });

  test("an unrecognized or missing payload is Unknown", () => {
    expect(
      kinetics.analyzeMoveTransaction(
        moveTx({ payload: { type: "brand_new" } }),
      ).summary.payloadKind,
    ).toBe(kinetics.MovePayloadKind.Unknown);
    expect(
      kinetics.analyzeMoveTransaction(moveTx({ payload: undefined })).summary
        .payloadKind,
    ).toBe(kinetics.MovePayloadKind.Unknown);
  });

  test("an entry function with an unparseable id yields a null function", () => {
    const a = kinetics.analyzeMoveTransaction(
      moveTx({
        payload: {
          type: "entry_function_payload",
          function: "0x1::onlymodule",
          type_arguments: [],
          arguments: [1, 2, 3],
        },
      }),
    );
    expect(a.summary.payloadKind).toBe(kinetics.MovePayloadKind.EntryFunction);
    expect(a.summary.functionId).toBeNull();
    expect(a.payload.function).toBeNull();
    expect(a.summary.argumentCount).toBe(3);
  });

  test("script byte size is null without bytecode and counts non-0x hex", () => {
    expect(
      kinetics.analyzeMoveTransaction(
        moveTx({
          payload: {
            type: "script_payload",
            code: {},
            type_arguments: [],
            arguments: [],
          },
        }),
      ).payload.scriptByteSize,
    ).toBeNull();
    expect(
      kinetics.analyzeMoveTransaction(
        moveTx({
          payload: {
            type: "script_payload",
            code: { bytecode: "abcd" },
            type_arguments: [],
            arguments: [],
          },
        }),
      ).payload.scriptByteSize,
    ).toBe(2);
    expect(
      kinetics.analyzeMoveTransaction(
        moveTx({
          payload: {
            type: "script_payload",
            code: { bytecode: "0x" },
            type_arguments: [],
            arguments: [],
          },
        }),
      ).payload.scriptByteSize,
    ).toBe(0);
  });

  test("defaults are applied and missing fields degrade cleanly", () => {
    const a = kinetics.analyzeMoveTransaction({
      payload: {
        type: "entry_function_payload",
        function: "0x1::m::f",
        type_arguments: [],
        arguments: [],
      },
    } as unknown as kinetics.MoveTransaction);
    expect(a.summary.chain).toBe("aptos");
    expect(a.summary.network).toBeNull();
    expect(a.gas.symbol).toBe("APT");
    expect(a.gas.decimals).toBe(8);
    expect(a.summary.txType).toBe("unknown");
    expect(a.summary.success).toBe(false);
    expect(a.summary.vmStatus).toBe("unknown");
    expect(a.sender).toBeNull();
    expect(a.hash).toBeNull();
    expect(a.timestampMicros).toBeNull();
    expect(a.summary.accountsTouched).toBe(0);
  });
});

describe("Move write-set categories", () => {
  test("module publishes, deletes, table items, and unknown kinds are counted", () => {
    const a = kinetics.analyzeMoveTransaction(
      moveTx({
        sender: "0xpub",
        payload: {
          type: "entry_function_payload",
          function: "0xpkg::mod::run",
          type_arguments: [],
          arguments: [],
        },
        changes: [
          {
            type: "write_module",
            address: "0xpkg",
            data: { abi: { name: "mod" } },
          },
          { type: "write_module", address: "0xpkg2", data: {} }, // no abi.name
          {
            type: "delete_resource",
            address: "0xacc",
            data: { type: "0xpkg::mod::Thing" },
          },
          { type: "delete_module", address: "0xpkg3", data: {} },
          { type: "write_table_item", handle: "0xh", data: {} },
          { type: "write_resource", address: "0xr", data: {} }, // no data.type
          { type: "weird_change", address: "0xw" }, // unknown kind
          { address: "0xno_type" }, // no `type` discriminant
        ],
      }),
    );
    expect(a.writeset.modulesPublished).toContain("0xpkg::mod");
    expect(a.writeset.modulesPublished).toContain("0xpkg2");
    expect(a.writeset.counts[kinetics.MoveChangeKind.WriteModule]).toBe(2);
    expect(a.writeset.counts[kinetics.MoveChangeKind.DeleteResource]).toBe(1);
    expect(a.writeset.counts[kinetics.MoveChangeKind.DeleteModule]).toBe(1);
    expect(a.writeset.counts[kinetics.MoveChangeKind.WriteTableItem]).toBe(1);
    expect(a.writeset.counts[kinetics.MoveChangeKind.Unknown]).toBe(2);
    expect(a.writeset.resourceTypes).toContain("0xpkg::mod::Thing");
    expect(a.packages).toContain("0xpkg");
  });
});

describe("Move events and balance movements", () => {
  test("events without a module or type, and asset events without an amount", () => {
    const a = kinetics.analyzeMoveTransaction(
      moveTx({
        events: [
          { type: "PlainEvent", data: {} }, // no "::" -> module null
          { data: { amount: "1" } }, // no type -> skipped
          { type: "0x1::coin::WithdrawEvent", data: {} }, // recognized but no amount
        ],
      }),
    );
    expect(a.events.find((e) => e.type === "PlainEvent")?.module).toBeNull();
    expect(a.summary.eventCount).toBe(3);
    expect(a.balanceChanges).toHaveLength(0);
  });

  test("balance movements resolve account and asset from varied event shapes", () => {
    const a = kinetics.analyzeMoveTransaction(
      moveTx({
        events: [
          {
            type: "0x1::coin::CoinWithdraw",
            data: {
              account: "0xA",
              coin_type: "0x1::aptos_coin::AptosCoin",
              amount: "10",
            },
          },
          {
            type: "0x1::fungible_asset::Withdraw",
            data: { owner: "0xB", store: "0xstore", amount: "20" },
          },
          {
            type: "0x1::fungible_asset::Deposit",
            data: { store: "0xC", amount: "30" },
          },
          {
            type: "0x1::coin::CoinDeposit",
            data: { metadata: "0x1::x::Y", account: "0xD", amount: "40" },
          },
          { type: "0x1::coin::DepositEvent", data: { amount: "50" } }, // no account fields
        ],
      }),
    );
    const by = Object.fromEntries(a.balanceChanges.map((b) => [b.amount, b]));
    expect(by["10"].account).toBe("0xA");
    expect(by["10"].asset).toBe("0x1::aptos_coin::AptosCoin"); // explicit coin_type
    expect(by["10"].symbol).toBe("AptosCoin");
    expect(by["10"].direction).toBe(kinetics.BalanceDirection.Out);
    expect(by["20"].account).toBe("0xB"); // owner
    expect(by["20"].asset).toBe("0xstore"); // store fallback
    expect(by["20"].symbol).toBeNull();
    expect(by["30"].account).toBe("0xC"); // store as account
    expect(by["30"].direction).toBe(kinetics.BalanceDirection.In);
    expect(by["40"].asset).toBe("0x1::x::Y"); // metadata (explicit)
    expect(by["50"].account).toBe("unknown"); // no account fields, no guid
    // The "unknown" account is excluded from the touched-accounts set.
    expect(a.accounts).not.toContain("unknown");
  });

  test("a malformed CoinStore type does not resolve a coin", () => {
    const a = kinetics.analyzeMoveTransaction(
      moveTx({
        events: [
          {
            type: "0x1::coin::WithdrawEvent",
            guid: { account_address: "0xs" },
            data: { amount: "5" },
          },
        ],
        changes: [
          {
            type: "write_resource",
            address: "0xs",
            data: { type: "0x1::coin::CoinStore<broken" },
          },
          { type: "write_resource", address: "0xs2", data: {} }, // no data.type
        ],
      }),
    );
    expect(a.balanceChanges[0].asset).toBe("coin"); // unresolved
    expect(a.balanceChanges[0].symbol).toBeNull();
  });
});

/* ======================================================================== */
/* Post-refactor gaps: the split into suiptb.ts + movevm.ts duplicated the   */
/* small defensive helpers, so a few branches now need to be exercised in    */
/* each file (bigint coercion, string coercion) plus a handful of PTB guards. */
/* ======================================================================== */

describe("PTB numeric, argument, and command guards", () => {
  test("a bigint argument index is coerced via Number()", () => {
    const a = kinetics.analyzePtb({
      inputs: [],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "f",
            arguments: [{ Input: 3n }],
          },
        },
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock);
    expect(a.commands[0].inputs[0].kind).toBe(kinetics.ArgumentKind.Input);
    expect(a.commands[0].inputs[0].index).toBe(3);
  });

  test("a MoveCall with no arguments field yields no inputs", () => {
    const a = kinetics.analyzePtb({
      inputs: [],
      transactions: [
        { MoveCall: { package: "0x1", module: "m", function: "f" } },
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock);
    expect(a.commands[0].kind).toBe(kinetics.CommandKind.MoveCall);
    expect(a.commands[0].inputs.length).toBe(0);
  });

  test("a non-object command normalizes to Unknown", () => {
    const a = kinetics.analyzePtb({
      inputs: [],
      transactions: [42],
    } as unknown as kinetics.ProgrammableTransactionBlock);
    expect(a.summary.commandCount).toBe(1);
    expect(a.commands[0].kind).toBe(kinetics.CommandKind.Unknown);
  });

  test("MakeMoveVec reads the objects alias and falls back to an empty vector", () => {
    const a = kinetics.analyzePtb({
      inputs: [{ type: "object", objectId: "0xo" }],
      transactions: [
        { MakeMoveVec: { objects: [{ Input: 0 }] } }, // objects alias
        { MakeMoveVec: { type: "0x2::coin::Coin" } }, // no elements/objects -> []
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock);
    expect(a.commands[0].kind).toBe(kinetics.CommandKind.MakeMoveVec);
    expect(a.commands[0].detail.elementCount).toBe(1);
    expect(a.commands[1].detail.elementCount).toBe(0);
  });

  test("objectChanges supplied as a bare array (JSON-RPC shape) is read", () => {
    const c = kinetics.extractObjectChanges({
      objectChanges: [{ idCreated: true }],
    } as unknown as kinetics.Effects);
    expect(c.created.length).toBe(1);
  });
});

describe("Move value coercion", () => {
  test("a numeric event amount is stringified", () => {
    const a = kinetics.analyzeMoveTransaction(
      moveTx({
        events: [
          {
            type: "0x1::coin::WithdrawEvent",
            guid: { account_address: "0xs" },
            data: { amount: 1000 },
          },
        ],
      }),
    );
    expect(a.balanceChanges[0].amount).toBe("1000");
  });
});

describe("Move payload defensive branches", () => {
  test("an entry function with no function field yields a null function", () => {
    const a = kinetics.analyzeMoveTransaction(
      moveTx({
        payload: {
          type: "entry_function_payload",
          type_arguments: [],
          arguments: [],
        },
      }),
    );
    expect(a.summary.payloadKind).toBe(kinetics.MovePayloadKind.EntryFunction);
    expect(a.summary.functionId).toBeNull();
  });

  test("a multisig payload without an address reports undefined", () => {
    const a = kinetics.analyzeMoveTransaction(
      moveTx({
        payload: {
          type: "multisig_payload",
          transaction_payload: {
            type: "entry_function_payload",
            function: "0xdead::vault::withdraw",
            type_arguments: [],
            arguments: [],
          },
        },
      }),
    );
    expect(a.summary.payloadKind).toBe(kinetics.MovePayloadKind.Multisig);
    expect(a.payload.multisigAddress).toBeUndefined();
  });
});

describe("PTB command-body and criticalPath fallbacks", () => {
  test("malformed and empty command bodies fall back without throwing", () => {
    const a = kinetics.analyzePtb({
      inputs: [{ type: "pure", value: "1" }],
      transactions: [
        { SplitCoins: { coin: "GasCoin" } }, // no amounts -> [] and splitCount ||1
        { SplitCoins: { coin: "GasCoin", amounts: 5 } }, // non-array amounts -> []
        { MergeCoins: { destination: { Input: 0 } } }, // no sources -> []
        { MergeCoins: { destination: { Input: 0 }, sources: 7 } }, // non-array sources -> []
        { TransferObjects: { address: { Input: 0 } } }, // no objects -> []
        { TransferObjects: { objects: 9, address: { Input: 0 } } }, // non-array objects -> []
        { MakeMoveVec: { elements: 3 } }, // non-array elements -> []
        { MoveCall: { package: "0x1" } }, // no module/function -> label "?::?"
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock);

    expect(a.commands[0].detail.splitCount).toBe(1);
    expect(a.commands[1].detail.splitCount).toBe(1);
    expect(a.commands[2].detail.mergeCount).toBe(0);
    expect(a.commands[3].detail.mergeCount).toBe(0);
    expect(a.commands[4].detail.objectCount).toBe(0);
    expect(a.commands[5].detail.objectCount).toBe(0);
    expect(a.commands[6].detail.elementCount).toBe(0);
    expect(a.commands[7].kind).toBe(kinetics.CommandKind.MoveCall);

    const labels = a.graph.nodes
      .filter((n) => n.kind === "command")
      .map((n) => (n as { label?: string }).label);
    expect(labels).toContain("?::?");
  });

  test("out-of-range result references and missing inputs degrade gracefully", () => {
    const a = kinetics.analyzePtb({
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "a",
            arguments: [{ Result: 99 }], // references a command that does not exist
          },
        },
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock);
    expect(a.summary.commandCount).toBe(1);
    expect(a.critical.length).toBeGreaterThanOrEqual(1);
  });
});
