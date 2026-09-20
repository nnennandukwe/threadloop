import { canonicalConformanceJson } from './codec.js';
import { fixtureSourceSchema, sharedValuesSchema } from './contracts.js';

/** Expand data-only references before domain validation. Never derive inputs or expected results. */
export function materializeFixtureSources(
  sources: Record<string, unknown>,
  sharedDocument: unknown,
): Record<string, unknown> {
  function bounded(value: unknown, label: string) {
    const checked = canonicalConformanceJson(value);
    if (!checked.ok) throw new Error(`${label}: invalid or unbounded JSON: ${JSON.stringify(checked.diagnostics)}`);
  }
  bounded(sharedDocument, 'shared.json');
  const { values } = sharedValuesSchema.parse(sharedDocument);
  const used = new Set<string>();
  const fixtures: Record<string, unknown> = {};
  for (const [path, document] of Object.entries(sources)) {
    try {
      bounded(document, path);
      const source = fixtureSourceSchema.parse(document);
      let visits = 0;
      let bytes = 0;
      const active = new Set<string>();
      function expand(value: unknown, depth: number): unknown {
        if (++visits > 1_000_000 || depth > 64) throw new Error('Fixture expansion depth/value limit exceeded.');
        // Account for canonical bytes while expanding, before allocating an oversized result.
        function charge(count: number) {
          bytes += count;
          if (bytes > 16 * 1024 * 1024) throw new Error('Fixture expansion byte limit exceeded.');
        }
        if (Array.isArray(value)) {
          charge(2 + Math.max(0, value.length - 1));
          return value.map((item: unknown) => expand(item, depth + 1));
        }
        if (value !== null && typeof value === 'object') {
          const entries = Object.entries(value);
          if (Object.hasOwn(value, '$fixture_ref')) {
            const name: unknown = (value as Record<string, unknown>).$fixture_ref;
            if (entries.length !== 1 || typeof name !== 'string' || !Object.hasOwn(values, name))
              throw new Error(`Invalid or missing shared reference: ${String(name)}.`);
            if (active.has(name)) throw new Error(`Shared reference cycle: ${name}.`);
            active.add(name);
            used.add(name);
            const expanded = expand(values[name], depth + 1);
            active.delete(name);
            return expanded;
          }
          charge(2 + Math.max(0, entries.length - 1));
          return Object.fromEntries(
            entries.map(([key, item]) => {
              charge(Buffer.byteLength(JSON.stringify(key)) + 1);
              return [key, expand(item, depth + 1)];
            }),
          );
        }
        charge(Buffer.byteLength(JSON.stringify(value)));
        return value;
      }
      fixtures[path] = expand(source.fixture, 0);
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  const unused = Object.keys(values).filter((name) => !used.has(name));
  if (unused.length)
    throw new Error(`shared.json: unused values: ${unused.join(', ')}. Remove them or restore references.`);
  return fixtures;
}
