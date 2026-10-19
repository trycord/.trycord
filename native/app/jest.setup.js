// Jest environment setup.
//
// The unit tests in src/**\/__tests__ cover the platform-independent parts of
// the client: the HTTP client, the draft store, the deep-link parser, the push
// payload builder and the design tokens. Those modules never import a native
// module, so the mocks below exist only so that a component import elsewhere
// does not blow up the whole run.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(async () => false),
  getGenericPassword: jest.fn(async () => false),
  resetGenericPassword: jest.fn(async () => true),
}));
