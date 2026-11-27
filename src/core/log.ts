// Each process's log: the console (stdout and stderr), which the main process, the smoke checks, the benchmark and
// the scripts read. Everything that logs goes through here; oxlint.config.mts lets only this file use the console.

/** A line in the log. */
export function log(...parts: Array<unknown>): void {
  console.log(...parts);
}

/** Something went wrong and the app carried on. */
export function warn(...parts: Array<unknown>): void {
  console.warn(...parts);
}

/** Something failed. */
export function logError(...parts: Array<unknown>): void {
  console.error(...parts);
}
