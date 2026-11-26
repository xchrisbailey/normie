# Normie

A keyboard-first desktop mail client that puts Gmail, iCloud and any IMAP/SMTP server into one fast inbox.

## Language

### Accounts and sending

**Account**:
One mailbox the user signs into on one mail server, such as a Gmail address or an iCloud address.
_Avoid_: Mailbox, login, profile

**Identity**:
A From name and address an **Account** can send as. One **Account** can have several; a reply defaults to the **Identity** the original message was sent to.
_Avoid_: Alias, sender, persona

### Mail

**Thread**:
A conversation of related messages inside one **Account**. A **Thread** never spans two **Accounts**, even when the same people wrote to both.
_Avoid_: Conversation, chain

**Label**:
A named tag the user puts on a **Thread**. On Gmail a **Thread** can have many; on folder-only servers it has at most one, and applying a **Label** moves it.
_Avoid_: Folder, tag, category

### Inbox

**Unified Inbox**:
The Inbox **Threads** of every **Account**, interleaved in one list.
_Avoid_: All inboxes, combined inbox

**Split**:
A saved filter over the **Unified Inbox**, shown as a tab, defined by local rules (sender, **Account**, **Label**, newsletter headers). One **Thread** can appear in several **Splits**.
_Avoid_: Tab, view, smart folder, filter

### Triage

**Done**:
The state of a **Thread** that has left the Inbox but was not deleted. Marking a **Thread** Done is the main triage action.
_Avoid_: Archive (as an action), mark done, complete

**Snooze**:
Hiding a **Thread** until a chosen time, when it comes back to the top of the Inbox. A snoozed **Thread** is hidden on the user's other devices too.
_Avoid_: Defer, remind me

**Reminder**:
A due date on a **Thread** the user sent; if nobody else has replied by then, the **Thread** comes back to the Inbox.
_Avoid_: Follow-up, nudge, snooze

### Outgoing

**Outbox**:
Messages the user has sent that haven't left the computer yet: those inside the undo window and those scheduled with **Send Later**.
_Avoid_: Queue, drafts

**Send Later**:
Scheduling a message in the **Outbox** to go out at a chosen time.
_Avoid_: Scheduled send, delayed send
