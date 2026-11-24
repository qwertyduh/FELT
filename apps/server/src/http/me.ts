import type { FastifyInstance } from 'fastify';

export interface MeResponse {
  userId: string;
  isAnonymous: boolean;
}

/** Authenticated (default-deny). P10 adds the username. */
export function registerMe(app: FastifyInstance): void {
  app.get('/me', async (request): Promise<MeResponse> => {
    return { userId: request.user.userId, isAnonymous: request.user.isAnonymous };
  });
}
