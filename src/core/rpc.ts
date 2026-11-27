// A small request/response and event protocol over any MessagePort-like channel:
// Electron's MessagePortMain in the utility processes, a DOM MessagePort in the renderer.
//
// Both ends are Normie's own processes, built from the same types: a request's arguments and an event's payload are
// what the other side's types say they are. That trust is spelled out once, here, in `trusted`.

export interface Channel {
  send(msg: unknown): void;
  onMessage(fn: (msg: unknown) => void): void;
}

type Wire =
  | { t: 'req'; id: number; method: string; args: Array<unknown> }
  | { t: 'res'; id: number; ok: true; value: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'evt'; name: string; payload: unknown };

const isWire = (m: unknown): m is Wire => typeof m === 'object' && m !== null && 't' in m && (m.t === 'req' || m.t === 'res' || m.t === 'evt');

/** A value from Normie's other process, typed as that process sent it (see the top of this file). */
function trusted<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- both ends share these types; see above
  return value as T;
}

/**
 * A value one process sends another: what structured clone copies (strings, numbers, Uint8Arrays, arrays and plain
 * objects such as the CoreApi and DataPort types), or nothing.
 */
export type PortValue = string | number | boolean | bigint | null | undefined | object;

/** A method another process can call. Its arguments arrive as the caller's types say. */
type Handler = (...args: Array<never>) => PortValue | void | Promise<PortValue | void>;

/** Emits the events of the map `E` (event name → payload). */
export type Emitter<E> = <K extends keyof E & string>(name: K, payload: E[K]) => void;

/** Answer requests on a channel with the given handlers. Returns a function that emits events of the map `E`. */
export function serve<E = Record<string, never>>(ch: Channel, handlers: Record<string, Handler>): Emitter<E> {
  ch.onMessage((raw) => {
    if (!isWire(raw) || raw.t !== 'req') {
      return;
    }
    const msg = raw;
    const fn = trusted<((...args: Array<unknown>) => PortValue | Promise<PortValue>) | undefined>(handlers[msg.method]);
    void (async () => {
      try {
        if (!fn) {
          throw new Error(`unknown method ${msg.method}`);
        }
        ch.send({ t: 'res', id: msg.id, ok: true, value: await fn(...msg.args) });
      } catch (error) {
        ch.send({ t: 'res', id: msg.id, ok: false, error: errorText(error) });
      }
    })();
  });
  return (name, payload) => ch.send({ t: 'evt', name, payload });
}

const errorText = (error: unknown) =>
  typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : String(error);

/** The calling end of a channel whose events are the map `E` (event name → payload). */
export interface Client<E = Record<string, never>> {
  call<T>(method: string, ...args: Array<unknown>): Promise<T>;
  on<K extends keyof E & string>(name: K, fn: (payload: E[K]) => void): () => void;
}

export function connect<E = Record<string, never>>(ch: Channel): Client<E> {
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  ch.onMessage((raw) => {
    if (!isWire(raw)) {
      return;
    }
    if (raw.t === 'res') {
      const p = pending.get(raw.id);
      if (!p) {
        return;
      }
      pending.delete(raw.id);
      if (raw.ok) {
        p.resolve(raw.value);
      } else {
        p.reject(new Error(raw.error));
      }
    } else if (raw.t === 'evt') {
      for (const fn of listeners.get(raw.name) ?? []) {
        fn(raw.payload);
      }
    }
  });
  return {
    call: <T>(method: string, ...args: Array<unknown>) =>
      new Promise<T>((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve: (v) => resolve(trusted<T>(v)), reject });
        ch.send({ t: 'req', id, method, args });
      }),
    on(name, fn) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      const listener = (p: unknown) => fn(trusted(p));
      set.add(listener);
      return () => set.delete(listener);
    },
  };
}

/** A typed proxy over a client for an interface whose methods all return promises. */
export function proxy<T>(client: Pick<Client, 'call'>, methods: ReadonlyArray<string>): T {
  const o: Record<string, (...args: Array<unknown>) => Promise<PortValue>> = {};
  for (const m of methods) {
    o[m] = (...args) => client.call(m, ...args);
  }
  return trusted<T>(o);
}

/** Electron MessagePortMain (utility process or main) as a Channel. */
export function mainPortChannel(port: { postMessage(m: unknown): void; on(ev: 'message', fn: (e: { data: unknown }) => void): void; start(): void }): Channel {
  const fns: Array<(m: unknown) => void> = [];
  port.on('message', (e) => {
    for (const fn of fns) {
      fn(e.data);
    }
  });
  port.start();
  return { send: (m) => port.postMessage(m), onMessage: (fn) => void fns.push(fn) };
}

/** A DOM MessagePort (renderer) as a Channel. */
export function domPortChannel(port: MessagePort): Channel {
  const fns: Array<(m: unknown) => void> = [];
  port.addEventListener('message', (e) => {
    for (const fn of fns) {
      fn(e.data);
    }
  });
  port.start();
  return { send: (m) => port.postMessage(m), onMessage: (fn) => void fns.push(fn) };
}
