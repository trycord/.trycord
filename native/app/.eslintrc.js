module.exports = {
  root: true,
  extends: '@react-native',
  parserOptions: {
    project: './tsconfig.json',
  },
  ignorePatterns: ['node_modules/', 'android/', 'ios/', 'coverage/'],
  rules: {
    'react-native/no-inline-styles': 'warn',
    'no-console': ['error', {allow: ['warn', 'error']}],
  },
  overrides: [
    {
      files: ['**/__tests__/**/*.{ts,tsx}', 'jest.setup.js'],
      env: {jest: true},
      rules: {
        'no-console': 'off',
      },
    },
  ],
};
