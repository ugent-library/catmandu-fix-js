import { createDefaultEsmPreset } from "ts-jest";

const presetConfig = createDefaultEsmPreset({});

export default {
  ...presetConfig,
  testEnvironment: 'node',
  testMatch: [
    '**/tests/**/*.test.ts',
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  // Tests run the compiled output (they import from dist/), so coverage is
  // collected from dist/*.js. These files are 1:1 with src/*.ts.
  collectCoverageFrom: [
    'dist/**/*.js',
    '!dist/**/*.d.ts',
  ],
  testTimeout: 30000,
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.ts'],
};
