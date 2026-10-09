import { createSampleSapSystem, sapGuiTest } from '../../src';

// The recording logs in, so the generated spec reads these from the environment
// like it would on a real run. They are the fake SAP's own made-up credentials.
process.env.SAP_PASSWORD ??= 'correct-horse';
process.env.SAP_USER ??= 'TESTUSER';
process.env.SAP_CLIENT ??= '100';
process.env.SAP_LANGUAGE ??= 'EN';

/**
 * `sapGuiTest` wired to the in-memory SAP instead of a real SAP GUI, so a
 * converted recording can be executed - and its conversion verified - on any
 * machine. Point `--test-import` at a file like this to try a conversion
 * without a SAP system. (It only knows the screens the fake defines: it proves
 * the conversion and the waiting, not that a recording matches your real system.)
 */
export const test = sapGuiTest.extend({
  // A function is only accepted here as a fixture implementation (in an
  // `{ option: true }` slot Playwright would call it as one), so hand it over via use().
  // Worker-scoped, like the connection that consumes it.
  sapGuiTransport: [
    async ({}, use) => {
      await use(() => createSampleSapSystem());
    },
    { scope: 'worker' },
  ],
});
export { test as sapGuiTest };
