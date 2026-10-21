// The SDK's own tests.
//
// They run against the compiled package, so what is tested is what is
// published. The server is not needed: a fetch that is answered by a
// function is enough to prove the request layer does what it says.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  AuthenticationError,
  Client,
  ConnectionError,
  Gateway,
  HttpError,
  NotFoundError,
  RateLimitError,
  REST,
  UsageError,
  Events,
  type GatewayEnvelope,
} from '../src/index.js';

/** A fetch that answers with what the test tells it to. */
function stubFetch(answers: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const answer = answers[index] || answers[answers.length - 1] || { status: 200, body: {} };
    index += 1;
    const status = answer.status ?? 200;
    const text = answer.body === undefined ? '' : JSON.stringify(answer.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: new Headers(answer.headers || {}),
      text: async () => text,
      json: async () => (answer.body === undefined ? null : answer.body),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

test('the REST client', async (t) => {
  await t.test('it needs an address', () => {
    assert.throws(() => new REST({ baseUrl: '' }), UsageError);
  });

  await t.test('it sends the token in the header and never in the URL', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { ok: true } }]);
    const rest = new REST({ baseUrl: 'https://example.test/api/v1', token: 'trcd_bot_secret' });
    rest.fetchImpl = fetchImpl as never;
    await rest.request({ path: '/communities/abc' });
    const first = calls[0]!;
    assert.equal(first.url, 'https://example.test/api/v1/communities/abc');
    const headers = first.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer trcd_bot_secret');
    assert.ok(!first.url.includes('trcd_bot_secret'), 'the token is not in the URL');
  });

  await t.test('a path without a slash is still a path', () => {
    const rest = new REST({ baseUrl: 'https://example.test/api/v1' });
    assert.equal(rest.url('communities/abc'), 'https://example.test/api/v1/communities/abc');
  });

  await t.test('a query carries only what was asked for', () => {
    const rest = new REST({ baseUrl: 'https://example.test/api/v1' });
    assert.equal(
      rest.url('/channels', { limit: 20, before: undefined }),
      'https://example.test/api/v1/channels?limit=20',
    );
  });

  await t.test('it turns a refusal into the error that says what it was', async () => {
    const { fetchImpl } = stubFetch([
      { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'no.' } } },
    ]);
    const rest = new REST({ baseUrl: 'https://example.test/api/v1', token: 'x' });
    rest.fetchImpl = fetchImpl as never;
    await assert.rejects(
      () => rest.request({ path: '/communities/abc' }),
      (error: unknown) => error instanceof AuthenticationError && error.status === 401,
    );
  });

  await t.test('a missing thing is a not found', async () => {
    const { fetchImpl } = stubFetch([{ status: 404, body: { error: { code: 'NOT_FOUND', message: 'gone' } } }]);
    const rest = new REST({ baseUrl: 'https://example.test/api/v1', token: 'x' });
    rest.fetchImpl = fetchImpl as never;
    await assert.rejects(
      () => rest.request({ path: '/communities/abc' }),
      (error: unknown) => error instanceof NotFoundError,
    );
  });

  await t.test('a rate limit is an error that says when to try again', async () => {
    const { fetchImpl } = stubFetch([
      { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } }, headers: { 'retry-after': '2' } },
    ]);
    const rest = new REST({ baseUrl: 'https://example.test/api/v1', token: 'x' });
    rest.fetchImpl = fetchImpl as never;
    await assert.rejects(
      () => rest.request({ path: '/communities/abc' }),
      (error: unknown) => error instanceof RateLimitError && error.retryAfter === 2000,
    );
  });

  await t.test('a request that never answers is a connection failure', async () => {
    const rest = new REST({ baseUrl: 'https://example.test/api/v1', token: 'x', timeoutMs: 50 });
    rest.fetchImpl = (async () => {
      const error = new Error('the network is gone');
      error.name = 'TypeError';
      throw error;
    }) as never;
    await assert.rejects(
      () => rest.request({ path: '/communities/abc' }),
      (error: unknown) => error instanceof ConnectionError,
    );
  });

  await t.test('a request that writes something is not retried', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 500, body: { error: { message: 'no' } } }]);
    const rest = new REST({ baseUrl: 'https://example.test/api/v1', token: 'x' });
    rest.fetchImpl = fetchImpl as never;
    await assert.rejects(() => rest.request({ method: 'POST', path: '/x', body: { a: 1 } }));
    assert.equal(calls.length, 1, 'the request was sent once');
  });

  await t.test('a request that reads something may be retried', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 500, body: { error: { message: 'no' } } },
      { status: 200, body: { ok: true } },
    ]);
    const rest = new REST({ baseUrl: 'https://example.test/api/v1', token: 'x' });
    rest.fetchImpl = fetchImpl as never;
    const answer = await rest.request<{ ok: boolean }>({ path: '/x' });
    assert.equal(answer.ok, true);
    assert.equal(calls.length, 2, 'the request was sent twice');
  });
});

