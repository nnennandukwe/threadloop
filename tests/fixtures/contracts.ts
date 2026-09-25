import { readFile, readdir } from 'node:fs/promises';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { expect } from 'vitest';
import type { ValidationResult } from '../../scripts/contract-kernel/kernel.js';

/** Diagnostic codes of a rejection, or [] when the input was accepted. */
export function codes(result: ValidationResult<unknown>): string[] {
  return result.ok ? [] : result.diagnostics.map((item) => item.code);
}

// Zod can place a type behind a `$ref` with a sibling keyword, so Ajv's type-style lint is off; types still apply.
export const ajv = () => new Ajv2020({ strict: true, strictTypes: false, validateFormats: false });

/** The published directory holds exactly the generated documents; returns an independent validator for each. */
export async function publishedValidators(family: string, generated: Record<string, object>) {
  const directory = new URL(`../../docs/contracts/${family}-v0.1/schemas/`, import.meta.url);
  expect((await readdir(directory)).sort()).toEqual(
    Object.keys(generated)
      .map((name) => `${name}.schema.json`)
      .sort(),
  );
  const compiler = ajv();
  const validators: Record<string, ValidateFunction> = {};
  for (const [name, schema] of Object.entries(generated)) {
    const published = JSON.parse(await readFile(new URL(`${name}.schema.json`, directory), 'utf8')) as object;
    expect(published, name).toEqual(schema);
    validators[name] = compiler.compile(published);
  }
  return validators;
}
