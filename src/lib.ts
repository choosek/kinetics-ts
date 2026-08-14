/**
 * TypeScript library that performs static analysis of Sui Programmable
 * Transaction Blocks (PTBs).
 *
 * A PTB is a small dataflow program: an ordered sequence of commands in which
 * the outputs of earlier commands (referenced as `Result` or `NestedResult`)
 * become the inputs of later commands, alongside pure values, object
 * references, and the gas coin. Because a command may only reference the
 * results of commands that precede it, the induced def-use relation is a
 * directed acyclic graph (DAG). This library reconstructs that graph and
 * derives several analyses from it — critical path, parallel-stage
 * decomposition, forward taint, and linear-resource accounting — together with
 * gas attribution computed from a transaction's effects.
 *
 * The analyses are deterministic, dependency-free, and side-effect-free: each
 * accepts a normalized PTB (and, where relevant, its effects) and returns a
 * plain data structure. No network access or signing is performed.
 */

/**
 * Enumeration of the argument categories that can appear within a PTB command.
 * Every argument references exactly one of these: the gas coin, a
 * transaction-level input, the sole result of an earlier command, or one
 * component of an earlier command's tuple of results.
 */
export enum ArgumentKind {
  Gas = "GasCoin",
  Input = "Input",
  Result = "Result",
  NestedResult = "NestedResult",
}

/**
 * Enumeration of the command categories recognized by the analyzer. These
 * correspond to the variants of the Sui `Command` type. Any command whose
 * category cannot be determined is represented as `Unknown` so that analysis
 * can proceed without loss.
 */
export enum CommandKind {
  MoveCall = "MoveCall",
  SplitCoins = "SplitCoins",
  MergeCoins = "MergeCoins",
  TransferObjects = "TransferObjects",
  MakeMoveVec = "MakeMoveVec",
  Publish = "Publish",
  Upgrade = "Upgrade",
  Unknown = "Unknown",
}

/**
 * Enumeration of the sink categories used by the taint analysis. A sink is a
 * command through which tainted values leave the sender's control or mutate
 * externally observable state: an object transfer, a coin merge, or a Move
 * call.
 */
export enum SinkKind {
  Transfer = "transfer",
  Merge = "merge",
  MoveCall = "move-call",
}

/**
 * Canonical representation of a single PTB argument. The `index` field is
 * populated for every kind except `Gas`; the `sub` field is populated only for
 * `NestedResult`, where it identifies the component within the referenced
 * command's tuple of results.
 */
export interface Argument {
  kind: ArgumentKind;
  index?: number;
  sub?: number;
}

/**
 * A transaction-level input to a PTB. Inputs are either pure (BCS-encoded
 * values such as integers and addresses) or object references (owned,
 * immutable, shared, or receiving). The optional fields carry whatever
 * provenance the source representation supplied; none is required for
 * analysis.
 */
export interface Input {
  type?: string;
  valueType?: string;
  value?: unknown;
  objectId?: string;
  shared?: boolean;
  mutable?: boolean;
  receiving?: boolean;
  __typename?: string;
}

/**
 * Structured detail attached to a normalized command. Which fields are present
 * depends on the command's kind; for example, `package`, `module`, and
 * `function` are present for a Move call, whereas `splitCount` is present for a
 * coin split.
 */
export interface CommandDetail {
  package?: string;
  module?: string;
  function?: string;
  typeArguments?: string[];
  splitCount?: number;
  mergeCount?: number;
  objectCount?: number;
  elementCount?: number;
  elemType?: string | null;
}

/**
 * A normalized PTB command. The `inputs` array lists the command's arguments
 * in canonical form; `produces` is the number of result values the command
 * yields (zero for commands such as `TransferObjects` and `MergeCoins` that
 * return nothing); and `detail` carries kind-specific metadata.
 */
export interface Command {
  index: number;
  kind: CommandKind;
  inputs: Argument[];
  produces: number;
  detail: CommandDetail;
}

/**
 * A Programmable Transaction Block in the shape the analyzer consumes: an
 * ordered list of transaction-level inputs together with an ordered list of
 * raw commands. The command objects are intentionally typed loosely because
 * this library accepts several source encodings (JSON-RPC, GraphQL, and the
 * TypeScript SDK) and normalizes them internally.
 */
export interface ProgrammableTransactionBlock {
  inputs?: Input[];
  transactions?: unknown[];
  commands?: unknown[];
}

/**
 * The subset of transaction effects consumed by the analyzer. Every field is
 * optional because effects may be absent (for example, when analyzing a PTB
 * that has been constructed but not executed) and because the several source
 * encodings expose gas and object-change information under different shapes,
 * all of which are tolerated during extraction.
 */
