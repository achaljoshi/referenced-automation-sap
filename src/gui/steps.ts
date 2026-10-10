import type { placeholders } from '@automation/referenced-automation-utils';
import { expect } from './matchers';
import type { SapGuiSession } from './session';
import { ensureLoggedIn } from './logon';

/** The step-registration functions of whichever BDD library is in use (playwright-bdd's `createBdd(test)` gives these). */
type StepFunction = (
  pattern: string | RegExp,
  implementation: (fixtures: any, ...parameters: any[]) => unknown,
) => unknown;

export interface BddSteps {
  Given: StepFunction;
  When: StepFunction;
  Then: StepFunction;
}

/** What a step receives from the test: the SAP session, and a place to remember values between steps of a scenario. */
interface SapStepFixtures {
  sap: SapGuiSession;
  sapScenario: Map<string, string>;
  /** The scenario's named values and `{{placeholders}}` (the test's `vars` fixture): every string in a step goes through it, and remembered values are stored there too so steps from other libraries (UI, API) can use `{{order}}`. */
  vars: placeholders.ScenarioVariables;
}

/**
 * Reusable, business-readable steps for Gherkin features that drive SAP GUI. Library-agnostic: pass the
 * Given/When/Then of your BDD tool. The test those steps run in needs the `sap` and `sapScenario` fixtures -
 * i.e. be built on `sapGuiTest` (see ui-api's features/ for a working setup with playwright-bdd).
 *
 *   Given I am logged on to SAP
 *   When I open transaction "VA01"
 *   And I enter "OR" in the field labelled "Order Type"
 *   And I press Enter
 *   And I click the toolbar button "Save"
 *   Then the status bar shows a success message containing "has been saved"
 *
 * Fields are found by the label the user sees; a technical id step exists for the cases that have no label.
 * Every string understands {{placeholders}} ({{random:alnum(6)}}, {{date:+7d}}, {{env:X}}, {{uuid}}, a remembered {{order}}),
 * and a value remembered from the status bar is available as {{name}} to steps from the UI and API libraries too.
 */
export function registerSapSteps({ Given, When, Then }: BddSteps): void {
  Given('I am logged on to SAP', async ({ sap }: SapStepFixtures) => {
    await ensureLoggedIn(sap);
  });

  When('I open transaction {string}', async ({ sap, vars }: SapStepFixtures, tcode: string) => {
    await sap.startTransaction(vars.interpolate(tcode));
  });

  When(
    'I enter {string} in the field labelled {string}',
    async ({ sap, vars }: SapStepFixtures, value: string, label: string) => {
      await sap.getByLabel(vars.interpolate(label)).fill(vars.interpolate(value));
    },
  );

  When(
    'I enter {string} in the field with id {string}',
    async ({ sap, vars }: SapStepFixtures, value: string, id: string) => {
      await sap.locator(id).fill(vars.interpolate(value));
    },
  );

  When('I tick the checkbox {string}', async ({ sap, vars }: SapStepFixtures, text: string) => {
    await sap.getByText(vars.interpolate(text), { type: 'GuiCheckBox' }).check();
  });

  When('I click {string}', async ({ sap, vars }: SapStepFixtures, text: string) => {
    await sap.getByText(vars.interpolate(text)).click();
  });

  When(
    'I click the toolbar button {string}',
    async ({ sap, vars }: SapStepFixtures, tooltip: string) => {
      await sap.getByTooltip(vars.interpolate(tooltip)).click();
    },
  );

  When('I press Enter', async ({ sap }: SapStepFixtures) => {
    await sap.sendVKey(0);
  });

  When('I go back', async ({ sap }: SapStepFixtures) => {
    await sap.sendVKey(3);
  });

  When(
    'I remember the number from the status bar matching {string} as {string}',
    async ({ sap, sapScenario, vars }: SapStepFixtures, pattern: string, name: string) => {
      const { text } = await sap.statusBar();
      const match = new RegExp(pattern).exec(text);
      if (!match)
        throw new Error(
          `the status bar says "${text || '(empty)'}", which does not match ${pattern}`,
        );
      const value = (match[1] ?? match[0]).trim();
      sapScenario.set(name, value);
      vars.set(name, value);
    },
  );

  When(
    'I enter the remembered {string} in the field labelled {string}',
    async ({ sap, sapScenario, vars }: SapStepFixtures, name: string, label: string) => {
      const value = sapScenario.get(name) ?? vars.get(name);
      if (value === undefined)
        throw new Error(
          `nothing was remembered as "${name}" - use "I remember the number from the status bar matching ... as "${name}"" first`,
        );
      await sap.getByLabel(vars.interpolate(label)).fill(value);
    },
  );

  Then('the status bar shows {string}', async ({ sap, vars }: SapStepFixtures, text: string) => {
    await expect(sap).toHaveStatusMessage(vars.interpolate(text));
  });

  Then(
    'the status bar shows a success message containing {string}',
    async ({ sap, vars }: SapStepFixtures, text: string) => {
      await expect(sap).toHaveStatusMessage(vars.interpolate(text), { type: 'S' });
    },
  );

  // Waits for evidence that SAP has answered the last action (a success/info/warning message, or the screen moving on) and
  // then checks for an error (E) or abort (A) - "no error yet" on a screen that has not changed proves nothing.
  Then('the status bar does not show an error', async ({ sap }: SapStepFixtures) => {
    await expect(sap).toHaveNoStatusError();
  });

  Then('the status bar does not show an error right now', async ({ sap }: SapStepFixtures) => {
    await expect(sap).toHaveNoStatusError({ requireOutcome: false });
  });

  Then(
    'the field labelled {string} contains {string}',
    async ({ sap, vars }: SapStepFixtures, label: string, value: string) => {
      await expect(sap.getByLabel(vars.interpolate(label))).toHaveText(vars.interpolate(value));
    },
  );

  Then(
    'the screen title contains {string}',
    async ({ sap, vars }: SapStepFixtures, text: string) => {
      await expect(sap).toHaveTitle(vars.interpolate(text));
    },
  );
}
