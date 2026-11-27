// Snippets (#45): parsing the file and expanding triggers.
import { describe, expect, it } from 'vitest';
import { expandAt, insertAt, parseSnippets } from '../src/renderer/commands/snippets';

const { snippets } = parseSnippets({ thanks: 'Thanks so much!', sig: { name: 'Signature', text: 'Chris\nSent from Normie' } });

describe('snippets', () => {
  it('reads plain and named snippets, and reports the rest', () => {
    expect(snippets).toEqual([
      { trigger: 'thanks', name: 'thanks', text: 'Thanks so much!' },
      { trigger: 'sig', name: 'Signature', text: 'Chris\nSent from Normie' },
    ]);
    const bad = parseSnippets({ 'two words': 'x', n: 4, ok: 'fine' });
    expect(bad.snippets.map((s) => s.trigger)).toEqual(['ok']);
    expect(bad.problems).toHaveLength(2);
    expect(parseSnippets(['x']).problems).toHaveLength(1);
    expect(parseSnippets(undefined)).toEqual({ snippets: [], problems: [] });
  });

  it('expands a trigger just before the cursor, whatever its case', () => {
    expect(expandAt('Great work. ;thanks', 19, snippets)).toEqual({ text: 'Great work. Thanks so much!', cursor: 27 });
    expect(expandAt(';SIG and more', 4, snippets)).toEqual({ text: 'Chris\nSent from Normie and more', cursor: 22 });
  });

  it('leaves Tab alone when there is nothing to expand', () => {
    expect(expandAt('no trigger here', 15, snippets)).toBeNull();
    expect(expandAt(';unknown', 8, snippets)).toBeNull();
    expect(expandAt('mail;thanks', 11, snippets)).toBeNull();
  });

  it('inserts at the cursor, replacing a selection', () => {
    expect(insertAt('Hello world', 6, 11, 'Ada')).toEqual({ text: 'Hello Ada', cursor: 9 });
  });
});
