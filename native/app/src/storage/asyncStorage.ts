/**
 * The production local store.
 *
 * AsyncStorage is backed by SQLite on Android and by a small file-backed store
 * on iOS. It holds nothing secret.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {KeyValueStore} from './localStore';

export const asyncStorageStore: KeyValueStore = {
  async get(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  },
  async set(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  },
  async remove(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
  },
};
