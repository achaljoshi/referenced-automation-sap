import { expect as pwExpect, test } from '@playwright/test';
import { createSampleSapSystem, sapExpect as expect, SapGuiSession } from '../../src';
import { demoSession, FAST } from './support';

test.describe('locators: find a control the way a user sees it', () => {
  test('by label, tooltip, text and type', async () => {
    const { sap } = await demoSession();
    expect(await sap.getByLabel('Priority').id()).toBe('wnd[0]/usr/cmbPRIO');
    expect(await sap.getByTooltip('Save').id()).toBe('wnd[0]/usr/btnSAVE');
    expect(await sap.getByText('Details').id()).toBe('wnd[0]/usr/tabsT/tabpDET');
    expect(await sap.getByType('GuiComboBox').id()).toBe('wnd[0]/usr/cmbPRIO');
    expect(await sap.getByLabel('priority').id()).toBe('wnd[0]/usr/cmbPRIO'); // case-insensitive
  });

  test('exact matches the whole text only', async () => {
    const { sap } = await demoSession();
    expect(await sap.getByText('Save', { exact: true }).count()).toBe(1);
    expect(await sap.getByText('Sav', { exact: true }).count()).toBe(0);
    expect(await sap.getByText('Sav').count()).toBe(1);
  });

  test('strict: an ambiguous locator fails and says which controls matched', async () => {
    const { sap } = await demoSession();
    const error = (await sap.getByType('GuiButton').id().catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/ambiguous: 2 controls match.*btnCONT.*btnSAVE/);
    expect(error.message).toContain('.first()');
  });

  test('first / last / nth choose on purpose', async () => {
    const { sap } = await demoSession();
    expect(await sap.getByType('GuiButton').first().id()).toBe('wnd[0]/usr/btnCONT');
    expect(await sap.getByType('GuiButton').last().id()).toBe('wnd[0]/usr/btnSAVE');
    expect(await sap.getByType('GuiButton').nth(1).id()).toBe('wnd[0]/usr/btnSAVE');
    await expect(sap.getByType('GuiButton').nth(5).id()).rejects.toThrow(/no match number 5 \(only 2 found\)/);
  });

  test('not found: says what was looked for and how to see the screen', async () => {
    const { sap } = await demoSession();
    const error = (await sap.getByLabel('Nonexistent').id(200).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/no control matched label "Nonexistent" after 200ms.*doctor -- --dump/);
  });

  test('waits for a control that is not there yet', async () => {
    const { fake } = await demoSession({ elements: { ...(await lateElements()) } });
    const sap = await SapGuiSession.attach(fake, FAST);
    expect(await sap.getByLabel('Late field').id()).toBe('wnd[0]/usr/txtLATE');
  });

  test('a child locator is addressed relative to its parent', async () => {
    const { sap } = await demoSession();
    expect(await sap.locator('wnd[0]/usr').locator('txtCITY').id()).toBe('wnd[0]/usr/txtCITY');
    expect(await sap.getByLabel('City').exists()).toBe(true);
  });
});

async function lateElements() {
  return {
    'wnd[0]': { type: 'GuiMainWindow' },
    'wnd[0]/usr/txtLATE': { type: 'GuiTextField', appearsAfterMs: 250, props: { leftLabel: 'Late field' } },
    'wnd[0]/sbar': { type: 'GuiStatusbar' },
  };
}

