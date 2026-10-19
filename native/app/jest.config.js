// Jest configuration for the Trycord native client.
//
// The suite covers the platform-independent parts of the client: the HTTP
// client, the draft store, the deep-link parser, the push payload builder and
// the design tokens. None of those import a native module, so they run under
// the React Native preset without a device or an emulator.

module.exports = {
  preset: 'react-native',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.test.ts',
    '<rootDir>/src/**/__tests__/**/*.test.tsx',
  ],
  transformIgnorePatterns: [
    'node_modules/(?!(?:@react-native|react-native|@react-navigation|react-native-svg|' +
      'react-native-screens|react-native-safe-area-context|@react-native-async-storage|@notifee)/)',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/__tests__/**'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
};
