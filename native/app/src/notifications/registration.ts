/**
 * The push registration contract.
 *
 * A device that wants to be told about a message while the app is closed has
 * to give the server a way to reach it, and the server has to keep that way
 * scoped to the instance that issued the session.
 *
 * The endpoint this calls does not exist on the server yet. The contract is
 * written down here so both halves can be built against the same shape, and
 * the call answers `false` - rather than throwing - when the instance does
 * not offer the endpoint, so the rest of the app carries on.
 */

import {ApiClient} from '../api/client';
import {ApiError} from '../api/errors';
import {PushDevice, PushPlatform} from './transport';

/** The path the server is expected to expose. */
export const PUSH_REGISTRATION_PATH = '/api/me/push-devices';

export interface PushRegistrationRequest {
  token: string;
  platform: PushPlatform;
  /** The instance the session belongs to, so one device can serve several. */
  instanceOrigin: string;
}

export interface PushRegistrationResult {
  registered: boolean;
  /** True when the instance has no such endpoint. */
  unsupported: boolean;
}

/**
 * Registers the device with the instance.
 *
 * Answers whether the instance accepted the registration. An instance that
 * does not offer the endpoint is reported, not hidden, because a person
 * asking for notifications deserves to be told that nothing is listening.
 */
export async function registerDevice(
  client: ApiClient,
  request: PushRegistrationRequest,
): Promise<PushRegistrationResult> {
  try {
    await client.post(PUSH_REGISTRATION_PATH, {
      token: request.token,
      platform: request.platform,
      instanceOrigin: request.instanceOrigin,
    });
    return {registered: true, unsupported: false};
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return {registered: false, unsupported: true};
    }
    throw error;
  }
}

/** Removes the device from the instance, for an account signing out. */
export async function unregisterDevice(
  client: ApiClient,
  request: PushRegistrationRequest,
): Promise<PushRegistrationResult> {
  try {
    await client.delete(
      `${PUSH_REGISTRATION_PATH}/${encodeURIComponent(request.token)}`,
    );
    return {registered: false, unsupported: false};
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return {registered: false, unsupported: true};
    }
    throw error;
  }
}

/** The device the transport found, ready to be registered. */
export function registrationFor(
  device: PushDevice,
  instanceOrigin: string,
): PushRegistrationRequest {
  return {
    token: device.token,
    platform: device.platform,
    instanceOrigin,
  };
}