export interface Effects {
  status?: { status?: string } | string;
  gasUsed?: Record<string, unknown>;
  gasEffects?: Record<string, unknown>;
  gasSummary?: Record<string, unknown>;
  created?: unknown[];
  mutated?: unknown[];
  deleted?: unknown[];
  wrapped?: unknown[];
  unwrapped?: unknown[];
  objectChanges?: { nodes?: unknown[] } | unknown[];
}

/**
 * A node in the reconstructed dataflow graph. Input and gas nodes correspond
 * to transaction-level inputs and the gas coin; command nodes correspond to
 * PTB commands. The `label` is a short human-readable identifier suitable for
 * display.
 */
export interface GraphNode {
  id: string;
  kind: "input" | "gas" | "command";
  label: string;
  index?: number;
  valueType?: string;
  value?: unknown;
  commandKind?: CommandKind;
  produces?: number;
  detail?: CommandDetail;
}

/**
 * A directed edge in the dataflow graph, oriented from the node that produces a
 * value to the command that consumes it. The `argumentLabel` records how the
 * consuming command referenced the value (for example, `Result(1)`), and
 * `kind` records the referencing argument's category.
 */
export interface GraphEdge {
  from: string;
  to: string;
  argumentLabel: string;
  kind: ArgumentKind;
}

/**
 * The reconstructed dataflow graph: the set of input, gas, and command nodes
 * together with the value-dependency edges among them.
 */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * One stage of the parallel-stage decomposition. Every command in a stage
 * shares the same dependency depth and therefore has no data dependency on any
 * other command in the same stage; the commands in a stage could, in
 * principle, execute concurrently.
 */
export interface Stage {
  depth: number;
  commands: number[];
}

/**
 * The result of the critical-path analysis. `length` is the number of commands
 * along the longest dependency chain (the lower bound on the transaction's
 * sequential depth); `path` lists the indices of one such longest chain;
 * `depthOf` maps each command index to its dependency depth; `stages` is the
 * parallel-stage decomposition; and `sequentiality` is the ratio of the
 * critical-path length to the total number of commands.
 */
export interface CriticalPath {
  length: number;
  path: number[];
  depthOf: Map<number, number>;
  stages: Stage[];
  sequentiality: number;
}

/**
 * A single sink identified by the taint analysis, together with the set of
 * transaction-level inputs (and possibly the gas coin) that can influence it.
 * Input taint sources are reported as numeric input indices; the gas coin is
 * reported as the string `"gas"`.
 */
export interface Sink {
  command: number;
  kind: SinkKind;
  label: string;
  taintedBy: Array<number | string>;
}

/**
 * The result of the forward taint analysis: the propagated taint sets keyed by
 * graph-node identifier, together with the list of identified sinks.
 */
export interface Taint {
  taint: Map<string, Set<number | string>>;
  sinks: Sink[];
}

/**
 * A record of whether a single command result (or, for multi-result commands,
 * a single component) is consumed by a later command. A result that is not
 * consumed is a candidate dangling result.
 */
export interface ResultRecord {
  producer: number;
  sub: number | null;
  consumed: boolean;
}

/**
 * A dangling result finding: a command result (or component) that no later
 * command consumes. In a well-formed PTB every produced resource is consumed,
 * so a dangling result frequently indicates a mistake.
 */
export interface Dangling {
  command: number;
  label: string;
  reason: string;
}

/**
 * Object-change conservation totals derived from a transaction's effects. The
 * `netObjectDelta` is the number of objects created and unwrapped less the
 * number deleted and wrapped.
 */
export interface Conservation {
  created: number;
  mutated: number;
  deleted: number;
  wrapped: number;
  unwrapped: number;
  netObjectDelta: number;
}

/**
 * The result of the linear-resource accounting analysis: the per-result
 * consumption records, the dangling-result findings, and (when effects are
 * available) the object-change conservation totals.
 */
export interface ResourceAccounting {
  results: ResultRecord[];
  dangling: Dangling[];
  conservation: Conservation | null;
}

/**
 * Gas attribution derived from a transaction's effects. `net` is the sum of
 * computation and storage cost less the storage rebate; all values are
 * expressed in MIST (the smallest denomination of SUI).
 */
export interface Gas {
  computation: number;
  storage: number;
  rebate: number;
  nonRefundable: number;
  net: number;
}

/**
 * A histogram mapping each observed command kind to the number of commands of
 * that kind.
 */
export type Histogram = Partial<Record<CommandKind, number>>;

/**
 * A high-level summary of an analyzed PTB, suitable for display as a compact
 * set of headline figures.
 */
