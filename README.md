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
| `GMAIL_USER=you@domain npm run test:live` | Read-only checks against real Gmail (browser sign-in). Add `GMAIL_LIVE_WRITE=1` to also mark one message Done and put it back |

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
| `z` | Undo the last action |
| `g i`, `g g`, `Shift-G` | Inbox, first Thread, last Thread |

### Your own keys

Put a `keymap.json` in the app's data folder (`~/Library/Application Support/normie/`). Each entry replaces an action's keys; `[]` unbinds it. Action ids are in `src/renderer/commands/registry.ts`. Changes apply without a restart. Problems (unknown actions, malformed keys, clashes) show as a note in the top bar, and the rest of the file still applies.

```json
{ "thread.done": ["e", "y"], "thread.star": "Shift-S", "thread.mute": [] }
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
