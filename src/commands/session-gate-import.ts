import { importSessionGateReceipt } from '../services/session-service.js';
import { type CommandContext, type JsonOption, writeCommandSuccess } from './runtime.js';

export interface SessionGateImportOptions extends JsonOption {
  session: string;
}

export async function sessionGateImportCommand(
  context: CommandContext,
  packagePath: string,
  options: SessionGateImportOptions,
) {
  const result = await importSessionGateReceipt({
    cwd: context.cwd,
    sessionId: options.session,
    packagePath,
  });
  writeCommandSuccess(context, {
    text: [
      `Signed CI gate ${result.receipt.gate_id}: ${result.receipt.result}`,
      `Receipt: ${result.receipt.id} (#${result.receipt.sequence})`,
      result.already_imported ? 'Already imported: yes' : 'Already imported: no',
    ],
    data: result,
  });
}