export interface Summary {
  commandCount: number;
  inputCount: number;
  packageCount: number;
  histogram: Histogram;
  criticalPathLength: number;
  sequentiality: number;
  parallelStages: number;
}

/**
 * The complete result of analyzing a PTB: the headline summary, the normalized
 * commands, the dataflow graph, and the outputs of each individual analysis.
 */
export interface Analysis {
  summary: Summary;
  commands: Command[];
  graph: Graph;
  critical: CriticalPath;
  taint: Taint;
  resources: ResourceAccounting;
  gas: Gas;
  packages: string[];
}

/**
 * Number of decimal digits used to express MIST as SUI (i.e., one SUI is ten
 * to this power MIST).
 */
const _MIST_PER_SUI_DIGITS = 9;

/**
 * Determine whether the supplied argument is a simple object (a non-null,
 * non-array object literal). Used to validate structured inputs before
 * inspecting their fields.
 */
function _isSimpleObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Coerce an arbitrary value to a finite number, returning zero when the value
 * cannot be interpreted as one. Effects returned by different Sui interfaces
 * express gas quantities as either numbers or decimal strings, so gas
 * extraction relies on this coercion.
 */
function _toNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Read a property from an object by key, returning `undefined` when the value
 * is not a simple object or lacks the key. Used to traverse loosely typed
 * source encodings without repeated inline guards.
 */
function _get(value: unknown, key: string): unknown {
  if (_isSimpleObject(value) && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * Normalize a single raw argument into canonical form, or return `null` when
 * the argument cannot be interpreted.
 *
 * A PTB argument is expressed differently across source encodings: the
 * JSON-RPC and SDK encodings use tagged object literals (for example,
 * `{ Input: 0 }`, `{ Result: 1 }`, `{ NestedResult: [1, 0] }`, and the string
 * `"GasCoin"`), whereas the GraphQL encoding uses typed nodes carrying `cmd`
 * and `ix` fields. This function maps all of these onto the {@link Argument}
 * representation so that the analyses need not be aware of the source.
 */
function _normalizeArgument(argument: unknown): Argument | null {
  if (argument === undefined || argument === null) {
    return null;
  }

  // Gas coin, expressed as a bare string, a tagged object, or a typed node.
  if (
    argument === "GasCoin" ||
    _get(argument, "GasCoin") !== undefined ||
    _get(argument, "kind") === "GasCoin" ||
    _get(argument, "__typename") === "GasCoin"
  ) {
    return { kind: ArgumentKind.Gas };
  }

  if (_isSimpleObject(argument)) {
    if ("Input" in argument) {
      return { kind: ArgumentKind.Input, index: _toNumber(argument.Input) };
    }
    if ("Result" in argument) {
      return { kind: ArgumentKind.Result, index: _toNumber(argument.Result) };
    }
    if ("NestedResult" in argument) {
      const pair = argument.NestedResult;
      if (Array.isArray(pair) && pair.length === 2) {
        return {
          kind: ArgumentKind.NestedResult,
          index: _toNumber(pair[0]),
          sub: _toNumber(pair[1]),
        };
      }
    }

    // GraphQL typed nodes.
    const typename = argument.__typename;
    if (typename === "Input" || argument.ix !== undefined) {
      return { kind: ArgumentKind.Input, index: _toNumber(argument.ix) };
    }
    if (typename === "TxResult") {
      const hasComponent =
        argument.ix !== undefined && _toNumber(argument.ix) !== 0;
      return hasComponent
        ? {
            kind: ArgumentKind.NestedResult,
            index: _toNumber(argument.cmd),
            sub: _toNumber(argument.ix),
          }
        : { kind: ArgumentKind.Result, index: _toNumber(argument.cmd) };
    }
  }

  // A bare number is interpreted as a reference to a command result.
  if (typeof argument === "number") {
    return { kind: ArgumentKind.Result, index: argument };
  }

  return null;
}

/**
 * Return the identifier of the graph node that produces the value referenced by
 * an argument, or `null` when the argument does not correspond to a producing
 * node. Both `Result` and `NestedResult` map to the identifier of the
 * producing command, because a nested result depends on the command that
 * produced the enclosing tuple.
 */
function _argumentSourceId(argument: Argument | null): string | null {
  if (argument === null) {
    return null;
  }
  switch (argument.kind) {
    case ArgumentKind.Gas:
      return "gas";
    case ArgumentKind.Input:
      return `in:${argument.index}`;
    case ArgumentKind.Result:
      return `cmd:${argument.index}`;
    case ArgumentKind.NestedResult:
      return `cmd:${argument.index}`;
    default:
      return null;
  }
}

/**
 * Return a short human-readable label for an argument (for example,
 * `NestedResult(1,0)`). Used both for edge labels in the dataflow graph and for
 * the command listing.
 */
function _argumentLabel(argument: Argument | null): string {
  if (argument === null) {
    return "?";
  }
  switch (argument.kind) {
    case ArgumentKind.Gas:
      return "GasCoin";
    case ArgumentKind.Input:
      return `Input(${argument.index})`;
    case ArgumentKind.Result:
      return `Result(${argument.index})`;
    case ArgumentKind.NestedResult:
      return `NestedResult(${argument.index},${argument.sub})`;
    default:
      return "?";
  }
}

/**
 * Extract the array of raw arguments from a Move call command body, tolerating
 * both the `arguments` field (JSON-RPC and SDK) and the `args` alias.
 */
function _moveCallArguments(body: unknown): unknown[] {
  const explicit = _get(body, "arguments");
  if (Array.isArray(explicit)) {
    return explicit;
  }
  const alias = _get(body, "args");
  if (Array.isArray(alias)) {
    return alias;
  }
  return [];
}

/**
 * Normalize the type arguments of a Move call into an array of display
 * strings, tolerating both bare strings and GraphQL `{ repr }` nodes.
 */
function _typeArguments(body: unknown): string[] {
  const raw = _get(body, "typeArguments") ?? _get(body, "type_arguments");
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }
    const repr = _get(entry, "repr");
    return typeof repr === "string" ? repr : String(entry);
  });
}

