import type { FastifyInstance } from 'fastify';

export interface HealthResponse {
  status: 'ok';
  uptime: number;
}

/** Liveness probe. P04 will extend the response with Redis status. */
export function registerHealth(app: FastifyInstance): void {
  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    uptime: process.uptime(),
  }));
}
