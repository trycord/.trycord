/**
 * The end-to-end encryption API.
 *
 * The surface the server exposes under `/api/e2ee`. Every route is
 * authenticated, every route that touches one account's material refuses
 * another account's, and no route accepts a plaintext message body: what
 * crosses it is a sealed ratchet state, a sealed key, or a public key.
 *
 * The names here are the server's route names, so a reader can match them
 * against `backend/src/routes/e2ee.js` line by line.
 */

import {ApiClient} from '../api/client';

export interface E2eeDevice {
  id: string;
  label: string;
  identityKey: string;
  identityDhKey: string;
  signedPreKey: string;
  keyFingerprint: string;
  createdAt: string | null;
  revokedAt: string | null;
}

export interface E2eeDeviceRegistration {
  id: string;
  label: string;
  identityKey: string;
  identityDhKey: string;
  signedPreKey: string;
  keyFingerprint?: string;
  signature?: string;
  wrappedPrivateKey?: string | null;
  recoverySalt?: string | null;
  recoveryIterations?: number | null;
}

export interface E2eePrekeyBundle {
  deviceId: string;
  identityKey: string;
  identityDhKey: string;
  signedPreKey: string;
  signature?: string;
  oneTimePreKeys: {id: string; publicKey: string}[];
}

export interface E2eeSession {
  id: string;
  deviceId: string;
  peerDeviceId: string;
  peerUserId: string;
  conversationId: string | null;
  sendCounter: number;
  recvCounter: number;
  ratchetState: string | null;
  closedAt: string | null;
}