/**
 * Normalize a single raw command into canonical form. The command's kind is
 * determined by its sole tag key (for example, `MoveCall` or `SplitCoins`);
 * unrecognized tags yield a command of kind {@link CommandKind.Unknown} so that
 * analysis is not interrupted. The returned command records its arguments in
 * canonical order, the number of results it produces, and kind-specific detail.
 */
function _normalizeCommand(raw: unknown, index: number): Command {
  const base: Command = {
    index,
    kind: CommandKind.Unknown,
    inputs: [],
    produces: 1,
    detail: {},
  };

  if (!_isSimpleObject(raw)) {
    return base;
  }

  const key = Object.keys(raw)[0];
  const body = (raw as Record<string, unknown>)[key];
  const norm = (argument: unknown) => _normalizeArgument(argument);
  const compact = (args: unknown[]): Argument[] =>
    args.map(norm).filter((a): a is Argument => a !== null);

  switch (key) {
    case CommandKind.MoveCall: {
      const args = compact(_moveCallArguments(body));
      return {
        ...base,
        kind: CommandKind.MoveCall,
        inputs: args,
        produces: 1,
        detail: {
          package: _get(body, "package") as string | undefined,
          module: _get(body, "module") as string | undefined,
          function: (_get(body, "function") ??
            _get(body, "functionName") ??
            _get(body, "function_name")) as string | undefined,
          typeArguments: _typeArguments(body),
        },
      };
    }
    case CommandKind.SplitCoins: {
      const coin = norm(_get(body, "coin") ?? _indexed(body, 0));
      const amountsRaw = _get(body, "amounts") ?? _indexed(body, 1) ?? [];
      const amounts = Array.isArray(amountsRaw) ? compact(amountsRaw) : [];
      const inputs = [coin, ...amounts].filter(
        (a): a is Argument => a !== null,
      );
      return {
        ...base,
        kind: CommandKind.SplitCoins,
        inputs,
        produces: amounts.length || 1,
        detail: { splitCount: amounts.length || 1 },
      };
    }
    case CommandKind.MergeCoins: {
      const destination = norm(_get(body, "destination") ?? _indexed(body, 0));
      const sourcesRaw = _get(body, "sources") ?? _indexed(body, 1) ?? [];
      const sources = Array.isArray(sourcesRaw) ? compact(sourcesRaw) : [];
      const inputs = [destination, ...sources].filter(
        (a): a is Argument => a !== null,
      );
      return {
        ...base,
        kind: CommandKind.MergeCoins,
        inputs,
        produces: 0,
        detail: { mergeCount: sources.length },
      };
    }
    case CommandKind.TransferObjects: {
      const objectsRaw = _get(body, "objects") ?? _indexed(body, 0) ?? [];
      const objects = Array.isArray(objectsRaw) ? compact(objectsRaw) : [];
      const address = norm(_get(body, "address") ?? _indexed(body, 1));
      const inputs = [...objects, address].filter(
        (a): a is Argument => a !== null,
      );
      return {
        ...base,
        kind: CommandKind.TransferObjects,
        inputs,
        produces: 0,
        detail: { objectCount: objects.length },
      };
    }
    case CommandKind.MakeMoveVec: {
      const elementsRaw =
        _get(body, "elements") ?? _indexed(body, 1) ?? _get(body, "objects") ?? [];
      const elements = Array.isArray(elementsRaw) ? compact(elementsRaw) : [];
      return {
        ...base,
        kind: CommandKind.MakeMoveVec,
        inputs: elements,
        produces: 1,
        detail: {
          elementCount: elements.length,
          elemType: (_get(body, "type") ?? null) as string | null,
        },
      };
    }
    case CommandKind.Publish: {
      return {
        ...base,
        kind: CommandKind.Publish,
        inputs: [],
        produces: 1,
        detail: {},
      };
    }
    case CommandKind.Upgrade: {
      const ticket = norm(_get(body, "ticket") ?? _indexed(body, 2));
      return {
        ...base,
        kind: CommandKind.Upgrade,
        inputs: ticket === null ? [] : [ticket],
        produces: 1,
        detail: {},
      };
    }
    default:
      return {
        ...base,
        kind:
          (Object.values(CommandKind) as string[]).includes(key)
            ? (key as CommandKind)
            : CommandKind.Unknown,
      };
  }
}

