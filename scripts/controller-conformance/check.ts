import { loadCorpus, verifyCompatibility, verifyPublishedSchemas } from './files.js';
import { validateCorpus } from './validation.js';

try {
  const corpus = await loadCorpus();
  const result = validateCorpus(corpus.manifest, corpus.fixtures, corpus.compatibility);
  if (!result.ok) {
    process.stderr.write(JSON.stringify(result.diagnostics, null, 2) + '\n');
    process.exitCode = 1;
  } else {
    await verifyCompatibility(corpus.compatibility);
    await verifyPublishedSchemas();
    process.stdout.write(
      `Controller corpus: ${result.value.fixtures.length} fixtures internally validated.\nCorpus: ${result.value.manifest.corpus_digest}\nNo external subject was run; controller selection and runtime conformance remain unproven.\n`,
    );
  }
} catch (error) {
  process.stderr.write(
    `Conformance corpus invalid: ${error instanceof Error ? error.message : String(error)}\nRestore the named artifact and rerun npm run spec:conformance:check.\n`,
  );
  process.exitCode = 1;
}
