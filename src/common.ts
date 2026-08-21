/**
 * Shared, dependency-free value helpers used by both the Sui PTB analyzer
 * and the Move VM analyzer. Chain interfaces return loosely typed data, and
 * both analyzers need to read and coerce it without throwing; this module
 * ensures the two analyzers use identical semantics.
 */

/**
 * Narrow an unknown to a plain object (a JSON object / object literal): not
 * null, not an array, and not an exotic object. Used to guard property reads
 * and to distinguish a structured node from a scalar.
 */
export function isSimpleObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Read a property from a value by key, returning `undefined` when the value is
 * not a plain object or does not have the key. Traverses loosely typed source
 * encodings without repeated inline guards.
 */
export function getField(value: unknown, key: string): unknown {
  if (isSimpleObject(value) && key in value) {
    return value[key];
  }
  return undefined;
}

/**
 * Coerce an arbitrary value to a finite number, returning zero when it cannot
 * be interpreted as one. Chain interfaces express numeric quantities (gas,
 * amounts, indices) as numbers or decimal strings, and occasionally as
 * bigints, so callers rely on this to normalize them.
 */
export function toNumber(value: unknown): number {
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
 * Coerce a value to a string, or `null` when it is not string-like. Numbers and
 * bigints are stringified; everything else (objects, arrays, booleans, null,
 * undefined) yields `null`.
 */
export function toStringOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}
