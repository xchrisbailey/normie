import { describe, expect, it } from 'vitest';
import { formatAddresses, parseAddresses } from '../src/core/addresses';

describe('address fields', () => {
  it('parses names, bare addresses, quotes and both separators', () => {
    expect(parseAddresses('Ada <ada@example.com>, grace@example.com; "Hopper, Grace" <g@navy.mil>')).toEqual({
      addresses: [{ name: 'Ada', address: 'ada@example.com' }, { address: 'grace@example.com' }, { name: 'Hopper, Grace', address: 'g@navy.mil' }],
      invalid: [],
    });
  });

  it('reports what is not an address', () => {
    expect(parseAddresses('ada, bob@example, <>,  ').invalid).toEqual(['ada', 'bob@example', '<>']);
  });

  it('formats a list back so it parses the same', () => {
    const list = [{ name: 'Hopper, Grace', address: 'g@navy.mil' }, { address: 'a@b.co' }];
    expect(parseAddresses(formatAddresses(list)).addresses).toEqual(list);
  });
});