/**
 * Read a positional element from a command body that encodes its arguments as
 * an array rather than as named fields. Some serializations of split, merge,
 * and transfer commands use positional bodies, which this helper accommodates.
 */
function _indexed(body: unknown, position: number): unknown {
  if (Array.isArray(body)) {
    return body[position];
  }
  return undefined;
}

/**
 * Return a short human-readable label for a command (for example,
 * `pool::swap` for a Move call, or `SplitCoins →2` for a split producing two
 * coins).
 */
function _commandLabel(command: Command): string {
  switch (command.kind) {
    case CommandKind.MoveCall: {
      const module = command.detail.module ?? "?";
      const fn = command.detail.function ?? "?";
      return `${module}::${fn}`;
    }
    case CommandKind.SplitCoins:
      return `SplitCoins →${command.detail.splitCount}`;
    case CommandKind.MergeCoins:
      return `MergeCoins ←${command.detail.mergeCount}`;
    case CommandKind.TransferObjects:
      return "TransferObjects →addr";
    case CommandKind.MakeMoveVec:
      return `MakeMoveVec [${command.detail.elementCount}]`;
    case CommandKind.Publish:
      return "Publish";
    case CommandKind.Upgrade:
      return "Upgrade";
    default:
      return command.kind;
  }
}

/**
 * Construct the dataflow graph for a sequence of normalized commands and
 * inputs. Input and gas nodes are created for every transaction-level input and
 * for the gas coin; a command node is created for each command; and a directed
 * edge is added from each producing node to each command that references it.
 * Multiple references from one producer to the same command are collapsed into
 * a single edge.
 */
function buildGraph(commands: Command[], inputs: Input[]): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  inputs.forEach((input, i) => {
    const isObject =
      input?.objectId !== undefined ||
      input?.type === "object" ||
      input?.__typename === "OwnedOrImmutable";
    nodes.push({
      id: `in:${i}`,
      kind: "input",
      index: i,
      label: `Input(${i})`,
      valueType: input?.type ?? input?.valueType ?? (isObject ? "object" : "pure"),
      value: input?.value ?? input?.objectId ?? null,
    });
  });

  nodes.push({ id: "gas", kind: "gas", label: "GasCoin", valueType: "coin" });

  for (const command of commands) {
    nodes.push({
      id: `cmd:${command.index}`,
      kind: "command",
      index: command.index,
      commandKind: command.kind,
      label: _commandLabel(command),
      detail: command.detail,
      produces: command.produces,
    });

    const seen = new Set<string>();
    for (const argument of command.inputs) {
      const from = _argumentSourceId(argument);
      if (from === null) {
        continue;
      }
      const edgeKey = `${from}->cmd:${command.index}`;
      if (seen.has(edgeKey)) {
        continue;
      }
      seen.add(edgeKey);
      edges.push({
        from,
        to: `cmd:${command.index}`,
        argumentLabel: _argumentLabel(argument),
        kind: argument.kind,
      });
    }
  }

  return { nodes, edges };
}

/**
 * Compute the critical path and parallel-stage decomposition of a command
 * sequence.
 *
 * Each command is assigned a dependency depth equal to one more than the
 * maximum depth of the commands it references (commands referencing only
 * inputs or the gas coin have depth one). Because PTB commands are already
 * given in dependency order — a command may reference only earlier commands —
 * a single forward pass suffices to compute every depth, making the analysis
 * linear in the size of the block. The critical-path length is the greatest
 * depth attained; one witnessing path is recovered by walking backward through
 * a deepest predecessor at each step. Grouping commands by depth yields the
 * parallel-stage decomposition: commands sharing a depth have no mutual data
 * dependency.
 */
