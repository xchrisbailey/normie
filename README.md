# Normie

A keyboard-first desktop mail client for Gmail, iCloud and any IMAP/SMTP server. The spec is [#3](https://github.com/xchrisbailey/normie/issues/3); vocabulary is in `GLOSSARY.md` and decisions in `docs/adr/`.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Build and run the app |
| `npm run start:fake` | Run against a fake mailbox, no Account needed |
| `npm test` | Core tests over the fake provider |
| `npm run typecheck` | TypeScript |
| `npm run smoke` | Launch the app hidden with the fake provider and check the Inbox renders |
| `npm run package` | Unsigned Mac build in `dist/` |
| `npm run smoke:packaged` | The smoke check against the packaged app |
| `npm run bench` | The performance budgets against a 100,000-message fixture |
| `GMAIL_USER=you@domain npm run test:live` | Read-only checks against real Gmail (browser sign-in). Add `GMAIL_LIVE_WRITE=1` to also mark one message Done and put it back, and `GMAIL_LIVE_SEND=1` to send one message to yourself |

## Keys

`Cmd-K` opens the palette, which lists every action with its key.

| | |
|---|---|
| `j` / `k`, `Enter`, `Esc` | Move, open a Thread, back to the list |
| `e` | Done |
| `#` | Delete (to Trash; `z` can bring it back for 10 s) |
| `s` | Star or unstar |
| `u` | Mark read or unread |
| `m` | Mute: Done now and whenever new mail arrives in it |
| `l` | Apply a Label |
| `h` | Snooze: type a time in plain words ("tomorrow 9", "fri 2pm", "in 3 hours") |
| `Shift-U` | Unsnooze (from the Snoozed tab) |
| `z` | Undo the last action |
| `g i`, `g g`, `Shift-G` | Inbox, first Thread, last Thread |
| `Space` / `Shift-Space` | Scroll the open Thread |
| `i` / `Shift-I` | Load hidden images in this Thread / always from these senders |
| `/` | Search: words, "a phrase", `from:`, `to:`, `subject:`; Enter goes to the results, Esc closes |
| `c`, `r`, `Shift-R`, `f` | Compose, reply, reply all, forward |
| `Cmd-Z` | Undo Send (for 5 s after sending) |

In the composer: `Cmd-Enter` sends, `Cmd-Shift-Enter` sends later (at a time in plain words; scheduled messages are in `Cmd-K`), `Cmd-Shift-H` sets a Reminder (the Thread comes back if nobody but you writes by then), `Esc` closes and keeps a draft, `Cmd-Shift-Backspace` discards it, `Cmd-Shift-A` attaches files (or drop them on it), and `Cmd-K` inserts a snippet. Drafts reopen from `Cmd-K`.

### Your own keys

Put a `keymap.json` in the app's data folder (`~/Library/Application Support/normie/`). Each entry replaces an action's keys; `[]` unbinds it. Action ids are in `src/renderer/commands/registry.ts`. Changes apply without a restart. Problems (unknown actions, malformed keys, clashes) show as a note in the top bar, and the rest of the file still applies.

```json
{ "thread.done": ["e", "y"], "thread.star": "Shift-S", "thread.mute": [] }
```

### Snippets

Put a `snippets.json` in the same folder. Type `;` and a trigger in a message, then Tab, to expand it; or pick one by name from `Cmd-K` while writing. Changes apply without a restart.

```json
{ "thanks": "Thanks so much!", "sig": { "name": "Signature", "text": "Chris\nSent from Normie" } }
```

### Splits

The Inbox has tabs: Inbox (everything), Important (VIPs and people you've written to), Other, Newsletters, VIP, and one per Account when you have several. Tab and Shift-Tab switch; 1–9 open an Account's tab and 0 the whole Inbox. "Add Sender to VIP" is in Cmd-K.

Put a `splits.json` in the same folder to reorder, rename or hide tabs, add your own, and choose which ones notify. Listed tabs show in that order; built-ins you leave out are hidden; `"accounts"` places the per-Account tabs. Your own tabs match on every rule given: `from` (an address or `@domain`, or a list), `account`, `label`, `newsletter`, `vip`.

```json
[
  { "id": "important", "notify": true },
  { "id": "work", "name": "Work", "from": ["@acme.com"], "newsletter": false, "notify": true },
  { "id": "other" },
  { "id": "newsletters", "name": "Reading" },
  { "id": "accounts" }
]
```

## Layout

```
src/
├── core/      # the core: store, data service, sync engine, provider interface, fake provider, rpc
├── main/      # Electron main: windows, process wiring
├── data/      # data utility process: owns SQLite
├── sync/      # sync utility process: talks to mail servers
├── preload/   # forwards the core's MessagePort into the page
└── renderer/  # React UI; reaches the core only through its MessagePort
```

npm 12 blocks install scripts by default; `allowScripts` in `package.json` approves better-sqlite3's.
