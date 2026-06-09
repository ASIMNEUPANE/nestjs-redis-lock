import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  // redlock v5 ships as ESM — without this Jest throws "Cannot use import statement outside a module"
  transformIgnorePatterns: ['node_modules/(?!(redlock)/)'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/testing.ts',
  ],
  coverageDirectory: './coverage',
  coverageThreshold: {
    global: { lines: 90, branches: 85, functions: 90, statements: 90 },
  },
  testEnvironment: 'node',
};

export default config;
