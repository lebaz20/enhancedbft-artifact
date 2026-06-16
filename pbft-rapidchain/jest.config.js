module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'services/**/*.js',
    'utils/**/*.js',
    'constants/**/*.js',
    '!**/node_modules/**',
    '!**/coverage/**',
    '!services/coreserver.js',
    '!services/idaGossip.js',
    '!services/p2pserver.js'
  ],
  testMatch: ['**/__tests__/**/*.js', '**/*.test.js'],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50
    }
  },
  testTimeout: 10000,
  verbose: true
}
