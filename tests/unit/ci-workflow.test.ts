import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

function object(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected workflow object.');
  }
  return value as Record<string, unknown>;
}

describe('signed gate reusable workflow', () => {
  it('is caller-bounded, keyless, least-privilege, and commit-pinned', async () => {
    const workflowPath = path.join(process.cwd(), '.github/workflows/threadloop-gate-sensor.yml');
    const source = await readFile(workflowPath, 'utf8');
    const workflow = object(parse(source) as unknown);
    const workflowCall = object(object(workflow.on).workflow_call);
    const inputs = object(workflowCall.inputs);
    const job = object(object(workflow.jobs)['signed-gate']);
    const steps = job.steps as Array<Record<string, unknown>>;

    expect(Object.keys(inputs)).toEqual(['session_id', 'plan_sha256', 'gate_id', 'gate_json']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(source).not.toContain('secrets:');
    expect(source).not.toContain('pull_request_target');
    expect(steps.map((step) => step.uses).filter(Boolean)).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    ]);
    expect(steps.find((step) => step.name === 'Execute and sign declared gate')).toMatchObject({
      run: 'npm run sensor:ci-gate',
      'working-directory': 'threadloop-sensor',
    });
    expect(steps.find((step) => step.name === 'Upload signed receipt')).toMatchObject({
      if: "${{ always() && hashFiles('receipt-output/signed-receipt.json') != '' }}",
    });
  });
});
