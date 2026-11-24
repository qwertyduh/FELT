import { buildApp } from './app';
import { loadEnv } from './config/env';
import { closeRedis, connectRedis, createRedis } from './config/redis';

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // The client is created before the app (buildApp needs it), so log through a late-bound reference.
  const late: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  const redis = createRedis(env.REDIS_URL, {
    warn: (obj, msg) => late.app?.log.warn(obj, msg),
    info: (obj, msg) => late.app?.log.info(obj, msg),
  });
  const server = await buildApp(env, { redis });
  late.app = server;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info({ signal }, 'shutting down');
    try {
      await server.close();
      await closeRedis(redis);
      process.exit(0);
    } catch (err) {
      server.log.error(err, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  connectRedis(redis);
  try {
    await server.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    server.log.error(err, 'failed to start');
    process.exit(1);
  }
}

void main();
