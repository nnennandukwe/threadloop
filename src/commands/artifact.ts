import type { ArtifactKind } from '../domain/types.js';
import { generateArtifact } from '../services/session-service.js';

export async function artifactGenerateCommand(kind: ArtifactKind) {
  const result = await generateArtifact(process.cwd(), kind);
  console.log(`Generated ${result.artifact.kind}: ${result.artifact.path}`);
}
