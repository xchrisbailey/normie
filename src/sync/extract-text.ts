// Plain text of a raw message for the reader and snippets. mailparser converts HTML-only mail to text.
import { simpleParser } from 'mailparser';

export async function extractText(raw: Uint8Array): Promise<string> {
  if (!raw.length) {return '';}
  const parsed = await simpleParser(Buffer.from(raw), { skipImageLinks: true, skipTextToHtml: true });
  return (parsed.text ?? '').replaceAll('\r\n', '\n').trim();
}
