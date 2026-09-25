import { z } from 'zod';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';

// Shared by the development-only contract validators; nothing here is packaged with the CLI.
export interface Diagnostic {
  code: string;
  path: string;
  identifier: string | null;
  message: string;
  recovery: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; diagnostics: Diagnostic[] };

export function diagnostic(
  code: string,
  path: string,
  identifier: string | null,
  message: string,
  recovery: string,
): Diagnostic {
  return { code, path, identifier, message, recovery };
}

/** Binds one contract's recovery guidance to the diagnostics it reports. */
export function withRecovery(recovery: string) {
  const issue = (code: string, path: string, message: string) => diagnostic(code, path, null, message, recovery);
  return {
    issue,
    invalid: (code: string, message: string, path = '$'): ValidationResult<never> => ({
      ok: false,
      diagnostics: [issue(code, path, message)],
    }),
  };
}

export function validateShape<T>(schema: z.ZodType<T>, value: unknown): ValidationResult<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    diagnostics: result.error.issues.map((issue) =>
      diagnostic(
        issue.path.at(-1) === 'schema_version' || issue.path.at(-1) === 'graph_schema_version'
          ? 'UNSUPPORTED_VERSION'
          : 'SCHEMA_INVALID',
        '$' + issue.path.map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`)).join(''),
        null,
        issue.message,
        'Use the published v0.1 schema and registered capability parameters; unknown fields are not ignored.',
      ),
    ),
  };
}

/** SHA-256 of ThreadLoop canonical JSON, the identity used by every domain digest. */
export function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Draft 2020-12 documents for one contract family; `definitions` names reusable `$defs`. */
export function publishedSchemas(
  family: string,
  schemas: Record<string, z.ZodType>,
  options: { reused?: 'inline' | 'ref'; definitions?: Record<string, z.ZodType> } = {},
) {
  const metadata = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(options.definitions ?? {})) metadata.add(schema, { id });
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      {
        ...z.toJSONSchema(schema, {
          target: 'draft-2020-12',
          ...(options.definitions ? { metadata } : {}),
          ...(options.reused ? { reused: options.reused } : {}),
        }),
        $id: `https://github.com/nnennandukwe/threadloop/contracts/${family}/0.1/${name}`,
      },
    ]),
  );
}
