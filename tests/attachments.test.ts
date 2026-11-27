// Writing attachments to disk (#39): safe names, and no opening of anything that runs code.
import { describe, expect, it } from 'vitest';
import { isRisky, safeFilename } from '../src/main/attachments';

describe('attachment files', () => {
  it('makes names safe to write', () => {
    expect(safeFilename('invoice 42.pdf')).toBe('invoice 42.pdf');
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\evil\\x.txt')).toBe('x.txt');
    expect(safeFilename('.hidden')).toBe('hidden');
    expect(safeFilename('a\u0000b:c.txt')).toBe('a_b_c.txt');
    expect(safeFilename('')).toBe('attachment');
    expect(safeFilename(`${'x'.repeat(300)}.pdf`)).toMatch(/^x{116}\.pdf$/);
  });

  it('refuses to open files that run code, whatever the case', () => {
    for (const f of ['Setup.app', 'run.command', 'x.SH', 'invoice.pdf.exe', 'a.jar', 'disk.dmg', 'link.webloc']) expect(isRisky(f), f).toBe(true);
    for (const f of ['invoice.pdf', 'photo.JPG', 'notes.txt', 'sheet.xlsx', 'archive.zip']) expect(isRisky(f), f).toBe(false);
  });
});
