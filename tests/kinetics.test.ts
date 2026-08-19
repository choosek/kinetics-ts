/**
 * Functional and structural unit tests for the PTB static analyzer.
 * Test suite containing functional unit tests for the exported analyses, as
 * well as unit tests confirming structural relationships (such as the
 * consistency of the dataflow graph with the critical-path decomposition and
 * the transitivity of taint propagation).
 */

import { describe, expect, test } from "vitest";
import * as kinetics from "#/lib";

/**
 * Number of MIST in one SUI, used to check gas conversions.
 */
const _MIST_PER_SUI: bigint = 10n ** 9n;

/**
 * A representative composed transaction used throughout the tests. It splits
 * the gas coin, swaps the resulting coin against a pool, independently claims a
 * reward from the same pool, merges the swap output into a user coin, and
 * transfers the reward to a recipient. Its dependency structure is known:
 * commands 0, 1, and 3 form the critical path, and command 2 is parallel to
 * commands 0 and 1.
 */
function composedBlock(): kinetics.ProgrammableTransactionBlock {
  return {
    inputs: [
      { type: "object", objectId: "0xpool" },
      { type: "object", objectId: "0xusercoin" },
      { type: "pure", valueType: "u64", value: "1000000" },
      { type: "pure", valueType: "address", value: "0xrecipient" },
    ],
    transactions: [
      { SplitCoins: { coin: "GasCoin", amounts: [{ Input: 2 }] } },
      {
        MoveCall: {
          package: "0xdex",
          module: "pool",
          function: "swap",
          arguments: [{ Input: 0 }, { Result: 0 }],
        },
      },
      {
        MoveCall: {
          package: "0xdex",
          module: "pool",
          function: "get_reward",
          arguments: [{ Input: 0 }],
        },
      },
      { MergeCoins: { destination: { Input: 1 }, sources: [{ Result: 1 }] } },
      { TransferObjects: { objects: [{ Result: 2 }], address: { Input: 3 } } },
    ],
  };
}

/**
 * Effects consistent with {@link composedBlock}: a successful status, a gas
 * summary, and an object-change set with one created and two mutated objects.
 */
function composedEffects(): kinetics.Effects {
  return {
    status: { status: "success" },
    gasUsed: {
      computationCost: "1000000",
      storageCost: "2960000",
      storageRebate: "1470000",
    },
    created: [{ objectId: "0xnew" }],
    mutated: [{ objectId: "0xpool" }, { objectId: "0xusercoin" }],
    deleted: [],
  };
}

/**
 * Construct a linear chain of the specified length: a split followed by a
 * sequence of Move calls, each consuming the previous command's result. The
 * critical path of such a block has length equal to the number of commands.
 */
function chainBlock(length: number): kinetics.ProgrammableTransactionBlock {
  const transactions: unknown[] = [
    { SplitCoins: { coin: "GasCoin", amounts: [{ Input: 0 }] } },
  ];
  for (let i = 1; i < length; i++) {
    transactions.push({
      MoveCall: {
        package: "0x1",
        module: "m",
        function: `f${i}`,
        arguments: [{ Result: i - 1 }],
      },
    });
  }
  return { inputs: [{ type: "pure", value: "1" }], transactions };
}

/**
 * Construct a block of the specified width in which every command depends only
 * on a single shared input and none depends on another command. The critical
 * path of such a block has length one, and its parallel-stage decomposition has
 * a single stage.
 */
function parallelBlock(width: number): kinetics.ProgrammableTransactionBlock {
  const transactions: unknown[] = [];
  for (let i = 0; i < width; i++) {
    transactions.push({
      MoveCall: {
        package: "0x1",
        module: "m",
        function: `f${i}`,
        arguments: [{ Input: 0 }],
      },
    });
  }
  return { inputs: [{ type: "object", objectId: "0xshared" }], transactions };
}

/**
 * Function to detect when a `try` block did not throw an expected error.
 */
function expectThrow() {
  throw new Error("expected test to throw error");
}

/**
 * Test that the exported functions, classes, and enumerations match the
 * expected public API.
 */
