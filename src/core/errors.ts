// Errors arrive as `unknown` (a catch, a rejected promise): their message, for logs and for the user.

/** An error's message, or the thrown value itself when it isn't an Error. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}


/**
 * A value the code's own logic guarantees is there (a Map entry just set, a row just inserted), in place of a `!`.
 * If it's missing after all, this throws with `what` rather than failing later on undefined.
 */
export function expected<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}`);
  }
  return value;
}
