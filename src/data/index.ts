// The data process: owns the SQLite file. Serves the renderer's queries and sync's writes.
import type { MessagePortMain } from 'electron';
import { CORE_API_METHODS, coreApiOf } from '../core/core';
import { DATA_PORT_METHODS, DataService } from '../core/data-service';
import { mainPortChannel, serve } from '../core/rpc';
import { Store } from '../core/store';

type InitMessage =
  | { type: 'init'; dbPath: string }
  | { type: 'renderer-port' }
  | { type: 'sync-port' };

let data: DataService | undefined;
const pendingPorts: { kind: 'renderer-port' | 'sync-port'; port: MessagePortMain }[] = [];
let emitToSync: ((name: string, payload: unknown) => void) | undefined;

function attach(kind: 'renderer-port' | 'sync-port', port: MessagePortMain) {
  if (!data) return void pendingPorts.push({ kind, port });
  const ds = data;
  const ch = mainPortChannel(port);
  if (kind === 'renderer-port') {
    const api = coreApiOf(ds);
    const handlers = Object.fromEntries(CORE_API_METHODS.map((m) => [m, api[m]]));
    const emit = serve(ch, handlers);
    const off = ds.onNotice((n) => emit('notice', n));
    port.on('close', () => off());
  } else {
    const handlers = Object.fromEntries(DATA_PORT_METHODS.map((m) => [m, (...a: unknown[]) => (ds[m] as (...x: unknown[]) => unknown)(...a)]));
    emitToSync = serve(ch, handlers);
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data as InitMessage;
  if (msg.type === 'init') {
    data = new DataService(new Store(msg.dbPath));
    data.bodyRequester = (loc) => emitToSync?.('fetch-body', loc);
    for (const p of pendingPorts.splice(0)) attach(p.kind, p.port);
  } else {
    const port = e.ports[0];
    if (port) attach(msg.type, port);
  }
});
