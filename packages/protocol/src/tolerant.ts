import type { z } from 'zod';

type Path = readonly PropertyKey[];

/** A copy of `value` without `keys` on the object at `path`. */
function omit(value: unknown, path: Path, keys: readonly string[]): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const copy = (Array.isArray(value) ? [...value] : { ...value }) as Record<PropertyKey, unknown>;
  const [head, ...rest] = path;
  if (head === undefined) for (const key of keys) delete copy[key];
  else copy[head] = omit(copy[head], rest, keys);
  return copy;
}

/**
 * For payloads FROM the server, on the client only: keys the schema does not know are stripped
 * instead of failing the whole payload, so a newer server can add fields. Everything else is
 * checked as strictly as ever. The server must keep using the strict schemas themselves: they are
 * what stops private data going out, and what validates client input.
 */
export function parseTolerant<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.ZodSafeParseResult<z.output<S>> {
  let value = input;
  let result = schema.safeParse(value);
  // Bounded: a pass strips everything Zod reported; a few cover issues it only reaches later.
  for (let pass = 0; pass < 5 && !result.success; pass++) {
    let stripped = false;
    for (const issue of result.error.issues) {
      if (issue.code !== 'unrecognized_keys') continue;
      value = omit(value, issue.path, issue.keys);
      stripped = true;
    }
    if (!stripped) break;
    result = schema.safeParse(value);
  }
  return result;
}
