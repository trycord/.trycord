/**
 * The HTTP surface.
 *
 * One request() and everything goes through it, so authorisation, the error
 * envelope, the timeout and the base address are decided in one place. A
 * failure arrives as an ApiError carrying { code, message, status, details },
 * which is what screens switch on rather than parsing message strings.
 *
 * The client holds no global state: the base address and the bearer token are
 * set on it, and the session layer sets them per instance. A session belongs
 * to the instance that issued it, so the token for one instance is never the
 * token another instance is asked to present.
 */

import {ApiError} from './errors';
import {cancelTimer, scheduleTimer, TimerHandle} from '../util/runtime';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type QueryValue = string | number | boolean | null | undefined;

export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  /** The JSON body. Omitted entirely when undefined. */
  body?: unknown;
  /** false for the endpoints that are public. Defaults to true. */
  auth?: boolean;
  /** Query string parameters. Undefined and null values are left out. */
  query?: QueryParams;
  /** Overrides the client timeout for this one request. */
  timeoutMs?: number;
}

/** The parts of a fetch Response this client reads. */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  readonly headers: {get(name: string): string | null} | Record<string, string>;
  json(): Promise<unknown>;
}

/** The parts of a fetch call this client makes. */
export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: unknown;
}

export type FetchLike = (
  url: string,
  init: HttpRequestInit,
) => Promise<HttpResponseLike>;

export interface ApiClientOptions {
  /** The instance's base address, without a trailing slash. */
  baseUrl: string;
  /** The bearer token for this instance, if there is one. */
  token?: string | null;
  /** Overrides the platform fetch. Tests pass their own. */
  fetchImpl?: FetchLike;
  /** How long a request may take before it is abandoned. */
  timeoutMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 25000;

interface AbortControllerLike {
  readonly signal: unknown;
  abort(): void;
}

type AbortControllerCtor = new () => AbortControllerLike;

interface AbortGlobals {
  AbortController?: AbortControllerCtor;
}

const abortGlobals = globalThis as unknown as AbortGlobals;

interface FetchGlobals {
  fetch?: FetchLike;
}

const fetchGlobals = globalThis as unknown as FetchGlobals;

function defaultFetch(): FetchLike {
  const platformFetch = fetchGlobals.fetch;
  if (!platformFetch) {
    throw new ApiError(
      'CLIENT_MISCONFIGURED',
      'This platform has no fetch implementation.',
      0,
    );
  }
  return platformFetch;
}

function headerValue(
  response: HttpResponseLike,
  name: string,
): string | null {
  const headers = response.headers;
  if (headers && typeof (headers as {get?: unknown}).get === 'function') {
    return (headers as {get(key: string): string | null}).get(name);
  }
  const record = headers as Record<string, string>;
  const found = record[name] ?? record[name.toLowerCase()];
  return found === undefined ? null : found;
}

export function encodeQuery(query?: QueryParams): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

export class ApiClient {
  private baseUrl: string;
  private token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.token = options.token ? options.token : null;
    this.fetchImpl = options.fetchImpl || defaultFetch();
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get base(): string {
    return this.baseUrl;
  }

  get bearer(): string | null {
    return this.token;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = trimTrailingSlash(url);
  }

  setToken(token: string | null): void {
    const trimmed = token ? token.trim() : '';
    this.token = trimmed ? trimmed : null;
  }

  buildUrl(path: string, query?: QueryParams): string {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    const encoded = encodeQuery(query);
    return `${this.baseUrl}${suffix}${encoded ? `?${encoded}` : ''}`;
  }

  async request<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {};

    if (options.auth !== false) {
      const token = this.token;
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    let payload: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }

    const controller = abortGlobals.AbortController
      ? new abortGlobals.AbortController()
      : null;
    let timedOut = false;
    const limit = options.timeoutMs ?? this.timeoutMs;
    const timer: TimerHandle = scheduleTimer(() => {
      timedOut = true;
      if (controller) controller.abort();
    }, limit);

    let response: HttpResponseLike;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: controller ? controller.signal : undefined,
      });
    } catch (error) {
      cancelTimer(timer);
      if (timedOut) {
        throw new ApiError('TIMEOUT', 'The server took too long to answer.', 0);
      }
      throw new ApiError(
        'NETWORK',
        'Could not reach the server. Check your connection.',
        0,
      );
    }
    cancelTimer(timer);

    if (response.status === 204) return null as T;
    if (!response.ok) throw await readError(response);

    try {
      return (await response.json()) as T;
    } catch {
      return null as T;
    }
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, {...options, body});
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, {...options, body});
  }

  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, {...options, body});
  }

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }
}

function trimTrailingSlash(url: string): string {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '');
}

async function readError(response: HttpResponseLike): Promise<ApiError> {
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  const envelope = readEnvelope(parsed);
  if (envelope) {
    const retryAfter = Number(headerValue(response, 'retry-after')) || 0;
    return new ApiError(
      envelope.code,
      envelope.message || envelope.code,
      response.status,
      retryAfter,
      envelope.details,
    );
  }

  return new ApiError(
    `HTTP_${response.status}`,
    response.statusText || 'The request failed.',
    response.status,
  );
}

interface ErrorEnvelope {
  code: string;
  message: string;
  details: unknown;
}

function readEnvelope(parsed: unknown): ErrorEnvelope | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const error = (parsed as {error?: unknown}).error;
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (typeof candidate.code !== 'string' || !candidate.code) return null;
  return {
    code: candidate.code,
    message: typeof candidate.message === 'string' ? candidate.message : '',
    details: candidate.details === undefined ? null : candidate.details,
  };
}