function criticalPath(commands: Command[]): CriticalPath {
  const depth = new Map<number, number>();
  const predecessors = new Map<number, number[]>();

  for (const command of commands) {
    const preds: number[] = [];
    for (const argument of command.inputs) {
      if (
        argument.kind === ArgumentKind.Result ||
        argument.kind === ArgumentKind.NestedResult
      ) {
        if (argument.index !== undefined) {
          preds.push(argument.index);
        }
      }
    }
    predecessors.set(command.index, preds);
  }

  let best = 0;
  let bestNode = -1;
  for (const command of commands) {
    const preds = predecessors.get(command.index) ?? [];
    let d = 1;
    for (const p of preds) {
      d = Math.max(d, (depth.get(p) ?? 0) + 1);
    }
    depth.set(command.index, d);
    if (d > best) {
      best = d;
      bestNode = command.index;
    }
  }

  const path: number[] = [];
  let current = bestNode;
  while (current !== -1) {
    path.unshift(current);
    const preds = predecessors.get(current) ?? [];
    let next = -1;
    let nextDepth = -1;
    for (const p of preds) {
      const pd = depth.get(p) ?? 0;
      if (pd > nextDepth) {
        nextDepth = pd;
        next = p;
      }
    }
    current = next;
  }

  const stageMap = new Map<number, number[]>();
  for (const command of commands) {
    const d = depth.get(command.index) ?? 1;
    if (!stageMap.has(d)) {
      stageMap.set(d, []);
    }
    (stageMap.get(d) as number[]).push(command.index);
  }
  const stages: Stage[] = [...stageMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, ids]) => ({ depth: d, commands: ids }));

  return {
    length: best,
    path,
    depthOf: depth,
    stages,
    sequentiality: commands.length ? best / commands.length : 0,
  };
}

/**
 * Compute forward taint from each transaction-level input (and the gas coin) to
 * the sinks it can influence.
 *
 * Each input is its own taint source; the taint set of a command is the union
 * of the taint sets of its arguments' producers. Because commands are given in
 * dependency order, a single forward pass computes every taint set. The sinks
 * are the commands through which value leaves the sender's control or mutates
 * externally observable state — transfers, merges, and Move calls — and each is
 * reported together with the inputs whose taint reaches it. Taint may reach a
 * sink transitively; an input that is never an argument to the sink can still
 * taint it by flowing through an intermediate command.
 */
function taintAnalysis(commands: Command[], inputs: Input[]): Taint {
  const taint = new Map<string, Set<number | string>>();

  inputs.forEach((_input, i) => taint.set(`in:${i}`, new Set([i])));
  taint.set("gas", new Set<number | string>(["gas"]));

  for (const command of commands) {
    const accumulated = new Set<number | string>();
    for (const argument of command.inputs) {
      const id = _argumentSourceId(argument);
      if (id !== null && taint.has(id)) {
        for (const source of taint.get(id) as Set<number | string>) {
          accumulated.add(source);
        }
      }
    }
    taint.set(`cmd:${command.index}`, accumulated);
  }

  const sinks: Sink[] = [];
  for (const command of commands) {
    let kind: SinkKind | null = null;
    if (command.kind === CommandKind.TransferObjects) {
      kind = SinkKind.Transfer;
    } else if (command.kind === CommandKind.MergeCoins) {
      kind = SinkKind.Merge;
    } else if (command.kind === CommandKind.MoveCall) {
      kind = SinkKind.MoveCall;
    }
    if (kind === null) {
      continue;
    }
    sinks.push({
      command: command.index,
      kind,
      label: _commandLabel(command),
      taintedBy: [...(taint.get(`cmd:${command.index}`) ?? new Set())],
    });
  }

  return { taint, sinks };
}

/**
 * Determine whether a command produces a value that linear-resource accounting
 * should expect to be consumed. Splits, Move calls, publishes, and upgrades
 * yield resources (coins, arbitrary returns, and upgrade capabilities) that a
 * well-formed block consumes; other commands either produce nothing or produce
 * values that are conventionally consumed within the same block.
 */
function _producesResource(command: Command): boolean {
  return (
    command.kind === CommandKind.SplitCoins ||
    command.kind === CommandKind.MoveCall ||
    command.kind === CommandKind.Publish ||
    command.kind === CommandKind.Upgrade
  );
}

/**
 * Perform linear-resource accounting over a command sequence, optionally
 * incorporating a transaction's effects.
 *
 * Move enforces a linear discipline on resources — values whose types carry the
 * `key` or `store` abilities must be explicitly consumed rather than implicitly
 * discarded. This function approximates the corresponding property at the level
 * of the PTB: every command result that represents a resource should be
 * referenced (consumed) by a later command. Results that are never referenced
 * are reported as dangling, since in a well-formed block each produced resource
 * is consumed. When effects are supplied, the object-change set is additionally
 * summarized into conservation totals, including the net change in the number
 * of objects.
 */
