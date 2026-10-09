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
 */
export function registerSapSteps({ Given, When, Then }: BddSteps): void {
  Given('I am logged on to SAP', async ({ sap }: SapStepFixtures) => {
    await ensureLoggedIn(sap);
  });

  When('I open transaction {string}', async ({ sap }: SapStepFixtures, tcode: string) => {
    await sap.startTransaction(tcode);
  });

  When(
    'I enter {string} in the field labelled {string}',
    async ({ sap }: SapStepFixtures, value: string, label: string) => {
      await sap.getByLabel(label).fill(value);
    },
  );

  When(
    'I enter {string} in the field with id {string}',
    async ({ sap }: SapStepFixtures, value: string, id: string) => {
      await sap.locator(id).fill(value);
    },
  );

  When('I tick the checkbox {string}', async ({ sap }: SapStepFixtures, text: string) => {
    await sap.getByText(text, { type: 'GuiCheckBox' }).check();
  });

  When('I click {string}', async ({ sap }: SapStepFixtures, text: string) => {
    await sap.getByText(text).click();
  });

  When('I click the toolbar button {string}', async ({ sap }: SapStepFixtures, tooltip: string) => {
    await sap.getByTooltip(tooltip).click();
  });

  When('I press Enter', async ({ sap }: SapStepFixtures) => {
    await sap.sendVKey(0);
  });

  When('I go back', async ({ sap }: SapStepFixtures) => {
    await sap.sendVKey(3);
  });

  When(
    'I remember the number from the status bar matching {string} as {string}',
    async ({ sap, sapScenario }: SapStepFixtures, pattern: string, name: string) => {
      const { text } = await sap.statusBar();
      const match = new RegExp(pattern).exec(text);
      if (!match)
        throw new Error(
          `the status bar says "${text || '(empty)'}", which does not match ${pattern}`,
        );
      sapScenario.set(name, (match[1] ?? match[0]).trim());
    },
  );

  When(
    'I enter the remembered {string} in the field labelled {string}',
    async ({ sap, sapScenario }: SapStepFixtures, name: string, label: string) => {
      const value = sapScenario.get(name);
      if (value === undefined)
        throw new Error(
          `nothing was remembered as "${name}" - use "I remember the number from the status bar matching ... as "${name}"" first`,
        );
      await sap.getByLabel(label).fill(value);
    },
  );

  Then('the status bar shows {string}', async ({ sap }: SapStepFixtures, text: string) => {
    await expect(sap).toHaveStatusMessage(text);
  });

  Then(
    'the status bar shows a success message containing {string}',
    async ({ sap }: SapStepFixtures, text: string) => {
      await expect(sap).toHaveStatusMessage(text, { type: 'S' });
    },
  );

  Then('the status bar does not show an error', async ({ sap }: SapStepFixtures) => {
    await expect(sap).not.toHaveStatusMessage(/./, { type: 'E' });
  });

  Then(
    'the field labelled {string} contains {string}',
    async ({ sap }: SapStepFixtures, label: string, value: string) => {
      await expect(sap.getByLabel(label)).toHaveText(value);
    },
  );

  Then('the screen title contains {string}', async ({ sap }: SapStepFixtures, text: string) => {
    await expect(sap).toHaveTitle(text);
  });
}
