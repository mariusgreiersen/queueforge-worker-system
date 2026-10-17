import { defineConfig } from 'vitest/config';

// Unit tests: pure logic, no Redis, no processes.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
