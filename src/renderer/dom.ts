// Shape checks for values that arrive wider than we use them (event targets, parsed JSON). Not `instanceof`: the mail
// frame is another realm, where an element isn't an instance of this window's classes.
import type { JsonValue } from '../core/json';

/** An event target that is an element (of any frame). */
export function isElement(target: unknown): target is Element {
  return typeof target === 'object' && target !== null && 'closest' in target && 'tagName' in target;
}

/** An event target that is an HTML element (of any frame): it has a dataset and focus(). */
export function isHtmlElement(target: unknown): target is HTMLElement {
  return isElement(target) && 'dataset' in target && 'focus' in target;
}

/** What a parsed JSON file holds, as an object. */
export type JsonObject = { [key: string]: JsonValue };

/** A parsed JSON object (not null, not a list). */
export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
