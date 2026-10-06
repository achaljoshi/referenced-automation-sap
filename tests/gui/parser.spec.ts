import { expect, test } from '@playwright/test';
import { parseVbs, type Step } from '../../src';

const kinds = (steps: Step[]) => steps.map((s) => s.kind);

test.describe('parseVbs - what the SAP GUI Scripting recorder emits', () => {
  test('drops the connect-to-SAP preamble (the fixture attaches the session instead)', () => {
    const { steps } = parseVbs(`If Not IsObject(application) Then
   Set SapGuiAuto  = GetObject("SAPGUI")
   Set application = SapGuiAuto.GetScriptingEngine
End If
If Not IsObject(connection) Then
   Set connection = application.Children(0)
End If
If Not IsObject(session) Then
   Set session    = connection.Children(0)
End If
If IsObject(WScript) Then
   WScript.ConnectObject session,     "on"
   WScript.ConnectObject application, "on"
End If
session.findById("wnd[0]/tbar[0]/btn[0]").press
`);
    expect(steps).toEqual([{ kind: 'call', id: 'wnd[0]/tbar[0]/btn[0]', method: 'press', args: [], into: undefined, line: 15 }]);
  });

  test('set, call, sendVKey with and without parentheses', () => {
    const { steps } = parseVbs(`session.findById("wnd[0]/usr/txtA").text = "x"
session.findById("wnd[0]").sendVKey 0
session.findById("wnd[0]").sendVKey(11)
session.findById("wnd[0]/usr/chkB").selected = true
session.findById("wnd[0]/usr/txtA").caretPosition = 4`);
    expect(steps.map((s) => (s.kind === 'set' || s.kind === 'call' ? `${s.kind}:${'prop' in s ? s.prop : s.method}` : s.kind))).toEqual([
      'set:text',
      'call:sendVKey',
      'call:sendVKey',
      'set:selected',
      'set:caretPosition',
    ]);
    expect(steps[1]).toMatchObject({ args: [{ kind: 'number', value: 0 }] });
    expect(steps[3]).toMatchObject({ value: { kind: 'boolean', value: true } });
  });

  test('With blocks: relative findById and bare .member resolve against the block target', () => {
    const { steps } = parseVbs(`With session.findById("wnd[0]/usr/tblX")
    .verticalScrollbar.position = 12
    .findById("ctxtA[1,0]").text = "TG11"
End With
session.findById("wnd[0]/usr/txtAfter").text = "y"`);
    expect(steps).toMatchObject([
      { kind: 'set', id: 'wnd[0]/usr/tblX', prop: 'verticalScrollbar.position' },
      { kind: 'set', id: 'wnd[0]/usr/tblX/ctxtA[1,0]', prop: 'text' },
      { kind: 'set', id: 'wnd[0]/usr/txtAfter' },
    ]);
  });

  test('chained access keeps literal arguments in the path', () => {
    const { steps } = parseVbs(`session.findById("wnd[0]/usr/tblX").columns.elementAt(1).width = 18
session.findById("wnd[0]/usr/tblX").getAbsoluteRow(3).selected = true
session.findById("wnd[0]/usr/grid").getCellValue(2, "MATNR")`);
    expect(steps).toMatchObject([
      { kind: 'set', prop: 'columns.elementAt(1).width', value: { kind: 'number', value: 18 } },
      { kind: 'set', prop: 'getAbsoluteRow(3).selected' },
      { kind: 'call', method: 'getCellValue', args: [{ kind: 'number', value: 2 }, { kind: 'string', value: 'MATNR' }] },
    ]);
  });

  test('a variable inside a chained path is flagged, not guessed', () => {
    const { steps } = parseVbs(`session.findById("wnd[0]/usr/tblX").getAbsoluteRow(i).selected = true`);
    expect(steps).toMatchObject([{ kind: 'unsupported', reason: expect.stringContaining('chained member path') }]);
  });

  test('line continuations and doubled quotes inside strings', () => {
    const { steps } = parseVbs(`session.findById("wnd[0]/usr/txtA").text = _
    "say ""hi"""`);
    expect(steps).toMatchObject([{ kind: 'set', value: { kind: 'string', value: 'say "hi"' }, line: 1 }]);
  });

  test('an apostrophe inside a string is not a comment', () => {
    const { steps } = parseVbs(`session.findById("wnd[0]/usr/txtA").text = "it's fine" ' trailing comment`);
    expect(steps).toMatchObject([{ kind: 'set', value: { kind: 'string', value: "it's fine" } }]);
  });

  test('element variables: Set btn = findById(...) then btn.press', () => {
    const { steps } = parseVbs(`Set btn = session.findById("wnd[0]/tbar[0]/btn[11]")
btn.press`);
    expect(steps).toMatchObject([{ kind: 'call', id: 'wnd[0]/tbar[0]/btn[11]', method: 'press' }]);
  });

  test('reading a value into a variable', () => {
    const { steps } = parseVbs(`orderNo = session.findById("wnd[0]/usr/txtORDER").text`);
    expect(steps).toMatchObject([{ kind: 'get', id: 'wnd[0]/usr/txtORDER', prop: 'text', into: 'orderNo' }]);
  });

  test('WScript.Sleep is recognised (and later dropped by the generator)', () => {
    expect(parseVbs('WScript.Sleep 500').steps).toEqual([{ kind: 'sleep', ms: 500, line: 1 }]);
  });

  test('If/For logic is passed through as TODO, never executed unconditionally', () => {
    const { steps } = parseVbs(`session.findById("wnd[0]/usr/txtA").text = "1"
If session.findById("wnd[0]/sbar").text <> "" Then
    session.findById("wnd[0]").sendVKey 3
End If
session.findById("wnd[0]/usr/txtB").text = "2"`);
    expect(kinds(steps)).toEqual(['set', 'unsupported', 'unsupported', 'unsupported', 'set']);
    // the statement INSIDE the If must not have become a plain unconditional step
    expect(steps.filter((s) => s.kind === 'call')).toHaveLength(0);
  });

  test('MsgBox and friends have no meaning in an automated run and are reported', () => {
    const { steps } = parseVbs('MsgBox "done"');
    expect(steps).toMatchObject([{ kind: 'unsupported', reason: expect.stringContaining('dropped') }]);
  });

  test('tolerates a BOM and CRLF line endings (files saved by the recorder on Windows)', () => {
    const { steps } = parseVbs('\uFEFFsession.findById("wnd[0]/usr/txtA").text = "x"\r\nsession.findById("wnd[0]").sendVKey 0\r\n');
    expect(kinds(steps)).toEqual(['set', 'call']);
  });

  test('table-control cell ids with [col,row] survive intact', () => {
    const id = 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]';
    expect(parseVbs(`session.findById("${id}").text = "TG11"`).steps).toMatchObject([{ id }]);
  });
});
