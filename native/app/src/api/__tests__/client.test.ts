/**
 * The HTTP client.
 *
 * These are the rules the whole client leans on: the bearer token travels
 * with the request, the body is JSON, the server's error envelope becomes an
 * ApiError, and a request that never answers is abandoned rather than left
 * hanging.
 */

import {
  ApiClient,
  FetchLike,
  HttpResponseLike,
} from '../client';
import {ApiError} from '../errors';

interface Recorded {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: unknown;
  };
}

function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get(name: string) {
        const found = headers[name.toLowerCase()];
        return found === undefined ? null : found;
      },
    },
    json: async () => body,
  };
}

function recordingFetch(
  response: HttpResponseLike,
): {fetch: FetchLike; calls: Recorded[]} {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({url, init});
    return response;
  };
  return {fetch, calls};
}

describe('ApiClient', () => {
  it('sends the bearer token of the instance it is pointed at', async () => {
    const {fetch, calls} = recordingFetch(makeResponse(200, {ok: true}));
    const client = new ApiClient({
      baseUrl: 'https://one.example',
      token: 'token-one',
      fetchImpl: fetch,
    });

    await client.get('/api/users/me');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://one.example/api/users/me');
    expect(calls[0].init.headers.Authorization).toBe('Bearer token-one');
  });

  it('leaves the token out of the public endpoints', async () => {
    const {fetch, calls} = recordingFetch(makeResponse(200, {ok: true}));
    const client = new ApiClient({
      baseUrl: 'https://one.example',
      token: 'token-one',
      fetchImpl: fetch,
    });

    await client.get('/api/instance', {auth: false});

    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it('sends a JSON body with the JSON content type', async () => {
    const {fetch, calls} = recordingFetch(makeResponse(200, {ok: true}));
    const client = new ApiClient({
      baseUrl: 'https://one.example',
      fetchImpl: fetch,
    });

    await client.post('/api/auth/login', {username: 'ada', password: 'secret'});

    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      username: 'ada',
      password: 'secret',
    });
  });

  it('reads the server error envelope into an ApiError', async () => {
    const {fetch} = recordingFetch(
      makeResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'username and password required',
          details: {field: 'username'},
        },
      }),
    );
    const client = new ApiClient({
      baseUrl: 'https://one.example',
      fetchImpl: fetch,
    });

    const error = await client.post('/api/auth/login', {}).catch(caught => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('username and password required');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({field: 'username'});
  });

  it('reads the retry-after header of a rate-limited answer', async () => {
    const {fetch} = recordingFetch(
      makeResponse(
        429,
        {error: {code: 'ACCOUNT_LOCKED', message: 'too many failed attempts'}},
        {'retry-after': '42'},
      ),
    );
    const client = new ApiClient({
      baseUrl: 'https://one.example',
      fetchImpl: fetch,
    });

    const error = await client.post('/api/auth/login', {}).catch(caught => caught);

    expect(error.code).toBe('ACCOUNT_LOCKED');
    expect(error.retryAfter).toBe(42);
  });

  it('falls back to the status when the body is not an envelope', async () => {
    const {fetch} = recordingFetch(makeResponse(500, {something: 'else'}));
    const client = new ApiClient({
      baseUrl: 'https://one.example',
      fetchImpl: fetch,
    });

    const error = await client.get('/api/users/me').catch(caught => caught);

    expect(error.code).toBe('HTTP_500');
    expect(error.status).toBe(500);
  });

  it('answers null for an answer with no content', async () => {
    const {fetch} = recordingFetch(makeResponse(204, null));
    const client = new ApiClient({
      baseUrl: 'https://one.example',
      fetchImpl: fetch,
    });

    await expect(client.delete('/api/mutes/abc')).resolves.toBeNull();
  });

  it('builds the query string in a stable order', () => {
    const client = new ApiClient({baseUrl: 'https://one.example/'});

    const url = client.buildUrl('/api/users/search', {q: 'ada l', limit: 10});

    expect(url).toBe('https://one.example/api/users/search?q=ada%20l&limit=10');
  });

  it('leaves undefined and null query values out', () => {
    const client = new ApiClient({baseUrl: 'https://one.example'});

    const url = client.buildUrl('/api/users/search', {
      q: 'ada',
      cursor: undefined,
      page: null,
    });

    expect(url).toBe('https://one.example/api/users/search?q=ada');
  });

  it('abandons a request that never answers', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as
          | {addEventListener?: (type: string, handler: () => void) => void}
          | undefined;
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
      });
    const client = new ApiClient({
      baseUrl: 'https://one.example',
      fetchImpl: fetch,
      timeoutMs: 10,
    });

    const error = await client.get('/api/users/me').catch(caught => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('TIMEOUT');
  });

  it('reports a request that never left the device as a network failure', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('socket closed');
    };
    const client = new ApiClient({
      baseUrl: 'https://one.example',
      fetchImpl: fetch,
    });

    const error = await client.get('/api/users/me').catch(caught => caught);

    expect(error.code).toBe('NETWORK');
    expect(error.isNetworkFailure).toBe(true);
  });

  it('keeps the instance address apart from the path', () => {
    const client = new ApiClient({baseUrl: 'https://one.example/'});

    expect(client.base).toBe('https://one.example');
    expect(client.buildUrl('api/users/me')).toBe(
      'https://one.example/api/users/me',
    );
  });
});