function resourceAccounting(
  commands: Command[],
  effects: Effects | null,
): ResourceAccounting {
  const consumed = new Set<string>();
  for (const command of commands) {
    for (const argument of command.inputs) {
      if (argument.kind === ArgumentKind.Result) {
        consumed.add(`cmd:${argument.index}`);
      } else if (argument.kind === ArgumentKind.NestedResult) {
        consumed.add(`cmd:${argument.index}#${argument.sub}`);
      }
    }
  }

  const results: ResultRecord[] = [];
  const dangling: Dangling[] = [];

  for (const command of commands) {
    if (command.produces === 0) {
      continue;
    }
    if (command.produces === 1) {
      const isConsumed =
        consumed.has(`cmd:${command.index}`) ||
        consumed.has(`cmd:${command.index}#0`);
      results.push({ producer: command.index, sub: null, consumed: isConsumed });
      if (!isConsumed && _producesResource(command)) {
        dangling.push({
          command: command.index,
          label: _commandLabel(command),
          reason: "result never consumed",
        });
      }
    } else {
      for (let j = 0; j < command.produces; j++) {
        const isConsumed =
          consumed.has(`cmd:${command.index}#${j}`) ||
          consumed.has(`cmd:${command.index}`);
        results.push({ producer: command.index, sub: j, consumed: isConsumed });
        if (!isConsumed) {
          dangling.push({
            command: command.index,
            label: `${_commandLabel(command)} [${j}]`,
            reason: "split output never consumed",
          });
        }
      }
    }
  }

  let conservation: Conservation | null = null;
  if (effects !== null) {
    const changes = extractObjectChanges(effects);
    conservation = {
      created: changes.created.length,
      mutated: changes.mutated.length,
      deleted: changes.deleted.length,
      wrapped: changes.wrapped.length,
      unwrapped: changes.unwrapped.length,
      netObjectDelta:
        changes.created.length +
        changes.unwrapped.length -
        changes.deleted.length -
        changes.wrapped.length,
    };
  }

  return { results, dangling, conservation };
}

/**
 * The object-change set extracted from a transaction's effects, partitioned by
 * the kind of change.
 */
export interface ObjectChanges {
  created: unknown[];
  mutated: unknown[];
  deleted: unknown[];
  wrapped: unknown[];
  unwrapped: unknown[];
}

/**
 * Extract the object-change set from a transaction's effects, tolerating both
 * the JSON-RPC shape (top-level `created`, `mutated`, `deleted`, `wrapped`, and
 * `unwrapped` arrays) and the GraphQL shape (a list of change nodes under
 * `objectChanges`). In the GraphQL shape, a node is classified as created or
 * deleted by its `idCreated`/`idDeleted` flags (or, failing those, by the
 * presence of an input or output state), and is otherwise treated as a
 * mutation.
 */
function extractObjectChanges(effects: Effects | null): ObjectChanges {
  const out: ObjectChanges = {
    created: [],
    mutated: [],
    deleted: [],
    wrapped: [],
    unwrapped: [],
  };
  if (effects === null) {
    return out;
  }

  if (Array.isArray(effects.created)) {
    out.created = effects.created;
  }
  if (Array.isArray(effects.mutated)) {
    out.mutated = effects.mutated;
  }
  if (Array.isArray(effects.deleted)) {
    out.deleted = effects.deleted;
  }
  if (Array.isArray(effects.wrapped)) {
    out.wrapped = effects.wrapped;
  }
  if (Array.isArray(effects.unwrapped)) {
    out.unwrapped = effects.unwrapped;
  }

  const changesContainer = effects.objectChanges;
  const nodes = Array.isArray(changesContainer)
    ? changesContainer
    : _get(changesContainer, "nodes");
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const idCreated = _get(node, "idCreated");
      const idDeleted = _get(node, "idDeleted");
      const inputState = _get(node, "inputState");
      const outputState = _get(node, "outputState");
      if (idCreated || (outputState && !inputState)) {
        out.created.push(node);
      } else if (idDeleted || (inputState && !outputState)) {
        out.deleted.push(node);
      } else {
        out.mutated.push(node);
      }
    }
  }

  return out;
}

/**
 * Extract gas attribution from a transaction's effects, tolerating the several
 * shapes under which gas information is exposed (`gasUsed`,
 * `gasEffects.gasSummary`, `gasEffects.gasUsed`, and `gasSummary`) and the
 * snake-case and camel-case spellings of each field. The net cost is
 * computation plus storage less the storage rebate; Sui refunds storage when
 * objects are deleted, so a delete-heavy transaction can carry a large rebate
 * that offsets its storage cost.
 */
