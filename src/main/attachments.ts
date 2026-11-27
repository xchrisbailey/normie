// Opening and saving attachments. A file from a message is untrusted: it gets a safe name, macOS's quarantine
// mark (so Gatekeeper checks it before anything runs), and Normie never opens anything executable itself.
import { execFile } from 'node:child_process';
import path from 'node:path';

/** A file name safe to write: no folders, no control characters, no leading dot, a sane length. */
export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let clean = base.replaceAll(/[\u0000-\u001f\u007f:*?"<>|]/g, '_').replace(/^[.\s]+/, '').trim();
  if (!clean) {clean = 'attachment';}
  if (clean.length > 120) {
    const ext = path.extname(clean).slice(0, 16);
    clean = clean.slice(0, 120 - ext.length) + ext;
  }
  return clean;
}

/** Types that run code when opened. These can be saved, never opened from Normie. */
const RISKY = new Set([
  'app', 'command', 'tool', 'sh', 'bash', 'zsh', 'csh', 'ksh', 'fish', 'pkg', 'mpkg', 'dmg', 'scpt', 'scptd', 'applescript', 'workflow',
  'action', 'terminal', 'jar', 'jnlp', 'exe', 'msi', 'bat', 'cmd', 'com', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'py', 'pl', 'rb', 'php',
  'dylib', 'so', 'kext', 'plugin', 'prefpane', 'webloc', 'inetloc', 'fileloc', 'url', 'desktop', 'scr', 'lnk', 'reg', 'iso', 'img',
]);

export function isRisky(filename: string): boolean {
  return RISKY.has(path.extname(filename).slice(1).toLowerCase());
}

/** Mark a file as downloaded from the internet, as browsers do. */
export function quarantine(file: string): Promise<void> {
  if (process.platform !== 'darwin') {return Promise.resolve();}
  const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};Normie;`;
  return new Promise((resolve) => execFile('xattr', ['-w', 'com.apple.quarantine', value, file], () => resolve()));
}
