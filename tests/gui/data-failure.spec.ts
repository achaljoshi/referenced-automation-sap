import { expect, test } from '@playwright/test';
import { startFromHome, surfaceCleanupFailures, type CreatedObject } from '../../src';
import { countingTest } from './countingTest';
import { demoSession } from './support';

/**
 * SAP-05: a cleanup that fails used to be a log line - the test stayed green and the orphan order stayed in SAP. Now every failed
 * cleanup is a test annotation and, by default, fails the test (naming each orphan); `sapCleanupFailure: 'warn'` /
 * SAP_GUI_CLEANUP_FAILURE=warn only records it.
 */
const item = (status: CreatedObject['status'], id: string, note?: string): CreatedObject => ({ type: 'SalesOrder', id, test: 't', at: 'now', status, ...(note ? { note } : {}) });

test.describe('surfacing cleanup failures (what the sapData fixture does after the cleanup)', () => {
  test('a failed cleanup fails the test, naming the orphan and why, and is annotated', () => {
    const testInfo = { annotations: [] as Array<{ type: string; description?: string }> };
    expect(() => surfaceCleanupFailures([item('cleaned', '1'), item('cleanup-failed', '4711', 'locked by another user')], testInfo, 'fail')).toThrow(
      /1 SAP object\(s\).*could not be cleaned up[\s\S]*SalesOrder 4711: locked by another user/,
    );
    expect(testInfo.annotations).toEqual([{ type: 'sap-cleanup-failed', description: 'SalesOrder 4711: locked by another user' }]);
  });

  test('"warn" records the annotation and lets the test pass', () => {
    const testInfo = { annotations: [] as Array<{ type: string; description?: string }> };
    expect(() => surfaceCleanupFailures([item('cleanup-failed', '4712', 'boom')], testInfo, 'warn')).not.toThrow();
    expect(testInfo.annotations).toHaveLength(1);
  });

  test('nothing failed (cleaned, kept, or left on purpose with SAP_GUI_CLEANUP=off) is not a failure', () => {
    const testInfo = { annotations: [] as Array<{ type: string; description?: string }> };
    expect(() => surfaceCleanupFailures([item('cleaned', '1'), item('kept', '2'), item('created', '3')], testInfo, 'fail')).not.toThrow();
    expect(testInfo.annotations).toEqual([]);
  });
});

test.describe('S15: a session that cannot go home fails the test', () => {
  test('home() failing is an error by default, and the connection is dropped so the next test starts fresh', async () => {
    const { sap } = await demoSession();
    sap.home = async () => Promise.reject(new Error('wnd[1] is still open'));
    let dropped = false;
    await expect(startFromHome(sap, 'fail', async () => void (dropped = true))).rejects.toThrow(
      /could not return to the start screen before the test: wnd\[1\] is still open.*SAP_GUI_HOME_FAILURE=warn/,
    );
    expect(dropped).toBe(true);
  });

  test('"warn" logs it and lets the test run', async () => {
    const { sap } = await demoSession();
    sap.home = async () => Promise.reject(new Error('wnd[1] is still open'));
    await expect(startFromHome(sap, 'warn')).resolves.toBeUndefined();
  });
});

// The wiring: the option exists on the fixture and reaches the teardown.
const lenient = countingTest({ opened: 0 });
lenient.use({ sapGuiMode: 'attach', sapCleanupFailure: 'warn' });
lenient('with sapCleanupFailure: "warn" a failing cleanup does not fail the test', async ({ sapData }) => {
  sapData.record('SalesOrder', '4712', { cleanup: async () => Promise.reject(new Error('locked by another user')) });
});
