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

/** http(s) URL, trailing slashes stripped so `${url}/auth/v1` matches the token `iss` exactly. */
const httpUrl = z
  .string({ error: 'is required in production (e.g. https://<ref>.supabase.co)' })
  .transform((value, ctx) => {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
      if (url.search !== '' || url.hash !== '') throw new Error('query');
      return url.href.replace(/\/+$/, '');
    } catch {
      ctx.addIssue({ code: 'custom', message: `"${value}" is not a valid http(s) URL` });
      return z.NEVER;
    }
  });

export const envSchema = z
  .object({
    // Dev: `PORT=3001 npm run dev` runs the server on another port if 3000 is taken.
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    HOST: z.string().min(1).default('0.0.0.0'),
    /**
     * Trust X-Forwarded-For (needed for correct `request.ip` and per-IP rate limits behind
     * Railway's proxy). Defaults to true in production only; set TRUST_PROXY=false to disable.
     */
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    WEB_ORIGIN: originList,
    REDIS_URL: z
      .string({ error: 'is required in production (e.g. redis://host:6379)' })
      .refine((v) => /^rediss?:\/\/\S+$/.test(v), 'must be a redis:// or rediss:// URL'),
    SUPABASE_URL: httpUrl,
    /** Optional override; defaults to `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. */
    SUPABASE_JWKS_URL: httpUrl.optional(),
    /** Server-only secret. Required in production; without it the username routes answer 503. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1).optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.SUPABASE_SERVICE_ROLE_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SUPABASE_SERVICE_ROLE_KEY'],
        message: 'is required in production',
      });
    }
  });

type ParsedEnv = z.infer<typeof envSchema>;
/** Validated config; `SUPABASE_JWKS_URL` is always resolved. */
export type Env = Omit<ParsedEnv, 'SUPABASE_JWKS_URL' | 'TRUST_PROXY'> & {
  SUPABASE_JWKS_URL: string;
  TRUST_PROXY: boolean;
};

/** Parse and validate environment variables. Throws one error listing every problem. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Treat empty strings as unset so `PORT=` falls back to the default instead of coercing to 0.
  const cleaned: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = source[key];
    cleaned[key] = value === undefined || value.trim() === '' ? undefined : value;
  }
  // Dev conveniences: the schema stays strict, so production still requires both values.
  // An invalid NODE_ENV falls through untouched and is reported by the schema.
  const nodeEnv = cleaned.NODE_ENV ?? 'development';
  if (nodeEnv === 'development') cleaned.WEB_ORIGIN ??= 'http://localhost:5173';
  if (nodeEnv === 'development' || nodeEnv === 'test')
    cleaned.REDIS_URL ??= 'redis://localhost:6379';
  if (nodeEnv === 'development' || nodeEnv === 'test')
    cleaned.SUPABASE_URL ??= 'http://127.0.0.1:54321';
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const data = {
    ...result.data,
    TRUST_PROXY: result.data.TRUST_PROXY ?? result.data.NODE_ENV === 'production',
  };
  const jwksUrl = data.SUPABASE_JWKS_URL ?? `${data.SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
  // Signing keys fetched over plain http could be swapped by a network attacker.
  if (data.NODE_ENV === 'production' && !jwksUrl.startsWith('https://')) {
    throw new Error(
      'Invalid environment configuration:\n  - SUPABASE_JWKS_URL: must be https in production',
    );
  }
  return { ...data, SUPABASE_JWKS_URL: jwksUrl };
}
