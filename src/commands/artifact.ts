import type { ArtifactKind } from '../domain/types.js';
import { generateArtifact } from '../services/session-service.js';
import { type CommandContext, writeCommandSuccess } from './runtime.js';

export async function artifactGenerateCommand(
  context: CommandContext,
  kind: ArtifactKind,
  options: { session?: string },
) {
  const result = await generateArtifact(context.cwd, kind, options.session?.trim() || undefined);

  writeCommandSuccess(context, {
    text: [`Generated ${result.artifact.kind}: ${result.artifact.path}`],
    data: {
      task_id: result.task.id,
      session_id: result.session.id,
      artifact: result.artifact,
      full_path: result.fullPath,
    },
  });
}
