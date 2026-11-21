import { type CommandContext, writeCommandSuccess } from './runtime.js';
import {
  createWorkflowRun,
  inspectWorkflowRun,
  decideWorkflowRun,
  applyWorkflowRun,
  prepareWorkflowEvidence,
  importWorkflowEvidence,
  type WorkflowPrepareOptions,
} from '../services/workflow-runtime.js';
import { collectWorkflowEvidence, type CollectOptions } from '../services/workflow-collection.js';
import { executeWorkflowRun, importWorkflowGaap } from '../services/workflow-execution.js';
import type { RunView } from '../domain/workflow-run.js';

type ManagedInspection = Extract<Awaited<ReturnType<typeof inspectWorkflowRun>>, { collections: unknown }>;
function writeRun(
  context: CommandContext,
  view: RunView & Partial<Pick<ManagedInspection, 'execution' | 'collections'>>,
) {
  writeCommandSuccess(context, {
    data: view,
    text: [
      view.workflow_run_id + ' is at ' + view.state + ' (version ' + view.state_version + ').',
      'Graph ' + view.graph_digest,
      ...(view.execution
        ? [
            'Execution ' + view.execution.disposition,
            'Correlation ' + JSON.stringify(view.execution.correlation),
            view.execution.recovery,
            JSON.stringify(view.execution.recovery_argv),
          ]
        : []),
      ...(view.collections?.map(
        (collection) => 'Collection ' + collection.attempt + ' ' + collection.kind + ' ' + collection.phase,
      ) ?? []),
    ],
  });
}

export async function workflowCreateCommand(
  context: CommandContext,
  run: string,
  options: { profile: string; setup: string },
) {
  writeRun(context, await createWorkflowRun(context.cwd, run, options.profile, options.setup));
}

export async function workflowInspectCommand(context: CommandContext, run: string) {
  writeRun(context, await inspectWorkflowRun(context.cwd, run));
}

export async function workflowDecideCommand(context: CommandContext, run: string) {
  const data = await decideWorkflowRun(context.cwd, run);
  const choice = data.controller_decision.decision;
  const lines: string[] = [choice.outcome];
  switch (choice.outcome) {
    case 'transition_available':
      lines.push(choice.transition_id + ' -> ' + choice.target_state);
      break;
    case 'engineering_action_required':
    case 'human_action_required':
      lines.push(choice.action_request.request.action_id + ' (' + choice.action_request.request.capability + ')');
      break;
    case 'blocked':
      lines.push(...choice.reasons.map((reason) => reason.code + ' - ' + reason.message + ' ' + reason.recovery));
      break;
    case 'waiting':
      lines.push(choice.attempt_id);
      break;
    case 'terminal':
      lines.push(choice.terminal_state);
      break;
  }
  writeCommandSuccess(context, { data, text: lines });
}

export async function workflowApplyCommand(
  context: CommandContext,
  run: string,
  options: { decision: string; idempotencyKey: string },
) {
  const data = await applyWorkflowRun(context.cwd, run, options.decision, options.idempotencyKey);
  writeCommandSuccess(context, {
    data,
    text: [
      data.transition_id +
        ' moved ' +
        data.workflow_run_id +
        ' from ' +
        data.from +
        ' to ' +
        data.to +
        ' (version ' +
        data.state_version +
        ').',
      'Event ' + data.event_digest,
    ],
  });
}

export async function workflowPrepareCommand(context: CommandContext, kind: string, options: WorkflowPrepareOptions) {
  const data = await prepareWorkflowEvidence(context.cwd, kind, options);
  const target = data.target.kind === 'signed-gate' ? data.target.gate_id : 'PR #' + data.target.pr;
  writeCommandSuccess(context, {
    data,
    text: [
      data.prepared_id + ' ' + data.target.kind + ' ' + target,
      'Valid until ' + data.valid_until,
      JSON.stringify(data.sensor_inputs),
      ...(data.manifest_json ? [data.manifest_json] : []),
    ],
  });
}

export async function workflowImportCommand(
  context: CommandContext,
  kind: string,
  options: { run: string; source: string; expectedStateVersion: number },
) {
  if (kind === 'gaap') {
    const data = await importWorkflowGaap(context.cwd, options.run, options.source, options.expectedStateVersion);
    writeCommandSuccess(context, {
      data,
      text: [
        'Imported ' + data.source_id + ' for Attempt ' + data.attempt_id + '.',
        'State version ' + data.state_version + '.',
        'Correlation ' + JSON.stringify(data.correlation),
      ],
    });
    return;
  }
  const data = await importWorkflowEvidence(context.cwd, kind, options);
  writeCommandSuccess(context, {
    data,
    text: [
      data.admission_id +
        ' admitted source ' +
        data.raw_source_sha256 +
        ' at evidence revision ' +
        data.evidence_revision +
        '.',
    ],
  });
}

export async function workflowExecuteCommand(context: CommandContext, run: string, options: { decision: string }) {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const data = await executeWorkflowRun(context.cwd, run, options.decision, cancellation.signal);
    writeCommandSuccess(context, {
      data,
      text:
        data.disposition === 'human_handoff'
          ? ['Human action required: ' + data.action_request.request.action_id]
          : [
              'Imported ' + data.source_id + ' for Attempt ' + data.attempt_id + '.',
              'State version ' + data.state_version + '.',
              'Correlation ' + JSON.stringify(data.correlation),
            ],
    });
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

export async function workflowCollectCommand(context: CommandContext, kind: string, options: CollectOptions) {
  const data = await collectWorkflowEvidence(context.cwd, kind, options);
  writeCommandSuccess(context, {
    data,
    text: ['Admitted ' + data.admission_id + ' at evidence revision ' + data.evidence_revision + '.'],
  });
}
