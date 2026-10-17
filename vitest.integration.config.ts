import { defineConfig } from 'vitest/config';

// API, integration and reliability tests against a real Redis.
// Uses REDIS_URL when set (CI service container); otherwise starts Redis with Testcontainers.
export default defineConfig({
  test: {
    include: ['tests/api/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/reliability/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/setup/redis.ts'],
    // Files run one at a time: reliability tests spawn and kill worker processes and measure timing.
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
