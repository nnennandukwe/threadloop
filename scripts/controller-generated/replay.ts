import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { runHistory } from '../../tests/generated/controller/history.js';
import { scenarioSchema } from '../../tests/generated/controller/scenario.js';
import { processHistorySchema } from '../../tests/generated/controller/process-model.js';
import { runProcessHistory } from '../../tests/generated/controller/process-adapter.js';

try {
  const args = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'export-conformance': { type: 'string' },
    },
  });
  if (args.values.help) {
    process.stdout.write(
      'Replay a generated controller or process history.\n' +
        'Usage: npm run test:controller:replay -- history.json [--export-conformance scenario.json]\n' +
        'Input: a versioned history or generated-failure envelope containing history.\n' +
        'Export writes normalized controller-conformance v0.1 input without expectations.\n',
    );
  } else {
    if (args.positionals.length !== 1) throw new Error('Supply one history JSON file. Use --help for examples.');
    const parsed: unknown = JSON.parse(await readFile(args.positionals[0]!, 'utf8'));
    const value = parsed && typeof parsed === 'object' && 'history' in parsed ? parsed.history : parsed;
    const version = value && typeof value === 'object' && 'schema' in value ? value.schema : undefined;
    if (version === 'threadloop.generated-history/1') {
      const history = scenarioSchema.parse(value);
      const input = await runHistory(history);
      if (args.values['export-conformance']) {
        const schema = JSON.parse(
          await readFile(
            new URL(
              import.meta
                .resolve('threadloop-contracts/assets/controller-conformance-v0.1/schemas/execution-scenario.schema.json'),
            ),
            'utf8',
          ),
        ) as object;
        const validate = new Ajv2020({ strict: true }).compile(schema);
        if (!validate(input))
          throw new Error('Promotion input failed the published schema: ' + JSON.stringify(validate.errors));
        await writeFile(args.values['export-conformance'], JSON.stringify(input, null, 2) + '\n', { flag: 'wx' });
        process.stdout.write('Conformance input written: ' + args.values['export-conformance'] + '\n');
      }
      process.stdout.write('Controller history passed: ' + history.steps.length + ' steps.\n');
    } else if (version === 'threadloop.generated-process-history/1') {
      if (args.values['export-conformance'])
        throw new Error('Only controller histories export to the v0.1 execution scenario.');
      const processHistory = processHistorySchema.parse(value);
      await runProcessHistory(processHistory);
      process.stdout.write('Process history passed: ' + processHistory.steps.length + ' steps.\n');
    } else
      throw new Error(
        'Unsupported history schema: ' + JSON.stringify(version) + '. Use a supported versioned history.',
      );
  }
} catch (error) {
  process.stderr.write(
    'History replay failed: ' +
      (error instanceof Error ? error.message : String(error)) +
      '\nRestore the reported history or fix the failing operation, then rerun the same command.\n',
  );
  process.exitCode = 1;
}
