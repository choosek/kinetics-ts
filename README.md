# kinetics-ts

[![npm](https://badge.fury.io/js/@choosek/kinetics.svg)](https://www.npmjs.com/package/@choosek/kinetics)
[![ci](https://github.com/choosek/kinetics-ts/actions/workflows/ci.yaml/badge.svg)](https://github.com/choosek/kinetics-ts/actions)
[![coveralls](https://coveralls.io/repos/github/choosek/kinetics-ts/badge.svg?branch=main)](https://coveralls.io/github/choosek/kinetics-ts)

Library for static analysis of [Sui](https://sui.io/) [Programmable Transaction Blocks (PTBs)](https://docs.sui.io/concepts/transactions/prog-txn-blocks).

## Purpose

This library reconstructs the dataflow structure of a [Programmable Transaction Block](https://docs.sui.io/concepts/transactions/prog-txn-blocks) and derives a number of analyses from it, entirely without network access or transaction signing. A PTB is a small dataflow program: an ordered sequence of commands in which the results of earlier commands become the inputs of later ones, alongside pure values, object references, and the gas coin. Because a command may reference only the results of commands that precede it, the induced [def-use](https://en.wikipedia.org/wiki/Use-define_chain) relation is a [directed acyclic graph (DAG)](https://en.wikipedia.org/wiki/Directed_acyclic_graph). From that graph this library computes a [critical path](https://en.wikipedia.org/wiki/Critical_path_method) and parallel-stage decomposition (using a [longest-path](https://en.wikipedia.org/wiki/Longest_path_problem) computation over the DAG), a forward [taint analysis](https://en.wikipedia.org/wiki/Taint_checking) relating transaction inputs to the sinks they influence, and a [linear-resource](https://en.wikipedia.org/wiki/Substructural_type_system#Linear_type_systems) accounting check inspired by [Move](https://move-language.github.io/move/)'s treatment of objects as linear resources. Gas attribution is computed from a transaction's effects when they are supplied.

## Package Installation and Usage

The package can be installed using [pnpm](https://pnpm.io/):
```shell
pnpm install
```
The library can be imported in the usual way:
```ts
import * as kinetics from "@choosek/kinetics";
```
The analyzer has no runtime dependencies. Its input is a PTB expressed as a plain object; several source encodings are accepted (see [Accepted Source Encodings](#accepted-source-encodings)), so the output of the [Sui TypeScript SDK](https://sdk.mystenlabs.com/typescript), the [JSON-RPC](https://docs.sui.io/references/sui-api) interface, or the [GraphQL](https://docs.sui.io/concepts/graphql-rpc) interface may be passed with little or no adaptation.

### The Programmable Transaction Block Model

A PTB consists of an ordered array of *inputs* and an ordered array of *commands*. During execution, [the runtime loads the inputs into an input array and then executes the commands in order, storing each command's results in a result vector, before applying the transaction's effects atomically](https://docs.sui.io/concepts/transactions/prog-txn-blocks). An argument to a command references exactly one of the following:

| Argument         | Meaning                                                                                                        |
|------------------|----------------------------------------------------------------------------------------------------------------|
| `GasCoin`        | The gas coin, from which the gas budget is withdrawn and to which unused gas is returned.                       |
| `Input(i)`       | The *i*-th transaction-level input (a pure value or an object reference).                                       |
| `Result(i)`      | The sole result of the command at index *i*. [It is shorthand for `NestedResult(i, 0)`, valid only when that command returns exactly one result](https://docs.sui.io/concepts/transactions/prog-txn-blocks). |
| `NestedResult(i, j)` | The *j*-th component of the result tuple of the command at index *i*.                                      |

The commands recognized by this library correspond to the [variants of the Sui `Command` type](https://docs.sui.io/concepts/transactions/prog-txn-blocks): `MoveCall`, `SplitCoins`, `MergeCoins`, `TransferObjects`, `MakeMoveVec`, `Publish`, and `Upgrade`. A command whose category cannot be determined is retained with kind `Unknown` so that analysis is never interrupted by an unrecognized command.

### Analyses

The table below summarizes the analyses this library makes available. Each is a pure function of the normalized block (and, where indicated, its effects), and each is additionally exported individually so that it may be invoked on an already-normalized command sequence.

| Analysis                    | Requires Effects | Output                                                                                                     |
|-----------------------------|:----------------:|------------------------------------------------------------------------------------------------------------|
| Dataflow graph              | no               | Typed nodes (inputs, gas, commands) and value-dependency edges oriented from producer to consumer.         |
| Critical path and stages    | no               | The longest dependency chain, the depth of each command, and the [parallel-stage](https://en.wikipedia.org/wiki/Topological_sorting) decomposition. |
| Forward taint               | no               | For each sink (transfer, merge, or Move call), the set of inputs whose values can influence it.             |
| Linear-resource accounting  | optional         | Per-result consumption records, dangling-result findings, and (with effects) object-change conservation.   |
| Gas attribution             | yes              | Computation, storage, and rebate components, and the net cost, expressed in [MIST](https://docs.sui.io/references/sui-api).            |

#### Critical Path and Parallel Stages

Each command is assigned a dependency depth equal to one more than the maximum depth of the commands it references; commands referencing only inputs or the gas coin have depth one. Because PTB commands are given in dependency order, a single forward pass computes every depth, so the analysis is linear in the size of the block. The critical-path length is the greatest depth attained — the lower bound on the number of commands that must execute sequentially — and one witnessing path is recovered by walking backward through a deepest predecessor. Grouping commands by depth yields the parallel-stage decomposition: commands that share a depth have no mutual data dependency.

#### Forward Taint

Each transaction-level input (and the gas coin) is a distinct taint source. The taint set of a command is the union of the taint sets of its arguments' producers, computed in a single forward pass. The *sinks* are the commands through which value leaves the sender's control or mutates externally observable state — object transfers, coin merges, and Move calls — and each is reported together with the inputs whose taint reaches it. Taint may reach a sink transitively: an input that is not itself an argument to a sink can still influence it by flowing through an intermediate command.

#### Linear-Resource Accounting

Move models objects as [linear resources](https://en.wikipedia.org/wiki/Substructural_type_system#Linear_type_systems): a value whose type carries the `key` or `store` ability must be explicitly consumed rather than implicitly discarded. The Sui runtime enforces a corresponding property on PTBs — [if a command creates an object that is not subsequently destroyed, transferred, or used, the transaction fails](https://docs.sui.io/concepts/transactions/prog-txn-blocks). This library approximates that property statically: every command result that represents a resource should be referenced by a later command, and any result that is never referenced is reported as *dangling*. Because a dangling result frequently indicates a mistake, this check is often useful before a block is ever submitted. When effects are supplied, the object-change set is additionally summarized into conservation totals, including the net change in the number of objects (objects created and unwrapped, less those deleted and wrapped).

#### Gas Attribution

The net gas cost is the computation cost plus the storage cost less the storage rebate. Sui refunds storage when objects are deleted, so a delete-heavy transaction can carry a large rebate that offsets its storage cost. All quantities are expressed in MIST (the smallest denomination of SUI, of which there are ten-to-the-ninth per SUI); the `mistToSui` helper converts a MIST quantity to a SUI-denominated string.

### Accepted Source Encodings

A PTB argument is expressed differently across the interfaces that produce it. This library normalizes all of the following onto a single canonical representation, so that the analyses need not be aware of the source:

| Source                | Argument encoding examples                                              |
|-----------------------|------------------------------------------------------------------------|
| JSON-RPC / TypeScript SDK | `"GasCoin"`, `{ Input: 0 }`, `{ Result: 1 }`, `{ NestedResult: [1, 0] }` |
| GraphQL               | typed nodes carrying `__typename`, `cmd`, and `ix` fields              |

In addition, the `arguments` field of a Move call may be supplied under the `args` alias, the `transactions` array of a block may be supplied under the `commands` alias, and command bodies that encode their arguments positionally (as arrays) are accepted alongside those that use named fields. A bare number is interpreted as a reference to a command result.

### Examples

The example below analyzes a composed transaction that splits the gas coin, swaps the resulting coin against a pool, merges the swap output into a user coin, and transfers a claimed reward to a recipient:
```ts
import * as kinetics from "@choosek/kinetics";

const ptb = {
  inputs: [
    { type: "object", objectId: "0xpool" },
    { type: "object", objectId: "0xusercoin" },
    { type: "pure", valueType: "u64", value: "1000000" },
    { type: "pure", valueType: "address", value: "0xrecipient" },
  ],
  transactions: [
    { SplitCoins: { coin: "GasCoin", amounts: [{ Input: 2 }] } },
    { MoveCall: { package: "0xdex", module: "pool", function: "swap", arguments: [{ Input: 0 }, { Result: 0 }] } },
    { MoveCall: { package: "0xdex", module: "pool", function: "get_reward", arguments: [{ Input: 0 }] } },
    { MergeCoins: { destination: { Input: 1 }, sources: [{ Result: 1 }] } },
    { TransferObjects: { objects: [{ Result: 2 }], address: { Input: 3 } } },
  ],
};

const analysis = kinetics.analyzePtb(ptb);
console.log(analysis.critical.length); // 3
console.log(analysis.critical.path);   // [0, 1, 3]
```
The critical path has length three (the split, the swap, and the merge form the longest dependency chain), while the reward claim is independent of the split and swap and is therefore placed in the same parallel stage as the split.

The example below inspects the taint reaching the transfer sink. The reward claim depends on the pool input, and the transfer consumes the reward, so the pool input taints the transfer even though it is not a direct argument to it:
```ts
const analysis = kinetics.analyzePtb(ptb);
const transfer = analysis.taint.sinks.find((s) => s.kind === kinetics.SinkKind.Transfer);
console.log(transfer?.taintedBy); // includes 0 (the pool input) and 3 (the recipient)
```
The example below detects a dangling result. The split produces two coins but only the first is transferred, so the second is reported:
```ts
const ptb = {
  inputs: [{ type: "pure", value: "500" }, { type: "pure", value: "999" }, { type: "pure", value: "0xrec" }],
  transactions: [
    { SplitCoins: { coin: "GasCoin", amounts: [{ Input: 0 }, { Input: 1 }] } },
    { TransferObjects: { objects: [{ NestedResult: [0, 0] }], address: { Input: 2 } } },
  ],
};

const analysis = kinetics.analyzePtb(ptb);
console.log(analysis.resources.dangling.length);      // 1
console.log(analysis.resources.dangling[0].reason);   // "split output never consumed"
```
The example below supplies effects to obtain gas attribution and object-change conservation totals:
```ts
const effects = {
  status: { status: "success" },
  gasUsed: { computationCost: "1000000", storageCost: "2960000", storageRebate: "1470000" },
  created: [{ objectId: "0xnew" }],
  mutated: [{ objectId: "0xpool" }, { objectId: "0xusercoin" }],
  deleted: [],
};

const analysis = kinetics.analyzePtb(ptb, effects);
console.log(analysis.gas.net);                          // 2490000
console.log(kinetics.mistToSui(analysis.gas.net));      // "0.002490000"
console.log(analysis.resources.conservation?.netObjectDelta); // 1
```

## Development

Use of [pnpm](https://pnpm.io/) is recommended for typical development tasks.

### Testing and Conventions

All unit tests are executed and their coverage measured with [vitest](https://vitest.dev/):
```shell
pnpm test
```
Style conventions are enforced using [biomejs](https://biomejs.dev/):
```shell
pnpm lint
```
Type checking can be performed:
```shell
pnpm typecheck
```
The distribution files can also be checked:
```shell
pnpm attw
```
The structural relationships asserted informally above — that the parallel-stage decomposition partitions the commands, that no command depends on another in the same stage, that a linear chain has critical-path length equal to its command count while a fully parallel block has critical-path length one, and that taint propagates transitively — are each checked within the testing script.

### Contributions

In order to contribute to the source code, open an issue or submit a pull request on the [GitHub page](https://github.com/choosek/kinetics-ts) for this library. To enforce conventions, git hooks are provided and can be installed:
```shell
pnpm install-hooks
```

### Versioning

The version number format for this library and the changes to the library associated with version number increments conform with [Semantic Versioning 2.0.0](https://semver.org/#semantic-versioning-200).
