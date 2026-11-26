// PROTOTYPE, throw away. Runs in an Electron utility process.
process.parentPort.once('message', ({ data, ports }) => {
  const [port] = ports;
  const send = (msg) => port.postMessage(msg);
  try {
    const t0 = performance.now();
    const Database = require('better-sqlite3');
    const tLoad = performance.now() - t0;

    const fs = require('fs');
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(data.dbPath + ext, { force: true });

    const db = new Database(data.dbPath);
    db.pragma('journal_mode = WAL');
    const versions = db.prepare('select sqlite_version() v').get().v;
    const fts5 = db.prepare("select sqlite_compileoption_used('ENABLE_FTS5') on_").get().on_;

    db.exec(`create table messages(id integer primary key, subject text, sender text, body text);
             create virtual table messages_fts using fts5(subject, sender, body, content='messages', content_rowid='id');`);

    const words = 'invoice flight hotel meeting lunch receipt newsletter release deploy budget travel dinner'.split(' ');
    const pick = (i, k) => words[(i * 7 + k * 13) % words.length];
    const insert = db.prepare('insert into messages(id, subject, sender, body) values (?, ?, ?, ?)');
    const insertFts = db.prepare('insert into messages_fts(rowid, subject, sender, body) values (?, ?, ?, ?)');
    const N = 100_000;
    const t1 = performance.now();
    db.transaction(() => {
      for (let i = 1; i <= N; i++) {
        const s = `${pick(i, 1)} ${pick(i, 2)} #${i}`;
        const from = `person${i % 500}@example.com`;
        const b = `Hello, about the ${pick(i, 3)} and the ${pick(i, 4)}. Thanks ${i}`;
        insert.run(i, s, from, b);
        insertFts.run(i, s, from, b);
      }
    })();
    const tInsert = performance.now() - t1;

    const search = db.prepare("select rowid from messages_fts where messages_fts match ? order by rank limit 50");
    const timings = [];
    for (const q of ['invoice', 'flight hotel', 'person42', 'budget AND travel', 'deplo*']) {
      const t = performance.now();
      const rows = search.all(q);
      timings.push({ q, hits: rows.length, ms: +(performance.now() - t).toFixed(2) });
    }
    db.close();

    send({
      done: true,
      execPath: process.execPath,
      modulePath: require.resolve('better-sqlite3'),
      sqlite: versions,
      fts5: !!fts5,
      loadMs: +tLoad.toFixed(1),
      insert100kMs: Math.round(tInsert),
      searches: timings,
    });
  } catch (e) {
    send({ error: String(e && e.stack || e) });
  }
});
