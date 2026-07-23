import { createRequire } from 'node:module';

const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time';

const require = createRequire(import.meta.url);
const originalEmitWarning: typeof process.emitWarning = process.emitWarning.bind(process);

process.emitWarning = (warning, typeOrOptions, ...args) => {
  const warningMessage = typeof warning === 'string' ? warning : warning.message;
  const warningType = readWarningType(warning, typeOrOptions);

  if (warningType === 'ExperimentalWarning' && warningMessage?.includes(SQLITE_EXPERIMENTAL_WARNING)) {
    return;
  }

  Reflect.apply(originalEmitWarning, process, [warning, typeOrOptions, ...args]);
};

const sqlite = (() => {
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = originalEmitWarning;
  }
})();

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = InstanceType<typeof sqlite.DatabaseSync>;

function readWarningType(warning: string | Error, typeOrOptions: unknown) {
  if (typeof typeOrOptions === 'string') {
    return typeOrOptions;
  }

  if (typeOrOptions && typeof typeOrOptions === 'object' && 'type' in typeOrOptions) {
    const objectType = typeOrOptions.type;
    return typeof objectType === 'string' ? objectType : undefined;
  }

  return warning instanceof Error ? warning.name : undefined;
}
