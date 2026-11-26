// PROTOTYPE, throw away. Question: does better-sqlite3 + FTS5 work inside an
// Electron utilityProcess, in dev and in a packaged asar build?
const { app, utilityProcess, MessageChannelMain } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('temp'), 'PROTOTYPE-wipe-me-normie-spike.sqlite');
  const child = utilityProcess.fork(path.join(__dirname, 'data-process.js'), [], {
    serviceName: 'normie-data-spike',
    stdio: 'inherit',
  });
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ dbPath }, [port2]);

  const started = Date.now();
  port1.on('message', ({ data }) => {
    console.log('[main] from data process:', JSON.stringify(data, null, 2));
    if (data.done || data.error) {
      console.log(`[main] round trip ${Date.now() - started} ms, packaged=${app.isPackaged}`);
      child.kill();
      app.exit(data.error ? 1 : 0);
    }
  });
  port1.start();
  child.on('exit', (code) => console.log('[main] data process exited', code));
});
