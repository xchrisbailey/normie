// JSON from outside the type system (the store's JSON columns, files in the data folder): parsed to `unknown`,
// then narrowed with these checks rather than cast.

/** What JSON text can hold. */
export type JsonValue = string | number | boolean | null | Array<JsonValue> | { [key: string]: JsonValue };

/** JSON.parse, typed as what it really returns. */
export function parseJson(text: string): JsonValue {
  const value: JsonValue = JSON.parse(text);
  return value;
}

export const isStringArray = (v: unknown): v is Array<string> => Array.isArray(v) && v.every((x) => typeof x === 'string');

export const isNumberArray = (v: unknown): v is Array<number> => Array.isArray(v) && v.every((x) => typeof x === 'number');

/** A JSON column holding a list of strings (labels, flags): the list, or empty when it's anything else. */
export function stringList(text: string | null | undefined): Array<string> {
  if (!text) {
    return [];
  }
  const v = parseJson(text);
  return isStringArray(v) ? v : [];
}
