/**
 * The session.
 *
 * One place decides which instance the client is talking to, which token is
 * presented to it, and what happens to that token when the reader signs out
 * or moves to another instance.
 *
 * The rules it holds to:
 *   - A token is filed in the platform keystore under the origin of the
 *     instance that issued it. A token for one instance is never presented
 *     to another.
 *   - A network failure is not a sign-out. Only an answer from the server
 *     saying the session is gone ends the session.
 *   - Moving to another instance forgets the session of the instance being
 *     left, so nothing signed in there travels along on a shared device.
 */

import {ApiClient, FetchLike} from '../api/client';
import {isApiError} from '../api/errors';
import {endpoints, RegistrationPayload} from '../api';
import {normalizeUser} from '../api/normalize';
import {LoginResult, User} from '../api/types';
import {KeyValueStore} from '../storage/localStore';
import {SecureStore} from '../storage/secureStore';
import {
  CURRENT_INSTANCE_KEY,
  instanceOrigin,
  KNOWN_INSTANCES_KEY,
  normalizeInstanceUrl,
  sessionKeyFor,
} from './instance';

export interface ActiveInstance {
  url: string;
  origin: string;
  name: string;
}

export type SignInOutcome =
  | {status: 'signed-in'}
  | {status: 'mfa-required'; challengeToken: string; expiresInSeconds: number};

export interface SessionManagerOptions {
  secureStore: SecureStore;
  localStore: KeyValueStore;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface RestoredSession {
  instance: ActiveInstance;
  user: User | null;
}

export class SessionManager {
  readonly api: ApiClient;

  private readonly secureStore: SecureStore;
  private readonly localStore: KeyValueStore;
  private instance: ActiveInstance | null = null;
  private user: User | null = null;

  constructor(options: SessionManagerOptions) {
    this.secureStore = options.secureStore;
    this.localStore = options.localStore;
    this.api = new ApiClient({
      baseUrl: '',
      token: null,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  }

  get currentInstance(): ActiveInstance | null {
    return this.instance;
  }

  get currentUser(): User | null {
    return this.user;
  }

  get signedIn(): boolean {
    return !!this.api.bearer;
  }

  /**
   * Reads the remembered instance and its token, and checks that the token
   * still works.
   *
   * Returns null when there is nothing to restore, or when the server says
   * the session is no longer valid. A network failure is raised rather than
   * swallowed, so the app can say "the connection is down" instead of
   * "you have been signed out".
   */
  async restore(): Promise<RestoredSession | null> {
    const url = await this.localStore.get(CURRENT_INSTANCE_KEY);
    if (!url) return null;
    const base = normalizeInstanceUrl(url);
    if (!base) return null;

    const origin = instanceOrigin(base);
    const token = await this.secureStore.get(sessionKeyFor(origin));
    if (!token) return null;

    this.api.setBaseUrl(base);
    this.api.setToken(token);
    this.instance = {url: base, origin, name: origin};

    try {
      const user = await endpoints.me(this.api);
      this.user = user;
      return {instance: this.instance, user};
    } catch (error) {
      if (isApiError(error) && error.isAuthFailure) {
        await this.forgetToken();
        this.instance = null;
        this.user = null;
        this.api.setToken(null);
        return null;
      }
      throw error;
    }
  }

  /**
   * Points the client at an instance and remembers it.
   *
   * The session of the instance being left is forgotten: a shared device
   * that moves to another instance must not carry the first one's token
   * along.
   */
  async useInstance(url: string, name?: string): Promise<ActiveInstance> {
    const base = normalizeInstanceUrl(url);
    if (!base) {
      throw new Error('That is not a full web address.');
    }
    const previous = this.instance;
    if (previous && previous.origin !== instanceOrigin(base)) {
      await this.forgetToken(previous.origin);
    }
    const origin = instanceOrigin(base);
    this.instance = {url: base, origin, name: name || origin};
    this.api.setBaseUrl(base);
    await this.localStore.set(CURRENT_INSTANCE_KEY, base);
    await this.rememberInstance(base);
    return this.instance;
  }

  /** The instances this reader has used, most recent first. */
  async knownInstances(): Promise<string[]> {
    const raw = await this.localStore.get(KNOWN_INSTANCES_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(entry => typeof entry === 'string' && !!entry);
    } catch {
      return [];
    }
  }

  async signIn(
    url: string,
    username: string,
    password: string,
  ): Promise<SignInOutcome> {
    await this.useInstance(url);
    const outcome = await endpoints.login(this.api, {username, password});
    if ('mfaRequired' in outcome) {
      return {
        status: 'mfa-required',
        challengeToken: outcome.challengeToken,
        expiresInSeconds: outcome.expiresInSeconds,
      };
    }
    await this.acceptToken(outcome);
    return {status: 'signed-in'};
  }

  async completeTwoFactor(challengeToken: string, code: string): Promise<User | null> {
    const result: LoginResult = await endpoints.twoFactorVerify(
      this.api,
      challengeToken,
      code,
    );
    await this.acceptToken(result);
    return this.user;
  }

  /**
   * Creates an account.
   *
   * The server may answer with a session, or with nothing at all, when the
   * account has to be approved or its address verified first. The caller is
   * told which happened.
   */
  async register(
    url: string,
    payload: RegistrationPayload,
  ): Promise<{signedIn: boolean; user: User | null}> {
    await this.useInstance(url);
    const result = await endpoints.register(this.api, payload);
    if (!result) {
      return {signedIn: false, user: null};
    }
    await this.acceptToken(result);
    return {signedIn: true, user: this.user};
  }

  /** Reads the account behind the current token. */
  async refreshUser(): Promise<User | null> {
    if (!this.signedIn) return null;
    try {
      const user = await endpoints.me(this.api);
      this.user = user;
      return user;
    } catch (error) {
      if (isApiError(error) && error.isAuthFailure) {
        await this.forgetToken();
        this.api.setToken(null);
        this.user = null;
        return null;
      }
      throw error;
    }
  }

  /**
   * Ends the session.
   *
   * The server is told first, so the session shows up in the account's own
   * list of signed-in devices and can be ended from there. The local token is
   * removed whether or not the server answered, because the reader asked to
   * sign out either way.
   */
  async signOut(): Promise<void> {
    try {
      await endpoints.logout(this.api);
    } catch {
      // The session is going regardless of what the server said.
    }
    await this.forgetToken();
    this.api.setToken(null);
    this.user = null;
  }

  /** Removes the stored token for one origin. */
  async forgetToken(origin?: string): Promise<void> {
    const target = origin ?? (this.instance ? this.instance.origin : null);
    if (!target) return;
    await this.secureStore.remove(sessionKeyFor(target));
  }

  private async acceptToken(result: LoginResult): Promise<void> {
    if (!this.instance) {
      throw new Error('No instance has been chosen yet.');
    }
    const token = String(result.token || '');
    if (!token) {
      throw new Error('The server did not return a session.');
    }
    await this.secureStore.set(sessionKeyFor(this.instance.origin), token);
    this.api.setToken(token);
    this.user = normalizeUser(result.user);
  }

  private async rememberInstance(url: string): Promise<void> {
    const known = await this.knownInstances();
    const next = [url, ...known.filter(entry => entry !== url)].slice(0, 8);
    await this.localStore.set(KNOWN_INSTANCES_KEY, JSON.stringify(next));
  }
}
