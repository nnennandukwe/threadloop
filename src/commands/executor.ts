import { GaapState } from '../adapters/fs/gaap-state.js';
import { readGaapFile } from '../adapters/fs/gaap-files.js';
import { GaapEvidenceError, parseGaapJson } from '../domain/gaap-json.js';
import {
  admitGaapOutput,
  evaluateGaapController,
  inspectGaapExecutor,
  registerGaapExecutor,
  runGaapExecutor,
} from '../services/gaap-executor.js';
import { ThreadloopError } from '../contracts/errors.js';
import { writeCommandSuccess, type CommandContext } from './runtime.js';

interface Options {
  state: string;
  binding?: string;
  config?: string;
}
function readInput(filename: string) {
  return parseGaapJson(readGaapFile(filename, 4 * 1024 * 1024));
}
async function execute(context: CommandContext, operation: () => unknown) {
  try {
    const data = await operation();
    writeCommandSuccess(context, { text: [JSON.stringify(data, null, 2)], data });
  } catch (error) {
    if (error instanceof GaapEvidenceError)
      throw new ThreadloopError('EXECUTOR_REJECTED', error.message, {
        cause: error,
        details: {
          reason: error.code,
          hint: "Inspect this state directory before recovery. A new invocation mustn't repeat a launched Attempt.",
        },
      });
    throw error;
  }
}
export async function executorRegisterCommand(context: CommandContext, options: Options) {
  await execute(context, () => {
    if (!options.binding || !options.config)
      throw new GaapEvidenceError('executor.input', 'Pass both --binding and --config.');
    return registerGaapExecutor(new GaapState(options.state), readInput(options.binding), readInput(options.config));
  });
}
export async function executorRunCommand(context: CommandContext, options: Options) {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    await execute(context, async () => {
      const result = await runGaapExecutor(new GaapState(options.state), cancellation.signal);
      if (!['admitted', 'committed_with_warning', 'already_admitted'].includes(result.status)) {
        throw new ThreadloopError(
          'EXECUTOR_REJECTED',
          'Execution produced no admitted evidence. Inspect the retained observation before recovery.',
          { details: { ...result } },
        );
      }
      return result;
    });
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
export async function executorInspectCommand(context: CommandContext, options: Options) {
  await execute(context, () => inspectGaapExecutor(new GaapState(options.state)));
}
export async function executorAdmitCommand(context: CommandContext, observation: string, options: Options) {
  await execute(context, () => {
    const id = Number(observation);
    if (!Number.isSafeInteger(id) || id < 1)
      throw new GaapEvidenceError('executor.observation', 'Select a positive retained observation ID.');
    return admitGaapOutput(new GaapState(options.state), id);
  });
}
export async function executorEvaluateCommand(context: CommandContext, options: Options) {
  await execute(context, () => evaluateGaapController(new GaapState(options.state)));
}
