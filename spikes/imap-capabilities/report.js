// PROTOTYPE helpers shared by gmail.js and icloud.js.
export const WANT = ['IDLE', 'CONDSTORE', 'QRESYNC', 'MOVE', 'UIDPLUS', 'SPECIAL-USE', 'COMPRESS=DEFLATE',
  'ESEARCH', 'LIST-STATUS', 'X-GM-EXT-1', 'ENABLE', 'THREAD=REFERENCES', 'THREAD=ORDEREDSUBJECT', 'SORT', 'OBJECTID'];

export function capabilityReport(client) {
  const caps = [...client.capabilities.keys()];
  return {
    all: caps.sort(),
    checked: Object.fromEntries(WANT.map((c) => [c, client.capabilities.has(c)])),
    enabledAfterLogin: [...(client.enabled || [])],
  };
}

export async function mailboxReport(client) {
  const list = await client.list();
  return list.map((m) => `${m.path}${m.specialUse ? `  ${m.specialUse}` : ''}`);
}

export function mailboxState(mb) {
  return {
    exists: mb.exists, uidValidity: String(mb.uidValidity), uidNext: mb.uidNext,
    highestModseq: mb.highestModseq === undefined ? 'none (no CONDSTORE)' : String(mb.highestModseq),
  };
}

export const print = (title, obj) => console.log(`\n=== ${title}\n${JSON.stringify(obj, null, 2)}`);

export function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name}. See README.md.`); process.exit(2); }
  return v;
}