function extractGas(effects: Effects | null): Gas {
  const zero: Gas = {
    computation: 0,
    storage: 0,
    rebate: 0,
    nonRefundable: 0,
    net: 0,
  };
  if (effects === null) {
    return zero;
  }

  const summary =
    effects.gasUsed ??
    (_get(effects.gasEffects, "gasSummary") as Record<string, unknown>) ??
    (_get(effects.gasEffects, "gasUsed") as Record<string, unknown>) ??
    effects.gasSummary ??
    {};

  const computation = _toNumber(
    _get(summary, "computationCost") ?? _get(summary, "computation_cost"),
  );
  const storage = _toNumber(
    _get(summary, "storageCost") ?? _get(summary, "storage_cost"),
  );
  const rebate = _toNumber(
    _get(summary, "storageRebate") ?? _get(summary, "storage_rebate"),
  );
  const nonRefundable = _toNumber(
    _get(summary, "nonRefundableStorageFee") ??
      _get(summary, "non_refundable_storage_fee"),
  );

  return {
    computation,
    storage,
    rebate,
    nonRefundable,
    net: computation + storage - rebate,
  };
}

/**
 * Return the list of raw commands from a PTB, tolerating both the
 * `transactions` field (the name used by the Sui interfaces) and the
 * `commands` alias.
 */
function _rawCommands(ptb: ProgrammableTransactionBlock): unknown[] {
  if (Array.isArray(ptb.transactions)) {
    return ptb.transactions;
  }
  if (Array.isArray(ptb.commands)) {
    return ptb.commands;
  }
  return [];
}

/**
 * Analyze a Programmable Transaction Block, optionally incorporating its
 * effects.
 *
 * The PTB is normalized into canonical commands and inputs, from which the
 * dataflow graph is constructed and the critical-path, taint, and
 * resource-accounting analyses are derived; gas attribution is computed from
 * the effects when they are supplied. The return value aggregates a headline
 * summary with the full output of each analysis.
 *
 * @param ptb - The Programmable Transaction Block to analyze. Must be a simple
 * object; its commands may be expressed in any of the supported source
 * encodings.
 * @param effects - The transaction's effects, or `null`/`undefined` when they
 * are unavailable (in which case gas and object-change conservation are
 * reported as empty).
 * @returns The complete {@link Analysis} of the block.
 * @throws TypeError if `ptb` is not a simple object.
 */
export function analyzePtb(
  ptb: ProgrammableTransactionBlock,
  effects: Effects | null = null,
): Analysis {
  if (!_isSimpleObject(ptb)) {
    throw new TypeError(
      "programmable transaction block must be a simple object",
    );
  }

  const inputs: Input[] = Array.isArray(ptb.inputs) ? ptb.inputs : [];
  const commands = _rawCommands(ptb).map((raw, i) => _normalizeCommand(raw, i));

  const graph = buildGraph(commands, inputs);
  const critical = criticalPath(commands);
  const taint = taintAnalysis(commands, inputs);
  const resources = resourceAccounting(commands, effects ?? null);
  const gas = extractGas(effects ?? null);

  const histogram: Histogram = {};
  for (const command of commands) {
    histogram[command.kind] = (histogram[command.kind] ?? 0) + 1;
  }

  const packages = new Set<string>();
  for (const command of commands) {
    if (command.detail.package !== undefined) {
      packages.add(command.detail.package);
    }
  }

  return {
    summary: {
      commandCount: commands.length,
      inputCount: inputs.length,
      packageCount: packages.size,
      histogram,
      criticalPathLength: critical.length,
      sequentiality: critical.sequentiality,
      parallelStages: critical.stages.length,
    },
    commands,
    graph,
    critical,
    taint,
    resources,
    gas,
    packages: [...packages],
  };
}

/**
 * Convert a quantity expressed in MIST to a string expressed in SUI, using the
 * fixed conversion of ten-to-the-ninth MIST per SUI. Provided as a convenience
 * for presenting gas figures.
 */
export function mistToSui(mist: number | bigint): string {
  const value = typeof mist === "bigint" ? Number(mist) : mist;
  return (value / 10 ** _MIST_PER_SUI_DIGITS).toFixed(_MIST_PER_SUI_DIGITS);
}

// The individual analyses are exported alongside the aggregate entry point so
// that callers may invoke them independently — for example, to compute only the
// critical path of an already-normalized block.
export {
  buildGraph,
  criticalPath,
  taintAnalysis,
  resourceAccounting,
  extractGas,
  extractObjectChanges,
};
