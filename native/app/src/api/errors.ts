/**
 * The error the API raises.
 *
 * The server answers a failure with a structured envelope -
 * `{ error: { code, message, details } }` - and the code is the part worth
 * branching on. A screen decides what to do from `code`, never from the
 * wording of `message`, because the wording is written for a person and
 * changes between releases.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number;
  readonly details: unknown;

  constructor(
    code: string,
    message: string,
    status: number,
    retryAfter: number = 0,
    details: unknown = null,
  ) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code || 'INTERNAL';
    this.status = status || 500;
    this.retryAfter = retryAfter;
    this.details = details;
  }

  /**
   * True when the session the server holds is no longer usable. The client
   * treats this as "sign out and ask again" rather than "show a message".
   */
  get isAuthFailure(): boolean {
    return (
      this.status === 401 ||
      this.code === 'AUTH_REQUIRED' ||
      this.code === 'SESSION_REVOKED'
    );
  }

  /** True when the request never reached the server. */
  get isNetworkFailure(): boolean {
    return this.code === 'NETWORK' || this.code === 'TIMEOUT';
  }

  /** A message safe to show a person. */
  get displayMessage(): string {
    return this.message || 'Something went wrong.';
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Turns anything thrown into a message a screen can show. An error that is
 * not an ApiError came from somewhere inside the client, and saying so is
 * more useful than saying nothing.
 */
export function describeError(value: unknown): string {
  if (isApiError(value)) return value.displayMessage;
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return 'Something went wrong.';
}
