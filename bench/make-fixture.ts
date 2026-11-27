// Generates the seeded 100,000-message fixture: a store file the app can open with sync off.
//   node out/bench/make-fixture.js <path> [count]
import { existsSync, rmSync } from 'node:fs';
import { expected } from '../src/core/errors';
import { Store } from '../src/core/store';
import type { RemoteHeader } from '../src/core/types';

const path = process.argv[2];
const count = Number(process.argv[3] ?? 100_000);
if (!path) {
  throw new Error('usage: make-fixture <path> [count]');
}

const NOW = Date.UTC(2026, 10, 26, 12);
const people = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Linus Torvalds', 'Margaret Hamilton', 'Barbara Liskov', 'Edsger Dijkstra'];
const topics = [
  'Quarterly budget',
  'Flight to Lisbon',
  'Release notes',
  'Lunch on Friday',
  'Invoice',
  'Design review',
  'Hotel booking',
  'CI is red again',
  'Offsite agenda',
  'Contract renewal',
];
const words = 'the and for with about this that please thanks review attached update meeting notes next week schedule numbers draft final'.split(' ');

function text(i: number) {
  const n = 40 + (i % 80);
  const out: Array<string> = [];
  for (let k = 0; k < n; k++) {
    out.push(expected(words[(i * 7 + k * 13) % words.length], 'a word'));
  }
  return `Hi,\n\n${out.join(' ')}.\n\nThanks`;
}

function htmlRaw(body: string, i: number) {
  const rows = Array.from(
    { length: 12 },
    (_, k) =>
      `<tr><td style="padding:12px;border-bottom:1px solid #eee"><img src="https://cdn.example.com/${i}/${k}.png" width="80" height="80" alt=""></td>` +
      `<td style="padding:12px"><h2 style="margin:0;font:600 16px Helvetica">Story ${k}</h2><p>${body.slice(0, 160)}</p>` +
      `<a href="https://example.com/${i}/${k}" style="color:#1a73e8">Read more</a></td></tr>`,
  ).join('');
  const html =
    `<html><head><style>body{font-family:Helvetica,Arial;color:#222} .wrap{max-width:600px;margin:0 auto} td{vertical-align:top}</style></head>` +
    `<body><div class="wrap"><img src="https://cdn.example.com/header.png" width="600" alt="News"><table width="100%">${rows}</table>` +
    `<p style="font-size:11px;color:#888">You get this because you subscribed. <a href="https://example.com/unsubscribe">Unsubscribe</a></p></div>` +
    `<img src="https://tracker.example.com/open/${i}.gif" width="1" height="1"></body></html>`;
  return [
    'Subject: x',
    'List-Unsubscribe: <https://example.com/unsubscribe>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
    '--b',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '',
    '--b--',
    '',
  ].join('\r\n');
}

const t0 = performance.now();
for (const ext of ['', '-wal', '-shm']) {
  if (existsSync(path + ext)) {
    rmSync(path + ext);
  }
}
const store = new Store(path);
const account = 'fixture-1';
const mailbox = '[Gmail]/All Mail';
store.upsertAccount(account, 'fixture', 'me@example.com');
store.setMailboxes(account, [{ path: mailbox, role: 'all' }]);

const BATCH = 5000;
for (let start = 0; start < count; start += BATCH) {
  const headers: Array<RemoteHeader> = [];
  const bodies: Array<{ uid: number; raw: Uint8Array; text: string }> = [];
  for (let i = start; i < Math.min(count, start + BATCH); i++) {
    const uid = i + 1;
    const name = expected(people[i % people.length], 'a person');
    const thread = Math.floor(i / 3);
    // A third of Threads are in the Inbox; the rest are Done.
    const labels = thread % 3 === 0 ? [String.raw`\Inbox`] : ['Archive'];
    headers.push({
      uid,
      remoteId: `gm-${uid}`,
      threadId: `t-${thread}`,
      messageId: `<m${uid}@fixture>`,
      subject: `${topics[thread % topics.length]} ${thread}`,
      from: { name, address: `${expected(name.split(' ')[0], 'a first name').toLowerCase()}@example.com` },
      to: [{ address: 'me@example.com' }],
      date: NOW - i * 60_000,
      flags: i % 4 === 0 ? [] : [String.raw`\Seen`],
      labels,
      isList: i % 2 === 0,
    });
    const body = text(i);
    // Half the mail is HTML, like a newsletter: styles, a layout table, links and remote images.
    const raw = i % 2 === 0 ? htmlRaw(body, i) : `Subject: x\r\n\r\n${body}`;
    bodies.push({ uid, raw: new TextEncoder().encode(raw), text: body });
  }
  store.applyChanges(account, mailbox, { headers });
  store.putBodies(account, mailbox, bodies);
}
store.applyChanges(account, mailbox, { state: { uidValidity: '1', uidNext: count + 1, highestModseq: String(count) } });
const inbox = store.rows('inbox', 1e9).length;
store.close();
console.log(JSON.stringify({ fixture: path, messages: count, inboxThreads: inbox, ms: Math.round(performance.now() - t0) }));
