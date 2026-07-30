import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
    globalSetup: ['./tests/global-setup.ts'],
    // One budget for the whole suite instead of 18 per-test clocks.
    //
    // Measured over 300 tests: median 0.25s, p95 2.0s. The slowest test that is
    // not `packaging.test.ts` runs in 5.3s on an idle 12-core box but 11.6s at
    // CI-shaped concurrency (`--maxWorkers=3`) -- a 2.2x spread for the same
    // test on the same machine. 30s is ~2.6x that contended worst case.
    //
    // Because of that spread, a wall clock is a weak regression signal here: any
    // budget tight enough to catch a 2x slowdown will also flake under load.
    // Track total suite duration for regressions instead, and treat this number
    // as a hang detector. Ratchet it down as the suite gets cheaper, never up.
    //
    // `packaging.test.ts` keeps its own larger budget: it is bound by `npm pack`
    // and `npm install`, not by test logic.
    testTimeout: 30_000,
  },
});
