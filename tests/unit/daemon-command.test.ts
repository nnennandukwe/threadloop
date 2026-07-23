import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/session-service.js', () => ({
  reconcileSession: vi.fn(),
}));

import { daemonRunCommand } from '../../src/commands/daemon.js';
import type { CommandContext } from '../../src/commands/runtime.js';
import { reconcileSession } from '../../src/services/session-service.js';

const mockedReconcileSession = vi.mocked(reconcileSession);

function createContext(json = false): CommandContext {
  return {
    cwd: '/repo',
    json,
    command: 'daemon run',
  };
}

describe('daemon command', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedReconcileSession.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reconciles on schedule and shuts down cleanly on an injected stop signal', async () => {
    mockedReconcileSession.mockResolvedValue([]);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stopController = new AbortController();

    const daemon = daemonRunCommand(
      createContext(),
      { interval: 1 },
      {
        stopSignal: stopController.signal,
        registerProcessSignalHandlers: false,
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockedReconcileSession).toHaveBeenCalledTimes(1);
    expect(mockedReconcileSession).toHaveBeenCalledWith({
      cwd: '/repo',
      reconcileAll: true,
    });

    stopController.abort();
    await daemon;

    const stdoutText = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    const stderrText = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');

    expect(stdoutText).toContain('Daemon started, reconciling every 1s. Waiting for stop signal.');
    expect(stdoutText).toContain('[daemon] Reconciled 0 session(s)');
    expect(stdoutText).toContain('Daemon stopped.');
    expect(stderrText).toBe('');
  });

  it('logs reconcile errors and continues running until interrupted', async () => {
    mockedReconcileSession.mockRejectedValueOnce(new Error('reconcile failed')).mockResolvedValueOnce([]);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stopController = new AbortController();

    const daemon = daemonRunCommand(
      createContext(),
      { interval: 1 },
      {
        stopSignal: stopController.signal,
        registerProcessSignalHandlers: false,
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockedReconcileSession).toHaveBeenCalledTimes(2);

    stopController.abort();
    await daemon;

    const stdoutText = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    const stderrText = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');

    expect(stderrText).toContain('[daemon] Error: Error: reconcile failed');
    expect(stdoutText).toContain('[daemon] Reconciled 0 session(s)');
    expect(stdoutText).toContain('Daemon stopped.');
  });
});