describe("namespace", () => {
  test("kinetics API has all members", () => {
    expect(kinetics).not.toBeNull();
    const members = Object.getOwnPropertyNames(kinetics);
    expect(members).toEqual(
      expect.arrayContaining([
        // API symbols that should be available to users upon module import.
        "analyzePtb",
        "buildGraph",
        "criticalPath",
        "taintAnalysis",
        "resourceAccounting",
        "extractGas",
        "extractObjectChanges",
        "mistToSui",
        "ArgumentKind",
        "CommandKind",
        "SinkKind",
      ]),
    );
  });

  test("enumerations expose the expected variants", () => {
    expect(kinetics.ArgumentKind.Gas).toBe("GasCoin");
    expect(kinetics.ArgumentKind.Input).toBe("Input");
    expect(kinetics.ArgumentKind.Result).toBe("Result");
    expect(kinetics.ArgumentKind.NestedResult).toBe("NestedResult");
    expect(kinetics.CommandKind.MoveCall).toBe("MoveCall");
    expect(kinetics.SinkKind.Transfer).toBe("transfer");
  });
});

/**
 * Tests of the headline summary produced for a block.
 */
describe("summary of an analyzed block", () => {
  test("summary reports command, input, and package counts", () => {
    const analysis = kinetics.analyzePtb(composedBlock(), composedEffects());
    expect(analysis.summary.commandCount).toBe(5);
    expect(analysis.summary.inputCount).toBe(4);
    expect(analysis.summary.packageCount).toBe(1);
  });

  test("summary histogram counts each command kind", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    expect(analysis.summary.histogram.MoveCall).toBe(2);
    expect(analysis.summary.histogram.SplitCoins).toBe(1);
    expect(analysis.summary.histogram.MergeCoins).toBe(1);
    expect(analysis.summary.histogram.TransferObjects).toBe(1);
  });

  test("summary reports critical-path length, sequentiality, and stage count", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    expect(analysis.summary.criticalPathLength).toBe(3);
    expect(analysis.summary.parallelStages).toBe(3);
    expect(analysis.summary.sequentiality).toBeCloseTo(3 / 5);
  });
});

/**
 * Tests of the dataflow graph construction.
 */
describe("dataflow graph construction", () => {
  test("graph has a node for each input, the gas coin, and each command", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    const inputs = analysis.graph.nodes.filter((n) => n.kind === "input");
    const gas = analysis.graph.nodes.filter((n) => n.kind === "gas");
    const commands = analysis.graph.nodes.filter((n) => n.kind === "command");
    expect(inputs.length).toBe(4);
    expect(gas.length).toBe(1);
    expect(commands.length).toBe(5);
  });

  test("graph edges are oriented from producer to consuming command", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    // Command 1 (swap) consumes Result(0) from command 0 (split).
    const edge = analysis.graph.edges.find(
      (e) => e.from === "cmd:0" && e.to === "cmd:1",
    );
    expect(edge).toBeDefined();
    expect(edge?.argumentLabel).toBe("Result(0)");
    expect(edge?.kind).toBe(kinetics.ArgumentKind.Result);
  });

  test("multiple references from one producer to one command yield one edge", () => {
    const block: kinetics.ProgrammableTransactionBlock = {
      inputs: [{ type: "object", objectId: "0xa" }],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "f",
            // Reference the same input twice.
            arguments: [{ Input: 0 }, { Input: 0 }],
          },
        },
      ],
    };
    const analysis = kinetics.analyzePtb(block);
    const edges = analysis.graph.edges.filter(
      (e) => e.from === "in:0" && e.to === "cmd:0",
    );
    expect(edges.length).toBe(1);
  });

  test("every command edge target corresponds to a command node", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    const commandIds = new Set(
      analysis.graph.nodes.filter((n) => n.kind === "command").map((n) => n.id),
    );
    for (const edge of analysis.graph.edges) {
      expect(commandIds.has(edge.to)).toBe(true);
    }
  });
});

/**
 * Tests of the critical-path and parallel-stage analysis.
 */
