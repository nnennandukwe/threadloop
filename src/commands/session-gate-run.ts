import { runSessionGate } from '../services/session-service.js';
import { type CommandContext, type JsonOption, writeCommandSuccess } from './runtime.js';

export interface SessionGateRunOptions extends JsonOption {
  session: string;
}

export async function sessionGateRunCommand(context: CommandContext, gateId: string, options: SessionGateRunOptions) {
  const result = await runSessionGate({
    cwd: context.cwd,
    sessionId: options.session,
    gateId,
  });
  writeCommandSuccess(context, {
    text: [
      `Gate ${result.receipt.gate_id}: ${result.receipt.result}`,
      `Receipt: ${result.receipt.id} (#${result.receipt.sequence})`,
      ...(result.diagnostic ? [result.diagnostic.message, `Recovery: ${result.diagnostic.hint}`] : []),
    ],
    data: result,
  });
}
