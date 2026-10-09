import { FakeSapGui, SapGuiSession, type FakeScreen } from '../../src';

export const FAST = { timeoutMs: 1_500, pollMs: 10 };

/** A session on a one-screen fake SAP with one control of each kind a test might touch. */
export async function demoSession(extra: Partial<FakeScreen> = {}, transitionDelayMs = 0): Promise<{ sap: SapGuiSession; fake: FakeSapGui }> {
  const fake = new FakeSapGui({
    start: 'main',
    transitionDelayMs,
    screens: [
      {
        name: 'main',
        elements: {
          'wnd[0]': { type: 'GuiMainWindow', props: { text: 'Demo screen' } },
          'wnd[0]/tbar[0]/okcd': { type: 'GuiOkCodeField' },
          'wnd[0]/usr': { type: 'GuiUserArea' },
          'wnd[0]/usr/btnCONT': { type: 'GuiButton', props: { text: 'Continue', tooltip: 'Continue (Enter)' } },
          'wnd[0]/usr/btnSAVE': { type: 'GuiButton', props: { text: 'Save', tooltip: 'Save (Ctrl+S)' } },
          'wnd[0]/usr/chkINCL': { type: 'GuiCheckBox', props: { text: 'Include items', selected: false } },
          'wnd[0]/usr/radOPTB': { type: 'GuiRadioButton', props: { text: 'Option B', selected: false } },
          'wnd[0]/usr/tabsT/tabpDET': { type: 'GuiTab', props: { text: 'Details' } },
          'wnd[0]/usr/cmbPRIO': { type: 'GuiComboBox', options: ['Low', 'High'], props: { leftLabel: 'Priority', 'entries.count': 2, 'entries.item(0).value': 'Low', 'entries.item(1).value': 'High' } },
          'wnd[0]/usr/txtOWNER': { type: 'GuiTextField', props: { leftLabel: 'Created by', text: 'SYSTEM', changeable: false } },
          'wnd[0]/usr/txtNAME': { type: 'GuiTextField', props: { leftLabel: 'Name', text: '', maxLength: 5 } },
          'wnd[0]/usr/txtCITY': { type: 'GuiTextField', props: { leftLabel: 'City', text: '' } },
          'wnd[0]/usr/pwdPASS': { type: 'GuiPasswordField', props: { leftLabel: 'Password' } },
          'wnd[0]/usr/lblINFO': { type: 'GuiLabel', props: { text: 'Information' } },
          'wnd[0]/sbar': { type: 'GuiStatusbar', props: { messageType: 'S' } },
        },
        ...extra,
      },
      {
        name: 'popup',
        elements: {
          'wnd[0]': { type: 'GuiMainWindow', props: { text: 'Demo screen' } },
          'wnd[0]/tbar[0]/okcd': { type: 'GuiOkCodeField' },
          'wnd[1]': { type: 'GuiModalWindow', props: { text: 'System Message' } },
          'wnd[1]/usr/lblMSG': { type: 'GuiLabel', props: { text: 'Maintenance at 22:00' } },
          'wnd[1]/tbar[0]/btn[0]': { type: 'GuiButton', props: { tooltip: 'Continue' } },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
        onPress: { 'wnd[1]/tbar[0]/btn[0]': () => 'main' },
        onVKey: (vKey) => (vKey === 12 ? 'main' : undefined),
      },
    ],
  });
  const sap = await SapGuiSession.attach(fake, FAST);
  return { sap, fake };
}
