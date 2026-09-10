import { isProxy } from 'node:util/types';
import { diagnostic, type ValidationResult } from '../workflow-graph/contracts.js';
import { executionLimits, withinExecutionLimits } from '../execution-contract/limits.js';

export function invalid(code: string, message: string, path = '$'): ValidationResult<never> {
  return {
    ok: false,
    diagnostics: [
      diagnostic(
        code,
        path,
        null,
        message,
        'Use the published executor contract and exact retained inputs; do not retry an effect to repair evidence.',
      ),
    ],
  };
}

function wellFormed(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}

/** Check the JSON tree iteratively before recursive schema parsing or serialization. */
export function validateJsonValue(value: unknown): ValidationResult<unknown> {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let values = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (++values > executionLimits.values || current.depth > executionLimits.depth)
      return invalid('EXECUTOR_INPUT_LIMIT', 'JSON exceeds the value or nesting limit.');
    const item = current.value;
    if (typeof item === 'string') {
      if (item.length > executionLimits.jsonBytes)
        return invalid('EXECUTOR_INPUT_LIMIT', 'String exceeds the message byte limit.');
      if (!wellFormed(item)) return invalid('INVALID_JSON_VALUE', 'Unicode must not contain unpaired surrogates.');
    } else if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || item < 0 || Object.is(item, -0))
        return invalid('INVALID_JSON_VALUE', 'Numbers must be non-negative safe integers.');
    } else if (item !== null && typeof item === 'object') {
      if (
        isProxy(item) ||
        seen.has(item) ||
        (Array.isArray(item)
          ? Object.getPrototypeOf(item) !== Array.prototype
          : Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
      )
        return invalid('INVALID_JSON_VALUE', 'Supply a plain JSON tree without cycles or shared object references.');
      seen.add(item);
      const keys = Reflect.ownKeys(item);
      if (keys.length + values + pending.length > executionLimits.values)
        return invalid('EXECUTOR_INPUT_LIMIT', 'JSON exceeds the value limit.');
      if (Array.isArray(item) && (keys.length !== item.length + 1 || item.length > executionLimits.values))
        return invalid('INVALID_JSON_VALUE', 'Arrays must be dense JSON arrays.');
      for (const key of keys) {
        if (Array.isArray(item) && key === 'length') continue;
        if (typeof key === 'string' && key.length > executionLimits.jsonBytes)
          return invalid('EXECUTOR_INPUT_LIMIT', 'Object key exceeds the message byte limit.');
        if (typeof key !== 'string' || !wellFormed(key))
          return invalid('INVALID_JSON_VALUE', 'Object keys must be well-formed Unicode strings.');
        if (
          Array.isArray(item) &&
          (!Number.isSafeInteger(Number(key)) ||
            String(Number(key)) !== key ||
            Number(key) < 0 ||
            Number(key) >= item.length)
        )
          return invalid('INVALID_JSON_VALUE', 'Arrays cannot contain named properties.');
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !('value' in descriptor))
          return invalid('INVALID_JSON_VALUE', 'JSON properties must be enumerable values, not accessors.');
        pending.push({ value: descriptor.value as unknown, depth: current.depth + 1 });
      }
    } else if (item !== null && typeof item !== 'boolean') {
      return invalid('INVALID_JSON_VALUE', 'Only JSON values are supported.');
    }
  }
  return withinExecutionLimits(value)
    ? { ok: true, value }
    : invalid('EXECUTOR_INPUT_LIMIT', 'JSON exceeds the 16 MiB development message limit.');
}

// Serialize keys directly: JSON.stringify(object) reorders integer-looking keys.
// This is the JCS subset admitted above; existing ThreadLoop canonicalization is unchanged.
function serialize(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(serialize).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + serialize(object[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

export function canonicalExecutorJson(value: unknown): ValidationResult<string> {
  const checked = validateJsonValue(value);
  return checked.ok ? { ok: true, value: serialize(checked.value) } : checked;
}

export function parseExecutorMessage(bytes: Uint8Array): ValidationResult<unknown> {
  if (bytes.byteLength > executionLimits.jsonBytes + 1)
    return invalid('EXECUTOR_INPUT_LIMIT', 'Message exceeds 16 MiB plus one framing LF.');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid('INVALID_UTF8', 'Message must contain valid UTF-8.');
  }
  if (source.endsWith('\n')) source = source.slice(0, -1);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return invalid('INVALID_JSON', 'Expected exactly one JSON message followed by EOF.');
  }
  const canonical = canonicalExecutorJson(value);
  if (!canonical.ok) return canonical;
  if (source !== canonical.value)
    return invalid(
      'NONCANONICAL_JSON',
      'Message bytes differ from canonical JSON; duplicate keys and extra framing are forbidden.',
    );
  return { ok: true, value };
}