describe("critical-path and parallel-stage analysis", () => {
  test("critical path of the composed block is commands 0, 1, and 3", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    expect(analysis.critical.length).toBe(3);
    expect(analysis.critical.path).toEqual([0, 1, 3]);
  });

  test("independent command is placed at depth one, parallel to the split", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    // Command 2 (get_reward) depends only on the pool input.
    expect(analysis.critical.depthOf.get(2)).toBe(1);
    expect(analysis.critical.depthOf.get(0)).toBe(1);
  });

  test("stages partition every command exactly once", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    const seen = new Set<number>();
    let total = 0;
    for (const stage of analysis.critical.stages) {
      for (const command of stage.commands) {
        expect(seen.has(command)).toBe(false);
        seen.add(command);
        total += 1;
      }
    }
    expect(total).toBe(analysis.summary.commandCount);
  });

  test("a linear chain has critical-path length equal to its command count", () => {
    for (const length of [1, 2, 5, 10, 25]) {
      const analysis = kinetics.analyzePtb(chainBlock(length));
      expect(analysis.critical.length).toBe(length);
      expect(analysis.critical.stages.length).toBe(length);
      expect(analysis.critical.sequentiality).toBeCloseTo(1);
    }
  });

  test("a fully parallel block has critical-path length one and a single stage", () => {
    for (const width of [1, 2, 5, 20]) {
      const analysis = kinetics.analyzePtb(parallelBlock(width));
      expect(analysis.critical.length).toBe(1);
      expect(analysis.critical.stages.length).toBe(1);
      expect(analysis.critical.stages[0].commands.length).toBe(width);
    }
  });

  test("commands within a stage share no dependency", () => {
    // Within any stage, no command may reference another command in the same
    // stage; verified by checking that each command's referenced commands have
    // strictly smaller depth.
    const analysis = kinetics.analyzePtb(composedBlock());
    const depthOf = analysis.critical.depthOf;
    for (const command of analysis.commands) {
      for (const argument of command.inputs) {
        if (
          argument.kind === kinetics.ArgumentKind.Result ||
          argument.kind === kinetics.ArgumentKind.NestedResult
        ) {
          const producerDepth = depthOf.get(argument.index as number) ?? 0;
          const consumerDepth = depthOf.get(command.index) ?? 0;
          expect(producerDepth).toBeLessThan(consumerDepth);
        }
      }
    }
  });
});

/**
 * Tests of the forward taint analysis.
 */
describe("forward taint analysis", () => {
  test("every transfer, merge, and Move call is identified as a sink", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    const kinds = analysis.taint.sinks.map((s) => s.kind).sort();
    expect(kinds).toEqual(
      [
        kinetics.SinkKind.MoveCall,
        kinetics.SinkKind.MoveCall,
        kinetics.SinkKind.Merge,
        kinetics.SinkKind.Transfer,
      ].sort(),
    );
  });

  test("taint reaches a sink transitively through an intermediate command", () => {
    // The transfer (command 4) consumes the reward produced by command 2,
    // which depends on the pool input (input 0). Input 0 is therefore expected
    // to taint the transfer even though it is not a direct argument to it.
    const analysis = kinetics.analyzePtb(composedBlock());
    const transfer = analysis.taint.sinks.find(
      (s) => s.kind === kinetics.SinkKind.Transfer,
    );
    expect(transfer).toBeDefined();
    expect(transfer?.taintedBy).toContain(0);
    expect(transfer?.taintedBy).toContain(3);
  });

  test("the gas coin propagates as a distinct taint source", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    // The swap (command 1) consumes the split of the gas coin, so its taint
    // set includes the gas source.
    const swap = analysis.taint.sinks.find((s) => s.command === 1);
    expect(swap?.taintedBy).toContain("gas");
  });

  test("an isolated input does not taint unrelated sinks", () => {
    const block: kinetics.ProgrammableTransactionBlock = {
      inputs: [
        { type: "object", objectId: "0xa" },
        { type: "address", value: "0xrec" },
      ],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "f",
            arguments: [{ Input: 0 }],
          },
        },
      ],
    };
    const analysis = kinetics.analyzePtb(block);
    const sink = analysis.taint.sinks[0];
    expect(sink.taintedBy).toContain(0);
    expect(sink.taintedBy).not.toContain(1);
  });
});

/**
 * Tests of the linear-resource accounting analysis.
 */
