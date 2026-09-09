// Offline conformance limits, not a runtime retention or scheduling policy.
export const executionLimits = {
  journalEntries: 256,
  jsonBytes: 16 * 1024 * 1024,
  values: 1_000_000,
  depth: 64,
} as const;

/** Bound work before Zod cloning, canonicalization, or replay; never truncate history. */
export function withinExecutionLimits(value: unknown): boolean {
  let bytes = 0;
  let values = 0;
  function stringBytes(text: string): number {
    if (text.length > executionLimits.jsonBytes) return executionLimits.jsonBytes + 1;
    return Buffer.byteLength(JSON.stringify(text));
  }
  function visit(current: unknown, depth: number): boolean {
    if (++values > executionLimits.values || depth > executionLimits.depth) return false;
    if (typeof current === 'string') bytes += stringBytes(current);
    else if (current !== null && typeof current === 'object') {
      bytes += 2;
      if (Array.isArray(current)) {
        if (current.length > executionLimits.values - values) return false;
        bytes += Math.max(0, current.length - 1);
        for (const item of current) if (!visit(item, depth + 1)) return false;
      } else {
        const entries = Object.entries(current);
        if (entries.length > executionLimits.values - values) return false;
        bytes += Math.max(0, entries.length - 1);
        for (const [key, item] of entries) {
          bytes += stringBytes(key) + 1;
          if (bytes > executionLimits.jsonBytes || !visit(item, depth + 1)) return false;
        }
      }
    } else bytes += String(current).length;
    return bytes <= executionLimits.jsonBytes;
  }
  if (value !== null && typeof value === 'object' && 'execution' in value) {
    const execution = value.execution;
    if (
      execution !== null &&
      typeof execution === 'object' &&
      'entries' in execution &&
      Array.isArray(execution.entries) &&
      execution.entries.length > executionLimits.journalEntries
    )
      return false;
  }
  return visit(value, 0);
}
