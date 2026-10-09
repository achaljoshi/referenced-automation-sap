import { expect, test } from '@playwright/test';
import { attachDiagnostics, FakeSapGui, SapGuiSession } from '../../src';

/** A screen where the City field's id changed from txtCITY to txtNEWCITY (after a SAP release), but its label did not. */
async function drifted(options: { fallbacks?: 'report' | 'fail' | 'off'; lateOldId?: boolean; ambiguousLabel?: boolean } = {}) {
  const fake = new FakeSapGui({
    start: 'main',
    screens: [
      {
        name: 'main',
        context: { transaction: 'XK01', program: 'SAPMF02K', screen: '0100' },
        elements: {
          'wnd[0]': { type: 'GuiMainWindow' },
          'wnd[0]/usr/txtNEWCITY': { type: 'GuiTextField', props: { leftLabel: 'City' } },
          ...(options.ambiguousLabel ? { 'wnd[0]/usr/txtOTHERCITY': { type: 'GuiTextField', props: { leftLabel: 'City' } } } : {}),
          ...(options.lateOldId ? { 'wnd[0]/usr/txtCITY': { type: 'GuiTextField', appearsAfterMs: 600, props: { leftLabel: 'City (old)' } } } : {}),
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
      },
    ],
  });
  const sap = await SapGuiSession.attach(fake, { timeoutMs: 3_000, pollMs: 10, fallbacks: options.fallbacks });
  return { sap, fake };
}

test.describe('locator fallbacks: explicit, reported self-healing', () => {
  test('when the id is gone but the label is there, the test continues and the drift is recorded with the new id', async () => {
    const { sap, fake } = await drifted();
    await sap.locator('wnd[0]/usr/txtCITY').orElse(sap.getByLabel('City')).fill('Leeds');

    expect(fake.calls[0]).toMatchObject({ id: 'wnd[0]/usr/txtNEWCITY', name: 'text', args: ['Leeds'] });
    expect(sap.driftItems).toEqual([
      { expected: 'wnd[0]/usr/txtCITY', usedFallback: 'label "City"', foundId: 'wnd[0]/usr/txtNEWCITY', tx: 'XK01', screen: '0100' },
    ]);
  });

  test('the drift reaches the report as an attachment (even though the test passed)', async () => {
    const { sap } = await drifted();
    await sap.locator('wnd[0]/usr/txtCITY').orElse(sap.getByLabel('City')).fill('Leeds');
    const attached: Array<{ name: string; body?: string }> = [];
    await attachDiagnostics(sap, { attach: async (name, o) => void attached.push({ name, body: o.body }) }, 'failure', false);
    const drift = attached.find((a) => a.name === 'sap-locator-drift');
    expect(drift?.body).toContain('wnd[0]/usr/txtCITY');
    expect(drift?.body).toContain('wnd[0]/usr/txtNEWCITY');
    expect(drift?.body).toContain('transaction XK01');
  });

  test('negative control: without a fallback the same step simply fails', async () => {
    const { sap } = await drifted();
    await expect(sap.locator('wnd[0]/usr/txtCITY').fill('Leeds')).rejects.toThrow(/txtCITY.*not found/);
  });

  test('the primary id wins when it is there - no drift is recorded', async () => {
    const { sap, fake } = await drifted();
    await sap.locator('wnd[0]/usr/txtNEWCITY').orElse(sap.getByLabel('Nonexistent')).fill('Leeds');
    expect(fake.calls[0]?.id).toBe('wnd[0]/usr/txtNEWCITY');
    expect(sap.driftItems).toHaveLength(0);
  });

  test('a slow screen is not a changed id: the primary gets a grace period before a fallback may be used', async () => {
    const { sap, fake } = await drifted({ lateOldId: true });
    // the old id appears after 600 ms; the grace period is a third of the 3 s timeout = 1 s
    await sap.locator('wnd[0]/usr/txtCITY').orElse(sap.getByLabel('City', { exact: true })).fill('Leeds');
    expect(fake.calls[0]?.id).toBe('wnd[0]/usr/txtCITY');
    expect(sap.driftItems).toHaveLength(0);
  });

  test("SAP_GUI_FALLBACKS=fail turns drift into a failure that names the id to put in the page object", async () => {
    const { sap } = await drifted({ fallbacks: 'fail' });
    const error = (await sap.locator('wnd[0]/usr/txtCITY').orElse(sap.getByLabel('City')).fill('x').catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('locator drift');
    expect(error.message).toContain('wnd[0]/usr/txtNEWCITY');
    expect(error.message).toContain('Update the page object');
  });

  test("'off' ignores fallbacks entirely", async () => {
    const { sap } = await drifted({ fallbacks: 'off' });
    await expect(sap.locator('wnd[0]/usr/txtCITY').orElse(sap.getByLabel('City')).fill('x')).rejects.toThrow(/not found|no control matched/);
    expect(sap.driftItems).toHaveLength(0);
  });

  test('an ambiguous fallback is not used (it would be a guess); the next alternate is tried', async () => {
    const { sap, fake } = await drifted({ ambiguousLabel: true });
    await sap.locator('wnd[0]/usr/txtCITY').orElse(sap.getByLabel('City'), sap.locator('wnd[0]/usr/txtNEWCITY')).fill('Leeds');
    expect(fake.calls[0]?.id).toBe('wnd[0]/usr/txtNEWCITY');
    expect(sap.driftItems[0]?.usedFallback).toBe('wnd[0]/usr/txtNEWCITY');
  });

  test('works for reading and assertions too, not only fill', async () => {
    const { sap } = await drifted();
    const city = sap.locator('wnd[0]/usr/txtCITY').orElse(sap.getByLabel('City'));
    expect(await city.exists()).toBe(true);
    expect(await city.count()).toBe(1);
    expect(sap.driftItems).toHaveLength(0); // peeking does not count as use
    await city.fill('x');
    expect(sap.driftItems).toHaveLength(1);
  });

  test('resetDiagnostics clears the drift between tests', async () => {
    const { sap } = await drifted();
    await sap.locator('wnd[0]/usr/txtCITY').orElse(sap.getByLabel('City')).fill('x');
    sap.resetDiagnostics();
    expect(sap.driftItems).toHaveLength(0);
  });
});
