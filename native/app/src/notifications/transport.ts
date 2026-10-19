/**
 * The push transport.
 *
 * The payload builder decides what leaves the device; the transport is the
 * platform plumbing that carries it. They are separate because the payload
 * rules are the part that must be right, and the part that can be tested
 * without a phone.
 */

import {PushPayload} from './payload';

export type PushPlatform = 'ios' | 'android';

export interface PushDevice {
  token: string;
  platform: PushPlatform;
}

export interface PushTransport {
  /** False when this platform or this build cannot carry push at all. */
  readonly available: boolean;
  /** Asks the system for permission. Answers whether it was given. */
  requestPermission(): Promise<boolean>;
  /** The device's registration token, when there is one. */
  currentDevice(): Promise<PushDevice | null>;
  /** Called when the registration token changes. */
  onToken(handler: (device: PushDevice) => void): () => void;
  /** Called when a notification arrives while the app is in front. */
  onNotification(handler: (payload: PushPayload) => void): () => void;
  /** Shows a notification the app raised itself. */
  present(payload: PushPayload): Promise<void>;
}
