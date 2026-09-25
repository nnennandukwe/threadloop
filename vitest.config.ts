import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.worktrees/**', '.claude/worktrees/**'],
    globalSetup: ['./tests/global-setup.ts'],
    // One budget for the whole suite instead of per-test clocks.
    //
    // Measured over 766 tests on a 12-core box: median 0.01s, p95 2.0s. The
    // slowest test that is not `packaging.test.ts` ran in 6.7s with default
    // workers and 7.2s at CI-shaped concurrency (`--maxWorkers=3`). An earlier
    // measurement saw one test run 2.2x slower under contention than idle, so
    // 30s keeps well clear of a contended worst case.
    //
    // Because per-test wall clock moves with machine load, a budget tight enough
    // to catch a 2x slowdown will also flake. Track total suite duration for
    // regressions instead, and treat this number as a hang detector. Ratchet it
    // down as the suite gets cheaper, never up.
    //
    // `packaging.test.ts` keeps its own larger budget: it is bound by `npm pack`
    // and `npm install`, not by test logic.
    testTimeout: 30_000,
  },
});
