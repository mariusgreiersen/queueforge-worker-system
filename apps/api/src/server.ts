import { buildApp } from './app';
import { loadApiConfig } from './config';

const config = loadApiConfig();
const app = await buildApp({ config });

if (config.demoControlsEnabled) {
  app.log.warn('DEMO_CONTROLS_ENABLED=true: the worker crash endpoint is exposed. Local development only.');
}

let closing = false;
async function shutdown(signal: NodeJS.Signals) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'Shutting down API: refusing new requests, draining in-flight ones');
  const force = setTimeout(() => {
    app.log.error('Shutdown timed out; exiting');
    process.exit(1);
  }, 10_000);
  force.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
