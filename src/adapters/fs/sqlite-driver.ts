import { createRequire } from 'node:module';

const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time';

const require = createRequire(import.meta.url);
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = function suppressNodeSqliteExperimentalWarning(warning, type, ...args) {
  const warningMessage = typeof warning === 'string' ? warning : warning?.message;
  const warningType = readWarningType(warning, type);

  if (warningType === 'ExperimentalWarning' && warningMessage?.includes(SQLITE_EXPERIMENTAL_WARNING)) {
    return;
  }

  return originalEmitWarning(warning, type, ...args);
};

const sqlite = (() => {
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = originalEmitWarning;
  }
})();

export const { DatabaseSync } = sqlite;

function readWarningType(warning: string | Error, type: unknown) {
  if (typeof type === 'string') {
    return type;
  }

  if (type && typeof type === 'object' && 'type' in type) {
    const objectType = type.type;
    return typeof objectType === 'string' ? objectType : undefined;
  }

  return warning instanceof Error ? warning.name : undefined;
}
