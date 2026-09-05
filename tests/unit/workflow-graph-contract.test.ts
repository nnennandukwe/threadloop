import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseWorkflowProfile } from '../../scripts/workflow-graph/parser.js';
import { publishedSchemas } from '../../scripts/workflow-graph/contracts.js';

const bundle = new URL('../../docs/contracts/workflow-graph-v0.1/', import.meta.url);

function minimalProfile() {
  return {
    schema_version: '0.1',
    profile: { id: 'release_example', revision: 1 },
    initial_state: 'prepared',
    states: [
      { id: 'prepared', kind: 'active' },
      { id: 'completed', kind: 'terminal' },
    ],
    transitions: [
      {
        id: 'finish',
        from: 'prepared',
        to: 'completed',
        guard_refs: ['approval', 'published'],
        authority: ['threadloop', 'human'],
      },
    ],
    guards: [
      {
        id: 'approval',
        capability: 'human_approval',
        parameters: { scope: 'current_subject' },
        required_actions: ['approve'],
      },
      { id: 'published', capability: 'completion_observed', parameters: { kind: 'publication' } },
    ],
    required_actions: [{ id: 'approve', capability: 'approve_change', authority: 'human', parameters: {} }],
  };
}

describe('Workflow Profile authoring', () => {
  it('publishes reproducible Draft 2020-12 schemas usable by an independent validator', async () => {
    const ajv = new Ajv2020({ strict: true });
    for (const [name, generated] of Object.entries(publishedSchemas())) {
      const published: unknown = JSON.parse(await readFile(new URL(`schemas/${name}.schema.json`, bundle), 'utf8'));
      expect(published).toEqual(generated);
      expect(ajv.validateSchema(generated)).toBe(true);
      const validate = ajv.compile(generated);
      if (name === 'workflow-profile') {
        expect(validate(minimalProfile()), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...minimalProfile(), command: 'echo unauthorized' })).toBe(false);
      }
    }
  });
  it('accepts a provider-neutral release profile', () => {
    expect(parseWorkflowProfile(stringify(minimalProfile())).ok).toBe(true);
  });

  it.each([
    ['unknown schema', stringify({ ...minimalProfile(), schema_version: '0.2' })],
    ['numeric schema', stringify({ ...minimalProfile(), schema_version: 0.1 })],
    ['unknown field', stringify({ ...minimalProfile(), command: 'echo unauthorized' })],
    ['duplicate keys', 'schema_version: "0.1"\nschema_version: "0.1"'],
    ['multiple documents', '---\na: 1\n---\na: 2'],
    ['alias', 'a: &shared [1]\nb: *shared'],
    ['custom tag', 'a: !execute command'],
    ['merge key', 'a: { <<: { b: 1 } }'],
    ['non-string key', '1: value'],
    ['non-finite scalar', 'a: .inf'],
  ])('rejects %s without returning a profile', (_label, source) => {
    const result = parseWorkflowProfile(source);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('value');
  });
});
