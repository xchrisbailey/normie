# Electron as the desktop runtime

Normie is built on Electron rather than Tauri, Electrobun or a native Swift app. Electron gives one Chromium on every OS plus a real Node runtime, which ImapFlow, mailparser, Nodemailer and better-sqlite3 need. Tauri and Electrobun use each OS's own web view, and Electrobun runs on Bun, where native add-ons may break and ImapFlow is untested. We accept Electron's higher memory floor and cold start. If milestone 1 can't meet the performance budgets in the spec, that's the trigger to revisit this decision; we are not running an Electrobun spike in advance.
