# Verdict: Gmail and iCloud over IMAP and SMTP (PROTOTYPE)

Run on Nov 26, 2026 against Chris's Gmail (Workspace, OAuth through an Internal app) and iCloud (app-specific password), using ImapFlow 2.12.2 and Nodemailer 10.6.1.

## Capabilities

| | Gmail | iCloud |
|---|---|---|
| IDLE | yes | yes |
| CONDSTORE | **yes** | yes |
| QRESYNC | no | **yes** (enabled at login) |
| MOVE | yes | **no**: copy, then delete and expunge |
| UIDPLUS | yes | yes |
| SPECIAL-USE | yes | **no**, but ImapFlow tags Sent, Drafts, Junk and Trash by name |
| COMPRESS=DEFLATE | yes | no |
| THREAD | no | no |
| SORT | no | yes |
| X-GM-EXT-1 | yes | no |

## What we learned

**Gmail**

- OAuth through an Internal app works. It issues a refresh token with no fixed expiry, so there's no 7-day re-sign-in and no unverified-app screen.
- XOAUTH2 works for both IMAP and SMTP. Nodemailer's `transporter.verify()` succeeded with `type: 'OAuth2'`.
- CONDSTORE is present and `CHANGEDSINCE` works, so flag changes come from modseq and there's no need to re-read flags over the 90-day window. Without QRESYNC, deletions have to be found by comparing UID sets.
- `X-GM-THRID` groups messages into threads as expected.
- `X-GM-LABELS` leaves out the label of the selected mailbox: messages fetched from INBOX don't list `\Inbox`. Read labels from All Mail to see the Inbox label, which Done depends on.
- The account has look-alike mailboxes left behind by another client (`Sent Messages`, `Deleted Messages`, `[Gmail]All Mail`, `[Gmail]Trash`). Find system mailboxes by special-use flag only, never by name.

**iCloud**

- The IMAP and SMTP login must be the @icloud.com address. The Apple ID on a custom domain fails with `AUTHENTICATIONFAILED`.
- Sending From a custom-domain address (iCloud+) works over SMTP when logged in with the @icloud.com address. The login and the Identity are separate things, which matches the glossary's Account and Identity split.
- iCloud does **not** save SMTP mail to Sent. After 45 seconds the test message was in INBOX but not in `Sent Messages`, so Normie must IMAP APPEND to Sent.
- There's no Archive mailbox (only INBOX, Sent Messages, Drafts, Junk, Deleted Messages and user folders), so Normie creates one the first time it marks a Thread Done.
- CONDSTORE and QRESYNC both work, so iCloud gets the best sync path: changes and deletions since the last modseq.

## Side effects

One test message, "Normie spike test normie-spike-…", sent to iCloud INBOX. Safe to delete.
