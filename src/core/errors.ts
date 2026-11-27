// Errors arrive as `unknown` (a catch, a rejected promise): their message, for logs and for the user.

/** An error's message, or the thrown value itself when it isn't an Error. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

