// What the store keeps as JSON text in its columns, read back as the types it was written from. Anything that doesn't
// fit is left out rather than trusted: these narrow field by field.
import { isJsonObject, isStringArray, parseJson } from './json';
import type { JsonObject, JsonValue } from './json';
import type { Address, AttachmentInfo, ChangeResult, MessageEdit } from './types';

/** The text of a JSON object column; empty when it holds anything else. */
export function parseObject(text: string): JsonObject {
  const v = parseJson(text);
  return isJsonObject(v) ? v : {};
}

/** A string field of a stored object, or '' when it isn't one. */
export function stringField(o: JsonObject, key: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : '';
}

const isNumberList = (v: JsonValue | undefined): v is Array<number> => Array.isArray(v) && v.every((x) => typeof x === 'number');

/** A change's edit, as `JSON.stringify(edit)` wrote it. */
export function parseEdit(text: string): MessageEdit {
  const o = parseObject(text);
  const edit: MessageEdit = {};
  if (isStringArray(o.addFlags)) {
    edit.addFlags = o.addFlags;
  }
  if (isStringArray(o.removeFlags)) {
    edit.removeFlags = o.removeFlags;
  }
  if (isStringArray(o.addLabels)) {
    edit.addLabels = o.addLabels;
  }
  if (isStringArray(o.removeLabels)) {
    edit.removeLabels = o.removeLabels;
  }
  if (typeof o.moveTo === 'string') {
    edit.moveTo = o.moveTo;
  }
  return edit;
}

/** What a replayed change left behind, as `JSON.stringify(result)` wrote it. */
export function parseResult(text: string): ChangeResult {
  const o = parseObject(text);
  const result: ChangeResult = {};
  if (isNumberList(o.movedUids)) {
    result.movedUids = o.movedUids;
  }
  return result;
}

function toAddress(v: JsonValue | undefined): Address | undefined {
  if (!isJsonObject(v) || typeof v.address !== 'string') {
    return undefined;
  }
  return typeof v.name === 'string' ? { name: v.name, address: v.address } : { address: v.address };
}

/** An address column (`from_json`), or nothing when it's empty. */
export function parseAddress(text: string | null | undefined): Address | undefined {
  return text ? toAddress(parseJson(text)) : undefined;
}

/** A list of addresses already parsed from JSON. */
export function toAddressList(v: JsonValue | undefined): Array<Address> {
  return Array.isArray(v) ? v.flatMap((a) => toAddress(a) ?? []) : [];
}

/** An address list column (`to_json`). */
export function parseAddressList(text: string): Array<Address> {
  return toAddressList(parseJson(text));
}

/** The attachments column of a stored body. */
export function parseAttachmentInfos(text: string | null): Array<AttachmentInfo> {
  const v = text ? parseJson(text) : [];
  return Array.isArray(v)
    ? v.flatMap((a) => {
        if (
          !isJsonObject(a) ||
          typeof a.index !== 'number' ||
          typeof a.filename !== 'string' ||
          typeof a.contentType !== 'string' ||
          typeof a.size !== 'number'
        ) {
          return [];
        }
        return [{ index: a.index, filename: a.filename, contentType: a.contentType, size: a.size }];
      })
    : [];
}
