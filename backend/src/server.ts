import Fastify from 'fastify';
import { authRoutes } from './routes/auth';

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => {
  return { status: 'ok', project: 'FELT' };
});
fastify.register(authRoutes, { prefix: '/api/auth' });

const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    console.log('Backend running on port 3000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();