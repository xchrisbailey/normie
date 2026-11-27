// A small request/response and event protocol over any MessagePort-like channel:
// Electron's MessagePortMain in the utility processes, a DOM MessagePort in the renderer.

export interface Channel {
  send(msg: unknown): void;
  onMessage(fn: (msg: unknown) => void): void;
}

type Wire =
  | { t: 'req'; id: number; method: string; args: Array<unknown> }
  | { t: 'res'; id: number; ok: true; value: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'evt'; name: string; payload: unknown };

type Handlers = Record<string, (...args: Array<never>) => unknown>;

/** Answer requests on a channel with the given handlers. Returns a function that emits events. */
export function serve(ch: Channel, handlers: Handlers): (name: string, payload: unknown) => void {
  ch.onMessage(async (raw) => {
    const msg = raw as Wire;
    if (msg?.t !== 'req') {return;}
    const fn = handlers[msg.method] as ((...a: Array<unknown>) => unknown) | undefined;
    try {
      if (!fn) {throw new Error(`unknown method ${msg.method}`);}
      ch.send({ t: 'res', id: msg.id, ok: true, value: await fn(...msg.args) });
    } catch (error) {
      ch.send({ t: 'res', id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return (name, payload) => ch.send({ t: 'evt', name, payload });
}

export interface Client {
  call<T = unknown>(method: string, ...args: Array<unknown>): Promise<T>;
  on(name: string, fn: (payload: unknown) => void): () => void;
}

export function connect(ch: Channel): Client {
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  ch.onMessage((raw) => {
    const msg = raw as Wire;
    if (msg?.t === 'res') {
      const p = pending.get(msg.id);
      if (!p) {return;}
      pending.delete(msg.id);
      if (msg.ok) {p.resolve(msg.value);}
      else {p.reject(new Error(msg.error));}
    } else if (msg?.t === 'evt') {
      listeners.get(msg.name)?.forEach((fn) => fn(msg.payload));
    }
  });
  return {
    call: <T>(method: string, ...args: Array<unknown>) =>
      new Promise<T>((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        ch.send({ t: 'req', id, method, args });
      }),
    on(name, fn) {
      if (!listeners.has(name)) {listeners.set(name, new Set());}
      listeners.get(name)!.add(fn);
      return () => listeners.get(name)!.delete(fn);
    },
  };
}

/** A typed proxy over a client for an interface whose methods all return promises. */
export function proxy<T>(client: Client, methods: ReadonlyArray<string>): T {
  const o: Record<string, unknown> = {};
  for (const m of methods) {o[m] = (...args: unknown[]) => client.call(m, ...args);}
  return o as T;
}

/** Electron MessagePortMain (utility process or main) as a Channel. */
export function mainPortChannel(port: {
  postMessage(m: unknown): void;
  on(ev: 'message', fn: (e: { data: unknown }) => void): unknown;
  start(): void;
}): Channel {
  const fns: Array<(m: unknown) => void> = [];
  port.on('message', (e) => fns.forEach((fn) => fn(e.data)));
  port.start();
  return { send: (m) => port.postMessage(m), onMessage: (fn) => void fns.push(fn) };
}

/** A DOM MessagePort (renderer) as a Channel. */
export function domPortChannel(port: MessagePort): Channel {
  const fns: Array<(m: unknown) => void> = [];
  port.onmessage = (e) => fns.forEach((fn) => fn(e.data));
  return { send: (m) => port.postMessage(m), onMessage: (fn) => void fns.push(fn) };
}
