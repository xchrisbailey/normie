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
