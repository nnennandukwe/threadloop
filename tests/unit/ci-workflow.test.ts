import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** Actions must be the expected ones, each pinned to a full commit SHA; the pin itself is Dependabot's to move. */
function expectPinnedActions(steps: Array<Record<string, unknown>>, actions: string[]) {
  const uses = steps.map((step) => step.uses).filter((value): value is string => typeof value === 'string');
  expect(uses.map((value) => value.split('@')[0])).toEqual(actions);
  for (const value of uses) {
    expect(value).toMatch(/@[0-9a-f]{40}$/);
  }
}

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
    expectPinnedActions(executionSteps, [
      'actions/checkout',
      'actions/checkout',
      'actions/setup-node',
      'actions/upload-artifact',
    ]);
    expectPinnedActions(signingSteps, [
      'actions/checkout',
      'actions/setup-node',
      'actions/download-artifact',
      'actions/upload-artifact',
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
    expectPinnedActions(collectionSteps, ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact']);
    expectPinnedActions(signingSteps, [
      'actions/checkout',
      'actions/setup-node',
      'actions/download-artifact',
      'actions/upload-artifact',
    ]);
  });
});
