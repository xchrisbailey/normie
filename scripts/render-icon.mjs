// Renders the app icon, build/icon.svg, to build/icon.png (1024 px, transparent corners), which electron-builder
// turns into the .icns. The SVG is the source; edit it and run this again.
//   npx electron scripts/render-icon.mjs
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';

const SIZE = 1024;
app.dock?.hide();
app.whenReady().then(async () => {
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
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage();
  writeFileSync('build/icon.png', image.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG());
  console.log('build/icon.png written');
  app.quit();
});