describe("linear-resource accounting", () => {
  test("a well-formed block has no dangling results", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    expect(analysis.resources.dangling.length).toBe(0);
  });

  test("an unconsumed split output is reported as dangling", () => {
    const block: kinetics.ProgrammableTransactionBlock = {
      inputs: [
        { type: "pure", value: "500" },
        { type: "pure", value: "999" },
        { type: "address", value: "0xrec" },
      ],
      transactions: [
        // Two split outputs; only the first is transferred.
        {
          SplitCoins: {
            coin: "GasCoin",
            amounts: [{ Input: 0 }, { Input: 1 }],
          },
        },
        {
          TransferObjects: {
            objects: [{ NestedResult: [0, 0] }],
            address: { Input: 2 },
          },
        },
      ],
    };
    const analysis = kinetics.analyzePtb(block);
    const dangling = analysis.resources.dangling;
    expect(dangling.length).toBe(1);
    expect(dangling[0].reason).toBe("split output never consumed");
  });

  test("an unconsumed Move call result is reported as dangling", () => {
    const block: kinetics.ProgrammableTransactionBlock = {
      inputs: [],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "mint",
            arguments: [],
          },
        },
      ],
    };
    const analysis = kinetics.analyzePtb(block);
    expect(analysis.resources.dangling.length).toBe(1);
    expect(analysis.resources.dangling[0].reason).toBe("result never consumed");
  });

  test("object-change conservation totals are computed from effects", () => {
    const analysis = kinetics.analyzePtb(composedBlock(), composedEffects());
    const conservation = analysis.resources.conservation;
    expect(conservation).not.toBeNull();
    expect(conservation?.created).toBe(1);
    expect(conservation?.mutated).toBe(2);
    expect(conservation?.deleted).toBe(0);
    expect(conservation?.netObjectDelta).toBe(1);
  });

  test("conservation is null when effects are not supplied", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    expect(analysis.resources.conservation).toBeNull();
  });
});

/**
 * Tests of gas attribution.
 */
describe("gas attribution", () => {
  test("net gas is computation plus storage less the rebate", () => {
    const analysis = kinetics.analyzePtb(composedBlock(), composedEffects());
    expect(analysis.gas.computation).toBe(1000000);
    expect(analysis.gas.storage).toBe(2960000);
    expect(analysis.gas.rebate).toBe(1470000);
    expect(analysis.gas.net).toBe(1000000 + 2960000 - 1470000);
  });

  test("gas is zero when effects are not supplied", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    expect(analysis.gas.net).toBe(0);
    expect(analysis.gas.computation).toBe(0);
  });

  test("gas extraction tolerates the GraphQL effects shape", () => {
    const effects: kinetics.Effects = {
      status: "SUCCESS",
      gasEffects: {
        gasSummary: {
          computationCost: "1000",
          storageCost: "2000",
          storageRebate: "500",
        },
      },
      objectChanges: {
        nodes: [{ idCreated: true }, { idDeleted: true }, {}],
      },
    };
    const gas = kinetics.extractGas(effects);
    expect(gas.net).toBe(2500);
    const changes = kinetics.extractObjectChanges(effects);
    expect(changes.created.length).toBe(1);
    expect(changes.deleted.length).toBe(1);
    expect(changes.mutated.length).toBe(1);
  });

  test("mistToSui converts using the fixed nine-digit denomination", () => {
    expect(kinetics.mistToSui(Number(_MIST_PER_SUI))).toBe("1.000000000");
    expect(kinetics.mistToSui(2490000)).toBe("0.002490000");
    expect(kinetics.mistToSui(0)).toBe("0.000000000");
  });
});

/**
 * Tests confirming that the several source encodings of arguments and commands
 * are normalized consistently.
 */
describe("normalization of source encodings", () => {
  test("the args alias is accepted in place of arguments", () => {
    const block: kinetics.ProgrammableTransactionBlock = {
      inputs: [{ type: "object", objectId: "0xa" }],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "f",
            args: [{ Input: 0 }],
          },
        },
      ],
    };
    const analysis = kinetics.analyzePtb(block);
    expect(analysis.commands[0].inputs.length).toBe(1);
    expect(analysis.commands[0].inputs[0].kind).toBe(
      kinetics.ArgumentKind.Input,
    );
  });

  test("the commands alias is accepted in place of transactions", () => {
    const block: kinetics.ProgrammableTransactionBlock = {
      inputs: [],
      commands: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "f",
            arguments: [],
          },
        },
      ],
    };
    const analysis = kinetics.analyzePtb(block);
    expect(analysis.summary.commandCount).toBe(1);
  });

  test("a bare numeric argument is interpreted as a command result", () => {
    const block: kinetics.ProgrammableTransactionBlock = {
      inputs: [],
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
            arguments: [0],
          },
        },
      ],
    };
    const analysis = kinetics.analyzePtb(block);
    expect(analysis.commands[1].inputs[0].kind).toBe(
      kinetics.ArgumentKind.Result,
    );
    expect(analysis.commands[1].inputs[0].index).toBe(0);
  });

  test("type arguments are normalized from both strings and repr nodes", () => {
    const block: kinetics.ProgrammableTransactionBlock = {
      inputs: [],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "f",
            typeArguments: ["0x2::sui::SUI", { repr: "0x3::usdc::USDC" }],
            arguments: [],
          },
        },
      ],
    };
    const analysis = kinetics.analyzePtb(block);
    expect(analysis.commands[0].detail.typeArguments).toEqual([
      "0x2::sui::SUI",
      "0x3::usdc::USDC",
    ]);
  });
});

