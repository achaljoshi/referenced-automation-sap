import { expect, test } from '@playwright/test';
import { closeness, describeScreen, editDistance, FakeSapGui, sapExpect, SapGuiSession, type FakeElementSpec } from '../../src';

/**
 * When an assertion on a locator fails because the control is not on the screen, the message used to say only "expected on the
 * screen, received not on the screen". It now says what IS on the screen, so the test can be repaired without opening SAP.
 */
const FAST = { timeoutMs: 1_500, pollMs: 10 };
const SHORT = { timeout: 150 };

const bar = { 'wnd[0]/sbar': { type: 'GuiStatusbar', props: { messageType: 'W', text: 'Enter a customer' } } } as Record<string, FakeElementSpec>;

async function session(elements: Record<string, FakeElementSpec>, popup?: Record<string, FakeElementSpec>) {
  const fake = new FakeSapGui({
    start: 'main',
    screens: [
      {
        name: 'main',
        elements: { 'wnd[0]': { type: 'GuiMainWindow', props: { text: 'Customer: Overview' } }, 'wnd[0]/usr': { type: 'GuiUserArea' }, ...bar, ...elements, ...popup },
      },
    ],
  });
  return SapGuiSession.attach(fake, FAST);
}

const customerScreen: Record<string, FakeElementSpec> = {
  'wnd[0]/usr/lblADDR': { type: 'GuiLabel', props: { text: 'Addresses' } },
  'wnd[0]/usr/lblNAME': { type: 'GuiLabel', props: { text: 'Name' } },
  'wnd[0]/usr/tabsT/tabpGEN': { type: 'GuiTab', props: { text: 'General Data' } },
  'wnd[0]/usr/txtNAME1': { type: 'GuiTextField', props: { text: 'ACME Corp', leftLabel: 'Name' } },
  'wnd[0]/usr/txtCITY': { type: 'GuiTextField', props: { text: 'Walldorf', changeable: false, leftLabel: 'City' } },
  'wnd[0]/usr/chkBLOCK': { type: 'GuiCheckBox', props: { text: 'Blocked', selected: false } },
  'wnd[0]/tbar[0]/btn[11]': { type: 'GuiButton', props: { tooltip: 'Save (Ctrl+S)' } },
  'wnd[0]/mbar/menu[0]': { type: 'GuiMenu', props: { text: 'Customer' } },
};

async function failure(run: () => Promise<unknown>): Promise<string> {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(error, 'the assertion should have failed').toBeDefined();
  return (error as Error).message;
}

