// JSON from outside the type system (the store's JSON columns, files in the data folder): parsed to `unknown`,
// then narrowed with these checks rather than cast.

/** What JSON text can hold. */
export type JsonValue = string | number | boolean | null | Array<JsonValue> | { [key: string]: JsonValue };

/** JSON.parse, typed as what it really returns. */
export function parseJson(text: string): JsonValue {
  const value: unknown = JSON.parse(text);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; what it returns is JSON
  return value as JsonValue;
}

export const isStringArray = <V>(v: V): v is V & Array<string> => Array.isArray(v) && v.every((x) => typeof x === 'string');

export const isNumberArray = <V>(v: V): v is V & Array<number> => Array.isArray(v) && v.every((x) => typeof x === 'number');

/** A JSON column holding a list of strings (labels, flags): the list, or empty when it's anything else. */
export function stringList(text: string | null | undefined): Array<string> {
  if (!text) {
    return [];
  }
  const v = parseJson(text);
  return isStringArray(v) ? v : [];
}

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

export const isJsonObject = (v: JsonValue | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON column holding a list of numbers (UIDs, change ids): the list, or empty when it's anything else. */
export function numberList(text: string | null | undefined): Array<number> {
  if (!text) {
    return [];
  }
  const v = parseJson(text);
  return isNumberArray(v) ? v : [];
}
