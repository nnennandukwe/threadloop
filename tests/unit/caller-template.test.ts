import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

function object(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a YAML object.');
  }
  return value as Record<string, unknown>;
}

async function readWorkflow(relativePath: string) {
  const source = await readFile(path.join(process.cwd(), relativePath), 'utf8');
  return { source, workflow: object(parse(source)) };
}

function declaredInputs(workflow: Record<string, unknown>) {
  const on = object(workflow.on ?? workflow[true as unknown as string]);
  const call = object(on.workflow_call);
  return object(call.inputs ?? {});
}

const TEMPLATE = 'examples/threadloop-caller-workflow.yml';

describe('consumer caller workflow template', () => {
  it('passes exactly the inputs each sensor declares as required', async () => {
    const { workflow } = await readWorkflow(TEMPLATE);
    const { workflow: gateSensor } = await readWorkflow('.github/workflows/threadloop-gate-sensor.yml');
    const { workflow: reviewSensor } = await readWorkflow('.github/workflows/threadloop-review-sensor.yml');
    const jobs = object(workflow.jobs);

    // Drift between the template and the sensor contracts is the failure mode
    // this guards: a missing or renamed input fails workflow_call validation
    // before any job is created, which surfaces as a job that never appears and
    // produces no log at all.
    for (const [jobName, sensor] of [
      ['gate', gateSensor],
      ['review', reviewSensor],
    ] as const) {
      const required = Object.entries(declaredInputs(sensor))
        .filter(([, spec]) => object(spec).required === true)
        .map(([name]) => name)
        .sort();
      const passed = Object.keys(object(object(jobs[jobName]).with)).sort();

      expect(passed).toEqual(required);
    }
  });

  it('casts the numeric review input so the review job is actually created', async () => {
    const { workflow } = await readWorkflow(TEMPLATE);
    const reviewWith = object(object(object(workflow.jobs).review).with);

    // workflow_dispatch delivers every input as a string, including one declared
    // `type: number`. Passing it straight through fails validation, so the cast
    // is load-bearing rather than cosmetic.
    expect(reviewWith.pull_request_number).toBe('${{ fromJSON(inputs.pull_request_number) }}');
  });

  it('grants OIDC only to the sensor calls and keeps the template least-privilege', async () => {
    const { workflow, source } = await readWorkflow(TEMPLATE);
    const jobs = object(workflow.jobs);

    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(object(jobs.gate).permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(object(jobs.review).permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    });
    expect(source).not.toContain('pull_request_target');
    expect(source).not.toContain('secrets:');
  });

  it('selects exactly one sensor per dispatch and pins both by commit SHA', async () => {
    const { workflow } = await readWorkflow(TEMPLATE);
    const jobs = object(workflow.jobs);

    expect(object(jobs.gate).if).toBe("${{ inputs.evidence == 'gate' }}");
    expect(object(jobs.review).if).toBe("${{ inputs.evidence == 'review' }}");

    for (const jobName of ['gate', 'review'] as const) {
      const uses = String(object(jobs[jobName]).uses);
      expect(uses).toContain('/threadloop/.github/workflows/threadloop-');
      // A placeholder rather than a live SHA, because consumers must pin their own
      // reviewed commit. A branch or tag ref here would break commit pinning.
      expect(uses.endsWith('@FULL_COMMIT_SHA')).toBe(true);
    }
  });

  it('declares the pull-request number as a string so the cast has something to parse', async () => {
    const { workflow } = await readWorkflow(TEMPLATE);
    const on = object(workflow.on ?? workflow[true as unknown as string]);
    const dispatchInputs = object(object(on.workflow_dispatch).inputs);
    const prNumber = object(dispatchInputs.pull_request_number);

    expect(prNumber.type).toBe('string');
    expect(prNumber.default).toBe('0');
  });
});
