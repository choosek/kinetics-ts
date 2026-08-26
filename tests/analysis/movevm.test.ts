/**
 * Functional unit tests for the Move VM (Aptos/Movement) transaction analyzer.
 * These mirror the account-model shape returned by the Aptos REST API and check
 * payload decoding, event/balance derivation (including coin-type recovery from
 * the write-set), write-set accounting, and gas attribution.
 */

import { describe, expect, test } from "vitest";
import * as kinetics from "#/lib";

/**
 * A representative Aptos batch transfer: the sender pays two recipients from a
 * single AptosCoin store. Each account has exactly one CoinStore, so every
 * balance movement's coin type is recoverable from the write-set.
 */
function batchTransfer(): kinetics.MoveTransaction {
  return {
    type: "user_transaction",
    hash: "0xdemo",
    sender: "0xsender",
    sequence_number: "128",
    max_gas_amount: "20000",
    gas_unit_price: "100",
    gas_used: "2412",
    success: true,
    vm_status: "Executed successfully",
    payload: {
      type: "entry_function_payload",
      function: "0x1::aptos_account::batch_transfer",
      type_arguments: [],
      arguments: [
        ["0xrec1", "0xrec2"],
        ["300000000", "150000000"],
      ],
    },
    events: [
      {
        guid: { account_address: "0xsender" },
        type: "0x1::coin::WithdrawEvent",
        data: { amount: "300000000" },
      },
      {
        guid: { account_address: "0xrec1" },
        type: "0x1::coin::DepositEvent",
        data: { amount: "300000000" },
      },
      {
        guid: { account_address: "0xsender" },
        type: "0x1::coin::WithdrawEvent",
        data: { amount: "150000000" },
      },
      {
        guid: { account_address: "0xrec2" },
        type: "0x1::coin::DepositEvent",
        data: { amount: "150000000" },
      },
    ],
    changes: [
      {
        type: "write_resource",
        address: "0xsender",
        data: {
          type: "0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>",
          data: { coin: { value: "5499550000" } },
        },
      },
      {
        type: "write_resource",
        address: "0xrec1",
        data: {
          type: "0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>",
          data: { coin: { value: "300000000" } },
        },
      },
      {
        type: "write_resource",
        address: "0xrec2",
        data: {
          type: "0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>",
          data: { coin: { value: "150000000" } },
        },
      },
      {
        type: "write_resource",
        address: "0xsender",
        data: {
          type: "0x1::account::Account",
          data: { sequence_number: "129" },
        },
      },
    ],
  };
}

describe("analyzeMoveTransaction — entry function", () => {
  const a = kinetics.analyzeMoveTransaction(batchTransfer(), {
    chain: "aptos",
    network: "mainnet",
    symbol: "APT",
    decimals: 8,
  });

  test("decodes the entry-function payload", () => {
    expect(a.summary.payloadKind).toBe(kinetics.MovePayloadKind.EntryFunction);
    expect(a.summary.functionId).toBe("0x1::aptos_account::batch_transfer");
    expect(a.payload.function?.module).toBe("aptos_account");
    expect(a.payload.function?.name).toBe("batch_transfer");
    expect(a.summary.argumentCount).toBe(2);
  });

  test("summarizes events and changes", () => {
    expect(a.summary.eventCount).toBe(4);
    expect(a.summary.changeCount).toBe(4);
    expect(a.writeset.resourceTypes).toContain("0x1::account::Account");
  });

  test("derives directional balance movements with resolved coin types", () => {
    expect(a.balanceChanges).toHaveLength(4);
    expect(
      a.balanceChanges.filter(
        (b) => b.direction === kinetics.BalanceDirection.Out,
      ),
    ).toHaveLength(2);
    expect(
      a.balanceChanges.filter(
        (b) => b.direction === kinetics.BalanceDirection.In,
      ),
    ).toHaveLength(2);
    for (const b of a.balanceChanges) {
      expect(b.symbol).toBe("AptosCoin");
      expect(b.asset).toBe("0x1::aptos_coin::AptosCoin");
    }
  });

  test("attributes gas and touched sets", () => {
    expect(a.gas.totalSubunits).toBe(2412 * 100);
    expect(a.gas.symbol).toBe("APT");
    expect(kinetics.octasToApt(a.gas.totalSubunits)).toBe("0.00241200");
    expect(a.summary.accountsTouched).toBe(3);
    expect(a.summary.packagesTouched).toBe(1);
    expect(a.packages).toContain("0x1");
  });
});

