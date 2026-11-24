import { z } from 'zod';

const originList = z
  .string({ error: 'is required (comma-separated list of allowed origins)' })
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .pipe(
    z
      .array(
        z.string().transform((value, ctx) => {
          try {
            const url = new URL(value);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
            return url.origin; // normalises trailing slashes, default ports, case
          } catch {
            ctx.addIssue({ code: 'custom', message: `"${value}" is not a valid http(s) URL` });
            return z.NEVER;
          }
        }),
      )
      .min(1, 'must contain at least one origin'),
  );

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  WEB_ORIGIN: originList,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/** Parse and validate environment variables. Throws one error listing every problem. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Treat empty strings as unset so `PORT=` falls back to the default instead of coercing to 0.
  const cleaned: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = source[key];
    cleaned[key] = value === undefined || value.trim() === '' ? undefined : value;
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
