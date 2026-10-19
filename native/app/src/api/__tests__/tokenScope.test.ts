/**
 * Token scoping per instance.
 *
 * A session belongs to the instance that issued it. The token is filed under
 * that instance's origin, and it is only ever presented to that instance. A
 * reader who moves to another instance does not carry the first one's
 * session along.
 */

import {ApiClient, FetchLike, HttpResponseLike} from '../client';
import {createMemoryStore} from '../../storage/localStore';
import {SessionManager} from '../../session/sessionManager';
import {instanceOrigin, sessionKeyFor} from '../../session/instance';

interface Recorded {
  url: string;
  authorization: string | undefined;
}

function makeResponse(status: number, body: unknown): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: {get: () => null},
    json: async () => body,
  };
}

function makeFetch(calls: Recorded[]): FetchLike {
  return async (url, init) => {
    calls.push({
      url,
      authorization: init.headers.Authorization,
    });
    const body = init.body ? (JSON.parse(init.body) as {username?: string}) : {};
    if (url.endsWith('/api/auth/login')) {
      return makeResponse(200, {
        token: `token-for-${body.username}`,
        user: {id: 'u1', username: body.username, display_name: body.username},
      });
    }
    if (url.endsWith('/api/users/me')) {
      return makeResponse(200, {id: 'u1', username: 'ada', display_name: 'Ada'});
    }
    return makeResponse(204, null);
  };
}

describe('token scoping', () => {
  it('files the token under the origin of the instance that issued it', async () => {
    const secure = createMemoryStore();
    const local = createMemoryStore();
    const manager = new SessionManager({
      secureStore: secure,
      localStore: local,
      fetchImpl: makeFetch([]),
    });

    await manager.signIn('https://one.example', 'ada', 'secret');

    await expect(
      secure.get(sessionKeyFor('https://one.example')),
    ).resolves.toBe('token-for-ada');
    expect(manager.api.bearer).toBe('token-for-ada');
  });

  it('presents only the token of the instance it is talking to', async () => {
    const calls: Recorded[] = [];
    const secure = createMemoryStore();
    const local = createMemoryStore();
    const manager = new SessionManager({
      secureStore: secure,
      localStore: local,
      fetchImpl: makeFetch(calls),
    });

    await manager.signIn('https://one.example', 'ada', 'secret');
    await manager.signIn('https://two.example', 'grace', 'secret');

    const toTwo = calls.filter(call => call.url.startsWith('https://two.example'));
    const toOne = calls.filter(call => call.url.startsWith('https://one.example'));

    expect(toOne.length).toBeGreaterThan(0);
    expect(toOne.every(call => call.authorization === 'Bearer token-for-ada')).toBe(
      true,
    );
    expect(toTwo.length).toBeGreaterThan(0);
    expect(toTwo.every(call => call.authorization === 'Bearer token-for-grace')).toBe(
      true,
    );
  });

  it('forgets the session of the instance being left', async () => {
    const secure = createMemoryStore();
    const local = createMemoryStore();
    const manager = new SessionManager({
      secureStore: secure,
      localStore: local,
      fetchImpl: makeFetch([]),
    });

    await manager.signIn('https://one.example', 'ada', 'secret');
    await manager.signIn('https://two.example', 'grace', 'secret');

    await expect(
      secure.get(sessionKeyFor('https://one.example')),
    ).resolves.toBeNull();
    await expect(
      secure.get(sessionKeyFor('https://two.example')),
    ).resolves.toBe('token-for-grace');
  });

  it('keeps two instances apart when the addresses differ only in path', () => {
    expect(instanceOrigin('https://one.example/api')).toBe('https://one.example');
    expect(sessionKeyFor('https://one.example')).not.toBe(
      sessionKeyFor('https://two.example'),
    );
  });

  it('drops the token when the server says the session is gone', async () => {
    const secure = createMemoryStore();
    const local = createMemoryStore();
    const fetch: FetchLike = async url => {
      if (url.endsWith('/api/auth/login')) {
        return makeResponse(200, {
          token: 'token-for-ada',
          user: {id: 'u1', username: 'ada'},
        });
      }
      return makeResponse(401, {
        error: {code: 'AUTH_REQUIRED', message: 'invalid session'},
      });
    };
    const manager = new SessionManager({
      secureStore: secure,
      localStore: local,
      fetchImpl: fetch,
    });

    await manager.signIn('https://one.example', 'ada', 'secret');
    await local.set('trycord.currentInstance', 'https://one.example');
    const restored = await manager.restore();

    expect(restored).toBeNull();
    await expect(
      secure.get(sessionKeyFor('https://one.example')),
    ).resolves.toBeNull();
  });

  it('keeps the token when the server cannot be reached', async () => {
    const secure = createMemoryStore();
    const local = createMemoryStore();
    const fetch: FetchLike = async url => {
      if (url.endsWith('/api/auth/login')) {
        return makeResponse(200, {
          token: 'token-for-ada',
          user: {id: 'u1', username: 'ada'},
        });
      }
      throw new Error('no connection');
    };
    const manager = new SessionManager({
      secureStore: secure,
      localStore: local,
      fetchImpl: fetch,
    });

    await manager.signIn('https://one.example', 'ada', 'secret');
    await local.set('trycord.currentInstance', 'https://one.example');

    await expect(manager.restore()).rejects.toBeTruthy();
    await expect(
      secure.get(sessionKeyFor('https://one.example')),
    ).resolves.toBe('token-for-ada');
  });

  it('never sends one instance token to another instance', async () => {
    const first = new ApiClient({
      baseUrl: 'https://one.example',
      token: 'token-one',
    });
    const second = new ApiClient({
      baseUrl: 'https://two.example',
      token: 'token-two',
    });

    expect(first.bearer).toBe('token-one');
    expect(second.bearer).toBe('token-two');
    expect(first.base).not.toBe(second.base);
  });
});
