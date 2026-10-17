import { z } from 'zod';

/** Boolean env var: accepts true/false/1/0/yes/no (case-insensitive). */
export const envBoolean = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'TRUE', 'FALSE', 'True', 'False'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : ['true', '1', 'yes'].includes(v.toLowerCase())));

export const envInt = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Parse environment variables with a Zod schema; empty strings are treated as unset. */
export function parseEnv<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv = process.env): z.output<S> {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}
