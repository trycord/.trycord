// The REST client.
//
// One thing talks to the server: this. It holds the base address of the
// instance, the token, and the policy - a timeout, how many times to retry
// a request that may safely be retried, and what to do when the server says
// to slow down.
//
// The rules it keeps:
//   - the token is sent in the header, never in a URL;
//   - a request that is not idempotent is never retried unless the caller
//     says it may be;
//   - a 429 is waited out, using the server's own number, and only when the
//     wait is short enough to be worth it;
//   - the token never appears in an error message.

import {
  AuthenticationError,
  ConnectionError,
  ErrorBody,
  HttpError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  UsageError,
} from './errors.js';

/** How a request may be made. */
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The path, from the instance's API root. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** A JSON body. */
  body?: unknown;
  /** A form body, for an upload. */
  form?: FormData;
  /** Headers to add or replace. */
  headers?: Record<string, string>;
  /**
   * Whether this request may be sent again if the first one failed.
   *
   * The default is false: a request that writes something is not safe to
   * repeat, and repeating it is how a message gets posted twice.
   */
  idempotent?: boolean;
  /** How long to wait, in milliseconds. */
  timeoutMs?: number;
}

/** How the client behaves. */
export interface RestOptions {
  /** The instance's API root, e.g. `https://trycord.dev/api`. */
  baseUrl: string;
  /** The application's token. */
  token?: string;
  /** How long a request may take. Ten seconds by default. */
  timeoutMs?: number;
  /** How many times a retryable request may be repeated. */
  maxRetries?: number;
  /** The user agent the client sends. */
  userAgent?: string;
  /** A hook for debugging. It is given a redacted description. */
  onDebug?: (line: string) => void;
  /**
   * The fetch to use.
   *
   * The global one by default. A program that needs a proxy, a different
   * agent or a test that must not reach the network passes its own.
   */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;

/** A rate limit answer, as the server sends it. */
export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  reset?: number;
  retryAfter?: number;
}

/** One request, and the answer to it. */
export interface RawResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  rateLimit: RateLimitInfo;
}

/**
 * The REST client.
 *
 * It is created by the Client and is usable on its own: a program that only
 * wants to read and write messages never touches the gateway.
 */
export class REST {
  readonly baseUrl: string;
  readonly userAgent: string;

  private token?: string;
  private timeoutMs: number;
  private maxRetries: number;
  private onDebug?: (line: string) => void;
  /** The fetch this client uses. Replaceable, for a proxy or a test. */
  fetchImpl: typeof fetch;
  /** The rate limit the server last reported. */
  lastRateLimit: RateLimitInfo = {};

  constructor(options: RestOptions) {
    const base = String(options.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new UsageError('The SDK needs the address of the instance to talk to.');
    this.baseUrl = base;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.userAgent = options.userAgent ?? 'trycord-botjs/0.1.0';
    if (options.onDebug) this.onDebug = options.onDebug;
    this.fetchImpl = options.fetch || fetch;
  }

  /** The token the client sends. */
  get bearer(): string | undefined {
    return this.token;
  }

  set bearer(token: string | undefined) {
    this.token = token;
  }

  /** The full address of a path, with the query on it. */
  url(path: string, query?: RequestOptions['query']): string {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null) continue;
      search.set(key, String(value));
    }
    const queryString = search.toString();
    return `${this.baseUrl}${suffix}${queryString ? `?${queryString}` : ''}`;
  }

  /**
   * Make a request.
   *
   * @param options What to ask for.
   * @returns The answer, parsed.
   */
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const response = await this.raw<T>(options);
    return response.data;
  }

  /**
   * Make a request and keep the answer's headers.
   *
   * @param options What to ask for.
   */
  async raw<T = unknown>(options: RequestOptions): Promise<RawResponse<T>> {
    const method = options.method ?? 'GET';
    const attempts = (options.idempotent ?? method === 'GET' ? this.maxRetries : 0) + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.once<T>(options, method);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof HttpError && error.retryable;
        const wait = error instanceof RateLimitError ? error.retryAfter : undefined;
        if (!retryable || attempt === attempts - 1) throw error;
        // A rate limit is waited out for as long as the server asked, up to
        // ten seconds. A longer wait is the caller's business.
        const pause = typeof wait === 'number' ? Math.min(wait, 10_000) : 500 * (attempt + 1);
        this.debug(`${method} ${options.path} was refused (${(error as HttpError).status}); trying again in ${pause}ms`);
        await sleep(pause);
      }
    }
    throw lastError instanceof Error ? lastError : new ConnectionError('The request failed.');
  }

  private async once<T>(options: RequestOptions, method: string): Promise<RawResponse<T>> {
    const url = this.url(options.path, options.query);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent,
      ...(options.headers || {}),
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    let body: BodyInit | undefined;
    if (options.form) {
      body = options.form;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    let response: Response;
    try {
      this.debug(`${method} ${options.path}`);
      response = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new ConnectionError(
        aborted
          ? `The instance did not answer within ${options.timeoutMs ?? this.timeoutMs}ms.`
          : 'The instance could not be reached.',
        error,
      );
    }
    clearTimeout(timeout);

    const rateLimit = readRateLimit(response.headers);
    this.lastRateLimit = rateLimit;

    if (response.status === 204) {
      return { data: undefined as T, status: 204, headers: response.headers, rateLimit };
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) throw toHttpError(response.status, parsed, response.headers, rateLimit);

    return { data: parsed as T, status: response.status, headers: response.headers, rateLimit };
  }

  private debug(line: string): void {
    if (this.onDebug) this.onDebug(line);
  }
}

/** Read the rate limit headers, whichever names the server used. */
function readRateLimit(headers: Headers): RateLimitInfo {
  const info: RateLimitInfo = {};
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  const retryAfter = headers.get('retry-after');
  if (limit !== null) info.limit = Number(limit);
  if (remaining !== null) info.remaining = Number(remaining);
  if (reset !== null) info.reset = Number(reset);
  if (retryAfter !== null) info.retryAfter = Number(retryAfter) * 1000;
  return info;
}

/** Turn a refusal into the error that says what it was. */
function toHttpError(
  status: number,
  body: unknown,
  headers: Headers,
  rateLimit: RateLimitInfo,
): HttpError {
  const envelope = (body && typeof body === 'object' ? (body as ErrorBody).error : undefined) || {};
  const code = typeof envelope.code === 'string' ? envelope.code : `HTTP_${status}`;
  const message = typeof envelope.message === 'string' && envelope.message
    ? envelope.message
    : `The instance refused the request (HTTP ${status}).`;

  if (status === 401) return new AuthenticationError(message, body);
  if (status === 404) return new NotFoundError(message, body);
  if (status === 403) return new PermissionError(status, code, message, body);
  if (status === 429) {
    const wait = rateLimit.retryAfter ?? (headers.get('retry-after') ? Number(headers.get('retry-after')) * 1000 : undefined);
    return new RateLimitError(status, code, message, wait, body);
  }
  return new HttpError(status, code, message, body, headers.get('x-request-id') ?? undefined);
}

/** Wait, without blocking the thread. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
