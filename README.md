# kinetics-ts

[![npm](https://badge.fury.io/js/@choosek%2Fkinetics.svg)](https://www.npmjs.com/package/@choosek/kinetics)
[![lint-check-test-cover](https://github.com/choosek/kinetics-ts/actions/workflows/lint-check-test-cover.yaml/badge.svg)](https://github.com/choosek/kinetics-ts/actions)
[![coveralls](https://coveralls.io/repos/github/choosek/kinetics-ts/badge.svg?branch=main)](https://coveralls.io/github/choosek/kinetics-ts)

Library for static analysis and simulation of transactions across the [Move](https://move-language.github.io/move/) ecosystem — [Sui](https://sui.io/), [Aptos](https://aptos.dev/), and [Movement](https://movementnetwork.xyz/) — spanning both the object model of Sui [Programmable Transaction Blocks (PTBs)](https://docs.sui.io/concepts/transactions/prog-txn-blocks) and the account model of the Aptos and Movement [Move VM](https://move-language.github.io/move/).

## Purpose

This library statically analyzes a transaction and derives its analyses entirely without network access or transaction signing. What it computes is determined by the chain's execution model, of which two are represented across the three supported chains: the object model of Sui, in which a transaction is a dataflow program, and the account and global-storage model of Aptos and Movement, in which a transaction carries a single payload. Each analysis is a pure, deterministic, dependency-free function of a transaction supplied as a plain object; none reads the network or signs anything.

The library additionally offers *simulation*: rather than reading a transaction, it constructs one and executes it against a chain's current state to obtain the effects it would have if submitted — the balances that would move, the state that would change, and the gas it would cost — without signing or broadcasting it. Simulation necessarily reaches the network, but the library issues no requests of its own; each is delegated to a transport the caller supplies, so it remains dependency-free and runs unchanged in a browser, on a server, or behind a public API. Because the simulated effects are returned in the same form an executed transaction produces, they are interpreted through the same analyzers, and what a transaction *would* do is reported in the same terms as what a transaction *did*. Simulation is described in the [Simulation](#simulation) section.

### Sui

A [Programmable Transaction Block](https://docs.sui.io/concepts/transactions/prog-txn-blocks) is a small dataflow program: an ordered sequence of commands in which the results of earlier commands become the inputs of later ones, alongside pure values, object references, and the gas coin. Because a command may reference only the results of commands that precede it, the induced [def-use](https://en.wikipedia.org/wiki/Use-define_chain) relation is a [directed acyclic graph (DAG)](https://en.wikipedia.org/wiki/Directed_acyclic_graph). From that graph this library computes a [critical path](https://en.wikipedia.org/wiki/Critical_path_method) and parallel-stage decomposition (using a [longest-path](https://en.wikipedia.org/wiki/Longest_path_problem) computation over the DAG), a forward [taint analysis](https://en.wikipedia.org/wiki/Taint_checking) relating transaction inputs to the sinks they influence, and a [linear-resource](https://en.wikipedia.org/wiki/Substructural_type_system#Linear_type_systems) accounting check inspired by [Move](https://move-language.github.io/move/)'s treatment of objects as linear resources. Gas attribution is computed from a transaction's effects when they are supplied. The entry point is `analyzePtb`.

### Aptos

Aptos uses the original Move account and global-storage model. A transaction carries a single payload — most commonly an entry-function call, sometimes a Move script or a multisig wrapper — and does not chain the results of one command into the next, so there is no dataflow graph to reconstruct. The entry point `analyzeMoveTransaction` instead reads a transaction in the [Aptos REST](https://aptos.dev/en/build/apis/fullnode-rest-api) representation and reports what that model makes observable: the decoded payload (the function invoked, its type arguments, and the shape of its arguments), the gas profile, the emitted events, the balance movements those events imply — with each coin type recovered by correlating a withdrawal or deposit event against the `CoinStore` resource it was emitted against — and the write-set: the resources written or deleted, the modules published, and the distinct accounts and packages the transaction touches. The `octasToApt` and `subunitsToCoin` helpers render native-coin amounts. Like the PTB analyses, it is pure, deterministic, and dependency-free.

### Movement

Movement runs the same Move virtual machine as Aptos and exposes an Aptos-compatible REST interface — its mainnet carries the chain identifier 30732, and its test network is Bardock — so `analyzeMoveTransaction` analyzes a Movement transaction without modification, reporting the same payload, events, balance movements, write-set, and gas as in the Aptos case. The only distinctions the caller draws are the native coin the analysis is asked to name — MOVE, in the same eight-decimal subunits as Aptos — and the endpoint from which the transaction is read. The same guarantees of purity and determinism hold.

## Package Installation and Usage

The package can be installed using [pnpm](https://pnpm.io/):
```shell
corepack enable
pnpm install
```
The library can be imported in the usual way:
```ts
import * as kinetics from "@choosek/kinetics";
```
The library has no runtime dependencies. For analysis it exposes one entry point per execution model — `analyzePtb` for Sui and `analyzeMoveTransaction` for Aptos and Movement — each of which takes a transaction expressed as a plain object and returns a plain analysis object; the input accepted for each chain, and the analyses each computes, are described in the per-chain subsections below. For simulation it exposes `simulate`, which builds a transaction and executes it against live chain state through a transport the caller injects; it is described in the [Simulation](#simulation) section.

### Sui

`analyzePtb(ptb, effects?)` analyzes a PTB expressed as a plain object. Several source encodings are accepted (see [Accepted Source Encodings](#accepted-source-encodings)), so the output of the [Sui TypeScript SDK](https://sdk.mystenlabs.com/typescript), the [JSON-RPC](https://docs.sui.io/references/sui-api) interface, or the [GraphQL](https://docs.sui.io/concepts/graphql-rpc) interface may be passed with little or no adaptation. Supplying the transaction's effects as the optional second argument additionally enables gas attribution and object-change conservation.

#### The Programmable Transaction Block Model

A PTB consists of an ordered array of *inputs* and an ordered array of *commands*. During execution, [the runtime loads the inputs into an input array and then executes the commands in order, storing each command's results in a result vector, before applying the transaction's effects atomically](https://docs.sui.io/concepts/transactions/prog-txn-blocks). An argument to a command references exactly one of the following:

| Argument         | Meaning                                                                                                        |
|------------------|----------------------------------------------------------------------------------------------------------------|
| `GasCoin`        | The gas coin, from which the gas budget is withdrawn and to which unused gas is returned.                       |
| `Input(i)`       | The *i*-th transaction-level input (a pure value or an object reference).                                       |
| `Result(i)`      | The sole result of the command at index *i*. [It is shorthand for `NestedResult(i, 0)`, valid only when that command returns exactly one result](https://docs.sui.io/concepts/transactions/prog-txn-blocks). |
| `NestedResult(i, j)` | The *j*-th component of the result tuple of the command at index *i*.                                      |

The commands recognized by this library correspond to the [variants of the Sui `Command` type](https://docs.sui.io/concepts/transactions/prog-txn-blocks): `MoveCall`, `SplitCoins`, `MergeCoins`, `TransferObjects`, `MakeMoveVec`, `Publish`, and `Upgrade`. A command whose category cannot be determined is retained with kind `Unknown` so that analysis is never interrupted by an unrecognized command.

#### Accepted Source Encodings

A PTB argument is expressed differently across the interfaces that produce it. This library normalizes all of the following onto a single canonical representation, so that the analyses need not be aware of the source:

| Source                | Argument encoding examples                                              |
|-----------------------|------------------------------------------------------------------------|
| JSON-RPC / TypeScript SDK | `"GasCoin"`, `{ Input: 0 }`, `{ Result: 1 }`, `{ NestedResult: [1, 0] }` |
| GraphQL               | typed nodes carrying `__typename`, `cmd`, and `ix` fields              |

In addition, the `arguments` field of a Move call may be supplied under the `args` alias, the `transactions` array of a block may be supplied under the `commands` alias, and command bodies that encode their arguments positionally (as arrays) are accepted alongside those that use named fields. A bare number is interpreted as a reference to a command result.

#### Analyses

The table below summarizes the analyses the PTB analyzer makes available. Each is a pure function of the normalized block (and, where indicated, its effects), and each is additionally exported individually so that it may be invoked on an already-normalized command sequence.

| Analysis                    | Requires Effects | Output                                                                                                     |
|-----------------------------|:----------------:|------------------------------------------------------------------------------------------------------------|
| Dataflow graph              | no               | Typed nodes (inputs, gas, commands) and value-dependency edges oriented from producer to consumer.         |
| Critical path and stages    | no               | The longest dependency chain, the depth of each command, and the [parallel-stage](https://en.wikipedia.org/wiki/Topological_sorting) decomposition. |
| Forward taint               | no               | For each sink (transfer, merge, or Move call), the set of inputs whose values can influence it.             |
| Linear-resource accounting  | optional         | Per-result consumption records, dangling-result findings, and (with effects) object-change conservation.   |
| Gas attribution             | yes              | Computation, storage, and rebate components, and the net cost, expressed in [MIST](https://docs.sui.io/references/sui-api).            |

##### Critical Path and Parallel Stages

Each command is assigned a dependency depth equal to one more than the maximum depth of the commands it references; commands referencing only inputs or the gas coin have depth one. Because PTB commands are given in dependency order, a single forward pass computes every depth, so the analysis is linear in the size of the block. The critical-path length is the greatest depth attained — the lower bound on the number of commands that must execute sequentially — and one witnessing path is recovered by walking backward through a deepest predecessor. Grouping commands by depth yields the parallel-stage decomposition: commands that share a depth have no mutual data dependency.

##### Forward Taint

Each transaction-level input (and the gas coin) is a distinct taint source. The taint set of a command is the union of the taint sets of its arguments' producers, computed in a single forward pass. The *sinks* are the commands through which value leaves the sender's control or mutates externally observable state — object transfers, coin merges, and Move calls — and each is reported together with the inputs whose taint reaches it. Taint may reach a sink transitively: an input that is not itself an argument to a sink can still influence it by flowing through an intermediate command.

##### Linear-Resource Accounting

Move models objects as [linear resources](https://en.wikipedia.org/wiki/Substructural_type_system#Linear_type_systems): a value whose type carries the `key` or `store` ability must be explicitly consumed rather than implicitly discarded. The Sui runtime enforces a corresponding property on PTBs — [if a command creates an object that is not subsequently destroyed, transferred, or used, the transaction fails](https://docs.sui.io/concepts/transactions/prog-txn-blocks). This library approximates that property statically: every command result that represents a resource should be referenced by a later command, and any result that is never referenced is reported as *dangling*. Because a dangling result frequently indicates a mistake, this check is often useful before a block is ever submitted. When effects are supplied, the object-change set is additionally summarized into conservation totals, including the net change in the number of objects (objects created and unwrapped, less those deleted and wrapped).

##### Gas Attribution

The net gas cost is the computation cost plus the storage cost less the storage rebate. Sui refunds storage when objects are deleted, so a delete-heavy transaction can carry a large rebate that offsets its storage cost. All quantities are expressed in MIST (the smallest denomination of SUI, of which there are ten-to-the-ninth per SUI); the `mistToSui` helper converts a MIST quantity to a SUI-denominated string.

### Aptos

`analyzeMoveTransaction(tx, options?)` analyzes an Aptos transaction supplied in the [Aptos REST](https://aptos.dev/en/build/apis/fullnode-rest-api) representation — as returned by `GET /transactions/by_hash/{hash}` or `GET /transactions/by_version/{version}`, or as an element of the array returned by `POST /transactions/simulate`. The optional second argument carries presentational parameters, `{chain, network, symbol, decimals}`, of which `symbol` and `decimals` describe the native coin and default to `"APT"` and `8`.

The result is a `MoveAnalysis`, comprising a `summary` of headline figures (`MoveSummary`); the decoded `payload` (a `MovePayloadDetail`, categorized by `MovePayloadKind` as an entry-function call, script, multisig wrapper, module bundle, or unknown); the `gas` attribution (`MoveGas`); the aggregated `events`; the `balanceChanges`, each a `MoveBalanceChange` carrying a `BalanceDirection` and, where recoverable, a resolved coin type; the `writeset` accounting (`MoveWriteset`); and the distinct `packages` and `accounts` the transaction touches, together with its `sender`, `hash`, and timestamp. As with the PTB analyses, the individual normalizers — `summarizeEvents`, `normalizeMovePayload`, `normalizeWriteset`, and `deriveBalanceChanges` — are each exported so that a single facet of an already-fetched transaction may be computed on its own.

### Movement

Movement transactions are analyzed by the same `analyzeMoveTransaction`, Movement's REST interface being Aptos-compatible. The accepted input and the returned `MoveAnalysis` are exactly those of the [Aptos](#aptos) case; the caller passes `{symbol: "MOVE"}` in the options — the eight-decimal default being shared — and reads the transaction from a Movement endpoint, whether its mainnet or the Bardock test network.

### Examples

The examples below illustrate the Sui PTB analyzer; the account-model surface exercised by `analyzeMoveTransaction` on Aptos and Movement is described in the [Aptos](#aptos) and [Movement](#movement) subsections above and is covered by the test suite.

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

## Simulation

Analysis reads a transaction that already exists; *simulation* constructs one and asks a chain what it would do. Given a description of an intended transaction, `simulate` builds it, executes it against the chain's current state through the network's own dry-run facility, and returns the effects it would have if submitted — whether it would succeed, the balances that would move, the state entries that would change, and the gas it would cost — without signing or broadcasting anything. Those effects are returned in one uniform shape across chains. On Aptos and Movement the returned transaction is additionally interpreted through `analyzeMoveTransaction`, so a counterfactual is reported in the same terms as a historical transaction; on Sui the dry-run's status, balance changes, and gas are read directly.

### Injected Transport

Simulation is the one capability that must reach the network, yet the library performs no I/O itself. Each request it needs to make is expressed as a plain object and passed to a `Transport` — a function `(request) => Promise<response>` the caller supplies — which performs the request and returns the parsed JSON. The library thus depends on no HTTP client, SDK, or endpoint, and the same simulation core runs wherever a transport can be provided: in a browser against a same-origin proxy, on a server against an RPC provider, or behind a public API. A request is a Sui GraphQL call of the form `{chain, graphql: {query, variables}}` or an Aptos-style REST call of the form `{chain, rest: {method, path, query, body}}`; the transport is responsible for reaching the endpoint for the network the intent names and returning its parsed response.

### The `simulate` Entry Point

`simulate(intent, transport)` takes a `SimulationIntent` and a `Transport` and resolves to a uniform `SimulationResult`. The intent is a discriminated union whose implemented case is a native-coin `transfer`, stated as a wallet would state it: `{kind: "transfer", chain, network, sender, recipient, amount, symbol, decimals}`, where `amount` is a decimal string in whole coins and `symbol`/`decimals` name the native coin. The result reports the predicted `success` and VM `status`, the `gas` cost (both in the coin's smallest unit and rendered), the `balanceChanges` (each a magnitude, a `direction`, an asset, and the account it applies to), the number of state entries the transaction would touch, and — for Aptos and Movement, for richer display — the full `analyzeMoveTransaction` analysis of the simulated transaction. A `SimulationError` is thrown when the transaction cannot be built or the chain reports that it cannot be simulated. The individual request builders and response normalizers — among them `buildSuiTransferKind`, `suiDryRunRequest`, `parseSuiDryRun`, `buildSenderSignature`, `aptosSimulateRequest`, and `parseAptosSimulation` — are each exported, so a caller may drive any single step directly.

### Per-Chain Mechanics

On Sui, the transfer's programmable block — `SplitCoins(GasCoin, [amount])` followed by `TransferObjects([coin], recipient)` — is serialized to BCS transaction-kind bytes by the library itself and dry-run through the GraphQL `dryRunTransactionBlock` query, with `txMeta` supplying the sender and letting the node select gas. This uses only the client and a GraphQL endpoint; it does not rely on the fullnode's `unsafe_*` transaction-builder methods, which Sui has deprecated on public fullnodes along with the rest of JSON-RPC. On Aptos and Movement, which share a REST surface, simulation needs no valid signature: the sender's sequence number is read from `GET /accounts/{address}`, and rather than assume a key scheme, the library mirrors the authenticator from the account's own most recent transaction — so the sender must have transacted at least once before — blanking its signature bytes to a placeholder. Mirroring the real authenticator lets legacy Ed25519 accounts and modern single-key (or keyless) accounts simulate without special-casing. That placeholder `SignedTransaction` is submitted to `POST /transactions/simulate` with gas estimation enabled, and the returned `UserTransaction` feeds `analyzeMoveTransaction`.

### Example

The example below simulates a transfer on Aptos through a transport that forwards each request to an RPC endpoint; the same code simulates on Sui or Movement by changing the intent's `chain`, `symbol`, and `decimals`:
```ts
import * as kinetics from "@choosek/kinetics";

// A transport reaches the network however the host prefers. `request` is either
// {chain, jsonrpc: {method, params}} or {chain, rest: {method, path, query, body}};
// route it to an endpoint for the network the intent names and return the JSON.
const transport = async (request) => {
  const res = await fetch("https://your-rpc-proxy.example/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return res.json();
};

const result = await kinetics.simulate(
  {
    kind: "transfer",
    chain: "aptos",
    network: "mainnet",
    sender: "0x\u2026",      // a funded account that has transacted at least once
    recipient: "0x\u2026",
    amount: "1.25",
    symbol: "APT",
    decimals: 8,
  },
  transport,
);

console.log(result.success);         // whether it would succeed if submitted
console.log(result.gas.formatted);   // e.g. "0.00150000"
console.log(result.balanceChanges);  // the movements it would cause
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
The structural relationships asserted informally above are each checked within the testing script. For the PTB analyzer, these are that the parallel-stage decomposition partitions the commands, that no command depends on another in the same stage, that a linear chain has critical-path length equal to its command count while a fully parallel block has critical-path length one, and that taint propagates transitively. For the account-model analyzer, these are that a payload is decoded to its function and kind, that withdrawal and deposit events yield directional balance movements whose coin types are recovered from the write-set, that the write-set accounting and the touched-account and touched-package sets are computed correctly, and that gas is attributed from the gas used and the unit price.

### Contributions

In order to contribute to the source code, open an issue or submit a pull request on the [GitHub page](https://github.com/choosek/kinetics-ts) for this library. To enforce conventions, git hooks are provided and can be installed:
```shell
pnpm install-hooks
```

### Versioning

The version number format for this library and the changes to the library associated with version number increments conform with [Semantic Versioning 2.0.0](https://semver.org/#semantic-versioning-200).
