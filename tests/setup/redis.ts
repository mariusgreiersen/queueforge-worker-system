import type { TestProject } from 'vitest/node';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string;
  }
}

/**
 * Provides a real Redis to the integration suites.
 * - REDIS_URL set (e.g. GitHub Actions service container): use it as-is.
 * - Otherwise: start a throwaway redis:7.4-alpine container with Testcontainers (requires Docker).
 */
export default async function setup(project: TestProject) {
  const existing = process.env.REDIS_URL;
  if (existing) {
    project.provide('redisUrl', existing);
    return;
  }

  let container: StartedTestContainer;
  try {
    container = await new GenericContainer('redis:7.4-alpine')
      .withCommand(['redis-server', '--maxmemory-policy', 'noeviction', '--save', '', '--appendonly', 'no'])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
  } catch (err) {
    throw new Error(
      `Integration tests need Redis. Set REDIS_URL or make Docker available for Testcontainers.\nCause: ${(err as Error).message}`,
      { cause: err },
    );
  }
  project.provide('redisUrl', `redis://${container.getHost()}:${container.getMappedPort(6379)}`);
  return async () => {
    await container.stop();
  };
}
