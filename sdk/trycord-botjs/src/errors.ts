// The errors the SDK raises.
//
// Three kinds, and the difference matters:
//
//   - a platform refusal: the server answered, and the answer was no.
//     The body carries the code and the message, and the code is what a
//     program should branch on.
//   - a transport failure: the server did not answer. Nothing is known
//     about whether the request had an effect.
//   - an SDK misuse: the caller asked for something that cannot be done.
//
// A program that cannot tell these apart will retry a request that the
// server already refused, and will report a network blip as a policy
// decision.

/** The base of every error the SDK raises. */
export class TrycordError extends Error {
  constructor(message: string, name = 'TrycordError') {
    super(message);
    this.name = name;
  }
}

/** The server answered, and the answer was a refusal. */
export class HttpError extends TrycordError {
  /** The server's own code, e.g. `MESSAGE_NOT_FOUND`. */
  readonly code: string;
  /** The HTTP status. */
  readonly status: number;
  /** The body the server sent, when it sent one. */
  readonly body: unknown;
  /** The request id, when the server sent one. */
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, body?: unknown, requestId?: string) {
    super(message, 'HttpError');
    this.status = status;
    this.code = code;
    this.body = body;
    if (requestId) this.requestId = requestId;
  }

  /** Whether trying again could plausibly work. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** The server did not answer, or the answer could not be read. */
export class ConnectionError extends TrycordError {
  /** The underlying error, when there was one. */
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message, 'ConnectionError');
    if (cause !== undefined) this.cause = cause;
  }
}

/** The request was refused before it was sent. */
export class RateLimitError extends HttpError {
  /** How long to wait, in milliseconds, when the server said. */
  readonly retryAfter?: number;

  constructor(status: number, code: string, message: string, retryAfter?: number, body?: unknown) {
    super(status, code, message, body);
    this.name = 'RateLimitError';
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/** The caller asked for something the SDK cannot do. */
export class UsageError extends TrycordError {
  constructor(message: string) {
    super(message, 'UsageError');
  }
}

/** The token was not accepted. */
export class AuthenticationError extends HttpError {
  constructor(message = 'The token was not accepted.', body?: unknown) {
    super(401, 'UNAUTHENTICATED', message, body);
    this.name = 'AuthenticationError';
  }
}

/** The token is valid and the action is not allowed. */
export class PermissionError extends HttpError {
  constructor(status: number, code: string, message: string, body?: unknown) {
    super(status, code, message, body);
    this.name = 'PermissionError';
  }
}

/** A method the server does not have, or a path the SDK got wrong. */
export class NotFoundError extends HttpError {
  constructor(message = 'There is nothing there.', body?: unknown) {
    super(404, 'NOT_FOUND', message, body);
    this.name = 'NotFoundError';
  }
}

/**
 * The shape of a refusal, as the server sends it.
 *
 * The server's own error format: a code, a message, and sometimes a list of
 * the problems it found.
 */
export interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    problems?: string[];
    type?: string;
  };
}
