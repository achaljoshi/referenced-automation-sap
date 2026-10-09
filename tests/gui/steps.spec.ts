import { expect, test } from '@playwright/test';
import { createSampleSapSystem, registerSapSteps, SapGuiSession } from '../../src';
import { FAST } from './support';

type Implementation = (fixtures: any, ...parameters: any[]) => unknown;

/** A stand-in for a BDD library: records the steps so each can be run by hand. */
function registry() {
  const steps = new Map<string, Implementation>();
  const add = (_kind: string) => (pattern: string | RegExp, implementation: Implementation) => void steps.set(String(pattern), implementation);
  registerSapSteps({ Given: add('Given'), When: add('When'), Then: add('Then') });
  return {
    steps,
    run: async (pattern: string, fixtures: object, ...parameters: unknown[]) => {
      const step = steps.get(pattern);
      if (!step) throw new Error(`no step "${pattern}"`);
      await step(fixtures, ...parameters);
    },
  };
}

async function loggedOn() {
  const fake = createSampleSapSystem({ transitionDelayMs: 20 });
  const sap = await SapGuiSession.attach(fake, FAST);
  process.env.SAP_USER = 'TESTUSER';
  process.env.SAP_PASSWORD = 'correct-horse';
  process.env.SAP_CLIENT = '100';
  return { sap, fake, fixtures: { sap, sapScenario: new Map<string, string>() } };
}

test.afterEach(() => {
  for (const k of ['SAP_USER', 'SAP_PASSWORD', 'SAP_CLIENT']) delete process.env[k];
});

test.describe('the reusable SAP steps', () => {
  test('the vocabulary is stable (a rename would silently break every feature file that uses it)', () => {
    expect([...registry().steps.keys()].sort()).toEqual(
      [
        'I am logged on to SAP',
        'I click the toolbar button {string}',
        'I click {string}',
        'I enter the remembered {string} in the field labelled {string}',
        'I enter {string} in the field labelled {string}',
        'I enter {string} in the field with id {string}',
        'I go back',
        'I open transaction {string}',
        'I press Enter',
        'I remember the number from the status bar matching {string} as {string}',
        'I tick the checkbox {string}',
        'the field labelled {string} contains {string}',
        'the screen title contains {string}',
        'the status bar does not show an error',
        'the status bar shows a success message containing {string}',
        'the status bar shows {string}',
      ].sort(),
    );
  });

  test('a whole feature, step by step: log on, create an order, read the number, check the result', async () => {
    const { run } = registry();
    const { fixtures, sap } = await loggedOn();
    await run('I am logged on to SAP', fixtures);
    await run('I open transaction {string}', fixtures, 'VA01');
    await run('I enter {string} in the field labelled {string}', fixtures, 'OR', 'Order Type');
    await run('I enter {string} in the field labelled {string}', fixtures, '1000', 'Sales Organization');
    await run('I press Enter', fixtures);
    await run('I enter {string} in the field labelled {string}', fixtures, '1000', 'Sold-To Party');
    await run('I enter {string} in the field labelled {string}', fixtures, 'E2E-REF', 'Customer Reference');
    await run('the field labelled {string} contains {string}', fixtures, 'Customer Reference', 'E2E-REF');
    await run('I click the toolbar button {string}', fixtures, 'Save');
    await run('the status bar shows a success message containing {string}', fixtures, 'has been saved');
    await run('the status bar does not show an error', fixtures);
    await run('the screen title contains {string}', fixtures, 'Create Standard Order');
    await run('I remember the number from the status bar matching {string} as {string}', fixtures, 'Order (\\d+)', 'order');
    expect(fixtures.sapScenario.get('order')).toBe('4711');
    expect(sap.journalText()).toContain('VA01');
  });

  test('remembered values can be used by a later step; asking for one that was never remembered says how to remember it', async () => {
    const { run } = registry();
    const { fixtures } = await loggedOn();
    await run('I am logged on to SAP', fixtures);
    await run('I open transaction {string}', fixtures, 'VA01');
    await run('I enter {string} in the field labelled {string}', fixtures, 'OR', 'Order Type');
    await run('I press Enter', fixtures);
    fixtures.sapScenario.set('customer', '1000');
    await run('I enter the remembered {string} in the field labelled {string}', fixtures, 'customer', 'Sold-To Party');
    await expect(run('I enter the remembered {string} in the field labelled {string}', fixtures, 'nothing', 'Sold-To Party')).rejects.toThrow(/nothing was remembered as "nothing".*I remember the number from the status bar/);
  });

  test('negative controls: a wrong expectation fails, and says what SAP actually showed', async () => {
    const { run } = registry();
    const { fixtures } = await loggedOn();
    await run('I am logged on to SAP', fixtures);
    await expect(run('the status bar shows a success message containing {string}', fixtures, 'has been saved')).rejects.toThrow();
    await expect(run('the field labelled {string} contains {string}', fixtures, 'Ghost field', 'x')).rejects.toThrow();
    await expect(run('I remember the number from the status bar matching {string} as {string}', fixtures, 'Order (\\d+)', 'order')).rejects.toThrow(/does not match Order/);
  });

  test('"I am logged on" does nothing to a session that already is, and fails clearly without credentials', async () => {
    const { run } = registry();
    const { fixtures, fake } = await loggedOn();
    await run('I am logged on to SAP', fixtures);
    const calls = fake.calls.length;
    await run('I am logged on to SAP', fixtures);
    expect(fake.calls.length).toBe(calls);

    const fresh = createSampleSapSystem({ transitionDelayMs: 0 });
    const sap = await SapGuiSession.attach(fresh, FAST);
    delete process.env.SAP_USER;
    delete process.env.SAP_PASSWORD;
    await expect(run('I am logged on to SAP', { sap, sapScenario: new Map() })).rejects.toThrow(/SAP_USER and SAP_PASSWORD must both be set/);
  });
});
