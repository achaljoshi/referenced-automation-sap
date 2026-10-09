# Migrating from the Java/JACOB framework

A mapping from what the Java framework offers to where it is in the TypeScript one, and what is deliberately different. The technical ids in your recordings and page code are **unchanged**.

## Concept map

| Java | TypeScript | Notes |
|---|---|---|
| `SAPDriver.instance().startSAPConnection(server, user)` | fixtures: `SAP_GUI_MODE=open` + `SAP_GUI_CONNECTION_NAME` (or `SAP_GUI_CONNECTION_STRING`); or `attach` | The connection is opened for you before the first test |
| `SAPDriver.login(user)` / `loginScreen.logOn(user, password)` | `await logon(sap)` / the `loggedInSap` fixture | Handles the multiple-logon pop-up (`SAP_MULTIPLE_LOGON=continue|fail`) |
| `isSessionAlive()` (`Busy` read) | `session.healthCheck()` | Used automatically before a session is reused |
| `SAPActive` / `LoggedIn` reuse | one session per worker (`SAP_GUI_REUSE=worker`) | Reset to the start screen between tests |
| `closeThread()` (`safeRelease`) | fixture teardown | `/nex` only for a connection the framework opened |
| `initialiseJacob()` (32/64-bit DLL) | `SAP_GUI_POWERSHELL` | 32-bit SAP GUI: the SysWOW64 `powershell.exe` |
| `ApplicationUtilities.runApplication` / `killApplication` | `SAP_GUI_LOGON_PATH` | Starts SAP Logon if it is not running. **No process killing** - use a dedicated runner |
| `SAPElement.find(id)` | `sap.locator(id)` | Same id string |
| `.enterText(text)` | `.fill(text)` / `sap.setText(id, text)` | Read-only fields are refused with a message; `checkMaxLength` option |
| `.invoke("press")` / `.click()` | `.press()` / `.click()` | `click()` picks press/select/toggle by type |
| `.invoke("select")` | `.click()` on a tab/menu/radio button | |
| `.getText()` + `textIsExtractable` wait | `.text()` | Waiting is built in |
| `.focus()` | `.focus()` | |
| `sendFunctionKey(i)` / `sendEnterKey()` | `sap.sendVKey(i)` / `sendVKey(0)` | 3 Back, 8 Execute (`refresh()`), 11 Save, 12 Cancel, 82 Page down |
| `GetSAPElementBy.Text(...)` | `sap.getByText(...)` | Case-insensitive contains; `exact` for whole text |
| `GetSAPElementBy.Tooltip(...)` | `sap.getByTooltip(...)` | |
| `getLeftLabel()` / `getRightLabel()` text | `sap.getByLabel('Sold-To Party')` | Finds the *field* by its label |
| `selectButton(text)` (switch on type) | `sap.getByText(text).click()` | |
| `selectCheckbox(text)` / `setCheckbox(b)` | `.check()` / `.uncheck()` / `.setChecked(b)` | Idempotent |
| `setComboBox(value)` | `.fill(value)` | Invalid option: "not an option of the drop-down" |
| `isComboBoxOptionPresent(v)` | `(await loc.options()).includes(v)` | |
| `selectNode` / `expandNode` / `selectedNode` | `sap.tree(id).doubleClickNode(key)` / `expandNode` / `selectedNode()` | |
| `getChildElements()` | `sap.children(id)` / `npm run doctor -- --dump` | |
| `getScrollBarPosition` / `setScrollBarPosition` | `sap.table(id).scrollTo(n)` / `.get('verticalScrollbar.position')` | |
| `getProperty` / `setProperty` / `invoke` | `.get(prop)` / `.set(prop, v)` / `.call(method, ...)` | Property paths may chain: `'columns.elementAt(1).width'` |
| `waitUntilElementEnabled(id, secs)` | `await expect(loc).toBeEditable({ timeout })` | |
| `TimeLimit`, `WaitTimes`, `Thread.sleep(n)` | *(none)* | Waiting is the session's job. Delete the sleeps |
| `SoftAssertions` | `expect.soft(...)` | Playwright's own |
| `WriteToWordDoc` / `WriteToExcelFile` (evidence) | `await sap.evidence('label')`, journal on failure | Attached to the HTML/Allure report. A `.docx` export is not included |
| `PropertiesUtil` + `CredentialHandler` (AES, key beside it) | `.env.<name>` + `.env.<name>.local`, CI variables, or `sap-gui-secret` (DPAPI) | Do **not** port the key-beside-ciphertext scheme |
| `SAPException extends Error` | `AdapterError` (with `cause`) | Playwright reports it with the step journal |
| `Pages/*`, `DataObjects/*` | `tests/sapgui/pages/*.ts` page objects; data via `@automation/referenced-automation-utils` (`randomUtils`, `dateUtils`, csv/excel) | See `pages/SalesOrderPages.ts` |

## Porting a page class

Java (typical shape):

```java
SAPElement.find("wnd[0]/usr/ctxtVBAK-AUART").enterText("OR");
SAPElement.find("wnd[0]").invoke("sendVKey", 0);
TimeLimit.waitFor(5);
SAPElement.find("wnd[0]/tbar[0]/btn[11]").click();
```

TypeScript:

```ts
export class CreateOrderInitialPage extends SapPage {
  readonly marker = 'wnd[0]/usr/ctxtVBAK-AUART';
  readonly orderType = this.sap.locator('wnd[0]/usr/ctxtVBAK-AUART');

  async enter(type: string): Promise<OrderOverviewPage> {
    await this.orderType.fill(type);
    await this.sap.sendVKey(0);
    return new OrderOverviewPage(this.sap).waitUntilDisplayed(); // replaces the sleep
  }
}
// in the test:  await order.save.click();  await expect(sap).toHaveStatusMessage(/saved/i, { type: 'S' });
```

## Order of work

1. Run `npm run doctor` on the machine that runs the Java suite today. If it passes, the bridge works there.
2. Convert one recorded flow (`npm run convert`), run it, fix what it reports.
3. Port page classes one at a time; keep ids, drop sleeps, return the next page from navigating methods.
4. Move credentials to `.env.<name>.local` / `sap-gui-secret`; retire the AES properties file.
5. If PowerShell turns out to be restricted on your machines, the existing JACOB code can sit behind the `SapGuiTransport` interface (a small Java helper process) without changing any test.
