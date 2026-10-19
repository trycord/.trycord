/**
 * The session, as the application sees it.
 *
 * One provider owns the session manager, the API client and the realtime
 * client, and hands them down. The screens ask for a thing ("sign in",
 * "sign out") and never touch the storage or the socket themselves.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {ApiClient} from '../api/client';
import {endpoints, RegistrationPayload} from '../api';
import {User} from '../api/types';
import {RealtimeClient, RealtimeStatus} from '../realtime/socket';
import {asyncStorageStore} from '../storage/asyncStorage';
import {defaultSecureStore} from '../storage/keychain';
import {realtimeUrl} from './instance';
import {ActiveInstance, SessionManager, SignInOutcome} from './sessionManager';

export type SessionPhase = 'restoring' | 'signed-out' | 'signed-in';

export interface SessionContextValue {
  phase: SessionPhase;
  instance: ActiveInstance | null;
  user: User | null;
  api: ApiClient;
  realtime: RealtimeClient;
  realtimeStatus: RealtimeStatus;
  signIn(
    url: string,
    username: string,
    password: string,
  ): Promise<SignInOutcome>;
  completeTwoFactor(challengeToken: string, code: string): Promise<void>;
  register(
    url: string,
    payload: RegistrationPayload,
  ): Promise<{signedIn: boolean}>;
  signOut(): Promise<void>;
  useInstance(url: string, name?: string): Promise<ActiveInstance>;
  /** The instances this reader has used, most recent first. */
  knownInstances(): Promise<string[]>;
  refreshUser(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const manager = useRef<SessionManager | null>(null);
  if (manager.current === null) {
    manager.current = new SessionManager({
      secureStore: defaultSecureStore,
      localStore: asyncStorageStore,
    });
  }
  const session = manager.current;

  const [phase, setPhase] = useState<SessionPhase>('restoring');
  const [instance, setInstance] = useState<ActiveInstance | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('offline');

  const realtime = useMemo(
    () =>
      new RealtimeClient({
        ticket: async () => endpoints.realtimeTicket(session.api),
        urlFor: (ticket: string) => realtimeUrl(session.api.base, ticket),
      }),
    [session],
  );

  useEffect(() => realtime.onStatus(setRealtimeStatus), [realtime]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const restored = await session.restore();
        if (cancelled) return;
        if (restored) {
          setInstance(restored.instance);
          setUser(restored.user);
          setPhase('signed-in');
          return;
        }
        setPhase('signed-out');
      } catch {
        if (cancelled) return;
        // A network failure is not a sign-out. The token is still held, so the
        // app opens and the screens report that the server cannot be reached.
        if (session.signedIn) {
          setInstance(session.currentInstance);
          setPhase('signed-in');
          return;
        }
        setPhase('signed-out');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (phase !== 'signed-in') {
      realtime.disconnect();
      return;
    }
    realtime.connect();
    return () => realtime.disconnect();
  }, [phase, realtime]);

  const signIn = useCallback(
    async (
      url: string,
      username: string,
      password: string,
    ): Promise<SignInOutcome> => {
      const outcome = await session.signIn(url, username, password);
      if (outcome.status === 'signed-in') {
        setInstance(session.currentInstance);
        setUser(session.currentUser);
        setPhase('signed-in');
      }
      return outcome;
    },
    [session],
  );

  const completeTwoFactor = useCallback(
    async (challengeToken: string, code: string) => {
      const signedIn = await session.completeTwoFactor(challengeToken, code);
      setInstance(session.currentInstance);
      setUser(signedIn);
      setPhase('signed-in');
    },
    [session],
  );

  const register = useCallback(
    async (
      url: string,
      payload: RegistrationPayload,
    ): Promise<{signedIn: boolean}> => {
      const outcome = await session.register(url, payload);
      if (outcome.signedIn) {
        setInstance(session.currentInstance);
        setUser(outcome.user);
        setPhase('signed-in');
      }
      return outcome;
    },
    [session],
  );

  const signOut = useCallback(async () => {
    await session.signOut();
    setUser(null);
    setPhase('signed-out');
  }, [session]);

  const useInstance = useCallback(
    async (url: string, name?: string) => {
      const chosen = await session.useInstance(url, name);
      setInstance(chosen);
      return chosen;
    },
    [session],
  );

  const refreshUser = useCallback(async () => {
    const refreshed = await session.refreshUser();
    setUser(refreshed);
  }, [session]);

  const knownInstances = useCallback(
    () => session.knownInstances(),
    [session],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      phase,
      instance,
      user,
      api: session.api,
      realtime,
      realtimeStatus,
      signIn,
      completeTwoFactor,
      register,
      signOut,
      useInstance,
      knownInstances,
      refreshUser,
    }),
    [
      phase,
      instance,
      user,
      session,
      realtime,
      realtimeStatus,
      signIn,
      completeTwoFactor,
      register,
      signOut,
      useInstance,
      knownInstances,
      refreshUser,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside a SessionProvider.');
  }
  return value;
}
