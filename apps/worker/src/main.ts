import { createLogger } from '@queueforge/shared/node';
import { loadWorkerConfig } from './config';
import { startWorker } from './worker';

const config = loadWorkerConfig();
const logger = createLogger({ service: 'queueforge-worker', level: config.logLevel, pretty: config.logPretty });

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

const instance = await startWorker(config, logger);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    logger.warn({ signal }, 'Second signal received; exiting immediately');
    process.exit(1);
  }
  shuttingDown = true;
  logger.info({ signal, timeoutMs: config.shutdownTimeoutMs }, 'Graceful shutdown requested');

  // worker.close() waits for in-flight jobs. If they outlast the timeout we exit anyway; their
  // locks then expire and another worker recovers them through stalled-job detection.
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), config.shutdownTimeoutMs).unref());
  const outcome = await Promise.race([instance.close().then(() => 'closed' as const), timeout]);
  if (outcome === 'timeout') {
    logger.warn('Shutdown timeout reached with jobs still active; they will be recovered by stalled detection');
    process.exit(1);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
