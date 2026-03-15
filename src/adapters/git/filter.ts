const THREADLOOP_PATH_PREFIX = '.threadloop';

export function isThreadloopOwnedPath(filePath: string) {
  const normalized = filePath.trim().replace(/^\.\//, '');
  return normalized === THREADLOOP_PATH_PREFIX || normalized.startsWith(`${THREADLOOP_PATH_PREFIX}/`);
}

export function filterThreadloopPaths(paths: string[]) {
  return paths.filter((filePath) => !isThreadloopOwnedPath(filePath));
}