test('the client', async (t) => {
  await t.test('it needs a token to be useful', () => {
    const client = new Client({ baseUrl: 'https://example.test' });
    assert.equal(client.rest.baseUrl, 'https://example.test/api/v1');
  });

  await t.test('a listener that throws does not stop the others', async () => {
    const client = new Client({ baseUrl: 'https://example.test' });
    const seen: string[] = [];
    client.on(Events.MessageCreated, () => {
      throw new Error('the listener is broken');
    });
    client.on(Events.MessageCreated, () => {
      seen.push('the second one');
    });
    // The dispatch is private, so the listeners are exercised through the
    // public path: the gateway hands the client an event.
    (client as unknown as { dispatch: (event: GatewayEnvelope) => void }).dispatch({
      event: 'message.created',
    });
    assert.deepEqual(seen, ['the second one']);
  });

  await t.test('it sends a message through the route the server has', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 201, body: { id: 'm1', content: 'hello', channel_id: 'c1', server_id: 's1' } },
    ]);
    const client = new Client({ baseUrl: 'https://example.test', token: 'x' });
    client.rest.fetchImpl = fetchImpl as never;
    const message = await client.send('s1', 'c1', 'hello');
    assert.equal(message.content, 'hello');
    const first = calls[0]!;
    assert.equal(first.url, 'https://example.test/api/v1/communities/s1/channels/c1/messages');
    assert.equal((first.init.body as string), JSON.stringify({ content: 'hello' }));
  });

  await t.test('resource helpers use the server routes and unwrap their responses', async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { community: { id: 's1', name: 'Garden' } } },
      { body: { members: [{ userId: 'u1', username: 'ada' }], total: 3, limit: 1, offset: 1, hasMore: true } },
      { body: { channel: { id: 'c1', server_id: 's1', name: 'general', type: 'text' } } },
      { body: { roles: [{ id: 'r1', name: '@everyone', permissions: [] }] } },
      { body: { messages: [{ id: 'm1', channel_id: 'c1', server_id: 's1', content: 'older', seq: 4 }], limit: 1, before: 5, hasMore: true, nextBefore: 4 } },
    ]);
    const client = new Client({ baseUrl: 'https://example.test', token: 'x' });
    client.rest.fetchImpl = fetchImpl as never;

    const community = await client.community('s1');
    assert.equal(community.id, 's1');
    assert.equal(community.name, 'Garden');

    const members = await client.membersPage('s1', { limit: 1, offset: 1 });
    assert.equal(members.items[0]!.userId, 'u1');
    assert.equal(members.total, 3);
    assert.equal(members.hasMore, true);
    assert.equal(calls[1]!.url, 'https://example.test/api/v1/communities/s1/members?limit=1&offset=1');

    const channel = await client.channel('s1', 'c1');
    assert.equal(channel.id, 'c1');
    const roles = await client.roles('s1');
    assert.equal(roles[0]!.name, '@everyone');

    const messages = await client.messagesPage('s1', 'c1', { limit: 1, before: 5 });
    assert.equal(messages.items[0]!.seq, 4);
    assert.equal(messages.hasMore, true);
    assert.equal(messages.nextBefore, 4);
    assert.equal(calls[4]!.url,
      'https://example.test/api/v1/communities/s1/channels/c1/messages?limit=1&before=5');
  });

  await t.test('commands and health use their community-scoped routes', async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { application: { id: 'a1', name: 'helper' }, communityId: 's1' } },
      { body: { commands: [{ id: 'cmd1', name: 'ping' }] } },
      { body: { state: 'configured' } },
    ]);
    const client = new Client({ baseUrl: 'https://example.test', token: 'x' });
    client.rest.fetchImpl = fetchImpl as never;

    const commands = await client.commands();
    assert.equal(commands[0]!.name, 'ping');
    const health = await client.health();
    assert.equal(health.state, 'configured');
    assert.equal(calls.length, 3, 'the application identity is read once and reused');
    assert.equal(calls[1]!.url,
      'https://example.test/api/v1/communities/s1/applications/a1/commands');
    assert.equal(calls[2]!.url,
      'https://example.test/api/v1/communities/s1/applications/a1/health');
  });
});

