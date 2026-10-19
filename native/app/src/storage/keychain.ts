/**
 * The production secure store.
 *
 * This is the only file that imports the native keystore. Everything else
 * takes a SecureStore, so the rest of the client - and the unit tests - never
 * need a device to talk about credentials.
 */

import * as Keychain from 'react-native-keychain';

import {createSecureStore, KeychainLike} from './secureStore';

export const defaultSecureStore = createSecureStore(
  Keychain as unknown as KeychainLike,
);
