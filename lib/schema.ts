// Compact JSON Schema helpers for tool parameters.
//
// Tool schemas are sent on every request, so their size is a per-turn cost.
// `Type.Union([Type.Literal("a"), Type.Literal("b")])` serialises to
// `{"anyOf":[{"type":"string","const":"a"},{"type":"string","const":"b"}]}`,
// roughly twice the size of `{"type":"string","enum":["a","b"]}` and just as
// strict for every provider.

import { Type, type TUnsafe } from "typebox";

/** A string constrained to a fixed set, serialised as a flat `enum`. */
export function stringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string; default?: T[number] } = {},
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
