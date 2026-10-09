import { expect } from '@playwright/test';
import { ensureLoggedIn } from '../../src';
import { countingTest, creds } from './countingTest';

const reused = { opened: 0 };
const worker = countingTest(reused);
// file-level: worker-scoped options apply to the whole file, so each reuse mode has its own file
worker.use({ sapGuiMode: 'attach' }); // hermetic: do not depend on SAP_GUI_MODE in whichever .env file is active
worker.describe('worker reuse (the default): one SAP connection per worker', () => {
  worker.describe.configure({ mode: 'serial' });
  worker('test 1 opens the connection, logs on and leaves SAP in a transaction', async ({ sap }) => {
    await ensureLoggedIn(sap, creds);
    await sap.startTransaction('VA01');
    expect(sap.steps.length).toBeGreaterThan(0);
    await sap.evidence('left a mess behind');
  });

  worker('test 2 reuses it: no new connection, already logged on, back at the start screen, clean diagnostics', async ({ sap }) => {
    expect(reused.opened).toBe(1);
    expect(await sap.getText('wnd[0]')).toBe('SAP Easy Access'); // home() ran
    expect(await sap.exists('wnd[0]/usr/pwdRSYST-BCODE')).toBe(false); // still logged on
    expect(sap.evidenceItems).toHaveLength(0);
    expect(sap.steps.filter((s) => s.label.startsWith('home')).length).toBeLessThanOrEqual(sap.steps.length);
  });

  worker('pop-up handlers from an earlier test do not leak into this one', async ({ sap }) => {
    let ran = false;
    sap.onPopup('x', { title: /./ }, async () => void (ran = true));
    sap.resetDiagnostics();
    expect(await sap.dismissPopups()).toBe(0);
    expect(ran).toBe(false);
  });
});

