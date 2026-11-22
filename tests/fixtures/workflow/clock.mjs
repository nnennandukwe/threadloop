import { mock } from 'node:test';

mock.timers.enable({ apis: ['Date'], now: Date.parse(process.env.THREADLOOP_TEST_CLOCK) });
