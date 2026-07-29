import { nodeSignedReceiptFileSystem } from '../adapters/fs/signed-receipt-files.js';
import { importSessionReviewReceipt } from '../services/session-service.js';
import { type CommandContext, type JsonOption, writeCommandSuccess } from './runtime.js';

export interface SessionReviewImportOptions extends JsonOption {
  session: string;
}

export async function sessionReviewImportCommand(
  context: CommandContext,
  packagePath: string,
  options: SessionReviewImportOptions,
) {
  const result = await importSessionReviewReceipt({
    cwd: context.cwd,
    sessionId: options.session,
    packagePath,
    receiptFileSystem: nodeSignedReceiptFileSystem,
  });
  writeCommandSuccess(context, {
    text: [
      `Signed review PR #${result.receipt.pull_request_number}: ${result.review.status}`,
      `Receipt: ${result.receipt.id} (#${result.receipt.sequence})`,
      result.already_imported ? 'Already imported: yes' : 'Already imported: no',
    ],
    data: result,
  });
}
