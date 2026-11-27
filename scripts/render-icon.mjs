// Renders the app icon, build/icon.svg, to build/icon.png (1024 px, transparent corners), which electron-builder
// turns into the .icns. The SVG is the source; edit it and run this again.
//   npx electron scripts/render-icon.mjs
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';

const SIZE = 1024;
app.dock?.hide();
async function render() {
  const svg = readFileSync('build/icon.svg', 'base64');
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(1);
  await win.loadURL(
    'data:text/html,' +
      encodeURIComponent(
        `<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${svg}" width="${SIZE}" height="${SIZE}">`,
      ),
  );
  await new Promise((resolve) => {
    setTimeout(resolve, 300);
  });
  const image = await win.webContents.capturePage();
  writeFileSync('build/icon.png', image.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG());
  console.log('build/icon.png written');
}

/** @param {unknown} error */
function fail(error) {
  console.error(error);
  app.exit(1);
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- top-level await on whenReady never resolves in Electron's main module
app
  .whenReady()
  .then(render)
  .then(() => app.quit())
  .catch(fail);