export interface E2eeSealedKey {
  deviceId: string;
  epoch: number;
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface E2eeConversationState {
  conversationId: string;
  encrypted: boolean;
  epoch: number;
  deviceEpochs: Record<string, number>;
  missingDevices: string[];
}

export interface E2eeSafetyNumber {
  userId: string;
  safetyNumber: string;
  fingerprint: string;
  devices: {id: string; keyFingerprint: string}[];
}

export async function listDevices(client: ApiClient): Promise<E2eeDevice[]> {
  const raw = await client.get<{devices?: E2eeDevice[]}>('/api/e2ee/devices');
  return raw && Array.isArray(raw.devices) ? raw.devices : [];
}

export async function registerDevice(
  client: ApiClient,
  device: E2eeDeviceRegistration,
): Promise<E2eeDevice | null> {
  const raw = await client.post<{device?: E2eeDevice}>('/api/e2ee/devices', device);
  return (raw && raw.device) || null;
}

export async function device(
  client: ApiClient,
  deviceId: string,
): Promise<E2eeDevice | null> {
  const raw = await client.get<{device?: E2eeDevice}>(
    `/api/e2ee/devices/${encodeURIComponent(deviceId)}`,
  );
  return (raw && raw.device) || null;
}

export async function revokeDevice(
  client: ApiClient,
  deviceId: string,
): Promise<E2eeDevice | null> {
  const raw = await client.delete<{device?: E2eeDevice}>(
    `/api/e2ee/devices/${encodeURIComponent(deviceId)}`,
  );
  return (raw && raw.device) || null;
}

export async function publishPrekeys(
  client: ApiClient,
  deviceId: string,
  bundle: {
    identityKey: string;
    identityDhKey: string;
    signedPreKey: string;
    signature?: string;
    oneTimePreKeys: {id: string; publicKey: string}[];
  },
): Promise<unknown> {
  return client.post('/api/e2ee/prekeys', {deviceId, ...bundle});
}

export async function fetchPrekeyBundle(
  client: ApiClient,
  deviceId: string,
): Promise<E2eePrekeyBundle | null> {
  const raw = await client.get<{bundle?: E2eePrekeyBundle}>(
    `/api/e2ee/prekeys/${encodeURIComponent(deviceId)}`,
  );
  return (raw && raw.bundle) || null;
}

export async function createSession(
  client: ApiClient,
  session: {
    id: string;
    deviceId: string;
    peerDeviceId: string;
    peerUserId?: string;
    conversationId?: string | null;
    ratchetState?: string | null;
    sendCounter: number;
    recvCounter: number;
  },
): Promise<E2eeSession | null> {
  const raw = await client.post<{session?: E2eeSession}>('/api/e2ee/sessions', session);
  return (raw && raw.session) || null;
}

export async function listSessions(
  client: ApiClient,
  deviceId: string,
): Promise<E2eeSession[]> {
  const raw = await client.get<{sessions?: E2eeSession[]}>('/api/e2ee/sessions', {
    query: {deviceId},
  });
  return raw && Array.isArray(raw.sessions) ? raw.sessions : [];
}

export async function session(
  client: ApiClient,
  sessionId: string,
): Promise<E2eeSession | null> {
  const raw = await client.get<{session?: E2eeSession}>(
    `/api/e2ee/sessions/${encodeURIComponent(sessionId)}`,
  );
  return (raw && raw.session) || null;
}

export async function updateSession(
  client: ApiClient,
  sessionId: string,
  body: {ratchetState: string | null; sendCounter: number; recvCounter: number},
): Promise<E2eeSession | null> {
  const raw = await client.patch<{session?: E2eeSession}>(
    `/api/e2ee/sessions/${encodeURIComponent(sessionId)}`,
    body,
  );
  return (raw && raw.session) || null;
}

export async function closeSession(
  client: ApiClient,
  sessionId: string,
): Promise<E2eeSession | null> {
  const raw = await client.delete<{session?: E2eeSession}>(
    `/api/e2ee/sessions/${encodeURIComponent(sessionId)}`,
  );
  return (raw && raw.session) || null;
}

export async function publishConversationKey(
  client: ApiClient,
  conversationId: string,
  body: {deviceId: string; epoch?: number; sealedKeys: E2eeSealedKey[]},
): Promise<unknown> {
  return client.post(
    `/api/e2ee/conversations/${encodeURIComponent(conversationId)}/key`,
    body,
  );
}

export async function conversationKey(
  client: ApiClient,
  conversationId: string,
  deviceId: string,
): Promise<unknown> {
  return client.get(
    `/api/e2ee/conversations/${encodeURIComponent(conversationId)}/key`,
    {query: {deviceId}},
  );
}

export async function conversationState(
  client: ApiClient,
  conversationId: string,
): Promise<E2eeConversationState | null> {
  const raw = await client.get<{state?: E2eeConversationState}>(
    `/api/e2ee/conversations/${encodeURIComponent(conversationId)}/state`,
  );
  return (raw && raw.state) || null;
}

export async function registerAttachment(
  client: ApiClient,
  attachment: {
    id: string;
    conversationId: string;
    filename?: string;
    mime?: string;
    size?: number;
    sealedKeys: E2eeSealedKey[];
  },
): Promise<unknown> {
  return client.post('/api/e2ee/attachments', attachment);
}

export async function attachment(
  client: ApiClient,
  attachmentId: string,
): Promise<unknown> {
  return client.get(`/api/e2ee/attachments/${encodeURIComponent(attachmentId)}`);
}

export async function saveBackup(
  client: ApiClient,
  backup: {
    salt: string;
    iterations?: number;
    iv: string;
    ciphertext: string;
    tag: string;
  },
): Promise<unknown> {
  return client.post('/api/e2ee/backup', backup);
}

export async function fetchBackup(client: ApiClient): Promise<unknown> {
  return client.get('/api/e2ee/backup');
}

export async function recoverDevice(
  client: ApiClient,
  body: {
    sourceDeviceId: string;
    recoveryProof: string;
    device: E2eeDeviceRegistration;
  },
): Promise<unknown> {
  return client.post('/api/e2ee/recovery', body);
}

export async function safetyNumber(
  client: ApiClient,
  peerUserId: string,
): Promise<E2eeSafetyNumber | null> {
  const raw = await client.get<{safetyNumber?: E2eeSafetyNumber}>(
    '/api/e2ee/safety-number',
    {query: {userId: peerUserId}},
  );
  return (raw && raw.safetyNumber) || null;
}
