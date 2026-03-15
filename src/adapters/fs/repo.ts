import { existsSync } from 'node:fs';
import path from 'node:path';

export const THREADLOOP_DIR = '.threadloop';
export const STATE_DIR = path.join(THREADLOOP_DIR, 'state');
export const ARTIFACTS_DIR = path.join(THREADLOOP_DIR, 'artifacts');
export const CONFIG_PATH = path.join(THREADLOOP_DIR, 'config.json');
export const STATE_PATH = path.join(STATE_DIR, 'state.json');

export function threadloopPaths(repoRoot: string) {
  return {
    root: path.join(repoRoot, THREADLOOP_DIR),
    stateDir: path.join(repoRoot, STATE_DIR),
    artifactsDir: path.join(repoRoot, ARTIFACTS_DIR),
    configPath: path.join(repoRoot, CONFIG_PATH),
    statePath: path.join(repoRoot, STATE_PATH),
  };
}

export function isThreadloopInitialized(repoRoot: string) {
  return existsSync(threadloopPaths(repoRoot).configPath);
}