test.describe('"on the screen now" in a failed assertion', () => {
  test('getByText("Address", { exact: true }) on a screen that has "Addresses": the title, the status bar, the texts with ids, and the closest match', async () => {
    const sap = await session(customerScreen);
    await sapExpect(sap.getByText('Address').first()).toExist(); // "contains" finds "Addresses" - it is the exact match that is missing
    const message = await failure(() => sapExpect(sap.getByText('Address', { exact: true }).first()).toExist(SHORT));
    // the old message is still there
    expect(message).toMatch(/Expected: .*on the screen/);
    expect(message).toMatch(/Received: .*not on the screen/);
    // and what the screen shows
    expect(message).toContain('On the screen now (wnd[0]): title "Customer: Overview", status bar "Enter a customer" [W]');
    expect(message).toContain('"Addresses" (wnd[0]/usr/lblADDR)');
    expect(message).toContain('"General Data" (wnd[0]/usr/tabsT/tabpGEN)');
    expect(message).toContain('"Blocked" (wnd[0]/usr/chkBLOCK)');
    expect(message).toContain('"Customer" (wnd[0]/mbar/menu[0])');
    expect(message).toContain('tooltip "Save (Ctrl+S)" (wnd[0]/tbar[0]/btn[11])'); // a toolbar button has no text: its tooltip is what a user reads
    expect(message).toContain('Closest to "Address": "Addresses" (wnd[0]/usr/lblADDR)');
  });

  test('every assertion on a locator that cannot find its control says what is on the screen', async () => {
    const sap = await session(customerScreen);
    const missing = sap.getByText('Fax number');
    for (const [name, run] of [
      ['toExist', () => sapExpect(missing).toExist(SHORT)],
      ['toHaveText', () => sapExpect(missing).toHaveText('x', SHORT)],
      ['toContainText', () => sapExpect(missing).toContainText('x', SHORT)],
      ['toBeEditable', () => sapExpect(missing).toBeEditable(SHORT)],
      ['toBeChecked', () => sapExpect(missing).toBeChecked(SHORT)],
    ] as const) {
      const message = await failure(run);
      expect(message, name).toContain('not on the screen'); // 'not on the screen' (toExist) or '(control not on the screen)'
      expect(message, name).toContain('On the screen now (wnd[0]): title "Customer: Overview"');
      expect(message, name).toContain('"Addresses" (wnd[0]/usr/lblADDR)');
      expect(message, name).toContain('Nothing on the screen looks like "Fax number".');
    }
  });

  test('an id that is almost right: the closest ids are named', async () => {
    const sap = await session(customerScreen);
    const message = await failure(() => sapExpect(sap.locator('wnd[0]/usr/txtNAME2')).toExist(SHORT));
    expect(message).toContain('Closest to "txtNAME2": wnd[0]/usr/txtNAME1 (GuiTextField)');
  });

  test('a label locator names the labels that exist', async () => {
    const sap = await session(customerScreen);
    const message = await failure(() => sapExpect(sap.getByLabel('Nme')).toHaveText('x', SHORT));
    expect(message).toContain('Closest to "Nme": "Name" (wnd[0]/usr/lblNAME)');
  });

  test('a pop-up in front is named, with its own texts and ids', async () => {
    const sap = await session(customerScreen, {
      'wnd[1]': { type: 'GuiModalWindow', props: { text: 'System Message' } },
      'wnd[1]/usr/lblMSG': { type: 'GuiLabel', props: { text: 'Address data is being changed by user JDOE' } },
      'wnd[1]/tbar[0]/btn[0]': { type: 'GuiButton', props: { tooltip: 'Continue' } },
    });
    const message = await failure(() => sapExpect(sap.getByText('Address data').first()).toExist(SHORT));
    expect(message).toContain('A pop-up is in front (wnd[1], title "System Message")');
    expect(message).toContain('"Address data is being changed by user..." (wnd[1]/usr/lblMSG)'); // long texts are shortened
    expect(message).toContain('tooltip "Continue" (wnd[1]/tbar[0]/btn[0])');
    expect(message).toContain('Closest to "Address data" on the pop-up: "Address data is being changed by user..." (wnd[1]/usr/lblMSG)');
  });

  test('never shows a password, and never lists what an input field holds', async () => {
    const sap = await session({
      ...customerScreen,
      'wnd[0]/usr/pwdPASS': { type: 'GuiPasswordField', props: { text: 'hunter2-secret', leftLabel: 'Password' } },
      'wnd[0]/usr/lblPASS': { type: 'GuiLabel', props: { text: 'Password' } },
      'wnd[0]/usr/txtIBAN': { type: 'GuiTextField', props: { text: 'DE89370400440532013000', leftLabel: 'IBAN' } },
    });
    const message = await failure(() => sapExpect(sap.getByText('Passwort').first()).toExist(SHORT));
    expect(message).not.toContain('hunter2-secret');
    expect(message).not.toContain('pwdPASS');
    expect(message).not.toContain('DE89370400440532013000'); // the value of an input field is data, not a label
    expect(message).not.toContain('ACME Corp');
    expect(message).toContain('Closest to "Passwort": "Password" (wnd[0]/usr/lblPASS)'); // the label is fine
    // the hint helper itself, asked directly
    const direct = await describeScreen(sap, ['pwdPASS']);
    expect(direct).not.toContain('hunter2-secret');
  });

  test('is bounded: at most 25 texts are listed, and the whole block has a size limit', async () => {
    const many: Record<string, FakeElementSpec> = {};
    for (let i = 0; i < 150; i++) many[`wnd[0]/usr/lbl${i}`] = { type: 'GuiLabel', props: { text: `Label number ${i} ${'x'.repeat(200)}` } };
    const sap = await session(many);
    const message = await failure(() => sapExpect(sap.getByText('Address').first()).toExist(SHORT));
    const listed = message.slice(message.indexOf('On the screen now')).match(/\(wnd\[0\]\/usr\/lbl\d+\)/g) ?? [];
    expect(listed.length).toBeLessThanOrEqual(25);
    expect(listed.length).toBeGreaterThan(20);
    expect(message).toContain('texts (25 of 150)');
    expect(message.length).toBeLessThan(4_500);
    expect(message).toContain('...'); // long texts are shortened
    expect(message).not.toContain('x'.repeat(60));
  });

  test('is quick on a screen with many controls (the walk has a time budget)', async () => {
    const many: Record<string, FakeElementSpec> = {};
    for (let i = 0; i < 400; i++) many[`wnd[0]/usr/txtF${i}`] = { type: 'GuiTextField' };
    const sap = await session(many);
    const started = Date.now();
    await describeScreen(sap, ['x']);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('a control that is there passes with no screen walk, and a failing .not assertion (the control IS there) adds nothing', async () => {
    const sap = await session(customerScreen);
    await sapExpect(sap.getByText('Addresses')).toExist();
    const message = await failure(() => sapExpect(sap.getByText('Addresses')).not.toExist(SHORT));
    expect(message).not.toContain('On the screen now');
  });

  test('a failing text comparison on a control that exists is not "missing": no screen listing', async () => {
    const sap = await session(customerScreen);
    const message = await failure(() => sapExpect(sap.locator('wnd[0]/usr/txtNAME1')).toHaveText('Somebody else', SHORT));
    expect(message).toContain('ACME Corp');
    expect(message).not.toContain('On the screen now');
  });

  test('an action on a locator that matches nothing says the same (the message of the failed click / fill)', async () => {
    const fast = await SapGuiSession.attach(
      new FakeSapGui({ start: 'main', screens: [{ name: 'main', elements: { 'wnd[0]': { type: 'GuiMainWindow', props: { text: 'Customer: Overview' } }, ...customerScreen } }] }),
      { timeoutMs: 300, pollMs: 10 },
    );
    const message = await failure(() => fast.getByText('Adresses').first().click());
    expect(message).toContain('no control matched text "Adresses" [0]');
    expect(message).toContain('On the screen now (wnd[0]): title "Customer: Overview"');
    expect(message).toContain('Closest to "Adresses": "Addresses" (wnd[0]/usr/lblADDR)');
  });

  test('keeps going when parts of the screen cannot be read: the failure message still comes through', async () => {
    const sap = await session(customerScreen);
    const broken = new Proxy(sap, {
      get: (target, key, receiver) => (key === 'statusBar' || key === 'peekProp' ? () => Promise.reject(new Error('RPC server unavailable')) : Reflect.get(target, key, receiver)),
    });
    await expect(describeScreen(broken, ['x'])).resolves.toContain('On the screen now');
  });
});

test.describe('closeness - what counts as "looks like"', () => {
  test('contains either way, case-insensitive, or a small edit distance (a typo, a plural)', () => {
    expect(closeness('Address', 'Addresses')).toBe(0);
    expect(closeness('address data', 'ADDRESS')).toBe(0);
    expect(closeness('Custmer', 'Customer')).toBe(1);
    expect(closeness('Sold-To Party', 'Sold-to Prty')).toBeLessThanOrEqual(2);
    expect(closeness('Address', 'Material')).toBeUndefined();
    expect(closeness('', 'x')).toBeUndefined();
  });

  test('edit distance stops early once it is over the limit', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('kitten', 'sitting', 1)).toBeGreaterThan(1);
    expect(editDistance('a', 'abcdefgh', 2)).toBeGreaterThan(2);
  });
});
