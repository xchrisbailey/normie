# IMAP capabilities spike (PROTOTYPE, throw away)

Answers: what do Gmail (Workspace, over OAuth) and iCloud actually support over IMAP and SMTP, and does iCloud save SMTP mail to Sent by itself?

- `gmail.js` is read-only. It opens your browser for Google sign-in using `~/.config/normie/google-oauth-client.json`. Tokens stay in memory.
- `icloud.js` reads capabilities, then sends one test message from your address to itself and watches Sent for 45 seconds.
- Output shows ids, labels and flags, never subjects or bodies of your mail.

```
npm run gmail   # GMAIL_USER=you@yourdomain
npm run icloud  # ICLOUD_USER, ICLOUD_APP_PASSWORD, optional ICLOUD_FROM if the Apple ID isn't your @icloud.com address
npm start       # both
```
