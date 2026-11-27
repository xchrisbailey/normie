// The MessagePort protocol the processes use to talk to each other.
import { describe, expect, it } from 'vitest';
import { connect, domPortChannel, serve } from '../src/core/rpc';
import { sleep } from '../src/core/sleep';

function pair() {
  const { port1, port2 } = new MessageChannel();
  return { server: domPortChannel(port1), client: domPortChannel(port2), close: () => (port1.close(), port2.close()) };
}

describe('rpc over a MessagePort', () => {
  it('returns values, rejects errors and delivers events', async () => {
    const { server, client, close } = pair();
    const emit = serve<{ notice: { type: string } }>(server, {
      add: (a: number, b: number) => a + b,
      boom: () => {
        throw new Error('nope');
      },
    });
    const c = connect<{ notice: { type: string } }>(client);
    const events: Array<unknown> = [];
    c.on('notice', (p) => events.push(p));

    expect(await c.call('add', 2, 3)).toBe(5);
    await expect(c.call('boom')).rejects.toThrow('nope');
    await expect(c.call('missing')).rejects.toThrow('unknown method missing');
    emit('notice', { type: 'rows-changed' });
    await sleep(10);
    expect(events).toEqual([{ type: 'rows-changed' }]);
    close();
  });
});
