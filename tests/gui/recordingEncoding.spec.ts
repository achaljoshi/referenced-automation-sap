import { expect, test } from '@playwright/test';
import { convertVbs, decodeRecording } from '../../src/vbs';

const script = 'session.findById("wnd[0]/usr/txtRSYST-BNAME").text = "JDOE"\r\nsession.findById("wnd[0]").sendVKey 0\r\n';

const utf16le = (text: string, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);
const utf16be = (text: string) => {
  const body = Buffer.from(text, 'utf16le');
  body.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
};

test.describe('recordings are read in whatever encoding SAP GUI wrote them', () => {
  test('UTF-16 LE with a BOM (SAP GUI\'s default "Unicode"), UTF-16 BE, UTF-16 without a BOM, UTF-8 with and without a BOM and plain text all give the same text', () => {
    const accented = `${script}rem Größe – “quoted”\r\n`;
    for (const bytes of [utf16le(accented), utf16be(accented), utf16le(accented, false), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(accented, 'utf8')]), Buffer.from(accented, 'utf8')])
      expect(decodeRecording(bytes)).toBe(accented);
  });

  test('a Unicode recording converts to the same test as the same recording saved as UTF-8 (the old reader produced nothing usable)', () => {
    const fromUtf8 = convertVbs(decodeRecording(Buffer.from(script, 'utf8')), { testName: 't', sourceName: 'x.vbs' });
    const fromUtf16 = convertVbs(decodeRecording(utf16le(script)), { testName: 't', sourceName: 'x.vbs' });
    expect(fromUtf16.code).toBe(fromUtf8.code);
    expect(fromUtf16.code).toContain('wnd[0]/usr/txtRSYST-BNAME');
    // negative control: the UTF-8 reader on UTF-16 bytes does not find the control
    expect(convertVbs(utf16le(script).toString('utf8'), { testName: 't', sourceName: 'x.vbs' }).code).not.toContain('wnd[0]/usr/txtRSYST-BNAME');
  });

  test('the converter command line accepts a UTF-16 recording', async () => {
    const { spawnSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbs-enc-'));
    fs.writeFileSync(path.join(dir, 'rec.vbs'), utf16le(script));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../dist/cli/convertVbs.js'), path.join(dir, 'rec.vbs'), '--out', dir, '--allow-no-assertion'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'rec.spec.ts'), 'utf8')).toContain('wnd[0]/usr/txtRSYST-BNAME');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
