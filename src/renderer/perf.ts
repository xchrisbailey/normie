// Performance marks around every key action: time from keydown to the frame that shows the result.
export interface Sample {
  action: string;
  ms: number;
}

const samples: Sample[] = [];
const listeners = new Set<(s: Sample) => void>();
const MAX = 2000;

/** Measure from `start` (a performance.now() timestamp, such as event.timeStamp) to after the next frame is produced. */
export function measureToNextFrame(action: string, start: number) {
  requestAnimationFrame(() => {
    // The rAF callback runs before paint; a message posted from it runs after the frame is produced.
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      const end = performance.now();
      performance.measure(`action:${action}`, { start, end });
      const s = { action, ms: end - start };
      samples.push(s);
      if (samples.length > MAX) samples.shift();
      for (const fn of listeners) fn(s);
    };
    ch.port2.postMessage(null);
  });
}

export function onSample(fn: (s: Sample) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

// Read by the benchmark through executeJavaScript.
(window as unknown as { __normiePerf: unknown }).__normiePerf = {
  samples: () => samples.slice(),
  clear: () => void (samples.length = 0),
};
