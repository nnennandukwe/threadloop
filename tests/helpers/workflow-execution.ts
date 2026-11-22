import type { WorkflowSources } from '../../src/domain/workflow-run.js';
import { constants } from 'node:fs';
import { chmod, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { controllerFixture } from '../fixtures/gaap-controller.js';
import { governedWorkflowFixture } from './workflow-run.js';

export async function managedWorkflowFixture(
  mode = 'success',
  hostProducers: WorkflowSources['host_producers'] = ['local-gate'],
) {
  const { control, subject, setup } = await governedWorkflowFixture(hostProducers);
  const { root: producerRoot, binding, host } = await controllerFixture(mode);
  // Hosted CI can keep Node in a shared writable tool cache. Give this managed producer its own executable.
  const node = path.join(producerRoot, 'node');
  await copyFile(process.execPath, node, constants.COPYFILE_FICLONE);
  await chmod(node, 0o700);
  host.executable = node;
  const adapter = {
    schema_version: 'threadloop.workflow-gaap-adapter/1',
    mapping_policy: binding.mapping_policy,
    parameters: { ...binding.parameters, subject_locator: subject },
    executor: binding.executor,
    lease_ms: binding.lease_ms,
    execution_policy: {
      id: binding.execution_policy.id,
      retry_safety: binding.execution_policy.rules.retry_safety,
      max_attempts: binding.execution_policy.rules.max_attempts,
    },
  };
  host.workspace = subject;
  host.environment.TEST_GAAP_MAPPING = JSON.stringify(adapter.mapping_policy);
  host.environment.TEST_GAAP_IMPLEMENTATION = JSON.stringify(host.verification.implementation);
  const managedSetup = {
    ...setup,
    schema_version: 'threadloop.workflow-setup/2',
    gaap: { adapter: 'adapter.json', host: 'host.json' },
  };
  await Promise.all([
    writeFile(path.join(control, 'adapter.json'), JSON.stringify(adapter)),
    writeFile(path.join(control, 'host.json'), JSON.stringify(host)),
    writeFile(path.join(control, 'setup.json'), JSON.stringify(managedSetup)),
  ]);
  return { control, subject, setup: managedSetup, host, adapter, producerRoot };
}
