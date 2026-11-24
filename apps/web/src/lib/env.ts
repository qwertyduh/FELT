export interface WebEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  serverUrl: string;
}

export interface RawWebEnv {
  [key: string]: unknown;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_SERVER_URL?: string;
}

const DEV_SUPABASE_URL = 'http://127.0.0.1:54321';
const DEV_SERVER_URL = 'http://127.0.0.1:3001';

function origin(name: string, value: string, problems: string[]): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    return url.href.replace(/\/+$/, '');
  } catch {
    problems.push(`${name} "${value}" is not a valid http(s) URL`);
    return '';
  }
}

/**
 * Validate the public web env. In dev the two URLs default to the local stack; the anon key never
 * has a default. Throws one error listing every problem (never echoes the key).
 */
export function readWebEnv(raw: RawWebEnv, dev: boolean): WebEnv {
  const problems: string[] = [];
  const get = (v: string | undefined) => (v ?? '').trim();

  const urlRaw = get(raw.VITE_SUPABASE_URL) || (dev ? DEV_SUPABASE_URL : '');
  const serverRaw = get(raw.VITE_SERVER_URL) || (dev ? DEV_SERVER_URL : '');
  const key = get(raw.VITE_SUPABASE_ANON_KEY);

  if (!urlRaw) problems.push('VITE_SUPABASE_URL is required');
  if (!key) problems.push('VITE_SUPABASE_ANON_KEY is required');
  if (!serverRaw) problems.push('VITE_SERVER_URL is required');

  const supabaseUrl = urlRaw ? origin('VITE_SUPABASE_URL', urlRaw, problems) : '';
  const serverUrl = serverRaw ? origin('VITE_SERVER_URL', serverRaw, problems) : '';

  if (problems.length > 0) {
    const hint = dev ? ' (local dev: run `npm run env:local -w apps/web`)' : '';
    throw new Error(`Invalid web environment: ${problems.join('; ')}${hint}`);
  }
  return { supabaseUrl, supabaseAnonKey: key, serverUrl };
}

let cached: WebEnv | undefined;

/** Validated env from Vite, read lazily so importing this module never throws. */
export function getWebEnv(): WebEnv {
  cached ??= readWebEnv(import.meta.env as RawWebEnv, import.meta.env.DEV);
  return cached;
}
