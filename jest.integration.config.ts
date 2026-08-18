import type { Config } from 'jest';

/**
 * Integration tests. These run against a REAL Redis (localhost:6379 by default,
 * override with REDIS_HOST / REDIS_PORT) because mutual exclusion cannot be
 * verified against a mock — v1.0.0 shipped three features that passed their
 * mocked unit tests while providing no locking at all.
 *
 * Run with: npm run test:e2e
 */
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  transformIgnorePatterns: ['node_modules/(?!(redlock)/)'],
  testEnvironment: 'node',
  // Jest's node sandbox drops globalThis.crypto on Node 18/20, which
  // @nestjs/schedule needs to register a cron job. See the setup file.
  setupFiles: ['<rootDir>/test/setup-globals.ts'],
  testTimeout: 30_000,
  // Concurrency assertions are meaningless if suites race each other on the
  // same Redis keyspace.
  maxWorkers: 1,
};

export default config;
