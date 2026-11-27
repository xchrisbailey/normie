// Build Normie.app and put it in Applications, replacing the copy there: the way to try a change in the installed
// app. Refuses while Normie is running (quit it first: ⌘Q or the menu bar envelope).
//   npm run install-app            → /Applications
//   npm run install-app -- ~/Applications
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const dir = (process.argv[2] ?? '/Applications').replace(/^~(?=\/|$)/, homedir());
const target = path.join(dir, 'Normie.app');
const running = () => spawnSync('pgrep', ['-f', 'Normie.app/Contents/MacOS/Normie']).status === 0;

if (running()) {
  console.error('Normie is running. Quit it (⌘Q, or Quit Normie in the menu bar), then run this again.');
  process.exit(1);
}
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
run('npm', ['run', 'package:dir']);
if (running()) {
  console.error('Normie started while building. Quit it, then run this again.');
  process.exit(1);
}
if (existsSync(target)) {rmSync(target, { recursive: true, force: true });}
run('ditto', ['dist/mac-arm64/Normie.app', target]);
run('codesign', ['--verify', '--deep', '--strict', target]);
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
console.log(`Installed ${target} (build ${commit}). Open it with: open -a Normie`);
