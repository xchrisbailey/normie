// The renderer's handle on the core: a CoreApi proxy over the MessagePort the preload forwards.
import { CORE_API_METHODS } from '../core/api';
import type { CoreApi, CoreEvents } from '../core/api';
import { connect, domPortChannel, proxy } from '../core/rpc';
import type { CoreNotice } from '../core/types';

export interface CoreClient extends CoreApi {
  onNotice(fn: (n: CoreNotice) => void): () => void;
}

export function waitForCore(): Promise<CoreClient> {
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.data !== 'normie:core-port' || !e.ports[0]) {
        return;
      }
      window.removeEventListener('message', onMessage);
      const client = connect<CoreEvents>(domPortChannel(e.ports[0]));
      resolve({
        ...proxy<CoreApi>(client, CORE_API_METHODS),
        onNotice: (fn) => client.on('notice', fn),
      });
    };
    window.addEventListener('message', onMessage);
  });
}
