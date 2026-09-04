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
    const jobs = object(workflow.jobs);
    const executionJob = object(jobs.execute_gate);
    const signingJob = object(jobs.sign_receipt);
    const executionSteps = executionJob.steps as Array<Record<string, unknown>>;
    const signingSteps = signingJob.steps as Array<Record<string, unknown>>;

    expect(Object.keys(inputs)).toEqual(['session_id', 'plan_sha256', 'gate_id', 'gate_json']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(jobs)).toEqual(['execute_gate', 'sign_receipt']);
    expect(executionJob.permissions).toEqual({ contents: 'read' });
    expect(signingJob.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(executionJob['runs-on']).toBe('ubuntu-latest');
    expect(signingJob['runs-on']).toBe('ubuntu-latest');
    expect(signingJob.needs).toBe('execute_gate');
    expect(signingJob.if).toBe('${{ always() }}');
    expect(source).not.toContain('secrets:');
    expect(source).not.toContain('pull_request_target');
    expect(executionSteps.map((step) => step.uses).filter(Boolean)).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    ]);
    expect(signingSteps.map((step) => step.uses).filter(Boolean)).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    ]);
    expect(executionSteps.find((step) => step.name === 'Execute declared gate')).toMatchObject({
      id: 'execute_gate',
      run: 'npm run sensor:ci-gate:run',
      'working-directory': 'threadloop-sensor',
    });
    expect(executionSteps.find((step) => step.name === 'Upload captured gate report')).toMatchObject({
      if: '${{ always() }}',
    });
    const signingStep = signingSteps.find((step) => step.name === 'Sign captured gate receipt');
    expect(signingStep).toMatchObject({
      run: 'npm run sensor:ci-gate:sign',
      'working-directory': 'threadloop-sensor',
    });
    expect(object(signingStep?.env)).toMatchObject({
      THREADLOOP_GATE_JOB_RESULT: '${{ needs.execute_gate.result }}',
    });
    expect(signingSteps.find((step) => step.name === 'Upload signed receipt')).toMatchObject({
      if: "${{ always() && hashFiles('receipt-output/signed-receipt.json') != '' }}",
    });
  });

  it('keeps signing authority out of the caller-controlled gate process', async () => {
    const executionSource = await readFile(path.join(process.cwd(), 'scripts/run-ci-gate-sensor.ts'), 'utf8');
    const signingSource = await readFile(path.join(process.cwd(), 'scripts/sign-ci-gate-receipt.ts'), 'utf8');

    expect(executionSource).not.toContain('signSigstoreStatement');
    expect(executionSource).not.toContain('THREADLOOP_OUTPUT_PATH');
    // Both the gate command and every declared setup step must run with the sanitized environment.
    expect(executionSource.match(/env: gateEnvironment\(\)/g)).toHaveLength(2);
    expect(signingSource).not.toContain('runGateProcess');
    expect(signingSource).not.toContain('THREADLOOP_SOURCE_ROOT');
  });

  it('scopes actionlint runtime-context suppressions to the reusable sensor', async () => {
    const configPath = path.join(process.cwd(), '.github/actionlint.yaml');
    const config = object(parse(await readFile(configPath, 'utf8')) as unknown);
    const paths = object(config.paths);

    expect(paths).toEqual({
      '.github/workflows/threadloop-gate-sensor.yml': {
        ignore: [
          'property "workflow_repository" is not defined in object type',
          'property "workflow_sha" is not defined in object type',
        ],
      },
      '.github/workflows/threadloop-review-sensor.yml': {
        ignore: [
          'property "workflow_repository" is not defined in object type',
          'property "workflow_sha" is not defined in object type',
        ],
      },
    });
  });
});

describe('signed review reusable workflow', () => {
  it('separates read-only review collection from keyless signing authority', async () => {
    const workflowPath = path.join(process.cwd(), '.github/workflows/threadloop-review-sensor.yml');
    const source = await readFile(workflowPath, 'utf8');
    const workflow = object(parse(source) as unknown);
    const workflowCall = object(object(workflow.on).workflow_call);
    const inputs = object(workflowCall.inputs);
    const jobs = object(workflow.jobs);
    const collectionJob = object(jobs.collect_review);
    const signingJob = object(jobs.sign_receipt);
    const collectionSteps = collectionJob.steps as Array<Record<string, unknown>>;
    const signingSteps = signingJob.steps as Array<Record<string, unknown>>;

    expect(Object.keys(inputs)).toEqual(['session_id', 'plan_sha256', 'pull_request_number']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(jobs)).toEqual(['collect_review', 'sign_receipt']);
    expect(collectionJob.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(signingJob.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(signingJob.needs).toBe('collect_review');
    expect(source).not.toContain('pull_request_target');
    expect(source).not.toContain('secrets:');
    expect(collectionSteps.find((step) => step.name === 'Collect review snapshot')).toMatchObject({
      run: 'npm run sensor:github-review:collect',
      'working-directory': 'threadloop-sensor',
    });
    expect(signingSteps.find((step) => step.name === 'Sign review snapshot')).toMatchObject({
      run: 'npm run sensor:github-review:sign',
      'working-directory': 'threadloop-sensor',
    });
    expect(signingSteps.find((step) => step.name === 'Sign review snapshot')?.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(collectionSteps.map((step) => step.uses).filter(Boolean)).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    ]);
    expect(signingSteps.map((step) => step.uses).filter(Boolean)).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    ]);
  });
});