describe("analyzeMoveTransaction — other payloads and edge cases", () => {
  test("handles a script payload", () => {
    const tx: kinetics.MoveTransaction = {
      type: "user_transaction",
      sender: "0xs",
      gas_used: "100",
      gas_unit_price: "100",
      success: true,
      vm_status: "Executed successfully",
      payload: {
        type: "script_payload",
        code: { bytecode: "0xa11ceb0b0600000000" },
        type_arguments: ["0x1::aptos_coin::AptosCoin"],
        arguments: ["42"],
      },
      events: [],
      changes: [],
    };
    const a = kinetics.analyzeMoveTransaction(tx, {
      chain: "movement",
      symbol: "MOVE",
    });
    expect(a.summary.payloadKind).toBe(kinetics.MovePayloadKind.Script);
    expect(a.summary.functionId).toBeNull();
    expect(a.payload.scriptByteSize).toBe(9);
    expect(a.summary.typeArgCount).toBe(1);
  });

  test("unwraps a multisig payload's inner function", () => {
    const tx: kinetics.MoveTransaction = {
      type: "user_transaction",
      sender: "0xs",
      gas_used: "10",
      gas_unit_price: "100",
      success: true,
      vm_status: "Executed successfully",
      payload: {
        type: "multisig_payload",
        multisig_address: "0xmultisig",
        transaction_payload: {
          type: "entry_function_payload",
          function: "0xdead::vault::withdraw",
          type_arguments: [],
          arguments: ["1000"],
        },
      },
    };
    const a = kinetics.analyzeMoveTransaction(tx);
    expect(a.summary.payloadKind).toBe(kinetics.MovePayloadKind.Multisig);
    expect(a.summary.functionId).toBe("0xdead::vault::withdraw");
    expect(a.payload.multisigAddress).toBe("0xmultisig");
  });

  test("leaves the coin type unresolved when the store is ambiguous", () => {
    // Two CoinStores under the same account → attribution is ambiguous, so the
    // coin type cannot be recovered and falls back to a generic marker.
    const tx: kinetics.MoveTransaction = {
      type: "user_transaction",
      sender: "0xs",
      gas_used: "10",
      gas_unit_price: "100",
      success: true,
      vm_status: "Executed successfully",
      payload: {
        type: "entry_function_payload",
        function: "0xdex::router::swap",
        type_arguments: [],
        arguments: [],
      },
      events: [
        {
          guid: { account_address: "0xs" },
          type: "0x1::coin::WithdrawEvent",
          data: { amount: "100" },
        },
      ],
      changes: [
        {
          type: "write_resource",
          address: "0xs",
          data: {
            type: "0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>",
            data: {},
          },
        },
        {
          type: "write_resource",
          address: "0xs",
          data: { type: "0x1::coin::CoinStore<0xf00d::usdc::USDC>", data: {} },
        },
      ],
    };
    const a = kinetics.analyzeMoveTransaction(tx);
    expect(a.balanceChanges).toHaveLength(1);
    expect(a.balanceChanges[0].asset).toBe("coin");
    expect(a.balanceChanges[0].symbol).toBeNull();
  });

  test("throws on non-object input", () => {
    // @ts-expect-error deliberately passing an invalid argument
    expect(() => kinetics.analyzeMoveTransaction(null)).toThrow(TypeError);
  });
});
