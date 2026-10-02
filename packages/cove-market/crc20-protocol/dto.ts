/** Transport representation only. Decoding does not authorize a plan, state or offer;
 * consumers must use the core's domain and signature validation at trust boundaries. */
export type ProtocolDto<T> = T extends bigint
  ? string
  : T extends readonly (infer V)[]
    ? ProtocolDto<V>[]
    : T extends object
      ? {
          [K in keyof T]: K extends "sats" | "atoms" | `${string}Sats` | `${string}Atoms`
            ? string | (undefined extends T[K] ? undefined : never)
            : ProtocolDto<T[K]>;
        }
      : T;
const amountField = (key: string) => /^(?:sats|atoms|.*Sats|.*Atoms)$/.test(key);
function map(value: unknown, decode: boolean, key = ""): unknown {
  if (amountField(key)) {
    // Economic deltas can be negative; BTC amounts, fees and atom balances cannot.
    const signedDelta = key === "economicSats";
    if (decode) {
      if (
        typeof value !== "string" ||
        !(signedDelta ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/).test(value)
      )
        throw new Error(`noncanonical DTO amount: ${key}`);
      return BigInt(value);
    }
    if (
      (typeof value !== "bigint" && typeof value !== "number") ||
      (typeof value === "number" && !Number.isSafeInteger(value)) ||
      (!signedDelta && BigInt(value) < 0n)
    )
      throw new Error(`invalid DTO amount: ${key}`);
    return value.toString();
  }
  if (Array.isArray(value)) return value.map((item) => map(item, decode));
  if (value !== null && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error("DTO requires plain objects");
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, map(v, decode, k)]),
    );
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    (typeof value === "number" && !Number.isSafeInteger(value)) ||
    value === undefined
  )
    throw new Error(`invalid DTO value: ${key}`);
  return value;
}
export function encodeProtocolDto<T>(value: T): ProtocolDto<T> {
  return map(value, false) as ProtocolDto<T>;
}
export function decodeProtocolDto<T>(value: unknown): T {
  return map(value, true) as T;
}
