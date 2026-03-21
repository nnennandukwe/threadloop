import { createRequire } from 'node:module';

const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time';

const require = createRequire(import.meta.url);
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = function suppressNodeSqliteExperimentalWarning(warning, type, ...args) {
  const warningMessage = typeof warning === 'string' ? warning : warning?.message;
  const warningType = typeof type === 'string' ? type : warning instanceof Error ? warning.name : undefined;

  if (warningType === 'ExperimentalWarning' && warningMessage?.includes(SQLITE_EXPERIMENTAL_WARNING)) {
    return;
  }

  return originalEmitWarning(warning, type, ...args);
};

const sqlite = require('node:sqlite') as typeof import('node:sqlite');

process.emitWarning = originalEmitWarning;

export const { DatabaseSync } = sqlite;
