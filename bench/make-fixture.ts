// Generates the seeded 100,000-message fixture: a store file the app can open with sync off.
//   node out/bench/make-fixture.js <path> [count]
import { existsSync, rmSync } from 'node:fs';
import { Store } from '../src/core/store';
import type { RemoteHeader } from '../src/core/types';

const path = process.argv[2];
const count = Number(process.argv[3] ?? 100_000);
if (!path) throw new Error('usage: make-fixture <path> [count]');

const NOW = Date.UTC(2026, 10, 26, 12);
const people = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Linus Torvalds', 'Margaret Hamilton', 'Barbara Liskov', 'Edsger Dijkstra'];
const topics = ['Quarterly budget', 'Flight to Lisbon', 'Release notes', 'Lunch on Friday', 'Invoice', 'Design review', 'Hotel booking', 'CI is red again', 'Offsite agenda', 'Contract renewal'];
const words = 'the and for with about this that please thanks review attached update meeting notes next week schedule numbers draft final'.split(' ');

function text(i: number) {
  const n = 40 + (i % 80);
  const out: string[] = [];
  for (let k = 0; k < n; k++) out.push(words[(i * 7 + k * 13) % words.length]!);
  return `Hi,\n\n${out.join(' ')}.\n\nThanks`;
}

const t0 = performance.now();
for (const ext of ['', '-wal', '-shm']) if (existsSync(path + ext)) rmSync(path + ext);
const store = new Store(path);
const account = 'fixture-1';
const mailbox = '[Gmail]/All Mail';
store.upsertAccount(account, 'fixture', 'me@example.com');
store.setMailboxes(account, [{ path: mailbox, role: 'all' }]);

const BATCH = 5000;
for (let start = 0; start < count; start += BATCH) {
  const headers: RemoteHeader[] = [];
  const bodies: { uid: number; raw: Uint8Array; text: string }[] = [];
  for (let i = start; i < Math.min(count, start + BATCH); i++) {
    const uid = i + 1;
    const name = people[i % people.length]!;
    const thread = Math.floor(i / 3);
    // A third of Threads are in the Inbox; the rest are Done.
    const labels = thread % 3 === 0 ? ['\\Inbox'] : ['Archive'];
    headers.push({
      uid, remoteId: `gm-${uid}`, threadId: `t-${thread}`, messageId: `<m${uid}@fixture>`,
      subject: `${topics[thread % topics.length]} ${thread}`, from: { name, address: `${name.split(' ')[0]!.toLowerCase()}@example.com` },
      to: [{ address: 'me@example.com' }], date: NOW - i * 60_000, flags: i % 4 === 0 ? [] : ['\\Seen'], labels,
    });
    const body = text(i);
    bodies.push({ uid, raw: new TextEncoder().encode(`Subject: x\r\n\r\n${body}`), text: body });
  }
  store.applyChanges(account, mailbox, { headers });
  store.putBodies(account, mailbox, bodies);
}
store.applyChanges(account, mailbox, { state: { uidValidity: '1', uidNext: count + 1, highestModseq: String(count) } });
const inbox = store.rows('inbox', 1e9).length;
store.close();
console.log(JSON.stringify({ fixture: path, messages: count, inboxThreads: inbox, ms: Math.round(performance.now() - t0) }));