/**
 * Tests confirming that malformed and degenerate inputs are tolerated without
 * error, so that analysis of adversarial or unexpected blocks does not throw.
 */
describe("robustness to malformed and degenerate input", () => {
  test("an empty block yields empty analyses", () => {
    const analysis = kinetics.analyzePtb({ inputs: [], transactions: [] });
    expect(analysis.summary.commandCount).toBe(0);
    expect(analysis.critical.length).toBe(0);
    expect(analysis.taint.sinks.length).toBe(0);
    expect(analysis.graph.edges.length).toBe(0);
  });

  test("an unrecognized command kind is preserved as unknown", () => {
    const block = {
      inputs: [],
      transactions: [{ FutureCommand: { foo: "bar" } }],
    } as unknown as kinetics.ProgrammableTransactionBlock;
    const analysis = kinetics.analyzePtb(block);
    expect(analysis.commands[0].kind).toBe(kinetics.CommandKind.Unknown);
  });

  test("malformed arguments are dropped rather than causing an error", () => {
    const block = {
      inputs: [],
      transactions: [
        {
          MoveCall: {
            package: "0x1",
            module: "m",
            function: "f",
            arguments: [null, undefined, { Input: 0 }, "GasCoin"],
          },
        },
      ],
    } as unknown as kinetics.ProgrammableTransactionBlock;
    const analysis = kinetics.analyzePtb(block);
    // The null and undefined arguments are dropped; the input and gas remain.
    expect(analysis.commands[0].inputs.length).toBe(2);
  });

  test("missing effects fields are treated as absent", () => {
    const analysis = kinetics.analyzePtb(composedBlock(), {});
    expect(analysis.gas.net).toBe(0);
    expect(analysis.resources.conservation?.netObjectDelta).toBe(0);
  });
});

/**
 * Tests of the errors thrown by the analyzer.
 */
describe("errors thrown by the analyzer", () => {
  test("analyzePtb throws a TypeError when the block is not a simple object", () => {
    for (const value of [null, undefined, 42, "block", [], true]) {
      try {
        kinetics.analyzePtb(
          value as unknown as kinetics.ProgrammableTransactionBlock,
        );
        expectThrow();
      } catch (e) {
        expect(e).toBeInstanceOf(TypeError);
      }
    }
  });
});

/**
 * Tests that invoke the individual analyses directly, confirming that they are
 * usable independently of the aggregate entry point.
 */
describe("individual analyses invoked directly", () => {
  test("criticalPath consumes normalized commands from analyzePtb", () => {
    const analysis = kinetics.analyzePtb(chainBlock(4));
    const recomputed = kinetics.criticalPath(analysis.commands);
    expect(recomputed.length).toBe(4);
    expect(recomputed.path).toEqual(analysis.critical.path);
  });

  test("buildGraph reconstructs the same edge count as analyzePtb", () => {
    const analysis = kinetics.analyzePtb(composedBlock());
    const graph = kinetics.buildGraph(analysis.commands, []);
    // Rebuilding without inputs preserves the command-to-command edges.
    const commandEdges = analysis.graph.edges.filter((e) =>
      e.from.startsWith("cmd:"),
    ).length;
    const rebuiltCommandEdges = graph.edges.filter((e) =>
      e.from.startsWith("cmd:"),
    ).length;
    expect(rebuiltCommandEdges).toBe(commandEdges);
  });

  test("taintAnalysis and resourceAccounting agree with analyzePtb", () => {
    const analysis = kinetics.analyzePtb(composedBlock(), composedEffects());
    const taint = kinetics.taintAnalysis(analysis.commands, [{}, {}, {}, {}]);
    expect(taint.sinks.length).toBe(analysis.taint.sinks.length);
    const resources = kinetics.resourceAccounting(
      analysis.commands,
      composedEffects(),
    );
    expect(resources.dangling.length).toBe(analysis.resources.dangling.length);
  });
});
