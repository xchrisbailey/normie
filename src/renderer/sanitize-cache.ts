// Sanitized HTML per message, kept so opening a prefetched Thread doesn't sanitize on the key path.
import type { ThreadMessage } from '../core/types';
import { createSanitizer, type SanitizedMail } from './sanitize';

const MAX = 300;
const cache = new Map<string, SanitizedMail>();
let clean: ReturnType<typeof createSanitizer> | undefined;

/** A message's sanitized HTML, with remote images blocked unless `allowRemote`. */
export function sanitized(m: ThreadMessage, allowRemote: boolean): SanitizedMail {
  if (!m.html) return { html: '', remoteImages: 0 };
  const key = `${m.id}:${allowRemote ? 1 : 0}:${m.html.length}`;
  let hit = cache.get(key);
  if (!hit) {
    clean ??= createSanitizer();
    hit = clean(m.html, { allowRemote });
    cache.set(key, hit);
    while (cache.size > MAX) cache.delete(cache.keys().next().value!);
  }
  return hit;
}
