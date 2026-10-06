import { expect, test } from '@playwright/test';
import { BRIDGE_SCRIPT, parseMemberPath } from '../../src';

test.describe('parseMemberPath', () => {
  test('a plain member has no chain', () => {
    expect(parseMemberPath('text')).toEqual({ via: [], name: 'text' });
  });

  test('walks objects before the final member, keeping literal args', () => {
    expect(parseMemberPath('columns.elementAt(1).width')).toEqual({
      via: [{ member: 'columns' }, { member: 'elementAt', args: [1] }],
      name: 'width',
    });
  });

  test('string and boolean args, including commas and dots inside strings', () => {
    expect(parseMemberPath('cell(2,"A.B, C",true).value')).toEqual({
      via: [{ member: 'cell', args: [2, 'A.B, C', true] }],
      name: 'value',
    });
  });

  test('garbage is rejected with the path in the message', () => {
    expect(() => parseMemberPath('a..b')).toThrow(/member path/);
  });
});

test.describe('the PowerShell bridge text', () => {
  test('is ASCII only (Windows PowerShell 5.1 reads BOM-less scripts in the system code page)', () => {
    expect([...BRIDGE_SCRIPT].filter((ch) => ch.charCodeAt(0) > 127)).toEqual([]);
  });

  test('handles every transport op the framework can send', () => {
    for (const op of ['ping', 'attach', 'open', 'busy', 'exists', 'get', 'set', 'call', 'children', 'quit']) {
      expect(BRIDGE_SCRIPT).toContain(`'${op}'`);
    }
  });

  test('does not touch the network, the registry or the file system (apart from the screenshot SAP itself writes)', () => {
    expect(BRIDGE_SCRIPT).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|Set-ItemProperty|New-Item|Remove-Item|Set-Content|Out-File/i);
  });

  test('the only program it can start is SAP Logon, from the configured path, and only when SAP Logon is not running', () => {
    const starts = BRIDGE_SCRIPT.match(/Start-Process[^\n]*/gi) ?? [];
    expect(starts).toEqual(['Start-Process -FilePath $logonPath | Out-Null']);
    // ... and only after the attempt to attach to a running one failed and a path was supplied
    const attach = BRIDGE_SCRIPT.indexOf('$engine = Try-GetScriptingEngine');
    expect(attach).toBeGreaterThan(-1);
    expect(BRIDGE_SCRIPT.indexOf('Start-Process')).toBeGreaterThan(attach);
    expect(BRIDGE_SCRIPT).toMatch(/IsNullOrEmpty\(\$logonPath\)[\s\S]*throw/);
  });

  test('braces and quotes are balanced (a cheap guard against an editing slip - not a PowerShell parser)', () => {
    const stripped = BRIDGE_SCRIPT.replace(/'[^'\n]*'/g, "''").replace(/#.*$/gm, '');
    const count = (ch: string) => stripped.split(ch).length - 1;
    expect(count('{')).toBe(count('}'));
    expect(count('(')).toBe(count(')'));
  });
});