test.describe('actions choose by what the control is', () => {
  test('click: a button is pressed, a tab and radio button are selected, a checkbox is toggled', async () => {
    const { sap, fake } = await demoSession();
    await sap.getByTooltip('Save').click();
    await sap.getByText('Details').click();
    await sap.getByText('Option B').click();
    await sap.getByText('Include items').click();
    expect(fake.calls.map((c) => `${c.op}:${c.name}:${c.id.split('/').pop()}`)).toEqual([
      'call:press:btnSAVE',
      'call:select:tabpDET',
      'call:select:radOPTB',
      'set:selected:chkINCL',
    ]);
    expect(fake.calls[3]?.args).toEqual([true]);
  });

  test('click twice on a checkbox toggles back', async () => {
    const { sap, fake } = await demoSession();
    const box = sap.getByText('Include items');
    await box.click();
    await box.click();
    expect(fake.calls.map((c) => c.args[0])).toEqual([true, false]);
  });

  test('click on a control it cannot click explains what to do instead', async () => {
    const { sap } = await demoSession();
    await expect(sap.getByText('Information').click()).rejects.toThrow(/does not know what to do with a GuiLabel.*\.call\(/);
  });

  test('fill: text into a field, an option into a drop-down, a tick into a checkbox', async () => {
    const { sap, fake } = await demoSession();
    await sap.getByLabel('City').fill('Leeds');
    await sap.getByLabel('Priority').fill('High');
    await sap.getByText('Include items').fill('X');
    expect(fake.calls.map((c) => `${c.name}=${String(c.args[0])}`)).toEqual(['text=Leeds', 'value=High', 'selected=true']);
  });

  test('a drop-down lists its entries', async () => {
    const { sap } = await demoSession();
    expect(await sap.getByLabel('Priority').options()).toEqual(['Low', 'High']);
  });

  test('fill: an invalid drop-down option says so', async () => {
    const { sap } = await demoSession();
    await expect(sap.getByLabel('Priority').fill('Urgent')).rejects.toThrow(/"Urgent" is not an option of the drop-down/);
  });

  test('fill: a read-only field is refused before anything is typed', async () => {
    const { sap, fake } = await demoSession();
    await expect(sap.getByLabel('Created by').fill('me')).rejects.toThrow(/is read-only/);
    expect(fake.calls).toHaveLength(0);
  });

  test('fill: checkMaxLength refuses text longer than the field allows', async () => {
    const { sap } = await demoSession();
    await expect(sap.getByLabel('Name').fill('Toolong', { checkMaxLength: true })).rejects.toThrow(/7 characters but .* allows 5/);
    await sap.getByLabel('Name').fill('Okay', { checkMaxLength: true });
  });

  test('check / uncheck are idempotent', async () => {
    const { sap, fake } = await demoSession();
    const box = sap.getByText('Include items');
    await box.uncheck(); // already unticked: nothing to do
    expect(fake.calls).toHaveLength(0);
    await box.check();
    await box.check();
    expect(fake.calls).toHaveLength(1);
  });

  test('a typed password is masked in the log', async () => {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const { sap } = await demoSession();
      await sap.getByLabel('Password').fill('hunter2-secret');
    } finally {
      process.stdout.write = original;
    }
    const out = lines.join('');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('hunter2-secret');
  });
});

test.describe('assertions wait and retry (and a negative control proves they are not vacuous)', () => {
  test('toHaveText waits for a field that appears late', async () => {
    const { fake } = await demoSession({ elements: { ...(await lateElements()) } });
    const sap = await SapGuiSession.attach(fake, FAST);
    await expect(sap.getByLabel('Late field')).toExist({ timeout: 2000 });
  });

  test('toHaveText / toContainText / toBeEditable', async () => {
    const { sap } = await demoSession();
    await expect(sap.getByLabel('Created by')).toHaveText('SYSTEM');
    await expect(sap.getByLabel('Created by')).toContainText(/SYS/);
    await expect(sap.getByLabel('Created by')).not.toBeEditable();
    await expect(sap.getByLabel('City')).toBeEditable();
  });

  test('a failing assertion reports what was found', async () => {
    const { sap } = await demoSession();
    const failure = await expect(sap.getByLabel('Created by')).toHaveText('SOMEONE', { timeout: 300 }).catch((e: unknown) => e as Error);
    expect((failure as Error).message).toContain('SOMEONE');
    expect((failure as Error).message).toContain('SYSTEM');
  });

  test('.not.toExist passes for a control that is absent, and fails for one that is there', async () => {
    const { sap } = await demoSession();
    await expect(sap.getByLabel('Ghost')).not.toExist({ timeout: 200 });
    await expect(expect(sap.getByLabel('City')).not.toExist({ timeout: 200 })).rejects.toThrow();
  });

  test('toBeChecked follows a change', async () => {
    const { sap } = await demoSession();
    await expect(sap.getByText('Include items')).not.toBeChecked();
    await sap.getByText('Include items').check();
    await expect(sap.getByText('Include items')).toBeChecked();
  });

  test('toHaveStatusMessage waits for the message a server round trip produces', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 150 });
    const sap = await SapGuiSession.attach(fake, FAST);
    await sap.setText('wnd[0]/usr/txtRSYST-MANDT', '100');
    await sap.setText('wnd[0]/usr/txtRSYST-BNAME', 'TESTUSER');
    await sap.setText('wnd[0]/usr/pwdRSYST-BCODE', 'correct-horse');
    await sap.sendVKey(0);
    await sap.startTransaction('VA01');
    await sap.setText('wnd[0]/usr/ctxtVBAK-AUART', 'OR');
    await sap.sendVKey(0);
    await sap.getByTooltip('Save').click();
    await expect(sap).toHaveStatusMessage(/has been saved/i, { type: 'S' });
    await expect(sap).toHaveTitle(/Create Standard Order/);
    await expect(expect(sap).toHaveStatusMessage(/has been saved/i, { type: 'E', timeout: 200 })).rejects.toThrow();
  });

  test('the sample logon fields are findable by label', async () => {
    const sap = await SapGuiSession.attach(createSampleSapSystem(), FAST);
    await sap.getByLabel('User').fill('TESTUSER');
    pwExpect(await sap.getByLabel('User').text()).toBe('TESTUSER');
  });
});