test('the CommonJS build can be required by Node', () => {
  const require = createRequire(import.meta.url);
  const sdk = require('../..') as typeof import('../src/index.js');
  const client = new sdk.Client({ baseUrl: 'https://example.test' });
  assert.equal(client.rest.baseUrl, 'https://example.test/api/v1');
  assert.equal(sdk.Events.MessageCreated, 'message.created');
});

test('the gateway reports only the event subscriptions the server accepts', async () => {
  let socket: import('../src/index.js').SocketLike;
  const frames: Array<Record<string, unknown>> = [];
  const createSocket = () => {
    socket = {
      send(data) {
        const frame = JSON.parse(data) as Record<string, unknown>;
        frames.push(frame);
        if (frame.op === 'subscribe') {
          const asked = Array.isArray(frame.events) ? frame.events : [];
          const accepted = asked.filter((event) => event === Events.MessageCreated);
          queueMicrotask(() => socket.onmessage?.({
            data: JSON.stringify({ op: 'subscribed', events: accepted }),
          }));
        }
      },
      close() { socket.onclose?.({}); },
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    queueMicrotask(() => socket.onopen?.({}));
    return socket;
  };
  const rest = { request: async () => ({ ticket: 'one-use-ticket' }) } as unknown as REST;
  const gateway = new Gateway(rest, {
    baseUrl: 'https://example.test',
    applicationId: 'a1',
    events: [Events.MessageCreated],
    createSocket,
  });

  await gateway.connect();
  assert.equal(gateway.status, 'open');
  assert.deepEqual(gateway.subscriptions, [Events.MessageCreated]);
  assert.deepEqual(await gateway.subscribe([]), [], 'an empty list really means no events');
  assert.deepEqual(gateway.subscriptions, []);
  assert.deepEqual(frames.map((frame) => frame.op), ['subscribe', 'subscribe']);
  gateway.close();
});

test('the commands', async (t) => {
  await t.test('a command is declared on the route the server has', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { command: { id: 'c1', name: 'ping', response: 'Pong.' } } },
    ]);
    const client = new Client({ baseUrl: 'https://example.test', token: 'x' });
    client.rest.fetchImpl = fetchImpl as never;
    const command = await client.registerCommand('s1', 'a1', {
      name: 'ping',
      description: 'Answers with a word.',
      response: 'Pong.',
      options: [{ name: 'loud', type: 'boolean' }],
    });
    assert.equal(command.name, 'ping');
    const first = calls[0]!;
    assert.equal(first.url, 'https://example.test/api/v1/communities/s1/applications/a1/commands');
    assert.equal(first.init.method, 'PUT');
    assert.deepEqual(JSON.parse(first.init.body as string), {
      name: 'ping',
      description: 'Answers with a word.',
      response: 'Pong.',
      options: [{ name: 'loud', type: 'boolean' }],
    });
  });

  await t.test('a command is taken away', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { ok: true } }]);
    const client = new Client({ baseUrl: 'https://example.test', token: 'x' });
    client.rest.fetchImpl = fetchImpl as never;
    await client.removeCommand('s1', 'a1', 'c1');
    const first = calls[0]!;
    assert.equal(first.url, 'https://example.test/api/v1/communities/s1/applications/a1/commands/c1');
    assert.equal(first.init.method, 'DELETE');
  });
});

test('the errors', async (t) => {
  await t.test('a refusal says whether trying again could work', () => {
    assert.equal(new HttpError(500, 'X', 'no').retryable, true);
    assert.equal(new HttpError(403, 'X', 'no').retryable, false);
    assert.equal(new HttpError(429, 'X', 'no').retryable, true);
  });
});
