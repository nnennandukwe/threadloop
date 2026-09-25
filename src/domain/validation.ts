import { z } from 'zod';
import { isPlainObject } from './canonical-json.js';

/**
 * Field rules shared by proof plans and signed receipt artifacts. Each domain keeps its own error class, so a
 * rule is declared once here and reported through whichever class that domain's callers catch.
 */
export type FieldErrorFactory = (field: string, detail: string) => Error;

/**
 * Parses `value` and reports the first failing rule as one field error, `<field> <detail>.`: the error shape the
 * CLI has always surfaced. Every leaf rule aborts on failure, so the first issue is the first rule that failed in
 * declaration order, and a cross-field refinement only ever runs against well-formed fields.
 */
export function parseFields<S extends z.ZodType>(
  schema: S,
  value: unknown,
  root: string,
  fail: FieldErrorFactory,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  const path = (issue?.path ?? []).map((key) => (typeof key === 'number' ? `[${key}]` : `.${String(key)}`)).join('');
  throw fail(`${root}${path}`, issue?.message ?? 'is invalid');
}

/**
 * An object whose key set must match exactly. The key check runs before any field rule and reports at the object
 * itself, so a missing or unknown key names the object and its full key list. `optional` names the one key whose
 * presence depends on the record itself, such as a version-gated field; it is expected only when that returns
 * true.
 */
export function exactObject<S extends z.ZodRawShape>(
  shape: S,
  optional?: { key: keyof S & string; expected: (record: Record<string, unknown>) => boolean },
) {
  const keys = Object.keys(shape);
  return z.preprocess((value, context) => {
    if (!isPlainObject(value)) {
      reject(context, [], 'must be an object');
      return value;
    }
    const expected = optional && !optional.expected(value) ? keys.filter((key) => key !== optional.key) : keys;
    const actual = Object.keys(value);
    if (actual.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) {
      reject(context, [], `must contain exactly: ${expected.join(', ')}`);
    }
    return value;
  }, z.object(shape));
}

/** Adds a cross-field issue at `path`, relative to the value being refined. */
export function reject(context: z.RefinementCtx, path: Array<string | number>, message: string) {
  context.addIssue({ code: 'custom', path, message });
}

/** Rejects `value` with `message` unless `check` holds, and stops any later rule from running against it. */
export function rule<S extends z.ZodType>(schema: S, check: (value: z.output<S>) => boolean, message: string) {
  return schema.refine(check, { message, abort: true });
}

export function text(maximumLength: number) {
  const message = `must be a non-empty string no longer than ${maximumLength} characters`;
  return rule(
    z.string({ error: message }),
    (value) => value.trim().length > 0 && value.length <= maximumLength && !value.includes('\0'),
    message,
  );
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function identifier(maximumLength: number, pattern = IDENTIFIER) {
  return rule(text(maximumLength), (value) => pattern.test(value), `must match ${pattern.source.slice(1, -1)}`);
}

export function integer(minimum: number, maximum: number) {
  const message = `must be an integer from ${minimum} through ${maximum}`;
  return rule(
    z.number({ error: message }),
    (value) => Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    message,
  );
}

export const positiveInteger = rule(
  z.number({ error: 'must be a positive integer' }),
  (value) => Number.isSafeInteger(value) && value >= 1,
  'must be a positive integer',
);

export const sha256Digest = rule(
  z.string({ error: 'must be a lowercase SHA-256 digest' }),
  (value) => /^[0-9a-f]{64}$/.test(value),
  'must be a lowercase SHA-256 digest',
);

export const commitSha = rule(
  z.string({ error: 'must be a full lowercase Git commit SHA' }),
  (value) => /^[0-9a-f]{40}$/.test(value),
  'must be a full lowercase Git commit SHA',
);

/** The exact form `Date#toISOString` produces, which is what ThreadLoop's own sensors record. */
export const canonicalTimestamp = rule(
  text(64),
  (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  'must be a canonical UTC ISO-8601 timestamp',
);

/**
 * Any timestamp `Date.parse` accepts. Review snapshots carry GitHub's timestamps verbatim, which omit
 * milliseconds, so the canonical form would reject every real review.
 */
export const parsableTimestamp = rule(
  text(64),
  (value) => Number.isFinite(Date.parse(value)),
  'must be an ISO timestamp',
);

export const githubRepository = rule(
  text(512),
  (value) => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value),
  'must be an exact GitHub repository URI',
);

export const boolean = z.boolean({ error: 'must be a boolean' });

export function literal<const T extends string | number>(value: T) {
  return z.literal(value, { error: `must be ${value}` });
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
