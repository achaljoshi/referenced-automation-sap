import { createSampleSapSystem, sapGuiTest } from '../../src';

export const creds = { client: '100', user: 'TESTUSER', password: 'correct-horse' };

/** Counts how many SAP connections a worker opens, so reuse can be asserted rather than assumed. */
export function countingTest(counter: { opened: number }) {
  return sapGuiTest.extend({
    sapGuiTransport: [
      async ({}, use) => {
        await use(() => {
          counter.opened++;
          return createSampleSapSystem({ transitionDelayMs: 20 });
        });
      },
      { scope: 'worker' },
    ],
  });
}
